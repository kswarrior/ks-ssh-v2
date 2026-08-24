package monitor

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/ks/ks-ssh/server/internal/sshlayer"
)

type SystemInfo struct {
	Hostname      string `json:"hostname"`
	OS            string `json:"os"`
	OSVersion     string `json:"osVersion"`
	Kernel        string `json:"kernel"`
	Arch          string `json:"arch"`
	CPUModel      string `json:"cpuModel"`
	CPUCores      int    `json:"cpuCores"`
	RAMTotal      int64  `json:"ramTotal"`
	DiskTotal     int64  `json:"diskTotal"`
	Virtualization string `json:"virtualization"`
	PublicIP      string `json:"publicIp"`
	Distro        string `json:"distro"`
	Logo          string `json:"logo"`
	UptimeSec     int64  `json:"uptimeSec"`
}

const infoScript = `
hostname 2>/dev/null
uname -srmo 2>/dev/null
grep PRETTY_NAME /etc/os-release 2>/dev/null | cut -d= -f2- | tr -d '"'
nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo
grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ //'
grep MemTotal /proc/meminfo 2>/dev/null
df -kP / 2>/dev/null | tail -1
cat /proc/uptime 2>/dev/null
systemd-detect-virt 2>/dev/null || ( [ -f /proc/user_beancounters ] && echo openvz ) || ( grep -q docker /proc/1/cgroup 2>/dev/null && echo docker ) || echo unknown
curl -4s --max-time 3 https://api.ipify.org 2>/dev/null || wget -4qO- --timeout=3 https://api.ipify.org 2>/dev/null || echo ""
`

func GetSystemInfo(ctx context.Context, c *sshlayer.Client) (*SystemInfo, error) {
	out, _, code, err := c.Run(ctx, 20*time.Second, infoScript)
	if err != nil {
		return nil, err
	}
	if code != 0 && strings.TrimSpace(out) == "" {
		return nil, fmt.Errorf("info probe failed")
	}
	lines := nonEmpty(out)
	info := &SystemInfo{Virtualization: "unknown"}
	get := func(i int) string {
		if i < len(lines) {
			return lines[i]
		}
		return ""
	}
	idx := 0
	info.Hostname = get(idx); idx++
	uname := get(idx); idx++ // "Linux 5.15.0-91-generic x86_64 GNU/Linux"
	info.Distro = strings.Trim(get(idx), `"'`); idx++
	ncores := get(idx); idx++
	info.CPUModel = get(idx); idx++
	memTotalLine := get(idx); idx++
	dfLine := get(idx); idx++
	uptimeLine := get(idx); idx++
	virt := get(idx); idx++
	pubIP := get(idx)

	if f := strings.Fields(uname); len(f) >= 1 {
		info.OS = f[0]
		if len(f) >= 2 {
			info.Kernel = f[1]
			info.OSVersion = kernelVer(f[1])
		}
		if len(f) >= 3 {
			info.Arch = f[2]
		}
	}
	info.DistroLogoHint(info.Distro)
	info.CPUCores, _ = strconv.Atoi(ncores)
	if info.CPUCores <= 0 {
		info.CPUCores = 1
	}
	if strings.HasPrefix(memTotalLine, "MemTotal:") {
		info.RAMTotal = parseKiB(memTotalLine)
	}
	var s Sample
	parseDfLine(dfLine, &s)
	info.DiskTotal = s.DiskTotal
	if f := strings.Fields(uptimeLine); len(f) >= 1 {
		up, _ := strconv.ParseFloat(f[0], 64)
		info.UptimeSec = int64(up)
	}
	switch strings.ToLower(virt) {
	case "kvm", "vmware", "oracle", "xen", "microsoft", "qemu", "bochs", "parallels":
		info.Virtualization = virt
	case "none":
		info.Virtualization = "bare-metal"
	default:
		info.Virtualization = strings.ToLower(virt)
	}
	if pubIP != "" && isPublicIP(pubIP) {
		info.PublicIP = pubIP
	}
	return info, nil
}

var verRe = regexp.MustCompile(`\d+\.\d+[\w.\-]*`)

func kernelVer(k string) string { return verRe.FindString(k) }

var privateRanges = []string{"10.", "192.168.", "172.16.", "127.", "169.254."}

func isPublicIP(ip string) bool {
	for _, p := range privateRanges {
		if strings.HasPrefix(ip, p) {
			return false
		}
	}
	return true
}

func nonEmpty(s string) []string {
	var out []string
	for _, ln := range strings.Split(s, "\n") {
		ln = strings.TrimSpace(ln)
		if ln != "" {
			out = append(out, ln)
		}
	}
	return out
}

// distro slug helper for frontend logos.
func (i *SystemInfo) DistroLogoHint(distro string) {
	d := strings.ToLower(distro)
	switch {
	case strings.Contains(d, "ubuntu"):
		i.Logo = "ubuntu"
	case strings.Contains(d, "debian"):
		i.Logo = "debian"
	case strings.Contains(d, "centos"):
		i.Logo = "centos"
	case strings.Contains(d, "almalinux"):
		i.Logo = "alma"
	case strings.Contains(d, "rocky"):
		i.Logo = "rocky"
	case strings.Contains(d, "alpine"):
		i.Logo = "alpine"
	case strings.Contains(d, "fedora"):
		i.Logo = "fedora"
	case strings.Contains(d, "arch"):
		i.Logo = "arch"
	case strings.Contains(d, "rhel") || strings.Contains(d, "red hat"):
		i.Logo = "rhel"
	default:
		i.Logo = "linux"
	}
}
