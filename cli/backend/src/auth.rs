//! Optional login gate for the local web UI (`--user` / `--pass`).
//!
//! When enabled, the frontend shows a login page and every sensitive
//! endpoint (`/api/*` except `/api/hello` + `/api/auth/*`, plus
//! `/v1/shell`) requires the session cookie. Auth rides the shared router,
//! so it applies over the relay too: the agent proxies `rpc-*`/`shell-*`
//! to a loopback server with the same middleware, forwarding the viewer's
//! `ks_ssh_auth` cookie (see `--relay-auth` for the extra routing-layer
//! viewer PIN).
//!
//! Case 9 (Identity & audit, Teleport-level at homelab scale):
//! - **Crypto**: Argon2id (salt per user). Legacy unsalted SHA-256 hashes
//!   from older `users.json` still log in once, then upgrade to Argon2id.
//! - **Sessions**: `ks_ssh_auth` cookie (`HttpOnly`, `Secure`,
//!   `SameSite=Lax`), 12h absolute + 30min sliding idle expiry, rotated on
//!   privilege change (password/role/TOTP).
//! - **RBAC**: `admin` / `operator` / `viewer` (see [`Role`] + [`role_allows`]).
//!   Owner is always `admin`; legacy users without a role default to
//!   `operator`.
//! - **2FA**: per-user TOTP (otpauth URI + recovery codes).
//! - **SSO**: optional OIDC authorization-code + PKCE behind
//!   `--oidc-issuer` / `--oidc-client-id` (auto-provision as viewer,
//!   `--oidc-allow-domain` whitelist). Tokens are never logged.
//! - **Rate-limit**: 5 fails → 5min lockout per IP+user.
//! - **Audit**: every login/logout, user CRUD, RBAC denial and TOTP/OIDC
//!   event appends to the `audit` table via `crate::db` (never secrets).

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Extension, Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};

/// Cookie carrying the session token.
pub const COOKIE_NAME: &str = "ks_ssh_auth";
/// Absolute session lifetime: 12h.
pub const COOKIE_MAX_AGE: u64 = 12 * 60 * 60;
/// Sliding idle timeout: 30min without a request kills the session.
pub const IDLE_TIMEOUT_SECS: i64 = 30 * 60;
/// Minimum password length for accounts created/changed via the Users page
/// or change-password. (The `--pass` flag itself accepts any non-empty value
/// for backward compat, with a startup warning when < 12.)
pub const MIN_PASSWORD_LEN: usize = 12;
/// Username rules for accounts created/changed via the Users page.
const USERNAME_MIN: usize = 3;
const USERNAME_MAX: usize = 32;
/// Login rate-limit: 5 fails → 5min lockout per IP+user.
pub const RATE_MAX_FAILS: u32 = 5;
pub const RATE_LOCKOUT_SECS: i64 = 5 * 60;

// ---------------------------------------------------------------------------
// Roles + permission matrix.
// ---------------------------------------------------------------------------

/// Least-privilege roles. Serialized lowercase (`"admin"` …).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Admin,
    Operator,
    Viewer,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Admin => "admin",
            Role::Operator => "operator",
            Role::Viewer => "viewer",
        }
    }

    pub fn parse(s: &str) -> Option<Role> {
        match s.trim().to_ascii_lowercase().as_str() {
            "admin" => Some(Role::Admin),
            "operator" => Some(Role::Operator),
            "viewer" => Some(Role::Viewer),
            _ => None,
        }
    }

    /// Rank for `>=` comparisons (viewer 0 < operator 1 < admin 2).
    fn rank(self) -> u8 {
        match self {
            Role::Viewer => 0,
            Role::Operator => 1,
            Role::Admin => 2,
        }
    }

    pub fn at_least(self, min: Role) -> bool {
        self.rank() >= min.rank()
    }
}

/// Minimum role for `(method, path)`. Paths are matched without query.
/// Keep in sync with `main.rs` route table.
pub fn required_role(method: &str, path: &str) -> Required {
    // Public auth flow (never needs a session).
    if path == "/api/hello"
        || path == "/api/record/status"
        || path == "/api/auth/status"
        || path == "/api/auth/login"
        || path == "/api/auth/logout"
        || path == "/api/auth/oidc/login"
        || path.starts_with("/api/auth/oidc/callback")
    {
        return Required::Public;
    }
    // Any authenticated user.
    if path == "/api/auth/me"
        || path == "/api/auth/change-password"
        || path.starts_with("/api/auth/totp/")
        || path == "/api/auth/sessions/mine"
        || path == "/api/relay/pin/status"
        || path == "/api/chat"
    {
        return Required::Viewer;
    }
    // Reads: viewer+.
    if method == "GET"
        && (path == "/api/files"
            || path == "/api/files/content"
            || path == "/api/files/download"
            || path == "/api/files/stat"
            || path == "/api/files/search"
            || path == "/api/files/download-zip"
            || path == "/api/ports"
            || path == "/api/host"
            || path == "/api/terms"
            || path == "/api/audit/export"
            || (path.starts_with("/api/terms/") && path.ends_with("/recording")))
    {
        // /api/audit/export is admin-only despite being GET — handled below.
        if path == "/api/audit/export" {
            return Required::Admin;
        }
        return Required::Viewer;
    }
    // Operator+ writes (no delete/kill/chmod/users).
    if (method == "POST"
        && (path == "/api/files/mkdir"
            || path == "/api/files/upload"
            || path == "/api/files/upload-url"
            || path == "/api/files/rename"
            || path == "/api/files/copy"
            || path == "/api/files/zip-many"
            || path == "/api/files/unzip"
            || path == "/api/relay/pin"))
        || (method == "PUT" && path == "/api/files/content")
    {
        return Required::Operator;
    }
    // WebSocket shell: viewer may connect (read-only enforced in shell.rs),
    // operator+ may write.
    if path == "/v1/shell" {
        return Required::Viewer;
    }
    // Killing a shell session: operator+ (viewer is read-only). Closing a
    // tab calls `DELETE /api/terms/:id` so the PTY does not linger detached.
    if method == "DELETE"
        && path.starts_with("/api/terms/")
        && !path.ends_with("/recording")
    {
        return Required::Operator;
    }
    // Admin-only mutating ops.
    if (method == "DELETE" && path == "/api/files")
        || (method == "POST" && path == "/api/files/chmod")
        || (method == "POST" && path == "/api/ports/kill")
        || path == "/api/audit"
        || path.starts_with("/api/auth/users")
        || path == "/api/auth/sessions"
        || path.starts_with("/api/auth/sessions/")
        || (path.starts_with("/api/terms/") && path.ends_with("/recording") && method == "DELETE")
    {
        return Required::Admin;
    }
    // Unknown protected path: deny by default (admin only) so new routes
    // fail closed until classified above.
    Required::Admin
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Required {
    Public,
    Viewer,
    Operator,
    Admin,
}

/// `true` when `role` may call `(method, path)`.
pub fn role_allows(role: Role, method: &str, path: &str) -> bool {
    match required_role(method, path) {
        Required::Public => true,
        Required::Viewer => true, // any authenticated role (checked separately)
        Required::Operator => role.at_least(Role::Operator),
        Required::Admin => role == Role::Admin,
    }
}

// ---------------------------------------------------------------------------
// Password hashing: Argon2id (new) + unsalted SHA-256 (legacy, migrates).
// ---------------------------------------------------------------------------

use sha2::{Digest, Sha256};

fn hash_sha256(pass: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(pass.as_bytes());
    let digest = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
        let hi = (chunk[0] as char).to_digit(16)?;
        let lo = (chunk[1] as char).to_digit(16)?;
        out[i] = (hi as u8) * 16 + (lo as u8);
    }
    Some(out)
}

fn hash_argon2(pass: &str) -> String {
    use argon2::{Argon2, password_hash::PasswordHasher as _};
    Argon2::default()
        .hash_password(pass.as_bytes())
        .map(|h| h.to_string())
        .unwrap_or_else(|_| {
            // Practically unreachable — fall back to a distinct marker so we
            // never silently store a weak hash.
            format!("$argon2-fallback${}", to_hex(&hash_sha256(pass)))
        })
}

fn verify_argon2(phc: &str, pass: &str) -> bool {
    use argon2::{Argon2, PasswordHash, PasswordVerifier as _};
    let Ok(parsed) = PasswordHash::new(phc) else {
        return false;
    };
    Argon2::default()
        .verify_password(pass.as_bytes(), &parsed)
        .is_ok()
}

/// Stored password: new Argon2id PHC or legacy hex SHA-256 (migrates on login).
#[derive(Clone, Debug)]
enum PassStored {
    Argon2(String),
    Legacy([u8; 32]),
}

impl PassStored {
    fn verify(&self, pass: &str) -> bool {
        match self {
            PassStored::Argon2(phc) => verify_argon2(phc, pass),
            PassStored::Legacy(h) => ct_eq(h, &hash_sha256(pass)),
        }
    }

    fn is_legacy(&self) -> bool {
        matches!(self, PassStored::Legacy(_))
    }

    fn to_file_string(&self) -> String {
        match self {
            PassStored::Argon2(phc) => phc.clone(),
            PassStored::Legacy(h) => to_hex(h),
        }
    }

    fn from_file_string(s: &str) -> Option<PassStored> {
        let t = s.trim();
        if t.starts_with("$argon2") {
            // Basic sanity — full parse happens on verify.
            if t.len() < 20 || t.len() > 512 {
                return None;
            }
            Some(PassStored::Argon2(t.to_string()))
        } else {
            from_hex(t).map(PassStored::Legacy)
        }
    }
}

// ---------------------------------------------------------------------------
// TOTP helpers (RFC 6238, SHA1, 6 digits, 30s step, ±1 skew).
// ---------------------------------------------------------------------------

fn totp_secret_bytes() -> Vec<u8> {
    let mut raw = vec![0u8; 20];
    if getrandom::fill(&mut raw).is_err() {
        // Fallback (still unique per call); getrandom failing is fatal
        // elsewhere too, but TOTP enrol must not panic.
        for b in raw.iter_mut() {
            *b = fastrand::u8(..);
        }
    }
    raw
}

fn totp_base32(raw: &[u8]) -> String {
    base32::encode(base32::Alphabet::Rfc4648 { padding: false }, raw)
}

fn totp_parse_secret(secret_b32: &str) -> Option<Vec<u8>> {
    let t = secret_b32.trim().replace([' ', '-'], "").to_ascii_uppercase();
    if t.is_empty() || t.len() > 128 {
        return None;
    }
    // Accept padded or unpadded.
    base32::decode(base32::Alphabet::Rfc4648 { padding: false }, &t)
        .or_else(|| base32::decode(base32::Alphabet::Rfc4648 { padding: true }, &t))
}

fn totp_check(secret_raw: &[u8], code: &str) -> bool {
    use totp_rs::Algorithm;
    let code = code.trim().replace([' ', '-'], "");
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let secret = totp_rs::Secret::new(secret_raw.to_vec().into_boxed_slice());
    let builder = totp_rs::Builder::new()
        .with_algorithm(Algorithm::SHA1)
        .with_digits(6)
        .with_skew(1)
        .with_step_duration(30)
        .with_secret(secret)
        .build();
    let Ok(totp) = builder else {
        return false;
    };
    totp.check_current(&code).is_some()
}

// Test-only helper (used from `#[cfg(test)]`); allow dead code in normal builds.
#[allow(dead_code)]
fn totp_current_for_tests(secret_raw: &[u8]) -> Option<String> {
    use totp_rs::Algorithm;
    let secret = totp_rs::Secret::new(secret_raw.to_vec().into_boxed_slice());
    let totp = totp_rs::Builder::new()
        .with_algorithm(Algorithm::SHA1)
        .with_digits(6)
        .with_skew(1)
        .with_step_duration(30)
        .with_secret(secret)
        .build()
        .ok()?;
    Some(totp.generate_current().to_string())
}

fn otpauth_uri(username: &str, secret_b32: &str) -> String {
    // `otpauth://totp/KS-SSH:alice?secret=…&issuer=KS-SSH&algorithm=SHA1&digits=6&period=30`
    let user = percent_encode(username);
    format!(
        "otpauth://totp/KS-SSH:{user}?secret={secret_b32}&issuer=KS-SSH&algorithm=SHA1&digits=6&period=30"
    )
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-' || b == b'~' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn new_recovery_codes() -> Vec<String> {
    (0..8)
        .map(|_| {
            (0..10)
                .map(|_| {
                    const ALPH: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
                    ALPH[fastrand::usize(..ALPH.len())] as char
                })
                .collect()
        })
        .collect()
}

fn hash_recovery(code: &str) -> [u8; 32] {
    hash_sha256(&format!("ks-ssh-recovery:{}", code.trim().to_ascii_uppercase()))
}

