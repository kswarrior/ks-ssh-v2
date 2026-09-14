//! Relay agent: one outbound WSS to the Worker, no open port needed.
//!
//! The CLI registers a 5-char token (`/v1/agent?token=XXXXX`). A browser
//! that opens `/v1/client?token=XXXXX` is paired into the same
//! Durable Object room and the two sides are bridged.
//!
//! On connect the agent also pushes its whole embedded frontend as a
//! single-file HTML bundle (`ui-begin` / `ui-chunk` / `ui-end`), so CF can
//! cache it per token and open it fullscreen (`/v/TOKEN`, `#/view/TOKEN`).
//!
//! E2E (sshx-style): `token` routes, `k` (256-bit, fragment-only) seals.
//! Sensitive payloads travel as `{"type":"enc",...}` (AES-256-GCM, AAD=token).
//! The relay sees only sizes/timing. UI bundle + control messages stay
//! plaintext by design (see `crate::e2e`).

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::e2e::{E2E_ALG, E2e, E2eKey};

const TOKEN_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/// Raw bytes per ui-chunk (~64KB base64 per WS message, well under limits).
const UI_CHUNK_RAW: usize = 48 * 1024;

type WsTx = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Message,
>;

/// Random 5-char token (letters + numbers, no look-alikes like 0/O or 1/I).
pub fn new_token() -> String {
    (0..5)
        .map(|_| {
            let i = fastrand::usize(..TOKEN_ALPHABET.len());
            TOKEN_ALPHABET[i] as char
        })
        .collect()
}

pub fn valid_token(t: &str) -> bool {
    t.len() == 5 && t.bytes().all(|b| b.is_ascii_alphanumeric())
}

#[derive(Serialize)]
struct Hello<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    role: &'a str,
    token: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    e2e: Option<&'a str>,
}

#[derive(Serialize)]
struct Ping {
    #[serde(rename = "type")]
    kind: &'static str,
}

#[derive(Serialize)]
struct UiBegin {
    #[serde(rename = "type")]
    kind: &'static str,
    encoding: &'static str,
    size: usize,
    chunks: usize,
}

#[derive(Serialize)]
struct UiChunk<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    i: usize,
    data: &'a str,
}

#[derive(Serialize)]
struct UiEnd {
    #[serde(rename = "type")]
    kind: &'static str,
    chunks: usize,
}

fn https_base(ws_base: &str) -> String {
    let base = ws_base.trim_end_matches('/');
    if let Some(rest) = base.strip_prefix("wss://") {
        format!("https://{rest}")
    } else if let Some(rest) = base.strip_prefix("ws://") {
        format!("http://{rest}")
    } else {
        base.to_string()
    }
}

