package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
)

// Claims is the JWT payload. Kept minimal: no secrets inside.
type Claims struct {
	Sub      int64  `json:"sub"`
	Name     string `json:"name"`
	Role     string `json:"role"`
	ExpiresAt int64 `json:"exp"`
	IssuedAt int64  `json:"iat"`
}

var (
	ErrExpired = errors.New("token expired")
	ErrInvalid = errors.New("invalid token")
)

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func sign(payload []byte, secret []byte) []byte {
	m := hmac.New(sha256.New, secret)
	m.Write(payload)
	return m.Sum(nil)
}

// IssueToken creates an HS256 JWT.
func IssueToken(secret []byte, sub int64, name, role string, ttl time.Duration) (string, time.Time, error) {
	now := time.Now()
	exp := now.Add(ttl)
	c := Claims{Sub: sub, Name: name, Role: role, ExpiresAt: exp.Unix(), IssuedAt: now.Unix()}
	head, err := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	if err != nil {
		return "", time.Time{}, err
	}
	body, err := json.Marshal(c)
	if err != nil {
		return "", time.Time{}, err
	}
	signingInput := b64(head) + "." + b64(body)
	sig := sign([]byte(signingInput), secret)
	return signingInput + "." + b64(sig), exp, nil
}

// VerifyToken validates signature and expiry.
func VerifyToken(token string, secret []byte) (*Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, ErrInvalid
	}
	signingInput := parts[0] + "." + parts[1]
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, ErrInvalid
	}
	want := sign([]byte(signingInput), secret)
	if !hmac.Equal(sig, want) {
		return nil, ErrInvalid
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, ErrInvalid
	}
	var c Claims
	if err := json.Unmarshal(body, &c); err != nil {
		return nil, ErrInvalid
	}
	if c.ExpiresAt < time.Now().Unix() {
		return nil, ErrExpired
	}
	return &c, nil
}

// NewCSRFToken returns a random URL-safe token for double-submit CSRF.
func NewCSRFToken() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand failure = process-level problem
	}
	return b64(b)
}

const (
	CookieName     = "ks_session"
	CSRFCookieName = "ks_csrf"
)

var _ = strconv.Itoa
