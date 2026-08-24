package sshlayer

import (
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// SFTPClient abstracts the SFTP session for tests.
type SFTPClient interface {
	Close() error
}

func newSFTP(conn *ssh.Client) (*sftp.Client, error) {
	return sftp.NewClient(conn)
}
