package ports

import "testing"

const ssOut = `Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Address Process
udp   UNCONN 0      0      0.0.0.0:68        0.0.0.0:* users:(("dhclient",pid=512,fd=7))
tcp   LISTEN 0      128    127.0.0.1:5050    0.0.0.0:* users:(("python3",pid=1234,fd=3))
tcp   LISTEN 0      4096   *:22              *:*
tcp   LISTEN 0      511    [::]:8080         [::]:* users:(("node",pid=99,fd=19))`

func TestParseSS(t *testing.T) {
	rows := parseSS(ssOut)
	if len(rows) != 4 {
		t.Fatalf("want 4 rows, got %d: %+v", len(rows), rows)
	}
	byPort := map[int]Row{}
	for _, r := range rows {
		byPort[r.Port] = r
	}
	d := byPort[68]
	if d.Protocol != "udp" || d.PID == nil || *d.PID != 512 || d.Process != "dhclient" {
		t.Fatalf("dhcp row wrong: %+v", d)
	}
	p := byPort[5050]
	if p.BindAddress != "127.0.0.1" || p.Process != "python3" {
		t.Fatalf("5050 row wrong: %+v", p)
	}
	s := byPort[22]
	if s.Process != "" || s.PID != nil {
		t.Fatalf("ssh row should have no process info: %+v", s)
	}
	n := byPort[8080]
	if n.BindAddress != "::" || n.Process != "node" {
		t.Fatalf("8080 row wrong: %+v", n)
	}
}

func TestParseNetstat(t *testing.T) {
	out := `tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      981/sshd
udp        0      0 0.0.0.0:68              0.0.0.0:                           512/dhclient`
	rows := parseNetstat(out)
	if len(rows) != 2 {
		t.Fatalf("want 2 rows, got %d", len(rows))
	}
	if rows[0].Port != 22 || rows[0].Process != "sshd" || rows[0].PID == nil || *rows[0].PID != 981 {
		t.Fatalf("sshd row wrong: %+v", rows[0])
	}
	if rows[1].Protocol != "udp" || rows[1].Port != 68 {
		t.Fatalf("udp row wrong: %+v", rows[1])
	}
}

func TestSplitAddr(t *testing.T) {
	h, p := splitAddr("[::]:443")
	if p != 443 || h == "" {
		t.Fatalf("ipv6 split failed: %q %d", h, p)
	}
}
