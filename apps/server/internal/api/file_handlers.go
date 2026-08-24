package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/ks/ks-ssh/server/internal/sftplayer"
)

func hostClientFor(w http.ResponseWriter, r *http.Request, s *Server, hostID int64) (*sftplayer.Ops, bool) {
	c, err := s.SSH.Get(hostID)
	if err != nil {
		fail(w, http.StatusBadGateway, "offline", "host not connected — connect first")
		return nil, false
	}
	return sftplayer.New(c), true
}

func queryHost(r *http.Request) int64 {
	return queryInt64(r, "hostId", 0)
}

func (s *Server) handleFileList(w http.ResponseWriter, r *http.Request) {
	hostID := queryHost(r)
	dir := r.URL.Query().Get("path")
	if dir == "" {
		dir = "/"
	}
	ops, ok := hostClientFor(w, r, s, hostID)
	if !ok {
		return
	}
	entries, err := ops.List(dir)
	if err != nil {
		fail(w, http.StatusBadGateway, "sftp", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"path": path.Clean(dir), "entries": entries})
}

func (s *Server) handleFileStat(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	ops, ok := hostClientFor(w, r, s, queryHost(r))
	if !ok {
		return
	}
	e, err := ops.Stat(p)
	if err != nil {
		fail(w, http.StatusBadGateway, "sftp", err.Error())
		return
	}
	writeJSON(w, 200, e)
}

func (s *Server) handleMkdir(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HostID int64  `json:"hostId"`
		Path   string `json:"path"`
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	ops, ok := hostClientFor(w, r, s, req.HostID)
	if !ok {
		return
	}
	if err := ops.Mkdir(req.Path); err != nil {
		fail(w, http.StatusBadGateway, "sftp", err.Error())
		return
	}
	s.audit(r, "file.mkdir", req.Path, strconv.FormatInt(req.HostID, 10), "ok", "")
	writeJSON(w, 201, map[string]bool{"created": true})
}

func (s *Server) handleRename(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HostID int64  `json:"hostId"`
		From   string `json:"from"`
		To     string `json:"to"`
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	ops, ok := hostClientFor(w, r, s, req.HostID)
	if !ok {
		return
	}
	if err := ops.Rename(req.From, req.To); err != nil {
		fail(w, http.StatusBadGateway, "sftp", err.Error())
		return
	}
	s.audit(r, "file.rename", req.From+" → "+req.To, strconv.FormatInt(req.HostID, 10), "ok", "")
	writeJSON(w, 200, map[string]bool{"renamed": true})
}

func (s *Server) handleMove(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HostID int64    `json:"hostId"`
		From   []string `json:"from"`
		DestDir string  `json:"destDir"`
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	ops, ok := hostClientFor(w, r, s, req.HostID)
	if !ok {
		return
	}
	var moved []string
	var lastErr error
	for _, from := range req.From {
		to := path.Join(req.DestDir, path.Base(from))
		if err := ops.Rename(from, to); err != nil {
			lastErr = err
			continue
		}
		moved = append(moved, to)
	}
	if len(moved) < len(req.From) && lastErr != nil {
		fail(w, http.StatusBadGateway, "sftp", fmt.Sprintf("moved %d/%d: %v", len(moved), len(req.From), lastErr))
		return
	}
	s.audit(r, "file.move", fmt.Sprintf("%d paths → %s", len(moved), req.DestDir),
		strconv.FormatInt(req.HostID, 10), "ok", "")
	writeJSON(w, 200, map[string]any{"moved": moved})
}

