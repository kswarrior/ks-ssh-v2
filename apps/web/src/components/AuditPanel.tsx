import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useApp } from '../stores/appStore'

// ---- Audit viewer + export (JSON/CSV) + session list + recordings ----

export default function AuditPanel() {
  const [tab, setTab] = useState<'audit' | 'sessions' | 'recordings'>('audit')
  const [rows, setRows] = useState<any[]>([])
  const [filter, setFilter] = useState('')
  const { notify } = useApp()

  const load = useCallback(async () => {
    try {
      if (tab === 'audit') setRows(await api<any[]>('/api/audit?limit=500'))
      else if (tab === 'sessions') setRows(await api<any[]>('/api/sessions?limit=200'))
      else setRows(await api<any[]>('/api/recordings'))
    } catch (e: any) {
      notify({ level: 'error', title: tab, body: e.message })
    }
  }, [tab, notify])

  useEffect(() => { load() }, [load])

  const shown = filter
    ? rows.filter(r =>
      JSON.stringify(r).toLowerCase().includes(filter.toLowerCase()))
    : rows

  return (
    <div style={{ padding: 6 }}>
      <div className="row small" style={{ marginBottom: 6 }}>
        {(['audit', 'sessions', 'recordings'] as const).map(t => (
          <button key={t} className={tab === t ? 'primary' : 'ghost'}
            style={{ fontSize: 11 }} onClick={() => setTab(t)}>{t}</button>
        ))}
        <span style={{ flex: 1 }} />
        {tab === 'audit' && (
          <>
            <a className="small" href="/api/audit/export?format=csv">csv ⬇</a>
            <a className="small" href="/api/audit/export?format=json">json ⬇</a>
          </>
        )}
      </div>
      <input placeholder="filter…" style={{ width: '100%', marginBottom: 6 }}
        value={filter} onChange={e => setFilter(e.target.value)} />
      <table className="data">
        <thead><tr>
          {tab === 'audit' && (<><th>when</th><th>who</th><th>action</th><th>target</th><th>result</th></>)}
          {tab === 'sessions' && (<><th>started</th><th>user</th><th>host</th><th>kind</th><th>ended</th></>)}
          {tab === 'recordings' && (<><th>id</th><th>session</th><th>duration</th><th>size</th><th /></>)}
        </tr></thead>
        <tbody>
          {tab === 'audit' && shown.map((r: any) => (
            <tr key={r.id}>
              <td>{String(r.at).replace('T', ' ').slice(0, 19)}</td>
              <td>{r.username}</td>
              <td>{r.action}</td>
              <td className="prewrap">{String(r.target).slice(0, 60)}</td>
              <td className={r.result === 'ok' ? 'dot-ok' : 'dot-err'}>{r.result}</td>
            </tr>
          ))}
          {tab === 'sessions' && shown.map((r: any) => (
            <tr key={r.id}>
              <td>{String(r.startedAt).replace('T', ' ').slice(0, 19)}</td>
              <td>{r.username}</td>
              <td>{r.hostName}</td>
              <td>{r.kind}</td>
              <td>{r.endedAt ? String(r.endedAt).slice(11, 19) : <span className="dot-warn">live</span>}</td>
            </tr>
          ))}
          {tab === 'recordings' && shown.map((r: any) => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{String(r.sessionId ?? r.sessionToken ?? '').slice(0, 18)}</td>
              <td>{r.durationSec}s</td>
              <td>{(Number(r.sizeBytes) / 1024).toFixed(1)} KB</td>
              <td>
                {r.durationSec > 0 || r.sizeBytes > 0 ? (
                  <a href={`/api/recordings/${r.id}`} target="_blank" rel="noreferrer"
                    download className="small">cast ⬇</a>
                ) : <span className="muted small">recording…</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