// ---------------------------------------------------------------------------
// Misc helpers.
// ---------------------------------------------------------------------------

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn new_session_token() -> String {
    (0..32).map(|_| format!("{:02x}", fastrand::u8(..))).collect()
}

fn new_state_token() -> String {
    (0..24).map(|_| format!("{:02x}", fastrand::u8(..))).collect()
}

fn new_pkce_verifier() -> String {
    // 32 random bytes → 43-char base64url (within 43..128).
    use base64::Engine as _;
    let mut raw = [0u8; 32];
    let _ = getrandom::fill(&mut raw);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw)
}

fn pkce_challenge(verifier: &str) -> String {
    use base64::Engine as _;
    let mut h = Sha256::new();
    h.update(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(h.finalize())
}

/// Client IP for audit rows: first `X-Forwarded-For` hop, else `X-Real-IP`,
/// else `"local"`. Never includes secrets.
pub fn client_ip(headers: &HeaderMap) -> String {
    if let Some(v) = headers.get("x-forwarded-for")
        && let Ok(s) = v.to_str()
        && let Some(first) = s.split(',').next()
    {
        let t = first.trim();
        if !t.is_empty() && t.len() <= 64 {
            return t.to_string();
        }
    }
    if let Some(v) = headers.get("x-real-ip")
        && let Ok(s) = v.to_str()
    {
        let t = s.trim();
        if !t.is_empty() && t.len() <= 64 {
            return t.to_string();
        }
    }
    "local".to_string()
}

/// Where extra users are persisted. `KS_SSH_USERS_FILE` wins (tests),
/// then `$XDG_CONFIG_HOME/ks-ssh/users.json`, else `~/.config/ks-ssh/users.json`.
pub fn default_users_file() -> PathBuf {
    if let Ok(p) = std::env::var("KS_SSH_USERS_FILE")
        && !p.trim().is_empty()
    {
        return PathBuf::from(p);
    }
    let base = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .map(|h| PathBuf::from(h).join(".config"))
        })
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    base.join("ks-ssh").join("users.json")
}

// ---------------------------------------------------------------------------
// Stored state.
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct StoredUser {
    pass: PassStored,
    created_at: i64,
    role: Role,
    totp_secret: Option<Vec<u8>>,
    totp_enabled: bool,
    recovery_hashes: Vec<[u8; 32]>,
    oidc_sub: Option<String>,
}

#[derive(Clone)]
struct SessionInfo {
    username: String,
    created_at: i64,
    last_seen: i64,
}

#[derive(Clone, Default)]
struct RateEntry {
    fails: u32,
    lockout_until: i64,
}

struct Inner {
    owner_pass: PassStored,
    owner_totp_secret: Option<Vec<u8>>,
    owner_totp_enabled: bool,
    owner_recovery: Vec<[u8; 32]>,
    owner_oidc_sub: Option<String>,
    /// Extra (non-owner) accounts by username.
    users: HashMap<String, StoredUser>,
    /// Active logins: session token -> info.
    sessions: HashMap<String, SessionInfo>,
    /// Rate-limit buckets keyed by `ip|user`.
    rate: HashMap<String, RateEntry>,
    /// OIDC subject -> username link (also stored per-user for persistence).
    oidc_links: HashMap<String, String>,
}

pub struct AuthState {
    owner_username: String,
    inner: Mutex<Inner>,
    users_file: Option<PathBuf>,
}

/// Authenticated caller injected by [`require_auth`] for downstream handlers.
#[derive(Clone, Debug)]
pub struct AuthContext {
    pub username: String,
    pub role: Role,
    pub is_owner: bool,
}

// `new`/`verify`/`owner_username` are exercised by unit tests;
// allow dead code in non-test builds.
#[allow(dead_code)]
impl AuthState {
    pub fn new(user: &str, pass: &str) -> Self {
        Self {
            owner_username: user.to_string(),
            inner: Mutex::new(Inner {
                owner_pass: PassStored::Argon2(hash_argon2(pass)),
                owner_totp_secret: None,
                owner_totp_enabled: false,
                owner_recovery: Vec::new(),
                owner_oidc_sub: None,
                users: HashMap::new(),
                sessions: HashMap::new(),
                rate: HashMap::new(),
                oidc_links: HashMap::new(),
            }),
            users_file: None,
        }
    }

    /// Like `new`, but loads/persists extra users at `path`.
    pub fn new_with_file(user: &str, pass: &str, path: PathBuf) -> Self {
        let (users, links) = load_users_file(&path);
        // Owner links: none persisted for owner (flag is source of truth).
        let _ = links;
        Self {
            owner_username: user.to_string(),
            inner: Mutex::new(Inner {
                owner_pass: PassStored::Argon2(hash_argon2(pass)),
                owner_totp_secret: None,
                owner_totp_enabled: false,
                owner_recovery: Vec::new(),
                owner_oidc_sub: None,
                users,
                sessions: HashMap::new(),
                rate: HashMap::new(),
                oidc_links: HashMap::new(),
            }),
            users_file: Some(path),
        }
    }

    pub fn owner_username(&self) -> &str {
        &self.owner_username
    }

