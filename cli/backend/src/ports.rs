//! Ports API: list open (listening/bound) ports on the host.
//!
//! Linux-first: parses `/proc/net/{tcp,tcp6,udp,udp6}` and maps socket
//! inodes to processes via `/proc/<pid>/fd`. Falls back to `ss -tuln`
//! when `/proc/net` is unavailable (non-Linux / containers).

use axum::{
    Extension, Json,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr};

use crate::{auth, db};

fn audit_kill(
    ctx: &Option<Extension<auth::AuthContext>>,
    headers: &HeaderMap,
    target: &str,
    ok: bool,
) {
    let actor = ctx
        .as_ref()
        .map(|Extension(c)| c.username.as_str())
        .unwrap_or("-");
    db::audit(actor, &auth::client_ip(headers), "ports-kill", target, if ok { "ok" } else { "deny" });
}

#[derive(Serialize, Clone)]
pub struct PortEntry {
    pub proto: String,
    pub addr: String,
    pub port: u16,
    pub state: String,
    pub pid: Option<u32>,
    pub process: Option<String>,
}

#[derive(Serialize)]
pub struct PortsResponse {
    pub hostname: String,
    pub count: usize,
    pub ports: Vec<PortEntry>,
}

fn hostname() -> String {
    if let Ok(h) = std::fs::read_to_string("/proc/sys/kernel/hostname") {
        let h = h.trim().to_string();
        if !h.is_empty() {
            return h;
        }
    }
    std::env::var("HOSTNAME")
        .ok()
        .filter(|h| !h.trim().is_empty())
        .unwrap_or_else(|| "host".to_string())
}

/// Decode the hex `IP:PORT` form used by /proc/net/*.
fn parse_local_addr(raw: &str) -> Option<(String, u16)> {
    let (ip_hex, port_hex) = raw.split_once(':')?;
    let port = u16::from_str_radix(port_hex, 16).ok()?;
    let addr = if ip_hex.len() == 8 {
        // IPv4: one little-endian u32.
        let w = u32::from_str_radix(ip_hex, 16).ok()?;
        Ipv4Addr::from(w.to_le_bytes()).to_string()
    } else if ip_hex.len() == 32 {
        // IPv6: four little-endian u32 words.
        let mut bytes = [0u8; 16];
        for (i, chunk) in (0..32).step_by(8).enumerate() {
            let w = u32::from_str_radix(&ip_hex[chunk..chunk + 8], 16).ok()?;
            bytes[i * 4..i * 4 + 4].copy_from_slice(&w.to_le_bytes());
        }
        Ipv6Addr::from(bytes).to_string()
    } else {
        return None;
    };
    Some((addr, port))
}

fn tcp_state(code: &str) -> &'static str {
    match code {
        "01" => "ESTABLISHED",
        "02" => "SYN_SENT",
        "03" => "SYN_RECV",
        "04" => "FIN_WAIT1",
        "05" => "FIN_WAIT2",
        "06" => "TIME_WAIT",
        "07" => "CLOSE",
        "08" => "CLOSE_WAIT",
        "09" => "LAST_ACK",
        "0A" => "LISTEN",
        "0B" => "CLOSING",
        "0C" => "NEW_SYN_RECV",
        _ => "UNKNOWN",
    }
}

/// inode -> (pid, process name) by scanning /proc/<pid>/fd symlinks.
fn inode_to_process() -> HashMap<u64, (u32, String)> {
    let mut map: HashMap<u64, (u32, String)> = HashMap::new();
    let Ok(proc_dir) = std::fs::read_dir("/proc") else {
        return map;
    };
    for entry in proc_dir.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(pid) = name.parse::<u32>() else {
            continue;
        };
        // Process name: /proc/<pid>/comm, fallback to argv[0].
        let pname = std::fs::read_to_string(entry.path().join("comm"))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                std::fs::read(entry.path().join("cmdline"))
                    .ok()
                    .and_then(|b| {
                        b.split(|c| *c == 0)
                            .next()
                            .and_then(|s| std::str::from_utf8(s).ok())
                            .map(|s| s.rsplit('/').next().unwrap_or(s).trim().to_string())
                    })
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "?".to_string())
            });
        let Ok(fds) = std::fs::read_dir(entry.path().join("fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            let Ok(link) = std::fs::read_link(fd.path()) else {
                continue;
            };
            let s = link.to_string_lossy();
            // Links look like `socket:[12345]`.
            if let Some(inner) = s.strip_prefix("socket:[").and_then(|t| t.strip_suffix(']'))
                && let Ok(inode) = inner.parse::<u64>()
            {
                map.entry(inode).or_insert((pid, pname.clone()));
            }
        }
    }
    map
}

