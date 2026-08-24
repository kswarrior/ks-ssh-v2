package e2e

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/ks/ks-ssh/server/internal/api"
	"github.com/ks/ks-ssh/server/internal/config"
	"github.com/ks/ks-ssh/server/internal/cryptox"
	"github.com/ks/ks-ssh/server/internal/store"
	"github.com/ks/ks-ssh/server/internal/sshlayer"
	"github.com/ks/ks-ssh/server/internal/tunnels"
	"github.com/ks/ks-ssh/server/internal/wshub"
)

type env struct {
	ts     *httptest.Server
	client *httpc
}

func setupEnv(t *testing.T) (*env, func()) {
	t.Helper()
	dataDir := t.TempDir()

	cfg := &config.Config{
		Port: "8099", DataDir: dataDir,
		SecretKey: "e2e-secret-key-12345678",
		JWTSecret: []byte("e2e-jwt-secret-0000000000000000"),
		MaxSessionsPerHost: 3,
	}
	st, err := store.Open(filepath.Join(dataDir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	box, err := cryptox.NewBox(cfg.SecretKey)
	if err != nil {
		t.Fatal(err)
	}
	appPort, _ := parsePort(cfg.Port)
	sshMgr := sshlayer.NewManager(st, box, cfg)
	tunMgr := tunnels.NewManager(sshMgr, st, appPort)
	reg := wshub.NewRegistry(st)

	srv := api.New(cfg, st, box, sshMgr, tunMgr, reg)
	router := srv.Router(nil, false)
	ts := httptest.NewServer(router)

	e := &env{ts: ts, client: newClient(ts)}
	return e, func() {
		ts.Close()
		tunMgr.StopAll()
		reg.Shutdown()
		sshMgr.DisconnectAll()
		st.Close()
	}
}

func parsePort(s string) (int, error) {
	var n int
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, fmt.Errorf("bad port %q", s)
		}
		n = n*10 + int(c-'0')
	}
	return n, nil
}

func urlq(p string) string { return url.QueryEscape(p) }

// ---- tiny cookie-aware http client ----

type httpc struct {
	base string
	jar  map[string]string
	csrf string
}

func newClient(ts *httptest.Server) *httpc {
	return &httpc{base: ts.URL, jar: map[string]string{}}
}

type resp struct {
	code int
	body string
}

func (r *resp) json(t *testing.T) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(r.body), &m); err != nil {
		t.Fatalf("bad json %q: %v", r.body, err)
	}
	return m
}

func (c *httpc) do(method, path string, body any) (*resp, error) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.base+path, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Cookie", joinCookies(c.jar))
	req.Header.Set("Content-Type", "application/json")
	if method != "GET" && method != "HEAD" {
		req.Header.Set("X-CSRF-Token", c.csrf)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	for _, ck := range res.Cookies() {
		c.jar[ck.Name] = ck.Value
		if ck.Name == "ks_csrf" {
			c.csrf = ck.Value
		}
	}
	raw, _ := io.ReadAll(res.Body)
	return &resp{code: res.StatusCode, body: string(raw)}, nil
}

func joinCookies(jar map[string]string) string {
	out := ""
	for k, v := range jar {
		if out != "" {
			out += "; "
		}
		out += k + "=" + v
	}
	return out
}

const (
	hostKey = "hostId"
	pathKey = "path"
)