func (s *Server) handleCopy(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HostID int64    `json:"hostId"`
		From   []string `json:"from"`
		DestDir string  `json:"destDir"`
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	ops, ok := hostClientFor(w, r, s, req.HostID)
	if !ok {
		return
	}
	var copied []string
	var lastErr error
	for _, from := range req.From {
		base := path.Base(from)
		ext := path.Ext(base)
		name := stringsTrimSuffix(base, ext)
		to := path.Join(req.DestDir, name+"-copy"+ext)
		if err := ops.Copy(r.Context(), from, to, nil); err != nil {
			lastErr = err
			continue
		}
		copied = append(copied, to)
	}
	if len(copied) < len(req.From) && lastErr != nil {
		fail(w, http.StatusBadGateway, "sftp", fmt.Sprintf("copied %d/%d: %v", len(copied), len(req.From), lastErr))
		return
	}
	s.audit(r, "file.copy", fmt.Sprintf("%d paths → %s", len(copied), req.DestDir),
		strconv.FormatInt(req.HostID, 10), "ok", "")
	writeJSON(w, 200, map[string]any{"copied": copied})
}

func stringsTrimSuffix(s, suf string) string {
	return s[:len(s)-len(suf)]
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HostID int64    `json:"hostId"`
		Paths  []string `json:"paths"`
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	if len(req.Paths) == 0 {
		fail(w, 400, "bad_request", "paths required")
		return
	}
	ops, ok := hostClientFor(w, r, s, req.HostID)
	if !ok {
		return
	}
	var deleted []string
	var lastErr error
	for _, p := range req.Paths {
		if err := ops.Delete(r.Context(), p); err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				deleted = append(deleted, p)
				continue
			}
			lastErr = err
			continue
		}
		deleted = append(deleted, p)
	}
	if len(deleted) < len(req.Paths) && lastErr != nil {
		fail(w, http.StatusBadGateway, "sftp", fmt.Sprintf("deleted %d/%d: %v", len(deleted), len(req.Paths), lastErr))
		return
	}
	s.audit(r, "file.delete", fmt.Sprintf("%d paths: %v", len(deleted), req.Paths),
		strconv.FormatInt(req.HostID, 10), "ok", "")
	writeJSON(w, 200, map[string]any{"deleted": deleted})
}

func (s *Server) handleChmod(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HostID int64  `json:"hostId"`
		Path   string `json:"path"`
		Mode   string `json:"mode"` // octal like 0644 or 644
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	if _, err := strconv.ParseUint(strings.TrimPrefix(req.Mode, "0"), 8, 32); err != nil {
		fail(w, 400, "bad_request", "mode must be octal")
		return
	}
	ops, ok := hostClientFor(w, r, s, req.HostID)
	if !ok {
		return
	}
	if err := ops.Chmod(req.Path, strings.TrimPrefix(req.Mode, "0")); err != nil {
		fail(w, http.StatusBadGateway, "sftp", err.Error())
		return
	}
	s.audit(r, "file.chmod", req.Path+" → "+req.Mode, strconv.FormatInt(req.HostID, 10), "ok", "")
	writeJSON(w, 200, map[string]bool{"changed": true})
}

func (s *Server) handleFileSearch(w http.ResponseWriter, r *http.Request) {
	root := r.URL.Query().Get("root")
	pattern := r.URL.Query().Get("pattern")
	limit := queryInt(r, "limit", 200)
	ops, ok := hostClientFor(w, r, s, queryHost(r))
	if !ok {
		return
	}
	hits, err := ops.Search(r.Context(), root, pattern, limit)
	if err != nil {
		fail(w, http.StatusBadGateway, "sftp", err.Error())
		return
	}
	writeJSON(w, 200, hits)
}

