//! Local shell over WebSocket — sshx.io style, no token.
//!
//! `GET /v1/shell?id=<session>` upgrades to WebSocket. Sessions outlive
//! the socket: closing the page (or refreshing) detaches, and reconnecting
//! with the same id reattaches to the still-running shell, replaying the
//! scrollback ring first. Detached sessions are reaped after a TTL.
//!
//! Protocol (v1 — unchanged, default):
//! * client -> server: raw keystrokes (`onData` from xterm.js). Only the
//!   exact JSON `{"type":"resize","cols":N,"rows":N}` is control traffic —
//!   everything else (even typed JSON) goes to the shell as input.
//! * server -> client: `{"type":"ready","id":...}` (Text) first, then raw
//!   PTY bytes (Binary frames) for xterm.js, plus the exact Text
//!   `{"type":"exit"}` once when the shell exits (followed by Close).
//!   A superseded socket gets Close code 4000 ("attached elsewhere").
//!
//! Protocol (v2 — opt-in via `?v=2`, fully backward compatible):
//! * Old clients never send `v`/`from`, so they always get the v1 shapes
//!   above, byte-identical. Old servers ignore the unknown `v`/`from`
//!   query fields (serde default) and keep speaking v1.
//! * v2 `ready` adds stream state:
//!   `{"type":"ready","id":...,"v":2,"seq":N,"behind":false}`
//!   (`seq` = total PTY bytes ever produced; `behind` = the requested
//!   `?from=` offset was already evicted from the ring).
//! * v2 Binary frames are `u64 LE stream offset + raw PTY bytes`, so the
//!   client can detect gaps and resume with `?from=LAST` without
//!   duplication or loss (replay sends only the missed tail).
//! * v2 client -> server control (exact shapes only, else shell input):
//!   `{"type":"ack","seq":N}` (received watermark, visible in /api/terms),
//!   `{"type":"ping","t":ms}` -> server replies `{"type":"pong","t":ms}`
//!   for client-side RTT. `resize` works as in v1.
//!
//! Persistence (`--db`, see `crate::db`): sessions are mirrored into SQLite
//! — any visitor can list (`GET /api/terms`) and reattach to them, and the
//! scrollback survives a backend restart as replayable history. Live PTY
//! processes cannot survive a restart (the OS child dies with us).

