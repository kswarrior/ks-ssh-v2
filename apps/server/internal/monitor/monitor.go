// Package monitor reads remote metrics from /proc + df over one exec
// channel — no agents installed on the remote host.
package monitor

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/ks/ks-ssh/server/internal/sshlayer"
)

type Sample struct {
	TS        int64   `json:"ts"`
	CPUPercent float64 `json:"cpuPercent"`
	MemTotal  int64   `json:"memTotal"`
	MemUsed   int64   `json:"memUsed"`
	SwapTotal int64   `json:"swapTotal"`
	SwapUsed  int64   `json:"swapUsed"`
	DiskTotal int64   `json:"diskTotal"`
	DiskUsed  int64   `json:"diskUsed"`
	NetRx     float64 `json:"netRx"` // bytes/s
	NetTx     float64 `json:"netTx"`
	Load1     float64 `json:"load1"`
	Load5     float64 `json:"load5"`
	Load15    float64 `json:"load15"`
	UptimeSec int64   `json:"uptimeSec"`
}

type ProcRow struct {
	PID       int64   `json:"pid"`
	User      string  `json:"user"`
	CPUPercent float64 `json:"cpuPercent"`
	MemPercent float64 `json:"memPercent"`
	MemBytes  int64   `json:"memBytes"`
	Command   string  `json:"command"`
}

// probeScript gathers all raw counters in one round-trip.
const probeScript = `
cat /proc/stat | grep '^cpu '
cat /proc/meminfo | grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):'
df -kP / 2>/dev/null | tail -1
grep -E '^(eth0|ens|enp|wlan|venet)' /proc/net/dev 2>/dev/null || tail -n +3 /proc/net/dev
cat /proc/loadavg
cat /proc/uptime
`

type prevCounters struct {
	cpuIdle  float64
	cpuTotal float64
	rx       float64
	tx       float64
	ts       time.Time
}

// Collector keeps previous counter state per client to compute rates.
type Collector struct {
	c    *sshlayer.Client
	prev prevCounters
	mu   chan struct{}
}

func NewCollector(c *sshlayer.Client) *Collector {
	return &Collector{c: c, mu: make(chan struct{}, 1)}
}

func (col *Collector) Sample(ctx context.Context) (*Sample, error) {
	select {
	case col.mu <- struct{}{}:
		defer func() { <-col.mu }()
	default:
		return nil, fmt.Errorf("sample in progress")
	}
	out, _, code, err := col.c.Run(ctx, 10*time.Second, probeScript)
	if err != nil {
		return nil, err
	}
	if code != 0 && strings.TrimSpace(out) == "" {
		return nil, fmt.Errorf("probe failed rc=%d", code)
	}
	lines := strings.Split(out, "\n")
	s := &Sample{TS: time.Now().UnixMilli()}
	var memAvail, swapFree int64
	for _, ln := range lines {
		ln = strings.TrimSpace(ln)
		switch {
		case strings.HasPrefix(ln, "cpu "):
			f := strings.Fields(ln)
			if len(f) >= 5 {
				user, _ := strconv.ParseFloat(f[1], 64)
				nice, _ := strconv.ParseFloat(f[2], 64)
				sys, _ := strconv.ParseFloat(f[3], 64)
				idle, _ := strconv.ParseFloat(f[4], 64)
				iowait := 0.0
				if len(f) >= 6 {
					iowait, _ = strconv.ParseFloat(f[5], 64)
				}
				total := user + nice + sys + idle + iowait
				if col.prev.ts.Unix() > 0 {
					dTotal := total - col.prev.cpuTotal
					dIdle := (idle + iowait) - col.prev.cpuIdle
					if dTotal > 0 {
						s.CPUPercent = clampPct(100 * (dTotal - dIdle) / dTotal)
					}
				}
				col.prev.cpuTotal = total
				col.prev.cpuIdle = idle + iowait
			}
		case strings.HasPrefix(ln, "MemTotal:"):
			s.MemTotal = parseKiB(ln)
		case strings.HasPrefix(ln, "MemAvailable:"):
			memAvail = parseKiB(ln)
		case strings.HasPrefix(ln, "SwapTotal:"):
			s.SwapTotal = parseKiB(ln)
		case strings.HasPrefix(ln, "SwapFree:"):
			swapFree = parseKiB(ln)
		case strings.Contains(ln, "%") && !strings.Contains(ln, " "): // df line has % on root fs row
			parseDfLine(ln, s)
		case strings.Contains(ln, "/"):
			if strings.Count(ln, ":") > 0 && strings.Contains(ln, "|") { // net dev rows have '|'? no
				continue
			}
		default:
		}
		if isNetDev(ln) {
			rx, tx := parseNetDev(ln)
			now := time.Now()
			if col.prev.rx > 0 || col.prev.tx > 0 {
				dt := now.Sub(col.prev.ts).Seconds()
				if dt > 0 {
					s.NetRx = (rx - col.prev.rx) / dt
					s.NetTx = (tx - col.prev.tx) / dt
				}
			}
			col.prev.rx = rx
			col.prev.tx = tx
			col.prev.ts = now
		}
		if looksLikeLoadavg(ln) {
			f := strings.Fields(ln)
			if len(f) >= 3 {
				s.Load1, _ = strconv.ParseFloat(f[0], 64)
				s.Load5, _ = strconv.ParseFloat(f[1], 64)
				s.Load15, _ = strconv.ParseFloat(f[2], 64)
			}
		}
		if looksLikeUptime(ln) {
			f := strings.Fields(ln)
			if len(f) >= 1 {
				up, _ := strconv.ParseFloat(f[0], 64)
				s.UptimeSec = int64(up)
			}
		}
	}
	if memAvail > 0 && s.MemTotal > 0 {
		s.MemUsed = s.MemTotal - memAvail
	}
	s.SwapUsed = s.SwapTotal - swapFree
	if dfErr := sampleDisk(ctx, col.c, s); dfErr != nil {
		// disk stays zero — non-fatal
		_ = dfErr
	}
	return s, nil
}

