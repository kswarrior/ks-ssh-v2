package sftplayer

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/ks/ks-ssh/server/internal/store"
)

// FetchFromURL streams a remote HTTP(S) resource into an SFTP file
// (Upload ▾ → From URL). SSRF guard: only http(s), no private/link-local.
func (o *Ops) FetchFromURL(ctx context.Context, st *store.Store, rawurl, destDir string, prog func(n int64)) (finalPath string, err error) {
	u, err := url.Parse(rawurl)
	if err != nil {
		return "", fmt.Errorf("bad url: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("only http(s) URLs allowed")
	}
	host := u.Hostname()
	ips, err := net.LookupIP(host)
	if err != nil || len(ips) == 0 {
		return "", fmt.Errorf("cannot resolve %q", host)
	}
	for _, ip := range ips {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
			return "", fmt.Errorf("refusing private/link-local target %s", ip)
		}
	}
	req, err := http.NewRequestWithContext(ctx, "GET", rawurl, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "ks-ssh/1.0")
	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("upstream status %d", resp.StatusCode)
	}
	name := sanitizeName(path.Base(u.Path))
	if name == "" || name == "." || name == "/" {
		name = "download-" + fmt.Sprint(time.Now().Unix())
	}
	cli, err := o.cli()
	if err != nil {
		return "", err
	}
	dp, err := CleanPath(destDir)
	if err != nil {
		return "", err
	}
	finalPath = strings.TrimSuffix(dp, "/") + "/" + name
	dst, err := cli.Create(finalPath)
	if err != nil {
		return "", err
	}
	defer dst.Close()
	buf := make([]byte, 512*1024)
	var n int64
	for {
		select {
		case <-ctx.Done():
			return finalPath, ctx.Err()
		default:
		}
		rn, rerr := resp.Body.Read(buf)
		if rn > 0 {
			if _, werr := dst.Write(buf[:rn]); werr != nil {
				return finalPath, werr
			}
			n += int64(rn)
			if prog != nil {
				prog(n)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return finalPath, rerr
		}
	}
	return finalPath, nil
}

var _ = io.Discard
