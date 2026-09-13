import { useCallback, useEffect, useRef, useState } from 'react'

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

function downloadUrl(path: string): string {
  return `/api/files/download?path=${encodeURIComponent(path)}`
}

export default function FilesPage() {
  const [data, setData] = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(true)
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)

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
      setMenuOpen(null)
      setRenaming(null)
      setConfirmDelete(null)
      setActionError(null)
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

  // Close the ⋮ menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return
    const onDocClick = () => setMenuOpen(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(null)
        setConfirmDelete(null)
      }
    }
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  // Focus the rename field when it opens.
  useEffect(() => {
    if (renaming) {
      const t = setTimeout(() => renameInputRef.current?.select(), 30)
      return () => clearTimeout(t)
    }
  }, [renaming])

  const visible = (data?.entries ?? []).filter(
    (e) => showHidden || !e.name.startsWith('.'),
  )
  const dirCount = visible.filter((e) => e.is_dir).length
  const fileCount = visible.length - dirCount

  const startRename = (e: FileEntry) => {
    setMenuOpen(null)
    setConfirmDelete(null)
    setActionError(null)
    setRenaming(e.path)
    setNewName(e.name)
  }

  const submitRename = async (e: FileEntry) => {
    const name = newName.trim()
    if (!name || name === e.name) {
      setRenaming(null)
      return
    }
    if (name.includes('/') || name.includes('\\')) {
      setActionError('Name cannot contain / or \\.')
      return
    }
    setBusy(true)
    setActionError(null)
    try {
      const to = `${data?.path ?? ''}/${name}`
      const res = await fetch('/api/files/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: e.path, to }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `rename failed (${res.status})`)
      }
      await load(data?.path)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Rename failed.')
    } finally {
      setBusy(false)
    }
  }

  const submitDelete = async (e: FileEntry) => {
    setBusy(true)
    setActionError(null)
    try {
      const res = await fetch(
        `/api/files?path=${encodeURIComponent(e.path)}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `delete failed (${res.status})`)
      }
      await load(data?.path)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Delete failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="page files-page" aria-labelledby="page-title-files">
      <div className="page-head">
        <h1 id="page-title-files">Files</h1>
        <div className="row-actions files-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void load(data?.home)}
            disabled={loading || busy}
            title="Go to HOME"
          >
            Home
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => data?.parent && void load(data.parent)}
            disabled={loading || busy || !data?.parent}
            title={data?.parent ?? 'Already at HOME'}
          >
            Up
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void load(data?.path)}
            disabled={loading || busy}
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

        {actionError && !error && (
          <div className="banner-error" role="alert">
            <p>{actionError}</p>
          </div>
        )}

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
          <ul className="file-grid" aria-label={`Files in ${data?.path}`}>
            {visible.map((e) => {
              const isMenu = menuOpen === e.path
              const isRenaming = renaming === e.path
              const isConfirm = confirmDelete === e.path
              return (
                <li key={e.path} className="file-card">
                  <div className="file-card-top">
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
                    {isRenaming ? (
                      <form
                        className="file-rename-form"
                        onSubmit={(ev) => {
                          ev.preventDefault()
                          void submitRename(e)
                        }}
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        <input
                          ref={renameInputRef}
                          className="file-rename-input"
                          type="text"
                          value={newName}
                          onChange={(ev) => setNewName(ev.target.value)}
                          aria-label={`New name for ${e.name}`}
                          maxLength={255}
                          disabled={busy}
                        />
                      </form>
                    ) : e.is_dir ? (
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
                        href={downloadUrl(e.path)}
                        title={`Download ${e.path}`}
                      >
                        {e.name}
                      </a>
                    )}
                    <div
                      className="file-menu-wrap"
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="file-dots"
                        aria-label={`Actions for ${e.name}`}
                        aria-haspopup="menu"
                        aria-expanded={isMenu}
                        title="Actions"
                        onClick={(ev) => {
                          ev.stopPropagation()
                          setMenuOpen(isMenu ? null : e.path)
                          setConfirmDelete(null)
                        }}
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                          <circle cx="12" cy="5" r="1.8" />
                          <circle cx="12" cy="12" r="1.8" />
                          <circle cx="12" cy="19" r="1.8" />
                        </svg>
                      </button>
                      {isMenu && (
                        <div className="file-menu" role="menu">
                          {e.is_dir ? (
                            <button
                              type="button"
                              role="menuitem"
                              className="file-menu-item"
                              onClick={() => void load(e.path)}
                            >
                              Open
                            </button>
                          ) : (
                            <a
                              role="menuitem"
                              className="file-menu-item"
                              href={downloadUrl(e.path)}
                              download={e.name}
                            >
                              Download
                            </a>
                          )}
                          <button
                            type="button"
                            role="menuitem"
                            className="file-menu-item"
                            onClick={() => startRename(e)}
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="file-menu-item danger"
                            onClick={() => setConfirmDelete(e.path)}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="file-meta">
                    {e.is_dir ? 'folder' : formatSize(e.size)} ·{' '}
                    {formatDate(e.modified)}
                  </div>

                  {isRenaming && (
                    <div className="file-inline-actions">
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={busy || !newName.trim() || newName.trim() === e.name}
                        onClick={() => void submitRename(e)}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => {
                          setRenaming(null)
                          setActionError(null)
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  )}

                  {isConfirm && (
                    <div
                      className="file-confirm"
                      role="alertdialog"
                      aria-label={`Delete ${e.name}?`}
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      <p>
                        Delete <strong>{e.name}</strong>
                        {e.is_dir ? ' and everything inside it?' : '?'}
                      </p>
                      <div className="file-inline-actions">
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={busy}
                          onClick={() => void submitDelete(e)}
                        >
                          {busy ? 'Deleting…' : 'Delete'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          onClick={() => setConfirmDelete(null)}
                        >
                          Keep
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
