package sftplayer

import (
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"time"
)

func sha256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func timeNow() time.Time { return time.Now() }

func slogDebug(msg string, args ...any) { slog.Debug(msg, args...) }
