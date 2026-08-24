package api

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/ks/ks-ssh/server/internal/auth"
	"github.com/ks/ks-ssh/server/internal/store"
)

// userJSON is the API shape — never includes secrets.
type userJSON struct {
	ID          int64  `json:"id"`
	Username    string `json:"username"`
	Role        string `json:"role"`
	TOTPEnabled bool   `json:"totpEnabled"`
	CreatedAt   string `json:"createdAt"`
}

func toUserJSON(u *store.User) userJSON {
	return userJSON{
		ID: u.ID, Username: u.Username, Role: u.Role,
		TOTPEnabled: u.TOTPEnabled,
		CreatedAt:   u.CreatedAt.Format(time.RFC3339),
	}
}

func chiURLParam(r *http.Request, name string) string {
	return chi.URLParam(r, name)
}

func (s *Server) setSessionCookies(w http.ResponseWriter, userID int64, name, role string) error {
	token, exp, err := auth.IssueToken(s.Cfg.JWTSecret, userID, name, role, 24*time.Hour)
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     auth.CookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   false, // behind TLS-terminating reverse proxy; HSTS set there
		SameSite: http.SameSiteLaxMode,
		Expires:  exp,
	})
	csrf := auth.NewCSRFToken()
	http.SetCookie(w, &http.Cookie{
		Name:     auth.CSRFCookieName,
		Value:    csrf,
		Path:     "/",
		HttpOnly: false, // must be readable by the app for double-submit
		SameSite: http.SameSiteLaxMode,
		Expires:  exp,
	})
	return nil
}

func clearSessionCookies(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: auth.CookieName, Value: "", Path: "/", MaxAge: -1})
	http.SetCookie(w, &http.Cookie{Name: auth.CSRFCookieName, Value: "", Path: "/", MaxAge: -1})
}

// handleBootstrap creates the first admin when no users exist.
func (s *Server) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	n, err := s.St.UserCount()
	if err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	if n > 0 {
		fail(w, 409, "exists", "bootstrap already done")
		return
	}
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	if len(req.Username) < 3 || len(req.Password) < 8 {
		fail(w, 400, "bad_request", "username ≥3 chars, password ≥8 chars")
		return
	}
	u, err := s.St.CreateUser(req.Username, req.Password, "admin")
	if err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	if err := s.setSessionCookies(w, u.ID, u.Username, u.Role); err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	writeJSON(w, 201, map[string]any{"user": toUserJSON(u)})
}

// handleLogin implements rate-limited login (+TOTP).
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	s.loginMu.Lock()
	defer s.loginMu.Unlock()

	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		TOTP     string `json:"totp,omitempty"`
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	req.Username = strings.TrimSpace(strings.ToLower(req.Username))
	ip := clientIP(r)

	// lockout: 5 failures in 10 minutes
	fails, _ := s.St.RecentFailures(req.Username, 10*time.Minute)
	if fails >= 5 {
		s.St.RecordAuthAttempt(req.Username, ip, false)
		fail(w, 429, "locked", "too many failed attempts — try again later")
		return
	}

	u, err := s.St.GetUserByName(req.Username)
	if err != nil || u.Disabled {
		s.St.RecordAuthAttempt(req.Username, ip, false)
		// constant-ish delay to blunt user enumeration
		time.Sleep(300 * time.Millisecond)
		fail(w, 401, "unauthorized", "invalid credentials")
		return
	}
	if !s.St.CheckPassword(u.ID, req.Password) {
		s.St.RecordAuthAttempt(req.Username, ip, false)
		fail(w, 401, "unauthorized", "invalid credentials")
		return
	}
	if u.TOTPEnabled {
		if req.TOTP == "" {
			writeJSON(w, 200, map[string]any{"needsTotp": true})
			return
		}
		if u.TOTPSecret == nil || !auth.ValidateTOTP(*u.TOTPSecret, req.TOTP) {
			s.St.RecordAuthAttempt(req.Username, ip, false)
			fail(w, 401, "unauthorized", "invalid TOTP code")
			return
		}
	}
	s.St.RecordAuthAttempt(req.Username, ip, true)
	if err := s.setSessionCookies(w, u.ID, u.Username, u.Role); err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"user": toUserJSON(u)})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	clearSessionCookies(w)
	writeJSON(w, 200, map[string]string{"ok": "true"})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	cl := claimsOf(r)
	u, err := s.St.GetUserByID(cl.Sub)
	if err != nil {
		clearSessionCookies(w)
		fail(w, 401, "unauthorized", "user gone")
		return
	}
	writeJSON(w, 200, map[string]any{"user": toUserJSON(u)})
}

// ---- 2FA ----

