import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useApp } from '../stores/appStore'
import type { PortRow } from '@shared'
import { Modal, Confirm } from './ui'

export default function PortsPanel({ hostId }: { hostId: number }) {
  const [rows, setRows] = useState<PortRow[]>([])
  const [busy, setBusy] = useState(false)
  const [killTarget, setKillTarget] = useState<PortRow | null>(null)
  const [auto, setAuto] = useState(true)
  const { notify } = useApp()

  const load = useCallback(async () => {
    setBusy(true)
    try {
      setRows(await api<PortRow[]>(`/api/ports?hostId=${hostId}`))
    } catch (e: any) {
      notify({ level: 'error', title: 'ports', body: e.message })
    }
    setBusy(false)
  }, [hostId, notify])

  useEffect(() => {
    load()
    if (!auto) return
    const t = setInterval(load, 10000) // auto-refresh every 10 s (plan §2.5)
    return () => clearInterval(t)
  }, [load, auto])

  async function kill(row: PortRow) {
    try {
      await api('/api/ports/kill', { method: 'POST', body: { hostId, pid: row.pid, port: row.port } })
      notify({ level: 'info', title: `killed pid ${row.pid}`, body: `port ${row.port}` })
      load()
    } catch (e: any) {
      notify({ level: 'error', title: 'kill failed', body: e.message })
    }
  }

  function previewUrl(row: PortRow): string | null {
    const host = useApp.getState().hosts.find(h => h.id === hostId)
    if (!host?.previewEnabled || row.protocol !== 'tcp') return null
    return `${location.origin}/port/preview/${hostId}/${row.port}/`
  }

  return (
    <div style={{ padding: 6 }}>
      <div className="row small" style={{ justifyContent: 'space-between', padding: '2px 4px' }}>
        <span className="muted">{rows.length} listening · refresh 10s</span>
        <span className="row" style={{ gap: 4 }}>
          <label className="small muted">
            <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} /> auto
          </label>
          <button className="ghost small" disabled={busy} onClick={load}>↻</button>
        </span>
      </div>
      <table className="data">
        <thead><tr><th>port</th><th>bind</th><th>pid</th><th>process</th><th /></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.protocol}-${r.port}-${r.pid}-${i}`}>
              <td>{r.port}/{r.protocol}</td>
              <td>{r.bindAddress}</td>
              <td>{r.pid ?? '—'}</td>
              <td className="prewrap">{r.process || '—'}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {r.pid != null && (
                  <button className="danger small" onClick={() => setKillTarget(r)}>Kill</button>
                )}
                {r.protocol === 'tcp' && (() => {
                  const u = previewUrl(r)
                  return u ? (
                    <a href={u} target="_blank" rel="noreferrer"
                      style={{ marginLeft: 6 }} className="small">Preview ↗</a>
                  ) : null
                })()}
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="muted">no data — connect first</td></tr>}
        </tbody>
      </table>

      {killTarget && (
        <Confirm
          title={`Kill PID ${killTarget.pid}?`}
          body={`Process ${killTarget.process || 'unknown'} on port ${killTarget.port}. The server re-validates ownership before killing.`}
          danger onYes={() => kill(killTarget)} onClose={() => setKillTarget(null)} />
      )}
    </div>
  )
}

export { Modal }
