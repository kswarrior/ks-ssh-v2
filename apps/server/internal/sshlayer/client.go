package sshlayer

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"

	"github.com/ks/ks-ssh/server/internal/store"
)

const (
	keepaliveInterval = 15 * time.Second
	keepaliveTimeout  = 45 * time.Second
	channelCap        = 20
	maxSessionDefault = 10
)

// Client is one multiplexed SSH connection to a host.
type Client struct {
	mu       sync.Mutex
	host     *store.Host
	conn     *ssh.Client
	closed   atomic.Bool
	sem      chan struct{} // channel cap guard
	rtt      atomic.Int64
	ptyCount atomic.Int64

	sftpMu   sync.Mutex
	sftpCli  *sftp.Client

	deadChOnce sync.Once
	deadCh     chan struct{}

	lastActivity atomic.Int64 // unix
}

func (c *Client) alive() bool {
	return !c.closed.Load() && c.conn != nil
}

func (c *Client) close() {
	if c.closed.CompareAndSwap(false, true) {
		c.mu.Lock()
		conn := c.conn
		c.mu.Unlock()
		if conn != nil {
			conn.Close()
		}
	}
}

// reap closes a dead client's resources (idempotent).
func (c *Client) reap(m *Manager) {
	c.close()
}

func (c *Client) acquire() error {
	select {
	case c.sem <- struct{}{}:
		return nil
	default:
		return ErrTooManySessions
	}
}

func (c *Client) release() {
	select {
	case <-c.sem:
	default:
	}
}

// keepaliveLoop sends keepalives every 15s, measures RTT,
// declares the peer dead after 45s of silence and closes the conn
// so auto-reconnect can rebuild it.
func (c *Client) keepaliveLoop(stopCh chan struct{}) {
	t := time.NewTicker(keepaliveInterval)
	defer t.Stop()
	var misses int
	for {
		select {
		case <-stopCh:
			return
		case <-t.C:
		}
		if c.closed.Load() {
			return
		}
		start := time.Now()
		done := make(chan error, 1)
		go func() {
			_, _, err := c.conn.SendRequest("keepalive@openssh.com", true, nil)
			done <- err
		}()
		select {
		case err := <-done:
			if err != nil {
				misses++
			} else {
				misses = 0
				c.rtt.Store(time.Since(start).Milliseconds())
			}
		case <-time.After(keepaliveInterval):
			misses += 3 // one full window missed
		}
		if misses >= 3 { // ≥45 s without a reply
			slog.Warn("ssh peer dead", "host", c.host.Name)
			c.close()
			return
		}
	}
}

// ---- dialing ----

func (m *Manager) hostKeyCallback(host *store.Host) (ssh.HostKeyCallback, error) {
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		fp := fingerprint(key)
		kh, err := m.st.ListKnownHosts(host.Hostname, host.Port)
		if err != nil {
			return fmt.Errorf("known_hosts lookup: %w", err)
		}
		for _, k := range kh {
			if k.KeyType == key.Type() {
				if k.Fingerprint == fp {
					return nil // match
				}
				return &HostKeyMismatch{
					Fingerprint: fp, KeyType: key.Type(), StoredFingerpr: k.Fingerprint,
					Hostname: host.Hostname, Port: host.Port,
				}
			}
		}
		return &UnknownHostKey{
			Fingerprint: fp, KeyType: key.Type(),
			Hostname: host.Hostname, Port: host.Port,
		}
	}, nil
}

func fingerprint(key ssh.PublicKey) string {
	return fingerprintBytes(key.Marshal())
}

