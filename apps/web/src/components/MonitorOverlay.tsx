import { useEffect, useRef, useState } from 'react'
import { api, humanSize } from '../lib/api'
import { useApp } from '../stores/appStore'
import type { MetricSample, ProcessRow, SystemInfo as SI } from '@shared'
import { Modal } from './ui'

// ---- Monitor overlay: live charts at 1 s resolution ----

function Sparkline({ values, max }: { values: number[]; max?: number }) {
  if (values.length < 2) return <svg className="spark" />
  const m = max ?? Math.max(...values, 1)
  const pts = values.map((v, i) =>
    `${(i / (values.length - 1)) * 100},${28 - (Math.min(v, m) / m) * 26}`)
  return (
    <svg className="spark" viewBox="0 0 100 30" preserveAspectRatio="none">
      <polyline fill="none" stroke="var(--accent)" strokeWidth="1.2"
        points={pts.join(' ')} />
    </svg>
  )
}

export function MonitorOverlay({ hostId, onClose }: { hostId: number; onClose: () => void }) {
  const [cur, setCur] = useState<MetricSample | null>(null)
  const [hist, setHist] = useState<MetricSample[]>([])
  const [procs, setProcs] = useState<ProcessRow[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const { notify } = useApp()

  async function kill(p: ProcessRow) {
    if (!window.confirm(`Kill PID ${p.pid} (${p.command.slice(0, 60)})?`)) return
    try {
      await api('/api/ports/kill', { method: 'POST', body: { hostId, pid: p.pid, port: -1 } })
      notify({ level: 'info', title: `killed ${p.pid}` })
      setProcs(procs.filter(x => x.pid !== p.pid))
    } catch (e: any) {
      notify({ level: 'error', title: 'kill failed', body: e.message })
    }
  }

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/api/monitor/ws?host=${hostId}`)
    wsRef.current = ws
    ws.onmessage = ev => {
      try {
        const env = JSON.parse(ev.data)
        if (env.type === 'monitor.sample') setCur(env.payload)
      } catch { /* ignore */ }
    }
    return () => ws.close()
  }, [hostId])

  useEffect(() => {
    if (cur) setHist(h => [...h.slice(-3599), cur]) // 1 h window in memory
  }, [cur])

  useEffect(() => {
    const t = setInterval(() => {
      api<ProcessRow[]>(`/api/monitor/top?hostId=${hostId}&limit=12`)
        .then(setProcs).catch(() => {})
    }, 4000)
    api<ProcessRow[]>(`/api/monitor/top?hostId=${hostId}&limit=12`).then(setProcs).catch(() => {})
    return () => clearInterval(t)
  }, [hostId])

  const pct = (used: number, total: number) =>
    total > 0 ? Math.min((used / total) * 100, 100) : 0
  const barClass = (p: number) => p > 90 ? 'err' : p > 70 ? 'warn' : ''

  const last = (sel: (s: MetricSample) => number) => hist.map(sel)

  return (
    <Modal title="Resource monitor" onClose={onClose} width={720}>
      <div className="chart-row">
        <span className="chart-label">CPU</span>
        <div className="bar-track"><div className={`bar-fill ${barClass(cur?.cpuPercent ?? 0)}`}
          style={{ width: `${cur?.cpuPercent ?? 0}%` }} /></div>
        <span className="metric-val">{cur?.cpuPercent?.toFixed(1) ?? '-'}%</span>
      </div>
      <Sparkline values={last(s => s.cpuPercent)} max={100} />

      <div className="chart-row">
        <span className="chart-label">RAM</span>
        <div className="bar-track"><div className={`bar-fill ${barClass(pct(cur?.memUsed ?? 0, cur?.memTotal ?? 0))}`}
          style={{ width: `${pct(cur?.memUsed ?? 0, cur?.memTotal ?? 0)}%` }} /></div>
        <span className="metric-val">{humanSize(cur?.memUsed ?? 0)}</span>
      </div>

      <div className="chart-row">
        <span className="chart-label">Disk</span>
        <div className="bar-track"><div className={`bar-fill ${barClass(pct(cur?.diskUsed ?? 0, cur?.diskTotal ?? 0))}`}
          style={{ width: `${pct(cur?.diskUsed ?? 0, cur?.diskTotal ?? 0)}%` }} /></div>
        <span className="metric-val">{humanSize(cur?.diskUsed ?? 0)}</span>
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <span className="muted small">net in/out:</span>
        <span className="mono small">↓{humanSize(cur?.netRx ?? 0)}/s ↑{humanSize(cur?.netTx ?? 0)}/s</span>
        <span className="muted small">load:</span>
        <span className="mono small">{cur ? `${cur.load1} ${cur.load5} ${cur.load15}` : '-'}</span>
        <span className="muted small">uptime:</span>
        <span className="mono small">{fmtUptime(cur?.uptimeSec ?? 0)}</span>
      </div>
      <Sparkline values={last(s => s.netRx + s.netTx)} />
      <Sparkline values={last(s => pct(s.memUsed, s.memTotal))} max={100} />

      <h4 style={{ margin: '14px 0 6px' }}>Top processes</h4>
      <table className="data">
        <thead><tr><th>pid</th><th>user</th><th>cpu%</th><th>mem%</th><th>command</th><th /></tr></thead>
        <tbody>
          {procs.map(p => (
            <tr key={p.pid}>
              <td>{p.pid}</td><td>{p.user}</td>
              <td>{p.cpuPercent.toFixed(1)}</td>
              <td>{p.memPercent.toFixed(1)} · {humanSize(p.memBytes)}</td>
              <td className="prewrap">{p.command}</td>
              <td><button className="danger small" onClick={() => kill(p)}>kill</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  )
}

export function fmtUptime(sec: number): string {
  if (!sec) return '-'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

// ---- System info modal (ⓘ) ----

export function SystemInfoModal({ hostId, onClose }: { hostId: number; onClose: () => void }) {
  const [info, setInfo] = useState<SI | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    api<SI>(`/api/monitor/info?hostId=${hostId}`).then(setInfo).catch(e => setErr(e.message))
  }, [hostId])
  return (
    <Modal title="System info" onClose={onClose}>
      {err && <div className="err-text">{err}</div>}
      {!info && !err && <div className="muted">probing remote…</div>}
      {info && (
        <>
          <dl className="kv">
            <dt>Hostname</dt><dd>{info.hostname}</dd>
            <dt>OS</dt><dd>{info.distro || info.os}</dd>
            <dt>Kernel</dt><dd>{info.kernel}</dd>
            <dt>Arch</dt><dd>{info.arch}</dd>
            <dt>CPU</dt><dd>{info.cpuModel || '?'} × {info.cpuCores}</dd>
            <dt>RAM</dt><dd>{humanSize(info.ramTotal)}</dd>
            <dt>Disk (/)</dt><dd>{humanSize(info.diskTotal)}</dd>
            <dt>Virtualization</dt><dd>{info.virtualization}</dd>
            <dt>Public IP</dt><dd>{info.publicIp ?? 'unavailable'}</dd>
            <dt>Uptime</dt><dd>{fmtUptime(info.uptimeSec)}</dd>
          </dl>
        </>
      )}
    </Modal>
  )
}
