import { useCallback, useEffect, useState } from 'react'
import { api, humanSize } from '../lib/api'
import { useApp } from '../stores/appStore'
import type { Tunnel } from '@shared'

export default function TunnelsPanel({ hostId }: { hostId: number }) {
  const [rows, setRows] = useState<Tunnel[]>([])
  const { notify } = useApp()

  const load = useCallback(async () => {
    try {
      const all = await api<Tunnel[]>('/api/tunnels')
      setRows(all)
    } catch (e: any) {
      notify({ level: 'error', title: 'tunnels', body: e.message })
    }
  }, [notify])

  useEffect(() => {
    load()
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [load])

  async function create() {
    const kind = prompt('kind: L (local), R (remote), D (SOCKS5)')?.toUpperCase()
    if (!kind || !['L', 'R', 'D'].includes(kind)) return
    let localPort = 0
    let remoteHost = ''
    let remotePort = 0
    if (kind !== 'R') {
      localPort = Number(prompt('local port to listen on:') ?? 0)
      if (!localPort) return
    }
    if (kind === 'L') {
      remoteHost = prompt('remote target host (as seen from the SSH server):', '127.0.0.1') ?? '127.0.0.1'
      remotePort = Number(prompt('remote target port:') ?? 0)
      if (!remotePort) return
    }
    if (kind === 'R') {
      remoteHost = prompt('bind address on remote host:', '127.0.0.1') ?? '127.0.0.1'
      remotePort = Number(prompt('port to listen on the remote host:') ?? 0)
      localPort = Number(prompt('forward to local port on KS SSH machine:') ?? 0)
      if (!remotePort || !localPort) return
    }
    try {
      await api('/api/tunnels', {
        method: 'POST',
        body: { hostId, kind, localPort, remoteHost, remotePort },
      })
      load()
    } catch (e: any) {
      notify({ level: 'error', title: 'create tunnel failed', body: e.message })
    }
  }

  async function act(id: number, action: 'start' | 'stop' | 'delete') {
    try {
      await api(`/api/tunnels/${id}/${action}`, { method: action === 'delete' ? 'DELETE' : 'POST' })
      load()
    } catch (e: any) {
      notify({ level: 'error', title: `tunnel ${action}`, body: e.message })
    }
  }

  const dotFor = (s: string) =>
    s === 'up' ? 'dot-ok' : s === 'error' ? 'dot-err' : s === 'starting' ? 'dot-warn' : ''

  return (
    <div style={{ padding: 6 }}>
      <div className="row small" style={{ justifyContent: 'space-between', padding: '2px 4px' }}>
        <span className="muted">L · R · SOCKS5 — persist across restarts</span>
        <button className="ghost small" onClick={create}>＋ new</button>
      </div>
      <table className="data">
        <thead><tr><th>type</th><th>route</th><th>status</th><th>traffic</th><th /></tr></thead>
        <tbody>
          {rows.map(t => (
            <tr key={t.id}>
              <td>{t.kind === 'D' ? 'SOCKS' : t.kind}</td>
              <td className="prewrap">
                {t.kind === 'L' && `${t.localHost}:${t.localPort} → ${t.remoteHost}:${t.remotePort}`}
                {t.kind === 'R' && `remote :${t.remotePort} → local:${t.localPort}`}
                {t.kind === 'D' && `${t.localHost}:${t.localPort}`}
              </td>
              <td className={dotFor(t.status)}>● {t.status}{t.error ? ` (${t.error.slice(0, 40)})` : ''}</td>
              <td>↑{humanSize(t.bytesUp)} ↓{humanSize(t.bytesDown)}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {t.status !== 'up'
                  ? <button className="small" onClick={() => act(t.id, 'start')}>start</button>
                  : <button className="small" onClick={() => act(t.id, 'stop')}>stop</button>}
                <button className="danger small" style={{ marginLeft: 4 }}
                  onClick={() => act(t.id, 'delete')}>✕</button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={5} className="muted">no tunnels yet</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
