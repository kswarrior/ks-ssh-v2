package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/ks/ks-ssh/server/internal/sftplayer"
)

// maxInlineFile is the largest file served inline to the editor (>2 MB opens read-only).
const maxInlineFile = 2 << 20

func langOf(name string, head []byte) string {
	base := strings.ToLower(filepath.Base(name))
	switch base {
	case "dockerfile":
		return "dockerfile"
	case "makefile":
		return "makefile"
	}
	ext := strings.TrimPrefix(strings.ToLower(path.Ext(name)), ".")
	switch ext {
	case "js", "mjs", "cjs", "jsx":
		return "javascript"
	case "ts", "mts", "tsx":
		return "typescript"
	case "py":
		return "python"
	case "go":
		return "go"
	case "json":
		return "json"
	case "yml", "yaml":
		return "yaml"
	case "html", "htm":
		return "html"
	case "css":
		return "css"
	case "scss", "sass":
		return "scss"
	case "sh", "bash", "zsh", "env":
		return "shell"
	case "md", "markdown":
		return "markdown"
	case "sql":
		return "sql"
	case "rs":
		return "rust"
	case "java":
		return "java"
	case "c", "h":
		return "c"
	case "cpp", "cc", "hpp":
		return "cpp"
	case "php":
		return "php"
	case "rb":
		return "ruby"
	case "xml", "svg":
		return "xml"
	case "csv":
		return "plaintext"
	case "toml", "ini", "conf", "cfg", "service":
		return "ini"
	case "log":
		return "log"
	default:
		if len(head) > 0 && head[0] == '#' && bytes.Contains(head, []byte("sh")) {
			return "shell"
		}
		return "plaintext"
	}
}

func (s *Server) handleEditorOpen(w http.ResponseWriter, r *http.Request) {
	hostID := queryHost(r)
	p := r.URL.Query().Get("path")
	ops, ok := hostClientFor(w, r, s, hostID)
	if !ok {
		return
	}
	st, err := ops.Stat(p)
	if err != nil {
		fail(w, http.StatusBadGateway, "sftp", err.Error())
		return
	}
	if st.IsDir {
		fail(w, 400, "bad_request", "cannot open a directory in the editor")
		return
	}
	f, err := ops.OpenRead(p)
	if err != nil {
		fail(w, http.StatusBadGateway, "sftp", err.Error())
		return
	}
	defer f.Close()
	readOnly := st.Size > maxInlineFile
	limit := int64(maxInlineFile + (1 << 20))
	buf := make([]byte, 0, 64*1024)
	tmp := make([]byte, 64*1024)
	var total int64
	for total < limit {
		n, rerr := f.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
			total += int64(n)
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			fail(w, http.StatusBadGateway, "sftp", rerr.Error())
			return
		}
	}
	writeJSON(w, 200, map[string]any{
		"path":     p,
		"content":  string(buf),
		"language": langOf(st.Name, buf),
		"size":     st.Size,
		"readOnly": readOnly,
		"mtimeMs":  st.ModTime.UnixMilli(),
	})
}

func (s *Server) handleEditorSave(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HostID          int64  `json:"hostId"`
		Path            string `json:"path"`
		Content         string `json:"content"`
		ExpectedMtimeMs int64  `json:"expectedMtimeMs"`
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	ops, ok := hostClientFor(w, r, s, req.HostID)
	if !ok {
		return
	}
	st, err := ops.Stat(req.Path)
	if err != nil {
		fail(w, http.StatusBadGateway, "sftp", err.Error())
		return
	}
	// optimistic concurrency: refuse clobbering remote edits
	if req.ExpectedMtimeMs > 0 && st.ModTime.UnixMilli() != req.ExpectedMtimeMs {
		s.audit(r, "editor.save-conflict", req.Path, strconv.FormatInt(req.HostID, 10), "blocked",
			fmt.Sprintf("remote mtime %d != expected %d", st.ModTime.UnixMilli(), req.ExpectedMtimeMs))
		fail(w, http.StatusConflict, "conflict", "file changed remotely — reload before saving")
		return
	}
	// timestamped backup of the previous version (kept N versions)
	if prev, err := ops.OpenRead(req.Path); err == nil {
		old, _ := io.ReadAll(io.LimitReader(prev, maxInlineFile+(1<<20)))
		prev.Close()
		if _, berr := s.St.AddBackup(req.HostID, req.Path, old); berr == nil {
			keep := 10
			if v, ok, gerr := s.St.GetSetting("keepBackupVersions"); gerr == nil && ok {
				if n, perr := strconv.Atoi(v); perr == nil && n > 0 && n <= 100 {
					keep = n
				}
			}
			_ = s.St.PruneBackups(req.HostID, req.Path, keep)
		}
	}
	if err := ops.WriteFile(req.Path, []byte(req.Content)); err != nil {
		fail(w, http.StatusBadGateway, "sftp", err.Error())
		return
	}
	newSt, serr := ops.Stat(req.Path)
	var newMtime int64
	if serr == nil {
		newMtime = newSt.ModTime.UnixMilli()
	}
	s.audit(r, "editor.save", req.Path, strconv.FormatInt(req.HostID, 10), "ok",
		fmt.Sprintf("%d bytes", len(req.Content)))
	writeJSON(w, 200, map[string]any{"saved": true, "mtimeMs": newMtime})
}

