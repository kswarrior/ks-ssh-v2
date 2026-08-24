package store

import "time"

type User struct {
	ID           int64
	Username     string
	PasswordHash string
	Role         string
	TOTPSecret   *string
	TOTPEnabled  bool
	Disabled     bool
	CreatedAt    time.Time
}

type HostGroup struct {
	ID    int64
	Name  string
	Color string
}

type Host struct {
	ID             int64
	Name           string
	Hostname       string
	Port           int
	Username       string
	AuthType       string
	GroupID        *int64
	Labels         string
	Color          string
	JumpHostID     *int64
	MaxSessions    int
	PreviewEnabled bool
	LastUsedAt     *time.Time
	CreatedAt      time.Time
}

type HostCredential struct {
	HostID       int64
	PasswordEnc  *string
	PrivateKeyEnc *string
	PassphraseEnc *string
}

type KnownHost struct {
	ID          int64
	Hostname    string
	Port        int
	KeyType     string
	Fingerprint string
	PublicKey   string
	AddedAt     time.Time
}

type Bookmark struct {
	ID     int64
	HostID int64
	Path   string
	Label  string
	Kind   string
}

type Snippet struct {
	ID        int64
	Name      string
	Command   string
	HostID    *int64
	CreatedAt time.Time
}

type Tunnel struct {
	ID         int64
	HostID     int64
	Kind       string
	LocalHost  string
	LocalPort  int
	RemoteHost string
	RemotePort int
	AutoStart  bool
	CreatedAt  time.Time
}

type Transfer struct {
	ID          string
	HostID      int64
	Kind        string
	Path        string
	Name        string
	Size        int64
	Transferred int64
	Status      string
	Checkpoint  *string
	UpdatedAt   time.Time
}

type SessionAudit struct {
	ID           int64
	SessionToken string
	Username     string
	HostName     string
	Kind         string
	StartedAt    time.Time
	EndedAt      *time.Time
}

type Recording struct {
	ID          int64
	SessionToken string
	HostID      int64
	File        string
	StartedAt   time.Time
	DurationSec int64
	SizeBytes   int64
}

type EditorBackup struct {
	ID        int64
	HostID    int64
	Path      string
	Content   []byte
	CreatedAt time.Time
}