struct RawSocket {
    port: u16,
    addr: String,
    state: String,
    inode: u64,
}

/// Parse one /proc/net/{tcp,tcp6,udp,udp6} file.
/// `listen_only` keeps only LISTEN entries (TCP); UDP keeps everything.
fn parse_proc_net(text: &str, listen_only: bool) -> Vec<RawSocket> {
    let mut out = Vec::new();
    for line in text.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 10 {
            continue;
        }
        let state_code = parts[3];
        let state = tcp_state(state_code).to_string();
        if listen_only && state_code != "0A" {
            continue;
        }
        let Some((addr, port)) = parse_local_addr(parts[1]) else {
            continue;
        };
        // Skip wildcard port 0 (not a real listener).
        if port == 0 {
            continue;
        }
        let Ok(inode) = parts[9].parse::<u64>() else {
            continue;
        };
        if inode == 0 {
            continue;
        }
        out.push(RawSocket {
            port,
            addr,
            state,
            inode,
        });
    }
    out
}

fn collect_from_proc() -> Option<Vec<(String, RawSocket)>> {
    let tcp = std::fs::read_to_string("/proc/net/tcp").ok()?;
    let mut out: Vec<(String, RawSocket)> = Vec::new();
    for r in parse_proc_net(&tcp, true) {
        out.push(("TCP".to_string(), r));
    }
    if let Ok(t) = std::fs::read_to_string("/proc/net/tcp6") {
        for r in parse_proc_net(&t, true) {
            out.push(("TCP6".to_string(), r));
        }
    }
    if let Ok(t) = std::fs::read_to_string("/proc/net/udp") {
        for r in parse_proc_net(&t, false) {
            out.push(("UDP".to_string(), r));
        }
    }
    if let Ok(t) = std::fs::read_to_string("/proc/net/udp6") {
        for r in parse_proc_net(&t, false) {
            out.push(("UDP6".to_string(), r));
        }
    }
    Some(out)
}

/// Fallback for non-Linux: parse `ss -tulnH` output.
/// Lines look like: `tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:*`
fn parse_ss_output(text: &str) -> Vec<(String, RawSocket)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 5 {
            continue;
        }
        let proto_raw = parts[0].to_lowercase();
        let (proto, is_tcp) = if proto_raw.starts_with("tcp") {
            ("TCP".to_string(), true)
        } else if proto_raw.starts_with("udp") {
            ("UDP".to_string(), false)
        } else {
            continue;
        };
        // ss columns: Netid State Recv-Q Send-Q Local:Port Peer:Port
        let (state, local) =
            if parts.len() >= 6 && !parts[1].chars().next().is_some_and(|c| c.is_ascii_digit()) {
                (parts[1].to_string(), parts[4])
            } else {
                ("LISTEN".to_string(), parts[3])
            };
        if is_tcp && state != "LISTEN" && state != "UNCONN" {
            continue;
        }
        let Some(idx) = local.rfind(':') else {
            continue;
        };
        let (host, port_str) = local.split_at(idx);
        let port_str = &port_str[1..];
        // `*:8080` style.
        let addr = if host.is_empty() || host == "*" {
            "0.0.0.0".to_string()
        } else {
            host.trim_matches(|c| c == '[' || c == ']').to_string()
        };
        // Port may be a service name when ss resolves names; skip those.
        let Ok(port) = port_str.parse::<u16>() else {
            continue;
        };
        if port == 0 {
            continue;
        }
        // Strip brackets / zone ids.
        let addr = addr.split('%').next().unwrap_or(&addr).to_string();
        out.push((
            proto,
            RawSocket {
                port,
                addr,
                state,
                inode: 0,
            },
        ));
    }
    out
}