func sampleDisk(ctx context.Context, c *sshlayer.Client, s *Sample) error {
	out, _, code, err := c.Run(ctx, 8*time.Second, `df -kP / | tail -1`)
	if err != nil || code != 0 {
		return fmt.Errorf("df failed")
	}
	parseDfLine(strings.TrimSpace(out), s)
	return nil
}

func parseDfLine(ln string, s *Sample) {
	// /dev/sda1 40188792 12345678 25788234 33% /
	f := strings.Fields(ln)
	for i := 0; i+2 < len(f); i++ {
		total, err1 := strconv.ParseInt(f[i+1], 10, 64)
		used, err2 := strconv.ParseInt(f[i+2], 10, 64)
		if err1 == nil && err2 == nil && strings.HasSuffix(f[i+4], "%") {
			s.DiskTotal = total * 1024
			s.DiskUsed = used * 1024
			return
		}
	}
}

func isNetDev(ln string) bool {
	if !strings.Contains(ln, ":") {
		return false
	}
	for _, p := range []string{"eth", "ens", "enp", "wlan", "venet", "eno", "wlx", "wwp", "tun", "tap", "en0"} {
		if strings.Contains(ln, p) {
			return true
		}
	}
	return false
}

func parseNetDev(ln string) (float64, float64) {
	parts := strings.SplitN(ln, ":", 2)
	if len(parts) != 2 {
		return 0, 0
	}
	f := strings.Fields(parts[1])
	if len(f) < 9 {
		return 0, 0
	}
	rx, _ := strconv.ParseFloat(f[0], 64)
	tx, _ := strconv.ParseFloat(f[8], 64)
	return rx, tx
}

func looksLikeLoadavg(s string) bool {
	// e.g. "0.52 0.58 0.59 1/612 12345"
	f := strings.Fields(s)
	return len(f) == 5 && strings.Contains(f[3], "/")
}

func looksLikeUptime(s string) bool {
	f := strings.Fields(s)
	if len(f) != 2 {
		return false
	}
	_, e1 := strconv.ParseFloat(f[0], 64)
	_, e2 := strconv.ParseFloat(f[1], 64)
	return e1 == nil && e2 == nil
}

func parseKiB(ln string) int64 {
	f := strings.Fields(ln)
	if len(f) < 2 {
		return 0
	}
	v, _ := strconv.ParseInt(f[1], 10, 64)
	return v * 1024
}

func clampPct(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

// TopProcesses returns a sorted-by-cpu process table via ps.
func TopProcesses(ctx context.Context, c *sshlayer.Client, limit int) ([]ProcRow, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	out, _, code, err := c.Run(ctx, 10*time.Second,
		fmt.Sprintf(`ps aux --sort=-%%cpu 2>/dev/null | head -%d`, limit+7))
	if err != nil || code != 0 {
		return nil, fmt.Errorf("ps unavailable")
	}
	rows := []ProcRow{}
	for _, ln := range strings.Split(out, "\n") {
		f := strings.Fields(ln)
		if len(f) < 11 || f[0] == "USER" {
			continue
		}
		pid, _ := strconv.ParseInt(f[1], 10, 64)
		cpu, _ := strconv.ParseFloat(f[2], 64)
		memPct, _ := strconv.ParseFloat(f[3], 64)
		memKB, _ := strconv.ParseInt(f[5], 10, 64)
		if pid == 0 {
			continue
		}
		rows = append(rows, ProcRow{
			PID: pid, User: f[0],
			CPUPercent: cpu, MemPercent: memPct,
			MemBytes: memKB * 1024,
			Command:  strings.Join(f[10:], " "),
		})
		if len(rows) >= limit {
			break
		}
	}
	return rows, nil
}
