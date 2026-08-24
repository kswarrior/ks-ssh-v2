// Package sftplayer implements remote filesystem operations over the
// multiplexed SSH connection: browse, create, rename, move, copy, delete,
// chmod, search, streamed zip downloads and chunked resumable uploads.
package sftplayer

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/pkg/sftp"

	"github.com/ks/ks-ssh/server/internal/sshlayer"
)

var ErrOutsideRoot = errors.New("path escapes operation root")

// Ops groups SFTP helpers around one connected host client.
type Ops struct {
	C *sshlayer.Client
}

func New(c *sshlayer.Client) *Ops { return &Ops{C: c} }

func (o *Ops) cli() (*sftp.Client, error) { return o.C.SFTP() }

// CleanPath normalizes and rejects traversal attempts.
// Any ".." segment is rejected outright (defense in depth; symlink
// escapes are additionally caught by realPath prefix checks).
func CleanPath(p string) (string, error) {
	if p == "" {
		return "", errors.New("empty path")
	}
	if !strings.HasPrefix(p, "/") {
		return "", fmt.Errorf("path must be absolute: %q", p)
	}
	// reject any ".." segment in the raw input (before normalization)
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." {
			return "", ErrOutsideRoot
		}
	}
	cleaned := path.Clean(p)
	if cleaned == "" || cleaned == "." || strings.HasPrefix(cleaned, "../") || strings.Contains(cleaned, "/../") {
		return "", ErrOutsideRoot
	}
	for _, seg := range strings.Split(cleaned, "/") {
		if seg == ".." {
			return "", ErrOutsideRoot
		}
	}
	return cleaned, nil
}

func (o *Ops) safeResolve(root, p string) (string, error) {
	cp, err := CleanPath(p)
	if err != nil {
		return "", err
	}
	cr, err := CleanPath(root)
	if err != nil {
		return "", err
	}
	cli, err := o.cli()
	if err != nil {
		return "", err
	}
	realP, err := realPath(cli, cp)
	if err != nil {
		return "", err
	}
	realR, rerr := realPath(cli, cr)
	if rerr != nil {
		realR = cr // root may not exist yet (mkdir chains)
	}
	if realP != realR && !strings.HasPrefix(realP, strings.TrimSuffix(realR, "/")+"/") {
		return "", ErrOutsideRoot
	}
	return cp, nil
}

func realPath(cli *sftp.Client, p string) (string, error) {
	rp, err := cli.RealPath(p)
	if err == nil {
		return rp, nil
	}
	// RealPath fails if the leaf does not exist — resolve the parent instead.
	dir, base := path.Split(strings.TrimSuffix(p, "/"))
	if dir == "" {
		return p, nil
	}
	rd, err := cli.RealPath(dir)
	if err != nil {
		return "", err
	}
	return path.Join(rd, base), nil
}

// ---- entry model ----

type Entry struct {
	Name          string    `json:"name"`
	Path          string    `json:"path"`
	IsDir         bool      `json:"isDir"`
	IsSymlink     bool      `json:"isSymlink"`
	SymlinkTarget string    `json:"symlinkTarget,omitempty"`
	Size          int64     `json:"size"`
	Mode          string    `json:"mode"`
	Perms         string    `json:"perms"`
	Owner         string    `json:"owner"`
	Group         string    `json:"group"`
	ModTime       time.Time `json:"modTime"`
	ItemType      string    `json:"itemType"`
}

func modeString(m os.FileMode) string {
	s := m.Perm().String()
	switch {
	case m.IsDir():
		s = "d" + s
	case m&os.ModeSymlink != 0:
		s = "l" + s
	default:
		s = "-" + s
	}
	return s
}

func octal(m os.FileMode) string { return fmt.Sprintf("0%o", uint32(m.Perm())) }

