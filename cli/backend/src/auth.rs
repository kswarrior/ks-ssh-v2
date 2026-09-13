//! Optional login gate for the local web UI (`--user` / `--pass`).
//!
//! When enabled, the frontend shows a login page and every sensitive
//! endpoint (`/api/*` except `/api/hello` + `/api/auth/*`, plus
//! `/v1/shell`) requires the session cookie. Auth is local-UI only —
//! the relay path (`--token`) is unaffected.
//!
//! The CLI flags define the **main** (owner) account. Extra users can be
//! created from the Settings → Users page; they are persisted as salted
//! SHA-256 hashes in a JSON file (default
//! `$XDG_CONFIG_HOME/ks-ssh/users.json`, else `~/.config/ks-ssh/users.json`,
//! overridable via `KS_SSH_USERS_FILE`).
//!
//! Editing or deleting any account requires confirming with the **main**
//! password (`owner_pass`). The main account itself can only have its
//! password changed (runtime-only — the `--pass` flag stays the source of
//! truth across restarts) and can never be renamed or deleted.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Mutex,
};

use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Cookie carrying the session token (HttpOnly, same-origin).
pub const COOKIE_NAME: &str = "ks_ssh_auth";
/// Long-lived login (1 year); logging out invalidates the token server-side.
const COOKIE_MAX_AGE: u64 = 365 * 24 * 60 * 60;
/// Minimum password length for accounts created/changed via the Users page.
/// (The `--pass` flag itself accepts any non-empty value.)
pub const MIN_PASSWORD_LEN: usize = 4;
/// Username rules for accounts created/changed via the Users page.
const USERNAME_MIN: usize = 3;
const USERNAME_MAX: usize = 32;

