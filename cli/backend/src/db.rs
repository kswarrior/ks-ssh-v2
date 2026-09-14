//! Host-side SQLite persistence for terminal sessions (`--db`).
//!
//! Every shell session (live or exited) is mirrored into a `sessions` table:
//! id, timestamps, a dead flag, and the scrollback ring. On startup the rows
//! are loaded back as history placeholders, so any visitor can reattach and
//! read what happened — even after a backend restart. Live PTY processes
//! themselves cannot survive a restart (the OS child dies with us); only the
//! recorded output persists, and the tab shows `[shell exited]`.
//!
//! Writes are throttled: the PTY reader only flips a dirty flag, a background
//! task flushes dirty rings every few seconds, and exit/detach paths persist
//! immediately. A single global `Mutex<Connection>` is enough — every op is
//! one short statement.
//!
//! Case 9 (Identity & audit): this file also owns two append-only stores:
//! - `audit` — `(ts, actor, ip, action, target, result)` rows for logins,
//!   user CRUD, file writes, kills, shell attach/detach and playback.
//!   Read via `GET /api/audit` (admin only). Retention via
//!   `--audit-retain-days` (default 90, 0 = keep forever).
//! - `rec_frames` — timestamped PTY input/output frames per shell session
//!   for session recording/replay (`GET /api/terms/:id/recording`).
//!   Per-session cap via `--record-max-mb` (default 10).
//!
//! When `--db` is empty (persistence OFF) audit falls back to a bounded
//! in-memory ring so `cargo test` and `--db ""` runs still record audit
//! rows; recordings stay in memory only (see `crate::shell`).

