//! Relay agent: one outbound WSS to the Worker, no open port needed.
//!
//! The CLI registers a 5-char token (`/v1/agent?token=XXXXX`). A browser
//! that opens `/v1/client?token=XXXXX` is paired into the same
//! Durable Object room and the two sides are bridged.
//!
//! On connect the agent also pushes its whole embedded frontend as a
//! single-file HTML bundle (`ui-begin` / `ui-chunk` / `ui-end`), so CF can
//! cache it per token and open it fullscreen (`/v/TOKEN`, `#/session/TOKEN`).
//!
//! Full-function relay (Visit == `--port`): the pushed bundle runs in relay
//! mode inside CF and tunnels everything over this same WSS:
//! * `rpc-begin` / `rpc-chunk` / `rpc-end` — HTTP `/api/*` proxied to a
//!   loopback-only server in this process (same router, auth, DB, shells).
//! * `shell-open` / `shell-send` / `shell-close` — `/v1/shell` PTY proxied
//!   transparently (text + binary) to the same loopback server.
//! The Worker relays these opaquely by room; `k`/PINs are never logged.
//!
//! E2E (sshx-style): `token` routes, `k` (256-bit, fragment-only) seals.
//! Sensitive payloads travel as `{"type":"enc",...}` (AES-256-GCM, AAD=token).
//! The relay sees only sizes/timing. UI bundle + rpc/shell control messages
//! stay plaintext by design (see `crate::e2e`).

use std::collections::HashMap;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, mpsc};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::e2e::{E2E_ALG, E2e, E2eKey};

const TOKEN_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/// Raw bytes per ui-chunk (~64KB base64 per WS message, well under limits).
const UI_CHUNK_RAW: usize = 48 * 1024;
/// Raw bytes per rpc-chunk (same 48KB budget as the UI upload).
const RPC_CHUNK_RAW: usize = 48 * 1024;
/// Hard cap per proxied HTTP body (32 MiB — covers UI JSON + file up/down).
const MAX_RPC_BYTES: usize = 32 * 1024 * 1024;
/// Hard cap on chunks per proxied body (1024 × 48KB ≈ 48MB envelope).
const MAX_RPC_CHUNKS: usize = 1024;

type WsTx = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Message,
>;
/// Outgoing relay texts from the main loop + per-shell bridge tasks.
type OutTx = mpsc::UnboundedSender<String>;

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
/// `local_base`: loopback HTTP base (e.g. `http://127.0.0.1:PORT`) the agent
/// proxies `rpc-*` / `shell-*` relay messages to — same router/auth/DB as
/// `--port`, so Visit-over-WSS is fully functional with no open port.
pub async fn run_agent(
    relay: &str,
    token: &str,
    push_ui: bool,
    e2e_key: Option<E2eKey>,
    relay_pin: Option<std::sync::Arc<crate::auth::RelayPinState>>,
    local_base: String,
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
        println!("  {http}/#/session/{token}#k={secret}");
        // Drop the display copy immediately (the key itself stays in memory).
    } else {
        println!("E2E: OFF (legacy --no-e2e) — relay can see plaintext.");
    }
    if relay_pin.is_some() {
        println!("Relay auth: ON — viewers must present the PIN printed at startup (or a minted one via POST /api/relay/pin). Default without --relay-auth stays bearer-open.");
    }
    if push_ui {
        println!("Fullscreen UI: {http}/v/{token}  (or {http}/#/session/{token})");
        println!("Visit in CF opens the full CLI UI (Terminal, Files, Ports, Host) over WSS — same as --port, fully functional.");
    }

    let mut backoff_secs = 1u64;
    loop {
        // Clone the key per session (seq resets to 0 each connection).
        let key_clone = e2e_key.clone();
        let pin_clone = relay_pin.clone();
        let base_clone = local_base.clone();
        match agent_session(&url, token, push_ui, key_clone, pin_clone, base_clone).await {
            Ok(()) => backoff_secs = 1,
            Err(e) => eprintln!("relay error: {e} (retry in {backoff_secs}s)"),
        }
        tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
        backoff_secs = (backoff_secs * 2).min(30);
    }
}

/// Incoming chunked HTTP body being reassembled from `rpc-chunk`s.
struct PendingRpc {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body_len: usize,
    parts: Vec<Option<String>>,
}

/// One live `/v1/shell` bridge: relay channel <-> loopback WS.
struct ShellBridge {
    /// Relay -> loopback forwarder (main loop sends here).
    to_local: mpsc::UnboundedSender<ShellLocalIn>,
}

