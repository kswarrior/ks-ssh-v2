//! Relay agent: one outbound WSS to the Worker, no open port needed.
//!
//! The CLI registers a 5-char token (`/v1/agent?token=XXXXX`). A browser
//! that opens `/v1/client?token=XXXXX` is paired into the same
//! Durable Object room and the two sides are bridged.

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio_tungstenite::{connect_async, tungstenite::Message};

const TOKEN_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

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

/// Hold the relay connection forever (reconnects with backoff).
pub async fn run_agent(relay: &str, token: &str) {
    // rustls ships without a crypto provider — install ring once.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let base = relay.trim_end_matches('/');
    let url = format!("{base}/v1/agent?token={token}");
    println!("Relay token: {token} — enter it in the SSH page to connect.");
    println!("Relay: {url} (no open port needed)");

    let mut backoff_secs = 1u64;
    loop {
        match agent_session(&url, token).await {
            Ok(()) => backoff_secs = 1,
            Err(e) => eprintln!("relay error: {e} (retry in {backoff_secs}s)"),
        }
        tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
        backoff_secs = (backoff_secs * 2).min(30);
    }
}

async fn agent_session(url: &str, token: &str) -> anyhow::Result<()> {
    let (ws, _) = connect_async(url).await.map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("relay connected");
    let (mut tx, mut rx) = ws.split();

    let hello = serde_json::to_string(&Hello {
        kind: "hello",
        role: "agent",
        token,
    })?;
    tx.send(Message::Text(hello.into())).await?;

    let mut keepalive =
        tokio::time::interval(std::time::Duration::from_secs(20));
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
                    Message::Text(text) => on_text(&mut tx, &text).await?,
                    Message::Binary(_) => {}
                    Message::Close(_) => anyhow::bail!("relay closed"),
                    _ => {}
                }
            }
        }
    }
}

async fn on_text(
    tx: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >,
    text: &str,
) -> anyhow::Result<()> {
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
        Some("data") => {
            // v1: acknowledge bridged payloads (PTY bridging comes next).
            tx.send(Message::Text(r#"{"type":"ack"}"#.to_string().into()))
                .await?;
        }
        _ => {}
    }
    Ok(())
}