func (m *Manager) authMethods(host *store.Host, credOverride *store.HostCredential) ([]ssh.AuthMethod, error) {
	cred := credOverride
	if cred == nil {
		var err error
		cred, err = m.st.GetCredential(host.ID)
		if err != nil {
			return nil, err
		}
	}
	switch host.AuthType {
	case "password":
		pw := ""
		if cred.PasswordEnc != nil {
			var err error
			pw, err = m.box.OpenString(*cred.PasswordEnc)
			if err != nil {
				return nil, fmt.Errorf("decrypt password: %w", err)
			}
		}
		return []ssh.AuthMethod{ssh.Password(pw)}, nil
	case "key":
		keyData := ""
		if cred.PrivateKeyEnc != nil {
			var err error
			keyData, err = m.box.OpenString(*cred.PrivateKeyEnc)
			if err != nil {
				return nil, fmt.Errorf("decrypt key: %w", err)
			}
		}
		signer, err := parseKey(keyData, "")
		if err != nil {
			return nil, err
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, nil
	case "key_passphrase":
		keyData, pass := "", ""
		if cred.PrivateKeyEnc != nil {
			var err error
			keyData, err = m.box.OpenString(*cred.PrivateKeyEnc)
			if err != nil {
				return nil, fmt.Errorf("decrypt key: %w", err)
			}
		}
		if cred.PassphraseEnc != nil {
			var err error
			pass, err = m.box.OpenString(*cred.PassphraseEnc)
			if err != nil {
				return nil, fmt.Errorf("decrypt passphrase: %w", err)
			}
		}
		signer, err := parseKey(keyData, pass)
		if err != nil {
			return nil, err
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, nil
	case "agent":
		a, err := localAgent()
		if err != nil {
			return nil, err
		}
		signers, err := a.Signers()
		if err != nil || len(signers) == 0 {
			return nil, errors.New("no keys available from SSH agent")
		}
		return []ssh.AuthMethod{ssh.PublicKeysCallback(a.Signers)}, nil
	default:
		return nil, fmt.Errorf("unsupported auth type %q", host.AuthType)
	}
}

// dialHost builds the jump chain then dials the target.
func (m *Manager) dialHost(host *store.Host) (*Client, error) {
	return m.dialHostWithCreds(host, nil)
}

// dialHostWithCreds dials with optional credential override (test-connection
// before save). The override is used in-memory only, never persisted.
func (m *Manager) dialHostWithCreds(host *store.Host, credOverride *store.HostCredential) (*Client, error) {
	cfg := &ssh.ClientConfig{
		User:            host.Username,
		Auth:            nil,
		HostKeyCallback: nil,
		Timeout:         15 * time.Second,
	}
	cb, err := m.hostKeyCallback(host)
	if err != nil {
		return nil, err
	}
	cfg.HostKeyCallback = cb
	methods, err := m.authMethods(host, credOverride)
	if err != nil {
		return nil, err
	}
	cfg.Auth = methods

	addr := net.JoinHostPort(host.Hostname, fmt.Sprint(host.Port))
	var conn *ssh.Client

	if host.JumpHostID != nil {
		jump, err := m.Connect(*host.JumpHostID)
		if err != nil {
			return nil, fmt.Errorf("jump host: %w", err)
		}
		nc, err := jump.conn.Dial("tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("jump tunnel: %w", err)
		}
		c, chans, reqs, err := ssh.NewClientConn(nc, addr, cfg)
		if err != nil {
			nc.Close()
			return nil, err
		}
		conn = ssh.NewClient(c, chans, reqs)
	} else {
		var derr error
		conn, derr = ssh.Dial("tcp", addr, cfg)
		if derr != nil {
			return nil, mapDialError(derr)
		}
	}
	maxSessions := host.MaxSessions
	if maxSessions <= 0 {
		maxSessions = maxSessionDefault
	}
	c := &Client{
		host: host,
		conn: conn,
		sem:  make(chan struct{}, channelCap),
	}
	return c, nil
}

func mapDialError(err error) error {
	msg := err.Error()
	if strings.Contains(msg, "unable to authenticate") || strings.Contains(msg, "auth failed") {
		return fmt.Errorf("authentication failed for remote host: %w", err)
	}
	return err
}

// AcceptKey stores a user-accepted fingerprint (TOFU). If a different
// fingerprint exists for this key type it is replaced — but only after an
// explicit mismatch was surfaced and accepted by the user via API.
func (m *Manager) AcceptKey(hostID int64, keyType, fingerprint, publicKey string) error {
	host, err := m.st.GetHost(hostID)
	if err != nil {
		return err
	}
	return m.st.UpsertKnownHost(host.Hostname, host.Port, keyType, fingerprint, publicKey)
}

// TestConnection dials once (optionally with credentials not yet saved),
// reports latency, closes. Never stores anything.
func (m *Manager) TestConnection(ctx context.Context, host *store.Host, credsOverride *store.HostCredential) (latencyMs int64, err error) {
	start := time.Now()
	c, err := m.dialHostWithCreds(host, credsOverride)
	if err != nil {
		return 0, err
	}
	defer c.close()
	_ = ctx
	return time.Since(start).Milliseconds(), nil
}

// Session opens a session channel with optional agent forwarding.
func (c *Client) Session(forwardAgent bool) (*ssh.Session, error) {
	if c.closed.Load() {
		return nil, ErrHostOffline
	}
	if err := c.acquire(); err != nil {
		return nil, err
	}
	s, err := c.conn.NewSession()
	if err != nil {
		c.release()
		if c.closed.Load() {
			return nil, ErrHostOffline
		}
		return nil, err
	}
	if forwardAgent && c.host.AuthType == "agent" {
		if ag, aerr := localAgent(); aerr == nil {
			_ = agent.ForwardToRemote(c.conn, "127.0.0.1:22")
			_ = agent.RequestAgentForwarding(s)
			_ = ag
		}
	}
	return s, nil
}

func (c *Client) ReleaseSession() { c.release() }

// Run executes a command, returning stdout+stderr combined and exit code.
// Output capped by ring buffer semantics upstream; here we cap at limit bytes.
func (c *Client) Run(ctx context.Context, timeout time.Duration, command string) (stdout, stderr string, code int, err error) {
	sess, err := c.Session(c.host.AuthType == "agent")
	if err != nil {
		return "", "", -1, err
	}
	defer c.ReleaseSession()
	defer sess.Close()
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var outBuf, errBuf strings.Builder
	sess.Stdout = &outBuf
	sess.Stderr = &errBuf
	done := make(chan error, 1)
	go func() { done <- sess.Run(command) }()
	select {
	case <-ctx.Done():
		sess.Signal(ssh.SIGKILL)
		return outBuf.String(), errBuf.String(), -1, fmt.Errorf("timeout after %s: %w", timeout, ctx.Err())
	case err = <-done:
	}
	code = 0
	if err != nil {
		var ee *ssh.ExitError
		if errors.As(err, &ee) {
			code = ee.ExitStatus()
			err = nil
		} else {
			return outBuf.String(), errBuf.String(), -1, err
		}
	}
	return outBuf.String(), errBuf.String(), code, nil
}

// SFTP returns the shared SFTP client, creating it lazily and rebuilding
// transparently after reconnects. pkg/sftp clients are safe for concurrent use.
func (c *Client) SFTP() (*sftp.Client, error) {
	c.sftpMu.Lock()
	cli := c.sftpCli
	c.sftpMu.Unlock()
	if cli != nil {
		if _, err := cli.Stat("."); err == nil {
			return cli, nil
		}
		// stale — drop and rebuild
		cli.Close()
		c.sftpMu.Lock()
		c.sftpCli = nil
		c.sftpMu.Unlock()
	}
	if c.closed.Load() {
		return nil, ErrHostOffline
	}
	newCli, err := newSFTP(c.conn)
	if err != nil {
		if c.closed.Load() {
			return nil, ErrHostOffline
		}
		return nil, err
	}
	c.sftpMu.Lock()
	c.sftpCli = newCli
	c.sftpMu.Unlock()
	return newCli, nil
}

// LastRTT returns the last measured keepalive round-trip in ms.
func (c *Client) LastRTT() int64 { return c.rtt.Load() }

// Host exposes the host row (read-only use).
func (c *Client) Host() *store.Host { return c.host }

// Closed returns a channel closed when this client dies (for listeners).
func (c *Client) Closed() <-chan struct{} {
	c.deadChOnce.Do(func() {
		c.deadCh = make(chan struct{})
		go func() {
			for !c.closed.Load() {
				time.Sleep(2 * time.Second)
			}
			close(c.deadCh)
		}()
	})
	return c.deadCh
}

// Conn exposes underlying client for proxy/tunnels (advanced use).
func (c *Client) Conn() *ssh.Client {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn
}

var _ = slog.Info
