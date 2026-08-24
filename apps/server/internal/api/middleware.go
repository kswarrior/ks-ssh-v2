package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/ks/ks-ssh/server/internal/auth"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

type apiErr struct {
	Error string `json:"error"`
	Code  string `json:"code,omitempty"`
}

func fail(w http.ResponseWriter, status int, code string, msg string) {
	writeJSON(w, status, apiErr{Error: msg, Code: code})
}

func decodeJSON(r *http.Request, v any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 32<<20))
	return dec.Decode(v)
}

func recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				slog.Error("panic recovered", "path", r.URL.Path, "err", rec)
				fail(w, http.StatusInternalServerError, "internal", "internal server error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// secureHeaders sets strict CSP and friends. devMode relaxes CSP for vite HMR.
func secureHeaders(devMode bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("X-Frame-Options", "DENY")
			h.Set("Referrer-Policy", "same-origin")
			h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
			csp := "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' ws: wss:; script-src 'self'"
			if !devMode {
				h.Set("Content-Security-Policy", csp)
				if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
					h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(sw, r)
		if strings.HasPrefix(r.URL.Path, "/api/") || sw.status >= 400 {
			slog.Info("http", "method", r.Method, "path", r.URL.Path,
				"status", sw.status, "dur", time.Since(start).Round(time.Millisecond).String())
		}
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

// Hijack delegates so websocket upgrades pass through the logger.
func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("underlying writer is not a Hijacker")
	}
	w.status = 101
	return h.Hijack()
}

// Flush delegates for streaming responses.
func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// requireAuth validates the session cookie and injects claims.
func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(auth.CookieName)
		if err != nil || c.Value == "" {
			fail(w, http.StatusUnauthorized, "unauthorized", "login required")
			return
		}
		claims, err := auth.VerifyToken(c.Value, s.Cfg.JWTSecret)
		if err != nil {
			fail(w, http.StatusUnauthorized, "unauthorized", "session invalid or expired")
			return
		}
		// CSRF double-submit on mutating requests.
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
			csrfCookie, cerr := r.Cookie(auth.CSRFCookieName)
			csrfHeader := r.Header.Get("X-CSRF-Token")
			if cerr != nil || csrfCookie.Value == "" || csrfHeader == "" ||
				csrfCookie.Value != csrfHeader {
				fail(w, http.StatusForbidden, "csrf", "CSRF token missing or mismatched")
				return
			}
		}
		ctx := context.WithValue(r.Context(), claimsCtxKey, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// claimsOf extracts the injected claims.
func claimsOf(r *http.Request) *auth.Claims {
	v := r.Context().Value(claimsCtxKey)
	if c, ok := v.(*auth.Claims); ok {
		return c
	}
	return nil
}

func (s *Server) requireRole(minRole string) func(http.Handler) http.Handler {
	rank := map[string]int{"viewer": 1, "operator": 2, "admin": 3}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			cl := claimsOf(r)
			if cl == nil {
				fail(w, http.StatusUnauthorized, "unauthorized", "login required")
				return
			}
			if rank[cl.Role] < rank[minRole] {
				fail(w, http.StatusForbidden, "forbidden", "role "+cl.Role+" may not perform this action")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

var _ = slog.Info