    pub fn extra_user_count(&self) -> usize {
        self.inner.lock().map(|g| g.users.len()).unwrap_or(0)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn persist(&self, users: &HashMap<String, StoredUser>) {
        let Some(ref path) = self.users_file else {
            return;
        };
        if let Err(e) = save_users_file(path, users) {
            eprintln!("auth: cannot save users file {}: {e:#}", path.display());
        }
    }

    fn snapshot_users(&self) -> HashMap<String, StoredUser> {
        self.lock().users.clone()
    }

    /// The main password — used to confirm edit/delete of any account.
    pub fn verify_owner_pass(&self, attempt: &str) -> bool {
        self.lock().owner_pass.verify(attempt)
    }

    /// Any account (owner or extra).
    pub fn verify(&self, user: &str, pass: &str) -> bool {
        let g = self.lock();
        if user == self.owner_username {
            return g.owner_pass.verify(pass);
        }
        g.users.get(user).is_some_and(|u| u.pass.verify(pass))
    }

    fn is_owner_name(&self, name: &str) -> bool {
        name == self.owner_username
    }

    pub fn role_of(&self, username: &str) -> Option<Role> {
        let g = self.lock();
        if self.is_owner_name(username) {
            return Some(Role::Admin);
        }
        g.users.get(username).map(|u| u.role)
    }

    /// Rate-limit key (lowercased user so `Bob`/`bob` share a bucket).
    fn rate_key(ip: &str, user: &str) -> String {
        format!("{}|{}", ip.trim(), user.trim().to_ascii_lowercase())
    }

    /// `true` when `ip|user` is currently locked out.
    pub fn is_locked(&self, ip: &str, user: &str) -> bool {
        let g = self.lock();
        g.rate
            .get(&Self::rate_key(ip, user))
            .is_some_and(|e| e.lockout_until > now_secs())
    }

    /// Lockout expiry for `user` on any IP (for the Users page), if any.
    pub fn user_lockout_until(&self, username: &str) -> Option<i64> {
        let want = username.trim().to_ascii_lowercase();
        let g = self.lock();
        let now = now_secs();
        g.rate
            .iter()
            .filter(|(k, _)| k.split('|').nth(1).unwrap_or("") == want)
            .map(|(_, e)| e.lockout_until)
            .filter(|&u| u > now)
            .max()
    }

    fn record_fail(&self, ip: &str, user: &str) {
        let mut g = self.lock();
        let key = Self::rate_key(ip, user);
        let e = g.rate.entry(key).or_default();
        e.fails = e.fails.saturating_add(1);
        if e.fails >= RATE_MAX_FAILS {
            e.lockout_until = now_secs() + RATE_LOCKOUT_SECS;
        }
    }

    fn record_success(&self, ip: &str, user: &str) {
        let mut g = self.lock();
        g.rate.remove(&Self::rate_key(ip, user));
    }

    fn clear_lockout(&self, username: &str) {
        let want = username.trim().to_ascii_lowercase();
        let mut g = self.lock();
        g.rate.retain(|k, _| k.split('|').nth(1).unwrap_or("") != want);
    }

    fn totp_required_for(&self, g: &Inner, username: &str) -> bool {
        if self.is_owner_name(username) {
            g.owner_totp_enabled
        } else {
            g.users.get(username).is_some_and(|u| u.totp_enabled)
        }
    }

    fn verify_totp_for(&self, g: &Inner, username: &str, code: &str) -> bool {
        let secret = if self.is_owner_name(username) {
            g.owner_totp_secret.clone()
        } else {
            g.users.get(username).and_then(|u| u.totp_secret.clone())
        };
        match secret {
            Some(raw) => totp_check(&raw, code),
            None => false,
        }
    }

    fn verify_recovery_for(&self, username: &str, code: &str) -> bool {
        let h = hash_recovery(code);
        let mut g = self.lock();
        if self.is_owner_name(username) {
            if let Some(pos) = g.owner_recovery.iter().position(|x| ct_eq(x, &h)) {
                g.owner_recovery.remove(pos);
                let snap = g.users.clone();
                drop(g);
                self.persist(&snap);
                return true;
            }
            return false;
        }
        let ok = g
            .users
            .get(username)
            .is_some_and(|u| u.recovery_hashes.iter().any(|x| ct_eq(x, &h)));
        if ok {
            if let Some(u) = g.users.get_mut(username) {
                u.recovery_hashes.retain(|x| !ct_eq(x, &h));
            }
            let snap = g.users.clone();
            drop(g);
            self.persist(&snap);
            return true;
        }
        false
    }

    /// Log in; on success mints a fresh session token.
    /// `ip` is the audit/rate-limit key (never secrets). `totp` is the 6-digit
    /// code when the account has 2FA enabled (or a recovery code).
    /// Returns `LoginOutcome` so handlers can distinguish bad password (401)
    /// from locked (429) from missing 2FA.
    pub fn login(
        &self,
        user: &str,
        pass: &str,
        totp: Option<&str>,
        ip: &str,
    ) -> LoginOutcome {
        let user = user.trim().to_string();
        if user.is_empty() {
            return LoginOutcome::BadCredentials;
        }
        if self.is_locked(ip, &user) {
            return LoginOutcome::Locked;
        }
        // Verify password (supports legacy SHA-256 → Argon2id migration).
        let (ok, needs_migrate, totp_required) = {
            let g = self.lock();
            let is_owner = self.is_owner_name(&user);
            let ok = if is_owner {
                g.owner_pass.verify(pass)
            } else {
                g.users.get(&user).is_some_and(|u| u.pass.verify(pass))
            };
            if !ok {
                (false, false, false)
            } else {
                let needs_migrate = if is_owner {
                    g.owner_pass.is_legacy()
                } else {
                    g.users.get(&user).is_some_and(|u| u.pass.is_legacy())
                };
                let totp_required = self.totp_required_for(&g, &user);
                (true, needs_migrate, totp_required)
            }
        };
        if !ok {
            self.record_fail(ip, &user);
            if self.is_locked(ip, &user) {
                return LoginOutcome::Locked;
            }
            return LoginOutcome::BadCredentials;
        }
        // Password correct — migrate legacy hashes now (keeps old users.json
        // working once, then upgrades).
        if needs_migrate {
            let mut g = self.lock();
            let fresh = PassStored::Argon2(hash_argon2(pass));
            if self.is_owner_name(&user) {
                g.owner_pass = fresh;
            } else if let Some(u) = g.users.get_mut(&user) {
                u.pass = fresh;
            }
            let snap = g.users.clone();
            drop(g);
            self.persist(&snap);
        }
        // 2FA gate.
        if totp_required {
            let code = totp.map(str::trim).unwrap_or("");
            if code.is_empty() {
                return LoginOutcome::NeedTotp;
            }
            let totp_ok = {
                let g = self.lock();
                self.verify_totp_for(&g, &user, code)
            };
            if !totp_ok {
                // Recovery codes are single-use.
                if !self.verify_recovery_for(&user, code) {
                    self.record_fail(ip, &user);
                    if self.is_locked(ip, &user) {
                        return LoginOutcome::Locked;
                    }
                    return LoginOutcome::BadTotp;
                }
            }
        }
        self.record_success(ip, &user);
        let mut g = self.lock();
        let is_owner = self.is_owner_name(&user);
        let now = now_secs();
        let token = new_session_token();
        g.sessions.insert(
            token.clone(),
            SessionInfo {
                username: user.clone(),
                created_at: now,
                last_seen: now,
            },
        );
        // Opportunistic expiry sweep.
        let now2 = now;
        g.sessions.retain(|_, s| {
            now2 - s.created_at <= COOKIE_MAX_AGE as i64
                && now2 - s.last_seen <= IDLE_TIMEOUT_SECS
        });
        drop(g);
        // Role lookup after unlock (owner = admin).
        let role = self.role_of(&user).unwrap_or(Role::Viewer);
        LoginOutcome::Ok(LoginInfo {
            token,
            username: user,
            is_owner,
            role,
        })
    }

    /// Back-compat login without IP/TOTP (tests + internal callers).
    /// Uses `ip = "local"` and no TOTP code.
    pub fn login_simple(&self, user: &str, pass: &str) -> Option<LoginInfo> {
        match self.login(user, pass, None, "local") {
            LoginOutcome::Ok(info) => Some(info),
            _ => None,
        }
    }

    /// Log out one session; `true` when the token existed.
    pub fn logout(&self, token: &str) -> bool {
        self.lock().sessions.remove(token).is_some()
    }

    /// Live session context: checks 12h absolute + 30min idle expiry and
    /// slides `last_seen` forward. Returns `None` for unknown/expired tokens.
    pub fn session_context(&self, token: &str) -> Option<AuthContext> {
        let mut g = self.lock();
        let now = now_secs();
        let info = g.sessions.get(token)?.clone();
        if now - info.created_at > COOKIE_MAX_AGE as i64
            || now - info.last_seen > IDLE_TIMEOUT_SECS
        {
            g.sessions.remove(token);
            return None;
        }
        // Slide idle window.
        if let Some(s) = g.sessions.get_mut(token) {
            s.last_seen = now;
        }
        let is_owner = self.is_owner_name(&info.username);
        let role = if is_owner {
            Role::Admin
        } else {
            g.users.get(&info.username).map(|u| u.role).unwrap_or(Role::Operator)
        };
        Some(AuthContext {
            username: info.username,
            role,
            is_owner,
        })
    }

    /// `(username, is_owner)` for a live session token (expiry-checked).
    pub fn session_user(&self, token: &str) -> Option<(String, bool)> {
        self.session_context(token)
            .map(|c| (c.username, c.is_owner))
    }

    pub fn is_token_valid(&self, token: &str) -> bool {
        self.session_context(token).is_some()
    }

    /// Sessions for `username` (for revoke UI). Returns suffix-masked ids?
    /// We return full opaque ids only to the owner of the session or an admin
    /// via the handler (never logged).
    pub fn sessions_for(&self, username: &str) -> Vec<SessionView> {
        let g = self.lock();
        let now = now_secs();
        g.sessions
            .iter()
            .filter(|(_, s)| s.username == username)
            .map(|(tok, s)| SessionView {
                id_suffix: tok.chars().rev().take(6).collect::<String>(),
                created_at: s.created_at,
                last_seen: s.last_seen,
                age_secs: now.saturating_sub(s.created_at),
                idle_secs: now.saturating_sub(s.last_seen),
            })
            .collect()
    }

    pub fn session_count_for(&self, username: &str) -> usize {
        self.lock()
            .sessions
            .values()
            .filter(|s| s.username == username)
            .count()
    }

    /// Revoke all sessions of `username` except `keep_token`.
    /// Returns number revoked.
    pub fn revoke_sessions(&self, username: &str, keep_token: Option<&str>) -> usize {
        let mut g = self.lock();
        let before = g.sessions.len();
        let keep = keep_token.map(str::to_string);
        g.sessions
            .retain(|tok, s| s.username != username || keep.as_deref() == Some(tok.as_str()));
        before - g.sessions.len()
    }

    /// Owner first, then extras alphabetically.
    pub fn list_users(&self) -> Vec<UserInfo> {
        let g = self.lock();
        let mut out = vec![UserInfo {
            username: self.owner_username.clone(),
            is_owner: true,
            created_at: None,
            role: Role::Admin,
            totp_enabled: g.owner_totp_enabled,
            oidc: g.owner_oidc_sub.is_some(),
            locked: false,
            sessions: g.sessions.values().filter(|s| s.username == self.owner_username).count(),
        }];
        let mut extras: Vec<UserInfo> = g
            .users
            .iter()
            .map(|(name, u)| {
                let locked = g
                    .rate
                    .iter()
                    .any(|(k, e)| {
                        k.split('|').nth(1).unwrap_or("") == name.to_ascii_lowercase()
                            && e.lockout_until > now_secs()
                    });
                UserInfo {
                    username: name.clone(),
                    is_owner: false,
                    created_at: Some(u.created_at),
                    role: u.role,
                    totp_enabled: u.totp_enabled,
                    oidc: u.oidc_sub.is_some(),
                    locked,
                    sessions: g.sessions.values().filter(|s| &s.username == name).count(),
                }
            })
            .collect();
        extras.sort_by(|a, b| a.username.cmp(&b.username));
        out.extend(extras);
        out
    }

    pub fn create_user(
        &self,
        username: &str,
        password: &str,
        role: Option<Role>,
    ) -> Result<UserInfo, UserError> {
        let name = validate_username(username)?;
        validate_new_password(password)?;
        let role = role.unwrap_or(Role::Operator);
        let mut g = self.lock();
        if self.is_owner_name(&name) || g.users.contains_key(&name) {
            return Err(UserError::Exists);
        }
        let rec = StoredUser {
            pass: PassStored::Argon2(hash_argon2(password)),
            created_at: now_secs(),
            role,
            totp_secret: None,
            totp_enabled: false,
            recovery_hashes: Vec::new(),
            oidc_sub: None,
        };
        g.users.insert(name.clone(), rec);
        let snapshot = g.users.clone();
        drop(g);
        self.persist(&snapshot);
        Ok(UserInfo {
            username: name,
            is_owner: false,
            created_at: Some(now_secs()),
            role,
            totp_enabled: false,
            oidc: false,
            locked: false,
            sessions: 0,
        })
    }

    /// Change own password (self-service, no `owner_pass` needed).
    /// Verifies the current password, enforces min-12, rotates all other
    /// sessions of the account.
    pub fn change_own_password(
        &self,
        username: &str,
        current: &str,
        new_pass: &str,
        keep_token: Option<&str>,
    ) -> Result<(), UserError> {
        validate_new_password(new_pass)?;
        let mut g = self.lock();
        let is_owner = self.is_owner_name(username);
        let ok = if is_owner {
            g.owner_pass.verify(current)
        } else {
            g.users.get(username).is_some_and(|u| u.pass.verify(current))
        };
        if !ok {
            return Err(UserError::BadCurrentPass);
        }
        let fresh = PassStored::Argon2(hash_argon2(new_pass));
        if is_owner {
            g.owner_pass = fresh;
        } else if let Some(u) = g.users.get_mut(username) {
            u.pass = fresh;
        } else {
            return Err(UserError::NotFound);
        }
        let keep = keep_token.map(str::to_string);
        let target = username.to_string();
        g.sessions
            .retain(|tok, s| s.username != target || keep.as_deref() == Some(tok.as_str()));
        let snapshot = g.users.clone();
        drop(g);
        self.persist(&snapshot);
        Ok(())
    }

    /// Edit an account. Requires the **admin role** (enforced by the handler
    /// via RBAC) **and** the main password (`owner_pass`).
    /// The owner itself may only change its password (runtime-only); it can
    /// never be renamed. Password/role changes drop all other sessions of
    /// that account; `keep_token` (the caller's own session) survives.
    pub fn update_user(
        &self,
        target: &str,
        new_username: Option<&str>,
        new_password: Option<&str>,
        new_role: Option<Role>,
        owner_pass: &str,
        keep_token: Option<&str>,
    ) -> Result<UserInfo, UserError> {
        if !self.lock().owner_pass.verify(owner_pass) {
            return Err(UserError::BadOwnerPass);
        }
        let target = target.trim();
        let new_name = new_username
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(validate_username)
            .transpose()?;
        if let Some(pw) = new_password
            && !pw.is_empty()
        {
            validate_new_password(pw)?;
        }
        if new_name.is_none() && new_password.unwrap_or("").is_empty() && new_role.is_none() {
            return Err(UserError::NothingToChange);
        }

        let mut g = self.lock();
        let target_is_owner = self.is_owner_name(target);
        if !target_is_owner && !g.users.contains_key(target) {
            return Err(UserError::NotFound);
        }
        if target_is_owner && new_name.is_some() {
            return Err(UserError::OwnerProtected);
        }
        if let Some(ref nn) = new_name
            && (self.is_owner_name(nn) || g.users.contains_key(nn))
        {
            return Err(UserError::Exists);
        }

        if target_is_owner {
            if let Some(pw) = new_password
                && !pw.is_empty()
            {
                g.owner_pass = PassStored::Argon2(hash_argon2(pw));
            }
            // Owner is always admin — role changes ignored.
            let keep = keep_token.map(str::to_string);
            g.sessions
                .retain(|tok, s| s.username != target || keep.as_deref() == Some(tok.as_str()));
            return Ok(UserInfo {
                username: self.owner_username.clone(),
                is_owner: true,
                created_at: None,
                role: Role::Admin,
                totp_enabled: g.owner_totp_enabled,
                oidc: g.owner_oidc_sub.is_some(),
                locked: false,
                sessions: g.sessions.values().filter(|s| s.username == target).count(),
            });
        }

        // Extra account: take it out, mutate, re-insert (handles renames).
        let mut rec = g.users.remove(target).ok_or(UserError::NotFound)?;
        if let Some(pw) = new_password
            && !pw.is_empty()
        {
            rec.pass = PassStored::Argon2(hash_argon2(pw));
        }
        if let Some(r) = new_role {
            rec.role = r;
        }
        let final_name = new_name.unwrap_or_else(|| target.to_string());
        let password_changed = !new_password.unwrap_or("").is_empty();
        let role_changed = new_role.is_some();
        let renamed = final_name != target;
        let out_role = rec.role;
        let out_totp = rec.totp_enabled;
        let out_oidc = rec.oidc_sub.is_some();
        g.users.insert(final_name.clone(), rec);
        if password_changed || renamed || role_changed {
            let keep = keep_token.map(str::to_string);
            if renamed {
                let tokens: Vec<String> = g
                    .sessions
                    .iter()
                    .filter(|(_, s)| s.username == target)
                    .map(|(t, _)| t.clone())
                    .collect();
                for tok in tokens {
                    if (password_changed || role_changed) && keep.as_deref() != Some(tok.as_str()) {
                        g.sessions.remove(&tok);
                    } else if let Some(s) = g.sessions.get_mut(&tok) {
                        s.username = final_name.clone();
                    }
                }
            } else {
                g.sessions
                    .retain(|tok, s| s.username != target || keep.as_deref() == Some(tok.as_str()));
            }
        }
        let created = g.users.get(&final_name).map(|u| u.created_at);
        let sess_n = g.sessions.values().filter(|s| s.username == final_name).count();
        let snapshot = g.users.clone();
        drop(g);
        self.persist(&snapshot);
        Ok(UserInfo {
            username: final_name,
            is_owner: false,
            created_at: created,
            role: out_role,
            totp_enabled: out_totp,
            oidc: out_oidc,
            locked: false,
            sessions: sess_n,
        })
    }

    /// Delete an extra account. Requires admin RBAC (handler) + main password.
    /// The main account can never be deleted.
    pub fn delete_user(&self, target: &str, owner_pass: &str) -> Result<(), UserError> {
        if !self.lock().owner_pass.verify(owner_pass) {
            return Err(UserError::BadOwnerPass);
        }
        let target = target.trim();
        if self.is_owner_name(target) {
            return Err(UserError::OwnerProtected);
        }
        let mut g = self.lock();
        if g.users.remove(target).is_none() {
            return Err(UserError::NotFound);
        }
        g.sessions.retain(|_, s| s.username != target);
        // Clear any rate-limit buckets + OIDC links for the deleted user.
        let want = target.to_ascii_lowercase();
        g.rate.retain(|k, _| k.split('|').nth(1).unwrap_or("") != want);
        g.oidc_links.retain(|_, v| v != target);
        let snapshot = g.users.clone();
        drop(g);
        self.persist(&snapshot);
        Ok(())
    }

    /// Admin: clear lockout buckets for `target`.
    pub fn unlock_user(&self, target: &str) -> bool {
        let want = target.trim().to_ascii_lowercase();
        let mut g = self.lock();
        let before = g.rate.len();
        g.rate.retain(|k, _| k.split('|').nth(1).unwrap_or("") != want);
        g.rate.len() != before
    }

    // -- TOTP self-service -------------------------------------------------

    /// Start TOTP enrol: generates a fresh secret (disabled until verified).
    /// Returns `(otpauth_uri, secret_b32, recovery_codes_plaintext)`.
    pub fn totp_enroll(&self, username: &str) -> Result<(String, String, Vec<String>), UserError> {
        let raw = totp_secret_bytes();
        let b32 = totp_base32(&raw);
        let uri = otpauth_uri(username, &b32);
        let codes = new_recovery_codes();
        let hashes: Vec<[u8; 32]> = codes.iter().map(|c| hash_recovery(c)).collect();
        let mut g = self.lock();
        if self.is_owner_name(username) {
            g.owner_totp_secret = Some(raw);
            g.owner_totp_enabled = false;
            g.owner_recovery = hashes;
        } else {
            let u = g.users.get_mut(username).ok_or(UserError::NotFound)?;
            u.totp_secret = Some(raw);
            u.totp_enabled = false;
            u.recovery_hashes = hashes;
        }
        let snap = g.users.clone();
        drop(g);
        self.persist(&snap);
        Ok((uri, b32, codes))
    }

    /// Confirm TOTP enrol with a current code.
    pub fn totp_verify(&self, username: &str, code: &str) -> Result<(), UserError> {
        let ok = {
            let g = self.lock();
            let secret = if self.is_owner_name(username) {
                g.owner_totp_secret.clone()
            } else {
                g.users.get(username).and_then(|u| u.totp_secret.clone())
            };
            match secret {
                Some(raw) => totp_check(&raw, code),
                None => false,
            }
        };
        if !ok {
            return Err(UserError::BadTotp);
        }
        let mut g = self.lock();
        if self.is_owner_name(username) {
            g.owner_totp_enabled = true;
        } else {
            let u = g.users.get_mut(username).ok_or(UserError::NotFound)?;
            u.totp_enabled = true;
        }
        // Enabling 2FA rotates all other sessions (privilege change).
        let target = username.to_string();
        let keep: Vec<String> = g
            .sessions
            .iter()
            .filter(|(_, s)| s.username == target)
            .map(|(t, _)| t.clone())
            .collect();
        // Keep the most recent session only (caller's is among them; without
        // the token we conservatively keep the newest).
        if keep.len() > 1 {
            let mut sorted = keep.clone();
            sorted.sort_by_key(|t| {
                g.sessions.get(t).map(|s| s.last_seen).unwrap_or(0)
            });
            let newest = sorted.last().cloned();
            g.sessions.retain(|tok, s| {
                s.username != target || newest.as_deref() == Some(tok.as_str())
            });
        }
        let snap = g.users.clone();
        drop(g);
        self.persist(&snap);
        Ok(())
    }

    /// Disable TOTP (requires current password as confirmation).
    pub fn totp_disable(&self, username: &str, password: &str) -> Result<(), UserError> {
        let mut g = self.lock();
        let ok = if self.is_owner_name(username) {
            g.owner_pass.verify(password)
        } else {
            g.users.get(username).is_some_and(|u| u.pass.verify(password))
        };
        if !ok {
            return Err(UserError::BadCurrentPass);
        }
        if self.is_owner_name(username) {
            g.owner_totp_secret = None;
            g.owner_totp_enabled = false;
            g.owner_recovery.clear();
        } else {
            let u = g.users.get_mut(username).ok_or(UserError::NotFound)?;
            u.totp_secret = None;
            u.totp_enabled = false;
            u.recovery_hashes.clear();
        }
        let snap = g.users.clone();
        drop(g);
        self.persist(&snap);
        Ok(())
    }

    pub fn totp_enabled(&self, username: &str) -> bool {
        let g = self.lock();
        if self.is_owner_name(username) {
            g.owner_totp_enabled
        } else {
            g.users.get(username).is_some_and(|u| u.totp_enabled)
        }
    }

    // -- OIDC linking ------------------------------------------------------

    /// Link an OIDC subject to a username (persisted per-user).
    pub fn link_oidc(&self, username: &str, subject: &str) {
        let mut g = self.lock();
        if self.is_owner_name(username) {
            g.owner_oidc_sub = Some(subject.to_string());
        } else if let Some(u) = g.users.get_mut(username) {
            u.oidc_sub = Some(subject.to_string());
        } else {
            return;
        }
        g.oidc_links.insert(subject.to_string(), username.to_string());
        let snap = g.users.clone();
        drop(g);
        self.persist(&snap);
    }

    pub fn lookup_oidc(&self, subject: &str) -> Option<String> {
        self.lock().oidc_links.get(subject).cloned().or_else(|| {
            // Fallback: scan users (links map is in-memory only across restarts).
            let g = self.lock();
            if g.owner_oidc_sub.as_deref() == Some(subject) {
                return Some(self.owner_username.clone());
            }
            g.users.iter().find_map(|(name, u)| {
                if u.oidc_sub.as_deref() == Some(subject) {
                    Some(name.clone())
                } else {
                    None
                }
            })
        })
    }

    /// Auto-provision an OIDC user as viewer (or return the linked account).
    /// `email` is used for the username when available, else `sub` suffix.
    pub fn provision_oidc(&self, subject: &str, email: Option<&str>) -> String {
        if let Some(existing) = self.lookup_oidc(subject) {
            return existing;
        }
        let base = email
            .and_then(|e| e.split('@').next())
            .map(sanitize_oidc_name)
            .filter(|s| validate_username(s).is_ok())
            .unwrap_or_else(|| {
                let suffix: String = subject
                    .chars()
                    .filter(|c| c.is_ascii_alphanumeric())
                    .rev()
                    .take(8)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect();
                format!("oidc-{suffix}")
            });
        let mut g = self.lock();
        let mut name = base.clone();
        let mut n = 1;
        while self.is_owner_name(&name) || g.users.contains_key(&name) {
            n += 1;
            name = format!("{base}-{n}");
            if n > 99 {
                name = format!("oidc-{}", &new_state_token()[..8]);
                break;
            }
        }
        // Random unguessable password (OIDC-only login; password login disabled
        // only in the sense that nobody knows it).
        let random_pw: String = (0..32)
            .map(|_| format!("{:02x}", fastrand::u8(..)))
            .collect();
        g.users.insert(
            name.clone(),
            StoredUser {
                pass: PassStored::Argon2(hash_argon2(&random_pw)),
                created_at: now_secs(),
                role: Role::Viewer,
                totp_secret: None,
                totp_enabled: false,
                recovery_hashes: Vec::new(),
                oidc_sub: Some(subject.to_string()),
            },
        );
        g.oidc_links.insert(subject.to_string(), name.clone());
        let snap = g.users.clone();
        drop(g);
        self.persist(&snap);
        name
    }

    /// Mint a session for an already-authenticated OIDC user (post-callback).
    pub fn login_oidc_user(&self, username: &str) -> LoginInfo {
        let mut g = self.lock();
        let now = now_secs();
        let token = new_session_token();
        g.sessions.insert(
            token.clone(),
            SessionInfo {
                username: username.to_string(),
                created_at: now,
                last_seen: now,
            },
        );
        let is_owner = self.is_owner_name(username);
        let role = if is_owner {
            Role::Admin
        } else {
            g.users.get(username).map(|u| u.role).unwrap_or(Role::Viewer)
        };
        LoginInfo {
            token,
            username: username.to_string(),
            is_owner,
            role,
        }
    }
}

fn sanitize_oidc_name(s: &str) -> String {
    s.trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

/// Outcome of [`AuthState::login`] so handlers can return 401 vs 429 vs 2FA.
#[derive(Debug)]
pub enum LoginOutcome {
    Ok(LoginInfo),
    BadCredentials,
    BadTotp,
    NeedTotp,
    Locked,
}

// ---------------------------------------------------------------------------
// OIDC state (authorization-code + PKCE, behind flags).
// ---------------------------------------------------------------------------

/// OIDC config from `--oidc-issuer` / `--oidc-client-id` (+ friends).
/// Pending `state -> verifier` pairs live here (10min TTL).
pub struct OidcState {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: Option<String>,
    pub allow_domain: Option<String>,
    pending: Mutex<HashMap<String, (String, i64)>>,
}

impl OidcState {
    pub fn new(issuer: String, client_id: String, client_secret: Option<String>, allow_domain: Option<String>) -> Self {
        Self {
            issuer: issuer.trim_end_matches('/').to_string(),
            client_id,
            client_secret,
            allow_domain: allow_domain.map(|d| d.trim().to_ascii_lowercase()).filter(|d| !d.is_empty()),
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub fn enabled(&self) -> bool {
        !self.issuer.is_empty() && !self.client_id.is_empty()
    }

    /// Build the authorization URL + `state` for `GET /api/auth/oidc/login`.
    /// `callback` is the absolute `…/api/auth/oidc/callback` URL.
    pub fn auth_url(&self, callback: &str) -> (String, String) {
        let state = new_state_token();
        let verifier = new_pkce_verifier();
        let challenge = pkce_challenge(&verifier);
        {
            let mut g = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            g.insert(state.clone(), (verifier, now_secs()));
            // Sweep stale pendings.
            let now = now_secs();
            g.retain(|_, (_, t)| now - *t < 600);
        }
        let url = format!(
            "{}/authorize?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
            self.issuer,
            percent_encode(&self.client_id),
            percent_encode(callback),
            percent_encode("openid email profile"),
            percent_encode(&state),
            percent_encode(&challenge),
        );
        (url, state)
    }

    pub fn take_verifier(&self, state: &str) -> Option<String> {
        let mut g = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let (v, t) = g.remove(state)?;
        if now_secs() - t > 600 { None } else { Some(v) }
    }

    /// Domain whitelist check (`--oidc-allow-domain`). `None` = allow all.
    pub fn check_domain(&self, email: Option<&str>) -> bool {
        let Some(domain) = self.allow_domain.as_deref() else {
            return true;
        };
        let Some(email) = email else { return false };
        email
            .rsplit('@')
            .next()
            .is_some_and(|d| d.trim().to_ascii_lowercase() == domain)
    }
}

// ---------------------------------------------------------------------------
// Viewer PIN state (`--relay-auth`).
// ---------------------------------------------------------------------------

/// One-time viewer PINs for the relay share link (`--relay-auth`).
/// Only the SHA-256 hash is kept; the plaintext PIN is printed once by the
/// agent (or minted via `POST /api/relay/pin`) and never logged or put in a
/// query string. The PIN travels ONLY inside `enc`
/// (`{"type":"auth","pin":"..."}`) — never plaintext `hello` when both
/// sides do E2E. Each mint invalidates the previous PIN (one-time) and
/// PINs expire after [`RELAY_PIN_TTL_SECS`].
pub struct RelayPinState {
    hash: Mutex<Option<[u8; 32]>>,
    created_at: Mutex<i64>,
}

/// Viewer PIN lifetime: 15 minutes from mint. Expired PINs fail closed.
pub const RELAY_PIN_TTL_SECS: i64 = 15 * 60;

impl RelayPinState {
    pub fn new() -> Self {
        Self {
            hash: Mutex::new(None),
            created_at: Mutex::new(0),
        }
    }

    fn hash_pin(pin: &str) -> [u8; 32] {
        hash_sha256(&format!("ks-ssh-relay-pin:{}", pin.trim()))
    }

    /// Mint a fresh 6-digit PIN (invalidates the previous one).
    /// Returns the plaintext PIN (caller prints it once, never logs it).
    pub fn mint(&self) -> String {
        let pin: String = (0..6).map(|_| fastrand::u8(0..10).to_string()).collect();
        // Avoid `000000`-style trivial PINs.
        let pin = if pin.bytes().all(|b| b == pin.as_bytes()[0]) {
            format!("{}7", &pin[1..])
        } else {
            pin
        };
        *self.hash.lock().unwrap_or_else(|e| e.into_inner()) = Some(Self::hash_pin(&pin));
        *self.created_at.lock().unwrap_or_else(|e| e.into_inner()) = now_secs();
        pin
    }

    pub fn verify(&self, attempt: &str) -> bool {
        if self.expired() {
            return false;
        }
        let g = self.hash.lock().unwrap_or_else(|e| e.into_inner());
        match *g {
            // Constant-time compare — no early exit on first mismatch.
            Some(h) => ct_eq(&h, &Self::hash_pin(attempt)),
            None => false,
        }
    }

    /// True when no PIN is armed or the armed PIN passed its TTL.
    pub fn expired(&self) -> bool {
        let created = *self.created_at.lock().unwrap_or_else(|e| e.into_inner());
        let has = self.hash.lock().map(|g| g.is_some()).unwrap_or(false);
        if !has {
            return true;
        }
        now_secs().saturating_sub(created) > RELAY_PIN_TTL_SECS
    }

    pub fn has_pin(&self) -> bool {
        self.hash.lock().map(|g| g.is_some()).unwrap_or(false) && !self.expired()
    }

    pub fn created_at(&self) -> i64 {
        *self.created_at.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Default for RelayPinState {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Persistence (extra users only; hashes, never plaintext).
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct UsersFile {
    #[serde(default)]
    users: HashMap<String, FileUser>,
}

#[derive(Serialize, Deserialize)]
struct FileUser {
    pass_hash: String,
    created_at: i64,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    totp_secret: Option<String>,
    #[serde(default)]
    totp_enabled: bool,
    #[serde(default)]
    recovery_hashes: Vec<String>,
    #[serde(default)]
    oidc_sub: Option<String>,
}

fn load_users_file(path: &PathBuf) -> (HashMap<String, StoredUser>, HashMap<String, String>) {
    let Ok(bytes) = std::fs::read(path) else {
        return (HashMap::new(), HashMap::new());
    };
    let parsed: UsersFile = match serde_json::from_slice(&bytes) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("auth: ignoring unreadable users file {}: {e}", path.display());
            return (HashMap::new(), HashMap::new());
        }
    };
    let mut links = HashMap::new();
    let users = parsed
        .users
        .into_iter()
        .filter_map(|(name, fu)| {
            if validate_username(&name).is_err() {
                return None;
            }
            let pass = PassStored::from_file_string(&fu.pass_hash)?;
            let role = fu.role.as_deref().and_then(Role::parse).unwrap_or(Role::Operator);
            // Owner stays admin — a file role of admin on a non-owner name is
            // fine (explicit grant), but never downgrades the owner.
            let totp_secret = fu.totp_secret.as_deref().and_then(totp_parse_secret);
            let totp_enabled = fu.totp_enabled && totp_secret.is_some();
            let recovery_hashes: Vec<[u8; 32]> = fu
                .recovery_hashes
                .iter()
                .filter_map(|h| from_hex(h.trim()))
                .collect();
            if let Some(ref sub) = fu.oidc_sub
                && !sub.trim().is_empty()
            {
                links.insert(sub.clone(), name.clone());
            }
            Some((
                name,
                StoredUser {
                    pass,
                    created_at: fu.created_at,
                    role,
                    totp_secret,
                    totp_enabled,
                    recovery_hashes,
                    oidc_sub: fu.oidc_sub.filter(|s| !s.trim().is_empty()),
                },
            ))
        })
        .collect();
    (users, links)
}

fn save_users_file(path: &PathBuf, users: &HashMap<String, StoredUser>) -> anyhow::Result<()> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)?;
    }
    let file_users: HashMap<String, FileUser> = users
        .iter()
        .map(|(name, u)| {
            (
                name.clone(),
                FileUser {
                    pass_hash: u.pass.to_file_string(),
                    created_at: u.created_at,
                    role: Some(u.role.as_str().to_string()),
                    totp_secret: u.totp_secret.as_deref().map(totp_base32),
                    totp_enabled: u.totp_enabled,
                    recovery_hashes: u.recovery_hashes.iter().map(|h| to_hex(h)).collect(),
                    oidc_sub: u.oidc_sub.clone(),
                },
            )
        })
        .collect();
    let data = serde_json::to_vec_pretty(&UsersFile { users: file_users })?;
    std::fs::write(path, &data)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------

/// Shared app state: `auth` is `None` when `--user/--pass` were omitted
/// (open access, previous behaviour).
#[derive(Clone, Default)]
pub struct AppState {
    pub auth: Option<std::sync::Arc<AuthState>>,
    pub oidc: Option<std::sync::Arc<OidcState>>,
    pub relay_pin: Option<std::sync::Arc<RelayPinState>>,
}

#[derive(Clone, Debug)]
pub struct LoginInfo {
    pub token: String,
    pub username: String,
    pub is_owner: bool,
    pub role: Role,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct UserInfo {
    pub username: String,
    pub is_owner: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    pub role: Role,
    pub totp_enabled: bool,
    #[serde(default)]
    pub oidc: bool,
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub sessions: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct SessionView {
    pub id_suffix: String,
    pub created_at: i64,
    pub last_seen: i64,
    pub age_secs: i64,
    pub idle_secs: i64,
}

#[derive(Serialize)]
struct StatusResponse {
    protected: bool,
    authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_owner: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<Role>,
    #[serde(skip_serializing_if = "Option::is_none")]
    totp_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    oidc_enabled: Option<bool>,
}

/// GET /api/auth/status — public; tells the UI whether to show login.
pub async fn api_status(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match state.auth {
        None => (
            StatusCode::OK,
            Json(StatusResponse {
                protected: false,
                authenticated: true,
                user: None,
                is_owner: None,
                role: None,
                totp_enabled: None,
                oidc_enabled: None,
            }),
        )
            .into_response(),
        Some(ref auth) => {
            let ctx = raw_token_from_headers(&headers).and_then(|t| auth.session_context(&t));
            (
                StatusCode::OK,
                Json(StatusResponse {
                    protected: true,
                    authenticated: ctx.is_some(),
                    user: ctx.as_ref().map(|c| c.username.clone()),
                    is_owner: ctx.as_ref().map(|c| c.is_owner),
                    role: ctx.as_ref().map(|c| c.role),
                    totp_enabled: ctx
                        .as_ref()
                        .map(|c| auth.totp_enabled(&c.username)),
                    oidc_enabled: Some(state.oidc.as_ref().is_some_and(|o| o.enabled())),
                }),
            )
                .into_response()
        }
    }
}

/// GET /api/auth/me — role + 2FA status for the current session.
pub async fn api_me(State(state): State<AppState>, Extension(ctx): Extension<AuthContext>) -> Response {
    let Some(auth) = state.auth else {
        return (StatusCode::NOT_FOUND, "auth disabled").into_response();
    };
    let totp_enabled = auth.totp_enabled(&ctx.username);
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "user": ctx.username,
            "role": ctx.role,
            "is_owner": ctx.is_owner,
            "totp_enabled": totp_enabled,
            "oidc_enabled": state.oidc.as_ref().is_some_and(|o| o.enabled()),
        })),
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct LoginBody {
    pub username: Option<String>,
    pub password: Option<String>,
    // Accept `user`/`pass` aliases too (CLI flag naming).
    pub user: Option<String>,
    pub pass: Option<String>,
    /// TOTP 6-digit code (or recovery code) when 2FA is enabled.
    pub totp: Option<String>,
}

/// POST /api/auth/login {"username","password"[,"totp"]} — sets the session cookie.
pub async fn api_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(b): Json<LoginBody>,
) -> Response {
    let Some(auth) = state.auth else {
        return (StatusCode::NOT_FOUND, "auth disabled").into_response();
    };
    let user = b.username.or(b.user).unwrap_or_default();
    let pass = b.password.or(b.pass).unwrap_or_default();
    let ip = client_ip(&headers);
    match auth.login(user.trim(), &pass, b.totp.as_deref(), &ip) {
        LoginOutcome::Ok(info) => {
            crate::db::audit(&info.username, &ip, "login", &info.username, "ok");
            (
                StatusCode::OK,
                [
                    (header::SET_COOKIE, set_cookie_header(&info.token)),
                    (header::CACHE_CONTROL, "no-store".to_string()),
                ],
                Json(serde_json::json!({ "ok": true, "user": info.username, "is_owner": info.is_owner, "role": info.role })),
            )
                .into_response()
        }
        LoginOutcome::NeedTotp => {
            crate::db::audit(user.trim(), &ip, "login", user.trim(), "need-totp");
            (
                StatusCode::UNAUTHORIZED,
                [(header::CACHE_CONTROL, "no-store".to_string())],
                Json(serde_json::json!({ "ok": false, "need_totp": true, "error": "two-factor code required" })),
            )
                .into_response()
        }
        LoginOutcome::BadTotp => {
            crate::db::audit(user.trim(), &ip, "login", user.trim(), "bad-totp");
            (
                StatusCode::UNAUTHORIZED,
                [(header::CACHE_CONTROL, "no-store".to_string())],
                Json(serde_json::json!({ "ok": false, "error": "invalid two-factor code" })),
            )
                .into_response()
        }
        LoginOutcome::Locked => {
            crate::db::audit(user.trim(), &ip, "login", user.trim(), "locked");
            (
                StatusCode::TOO_MANY_REQUESTS,
                [(header::CACHE_CONTROL, "no-store".to_string())],
                Json(serde_json::json!({ "ok": false, "error": "too many attempts — locked for 5 minutes" })),
            )
                .into_response()
        }
        LoginOutcome::BadCredentials => {
            crate::db::audit(user.trim(), &ip, "login", user.trim(), "deny");
            (
                StatusCode::UNAUTHORIZED,
                [(header::CACHE_CONTROL, "no-store".to_string())],
                Json(serde_json::json!({ "ok": false, "error": "invalid username or password" })),
            )
                .into_response()
        }
    }
}

/// POST /api/auth/logout — invalidates the session + clears the cookie.
pub async fn api_logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(auth) = state.auth {
        let ip = client_ip(&headers);
        if let Some(tok) = raw_token_from_headers(&headers) {
            let who = auth.session_context(&tok).map(|c| c.username.clone());
            auth.logout(&tok);
            crate::db::audit(who.as_deref().unwrap_or("-"), &ip, "logout", who.as_deref().unwrap_or("-"), "ok");
        }
    }
    (
        StatusCode::OK,
        [(header::SET_COOKIE, clear_cookie_header())],
        Json(serde_json::json!({ "ok": true })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Self-service: change-password + TOTP.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ChangePasswordBody {
    pub current_password: Option<String>,
    pub current: Option<String>,
    pub new_password: Option<String>,
    pub new: Option<String>,
}

/// POST /api/auth/change-password {"current_password","new_password"}.
/// Self-service — no `owner_pass` needed. Verifies the current password.
pub async fn api_change_password_json(
    State(state): State<AppState>,
    headers: HeaderMap,
    Extension(ctx): Extension<AuthContext>,
    Json(b): Json<ChangePasswordBody>,
) -> Response {
    let Some(auth) = state.auth else {
        return (StatusCode::NOT_FOUND, "auth disabled").into_response();
    };
    let current = b.current_password.or(b.current).unwrap_or_default();
    let new_pass = b.new_password.or(b.new).unwrap_or_default();
    let keep = raw_token_from_headers(&headers);
    let ip = client_ip(&headers);
    match auth.change_own_password(&ctx.username, &current, &new_pass, keep.as_deref()) {
        Ok(()) => {
            crate::db::audit(&ctx.username, &ip, "password-change", &ctx.username, "ok");
            (
                StatusCode::OK,
                Json(serde_json::json!({ "ok": true })),
            )
                .into_response()
        }
        Err(e) => {
            crate::db::audit(&ctx.username, &ip, "password-change", &ctx.username, "deny");
            (e.status(), Json(serde_json::json!({ "error": e.message() }))).into_response()
        }
    }
}

#[derive(Serialize)]
struct TotpEnrollResponse {
    otpauth_uri: String,
    secret: String,
    recovery_codes: Vec<String>,
}

/// POST /api/auth/totp/enroll — fresh secret + otpauth URI + recovery codes.
/// The secret stays disabled until `verify` confirms a current code.
pub async fn api_totp_enroll(
    State(state): State<AppState>,
    headers: HeaderMap,
    Extension(ctx): Extension<AuthContext>,
) -> Response {
    let Some(auth) = state.auth else {
        return (StatusCode::NOT_FOUND, "auth disabled").into_response();
    };
    let ip = client_ip(&headers);
    match auth.totp_enroll(&ctx.username) {
        Ok((uri, secret, codes)) => {
            crate::db::audit(&ctx.username, &ip, "totp-enroll", &ctx.username, "ok");
            (
                StatusCode::OK,
                Json(TotpEnrollResponse {
                    otpauth_uri: uri,
                    secret,
                    recovery_codes: codes,
                }),
            )
                .into_response()
        }
        Err(e) => (e.status(), Json(serde_json::json!({ "error": e.message() }))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct TotpVerifyBody {
    pub code: Option<String>,
    pub totp: Option<String>,
}

/// POST /api/auth/totp/verify {"code"} — enable TOTP after checking a code.
pub async fn api_totp_verify(
    State(state): State<AppState>,
    headers: HeaderMap,
    Extension(ctx): Extension<AuthContext>,
    Json(b): Json<TotpVerifyBody>,
) -> Response {
    let Some(auth) = state.auth else {
        return (StatusCode::NOT_FOUND, "auth disabled").into_response();
    };
    let code = b.code.or(b.totp).unwrap_or_default();
    let ip = client_ip(&headers);
    match auth.totp_verify(&ctx.username, &code) {
        Ok(()) => {
            crate::db::audit(&ctx.username, &ip, "totp-verify", &ctx.username, "ok");
            (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
        }
        Err(e) => {
            crate::db::audit(&ctx.username, &ip, "totp-verify", &ctx.username, "deny");
            (e.status(), Json(serde_json::json!({ "error": e.message() }))).into_response()
        }
    }
}

#[derive(Deserialize)]
pub struct TotpDisableBody {
    pub password: Option<String>,
    pub current_password: Option<String>,
}

/// POST /api/auth/totp/disable {"password"} — remove 2FA (password confirm).
pub async fn api_totp_disable(
    State(state): State<AppState>,
    headers: HeaderMap,
    Extension(ctx): Extension<AuthContext>,
    Json(b): Json<TotpDisableBody>,
) -> Response {
    let Some(auth) = state.auth else {
        return (StatusCode::NOT_FOUND, "auth disabled").into_response();
    };
    let pw = b.password.or(b.current_password).unwrap_or_default();
    let ip = client_ip(&headers);
    match auth.totp_disable(&ctx.username, &pw) {
        Ok(()) => {
            crate::db::audit(&ctx.username, &ip, "totp-disable", &ctx.username, "ok");
            (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
        }
        Err(e) => {
            crate::db::audit(&ctx.username, &ip, "totp-disable", &ctx.username, "deny");
            (e.status(), Json(serde_json::json!({ "error": e.message() }))).into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// Users management (admin only via RBAC; 404 when auth is disabled).
// ---------------------------------------------------------------------------

/// GET /api/auth/users — list accounts (owner first).
pub async fn api_list_users(
    State(state): State<AppState>,
    Extension(ctx): Extension<AuthContext>,
) -> Response {
    let Some(auth) = state.auth else {
        return (StatusCode::NOT_FOUND, "auth disabled").into_response();
    };
    if ctx.role != Role::Admin {
        crate::db::audit(&ctx.username, "local", "user-list", "-", "deny");
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "admin only" })),
        )
            .into_response();
    }
    (StatusCode::OK, Json(serde_json::json!({ "users": auth.list_users() }))).into_response()
}

#[derive(Deserialize)]
pub struct CreateUserBody {
    pub username: Option<String>,
    pub password: Option<String>,
    pub role: Option<String>,
}

/// POST /api/auth/users {"username","password"[,"role"]} — admin only.
pub async fn api_create_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Extension(ctx): Extension<AuthContext>,
    Json(b): Json<CreateUserBody>,
) -> Response {
    let Some(auth) = state.auth else {
        return (StatusCode::NOT_FOUND, "auth disabled").into_response();
    };
    if ctx.role != Role::Admin {
        crate::db::audit(&ctx.username, &client_ip(&headers), "user-create", b.username.as_deref().unwrap_or("-"), "deny");
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "admin only" })),
        )
            .into_response();
    }
    let username = b.username.unwrap_or_default();
    let password = b.password.unwrap_or_default();
    let role = b.role.as_deref().and_then(Role::parse);
    if b.role.is_some() && role.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "role must be admin, operator or viewer" })),
        )
            .into_response();
    }
    match auth.create_user(&username, &password, role) {
        Ok(info) => {
            crate::db::audit(&ctx.username, &client_ip(&headers), "user-create", &info.username, "ok");
            (StatusCode::CREATED, Json(info)).into_response()
        }
        Err(e) => {
            crate::db::audit(&ctx.username, &client_ip(&headers), "user-create", username.trim(), "deny");
            (e.status(), Json(serde_json::json!({ "error": e.message() }))).into_response()
        }
    }
}

