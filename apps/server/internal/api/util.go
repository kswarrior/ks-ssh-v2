package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"strconv"
	"strings"

	"github.com/ks/ks-ssh/server/internal/ports"
	"github.com/ks/ks-ssh/server/internal/sshlayer"
	"github.com/ks/ks-ssh/server/internal/tunnels"
)

func jsonDecodeBytes(b []byte, v any) error {
	return json.Unmarshal(b, v)
}

func jsonMarshal(v any) ([]byte, error) {
	return json.Marshal(v)
}

// unifiedDiff produces a minimal unified diff (no external deps).
func unifiedDiff(oldStr, newStr string) string {
	oldLines := splitLines(oldStr)
	newLines := splitLines(newStr)
	var b strings.Builder
	same := true
	n := len(oldLines)
	if len(newLines) > n {
		n = len(newLines)
	}
	for i := 0; i < n; i++ {
		switch {
		case i < len(oldLines) && i < len(newLines) && oldLines[i] == newLines[i]:
			b.WriteString("  " + oldLines[i] + "\n")
		default:
			same = false
			if i < len(oldLines) {
				b.WriteString("- " + oldLines[i] + "\n")
			}
			if i < len(newLines) {
				b.WriteString("+ " + newLines[i] + "\n")
			}
		}
	}
	if same {
		return ""
	}
	return "--- remote\n+++ local\n" + b.String()
}

func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	lines := strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

// thin wrappers so handler files don't import ports/tunnels directly.
func portsList(ctx context.Context, c *sshlayer.Client) ([]ports.Row, error) {
	return ports.List(ctx, c)
}

func portsKill(ctx context.Context, c *sshlayer.Client, pid int64, port int) error {
	return ports.Kill(ctx, c, pid, port)
}

func validateBind(host string, port int, appPort int) error {
	appPortN, err := strconv.Atoi(appPortStr(appPort))
	if err != nil {
		return err
	}
	return tunnels.ValidateBind(host, port, appPortN)
}

func appPortStr(p int) string { return strconv.Itoa(p) }

var _ = fmt.Sprintf
var _ = net.JoinHostPort
