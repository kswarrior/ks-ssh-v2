package wshub

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ks/ks-ssh/server/internal/store"
)

// ptyChunk is one unit of terminal output in the ring buffer.
type ptyChunk struct {
	Seq  int64
	Data []byte
}

// PtySession is a server-side PTY that outlives browser connections.
// One SSH session + PTY per PtySession; N viewers may attach (tabs/splits).
type PtySession struct {
	ID     string
	HostID int64
	User   string // owner username

	mu       sync.RWMutex
	ring     []ptyChunk
	ringSize int64 // max bytes buffered
	firstSeq int64 // lowest seq still in ring
	lastSeq  int64
	closed   atomic.Bool
	lastUsed atomic.Int64 // unix

	subs map[*Conn]chan *Envelope
	subMu sync.Mutex

	writeFn func(data []byte)          // pushes to PTY stdin
	closeFn func()                     // kills PTY + ssh channel
	resizeFn func(cols, rows int) error

	recFile   *os.File
	recStart  time.Time
	recFrames int64
	recMeta   recMeta
}

const defaultRingSize = 1024 * 1024 // 1 MB scrollback replay window

func NewPtySession(id string, hostID int64, user string) *PtySession {
	return &PtySession{
		ID:       id,
		HostID:   hostID,
		User:     user,
		ring:     make([]ptyChunk, 0, 256),
		ringSize: defaultRingSize,
		firstSeq: 1,
		lastSeq:  0,
		subs:     map[*Conn]chan *Envelope{},
	}
}

var globalSeqCounter atomic.Int64

// Write appends output from the PTY into the ring and fans out to subscribers.
func (s *PtySession) Write(p []byte) {
	if s.closed.Load() || len(p) == 0 {
		return
	}
	s.mu.Lock()
	seq := s.lastSeq + 1
	chunk := ptyChunk{Seq: seq, Data: append([]byte(nil), p...)}
	s.ring = append(s.ring, chunk)
	s.lastSeq = seq
	for s.totalBytes() > s.ringSize && len(s.ring) > 1 {
		s.ring = s.ring[1:]
		s.firstSeq++
	}
	env, _ := NewEnvelope("pty.out", seq, map[string]string{"data": string(chunk.Data)})
	s.mu.Unlock()

	if env == nil {
		return
	}
	s.subMu.Lock()
	for _, ch := range s.subs {
		select {
		case ch <- env:
		default:
			// slow consumer: buffer full — drop it (client reconnects+replays)
		}
	}
	s.subMu.Unlock()
	s.lastUsed.Store(time.Now().Unix())
	s.recordFrame(string(p))
}

func (s *PtySession) totalBytes() int64 {
	var n int64
	for _, c := range s.ring {
		n += int64(len(c.Data))
	}
	return n
}

// Attach registers a viewer. fromSeq < firstSeq means history was truncated.
func (s *PtySession) Attach(c *Conn, fromSeq int64) {
	ch := make(chan *Envelope, 512)
	s.subMu.Lock()
	s.subs[c] = ch
	s.subMu.Unlock()

	s.mu.RLock()
	truncated := fromSeq > 0 && fromSeq < s.firstSeq-1
	start := s.firstSeq
	if fromSeq >= s.firstSeq {
		start = fromSeq + 1
	}
	var replay []*Envelope
	for _, chunk := range s.ring {
		if chunk.Seq >= start {
			e, _ := NewEnvelope("pty.out", chunk.Seq, map[string]string{"data": string(chunk.Data)})
			replay = append(replay, e)
		}
	}
	firstReplay, lastReplay := int64(0), s.lastSeq
	if len(replay) > 0 {
		firstReplay = replay[0].Seq
	}
	s.mu.RUnlock()

	_ = c.SendRaw(&Envelope{Type: "pty.attached", Seq: 0, TS: time.Now().UnixMilli(),
		Payload: mustJSON(map[string]any{
			"sessionId": s.ID, "hostId": s.HostID,
			"replayedFromSeq": firstReplay, "lastSeq": lastReplay, "truncated": truncated,
		})})
	for _, e := range replay {
		if err := c.SendRaw(e); err != nil {
			return
		}
	}
	go s.pump(c, ch)
}

func (s *PtySession) pump(c *Conn, ch chan *Envelope) {
	for env := range ch {
		if err := c.SendRaw(env); err != nil {
			s.Detach(c)
			return
		}
	}
}

func (s *PtySession) Detach(c *Conn) {
	s.subMu.Lock()
	ch, ok := s.subs[c]
	if ok {
		delete(s.subs, c)
		close(ch)
	}
	n := len(s.subs)
	s.subMu.Unlock()
	if ok {
		c.Close()
	}
	if n == 0 {
		s.lastUsed.Store(time.Now().Unix())
	}
}

// ViewerCount returns attached viewers.
func (s *PtySession) ViewerCount() int {
	s.subMu.Lock()
	defer s.subMu.Unlock()
	return len(s.subs)
}

// Input writes client keystrokes to the PTY.
func (s *PtySession) Input(data []byte) error {
	s.lastUsed.Store(time.Now().Unix())
	if s.writeFn == nil {
		return fmt.Errorf("session closed")
	}
	s.writeFn(data)
	return nil
}