#[derive(Deserialize)]
pub struct UpdateUserBody {
    pub new_username: Option<String>,
    pub new_password: Option<String>,
    pub role: Option<String>,
    /// The **main** password — always required for edit.
    pub owner_pass: Option<String>,
}

/// PUT /api/auth/users/:username — rename / password / role (admin + main pass).
pub async fn api_update_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Extension(ctx): Extension<AuthContext>,
    Path(target): Path<String>,
    Json(b): Json<UpdateUserBody>,
) -> Response {
    let Some(auth) = state.auth else {
        return (StatusCode::NOT_FOUND, "auth disabled").into_response();
    };
    if ctx.role != Role::Admin {
        crate::db::audit(&ctx.username, &client_ip(&headers), "user-update", &target, "deny");
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "admin only" })),
        )
            .into_response();
    }
    let role = match b.role.as_deref() {
        None => None,
        Some(s) => match Role::parse(s) {
            Some(r) => Some(r),
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "error": "role must be admin, operator or viewer" })),
                )
                    .into_response();
            }
        },
    };
    let keep = raw_token_from_headers(&headers);
    let ip = client_ip(&headers);
    match auth.update_user(
        &target,
        b.new_username.as_deref(),
        b.new_password.as_deref(),
        role,
        b.owner_pass.as_deref().unwrap_or(""),
        keep.as_deref(),
    ) {
        Ok(info) => {
            crate::db::audit(&ctx.username, &ip, "user-update", &info.username, "ok");
            (StatusCode::OK, Json(info)).into_response()
        }
        Err(e) => {
            crate::db::audit(&ctx.username, &ip, "user-update", &target, "deny");
            (e.status(), Json(serde_json::json!({ "error": e.message() }))).into_response()
        }
    }
}