#[derive(Debug)]
enum ShellLocalIn {
    /// Raw client bytes: text (UTF-8 incl. JSON control) or binary.
    Send { is_text: bool, data: Vec<u8> },
    Close,
}

async fn agent_session(
    url: &str,
    token: &str,
    push_ui: bool,
    e2e_key: Option<E2eKey>,
    relay_pin: Option<std::sync::Arc<crate::auth::RelayPinState>>,
    local_base: String,
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

    if push_ui && let Err(e) = push_ui_bundle(&mut tx, token).await {
        eprintln!("ui push failed: {e:#}");
    }

    // Outgoing queue: main loop + per-shell tasks send JSON texts here;
    // a single sender task owns the WS sink (no lock contention).
    let (out_tx, mut out_rx): (OutTx, mpsc::UnboundedReceiver<String>) =
        mpsc::unbounded_channel();
    let mut send_task = tokio::spawn(async move {
        while let Some(text) = out_rx.recv().await {
            if tx.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    let http_client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut pending_rpc: HashMap<String, PendingRpc> = HashMap::new();
    let shells: Arc<Mutex<HashMap<String, ShellBridge>>> =
        Arc::new(Mutex::new(HashMap::new()));

    let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(20));
    // `--relay-auth`: track whether the paired viewer presented the PIN.
    // Plain `bool` per connection (single viewer per agent session in v1).
    let mut viewer_ok = relay_pin.is_none();
    let res: anyhow::Result<()> = loop {
        tokio::select! {
            _ = keepalive.tick() => {
                let ping = serde_json::to_string(&Ping { kind: "ping" })?;
                let _ = out_tx.send(ping);
            }
            msg = rx.next() => {
                let Some(msg) = msg else { break Err(anyhow::anyhow!("relay closed")) };
                let msg = msg.map_err(|e| anyhow::anyhow!("{e}"))?;
                match msg {
                    Message::Text(text) => {
                        if let Err(e) = on_text(
                            &out_tx,
                            &http_client,
                            &local_base,
                            &mut pending_rpc,
                            shells.clone(),
                            &text,
                            push_ui,
                            token,
                            &mut e2e,
                            &mut peer_e2e,
                            &relay_pin,
                            &mut viewer_ok,
                        )
                        .await
                        {
                            eprintln!("relay on_text error: {e:#}");
                        }
                    }
                    Message::Binary(_) => {}
                    Message::Close(_) => break Err(anyhow::anyhow!("relay closed")),
                    _ => {}
                }
            }
            else => break Err(anyhow::anyhow!("relay closed")),
        }
    };
    send_task.abort();
    // Drop all shell bridges (their tasks notice the closed out_tx / abort).
    shells.lock().await.clear();
    pending_rpc.clear();
    res
}

/// Build the single-file frontend and push it chunked over the agent socket.
/// NOTE: the UI bundle is public build output and stays PLAINTEXT by design
/// (needed for per-token caching in `room.ts`). Never tunnel secrets inside
/// UI messages.
async fn push_ui_bundle(tx: &mut WsTx, token: &str) -> anyhow::Result<()> {
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
    // Audit the push (token only, never bundle contents / secrets).
    crate::db::audit("-", "local", "relay-ui-push", token, "ok");
    Ok(())
}

/// Send a JSON value sealed inside `enc` (E2E on). No-op error when E2E off.
async fn send_enc_via(out_tx: &OutTx, e2e: &mut E2e, value: &serde_json::Value) -> anyhow::Result<()> {
    let pt = serde_json::to_vec(value)?;
    let env = e2e.encrypt_next(&pt)?;
    let text = crate::e2e::envelope_to_text(&env)?;
    let _ = out_tx.send(text);
    Ok(())
}

fn send_out(out_tx: &OutTx, value: &serde_json::Value) {
    if let Ok(text) = serde_json::to_string(value) {
        let _ = out_tx.send(text);
    }
}

fn rpc_error(out_tx: &OutTx, id: &str, status: u16, message: &str) {
    send_out(
        out_tx,
        &serde_json::json!({"type":"rpc-error","id":id,"status":status,"message":message}),
    );
}

/// Only `/api/*` is proxied (never `/`, `/v1/shell` over HTTP, or `/assets/`).
fn valid_rpc_path(path: &str) -> bool {
    if !path.starts_with("/api/") {
        return false;
    }
    if path.contains("..") || path.contains('\0') || path.len() > 4096 {
        return false;
    }
    true
}

fn ws_base(local_base: &str) -> String {
    let base = local_base.trim_end_matches('/');
    if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base.to_string()
    }
}

fn b64_encode(raw: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(raw)
}

fn b64_decode(s: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}

/// Proxy one reassembled HTTP request to the loopback server and stream the
/// response back chunked (`rpc-begin` / `rpc-chunk` / `rpc-end`).
async fn proxy_rpc(
    out_tx: &OutTx,
    http_client: &reqwest::Client,
    local_base: &str,
    token: &str,
    id: String,
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
) {
    if !valid_rpc_path(&path) {
        rpc_error(out_tx, &id, 404, "not found");
        return;
    }
    let url = format!("{}{}", local_base.trim_end_matches('/'), path);
    let req_method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
        .unwrap_or(reqwest::Method::GET);
    // Only safe methods without body are cacheable — everything here is a
    // live proxy, no caching.
    let mut req = http_client.request(req_method.clone(), &url);
    for (k, v) in &headers {
        let kl = k.to_ascii_lowercase();
        // Allowlist: auth + content negotiation only. `host`/`connection`/
        // `content-length` are set by reqwest itself.
        if kl == "cookie" || kl == "content-type" || kl == "accept" || kl == "range" {
            req = req.header(kl.as_str(), v.as_str());
        }
    }
    if !body.is_empty() {
        req = req.body(body);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("relay rpc proxy failed ({method} {}): {e:#}", short_path(&path));
            crate::db::audit("-", "local", "relay-rpc", token, "error");
            rpc_error(out_tx, &id, 502, "local backend unreachable");
            return;
        }
    };
    let status = resp.status().as_u16();
    let mut out_headers = HashMap::new();
    for (k, v) in resp.headers().iter() {
        let kl = k.as_str().to_ascii_lowercase();
        if kl == "content-type"
            || kl == "content-disposition"
            || kl == "set-cookie"
            || kl == "cache-control"
            || kl == "accept-ranges"
            || kl == "content-range"
        {
            if let Ok(s) = v.to_str() {
                // Multiple set-cookie headers collapse in reqwest iteration;
                // keep the last (login/logout set a single cookie).
                out_headers.insert(kl, s.to_string());
            }
        }
    }
    // Guard huge downloads before buffering (Content-Length may be absent).
    if let Some(cl) = resp.content_length()
        && cl > MAX_RPC_BYTES as u64
    {
        rpc_error(out_tx, &id, 413, "response too large for relay (32MB cap)");
        return;
    }
    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("relay rpc read failed: {e:#}");
            rpc_error(out_tx, &id, 502, "failed to read local response");
            return;
        }
    };
    if bytes.len() > MAX_RPC_BYTES {
        rpc_error(out_tx, &id, 413, "response too large for relay (32MB cap)");
        return;
    }
    let chunks: Vec<String> = bytes
        .chunks(RPC_CHUNK_RAW)
        .map(|c| b64_encode(c))
        .collect();
    let n = chunks.len();
    send_out(
        out_tx,
        &serde_json::json!({
            "type": "rpc-begin",
            "id": id,
            "status": status,
            "headers": out_headers,
            "body_len": bytes.len(),
            "chunks": n,
        }),
    );
    for (i, data) in chunks.iter().enumerate() {
        send_out(
            out_tx,
            &serde_json::json!({"type":"rpc-chunk","id":id,"i":i,"data":data}),
        );
    }
    send_out(
        out_tx,
        &serde_json::json!({"type":"rpc-end","id":id,"chunks":n}),
    );
    crate::db::audit("-", "local", "relay-rpc", token, "ok");
}

