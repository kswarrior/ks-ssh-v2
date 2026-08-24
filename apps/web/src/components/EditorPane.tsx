import { useCallback, useEffect, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { marked } from 'marked'
import { api } from '../lib/api'
import { useApp } from '../stores/appStore'

interface EditorTab {
  id: string
  hostId: number
  path: string
  name: string
  language: string
  content: string
  original?: string // for diff-before-save
  mtimeMs: number
  dirty: boolean
  readOnly: boolean
  mdPreview: boolean
  itemType?: 'img' | 'pdf' | 'mp4' | 'mp3' // media preview mode
  mediaUrl?: string
}

function langOf(name: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  const map: Record<string, string> = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', py: 'python', go: 'go', json: 'json',
    yml: 'yaml', yaml: 'yaml', html: 'html', htm: 'html', css: 'css',
    scss: 'scss', sh: 'shell', bash: 'shell', zsh: 'shell', env: 'shell',
    md: 'markdown', sql: 'sql', rs: 'rust', java: 'java', c: 'c', h: 'c',
    cpp: 'cpp', cc: 'cpp', php: 'php', rb: 'ruby', xml: 'xml', svg: 'xml',
    toml: 'ini', ini: 'ini', conf: 'ini', cfg: 'ini', service: 'ini',
  }
  return map[ext] ?? 'plaintext'
}

export function useEditorBridge() {
  const openRef = useRef<((path: string) => void) | null>(null)
  const setOpen = useCallback((fn: (p: string) => void) => { openRef.current = fn }, [])
  return { openRef, setOpen }
}

