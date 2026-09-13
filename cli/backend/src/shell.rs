//! Local shell over WebSocket — sshx.io style, no token.
//!
//! `GET /v1/shell` upgrades to WebSocket. Each connection spawns its own
//! login shell (`$SHELL`, else `bash`, else `sh`) inside a real PTY so
//! prompts, colors, `clear`, `vim`, etc. behave like a real terminal.
//!
//! Protocol:
//! * client -> server: raw keystrokes. Only the exact JSON
//!   `{"type":"resize","cols":N,"rows":N}` is control traffic —
//!   everything else (even typed JSON) goes to the shell as input.
//! * server -> client: raw PTY output (UTF-8 lossy). `{"type":"exit"}`
//!   is sent once when the shell process exits.

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::io::Read;

pub async fn ws_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(handle_socket)
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
    cmd.env("KS_SSH", "1");
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            cmd.cwd(home);
        }
    }

    let child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(_) => {
            let mut plain = CommandBuilder::new(&shell);
            plain.env("TERM", "xterm-256color");
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
                .send(Message::Text(format!("ks-ssh: cannot spawn shell: {e}").into()))
                .await;
            return;
        }
    };
    // Shared so the session end always reaps the shell — a tab that is
    // closed must never leave an orphaned bash behind.
    let child = std::sync::Arc::new(std::sync::Mutex::new(Some(child)));

    // PTY reader runs on a blocking thread, pushes bytes through a
    // bounded channel. `blocking_send` applies backpressure into the PTY
    // so `cat` on a huge file slows the reader instead of OOMing us.
    let mut reader = match master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            let _ = ws_tx
                .send(Message::Text(format!("ks-ssh: cannot read pty: {e}").into()))
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

    // PTY writer lives behind a mutex so the WS loop can write from async.
    let writer = match master.take_writer() {
        Ok(w) => w,
        Err(e) => {
            let _ = ws_tx
                .send(Message::Text(format!("ks-ssh: cannot write pty: {e}").into()))
                .await;
            return;
        }
    };
    let writer = std::sync::Arc::new(tokio::sync::Mutex::new(writer));
    let writer_clone = writer.clone();

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
        loop {
            tokio::select! {
                chunk = out_rx.recv() => {
                    match chunk {
                        Some(bytes) => {
                            let text = String::from_utf8_lossy(&bytes).into_owned();
                            if ws_tx.send(Message::Text(text.into())).await.is_err() {
                                break;
                            }
                        }
                        // Reader hit EOF — the shell is gone. Tell the UI
                        // (the exit watcher is only a backup: EOF usually
                        // wins the race against its 200ms poll).
                        None => {
                            let _ = ws_tx
                                .send(Message::Text(r#"{"type":"exit"}"#.to_string().into()))
                                .await;
                            break;
                        }
                    }
                }
                _ = &mut exit_rx => {
                    let _ = ws_tx
                        .send(Message::Text(r#"{"type":"exit"}"#.to_string().into()))
                        .await;
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
                        let is_resize = v.get("type").and_then(|t| t.as_str())
                            == Some("resize")
                            && v.get("cols").and_then(|c| c.as_u64()).is_some()
                            && v.get("rows").and_then(|r| r.as_u64()).is_some();
                        if is_resize {
                            let cols =
                                v.get("cols").and_then(|c| c.as_u64()).unwrap_or(80) as u16;
                            let rows =
                                v.get("rows").and_then(|r| r.as_u64()).unwrap_or(24) as u16;
                            let _ = master.resize(PtySize {
                                rows: rows.max(2).min(300),
                                cols: cols.max(2).min(500),
                                pixel_width: 0,
                                pixel_height: 0,
                            });
                            continue;
                        }
                    }
                    let mut w = writer_clone.lock().await;
                    use std::io::Write as _;
                    let _ = w.write_all(s.as_bytes());
                    let _ = w.flush();
                }
                Message::Binary(bin) => {
                    let mut w = writer_clone.lock().await;
                    use std::io::Write as _;
                    let _ = w.write_all(&bin);
                    let _ = w.flush();
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
    if let Ok(mut guard) = child.lock() {
        if let Some(mut c) = guard.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}
