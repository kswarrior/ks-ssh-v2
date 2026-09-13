//! Relay agent: one outbound WSS to the Worker, no open port needed.
//!
//! The CLI registers a 5-char token (`/v1/agent?token=XXXXX`). A browser
//! that opens `/v1/client?token=XXXXX` is paired into the same
//! Durable Object room and the two sides are bridged.
//!
//! On connect the agent also pushes its whole embedded frontend as a
//! single-file HTML bundle (`ui-begin` / `ui-chunk` / `ui-end`), so CF can
//! cache it per token and open it fullscreen (`/v/TOKEN`, `#/view/TOKEN`).

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio_tungstenite::{connect_async, tungstenite::Message};

const TOKEN_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/// Raw bytes per ui-chunk (~64KB base64 per WS message, well under limits).
const UI_CHUNK_RAW: usize = 48 * 1024;

type WsTx = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
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
}

#[derive(Serialize)]
struct Ping<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
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
pub async fn run_agent(relay: &str, token: &str, push_ui: bool) {
    // rustls ships without a crypto provider — install ring once.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let base = relay.trim_end_matches('/');
    let url = format!("{base}/v1/agent?token={token}");
    let http = https_base(base);
    println!("Relay token: {token} — enter it in the SSH page to connect.");
    println!("Relay: {url} (no open port needed)");
    if push_ui {
        println!("Fullscreen UI: {http}/v/{token}  (or {http}/#/view/{token})");
    }

    let mut backoff_secs = 1u64;
    loop {
        match agent_session(&url, token, push_ui).await {
            Ok(()) => backoff_secs = 1,
            Err(e) => eprintln!("relay error: {e} (retry in {backoff_secs}s)"),
        }
        tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
        backoff_secs = (backoff_secs * 2).min(30);
    }
}

async fn agent_session(url: &str, token: &str, push_ui: bool) -> anyhow::Result<()> {
    let (ws, _) = connect_async(url).await.map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("relay connected");
    let (mut tx, mut rx) = ws.split();

    let hello = serde_json::to_string(&Hello {
        kind: "hello",
        role: "agent",
        token,
    })?;
    tx.send(Message::Text(hello.into())).await?;

    if push_ui {
        if let Err(e) = push_ui_bundle(&mut tx).await {
            eprintln!("ui push failed: {e:#}");
        }
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
                    Message::Text(text) => on_text(&mut tx, &text, push_ui).await?,
                    Message::Binary(_) => {}
                    Message::Close(_) => anyhow::bail!("relay closed"),
                    _ => {}
                }
            }
        }
    }
}

/// Build the single-file frontend and push it chunked over the agent socket.
async fn push_ui_bundle(tx: &mut WsTx) -> anyhow::Result<()> {
    let html = crate::ui::build_single_file()?;
    let bytes = html.as_bytes();
    let chunks: Vec<String> = bytes
        .chunks(UI_CHUNK_RAW)
        .map(|c| {
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, c)
        })
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

async fn on_text(tx: &mut WsTx, text: &str, push_ui: bool) -> anyhow::Result<()> {
    let msg: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    match msg.get("type").and_then(|t| t.as_str()) {
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
            // v1: acknowledge bridged payloads (PTY bridging comes next).
            tx.send(Message::Text(r#"{"type":"ack"}"#.to_string().into()))
                .await?;
        }
        _ => {}
    }
    Ok(())
}
