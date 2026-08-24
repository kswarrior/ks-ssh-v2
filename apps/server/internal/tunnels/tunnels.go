// Package tunnels runs persistent L/R/SOCKS5 forwards over host SSH
// connections, with auto-reconnect (exponential backoff), traffic counters
// and bind-address validation.
package tunnels

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ks/ks-ssh/server/internal/sshlayer"
	"github.com/ks/ks-ssh/server/internal/store"
)

type Status string

const (
	StatusStopped  Status = "stopped"
	StatusStarting Status = "starting"
	StatusUp       Status = "up"
	StatusError    Status = "error"
)

type Run struct {
	Tunnel *store.Tunnel

	status   atomic.Value // Status
	lastErr  atomic.Value // string
	bytesUp  atomic.Int64
	bytesDown atomic.Int64
	conns    atomic.Int64

	stopCh chan struct{}
	mu     sync.Mutex
}

func (r *Run) snapshot() (Status, string, int64, int64, int64) {
	st := r.status.Load()
	s, _ := st.(Status)
	if s == "" {
		s = StatusStopped
	}
	e, _ := r.lastErr.Load().(string)
	return s, e, r.bytesUp.Load(), r.bytesDown.Load(), r.conns.Load()
}

type Manager struct {
	mu    sync.Mutex
	runs  map[int64]*Run
	mgr   *sshlayer.Manager
	st    *store.Store
	appPort int
	stopCh chan struct{}
	wg    sync.WaitGroup
}

func NewManager(mgr *sshlayer.Manager, st *store.Store, appPort int) *Manager {
	return &Manager{runs: map[int64]*Run{}, mgr: mgr, st: st, appPort: appPort, stopCh: make(chan struct{})}
}

var ErrBadBind = errors.New("unsafe bind address")

// ValidateBind refuses wildcard binds and collisions with the app port.
func ValidateBind(host string, port int, appPort int) error {
	h := strings.TrimSpace(host)
	if h == "" {
		h = "127.0.0.1"
	}
	if h == "0.0.0.0" || h == "::" || h == "[::]" || h == "*" {
		return fmt.Errorf("%w: refusing wildcard bind %q — pick a concrete interface address", ErrBadBind, h)
	}
	if port <= 0 || port > 65535 {
		return fmt.Errorf("invalid port %d", port)
	}
	if port == appPort {
		return fmt.Errorf("%w: port %d is KS SSH's own port", ErrBadBind, appPort)
	}
	ip := net.ParseIP(h)
	if ip != nil && ip.IsUnspecified() {
		return fmt.Errorf("%w: unspecified address", ErrBadBind)
	}
	return nil
}

// Start launches a tunnel run (idempotent).
func (m *Manager) Start(t *store.Tunnel) error {
	m.mu.Lock()
	if _, ok := m.runs[t.ID]; ok {
		m.mu.Unlock()
		return nil
	}
	run := &Run{Tunnel: t, stopCh: make(chan struct{})}
	run.status.Store(StatusStarting)
	m.runs[t.ID] = run
	m.mu.Unlock()

	m.wg.Add(1)
	go m.supervise(run)
	return nil
}

func (m *Manager) Stop(id int64) {
	m.mu.Lock()
	run := m.runs[id]
	delete(m.runs, id)
	m.mu.Unlock()
	if run != nil {
		close(run.stopCh)
		run.conns.Store(0)
		run.status.Store(StatusStopped)
	}
}

func (m *Manager) StopAll() {
	m.mu.Lock()
	ids := make([]int64, 0, len(m.runs))
	for id := range m.runs {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.Stop(id)
	}
	m.wg.Wait()
}

// Snapshot returns live status for all running tunnels.
func (m *Manager) Snapshot() map[int64]Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[int64]Status, len(m.runs))
	for id, r := range m.runs {
		s, e, up, down, cn := r.snapshot()
		_ = e
		_ = up
		_ = down
		_ = cn
		out[id] = s
	}
	return out
}

// Detail returns full live stats for one tunnel (zero values when not running).
func (m *Manager) Detail(id int64) (Status, string, int64, int64, int64) {
	m.mu.Lock()
	r := m.runs[id]
	m.mu.Unlock()
	if r == nil {
		return StatusStopped, "", 0, 0, 0
	}
	return r.snapshot()
}