fn collect_from_ss() -> Vec<(String, RawSocket)> {
    for args in [&["-tulnH"], &["-tuln"]] {
        if let Ok(out) = std::process::Command::new("ss").args(args).output()
            && out.status.success()
        {
            let text = String::from_utf8_lossy(&out.stdout).into_owned();
            let parsed = parse_ss_output(&text);
            if !parsed.is_empty() {
                return parsed;
            }
        }
    }
    Vec::new()
}

fn build_entries() -> Vec<PortEntry> {
    let raw: Vec<(String, RawSocket)> = collect_from_proc().unwrap_or_else(collect_from_ss);
    let proc_map = inode_to_process();
    let mut entries: Vec<PortEntry> = raw
        .into_iter()
        .map(|(proto, r)| {
            let (pid, process) = if r.inode != 0 {
                match proc_map.get(&r.inode) {
                    Some((pid, name)) => (Some(*pid), Some(name.clone())),
                    None => (None, None),
                }
            } else {
                (None, None)
            };
            // UDP has no connection state in /proc (always 07) — show OPEN.
            let state = if proto.starts_with("UDP") {
                "OPEN".to_string()
            } else {
                r.state
            };
            PortEntry {
                proto,
                addr: r.addr,
                port: r.port,
                state,
                pid,
                process,
            }
        })
        .collect();
    // Sort by port, then protocol, then address.
    entries.sort_by(|a, b| {
        a.port
            .cmp(&b.port)
            .then_with(|| a.proto.cmp(&b.proto))
            .then_with(|| a.addr.cmp(&b.addr))
    });
    entries
}

/// GET /api/ports — all open (listening/bound) ports on the host.
pub async fn api_list_ports() -> Response {
    let ports = build_entries();
    let res = PortsResponse {
        count: ports.len(),
        ports,
        hostname: hostname(),
    };
    (StatusCode::OK, Json(res)).into_response()
}

#[derive(Deserialize)]
pub struct KillRequest {
    pub pid: u32,
}

#[derive(Serialize)]
struct KillResponse {
    pub ok: bool,
    pub pid: u32,
}

fn pid_alive(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        std::path::Path::new(&format!("/proc/{pid}")).exists()
    }
    #[cfg(not(target_os = "linux"))]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(true)
    }
}

fn run_kill(pid: u32, signal: Option<&str>) -> Result<(), String> {
    let pid_s = pid.to_string();
    let mut cmd = std::process::Command::new("kill");
    if let Some(sig) = signal {
        cmd.arg(format!("-{sig}"));
    }
    match cmd.arg(&pid_s).output() {
        Ok(out) if out.status.success() => Ok(()),
        Ok(out) => {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(if err.is_empty() {
                format!("kill {pid} failed (exit {})", out.status)
            } else {
                err
            })
        }
        Err(e) => Err(format!("cannot run kill: {e}")),
    }
}

