package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	

	"github.com/ks/ks-ssh/server/internal/sshlayer"
	"github.com/ks/ks-ssh/server/internal/store"
)

// hostJSON mirrors packages/types Host.
type hostJSON struct {
	ID             int64    `json:"id"`
	Name           string   `json:"name"`
	Hostname       string   `json:"hostname"`
	Port           int      `json:"port"`
	Username       string   `json:"username"`
	AuthType       string   `json:"authType"`
	GroupID        *int64   `json:"groupId"`
	Labels         []string `json:"labels"`
	Color          string   `json:"color"`
	JumpHostID     *int64   `json:"jumpHostId"`
	MaxSessions    int      `json:"maxSessions"`
	PreviewEnabled bool     `json:"previewEnabled"`
	LastUsedAt     *string  `json:"lastUsedAt"`
}

func hostToJSON(h *store.Host) hostJSON {
	var labels []string
	_ = json.Unmarshal([]byte(h.Labels), &labels)
	var last *string
	if h.LastUsedAt != nil {
		v := h.LastUsedAt.Format(time.RFC3339)
		last = &v
	}
	return hostJSON{
		ID: h.ID, Name: h.Name, Hostname: h.Hostname, Port: h.Port,
		Username: h.Username, AuthType: h.AuthType, GroupID: h.GroupID,
		Labels: labels, Color: h.Color, JumpHostID: h.JumpHostID,
		MaxSessions: h.MaxSessions, PreviewEnabled: h.PreviewEnabled,
		LastUsedAt: last,
	}
}

type hostInputReq struct {
	Name           string   `json:"name"`
	Hostname       string   `json:"hostname"`
	Port           int      `json:"port"`
	Username       string   `json:"username"`
	AuthType       string   `json:"authType"`
	Password       string   `json:"password,omitempty"`
	PrivateKey     string   `json:"privateKey,omitempty"`
	Passphrase     string   `json:"passphrase,omitempty"`
	GroupID        *int64   `json:"groupId"`
	Labels         []string `json:"labels"`
	Color          string   `json:"color"`
	JumpHostID     *int64   `json:"jumpHostId"`
	MaxSessions    int      `json:"maxSessions"`
	PreviewEnabled bool     `json:"previewEnabled"`
}

func (s *Server) normalizeHostInput(req *hostInputReq) (*store.HostInput, error) {
	in := &store.HostInput{
		Name: strings.TrimSpace(req.Name),
	}
	if req.Port == 0 {
		req.Port = 22
	}
	if req.MaxSessions <= 0 {
		req.MaxSessions = s.Cfg.MaxSessionsPerHost
	}
	labels := "[]"
	if len(req.Labels) > 0 {
		b, _ := json.Marshal(req.Labels)
		labels = string(b)
	}
	color := req.Color
	if color == "" {
		color = "#3b82f6"
	}
	in.Hostname = strings.TrimSpace(req.Hostname)
	in.Port = req.Port
	in.Username = strings.TrimSpace(req.Username)
	switch req.AuthType {
	case "password", "key", "key_passphrase", "agent":
	default:
		return nil, fmt.Errorf("authType must be password|key|key_passphrase|agent")
	}
	in.AuthType = req.AuthType
	if in.Name == "" || in.Hostname == "" || in.Username == "" {
		return nil, fmt.Errorf("name, hostname and username are required")
	}
	in.GroupID = req.GroupID
	in.Labels = labels
	in.Color = color
	in.JumpHostID = req.JumpHostID
	in.MaxSessions = req.MaxSessions
	in.PreviewEnabled = req.PreviewEnabled
	return in, nil
}

func (s *Server) storeCredentials(hostID int64, req *hostInputReq) error {
	pwEnc, keyEnc, passEnc := (*string)(nil), (*string)(nil), (*string)(nil)
	if req.Password != "" && req.AuthType == "password" {
		v, err := s.Box.SealedString(req.Password)
		if err != nil {
			return err
		}
		pwEnc = &v
	}
	if req.PrivateKey != "" && (req.AuthType == "key" || req.AuthType == "key_passphrase") {
		v, err := s.Box.SealedString(req.PrivateKey)
		if err != nil {
			return err
		}
		keyEnc = &v
	}
	if req.Passphrase != "" && req.AuthType == "key_passphrase" {
		v, err := s.Box.SealedString(req.Passphrase)
		if err != nil {
			return err
		}
		passEnc = &v
	}
	return s.St.SetCredential(hostID, pwEnc, keyEnc, passEnc)
}

