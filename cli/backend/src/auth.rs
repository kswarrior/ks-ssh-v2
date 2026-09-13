//! Optional login gate for the local web UI (`--user` / `--pass`).
//!
//! When enabled, the frontend shows a login page and every sensitive
//! endpoint (`/api/*` except `/api/hello` + `/api/auth/*`, plus
//! `/v1/shell`) requires the session cookie. Auth is local-UI only —
//! the relay path (`--token`) is unaffected.

use std::sync::Arc;

use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Cookie carrying the session token (HttpOnly, same-origin).
pub const COOKIE_NAME: &str = "ks_ssh_auth";
/// Long-lived login (1 year); clearing the cookie logs out this browser.
const COOKIE_MAX_AGE: u64 = 365 * 24 * 60 * 60;

#[derive(Clone)]
pub struct AuthState {
    username: String,
    pass_hash: [u8; 32],
    session_token: String,
}

impl AuthState {
    pub fn new(user: &str, pass: &str) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(pass.as_bytes());
        let digest = hasher.finalize();
        let mut pass_hash = [0u8; 32];
        pass_hash.copy_from_slice(&digest);
        Self {
            username: user.to_string(),
            pass_hash,
            session_token: new_session_token(),
        }
    }

    pub fn username(&self) -> &str {
        &self.username
    }

    fn pass_matches(&self, attempt: &str) -> bool {
        let mut hasher = Sha256::new();
        hasher.update(attempt.as_bytes());
        let digest = hasher.finalize();
        // Constant-time-ish compare (no early exit on contents).
        let mut diff = 0u8;
        for (a, b) in self.pass_hash.iter().zip(digest.iter()) {
            diff |= a ^ b;
        }
        diff == 0
    }

    pub fn verify(&self, user: &str, pass: &str) -> bool {
        user == self.username && self.pass_matches(pass)
    }

    fn token_valid(&self, token: &str) -> bool {
        if token.len() != self.session_token.len() {
            return false;
        }
        let mut diff = 0u8;
        for (a, b) in self.session_token.bytes().zip(token.bytes()) {
            diff |= a ^ b;
        }
        diff == 0
    }
}

/// Shared app state: `auth` is `None` when `--user/--pass` were omitted
/// (open access, previous behaviour).
#[derive(Clone, Default)]
pub struct AppState {
    pub auth: Option<Arc<AuthState>>,
}

fn new_session_token() -> String {
    // 32 random bytes as hex — unguessable, safe to keep in memory.
    (0..32).map(|_| format!("{:02x}", fastrand::u8(..))).collect()
}

/// Pull the session token from `Cookie:` or `Authorization: Bearer`.
pub fn token_from_headers(headers: &HeaderMap, auth: &AuthState) -> Option<String> {
    if let Some(cookie) = headers.get(header::COOKIE)
        && let Ok(s) = cookie.to_str()
    {
        for part in s.split(';') {
            let part = part.trim();
            if let Some(v) = part.strip_prefix(&format!("{COOKIE_NAME}=")) {
                let v = v.trim().trim_matches('"').to_string();
                if auth.token_valid(&v) {
                    return Some(v);
                }
            }
        }
    }
    if let Some(h) = headers.get(header::AUTHORIZATION)
        && let Ok(s) = h.to_str()
        && let Some(v) = s.strip_prefix("Bearer ").map(str::trim)
        && auth.token_valid(v)
    {
        return Some(v.to_string());
    }
    None
}

pub fn is_authenticated(headers: &HeaderMap, auth: &AuthState) -> bool {
    token_from_headers(headers, auth).is_some()
}

fn set_cookie_header(token: &str) -> String {
    format!("{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={COOKIE_MAX_AGE}")
}

fn clear_cookie_header() -> String {
    format!("{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
}

// ---------------------------------------------------------------------------
// Handlers (always registered; no-op open-access when auth is disabled).
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct StatusResponse {
    protected: bool,
    authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    user: Option<String>,
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
            }),
        )
            .into_response(),
        Some(ref auth) => {
            let ok = is_authenticated(&headers, auth);
            (
                StatusCode::OK,
                Json(StatusResponse {
                    protected: true,
                    authenticated: ok,
                    user: ok.then(|| auth.username().to_string()),
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
    if auth.verify(user.trim(), &pass) {
        (
            StatusCode::OK,
            [
                (header::SET_COOKIE, set_cookie_header(&auth.session_token)),
                (header::CACHE_CONTROL, "no-store".to_string()),
            ],
            Json(serde_json::json!({ "ok": true, "user": auth.username() })),
        )
            .into_response()
    } else {
        (
            StatusCode::UNAUTHORIZED,
            [(header::CACHE_CONTROL, "no-store".to_string())],
            Json(serde_json::json!({ "ok": false, "error": "invalid username or password" })),
        )
            .into_response()
    }
}

/// POST /api/auth/logout — clears the session cookie on this browser.
pub async fn api_logout() -> Response {
    (
        StatusCode::OK,
        [(header::SET_COOKIE, clear_cookie_header())],
        Json(serde_json::json!({ "ok": true })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Middleware: reject unauthenticated callers of the protected routes.
// ---------------------------------------------------------------------------

pub async fn require_auth(
    State(auth): State<Arc<AuthState>>,
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
    }

    #[test]
    fn tokens_are_unique_and_validated() {
        let a = AuthState::new("u", "p");
        let b = AuthState::new("u", "p");
        assert_ne!(a.session_token, b.session_token);
        assert!(a.token_valid(&a.session_token));
        assert!(!a.token_valid(&b.session_token));
        assert!(!a.token_valid(""));
        assert!(!a.token_valid("short"));
    }

    #[test]
    fn cookie_and_bearer_extraction() {
        let a = AuthState::new("u", "p");
        let tok = a.session_token.clone();
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            format!("other=1; {COOKIE_NAME}={tok}; foo=bar").parse().unwrap(),
        );
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
