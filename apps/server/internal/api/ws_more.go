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
	"github.com/ks/ks-ssh/server/internal/sshlayer"
)

// handleMultiRunWS fans a command out to N hosts, streaming per-host output.
func (s *Server) handleMultiRunWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgradeWS(w, r)
	if err != nil {
		return
	}
	defer conn.Close()

	var cancel context.CancelFunc
	var mu sync.Mutex
	ctx := context.Background()

	for {
		env, rerr := conn.Read()
		if rerr != nil {
			mu.Lock()
			if cancel != nil {
				cancel()
			}
			mu.Unlock()
			return
		}
		switch env.Type {
		case "multi.run":
			var p struct {
				Command string  `json:"command"`
				HostIDs []int64 `json:"hostIds"`
			}
			if err := jsonDecodeBytes(env.Payload, &p); err != nil || strings.TrimSpace(p.Command) == "" {
				continue
			}
			if isDangerous(p.Command) {
				_ = conn.Send("multi.dangerous", map[string]any{
					"command": p.Command,
					"error":   "dangerous command pattern detected — confirm in UI before running",
				})
				continue
			}
			mu.Lock()
			if cancel != nil {
				cancel()
			}
			var c context.CancelFunc
			ctx, c = context.WithCancel(context.Background())
			cancel = c
			runCtx := ctx
			mu.Unlock()

			cl := claimsOf(r)
			userName := "-"
			if cl != nil {
				userName = cl.Name
			}
			s.audit(r, "snippet.multi-run",
				fmt.Sprintf("%d hosts: %s", len(p.HostIDs), p.Command), "-", "ok", userName)

			var wg sync.WaitGroup
			for _, hostID := range p.HostIDs {
				wg.Add(1)
				go func(hostID int64) {
					defer wg.Done()
					hc, gerr := s.SSH.Get(hostID)
					if gerr != nil {
						_ = conn.Send("multi.output", map[string]any{
							"hostId": hostID, "stream": "stderr", "data": "host offline"})
						_ = conn.Send("multi.exit", map[string]any{
							"hostId": hostID, "exitCode": nil, "done": true})
						return
					}
					out, eout, code, _ := hc.Run(runCtx, 120*time.Second, p.Command)
					if len(out) > 0 {
						_ = conn.Send("multi.output", map[string]any{
							"hostId": hostID, "stream": "stdout", "data": out})
					}
					if len(eout) > 0 {
						_ = conn.Send("multi.output", map[string]any{
							"hostId": hostID, "stream": "stderr", "data": eout})
					}
					payload := map[string]any{"hostId": hostID, "exitCode": code, "done": true}
					if runCtx.Err() != nil {
						payload["exitCode"] = nil
						payload["stopped"] = true
					}
					_ = conn.Send("multi.exit", payload)
				}(hostID)
			}
			wg.Wait()
		case "multi.stop":
			mu.Lock()
			if cancel != nil {
				cancel()
			}
			mu.Unlock()
			_ = conn.Send("multi.stopped", map[string]bool{"ok": true})
		}
	}
}

var lastLinesMu sync.Mutex
var lastLinesMap = map[string]time.Time{}

func recentlySent(line string) bool {
	lastLinesMu.Lock()
	defer lastLinesMu.Unlock()
	if t, ok := lastLinesMap[line]; ok && time.Since(t) < time.Second {
		return true
	}
	lastLinesMap[line] = time.Now()
	if len(lastLinesMap) > 4096 {
		lastLinesMap = map[string]time.Time{}
	}
	return false
}

func shellQuoteArg(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// streamDockerTail polls `docker logs` incrementally (bounded output).
func streamDockerTail(ctx context.Context, c *sshlayer.Client, ch chan<- string, container string) {
	var since time.Time
	ticker := time.NewTicker(700 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		cmd := "docker logs --tail 100 "
		if !since.IsZero() {
			cmd += "--since " + strconv.FormatInt(since.Unix(), 10) + " "
		}
		cmd += shellQuoteArg(container) + " 2>&1 | tail -n 200"
		out, _, _, err := c.Run(ctx, 5*time.Second, cmd)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			continue
		}
		now := time.Now().Add(-1 * time.Second)
		for _, ln := range strings.Split(out, "\n") {
			if ln != "" && !recentlySent(ln) {
				ch <- ln
			}
		}
		since = now
	}
}

// handleDockerLogsWS streams container logs.
func (s *Server) handleDockerLogsWS(w http.ResponseWriter, r *http.Request) {
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

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go func() { // client close → stop tail
		for {
			if _, rerr := conn.Read(); rerr != nil {
				cancel()
				return
			}
		}
	}()

	linesCh := make(chan string, 256)
	go func() {
		defer close(linesCh)
		streamDockerTail(ctx, c, linesCh, container)
	}()

	for line := range linesCh {
		if err := conn.Send("log.line", map[string]string{"line": line}); err != nil {
			cancel()
			return
		}
	}
}

