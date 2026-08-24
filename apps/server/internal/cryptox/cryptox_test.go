package cryptox

import (
	"strings"
	"testing"
)

func TestBoxRoundtrip(t *testing.T) {
	b, err := NewBox("super-secret-key-material-01")
	if err != nil {
		t.Fatal(err)
	}
	enc, err := b.Seal([]byte("hunter2-password"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(enc, "hunter2") {
		t.Fatal("plaintext leaked into ciphertext encoding")
	}
	dec, err := b.Open(enc)
	if err != nil {
		t.Fatal(err)
	}
	if string(dec) != "hunter2-password" {
		t.Fatalf("roundtrip mismatch: %q", dec)
	}
}

func TestBoxWrongKeyFails(t *testing.T) {
	a, _ := NewBox("key-one-1234567890")
	c, _ := NewBox("key-two-0987654321")
	enc, _ := a.Seal([]byte("data"))
	if _, err := c.Open(enc); err == nil {
		t.Fatal("decrypting with wrong key must fail")
	}
}

func TestSealedStringEmpty(t *testing.T) {
	b, _ := NewBox("k-0123456789abcdef")
	s, err := b.SealedString("")
	if err != nil || s != "" {
		t.Fatal("empty secret must seal to empty")
	}
}

func TestRedact(t *testing.T) {
	if Redact("") != "" {
		t.Fatal("empty stays empty")
	}
	if got := Redact("abcdef"); !strings.HasSuffix(got, "***") || strings.Contains(got, "def") {
		t.Fatalf("redaction failed: %q", got)
	}
}
