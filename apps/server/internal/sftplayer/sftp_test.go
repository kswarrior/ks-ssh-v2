package sftplayer

import (
	"errors"
	"io/fs"
	"testing"

	"github.com/pkg/sftp"
)

func TestCleanPath(t *testing.T) {
	ok := []struct{ in, want string }{
		{"/etc/nginx/nginx.conf", "/etc/nginx/nginx.conf"},
		{"/a//b/./c", "/a/b/c"},
		{"/", "/"},
	}
	for _, c := range ok {
		got, err := CleanPath(c.in)
		if err != nil || got != c.want {
			t.Fatalf("CleanPath(%q) = %q, %v; want %q", c.in, got, err, c.want)
		}
	}
	bad := []string{"", "relative/path", "/../escape", "/a/../.."}
	for _, p := range bad {
		if _, err := CleanPath(p); !errors.Is(err, ErrOutsideRoot) && err == nil {
			t.Fatalf("CleanPath(%q) accepted traversal", p)
		}
	}
	if _, err := CleanPath("/a/../.."); !errors.Is(err, ErrOutsideRoot) {
		t.Fatalf("double-dot climb must be rejected, got %v", err)
	}
}

func TestTypeOf(t *testing.T) {
	cases := []struct {
		name string
		dir  bool
		want string
	}{
		{"app.py", false, "py"},
		{"main.go", false, "go"},
		{"index.tsx", false, "tsx"},
		{"Dockerfile", false, "conf"},
		{"backup.tar.gz", false, "gz"},
		{"photo.PNG", false, "img"},
		{"unknown.xyz", false, "file"},
		{"src", true, "folder"},
	}
	for _, c := range cases {
		if got := TypeOf(c.name, c.dir); got != c.want {
			t.Errorf("TypeOf(%q,%v)=%q want %q", c.name, c.dir, got, c.want)
		}
	}
}

func TestMapSFTP(t *testing.T) {
	err := &sftp.StatusError{Code: 2}
	mapped := mapSFTP(err)
	if !errors.Is(mapped, fs.ErrNotExist) {
		t.Fatal("status code 2 must map to fs.ErrNotExist")
	}
	other := mapSFTP(&sftp.StatusError{Code: 3})
	if errors.Is(other, fs.ErrNotExist) {
		t.Fatal("other status codes must not map to ErrNotExist")
	}
}