// List reads a directory (entries sorted dirs-first).
func (o *Ops) List(dir string) ([]*Entry, error) {
	p, err := o.safeResolve("/", dir)
	if err != nil {
		return nil, err
	}
	cli, err := o.cli()
	if err != nil {
		return nil, err
	}
	items, err := cli.ReadDir(p)
	if err != nil {
		return nil, mapSFTP(err)
	}
	out := make([]*Entry, 0, len(items))
	for _, it := range items {
		full := path.Join(p, it.Name())
		e := &Entry{
			Name:      it.Name(),
			Path:      full,
			IsDir:     it.IsDir(),
			Size:      it.Size(),
			ModTime:   it.ModTime(),
			ItemType:  TypeOf(it.Name(), it.IsDir()),
		}
		e.Mode = octal(it.Mode())
		e.Perms = modeString(it.Mode())
		if fstat, ok := it.Sys().(*sftp.FileStat); ok {
			e.Owner = fmt.Sprint(fstat.UID)
			e.Group = fmt.Sprint(fstat.GID)
		}
		if it.Mode()&os.ModeSymlink != 0 {
			e.IsSymlink = true
			if tgt, err := cli.ReadLink(full); err == nil {
				e.SymlinkTarget = tgt
				// surface link target type without following outside
				if st, err := cli.Stat(full); err == nil {
					e.IsDir = st.IsDir()
				}
			}
		}
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

func mapSFTP(err error) error {
	var se *sftp.StatusError
	if errors.As(err, &se) && uint32(se.Code) == 2 {
		return fs.ErrNotExist
	}
	return err
}

// Stat one path.
func (o *Ops) Stat(p string) (*Entry, error) {
	sp, err := o.safeResolve("/", p)
	if err != nil {
		return nil, err
	}
	cli, err := o.cli()
	if err != nil {
		return nil, err
	}
	st, err := cli.Stat(sp)
	if err != nil {
		return nil, mapSFTP(err)
	}
	dir := path.Dir(sp)
	e := &Entry{
		Name:     path.Base(sp),
		Path:     sp,
		IsDir:    st.IsDir(),
		Size:     st.Size(),
		ModTime:  st.ModTime(),
		ItemType: TypeOf(sp, st.IsDir()),
		Mode:     octal(st.Mode()),
		Perms:    modeString(st.Mode()),
	}
	_ = dir
	return e, nil
}

// ---- mutations (audited by caller) ----

func (o *Ops) Mkdir(p string) error {
	tp, err := o.safeResolve(path.Dir(p), p)
	if err != nil {
		return err
	}
	cli, err := o.cli()
	if err != nil {
		return err
	}
	return cli.MkdirAll(tp)
}

func (o *Ops) Rename(from, to string) error {
	f, err := o.safeResolve(path.Dir(from), from)
	if err != nil {
		return err
	}
	t, err := o.safeResolve(path.Dir(to), to)
	if err != nil {
		return err
	}
	cli, err := o.cli()
	if err != nil {
		return err
	}
	return cli.Rename(f, t)
}

// Copy copies a file or directory tree server-side via SFTP reads/writes.
func (o *Ops) Copy(ctx context.Context, from, to string, prog func(n int64)) error {
	sf, err := o.safeResolve("/", from)
	if err != nil {
		return err
	}
	st, err := o.safeResolve("/", to)
	if err != nil {
		return err
	}
	cli, err := o.cli()
	if err != nil {
		return err
	}
	info, err := cli.Stat(sf)
	if err != nil {
		return mapSFTP(err)
	}
	if info.IsDir() {
		return o.copyTree(ctx, cli, sf, st, prog)
	}
	return o.copyFile(ctx, cli, sf, st, info.Size(), prog)
}

func (o *Ops) copyFile(ctx context.Context, cli *sftp.Client, from, to string, size int64, prog func(int64)) error {
	src, err := cli.Open(from)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := cli.Create(to)
	if err != nil {
		return err
	}
	defer dst.Close()
	buf := make([]byte, 512*1024)
	var copied int64
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		n, rerr := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return werr
			}
			copied += int64(n)
			if prog != nil {
				prog(copied)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return rerr
		}
	}
	_ = size
	return nil
}

func (o *Ops) copyTree(ctx context.Context, cli *sftp.Client, from, to string, prog func(int64)) error {
	if err := cli.MkdirAll(to); err != nil {
		return err
	}
	items, err := cli.ReadDir(from)
	if err != nil {
		return err
	}
	for _, it := range items {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		src := path.Join(from, it.Name())
		dst := path.Join(to, it.Name())
		if it.IsDir() {
			if err := o.copyTree(ctx, cli, src, dst, prog); err != nil {
				return err
			}
		} else if it.Mode()&os.ModeSymlink != 0 {
			continue // never follow links outward during copy
		} else {
			if err := o.copyFile(ctx, cli, src, dst, it.Size(), prog); err != nil {
				return err
			}
		}
	}
	return nil
}

func (o *Ops) Delete(ctx context.Context, p string) error {
	dp, err := o.safeResolve("/", p)
	if err != nil {
		return err
	}
	cli, err := o.cli()
	if err != nil {
		return err
	}
	st, err := cli.Lstat(dp)
	if err != nil {
		return mapSFTP(err)
	}
	// Never follow the final symlink when deleting.
	if st.Mode()&os.ModeSymlink != 0 {
		return cli.Remove(dp)
	}
	if st.IsDir() {
		return o.removeTree(ctx, cli, dp)
	}
	return cli.Remove(dp)
}

func (o *Ops) removeTree(ctx context.Context, cli *sftp.Client, p string) error {
	items, err := cli.ReadDir(p)
	if err != nil {
		return err
	}
	for _, it := range items {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		child := path.Join(p, it.Name())
		if it.IsDir() && it.Mode()&os.ModeSymlink == 0 {
			if err := o.removeTree(ctx, cli, child); err != nil {
				return err
			}
		} else if err := cli.Remove(child); err != nil {
			return err
		}
	}
	return cli.RemoveDirectory(p)
}

