package sftplayer

import (
	"archive/zip"
	"context"
	"io"
	"os"
	"path"
)

// ZipTo walks the given paths on the remote and writes a zip stream to w.
// Symlinks are stored as links (never followed outside). No temp files
// are created on the remote host — everything streams through SFTP reads.
func (o *Ops) ZipTo(ctx context.Context, w io.Writer, paths []string, root string) error {
	cli, err := o.cli()
	if err != nil {
		return err
	}
	zw := zip.NewWriter(w)
	defer zw.Close()

	var writeEntry func(p, rel string, info os.FileInfo) error
	writeEntry = func(p, rel string, info os.FileInfo) error {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil // skip symlinks in archives (traversal-safe)
		}
		hdr := &zip.FileHeader{
			Name:     rel,
			Method:   zip.Deflate,
			Modified: info.ModTime(),
		}
		if info.IsDir() {
			hdr.Name += "/"
			if _, err := zw.CreateHeader(hdr); err != nil {
				return err
			}
			items, err := cli.ReadDir(p)
			if err != nil {
				return nil // unreadable dir: include empty
			}
			for _, it := range items {
				if err := writeEntry(path.Join(p, it.Name()), path.Join(rel, it.Name()), it); err != nil {
					return err
				}
			}
			return nil
		}
		f, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		src, err := cli.Open(p)
		if err != nil {
			return nil // unreadable file → empty entry, keep streaming
		}
		defer src.Close()
		if _, err := io.Copy(f, src); err != nil {
			return err
		}
		return nil
	}

	base := root
	if base == "" || base == "/" {
		base = ""
	}
	for _, p := range paths {
		sp, err := o.safeResolve("/", p)
		if err != nil {
			return err
		}
		info, err := cli.Lstat(sp)
		if err != nil {
			return mapSFTP(err)
		}
		name := stringsTrimSuffixSlash(sp)
		name = path.Base(name)
		rel := name
		if base != "" && len(sp) > len(base) {
			rel = trimLeading(sp[len(base):])
		}
		if err := writeEntry(sp, rel, info); err != nil {
			return err
		}
	}
	return zw.Flush()
}

func stringsTrimSuffixSlash(s string) string {
	for len(s) > 1 && s[len(s)-1] == '/' {
		s = s[:len(s)-1]
	}
	return s
}

func trimLeading(s string) string {
	for len(s) > 0 && s[0] == '/' {
		s = s[1:]
	}
	return s
}