use std::{
    path::Path,
    sync::{
        LazyLock, Mutex as StdMutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

/// How long a detached session's history stays visible (memory + DB).
/// Memory eviction still follows `shell::SESSION_TTL`-style idleness; rows
/// older than this are pruned at startup and by the reaper tick.
pub const PERSIST_TTL_SECS: u64 = 7 * 24 * 60 * 60;
/// Upper bound on stored sessions; oldest rows past it are dropped.
pub const MAX_PERSISTED: usize = 200;

/// Audit retention in days (`--audit-retain-days`, default 90, 0 = forever).
static AUDIT_RETAIN_DAYS: AtomicU64 = AtomicU64::new(90);
/// Per-session recording cap in MB (`--record-max-mb`, default 10).
static RECORD_MAX_MB: AtomicU64 = AtomicU64::new(10);
/// In-memory audit fallback when `--db` is off (bounded ring).
static MEM_AUDIT: LazyLock<StdMutex<Vec<AuditRow>>> =
    LazyLock::new(|| StdMutex::new(Vec::new()));
static MEM_AUDIT_ID: AtomicU64 = AtomicU64::new(1);
const MEM_AUDIT_CAP: usize = 2000;

static DB: LazyLock<StdMutex<Option<rusqlite::Connection>>> =
    LazyLock::new(|| StdMutex::new(None));

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `--audit-retain-days` (0 = keep forever).
pub fn set_audit_retain_days(days: u64) {
    AUDIT_RETAIN_DAYS.store(days, Ordering::SeqCst);
}
pub fn audit_retain_days() -> u64 {
    AUDIT_RETAIN_DAYS.load(Ordering::SeqCst)
}
/// `--record-max-mb` per session.
pub fn set_record_max_mb(mb: u64) {
    RECORD_MAX_MB.store(mb.max(1), Ordering::SeqCst);
}
pub fn record_max_bytes() -> u64 {
    RECORD_MAX_MB.load(Ordering::SeqCst).max(1) * 1024 * 1024
}

#[derive(Debug, Clone)]
pub struct PersistedSession {
    pub id: String,
    pub created_at: u64,
    pub dead: bool,
    pub scrollback: Vec<u8>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AuditRow {
    pub id: i64,
    pub ts: i64,
    pub actor: String,
    pub ip: String,
    pub action: String,
    pub target: String,
    pub result: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RecFrame {
    pub seq: i64,
    pub ts_ms: i64,
    /// "in" (keystrokes) or "out" (PTY output).
    pub kind: String,
    /// Raw bytes (base64url on the wire).
    #[serde(skip)]
    pub data: Vec<u8>,
}

fn with_db<T>(f: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>) -> Option<T> {
    let guard = DB.lock().ok()?;
    let conn = guard.as_ref()?;
    match f(conn) {
        Ok(v) => Some(v),
        Err(e) => {
            eprintln!("ks-ssh db error: {e:#}");
            None
        }
    }
}

/// Open (creating parents as needed) and migrate. `None` path disables
/// persistence silently — used only when `--db` handling is skipped.
pub fn init(path: Option<&Path>) -> usize {
    let Some(path) = path else { return 0 };
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
        && let Err(e) = std::fs::create_dir_all(parent)
    {
        eprintln!(
            "ks-ssh db: cannot create dir {}: {e:#} — persistence OFF",
            parent.display()
        );
        return 0;
    }
    let conn = match rusqlite::Connection::open(path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "ks-ssh db: cannot open {}: {e:#} — persistence OFF",
                path.display()
            );
            return 0;
        }
    };
    if let Err(e) = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sessions (
           id          TEXT PRIMARY KEY,
           created_at  INTEGER NOT NULL,
           last_active INTEGER NOT NULL,
           dead        INTEGER NOT NULL DEFAULT 0,
           scrollback  BLOB NOT NULL DEFAULT x''
         );
         CREATE INDEX IF NOT EXISTS idx_sessions_last_active
           ON sessions(last_active);
         CREATE TABLE IF NOT EXISTS audit (
           id     INTEGER PRIMARY KEY AUTOINCREMENT,
           ts     INTEGER NOT NULL,
           actor  TEXT NOT NULL,
           ip     TEXT NOT NULL DEFAULT '',
           action TEXT NOT NULL,
           target TEXT NOT NULL DEFAULT '',
           result TEXT NOT NULL DEFAULT ''
         );
         CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
         CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit(actor);
         CREATE TABLE IF NOT EXISTS rec_frames (
           session_id TEXT NOT NULL,
           seq        INTEGER NOT NULL,
           ts_ms      INTEGER NOT NULL,
           kind       TEXT NOT NULL,
           data       BLOB NOT NULL,
           PRIMARY KEY (session_id, seq)
         );
         CREATE INDEX IF NOT EXISTS idx_rec_session ON rec_frames(session_id, seq);",
    ) {
        eprintln!("ks-ssh db: cannot migrate {}: {e:#} — persistence OFF", path.display());
        return 0;
    }
    // Drop ancient history and enforce the row cap.
    let cutoff = now_secs().saturating_sub(PERSIST_TTL_SECS) as i64;
    let _ = conn.execute("DELETE FROM sessions WHERE last_active < ?1", [cutoff]);
    let _ = conn.execute(
        "DELETE FROM sessions WHERE id NOT IN
           (SELECT id FROM sessions ORDER BY last_active DESC LIMIT ?1)",
        [MAX_PERSISTED as i64],
    );
    prune_audit_inner(&conn);
    let loaded: usize = conn
        .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
        .unwrap_or(0);
    if let Ok(mut slot) = DB.lock() {
        *slot = Some(conn);
    }
    loaded
}

pub fn enabled() -> bool {
    DB.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// Insert or refresh a session row (keeps the original `created_at`).
pub fn upsert(id: &str, created_at: u64, last_active: u64, dead: bool, scrollback: &[u8]) {
    with_db(|conn| {
        conn.execute(
            "INSERT INTO sessions (id, created_at, last_active, dead, scrollback)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
               last_active = excluded.last_active,
               dead = excluded.dead,
               scrollback = excluded.scrollback",
            rusqlite::params![
                id,
                created_at as i64,
                last_active as i64,
                dead as i32,
                scrollback
            ],
        )
    });
}

pub fn mark_dead(id: &str, last_active: u64) {
    with_db(|conn| {
        conn.execute(
            "UPDATE sessions SET dead = 1, last_active = ?1 WHERE id = ?2",
            rusqlite::params![last_active as i64, id],
        )
    });
}

pub fn delete(id: &str) {
    with_db(|conn| conn.execute("DELETE FROM sessions WHERE id = ?1", [id]));
    // Recording frames die with the session.
    with_db(|conn| conn.execute("DELETE FROM rec_frames WHERE session_id = ?1", [id]));
}

/// Delete rows idle past the history TTL. Returns rows removed.
pub fn prune_expired() -> usize {
    let cutoff = now_secs().saturating_sub(PERSIST_TTL_SECS) as i64;
    // Collect expired session ids first so their recordings go too.
    let expired: Vec<String> = with_db(|conn| {
        let mut stmt = conn.prepare("SELECT id FROM sessions WHERE last_active < ?1")?;
        let rows = stmt.query_map([cutoff], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<Vec<String>>>()
    })
    .unwrap_or_default();
    for id in &expired {
        with_db(|conn| conn.execute("DELETE FROM rec_frames WHERE session_id = ?1", [id]));
    }
    let n = with_db(|conn| conn.execute("DELETE FROM sessions WHERE last_active < ?1", [cutoff]))
        .unwrap_or(0);
    with_db(|conn| {
        prune_audit_inner(conn);
        Ok::<_, rusqlite::Error>(())
    });
    n
}

pub fn load_all() -> Vec<PersistedSession> {
    with_db(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, created_at, dead, scrollback
             FROM sessions ORDER BY last_active DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([MAX_PERSISTED as i64], |r| {
            Ok(PersistedSession {
                id: r.get(0)?,
                created_at: r.get::<_, i64>(1)? as u64,
                dead: r.get::<_, i32>(2)? != 0,
                scrollback: r.get(3)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })
    .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Audit log (append-only; never UPDATE/DELETE except retention pruning).
// ---------------------------------------------------------------------------

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        // Cut on a char boundary.
        let mut end = max;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        s[..end].to_string()
    }
}

fn prune_audit_inner(conn: &rusqlite::Connection) {
    let days = AUDIT_RETAIN_DAYS.load(Ordering::SeqCst);
    if days == 0 {
        return;
    }
    let cutoff = now_secs().saturating_sub(days * 24 * 60 * 60) as i64;
    let _ = conn.execute("DELETE FROM audit WHERE ts < ?1", [cutoff]);
}

/// Append one audit row. Never logs secrets — callers must pass `target`
/// values with tokens/keys/PINs already redacted.
pub fn audit(actor: &str, ip: &str, action: &str, target: &str, result: &str) {
    let actor = truncate(actor.trim(), 64);
    let actor = if actor.is_empty() { "-".to_string() } else { actor };
    let ip = truncate(ip.trim(), 64);
    let action = truncate(action.trim(), 64);
    let target = truncate(target.trim(), 512);
    let result = truncate(result.trim(), 32);
    let ts = now_secs() as i64;
    if enabled() {
        with_db(|conn| {
            conn.execute(
                "INSERT INTO audit (ts, actor, ip, action, target, result)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![ts, actor, ip, action, target, result],
            )
        });
        with_db(|conn| {
            prune_audit_inner(conn);
            Ok::<_, rusqlite::Error>(())
        });
    } else {
        // In-memory ring (tests + `--db ""` runs).
        if let Ok(mut g) = MEM_AUDIT.lock() {
            let id = MEM_AUDIT_ID.fetch_add(1, Ordering::SeqCst) as i64;
            g.push(AuditRow {
                id,
                ts,
                actor,
                ip,
                action,
                target,
                result,
            });
            while g.len() > MEM_AUDIT_CAP {
                g.remove(0);
            }
        }
    }
}

/// Newest-first list, `since` filters by row id (`?since=` cursor).
/// `limit` clamped to 1..1000.
pub fn audit_list(limit: usize, since: i64) -> Vec<AuditRow> {
    let limit = limit.clamp(1, 1000) as i64;
    if enabled() {
        with_db(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, ts, actor, ip, action, target, result
                 FROM audit WHERE id > ?1 ORDER BY id DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map(rusqlite::params![since, limit], |r| {
                Ok(AuditRow {
                    id: r.get(0)?,
                    ts: r.get(1)?,
                    actor: r.get(2)?,
                    ip: r.get(3)?,
                    action: r.get(4)?,
                    target: r.get(5)?,
                    result: r.get(6)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap_or_default()
    } else if let Ok(g) = MEM_AUDIT.lock() {
        let mut out: Vec<AuditRow> = g.iter().filter(|r| r.id > since).cloned().collect();
        out.sort_by_key(|r| std::cmp::Reverse(r.id));
        out.truncate(limit as usize);
        out
    } else {
        Vec::new()
    }
}

/// Test helper: wipe audit rows (both SQLite and in-memory).
pub fn audit_clear_for_tests() {
    with_db(|conn| conn.execute("DELETE FROM audit", []));
    if let Ok(mut g) = MEM_AUDIT.lock() {
        g.clear();
    }
}

// ---------------------------------------------------------------------------
// Session recordings (timestamped PTY frames).
// ---------------------------------------------------------------------------

/// Append one frame; enforces the per-session `--record-max-mb` cap by
/// dropping the oldest frames first. `kind` is "in" or "out".
pub fn rec_append(session_id: &str, ts_ms: i64, kind: &str, data: &[u8]) {
    if !enabled() || session_id.is_empty() || data.is_empty() {
        return;
    }
    let kind = if kind == "in" { "in" } else { "out" };
    let next: i64 = with_db(|conn| {
        conn.query_row(
            "SELECT COALESCE(MAX(seq), -1) + 1 FROM rec_frames WHERE session_id = ?1",
            [session_id],
            |r| r.get(0),
        )
    })
    .unwrap_or(0);
    with_db(|conn| {
        conn.execute(
            "INSERT INTO rec_frames (session_id, seq, ts_ms, kind, data)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![session_id, next, ts_ms, kind, data],
        )
    });
    // Enforce cap.
    let cap = record_max_bytes();
    let total: u64 = with_db(|conn| {
        conn.query_row(
            "SELECT COALESCE(SUM(LENGTH(data)), 0) FROM rec_frames WHERE session_id = ?1",
            [session_id],
            |r| r.get(0),
        )
    })
    .unwrap_or(0);
    if total > cap {
        // Delete oldest frames until under cap (bounded loop).
        let mut over = total.saturating_sub(cap);
        for _ in 0..1024 {
            if over == 0 {
                break;
            }
            let oldest: Option<(i64, i64)> = with_db(|conn| {
                conn.query_row(
                    "SELECT seq, LENGTH(data) FROM rec_frames
                     WHERE session_id = ?1 ORDER BY seq ASC LIMIT 1",
                    [session_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            });
            match oldest {
                Some((seq, sz)) => {
                    with_db(|conn| {
                        conn.execute(
                            "DELETE FROM rec_frames WHERE session_id = ?1 AND seq = ?2",
                            rusqlite::params![session_id, seq],
                        )
                    });
                    over = over.saturating_sub(sz as u64);
                }
                None => break,
            }
        }
    }
}

/// Range read for playback: frames with `seq >= from_seq`, oldest first.
pub fn rec_list(session_id: &str, from_seq: i64, limit: usize) -> Vec<RecFrame> {
    let limit = limit.clamp(1, 5000) as i64;
    with_db(|conn| {
        let mut stmt = conn.prepare(
            "SELECT seq, ts_ms, kind, data FROM rec_frames
             WHERE session_id = ?1 AND seq >= ?2 ORDER BY seq ASC LIMIT ?3",
        )?;
        let rows = stmt.query_map(rusqlite::params![session_id, from_seq, limit], |r| {
            Ok(RecFrame {
                seq: r.get(0)?,
                ts_ms: r.get(1)?,
                kind: r.get(2)?,
                data: r.get(3)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })
    .unwrap_or_default()
}

pub fn rec_delete(session_id: &str) {
    with_db(|conn| conn.execute("DELETE FROM rec_frames WHERE session_id = ?1", [session_id]));
}

pub fn rec_session_bytes(session_id: &str) -> u64 {
    with_db(|conn| {
        conn.query_row(
            "SELECT COALESCE(SUM(LENGTH(data)), 0) FROM rec_frames WHERE session_id = ?1",
            [session_id],
            |r| r.get(0),
        )
    })
    .unwrap_or(0)
}

pub fn rec_frame_count(session_id: &str) -> usize {
    with_db(|conn| {
        conn.query_row(
            "SELECT COUNT(*) FROM rec_frames WHERE session_id = ?1",
            [session_id],
            |r| r.get(0),
        )
    })
    .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "ks-ssh-db-test-{}-{tag}.db",
            std::process::id()
        ))
    }

    #[test]
    fn db_roundtrip() {
        let path = temp_path("roundtrip");
        let _ = std::fs::remove_file(&path);
        // NOTE: uses its own connection — the global is process-wide.
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
             last_active INTEGER NOT NULL, dead INTEGER NOT NULL DEFAULT 0,
             scrollback BLOB NOT NULL DEFAULT x'');",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions (id, created_at, last_active, dead, scrollback)
             VALUES ('abc', 1, 2, 0, x'6869')",
            [],
        )
        .unwrap();
        let (dead, blob): (i32, Vec<u8>) = conn
            .query_row("SELECT dead, scrollback FROM sessions WHERE id = 'abc'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(dead, 0);
        assert_eq!(blob, b"hi");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn audit_write_and_list() {
        // Uses the in-memory ring when no DB is open OR the global DB when
        // another test opened it — either way our unique actor must roundtrip.
        let tag = format!("audit-test-{}-{}", std::process::id(), now_ms());
        audit(&tag, "127.0.0.1", "login", &tag, "ok");
        let rows = audit_list(1000, 0);
        assert!(
            rows.iter().any(|r| r.actor == tag && r.action == "login"),
            "audit row for {tag} must be listed"
        );
    }

    #[test]
    fn recording_roundtrip_via_mem_struct() {
        // Pure struct roundtrip (no global DB): frames keep order + kinds.
        let frames = vec![
            RecFrame { seq: 0, ts_ms: 1000, kind: "out".into(), data: b"hello ".to_vec() },
            RecFrame { seq: 1, ts_ms: 1010, kind: "in".into(), data: b"ls\n".to_vec() },
            RecFrame { seq: 2, ts_ms: 1020, kind: "out".into(), data: b"world".to_vec() },
        ];
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0].kind, "out");
        assert_eq!(frames[1].data, b"ls\n");
        // Reassembly keeps input+output order by seq.
        let mut ordered = frames.clone();
        ordered.sort_by_key(|f| f.seq);
        let seqs: Vec<i64> = ordered.iter().map(|f| f.seq).collect();
        assert_eq!(seqs, vec![0, 1, 2]);
    }
}
