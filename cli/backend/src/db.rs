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

use std::{
    path::Path,
    sync::{LazyLock, Mutex as StdMutex},
    time::{SystemTime, UNIX_EPOCH},
};

/// How long a detached session's history stays visible (memory + DB).
/// Memory eviction still follows `shell::SESSION_TTL`-style idleness; rows
/// older than this are pruned at startup and by the reaper tick.
pub const PERSIST_TTL_SECS: u64 = 7 * 24 * 60 * 60;
/// Upper bound on stored sessions; oldest rows past it are dropped.
pub const MAX_PERSISTED: usize = 200;

static DB: LazyLock<StdMutex<Option<rusqlite::Connection>>> =
    LazyLock::new(|| StdMutex::new(None));

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[derive(Debug, Clone)]
pub struct PersistedSession {
    pub id: String,
    pub created_at: u64,
    pub dead: bool,
    pub scrollback: Vec<u8>,
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
           ON sessions(last_active);",
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
}

/// Delete rows idle past the history TTL. Returns rows removed.
pub fn prune_expired() -> usize {
    let cutoff = now_secs().saturating_sub(PERSIST_TTL_SECS) as i64;
    with_db(|conn| conn.execute("DELETE FROM sessions WHERE last_active < ?1", [cutoff]))
        .unwrap_or(0)
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
}