func (s *Server) handleListHosts(w http.ResponseWriter, r *http.Request) {
	hosts, err := s.St.ListHosts()
	if err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	out := make([]hostJSON, 0, len(hosts))
	for _, h := range hosts {
		out = append(out, hostToJSON(h))
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleGetHost(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chiURLParam(r, "id"), 10, 64)
	h, err := s.St.GetHost(id)
	if err != nil {
		fail(w, 404, "not_found", "no such host")
		return
	}
	writeJSON(w, 200, hostToJSON(h))
}

func (s *Server) handleCreateHost(w http.ResponseWriter, r *http.Request) {
	var req hostInputReq
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	in, err := s.normalizeHostInput(&req)
	if err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	h, err := s.St.CreateHost(*in)
	if err != nil {
		fail(w, 409, "conflict", err.Error())
		return
	}
	if err := s.storeCredentials(h.ID, &req); err != nil {
		s.St.DeleteHost(h.ID)
		fail(w, 500, "internal", "credential encryption failed")
		return
	}
	s.audit(r, "host.create", h.Name, h.Hostname, "ok", "")
	writeJSON(w, 201, hostToJSON(h))
}

func (s *Server) handleUpdateHost(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chiURLParam(r, "id"), 10, 64)
	var req hostInputReq
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	in, err := s.normalizeHostInput(&req)
	if err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	h, err := s.St.UpdateHost(id, *in)
	if err != nil {
		fail(w, 404, "not_found", "no such host")
		return
	}
	if err := s.storeCredentials(h.ID, &req); err != nil {
		fail(w, 500, "internal", "credential encryption failed")
		return
	}
	s.audit(r, "host.update", h.Name, h.Hostname, "ok", "")
	writeJSON(w, 200, hostToJSON(h))
}

func (s *Server) handleDeleteHost(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chiURLParam(r, "id"), 10, 64)
	h, err := s.St.GetHost(id)
	if err != nil {
		fail(w, 404, "not_found", "no such host")
		return
	}
	s.SSH.Disconnect(id)
	if err := s.St.DeleteHost(id); err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	s.audit(r, "host.delete", h.Name, h.Hostname, "ok", "")
	writeJSON(w, 200, map[string]bool{"deleted": true})
}

