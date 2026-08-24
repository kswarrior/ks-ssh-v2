package store

import (
	"database/sql"
	"errors"
	"time"
)

// ---- bookmarks ----

func (s *Store) AddBookmark(hostID int64, path, label, kind string) (*Bookmark, error) {
	res, err := s.DB.Exec(`INSERT INTO bookmarks(host_id,path,label,kind) VALUES(?,?,?,?)
		ON CONFLICT(host_id,path) DO UPDATE SET label=excluded.label`, hostID, path, label, kind)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &Bookmark{ID: id, HostID: hostID, Path: path, Label: label, Kind: kind}, nil
}

func (s *Store) ListBookmarks(hostID int64) ([]*Bookmark, error) {
	rows, err := s.DB.Query(`SELECT id,host_id,path,label,kind FROM bookmarks WHERE host_id=? ORDER BY id DESC`, hostID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Bookmark
	for rows.Next() {
		b := &Bookmark{}
		if err := rows.Scan(&b.ID, &b.HostID, &b.Path, &b.Label, &b.Kind); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (s *Store) DeleteBookmark(id int64) error {
	_, err := s.DB.Exec(`DELETE FROM bookmarks WHERE id=?`, id)
	return err
}

func (s *Store) RenameBookmark(id int64, label string) error {
	_, err := s.DB.Exec(`UPDATE bookmarks SET label=? WHERE id=?`, label, id)
	return err
}

// ---- snippets ----

func (s *Store) CreateSnippet(name, command string, hostID *int64) (*Snippet, error) {
	res, err := s.DB.Exec(`INSERT INTO snippets(name,command,host_id) VALUES(?,?,?)`, name, command, hostID)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &Snippet{ID: id, Name: name, Command: command, HostID: hostID, CreatedAt: time.Now()}, nil
}

func (s *Store) ListSnippets() ([]*Snippet, error) {
	rows, err := s.DB.Query(`SELECT id,name,command,host_id,created_at FROM snippets ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Snippet
	for rows.Next() {
		sn := &Snippet{}
		var hid sql.NullInt64
		if err := rows.Scan(&sn.ID, &sn.Name, &sn.Command, &hid, &sn.CreatedAt); err != nil {
			return nil, err
		}
		if hid.Valid {
			v := hid.Int64
			sn.HostID = &v
		}
		out = append(out, sn)
	}
	return out, rows.Err()
}

func (s *Store) UpdateSnippet(id int64, name, command string, hostID *int64) error {
	_, err := s.DB.Exec(`UPDATE snippets SET name=?,command=?,host_id=? WHERE id=?`, name, command, hostID, id)
	return err
}

func (s *Store) DeleteSnippet(id int64) error {
	_, err := s.DB.Exec(`DELETE FROM snippets WHERE id=?`, id)
	return err
}

// ---- tunnels ----

func (s *Store) CreateTunnel(hostID int64, kind, localHost string, localPort int, remoteHost string, remotePort int, autoStart bool) (*Tunnel, error) {
	res, err := s.DB.Exec(`INSERT INTO tunnels(host_id,kind,local_host,local_port,remote_host,remote_port,auto_start) VALUES(?,?,?,?,?,?,?)`,
		hostID, kind, localHost, localPort, remoteHost, remotePort, autoStart)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &Tunnel{ID: id, HostID: hostID, Kind: kind, LocalHost: localHost, LocalPort: localPort,
		RemoteHost: remoteHost, RemotePort: remotePort, AutoStart: autoStart, CreatedAt: time.Now()}, nil
}

const tunnelCols = `id,host_id,kind,local_host,local_port,remote_host,remote_port,auto_start,created_at`

func scanTunnel(row interface{ Scan(...any) error }) (*Tunnel, error) {
	t := &Tunnel{}
	var created string
	err := row.Scan(&t.ID, &t.HostID, &t.Kind, &t.LocalHost, &t.LocalPort, &t.RemoteHost, &t.RemotePort, &t.AutoStart, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	t.CreatedAt, _ = time.Parse(time.RFC3339Nano, created)
	return t, nil
}

func (s *Store) GetTunnel(id int64) (*Tunnel, error) {
	return scanTunnel(s.DB.QueryRow(`SELECT `+tunnelCols+` FROM tunnels WHERE id=?`, id))
}

func (s *Store) ListTunnels() ([]*Tunnel, error) {
	rows, err := s.DB.Query(`SELECT ` + tunnelCols + ` FROM tunnels ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Tunnel
	for rows.Next() {
		t, err := scanTunnel(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) UpdateTunnel(id int64, kind, localHost string, localPort int, remoteHost string, remotePort int, autoStart bool) error {
	_, err := s.DB.Exec(`UPDATE tunnels SET kind=?,local_host=?,local_port=?,remote_host=?,remote_port=?,auto_start=? WHERE id=?`,
		kind, localHost, localPort, remoteHost, remotePort, autoStart, id)
	return err
}

func (s *Store) DeleteTunnel(id int64) error {
	_, err := s.DB.Exec(`DELETE FROM tunnels WHERE id=?`, id)
	return err
}

// ---- transfers (checkpoint persistence) ----

func (s *Store) UpsertTransfer(t *Transfer) error {
	_, err := s.DB.Exec(`INSERT INTO transfers(id,host_id,kind,path,name,size,transferred,status,checkpoint,updated_at)
		VALUES(?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		ON CONFLICT(id) DO UPDATE SET transferred=excluded.transferred,status=excluded.status,
		checkpoint=excluded.checkpoint,updated_at=excluded.updated_at`,
		t.ID, t.HostID, t.Kind, t.Path, t.Name, t.Size, t.Transferred, t.Status, t.Checkpoint)
	return err
}

func (s *Store) GetTransfer(id string) (*Transfer, error) {
	t := &Transfer{}
	var cp sql.NullString
	var upd string
	err := s.DB.QueryRow(`SELECT id,host_id,kind,path,name,size,transferred,status,checkpoint,updated_at FROM transfers WHERE id=?`, id).
		Scan(&t.ID, &t.HostID, &t.Kind, &t.Path, &t.Name, &t.Size, &t.Transferred, &t.Status, &cp, &upd)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if cp.Valid {
		t.Checkpoint = &cp.String
	}
	t.UpdatedAt, _ = time.Parse(time.RFC3339Nano, upd)
	return t, nil
}

func (s *Store) ListTransfers(hostID int64) ([]*Transfer, error) {
	rows, err := s.DB.Query(`SELECT id,host_id,kind,path,name,size,transferred,status,checkpoint,updated_at FROM transfers WHERE host_id=? ORDER BY updated_at DESC LIMIT 100`, hostID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Transfer
	for rows.Next() {
		t := &Transfer{}
		var cp sql.NullString
		var upd string
		if err := rows.Scan(&t.ID, &t.HostID, &t.Kind, &t.Path, &t.Name, &t.Size, &t.Transferred, &t.Status, &cp, &upd); err != nil {
			return nil, err
		}
		if cp.Valid {
			t.Checkpoint = &cp.String
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) DeleteTransfer(id string) error {
	_, err := s.DB.Exec(`DELETE FROM transfers WHERE id=?`, id)
	return err
}

// ---- sessions audit ----

func (s *Store) StartSession(token, username, hostName, kind string) (int64, error) {
	res, err := s.DB.Exec(`INSERT INTO sessions_audit(session_token,username,host_name,kind) VALUES(?,?,?,?)`,
		token, username, hostName, kind)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) EndSession(token string) error {
	_, err := s.DB.Exec(`UPDATE sessions_audit SET ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
		WHERE session_token=? AND ended_at IS NULL AND id=(SELECT MAX(id) FROM sessions_audit WHERE session_token=? AND ended_at IS NULL)`, token, token)
	return err
}

func (s *Store) ListSessions(limit int) ([]*SessionAudit, error) {
	rows, err := s.DB.Query(`SELECT id,session_token,username,host_name,kind,started_at,ended_at FROM sessions_audit ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*SessionAudit
	for rows.Next() {
		r := &SessionAudit{}
		var started, ended string
		var endN sql.NullString
		if err := rows.Scan(&r.ID, &r.SessionToken, &r.Username, &r.HostName, &r.Kind, &started, &endN); err != nil {
			return nil, err
		}
		r.StartedAt, _ = time.Parse(time.RFC3339Nano, started)
		if endN.Valid {
			e, _ := time.Parse(time.RFC3339Nano, endN.String)
			r.EndedAt = &e
		}
		_ = ended
		out = append(out, r)
	}
	return out, rows.Err()
}

// AuditEntry is one append-only record of a (destructive) action.
type AuditEntry struct {
	ID       int64
	Username string
	Action   string
	Target   string
	HostName string
	Result   string
	Detail   string
	At       time.Time
}

// AppendAudit writes an immutable audit entry. The table is append-only:
// no UPDATE/DELETE path exists anywhere in the codebase.
func (s *Store) AppendAudit(username, action, target, hostName, result, detail string) error {
	_, err := s.DB.Exec(`INSERT INTO audit_log(username,action,target,host_name,result,detail) VALUES(?,?,?,?,?,?)`,
		username, action, target, hostName, result, detail)
	return err
}

func (s *Store) ListAudit(limit int) ([]*AuditEntry, error) {
	rows, err := s.DB.Query(`SELECT id,username,action,target,host_name,result,detail,at FROM audit_log ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*AuditEntry
	for rows.Next() {
		a := &AuditEntry{}
		var at string
		if err := rows.Scan(&a.ID, &a.Username, &a.Action, &a.Target, &a.HostName, &a.Result, &a.Detail, &at); err != nil {
			return nil, err
		}
		a.At, _ = time.Parse(time.RFC3339Nano, at)
		out = append(out, a)
	}
	return out, rows.Err()
}

// ---- recordings ----

func (s *Store) AddRecording(sessionToken string, hostID int64, file string) (int64, error) {
	res, err := s.DB.Exec(`INSERT INTO recordings(session_token,host_id,file) VALUES(?,?,?)`, sessionToken, hostID, file)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) FinishRecording(id int64, durationSec, sizeBytes int64) error {
	_, err := s.DB.Exec(`UPDATE recordings SET duration_sec=?, size_bytes=? WHERE id=?`, durationSec, sizeBytes, id)
	return err
}

func (s *Store) ListRecordings() ([]*Recording, error) {
	rows, err := s.DB.Query(`SELECT id,session_token,host_id,file,started_at,duration_sec,size_bytes FROM recordings ORDER BY id DESC LIMIT 200`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Recording
	for rows.Next() {
		r := &Recording{}
		var started string
		if err := rows.Scan(&r.ID, &r.SessionToken, &r.HostID, &r.File, &started, &r.DurationSec, &r.SizeBytes); err != nil {
			return nil, err
		}
		r.StartedAt, _ = time.Parse(time.RFC3339Nano, started)
		out = append(out, r)
	}
	return out, rows.Err()
}

// ---- editor backups ----

func (s *Store) AddBackup(hostID int64, path string, content []byte) (int64, error) {
	res, err := s.DB.Exec(`INSERT INTO editor_backups(host_id,path,content) VALUES(?,?,?)`, hostID, path, content)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) ListBackups(hostID int64, path string) ([]*EditorBackup, error) {
	rows, err := s.DB.Query(`SELECT id,host_id,path,content,created_at FROM editor_backups WHERE host_id=? AND path=? ORDER BY id DESC`, hostID, path)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*EditorBackup
	for rows.Next() {
		b := &EditorBackup{}
		var created string
		if err := rows.Scan(&b.ID, &b.HostID, &b.Path, &b.Content, &created); err != nil {
			return nil, err
		}
		b.CreatedAt, _ = time.Parse(time.RFC3339Nano, created)
		out = append(out, b)
	}
	return out, rows.Err()
}

func (s *Store) PruneBackups(hostID int64, path string, keep int) error {
	if keep <= 0 {
		keep = 10
	}
	_, err := s.DB.Exec(`DELETE FROM editor_backups WHERE host_id=? AND path=? AND id NOT IN
		(SELECT id FROM editor_backups WHERE host_id=? AND path=? ORDER BY id DESC LIMIT ?)`,
		hostID, path, hostID, path, keep)
	return err
}

// ListBackupsByHost lists recent backups across all paths of a host.
func (s *Store) ListBackupsByHost(hostID int64) ([]*EditorBackup, error) {
	rows, err := s.DB.Query(`SELECT id,host_id,path,content,created_at FROM editor_backups WHERE host_id=? ORDER BY id DESC LIMIT 500`, hostID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*EditorBackup
	for rows.Next() {
		b := &EditorBackup{}
		var created string
		if err := rows.Scan(&b.ID, &b.HostID, &b.Path, &b.Content, &created); err != nil {
			return nil, err
		}
		b.CreatedAt, _ = time.Parse(time.RFC3339Nano, created)
		out = append(out, b)
	}
	return out, rows.Err()
}

// ---- app settings ----

func (s *Store) GetSetting(key string) (string, bool, error) {
	var v string
	err := s.DB.QueryRow(`SELECT value FROM app_settings WHERE key=?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return v, true, nil
}

func (s *Store) SetSetting(key, value string) error {
	_, err := s.DB.Exec(`INSERT INTO app_settings(key,value) VALUES(?,?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}

func (s *Store) AllSettings() (map[string]string, error) {
	rows, err := s.DB.Query(`SELECT key,value FROM app_settings`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}
