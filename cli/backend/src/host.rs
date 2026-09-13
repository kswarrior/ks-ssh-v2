//! Host API: complete info about the machine serving the UI.
//!
//! Linux-first: reads `/proc/{uptime,loadavg,stat,cpuinfo,meminfo,version}`
//! and `/etc/os-release`, lists filesystems via `df -kP -T`.
//! Every field degrades gracefully — unknown values become empty
//! strings / zeros instead of failing the whole request.

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Serialize, Clone)]
pub struct CpuInfo {
    pub model: String,
    pub cores: usize,
    pub usage_percent: f32,
    pub per_core: Vec<f32>,
}

#[derive(Serialize, Clone)]
pub struct MemoryInfo {
    pub total_kb: u64,
    pub used_kb: u64,
    pub free_kb: u64,
    pub available_kb: u64,
    pub usage_percent: f32,
    pub swap_total_kb: u64,
    pub swap_free_kb: u64,
    pub swap_used_kb: u64,
}

#[derive(Serialize, Clone)]
pub struct DiskInfo {
    pub device: String,
    pub fstype: String,
    pub mount: String,
    pub total_kb: u64,
    pub used_kb: u64,
    pub avail_kb: u64,
    pub usage_percent: f32,
}

#[derive(Serialize)]
pub struct HostResponse {
    pub hostname: String,
    pub os: String,
    pub kernel: String,
    pub arch: String,
    pub uptime_secs: u64,
    pub load1: f32,
    pub load5: f32,
    pub load15: f32,
    pub proc_count: usize,
    pub cpu: CpuInfo,
    pub memory: MemoryInfo,
    pub disks: Vec<DiskInfo>,
}

pub fn hostname() -> String {
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

fn os_pretty() -> String {
    if let Ok(text) = std::fs::read_to_string("/etc/os-release") {
        for line in text.lines() {
            if let Some(v) = line.strip_prefix("PRETTY_NAME=") {
                return v.trim().trim_matches('"').to_string();
            }
        }
        // Fallback: NAME + VERSION_ID.
        let mut name = String::new();
        let mut version = String::new();
        for line in text.lines() {
            if let Some(v) = line.strip_prefix("NAME=") {
                name = v.trim().trim_matches('"').to_string();
            } else if let Some(v) = line.strip_prefix("VERSION_ID=") {
                version = v.trim().trim_matches('"').to_string();
            }
        }
        let combined = format!("{name} {version}").trim().to_string();
        if !combined.is_empty() {
            return combined;
        }
    }
    std::env::consts::OS.to_string()
}

fn kernel() -> String {
    // `uname -r`, fallback to /proc/version.
    if let Ok(out) = std::process::Command::new("uname").arg("-r").output()
        && out.status.success()
    {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() {
            return s;
        }
    }
    std::fs::read_to_string("/proc/version")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_default()
}

fn uptime_secs() -> u64 {
    std::fs::read_to_string("/proc/uptime")
        .ok()
        .and_then(|t| t.split_whitespace().next()?.parse::<f64>().ok())
        .map(|f| f as u64)
        .unwrap_or(0)
}

fn load_avg() -> (f32, f32, f32) {
    let t = std::fs::read_to_string("/proc/loadavg").unwrap_or_default();
    let mut it = t.split_whitespace().filter_map(|s| s.parse::<f32>().ok());
    (
        it.next().unwrap_or(0.0),
        it.next().unwrap_or(0.0),
        it.next().unwrap_or(0.0),
    )
}

fn proc_count() -> usize {
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return 0;
    };
    dir.flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .chars()
                .all(|c| c.is_ascii_digit())
        })
        .count()
}

fn cpu_model_and_cores() -> (String, usize) {
    let mut model = String::new();
    let mut cores = 0usize;
    if let Ok(text) = std::fs::read_to_string("/proc/cpuinfo") {
        for line in text.lines() {
            if line.starts_with("processor") {
                cores += 1;
            } else if model.is_empty() && line.starts_with("model name") {
                if let Some(v) = line.split_once(':') {
                    model = v.1.trim().to_string();
                }
            }
        }
    }
    if model.is_empty() {
        // ARM boards use "Model" in /proc/cpuinfo or /proc/device-tree/model.
        if let Ok(text) = std::fs::read_to_string("/proc/cpuinfo") {
            for line in text.lines() {
                if line.starts_with("Model") || line.starts_with("Hardware") {
                    if let Some(v) = line.split_once(':') {
                        model = v.1.trim().to_string();
                        break;
                    }
                }
            }
        }
    }
    if model.is_empty() {
        model = std::fs::read_to_string("/proc/device-tree/model")
            .ok()
            .map(|s| s.trim_matches('\0').trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "CPU".to_string());
    }
    if cores == 0 {
        cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1);
    }
    (model, cores)
}