/// Short `METHOD /api/xxx` label for logs (no query — may hold filenames).
fn short_path(path: &str) -> String {
    let root = path.split('?').next().unwrap_or(path);
    if root.len() > 64 {
        format!("{}…", &root[..64])
    } else {
        root.to_string()
    }
}

/// Spawn the transparent `/v1/shell` bridge for one relay channel.
/// Owns the loopback WS; `in_rx` carries relay->local input from the main
/// loop. PTY bytes (text + binary, v1/v2 frames, resize/ping/ack) pass
/// through untouched as base64 `shell-recv` / `shell-send`.
async fn spawn_shell_bridge(
    out_tx: OutTx,
    shells: Arc<Mutex<HashMap<String, ShellBridge>>>,
    local_base: String,
    token: String,
    id: String,
    sid: Option<String>,
    v: u8,
    from: u64,
    cookie: Option<String>,
) {
    let (in_tx, mut in_rx): (
        mpsc::UnboundedSender<ShellLocalIn>,
        mpsc::UnboundedReceiver<ShellLocalIn>,
    ) = mpsc::unbounded_channel();
    shells.lock().await.insert(id.clone(), ShellBridge { to_local: in_tx });

    let out_tx_fail = out_tx.clone();
    let id_fail = id.clone();
    let shells_fail = shells.clone();
    let run = async move {
        // Build the loopback WS URL (same query shapes as the local UI).
        let mut url = format!("{}/v1/shell?v={v}&from={from}", ws_base(&local_base));
        if let Some(s) = sid.as_deref().filter(|s| !s.is_empty()) {
            url.push_str(&format!("&id={}", urlencoding_lite(s)));
        }
        // Connect with the viewer's session cookie (login over relay works:
        // the shim forwards `ks_ssh_auth` from its rpc cookie jar).
        let req = {
            use tokio_tungstenite::tungstenite::http::Request as HttpRequest;
            let mut builder = HttpRequest::builder().uri(url.as_str());
            if let Some(c) = cookie.as_deref().filter(|c| !c.is_empty()) {
                builder = builder.header("Cookie", c);
            }
            builder
                .header("Host", "127.0.0.1")
                .body(())
                .map_err(|e| anyhow::anyhow!("{e}"))?
        };
        let (local_ws, _) = connect_async(req)
            .await
            .map_err(|e| anyhow::anyhow!("loopback shell dial failed: {e}"))?;
        let (mut local_tx, mut local_rx) = local_ws.split();
        crate::db::audit("-", "local", "relay-shell-open", &token, "ok");
        loop {
            tokio::select! {
                msg = in_rx.recv() => {
                    let Some(msg) = msg else { break };
                    match msg {
                        ShellLocalIn::Send { is_text, data } => {
                            let res = if is_text {
                                match String::from_utf8(data) {
                                    Ok(s) => local_tx.send(Message::Text(s.into())).await,
                                    Err(_) => continue,
                                }
                            } else {
                                local_tx.send(Message::Binary(data.into())).await
                            };
                            if res.is_err() {
                                break;
                            }
                        }
                        ShellLocalIn::Close => {
                            let _ = local_tx.send(Message::Close(None)).await;
                            break;
                        }
                    }
                }
                msg = local_rx.next() => {
                    let Some(msg) = msg else { break };
                    match msg {
                        Ok(Message::Text(s)) => {
                            send_out(&out_tx, &serde_json::json!({
                                "type": "shell-recv",
                                "id": id,
                                "is_text": true,
                                "data": b64_encode(s.as_bytes()),
                            }));
                        }
                        Ok(Message::Binary(b)) => {
                            send_out(&out_tx, &serde_json::json!({
                                "type": "shell-recv",
                                "id": id,
                                "is_text": false,
                                "data": b64_encode(&b),
                            }));
                        }
                        Ok(Message::Close(frame)) => {
                            let (code, reason) = frame
                                .map(|f| (f.code.into(), f.reason.to_string()))
                                .unwrap_or((1005u16, String::new()));
                            send_out(&out_tx, &serde_json::json!({
                                "type": "shell-closed",
                                "id": id,
                                "code": code,
                                "reason": reason,
                            }));
                            break;
                        }
                        Ok(_) => {}
                        Err(_) => break,
                    }
                }
            }
        }
        crate::db::audit("-", "local", "relay-shell-close", &token, "ok");
        anyhow::Ok(())
    };
    if let Err(e) = run.await {
        eprintln!("relay shell bridge {id_fail} failed: {e:#}");
        send_out(
            &out_tx_fail,
            &serde_json::json!({"type":"shell-closed","id":id_fail,"code":1011,"reason":"loopback unreachable"}),
        );
    }
    shells_fail.lock().await.remove(&id_fail);
}

