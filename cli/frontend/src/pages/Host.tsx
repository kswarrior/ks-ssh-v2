import { useCallback, useEffect, useRef, useState } from 'react'

type CpuInfo = {
  model: string
  cores: number
  usage_percent: number
  per_core: number[]
}

type MemoryInfo = {
  total_kb: number
  used_kb: number
  free_kb: number
  available_kb: number
  usage_percent: number
  swap_total_kb: number
  swap_free_kb: number
  swap_used_kb: number
}

type DiskInfo = {
  device: string
  fstype: string
  mount: string
  total_kb: number
  used_kb: number
  avail_kb: number
  usage_percent: number
}

type HostResponse = {
  hostname: string
  os: string
  kernel: string
  arch: string
  uptime_secs: number
  load1: number
  load5: number
  load15: number
  proc_count: number
  cpu: CpuInfo
  memory: MemoryInfo
  disks: DiskInfo[]
}

const HISTORY_MAX = 40
const POLL_MS = 3000

function formatBytes(kb: number): string {
  const bytes = kb * 1024
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u += 1
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`
}

function formatUptime(totalSecs: number): string {
  if (totalSecs <= 0) return '—'
  const d = Math.floor(totalSecs / 86400)
  const h = Math.floor((totalSecs % 86400) / 3600)
  const m = Math.floor((totalSecs % 3600) / 60)
  const parts: string[] = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0 || d > 0) parts.push(`${h}h`)
  parts.push(`${m}m`)
  return parts.join(' ')
}

function pushHistory(prev: number[], next: number): number[] {
  const out = prev.length >= HISTORY_MAX ? prev.slice(prev.length - HISTORY_MAX + 1) : [...prev]
  out.push(next)
  return out
}

/** Live area graph (pure SVG, no deps) for CPU / RAM history. */
function SparkGraph({ values, label, tone }: { values: number[]; label: string; tone: 'cpu' | 'ram' }) {
  const W = 100
  const H = 36
  const pts = values.length < 2 ? [0, ...(values.length ? values : [0])] : values
  const coords = pts.map((v, i) => {
    const x = (i / (pts.length - 1)) * W
    const y = H - 2 - (Math.min(100, Math.max(0, v)) / 100) * (H - 4)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const line = coords.join(' ')
  const area = `0,${H} ${line} ${W},${H}`
  const gid = tone === 'cpu' ? 'host-g-cpu' : 'host-g-ram'
  return (
    <svg
      className="host-spark"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={tone === 'cpu' ? '#a78bfa' : '#22d3ee'} stopOpacity="0.55" />
          <stop offset="1" stopColor={tone === 'cpu' ? '#6366f1' : '#22d3ee'} stopOpacity="0.04" />
        </linearGradient>
      </defs>
      {[25, 50, 75].map((p) => (
        <line
          key={p}
          x1="0"
          x2={W}
          y1={H - (p / 100) * H}
          y2={H - (p / 100) * H}
          className="host-gridline"
        />
      ))}
      <polygon points={area} fill={`url(#${gid})`} />
      <polyline
        points={line}
        fill="none"
        stroke={tone === 'cpu' ? '#a78bfa' : '#22d3ee'}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

/** Stylish host-aware loading state: mirrors the real System / CPU / RAM /
 * Disks layout so an open or refresh is clearly "about this host". */
function HostSkeleton() {
  return (
    <div className="host-loading" aria-busy="true" aria-label="Probing host">
      <div className="card host-load-hero" aria-hidden="true">
        <span className="host-orb">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="7" rx="2" />
            <rect x="2" y="14" width="20" height="7" rx="2" />
            <path d="M6 6.5h.01M6 17.5h.01" />
          </svg>
        </span>
        <span className="host-load-text">
          <span className="host-load-title">Probing this host…</span>
          <span className="host-load-sub">CPU · memory · disks</span>
        </span>
        <span className="host-pulse-dot" />
      </div>

      <div className="host-grid">
        <div className="card host-card host-skel-card" aria-hidden="true">
          <h2>System</h2>
          <div className="host-skel-kv">
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className="host-skel-row">
                <span className="skeleton host-skel-dt" />
                <span
                  className="skeleton host-skel-dd"
                  style={{ width: `${[62, 78, 70, 34, 48, 66, 28][i]}%` }}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="card host-card host-skel-card" aria-hidden="true">
          <div className="host-card-head">
            <h2>CPU</h2>
            <span className="skeleton host-skel-stat" />
          </div>
          <span className="skeleton host-skel-line" style={{ width: '82%' }} />
          <div className="skeleton host-skel-graph" />
          <ul className="host-skel-cores">
            {Array.from({ length: 8 }, (_, i) => (
              <li key={i}>
                <span className="host-skel-core">
                  <span style={{ height: `${[38, 62, 48, 74, 30, 55, 68, 42][i]}%` }} />
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="card host-card host-skel-card" aria-hidden="true">
          <div className="host-card-head">
            <h2>RAM</h2>
            <span className="skeleton host-skel-stat" />
          </div>
          <span className="skeleton host-skel-line" style={{ width: '88%' }} />
          <div className="skeleton host-skel-graph host-skel-graph-ram" />
          <div className="skeleton host-skel-bar" />
          <span className="skeleton host-skel-line" style={{ width: '46%' }} />
        </div>
      </div>

      <div className="card host-card host-disks host-skel-card" aria-hidden="true">
        <div className="host-card-head">
          <h2>Disks</h2>
          <span className="skeleton host-skel-line" style={{ width: '110px' }} />
        </div>
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="host-skel-disk">
            <div className="host-skel-disk-top">
              <span className="skeleton" style={{ width: '64px' }} />
              <span className="skeleton" style={{ width: '150px' }} />
            </div>
            <div className="skeleton host-skel-bar" />
            <span className="skeleton host-skel-line" style={{ width: '72%' }} />
          </div>
        ))}
      </div>

      <span className="sr-only" role="status">
        Probing host — reading CPU, memory and disks…
      </span>
    </div>
  )
}

export default function HostPage() {
  const [data, setData] = useState<HostResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cpuHist, setCpuHist] = useState<number[]>([])
  const [ramHist, setRamHist] = useState<number[]>([])
  const timer = useRef<number | undefined>(undefined)

  const load = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true)
      setError(null)
    }
    try {
      const res = await fetch('/api/host', { cache: 'no-store' })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `request failed (${res.status})`)
      }
      const json = (await res.json()) as HostResponse
      setData(json)
      setCpuHist((h) => pushHistory(h, json.cpu.usage_percent))
      setRamHist((h) => pushHistory(h, json.memory.usage_percent))
      setError(null)
    } catch (e) {
      if (!silent) {
        setError(
          e instanceof Error
            ? e.message
            : 'Cannot reach the host. Host works on the local UI (http://127.0.0.1:8080) — not over the relay view.',
        )
      }
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    timer.current = window.setInterval(() => void load(true), POLL_MS)
    return () => {
      if (timer.current !== undefined) window.clearInterval(timer.current)
    }
  }, [load])

  const mem = data?.memory
  const swapPct =
    mem && mem.swap_total_kb > 0 ? (mem.swap_used_kb / mem.swap_total_kb) * 100 : 0

  return (
    <section className="page host-page" aria-labelledby="page-title-host">
      <div className="page-head ports-head">
        <h1 id="page-title-host" className="sr-only">
          Host
        </h1>
        <div className="row-actions ports-actions">
          <p className="files-sub host-live" aria-live="polite">
            {loading && !data ? (
              <span className="host-probing">
                <span className="host-pulse-dot" aria-hidden="true" />
                <span>Probing this host…</span>
              </span>
            ) : error ? (
              'Could not read host info.'
            ) : data ? (
              `${data.hostname} · up ${formatUptime(data.uptime_secs)} · live`
            ) : (
              ''
            )}
          </p>
          <div className="ports-right">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => void load()}
              disabled={loading}
              title="Refresh host info now"
            >
              <svg className={loading ? 'spin' : undefined} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <path d="M21 3v6h-6" />
              </svg>
              <span className="btn-label">{loading ? (data ? 'Refreshing…' : 'Probing…') : 'Refresh'}</span>
            </button>
          </div>
        </div>
      </div>

      <div className="files-body">
        {error ? (
          <div className="banner-error" role="alert">
            <p>{error}</p>
            <p>
              Tip: run <code>ks-ssh --port 8080</code> on the host and open
              this tab there. The fullscreen relay view has no host access.
            </p>
            <div className="row-actions">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => void load()}
                title="Retry reading host info"
              >
                <span className="btn-label">Retry</span>
              </button>
            </div>
          </div>
        ) : loading && !data ? (
          <HostSkeleton />
        ) : data ? (
          <>
            {loading && (
              <div className="host-refresh-bar" aria-hidden="true">
                <span />
              </div>
            )}
            <div className={loading ? 'host-stale' : undefined} aria-busy={loading || undefined}>
            <div className="host-grid">
              {/* System card */}
              <div className="card host-card">
                <h2>System</h2>
                <dl className="host-kv">
                  <div><dt>Hostname</dt><dd>{data.hostname}</dd></div>
                  <div><dt>OS</dt><dd>{data.os || '—'}</dd></div>
                  <div><dt>Kernel</dt><dd className="host-mono">{data.kernel || '—'}</dd></div>
                  <div><dt>Arch</dt><dd className="host-mono">{data.arch}</dd></div>
                  <div><dt>Uptime</dt><dd>{formatUptime(data.uptime_secs)}</dd></div>
                  <div>
                    <dt>Load</dt>
                    <dd className="host-mono">
                      {data.load1.toFixed(2)} · {data.load5.toFixed(2)} · {data.load15.toFixed(2)}
                    </dd>
                  </div>
                  <div><dt>Processes</dt><dd>{data.proc_count}</dd></div>
                </dl>
              </div>

              {/* CPU card with graph */}
              <div className="card host-card">
                <div className="host-card-head">
                  <h2>CPU</h2>
                  <span className="stat host-stat">{data.cpu.usage_percent.toFixed(1)}%</span>
                </div>
                <p className="host-sub host-mono">{data.cpu.model} · {data.cpu.cores} cores</p>
                <SparkGraph values={cpuHist} label={`CPU usage history, now ${data.cpu.usage_percent.toFixed(1)} percent`} tone="cpu" />
                {data.cpu.per_core.length > 0 && (
                  <ul className="host-cores" aria-label="Per-core CPU usage">
                    {data.cpu.per_core.map((v, i) => (
                      <li key={i} title={`Core ${i}: ${v.toFixed(0)}%`}>
                        <span className="host-core-bar">
                          <span style={{ height: `${Math.min(100, Math.max(0, v)).toFixed(0)}%` }} />
                        </span>
                        <span className="host-core-label">{i}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* RAM card with graph */}
              <div className="card host-card">
                <div className="host-card-head">
                  <h2>RAM</h2>
                  <span className="stat host-stat">{data.memory.usage_percent.toFixed(1)}%</span>
                </div>
                <p className="host-sub">
                  {formatBytes(data.memory.used_kb)} used of {formatBytes(data.memory.total_kb)} ·{' '}
                  {formatBytes(data.memory.available_kb)} available
                </p>
                <SparkGraph values={ramHist} label={`Memory usage history, now ${data.memory.usage_percent.toFixed(1)} percent`} tone="ram" />
                <div className="host-bar" role="img" aria-label={`Memory ${data.memory.usage_percent.toFixed(1)} percent used`}>
                  <span style={{ width: `${data.memory.usage_percent.toFixed(1)}%` }} />
                </div>
                <p className="host-sub">
                  Swap {mem && mem.swap_total_kb > 0
                    ? `${formatBytes(mem.swap_used_kb)} / ${formatBytes(mem.swap_total_kb)} (${swapPct.toFixed(0)}%)`
                    : 'none'}
                </p>
                {mem && mem.swap_total_kb > 0 && (
                  <div className="host-bar host-bar-swap" role="img" aria-label={`Swap ${swapPct.toFixed(1)} percent used`}>
                    <span style={{ width: `${swapPct.toFixed(1)}%` }} />
                  </div>
                )}
              </div>
            </div>

            {/* Disks card with bars */}
            <div className="card host-card host-disks">
              <div className="host-card-head">
                <h2>Disks</h2>
                <span className="host-sub">{data.disks.length} filesystem{data.disks.length === 1 ? '' : 's'}</span>
              </div>
              {data.disks.length === 0 ? (
                <p className="host-sub">No filesystems reported on this host.</p>
              ) : (
                <ul className="host-disk-list">
                  {data.disks.map((d) => (
                    <li key={`${d.device}-${d.mount}`} className="host-disk">
                      <div className="host-disk-top">
                        <strong className="host-mono">{d.mount}</strong>
                        <span className="host-disk-meta">
                          {d.device}{d.fstype ? ` · ${d.fstype}` : ''}
                        </span>
                        <span className="host-disk-pct host-mono">{d.usage_percent.toFixed(0)}%</span>
                      </div>
                      <div
                        className="host-bar"
                        role="img"
                        aria-label={`${d.mount}: ${d.usage_percent.toFixed(1)} percent used, ${formatBytes(d.avail_kb)} free of ${formatBytes(d.total_kb)}`}
                      >
                        <span
                          style={{ width: `${d.usage_percent.toFixed(1)}%` }}
                          data-tone={d.usage_percent > 90 ? 'bad' : d.usage_percent > 75 ? 'warn' : undefined}
                        />
                      </div>
                      <div className="host-disk-meta host-mono">
                        {formatBytes(d.used_kb)} used · {formatBytes(d.avail_kb)} free · {formatBytes(d.total_kb)} total
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            </div>
          </>
        ) : null}
      </div>
    </section>
  )
}