func (m *Manager) supervise(run *Run) {
	defer m.wg.Done()
	backoff := time.Second
	for {
		select {
		case <-run.stopCh:
			return
		case <-m.stopCh:
			return
		default:
		}
		err := m.serveOnce(run)
		select {
		case <-run.stopCh:
			return
		default:
		}
		if err != nil {
			run.status.Store(StatusError)
			run.lastErr.Store(err.Error())
			slog.Warn("tunnel error", "id", run.Tunnel.ID, "err", err)
		}
		time.Sleep(backoff)
		if backoff < 30*time.Second {
			backoff *= 2
		}
		select {
		case <-run.stopCh:
			return
		case <-m.stopCh:
			return
		default:
		}
	}
}

func (m *Manager) serveOnce(run *Run) error {
	c, err := m.mgr.Get(run.Tunnel.HostID)
	if err != nil {
		// try to bring the SSH session up
		c, err = m.mgr.Connect(run.Tunnel.HostID)
		if err != nil {
			return fmt.Errorf("host connect: %w", err)
		}
	}
	t := run.Tunnel
	switch t.Kind {
	case "L":
		err = m.serveLocal(run, c)
	case "R":
		err = m.serveRemote(run, c)
	case "D":
		err = m.serveSocks(run, c)
	default:
		err = fmt.Errorf("unknown kind %q", t.Kind)
	}
	return err
}

type countingConn struct {
	net.Conn
	up   func(int64)
	down func(int64)
}

func (cc *countingConn) Read(p []byte) (int, error) {
	n, err := cc.Conn.Read(p)
	if n > 0 {
		cc.down(int64(n))
	}
	return n, err
}

func (cc *countingConn) Write(p []byte) (int, error) {
	n, err := cc.Conn.Write(p)
	if n > 0 {
		cc.up(int64(n))
	}
	return n, err
}

func (m *Manager) serveLocal(run *Run, c *sshlayer.Client) error {
	t := run.Tunnel
	addr := net.JoinHostPort(t.LocalHost, strconv.Itoa(t.LocalPort))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", addr, err)
	}
	defer ln.Close()
	go func() {
		select {
		case <-run.stopCh:
			ln.Close()
		case <-m.stopCh:
			ln.Close()
		case <-c.Closed():
			ln.Close()
		}
	}()
	run.status.Store(StatusUp)
	run.lastErr.Store("")
	for {
		nc, err := ln.Accept()
		if err != nil {
			return nil // closed
		}
		run.conns.Add(1)
		go func(nc net.Conn) {
			defer run.conns.Add(-1)
			rc, err := c.Conn().Dial("tcp", net.JoinHostPort(t.RemoteHost, strconv.Itoa(t.RemotePort)))
			if err != nil {
				nc.Close()
				return
			}
			cc := &countingConn{Conn: nc,
				up:   func(n int64) { run.bytesUp.Add(n) },
				down: func(n int64) { run.bytesDown.Add(n) }}
			pipe(cc, rc)
		}(nc)
	}
}

// ListenerGuard closes Accept loops when stopCh fires.
func pipe(a, b io.ReadWriteCloser) {
	done := make(chan struct{}, 2)
	go func() { io.Copy(b, a); done <- struct{}{} }()
	go func() { io.Copy(a, b); done <- struct{}{} }()
	<-done
	a.Close()
	b.Close()
}

func (m *Manager) serveRemote(run *Run, c *sshlayer.Client) error {
	t := run.Tunnel
	remoteBind := net.JoinHostPort(orLoopback(t.RemoteHost), strconv.Itoa(t.RemotePort))
	ln, err := c.Conn().Listen("tcp", remoteBind)
	if err != nil {
		return fmt.Errorf("remote listen %s: %w", remoteBind, err)
	}
	defer ln.Close()
	run.status.Store(StatusUp)
	run.lastErr.Store("")
	localTarget := net.JoinHostPort(orLoopback(t.LocalHost), strconv.Itoa(t.LocalPort))
	for {
		nc, err := ln.Accept()
		if err != nil {
			return nil // listener closed / connection dropped
		}
		run.conns.Add(1)
		go func(nc net.Conn) {
			defer run.conns.Add(-1)
			lc, err := net.DialTimeout("tcp", localTarget, 5*time.Second)
			if err != nil {
				nc.Close()
				return
			}
			cc := &countingConn{Conn: nc,
				up:   func(n int64) { run.bytesUp.Add(n) },
				down: func(n int64) { run.bytesDown.Add(n) }}
			pipe(cc, lc)
		}(nc)
	}
}