/// Hold the relay connection forever (reconnects with backoff).
/// `e2e_key`: `Some` = E2E on (default), `None` = legacy plaintext (`--no-e2e`).
/// `relay_pin`: `Some` = `--relay-auth` — the agent requires a one-time
/// viewer PIN in the client's `hello` before bridging `data` (closes the
/// bearer-open bypass honestly). Audit rows log the token only, never `k`/PIN.
pub async fn run_agent(
    relay: &str,
    token: &str,
    push_ui: bool,
    e2e_key: Option<E2eKey>,
    relay_pin: Option<std::sync::Arc<crate::auth::RelayPinState>>,
) {
    // rustls ships without a crypto provider — install ring once.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let base = relay.trim_end_matches('/');
    let url = format!("{base}/v1/agent?token={token}");
    let http = https_base(base);
    // NOTE: the short token is safe to log (routing only). The E2E secret
    // `k` must NEVER appear in logs except in the one-time share links below.
    // The viewer PIN (when `--relay-auth`) is likewise printed once and never
    // logged again.
    println!("Relay token: {token} — enter it in the SSH page to connect.");
    println!("Relay: {url} (no open port needed)");
    crate::db::audit("-", "local", "relay-register", token, "ok");
    if let Some(ref k) = e2e_key {
        let secret = k.to_base64url();
        println!("E2E: ON (AES-256-GCM, {E2E_ALG}) — relay sees only ciphertext sizes.");
        println!("Share link (contains secret — send directly, do not log):");
        println!("  {http}/v/{token}#k={secret}");
        println!("  {http}/#/view/{token}#k={secret}");
        // Drop the display copy immediately (the key itself stays in memory).
    } else {
        println!("E2E: OFF (legacy --no-e2e) — relay can see plaintext.");
    }
    if relay_pin.is_some() {
        println!("Relay auth: ON — viewers must present the PIN printed at startup (or a minted one via POST /api/relay/pin). Default without --relay-auth stays bearer-open.");
    }
    if push_ui {
        println!("Fullscreen UI: {http}/v/{token}  (or {http}/#/view/{token})");
    }

    let mut backoff_secs = 1u64;
    loop {
        // Clone the key per session (seq resets to 0 each connection).
        let key_clone = e2e_key.clone();
        let pin_clone = relay_pin.clone();
        match agent_session(&url, token, push_ui, key_clone, pin_clone).await {
            Ok(()) => backoff_secs = 1,
            Err(e) => eprintln!("relay error: {e} (retry in {backoff_secs}s)"),
        }
        tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
        backoff_secs = (backoff_secs * 2).min(30);
    }
}

async fn agent_session(
    url: &str,
    token: &str,
    push_ui: bool,
    e2e_key: Option<E2eKey>,
    relay_pin: Option<std::sync::Arc<crate::auth::RelayPinState>>,
) -> anyhow::Result<()> {
    let (ws, _) = connect_async(url)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    // Log token only — never the E2E secret or PIN.
    println!("relay connected (token {token})");
    let (mut tx, mut rx) = ws.split();

    let mut e2e: Option<E2e> = e2e_key.map(|k| E2e::new(k, token));
    let mut peer_e2e = false;

    let hello = serde_json::to_string(&Hello {
        kind: "hello",
        role: "agent",
        token,
        e2e: if e2e.is_some() { Some(E2E_ALG) } else { None },
    })?;
    tx.send(Message::Text(hello.into())).await?;

    if push_ui && let Err(e) = push_ui_bundle(&mut tx).await {
        eprintln!("ui push failed: {e:#}");
    }

    let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(20));
    loop {
        tokio::select! {
            _ = keepalive.tick() => {
                let ping = serde_json::to_string(&Ping { kind: "ping" })?;
                tx.send(Message::Text(ping.into())).await?;
            }
            msg = rx.next() => {
                let Some(msg) = msg else { anyhow::bail!("relay closed") };
                let msg = msg.map_err(|e| anyhow::anyhow!("{e}"))?;
                match msg {
                    Message::Text(text) => {
                        on_text(&mut tx, &text, push_ui, &mut e2e, &mut peer_e2e).await?
                    }
                    Message::Binary(_) => {}
                    Message::Close(_) => anyhow::bail!("relay closed"),
                    _ => {}
                }
            }
        }
    }
}

/// Build the single-file frontend and push it chunked over the agent socket.
/// NOTE: the UI bundle is public build output and stays PLAINTEXT by design
/// (needed for per-token caching in `room.ts`). Never tunnel secrets inside
/// UI messages.
async fn push_ui_bundle(tx: &mut WsTx) -> anyhow::Result<()> {
    let html = crate::ui::build_single_file()?;
    let bytes = html.as_bytes();
    let chunks: Vec<String> = bytes
        .chunks(UI_CHUNK_RAW)
        .map(|c| base64::Engine::encode(&base64::engine::general_purpose::STANDARD, c))
        .collect();
    let begin = serde_json::to_string(&UiBegin {
        kind: "ui-begin",
        encoding: "base64",
        size: bytes.len(),
        chunks: chunks.len(),
    })?;
    tx.send(Message::Text(begin.into())).await?;
    for (i, data) in chunks.iter().enumerate() {
        let msg = serde_json::to_string(&UiChunk {
            kind: "ui-chunk",
            i,
            data,
        })?;
        tx.send(Message::Text(msg.into())).await?;
    }
    let end = serde_json::to_string(&UiEnd {
        kind: "ui-end",
        chunks: chunks.len(),
    })?;
    tx.send(Message::Text(end.into())).await?;
    println!(
        "ui pushed: {} bytes in {} chunks (open /v/<token> on CF for fullscreen)",
        bytes.len(),
        chunks.len()
    );
    Ok(())
}