use axum::{
    extract::{
        Query,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    response::IntoResponse,
};
use crate::db;
use futures_util::{SinkExt, StreamExt};
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde::Deserialize;
use std::{
    collections::{HashMap, VecDeque},
    io::Read,
    sync::{
        Arc, LazyLock, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

/// PTY output kept per session for reattach replay.
const RING_CAP: usize = 256 * 1024;
/// Detached sessions are reaped after this long without a socket.
const SESSION_TTL: Duration = Duration::from_secs(30 * 60);
/// Upper bound on sessions; oldest detached are evicted past it.
const MAX_SESSIONS: usize = 64;
/// Close code telling a socket it lost a takeover fight.
const CLOSE_SUPERSEDED: u16 = 4000;

/// Negotiated protocol version. v1 = legacy shapes (default).
const PROTO_V2: u8 = 2;

#[derive(Deserialize)]
pub struct ShellQuery {
    pub id: Option<String>,
    /// Opt-in protocol version (`?v=2`). Unknown to old servers (ignored),
    /// absent from old clients (v1 shapes).
    #[serde(default)]
    pub v: Option<u8>,
    /// v2 resume offset: total PTY bytes already received (`?from=N`).
    #[serde(default)]
    pub from: Option<u64>,
}

fn valid_session_id(t: &str) -> bool {
    !t.is_empty()
        && t.len() <= 64
        && t.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn new_session_id() -> String {
    // 128-bit random hex — unguessable, so another local user can't
    // attach to someone else's shell by guessing ids.
    (0..16)
        .map(|_| format!("{:02x}", fastrand::u8(..)))
        .collect()
}

/// Keep the last RING_CAP bytes of PTY output for reattach replay.
/// `base` tracks the stream offset of the ring front (total bytes evicted).
fn push_ring(ring: &mut VecDeque<u8>, base: &mut u64, bytes: &[u8]) {
    ring.extend(bytes.iter());
    let overflow = ring.len().saturating_sub(RING_CAP);
    if overflow > 0 {
        ring.drain(..overflow);
        *base = base.saturating_add(overflow as u64);
    }
}

/// v2 binary frame: `u64 LE stream offset + raw PTY bytes`.
fn encode_frame(base: u64, bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + bytes.len());
    out.extend_from_slice(&base.to_le_bytes());
    out.extend_from_slice(bytes);
    out
}

/// Split a v2 binary frame back into `(stream offset, PTY bytes)`.
/// Returns `None` when the frame is too short to hold an offset.
fn decode_frame(frame: &[u8]) -> Option<(u64, &[u8])> {
    if frame.len() < 8 {
        return None;
    }
    let mut b = [0u8; 8];
    b.copy_from_slice(&frame[..8]);
    Some((u64::from_le_bytes(b), &frame[8..]))
}

/// Exact-shape v2 control: `{"type":"ping","t":ms}` -> the echoed `t`.
fn parse_ping(v: &serde_json::Value) -> Option<u64> {
    if v.get("type").and_then(|t| t.as_str()) != Some("ping") {
        return None;
    }
    v.get("t").and_then(|t| t.as_u64())
}

/// Exact-shape v2 control: `{"type":"ack","seq":N}` -> received watermark.
fn parse_ack(v: &serde_json::Value) -> Option<u64> {
    if v.get("type").and_then(|t| t.as_str()) != Some("ack") {
        return None;
    }
    v.get("seq").and_then(|s| s.as_u64())
}

enum Out {
    Data { base: u64, bytes: Vec<u8> },
    Eof,
    Takeover,
}

struct Session {
    id: String,
    master: StdMutex<Option<Box<dyn portable_pty::MasterPty + Send>>>,
    child: StdMutex<Option<Box<dyn portable_pty::Child + Send + Sync>>>,
    /// Input path to the PTY writer thread (lives as long as the session).
    writer_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    /// Current subscriber (None while detached).
    sub: StdMutex<Option<tokio::sync::mpsc::Sender<Out>>>,
    ring: StdMutex<VecDeque<u8>>,
    /// Stream offset of the ring front (total bytes evicted from the ring).
    /// Invariant: `offset == ring_base + ring.len()`.
    ring_base: StdMutex<u64>,
    /// Total PTY bytes ever produced by this session (v2 stream offsets).
    offset: AtomicU64,
    /// Highest `ack` watermark reported by the attached client (v2).
    acked: AtomicU64,
    dead: AtomicBool,
    /// Bumped on every attach; lets stale sockets notice a takeover.
    epoch: AtomicU64,
    last_active: StdMutex<Instant>,
    created_at: u64,
    /// Ring changed since the last SQLite flush (set by the PTY reader).
    dirty: AtomicBool,
}

static SESSIONS: LazyLock<tokio::sync::Mutex<HashMap<String, Arc<Session>>>> =
    LazyLock::new(|| tokio::sync::Mutex::new(HashMap::new()));

pub async fn ws_handler(ws: WebSocketUpgrade, Query(q): Query<ShellQuery>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, q))
}

fn spawn_shell(
    cols: u16,
    rows: u16,
) -> anyhow::Result<(
    Box<dyn portable_pty::MasterPty + Send>,
    Box<dyn portable_pty::Child + Send + Sync>,
)> {
    let pty_system = NativePtySystem::default();
    let pair = pty_system.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "bash".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    // `-i` keeps `bash` interactive when stdin is a PTY slave; if the
    // binary is not bash (e.g. sh/zsh/fish) extra args are still harmless
    // for most shells — fall back to plain spawn when it fails.
    cmd.args(["-i"]);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("KS_SSH", "1");
    if let Ok(home) = std::env::var("HOME")
        && !home.trim().is_empty()
        && std::path::Path::new(&home).is_dir()
    {
        cmd.cwd(home);
    }

    let child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(_) => {
            let mut plain = CommandBuilder::new(&shell);
            plain.env("TERM", "xterm-256color");
            plain.env("COLORTERM", "truecolor");
            plain.env("KS_SSH", "1");
            pair.slave.spawn_command(plain)?
        }
    };
    Ok((pair.master, child))
}

