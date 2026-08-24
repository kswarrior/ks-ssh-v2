// Package execx runs real server-ops commands over SSH:
// git, docker, systemd services, cron, log tailing and grep search.
package execx

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/ks/ks-ssh/server/internal/sshlayer"
)

func run(ctx context.Context, c *sshlayer.Client, timeout time.Duration, cmd string) (string, string, int, error) {
	return c.Run(ctx, timeout, cmd)
}

// ---- Git ----

type GitFile struct {
	Path string `json:"path"`
	X    string `json:"x"`
	Y    string `json:"y"`
}

type GitStatusResult struct {
	Branch string     `json:"branch"`
	Ahead  int        `json:"ahead"`
	Behind int        `json:"behind"`
	Files  []GitFile  `json:"files"`
	Clean  bool       `json:"clean"`
}

func GitStatus(ctx context.Context, c *sshlayer.Client, dir string) (*GitStatusResult, error) {
	script := fmt.Sprintf(
		`cd %q && git rev-parse --abbrev-ref HEAD 2>&1; git status --porcelain=v1 2>&1; git rev-list --left-right --count @{u}...HEAD 2>/dev/null || echo "0 0"`,
		dir)
	out, _, _, err := run(ctx, c, 15*time.Second, script)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(out, "\n")
	st := &GitStatusResult{Files: []GitFile{}}
	if len(lines) > 0 && !strings.HasPrefix(lines[0], "fatal") {
		st.Branch = strings.TrimSpace(lines[0])
	}
	for i := 1; i < len(lines); i++ {
		ln := lines[i]
		if ln == "" {
			continue
		}
		if len(ln) >= 3 && ln[2] == ' ' {
			x, y := string(ln[0]), string(ln[1])
			if x != "?" && y != "?" {
				st.Files = append(st.Files, GitFile{Path: ln[3:], X: x, Y: y})
				continue
			}
			st.Files = append(st.Files, GitFile{Path: strings.TrimSpace(ln[1:]), X: "?", Y: "?"})
			continue
		}
		if f := strings.Fields(ln); len(f) == 2 { // ahead behind counts
			st.Behind, _ = strconv.Atoi(f[0])
			st.Ahead, _ = strconv.Atoi(f[1])
		}
	}
	st.Clean = len(st.Files) == 0
	return st, nil
}

func GitStage(ctx context.Context, c *sshlayer.Client, dir string, paths []string) error {
	args := ""
	for _, p := range paths {
		args += " " + shellQuote(p)
	}
	_, eb, code, err := run(ctx, c, 20*time.Second, fmt.Sprintf(`cd %q && git add --%s`, dir, args))
	if err != nil || code != 0 {
		return opErr("git add", err, eb)
	}
	return nil
}

func GitUnstage(ctx context.Context, c *sshlayer.Client, dir string, paths []string) error {
	args := ""
	for _, p := range paths {
		args += " " + shellQuote(p)
	}
	_, eb, code, err := run(ctx, c, 20*time.Second, fmt.Sprintf(`cd %q && git reset HEAD --%s`, dir, args))
	if err != nil || code != 0 {
		return opErr("git reset", err, eb)
	}
	return nil
}

func GitCommit(ctx context.Context, c *sshlayer.Client, dir, msg string) error {
	msg = strings.ReplaceAll(msg, "\n", " ")
	_, eb, code, err := run(ctx, c, 30*time.Second,
		fmt.Sprintf(`cd %q && git commit -m %s`, dir, shellQuote(msg)))
	if err != nil || code != 0 {
		return opErr("git commit", err, eb)
	}
	return nil
}

type GitLogEntry struct {
	Hash    string `json:"hash"`
	Author  string `json:"author"`
	Date    string `json:"date"`
	Subject string `json:"subject"`
}

func GitLog(ctx context.Context, c *sshlayer.Client, dir string, limit int) ([]GitLogEntry, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	sep := "\x1f"
	out, eb, code, err := run(ctx, c, 15*time.Second,
		fmt.Sprintf(`cd %q && git log --pretty=format:"%%h%s%%an%s%%ci%s%%s" -n %d`, dir, sep, sep, sep, limit))
	if err != nil || code != 0 {
		return nil, opErr("git log", err, eb)
	}
	entries := []GitLogEntry{}
	for _, ln := range strings.Split(out, "\n") {
		parts := strings.Split(ln, sep)
		if len(parts) == 4 {
			entries = append(entries, GitLogEntry{Hash: parts[0], Author: parts[1], Date: parts[2], Subject: parts[3]})
		}
	}
	return entries, nil
}

func GitBranches(ctx context.Context, c *sshlayer.Client, dir string) ([]string, error) {
	out, eb, code, err := run(ctx, c, 15*time.Second,
		fmt.Sprintf(`cd %q && git branch --format='%%(refname:short)'`, dir))
	if err != nil || code != 0 {
		return nil, opErr("git branch", err, eb)
	}
	var out2 []string
	for _, b := range strings.Split(strings.TrimSpace(out), "\n") {
		b = strings.TrimPrefix(b, "* ")
		if b != "" {
			out2 = append(out2, strings.TrimSpace(b))
		}
	}
	return out2, nil
}

