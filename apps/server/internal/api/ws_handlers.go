package api

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/ks/ks-ssh/server/internal/sftplayer"
	"github.com/ks/ks-ssh/server/internal/store"
	"github.com/ks/ks-ssh/server/internal/wshub"
)

func upgradeWS(w http.ResponseWriter, r *http.Request) (*wshub.Conn, error) {
	return wshub.Upgrade(w, r)
}

// handleTerminalWS serves the PTY protocol:
// client → pty.in | pty.resize | ws.ping | terminal.kill
// server → pty.attached | pty.out (seq'd replay+live) | ws.pong
func (s *Server) handleTerminalWS(w http.ResponseWriter, r *http.Request) {
	hostID := queryInt64(r, "host", 0)
	sessionID := r.URL.Query().Get("session")
	fromSeq := queryInt64(r, "from", 0)
	cols := int(queryInt64(r, "cols", 120))
	rows := int(queryInt64(r, "rows", 40))
	cl := claimsOf(r)
	if sessionID == "" || hostID <= 0 {
		fail(w, http.StatusBadRequest, "bad_request", "host and session required")
		return
	}
	sanitized := sanitizeSession(sessionID)
	c, err := s.SSH.Connect(hostID)
	if err != nil {
		msg := err.Error()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte(`{"error":` + strconv.Quote(msg) + `}`))
		return
	}
	go s.SSH.EnableReconnect(hostID)

	host, _ := s.St.GetHost(hostID)
	maxSessions := s.Cfg.MaxSessionsPerHost
	if host != nil && host.MaxSessions > 0 {
		maxSessions = host.MaxSessions
	}

	conn, err := upgradeWS(w, r)
	if err != nil {
		slog.Warn("ws upgrade failed", "path", r.URL.Path, "err", err)
		return
	}

	sess, ok := s.Registry.Get(sanitized)
	if !ok {
		if s.SSH.ActivePTYCount(hostID) >= maxSessions {
			_ = conn.Send("pty.error", map[string]string{"error": "per-host session limit reached"})
			conn.Close()
			return
		}
		sess = wshub.NewPtySession(sanitized, hostID, cl.Name)
		if err := s.startPTY(sess, c, cols, rows); err != nil {
			_ = conn.Send("pty.error", map[string]string{"error": err.Error()})
			conn.Close()
			return
		}
		s.Registry.Add(sess)
		hostName := "-"
		if host != nil {
			hostName = host.Name
		}
		s.recordSessionStart(sanitized, cl.Name, hostName)
	}
	sess.Attach(conn, fromSeq)
	defer sess.Detach(conn)

	for {
		env, rerr := conn.Read()
		if rerr != nil {
			return // browser gone; PTY keeps running server-side
		}
		switch env.Type {
		case "pty.in":
			var p struct {
				Data string `json:"data"`
			}
			if err := jsonDecodeBytes(env.Payload, &p); err == nil {
				_ = sess.Input([]byte(p.Data))
				s.appendShellHistory(cl.Name, hostID, p.Data)
			}
		case "pty.resize":
			var p struct {
				Cols int `json:"cols"`
				Rows int `json:"rows"`
			}
			if err := jsonDecodeBytes(env.Payload, &p); err == nil {
				_ = sess.Resize(p.Cols, p.Rows)
			}
		case "ws.ping":
			_ = conn.Send("ws.pong", map[string]int64{"rttMs": c.LastRTT()})
		case "terminal.kill":
			sess.Close()
			s.Registry.Remove(sanitized)
			_ = s.St.EndSession(sanitized)
			return
		}
	}
}

func sanitizeSession(id string) string {
	out := make([]rune, 0, len(id))
	for _, ch := range id {
		switch {
		case ch >= 'a' && ch <= 'z', ch >= 'A' && ch <= 'Z',
			ch >= '0' && ch <= '9', ch == '-', ch == '_':
			out = append(out, ch)
		default:
			out = append(out, '-')
		}
	}
	if len(out) == 0 {
		out = []rune("term")
	}
	if len(out) > 64 {
		out = out[:64]
	}
	return string(out)
}