/// Spawn the PTY + shell threads for a brand-new session.
fn spawn_session(id: String) -> anyhow::Result<Arc<Session>> {
    let (master, child) = spawn_shell(80, 24)?;

    let mut reader = master.try_clone_reader()?;
    let writer = master.take_writer()?;
    let (writer_tx, writer_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(128);

    let session = Arc::new(Session {
        id,
        master: StdMutex::new(Some(master)),
        child: StdMutex::new(Some(child)),
        writer_tx,
        sub: StdMutex::new(None),
        ring: StdMutex::new(VecDeque::new()),
        ring_base: StdMutex::new(0),
        offset: AtomicU64::new(0),
        acked: AtomicU64::new(0),
        dead: AtomicBool::new(false),
        epoch: AtomicU64::new(0),
        last_active: StdMutex::new(Instant::now()),
        created_at: db::now_secs(),
        dirty: AtomicBool::new(false),
    });

    // PTY writer lives on its own blocking thread so big pastes never
    // stall the tokio executor. It lives as long as the session, so input
    // works across reattaches.
    std::thread::spawn(move || {
        let mut w = writer;
        let mut rx = writer_rx;
        use std::io::Write as _;
        while let Some(data) = rx.blocking_recv() {
            let _ = w.write_all(&data);
            let _ = w.flush();
        }
    });

    // PTY reader: feeds the replay ring forever and forwards to whoever
    // is currently attached. `blocking_send` applies backpressure into
    // the PTY so `cat` on a huge file slows the reader instead of OOMing.
    let reader_session = session.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let bytes = &buf[..n];
                    // Claim this chunk's stream offset first so frames stay
                    // ordered even under contention.
                    let base = reader_session.offset.fetch_add(n as u64, Ordering::SeqCst);
                    if let Ok(mut ring) = reader_session.ring.lock() {
                        if let Ok(mut rbase) = reader_session.ring_base.lock() {
                            push_ring(&mut ring, &mut rbase, bytes);
                        }
                    }
                    reader_session.dirty.store(true, Ordering::SeqCst);
                    let tx = reader_session.sub.lock().ok().and_then(|g| g.clone());
                    if let Some(tx) = tx {
                        // Detached (or taken over) — ring keeps the bytes.
                        let _ = tx.blocking_send(Out::Data {
                            base,
                            bytes: bytes.to_vec(),
                        });
                    }
                }
                Err(_) => break,
            }
        }
        reader_session.dead.store(true, Ordering::SeqCst);
        // Shell over — flush the final output + dead flag to SQLite now.
        persist_session(&reader_session);
        if let Some(tx) = reader_session.sub.lock().ok().and_then(|g| g.clone()) {
            let _ = tx.try_send(Out::Eof);
        }
    });

    // Watch child exit (polled backup for EOF, which usually wins).
    let watch_session = session.clone();
    std::thread::spawn(move || {
        loop {
            let exited = watch_session
                .child
                .lock()
                .map(|mut guard| match guard.as_mut() {
                    Some(c) => matches!(c.try_wait(), Ok(Some(_))),
                    None => true,
                })
                .unwrap_or(true);
            if exited {
                watch_session.dead.store(true, Ordering::SeqCst);
                if let Some(tx) = watch_session.sub.lock().ok().and_then(|g| g.clone()) {
                    let _ = tx.try_send(Out::Eof);
                }
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    });

    Ok(session)
}

fn reap_child(session: &Session) {
    if let Ok(mut guard) = session.child.lock()
        && let Some(mut c) = guard.take()
    {
        let _ = c.kill();
        let _ = c.wait();
    }
}

/// Look up a session by id, or spawn a fresh one (honouring a valid
/// requested id so a reattach after a backend restart keeps working).
async fn get_or_create_session(want: Option<String>) -> Arc<Session> {
    let id = want
        .filter(|t| valid_session_id(t))
        .unwrap_or_else(new_session_id);
    let mut map = SESSIONS.lock().await;
    if let Some(s) = map.get(&id) {
        return s.clone();
    }
    let session = match spawn_session(id.clone()) {
        Ok(s) => s,
        Err(e) => {
            // PTY spawn failed — hand back a dead placeholder so the
            // socket still gets a clean error + close instead of hanging.
            let (writer_tx, _) = tokio::sync::mpsc::channel::<Vec<u8>>(1);
            let s = Arc::new(Session {
                id,
                master: StdMutex::new(None),
                child: StdMutex::new(None),
                writer_tx,
                sub: StdMutex::new(None),
                ring: StdMutex::new(VecDeque::from(
                    format!("ks-ssh: cannot spawn shell: {e}\r\n").into_bytes(),
                )),
                ring_base: StdMutex::new(0),
                offset: AtomicU64::new(0),
                acked: AtomicU64::new(0),
                dead: AtomicBool::new(true),
                epoch: AtomicU64::new(0),
                last_active: StdMutex::new(Instant::now()),
                created_at: db::now_secs(),
                dirty: AtomicBool::new(false),
            });
            // Don't even store it — nothing to reattach to.
            return s;
        }
    };
    map.insert(id, session.clone());
    // Mirror the new shell into SQLite so visitors (and restarts) see it.
    // (Only the DB lock is taken — brief, no SESSIONS recursion.)
    persist_session(&session);
    // Enforce the cap outside the lock (reaping blocks).
    let victims: Vec<Arc<Session>> = if map.len() > MAX_SESSIONS {
        let mut cands: Vec<(Instant, bool, Arc<Session>)> = map
            .values()
            .map(|s| {
                let t = s
                    .last_active
                    .lock()
                    .ok()
                    .map(|t| *t)
                    .unwrap_or(Instant::now());
                let detached = s.sub.lock().map(|g| g.is_none()).unwrap_or(true);
                (t, detached, s.clone())
            })
            .collect();
        cands.sort_by_key(|(t, _, _)| *t);
        cands
            .into_iter()
            .filter(|(_, detached, _)| *detached)
            .take(map.len() - MAX_SESSIONS)
            .map(|(_, _, s)| s)
            .collect()
    } else {
        Vec::new()
    };
    let victim_ids: Vec<String> = victims.iter().map(|s| s.id.clone()).collect();
    for vid in &victim_ids {
        map.remove(vid);
    }
    drop(map);
    for s in victims {
        reap_child(&s);
        db::delete(&s.id);
    }
    session
}

/// Snapshot one session's ring into SQLite (no-op when `--db` is off).
fn persist_session(session: &Session) {
    if !db::enabled() {
        return;
    }
    let bytes: Vec<u8> = session
        .ring
        .lock()
        .map(|r| r.iter().copied().collect())
        .unwrap_or_default();
    db::upsert(
        &session.id,
        session.created_at,
        db::now_secs(),
        session.dead.load(Ordering::SeqCst),
        &bytes,
    );
    session.dirty.store(false, Ordering::SeqCst);
}

/// Flush dirty scrollback rings into SQLite every few seconds.
/// Spawn once from `serve()` alongside the reaper.
pub fn spawn_persister() {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            if !db::enabled() {
                continue;
            }
            let sessions: Vec<Arc<Session>> = SESSIONS.lock().await.values().cloned().collect();
            for s in sessions {
                if s.dirty.load(Ordering::SeqCst) {
                    persist_session(&s);
                }
            }
        }
    });
}

