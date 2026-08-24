package api

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/ks/ks-ssh/server/internal/store"
)

// ---- sessions & audit ----

func (s *Server) handleSessionList(w http.ResponseWriter, r *http.Request) {
	limit := queryInt(r, "limit", 100)
	list, err := s.St.ListSessions(limit)
	if err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, sr := range list {
		row := map[string]any{
			"id": sr.ID, "username": sr.Username, "hostName": sr.HostName,
			"kind": sr.Kind, "startedAt": sr.StartedAt.Format(timeFmt),
		}
		if sr.EndedAt != nil {
			row["endedAt"] = sr.EndedAt.Format(timeFmt)
		}
		out = append(out, row)
	}
	writeJSON(w, 200, out)
}

const timeFmt = "2006-01-02T15:04:05Z07:00"

func (s *Server) handleAuditList(w http.ResponseWriter, r *http.Request) {
	limit := queryInt(r, "limit", 200)
	list, err := s.St.ListAudit(limit)
	if err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, a := range list {
		out = append(out, map[string]any{
			"id": a.ID, "username": a.Username, "action": a.Action,
			"target": a.Target, "hostName": a.HostName, "result": a.Result,
			"detail": a.Detail, "at": a.At.Format(timeFmt),
		})
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleAuditExport(w http.ResponseWriter, r *http.Request) {
	format := r.URL.Query().Get("format")
	list, err := s.St.ListAudit(10000)
	if err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	switch format {
	case "csv":
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", "attachment; filename=ks-ssh-audit.csv")
		cw := csv.NewWriter(w)
		_ = cw.Write([]string{"id", "username", "action", "target", "hostName", "result", "detail", "at"})
		for _, a := range list {
			_ = cw.Write([]string{strconv.FormatInt(a.ID, 10), a.Username, a.Action,
				a.Target, a.HostName, a.Result, a.Detail, a.At.Format(timeFmt)})
		}
		cw.Flush()
	default:
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Disposition", "attachment; filename=ks-ssh-audit.json")
		recs := make([]map[string]any, 0, len(list))
		for _, a := range list {
			recs = append(recs, map[string]any{
				"id": a.ID, "username": a.Username, "action": a.Action,
				"target": a.Target, "hostName": a.HostName, "result": a.Result,
				"detail": a.Detail, "at": a.At.Format(timeFmt)})
		}
		_ = json.NewEncoder(w).Encode(recs)
	}
	s.audit(r, "audit.export", format, "-", "ok", fmt.Sprintf("%d rows", len(list)))
}

// ---- recordings ----

func (s *Server) handleRecordingsList(w http.ResponseWriter, r *http.Request) {
	list, err := s.St.ListRecordings()
	if err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	hosts := map[int64]string{}
	if hs, herr := s.St.ListHosts(); herr == nil {
		for _, h := range hs {
			hosts[h.ID] = h.Name
		}
	}
	out := make([]map[string]any, 0, len(list))
	for _, rec := range list {
		out = append(out, map[string]any{
			"id": rec.ID, "sessionId": rec.SessionToken, "hostName": hosts[rec.HostID],
			"startedAt": rec.StartedAt.Format(timeFmt), "durationSec": rec.DurationSec,
			"sizeBytes": rec.SizeBytes,
		})
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleRecordingFile(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chiURLParam(r, "id"), 10, 64)
	list, err := s.St.ListRecordings()
	if err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	var target *store.Recording
	for _, rec := range list {
		if rec.ID == id {
			target = rec
			break
		}
	}
	if target == nil {
		fail(w, 404, "not_found", "no such recording")
		return
	}
	http.ServeFile(w, r, s.recordingPath(target.File))
}

func (s *Server) recordingPath(file string) string {
	return s.Cfg.DataDir + "/recordings/" + sanitizeSession(file)
}

// ---- settings ----

var defaultSettings = map[string]string{
	"theme":               "dark",
	"accentColor":         "#3b82f6",
	"terminalTheme":       "ks-dark",
	"fontSize":            "14",
	"keyBarDefault":       "true",
	"autoSaveEditor":      "false",
	"recordingEnabled":    "false",
	"enablePreviewDefault": "false",
	"keepBackupVersions":  "10",
}

func (s *Server) handleSettingsGet(w http.ResponseWriter, r *http.Request) {
	all, err := s.St.AllSettings()
	if err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	out := map[string]string{}
	for k, v := range defaultSettings {
		out[k] = v
	}
	for k, v := range all {
		if strings.HasPrefix(k, "recent:") || strings.HasPrefix(k, "history:") {
			continue
		}
		out[k] = v
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleSettingsPut(w http.ResponseWriter, r *http.Request) {
	var req map[string]string
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	saved := 0
	for k, v := range req {
		if strings.Contains(k, ":") { // reserved namespaces not writable here
			continue
		}
		if k == "" || len(v) > 4096 {
			continue
		}
		if err := s.St.SetSetting(k, v); err != nil {
			fail(w, 500, "internal", err.Error())
			return
		}
		saved++
	}
	s.audit(r, "settings.update", "-", "-", "ok", strconv.Itoa(saved))
	writeJSON(w, 200, map[string]bool{"saved": true})
}

// handleHostSessions lists live server-side PTY session ids for a host
// (used by the frontend for hot-exit workspace restore).
func (s *Server) handleHostSessions(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chiURLParam(r, "id"), 10, 64)
	if _, err := s.St.GetHost(id); err != nil {
		fail(w, 404, "not_found", "no such host")
		return
	}
	out := []map[string]any{}
	for _, ps := range s.Registry.ByHost(id) {
		out = append(out, map[string]any{
			"sessionId": ps.ID, "viewers": ps.ViewerCount(), "lastUsed": ps.LastUsed(),
		})
	}
	writeJSON(w, 200, out)
}
