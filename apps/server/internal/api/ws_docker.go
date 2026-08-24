package api

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/ks/ks-ssh/server/internal/wshub"
)

// handleDockerExecWS opens an interactive shell inside a container.
// Client sends raw {type:"exec.in", payload:{data}} keystrokes;
// server streams exec.out; resize supported via exec.resize.
func (s *Server) handleDockerExecWS(w http.ResponseWriter, r *http.Request) {
	hostID := queryInt64(r, "host", 0)
	container := r.URL.Query().Get("container")
	c, err := s.SSH.Get(hostID)
	if err != nil || container == "" {
		fail(w, http.StatusBadGateway, "offline", "host offline or container missing")
		return
	}
	conn, err := upgradeWS(w, r)
	if err != nil {
		return
	}
	defer conn.Close()

	sshSess, serr := c.Session(false)
	if serr != nil {
		_ = conn.Send("exec.error", map[string]string{"error": serr.Error()})
		return
	}
	defer func() {
		sshSess.Close()
		c.ReleaseSession()
	}()

	stdinR, stdinW := io.Pipe()
	outW := &lineWriter{send: func(data string) {
		_ = conn.Send("exec.out", map[string]string{"data": data})
	}}
	sshSess.Stdin = stdinR
	sshSess.Stdout = outW
	sshSess.Stderr = outW
	if err := sshSess.RequestPty("xterm-256color", 40, 120, ssh.TerminalModes{ssh.ECHO: 1}); err != nil {
		_ = conn.Send("exec.error", map[string]string{"error": err.Error()})
		return
	}
	cmd := fmt.Sprintf("docker exec -it %s /bin/sh -c 'exec $(command -v bash || command -v sh)'",
		shellQuoteArg(container))
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = sshSess.Run(cmd)
	}()
	go func() { // client close → kill
		for {
			env, rerr := conn.Read()
			if rerr != nil {
				_ = sshSess.Signal(ssh.SIGKILL)
				sshSess.Close()
				return
			}
			switch env.Type {
			case "exec.in":
				var p struct {
					Data string `json:"data"`
				}
				if jsonDecodeBytes(env.Payload, &p) == nil {
					stdinW.Write([]byte(p.Data))
				}
			case "exec.resize":
				var p struct {
					Cols int `json:"cols"`
					Rows int `json:"rows"`
				}
				if jsonDecodeBytes(env.Payload, &p) == nil {
					_ = sshSess.WindowChange(p.Rows, p.Cols)
				}
			case "ws.ping":
				_ = conn.Send("ws.pong", map[string]int64{"rttMs": c.LastRTT()})
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Hour):
		_ = sshSess.Signal(ssh.SIGKILL)
	}
}

// lineWriter batches small writes into WS frames.
type lineWriter struct {
	send func(string)
	buf  []byte
}

func (w *lineWriter) Write(p []byte) (int, error) {
	w.buf = append(w.buf, p...)
	const flushAt = 4 * 1024
	for len(w.buf) >= flushAt {
		w.send(string(w.buf[:flushAt]))
		w.buf = w.buf[flushAt:]
	}
	if len(p) > 0 && (p[len(p)-1] == '\n' || len(w.buf) > flushAt) {
		w.send(string(w.buf))
		w.buf = w.buf[:0]
	}
	return len(p), nil
}

var _ = context.Background
var _ = wshub.NewEnvelope
