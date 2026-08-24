package store

import (
	"database/sql"
	"errors"
	"time"

	"golang.org/x/crypto/bcrypt"
)

var ErrNotFound = errors.New("not found")

func (s *Store) CreateUser(username, password, role string) (*User, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}
	res, err := s.DB.Exec(`INSERT INTO users(username,password_hash,role) VALUES(?,?,?)`, username, string(hash), role)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.GetUserByID(id)
}

func scanUser(row interface{ Scan(...any) error }) (*User, error) {
	u := &User{}
	var totpSecret sql.NullString
	var created string
	err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.Role, &totpSecret, &u.TOTPEnabled, &u.Disabled, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if totpSecret.Valid {
		u.TOTPSecret = &totpSecret.String
	}
	u.CreatedAt, _ = time.Parse(time.RFC3339Nano, created)
	return u, nil
}

const userCols = `id,username,password_hash,role,totp_secret,totp_enabled,disabled,created_at`

func (s *Store) GetUserByID(id int64) (*User, error) {
	return scanUser(s.DB.QueryRow(`SELECT `+userCols+` FROM users WHERE id=?`, id))
}

func (s *Store) GetUserByName(name string) (*User, error) {
	return scanUser(s.DB.QueryRow(`SELECT `+userCols+` FROM users WHERE username=?`, name))
}

func (s *Store) ListUsers() ([]*User, error) {
	rows, err := s.DB.Query(`SELECT ` + userCols + ` FROM users ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *Store) SetPassword(id int64, password string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	_, err = s.DB.Exec(`UPDATE users SET password_hash=? WHERE id=?`, string(hash), id)
	return err
}

func (s *Store) CheckPassword(id int64, password string) bool {
	var hash string
	if err := s.DB.QueryRow(`SELECT password_hash FROM users WHERE id=? AND disabled=0`, id).Scan(&hash); err != nil {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

func (s *Store) DeleteUser(id int64) error {
	_, err := s.DB.Exec(`DELETE FROM users WHERE id=?`, id)
	return err
}

func (s *Store) SetUserRole(id int64, role string) error {
	_, err := s.DB.Exec(`UPDATE users SET role=? WHERE id=?`, role, id)
	return err
}

func (s *Store) SetUserDisabled(id int64, disabled bool) error {
	v := 0
	if disabled {
		v = 1
	}
	_, err := s.DB.Exec(`UPDATE users SET disabled=? WHERE id=?`, v, id)
	return err
}

func (s *Store) SetTOTP(id int64, secret *string, enabled bool) error {
	e := 0
	if enabled {
		e = 1
	}
	if secret == nil {
		_, err := s.DB.Exec(`UPDATE users SET totp_secret=NULL, totp_enabled=? WHERE id=?`, e, id)
		return err
	}
	_, err := s.DB.Exec(`UPDATE users SET totp_secret=?, totp_enabled=? WHERE id=?`, *secret, e, id)
	return err
}

// RecordAuthAttempt stores login attempt for rate limiting/lockout.
func (s *Store) RecordAuthAttempt(username, ip string, ok bool) error {
	v := 0
	if ok {
		v = 1
	}
	_, err := s.DB.Exec(`INSERT INTO auth_attempts(username,ip,ok) VALUES(?,?,?)`, username, ip, v)
	return err
}

// RecentFailures counts failed attempts in the last window.
func (s *Store) RecentFailures(username string, window time.Duration) (int, error) {
	since := time.Now().UTC().Add(-window).Format(time.RFC3339Nano)
	var n int
	err := s.DB.QueryRow(`SELECT COUNT(*) FROM auth_attempts WHERE username=? AND ok=0 AND at>?`, username, since).Scan(&n)
	return n, err
}

// UserCount returns number of users; used to bootstrap first admin.
func (s *Store) UserCount() (int, error) {
	var n int
	err := s.DB.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}
