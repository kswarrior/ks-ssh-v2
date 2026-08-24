package api

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ks/ks-ssh/server/internal/execx"
)

// ---- git ----

func (s *Server) gitDir(r *http.Request) (int64, string, bool, error) {
	hostID := queryHost(r)
	dir := r.URL.Query().Get("dir")
	if dir == "" {
		return 0, "", false, fmt.Errorf("dir required")
	}
	c, err := s.SSH.Get(hostID)
	if err != nil {
		return 0, "", false, fmt.Errorf("host offline")
	}
	return hostID, dir, c != nil, nil
}

func (s *Server) handleGitStatus(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HostID int64  `json:"hostId"`
		Dir    string `json:"dir"`
	}
	if r.Method == http.MethodPost {
		if err := decodeJSON(r, &req); err != nil {
			fail(w, 400, "bad_request", err.Error())
			return
		}
	} else {
		req.HostID = queryHost(r)
		req.Dir = r.URL.Query().Get("dir")
	}
	c, err := s.SSH.Get(req.HostID)
	if err != nil {
		fail(w, http.StatusBadGateway, "offline", "host offline")
		return
	}
	st, err := execx.GitStatus(r.Context(), c, req.Dir)
	if err != nil {
		fail(w, http.StatusBadGateway, "git", err.Error())
		return
	}
	writeJSON(w, 200, st)
}

func gitActionBody(w http.ResponseWriter, r *http.Request) (*struct {
	HostID int64    `json:"hostId"`
	Dir    string   `json:"dir"`
	Paths  []string `json:"paths,omitempty"`
}, error) {
	var req struct {
		HostID int64    `json:"hostId"`
		Dir    string   `json:"dir"`
		Paths  []string `json:"paths,omitempty"`
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return nil, err
	}
	return &req, nil
}

