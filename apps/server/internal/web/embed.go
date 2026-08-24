// Package web embeds the built frontend (apps/web/dist).
// The Makefile copies dist here before `go build`.
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var distFS embed.FS

// FS returns the embedded frontend filesystem (nil-safe when empty).
func FS() fs.FS {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		return nil
	}
	entries, err := fs.ReadDir(sub, ".")
	if err != nil || len(entries) == 0 {
		return nil
	}
	return sub
}
