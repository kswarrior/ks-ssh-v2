//! Floating chat widget API (`/api/chat`, persisted in SQLite).
//!
//! - `GET /api/chat?since=<id>&limit=<n>` — oldest-first messages.
//! - `POST /api/chat {"message":"..."}` — append one message.
//!   Username comes from the session (`AuthContext`) when the login gate is
//!   on, else `"guest"`. Works with or without `--user/--pass` (same
//!   `Option<Extension<AuthContext>>` pattern as `files.rs`).

use axum::{
    Extension, Json,
    extract::Query,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};

use crate::{auth, db};

#[derive(Debug, Deserialize)]
pub struct ChatListQuery {
    #[serde(default)]
    pub since: i64,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct ChatPostBody {
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatMessageOut {
    pub id: i64,
    pub ts: i64,
    pub username: String,
    pub message: String,
}

fn actor(opt_ctx: &Option<Extension<auth::AuthContext>>) -> String {
    opt_ctx
        .as_ref()
        .map(|Extension(c)| c.username.clone())
        .unwrap_or_else(|| "guest".to_string())
}

/// GET /api/chat — oldest-first, `?since=` cursor, `?limit=` (1..500).
pub async fn api_list_chat(Query(q): Query<ChatListQuery>) -> Response {
    let since = q.since.max(0);
    let limit = q.limit.unwrap_or(200).clamp(1, 500);
    let messages: Vec<ChatMessageOut> = db::chat_list(limit, since)
        .into_iter()
        .map(|m| ChatMessageOut {
            id: m.id,
            ts: m.ts,
            username: m.username,
            message: m.message,
        })
        .collect();
    (StatusCode::OK, Json(serde_json::json!({ "messages": messages }))).into_response()
}

/// POST /api/chat {"message"} — validate + persist, echo the stored row.
pub async fn api_post_chat(
    opt_ctx: Option<Extension<auth::AuthContext>>,
    headers: HeaderMap,
    Json(b): Json<ChatPostBody>,
) -> Response {
    let username = actor(&opt_ctx);
    let message = b.message.unwrap_or_default();
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "message is empty" })),
        )
            .into_response();
    }
    if trimmed.len() > 2000 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "message too long (max 2000 chars)" })),
        )
            .into_response();
    }
    let stored = db::chat_insert(&username, trimmed);
    let ip = auth::client_ip(&headers);
    db::audit(&username, &ip, "chat-send", &format!("id={}", stored.id), "ok");
    (
        StatusCode::CREATED,
        Json(ChatMessageOut {
            id: stored.id,
            ts: stored.ts,
            username: stored.username,
            message: stored.message,
        }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actor_falls_back_to_guest() {
        let none: Option<Extension<auth::AuthContext>> = None;
        assert_eq!(actor(&none), "guest");
    }

    #[test]
    fn chat_insert_and_list_roundtrip() {
        db::chat_clear_for_tests();
        let tag = format!("chat-test-{}", db::now_ms());
        let m = db::chat_insert("tester", &tag);
        assert!(!m.message.is_empty());
        let rows = db::chat_list(100, 0);
        assert!(rows.iter().any(|r| r.message == tag));
    }
}
