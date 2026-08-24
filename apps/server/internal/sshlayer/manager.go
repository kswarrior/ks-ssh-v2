// Package sshlayer manages one multiplexed SSH client per host session,
// with jump chains, known-hosts verification, keepalive RTT probing and
// auto-reconnect.
package sshlayer

import (
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/ks/ks-ssh/server/internal/config"
	"github.com/ks/ks-ssh/server/internal/cryptox"
	"github.com/ks/ks-ssh/server/internal/store"
)

var (
	ErrHostOffline = errors.New("host session not connected")
	ErrTooManySessions = errors.New("per-host session limit reached")
)

// UnknownHostKey signals a not-yet-seen host key (TOFU prompt).
type UnknownHostKey struct {
	Fingerprint string
	KeyType     string
	Hostname    string
	Port        int
}

func (e *UnknownHostKey) Error() string {
	return fmt.Sprintf("unknown host key %s for %s:%d (fingerprint %s)", e.KeyType, e.Hostname, e.Port, e.Fingerprint)
}

// HostKeyMismatch signals a changed fingerprint — hard block.
type HostKeyMismatch struct {
	Fingerprint    string
	KeyType        string
	StoredFingerpr string
	Hostname       string
	Port           int
}

func (e *HostKeyMismatch) Error() string {
	return fmt.Sprintf("HOST KEY MISMATCH for %s:%d: stored %s got %s (%s) — blocked",
		e.Hostname, e.Port, e.StoredFingerpr, e.Fingerprint, e.KeyType)
}

type Manager struct {
	mu      sync.Mutex
	clients map[int64]*Client

	st  *store.Store
	box *cryptox.Box
	cfg *config.Config

	stopCh chan struct{}
	wg     sync.WaitGroup
}

func NewManager(st *store.Store, box *cryptox.Box, cfg *config.Config) *Manager {
	return &Manager{
		clients: map[int64]*Client{},
		st:      st,
		box:     box,
		cfg:     cfg,
		stopCh:  make(chan struct{}),
	}
}

// Get returns the live client for a host or ErrHostOffline.
func (m *Manager) Get(hostID int64) (*Client, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.clients[hostID]
	if !ok || !c.alive() {
		if ok {
			go c.reap(m)
			delete(m.clients, hostID)
		}
		return nil, ErrHostOffline
	}
	return c, nil
}

func (m *Manager) IsConnected(hostID int64) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.clients[hostID]
	return ok && c.alive()
}

// Connect dials (or re-dials) a host and registers the client.
// Replaces a dead client transparently.
func (m *Manager) Connect(hostID int64) (*Client, error) {
	host, err := m.st.GetHost(hostID)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	if c, ok := m.clients[hostID]; ok && c.alive() {
		m.mu.Unlock()
		return c, nil
	}
	m.mu.Unlock()

	c, err := m.dialHost(host)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	old := m.clients[hostID]
	m.clients[hostID] = c
	m.mu.Unlock()
	if old != nil {
		go old.reap(m)
	}
	if err := m.st.TouchHost(hostID); err != nil {
		slog.Warn("touch host", "err", err)
	}
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		c.keepaliveLoop(m.stopCh)
	}()
	return c, nil
}

// Disconnect closes the client and stops its loops.
func (m *Manager) Disconnect(hostID int64) {
	m.mu.Lock()
	c := m.clients[hostID]
	delete(m.clients, hostID)
	m.mu.Unlock()
	if c != nil {
		c.close()
	}
}

// DisconnectAll closes everything at shutdown.
func (m *Manager) DisconnectAll() {
	close(m.stopCh)
	m.mu.Lock()
	all := make([]*Client, 0, len(m.clients))
	for id, c := range m.clients {
		all = append(all, c)
		delete(m.clients, id)
	}
	m.mu.Unlock()
	for _, c := range all {
		c.close()
	}
	m.wg.Wait()
}

// EnableReconnect starts a background auto-reconnect loop for a connected host.
// Called after successful Connect; survives transient drops with 1s→30s backoff.
func (m *Manager) EnableReconnect(hostID int64) {
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		backoff := time.Second
		for {
			select {
			case <-m.stopCh:
				return
			case <-time.After(500 * time.Millisecond):
			}
			m.mu.Lock()
			c := m.clients[hostID]
			m.mu.Unlock()
			if c == nil {
				return // user disconnected
			}
			if c.alive() {
				backoff = time.Second
				continue
			}
			slog.Info("reconnecting host", "hostId", hostID, "backoff", backoff)
			time.Sleep(backoff)
			select {
			case <-m.stopCh:
				return
			default:
			}
			nc, err := m.Connect(hostID)
			if err != nil {
				slog.Warn("reconnect failed", "hostId", hostID, "err", err)
				if backoff < 30*time.Second {
					backoff *= 2
					if backoff > 30*time.Second {
						backoff = 30 * time.Second
					}
				}
				continue
			}
			_ = nc
			backoff = time.Second
		}
	}()
}

// PingRTT returns last measured round-trip in ms (0 = unknown).
func (m *Manager) PingRTT(hostID int64) (int64, bool) {
	m.mu.Lock()
	c := m.clients[hostID]
	m.mu.Unlock()
	if c == nil || !c.alive() {
		return 0, false
	}
	rtt := c.rtt.Load()
	return rtt, rtt > 0
}

// ActivePTYCount counts live terminal sessions for the per-host cap.
func (m *Manager) ActivePTYCount(hostID int64) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.clients[hostID]
	if c == nil {
		return 0
	}
	return int(c.ptyCount.Load())
}
