//! Local shell over WebSocket — sshx.io style, no token.
//!
//! `GET /v1/shell?id=<session>` upgrades to WebSocket. Sessions outlive
//! the socket: closing the page (or refreshing) detaches, and reconnecting
//! with the same id reattaches to the still-running shell, replaying the
//! scrollback ring first. Detached sessions are reaped after a TTL.
//!
//! Protocol:
//! * client -> server: raw keystrokes (`onData` from xterm.js). Only the
//!   exact JSON `{"type":"resize","cols":N,"rows":N}` is control traffic —
//!   everything else (even typed JSON) goes to the shell as input.
//! * server -> client: `{"type":"ready","id":...}` (Text) first, then raw
//!   PTY bytes (Binary frames) for xterm.js, plus the exact Text
//!   `{"type":"exit"}` once when the shell exits (followed by Close).
//!   A superseded socket gets Close code 4000 ("attached elsewhere").

use axum::{
    extract::{
        Query,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    response::IntoResponse,
};
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

#[derive(Deserialize)]
struct ShellQuery {
    id: Option<String>,
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
fn push_ring(ring: &mut VecDeque<u8>, bytes: &[u8]) {
    ring.extend(bytes.iter());
    let overflow = ring.len().saturating_sub(RING_CAP);
    if overflow > 0 {
        ring.drain(..overflow);
    }
}

enum Out {
    Data(Vec<u8>),
    Eof,
    Takeover,
}

struct Session {
    id: String,
    master: StdMutex<Box<dyn portable_pty::MasterPty + Send>>,
    child: StdMutex<Option<Box<dyn portable_pty::Child + Send + Sync>>>,
    /// Input path to the PTY writer thread (lives as long as the session).
    writer_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    /// Current subscriber (None while detached).
    sub: StdMutex<Option<tokio::sync::mpsc::Sender<Out>>>,
    ring: StdMutex<VecDeque<u8>>,
    dead: AtomicBool,
    /// Bumped on every attach; lets stale sockets notice a takeover.
    gen: AtomicU64,
    last_active: StdMutex<Instant>,
}

static SESSIONS: LazyLock<tokio::sync::Mutex<HashMap<String, Arc<Session>>>> =
    LazyLock::new(|| tokio::sync::Mutex::new(HashMap::new()));

pub async fn ws_handler(ws: WebSocketUpgrade, Query(q): Query<ShellQuery>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, q.id))
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

async fn handle_socket(socket: WebSocket) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    let (master, child) = match spawn_shell(80, 24) {
        Ok(v) => v,
        Err(e) => {
            let _ = ws_tx
                .send(Message::Text(
                    format!("ks-ssh: cannot spawn shell: {e}").into(),
                ))
                .await;
            return;
        }
    };
    // Shared so the session end always reaps the shell — a tab that is
    // closed must never leave an orphaned bash behind.
    let child = std::sync::Arc::new(std::sync::Mutex::new(Some(child)));

    // PTY reader runs on a blocking thread, pushes raw bytes through a
    // bounded channel. `blocking_send` applies backpressure into the PTY
    // so `cat` on a huge file slows the reader instead of OOMing us.
    // Bytes go over the socket untouched (Binary frames) — the xterm.js
    // frontend decodes UTF-8/ANSI itself, so split multi-byte runes and
    // escape sequences always survive chunk boundaries.
    let mut reader = match master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            let _ = ws_tx
                .send(Message::Text(
                    format!("ks-ssh: cannot read pty: {e}").into(),
                ))
                .await;
            return;
        }
    };
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if out_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // PTY writer lives on its own blocking thread so big pastes never
    // stall the tokio executor. The WS loop just queues bytes.
    let writer = match master.take_writer() {
        Ok(w) => w,
        Err(e) => {
            let _ = ws_tx
                .send(Message::Text(
                    format!("ks-ssh: cannot write pty: {e}").into(),
                ))
                .await;
            return;
        }
    };
    let (in_tx, in_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(128);
    std::thread::spawn(move || {
        let mut w = writer;
        let mut rx = in_rx;
        use std::io::Write as _;
        while let Some(data) = rx.blocking_recv() {
            let _ = w.write_all(&data);
            let _ = w.flush();
        }
    });

    // Watch child exit (polled — lets the session end kill the shell
    // through the same handle instead of leaking it).
    let child_watch = child.clone();
    let (exit_tx, mut exit_rx) = tokio::sync::oneshot::channel::<()>();
    std::thread::spawn(move || {
        loop {
            let exited = child_watch
                .lock()
                .map(|mut guard| match guard.as_mut() {
                    Some(c) => matches!(c.try_wait(), Ok(Some(_))),
                    None => true,
                })
                .unwrap_or(true);
            if exited {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        let _ = exit_tx.send(());
    });

    // PTY -> WebSocket.
    let mut send_task = tokio::spawn(async move {
        // Helper: announce exit then close so the UI can distinguish a
        // real exit (JSON + close) from shell output that merely looks
        // like JSON (e.g. `echo '{"type":"exit"}'` keeps the socket open).
        let send_exit = async |ws_tx: &mut futures_util::stream::SplitSink<WebSocket, Message>| {
            let _ = ws_tx
                .send(Message::Text(r#"{"type":"exit"}"#.to_string().into()))
                .await;
            let _ = ws_tx.send(Message::Close(None)).await;
        };
        loop {
            tokio::select! {
                chunk = out_rx.recv() => {
                    match chunk {
                        Some(bytes) => {
                            if ws_tx.send(Message::Binary(bytes.into())).await.is_err() {
                                break;
                            }
                        }
                        // Reader hit EOF — the shell is gone. Tell the UI
                        // (the exit watcher is only a backup: EOF usually
                        // wins the race against its 200ms poll).
                        None => {
                            send_exit(&mut ws_tx).await;
                            break;
                        }
                    }
                }
                _ = &mut exit_rx => {
                    send_exit(&mut ws_tx).await;
                    break;
                }
            }
        }
    });

    // WebSocket -> PTY.
    let mut recv_task = tokio::spawn(async move {
        while let Some(msg) = ws_rx.next().await {
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
                            let _ = master.resize(PtySize {
                                rows: rows.clamp(2, 300),
                                cols: cols.clamp(2, 500),
                                pixel_width: 0,
                                pixel_height: 0,
                            });
                            continue;
                        }
                    }
                    // Queue for the blocking writer thread (backpressure ok).
                    if in_tx.send(s.as_bytes().to_vec()).await.is_err() {
                        break;
                    }
                }
                Message::Binary(bin) => {
                    if in_tx.send(bin.to_vec()).await.is_err() {
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
    // Session over — reap the shell so a closed tab never leaks a process.
    if let Ok(mut guard) = child.lock()
        && let Some(mut c) = guard.take()
    {
        let _ = c.kill();
        let _ = c.wait();
    }
}
