package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ks/ks-ssh/server/internal/monitor"
)

func (s *Server) handleSysInfo(w http.ResponseWriter, r *http.Request) {
	hostID := queryHost(r)
	c, err := s.SSH.Get(hostID)
	if err != nil {
		fail(w, http.StatusBadGateway, "offline", "host offline")
		return
	}
	info, err := monitor.GetSystemInfo(r.Context(), c)
	if err != nil {
		fail(w, http.StatusBadGateway, "info", err.Error())
		return
	}
	writeJSON(w, 200, info)
}

func (s *Server) handleTopProcs(w http.ResponseWriter, r *http.Request) {
	hostID := queryHost(r)
	limit := queryInt(r, "limit", 20)
	c, err := s.SSH.Get(hostID)
	if err != nil {
		fail(w, http.StatusBadGateway, "offline", "host offline")
		return
	}
	rows, err := monitor.TopProcesses(r.Context(), c, limit)
	if err != nil {
		fail(w, http.StatusBadGateway, "ps", err.Error())
		return
	}
	writeJSON(w, 200, rows)
}

// handleMonitorWS streams 1 Hz samples; sends in-memory window (1 h @ 1 s) first.
func (s *Server) handleMonitorWS(w http.ResponseWriter, r *http.Request) {
	hostID := queryHost(r)
	c, err := s.SSH.Get(hostID)
	if err != nil {
		fail(w, http.StatusBadGateway, "offline", "host offline")
		return
	}
	conn, err := upgradeWS(w, r)
	if err != nil {
		return
	}
	defer conn.Close()
	ms := s.monitorFor(hostID, func() *monitor.Collector { return monitor.NewCollector(c) })

	for _, sm := range ms.window() {
		_ = conn.Send("monitor.sample", sm)
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, err := conn.Read(); err != nil { // drain reads to detect close
				return
			}
		}
	}()

	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-done:
			return
		case <-tick.C:
		}
		sm, err := ms.col.Sample(r.Context())
		if err != nil {
			_ = conn.Send("monitor.error", map[string]string{"error": err.Error()})
			continue
		}
		ms.push(*sm)
		if err := conn.Send("monitor.sample", sm); err != nil {
			return
		}
	}
}

// ---- snippets ----

func (s *Server) handleSnippetList(w http.ResponseWriter, r *http.Request) {
	list, err := s.St.ListSnippets()
	if err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, sn := range list {
		row := map[string]any{
			"id": sn.ID, "name": sn.Name, "command": sn.Command,
			"dangerous": isDangerous(sn.Command),
			"createdAt": sn.CreatedAt.Format(time.RFC3339),
			"hostId":    (*int64)(nil),
		}
		if sn.HostID != nil {
			row["hostId"] = *sn.HostID
		}
		out = append(out, row)
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleSnippetCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name    string `json:"name"`
		Command string `json:"command"`
		HostID  *int64 `json:"hostId"`
	}
	if err := decodeJSON(r, &req); err != nil || strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.Command) == "" {
		fail(w, 400, "bad_request", "name and command required")
		return
	}
	sn, err := s.St.CreateSnippet(strings.TrimSpace(req.Name), strings.TrimSpace(req.Command), req.HostID)
	if err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	writeJSON(w, 201, map[string]any{"id": sn.ID})
}

func (s *Server) handleSnippetUpdate(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chiURLParam(r, "id"), 10, 64)
	var req struct {
		Name    string `json:"name"`
		Command string `json:"command"`
		HostID  *int64 `json:"hostId"`
	}
	if err := decodeJSON(r, &req); err != nil || strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.Command) == "" {
		fail(w, 400, "bad_request", "name and command required")
		return
	}
	if err := s.St.UpdateSnippet(id, strings.TrimSpace(req.Name), strings.TrimSpace(req.Command), req.HostID); err != nil {
		fail(w, 404, "not_found", "no such snippet")
		return
	}
	writeJSON(w, 200, map[string]bool{"updated": true})
}

func (s *Server) handleSnippetDelete(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chiURLParam(r, "id"), 10, 64)
	if err := s.St.DeleteSnippet(id); err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"deleted": true})
}

// dangerousPatterns are flagged pre-run (plan §2.8).
var dangerousPatterns = []string{
	"rm -rf /", "rm -rf /*", "mkfs", ":(){:|:&};:", "dd if=", "> /dev/sda",
	"chmod -R 777 /", "shutdown", "reboot", "halt", "init 0", "init 6",
	"wget -O- | sh", "curl | sh", "curl -fssl | sh",
}

func isDangerous(cmd string) bool {
	lc := strings.ToLower(cmd)
	for _, p := range dangerousPatterns {
		if strings.Contains(lc, strings.ToLower(p)) {
			return true
		}
	}
	return false
}

var _ = json.Marshal