func (s *Server) handleEditorDiff(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HostID  int64  `json:"hostId"`
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	ops, ok := hostClientFor(w, r, s, req.HostID)
	if !ok {
		return
	}
	f, err := ops.OpenRead(req.Path)
	if err != nil {
		fail(w, http.StatusBadGateway, "sftp", err.Error())
		return
	}
	defer f.Close()
	oldBytes, _ := io.ReadAll(io.LimitReader(f, maxInlineFile+(1<<20)))
	unified := unifiedDiff(string(oldBytes), req.Content)
	writeJSON(w, 200, map[string]any{"unified": unified, "changed": unified != ""})
}

func (s *Server) handleBackupsList(w http.ResponseWriter, r *http.Request) {
	hostID := queryHost(r)
	p := r.URL.Query().Get("path")
	backups, err := s.St.ListBackups(hostID, p)
	if err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	out := make([]map[string]any, 0, len(backups))
	for _, b := range backups {
		out = append(out, map[string]any{
			"id": b.ID, "path": b.Path,
			"createdAt": b.CreatedAt.Format(http.TimeFormat), "size": len(b.Content),
		})
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleBackupRestore(w http.ResponseWriter, r *http.Request) {
	var req struct {
		BackupID int64 `json:"backupId"`
		HostID   int64 `json:"hostId"`
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	all, lerr := s.St.ListBackupsByHost(req.HostID)
	if lerr != nil {
		fail(w, 500, "internal", lerr.Error())
		return
	}
	var targetPath string
	var content []byte
	for _, b := range all {
		if b.ID == req.BackupID {
			targetPath = b.Path
			content = b.Content
			break
		}
	}
	if targetPath == "" {
		fail(w, 404, "not_found", "backup not found")
		return
	}
	c, err := s.SSH.Get(req.HostID)
	if err != nil {
		fail(w, http.StatusBadGateway, "offline", "host offline")
		return
	}
	ops := sftplayer.New(c)
	if err := ops.WriteFile(targetPath, content); err != nil {
		fail(w, http.StatusBadGateway, "sftp", err.Error())
		return
	}
	s.audit(r, "editor.restore-backup", targetPath, strconv.FormatInt(req.HostID, 10), "ok", "")
	writeJSON(w, 200, map[string]any{"restored": true, "path": targetPath})
}

func (s *Server) handleStatPoll(w http.ResponseWriter, r *http.Request) {
	hostID := queryHost(r)
	p := r.URL.Query().Get("path")
	c, err := s.SSH.Get(hostID)
	if err != nil {
		fail(w, http.StatusBadGateway, "offline", "host offline")
		return
	}
	ops := sftplayer.New(c)
	st, err := ops.Stat(p)
	if err != nil {
		writeJSON(w, 200, map[string]any{"exists": false})
		return
	}
	writeJSON(w, 200, map[string]any{"exists": true, "mtimeMs": st.ModTime.UnixMilli(), "size": st.Size})
}

// ---- recents (per host) stored in app_settings ----

func (s *Server) handleTouchRecent(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HostID int64  `json:"hostId"`
		Path   string `json:"path"`
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	key := fmt.Sprintf("recent:%d", req.HostID)
	list := []string{}
	if v, ok, err := s.St.GetSetting(key); err == nil && ok {
		_ = json.Unmarshal([]byte(v), &list)
	}
	out := []string{req.Path}
	for _, v := range list {
		if v != req.Path && len(out) < 50 {
			out = append(out, v)
		}
	}
	b, _ := json.Marshal(out)
	_ = s.St.SetSetting(key, string(b))
	writeJSON(w, 200, map[string]bool{"ok": true})
}