func (s *Server) handleGitStage(w http.ResponseWriter, r *http.Request) {
	req, err := gitActionBody(w, r)
	if err != nil || req == nil {
		return
	}
	c, gerr := s.SSH.Get(req.HostID)
	if gerr != nil {
		fail(w, http.StatusBadGateway, "offline", "host offline")
		return
	}
	if err := execx.GitStage(r.Context(), c, req.Dir, req.Paths); err != nil {
		fail(w, http.StatusBadGateway, "git", err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleGitUnstage(w http.ResponseWriter, r *http.Request) {
	req, err := gitActionBody(w, r)
	if err != nil || req == nil {
		return
	}
	c, gerr := s.SSH.Get(req.HostID)
	if gerr != nil {
		fail(w, http.StatusBadGateway, "offline", "host offline")
		return
	}
	if err := execx.GitUnstage(r.Context(), c, req.Dir, req.Paths); err != nil {
		fail(w, http.StatusBadGateway, "git", err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleGitCommit(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HostID   int64  `json:"hostId"`
		Dir      string `json:"dir"`
		Message  string `json:"message"`
	}
	if err := decodeJSON(r, &req); err != nil || strings.TrimSpace(req.Message) == "" {
		fail(w, 400, "bad_request", "message required")
		return
	}
	c, gerr := s.SSH.Get(req.HostID)
	if gerr != nil {
		fail(w, http.StatusBadGateway, "offline", "host offline")
		return
	}
	if err := execx.GitCommit(r.Context(), c, req.Dir, req.Message); err != nil {
		fail(w, http.StatusBadGateway, "git", err.Error())
		return
	}
	s.audit(r, "git.commit", req.Dir, strconv.FormatInt(req.HostID, 10), "ok", req.Message)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleGitLog(w http.ResponseWriter, r *http.Request) {
	hostID := queryHost(r)
	dir := r.URL.Query().Get("dir")
	limit := queryInt(r, "limit", 50)
	c, err := s.SSH.Get(hostID)
	if err != nil {
		fail(w, http.StatusBadGateway, "offline", "host offline")
		return
	}
	log, gerr := execx.GitLog(r.Context(), c, dir, limit)
	if gerr != nil {
		fail(w, http.StatusBadGateway, "git", gerr.Error())
		return
	}
	writeJSON(w, 200, log)
}

func (s *Server) handleGitBranches(w http.ResponseWriter, r *http.Request) {
	hostID := queryHost(r)
	dir := r.URL.Query().Get("dir")
	c, err := s.SSH.Get(hostID)
	if err != nil {
		fail(w, http.StatusBadGateway, "offline", "host offline")
		return
	}
	branches, gerr := execx.GitBranches(r.Context(), c, dir)
	if gerr != nil {
		fail(w, http.StatusBadGateway, "git", gerr.Error())
		return
	}
	writeJSON(w, 200, branches)
}

func (s *Server) handleGitSwitch(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HostID int64  `json:"hostId"`
		Dir    string `json:"dir"`
		Branch string `json:"branch"`
	}
	if err := decodeJSON(r, &req); err != nil || strings.TrimSpace(req.Branch) == "" {
		fail(w, 400, "bad_request", "branch required")
		return
	}
	c, gerr := s.SSH.Get(req.HostID)
	if gerr != nil {
		fail(w, http.StatusBadGateway, "offline", "host offline")
		return
	}
	if err := execx.GitSwitch(r.Context(), c, req.Dir, req.Branch); err != nil {
		fail(w, http.StatusBadGateway, "git", err.Error())
		return
	}
	s.audit(r, "git.switch", req.Branch+" in "+req.Dir, strconv.FormatInt(req.HostID, 10), "ok", "")
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleGitAction(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HostID int64  `json:"hostId"`
		Dir    string `json:"dir"`
		Action string `json:"action"` // push | pull
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	c, gerr := s.SSH.Get(req.HostID)
	if gerr != nil {
		fail(w, http.StatusBadGateway, "offline", "host offline")
		return
	}
	out, aerr := execx.GitPushPull(r.Context(), c, req.Dir, req.Action)
	if aerr != nil {
		s.audit(r, "git."+req.Action, req.Dir, strconv.FormatInt(req.HostID, 10), "failed", aerr.Error())
		fail(w, http.StatusBadGateway, "git", aerr.Error())
		return
	}
	s.audit(r, "git."+req.Action, req.Dir, strconv.FormatInt(req.HostID, 10), "ok", "")
	writeJSON(w, 200, map[string]string{"output": out})
}

// ---- docker ----

func (s *Server) handleDockerPS(w http.ResponseWriter, r *http.Request) {
	hostID := queryHost(r)
	c, err := s.SSH.Get(hostID)
	if err != nil {
		fail(w, http.StatusBadGateway, "offline", "host offline")
		return
	}
	cs, derr := execx.DockerPS(r.Context(), c)
	if derr != nil {
		fail(w, http.StatusBadGateway, "docker", derr.Error())
		return
	}
	writeJSON(w, 200, cs)
}

func (s *Server) handleDockerAction(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HostID int64  `json:"hostId"`
		ID     string `json:"id"`
		Action string `json:"action"` // start|stop|restart
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	c, gerr := s.SSH.Get(req.HostID)
	if gerr != nil {
		fail(w, http.StatusBadGateway, "offline", "host offline")
		return
	}
	out, aerr := execx.DockerAction(r.Context(), c, req.Action, req.ID)
	if aerr != nil {
		s.audit(r, "docker."+req.Action, req.ID, strconv.FormatInt(req.HostID, 10), "failed", aerr.Error())
		fail(w, http.StatusBadGateway, "docker", aerr.Error())
		return
	}
	s.audit(r, "docker."+req.Action, req.ID, strconv.FormatInt(req.HostID, 10), "ok", "")
	writeJSON(w, 200, map[string]string{"output": out})
}

// ---- services ----

func (s *Server) handleServicesList(w http.ResponseWriter, r *http.Request) {
	hostID := queryHost(r)
	c, err := s.SSH.Get(hostID)
	if err != nil {
		fail(w, http.StatusBadGateway, "offline", "host offline")
		return
	}
	units, serr := execx.ListUnits(r.Context(), c)
	if serr != nil {
		fail(w, http.StatusBadGateway, "systemd", serr.Error())
		return
	}
	writeJSON(w, 200, units)
}

func (s *Server) handleServiceAction(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HostID int64  `json:"hostId"`
		Unit   string `json:"unit"`
		Action string `json:"action"`
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	c, gerr := s.SSH.Get(req.HostID)
	if gerr != nil {
		fail(w, http.StatusBadGateway, "offline", "host offline")
		return
	}
	out, aerr := execx.ServiceAction(r.Context(), c, req.Unit, req.Action)
	if aerr != nil {
		s.audit(r, "service."+req.Action, req.Unit, strconv.FormatInt(req.HostID, 10), "failed", aerr.Error())
		fail(w, http.StatusBadGateway, "systemctl", aerr.Error())
		return
	}
	s.audit(r, "service."+req.Action, req.Unit, strconv.FormatInt(req.HostID, 10), "ok", "")
	writeJSON(w, 200, map[string]string{"output": out})
}

// ---- cron ----

func (s *Server) handleCronRead(w http.ResponseWriter, r *http.Request) {
	hostID := queryHost(r)
	user := r.URL.Query().Get("user")
	c, err := s.SSH.Get(hostID)
	if err != nil {
		fail(w, http.StatusBadGateway, "offline", "host offline")
		return
	}
	lines, cerr := execx.CronRead(r.Context(), c, user)
	if cerr != nil {
		fail(w, http.StatusBadGateway, "cron", cerr.Error())
		return
	}
	out := make([]map[string]any, 0, len(lines))
	for _, ln := range lines {
		comment := strings.HasPrefix(strings.TrimSpace(ln), "#")
		out = append(out, map[string]any{"line": ln, "comment": comment})
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleCronWrite(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HostID int64    `json:"hostId"`
		User   string   `json:"user"`
		Lines  []string `json:"lines"`
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	c, gerr := s.SSH.Get(req.HostID)
	if gerr != nil {
		fail(w, http.StatusBadGateway, "offline", "host offline")
		return
	}
	if err := execx.CronWrite(r.Context(), c, req.User, req.Lines); err != nil {
		s.audit(r, "cron.write", "user="+orDash(req.User), strconv.FormatInt(req.HostID, 10), "failed", err.Error())
		fail(w, http.StatusBadGateway, "cron", err.Error())
		return
	}
	s.audit(r, "cron.write", "user="+orDash(req.User), strconv.FormatInt(req.HostID, 10), "ok",
		fmt.Sprintf("%d lines", len(req.Lines)))
	writeJSON(w, 200, map[string]bool{"saved": true})
}

func orDash(u string) string {
	if u == "" {
		return "-"
	}
	return u
}

var _ = context.Background
var _ = time.Now
var _ sync.Mutex