// handleTestHost tests connectivity; supports unsaved credentials.
func (s *Server) handleTestHost(w http.ResponseWriter, r *http.Request) {
	var req struct {
		hostInputReq
		HostID int64 `json:"hostId,omitempty"` // test saved creds of existing host
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	var host *store.Host
	var credOverride *store.HostCredential
	if req.HostID > 0 && req.hostInputReq.Name == "" {
		h, err := s.St.GetHost(req.HostID)
		if err != nil {
			fail(w, 404, "not_found", "no such host")
			return
		}
		host = h
	} else {
		in, err := s.normalizeHostInput(&req.hostInputReq)
		if err != nil {
			fail(w, 400, "bad_request", err.Error())
			return
		}
		host = &store.Host{
			ID: 0, Name: in.Name, Hostname: in.Hostname, Port: in.Port,
			Username: in.Username, AuthType: in.AuthType,
			JumpHostID: in.JumpHostID, MaxSessions: in.MaxSessions,
		}
		if req.Password != "" || req.PrivateKey != "" || req.Passphrase != "" {
			credOverride = &store.HostCredential{HostID: 0}
			if req.Password != "" {
				v, err := s.Box.SealedString(req.Password)
				if err != nil {
					fail(w, 500, "internal", "encrypt failed")
					return
				}
				credOverride.PasswordEnc = &v
			}
			if req.PrivateKey != "" {
				v, err := s.Box.SealedString(req.PrivateKey)
				if err != nil {
					fail(w, 500, "internal", "encrypt failed")
					return
				}
				credOverride.PrivateKeyEnc = &v
			}
			if req.Passphrase != "" {
				v, err := s.Box.SealedString(req.Passphrase)
				if err != nil {
					fail(w, 500, "internal", "encrypt failed")
					return
				}
				credOverride.PassphraseEnc = &v
			}
		}
	}
	start := time.Now()
	_, derr := s.SSH.TestConnection(r.Context(), host, credOverride)
	res := map[string]any{"ok": derr == nil, "latencyMs": time.Since(start).Milliseconds()}
	if derr != nil {
		code := "error"
		var uk *sshlayer.UnknownHostKey
		var mm *sshlayer.HostKeyMismatch
		if asErr(derr, &uk) {
			code = "unknown_host"
			res["fingerprint"] = uk.Fingerprint
			res["keyType"] = uk.KeyType
		} else if asErr(derr, &mm) {
			code = "key_mismatch"
			res["fingerprint"] = mm.Fingerprint
			res["storedFingerprint"] = mm.StoredFingerpr
			res["keyType"] = mm.KeyType
		}
		res["error"] = derr.Error()
		res["code"] = code
	}
	writeJSON(w, 200, res)
}

// small errors.As helper avoiding import cycle noise.
func asErr[E error](err error, target *E) bool {
	for err != nil {
		if e, ok := err.(E); ok {
			*target = e
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}

func (s *Server) handleAcceptHostKey(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chiURLParam(r, "id"), 10, 64)
	var req struct {
		Fingerprint string `json:"fingerprint"`
		KeyType     string `json:"keyType"`
		PublicKey   string `json:"publicKey"`
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	if req.Fingerprint == "" || req.KeyType == "" {
		fail(w, 400, "bad_request", "fingerprint and keyType required")
		return
	}
	h, err := s.St.GetHost(id)
	if err != nil {
		fail(w, 404, "not_found", "no such host")
		return
	}
	if err := s.SSH.AcceptKey(id, req.KeyType, req.Fingerprint, req.PublicKey); err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	s.audit(r, "host.accept-key", h.Name, fmt.Sprintf("%s:%d", h.Hostname, h.Port), "ok", req.Fingerprint)
	writeJSON(w, 200, map[string]bool{"accepted": true})
}

func (s *Server) handleConnectHost(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chiURLParam(r, "id"), 10, 64)
	if _, err := s.SSH.Connect(id); err != nil {
		code := "error"
		msg := err.Error()
		var uk *sshlayer.UnknownHostKey
		var mm *sshlayer.HostKeyMismatch
		if asErr(err, &uk) {
			code = "unknown_host"
		} else if asErr(err, &mm) {
			code = "key_mismatch"
		}
		fail(w, http.StatusBadGateway, code, msg)
		return
	}
	go s.SSH.EnableReconnect(id)
	rtt, _ := s.SSH.PingRTT(id)
	writeJSON(w, 200, map[string]any{"connected": true, "latencyMs": rtt})
}

func (s *Server) handleDisconnectHost(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chiURLParam(r, "id"), 10, 64)
	s.SSH.Disconnect(id)
	writeJSON(w, 200, map[string]bool{"connected": false})
}

func (s *Server) handleHostStatuses(w http.ResponseWriter, r *http.Request) {
	hosts, err := s.St.ListHosts()
	if err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	out := map[string]any{}
	for _, h := range hosts {
		rtt, conn := s.SSH.PingRTT(h.ID)
		out[strconv.FormatInt(h.ID, 10)] = map[string]any{
			"connected": conn && s.SSH.IsConnected(h.ID),
			"rttMs":     rtt,
			"ptyCount":  s.SSH.ActivePTYCount(h.ID),
		}
	}
	writeJSON(w, 200, out)
}

func (s *Server) handlePing(w http.ResponseWriter, r *http.Request) {
	hostID := queryInt64(r, "hostId", 0)
	rtt, ok := s.SSH.PingRTT(hostID)
	writeJSON(w, 200, map[string]any{"rttMs": rtt, "connected": ok})
}

// ---- groups ----

func (s *Server) handleListGroups(w http.ResponseWriter, r *http.Request) {
	gs, err := s.St.ListGroups()
	if err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	out := make([]map[string]any, 0, len(gs))
	for _, g := range gs {
		out = append(out, map[string]any{"id": g.ID, "name": g.Name, "color": g.Color})
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleCreateGroup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name  string `json:"name"`
		Color string `json:"color"`
	}
	if err := decodeJSON(r, &req); err != nil || strings.TrimSpace(req.Name) == "" {
		fail(w, 400, "bad_request", "name required")
		return
	}
	if req.Color == "" {
		req.Color = "#ffffff"
	}
	g, err := s.St.CreateGroup(strings.TrimSpace(req.Name), req.Color)
	if err != nil {
		fail(w, 409, "conflict", err.Error())
		return
	}
	writeJSON(w, 201, g)
}

func (s *Server) handleDeleteGroup(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chiURLParam(r, "id"), 10, 64)
	if err := s.St.DeleteGroup(id); err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"deleted": true})
}