// startPTY wires an ssh session+PTY into a wshub.PtySession.
func (s *Server) startPTY(sess *wshub.PtySession, client interface {
	Session(bool) (*ssh.Session, error)
	ReleaseSession()
}, cols, rows int) error {
	sshSess, err := client.Session(false)
	if err != nil {
		return err
	}
	stdinR, stdinW := io.Pipe()
	stdoutW := &sessWriter{sess: sess}
	sshSess.Stdin = stdinR
	sshSess.Stdout = stdoutW
	sshSess.Stderr = stdoutW
	_ = sshSess.Setenv("TERM", "xterm-256color")
	_ = sshSess.Setenv("LANG", "en_US.UTF-8")
	if err := sshSess.RequestPty("xterm-256color", rows, cols, ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 115200,
		ssh.TTY_OP_OSPEED: 115200,
	}); err != nil {
		sshSess.Close()
		client.ReleaseSession()
		return err
	}
	sess.WriteFn(func(b []byte) { _, _ = stdinW.Write(b) })
	sess.ResizeFn(func(ccols, crows int) error { return sshSess.WindowChange(crows, ccols) })
	sess.CloseFn(func() {
		_ = sshSess.Signal(ssh.SIGKILL)
		sshSess.Close()
		stdinW.Close()
	})

	go func() {
		_ = sshSess.Shell()
		time.Sleep(200 * time.Millisecond) // let trailing output flush into the ring
		sess.Close()
		s.Registry.Remove(sess.ID)
	}()

	recordingOn := false
	if v, ok, gerr := s.St.GetSetting("recordingEnabled"); gerr == nil && ok {
		recordingOn = v == "true"
	}
	if recordingOn {
		dir := filepath.Join(s.Cfg.DataDir, "recordings")
		if rerr := sess.StartRecording(dir); rerr == nil {
			file := filepath.Base(strings.SplitN(dir, "/recordings", 2)[0])
			_, _ = file, dir
			if id, aerr := s.St.AddRecording("rec:"+sess.ID, sess.HostID, sess.ID+".cast"); aerr == nil {
				go func() {
					t := time.NewTicker(5 * time.Second)
					defer t.Stop()
					for range t.C {
						dur, size := sess.RecMeta()
						if sess.Closed() {
							_ = s.St.FinishRecording(id, dur, size)
							return
						}
					}
				}()
			}
		} else {
			slog.Warn("recording start failed", "err", rerr)
		}
	}
	return nil
}

// sessWriter forwards PTY output into the session ring buffer.
type sessWriter struct {
	sess *wshub.PtySession
	mu   sync.Mutex
}

func (w *sessWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.sess.Write(p)
	return len(p), nil
}

func (s *Server) recordSessionStart(token, username, hostName string) {
	if _, err := s.St.StartSession(token, username, hostName, "pty"); err != nil {
		slog.Debug("session audit start failed", "err", err)
	}
}

// appendShellHistory stores per-session command lines (best effort).
func (s *Server) appendShellHistory(user string, hostID int64, input string) {
	input = strings.TrimRight(input, "\n\r\t ")
	if input == "" || strings.ContainsAny(input, "\t") {
		return
	}
	key := fmt.Sprintf("history:%d:%s", hostID, user)
	list := []string{}
	if v, ok, err := s.St.GetSetting(key); err == nil && ok {
		_ = jsonDecodeBytes([]byte(v), &list)
	}
	list = append(list, input)
	if len(list) > 500 {
		list = list[len(list)-500:]
	}
	b, _ := jsonMarshal(list)
	_ = s.St.SetSetting(key, string(b))
}