/// Rebuild history placeholders from SQLite at startup. No PTY is spawned —
/// the OS child is gone, so these replay their saved scrollback and then
/// report `exit` through the normal dead-session path in `handle_socket`.
/// Returns the number of sessions restored.
pub async fn load_persisted() -> usize {
    if !db::enabled() {
        return 0;
    }
    let rows = db::load_all();
    if rows.is_empty() {
        return 0;
    }
    let mut map = SESSIONS.lock().await;
    let mut n = 0;
    for row in rows {
        if map.contains_key(&row.id) || !valid_session_id(&row.id) {
            continue;
        }
        if !row.dead {
            // Was live at shutdown — the shell itself is gone for good.
            db::mark_dead(&row.id, db::now_secs());
        }
        let (writer_tx, _) = tokio::sync::mpsc::channel::<Vec<u8>>(1);
        let session = Arc::new(Session {
            id: row.id.clone(),
            master: StdMutex::new(None),
            child: StdMutex::new(None),
            writer_tx,
            sub: StdMutex::new(None),
            ring: StdMutex::new(row.scrollback.into_iter().collect()),
            ring_base: StdMutex::new(0),
            offset: AtomicU64::new(row.scrollback.len() as u64),
            acked: AtomicU64::new(0),
            dead: AtomicBool::new(true),
            epoch: AtomicU64::new(0),
            last_active: StdMutex::new(Instant::now()),
            created_at: row.created_at,
            dirty: AtomicBool::new(false),
        });
        map.insert(row.id, session);
        n += 1;
    }
    n
}