// handleFileDownload streams a single file, or a zip of many/folders.
func (s *Server) handleFileDownload(w http.ResponseWriter, r *http.Request) {
	hostID := queryHost(r)
	q := r.URL.Query().Get("paths")
	if q == "" {
		q = r.URL.Query().Get("path")
	}
	if q == "" {
		fail(w, 400, "bad_request", "path(s) required")
		return
	}
	paths := splitPathsQuery(q)
	if len(paths) == 0 {
		fail(w, 400, "bad_request", "path(s) required")
		return
	}
	ops, ok := hostClientFor(w, r, s, hostID)
	if !ok {
		return
	}
	if len(paths) == 1 {
		st, err := ops.Stat(paths[0])
		if err != nil {
			fail(w, http.StatusBadGateway, "sftp", err.Error())
			return
		}
		if !st.IsDir {
			w.Header().Set("Content-Disposition",
				"attachment; filename*=UTF-8''"+url.PathEscape(st.Name))
			w.Header().Set("Content-Length", strconv.FormatInt(st.Size, 10))
			w.Header().Set("Content-Type", "application/octet-stream")
			f, err := ops.OpenRead(paths[0])
			if err != nil {
				fail(w, http.StatusBadGateway, "sftp", err.Error())
				return
			}
			defer f.Close()
			http.ServeContent(w, r, st.Name, st.ModTime, f)
			s.audit(r, "file.download", paths[0], strconv.FormatInt(hostID, 10), "ok", "")
			return
		}
	}
	name := zipName(paths)
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition",
		"attachment; filename*=UTF-8''"+url.PathEscape(name))
	if err := ops.ZipTo(r.Context(), w, paths, commonRoot(paths)); err != nil {
		// headers already sent; best effort log only when nothing written
		fmt.Println("zip stream error:", err)
		return
	}
	s.audit(r, "file.download-zip", fmt.Sprintf("%d paths", len(paths)),
		strconv.FormatInt(hostID, 10), "ok", name)
}

func zipName(paths []string) string {
	if len(paths) == 1 {
		b := path.Base(paths[0])
		return b + ".zip"
	}
	return "download-" + strconv.FormatInt(time.Now().Unix(), 10) + ".zip"
}

func commonRoot(paths []string) string {
	if len(paths) == 0 {
		return "/"
	}
	if len(paths) == 1 {
		return path.Dir(paths[0])
	}
	return "/"
}

// splitPathsQuery accepts a JSON array or a comma-separated list.
func splitPathsQuery(q string) []string {
	if len(q) > 1 && q[0] == '[' {
		var arr []string
		if err := json.Unmarshal([]byte(q), &arr); err == nil && len(arr) > 0 {
			return arr
		}
	}
	u, err := url.QueryUnescape(q)
	if err != nil {
		u = q
	}
	var out []string
	for _, part := range strings.Split(u, ",") {
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

// handleURLUpload downloads a URL server-side into the remote FS.
func (s *Server) handleURLUpload(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HostID int64  `json:"hostId"`
		URL    string `json:"url"`
		Dir    string `json:"dir"`
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	ops, ok := hostClientFor(w, r, s, req.HostID)
	if !ok {
		return
	}
	final, err := ops.FetchFromURL(r.Context(), s.St, req.URL, req.Dir, func(n int64) {})
	if err != nil {
		fail(w, http.StatusBadGateway, "fetch", err.Error())
		return
	}
	s.audit(r, "file.url-upload", req.URL+" → "+final, strconv.FormatInt(req.HostID, 10), "ok", "")
	writeJSON(w, 200, map[string]string{"path": final})
}

// handleTransfersList returns persisted transfer rows for restore/UX.
func (s *Server) handleTransfersList(w http.ResponseWriter, r *http.Request) {
	hostID := queryHost(r)
	list, err := s.St.ListTransfers(hostID)
	if err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	type row struct {
		ID          string `json:"id"`
		Kind        string `json:"kind"`
		Path        string `json:"path"`
		Name        string `json:"name"`
		Size        int64  `json:"size"`
		Transferred int64  `json:"transferred"`
		Status      string `json:"status"`
	}
	out := make([]row, 0, len(list))
	for _, t := range list {
		out = append(out, row{ID: t.ID, Kind: t.Kind, Path: t.Path, Name: t.Name,
			Size: t.Size, Transferred: t.Transferred, Status: t.Status})
	}
	writeJSON(w, 200, out)
}
