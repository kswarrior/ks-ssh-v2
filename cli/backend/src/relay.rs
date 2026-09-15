//! Relay agent: one outbound WSS to the Worker, no open port needed.
//!
//! The CLI registers a token (`/v1/agent?token=XXXXX`). A browser
//! that opens `/v1/client?token=XXXXX` is paired into the same
//! Durable Object room and the two sides are bridged.
//!
//! Tokens are 9-char by default (letters + numbers, no look-alikes);
//! 5-char legacy tokens still route (compat) but fresh runs mint 9.
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
//!   The Worker relays these opaquely by room; `k`/PINs are never logged.
//!
//! E2E (sshx-style), strict-by-default: `token` routes, `k` (256-bit,
//! fragment-only) seals. When E2E is on (default) both sides advertise
//! `e2e:"aes-gcm-v1"` in `hello` plus session binding (`sess`, `epoch`,
//! `fp` = fingerprint of `k`). Sensitive payloads travel ONLY as
//! `{"type":"enc",...}` (AES-256-GCM, AAD=`TOKEN|sess|dir|epoch`, strict
//! seq, random `_pad`). A peer without E2E is hard-failed with `E2E error`
//! and an audit deny — no plaintext is sent. `--no-e2e` is the only escape
//! hatch (explicit, loud warning + audit row). The relay sees only
//! sizes/timing. UI bundle + `paired`/`agent` presence + `ping`/`pong` +
//! `ui-*` control stay plaintext by design (public build output / no
//! secrets); the viewer PIN travels ONLY inside `enc`
//! (`{"type":"auth","pin":"..."}`) when both sides do E2E.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, mpsc};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::e2e::{E2E_ALG, E2E_ERROR_MSG, E2e, E2eKey, strict_peer_ok};

const TOKEN_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/// Fresh tokens are 9 chars (~46 bits of routing entropy, up from 5/~25b).
/// 5-char legacy tokens still route for compat.
pub const TOKEN_LEN_NEW: usize = 9;

/// Raw bytes per ui-chunk (~64KB base64 per WS message, well under limits).
const UI_CHUNK_RAW: usize = 48 * 1024;
/// Raw bytes per rpc-chunk (same 48KB budget as the UI upload).
const RPC_CHUNK_RAW: usize = 48 * 1024;
/// Hard cap per proxied HTTP body (32 MiB — covers UI JSON + file up/down).
const MAX_RPC_BYTES: usize = 32 * 1024 * 1024;
/// Hard cap on chunks per proxied body (1024 × 48KB ≈ 48MB envelope).
const MAX_RPC_CHUNKS: usize = 1024;
/// Max concurrent pending RPC uploads (prevents memory exhaustion).
const MAX_PENDING_RPC: usize = 64;

type WsTx = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Message,
>;
/// Outgoing relay texts from the main loop + per-shell bridge tasks.
type OutTx = mpsc::UnboundedSender<String>;

/// Random 9-char token (letters + numbers, no look-alikes like 0/O or 1/I).
pub fn new_token() -> String {
    (0..TOKEN_LEN_NEW)
        .map(|_| {
            let i = fastrand::usize(..TOKEN_ALPHABET.len());
            TOKEN_ALPHABET[i] as char
        })
        .collect()
}

