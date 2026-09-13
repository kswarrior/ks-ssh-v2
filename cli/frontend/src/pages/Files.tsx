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

type ContentKind = 'text' | 'binary' | 'too-large'

type ContentResponse = {
  path: string
  name: string
  size: number
  modified: number | null
  kind: ContentKind
  content?: string
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
  // Editor state.
  const [editing, setEditing] = useState<FileEntry | null>(null)
  const [editorKind, setEditorKind] = useState<ContentKind | null>(null)
  const [editorText, setEditorText] = useState('')
  const [editorSaved, setEditorSaved] = useState('')
  const [editorLoading, setEditorLoading] = useState(false)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [editorSaving, setEditorSaving] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const editorDirty = editorText !== editorSaved
  // Create dialog state.
  const [creating, setCreating] = useState<null | 'file' | 'folder'>(null)
  const [createName, setCreateName] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const createInputRef = useRef<HTMLInputElement | null>(null)
  // Upload dialog state.
  const [uploading, setUploading] = useState<null | 'local' | 'url'>(null)
  const [uploadFiles, setUploadFiles] = useState<File[]>([])
  const [uploadUrl, setUploadUrl] = useState('')
  const [uploadName, setUploadName] = useState('')
  const [uploadBusy, setUploadBusy] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadDone, setUploadDone] = useState<string[]>([])
  const [uploadProgress, setUploadProgress] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

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

  // Escape closes the editor (twice when there are unsaved changes).
  useEffect(() => {
    if (!editing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeEditor()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  // Focus the create input + Escape closes the create dialog.
  useEffect(() => {
    if (!creating) return
    const t = setTimeout(() => createInputRef.current?.select(), 30)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !createBusy) setCreating(null)
    }
    document.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      document.removeEventListener('keydown', onKey)
    }
  }, [creating, createBusy])

  // Escape closes the upload dialog (when idle).
  useEffect(() => {
    if (!uploading) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !uploadBusy) setUploading(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [uploading, uploadBusy])

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

  // Click a card: folders open, files open in the editor.
  const openEntry = (e: FileEntry) => {
    if (renaming === e.path || confirmDelete === e.path) return
    if (e.is_dir) {
      void load(e.path)
    } else {
      void openEditor(e)
    }
  }

  const openEditor = async (e: FileEntry) => {
    setEditing(e)
    setEditorKind(null)
    setEditorText('')
    setEditorSaved('')
    setEditorError(null)
    setConfirmDiscard(false)
    setEditorLoading(true)
    try {
      const res = await fetch(
        `/api/files/content?path=${encodeURIComponent(e.path)}`,
      )
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `cannot open file (${res.status})`)
      }
      const json = (await res.json()) as ContentResponse
      setEditorKind(json.kind)
      if (json.kind === 'text') {
        setEditorText(json.content ?? '')
        setEditorSaved(json.content ?? '')
      }
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : 'Cannot open file.')
    } finally {
      setEditorLoading(false)
    }
  }

  const closeEditor = () => {
    if (editorDirty && !confirmDiscard) {
      setConfirmDiscard(true)
      return
    }
    setEditing(null)
    setEditorKind(null)
    setEditorText('')
    setEditorSaved('')
    setEditorError(null)
    setConfirmDiscard(false)
  }

  const saveEditor = async () => {
    if (!editing || !editorDirty) return
    setEditorSaving(true)
    setEditorError(null)
    try {
      const res = await fetch('/api/files/content', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: editing.path, content: editorText }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `save failed (${res.status})`)
      }
      setEditorSaved(editorText)
      setConfirmDiscard(false)
      await load(data?.path)
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : 'Save failed.')
    } finally {
      setEditorSaving(false)
    }
  }

  const openCreate = () => {
    setCreateName('')
    setCreateError(null)
    setCreating('file')
  }

  const openUpload = () => {
    setUploadFiles([])
    setUploadUrl('')
    setUploadName('')
    setUploadError(null)
    setUploadDone([])
    setUploadProgress('')
    setUploading('local')
  }

  const submitLocalUpload = async () => {
    if (!data || uploadFiles.length === 0) return
    setUploadBusy(true)
    setUploadError(null)
    setUploadDone([])
    const done: string[] = []
    const failed: string[] = []
    for (const f of uploadFiles) {
      setUploadProgress(`Uploading ${f.name} (${done.length + 1}/${uploadFiles.length})…`)
      try {
        const res = await fetch(
          `/api/files/upload?dir=${encodeURIComponent(data.path)}&name=${encodeURIComponent(f.name)}`,
          { method: 'POST', body: f },
        )
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(text || `upload failed (${res.status})`)
        }
        done.push(f.name)
      } catch (err) {
        failed.push(`${f.name}: ${err instanceof Error ? err.message : 'failed'}`)
      }
    }
    setUploadDone(done)
    setUploadProgress('')
    setUploadBusy(false)
    await load(data.path)
    if (failed.length > 0) {
      setUploadError(failed.join('\n'))
    } else {
      setUploadFiles([])
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const submitUrlUpload = async () => {
    const url = uploadUrl.trim()
    if (!data || !url) return
    setUploadBusy(true)
    setUploadError(null)
    setUploadDone([])
    setUploadProgress(`Fetching…`)
    try {
      const res = await fetch('/api/files/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dir: data.path,
          url,
          name: uploadName.trim() || undefined,
        }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `fetch failed (${res.status})`)
      }
      const json = (await res.json()) as { path?: string }
      const saved = json.path?.split('/').pop() ?? url
      setUploadDone([saved])
      setUploadUrl('')
      setUploadName('')
      await load(data.path)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Fetch failed.')
    } finally {
      setUploadBusy(false)
      setUploadProgress('')
    }
  }

  const createNameValid = (() => {
    const n = createName.trim()
    if (!n || n === '.' || n === '..') return false
    if (n.includes('/') || n.includes('\\')) return false
    return true
  })()

  const submitCreate = async () => {
    const name = createName.trim()
    if (!creating || !data || !createNameValid) return
    if (
      (data.entries ?? []).some(
        (x) => x.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      setCreateError(`"${name}" already exists here.`)
      return
    }
    const target = `${data.path}/${name}`
    setCreateBusy(true)
    setCreateError(null)
    try {
      if (creating === 'folder') {
        const res = await fetch('/api/files/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: target }),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(text || `cannot create folder (${res.status})`)
        }
        setCreating(null)
        await load(data.path)
      } else {
        const res = await fetch('/api/files/content', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: target, content: '' }),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(text || `cannot create file (${res.status})`)
        }
        setCreating(null)
        await load(data.path)
        await openEditor({
          name,
          path: target,
          is_dir: false,
          size: 0,
          modified: null,
        })
      }
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Create failed.')
    } finally {
      setCreateBusy(false)
    }
  }

  return (
    <section className="page files-page" aria-labelledby="page-title-files">
      <div className="page-head files-head">
        <h1 id="page-title-files" className="sr-only">
          Files
        </h1>
        <div className="row-actions files-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={openCreate}
            disabled={loading || busy || !!error || !data}
            title="Create a file or folder here"
          >
            Create
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={openUpload}
            disabled={loading || busy || !!error || !data}
            title="Upload files or fetch a URL here"
          >
            Upload
          </button>
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

      <div className="files-body">
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
          <ul
            className="file-grid"
            aria-label="Loading host files"
            aria-busy="true"
          >
            {Array.from({ length: 8 }, (_, i) => (
              <li
                key={i}
                className="file-card ports-skeleton"
                aria-hidden="true"
              >
                <div className="file-card-top">
                  <span className="skeleton skeleton-icon" />
                  <span className="skeleton skeleton-title" />
                </div>
                <div className="file-meta">
                  <span className="skeleton skeleton-meta" />
                </div>
              </li>
            ))}
            <span className="sr-only" role="status">
              Loading host files…
            </span>
          </ul>
        ) : visible.length === 0 ? (
          <p>Empty folder.</p>
        ) : (
          <ul className="file-grid" aria-label={`Files in ${data?.path}`}>
            {visible.map((e) => {
              const isMenu = menuOpen === e.path
              const isRenaming = renaming === e.path
              const isConfirm = confirmDelete === e.path
              return (
                <li
                  key={e.path}
                  className="file-card"
                  onClick={() => openEntry(e)}
                  title={e.is_dir ? `Open ${e.path}` : `Edit ${e.path}`}
                >
                  <div
                    className={`file-card-top${e.is_dir ? ' is-dir' : ''}`}
                  >
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
                        onClick={(ev) => {
                          ev.stopPropagation()
                          void load(e.path)
                        }}
                        title={`Open ${e.path}`}
                      >
                        {e.name}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="file-name file-link"
                        onClick={(ev) => {
                          ev.stopPropagation()
                          void openEditor(e)
                        }}
                        title={`Edit ${e.path}`}
                      >
                        {e.name}
                      </button>
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
                            <>
                              <button
                                type="button"
                                role="menuitem"
                                className="file-menu-item"
                                onClick={() => {
                                  setMenuOpen(null)
                                  void openEditor(e)
                                }}
                              >
                                Open in editor
                              </button>
                              <a
                                role="menuitem"
                                className="file-menu-item"
                                href={downloadUrl(e.path)}
                                download={e.name}
                              >
                                Download
                              </a>
                            </>
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
                    <div
                      className="file-inline-actions"
                      onClick={(ev) => ev.stopPropagation()}
                    >
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

      {editing && (
        <div
          className="editor-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Edit ${editing.name}`}
          onClick={() => closeEditor()}
        >
          <div
            className="editor-window"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="editor-head">
              <div className="editor-title">
                <strong>{editing.name}</strong>
                <code title={editing.path}>{editing.path}</code>
              </div>
              {editorDirty && (
                <span className="dirty-dot" title="Unsaved changes">
                  ●
                </span>
              )}
              <button
                type="button"
                className="icon-btn editor-close"
                aria-label="Close editor"
                title="Close editor"
                onClick={() => closeEditor()}
              >
                ×
              </button>
            </div>

            {editorLoading ? (
              <div className="editor-skeleton" aria-busy="true" aria-label="Loading file contents">
                <span className="skeleton skeleton-line" />
                <span className="skeleton skeleton-line" />
                <span className="skeleton skeleton-line short" />
                <span className="skeleton skeleton-line" />
                <span className="skeleton skeleton-line medium" />
                <span className="sr-only" role="status">
                  Loading file…
                </span>
              </div>
            ) : editorError ? (
              <div className="banner-error" role="alert">
                <p>{editorError}</p>
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => void openEditor(editing)}
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => closeEditor()}
                  >
                    Close
                  </button>
                </div>
              </div>
            ) : editorKind === 'text' ? (
              <>
                <textarea
                  className="editor-area"
                  value={editorText}
                  onChange={(ev) => {
                    setEditorText(ev.target.value)
                    setConfirmDiscard(false)
                  }}
                  disabled={editorSaving}
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="off"
                  wrap="off"
                  aria-label={`Contents of ${editing.name}`}
                />
                {editorError && (
                  <div className="banner-error" role="alert">
                    <p>{editorError}</p>
                  </div>
                )}
                <div className="editor-foot">
                  <span className="editor-status">
                    {editorText.split('\n').length} lines ·{' '}
                    {formatSize(new Blob([editorText]).size)}
                    {editorDirty ? ' · unsaved' : ' · saved'}
                    {editorSaving ? ' · saving…' : ''}
                  </span>
                  <div className="row-actions editor-actions">
                    <a
                      className="btn btn-sm"
                      href={downloadUrl(editing.path)}
                      download={editing.name}
                    >
                      Get
                    </a>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={!editorDirty || editorSaving}
                      onClick={() => void saveEditor()}
                    >
                      {editorSaving ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={editorSaving}
                      onClick={() => closeEditor()}
                    >
                      {editorDirty
                        ? confirmDiscard
                          ? 'Discard?'
                          : 'Close'
                        : 'Close'}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="editor-fallback">
                <p>
                  {editorKind === 'binary'
                    ? 'This looks like a binary file, so it cannot be edited here.'
                    : 'This file is too large to edit here (over 1 MB).'}
                </p>
                <div className="row-actions">
                  <a
                    className="btn btn-sm btn-primary"
                    href={downloadUrl(editing.path)}
                    download={editing.name}
                  >
                    Download
                  </a>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => closeEditor()}
                  >
                    Close
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {creating && (
        <div
          className="editor-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Create file or folder"
          onClick={() => {
            if (!createBusy) setCreating(null)
          }}
        >
          <div
            className="editor-window create-window"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="editor-head">
              <div className="editor-title">
                <strong>Create in this folder</strong>
                <code title={data?.path}>{data?.path}</code>
              </div>
              <button
                type="button"
                className="icon-btn editor-close"
                aria-label="Close create dialog"
                title="Close"
                disabled={createBusy}
                onClick={() => setCreating(null)}
              >
                ×
              </button>
            </div>

            <div className="create-tabs" role="tablist" aria-label="What to create">
              {(['file', 'folder'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={creating === t}
                  className={creating === t ? 'create-tab active' : 'create-tab'}
                  disabled={createBusy}
                  onClick={() => {
                    setCreating(t)
                    setCreateError(null)
                    setTimeout(() => createInputRef.current?.select(), 30)
                  }}
                >
                  {t === 'file' ? 'File' : 'Folder'}
                </button>
              ))}
            </div>

            <form
              onSubmit={(ev) => {
                ev.preventDefault()
                void submitCreate()
              }}
            >
              <label className="create-field">
                {creating === 'file' ? 'File name' : 'Folder name'}
                <input
                  ref={createInputRef}
                  className="file-rename-input"
                  type="text"
                  value={createName}
                  onChange={(ev) => {
                    setCreateName(ev.target.value)
                    setCreateError(null)
                  }}
                  placeholder={creating === 'file' ? 'notes.txt' : 'new-folder'}
                  maxLength={255}
                  disabled={createBusy}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </label>
            </form>

            {createError && (
              <div className="banner-error" role="alert">
                <p>{createError}</p>
              </div>
            )}

            <div className="row-actions editor-actions">
              <button
                type="button"
                className="btn btn-sm"
                disabled={createBusy}
                onClick={() => setCreating(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={!createNameValid || createBusy}
                onClick={() => void submitCreate()}
              >
                {createBusy
                  ? 'Creating…'
                  : creating === 'file'
                    ? 'Create file'
                    : 'Create folder'}
              </button>
            </div>
          </div>
        </div>
      )}

      {uploading && (
        <div
          className="editor-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Upload to this folder"
          onClick={() => {
            if (!uploadBusy) setUploading(null)
          }}
        >
          <div
            className="editor-window create-window"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="editor-head">
              <div className="editor-title">
                <strong>Upload to this folder</strong>
                <code title={data?.path}>{data?.path}</code>
              </div>
              <button
                type="button"
                className="icon-btn editor-close"
                aria-label="Close upload dialog"
                title="Close"
                disabled={uploadBusy}
                onClick={() => setUploading(null)}
              >
                ×
              </button>
            </div>

            <div className="create-tabs" role="tablist" aria-label="Upload source">
              {(['local', 'url'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={uploading === t}
                  className={uploading === t ? 'create-tab active' : 'create-tab'}
                  disabled={uploadBusy}
                  onClick={() => {
                    setUploading(t)
                    setUploadError(null)
                    setUploadDone([])
                  }}
                >
                  {t === 'local' ? 'Local' : 'URL'}
                </button>
              ))}
            </div>

            {uploading === 'local' ? (
              <>
                <label className="create-field">
                  Choose files
                  <input
                    ref={fileInputRef}
                    className="upload-input"
                    type="file"
                    multiple
                    disabled={uploadBusy}
                    onChange={(ev) => {
                      setUploadFiles(Array.from(ev.target.files ?? []))
                      setUploadError(null)
                      setUploadDone([])
                    }}
                  />
                </label>
                {uploadFiles.length > 0 && (
                  <ul className="upload-list" aria-label="Selected files">
                    {uploadFiles.map((f) => (
                      <li key={`${f.name}-${f.size}-${f.lastModified}`} className="upload-row">
                        <span className="upload-name" title={f.name}>
                          {f.name}
                        </span>
                        <span className="upload-size">{formatSize(f.size)}</span>
                        <button
                          type="button"
                          className="file-dots"
                          aria-label={`Remove ${f.name}`}
                          title="Remove"
                          disabled={uploadBusy}
                          onClick={() =>
                            setUploadFiles((prev) => prev.filter((x) => x !== f))
                          }
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <form
                className="upload-url-form"
                onSubmit={(ev) => {
                  ev.preventDefault()
                  void submitUrlUpload()
                }}
              >
                <label className="create-field">
                  File URL
                  <input
                    className="file-rename-input"
                    type="url"
                    value={uploadUrl}
                    onChange={(ev) => {
                      setUploadUrl(ev.target.value)
                      setUploadError(null)
                    }}
                    placeholder="https://example.com/file.zip"
                    disabled={uploadBusy}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <label className="create-field">
                  Save as (optional)
                  <input
                    className="file-rename-input"
                    type="text"
                    value={uploadName}
                    onChange={(ev) => {
                      setUploadName(ev.target.value)
                      setUploadError(null)
                    }}
                    placeholder="keeps the URL file name when empty"
                    maxLength={255}
                    disabled={uploadBusy}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              </form>
            )}

            {uploadProgress && <p className="files-sub">{uploadProgress}</p>}

            {uploadDone.length > 0 && (
              <div className="upload-done" role="status">
                <p>Uploaded: {uploadDone.join(', ')}</p>
              </div>
            )}

            {uploadError && (
              <div className="banner-error" role="alert">
                <p>{uploadError}</p>
              </div>
            )}

            <div className="row-actions editor-actions">
              <button
                type="button"
                className="btn btn-sm"
                disabled={uploadBusy}
                onClick={() => setUploading(null)}
              >
                {uploadDone.length > 0 ? 'Done' : 'Cancel'}
              </button>
              {uploading === 'local' ? (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={uploadFiles.length === 0 || uploadBusy}
                  onClick={() => void submitLocalUpload()}
                >
                  {uploadBusy
                    ? 'Uploading…'
                    : `Upload ${uploadFiles.length > 0 ? `${uploadFiles.length} file${uploadFiles.length > 1 ? 's' : ''}` : ''}`}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={!uploadUrl.trim() || uploadBusy}
                  onClick={() => void submitUrlUpload()}
                >
                  {uploadBusy ? 'Fetching…' : 'Fetch file'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
