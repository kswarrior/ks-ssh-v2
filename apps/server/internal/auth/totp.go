package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"strings"
	"time"
)

// TOTP (RFC 6238, SHA-1, 6 digits, 30s step) — minimal dependency-free implementation.

func totpCode(secret []byte, step int64, t time.Time) uint32 {
	counter := t.Unix() / step
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], uint64(counter))
	mac := hmac.New(sha1.New, secret)
	mac.Write(buf[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	code := (uint32(sum[offset])&0x7f)<<24 |
		uint32(sum[offset+1])<<16 |
		uint32(sum[offset+2])<<8 |
		uint32(sum[offset+3])
	return code % 1000000
}

func decodeSecret(s string) ([]byte, error) {
	clean := strings.ToUpper(strings.ReplaceAll(strings.ReplaceAll(s, " ", ""), "-", ""))
	return base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(clean)
}

// GenerateTOTPSecret returns a new base32 secret (160-bit).
func GenerateTOTPSecret() (string, error) {
	b := make([]byte, 20)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b), nil
}

// ValidateTOTP checks code against current step ±1 (clock drift tolerance).
func ValidateTOTP(secretB32, code string) bool {
	secret, err := decodeSecret(secretB32)
	if err != nil || len(code) != 6 {
		return false
	}
	var got uint32
	if _, err := fmt.Sscanf(code, "%06d", &got); err != nil {
		return false
	}
	now := time.Now()
	for _, d := range []time.Duration{0, -30 * time.Second, 30 * time.Second} {
		if totpCode(secret, 30, now.Add(d)) == got {
			return true
		}
	}
	return false
}

// TOTPURI builds the otpauth:// provisioning URI.
func TOTPURI(account, issuer, secretB32 string) string {
	return fmt.Sprintf("otpauth://totp/%s:%s?secret=%s&issuer=%s&algorithm=SHA1&digits=6&period=30",
		issuer, account, secretB32, issuer)
}