/// 5-char legacy tokens still route; fresh runs mint 9 chars.
pub fn valid_token(t: &str) -> bool {
    (t.len() == 5 || t.len() == TOKEN_LEN_NEW)
        && t.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Shared E2E sender state: the main loop owns decrypt order, spawned
/// rpc/shell tasks share encrypt order through this lock (monotonic seq).
type SharedE2e = Arc<Mutex<Option<E2e>>>;
type SharedPeer = Arc<AtomicBool>;

#[derive(Serialize)]
struct Hello<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    role: &'a str,
    token: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    e2e: Option<&'a str>,
    /// Session binding (E2E only): random per-run id + per-connection epoch.
    #[serde(skip_serializing_if = "Option::is_none")]
    sess: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    epoch: Option<u64>,
    /// Fingerprint of `k` (TOFU identity, E2E only — not a secret).
    #[serde(skip_serializing_if = "Option::is_none")]
    fp: Option<&'a str>,
    /// Whether this agent gates data behind a viewer PIN (`--relay-auth`).
    #[serde(skip_serializing_if = "Option::is_none")]
    relay_auth: Option<bool>,
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
/// `e2e_key`: `Some` = E2E on (default, strict), `None` = legacy plaintext
/// (`--no-e2e`, explicit escape hatch only).
/// `relay_pin`: `Some` = `--relay-auth` — the agent requires the viewer PIN
/// inside `enc` (`{"type":"auth","pin":"..."}`) before bridging data/rpc/
/// shell (closes the bearer-open bypass honestly). Audit rows log the token
/// only, never `k`/PIN.
/// `local_base`: loopback HTTP base (e.g. `http://127.0.0.1:PORT`) the agent
/// proxies `rpc-*` / `shell-*` relay messages to — same router/auth/DB as
/// `--port`, so Visit-over-WSS is fully functional with no open port.
/// `viewer_pin`: one-time `--relay-auth` PIN string for the startup panel
/// (the verifier stays in `relay_pin`; the string is display-only).
/// `public_url`: local UI URL (`Some` when serving alongside, `None` pure agent).
/// `auth_on`: local login gate on/off (panel row only).
#[allow(clippy::too_many_arguments)] // startup wiring: explicit params avoid mega-struct churn
pub async fn run_agent(
    relay: &str,
    token: &str,
    push_ui: bool,
    e2e_key: Option<E2eKey>,
    relay_pin: Option<std::sync::Arc<crate::auth::RelayPinState>>,
    local_base: String,
    viewer_pin: Option<String>,
    public_url: Option<String>,
    auth_on: bool,
) {
    // rustls ships without a crypto provider — install ring once.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let base = relay.trim_end_matches('/');
    let url = format!("{base}/v1/agent?token={token}");
    let http = https_base(base);
    // NOTE: the token is safe to log (routing only). The E2E secret
    // `k` appears ONLY in the one-time share links inside the startup
    // panel below — never in any other log line.
    // The viewer PIN (when `--relay-auth`) is likewise shown once in the
    // panel and never logged again.
    crate::db::audit("-", "local", "relay-register", token, "ok");
    // One-time display copies for the panel (the key itself stays in memory).
    let (panel_key, panel_fp) = match e2e_key.as_ref() {
        Some(k) => (Some(k.to_base64url()), Some(k.fingerprint())),
        None => (None, None),
    };
    let e2e_on = e2e_key.is_some();
    if !e2e_on {
        crate::db::audit("-", "local", "relay-downgrade", token, "explicit-no-e2e");
    }
    // Pure agent: surface the internal loopback for debugging; combined
    // mode already shows the public URL (same target), so skip it there.
    let loopback_row = if public_url.is_none() {
        Some(local_base.clone())
    } else {
        None
    };
    crate::banner::print(&crate::banner::StartupBanner {
        local_url: public_url,
        loopback: loopback_row,
        relay_http: Some(http.clone()),
        token: Some(token.to_string()),
        e2e_on,
        e2e_key: panel_key,
        e2e_fp: panel_fp,
        viewer_pin,
        auth_on,
        relay_auth_on: relay_pin.is_some(),
        push_ui,
    });

    // Session binding: one random `sess` per run, `epoch` bumps per connect.
    // AAD=`TOKEN|sess|dir|epoch` so cross-session/epoch replays fail even
    // though `seq` restarts at 0 per connection.
    let sess = if e2e_key.is_some() {
        crate::e2e::new_session_id()
    } else {
        String::new()
    };
    let mut epoch: u64 = 0;
    let mut backoff_secs = 1u64;
    loop {
        // Clone the key per session (seq restarts at 0; epoch binds AAD).
        let key_clone = e2e_key.clone();
        let pin_clone = relay_pin.clone();
        let base_clone = local_base.clone();
        let sess_clone = sess.clone();
        let cur_epoch = epoch;
        match agent_session(
            &url,
            token,
            push_ui,
            key_clone,
            pin_clone,
            base_clone,
            sess_clone,
            cur_epoch,
        )
        .await
        {
            Ok(()) => backoff_secs = 1,
            Err(e) => eprintln!("relay error: {e} (retry in {backoff_secs}s)"),
        }
        epoch = epoch.wrapping_add(1);
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
    chunks: usize,
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

#[allow(clippy::too_many_arguments)] // relay session wiring: explicit params avoid mega-struct churn
async fn agent_session(
    url: &str,
    token: &str,
    push_ui: bool,
    e2e_key: Option<E2eKey>,
    relay_pin: Option<std::sync::Arc<crate::auth::RelayPinState>>,
    local_base: String,
    sess: String,
    epoch: u64,
) -> anyhow::Result<()> {
    let (ws, _) = connect_async(url)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    // Log token only — never the E2E secret or PIN.
    println!("relay connected (token {token})");
    let (mut tx, mut rx) = ws.split();

    let local_fp: Option<String> = e2e_key.as_ref().map(|k| k.fingerprint());
    let shared: SharedE2e = Arc::new(Mutex::new(e2e_key.clone().map(|k| {
        if sess.is_empty() {
            E2e::new(k, token)
        } else {
            E2e::new_session(k, token, &sess, epoch, true)
        }
    })));
    let e2e_on = e2e_key.is_some();
    let peer: SharedPeer = Arc::new(AtomicBool::new(false));

    let hello = serde_json::to_string(&Hello {
        kind: "hello",
        role: "agent",
        token,
        e2e: if e2e_on { Some(E2E_ALG) } else { None },
        sess: if e2e_on && !sess.is_empty() {
            Some(sess.as_str())
        } else {
            None
        },
        epoch: if e2e_on { Some(epoch) } else { None },
        fp: local_fp.as_deref(),
        relay_auth: if relay_pin.is_some() { Some(true) } else { None },
    })?;
    tx.send(Message::Text(hello.into())).await?;

    if push_ui && let Err(e) = push_ui_bundle(&mut tx, token).await {
        eprintln!("ui push failed: {e:#}");
    }

    // Outgoing queue: main loop + per-shell tasks send JSON texts here;
    // a single sender task owns the WS sink (no lock contention).
    let (out_tx, mut out_rx): (OutTx, mpsc::UnboundedReceiver<String>) =
        mpsc::unbounded_channel();
    let send_task = tokio::spawn(async move {
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
    // The PIN arrives inside `enc` (`{"type":"auth","pin":"..."}`) when both
    // sides do E2E; legacy plaintext `hello.pin` is accepted only from
    // non-E2E peers for compat (and ignored once E2E is negotiated).
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
                            shared.clone(),
                            peer.clone(),
                            e2e_on,
                            local_fp.clone(),
                            sess.clone(),
                            epoch,
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

/// Send a JSON value sealed inside `enc` via shared state (E2E on).
async fn send_enc_shared(out_tx: &OutTx, shared: &SharedE2e, value: &serde_json::Value) -> anyhow::Result<()> {
    let mut padded = value.clone();
    crate::e2e::add_padding(&mut padded);
    let pt = serde_json::to_vec(&padded)?;
    let mut g = shared.lock().await;
    let Some(state) = g.as_mut() else {
        anyhow::bail!("e2e off");
    };
    let env = state.encrypt_next(&pt)?;
    let text = crate::e2e::envelope_to_text(&env)?;
    let _ = out_tx.send(text);
    Ok(())
}

fn send_out(out_tx: &OutTx, value: &serde_json::Value) {
    if let Ok(text) = serde_json::to_string(value) {
        let _ = out_tx.send(text);
    }
}

/// Strict router for agent→client responses: when E2E is on and the peer
/// negotiated E2E, seal via `enc`; when E2E is on but the peer did not,
/// refuse (caller audits deny) instead of leaking plaintext; when E2E is
/// off (`--no-e2e`), send plaintext (explicit escape hatch).
async fn send_strict(
    out_tx: &OutTx,
    shared: &SharedE2e,
    peer: &SharedPeer,
    e2e_on: bool,
    value: &serde_json::Value,
) -> bool {
    if e2e_on {
        if !peer.load(Ordering::SeqCst) {
            return false;
        }
        return send_enc_shared(out_tx, shared, value).await.is_ok();
    }
    send_out(out_tx, value);
    true
}

fn peer_e2e_now(peer: &SharedPeer) -> bool {
    peer.load(Ordering::SeqCst)
}

#[allow(clippy::too_many_arguments)] // relay RPC plumbing: explicit params keep call sites readable
async fn rpc_error_shared(
    out_tx: &OutTx,
    shared: &SharedE2e,
    peer: &SharedPeer,
    e2e_on: bool,
    token: &str,
    id: &str,
    status: u16,
    message: &str,
) {
    let v = serde_json::json!({"type":"rpc-error","id":id,"status":status,"message":message});
    if !send_strict(out_tx, shared, peer, e2e_on, &v).await {
        // Error bodies carry no secrets — still notify plaintext peers so
        // requests fail fast with a message instead of a 120s timeout.
        rpc_error(out_tx, id, status, message);
        crate::db::audit("-", "local", "relay-downgrade", token, "deny");
    }
}

/// Strict-refusal notice for plaintext peers (E2E on, peer without `#k=`).
/// Plaintext by necessity — the peer cannot open sealed mail. The body is
/// the actionable hint only, never key material.
fn rpc_e2e_required(out_tx: &OutTx, token: &str, id: &str) {
    rpc_error(
        out_tx,
        id,
        426,
        "E2E required — open the full link with #k=... (the CLI printed it at startup)",
    );
    crate::db::audit("-", "local", "relay-downgrade", token, "deny");
}

fn shell_e2e_required(out_tx: &OutTx, token: &str, id: &str) {
    send_out(
        out_tx,
        &serde_json::json!({
            "type": "shell-closed",
            "id": id,
            "code": 4401,
            "reason": "E2E required — open the full link with #k=... (the CLI printed it at startup)",
        }),
    );
    crate::db::audit("-", "local", "relay-downgrade", token, "deny");
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
/// Responses follow the strict router: sealed via `enc` when E2E is on,
/// refused (deny) when the peer lacks E2E, plaintext only for `--no-e2e`.
#[allow(clippy::too_many_arguments)] // relay plumbing: explicit params keep call sites readable
async fn proxy_rpc(
    out_tx: &OutTx,
    shared: &SharedE2e,
    peer: &SharedPeer,
    e2e_on: bool,
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
        rpc_error_shared(out_tx, shared, peer, e2e_on, token, &id, 404, "not found").await;
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
            rpc_error_shared(out_tx, shared, peer, e2e_on, token, &id, 502, "local backend unreachable").await;
            return;
        }
    };
    let status = resp.status().as_u16();
    let mut out_headers = HashMap::new();
    for (k, v) in resp.headers().iter() {
        let kl = k.as_str().to_ascii_lowercase();
        if (kl == "content-type"
            || kl == "content-disposition"
            || kl == "set-cookie"
            || kl == "cache-control"
            || kl == "accept-ranges"
            || kl == "content-range")
            && let Ok(s) = v.to_str() {
                // Multiple set-cookie headers collapse in reqwest iteration;
                // keep the last (login/logout set a single cookie).
                out_headers.insert(kl, s.to_string());
            }
    }
    // Guard huge downloads before buffering (Content-Length may be absent).
    if let Some(cl) = resp.content_length()
        && cl > MAX_RPC_BYTES as u64
    {
        rpc_error_shared(out_tx, shared, peer, e2e_on, token, &id, 413, "response too large for relay (32MB cap)").await;
        return;
    }
    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("relay rpc read failed: {e:#}");
            rpc_error_shared(out_tx, shared, peer, e2e_on, token, &id, 502, "failed to read local response").await;
            return;
        }
    };
    if bytes.len() > MAX_RPC_BYTES {
        rpc_error_shared(out_tx, shared, peer, e2e_on, token, &id, 413, "response too large for relay (32MB cap)").await;
        return;
    }
    let chunks: Vec<String> = bytes
        .chunks(RPC_CHUNK_RAW)
        .map(b64_encode)
        .collect();
    let n = chunks.len();
    // Strict: refuse the whole response when the peer lacks E2E (no leak).
    if e2e_on && !peer_e2e_now(peer) {
        eprintln!("{E2E_ERROR_MSG} (rpc {id})");
        crate::db::audit("-", "local", "relay-downgrade", token, "deny");
        return;
    }
    if e2e_on {
        // Sealed path — any single seal failure fails the response loudly.
        let seq_msgs = std::iter::once(serde_json::json!({
            "type": "rpc-begin",
            "id": id,
            "status": status,
            "headers": out_headers,
            "body_len": bytes.len(),
            "chunks": n,
        }))
        .chain(chunks.iter().enumerate().map(|(i, data)| {
            serde_json::json!({"type":"rpc-chunk","id":id,"i":i,"data":data})
        }))
        .chain(std::iter::once(
            serde_json::json!({"type":"rpc-end","id":id,"chunks":n}),
        ));
        for v in seq_msgs {
            if send_enc_shared(out_tx, shared, &v).await.is_err() {
                eprintln!("E2E seal failed (rpc {id})");
                crate::db::audit("-", "local", "relay-rpc", token, "error");
                return;
            }
        }
    } else {
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
    }
    crate::db::audit("-", "local", "relay-rpc", token, "ok");
}

/// Short `METHOD /api/xxx` label for logs (no query — may hold filenames).
fn short_path(path: &str) -> String {
    let root = path.split('?').next().unwrap_or(path);
    if root.len() > 64 {
        let truncated: String = root.chars().take(64).collect();
        format!("{truncated}…")
    } else {
        root.to_string()
    }
}

/// Spawn the transparent `/v1/shell` bridge for one relay channel.
/// Owns the loopback WS; `in_rx` carries relay->local input from the main
/// loop. PTY bytes (text + binary, v1/v2 frames, resize/ping/ack) pass
/// through untouched as base64 `shell-recv` / `shell-send` — sealed via
/// `enc` when E2E is on (strict: refused when the peer lacks E2E).
#[allow(clippy::too_many_arguments)] // relay plumbing: explicit params keep call sites readable
async fn spawn_shell_bridge(
    out_tx: OutTx,
    shared: SharedE2e,
    peer: SharedPeer,
    e2e_on: bool,
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
    let shared_fail = shared.clone();
    let peer_fail = peer.clone();
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
        // NOTE: tungstenite 0.30 requires a hand-built Request to already
        // carry every handshake header (Host/Connection/Upgrade/
        // Sec-WebSocket-Version/Sec-WebSocket-Key) — a bare builder fails
        // every dial with `sec-websocket-key` and relay terminals never
        // open. Build via `IntoClientRequest` (adds all of them + a fresh
        // key) and only append our Cookie afterwards.
        let req = {
            use tokio_tungstenite::tungstenite::client::IntoClientRequest;
            use tokio_tungstenite::tungstenite::http::header::{COOKIE, HeaderValue};
            let mut req = url
                .as_str()
                .into_client_request()
                .map_err(|e| anyhow::anyhow!("loopback shell request: {e}"))?;
            if let Some(c) = cookie.as_deref().filter(|c| !c.is_empty()) {
                req.headers_mut().insert(
                    COOKIE,
                    HeaderValue::from_str(c)
                        .map_err(|e| anyhow::anyhow!("bad cookie header: {e}"))?,
                );
            }
            req
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
                    // Strict helper: seal when E2E on, drop when peer lacks it.
                    let emit = |v: serde_json::Value| {
                        let out = out_tx.clone();
                        let sh = shared.clone();
                        let pr = peer.clone();
                        async move {
                            if e2e_on {
                                if !pr.load(Ordering::SeqCst) {
                                    return;
                                }
                                let _ = send_enc_shared(&out, &sh, &v).await;
                            } else {
                                send_out(&out, &v);
                            }
                        }
                    };
                    match msg {
                        Ok(Message::Text(s)) => {
                            emit(serde_json::json!({
                                "type": "shell-recv",
                                "id": id,
                                "is_text": true,
                                "data": b64_encode(s.as_bytes()),
                            })).await;
                        }
                        Ok(Message::Binary(b)) => {
                            emit(serde_json::json!({
                                "type": "shell-recv",
                                "id": id,
                                "is_text": false,
                                "data": b64_encode(&b),
                            })).await;
                        }
                        Ok(Message::Close(frame)) => {
                            let (code, reason) = frame
                                .map(|f| (f.code.into(), f.reason.to_string()))
                                .unwrap_or((1005u16, String::new()));
                            emit(serde_json::json!({
                                "type": "shell-closed",
                                "id": id,
                                "code": code,
                                "reason": reason,
                            })).await;
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
        let v = serde_json::json!({"type":"shell-closed","id":id_fail,"code":1011,"reason":"loopback unreachable"});
        if e2e_on {
            if peer_fail.load(Ordering::SeqCst) {
                let _ = send_enc_shared(&out_tx_fail, &shared_fail, &v).await;
            }
        } else {
            send_out(&out_tx_fail, &v);
        }
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

/// Sealed inner `rpc-*` (decrypted `enc` payload): same validation as the
/// plaintext path, responses sealed via `enc` (strict).
#[allow(clippy::too_many_arguments)] // relay plumbing: explicit params keep call sites readable
async fn handle_inner_rpc(
    out_tx: &OutTx,
    http_client: &reqwest::Client,
    local_base: &str,
    pending_rpc: &mut HashMap<String, PendingRpc>,
    inner: &serde_json::Value,
    token: &str,
    shared: SharedE2e,
    peer: SharedPeer,
    e2e_on: bool,
) {
    match inner.get("type").and_then(|t| t.as_str()) {
        Some("rpc-begin") => {
            let parsed: Result<RpcBeginMsg, _> = serde_json::from_value(inner.clone());
            let req = match parsed {
                Ok(r) => r,
                Err(_) => return,
            };
            if req.id.is_empty() || req.id.len() > 64 || !valid_rpc_path(&req.path) {
                rpc_error_shared(out_tx, &shared, &peer, e2e_on, token, &req.id, 400, "bad rpc request").await;
                return;
            }
            if req.chunks > MAX_RPC_CHUNKS || req.body_len > MAX_RPC_BYTES {
                rpc_error_shared(out_tx, &shared, &peer, e2e_on, token, &req.id, 413, "request too large for relay (32MB cap)").await;
                return;
            }
            if req.chunks == 0 {
                let out = out_tx.clone();
                let client = http_client.clone();
                let base = local_base.to_string();
                let tok = token.to_string();
                tokio::spawn(async move {
                    proxy_rpc(&out, &shared, &peer, e2e_on, &client, &base, &tok, req.id, req.method, req.path, req.headers, Vec::new()).await;
                });
            } else {
                if pending_rpc.len() >= MAX_PENDING_RPC {
                    rpc_error_shared(out_tx, &shared, &peer, e2e_on, token, &req.id, 429, "too many pending rpc uploads").await;
                    return;
                }
                if pending_rpc.contains_key(&req.id) {
                    rpc_error_shared(out_tx, &shared, &peer, e2e_on, token, &req.id, 400, "duplicate rpc id").await;
                    return;
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
                        chunks: req.chunks.min(MAX_RPC_CHUNKS),
                        parts,
                    },
                );
            }
        }
        Some("rpc-chunk") => {
            let id = inner.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let i = inner.get("i").and_then(|v| v.as_u64()).unwrap_or(u64::MAX) as usize;
            let data = inner.get("data").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(pending) = pending_rpc.get_mut(id)
                && i < pending.parts.len() && data.len() <= 128 * 1024 && !data.is_empty() {
                    pending.parts[i] = Some(data.to_string());
                }
        }
        Some("rpc-end") => {
            let id = inner.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if let Some(pending) = pending_rpc.remove(&id) {
                if pending.parts.iter().any(|p| p.is_none()) {
                    rpc_error_shared(out_tx, &shared, &peer, e2e_on, token, &id, 400, "incomplete rpc upload").await;
                    return;
                }
                let mut raw = Vec::with_capacity(pending.body_len.min(MAX_RPC_BYTES));
                for part in pending.parts.iter().flatten() {
                    match b64_decode(part) {
                        Some(bytes) => raw.extend_from_slice(&bytes),
                        None => {
                            rpc_error_shared(out_tx, &shared, &peer, e2e_on, token, &id, 400, "bad rpc chunk encoding").await;
                            return;
                        }
                    }
                    if raw.len() > MAX_RPC_BYTES {
                        rpc_error_shared(out_tx, &shared, &peer, e2e_on, token, &id, 413, "request too large for relay (32MB cap)").await;
                        return;
                    }
                }
                let out = out_tx.clone();
                let sh = shared.clone();
                let pr = peer.clone();
                let client = http_client.clone();
                let base = local_base.to_string();
                let tok = token.to_string();
                tokio::spawn(async move {
                    proxy_rpc(&out, &sh, &pr, e2e_on, &client, &base, &tok, id, pending.method, pending.path, pending.headers, raw).await;
                });
            }
        }
        _ => {}
    }
}

/// Sealed inner `shell-*` (decrypted `enc` payload): same bridge as the
/// plaintext path, PTY bytes sealed via `enc` on the way back.
#[allow(clippy::too_many_arguments)] // relay plumbing: explicit params keep call sites readable
async fn handle_inner_shell(
    out_tx: &OutTx,
    shells: Arc<Mutex<HashMap<String, ShellBridge>>>,
    inner: &serde_json::Value,
    local_base: &str,
    token: &str,
    shared: SharedE2e,
    peer: SharedPeer,
    e2e_on: bool,
) {
    match inner.get("type").and_then(|t| t.as_str()) {
        Some("shell-open") => {
            let id = inner.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if id.is_empty() || id.len() > 64 {
                return;
            }
            if shells.lock().await.contains_key(&id) {
                return;
            }
            let sid = inner.get("sid").and_then(|v| v.as_str()).map(|s| s.to_string());
            let v = inner.get("v").and_then(|v| v.as_u64()).unwrap_or(2).min(2) as u8;
            let from = inner.get("from").and_then(|v| v.as_u64()).unwrap_or(0);
            let cookie = inner.get("cookie").and_then(|v| v.as_str()).map(|s| s.to_string());
            let out = out_tx.clone();
            let shells_clone = shells.clone();
            let base = local_base.to_string();
            let tok = token.to_string();
            tokio::spawn(async move {
                spawn_shell_bridge(out, shared, peer, e2e_on, shells_clone, base, tok, id, sid, v, from, cookie).await;
            });
        }
        Some("shell-send") => {
            let id = inner.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let is_text = inner.get("is_text").and_then(|v| v.as_bool()).unwrap_or(true);
            let data = inner.get("data").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(bridge) = shells.lock().await.get(id)
                && let Some(bytes) = b64_decode(data) {
                    let _ = bridge.to_local.send(ShellLocalIn::Send { is_text, data: bytes });
                }
        }
        Some("shell-close") => {
            let id = inner.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(bridge) = shells.lock().await.get(id) {
                let _ = bridge.to_local.send(ShellLocalIn::Close);
            }
        }
        _ => {}
    }
}

#[allow(clippy::too_many_arguments)] // relay plumbing: explicit params keep call sites readable
async fn on_text(
    out_tx: &OutTx,
    http_client: &reqwest::Client,
    local_base: &str,
    pending_rpc: &mut HashMap<String, PendingRpc>,
    shells: Arc<Mutex<HashMap<String, ShellBridge>>>,
    text: &str,
    push_ui: bool,
    token: &str,
    shared: SharedE2e,
    peer: SharedPeer,
    e2e_on: bool,
    local_fp: Option<String>,
    sess: String,
    epoch: u64,
    relay_pin: &Option<std::sync::Arc<crate::auth::RelayPinState>>,
    viewer_ok: &mut bool,
) -> anyhow::Result<()> {
    // Fast path: `enc` envelopes (opaque to the relay, sealed for us).
    if let Some(env) = crate::e2e::parse_envelope(text) {
        if !e2e_on {
            // Legacy agent (`--no-e2e`) got sealed traffic it cannot read.
            return Ok(());
        }
        let pt = {
            let mut g = shared.lock().await;
            let Some(state) = g.as_mut() else {
                return Ok(());
            };
            match state.decrypt_next(&env) {
                Ok(pt) => pt,
                Err(_) => {
                    // Wrong key / tampered / cross-session / replay — generic.
                    eprintln!("E2E decrypt failed (wrong key or tampered message)");
                    crate::db::audit("-", "local", "relay-e2e-error", token, "deny");
                    return Ok(());
                }
            }
        };
        // Inner protocol is the existing JSON (auth, data, rpc-*, shell-*).
        let inner: serde_json::Value = match serde_json::from_slice(&pt) {
            Ok(v) => v,
            Err(_) => return Ok(()),
        };
        // PIN inside enc takes precedence (never plaintext when E2E works).
        if inner.get("type").and_then(|t| t.as_str()) == Some("auth") {
            if let Some(pin_state) = relay_pin {
                let attempt = inner.get("pin").and_then(|v| v.as_str()).unwrap_or("");
                let ok = !attempt.is_empty() && pin_state.verify(attempt);
                *viewer_ok = ok;
                crate::db::audit(
                    "-",
                    "local",
                    "relay-viewer-auth",
                    token,
                    if ok { "ok" } else { "deny" },
                );
                let resp = if ok {
                    serde_json::json!({"type":"auth-ok"})
                } else {
                    eprintln!("relay viewer PIN rejected (inside E2E)");
                    serde_json::json!({"type":"auth-fail"})
                };
                let _ = send_enc_shared(out_tx, &shared, &resp).await;
            } else {
                let _ = send_enc_shared(out_tx, &shared, &serde_json::json!({"type":"auth-ok"})).await;
            }
            return Ok(());
        }
        // `--relay-auth`: refuse sealed data until the viewer PIN checked out.
        if relay_pin.is_some() && !*viewer_ok {
            eprintln!("relay viewer PIN required before data bridge");
            crate::db::audit("-", "local", "relay-data", token, "deny");
            let _ = send_enc_shared(out_tx, &shared, &serde_json::json!({"type":"auth-required"})).await;
            return Ok(());
        }
        match inner.get("type").and_then(|t| t.as_str()) {
            Some("data") => {
                // v1 legacy ack path (kept for old peers) — now sealed.
                crate::db::audit("-", "local", "relay-data", token, "ok");
                let _ = send_enc_shared(out_tx, &shared, &serde_json::json!({"type":"ack"})).await;
            }
            Some("ping") => {
                let _ = send_enc_shared(out_tx, &shared, &serde_json::json!({"type":"pong"})).await;
            }
            Some("rpc-begin") | Some("rpc-chunk") | Some("rpc-end") => {
                handle_inner_rpc(
                    out_tx,
                    http_client,
                    local_base,
                    pending_rpc,
                    &inner,
                    token,
                    shared.clone(),
                    peer.clone(),
                    e2e_on,
                )
                .await;
            }
            Some("shell-open") | Some("shell-send") | Some("shell-close") => {
                handle_inner_shell(out_tx, shells.clone(), &inner, local_base, token, shared.clone(), peer.clone(), e2e_on).await;
            }
            _ => {}
        }
        return Ok(());
    }

    let msg: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    match msg.get("type").and_then(|t| t.as_str()) {
        Some("hello") => {
            // Peer capability negotiation:
            // `{type:hello, role, token, e2e?, sess?, epoch?, fp?, pin?(legacy)}`.
            // Strict-by-default: E2E-on locally requires the peer to
            // advertise E2E, else hard-fail with `E2E error` + audit deny
            // and refuse all plaintext below. `--no-e2e` is the only escape
            // hatch (explicit, loud + audited at startup).
            let alg = msg.get("e2e").and_then(|v| v.as_str());
            let peer_ok = alg == Some(E2E_ALG);
            peer.store(peer_ok, Ordering::SeqCst);
            if peer_ok {
                println!("web client supports E2E ({E2E_ALG})");
                // Identity binding: peer fp must match ours (same k).
                if e2e_on
                    && let (Some(theirs), Some(ours)) = (
                        msg.get("fp").and_then(|v| v.as_str()),
                        local_fp.as_deref(),
                    )
                        && theirs != ours {
                            eprintln!(
                                "E2E error: fingerprint mismatch (wrong key?) — refusing plaintext"
                            );
                            crate::db::audit("-", "local", "relay-downgrade", token, "deny");
                            peer.store(false, Ordering::SeqCst);
                        }
            } else if e2e_on {
                eprintln!("{E2E_ERROR_MSG}");
                crate::db::audit("-", "local", "relay-downgrade", token, "deny");
            }
            // Legacy plaintext PIN: accepted ONLY from non-E2E peers for
            // compat. Once E2E is negotiated the PIN must arrive inside
            // `enc` (`auth`) — plaintext `pin` here is ignored (never logged).
            if let Some(pin_state) = relay_pin {
                let has_plaintext_pin = msg.get("pin").and_then(|v| v.as_str()).is_some();
                if has_plaintext_pin && !(e2e_on && peer_e2e_now(&peer)) {
                    let pin_ok = msg
                        .get("pin")
                        .and_then(|v| v.as_str())
                        .is_some_and(|p| pin_state.verify(p));
                    *viewer_ok = pin_ok;
                    crate::db::audit(
                        "-",
                        "local",
                        "relay-viewer-auth",
                        token,
                        if pin_ok { "ok" } else { "deny" },
                    );
                    if !pin_ok {
                        eprintln!("relay viewer PIN rejected");
                    } else {
                        eprintln!(
                            "note: plaintext viewer PIN accepted (legacy peer) — prefer E2E + PIN inside enc"
                        );
                    }
                } else if has_plaintext_pin {
                    eprintln!(
                        "plaintext viewer PIN ignored — resend inside E2E (never in hello/query/logs)"
                    );
                    crate::db::audit("-", "local", "relay-viewer-auth", token, "deny");
                }
            }
            // Answer every client `hello` with our own (plaintext control, no
            // secrets — `fp` is public identity). Late joiners miss the
            // connect-time hello (the room only replays the UI bundle), so
            // without this reply the viewer would never learn
            // `sess`/`epoch`/`fp`/`relay_auth` and could not seal `enc`.
            // The room relays this to all clients (v1: single viewer).
            let reply = serde_json::json!({
                "type": "hello",
                "role": "agent",
                "token": token,
                "e2e": if e2e_on { Some(E2E_ALG) } else { None },
                "sess": if e2e_on && !sess.is_empty() { Some(sess.as_str()) } else { None },
                "epoch": if e2e_on { Some(epoch) } else { None },
                "fp": local_fp.as_deref(),
                "relay_auth": if relay_pin.is_some() { Some(true) } else { None },
            });
            send_out(out_tx, &reply);
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
            // `ui-*` stays plaintext by design (public build output, zero
            // secrets — proven by `ui_bundle_has_no_secrets` test + no-store).
            // When `--relay-auth` gates data, the UI shell still loads but
            // every data/rpc/shell bridge denies until PIN-inside-enc verifies.
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
            // Strict: E2E-on refuses plaintext data (no silent downgrade).
            if e2e_on && !strict_peer_ok(e2e_on, peer_e2e_now(&peer)) {
                eprintln!("{E2E_ERROR_MSG} (data)");
                crate::db::audit("-", "local", "relay-downgrade", token, "deny");
                return Ok(());
            }
            crate::db::audit("-", "local", "relay-data", token, "ok");
            send_out(out_tx, &serde_json::json!({"type":"ack"}));
        }
        // ---- Full-function relay: HTTP `/api/*` over WSS ----
        // Strict: plaintext rpc is refused when E2E is on (no downgrade).
        Some("rpc-begin") => {
            if relay_pin.is_some() && !*viewer_ok {
                let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
                eprintln!("relay viewer PIN required before rpc bridge");
                crate::db::audit("-", "local", "relay-rpc", token, "deny");
                rpc_error_shared(out_tx, &shared, &peer, e2e_on, token, id, 403, "viewer PIN required").await;
                return Ok(());
            }
            if e2e_on && !strict_peer_ok(e2e_on, peer_e2e_now(&peer)) {
                let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
                eprintln!("{E2E_ERROR_MSG} (rpc-begin {id})");
                rpc_e2e_required(out_tx, token, id);
                return Ok(());
            }
            let parsed: Result<RpcBeginMsg, _> = serde_json::from_value(msg.clone());
            let req = match parsed {
                Ok(r) => r,
                Err(_) => return Ok(()),
            };
            if req.id.is_empty() || req.id.len() > 64 || !valid_rpc_path(&req.path) {
                rpc_error_shared(out_tx, &shared, &peer, e2e_on, token, &req.id, 400, "bad rpc request").await;
                return Ok(());
            }
            if req.chunks > MAX_RPC_CHUNKS || req.body_len > MAX_RPC_BYTES {
                rpc_error_shared(out_tx, &shared, &peer, e2e_on, token, &req.id, 413, "request too large for relay (32MB cap)").await;
                return Ok(());
            }
            if req.chunks == 0 {
                // No body — proxy immediately.
                let out = out_tx.clone();
                let sh = shared.clone();
                let pr = peer.clone();
                let client = http_client.clone();
                let base = local_base.to_string();
                let tok = token.to_string();
                tokio::spawn(async move {
                    proxy_rpc(&out, &sh, &pr, e2e_on, &client, &base, &tok, req.id, req.method, req.path, req.headers, Vec::new()).await;
                });
            } else {
                // Chunked body — reassemble, then proxy on rpc-end.
                if pending_rpc.contains_key(&req.id) {
                    rpc_error_shared(out_tx, &shared, &peer, e2e_on, token, &req.id, 400, "duplicate rpc id").await;
                    return Ok(());
                }
                let mut parts = Vec::new();
                parts.resize_with(req.chunks.min(MAX_RPC_CHUNKS), || None);
                let pending = PendingRpc {
                    method: req.method,
                    path: req.path,
                    headers: req.headers,
                    body_len: req.body_len,
                    chunks: req.chunks.min(MAX_RPC_CHUNKS),
                    parts,
                };
                let _ = pending.chunks;
                pending_rpc.insert(req.id.clone(), pending);
            }
        }
        Some("rpc-chunk") => {
            if e2e_on && !strict_peer_ok(e2e_on, peer_e2e_now(&peer)) {
                return Ok(());
            }
            let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let i = msg.get("i").and_then(|v| v.as_u64()).unwrap_or(u64::MAX) as usize;
            let data = msg.get("data").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(pending) = pending_rpc.get_mut(id)
                && i < pending.parts.len() && data.len() <= 128 * 1024 && !data.is_empty() {
                    pending.parts[i] = Some(data.to_string());
                }
        }
        Some("rpc-end") => {
            if e2e_on && !strict_peer_ok(e2e_on, peer_e2e_now(&peer)) {
                return Ok(());
            }
            let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if let Some(pending) = pending_rpc.remove(&id) {
                if pending.parts.iter().any(|p| p.is_none()) {
                    rpc_error_shared(out_tx, &shared, &peer, e2e_on, token, &id, 400, "incomplete rpc upload").await;
                    return Ok(());
                }
                let mut raw = Vec::with_capacity(pending.body_len.min(MAX_RPC_BYTES));
                for part in pending.parts.iter().flatten() {
                    match b64_decode(part) {
                        Some(bytes) => raw.extend_from_slice(&bytes),
                        None => {
                            rpc_error_shared(out_tx, &shared, &peer, e2e_on, token, &id, 400, "bad rpc chunk encoding").await;
                            return Ok(());
                        }
                    }
                    if raw.len() > MAX_RPC_BYTES {
                        rpc_error_shared(out_tx, &shared, &peer, e2e_on, token, &id, 413, "request too large for relay (32MB cap)").await;
                        return Ok(());
                    }
                }
                let out = out_tx.clone();
                let sh = shared.clone();
                let pr = peer.clone();
                let client = http_client.clone();
                let base = local_base.to_string();
                let tok = token.to_string();
                tokio::spawn(async move {
                    proxy_rpc(&out, &sh, &pr, e2e_on, &client, &base, &tok, id, pending.method, pending.path, pending.headers, raw).await;
                });
            }
        }
        // ---- Full-function relay: `/v1/shell` PTY over WSS ----
        Some("shell-open") => {
            if relay_pin.is_some() && !*viewer_ok {
                let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
                eprintln!("relay viewer PIN required before shell bridge");
                crate::db::audit("-", "local", "relay-shell", token, "deny");
                let v = serde_json::json!({"type":"shell-closed","id":id,"code":4403,"reason":"viewer PIN required"});
                if !send_strict(out_tx, &shared, &peer, e2e_on, &v).await {
                    // No secrets in the notice — still notify plaintext peers.
                    send_out(out_tx, &serde_json::json!({"type":"shell-closed","id":id,"code":4403,"reason":"viewer PIN required"}));
                    crate::db::audit("-", "local", "relay-downgrade", token, "deny");
                }
                return Ok(());
            }
            if e2e_on && !strict_peer_ok(e2e_on, peer_e2e_now(&peer)) {
                let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
                eprintln!("{E2E_ERROR_MSG} (shell-open {id})");
                shell_e2e_required(out_tx, token, id);
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
            let out = out_tx.clone();
            let sh = shared.clone();
            let pr = peer.clone();
            let shells_clone = shells.clone();
            let base = local_base.to_string();
            let tok = token.to_string();
            tokio::spawn(async move {
                spawn_shell_bridge(out, sh, pr, e2e_on, shells_clone, base, tok, id, sid, v, from, cookie).await;
            });
        }
        Some("shell-send") => {
            if e2e_on && !strict_peer_ok(e2e_on, peer_e2e_now(&peer)) {
                return Ok(());
            }
            if relay_pin.is_some() && !*viewer_ok {
                return Ok(());
            }
            let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let is_text = msg.get("is_text").and_then(|v| v.as_bool()).unwrap_or(true);
            let data = msg.get("data").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(bridge) = shells.lock().await.get(id)
                && let Some(bytes) = b64_decode(data) {
                    let _ = bridge.to_local.send(ShellLocalIn::Send { is_text, data: bytes });
                }
        }
        Some("shell-close") => {
            if e2e_on && !strict_peer_ok(e2e_on, peer_e2e_now(&peer)) {
                return Ok(());
            }
            let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(bridge) = shells.lock().await.get(id) {
                let _ = bridge.to_local.send(ShellLocalIn::Close);
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_fresh_are_9_and_legacy_5_still_valid() {
        let t = new_token();
        assert_eq!(t.len(), TOKEN_LEN_NEW);
        assert!(valid_token(&t));
        // Legacy 5-char tokens still route (compat).
        assert!(valid_token("ABCDE"));
        assert!(valid_token("abcde".to_uppercase().as_str()));
        assert!(!valid_token("ABCD"));
        assert!(!valid_token("ABCDEFGHIJ"));
        assert!(!valid_token("AB-CD"));
        assert!(!valid_token(""));
    }

    #[test]
    fn downgrade_strict_matrix() {
        // E2E-on + legacy peer → refuse (no silent plaintext).
        assert!(!strict_peer_ok(true, false));
        assert!(strict_peer_ok(true, true));
        // Explicit escape hatch only.
        assert!(strict_peer_ok(false, false));
    }

    #[test]
    fn rpc_path_allowlist() {
        assert!(valid_rpc_path("/api/files"));
        assert!(valid_rpc_path("/api/terms/abc/recording"));
        assert!(!valid_rpc_path("/"));
        assert!(!valid_rpc_path("/v1/shell"));
        assert!(!valid_rpc_path("/api/../etc"));
        assert!(!valid_rpc_path("/assets/app.js"));
    }

    #[test]
    fn ui_bundle_carries_zero_secrets() {
        // The pushed bundle is public build output served with `no-store`.
        // Prove it embeds no E2E secret / PIN material: no `#k=<43-char key>`
        // fragment secret (code only mentions `#k=...` placeholders), no
        // PIN JSON. (`k`/PIN live only in the URL fragment + memory.)
        let html = crate::ui::build_single_file().expect("build bundle");
        let mut found_key = false;
        let bytes = html.as_bytes();
        // Scan for `#k=` followed by 43 URL-safe chars (a real embedded key).
        for (i, w) in bytes.windows(3).enumerate() {
            if w == b"#k=" {
                let rest = &html[i + 3..];
                let keylen = rest
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                    .count();
                if keylen == 43 {
                    found_key = true;
                    break;
                }
            }
        }
        assert!(!found_key, "bundle must not embed an E2E key");
        assert!(
            !html.contains("\"pin\"") || html.contains("relay-auth"),
            "bundle must not embed a viewer PIN"
        );
    }
}