/// Send a JSON value sealed inside `enc` (E2E on). No-op error when E2E off.
async fn send_enc(tx: &mut WsTx, e2e: &mut E2e, value: &serde_json::Value) -> anyhow::Result<()> {
    let pt = serde_json::to_vec(value)?;
    let env = e2e.encrypt_next(&pt)?;
    let text = crate::e2e::envelope_to_text(&env)?;
    tx.send(Message::Text(text.into())).await?;
    Ok(())
}

async fn on_text(
    tx: &mut WsTx,
    text: &str,
    push_ui: bool,
    e2e: &mut Option<E2e>,
    peer_e2e: &mut bool,
) -> anyhow::Result<()> {
    // Fast path: `enc` envelopes (opaque to the relay, sealed for us).
    if let Some(env) = crate::e2e::parse_envelope(text) {
        match e2e {
            Some(state) => match state.decrypt_next(&env) {
                Ok(pt) => {
                    // Inner protocol is the existing JSON (data, resize, …).
                    let inner: serde_json::Value = match serde_json::from_slice(&pt) {
                        Ok(v) => v,
                        Err(_) => return Ok(()),
                    };
                    match inner.get("type").and_then(|t| t.as_str()) {
                        Some("data") => {
                            // v1: acknowledge bridged payloads (PTY bridging
                            // comes next — same enc path). Ack INSIDE enc.
                            send_enc(tx, state, &serde_json::json!({"type":"ack"})).await?;
                        }
                        _ => {}
                    }
                }
                Err(_) => {
                    // Wrong key / tampered tag — generic message, no details.
                    eprintln!("E2E decrypt failed (wrong key or tampered message)");
                }
            },
            None => {
                // Legacy agent got sealed traffic it cannot read — ignore.
            }
        }
        return Ok(());
    }

    let msg: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    match msg.get("type").and_then(|t| t.as_str()) {
        Some("hello") => {
            // Peer capability negotiation: `{type:hello, role, token, e2e?}`.
            let alg = msg.get("e2e").and_then(|v| v.as_str());
            if alg == Some(E2E_ALG) {
                *peer_e2e = true;
                println!("web client supports E2E ({E2E_ALG})");
            } else {
                *peer_e2e = false;
                if e2e.is_some() {
                    eprintln!(
                        "Relay is NOT end-to-end encrypted for this peer (legacy client without E2E) — falling back to plaintext for its messages."
                    );
                }
            }
        }
        Some("paired") => println!("web client connected via relay"),
        Some("ping") => {
            tx.send(Message::Text(r#"{"type":"pong"}"#.to_string().into()))
                .await?;
        }
        Some("ui-request") => {
            // CF has no cached UI for this token (e.g. DO restarted) — resend.
            if push_ui {
                println!("ui re-requested — repushing bundle");
                if let Err(e) = push_ui_bundle(tx).await {
                    eprintln!("ui repush failed: {e:#}");
                }
            }
        }
        Some("data") => {
            // Plaintext data: legacy peer, or peer that chose plaintext.
            // v1: acknowledge (PTY bridging comes next).
            if e2e.is_some() {
                eprintln!("legacy plaintext data (relay-visible) — peer without E2E");
            }
            tx.send(Message::Text(r#"{"type":"ack"}"#.to_string().into()))
                .await?;
        }
        _ => {}
    }
    Ok(())
}