/// GET /api/terms — host-wide terminal list so any visitor can see and
/// reattach to the shared shells. Behind `require_auth` like `/v1/shell`.
pub async fn api_list_terms() -> impl IntoResponse {
    let mut sessions: Vec<serde_json::Value> = {
        let map = SESSIONS.lock().await;
        map.values()
            .map(|s| {
                let bytes = s.ring.lock().map(|r| r.len()).unwrap_or(0);
                let idle_secs = s
                    .last_active
                    .lock()
                    .ok()
                    .map(|t| t.elapsed().as_secs())
                    .unwrap_or(u64::MAX);
                serde_json::json!({
                    "id": s.id,
                    "alive": !s.dead.load(Ordering::SeqCst),
                    "idle_secs": idle_secs.min(9_999_999_999),
                    "bytes": bytes,
                })
            })
            .collect()
    };
    // Live shells first, then most recently active.
    sessions.sort_by_key(|v| {
        (
            !v.get("alive").and_then(|a| a.as_bool()).unwrap_or(false),
            v.get("idle_secs").and_then(|i| i.as_u64()).unwrap_or(u64::MAX),
        )
    });
    axum::Json(serde_json::json!({ "sessions": sessions }))
}

/// Detach bookkeeping when a socket goes away — the shell keeps running.
fn release(session: &Session, my_epoch: u64) {
    if session.epoch.load(Ordering::SeqCst) == my_epoch
        && let Ok(mut slot) = session.sub.lock()
    {
        slot.take();
    }
    if let Ok(mut t) = session.last_active.lock() {
        *t = Instant::now();
    }
    // Flush the latest output promptly so other visitors see it.
    session.dirty.store(true, Ordering::SeqCst);
}

/// Reap detached sessions past their TTL. Spawn once from `serve()`.
pub fn spawn_reaper() {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let now = Instant::now();
            let victims: Vec<Arc<Session>> = {
                let mut map = SESSIONS.lock().await;
                let ids: Vec<String> = map
                    .iter()
                    .filter(|(_, s)| {
                        let detached = s.sub.lock().map(|g| g.is_none()).unwrap_or(true);
                        let idle = s
                            .last_active
                            .lock()
                            .map(|t| now.duration_since(*t) > SESSION_TTL)
                            .unwrap_or(true);
                        detached && idle
                    })
                    .map(|(id, _)| id.clone())
                    .collect();
                let mut out = Vec::new();
                for id in ids {
                    if let Some(s) = map.remove(&id) {
                        out.push(s);
                    }
                }
                out
            };
            for s in victims {
                reap_child(&s);
                db::delete(&s.id);
            }
            // Drop ancient history rows even for sessions already gone.
            db::prune_expired();
        }
    });
}