// Resize resizes the remote PTY.
func (s *PtySession) Resize(cols, rows int) error {
	if s.resizeFn == nil {
		return fmt.Errorf("session closed")
	}
	return s.resizeFn(cols, rows)
}

// Close terminates the PTY and all viewers.
func (s *PtySession) Close() {
	if s.closed.CompareAndSwap(false, true) {
		if s.closeFn != nil {
			s.closeFn()
		}
		s.subMu.Lock()
		for c, ch := range s.subs {
			close(ch)
			c.Close()
			delete(s.subs, c)
		}
		s.subMu.Unlock()
		s.finishRecording()
	}
}

// LastUsed unix seconds.
func (s *PtySession) LastUsed() int64 { return s.lastUsed.Load() }

// Closed reports whether this session has terminated.
func (s *PtySession) Closed() bool { return s.closed.Load() }

// Setters used by the API layer when wiring an SSH PTY in.
func (s *PtySession) WriteFn(fn func([]byte))     { s.writeFn = fn }
func (s *PtySession) ResizeFn(fn func(int, int) error) { s.resizeFn = fn }
func (s *PtySession) CloseFn(fn func())           { s.closeFn = fn }

// ---- recording (asciicast v2) ----

func (s *PtySession) StartRecording(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.Create(filepath.Join(dir, fmt.Sprintf("%d-%s.cast", time.Now().UnixMilli(), s.ID)))
	if err != nil {
		return err
	}
	s.recStart = time.Now()
	header := map[string]any{
		"version": 2, "width": 120, "height": 40,
		"timestamp": s.recStart.Unix(),
		"env":       map[string]string{"SHELL": "/bin/bash", "TERM": "xterm-256color"},
	}
	b, _ := json.Marshal(header)
	if _, err := f.Write(append(b, '\n')); err != nil {
		f.Close()
		return err
	}
	s.recFile = f
	return nil
}

func (s *PtySession) recordFrame(data string) {
	s.mu.Lock()
	f := s.recFile
	t := time.Since(s.recStart).Seconds()
	s.mu.Unlock()
	if f == nil {
		return
	}
	frame, _ := json.Marshal([]any{t, "o", data})
	atomic.AddInt64(&s.recFrames, 1)
	f.SetWriteDeadline(time.Now().Add(2 * time.Second))
	if _, err := f.Write(append(frame, '\n')); err != nil {
		slog.Debug("recording write failed", "err", err)
	}
}

func (s *PtySession) finishRecording() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.recFile != nil {
		dur := int64(0)
		if !s.recStart.IsZero() {
			dur = int64(time.Since(s.recStart).Seconds())
		}
		st, _ := s.recFile.Stat()
		size := int64(0)
		if st != nil {
			size = st.Size()
		}
		s.recMeta = recMeta{dur: dur, size: size}
		s.recFile.Close()
		s.recFile = nil
	}
}

type recMeta struct{ dur, size int64 }

// RecMeta returns duration/size after close (zero while open).
func (s *PtySession) RecMeta() (int64, int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.recMeta.dur, s.recMeta.size
}

// ---- registry ----

type Registry struct {
	mu       sync.Mutex
	sessions map[string]*PtySession
	store    *store.Store
	stopCh   chan struct{}
}

func NewRegistry(st *store.Store) *Registry {
	return &Registry{sessions: map[string]*PtySession{}, store: st, stopCh: make(chan struct{})}
}

func (r *Registry) Get(id string) (*PtySession, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.sessions[id]
	return s, ok
}

func (r *Registry) Add(s *PtySession) {
	r.mu.Lock()
	r.sessions[s.ID] = s
	r.mu.Unlock()
}

// Remove drops a closed session from the registry.
func (r *Registry) Remove(id string) {
	r.mu.Lock()
	delete(r.sessions, id)
	r.mu.Unlock()
}

// ByHost lists live sessions for a host (for workspace restore).
func (r *Registry) ByHost(hostID int64) []*PtySession {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []*PtySession{}
	for _, s := range r.sessions {
		if s.HostID == hostID && !s.closed.Load() {
			out = append(out, s)
		}
	}
	return out
}

// Shutdown closes every session.
func (r *Registry) Shutdown() {
	close(r.stopCh)
	r.mu.Lock()
	all := make([]*PtySession, 0, len(r.sessions))
	for id, s := range r.sessions {
		all = append(all, s)
		delete(r.sessions, id)
	}
	r.mu.Unlock()
	for _, s := range all {
		s.Close()
	}
}

// StartJanitor reaps sessions idle > maxIdle with no viewers.
func (r *Registry) StartJanitor(maxIdle time.Duration) {
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-r.stopCh:
				return
			case <-t.C:
			}
			now := time.Now().Unix()
			r.mu.Lock()
			var dead []*PtySession
			for id, s := range r.sessions {
				if s.ViewerCount() == 0 && now-s.LastUsed() > int64(maxIdle.Seconds()) {
					dead = append(dead, s)
					delete(r.sessions, id)
				}
			}
			r.mu.Unlock()
			for _, s := range dead {
				slog.Info("reaping idle pty session", "id", s.ID)
				s.Close()
			}
		}
	}()
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage("{}")
	}
	return b
}