#[derive(Deserialize)]
pub struct DeleteUserBody {
    /// The **main** password — always required for delete.
    pub owner_pass: Option<String>,
}

/// DELETE /api/auth/users/:username — admin + main password.
pub async fn api_delete_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Extension(ctx): Extension<AuthContext>,
    Path(target): Path<String>,
    body: Option<Json<DeleteUserBody>>,
) -> Response {
    let Some(auth) = state.auth else {
        return (StatusCode::NOT_FOUND, "auth disabled").into_response();
    };
    if ctx.role != Role::Admin {
        crate::db::audit(&ctx.username, &client_ip(&headers), "user-delete", &target, "deny");
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "admin only" })),
        )
            .into_response();
    }
    let owner_pass = body.map(|Json(b)| b.owner_pass).unwrap_or(None).unwrap_or_default();
    let ip = client_ip(&headers);
    match auth.delete_user(&target, &owner_pass) {
        Ok(()) => {
            crate::db::audit(&ctx.username, &ip, "user-delete", &target, "ok");
            (
                StatusCode::OK,
                Json(serde_json::json!({ "ok": true })),
            )
                .into_response()
        }
        Err(e) => {
            crate::db::audit(&ctx.username, &ip, "user-delete", &target, "deny");
            (e.status(), Json(serde_json::json!({ "error": e.message() }))).into_response()
        }
    }
}

