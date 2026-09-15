import { useCallback, useEffect, useMemo, useState } from 'react'

type PortEntry = {
  proto: string
  addr: string
  port: number
  state: string
  pid: number | null
  process: string | null
}

type PortsResponse = {
  hostname: string
  count: number
  ports: PortEntry[]
}

type ProtoFilter = 'all' | 'tcp' | 'udp'
type ViewMode = 'grid' | 'list'

const KNOWN_SERVICES: Record<number, string> = {
  20: 'FTP-data',
  21: 'FTP',
  22: 'SSH',
  23: 'Telnet',
  25: 'SMTP',
  53: 'DNS',
  67: 'DHCP',
  68: 'DHCP',
  69: 'TFTP',
  80: 'HTTP',
  110: 'POP3',
  123: 'NTP',
  143: 'IMAP',
  161: 'SNMP',
  443: 'HTTPS',
  445: 'SMB',
  465: 'SMTPS',
  587: 'SMTP',
  993: 'IMAPS',
  995: 'POP3S',
  1433: 'MSSQL',
  1521: 'Oracle',
  2049: 'NFS',
  3000: 'Dev',
  3306: 'MySQL',
  3389: 'RDP',
  4000: 'Dev',
  5000: 'Dev',
  5432: 'Postgres',
  5900: 'VNC',
  6379: 'Redis',
  8000: 'Dev',
  8080: 'HTTP-alt',
  8443: 'HTTPS-alt',
  9000: 'Dev',
  9090: 'Dev',
  9200: 'Elastic',
  27017: 'MongoDB',
  27018: 'MongoDB',
}

function serviceName(port: number): string | null {
  return KNOWN_SERVICES[port] ?? null
}

function isTcp(proto: string): boolean {
  return proto.toUpperCase().startsWith('TCP')
}

