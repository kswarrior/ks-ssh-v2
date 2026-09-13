import { useCallback, useEffect, useState } from 'react'

type FileEntry = {
  name: string
  path: string
  is_dir: boolean
  size: number
  modified: number | null
}

type ListResponse = {
  home: string
  path: string
  parent: string | null
  entries: FileEntry[]
}

function formatSize(bytes: number): string {
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

function formatDate(secs: number | null): string {
  if (secs == null) return '—'
  const d = new Date(secs * 1000)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

export default function FilesPage() {
  const [data, setData] = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(true)

  const load = useCallback(async (path?: string) => {
    setLoading(true)
    setError(null)
    try {
      const url = path
        ? `/api/files?path=${encodeURIComponent(path)}`
        : '/api/files'
      const res = await fetch(url)
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `request failed (${res.status})`)
      }
      const json = (await res.json()) as ListResponse
      setData(json)
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Cannot reach the host. Files works on the local UI (http://127.0.0.1:8080) — not over the relay view.',
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const visible = (data?.entries ?? []).filter(
    (e) => showHidden || !e.name.startsWith('.'),
  )
  const dirCount = visible.filter((e) => e.is_dir).length
  const fileCount = visible.length - dirCount

  return (
    <section className="page files-page" aria-labelledby="page-title-files">
      <div className="page-head">
        <h1 id="page-title-files">Files</h1>
        <div className="row-actions files-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void load(data?.home)}
            disabled={loading}
            title="Go to HOME"
          >
            Home
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => data?.parent && void load(data.parent)}
            disabled={loading || !data?.parent}
            title={data?.parent ?? 'Already at HOME'}
          >
            Up
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void load(data?.path)}
            disabled={loading}
            title="Refresh"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="card files-card">
        <div className="files-pathrow">
          <code className="files-path" title={data?.path ?? 'HOME of host'}>
            {data?.path ?? '~'}
          </code>
          <label className="files-toggle">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            Hidden
          </label>
        </div>
        <p className="files-sub">
          {loading
            ? 'Loading HOME of host…'
            : error
              ? 'Could not list host files.'
              : `${dirCount} folders · ${fileCount} files`}
        </p>

        {error ? (
          <div className="banner-error" role="alert">
            <p>{error}</p>
            <p>
              Tip: run <code>ks-ssh --port 8080</code> on the host and open
              this tab there. The fullscreen relay view has no host
              filesystem access.
            </p>
            <div className="row-actions">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => void load(data?.path)}
              >
                Retry
              </button>
            </div>
          </div>
        ) : loading && !data ? (
          <p aria-busy="true">Loading…</p>
        ) : visible.length === 0 ? (
          <p>Empty folder.</p>
        ) : (
          <ul className="file-list" aria-label={`Files in ${data?.path}`}>
            {visible.map((e) => (
              <li key={e.path} className="file-row">
                <span
                  className="file-icon"
                  aria-hidden="true"
                  data-kind={e.is_dir ? 'dir' : 'file'}
                >
                  {e.is_dir ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <path d="M14 2v6h6" />
                    </svg>
                  )}
                </span>
                <span className="file-info">
                  {e.is_dir ? (
                    <button
                      type="button"
                      className="file-name file-link"
                      onClick={() => void load(e.path)}
                      title={`Open ${e.path}`}
                    >
                      {e.name}
                    </button>
                  ) : (
                    <a
                      className="file-name file-link"
                      href={`/api/files/download?path=${encodeURIComponent(e.path)}`}
                      title={`Download ${e.path}`}
                    >
                      {e.name}
                    </a>
                  )}
                  <span className="file-meta">
                    {e.is_dir ? 'folder' : formatSize(e.size)} ·{' '}
                    {formatDate(e.modified)}
                  </span>
                </span>
                {e.is_dir ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void load(e.path)}
                  >
                    Open
                  </button>
                ) : (
                  <a
                    className="btn btn-sm"
                    href={`/api/files/download?path=${encodeURIComponent(e.path)}`}
                    download={e.name}
                  >
                    Get
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
