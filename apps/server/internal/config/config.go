package config

import (
	"crypto/sha256"
	"fmt"
	"log/slog"
	"os"
	"strconv"
)

type Config struct {
	Port               string
	DataDir            string
	SecretKey          string
	LogLevel           slog.Level
	MaxSessionsPerHost int
	EnablePreview      bool
	JWTSecret          []byte
}

func Load() (*Config, error) {
	c := &Config{
		Port:               getenv("PORT", "8090"),
		DataDir:            getenv("DATA_DIR", "./data"),
		SecretKey:          os.Getenv("SECRET_KEY"),
		MaxSessionsPerHost: 10,
	}
	if v := os.Getenv("MAX_SESSIONS_PER_HOST"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return nil, fmt.Errorf("MAX_SESSIONS_PER_HOST invalid: %q", v)
		}
		c.MaxSessionsPerHost = n
	}
	if c.SecretKey == "" {
		return nil, fmt.Errorf("SECRET_KEY is required (encryption key for stored secrets)")
	}
	if len(c.SecretKey) < 16 {
		return nil, fmt.Errorf("SECRET_KEY must be at least 16 characters")
	}
	switch getenv("LOG_LEVEL", "info") {
	case "debug":
		c.LogLevel = slog.LevelDebug
	case "warn":
		c.LogLevel = slog.LevelWarn
	case "error":
		c.LogLevel = slog.LevelError
	default:
		c.LogLevel = slog.LevelInfo
	}
	c.EnablePreview = getenv("ENABLE_PREVIEW", "false") == "true"
	// JWT signing key: purpose-bound derivation from SECRET_KEY.
	j := sha256.Sum256([]byte("ks-ssh:jwt-v1:" + c.SecretKey))
	c.JWTSecret = j[:]
	return c, nil
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// PortAsInt returns the listen port as an int (0 on parse failure).
func (c *Config) PortAsInt() int {
	n, _ := strconv.Atoi(c.Port)
	return n
}