/// Parse `/proc/stat` cpu lines into (idle, total) per cpu id ("cpu" = aggregate).
fn read_cpu_times() -> HashMap<String, (u64, u64)> {
    let mut map = HashMap::new();
    let Ok(text) = std::fs::read_to_string("/proc/stat") else {
        return map;
    };
    for line in text.lines() {
        if !line.starts_with("cpu") {
            break;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 5 {
            continue;
        }
        // cpu user nice system idle iowait irq softirq steal ...
        let nums: Vec<u64> = parts[1..].iter().filter_map(|s| s.parse().ok()).collect();
        if nums.len() < 4 {
            continue;
        }
        let idle = nums[3] + *nums.get(4).unwrap_or(&0);
        let total: u64 = nums.iter().sum();
        map.insert(parts[0].to_string(), (idle, total));
    }
    map
}

fn pct(idle_delta: u64, total_delta: u64) -> f32 {
    if total_delta == 0 {
        return 0.0;
    }
    ((total_delta.saturating_sub(idle_delta)) as f64 / total_delta as f64 * 100.0) as f32
}

async fn cpu_usage() -> (f32, Vec<f32>, usize) {
    let before = read_cpu_times();
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let after = read_cpu_times();
    let usage = match (before.get("cpu"), after.get("cpu")) {
        (Some((ib, tb)), Some((ia, ta))) => pct(ia.saturating_sub(*ib), ta.saturating_sub(*tb)),
        _ => 0.0,
    };
    // Per-core series in cpu0, cpu1, ... order.
    let mut cores: Vec<(usize, f32)> = Vec::new();
    for (k, (ia, ta)) in &after {
        if k == "cpu" {
            continue;
        }
        let Some(idx) = k.strip_prefix("cpu").and_then(|s| s.parse::<usize>().ok()) else {
            continue;
        };
        let v = match before.get(k) {
            Some((ib, tb)) => pct(ia.saturating_sub(*ib), ta.saturating_sub(*tb)),
            None => 0.0,
        };
        cores.push((idx, v.clamp(0.0, 100.0)));
    }
    cores.sort_by_key(|(i, _)| *i);
    let per_core: Vec<f32> = cores.into_iter().map(|(_, v)| v).collect();
    (usage.clamp(0.0, 100.0), per_core, before.len())
}

fn mem_kb(map: &HashMap<String, u64>, key: &str) -> u64 {
    map.get(key).copied().unwrap_or(0)
}

fn memory_info() -> MemoryInfo {
    let mut map: HashMap<String, u64> = HashMap::new();
    if let Ok(text) = std::fs::read_to_string("/proc/meminfo") {
        for line in text.lines() {
            let mut it = line.split_whitespace();
            let (Some(k), Some(v)) = (it.next(), it.next()) else {
                continue;
            };
            if let Ok(n) = v.parse::<u64>() {
                map.insert(k.trim_end_matches(':').to_string(), n);
            }
        }
    }
    let total = mem_kb(&map, "MemTotal");
    let free = mem_kb(&map, "MemFree");
    let available = mem_kb(&map, "MemAvailable");
    let avail = if available > 0 { available } else { free };
    let used = total.saturating_sub(avail);
    let usage = if total > 0 {
        used as f64 / total as f64 * 100.0
    } else {
        0.0
    } as f32;
    let swap_total = mem_kb(&map, "SwapTotal");
    let swap_free = mem_kb(&map, "SwapFree");
    MemoryInfo {
        total_kb: total,
        used_kb: used,
        free_kb: free,
        available_kb: avail,
        usage_percent: usage.clamp(0.0, 100.0),
        swap_total_kb: swap_total,
        swap_free_kb: swap_free,
        swap_used_kb: swap_total.saturating_sub(swap_free),
    }
}

/// Pseudo filesystems that add noise to the disk list.
fn is_pseudo(fstype: &str, mount: &str) -> bool {
    matches!(
        fstype,
        "tmpfs" | "devtmpfs" | "devpts" | "sysfs" | "proc" | "cgroup" | "cgroup2" | "overlay"
            if mount.starts_with("/proc")
                || mount.starts_with("/sys")
                || mount.starts_with("/dev")
                || mount == "/dev/shm"
    ) || matches!(fstype, "sysfs" | "proc" | "devpts" | "cgroup" | "cgroup2" | "securityfs" | "pstore" | "bpf" | "tracefs" | "debugfs" | "fusectl" | "configfs")
}

/// Parse `df -kP -T` (POSIX + filesystem type).
/// Columns: Filesystem Type 1024-blocks Used Available Capacity Mounted-on.
fn parse_df(text: &str) -> Vec<DiskInfo> {
    let mut out = Vec::new();
    for line in text.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 7 {
            continue;
        }
        let (device, fstype, total, used, avail, mount) =
            (parts[0], parts[1], parts[2], parts[3], parts[4], parts[6]);
        let (Ok(total), Ok(used), Ok(avail)) = (
            total.parse::<u64>(),
            used.parse::<u64>(),
            avail.parse::<u64>(),
        ) else {
            continue;
        };
        if total == 0 {
            continue;
        }
        if is_pseudo(fstype, mount) {
            continue;
        }
        let usage = used as f64 / total as f64 * 100.0;
        out.push(DiskInfo {
            device: device.to_string(),
            fstype: fstype.to_string(),
            mount: mount.to_string(),
            total_kb: total,
            used_kb: used,
            avail_kb: avail,
            usage_percent: (usage as f32).clamp(0.0, 100.0),
        });
    }
    // Biggest filesystem first.
    out.sort_by(|a, b| b.total_kb.cmp(&a.total_kb));
    out
}