fn hash_pass(pass: &str) -> [u8; 32] {
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

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn new_session_token() -> String {
    // 32 random bytes as hex — unguessable, safe to keep in memory.
    (0..32).map(|_| format!("{:02x}", fastrand::u8(..))).collect()
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

#[derive(Clone)]
struct StoredUser {
    pass_hash: [u8; 32],
    created_at: i64,
}

struct Inner {
    owner_pass_hash: [u8; 32],
    /// Extra (non-owner) accounts by username.
    users: HashMap<String, StoredUser>,
    /// Active logins: session token -> username.
    sessions: HashMap<String, String>,
}

pub struct AuthState {
    owner_username: String,
    inner: Mutex<Inner>,
    users_file: Option<PathBuf>,
}

impl AuthState {
    pub fn new(user: &str, pass: &str) -> Self {
        Self {
            owner_username: user.to_string(),
            inner: Mutex::new(Inner {
                owner_pass_hash: hash_pass(pass),
                users: HashMap::new(),
                sessions: HashMap::new(),
            }),
            users_file: None,
        }
    }

    /// Like `new`, but loads/persists extra users at `path`.
    pub fn new_with_file(user: &str, pass: &str, path: PathBuf) -> Self {
        let users = load_users_file(&path);
        Self {
            owner_username: user.to_string(),
            inner: Mutex::new(Inner {
                owner_pass_hash: hash_pass(pass),
                users,
                sessions: HashMap::new(),
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

    /// The main password — used to confirm edit/delete of any account.
    pub fn verify_owner_pass(&self, attempt: &str) -> bool {
        ct_eq(&self.lock().owner_pass_hash, &hash_pass(attempt))
    }

    /// Any account (owner or extra). Legacy single-user API.
    pub fn verify(&self, user: &str, pass: &str) -> bool {
        let g = self.lock();
        if user == self.owner_username {
            return ct_eq(&g.owner_pass_hash, &hash_pass(pass));
        }
        g.users
            .get(user)
            .is_some_and(|u| ct_eq(&u.pass_hash, &hash_pass(pass)))
    }

    fn is_owner_name(&self, name: &str) -> bool {
        name == self.owner_username
    }

    /// Log in; on success mints a fresh session token.
    pub fn login(&self, user: &str, pass: &str) -> Option<LoginInfo> {
        let user = user.trim();
        let mut g = self.lock();
        let is_owner = self.is_owner_name(user);
        let ok = if is_owner {
            ct_eq(&g.owner_pass_hash, &hash_pass(pass))
        } else {
            g.users
                .get(user)
                .is_some_and(|u| ct_eq(&u.pass_hash, &hash_pass(pass)))
        };
        if !ok {
            return None;
        }
        let token = new_session_token();
        g.sessions.insert(token.clone(), user.to_string());
        Some(LoginInfo {
            token,
            username: user.to_string(),
            is_owner,
        })
    }

    /// Log out one session; `true` when the token existed.
    pub fn logout(&self, token: &str) -> bool {
        self.lock().sessions.remove(token).is_some()
    }

    /// `(username, is_owner)` for a live session token.
    pub fn session_user(&self, token: &str) -> Option<(String, bool)> {
        let g = self.lock();
        let name = g.sessions.get(token)?.clone();
        Some((name.clone(), self.is_owner_name(&name)))
    }

    pub fn is_token_valid(&self, token: &str) -> bool {
        self.lock().sessions.contains_key(token)
    }

    /// Owner first, then extras alphabetically.
    pub fn list_users(&self) -> Vec<UserInfo> {
        let g = self.lock();
        let mut out = vec![UserInfo {
            username: self.owner_username.clone(),
            is_owner: true,
            created_at: None,
        }];
        let mut extras: Vec<UserInfo> = g
            .users
            .iter()
            .map(|(name, u)| UserInfo {
                username: name.clone(),
                is_owner: false,
                created_at: Some(u.created_at),
            })
            .collect();
        extras.sort_by(|a, b| a.username.cmp(&b.username));
        out.extend(extras);
        out
    }

    pub fn create_user(&self, username: &str, password: &str) -> Result<UserInfo, UserError> {
        let name = validate_username(username)?;
        validate_new_password(password)?;
        let mut g = self.lock();
        if self.is_owner_name(&name) || g.users.contains_key(&name) {
            return Err(UserError::Exists);
        }
        let rec = StoredUser {
            pass_hash: hash_pass(password),
            created_at: now_secs(),
        };
        g.users.insert(name.clone(), rec);
        let snapshot = g.users.clone();
        drop(g);
        self.persist(&snapshot);
        Ok(UserInfo {
            username: name,
            is_owner: false,
            created_at: Some(now_secs()),
        })
    }

    /// Edit an account. `owner_pass` (the **main** password) is always
    /// required. The owner itself may only change its password
    /// (runtime-only); it can never be renamed. Password changes drop all
    /// other sessions of that account; `keep_token` (the caller's own
    /// session) survives so a self-change doesn't log you out mid-click.
    pub fn update_user(
        &self,
        target: &str,
        new_username: Option<&str>,
        new_password: Option<&str>,
        owner_pass: &str,
        keep_token: Option<&str>,
    ) -> Result<UserInfo, UserError> {
        if !self.verify_owner_pass(owner_pass) {
            return Err(UserError::BadOwnerPass);
        }
        let target = target.trim();
        let new_name = new_username
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(validate_username)
            .transpose()?;
        if let Some(ref pw) = new_password
            && !pw.is_empty()
        {
            validate_new_password(pw)?;
        }
        if new_name.is_none() && new_password.as_deref().unwrap_or("").is_empty() {
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
            // Owner rename is forbidden (checked above); only password changes.
            if let Some(pw) = new_password
                && !pw.is_empty()
            {
                g.owner_pass_hash = hash_pass(pw);
            }
            let keep = keep_token.map(str::to_string);
            g.sessions
                .retain(|tok, name| name != target || keep.as_deref() == Some(tok.as_str()));
            return Ok(UserInfo {
                username: self.owner_username.clone(),
                is_owner: true,
                created_at: None,
            });
        }

        // Extra account: take it out, mutate, re-insert (handles renames).
        let mut rec = g.users.remove(target).ok_or(UserError::NotFound)?;
        if let Some(pw) = new_password
            && !pw.is_empty()
        {
            rec.pass_hash = hash_pass(pw);
        }
        let final_name = new_name.unwrap_or_else(|| target.to_string());
        let password_changed = !new_password.as_deref().unwrap_or("").is_empty();
        let renamed = final_name != target;
        g.users.insert(final_name.clone(), rec);
        if password_changed || renamed {
            let keep = keep_token.map(str::to_string);
            if renamed {
                // Move sessions to the new name (or drop them on pw change).
                let tokens: Vec<String> = g
                    .sessions
                    .iter()
                    .filter(|(_, n)| *n == target)
                    .map(|(t, _)| t.clone())
                    .collect();
                for tok in tokens {
                    if password_changed && keep.as_deref() != Some(tok.as_str()) {
                        g.sessions.remove(&tok);
                    } else {
                        g.sessions.insert(tok, final_name.clone());
                    }
                }
            } else {
                g.sessions
                    .retain(|tok, name| name != target || keep.as_deref() == Some(tok.as_str()));
            }
        }
        let created = g.users.get(&final_name).map(|u| u.created_at);
        let snapshot = g.users.clone();
        drop(g);
        self.persist(&snapshot);
        Ok(UserInfo {
            username: final_name,
            is_owner: false,
            created_at: created,
        })
    }

    /// Delete an extra account. Requires the **main** password.
    /// The main account can never be deleted.
    pub fn delete_user(&self, target: &str, owner_pass: &str) -> Result<(), UserError> {
        if !self.verify_owner_pass(owner_pass) {
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
        g.sessions.retain(|_, name| name != target);
        let snapshot = g.users.clone();
        drop(g);
        self.persist(&snapshot);
        Ok(())
    }
}

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

pub fn is_authenticated(headers: &HeaderMap, auth: &AuthState) -> bool {
    raw_token_from_headers(headers).is_some_and(|t| auth.is_token_valid(&t))
}

fn set_cookie_header(token: &str) -> String {
    format!("{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={COOKIE_MAX_AGE}")
}

fn clear_cookie_header() -> String {
    format!("{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserError {
    InvalidUsername,
    WeakPassword,
    Exists,
    NotFound,
    BadOwnerPass,
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
            UserError::BadOwnerPass | UserError::OwnerProtected => StatusCode::FORBIDDEN,
        }
    }

    fn message(&self) -> &'static str {
        match self {
            UserError::InvalidUsername => {
                "username must be 3-32 chars: letters, digits, dot, underscore, dash"
            }
            UserError::WeakPassword => "password must be at least 4 characters",
            UserError::Exists => "that username is already taken",
            UserError::NotFound => "no such user",
            UserError::BadOwnerPass => "main password incorrect",
            UserError::OwnerProtected => "the main account cannot be renamed or deleted",
            UserError::NothingToChange => "nothing to change",
        }
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
}

fn load_users_file(path: &PathBuf) -> HashMap<String, StoredUser> {
    let Ok(bytes) = std::fs::read(path) else {
        return HashMap::new();
    };
    let parsed: UsersFile = match serde_json::from_slice(&bytes) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("auth: ignoring unreadable users file {}: {e}", path.display());
            return HashMap::new();
        }
    };
    parsed
        .users
        .into_iter()
        .filter_map(|(name, fu)| {
            if validate_username(&name).is_err() {
                return None;
            }
            Some((
                name,
                StoredUser {
                    pass_hash: from_hex(fu.pass_hash.trim())?,
                    created_at: fu.created_at,
                },
            ))
        })
        .collect()
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
                    pass_hash: to_hex(&u.pass_hash),
                    created_at: u.created_at,
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
}

#[derive(Clone)]
pub struct LoginInfo {
    pub token: String,
    pub username: String,
    pub is_owner: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct UserInfo {
    pub username: String,
    pub is_owner: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
}

#[derive(Serialize)]
struct StatusResponse {
    protected: bool,
    authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_owner: Option<bool>,
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
            }),
        )
            .into_response(),
        Some(ref auth) => {
            let session = raw_token_from_headers(&headers).and_then(|t| auth.session_user(&t));
            (
                StatusCode::OK,
                Json(StatusResponse {
                    protected: true,
                    authenticated: session.is_some(),
                    user: session.as_ref().map(|(u, _)| u.clone()),
                    is_owner: session.map(|(_, o)| o),
                }),
            )
                .into_response()
        }
    }
}

#[derive(Deserialize)]
pub struct LoginBody {
    pub username: Option<String>,
    pub password: Option<String>,
    // Accept `user`/`pass` aliases too (CLI flag naming).
    pub user: Option<String>,
    pub pass: Option<String>,
}

/// POST /api/auth/login {"username","password"} — sets the session cookie.
pub async fn api_login(State(state): State<AppState>, Json(b): Json<LoginBody>) -> Response {
    let Some(auth) = state.auth else {
        return (StatusCode::NOT_FOUND, "auth disabled").into_response();
    };
    let user = b.username.or(b.user).unwrap_or_default();
    let pass = b.password.or(b.pass).unwrap_or_default();
    match auth.login(user.trim(), &pass) {
        Some(info) => (
            StatusCode::OK,
            [
                (header::SET_COOKIE, set_cookie_header(&info.token)),
                (header::CACHE_CONTROL, "no-store".to_string()),
            ],
            Json(serde_json::json!({ "ok": true, "user": info.username, "is_owner": info.is_owner })),
        )
            .into_response(),
        None => (
            StatusCode::UNAUTHORIZED,
            [(header::CACHE_CONTROL, "no-store".to_string())],
            Json(serde_json::json!({ "ok": false, "error": "invalid username or password" })),
        )
            .into_response(),
    }
}

/// POST /api/auth/logout — invalidates the session + clears the cookie.
pub async fn api_logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(auth) = state.auth
        && let Some(tok) = raw_token_from_headers(&headers)
    {
        auth.logout(&tok);
    }
    (
        StatusCode::OK,
        [(header::SET_COOKIE, clear_cookie_header())],
        Json(serde_json::json!({ "ok": true })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Users management (behind `require_auth`; 404 when auth is disabled).
// ---------------------------------------------------------------------------

/// GET /api/auth/users — list accounts (owner first).
pub async fn api_list_users(State(state): State<AppState>) -> Response {
    let Some(auth) = state.auth else {
        return (StatusCode::NOT_FOUND, "auth disabled").into_response();
    };
    (StatusCode::OK, Json(serde_json::json!({ "users": auth.list_users() }))).into_response()
}

#[derive(Deserialize)]
pub struct CreateUserBody {
    pub username: Option<String>,
    pub password: Option<String>,
}

/// POST /api/auth/users {"username","password"} — create an extra account.
/// Any logged-in user may create; edit/delete additionally require the
/// main password (see below).
pub async fn api_create_user(State(state): State<AppState>, Json(b): Json<CreateUserBody>) -> Response {
    let Some(auth) = state.auth else {
        return (StatusCode::NOT_FOUND, "auth disabled").into_response();
    };
    let username = b.username.unwrap_or_default();
    let password = b.password.unwrap_or_default();
    match auth.create_user(&username, &password) {
        Ok(info) => (StatusCode::CREATED, Json(info)).into_response(),
        Err(e) => (e.status(), Json(serde_json::json!({ "error": e.message() }))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct UpdateUserBody {
    pub new_username: Option<String>,
    pub new_password: Option<String>,
    /// The **main** password — always required for edit.
    pub owner_pass: Option<String>,
}

/// PUT /api/auth/users/:username — rename and/or change password.
/// Requires the main password; the main account may only change its
/// password (never be renamed).
pub async fn api_update_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(target): Path<String>,
    Json(b): Json<UpdateUserBody>,
) -> Response {
    let Some(auth) = state.auth else {
        return (StatusCode::NOT_FOUND, "auth disabled").into_response();
    };
    let keep = raw_token_from_headers(&headers);
    match auth.update_user(
        &target,
        b.new_username.as_deref(),
        b.new_password.as_deref(),
        b.owner_pass.as_deref().unwrap_or(""),
        keep.as_deref(),
    ) {
        Ok(info) => (StatusCode::OK, Json(info)).into_response(),
        Err(e) => (e.status(), Json(serde_json::json!({ "error": e.message() }))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct DeleteUserBody {
    /// The **main** password — always required for delete.
    pub owner_pass: Option<String>,
}

/// DELETE /api/auth/users/:username — delete an extra account.
/// Requires the main password; the main account can never be deleted.
pub async fn api_delete_user(
    State(state): State<AppState>,
    Path(target): Path<String>,
    body: Option<Json<DeleteUserBody>>,
) -> Response {
    let Some(auth) = state.auth else {
        return (StatusCode::NOT_FOUND, "auth disabled").into_response();
    };
    let owner_pass = body.map(|Json(b)| b.owner_pass).unwrap_or(None).unwrap_or_default();
    match auth.delete_user(&target, &owner_pass) {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({ "ok": true })),
        )
            .into_response(),
        Err(e) => (e.status(), Json(serde_json::json!({ "error": e.message() }))).into_response(),
    }
}

// ---------------------------------------------------------------------------
// Middleware: reject unauthenticated callers of the protected routes.
// ---------------------------------------------------------------------------

pub async fn require_auth(
    State(auth): State<std::sync::Arc<AuthState>>,
    headers: HeaderMap,
    req: axum::http::Request<axum::body::Body>,
    next: axum::middleware::Next,
) -> Response {
    if is_authenticated(&headers, &auth) {
        next.run(req).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "login required" })),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_verify_roundtrip() {
        let a = AuthState::new("admin", "s3cret!");
        assert!(a.verify("admin", "s3cret!"));
        assert!(!a.verify("admin", "wrong"));
        assert!(!a.verify("root", "s3cret!"));
        assert!(!a.verify(" admin", "s3cret!"));
        assert!(a.verify_owner_pass("s3cret!"));
        assert!(!a.verify_owner_pass("nope"));
    }

    #[test]
    fn sessions_are_per_login_and_revocable() {
        let a = AuthState::new("u", "p");
        let s1 = a.login("u", "p").expect("login");
        let s2 = a.login("u", "p").expect("login");
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
        let a = AuthState::new("admin", "main-pass");
        // Create.
        let info = a.create_user("bob", "bob-pass").expect("create");
        assert!(!info.is_owner);
        assert!(a.login("bob", "bob-pass").is_some());
        assert!(a.login("bob", "wrong").is_none());
        // Dup + validation.
        assert_eq!(a.create_user("bob", "other-pass"), Err(UserError::Exists));
        assert_eq!(a.create_user("admin", "other-pass"), Err(UserError::Exists));
        assert_eq!(a.create_user("ab", "long-enough"), Err(UserError::InvalidUsername));
        assert_eq!(a.create_user("bob2", "123"), Err(UserError::WeakPassword));
        assert_eq!(a.create_user("bad name!", "long-enough"), Err(UserError::InvalidUsername));
        // Edit needs the main password.
        assert_eq!(
            a.update_user("bob", None, Some("new-pass"), "wrong-main", None),
            Err(UserError::BadOwnerPass)
        );
        let me = a.login("bob", "bob-pass").expect("bob session");
        a.update_user("bob", None, Some("new-pass"), "main-pass", Some(&me.token))
            .expect("edit");
        assert!(a.login("bob", "new-pass").is_some());
        assert!(a.login("bob", "bob-pass").is_none());
        // Other sessions dropped, caller's kept.
        assert!(a.is_token_valid(&me.token));
        // Rename.
        a.update_user("bob", Some("bobby"), None, "main-pass", None)
            .expect("rename");
        assert!(a.login("bobby", "new-pass").is_some());
        assert!(a.login("bob", "new-pass").is_none());
        // Owner rename/delete forbidden.
        assert_eq!(
            a.update_user("admin", Some("root"), None, "main-pass", None),
            Err(UserError::OwnerProtected)
        );
        assert_eq!(a.delete_user("admin", "main-pass"), Err(UserError::OwnerProtected));
        // Delete needs the main password too.
        assert_eq!(a.delete_user("bobby", "wrong-main"), Err(UserError::BadOwnerPass));
        a.delete_user("bobby", "main-pass").expect("delete");
        assert!(a.login("bobby", "new-pass").is_none());
        assert_eq!(a.delete_user("bobby", "main-pass"), Err(UserError::NotFound));
    }

    #[test]
    fn owner_password_change_keeps_caller_session() {
        let a = AuthState::new("admin", "old-main");
        let me = a.login("admin", "old-main").expect("login");
        let other = a.login("admin", "old-main").expect("login");
        a.update_user("admin", None, Some("new-main"), "old-main", Some(&me.token))
            .expect("owner pw change");
        assert!(a.login("admin", "new-main").is_some());
        assert!(a.login("admin", "old-main").is_none());
        assert!(a.is_token_valid(&me.token));
        assert!(!a.is_token_valid(&other.token));
    }

    #[test]
    fn users_persist_to_file_as_hashes() {
        let dir = std::env::temp_dir().join(format!("ks-ssh-auth-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("users.json");
        {
            let a = AuthState::new_with_file("admin", "main-pass", path.clone());
            a.create_user("carol", "carol-pass").expect("create");
            let raw = std::fs::read_to_string(&path).expect("file written");
            assert!(raw.contains("carol"));
            assert!(!raw.contains("carol-pass"), "no plaintext passwords");
        }
        let b = AuthState::new_with_file("admin", "main-pass", path.clone());
        assert!(b.login("carol", "carol-pass").is_some());
        assert_eq!(b.extra_user_count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cookie_and_bearer_extraction() {
        let a = AuthState::new("u", "p");
        let s = a.login("u", "p").expect("login");
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
}
