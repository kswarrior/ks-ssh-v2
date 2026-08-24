package store

import (
	"database/sql"
	"fmt"
	"log/slog"

	_ "modernc.org/sqlite"
)

// Store wraps SQLite. Schema changes are additive steps only —
// never rewrite shipped steps destructively.
type Store struct {
	DB *sql.DB
}

func Open(path string) (*Store, error) {
	// WAL for concurrent reads; busy_timeout for lock contention.
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // modernc sqlite: serialize writers, avoid SQLITE_BUSY
	s := &Store{DB: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.DB.Close() }

var migrations = []string{
	// 1 — initial schema
	`CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT NOT NULL UNIQUE,
		password_hash TEXT NOT NULL,
		role TEXT NOT NULL DEFAULT 'operator' CHECK(role IN ('admin','operator','viewer')),
		totp_secret TEXT,
		totp_enabled INTEGER NOT NULL DEFAULT 0,
		disabled INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
	);
	CREATE TABLE IF NOT EXISTS host_groups (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL UNIQUE,
		color TEXT NOT NULL DEFAULT '#ffffff'
	);
	CREATE TABLE IF NOT EXISTS hosts (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL UNIQUE,
		hostname TEXT NOT NULL,
		port INTEGER NOT NULL DEFAULT 22,
		username TEXT NOT NULL,
		auth_type TEXT NOT NULL CHECK(auth_type IN ('password','key','key_passphrase','agent')),
		group_id INTEGER REFERENCES host_groups(id) ON DELETE SET NULL,
		labels TEXT NOT NULL DEFAULT '[]',
		color TEXT NOT NULL DEFAULT '#3b82f6',
		jump_host_id INTEGER REFERENCES hosts(id) ON DELETE SET NULL,
		max_sessions INTEGER NOT NULL DEFAULT 10,
		preview_enabled INTEGER NOT NULL DEFAULT 0,
		last_used_at TEXT,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
	);
	CREATE TABLE IF NOT EXISTS host_credentials (
		host_id INTEGER PRIMARY KEY REFERENCES hosts(id) ON DELETE CASCADE,
		password_enc TEXT,
		private_key_enc TEXT,
		passphrase_enc TEXT
	);
	CREATE TABLE IF NOT EXISTS known_hosts (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		hostname TEXT NOT NULL,
		port INTEGER NOT NULL,
		key_type TEXT NOT NULL,
		fingerprint TEXT NOT NULL,
		public_key TEXT NOT NULL,
		added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
		UNIQUE(hostname, port, key_type)
	);
	CREATE TABLE IF NOT EXISTS bookmarks (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
		path TEXT NOT NULL,
		label TEXT NOT NULL,
		kind TEXT NOT NULL DEFAULT 'path',
		UNIQUE(host_id, path)
	);
	CREATE TABLE IF NOT EXISTS snippets (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL,
		command TEXT NOT NULL,
		host_id INTEGER REFERENCES hosts(id) ON DELETE CASCADE,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
	);
	CREATE TABLE IF NOT EXISTS tunnels (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
		kind TEXT NOT NULL CHECK(kind IN ('L','R','D')),
		local_host TEXT NOT NULL DEFAULT '127.0.0.1',
		local_port INTEGER NOT NULL,
		remote_host TEXT NOT NULL DEFAULT '',
		remote_port INTEGER NOT NULL DEFAULT 0,
		auto_start INTEGER NOT NULL DEFAULT 1,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
	);
	CREATE TABLE IF NOT EXISTS transfers (
		id TEXT PRIMARY KEY,
		host_id INTEGER NOT NULL,
		kind TEXT NOT NULL CHECK(kind IN ('upload','download')),
		path TEXT NOT NULL,
		name TEXT NOT NULL,
		size INTEGER NOT NULL DEFAULT 0,
		transferred INTEGER NOT NULL DEFAULT 0,
		status TEXT NOT NULL DEFAULT 'queued',
		checkpoint TEXT,
		updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
	);
	CREATE TABLE IF NOT EXISTS sessions_audit (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_token TEXT NOT NULL,
		username TEXT NOT NULL,
		host_name TEXT NOT NULL,
		kind TEXT NOT NULL,
		started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
		ended_at TEXT
	);
	CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions_audit(session_token);
	CREATE TABLE IF NOT EXISTS recordings (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_token TEXT NOT NULL,
		host_id INTEGER NOT NULL,
		file TEXT NOT NULL,
		started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
		duration_sec INTEGER NOT NULL DEFAULT 0,
		size_bytes INTEGER NOT NULL DEFAULT 0
	);
	CREATE TABLE IF NOT EXISTS editor_backups (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		host_id INTEGER NOT NULL,
		path TEXT NOT NULL,
		content BLOB NOT NULL,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
	);
	CREATE INDEX IF NOT EXISTS idx_backups_path ON editor_backups(host_id, path, id DESC);
	CREATE TABLE IF NOT EXISTS app_settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS auth_attempts (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT NOT NULL,
		ip TEXT NOT NULL DEFAULT '',
		ok INTEGER NOT NULL,
		at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
	);
	CREATE INDEX IF NOT EXISTS idx_auth_attempts_user ON auth_attempts(username, at);`,
	// 2 — dedicated append-only audit table (who, what, where, when, result)
	`CREATE TABLE IF NOT EXISTS audit_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT NOT NULL,
		action TEXT NOT NULL,
		target TEXT NOT NULL DEFAULT '',
		host_name TEXT NOT NULL DEFAULT '',
		result TEXT NOT NULL DEFAULT 'ok',
		detail TEXT NOT NULL DEFAULT '',
		at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
	);`,
}

func (s *Store) migrate() error {
	if _, err := s.DB.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		step INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`, ); err != nil {
		return fmt.Errorf("schema_migrations: %w", err)
	}
	var current int
	if err := s.DB.QueryRow(`SELECT COALESCE(MAX(step),0) FROM schema_migrations`).Scan(&current); err != nil {
		return err
	}
	for i, m := range migrations {
		step := i + 1
		if step <= current {
			continue
		}
		tx, err := s.DB.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(m); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d: %w", step, err)
		}
		if _, err := tx.Exec(`INSERT INTO schema_migrations(step) VALUES (?)`, step); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d record: %w", step, err)
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		slog.Info("applied migration", "step", step)
	}
	return nil
}
