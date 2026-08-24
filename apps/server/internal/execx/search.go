package execx

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/ks/ks-ssh/server/internal/sshlayer"
)

type Hit struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

// Grep runs a recursive, bounded search (server-side grep).
func Grep(ctx context.Context, c *sshlayer.Client, root, pattern string, caseSensitive bool, include string, limit int) ([]Hit, error) {
	if strings.TrimSpace(pattern) == "" {
		return nil, fmt.Errorf("empty pattern")
	}
	if limit <= 0 || limit > 2000 {
		limit = 500
	}
	flags := "-rIn -m 1 --binary-files=without-match --exclude-dir=.git -E"
	if !caseSensitive {
		flags += " -i"
	}
	includePart := ""
	if include != "" {
		includePart = " --include=" + shellQuote(include)
	}
	out, _, _, err := run(ctx, c, 30*time.Second,
		fmt.Sprintf(`grep %s %s %s %s 2>/dev/null | head -%d`,
			flags, includePart, shellQuote(pattern), shellQuote(root), limit))
	if err != nil {
		return nil, err
	}
	hits := []Hit{}
	for _, ln := range strings.Split(out, "\n") {
		i := strings.Index(ln, ":")
		j := strings.Index(ln[i+1:], ":")
		if i <= 0 || j < 0 {
			continue
		}
		n, err := strconv.Atoi(ln[i+1 : i+1+j])
		if err != nil || n < 0 {
			continue
		}
		hits = append(hits, Hit{Path: ln[:i], Line: n, Text: ln[i+j+2:]})
	}
	return hits, nil
}

// Replace applies literal replacements via sed across matching files.
// Files are re-validated by grep before sed touches them.
func Replace(ctx context.Context, c *sshlayer.Client, root, pattern, replacement string, caseSensitive bool) (int, error) {
	hits, err := Grep(ctx, c, root, pattern, caseSensitive, "", 2000)
	if err != nil {
		return 0, err
	}
	files := map[string]bool{}
	for _, h := range hits {
		files[h.Path] = true
	}
	n := 0
	for f := range files {
		sedFlags := "s"
		if !caseSensitive {
			sedFlags += "I"
		}
		escPat := strings.ReplaceAll(pattern, "/", `\/`)
		escRep := strings.ReplaceAll(replacement, "/", `\/`)
		escPat = strings.ReplaceAll(escPat, "&", `\&`)
		escRep = strings.ReplaceAll(escRep, "&", `\&`)
		o, eb, code, err := run(ctx, c, 20*time.Second,
			fmt.Sprintf(`sed -i '%s|%s|%s|' %q`, sedFlags, escPat, escRep, f))
		if err != nil || code != 0 {
			return n, opErr("sed", err, o+" "+eb)
		}
		n++
	}
	return n, nil
}

var _ = time.Second