/// POST /api/auth/users/:username/unlock — clear rate-limit lockout (admin).
pub async fn api_unlock_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Extension(ctx): Extension<AuthContext>,
    Path(target): Path<String>,
) -> Response {
    let Some(auth) = state.auth else {
        return (StatusCode::NOT_FOUND, "auth disabled").into_response();
    };
    if ctx.role != Role::Admin {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "admin only" })),
        )
            .into_response();
    }
    let cleared = auth.unlock_user(&target);
    crate::db::audit(&ctx.username, &client_ip(&headers), "user-unlock", &target, if cleared { "ok" } else { "noop" });
    (StatusCode::OK, Json(serde_json::json!({ "ok": true, "cleared": cleared }))).into_response()
}

/// POST /api/auth/users/:username/revoke-sessions — drop all sessions (admin).
/// The caller's own session survives when revoking self.
pub async fn api_revoke_user_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Extension(ctx): Extension<AuthContext>,
    Path(target): Path<String>,
) -> Response {
    let Some(auth) = state.auth else {
        return (StatusCode::NOT_FOUND, "auth disabled").into_response();
    };
    if ctx.role != Role::Admin {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "admin only" })),
        )
            .into_response();
    }
    let keep = raw_token_from_headers(&headers);
    let n = auth.revoke_sessions(&target, keep.as_deref());
    crate::db::audit(&ctx.username, &client_ip(&headers), "session-revoke", &target, "ok");
    (StatusCode::OK, Json(serde_json::json!({ "ok": true, "revoked": n }))).into_response()
}

/// GET /api/auth/sessions/mine — own live sessions (suffix-masked ids).
pub async fn api_my_sessions(
    State(state): State<AppState>,
    Extension(ctx): Extension<AuthContext>,
) -> Response {
    let Some(auth) = state.auth else {
        return (StatusCode::NOT_FOUND, "auth disabled").into_response();
    };
    (
        StatusCode::OK,
        Json(serde_json::json!({ "sessions": auth.sessions_for(&ctx.username) })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Audit query (admin only).
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct AuditQuery {
    pub limit: Option<usize>,
    pub since: Option<i64>,
}

/// GET /api/audit?limit&since — newest-first audit rows (admin only).
pub async fn api_list_audit(
    State(state): State<AppState>,
    Extension(ctx): Extension<AuthContext>,
    Query(q): Query<AuditQuery>,
) -> Response {
    if state.auth.is_none() {
        return (StatusCode::NOT_FOUND, "auth disabled").into_response();
    }
    if ctx.role != Role::Admin {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "admin only" })),
        )
            .into_response();
    }
    let rows = crate::db::audit_list(q.limit.unwrap_or(100), q.since.unwrap_or(0));
    (StatusCode::OK, Json(serde_json::json!({ "audit": rows }))).into_response()
}

#[derive(Deserialize)]
pub struct AuditExportQuery {
    pub limit: Option<usize>,
    pub since: Option<i64>,
    /// `json` (default) or `csv`.
    pub format: Option<String>,
}

/// GET /api/audit/export?limit&since&format=json|csv — full audit dump
/// (admin only). CSV uses `Content-Disposition: attachment` for one-click
/// download from the Audit page. The export itself is audited (never data).
pub async fn api_export_audit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Extension(ctx): Extension<AuthContext>,
    Query(q): Query<AuditExportQuery>,
) -> Response {
    if state.auth.is_none() {
        return (StatusCode::NOT_FOUND, "auth disabled").into_response();
    }
    if ctx.role != Role::Admin {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "admin only" })),
        )
            .into_response();
    }
    let rows = crate::db::audit_list(q.limit.unwrap_or(1000), q.since.unwrap_or(0));
    crate::db::audit(&ctx.username, &client_ip(&headers), "audit-export", "-", "ok");
    if q.format.as_deref().unwrap_or("json").trim().eq_ignore_ascii_case("csv") {
        fn esc(s: &str) -> String {
            if s.contains([',', '"', '\n', '\r']) {
                format!("\"{}\"", s.replace('"', "\"\""))
            } else {
                s.to_string()
            }
        }
        let mut out = String::from("id,ts,actor,ip,action,target,result\n");
        for r in &rows {
            out.push_str(&format!(
                "{},{},{},{},{},{},{}\n",
                r.id,
                r.ts,
                esc(&r.actor),
                esc(&r.ip),
                esc(&r.action),
                esc(&r.target),
                esc(&r.result)
            ));
        }
        (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "text/csv; charset=utf-8".to_string()),
                (
                    header::CONTENT_DISPOSITION,
                    "attachment; filename=\"ks-ssh-audit.csv\"".to_string(),
                ),
            ],
            out,
        )
            .into_response()
    } else {
        (StatusCode::OK, Json(serde_json::json!({ "audit": rows }))).into_response()
    }
}

// ---------------------------------------------------------------------------
// OIDC handlers (only when `--oidc-issuer` + `--oidc-client-id` are set).
// ---------------------------------------------------------------------------

/// GET /api/auth/oidc/login — 302 to the issuer authorize URL (PKCE).
pub async fn api_oidc_login(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(oidc) = state.oidc else {
        return (StatusCode::NOT_FOUND, "oidc disabled").into_response();
    };
    if !oidc.enabled() {
        return (StatusCode::NOT_FOUND, "oidc disabled").into_response();
    }
    // Absolute callback from this request's Host (http is fine for homelab;
    // production should sit behind TLS).
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("127.0.0.1:8080");
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("http");
    let callback = format!("{scheme}://{host}/api/auth/oidc/callback");
    let (url, _state) = oidc.auth_url(&callback);
    ([(header::LOCATION, url)], StatusCode::FOUND).into_response()
}

#[derive(Deserialize)]
pub struct OidcCallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

/// GET /api/auth/oidc/callback — exchange code, whitelist domain,
/// auto-provision as viewer, mint session cookie. Tokens are never logged.
pub async fn api_oidc_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<OidcCallbackQuery>,
) -> Response {
    let (Some(auth), Some(oidc)) = (state.auth.clone(), state.oidc.clone()) else {
        return (StatusCode::NOT_FOUND, "oidc disabled").into_response();
    };
    if !oidc.enabled() {
        return (StatusCode::NOT_FOUND, "oidc disabled").into_response();
    }
    let ip = client_ip(&headers);
    if let Some(err) = q.error {
        crate::db::audit("-", &ip, "oidc-callback", "-", "deny");
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": format!("oidc: {err}") })),
        )
            .into_response();
    }
    let (Some(code), Some(st)) = (q.code, q.state) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "missing code/state" })),
        )
            .into_response();
    };
    let Some(verifier) = oidc.take_verifier(&st) else {
        crate::db::audit("-", &ip, "oidc-callback", "-", "deny");
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "bad or expired state" })),
        )
            .into_response();
    };
    // Never log `code` / tokens — only the outcome.
    match exchange_oidc_code(&oidc, &verifier, &code, &headers).await {
        Ok((sub, email)) => {
            if !oidc.check_domain(email.as_deref()) {
                crate::db::audit("-", &ip, "oidc-callback", email.as_deref().unwrap_or("-"), "deny");
                return (
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({ "error": "email domain not allowed" })),
                )
                    .into_response();
            }
            let username = auth.provision_oidc(&sub, email.as_deref());
            let info = auth.login_oidc_user(&username);
            crate::db::audit(&username, &ip, "oidc-login", &username, "ok");
            (
                StatusCode::OK,
                [
                    (header::SET_COOKIE, set_cookie_header(&info.token)),
                    (header::CACHE_CONTROL, "no-store".to_string()),
                ],
                Json(serde_json::json!({ "ok": true, "user": info.username, "role": info.role })),
            )
                .into_response()
        }
        Err(e) => {
            // Generic message — token/HTTP details stay server-side (stderr only).
            eprintln!("oidc exchange failed: {e:#}");
            crate::db::audit("-", &ip, "oidc-callback", "-", "deny");
            (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "error": "oidc exchange failed" })),
            )
                .into_response()
        }
    }
}

