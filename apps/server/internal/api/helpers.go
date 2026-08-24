package api

import (
	"fmt"
	"io/fs"
	"net/http"
	"path"
	"strconv"
	"strings"

	"github.com/ks/ks-ssh/server/internal/monitor"
)

// audit appends an entry to the immutable audit log.
func (s *Server) audit(r *http.Request, action, target, hostName, result, detail string) {
	cl := claimsOf(r)
	user := "-"
	if cl != nil {
		user = cl.Name
	}
	if err := s.St.AppendAudit(user, action, target, hostName, result, detail); err != nil {
		fmt.Println("audit write failed:", err) // never silent
	}
}

// monitorState keeps the 1h in-memory metric window per host.
type monitorState struct {
	col     *monitor.Collector
	samples []monitor.Sample // ring, max 3600
	maxLen  int
}

func (s *Server) monitorFor(hostID int64, newCollector func() *monitor.Collector) *monitorState {
	s.monMu.Lock()
	defer s.monMu.Unlock()
	ms, ok := s.monitors[hostID]
	if !ok {
		ms = &monitorState{col: newCollector(), samples: make([]monitor.Sample, 0, 64), maxLen: 3600}
		s.monitors[hostID] = ms
	}
	return ms
}

func (ms *monitorState) push(sm monitor.Sample) {
	ms.samples = append(ms.samples, sm)
	if len(ms.samples) > ms.maxLen {
		ms.samples = ms.samples[len(ms.samples)-ms.maxLen:]
	}
}

func (ms *monitorState) window() []monitor.Sample {
	return ms.samples
}

func queryInt(r *http.Request, name string, def int) int {
	v := r.URL.Query().Get(name)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func queryInt64(r *http.Request, name string, def int64) int64 {
	v := r.URL.Query().Get(name)
	if v == "" {
		return def
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return def
	}
	return n
}

// ---- embedded SPA serving ----

func serveStatic(w http.ResponseWriter, r *http.Request, webFS fs.FS, fileServer http.Handler) {
	upath := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if upath == "" {
		upath = "index.html"
	}
	f, err := webFS.Open(upath)
	if err == nil {
		f.Close()
		fileServer.ServeHTTP(w, r)
		return
	}
	serveIndex(w, r, webFS, fileServer)
}

// serveIndex falls back to index.html for SPA client routes.
func serveIndex(w http.ResponseWriter, _ *http.Request, webFS fs.FS, _ http.Handler) {
	data, err := fs.ReadFile(webFS, "index.html")
	if err != nil {
		http.Error(w, "frontend not built — run `make build`", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(data)
}