/// Minimal percent-encoding for the `id` query value (alnum + `-_` only).
fn urlencoding_lite(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[derive(Debug, Deserialize)]
struct RpcBeginMsg {
    id: String,
    method: String,
    path: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    body_len: usize,
    #[serde(default)]
    chunks: usize,
}

async fn on_text(
    out_tx: &OutTx,
    http_client: &reqwest::Client,
    local_base: &str,
    pending_rpc: &mut HashMap<String, PendingRpc>,
    shells: Arc<Mutex<HashMap<String, ShellBridge>>>,
    text: &str,
    push_ui: bool,
    token: &str,
    e2e: &mut Option<E2e>,
    peer_e2e: &mut bool,
    relay_pin: &Option<std::sync::Arc<crate::auth::RelayPinState>>,
    viewer_ok: &mut bool,
) -> anyhow::Result<()> {
    // Fast path: `enc` envelopes (opaque to the relay, sealed for us).
    if let Some(env) = crate::e2e::parse_envelope(text) {
        // `--relay-auth`: refuse sealed data until the viewer PIN checked out.
        // (Audit logs the token only, never key material.)
        if relay_pin.is_some() && !*viewer_ok {
            eprintln!("relay viewer PIN required before data bridge");
            crate::db::audit("-", "local", "relay-data", token, "deny");
            return Ok(());
        }
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
                            // v1 legacy ack path (kept for old peers).
                            crate::db::audit("-", "local", "relay-data", token, "ok");
                            send_enc_via(out_tx, state, &serde_json::json!({"type":"ack"})).await?;
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
            // With `--relay-auth` the client must also present `pin` (its
            // value is never logged; only the outcome is audited).
            if let Some(pin_state) = relay_pin {
                let pin_ok = msg
                    .get("pin")
                    .and_then(|v| v.as_str())
                    .is_some_and(|p| pin_state.verify(p));
                *viewer_ok = pin_ok;
                // Audit with token only — never the PIN.
                crate::db::audit(
                    "-",
                    "local",
                    "relay-viewer-auth",
                    token,
                    if pin_ok { "ok" } else { "deny" },
                );
                if !pin_ok {
                    eprintln!("relay viewer PIN rejected");
                }
            }
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
            send_out(out_tx, &serde_json::json!({"type":"pong"}));
        }
        Some("ui-request") => {
            // CF has no cached UI for this token (e.g. DO restarted) — resend.
            // ui push needs the raw WS sink; signal via out channel is not
            // possible here (chunked binary) — the next agent_session hello
            // re-pushes. Tell the client to wait for ui-ready.
            if push_ui {
                println!("ui re-requested — client waits for cached replay or reconnect repush");
                send_out(out_tx, &serde_json::json!({"type":"ui-pending"}));
            } else {
                send_out(
                    out_tx,
                    &serde_json::json!({"type":"ui-missing"}),
                );
            }
        }
        Some("data") => {
            // `--relay-auth`: refuse plaintext data until the viewer PIN
            // checked out (audit token only).
            if relay_pin.is_some() && !*viewer_ok {
                eprintln!("relay viewer PIN required before data bridge");
                crate::db::audit("-", "local", "relay-data", token, "deny");
                return Ok(());
            }
            // Plaintext data: legacy peer, or peer that chose plaintext.
            if e2e.is_some() {
                eprintln!("legacy plaintext data (relay-visible) — peer without E2E");
            }
            crate::db::audit("-", "local", "relay-data", token, "ok");
            send_out(out_tx, &serde_json::json!({"type":"ack"}));
        }
        // ---- Full-function relay: HTTP `/api/*` over WSS ----
        Some("rpc-begin") => {
            if relay_pin.is_some() && !*viewer_ok {
                let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
                eprintln!("relay viewer PIN required before rpc bridge");
                crate::db::audit("-", "local", "relay-rpc", token, "deny");
                rpc_error(out_tx, id, 403, "viewer PIN required");
                return Ok(());
            }
            let parsed: Result<RpcBeginMsg, _> = serde_json::from_value(msg.clone());
            let req = match parsed {
                Ok(r) => r,
                Err(_) => return Ok(()),
            };
            if req.id.is_empty() || req.id.len() > 64 || !valid_rpc_path(&req.path) {
                rpc_error(out_tx, &req.id, 400, "bad rpc request");
                return Ok(());
            }
            if req.chunks > MAX_RPC_CHUNKS || req.body_len > MAX_RPC_BYTES {
                rpc_error(out_tx, &req.id, 413, "request too large for relay (32MB cap)");
                return Ok(());
            }
            if e2e.is_some() && !*peer_e2e {
                eprintln!("relay rpc plaintext (relay-visible) — peer without E2E");
            }
            if req.chunks == 0 {
                // No body — proxy immediately.
                let out = out_tx.clone();
                let client = http_client.clone();
                let base = local_base.to_string();
                let tok = token.to_string();
                tokio::spawn(async move {
                    proxy_rpc(&out, &client, &base, &tok, req.id, req.method, req.path, req.headers, Vec::new()).await;
                });
            } else {
                // Chunked body — reassemble, then proxy on rpc-end.
                if pending_rpc.contains_key(&req.id) {
                    rpc_error(out_tx, &req.id, 400, "duplicate rpc id");
                    return Ok(());
                }
                let mut parts = Vec::new();
                parts.resize_with(req.chunks.min(MAX_RPC_CHUNKS), || None);
                pending_rpc.insert(
                    req.id.clone(),
                    PendingRpc {
                        method: req.method,
                        path: req.path,
                        headers: req.headers,
                        body_len: req.body_len,
                        parts,
                    },
                );
            }
        }
        Some("rpc-chunk") => {
            let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let i = msg.get("i").and_then(|v| v.as_u64()).unwrap_or(u64::MAX) as usize;
            let data = msg.get("data").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(pending) = pending_rpc.get_mut(id) {
                if i < pending.parts.len() && data.len() <= 128 * 1024 && !data.is_empty() {
                    pending.parts[i] = Some(data.to_string());
                }
            }
        }
        Some("rpc-end") => {
            let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if let Some(pending) = pending_rpc.remove(&id) {
                if pending.parts.iter().any(|p| p.is_none()) {
                    rpc_error(out_tx, &id, 400, "incomplete rpc upload");
                    return Ok(());
                }
                let mut raw = Vec::with_capacity(pending.body_len.min(MAX_RPC_BYTES));
                for part in pending.parts.iter().flatten() {
                    match b64_decode(part) {
                        Some(bytes) => raw.extend_from_slice(&bytes),
                        None => {
                            rpc_error(out_tx, &id, 400, "bad rpc chunk encoding");
                            return Ok(());
                        }
                    }
                    if raw.len() > MAX_RPC_BYTES {
                        rpc_error(out_tx, &id, 413, "request too large for relay (32MB cap)");
                        return Ok(());
                    }
                }
                let out = out_tx.clone();
                let client = http_client.clone();
                let base = local_base.to_string();
                let tok = token.to_string();
                tokio::spawn(async move {
                    proxy_rpc(&out, &client, &base, &tok, id, pending.method, pending.path, pending.headers, raw).await;
                });
            }
        }
        // ---- Full-function relay: `/v1/shell` PTY over WSS ----
        Some("shell-open") => {
            if relay_pin.is_some() && !*viewer_ok {
                let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
                eprintln!("relay viewer PIN required before shell bridge");
                crate::db::audit("-", "local", "relay-shell", token, "deny");
                send_out(out_tx, &serde_json::json!({"type":"shell-closed","id":id,"code":4403,"reason":"viewer PIN required"}));
                return Ok(());
            }
            let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if id.is_empty() || id.len() > 64 {
                return Ok(());
            }
            if shells.lock().await.contains_key(&id) {
                return Ok(());
            }
            let sid = msg.get("sid").and_then(|v| v.as_str()).map(|s| s.to_string());
            let v = msg.get("v").and_then(|v| v.as_u64()).unwrap_or(2).min(2) as u8;
            let from = msg.get("from").and_then(|v| v.as_u64()).unwrap_or(0);
            let cookie = msg.get("cookie").and_then(|v| v.as_str()).map(|s| s.to_string());
            if e2e.is_some() && !*peer_e2e {
                eprintln!("relay shell plaintext (relay-visible) — peer without E2E");
            }
            let out = out_tx.clone();
            let shells_clone = shells.clone();
            let base = local_base.to_string();
            let tok = token.to_string();
            tokio::spawn(async move {
                spawn_shell_bridge(out, shells_clone, base, tok, id, sid, v, from, cookie).await;
            });
        }
        Some("shell-send") => {
            let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let is_text = msg.get("is_text").and_then(|v| v.as_bool()).unwrap_or(true);
            let data = msg.get("data").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(bridge) = shells.lock().await.get(id) {
                if let Some(bytes) = b64_decode(data) {
                    let _ = bridge.to_local.send(ShellLocalIn::Send { is_text, data: bytes });
                }
            }
        }
        Some("shell-close") => {
            let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(bridge) = shells.lock().await.get(id) {
                let _ = bridge.to_local.send(ShellLocalIn::Close);
            }
        }
        _ => {}
    }
    Ok(())
}