/// Exchange `code` for `sub`/`email` via discovery + token + userinfo.
/// Uses `reqwest` over TLS; secrets stay in memory and are never logged.
async fn exchange_oidc_code(
    oidc: &OidcState,
    verifier: &str,
    code: &str,
    headers: &HeaderMap,
) -> anyhow::Result<(String, Option<String>)> {
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;
    // 1. Discovery.
    let disc_url = format!("{}/.well-known/openid-configuration", oidc.issuer);
    let disc: serde_json::Value = http.get(&disc_url).send().await?.error_for_status()?.json().await?;
    let token_ep = disc
        .get("token_endpoint")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("no token_endpoint"))?
        .to_string();
    let userinfo_ep = disc
        .get("userinfo_endpoint")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    // 2. Token exchange (PKCE verifier, no client secret unless configured).
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("127.0.0.1:8080");
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("http");
    let redirect_uri = format!("{scheme}://{host}/api/auth/oidc/callback");
    let mut form: HashMap<&str, &str> = HashMap::new();
    form.insert("grant_type", "authorization_code");
    form.insert("code", code);
    form.insert("redirect_uri", &redirect_uri);
    form.insert("client_id", &oidc.client_id);
    form.insert("code_verifier", verifier);
    let mut req = http.post(&token_ep).form(&form);
    if let Some(secret) = oidc.client_secret.as_deref() {
        req = req.basic_auth(&oidc.client_id, Some(secret));
    }
    let tok: serde_json::Value = req.send().await?.error_for_status()?.json().await?;
    let access = tok
        .get("access_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let id_token = tok.get("id_token").and_then(|v| v.as_str()).unwrap_or("");
    // 3a. Prefer userinfo (TLS-authenticated, no local JWT verify needed).
    if let Some(ep) = userinfo_ep
        && !access.is_empty()
    {
        let info: serde_json::Value = http
            .get(&ep)
            .bearer_auth(&access)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        if let Some(sub) = info.get("sub").and_then(|v| v.as_str()) {
            let email = info.get("email").and_then(|v| v.as_str()).map(str::to_string);
            return Ok((sub.to_string(), email));
        }
    }
    // 3b. Fallback: unverified `id_token` claims (homelab scale — the token
    // came over TLS directly from the issuer's token endpoint).
    if !id_token.is_empty() {
        let parts: Vec<&str> = id_token.split('.').collect();
        if parts.len() >= 2 {
            use base64::Engine as _;
            let mut payload = parts[1].to_string();
            while !payload.len().is_multiple_of(4) {
                payload.push('=');
            }
            if let Ok(raw) = base64::engine::general_purpose::URL_SAFE.decode(&payload)
                && let Ok(v) = serde_json::from_slice::<serde_json::Value>(&raw)
                && let Some(sub) = v.get("sub").and_then(|s| s.as_str())
            {
                let email = v.get("email").and_then(|s| s.as_str()).map(str::to_string);
                return Ok((sub.to_string(), email));
            }
        }
    }
    anyhow::bail!("no sub in oidc response")
}

// ---------------------------------------------------------------------------
// Relay viewer PIN (`--relay-auth`).
// ---------------------------------------------------------------------------

/// GET /api/relay/pin/status — whether a viewer PIN is armed (never the PIN).
pub async fn api_relay_pin_status(
    State(state): State<AppState>,
    Extension(ctx): Extension<AuthContext>,
) -> Response {
    let _ = ctx;
    let Some(pin) = state.relay_pin else {
        return (
            StatusCode::OK,
            Json(serde_json::json!({ "relay_auth": false, "has_pin": false })),
        )
            .into_response();
    };
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "relay_auth": true,
            "has_pin": pin.has_pin(),
            "created_at": pin.created_at(),
        })),
    )
        .into_response()
}

/// POST /api/relay/pin — mint a fresh viewer PIN (operator+).
/// Returns the plaintext PIN **once**; it is never logged or stored.
pub async fn api_relay_pin_mint(
    State(state): State<AppState>,
    headers: HeaderMap,
    Extension(ctx): Extension<AuthContext>,
) -> Response {
    if ctx.role == Role::Viewer {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "operator only" })),
        )
            .into_response();
    }
    let Some(pin) = state.relay_pin else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "relay auth disabled (restart with --relay-auth)" })),
        )
            .into_response();
    };
    let fresh = pin.mint();
    // Audit records the mint event — never the PIN itself.
    crate::db::audit(&ctx.username, &client_ip(&headers), "relay-pin-mint", "relay", "ok");
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "ok": true,
            "pin": fresh,
            "note": "one-time viewer PIN — share out-of-band, never in query/logs",
        })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Compat helpers + middleware.
// ---------------------------------------------------------------------------

/// Compat helper: the raw session token from `Cookie:` / `Authorization:`.
pub fn raw_token_from_headers(headers: &HeaderMap) -> Option<String> {
    if let Some(cookie) = headers.get(header::COOKIE)
        && let Ok(s) = cookie.to_str()
    {
        for part in s.split(';') {
            let part = part.trim();
            if let Some(v) = part.strip_prefix(&format!("{COOKIE_NAME}=")) {
                let v = v.trim().trim_matches('"').to_string();
                if !v.is_empty() {
                    return Some(v);
                }
            }
        }
    }
    if let Some(h) = headers.get(header::AUTHORIZATION)
        && let Ok(s) = h.to_str()
        && let Some(v) = s.strip_prefix("Bearer ").map(str::trim)
        && !v.is_empty()
    {
        return Some(v.to_string());
    }
    None
}

#[allow(dead_code)] // exercised in tests; kept as public helper
pub fn is_authenticated(headers: &HeaderMap, auth: &AuthState) -> bool {
    raw_token_from_headers(headers).is_some_and(|t| auth.is_token_valid(&t))
}

fn set_cookie_header(token: &str) -> String {
    format!("{COOKIE_NAME}={token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age={COOKIE_MAX_AGE}")
}

fn clear_cookie_header() -> String {
    format!("{COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0")
}

/// Username rules for the Users page: 3–32 chars, letters/digits/`._-`.
fn validate_username(raw: &str) -> Result<String, UserError> {
    let name = raw.trim().to_string();
    if name.len() < USERNAME_MIN || name.len() > USERNAME_MAX {
        return Err(UserError::InvalidUsername);
    }
    if !name
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
    {
        return Err(UserError::InvalidUsername);
    }
    Ok(name)
}

fn validate_new_password(pw: &str) -> Result<(), UserError> {
    if pw.len() < MIN_PASSWORD_LEN {
        return Err(UserError::WeakPassword);
    }
    Ok(())
}

/// 0–4 strength score for the frontend meter (informational only;
/// enforcement is `len >= 12`).
#[allow(dead_code)] // exercised in tests; kept as public helper
pub fn password_strength(pw: &str) -> u8 {
    let mut score = 0u8;
    if pw.len() >= 12 {
        score += 1;
    }
    if pw.len() >= 16 {
        score += 1;
    }
    let classes = [
        pw.bytes().any(|b| b.is_ascii_lowercase()),
        pw.bytes().any(|b| b.is_ascii_uppercase()),
        pw.bytes().any(|b| b.is_ascii_digit()),
        pw.bytes().any(|b| !b.is_ascii_alphanumeric()),
    ]
    .iter()
    .filter(|&&b| b)
    .count();
    if classes >= 3 {
        score += 1;
    }
    if classes >= 4 && pw.len() >= 14 {
        score += 1;
    }
    score.min(4)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserError {
    InvalidUsername,
    WeakPassword,
    Exists,
    NotFound,
    BadOwnerPass,
    BadCurrentPass,
    BadTotp,
    OwnerProtected,
    NothingToChange,
}

impl UserError {
    fn status(&self) -> StatusCode {
        match self {
            UserError::InvalidUsername | UserError::WeakPassword | UserError::NothingToChange => {
                StatusCode::BAD_REQUEST
            }
            UserError::Exists => StatusCode::CONFLICT,
            UserError::NotFound => StatusCode::NOT_FOUND,
            UserError::BadOwnerPass
            | UserError::OwnerProtected
            | UserError::BadCurrentPass
            | UserError::BadTotp => StatusCode::FORBIDDEN,
        }
    }

    fn message(&self) -> &'static str {
        match self {
            UserError::InvalidUsername => {
                "username must be 3-32 chars: letters, digits, dot, underscore, dash"
            }
            UserError::WeakPassword => "password must be at least 12 characters",
            UserError::Exists => "that username is already taken",
            UserError::NotFound => "no such user",
            UserError::BadOwnerPass => "main password incorrect",
            UserError::BadCurrentPass => "current password incorrect",
            UserError::BadTotp => "invalid two-factor code",
            UserError::OwnerProtected => "the main account cannot be renamed or deleted",
            UserError::NothingToChange => "nothing to change",
        }
    }
}

// ---------------------------------------------------------------------------
// Middleware: session + RBAC gate for the protected routes.
// ---------------------------------------------------------------------------

