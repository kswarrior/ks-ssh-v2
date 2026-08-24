// Package e2e contains a real loopback SSH server used by end-to-end tests.
// It exercises the production dial/PTY/SFTP/exec paths — no product mocks involved.
package e2e

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os/exec"
	"strings"
	"sync"
	"testing"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// Server is a minimal SSH server: password auth, PTY echo-shell,
// real command exec, and the SFTP subsystem (serving the real FS).
type Server struct {
	Root     string
	User     string
	Pass     string
	Port     int
	listener net.Listener
	hostCfg  *ssh.ServerConfig
	signer   ssh.Signer
	mu       sync.Mutex
	closed   bool
}

func Start(t *testing.T, root string) *Server {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Root: root, User: "tester", Pass: "pw", signer: signer}

	cfg := &ssh.ServerConfig{
		PasswordCallback: func(conn ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
			if conn.User() == s.User && string(password) == s.Pass {
				return nil, nil
			}
			return nil, fmt.Errorf("auth rejected for %q", conn.User())
		},
	}
	cfg.AddHostKey(signer)
	s.hostCfg = cfg

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s.listener = ln
	s.Port = ln.Addr().(*net.TCPAddr).Port
	go s.acceptLoop()
	return s
}

func (s *Server) Fingerprint() string {
	h := sha256.Sum256(s.signer.PublicKey().Marshal())
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(h[:])
}

func (s *Server) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closed {
		s.closed = true
		s.listener.Close()
	}
}

type closeOnce struct{ io.Closer }

func (s *Server) acceptLoop() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		go s.handle(conn)
	}
}

func (s *Server) handle(conn net.Conn) {
	sconn, chans, reqs, err := ssh.NewServerConn(conn, s.hostCfg)
	if err != nil {
		return
	}
	defer sconn.Close()
	go ssh.DiscardRequests(reqs)
	for nc := range chans {
		go s.channel(nc)
	}
}

func (s *Server) channel(nc ssh.NewChannel) {
	if nc.ChannelType() != "session" {
		nc.Reject(ssh.UnknownChannelType, "unsupported")
		return
	}
	ch, reqs, err := nc.Accept()
	if err != nil {
		return
	}
	defer ch.Close()

	hasPty := false
	for req := range reqs {
		switch req.Type {
		case "pty-req":
			hasPty = true
			req.Reply(true, nil)
		case "env":
			req.Reply(true, nil)
		case "shell":
			req.Reply(true, nil)
			s.echoShell(ch)
			return
		case "exec":
			req.Reply(true, nil)
			cmd := u32String(req.Payload)
			out, execErr := runLocal(cmd, s.Root)
			ch.Write([]byte(out))
			code := uint32(0)
			if execErr != nil {
				fmt.Fprintf(ch.Stderr(), "%v\r\n", execErr)
				code = 1
			}
			ch.SendRequest("exit-status", false, ssh.Marshal(
				struct{ Status uint32 }{code}))
			return
		case "subsystem":
			name := u32String(req.Payload)
			if name == "sftp" {
				req.Reply(true, nil)
				srv, serr := sftp.NewServer(ch)
				if serr == nil {
					_ = srv.Serve()
				}
				return
			}
			req.Reply(false, nil)
		default:
			if req.WantReply {
				req.Reply(false, nil)
			}
		}
	}
	_ = hasPty
}

// echoShell answers each stdin line: echo/pwd handled, else echoed back.
func (s *Server) echoShell(ch ssh.Channel) {
	buf := make([]byte, 4096)
	var line []byte
	for {
		n, err := ch.Read(buf)
		if n > 0 {
			line = append(line, buf[:n]...)
			for {
				idx := strings.IndexByte(string(line), '\n')
				if idx < 0 {
					break
				}
				cmdLine := strings.TrimRight(string(line[:idx]), "\r")
				line = line[idx+1:]
				switch {
				case cmdLine == "":
				case strings.HasPrefix(cmdLine, "echo "):
					fmt.Fprintf(ch, "%s\r\n", strings.TrimPrefix(cmdLine, "echo "))
				case cmdLine == "pwd":
					fmt.Fprintf(ch, "%s\r\n", s.Root)
				default:
					fmt.Fprintf(ch, "ks-test-shell: %s\r\n", cmdLine)
				}
			}
		}
		if err != nil {
			return
		}
	}
}

func runLocal(cmd, dir string) (string, error) {
	c := exec.Command("sh", "-c", cmd)
	c.Dir = dir
	out, err := c.CombinedOutput()
	return string(out), err
}

// u32String decodes an SSH "string" field (u32 len + bytes).
func u32String(payload []byte) string {
	if len(payload) < 4 {
		return ""
	}
	n := binary.BigEndian.Uint32(payload[:4])
	if int(n) > len(payload)-4 || n > 1<<20 {
		return ""
	}
	return string(payload[4 : 4+n])
}