export default function PortsPage() {
  const [data, setData] = useState<PortsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<ProtoFilter>('all')
  const [query, setQuery] = useState('')
  const [view, setView] = useState<ViewMode>('grid')
  const [confirmKill, setConfirmKill] = useState<{ key: string; port: PortEntry } | null>(null)
  const [killing, setKilling] = useState<string | null>(null)
  const [killError, setKillError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/ports')
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `request failed (${res.status})`)
      }
      const json = (await res.json()) as PortsResponse
      setData(json)
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Cannot reach the host. Ports works on the local UI (http://127.0.0.1:8080) — not over the relay view.',
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Escape closes the kill confirmation (when not killing).
  useEffect(() => {
    if (!confirmKill || killing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirmKill(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [confirmKill, killing])

  const killPort = useCallback(
    async (p: PortEntry, key: string) => {
      if (p.pid == null) return
      setKilling(key)
      setKillError(null)
      try {
        const res = await fetch('/api/ports/kill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pid: p.pid }),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(text || `kill failed (${res.status})`)
        }
        setConfirmKill(null)
        await load()
      } catch (e) {
        setKillError(e instanceof Error ? e.message : 'Kill failed.')
      } finally {
        setKilling(null)
      }
    },
    [load],
  )

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (data?.ports ?? []).filter((p) => {
      if (filter === 'tcp' && !isTcp(p.proto)) return false
      if (filter === 'udp' && isTcp(p.proto)) return false
      if (!q) return true
      const svc = serviceName(p.port)?.toLowerCase() ?? ''
      return (
        String(p.port).includes(q) ||
        p.addr.toLowerCase().includes(q) ||
        (p.process ?? '').toLowerCase().includes(q) ||
        (p.pid != null && String(p.pid).includes(q)) ||
        svc.includes(q) ||
        p.proto.toLowerCase().includes(q)
      )
    })
  }, [data, filter, query])

  const tcpCount = useMemo(
    () => (data?.ports ?? []).filter((p) => isTcp(p.proto)).length,
    [data],
  )
  const udpCount = (data?.ports.length ?? 0) - tcpCount

  return (
    <section className="page ports-page" aria-labelledby="page-title-ports">
      <div className="page-head ports-head">
        <h1 id="page-title-ports" className="sr-only">
          Ports
        </h1>
        <div className="row-actions ports-actions">
          <label className="ports-search">
            <span className="sr-only">Search ports</span>
            <svg className="ports-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search port, address, process…"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="ports-right">
            <label className="ports-select-wrap">
              <span className="sr-only">Protocol filter</span>
              <select
                className="ports-select"
                value={filter}
                onChange={(e) => setFilter(e.target.value as ProtoFilter)}
                aria-label="Protocol filter"
              >
                <option value="all">All</option>
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
              </select>
              <svg className="ports-select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </label>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setView((v) => (v === 'grid' ? 'list' : 'grid'))}
              title={view === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
              aria-label={view === 'grid' ? 'List view' : 'Grid view'}
              aria-pressed={view === 'list'}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {view === 'grid' ? (
                  <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
                ) : (
                  <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />
                )}
              </svg>
              <span className="btn-label">{view === 'grid' ? 'List' : 'Grid'}</span>
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => void load()}
              disabled={loading}
              title="Rescan host ports"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <path d="M21 3v6h-6" />
              </svg>
              <span className="btn-label">{loading ? 'Scanning…' : 'Refresh'}</span>
            </button>
          </div>
        </div>
      </div>

      <div className="files-body">
        <p className="files-sub" aria-live="polite">
          {loading && !data
            ? 'Scanning host ports…'
            : error
              ? 'Could not scan host ports.'
              : `${visible.length} of ${data?.ports.length ?? 0} open ports on ${data?.hostname ?? 'host'} · ${tcpCount} TCP · ${udpCount} UDP`}
        </p>

        {killError && !error && (
          <div className="banner-error" role="alert">
            <p>{killError}</p>
          </div>
        )}

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
                title="Retry scanning ports"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                  <path d="M21 3v6h-6" />
                </svg>
                <span className="btn-label">Retry</span>
              </button>
            </div>
          </div>
        ) : loading && !data ? (
          <ul
            className="file-grid"
            aria-label="Scanning host ports"
            aria-busy="true"
          >
            {Array.from({ length: 8 }, (_, i) => (
              <li key={i} className="file-card ports-skeleton" aria-hidden="true">
                <div className="file-card-top">
                  <span className="skeleton skeleton-icon" />
                  <span className="skeleton skeleton-title" />
                </div>
                <div className="file-meta">
                  <span className="skeleton skeleton-meta" />
                </div>
              </li>
            ))}
            <span className="sr-only" role="status">Scanning host ports…</span>
          </ul>
        ) : visible.length === 0 ? (
          <div className="ports-empty">
            <h2>No open ports found</h2>
            <p>
              {query || filter !== 'all'
                ? 'Nothing matches this filter. Clear the search or switch protocol.'
                : 'No listening TCP ports or bound UDP sockets were detected on this host.'}
            </p>
          </div>
        ) : (
          <ul className={view === 'grid' ? 'file-grid' : 'file-list'} aria-label={`Open ports on ${data?.hostname ?? 'host'}`}>
            {visible.map((p, i) => {
              const svc = serviceName(p.port)
              const tcp = isTcp(p.proto)
              const key = `${p.proto}-${p.addr}-${p.port}-${i}`
              const proc = p.process
                ? ` · ${p.process}${p.pid != null ? ` (pid ${p.pid})` : ''}`
                : ''
              const metaText = `${p.addr}:${p.port} · ${p.state}${proc}`
              const isConfirm = confirmKill?.key === key
              return (
                <li
                  key={key}
                  className="file-card"
                  title={`Port ${p.port} (${p.proto}) on ${p.addr}${p.process ? ` — ${p.process}` : ''}`}
                >
                  <div className="file-card-top">
                    <span
                      className="file-icon"
                      aria-hidden="true"
                      data-kind={tcp ? 'dir' : 'file'}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 2v6M15 2v6M7 8h10v4a5 5 0 0 1-10 0z" />
                        <path d="M12 17v5" />
                      </svg>
                    </span>
                    <span className="file-name">
                      <span className="ports-port">{p.port}</span>
                      {svc && (
                        <span className="ports-svc" title="Well-known service">
                          {svc}
                        </span>
                      )}
                    </span>
                    <span
                      className="ports-pill ports-top-pill"
                      data-proto={tcp ? 'tcp' : 'udp'}
                    >
                      {p.proto}
                    </span>
                    <button
                      type="button"
                      className="ports-kill"
                      disabled={p.pid == null || killing != null}
                      title={
                        p.pid != null
                          ? `Kill ${p.process ?? 'process'} (pid ${p.pid}) — frees port ${p.port}`
                          : 'No process info — cannot kill'
                      }
                      aria-label={
                        p.pid != null
                          ? `Kill process on port ${p.port} (pid ${p.pid})`
                          : `Cannot kill port ${p.port} — no process info`
                      }
                      onClick={(e) => {
                        e.stopPropagation()
                        setKillError(null)
                        setConfirmKill(isConfirm ? null : { key, port: p })
                      }}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M3 6h18" />
                        <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                        <path d="M10 11v6M14 11v6" />
                      </svg>
                    </button>
                  </div>
                  <div className="file-meta" title={metaText}>
                    {p.addr}:{p.port} · {p.state}
                    {proc}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {confirmKill && (
        <div
          className="term-confirm-overlay"
          onClick={() => {
            if (!killing) setConfirmKill(null)
          }}
        >
          <div
            className="term-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="ports-confirm-title"
            onClick={(e) => e.stopPropagation()}
          >
            <svg
              className="term-confirm-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 6h18" />
              <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6" />
              <path d="M10 11v6M14 11v6" />
            </svg>
            <h2 id="ports-confirm-title">
              Kill process on port {confirmKill.port.port}?
            </h2>
            <p>
              Kill{' '}
              <strong>
                {confirmKill.port.process ?? 'process'}
                {confirmKill.port.pid != null
                  ? ` (pid ${confirmKill.port.pid})`
                  : ''}
              </strong>{' '}
              on port <strong>{confirmKill.port.port}</strong>? This frees
              the port.
            </p>
            {killError && (
              <div className="banner-error" role="alert">
                <p>{killError}</p>
              </div>
            )}
            <div className="term-confirm-actions">
              <button
                type="button"
                className="btn btn-sm"
                disabled={killing != null}
                onClick={() => setConfirmKill(null)}
                autoFocus
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={killing != null}
                onClick={() =>
                  void killPort(confirmKill.port, confirmKill.key)
                }
              >
                {killing ? 'Killing…' : 'Kill'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
