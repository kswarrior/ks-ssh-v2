// Package proxy implements the port-preview reverse proxy: it forwards
// HTTP and WebSocket traffic to a remote host's local port over the SSH
// connection — no open firewall ports needed on the remote side.
package proxy

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ks/ks-ssh/server/internal/sshlayer"
)

// Gate decides whether preview is allowed for a host.
type Gate func(hostID int64) (allowed bool, reason string)

type Handler struct {
	SSH     *sshlayer.Manager
	Gate    Gate
	AppPort int // KS SSH's own port — never proxied
}

func New(mgr *sshlayer.Manager, gate Gate, appPort int) *Handler {
	return &Handler{SSH: mgr, Gate: gate, AppPort: appPort}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// path: /{host}/{port}[/rest]
	segs := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/"), "/", 3)
	if len(segs) < 2 {
		http.Error(w, "expected /port/preview/{host}/{port}/...", http.StatusBadRequest)
		return
	}
	hostID, err := strconv.ParseInt(segs[0], 10, 64)
	if err != nil || hostID <= 0 {
		http.Error(w, "bad host id", http.StatusBadRequest)
		return
	}
	port, err := strconv.Atoi(segs[1])
	if err != nil || port <= 0 || port > 65535 {
		http.Error(w, "bad port", http.StatusBadRequest)
		return
	}
	if ok, reason := h.Gate(hostID); !ok {
		http.Error(w, "preview blocked: "+reason, http.StatusForbidden)
		return
	}
	// block loopback to KS SSH itself (plan §2.5)
	if port == h.AppPort {
		http.Error(w, "preview blocked: target port is KS SSH itself", http.StatusForbidden)
		return
	}
	c, cerr := h.SSH.Get(hostID)
	if cerr != nil {
		http.Error(w, "host offline", http.StatusBadGateway)
		return
	}
	target := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))

	rest := ""
	if len(segs) == 3 && segs[2] != "" {
		rest = "/" + segs[2]
	}
	outPath := rest + "?" + r.URL.RawQuery

	// WebSocket pass-through: raw bidirectional tunnel.
	if isUpgrade(r) {
		h.proxyWS(w, r, c, target, outPath)
		return
	}
	h.proxyHTTP(w, r, c, target, outPath)
}

func isUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket") &&
		strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade")
}

func (h *Handler) proxyHTTP(w http.ResponseWriter, r *http.Request, c *sshlayer.Client, target, outPath string) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	remote, derr := c.Conn().DialContext(ctx, "tcp", target)
	if derr != nil {
		http.Error(w, "remote dial: "+derr.Error(), http.StatusBadGateway)
		return
	}
	defer remote.Close()

	var hb strings.Builder
	hb.WriteString(r.Method + " " + outPath + " HTTP/1.1\r\n")
	hb.WriteString("Host: " + r.Host + "\r\n")
	for k, vv := range r.Header {
		lk := strings.ToLower(k)
		if strings.HasPrefix(lk, "x-forwarded") {
			continue
		}
		for _, v := range vv {
			hb.WriteString(k + ": " + v + "\r\n")
		}
	}
	hb.WriteString("X-Forwarded-For: " + clientIPStr(r) + "\r\n")
	hb.WriteString("X-Forwarded-Host: " + r.Host + "\r\n")
	hb.WriteString("X-Forwarded-Proto: " + schemeOf(r) + "\r\n")
	hb.WriteString("\r\n")

	if _, werr := remote.Write([]byte(hb.String())); werr != nil {
		http.Error(w, "remote write: "+werr.Error(), http.StatusBadGateway)
		return
	}
	if r.Body != nil && r.ContentLength != 0 {
		io.Copy(remote, io.LimitReader(r.Body, 32<<20))
	}

	done := make(chan error, 1)
	go func() {
		_, cerr2 := io.Copy(w, remote)
		done <- cerr2
	}()
	select {
	case <-ctx.Done():
	case <-time.After(120 * time.Second):
	case err := <-done:
		_ = err
	}
}

func (h *Handler) proxyWS(w http.ResponseWriter, r *http.Request, c *sshlayer.Client, target, outPath string) {
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "webserver does not support hijacking", http.StatusInternalServerError)
		return
	}
	clientConn, clientBuf, herr := hj.Hijack()
	if herr != nil {
		http.Error(w, "hijack failed", http.StatusInternalServerError)
		return
	}
	defer clientConn.Close()

	remote, derr := c.Conn().Dial("tcp", target)
	if derr != nil {
		fmt.Fprintf(clientBuf, "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\nremote dial failed")
		clientBuf.Flush()
		return
	}
	defer remote.Close()

	var req strings.Builder
	req.WriteString("GET " + outPath + " HTTP/1.1\r\n")
	req.WriteString("Host: " + r.Host + "\r\n")
	sawKey := false
	for k, vv := range r.Header {
		lk := strings.ToLower(k)
		switch lk {
		case "sec-websocket-key":
			sawKey = true
		case "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto":
			continue
		}
		for _, v := range vv {
			req.WriteString(k + ": " + v + "\r\n")
		}
	}
	if !sawKey {
		fmt.Fprintf(clientBuf, "HTTP/1.1 400 Bad Request\r\n\r\nmissing Sec-WebSocket-Key")
		clientBuf.Flush()
		return
	}
	req.WriteString("\r\n")
	if _, werr := remote.Write([]byte(req.String())); werr != nil {
		return
	}
	clientBuf.Flush()

	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(remote, clientConn); done <- struct{}{} }()
	go func() { _, _ = io.Copy(clientConn, remote); done <- struct{}{} }()
	<-done
	slog.Debug("ws proxy closed", "target", target)
}

func clientIPStr(r *http.Request) string {
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		return strings.TrimSpace(strings.Split(v, ",")[0])
	}
	i := strings.LastIndex(r.RemoteAddr, ":")
	if i > 0 {
		return r.RemoteAddr[:i]
	}
	return r.RemoteAddr
}

func schemeOf(r *http.Request) string {
	if r.TLS != nil {
		return "https"
	}
	if p := r.Header.Get("X-Forwarded-Proto"); p != "" {
		return p
	}
	return "http"
}