// handleFilesWS: chunked uploads with checksum + resume + progress + URL fetch.
func (s *Server) handleFilesWS(w http.ResponseWriter, r *http.Request) {
	hostID := queryInt64(r, "host", 0)
	c, err := s.SSH.Get(hostID)
	if err != nil {
		fail(w, http.StatusBadGateway, "offline", "host not connected")
		return
	}
	conn, err := upgradeWS(w, r)
	if err != nil {
		return
	}
	defer conn.Close()

	for {
		env, rerr := conn.Read()
		if rerr != nil {
			return
		}
		switch env.Type {
		case "transfer.begin":
			var p struct {
				TransferID string `json:"transferId"`
				Dir        string `json:"dir"`
				Name       string `json:"name"`
				Size       int64  `json:"size"`
			}
			if err := jsonDecodeBytes(env.Payload, &p); err != nil {
				continue
			}
			nextIdx, berr := s.Uploads.Begin(c, p.TransferID, p.Dir, p.Name, p.Size)
			if berr != nil {
				_ = conn.Send("transfer.error", map[string]any{
					"transferId": p.TransferID, "error": berr.Error()})
				continue
			}
			_ = s.St.UpsertTransfer(&store.Transfer{
				ID: p.TransferID, HostID: hostID, Kind: "upload",
				Path: p.Dir, Name: p.Name, Size: p.Size, Status: "active",
			})
			_ = conn.Send("transfer.ready", map[string]any{
				"transferId": p.TransferID, "resumeFromChunk": nextIdx})
		case "transfer.chunk":
			var p struct {
				TransferID string `json:"transferId"`
				Index      int64  `json:"index"`
				DataB64    string `json:"dataBase64"`
				Checksum   string `json:"checksum"`
				Final      bool   `json:"final"`
			}
			if err := jsonDecodeBytes(env.Payload, &p); err != nil {
				continue
			}
			data, derr := base64.StdEncoding.DecodeString(p.DataB64)
			if derr != nil {
				_ = conn.Send("transfer.ack", map[string]any{
					"transferId": p.TransferID, "index": p.Index, "ok": false, "error": "bad base64"})
				continue
			}
			sum := sha256.Sum256(data)
			if hex.EncodeToString(sum[:]) != strings.ToLower(p.Checksum) {
				_ = conn.Send("transfer.ack", map[string]any{
					"transferId": p.TransferID, "index": p.Index, "ok": false, "error": "checksum mismatch"})
				continue
			}
			if werr := s.Uploads.WriteChunk(p.TransferID, p.Index, data, ""); werr != nil {
				_ = conn.Send("transfer.ack", map[string]any{
					"transferId": p.TransferID, "index": p.Index, "ok": false, "error": werr.Error()})
				continue
			}
			_ = conn.Send("transfer.ack", map[string]any{
				"transferId": p.TransferID, "index": p.Index, "ok": true})
			if p.Final {
				if ferr := s.Uploads.Finish(p.TransferID, 0); ferr != nil {
					_ = conn.Send("transfer.error", map[string]any{
						"transferId": p.TransferID, "error": ferr.Error()})
					continue
				}
				_ = conn.Send("transfer.done", map[string]any{"transferId": p.TransferID})
			}
		case "transfer.abort":
			var p struct {
				TransferID string `json:"transferId"`
			}
			if err := jsonDecodeBytes(env.Payload, &p); err == nil {
				_ = s.Uploads.Abort(p.TransferID)
				_ = conn.Send("transfer.aborted", map[string]any{"transferId": p.TransferID})
			}
		case "url.upload":
			var p struct {
				URL string `json:"url"`
				Dir string `json:"dir"`
			}
			if err := jsonDecodeBytes(env.Payload, &p); err != nil {
				continue
			}
			tid := "url-" + shortHash(p.URL)
			c2, gerr := s.SSH.Get(hostID)
			if gerr != nil {
				continue
			}
			final, ferr := sftplayer.New(c2).FetchFromURL(context.Background(), s.St, p.URL, p.Dir, func(n int64) {
				_ = conn.Send("transfer.progress", map[string]any{
					"transferId": tid, "transferred": n, "kind": "url-upload"})
			})
			if ferr != nil {
				_ = conn.Send("transfer.error", map[string]any{
					"transferId": tid, "error": ferr.Error()})
				continue
			}
			s.audit(r, "file.url-upload", p.URL+" → "+final, strconv.FormatInt(hostID, 10), "ok", "")
			_ = conn.Send("transfer.done", map[string]any{"transferId": tid, "path": final})
		}
	}
}

func shortHash(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:8])
}

var _ = slog.Info