// handleLogsWS tails a remote file via incremental bounded reads.
func (s *Server) handleLogsWS(w http.ResponseWriter, r *http.Request) {
	hostID := queryInt64(r, "host", 0)
	pathQ := r.URL.Query().Get("path")
	filter := r.URL.Query().Get("filter")
	c, err := s.SSH.Get(hostID)
	if err != nil || pathQ == "" {
		fail(w, http.StatusBadGateway, "offline", "host offline or path missing")
		return
	}
	conn, err := upgradeWS(w, r)
	if err != nil {
		return
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go func() {
		for {
			if _, rerr := conn.Read(); rerr != nil {
				cancel()
				return
			}
		}
	}()

	q := shellQuoteArg(pathQ)
	offset := queryInt64(r, "offsetBytes", 0)
	if offset <= 0 {
		out, _, _, _ := c.Run(ctx, 8*time.Second, "wc -c < "+q+" ; tail -n 300 "+q+" 2>/dev/null")
		parts := strings.SplitN(out, "\n", 2)
		if n, perr := strconv.ParseInt(strings.TrimSpace(parts[0]), 10, 64); perr == nil {
			offset = n
		}
		if len(parts) == 2 && parts[1] != "" {
			for _, ln := range strings.Split(parts[1], "\n") {
				if ln != "" && matchesFilter(ln, filter) {
					_ = conn.Send("log.line", map[string]any{"line": ln})
				}
			}
		}
	}
	ticker := time.NewTicker(800 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		sizeOut, _, _, _ := c.Run(ctx, 5*time.Second, "wc -c < "+q)
		size, _ := strconv.ParseInt(strings.TrimSpace(sizeOut), 10, 64)
		if size <= offset {
			if size < offset {
				offset = 0 // rotated/truncated
			} else {
				continue
			}
		}
		n := size - offset
		if n > 512*1024 {
			n = 512 * 1024
		}
		cmd := fmt.Sprintf("tail -c +%d %s 2>/dev/null | head -c %d", offset+1, q, n)
		out, _, _, rerr := c.Run(ctx, 5*time.Second, cmd)
		if rerr != nil {
			continue
		}
		offset += n
		for _, ln := range strings.Split(out, "\n") {
			if ln != "" && matchesFilter(ln, filter) {
				if err := conn.Send("log.line", map[string]any{"line": ln}); err != nil {
					return
				}
			}
		}
	}
}

func matchesFilter(line, filter string) bool {
	if filter == "" {
		return true
	}
	return strings.Contains(line, filter)
}

// ---- history ----

func (s *Server) handleHistoryList(w http.ResponseWriter, r *http.Request) {
	hostID := queryHost(r)
	cl := claimsOf(r)
	key := fmt.Sprintf("history:%d:%s", hostID, cl.Name)
	list := []string{}
	if v, ok, err := s.St.GetSetting(key); err == nil && ok {
		_ = jsonDecodeBytes([]byte(v), &list)
	}
	writeJSON(w, 200, list)
}

// ---- bookmarks ----

func (s *Server) handleBookmarkList(w http.ResponseWriter, r *http.Request) {
	hostID := queryHost(r)
	list, err := s.St.ListBookmarks(hostID)
	if err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, b := range list {
		out = append(out, map[string]any{"id": b.ID, "hostId": b.HostID,
			"path": b.Path, "label": b.Label, "kind": b.Kind})
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleBookmarkCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HostID int64  `json:"hostId"`
		Path   string `json:"path"`
		Label  string `json:"label"`
		Kind   string `json:"kind"`
	}
	if err := decodeJSON(r, &req); err != nil || strings.TrimSpace(req.Path) == "" {
		fail(w, 400, "bad_request", "path required")
		return
	}
	if req.Kind != "file" && req.Kind != "path" {
		req.Kind = "path"
	}
	label := req.Label
	if label == "" {
		label = req.Path
	}
	b, err := s.St.AddBookmark(req.HostID, req.Path, label, req.Kind)
	if err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	writeJSON(w, 201, map[string]any{"id": b.ID})
}

func (s *Server) handleBookmarkDelete(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chiURLParam(r, "id"), 10, 64)
	if err := s.St.DeleteBookmark(id); err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"deleted": true})
}

func (s *Server) handleBookmarkRename(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chiURLParam(r, "id"), 10, 64)
	var req struct {
		Label string `json:"label"`
	}
	if err := decodeJSON(r, &req); err != nil || strings.TrimSpace(req.Label) == "" {
		fail(w, 400, "bad_request", "label required")
		return
	}
	if err := s.St.RenameBookmark(id, strings.TrimSpace(req.Label)); err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"renamed": true})
}

var _ = execx.GitFile{}
