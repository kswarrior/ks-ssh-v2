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
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search port, address, process…"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div
            className="create-tabs ports-filter"
            role="tablist"
            aria-label="Protocol filter"
          >
            {(
              [
                ['all', 'All'],
                ['tcp', 'TCP'],
                ['udp', 'UDP'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={filter === id}
                className={filter === id ? 'create-tab active' : 'create-tab'}
                onClick={() => setFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => void load()}
            disabled={loading}
            title="Rescan host ports"
          >
            {loading ? 'Scanning…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="card ports-card">
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
              >
                Retry
              </button>
            </div>
          </div>
        ) : loading && !data ? (
          <p aria-busy="true">Scanning…</p>
        ) : visible.length === 0 ? (
          <div className="card">
            <h2>No open ports found</h2>
            <p>
              {query || filter !== 'all'
                ? 'Nothing matches this filter. Clear the search or switch protocol.'
                : 'No listening TCP ports or bound UDP sockets were detected on this host.'}
            </p>
          </div>
        ) : (
          <div className="ports-table-wrap">
            <table className="ports-table">
              <thead>
                <tr>
                  <th scope="col">Port</th>
                  <th scope="col">Proto</th>
                  <th scope="col">Listen address</th>
                  <th scope="col">State</th>
                  <th scope="col">Process</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((p, i) => {
                  const svc = serviceName(p.port)
                  return (
                    <tr key={`${p.proto}-${p.addr}-${p.port}-${i}`}>
                      <td>
                        <span className="ports-port">{p.port}</span>
                        {svc && (
                          <span className="ports-svc" title="Well-known service">
                            {svc}
                          </span>
                        )}
                      </td>
                      <td>
                        <span
                          className="ports-pill"
                          data-proto={isTcp(p.proto) ? 'tcp' : 'udp'}
                        >
                          {p.proto}
                        </span>
                      </td>
                      <td>
                        <code className="ports-addr" title={`${p.addr}:${p.port}`}>
                          {p.addr}
                        </code>
                      </td>
                      <td>
                        <span className="tag online">{p.state}</span>
                      </td>
                      <td className="ports-proc">
                        {p.process ? (
                          <>
                            <span className="ports-proc-name">{p.process}</span>
                            {p.pid != null && (
                              <span className="ports-pid" title="Process ID">
                                pid {p.pid}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="ports-unknown" title="Needs root to see all processes">
                            —
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}