pub async fn require_auth(
    State(auth): State<std::sync::Arc<AuthState>>,
    headers: HeaderMap,
    mut req: axum::http::Request<axum::body::Body>,
    next: axum::middleware::Next,
) -> Response {
    let token = raw_token_from_headers(&headers);
    let ctx = token.as_deref().and_then(|t| auth.session_context(t));
    let Some(ctx) = ctx else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "login required" })),
        )
            .into_response();
    };
    let method = req.method().as_str().to_string();
    let path = req.uri().path().to_string();
    if !role_allows(ctx.role, &method, &path) {
        let ip = client_ip(&headers);
        crate::db::audit(
            &ctx.username,
            &ip,
            "rbac-deny",
            &format!("{method} {path}"),
            "deny",
        );
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "forbidden for role", "role": ctx.role })),
        )
            .into_response();
    }
    req.extensions_mut().insert(ctx);
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn long_pw(s: &str) -> String {
        if s.len() >= 12 {
            s.to_string()
        } else {
            format!("{s}-long-enough-123")
        }
    }

    #[test]
    fn login_verify_roundtrip() {
        let a = AuthState::new("admin", "s3cret-pw-long-123");
        assert!(a.verify("admin", "s3cret-pw-long-123"));
        assert!(!a.verify("admin", "wrong"));
        assert!(!a.verify("root", "s3cret-pw-long-123"));
        assert!(!a.verify(" admin", "s3cret-pw-long-123"));
        assert!(a.verify_owner_pass("s3cret-pw-long-123"));
        assert!(!a.verify_owner_pass("nope"));
    }

    #[test]
    fn sessions_are_per_login_and_revocable() {
        let a = AuthState::new("u", "p-long-enough-123");
        let s1 = a.login_simple("u", "p-long-enough-123").expect("login");
        let s2 = a.login_simple("u", "p-long-enough-123").expect("login");
        assert_ne!(s1.token, s2.token);
        assert!(s1.is_owner && s2.is_owner);
        assert!(a.is_token_valid(&s1.token));
        assert!(!a.is_token_valid("bogus"));
        assert_eq!(a.session_user(&s1.token), Some(("u".to_string(), true)));
        assert!(a.logout(&s1.token));
        assert!(!a.is_token_valid(&s1.token));
        assert!(a.is_token_valid(&s2.token));
        assert!(!a.logout(&s1.token));
    }

    #[test]
    fn extra_user_crud_with_owner_pass_gate() {
        let a = AuthState::new("admin", "main-pass-long-123");
        // Create (min 12 chars now).
        let info = a
            .create_user("bob", &long_pw("bob-pass"), None)
            .expect("create");
        assert!(!info.is_owner);
        assert_eq!(info.role, Role::Operator);
        assert!(a.login_simple("bob", &long_pw("bob-pass")).is_some());
        assert!(a.login_simple("bob", "wrong").is_none());
        // Dup + validation.
        assert_eq!(
            a.create_user("bob", &long_pw("other"), None),
            Err(UserError::Exists)
        );
        assert_eq!(
            a.create_user("admin", &long_pw("other"), None),
            Err(UserError::Exists)
        );
        assert_eq!(
            a.create_user("ab", &long_pw("x"), None),
            Err(UserError::InvalidUsername)
        );
        assert_eq!(
            a.create_user("bob2", "123", None),
            Err(UserError::WeakPassword)
        );
        assert_eq!(
            a.create_user("bad name!", &long_pw("x"), None),
            Err(UserError::InvalidUsername)
        );
        // Edit needs the main password.
        assert_eq!(
            a.update_user("bob", None, Some(&long_pw("new")), None, "wrong-main", None),
            Err(UserError::BadOwnerPass)
        );
        let me = a.login_simple("bob", &long_pw("bob-pass")).expect("bob session");
        a.update_user(
            "bob",
            None,
            Some(&long_pw("new")),
            None,
            "main-pass-long-123",
            Some(&me.token),
        )
        .expect("edit");
        assert!(a.login_simple("bob", &long_pw("new")).is_some());
        assert!(a.login_simple("bob", &long_pw("bob-pass")).is_none());
        // Other sessions dropped, caller's kept.
        assert!(a.is_token_valid(&me.token));
        // Rename.
        a.update_user("bob", Some("bobby"), None, None, "main-pass-long-123", None)
            .expect("rename");
        assert!(a.login_simple("bobby", &long_pw("new")).is_some());
        assert!(a.login_simple("bob", &long_pw("new")).is_none());
        // Role change.
        a.update_user("bobby", None, None, Some(Role::Viewer), "main-pass-long-123", None)
            .expect("role");
        assert_eq!(a.role_of("bobby"), Some(Role::Viewer));
        // Owner rename/delete forbidden.
        assert_eq!(
            a.update_user("admin", Some("root"), None, None, "main-pass-long-123", None),
            Err(UserError::OwnerProtected)
        );
        assert_eq!(
            a.delete_user("admin", "main-pass-long-123"),
            Err(UserError::OwnerProtected)
        );
        // Delete needs the main password too.
        assert_eq!(
            a.delete_user("bobby", "wrong-main"),
            Err(UserError::BadOwnerPass)
        );
        a.delete_user("bobby", "main-pass-long-123").expect("delete");
        assert!(a.login_simple("bobby", &long_pw("new")).is_none());
        assert_eq!(
            a.delete_user("bobby", "main-pass-long-123"),
            Err(UserError::NotFound)
        );
    }

    #[test]
    fn owner_password_change_keeps_caller_session() {
        let a = AuthState::new("admin", "old-main-long-123");
        let me = a.login_simple("admin", "old-main-long-123").expect("login");
        let other = a.login_simple("admin", "old-main-long-123").expect("login");
        a.change_own_password("admin", "old-main-long-123", "new-main-long-123", Some(&me.token))
            .expect("owner pw change");
        assert!(a.login_simple("admin", "new-main-long-123").is_some());
        assert!(a.login_simple("admin", "old-main-long-123").is_none());
        assert!(a.is_token_valid(&me.token));
        assert!(!a.is_token_valid(&other.token));
    }

    #[test]
    fn users_persist_to_file_as_hashes() {
        let dir = std::env::temp_dir().join(format!("ks-ssh-auth-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("users.json");
        {
            let a = AuthState::new_with_file("admin", "main-pass-long-123", path.clone());
            a.create_user("carol", &long_pw("carol"), Some(Role::Viewer))
                .expect("create");
            let raw = std::fs::read_to_string(&path).expect("file written");
            assert!(raw.contains("carol"));
            assert!(!raw.contains("carol-pass"), "no plaintext passwords");
            assert!(raw.contains("$argon2"), "argon2id hashes");
        }
        let b = AuthState::new_with_file("admin", "main-pass-long-123", path.clone());
        assert!(b.login_simple("carol", &long_pw("carol")).is_some());
        assert_eq!(b.extra_user_count(), 1);
        assert_eq!(b.role_of("carol"), Some(Role::Viewer));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_sha256_users_migrate_on_login() {
        // Write an old-format users.json (unsalted SHA-256 hex) by hand.
        let dir = std::env::temp_dir().join(format!("ks-ssh-legacy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("users.json");
        let pw = "legacy-pass-long-123";
        let hex = to_hex(&hash_sha256(pw));
        let now = now_secs();
        std::fs::write(
            &path,
            serde_json::json!({ "users": { "dave": { "pass_hash": hex, "created_at": now } } }).to_string(),
        )
        .unwrap();
        let a = AuthState::new_with_file("admin", "main-pass-long-123", path.clone());
        // Old hash still logs in once (default role: operator).
        assert_eq!(a.role_of("dave"), Some(Role::Operator));
        assert!(a.login_simple("dave", pw).is_some());
        // …then upgrades to Argon2id on disk.
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("$argon2"), "migrated to argon2: {raw}");
        assert!(!raw.contains(&hex), "old sha256 hex gone");
        // Still logs in after migration.
        let b = AuthState::new_with_file("admin", "main-pass-long-123", path.clone());
        assert!(b.login_simple("dave", pw).is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rbac_matrix() {
        // viewer: reads only; operator: + writes (no kill/rm/chmod/users);
        // admin: everything.
        assert!(role_allows(Role::Viewer, "GET", "/api/files"));
        assert!(role_allows(Role::Viewer, "GET", "/api/ports"));
        assert!(role_allows(Role::Viewer, "GET", "/api/host"));
        assert!(role_allows(Role::Viewer, "GET", "/api/terms"));
        assert!(role_allows(Role::Viewer, "GET", "/v1/shell"));
        assert!(!role_allows(Role::Viewer, "DELETE", "/api/files"));
        assert!(!role_allows(Role::Viewer, "POST", "/api/files/chmod"));
        assert!(!role_allows(Role::Viewer, "POST", "/api/ports/kill"));
        assert!(!role_allows(Role::Viewer, "POST", "/api/files/upload"));
        assert!(!role_allows(Role::Viewer, "POST", "/api/files/mkdir"));
        assert!(!role_allows(Role::Viewer, "GET", "/api/auth/users"));
        assert!(!role_allows(Role::Viewer, "GET", "/api/audit"));

        assert!(role_allows(Role::Operator, "GET", "/api/files"));
        assert!(role_allows(Role::Operator, "POST", "/api/files/upload"));
        assert!(role_allows(Role::Operator, "POST", "/api/files/mkdir"));
        assert!(role_allows(Role::Operator, "PUT", "/api/files/content"));
        assert!(!role_allows(Role::Operator, "DELETE", "/api/files"));
        assert!(!role_allows(Role::Operator, "POST", "/api/files/chmod"));
        assert!(!role_allows(Role::Operator, "POST", "/api/ports/kill"));
        assert!(role_allows(Role::Operator, "DELETE", "/api/terms/abc123"));
        assert!(!role_allows(Role::Viewer, "DELETE", "/api/terms/abc123"));
        assert!(!role_allows(Role::Operator, "GET", "/api/auth/users"));
        assert!(!role_allows(Role::Operator, "POST", "/api/auth/users"));
        assert!(!role_allows(Role::Operator, "GET", "/api/audit"));

        assert!(role_allows(Role::Admin, "DELETE", "/api/files"));
        assert!(role_allows(Role::Admin, "POST", "/api/files/chmod"));
        assert!(role_allows(Role::Admin, "POST", "/api/ports/kill"));
        assert!(role_allows(Role::Admin, "GET", "/api/auth/users"));
        assert!(role_allows(Role::Admin, "GET", "/api/audit"));
        assert!(role_allows(Role::Admin, "GET", "/api/files"));
    }

    #[test]
    fn lockout_after_five_fails() {
        let a = AuthState::new("admin", "main-pass-long-123");
        a.create_user("eve", &long_pw("eve"), None).unwrap();
        let ip = format!("lockout-test-{}", now_secs());
        for _ in 0..5 {
            let out = a.login("eve", "wrong-pass-long", None, &ip);
            assert!(matches!(out, LoginOutcome::BadCredentials | LoginOutcome::Locked));
        }
        // 6th attempt (even correct) is locked.
        assert!(matches!(a.login("eve", &long_pw("eve"), None, &ip), LoginOutcome::Locked));
        assert!(a.is_locked(&ip, "eve"));
        // Other users on the same IP are not locked.
        assert!(!a.is_locked(&ip, "admin"));
        // Unlock clears it.
        a.unlock_user("eve");
        assert!(!a.is_locked(&ip, "eve"));
        assert!(matches!(
            a.login("eve", &long_pw("eve"), None, &ip),
            LoginOutcome::Ok(_)
        ));
    }

    #[test]
    fn totp_enroll_verify_roundtrip() {
        let a = AuthState::new("admin", "main-pass-long-123");
        a.create_user("ted", &long_pw("ted"), None).unwrap();
        // Enrol → disabled until verified.
        let (_uri, secret_b32, codes) = a.totp_enroll("ted").unwrap();
        assert!(!codes.is_empty());
        assert!(!a.totp_enabled("ted"));
        // Login without code now fails with NeedTotp? No — not enabled yet,
        // so plain login still works.
        assert!(a.login_simple("ted", &long_pw("ted")).is_some());
        // Verify with a current code.
        let raw = totp_parse_secret(&secret_b32).unwrap();
        let code = totp_current_for_tests(&raw).unwrap();
        a.totp_verify("ted", &code).unwrap();
        assert!(a.totp_enabled("ted"));
        // Now login requires the code.
        assert!(matches!(
            a.login("ted", &long_pw("ted"), None, "local"),
            LoginOutcome::NeedTotp
        ));
        let code2 = totp_current_for_tests(&raw).unwrap();
        assert!(matches!(
            a.login("ted", &long_pw("ted"), Some(&code2), "local"),
            LoginOutcome::Ok(_)
        ));
        // Recovery code works once.
        let rc = codes[0].clone();
        assert!(matches!(
            a.login("ted", &long_pw("ted"), Some(&rc), "local"),
            LoginOutcome::Ok(_)
        ));
        // Second use fails (single-use).
        assert!(!matches!(
            a.login("ted", &long_pw("ted"), Some(&rc), "local"),
            LoginOutcome::Ok(_)
        ));
    }

    #[test]
    fn oidc_domain_whitelist() {
        let o = OidcState::new(
            "https://id.example.com".into(),
            "cid".into(),
            None,
            Some("Example.COM".into()),
        );
        assert!(o.check_domain(Some("alice@example.com")));
        assert!(!o.check_domain(Some("bob@other.com")));
        assert!(!o.check_domain(None));
        let open = OidcState::new("https://id.example.com".into(), "cid".into(), None, None);
        assert!(open.check_domain(Some("anyone@anywhere.org")));
    }

    #[test]
    fn pkce_challenge_is_s256() {
        // RFC 7636 Appendix B vector.
        let v = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(pkce_challenge(v), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn cookie_and_bearer_extraction() {
        let a = AuthState::new("u", "p-long-enough-123");
        let s = a.login_simple("u", "p-long-enough-123").expect("login");
        let tok = s.token.clone();
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            format!("other=1; {COOKIE_NAME}={tok}; foo=bar").parse().unwrap(),
        );
        assert_eq!(raw_token_from_headers(&h), Some(tok.clone()));
        assert!(is_authenticated(&h, &a));

        let mut h2 = HeaderMap::new();
        h2.insert(header::COOKIE, "ks_ssh_auth=nope".parse().unwrap());
        assert!(!is_authenticated(&h2, &a));

        let mut h3 = HeaderMap::new();
        h3.insert(
            header::AUTHORIZATION,
            format!("Bearer {tok}").parse().unwrap(),
        );
        assert!(is_authenticated(&h3, &a));
    }

    #[test]
    fn password_policy_and_strength() {
        assert!(validate_new_password("short").is_err());
        assert!(validate_new_password("long-enough-123").is_ok());
        assert!(password_strength("abc") < password_strength("Long-enough-123!@#"));
    }

    #[test]
    fn relay_pin_verify_expiry_and_onetime() {
        let st = RelayPinState::new();
        assert!(!st.verify("000000"));
        let p1 = st.mint();
        assert_eq!(p1.len(), 6);
        assert!(st.has_pin());
        assert!(st.verify(&p1));
        assert!(!st.verify("000000"));
        // Each mint invalidates the previous PIN (one-time).
        let p2 = st.mint();
        assert!(st.verify(&p2));
        assert!(!st.verify(&p1));
        // TTL is enforced (15 min).
        assert_eq!(RELAY_PIN_TTL_SECS, 15 * 60);
    }
}