func TestFullFlow(t *testing.T) {
	root := t.TempDir()
	srv := Start(t, root)
	defer srv.Close()
	e, cleanup := setupEnv(t)
	defer cleanup()

	// ---- bootstrap + login ----
	r, err := e.client.do("POST", "/api/auth/bootstrap", map[string]string{
		"username": "root", "password": "rootpass123"})
	if err != nil || r.code != 201 {
		t.Fatalf("bootstrap: %d %v %s", r.code, err, r.body)
	}
	r, _ = e.client.do("POST", "/api/auth/login", map[string]string{
		"username": "root", "password": "rootpass123"})
	if r.code != 200 {
		t.Fatalf("login: %d %s", r.code, r.body)
	}

	// unauthorized without cookies is rejected (fresh client)
	fresh := newClient(e.ts)
	r2, _ := fresh.do("GET", "/api/hosts", nil)
	if r2.code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", r2.code)
	}

	// ---- add host pointing at the loopback SSH server ----
	r, _ = e.client.do("POST", "/api/hosts", map[string]any{
		"name": "loopback", "hostname": "127.0.0.1", "port": srv.Port,
		"username": srv.User, "authType": "password", "password": srv.Pass,
	})
	if r.code != 201 {
		t.Fatalf("create host: %d %s", r.code, r.body)
	}
	hostID := int(r.json(t)["id"].(float64))

	// ---- first test → unknown_host TOFU prompt with fingerprint ----
	r, _ = e.client.do("POST", "/api/hosts/test", map[string]any{
		"name": "x", "hostname": "127.0.0.1", "port": srv.Port,
		"username": srv.User, "authType": "password", "password": srv.Pass})
	m := r.json(t)
	if m["code"] != "unknown_host" {
		t.Fatalf("expected unknown_host, got: %s", r.body)
	}
	fp := m["fingerprint"].(string)
	if fp != srv.Fingerprint() {
		t.Fatalf("fingerprint mismatch: %s vs %s", fp, srv.Fingerprint())
	}

	// ---- user accepts key; connect must succeed ----
	r, _ = e.client.do("POST", fmt.Sprintf("/api/hosts/%d/accept-key", hostID), map[string]string{
		"fingerprint": fp, "keyType": "ecdsa-sha2-nistp256"})
	if r.code != 200 {
		t.Fatalf("accept-key: %d %s", r.code, r.body)
	}
	r, _ = e.client.do("POST", fmt.Sprintf("/api/hosts/%d/connect", hostID), nil)
	if r.code != 200 {
		t.Fatalf("connect failed: %d %s", r.code, r.body)
	}

	// ---- wrong password must fail cleanly ----
	r, _ = e.client.do("POST", "/api/hosts/test", map[string]any{
		"name": "y", "hostname": "127.0.0.1", "port": srv.Port,
		"username": srv.User, "authType": "password", "password": "WRONG"})
	if r.json(t)["ok"] != false {
		t.Fatalf("wrong password should fail: %s", r.body)
	}

	// ---- SFTP: list / mkdir / download (ops scoped under root) ----
	os.MkdirAll(filepath.Join(root, "docs"), 0o755)
	os.WriteFile(filepath.Join(root, "hello.txt"), []byte("hello ks-ssh"), 0o644)

	r, _ = e.client.do("GET", fmt.Sprintf("/api/files/list?hostId=%d&path=%s", hostID, urlq(root)), nil)
	list := r.json(t)["entries"].([]any)
	names := []string{}
	for _, it := range list {
		names = append(names, it.(map[string]any)["name"].(string))
	}
	if !contains(names, "docs") || !contains(names, "hello.txt") {
		t.Fatalf("list incomplete: %v (%s)", names, r.body)
	}

	mk := filepath.Join(root, "made/by/api")
	r, _ = e.client.do("POST", "/api/files/mkdir", map[string]any{hostKey: hostID, pathKey: mk})
	if r.code != 201 {
		t.Fatalf("mkdir: %d %s", r.code, r.body)
	}
	if _, serr := os.Stat(mk); serr != nil {
		t.Fatalf("mkdir did not create dirs: %v", serr)
	}

	r, _ = e.client.do("GET", fmt.Sprintf("/api/files/download?hostId=%d&path=%s",
		hostID, urlq(filepath.Join(root, "hello.txt"))), nil)
	if !strings.HasSuffix(r.body, "hello ks-ssh") {
		t.Fatalf("download mismatch: %q", r.body)
	}

	// traversal attempt must be rejected outright
	r, _ = e.client.do("GET", fmt.Sprintf("/api/files/list?hostId=%d&path=%s",
		hostID, urlq(root+"/../escape")), nil)
	low := strings.ToLower(r.body)
	if r.code == http.StatusOK && strings.Contains(low, `"entries"`) {
		t.Fatalf("traversal not rejected: %d %s", r.code, r.body)
	}

	// ---- terminal WS round-trip through real SSH PTY ----
	wsURL := wsAddr(e.ts, fmt.Sprintf("/api/terminal/ws?host=%d&session=e2eterm1&cols=100&rows=30", hostID))
	hdr := http.Header{}
	hdr.Set("Cookie", joinCookies(e.client.jar))
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, hdr)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	gotHello := make(chan string, 8)
	go func() {
		for {
			_, raw, err := ws.ReadMessage()
			if err != nil {
				close(gotHello)
				return
			}
			var env struct {
				Type    string `json:"type"`
				Payload struct {
					Data string `json:"data"`
				} `json:"payload"`
			}
			if json.Unmarshal(raw, &env) == nil && env.Type == "pty.out" {
				select {
				case gotHello <- env.Payload.Data:
				default:
				}
			}
		}
	}()

	sendWS(t, ws, "pty.in", map[string]string{"data": "echo marker-e2e\n"})
	select {
	case data := <-gotHello:
		if !strings.Contains(data, "marker-e2e") {
			t.Fatalf("unexpected output: %q", data)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("timeout waiting for pty echo")
	}

	// session survives socket close (server-side PTY persists in registry)
	ws.Close()
	time.Sleep(400 * time.Millisecond)

	// ---- exec-based API over the same multiplexed client ----
	r, _ = e.client.do("GET", fmt.Sprintf("/api/monitor/info?hostId=%d", hostID), nil)
	info := r.json(t)
	if info["hostname"] == nil {
		t.Fatalf("sysinfo failed: %s", r.body)
	}

	// ---- audit captured the flow ----
	r, _ = e.client.do("GET", "/api/audit?limit=50", nil)
	for _, want := range []string{"host.create", "host.accept-key"} {
		if !strings.Contains(r.body, want) {
			t.Fatalf("audit missing %q: %s", want, r.body)
		}
	}

	// ---- disconnect closes everything ----
	r, _ = e.client.do("POST", fmt.Sprintf("/api/hosts/%d/disconnect", hostID), nil)
	if r.code != 200 {
		t.Fatalf("disconnect: %d", r.code)
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func wsAddr(ts *httptest.Server, path string) string {
	return "ws" + strings.TrimPrefix(ts.URL, "http") + path
}

func sendWS(t *testing.T, ws *websocket.Conn, typ string, payload any) {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"type": typ, "seq": 0, "ts": time.Now().UnixMilli(), "payload": payload})
	if err := ws.WriteMessage(websocket.TextMessage, b); err != nil {
		t.Fatal(err)
	}
}