func (o *Ops) Chmod(p, mode string) error {
	tp, err := o.safeResolve("/", p)
	if err != nil {
		return err
	}
	cli, err := o.cli()
	if err != nil {
		return err
	}
	var perm uint32
	if _, err := fmt.Sscanf(mode, "%o", &perm); err != nil {
		return fmt.Errorf("invalid mode %q", mode)
	}
	st, err := cli.Lstat(tp)
	if err != nil {
		return err
	}
	return cli.Chmod(tp, fs.FileMode(perm)|(st.Mode()&(os.ModeSymlink|os.ModeDir)))
}

// Search walks root matching glob case-insensitively, bounded depth/count,
// skipping symlinks entirely (traversal-safe).
func (o *Ops) Search(ctx context.Context, root, pattern string, limit int) ([]*Entry, error) {
	rp, err := o.safeResolve("/", root)
	if err != nil {
		return nil, err
	}
	cli, err := o.cli()
	if err != nil {
		return nil, err
	}
	want := strings.ToLower(pattern)
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	out := []*Entry{}
	var walk func(dir string, depth int) error
	walk = func(dir string, depth int) error {
		if depth > 12 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		items, err := cli.ReadDir(dir)
		if err != nil {
			return nil // unreadable dir — skip silently (permission denied is expected)
		}
		for _, it := range items {
			if len(out) >= limit {
				return nil
			}
			name := it.Name()
			matched, _ := path.Match(want, strings.ToLower(name))
			if matched {
				full := path.Join(dir, name)
				out = append(out, &Entry{
					Name: name, Path: full, IsDir: it.IsDir(), Size: it.Size(),
					ModTime: it.ModTime(), ItemType: TypeOf(name, it.IsDir()),
					Perms: modeString(it.Mode()), Mode: octal(it.Mode()),
				})
			}
			if it.IsDir() && it.Mode()&os.ModeSymlink == 0 {
				if err := walk(path.Join(dir, name), depth+1); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := walk(rp, 0); err != nil {
		return out, err
	}
	slog.Debug("file search done", "root", rp, "pattern", pattern, "hits", len(out))
	return out, nil
}

// OpenRead opens a remote file for streaming download.
func (o *Ops) OpenRead(p string) (*sftp.File, error) {
	sp, err := o.safeResolve("/", p)
	if err != nil {
		return nil, err
	}
	cli, err := o.cli()
	if err != nil {
		return nil, err
	}
	return cli.Open(sp)
}

// WriteFile atomically replaces a remote file's content (temp + rename).
func (o *Ops) WriteFile(p string, content []byte) error {
	sp, err := o.safeResolve("/", p)
	if err != nil {
		return err
	}
	cli, err := o.cli()
	if err != nil {
		return err
	}
	dir := path.Dir(sp)
	base := path.Base(sp)
	tmp := path.Join(dir, "."+base+".ks-tmp")
	f, err := cli.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := f.Write(content); err != nil {
		f.Close()
		_ = cli.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := cli.PosixRename(tmp, sp); err != nil {
		if rerr := cli.Rename(tmp, sp); rerr != nil {
			return fmt.Errorf("write finalize: %w (orig %v)", rerr, err)
		}
	}
	return nil
}

// TypeOf maps filename → item type for icons/syntax.
func TypeOf(name string, isDir bool) string {
	if isDir {
		return "folder"
	}
	base := strings.ToLower(path.Base(name))
	switch strings.TrimSuffix(base, path.Ext(base)) {
	case "dockerfile":
		return "conf"
	case "makefile":
		return "conf"
	}
	ext := strings.TrimPrefix(strings.ToLower(path.Ext(name)), ".")
	tarExts := map[string]string{"tar": "tar", "tgz": "gz"}
	if v, ok := tarExts[ext]; ok {
		return v
	}
	switch ext {
	case "js", "mjs", "cjs":
		return "js"
	case "ts", "mts":
		return "ts"
	case "jsx":
		return "jsx"
	case "tsx":
		return "tsx"
	case "py":
		return "py"
	case "go":
		return "go"
	case "json":
		return "json"
	case "yml":
		return "yml"
	case "yaml":
		return "yaml"
	case "html", "htm":
		return "html"
	case "css":
		return "css"
	case "scss", "sass":
		return "scss"
	case "sh", "bash", "zsh":
		return "sh"
	case "md", "markdown":
		return "md"
	case "zip", "7z", "rar", "xz", "bz2":
		return "zip"
	case "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico":
		return "img"
	case "pdf":
		return "pdf"
	case "mp3", "wav", "flac", "ogg":
		return "mp3"
	case "mp4", "mkv", "avi", "mov", "webm":
		return "mp4"
	case "log":
		return "log"
	case "conf", "ini", "toml", "cfg", "env", "service":
		return "conf"
	case "sql":
		return "sql"
	case "rs":
		return "rs"
	case "java":
		return "java"
	case "c", "h":
		return "c"
	case "cpp", "cc", "hpp":
		return "cpp"
	case "php":
		return "php"
	case "rb":
		return "rb"
	case "xml":
		return "xml"
	case "csv":
		return "csv"
	case "lock":
		return "lock"
	case "gz":
		return "gz"
	default:
		return "file"
	}
}

var _ = slog.Info
