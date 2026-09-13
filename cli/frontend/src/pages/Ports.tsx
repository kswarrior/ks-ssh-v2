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
          <ul className="file-grid" aria-label={`Open ports on ${data?.hostname ?? 'host'}`}>
            {visible.map((p, i) => {
              const svc = serviceName(p.port)
              const tcp = isTcp(p.proto)
              const proc = p.process
                ? ` · ${p.process}${p.pid != null ? ` (pid ${p.pid})` : ''}`
                : ''
              return (
                <li
                  key={`${p.proto}-${p.addr}-${p.port}-${i}`}
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
                  </div>
                  <div className="file-meta">
                    {p.addr}:{p.port} · {p.state}
                    {proc}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