func (s *Server) handle2FASetup(w http.ResponseWriter, r *http.Request) {
	cl := claimsOf(r)
	secret, err := auth.GenerateTOTPSecret()
	if err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	if err := s.St.SetTOTP(cl.Sub, &secret, false); err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{
		"secret": secret,
		"uri":    auth.TOTPURI(cl.Name, "KS SSH", secret),
	})
}

func (s *Server) handle2FAEnable(w http.ResponseWriter, r *http.Request) {
	cl := claimsOf(r)
	var req struct{ Code string `json:"code"` }
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	u, err := s.St.GetUserByID(cl.Sub)
	if err != nil || u.TOTPSecret == nil {
		fail(w, 400, "bad_request", "run setup first")
		return
	}
	if !auth.ValidateTOTP(*u.TOTPSecret, req.Code) {
		fail(w, 400, "bad_request", "invalid code")
		return
	}
	if err := s.St.SetTOTP(cl.Sub, u.TOTPSecret, true); err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"enabled": true})
}

func (s *Server) handle2FADisable(w http.ResponseWriter, r *http.Request) {
	cl := claimsOf(r)
	var req struct{ Password string `json:"password"` }
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	if !s.St.CheckPassword(cl.Sub, req.Password) {
		fail(w, 401, "unauthorized", "password check failed")
		return
	}
	if err := s.St.SetTOTP(cl.Sub, nil, false); err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"enabled": false})
}

// ---- users CRUD (admin) ----

func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	users, err := s.St.ListUsers()
	if err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	out := make([]userJSON, 0, len(users))
	for _, u := range users {
		out = append(out, toUserJSON(u))
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Role     string `json:"role"`
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	req.Role = normalizeRole(req.Role)
	if req.Role == "" {
		fail(w, 400, "bad_request", "role must be admin|operator|viewer")
		return
	}
	if len(req.Username) < 3 || len(req.Password) < 8 {
		fail(w, 400, "bad_request", "username ≥3 chars, password ≥8 chars")
		return
	}
	u, err := s.St.CreateUser(strings.TrimSpace(strings.ToLower(req.Username)), req.Password, req.Role)
	if err != nil {
		fail(w, 409, "conflict", "username taken or invalid: "+err.Error())
		return
	}
	s.audit(r, "user.create", u.Username, "-", "ok", "")
	writeJSON(w, 201, toUserJSON(u))
}

func (s *Server) handleUpdateUser(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chiURLParam(r, "id"), 10, 64)
	var req struct {
		Role     *string `json:"role,omitempty"`
		Disabled *bool   `json:"disabled,omitempty"`
		Password *string `json:"password,omitempty"`
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	cl := claimsOf(r)
	if id == cl.Sub && req.Disabled != nil && *req.Disabled {
		fail(w, 400, "bad_request", "cannot disable yourself")
		return
	}
	if req.Role != nil {
		role := normalizeRole(*req.Role)
		if role == "" {
			fail(w, 400, "bad_request", "bad role")
			return
		}
		if err := s.St.SetUserRole(id, role); err != nil {
			fail(w, 500, "internal", err.Error())
			return
		}
	}
	if req.Disabled != nil {
		if err := s.St.SetUserDisabled(id, *req.Disabled); err != nil {
			fail(w, 500, "internal", err.Error())
			return
		}
	}
	if req.Password != nil && *req.Password != "" {
		if len(*req.Password) < 8 {
			fail(w, 400, "bad_request", "password ≥8 chars")
			return
		}
		if err := s.St.SetPassword(id, *req.Password); err != nil {
			fail(w, 500, "internal", err.Error())
			return
		}
	}
	s.audit(r, "user.update", strconv.FormatInt(id, 10), "-", "ok", "")
	u, err := s.St.GetUserByID(id)
	if err != nil {
		fail(w, 404, "not_found", "no such user")
		return
	}
	writeJSON(w, 200, toUserJSON(u))
}

func (s *Server) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chiURLParam(r, "id"), 10, 64)
	cl := claimsOf(r)
	if id == cl.Sub {
		fail(w, 400, "bad_request", "cannot delete yourself")
		return
	}
	if err := s.St.DeleteUser(id); err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	s.audit(r, "user.delete", strconv.FormatInt(id, 10), "-", "ok", "")
	writeJSON(w, 200, map[string]bool{"deleted": true})
}

func normalizeRole(r string) string {
	switch strings.ToLower(strings.TrimSpace(r)) {
	case "admin":
		return "admin"
	case "operator":
		return "operator"
	case "viewer":
		return "viewer"
	default:
		return ""
	}
}

func clientIP(r *http.Request) string {
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		parts := strings.Split(v, ",")
		return strings.TrimSpace(parts[0])
	}
	return r.RemoteAddr
}