async fn handle_socket(socket: WebSocket, req_id: Option<String>) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    let session = get_or_create_session(req_id).await;
    if let Ok(mut t) = session.last_active.lock() {
        *t = Instant::now();
    }
    let my_epoch = session.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    let (sub_tx, mut sub_rx) = tokio::sync::mpsc::channel::<Out>(256);
    // Take over: boot the previous subscriber, if any.
    if let Ok(mut slot) = session.sub.lock()
        && let Some(old) = slot.replace(sub_tx)
    {
        let _ = old.try_send(Out::Takeover);
    }

    // Tell the tab which session it holds (new tabs learn their id here).
    let ready = serde_json::json!({"type": "ready", "id": session.id}).to_string();
    if ws_tx.send(Message::Text(ready.into())).await.is_err() {
        release(&session, my_epoch);
        return;
    }
    // Replay the scrollback ring so a refreshed page sees what it missed.
    let backlog: Vec<u8> = session
        .ring
        .lock()
        .map(|r| r.iter().copied().collect())
        .unwrap_or_default();
    if !backlog.is_empty() && ws_tx.send(Message::Binary(backlog.into())).await.is_err() {
        release(&session, my_epoch);
        return;
    }
    if session.dead.load(Ordering::SeqCst) {
        // Shell already gone — show the tail, announce, close.
        let _ = ws_tx
            .send(Message::Text(r#"{"type":"exit"}"#.to_string().into()))
            .await;
        let _ = ws_tx.send(Message::Close(None)).await;
        release(&session, my_epoch);
        return;
    }

    // PTY -> WebSocket.
    let send_session = session.clone();
    let mut send_task = tokio::spawn(async move {
        // Announce exit then close so the UI can distinguish a real exit
        // (JSON + close) from output that merely looks like JSON.
        let send_exit = async |ws_tx: &mut futures_util::stream::SplitSink<WebSocket, Message>| {
            let _ = ws_tx
                .send(Message::Text(r#"{"type":"exit"}"#.to_string().into()))
                .await;
            let _ = ws_tx.send(Message::Close(None)).await;
        };
        let send_takeover =
            async |ws_tx: &mut futures_util::stream::SplitSink<WebSocket, Message>| {
                let _ = ws_tx
                    .send(Message::Close(Some(CloseFrame {
                        code: CLOSE_SUPERSEDED,
                        reason: "attached elsewhere".into(),
                    })))
                    .await;
            };
        loop {
            // Lost a takeover race while idle — stand down.
            if send_session.epoch.load(Ordering::SeqCst) != my_epoch {
                send_takeover(&mut ws_tx).await;
                break;
            }
            match sub_rx.recv().await {
                Some(Out::Data(bytes)) => {
                    if ws_tx.send(Message::Binary(bytes.into())).await.is_err() {
                        break;
                    }
                }
                Some(Out::Eof) => {
                    send_exit(&mut ws_tx).await;
                    break;
                }
                Some(Out::Takeover) | None => {
                    send_takeover(&mut ws_tx).await;
                    break;
                }
            }
        }
    });

    // WebSocket -> PTY.
    let recv_session = session.clone();
    let writer_tx = session.writer_tx.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(msg) = ws_rx.next().await {
            // Superseded — stop feeding a shell that has a new owner.
            if recv_session.epoch.load(Ordering::SeqCst) != my_epoch {
                break;
            }
            let msg = match msg {
                Ok(m) => m,
                Err(_) => break,
            };
            match msg {
                Message::Text(text) => {
                    let s = text.as_str();
                    // Only the exact resize shape is control traffic —
                    // anything else (even typed JSON) is shell input.
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(s) {
                        let is_resize = v.get("type").and_then(|t| t.as_str()) == Some("resize")
                            && v.get("cols").and_then(|c| c.as_u64()).is_some()
                            && v.get("rows").and_then(|r| r.as_u64()).is_some();
                        if is_resize {
                            let cols = v.get("cols").and_then(|c| c.as_u64()).unwrap_or(80) as u16;
                            let rows = v.get("rows").and_then(|r| r.as_u64()).unwrap_or(24) as u16;
                            if let Ok(master) = recv_session.master.lock()
                                && let Some(master) = master.as_ref()
                            {
                                let _ = master.resize(PtySize {
                                    rows: rows.clamp(2, 300),
                                    cols: cols.clamp(2, 500),
                                    pixel_width: 0,
                                    pixel_height: 0,
                                });
                            }
                            continue;
                        }
                    }
                    // Queue for the blocking writer thread (backpressure ok).
                    if writer_tx.send(s.as_bytes().to_vec()).await.is_err() {
                        break;
                    }
                }
                Message::Binary(bin) => {
                    if writer_tx.send(bin.to_vec()).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = (&mut send_task) => { recv_task.abort(); }
        _ = (&mut recv_task) => { send_task.abort(); }
    }
    // Socket over — detach only. The shell keeps running for reattach;
    // the reaper (TTL) or an explicit kill reaps it later.
    release(&session, my_epoch);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_ids_validated() {
        assert!(valid_session_id("abc123"));
        assert!(valid_session_id("a-B_c9"));
        assert!(!valid_session_id(""));
        assert!(!valid_session_id("has space"));
        assert!(!valid_session_id("semi;colon"));
        assert!(!valid_session_id(&"x".repeat(65)));
    }

    #[test]
    fn ring_keeps_tail() {
        let mut ring = VecDeque::new();
        push_ring(&mut ring, b"hello ");
        push_ring(&mut ring, b"world");
        assert_eq!(ring.iter().copied().collect::<Vec<u8>>(), b"hello world");
        // A burst bigger than the cap keeps exactly the tail.
        push_ring(&mut ring, &vec![b'z'; RING_CAP + 10]);
        assert_eq!(ring.len(), RING_CAP);
        assert!(ring.iter().all(|&b| b == b'z'));
    }
}
