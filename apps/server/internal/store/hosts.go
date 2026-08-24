package store

import (
	"database/sql"
	"errors"
	"time"
)

const hostCols = `id,name,hostname,port,username,auth_type,group_id,labels,color,jump_host_id,max_sessions,preview_enabled,last_used_at,created_at`

func scanHost(row interface{ Scan(...any) error }) (*Host, error) {
	h := &Host{}
	var groupID, jumpID sql.NullInt64
	var lastUsed sql.NullString
	var created string
	err := row.Scan(&h.ID, &h.Name, &h.Hostname, &h.Port, &h.Username, &h.AuthType,
		&groupID, &h.Labels, &h.Color, &jumpID, &h.MaxSessions, &h.PreviewEnabled, &lastUsed, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if groupID.Valid {
		v := groupID.Int64
		h.GroupID = &v
	}
	if jumpID.Valid {
		v := jumpID.Int64
		h.JumpHostID = &v
	}
	if lastUsed.Valid {
		t, _ := time.Parse(time.RFC3339Nano, lastUsed.String)
		h.LastUsedAt = &t
	}
	h.CreatedAt, _ = time.Parse(time.RFC3339Nano, created)
	return h, nil
}

type HostInput struct {
	Name          string
	Hostname      string
	Port          int
	Username      string
	AuthType      string
	GroupID       *int64
	Labels        string
	Color         string
	JumpHostID    *int64
	MaxSessions   int
	PreviewEnabled bool
}

func (s *Store) CreateHost(in HostInput) (*Host, error) {
	res, err := s.DB.Exec(`INSERT INTO hosts(name,hostname,port,username,auth_type,group_id,labels,color,jump_host_id,max_sessions,preview_enabled)
		VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
		in.Name, in.Hostname, in.Port, in.Username, in.AuthType, in.GroupID, in.Labels, in.Color, in.JumpHostID, in.MaxSessions, in.PreviewEnabled)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.GetHost(id)
}

func (s *Store) UpdateHost(id int64, in HostInput) (*Host, error) {
	_, err := s.DB.Exec(`UPDATE hosts SET name=?,hostname=?,port=?,username=?,auth_type=?,group_id=?,labels=?,color=?,jump_host_id=?,max_sessions=?,preview_enabled=? WHERE id=?`,
		in.Name, in.Hostname, in.Port, in.Username, in.AuthType, in.GroupID, in.Labels, in.Color, in.JumpHostID, in.MaxSessions, in.PreviewEnabled, id)
	if err != nil {
		return nil, err
	}
	return s.GetHost(id)
}

func (s *Store) GetHost(id int64) (*Host, error) {
	return scanHost(s.DB.QueryRow(`SELECT `+hostCols+` FROM hosts WHERE id=?`, id))
}

func (s *Store) ListHosts() ([]*Host, error) {
	rows, err := s.DB.Query(`SELECT ` + hostCols + ` FROM hosts ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Host
	for rows.Next() {
		h, err := scanHost(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

func (s *Store) DeleteHost(id int64) error {
	_, err := s.DB.Exec(`DELETE FROM hosts WHERE id=?`, id)
	return err
}

func (s *Store) TouchHost(id int64) error {
	_, err := s.DB.Exec(`UPDATE hosts SET last_used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`, id)
	return err
}

// ---- credentials ----

func (s *Store) SetCredential(hostID int64, passwordEnc, keyEnc, passphraseEnc *string) error {
	_, err := s.DB.Exec(`INSERT INTO host_credentials(host_id,password_enc,private_key_enc,passphrase_enc)
		VALUES(?,?,?,?) ON CONFLICT(host_id) DO UPDATE SET password_enc=excluded.password_enc,
		private_key_enc=excluded.private_key_enc, passphrase_enc=excluded.passphrase_enc`,
		hostID, passwordEnc, keyEnc, passphraseEnc)
	return err
}

func (s *Store) GetCredential(hostID int64) (*HostCredential, error) {
	c := &HostCredential{HostID: hostID}
	err := s.DB.QueryRow(`SELECT host_id,password_enc,private_key_enc,passphrase_enc FROM host_credentials WHERE host_id=?`, hostID).
		Scan(&c.HostID, &c.PasswordEnc, &c.PrivateKeyEnc, &c.PassphraseEnc)
	if errors.Is(err, sql.ErrNoRows) {
		return c, nil // no credentials stored yet
	}
	return c, err
}

func (s *Store) ClearCredential(hostID int64) error {
	_, err := s.DB.Exec(`DELETE FROM host_credentials WHERE host_id=?`, hostID)
	return err
}

// ---- groups ----

func (s *Store) CreateGroup(name, color string) (*HostGroup, error) {
	res, err := s.DB.Exec(`INSERT INTO host_groups(name,color) VALUES(?,?)`, name, color)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &HostGroup{ID: id, Name: name, Color: color}, nil
}

func (s *Store) ListGroups() ([]*HostGroup, error) {
	rows, err := s.DB.Query(`SELECT id,name,color FROM host_groups ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*HostGroup
	for rows.Next() {
		g := &HostGroup{}
		if err := rows.Scan(&g.ID, &g.Name, &g.Color); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

func (s *Store) DeleteGroup(id int64) error {
	_, err := s.DB.Exec(`DELETE FROM host_groups WHERE id=?`, id)
	return err
}

// ---- known_hosts ----

func (s *Store) UpsertKnownHost(hostname string, port int, keyType, fingerprint, publicKey string) error {
	_, err := s.DB.Exec(`INSERT INTO known_hosts(hostname,port,key_type,fingerprint,public_key) VALUES(?,?,?,?,?)
		ON CONFLICT(hostname,port,key_type) DO UPDATE SET fingerprint=excluded.fingerprint, public_key=excluded.public_key`,
		hostname, port, keyType, fingerprint, publicKey)
	return err
}

func (s *Store) ListKnownHosts(hostname string, port int) ([]*KnownHost, error) {
	rows, err := s.DB.Query(`SELECT id,hostname,port,key_type,fingerprint,public_key,added_at FROM known_hosts WHERE hostname=? AND port=?`, hostname, port)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*KnownHost
	for rows.Next() {
		k := &KnownHost{}
		var added string
		if err := rows.Scan(&k.ID, &k.Hostname, &k.Port, &k.KeyType, &k.Fingerprint, &k.PublicKey, &added); err != nil {
			return nil, err
		}
		k.AddedAt, _ = time.Parse(time.RFC3339Nano, added)
		out = append(out, k)
	}
	return out, rows.Err()
}

func (s *Store) DeleteKnownHost(id int64) error {
	_, err := s.DB.Exec(`DELETE FROM known_hosts WHERE id=?`, id)
	return err
}
