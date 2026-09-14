import { useCallback, useEffect, useMemo, useState } from 'react'

type AuditRow = {
  id: number
  ts: number
  actor: string
  ip: string
  action: string
  target: string
  result: string
}

function fmtTime(ts: number): string {
  try {
    return new Date(ts * 1000).toLocaleString()
  } catch {
    return String(ts)
  }
}

function downloadBlob(filename: string, text: string, mime: string): void {
  try {
    const blob = new Blob([text], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    window.setTimeout(() => {
      URL.revokeObjectURL(url)
      a.remove()
    }, 500)
  } catch {
    // Download unavailable — nothing else we can do.
  }
}

function toCsv(rows: AuditRow[]): string {
  const esc = (s: string): string =>
    /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  const out = ['id,ts,actor,ip,action,target,result']
  for (const r of rows) {
    out.push(
      [r.id, r.ts, esc(r.actor), esc(r.ip), esc(r.action), esc(r.target), esc(r.result)].join(','),
    )
  }
  return out.join('\n')
}

/**
 * Audit trail (admin only): who logged in, changed users, killed PIDs,
 * deleted files, attached to shells, played recordings.
 * Filter + export JSON/CSV. The export itself is audited server-side.
 */
export default function AuditPage() {
  const [rows, setRows] = useState<AuditRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [disabled, setDisabled] = useState(false)
  const [filter, setFilter] = useState('')
  const [action, setAction] = useState('')
  const [result, setResult] = useState('')
  const [limit, setLimit] = useState(200)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(`/api/audit?limit=${limit}`, {
        cache: 'no-store',
        credentials: 'same-origin',
      })
      if (res.status === 401) {
        window.dispatchEvent(
          new CustomEvent('ks-ssh:auth', { detail: { protected: true, authenticated: false } }),
        )
        throw new Error('Session expired — please log in again.')
      }
      if (res.status === 404) {
        setDisabled(true)
        setRows([])
        return
      }
      if (res.status === 403) {
        setForbidden(true)
        setRows([])
        return
      }
      const data = (await res.json().catch(() => null)) as {
        audit?: AuditRow[]
        error?: string
      } | null
      if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`)
      setRows(Array.isArray(data?.audit) ? data.audit : [])
    } catch (e) {
      setError((e as Error).message)
    }
  }, [limit])

  useEffect(() => {
    void load()
  }, [load])

  const actions = useMemo(() => {
    const s = new Set<string>()
    for (const r of rows ?? []) if (r.action) s.add(r.action)
    return [...s].sort()
  }, [rows])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (rows ?? []).filter((r) => {
      if (action && r.action !== action) return false
      if (result && r.result !== result) return false
      if (!q) return true
      return (
        r.actor.toLowerCase().includes(q) ||
        r.action.toLowerCase().includes(q) ||
        r.target.toLowerCase().includes(q) ||
        r.ip.toLowerCase().includes(q)
      )
    })
  }, [rows, filter, action, result])

  const exportJson = async () => {
    try {
      const res = await fetch(`/api/audit?limit=1000`, {
        cache: 'no-store',
        credentials: 'same-origin',
      })
      const data = (await res.json()) as { audit?: AuditRow[] }
      downloadBlob(
        'ks-ssh-audit.json',
        JSON.stringify(data.audit ?? [], null, 2),
        'application/json',
      )
    } catch {
      // Fall back to the rows already on screen.
      downloadBlob('ks-ssh-audit.json', JSON.stringify(filtered, null, 2), 'application/json')
    }
  }

  const exportCsv = () => {
    // Server-rendered CSV (admin only) — one click, correct escaping.
    // Falls back to a client-side render when the endpoint is unreachable.
    fetch(`/api/audit/export?format=csv&limit=1000`, {
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then((res) => {
        if (!res.ok) throw new Error(`http ${res.status}`)
        return res.text()
      })
      .then((text) => downloadBlob('ks-ssh-audit.csv', text, 'text/csv;charset=utf-8'))
      .catch(() => downloadBlob('ks-ssh-audit.csv', toCsv(filtered), 'text/csv;charset=utf-8'))
  }

  return (
    <section className="page settings-page" aria-label="Audit log">
      <div className="page-head">
        <a className="btn btn-sm" href="#/more">
          ← More
        </a>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-sm" onClick={() => void load()}>
          Refresh
        </button>
        {!forbidden && !disabled && (
          <>
            <button type="button" className="btn btn-sm" onClick={() => void exportJson()}>
              Export JSON
            </button>
            <button type="button" className="btn btn-sm" onClick={exportCsv}>
              Export CSV
            </button>
          </>
        )}
      </div>

      <div className="card">
        <h2>Audit log</h2>
        {disabled ? (
          <p className="lead">
            Auditing needs the login gate. Restart the server with <code>--user</code> and{' '}
            <code>--pass</code>.
          </p>
        ) : forbidden ? (
          <p className="lead">The audit trail is admin-only — your role cannot view it. Every access attempt is itself audited.</p>
        ) : (
          <>
            <p className="lead">
              Append-only: logins, user changes, file writes, kills, shell attach/detach,
              recording playback. Retention: <code>--audit-retain-days</code> (default 90, 0 = forever).
            </p>
            <div className="audit-filters">
              <label className="field">
                Search
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="actor, action, target, ip…"
                  aria-label="Filter audit rows by text"
                />
              </label>
              <label className="field">
                Action
                <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter by action">
                  <option value="">all</option>
                  {actions.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Result
                <select value={result} onChange={(e) => setResult(e.target.value)} aria-label="Filter by result">
                  <option value="">all</option>
                  <option value="ok">ok</option>
                  <option value="deny">deny</option>
                  <option value="locked">locked</option>
                </select>
              </label>
              <label className="field">
                Limit
                <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} aria-label="Row limit">
                  <option value={100}>100</option>
                  <option value={200}>200</option>
                  <option value={500}>500</option>
                  <option value={1000}>1000</option>
                </select>
              </label>
            </div>
            {error && (
              <p className="login-error" role="alert">
                {error}{' '}
                <button type="button" className="btn btn-sm" onClick={() => void load()}>
                  Retry
                </button>
              </p>
            )}
            {rows === null && !error && <p className="lead">Loading…</p>}
            {rows !== null && (
              <p className="lead" role="status">
                Showing {filtered.length} of {rows.length} row(s).
              </p>
            )}
            {filtered.length > 0 && (
              <div className="table-wrap">
                <table className="audit-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Actor</th>
                      <th>IP</th>
                      <th>Action</th>
                      <th>Target</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => (
                      <tr key={r.id}>
                        <td className="nowrap">{fmtTime(r.ts)}</td>
                        <td>{r.actor}</td>
                        <td>{r.ip}</td>
                        <td>
                          <code>{r.action}</code>
                        </td>
                        <td className="wrap-anywhere">{r.target}</td>
                        <td>
                          <span className={r.result === 'ok' || r.result === 'noop' ? 'tag' : 'tag offline'}>
                            {r.result}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}
