// Package cryptox provides AES-256-GCM encryption for secrets at rest.
package cryptox

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"golang.org/x/crypto/scrypt"
)

var ErrTooShort = errors.New("ciphertext too short")

// Box encrypts/decrypts with a key derived from SECRET_KEY.
type Box struct {
	aead cipher.AEAD
}

func NewBox(secretKey string) (*Box, error) {
	k := sha256.Sum256([]byte(secretKey + ":ks-ssh-secrets-v1"))
	block, err := aes.NewCipher(k[:])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Box{aead: aead}, nil
}

// Seal returns base64(nonce||ciphertext).
func (b *Box) Seal(plaintext []byte) (string, error) {
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	out := b.aead.Seal(nonce, nonce, plaintext, nil)
	return base64.StdEncoding.EncodeToString(out), nil
}

func (b *Box) Open(encoded string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, err
	}
	ns := b.aead.NonceSize()
	if len(raw) < ns+b.aead.Overhead() {
		return nil, ErrTooShort
	}
	return b.aead.Open(nil, raw[:ns], raw[ns:], nil)
}

// SealedString is a convenience wrapper that never logs plaintext.
func (b *Box) SealedString(s string) (string, error) {
	if s == "" {
		return "", nil
	}
	return b.Seal([]byte(s))
}

func (b *Box) OpenString(s string) (string, error) {
	if s == "" {
		return "", nil
	}
	p, err := b.Open(s)
	if err != nil {
		return "", err
	}
	return string(p), nil
}

// deriveKey derives a subkey for a purpose from the master secret.
func deriveKey(secret, purpose string) []byte {
	out, err := scrypt.Key([]byte(secret), []byte("ks-ssh:"+purpose), 1<<14, 8, 1, 32)
	if err != nil { // params are fixed & valid; unreachable in practice
		h := sha256.Sum256([]byte(purpose + ":" + secret))
		return h[:]
	}
	return out
}

// HMACSign produces a detached HMAC for tokens.
func HMACSign(key, data []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(data)
	return m.Sum(nil)
}

// Redact masks secrets in error strings before logging.
func Redact(s string) string {
	if s == "" {
		return ""
	}
	const max = 3
	if len(s) <= max {
		return "***"
	}
	return s[:max] + "***"
}

var _ = fmt.Sprintf // keep fmt for future use