func orLoopback(h string) string {
	if h == "" {
		return "127.0.0.1"
	}
	return h
}

// serveSocks implements dynamic forwarding (SOCKS5 CONNECT-only).
func (m *Manager) serveSocks(run *Run, c *sshlayer.Client) error {
	t := run.Tunnel
	addr := net.JoinHostPort(t.LocalHost, strconv.Itoa(t.LocalPort))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("socks listen %s: %w", addr, err)
	}
	defer ln.Close()
	go func() {
		select {
		case <-run.stopCh:
			ln.Close()
		case <-m.stopCh:
			ln.Close()
		case <-c.Closed():
			ln.Close()
		}
	}()
	run.status.Store(StatusUp)
	run.lastErr.Store("")
	for {
		nc, err := ln.Accept()
		if err != nil {
			return nil
		}
		run.conns.Add(1)
		go func(nc net.Conn) {
			defer run.conns.Add(-1)
			target, err := socksHandshake(nc)
			if err != nil {
				nc.Close()
				return
			}
			rc, err := c.Conn().Dial("tcp", target)
			if err != nil {
				socksReply(nc, 0x01)
				nc.Close()
				return
			}
			socksReply(nc, 0x00)
			cc := &countingConn{Conn: nc,
				up:   func(n int64) { run.bytesUp.Add(n) },
				down: func(n int64) { run.bytesDown.Add(n) }}
			pipe(cc, rc)
		}(nc)
	}
}

func socksHandshake(nc net.Conn) (string, error) {
	nc.SetReadDeadline(time.Now().Add(10 * time.Second))
	defer nc.SetReadDeadline(time.Time{})
	head := make([]byte, 2)
	if _, err := io.ReadFull(nc, head); err != nil {
		return "", err
	}
	if head[0] != 5 {
		return "", errors.New("not socks5")
	}
	methods := make([]byte, head[1])
	if _, err := io.ReadFull(nc, methods); err != nil {
		return "", err
	}
	// no-auth
	if _, err := nc.Write([]byte{5, 0}); err != nil {
		return "", err
	}
	req := make([]byte, 4)
	if _, err := io.ReadFull(nc, req); err != nil {
		return "", err
	}
	if req[1] != 1 { // CONNECT only
		socksReply(nc, 0x07)
		return "", errors.New("only CONNECT supported")
	}
	var host string
	switch req[3] {
	case 1:
		b := make([]byte, 4)
		if _, err := io.ReadFull(nc, b); err != nil {
			return "", err
		}
		host = net.IP(b).String()
	case 3:
		l := make([]byte, 1)
		if _, err := io.ReadFull(nc, l); err != nil {
			return "", err
		}
		b := make([]byte, l[0])
		if _, err := io.ReadFull(nc, b); err != nil {
			return "", err
		}
		host = string(b)
	case 4:
		b := make([]byte, 16)
		if _, err := io.ReadFull(nc, b); err != nil {
			return "", err
		}
		host = net.IP(b).String()
	default:
		return "", errors.New("bad atyp")
	}
	portB := make([]byte, 2)
	if _, err := io.ReadFull(nc, portB); err != nil {
		return "", err
	}
	port := binary.BigEndian.Uint16(portB)
	return net.JoinHostPort(host, strconv.Itoa(int(port))), nil
}

func socksReply(nc net.Conn, code byte) {
	nc.Write([]byte{5, code, 0, 1, 0, 0, 0, 0, 0, 0})
}

// RestoreAutoStart starts tunnels marked auto-start (called on boot).
func (m *Manager) RestoreAutoStart(ctx context.Context) {
	list, err := m.st.ListTunnels()
	if err != nil {
		slog.Warn("cannot list tunnels for restore", "err", err)
		return
	}
	for _, t := range list {
		if !t.AutoStart {
			continue
		}
		if err := m.Start(t); err != nil {
			slog.Warn("autostart tunnel failed", "id", t.ID, "err", err)
		}
	}
}
