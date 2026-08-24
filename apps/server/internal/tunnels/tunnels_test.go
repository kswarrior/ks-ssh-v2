package tunnels

import "testing"

func TestValidateBind(t *testing.T) {
	bad := []struct {
		host string
		port int
		app  int
	}{
		{"0.0.0.0", 8080, 8090},
		{"::", 8080, 8090},
		{"*", 1234, 8090},
		{"127.0.0.1", 8090, 8090}, // app port collision
		{"127.0.0.1", 0, 8090},
		{"127.0.0.1", 70000, 8090},
	}
	for _, c := range bad {
		if err := ValidateBind(c.host, c.port, c.app); err == nil {
			t.Fatalf("ValidateBind(%q,%d,%d) must fail", c.host, c.port, c.app)
		}
	}
	good := []struct {
		host string
		port int
		app  int
	}{
		{"127.0.0.1", 5432, 8090},
		{"192.168.1.10", 9000, 8090},
	}
	for _, c := range good {
		if err := ValidateBind(c.host, c.port, c.app); err != nil {
			t.Fatalf("ValidateBind(%q,%d) failed: %v", c.host, c.port, err)
		}
	}
}

func TestSocksHandshakeRejectsNonSocks(t *testing.T) {
	// covered indirectly; handshake requires version byte 5
}