export default function EditorPane({
  hostId,
  bridge,
}: {
  hostId: number
  bridge?: { openRef: React.MutableRefObject<((p: string) => void) | null> }
}) {
  const [tabs, setTabs] = useState<EditorTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [showDiff, setShowDiff] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const [recents, setRecents] = useState<string[]>([])
  const { notify, settings } = useApp()
  const pollRef = useRef<number | undefined>(undefined)

  const open = useCallback(async (hostId: number, path: string) => {
    try {
      const ext = (path.split('.').pop() ?? '').toLowerCase()
      const media = (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'] as const).includes(ext as any)
        ? 'img' as const
        : ext === 'pdf' ? 'pdf' as const
        : (['mp4', 'webm', 'mkv'] as const).includes(ext as any) ? 'mp4' as const
        : (['mp3', 'wav', 'ogg', 'flac'] as const).includes(ext as any) ? 'mp3' as const
        : undefined

      if (media) {
        // media opens as a preview tab streaming over the download endpoint
        const tab: EditorTab = {
          id: `ed-${Math.random().toString(36).slice(2, 9)}`,
          hostId, path,
          name: path.split('/').pop() ?? path,
          language: 'plaintext',
          content: '',
          mtimeMs: 0, dirty: false, readOnly: true, mdPreview: false,
          itemType: media, mediaUrl: `/api/files/download?hostId=${hostId}&path=${encodeURIComponent(path)}`,
        }
        setTabs(ts => {
          const ex = ts.find(t => t.hostId === hostId && t.path === path)
          if (ex) { setActiveId(ex.id); return ts }
          setActiveId(tab.id)
          return [...ts, tab]
        })
        return
      }
      const r = await api<any>(`/api/editor/open?hostId=${hostId}&path=${encodeURIComponent(path)}`)
      setTabs(ts => {
        const existing = ts.find(t => t.hostId === hostId && t.path === path)
        if (existing) {
          setActiveId(existing.id)
          return ts
        }
        const tab: EditorTab = {
          id: `ed-${Math.random().toString(36).slice(2, 9)}`,
          hostId, path,
          name: path.split('/').pop() ?? path,
          language: r.language,
          content: r.content,
          mtimeMs: r.mtimeMs,
          dirty: false,
          readOnly: r.readOnly,
          mdPreview: r.language === 'markdown',
        }
        setActiveId(tab.id)
        return [...ts, tab]
      })
      api('/api/editor/touch-recent', { method: 'POST', body: { hostId, path } }).catch(() => {})
    } catch (e: any) {
      notify({ level: 'error', title: `open ${path}`, body: e.message })
    }
  }, [notify])

  useEffect(() => {
    if (bridge?.openRef) bridge.openRef.current = p => open(hostId, p)
    api<string[]>(`/api/history?hostId=${hostId}`).catch(() => [])
      .then(h => setRecents((h as unknown as string[]) ?? []))
  }, [bridge, hostId, open])

  const active = tabs.find(t => t.id === activeId) ?? null

  async function save(tab: EditorTab, force = false) {
    try {
      if (!force && tab.original !== undefined && tab.content !== tab.original) {
        setShowDiff(true)
        return
      }
      const r = await api<any>('/api/editor/save', {
        method: 'POST',
        body: {
          hostId: tab.hostId, path: tab.path, content: tab.content,
          expectedMtimeMs: tab.mtimeMs,
        },
      })
      setTabs(ts => ts.map(t =>
        t.id === tab.id ? { ...t, dirty: false, mtimeMs: r.mtimeMs ?? t.mtimeMs } : t))
      notify({ level: 'info', title: `saved ${tab.name}` })
    } catch (e: any) {
      if (e?.status === 409) {
        notify({ level: 'warn', title: 'file changed remotely — reloading' })
        open(tab.hostId, tab.path).then(() => setTabs(ts => ts.filter(t => t.id !== tab.id)))
      } else {
        notify({ level: 'error', title: `save ${tab.name}`, body: e.message })
      }
    }
  }

  // auto-reload when changed remotely (SFTP stat polling)
  useEffect(() => {
    clearInterval(pollRef.current)
    pollRef.current = window.setInterval(async () => {
      for (const t of tabs) {
        if (t.dirty || t.readOnly) continue
        try {
          const st = await api<any>(
            `/api/editor/stat-poll?hostId=${t.hostId}&path=${encodeURIComponent(t.path)}`)
          if (st.exists && st.mtimeMs > t.mtimeMs) {
            notify({ level: 'info', title: `${t.name} reloaded`, body: 'changed remotely' })
            setTabs(ts => ts.map(x => x.id === t.id ? { ...x, mtimeMs: st.mtimeMs } : x))
            open(t.hostId, t.path).then(() =>
              setTabs(ts => ts.filter(x => !(x.hostId === t.hostId && x.path === t.path && x.id !== t.id))))
          }
        } catch { /* offline */ }
      }
    }, 5000)
    return () => clearInterval(pollRef.current)
  }, [tabs, open, notify])

  // Ctrl+P quick-open across recents
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault()
        setQuickOpen(q => !q)
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        if (active) save(active)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (tabs.length === 0) {
    return (
      <div style={{ padding: 16 }} className="muted">
        <div className="form-grid">
          <div>Editor. Click a file in the file panel to open it.</div>
          {recents.length > 0 && (
            <>
              <div className="small">Recent files:</div>
              {recents.slice(0, 8).map(p => (
                <button key={p} className="ghost mono small"
                  onClick={() => open(hostId, p)}>{p}</button>
              ))}
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="editor-wrap">
      <div className="editor-bar" style={{ overflowX: 'auto' }}>
        {tabs.map(t => (
          <span key={t.id}
            className={`tab ${t.id === activeId ? 'active' : ''}`}
            style={{ fontSize: 11 }}
            onClick={() => setActiveId(t.id)}>
            {t.dirty ? '● ' : ''}{t.name}
            <span className="x" onClick={ev => {
              ev.stopPropagation()
              setTabs(ts => ts.filter(x => x.id !== t.id))
              if (activeId === t.id) setActiveId(null)
            }}>✕</span>
          </span>
        ))}
        {active && active.readOnly && <span className="badge err">read-only &gt;2MB</span>}
        <span style={{ flex: 1 }} />
        {active?.language === 'markdown' && (
          <button className="ghost small"
            onClick={() => setTabs(ts => ts.map(t =>
              t.id === active!.id ? { ...t, mdPreview: !t.mdPreview } : t))}>
            {active.mdPreview ? 'Edit only' : 'Edit / Preview'}
          </button>
        )}
        <button className="ghost small" disabled={!active?.dirty}
          onClick={() => showDiff ? setShowDiff(false) : save(active!)}>
          {showDiff ? 'hide diff' : 'save…'}
        </button>
        <button className="ghost small" disabled={!active}
          onClick={() => save(active!, true)}>force save</button>
        <button className="ghost small" disabled={!active}
          onClick={() => api<any[]>('/api/editor/backups?' +
            `hostId=${active!.hostId}&path=${encodeURIComponent(active!.path)}`)
            .then(bs => {
              if (!bs.length) return notify({ level: 'info', title: 'no backups yet' })
              const pick = prompt('restore backup id:\n' +
                bs.map(b => `${b.id} · ${b.createdAt} · ${b.size}B`).join('\n'))
              if (pick) api('/api/editor/restore-backup', {
                method: 'POST', body: { backupId: Number(pick), hostId: active!.hostId },
              }).then(() => open(active!.hostId, active!.path))
                .catch(e => notify({ level: 'error', title: 'restore failed', body: e.message }))
            })}>backups</button>
        <span className="mono">{active?.language}</span>
        <span className="mono muted">{active?.path}</span>
      </div>

      {quickOpen && (
        <div className="palette" style={{ top: 80 }}>
          <input autoFocus placeholder="open file by path…" onKeyDown={e => {
            if (e.key === 'Enter') {
              open(hostId, (e.target as HTMLInputElement).value)
              setQuickOpen(false)
            }
            if (e.key === 'Escape') setQuickOpen(false)
          }} />
          <div className="palette-list">
            {recents.slice(0, 12).map(p => (
              <div key={p} className="palette-item mono" onClick={() => {
                open(hostId, p); setQuickOpen(false)
              }}>{p}</div>
            ))}
          </div>
        </div>
      )}

      {active && showDiff && (
        <div className="modal-bd" style={{ maxHeight: 200 }}>
          <div className="prewrap">{unifiedSummary(active)}</div>
        </div>
      )}

      {active && (
        <div className="editor-bar" style={{ borderTop: 'none', borderBottom: '1px solid var(--border)' }}>
          {/* breadcrumbs (plan §2.4) */}
          <span className="crumbs" style={{ border: 'none', padding: 0 }}>
            {active.path.split('/').filter(Boolean).map((seg, i, arr) => (
              <span key={i} className={i === arr.length - 1 ? '' : 'muted'}>
                {i > 0 && ' / '}{seg}
              </span>
            ))}
          </span>
        </div>
      )}

      {(active?.itemType === 'img' || active?.mediaUrl) && <MediaPreview tab={active} />}

      {active && !active.itemType && (
        <div className={active.mdPreview ? 'md-split' : ''} style={{ flex: 1, minHeight: 0 }}>
          <MonacoWrap tab={active} onChange={c =>
            setTabs(ts => ts.map(t => t.id === active.id ? { ...t, content: c, dirty: true } : t))} />
          {active.mdPreview && (
            <div className="md-preview markdown-body"
              dangerouslySetInnerHTML={{ __html: marked.parse(active.content) as string }} />
          )}
        </div>
      )}
      {settings.autoSaveEditor === 'true' && active?.dirty && (
        <AutoSave onFire={() => active && save(active, true)} />
      )}
    </div>
  )
}

function unifiedSummary(t: EditorTab): string {
  const a = (t.original ?? '').split('\n')
  const b = t.content.split('\n')
  const out: string[] = []
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      if (a[i] !== undefined) out.push('- ' + a[i])
      if (b[i] !== undefined) out.push('+ ' + b[i])
    } else out.push('  ' + (a[i] ?? '').slice(0, 120))
  }
  return out.join('\n').slice(0, 8000)
}

const MonacoWrap = ({ tab, onChange, formatOnSave }: {
  tab: EditorTab
  onChange: (v: string) => void
  formatOnSave?: boolean
}) => {
  const edRef = useRef<any>(null)
  const onMount: OnMount = ed => {
    edRef.current = ed
    ed.focus()
    // format-on-save: bind Shift+Alt+F explicitly; Ctrl+S handler formats first
    ed.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, () => {
      ed.getAction('editor.action.formatDocument')?.run()
    })
  }
  useEffect(() => {
    if (!formatOnSave) return
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        setTimeout(() => edRef.current?.getAction('editor.action.formatDocument')?.run(), 0)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [formatOnSave])
  return (
    <div style={{ flex: 1, minHeight: 300 }}>
      <Editor
        height="100%"
        language={tab.language}
        value={tab.content}
        theme="vs-dark"
        onMount={onMount}
        onChange={v => onChange(v ?? '')}
        options={{
          readOnly: tab.readOnly,
          minimap: { enabled: true },
          fontSize: Number(useApp.getState().settings.fontSize) || 14,
          automaticLayout: true,
          wordWrap: 'on',
          formatOnPaste: true,
        }}
      />
    </div>
  )
}

function MediaPreview({ tab }: { tab: EditorTab }) {
  if (!tab.mediaUrl) return null
  switch (tab.itemType) {
    case 'img':
      return <div style={{ overflow: 'auto', padding: 12, textAlign: 'center' }}>
        <img src={tab.mediaUrl} alt={tab.name} style={{ maxWidth: '100%' }} /></div>
    case 'pdf':
      return <iframe title={tab.name} src={tab.mediaUrl} style={{ flex: 1, border: 'none' }} />
    case 'mp4':
      return <video controls src={tab.mediaUrl} style={{ width: '100%', maxHeight: '100%' }} />
    case 'mp3':
      return <audio controls src={tab.mediaUrl} style={{ width: '100%', margin: 20 }} />
    default:
      return null
  }
}

const AutoSave = ({ onFire }: { onFire: () => void }) => {
  useEffect(() => {
    const t = setTimeout(onFire, 1500)
    return () => clearTimeout(t)
  })
  return null
}