fn disk_info() -> Vec<DiskInfo> {
    for args in [&["-kP", "-T"], &["-kP"]] {
        if let Ok(out) = std::process::Command::new("df").args(args).output()
            && out.status.success()
        {
            let text = String::from_utf8_lossy(&out.stdout).into_owned();
            if args.len() == 2 {
                let parsed = parse_df(&text);
                if !parsed.is_empty() {
                    return parsed;
                }
            } else {
                // No fstype column: Filesystem 1024-blocks Used Avail Cap Mount.
                let mut disks = Vec::new();
                for line in text.lines().skip(1) {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() < 6 {
                        continue;
                    }
                    let (Ok(total), Ok(used), Ok(avail)) = (
                        parts[1].parse::<u64>(),
                        parts[2].parse::<u64>(),
                        parts[3].parse::<u64>(),
                    ) else {
                        continue;
                    };
                    if total == 0 {
                        continue;
                    }
                    let mount = parts[5];
                    disks.push(DiskInfo {
                        device: parts[0].to_string(),
                        fstype: String::new(),
                        mount: mount.to_string(),
                        total_kb: total,
                        used_kb: used,
                        avail_kb: avail,
                        usage_percent: (used as f64 / total as f64 * 100.0) as f32,
                    });
                }
                if !disks.is_empty() {
                    disks.sort_by(|a: &DiskInfo, b: &DiskInfo| b.total_kb.cmp(&a.total_kb));
                    return disks;
                }
            }
        }
    }
    Vec::new()
}

/// GET /api/host — full host overview for the Host page.
pub async fn api_host_info() -> Response {
    let (model, cores) = cpu_model_and_cores();
    let (usage, mut per_core, _) = cpu_usage().await;
    if per_core.len() != cores && !per_core.is_empty() {
        // Trust the kernel count when cpuinfo disagrees (containers).
        let n = per_core.len();
        let _ = n;
    }
    if per_core.is_empty() {
        per_core = vec![usage; cores.min(64)];
    }
    let (l1, l5, l15) = load_avg();
    let res = HostResponse {
        hostname: hostname(),
        os: os_pretty(),
        kernel: kernel(),
        arch: std::env::consts::ARCH.to_string(),
        uptime_secs: uptime_secs(),
        load1: l1,
        load5: l5,
        load15: l15,
        proc_count: proc_count(),
        cpu: CpuInfo {
            model,
            cores: per_core.len().max(cores).max(1),
            usage_percent: usage,
            per_core,
        },
        memory: memory_info(),
        disks: disk_info(),
    };
    (StatusCode::OK, Json(res)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_df_with_type() {
        let text = "Filesystem Type 1024-blocks Used Available Capacity Mounted on\n\
            /dev/sda1 ext4 100000 40000 60000 40% /\n\
            tmpfs tmpfs 1000 0 1000 0% /dev/shm\n";
        let disks = parse_df(text);
        assert_eq!(disks.len(), 1);
        assert_eq!(disks[0].mount, "/");
        assert_eq!(disks[0].fstype, "ext4");
        assert_eq!(disks[0].total_kb, 100000);
        assert!((disks[0].usage_percent - 40.0).abs() < 0.01);
    }

    #[test]
    fn skips_pseudo_filesystems() {
        assert!(is_pseudo("proc", "/proc"));
        assert!(is_pseudo("sysfs", "/sys"));
        assert!(is_pseudo("tmpfs", "/dev/shm"));
        assert!(!is_pseudo("ext4", "/"));
        assert!(!is_pseudo("vfat", "/boot/efi"));
    }

    #[test]
    fn usage_pct_math() {
        assert!((pct(20, 100) - 80.0).abs() < 0.01);
        assert_eq!(pct(0, 0), 0.0);
    }

    #[test]
    fn meminfo_math() {
        let mut map = HashMap::new();
        map.insert("MemTotal".to_string(), 1000);
        map.insert("MemAvailable".to_string(), 250);
        let used = 1000 - mem_kb(&map, "MemAvailable");
        assert_eq!(used, 750);
    }
}
