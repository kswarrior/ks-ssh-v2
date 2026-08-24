// Package ports lists listening ports on a remote host by parsing
// `ss -tlnp` (netstat fallback) and performs re-validated kills.
package ports

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/ks/ks-ssh/server/internal/sshlayer"
)

type Row struct {
	Protocol    string `json:"protocol"` // tcp | udp
	Port        int    `json:"port"`
	BindAddress string `json:"bindAddress"`
	PID         *int64 `json:"pid"`
	Process     string `json:"process"`
}

func List(ctx context.Context, c *sshlayer.Client) ([]Row, error) {
	out, errb, code, err := c.Run(ctx, 15*time.Second, "ss -tulnp 2>/dev/null || netstat -tulnp 2>/dev/null")
	if err != nil || code != 0 {
		if err == nil && strings.TrimSpace(out) == "" {
			return nil, fmt.Errorf("no output from ss/netstat (stderr: %s)", errb)
		}
		if err != nil {
			return nil, err
		}
	}
	rows := parseSS(out)
	if len(rows) == 0 {
		rows = parseNetstat(out)
	}
	return rows, nil
}

func parseSS(out string) []Row {
	var rows []Row
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) < 5 {
			continue
		}
		var proto string
		switch f[0] {
		case "tcp", "tcp4", "tcp6", "udp", "udp4", "udp6":
			proto = strings.TrimSuffix(strings.TrimPrefix(f[0], "tcp"), "46")
			if f[0] == "udp" || f[0] == "udp4" || f[0] == "udp6" {
				proto = "udp"
			} else {
				proto = "tcp"
			}
		default:
			continue
		}
		// state column only in tcp lines; find local address col
		localIdx := 4
		state := f[1]
		if proto == "udp" || state == "UNCONN" || state == "LISTEN" {
			localIdx = 4
		} else if isState(state) {
			localIdx = 4
		} else {
			continue
		}
		if localIdx >= len(f) {
			continue
		}
		local := f[localIdx]
		host, port := splitAddr(local)
		if port <= 0 {
			continue
		}
		row := Row{Protocol: proto, Port: port, BindAddress: host, Process: ""}
		rest := strings.Join(f[localIdx+1:], " ")
		if i := strings.Index(rest, "users:((\""); i >= 0 {
			seg := rest[i:]
			pid, name := parseUsers(seg)
			row.PID = pid
			row.Process = name
		}
		rows = append(rows, row)
	}
	return rows
}

func isState(s string) bool {
	switch s {
	case "LISTEN", "UNCONN", "ESTAB":
		return true
	}
	return false
}

func splitAddr(a string) (string, int) {
	i := strings.LastIndex(a, ":")
	if i < 0 {
		return "", -1
	}
	port, err := strconv.Atoi(a[i+1:])
	if err != nil {
		return "", -1
	}
	return strings.Trim(a[:i], "[]"), port
}

func parseUsers(seg string) (*int64, string) {
	// users:(("nginx",pid=1234,fd=6))
	start := strings.Index(seg, "(\"")
	if start < 0 {
		return nil, ""
	}
	rest := seg[start+2:]
	end := strings.Index(rest, "\"")
	if end < 0 {
		return nil, ""
	}
	name := rest[:end]
	var pid int64
	if i := strings.Index(rest, "pid="); i >= 0 {
		ps := rest[i+4:]
		j := 0
		for j < len(ps) && ps[j] >= '0' && ps[j] <= '9' {
			j++
		}
		pid, _ = strconv.ParseInt(ps[:j], 10, 64)
	}
	if pid <= 0 {
		return nil, name
	}
	return &pid, name
}

func parseNetstat(out string) []Row {
	var rows []Row
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) < 6 || (f[0] != "tcp" && f[0] != "tcp6" && f[0] != "udp" && f[0] != "udp6") {
			continue
		}
		proto := "tcp"
		if strings.HasPrefix(f[0], "udp") {
			proto = "udp"
		}
		local := f[3]
		host, port := splitAddr(local)
		if port <= 0 {
			continue
		}
		row := Row{Protocol: proto, Port: port, BindAddress: host}
		if len(f) >= 7 {
			last := f[len(f)-1]
			if i := strings.Index(last, "/"); i > 0 {
				if pid, err := strconv.ParseInt(last[:i], 10, 64); err == nil {
					row.PID = &pid
					row.Process = last[i+1:]
				}
			}
		}
		rows = append(rows, row)
	}
	return rows
}

// Kill validates the PID still exists (and owns the expected listening
// socket when expectPort > 0) before sending SIGTERM — no stale-PID kills.
func Kill(ctx context.Context, c *sshlayer.Client, pid int64, expectPort int) error {
	if pid <= 1 { // refuse init
		return fmt.Errorf("refusing to kill PID %d", pid)
	}
	check := fmt.Sprintf(
		`ls -l /proc/%d/fd 2>/dev/null | grep -c 'socket:\[' ; cat /proc/%d/cmdline 2>/dev/null | tr '\0' ' '`,
		pid, pid,
	)
	out, _, code, err := c.Run(ctx, 10*time.Second, check)
	if err != nil {
		return err
	}
	if code != 0 || strings.TrimSpace(out) == "" {
		return fmt.Errorf("PID %d does not exist on this host anymore", pid)
	}
	sockCount := 0
	fmt.Sscanf(strings.TrimSpace(out), "%d", &sockCount)
	cmdline := out
	if i := strings.Index(out, "\n"); i >= 0 {
		fmt.Sscanf(strings.TrimSpace(out[:i]), "%d", &sockCount)
		cmdline = out[i+1:]
	}
	if sockCount == 0 && expectPort > 0 {
		return fmt.Errorf("PID %d holds no sockets — refusing stale-PID kill", pid)
	}
	if expectPort > 0 {
		okPort, _ := pidOwnsPort(ctx, c, pid, expectPort)
		if !okPort {
			return fmt.Errorf("PID %d does not currently own port %d — refusing stale kill", pid, expectPort)
		}
	}
	_ = cmdline
	o, eb, cc, err := c.Run(ctx, 10*time.Second, fmt.Sprintf("kill -TERM %d && echo KS_KILL_SENT", pid))
	if err != nil {
		return err
	}
	if cc != 0 || !strings.Contains(o, "KS_KILL_SENT") {
		return fmt.Errorf("kill failed: %s %s", o, eb)
	}
	return nil
}

func pidOwnsPort(ctx context.Context, c *sshlayer.Client, pid int64, port int) (bool, error) {
	out, _, code, err := c.Run(ctx, 10*time.Second,
		fmt.Sprintf(`inode=$(readlink /proc/%d/fd/* 2>/dev/null | grep -o 'socket:\[[0-9]*\]' | grep -o '[0-9]*'); for f in /proc/net/tcp /proc/net/tcp6 /proc/net/udp /proc/net/udp6; do [ -r $f ] && grep -E ":[0-9A-F]{4} .*" $f | awk '{print $10}' | grep -qx "$inode" && echo YES; done`, pid))
	if err != nil || code != 0 {
		// fall back to ss-based ownership check
		list, lerr := List(ctx, c)
		if lerr != nil {
			return false, lerr
		}
		for _, r := range list {
			if r.PID != nil && *r.PID == pid && r.Port == port {
				return true, nil
			}
		}
		return false, nil
	}
	return strings.Contains(out, "YES"), nil
}
