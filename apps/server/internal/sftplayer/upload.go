package sftplayer

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path"
	"sync"
	"time"

	"github.com/pkg/sftp"

	"github.com/ks/ks-ssh/server/internal/sshlayer"
)

const ChunkSize = 256 * 1024 // 256 KiB chunks over WS

// UploadSession assembles one resumable upload on the remote host.
type UploadSession struct {
	ID       string
	Final    string // absolute remote path once complete
	Temp     string // .part file during assembly
	Size     int64
	written  int64
	nextIdx  int64
	file     *sftp.File
	cli      *sftp.Client
	mu       sync.Mutex
	lastSave time.Time
	onProg   func(written int64)
	finished bool
}

// UploadManager tracks active uploads per process.
type UploadManager struct {
	mu   sync.Mutex
	sess map[string]*UploadSession
}

func NewUploadManager() *UploadManager {
	return &UploadManager{sess: map[string]*UploadSession{}}
}

var ErrBadChecksum = errors.New("chunk checksum mismatch")
var ErrOutOfOrder = errors.New("chunk out of order")

// Begin starts (or resumes) an upload. Returns the chunk index to send first.
func (m *UploadManager) Begin(c *sshlayer.Client, id, dir, name string, size int64) (int64, error) {
	m.mu.Lock()
	if s, ok := m.sess[id]; ok {
		m.mu.Unlock()
		s.mu.Lock()
		idx := s.nextIdx
		s.mu.Unlock()
		return idx, nil
	}
	m.mu.Unlock()

	cli, err := c.SFTP()
	if err != nil {
		return 0, err
	}
	dp, err := CleanPath(dir)
	if err != nil {
		return 0, err
	}
	final := path.Join(dp, sanitizeName(name))
	temp := final + ".ks-part-" + id
	var offset int64
	if st, err := cli.Stat(temp); err == nil {
		offset = st.Size() // resume
		if offset > size {
			_ = cli.Remove(temp)
			offset = 0
		}
	} else if !os.IsNotExist(mapSFTP(err)) && err != nil {
		return 0, err
	}
	f, err := cli.OpenFile(temp, os.O_CREATE|os.O_WRONLY|os.O_APPEND)
	if err != nil {
		return 0, fmt.Errorf("open part file: %w", err)
	}
	s := &UploadSession{
		ID: id, Final: final, Temp: temp, Size: size,
		written: offset, nextIdx: offset / ChunkSize,
		file: f, cli: cli,
	}
	m.mu.Lock()
	m.sess[id] = s
	m.mu.Unlock()
	slog.Debug("upload begun", "id", id, "resumeFrom", offset)
	return s.nextIdx, nil
}

func (s *UploadSession) Written() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.written
}

// WriteChunk validates and appends one chunk.
func (m *UploadManager) WriteChunk(id string, idx int64, data []byte, checksumHex string) error {
	m.mu.Lock()
	s, ok := m.sess[id]
	m.mu.Unlock()
	if !ok {
		return errors.New("unknown transfer " + id)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.finished {
		return errors.New("transfer already finished")
	}
	if idx < s.nextIdx {
		return nil // already have it (client retry) — ack as success
	}
	if idx > s.nextIdx {
		return ErrOutOfOrder
	}
	if checksumHex != "" {
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != checksumHex {
			return ErrBadChecksum
		}
	}
	n, err := s.file.Write(data)
	if err != nil {
		return err
	}
	s.written += int64(n)
	s.nextIdx++
	if s.onProg != nil && time.Since(s.lastSave) > 500*time.Millisecond {
		s.lastSave = time.Now()
		go s.onProg(s.written)
	}
	return nil
}

// Finish closes and renames the part file into place.
func (m *UploadManager) Finish(id string, mtimeSec int64) error {
	m.mu.Lock()
	s, ok := m.sess[id]
	m.mu.Unlock()
	if !ok {
		return errors.New("unknown transfer " + id)
	}
	s.mu.Lock()
	err := s.file.Close()
	s.finished = true
	s.mu.Unlock()
	if err != nil {
		return err
	}
	if err := s.cli.PosixRename(s.Temp, s.Final); err != nil {
		// fallback: plain rename works when target FS lacks posix-rename ext
		if rerr := s.cli.Rename(s.Temp, s.Final); rerr != nil {
			return fmt.Errorf("rename part→final: %w (orig %v)", rerr, err)
		}
	}
	if mtimeSec > 0 {
		_ = s.cli.Chtimes(s.Final, time.Unix(mtimeSec, 0), time.Unix(mtimeSec, 0))
	}
	m.mu.Lock()
	delete(m.sess, id)
	m.mu.Unlock()
	slog.Debug("upload finished", "id", id, "path", s.Final, "bytes", s.Written())
	return nil
}

// Abort cancels an upload and removes the part file.
func (m *UploadManager) Abort(id string) error {
	m.mu.Lock()
	s, ok := m.sess[id]
	delete(m.sess, id)
	m.mu.Unlock()
	if !ok {
		return nil
	}
	s.mu.Lock()
	_ = s.file.Close()
	s.finished = true
	cli := s.cli
	temp := s.Temp
	s.mu.Unlock()
	_ = cli.Remove(temp)
	return nil
}

// Pending reports whether an upload session is still open.
func (m *UploadManager) Pending(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.sess[id]
	return ok
}

func sanitizeName(name string) string {
	base := path.Base(name)
	out := make([]rune, 0, len(base))
	for _, r := range base {
		switch {
		case r == '/', r == '\\':
			out = append(out, '_')
		case r < 32:
			// drop control chars
		default:
			out = append(out, r)
		}
	}
	if len(out) == 0 || string(out) == "." || string(out) == ".." {
		return "unnamed"
	}
	return string(out)
}