/// POST /api/ports/kill — kill the process holding a port (by pid).
/// Sends SIGTERM, waits briefly, then escalates to SIGKILL if needed.
/// Admin only (RBAC). Audited.
pub async fn api_kill_port(
    opt_ctx: Option<Extension<auth::AuthContext>>,
    headers: HeaderMap,
    Json(req): Json<KillRequest>,
) -> Response {
    let target = req.pid.to_string();
    if req.pid <= 1 {
        audit_kill(&opt_ctx, &headers, &target, false);
        return (
            StatusCode::BAD_REQUEST,
            format!("refusing to kill pid {}", req.pid),
        )
            .into_response();
    }
    if req.pid == std::process::id() {
        audit_kill(&opt_ctx, &headers, &target, false);
        return (StatusCode::FORBIDDEN, "refusing to kill ks-ssh itself").into_response();
    }
    if !pid_alive(req.pid) {
        audit_kill(&opt_ctx, &headers, &target, false);
        return (
            StatusCode::NOT_FOUND,
            format!("no such process (pid {})", req.pid),
        )
            .into_response();
    }
    if let Err(e) = run_kill(req.pid, Some("TERM")) {
        audit_kill(&opt_ctx, &headers, &target, false);
        return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response();
    }
    // Give it up to ~1.5s to exit after SIGTERM.
    for _ in 0..15 {
        if !pid_alive(req.pid) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    // Escalate to SIGKILL if it survived SIGTERM.
    if pid_alive(req.pid)
        && let Err(e) = run_kill(req.pid, Some("KILL"))
    {
        audit_kill(&opt_ctx, &headers, &target, false);
        return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response();
    }
    for _ in 0..10 {
        if !pid_alive(req.pid) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if pid_alive(req.pid) {
        audit_kill(&opt_ctx, &headers, &target, false);
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("process {} did not exit", req.pid),
        )
            .into_response();
    }
    audit_kill(&opt_ctx, &headers, &target, true);
    (
        StatusCode::OK,
        Json(KillResponse {
            ok: true,
            pid: req.pid,
        }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ipv4_addr() {
        // 0100007F = 127.0.0.1 (little-endian u32), port 1F90 = 8080.
        let (addr, port) = parse_local_addr("0100007F:1F90").expect("parse");
        assert_eq!(addr, "127.0.0.1");
        assert_eq!(port, 8080);
        let (addr, port) = parse_local_addr("00000000:0016").expect("parse");
        assert_eq!(addr, "0.0.0.0");
        assert_eq!(port, 22);
    }

    #[test]
    fn parses_ipv6_any() {
        let (addr, port) =
            parse_local_addr("00000000000000000000000000000000:0050").expect("parse");
        assert_eq!(port, 80);
        assert!(addr.contains(':'), "addr={addr}");
    }

    #[test]
    fn parses_ipv6_loopback() {
        // ::1 shows up per-word little-endian: ...01000000
        let (addr, _) = parse_local_addr("00000000000000000000000001000000:1F90").expect("parse");
        assert_eq!(addr, "::1");
    }

    #[test]
    fn rejects_bad_addr() {
        assert!(parse_local_addr("ZZZZ").is_none());
        assert!(parse_local_addr("0100007F").is_none());
        assert!(parse_local_addr("0100007F:ZZZZ").is_none());
    }

    #[test]
    fn proc_tcp_keeps_listen_only() {
        let text = "  sl  local_address rem_address   st tx_queue tr tm->when retrnsmt   uid  timeout inode\n\
           0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0000000000000000 100 0 0 10 0\n\
           1: 0100007F:0035 00000000:0000 07 00000000:00000000 00:00000000 00000000   101        0 22222 1 0000000000000000 100 0 0 10 0\n";
        let rows = parse_proc_net(text, true);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].port, 8080);
        assert_eq!(rows[0].state, "LISTEN");
        assert_eq!(rows[0].inode, 11111);
    }

    #[test]
    fn proc_udp_keeps_all() {
        let text = "  sl  local_address rem_address   st tx_queue tr tm->when retrnsmt   uid  timeout inode\n\
           0: 00000000:0035 00000000:0000 07 00000000:00000000 00:00000000 00000000   101        0 33333 1 0000000000000000 100 0 0 10 0\n";
        let rows = parse_proc_net(text, false);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].port, 53);
    }

    #[test]
    fn skips_port_zero() {
        let text = "  sl  local_address rem_address   st tx_queue tr tm->when retrnsmt   uid  timeout inode\n\
           0: 00000000:0000 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 44444 1 0000000000000000 100 0 0 10 0\n";
        assert!(parse_proc_net(text, true).is_empty());
    }

    #[test]
    fn ss_fallback_parses() {
        let text = "tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n\
                    udp UNCONN 0 0 0.0.0.0:68 0.0.0.0:*\n\
                    tcp ESTAB 0 0 127.0.0.1:8080 127.0.0.1:50000\n";
        let rows = parse_ss_output(text);
        // LISTEN tcp + UNCONN udp; ESTAB tcp skipped.
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].1.port, 22);
        assert_eq!(rows[1].1.port, 68);
    }

    #[test]
    fn tcp_state_names() {
        assert_eq!(tcp_state("0A"), "LISTEN");
        assert_eq!(tcp_state("01"), "ESTABLISHED");
        assert_eq!(tcp_state("FF"), "UNKNOWN");
    }
}
