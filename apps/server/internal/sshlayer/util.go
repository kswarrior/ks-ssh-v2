package sshlayer

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

// fingerprintBytes returns the OpenSSH-style SHA256 fingerprint for a key blob.
func fingerprintBytes(blob []byte) string {
	h := sha256.Sum256(blob)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(h[:])
}

func sha256sum(b []byte) []byte {
	h := sha256.Sum256(b)
	return h[:]
}

var _ = sha256sum // reserved for future chunk checksums

func parseKey(data, passphrase string) (ssh.Signer, error) {
	if strings.TrimSpace(data) == "" {
		return nil, errors.New("private key empty")
	}
	if passphrase != "" {
		return ssh.ParsePrivateKeyWithPassphrase([]byte(data), []byte(passphrase))
	}
	signer, err := ssh.ParsePrivateKey([]byte(data))
	if err == nil {
		return signer, nil
	}
	// Key may be encrypted but stored without a passphrase marker.
	if _, ok := err.(*ssh.PassphraseMissingError); ok {
		return nil, errors.New("private key requires a passphrase")
	}
	return nil, fmt.Errorf("parse private key: %w", err)
}

// localAgent connects to the server process SSH_AUTH_SOCK agent.
func localAgent() (agent.Agent, error) {
	sock := os.Getenv("SSH_AUTH_SOCK")
	if sock == "" {
		return nil, errors.New("SSH_AUTH_SOCK not set on KS SSH server host")
	}
	conn, err := net.DialTimeout("unix", sock, 3*time.Second)
	if err != nil {
		return nil, fmt.Errorf("agent socket: %w", err)
	}
	return agent.NewClient(conn), nil
}