// ---- known hosts UI ----

func (s *Server) handleListKnownHosts(w http.ResponseWriter, r *http.Request) {
	type kh struct {
		ID          int64  `json:"id"`
		Hostname    string `json:"hostname"`
		Port        int    `json:"port"`
		KeyType     string `json:"keyType"`
		Fingerprint string `json:"fingerprint"`
		AddedAt     string `json:"addedAt"`
	}
	all, err := s.stAllKnownHosts()
	if err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	out := make([]kh, 0, len(all))
	for _, k := range all {
		out = append(out, kh{ID: k.ID, Hostname: k.Hostname, Port: k.Port,
			KeyType: k.KeyType, Fingerprint: k.Fingerprint,
			AddedAt: k.AddedAt.Format(time.RFC3339)})
	}
	writeJSON(w, 200, out)
}

func (s *Server) stAllKnownHosts() ([]*store.KnownHost, error) {
	hosts, err := s.St.ListHosts()
	if err != nil {
		return nil, err
	}
	var out []*store.KnownHost
	for _, h := range hosts {
		khs, err := s.St.ListKnownHosts(h.Hostname, h.Port)
		if err != nil {
			continue
		}
		out = append(out, khs...)
	}
	return out, nil
}

func (s *Server) handleDeleteKnownHost(w http.ResponseWriter, r *http.Request) {
	hostname := chiURLParam(r, "hostname")
	port, _ := strconv.Atoi(chiURLParam(r, "port"))
	khs, err := s.St.ListKnownHosts(hostname, port)
	if err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	for _, k := range khs {
		if err := s.St.DeleteKnownHost(k.ID); err != nil {
			fail(w, 500, "internal", err.Error())
			return
		}
	}
	s.audit(r, "known-host.delete", hostname+":"+chiURLParam(r, "port"), "-", "ok", "")
	writeJSON(w, 200, map[string]bool{"deleted": true})
}

// ---- ~/.ssh/config import ----

func (s *Server) handleImportSSHConfig(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ConfigText string `json:"configText,omitempty"`
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	text := req.ConfigText
	if text == "" {
		home, _ := os.UserHomeDir()
		b, err := os.ReadFile(filepath.Join(home, ".ssh", "config"))
		if err != nil {
			fail(w, 400, "bad_request", "~/.ssh/config unreadable on the KS SSH server: "+err.Error())
			return
		}
		text = string(b)
	}
	imported, skipped := parseSSHConfig(text, s.Cfg.MaxSessionsPerHost)
	created := []hostJSON{}
	for i := range imported {
		in := imported[i]
		existing, err := s.St.CreateHost(in)
		if err != nil {
			skipped++
			continue
		}
		created = append(created, hostToJSON(existing))
	}
	s.audit(r, "hosts.import-ssh-config", "-", "-", "ok", fmt.Sprintf("%d created, %d skipped", len(created), skipped))
	writeJSON(w, 200, map[string]any{"created": created, "skipped": skipped})
}

func parseSSHConfig(text string, defMax int) ([]store.HostInput, int) {
	var out []store.HostInput
	skipped := 0
	var cur *store.HostInput
	flush := func() {
		if cur != nil {
			if cur.Hostname != "" && cur.Username != "" {
				out = append(out, *cur)
			} else {
				skipped++
			}
		}
		cur = nil
	}
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		key := strings.ToLower(fields[0])
		val := fields[1]
		if key == "host" {
			flush()
			if strings.ContainsAny(val, "*?!") { // wildcard patterns — not a real host
				continue
			}
			cur = &store.HostInput{Name: val, Hostname: val, Port: 22, MaxSessions: defMax,
				Color: "#3b82f6", Labels: "[]"}
			continue
		}
		if cur == nil {
			continue
		}
		switch key {
		case "hostname":
			cur.Hostname = val
		case "port":
			p, err := strconv.Atoi(val)
			if err == nil {
				cur.Port = p
			}
		case "user":
			cur.Username = val
		}
	}
	flush()
	return out, skipped
}