func GitSwitch(ctx context.Context, c *sshlayer.Client, dir, branch string) error {
	_, eb, code, err := run(ctx, c, 30*time.Second,
		fmt.Sprintf(`cd %q && git switch %s`, dir, shellQuote(branch)))
	if err != nil || code != 0 {
		return opErr("git switch", err, eb)
	}
	return nil
}

func GitPushPull(ctx context.Context, c *sshlayer.Client, dir, action string) (string, error) {
	switch action {
	case "push", "pull":
	default:
		return "", fmt.Errorf("invalid action %q", action)
	}
	o, eb, code, err := run(ctx, c, 120*time.Second, fmt.Sprintf(`cd %q && git %s 2>&1`, dir, action))
	if err != nil || code != 0 {
		return "", opErr("git "+action, err, eb+" "+o)
	}
	return o, nil
}

// ---- Docker ----

type Container struct {
	ID     string `json:"id"`
	Names  string `json:"names"`
	Image  string `json:"image"`
	State  string `json:"state"`
	Status string `json:"status"`
	Ports  string `json:"ports"`
}

func DockerPS(ctx context.Context, c *sshlayer.Client) ([]Container, error) {
	out, eb, code, err := run(ctx, c, 20*time.Second,
		`docker ps -a --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}|{{.Ports}}'`)
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, opErr("docker ps", err, eb)
	}
	cs := []Container{}
	for _, ln := range strings.Split(out, "\n") {
		p := strings.SplitN(ln, "|", 6)
		if len(p) == 6 {
			cs = append(cs, Container{ID: p[0], Names: p[1], Image: p[2], State: p[3], Status: p[4], Ports: p[5]})
		}
	}
	return cs, nil
}

func DockerAction(ctx context.Context, c *sshlayer.Client, action, id string) (string, error) {
	switch action {
	case "start", "stop", "restart":
	default:
		return "", fmt.Errorf("invalid docker action")
	}
	o, eb, code, err := run(ctx, c, 60*time.Second, fmt.Sprintf(`docker %s %s 2>&1`, action, shellQuote(id)))
	if err != nil || code != 0 {
		return "", opErr("docker "+action, err, eb)
	}
	return o, nil
}

// ---- systemd ----

type Unit struct {
	Unit        string `json:"unit"`
	Load        string `json:"load"`
	Active      string `json:"active"`
	Sub         string `json:"sub"`
	Description string `json:"description"`
}

func ListUnits(ctx context.Context, c *sshlayer.Client) ([]Unit, error) {
	out, _, _, err := run(ctx, c, 20*time.Second,
		`systemctl list-units --type=service --all --no-pager --no-legend 2>/dev/null || chkconfig 2>/dev/null || service --status-all 2>/dev/null`)
	if err != nil {
		return nil, err
	}
	units := []Unit{}
	for _, ln := range strings.Split(out, "\n") {
		f := strings.Fields(ln)
		if len(f) >= 4 {
			units = append(units, Unit{Unit: f[0], Load: f[1], Active: f[2], Sub: f[3],
				Description: strings.Join(f[4:], " ")})
		}
	}
	return units, nil
}

func ServiceAction(ctx context.Context, c *sshlayer.Client, unit, action string) (string, error) {
	switch action {
	case "start", "stop", "restart", "enable", "disable":
	default:
		return "", fmt.Errorf("invalid service action")
	}
	o, eb, code, err := run(ctx, c, 60*time.Second,
		fmt.Sprintf(`systemctl %s %s 2>&1`, action, shellQuote(unit)))
	if err != nil || code != 0 {
		return "", opErr("systemctl "+action, err, eb)
	}
	return o, nil
}

// ---- Cron ----

func CronRead(ctx context.Context, c *sshlayer.Client, user string) ([]string, error) {
	cmd := `crontab -l 2>/dev/null`
	if user != "" && user != "-" {
		cmd = fmt.Sprintf(`crontab -l -u %s 2>/dev/null`, shellQuote(user))
	}
	out, _, code, err := run(ctx, c, 10*time.Second, cmd)
	if err != nil {
		return nil, err
	}
	if code != 0 && strings.TrimSpace(out) == "" {
		return []string{}, nil // empty crontab is fine
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) == 1 && lines[0] == "" {
		return []string{}, nil
	}
	return lines, nil
}

func CronWrite(ctx context.Context, c *sshlayer.Client, user string, lines []string) error {
	payload := strings.Join(lines, "\n") + "\n"
	cmd := `crontab -`
	if user != "" && user != "-" {
		cmd = fmt.Sprintf(`crontab -u %s -`, shellQuote(user))
	}
	// write via stdin using printf to avoid temp files on remote
	esc := strings.ReplaceAll(payload, `\`, `\\`)
	esc = strings.ReplaceAll(esc, `'`, `'\''`)
	full := fmt.Sprintf("printf '%%s' '%s' | %s", esc, cmd)
	o, eb, code, err := run(ctx, c, 15*time.Second, full)
	if err != nil || code != 0 {
		return opErr("crontab write", err, o+" "+eb)
	}
	return nil
}

// ---- helpers ----

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func opErr(op string, err error, stderr string) error {
	msg := strings.TrimSpace(stderr)
	if err != nil {
		if msg == "" {
			msg = err.Error()
		}
	}
	if msg == "" {
		msg = "unknown failure"
	}
	return fmt.Errorf("%s: %s", op, msg)
}
