import { useCallback, useEffect, useRef, useState } from 'react'
import { api, downloadUrl, humanSize } from '../lib/api'
import { useApp } from '../stores/appStore'
import { FileIcon } from './FileIcons'
import { Dropdown } from './ui'
import { transfers } from './transferCenter'
import type { Bookmark, FileEntry } from '@shared'

interface Props {
  hostId: number
  compact?: boolean
  onOpenInEditor?: (path: string) => void
}

const CHUNK = 256 * 1024

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function openTransfers() {
  window.dispatchEvent(new CustomEvent('ks-show-transfers'))
}

export default function FilesPanel({ hostId, onOpenInEditor }: Props) {

  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selAnchor, setSelAnchor] = useState<string | null>(null)
  const [view, setView] = useState<'list' | 'tree'>('list')
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [searchQ, setSearchQ] = useState<string | null>(null)
  const { notify } = useApp()
  const dragDepth = useRef(0)

  const load = useCallback(async (p: string) => {
    try {
      const r = await api<{ path: string; entries: FileEntry[] }>(
        `/api/files/list?hostId=${hostId}&path=${encodeURIComponent(p)}`
      )
      setEntries(r.entries)
      setPath(r.path)
      setSelected(new Set())
    } catch (e: any) {
      notify({ level: 'error', title: 'list failed', body: e.message })
    }
  }, [hostId, notify])

  useEffect(() => {
    load('/')
    api<Bookmark[]>(`/api/bookmarks?hostId=${hostId}`).then(setBookmarks).catch(() => {})
  }, [hostId, load])

  async function mutate(fn: () => Promise<any>, okMsg: string) {
    try {
      await fn()
      await load(path)
      if (okMsg) notify({ level: 'info', title: okMsg })
    } catch (e: any) {
      notify({ level: 'error', title: 'operation failed', body: e.message })
    }
  }

  // ---- multi-select helpers ----
  function toggleSel(p: string) {
    setSelected(s => {
      const n = new Set(s)
      n.has(p) ? n.delete(p) : n.add(p)
      return n
    })
  }
  function rangeSel(entry: FileEntry) {
    if (!selAnchor) return toggleSel(entry.path)
    const ai = entries.findIndex(e => e.path === selAnchor)
    const bi = entries.findIndex(e => e.path === entry.path)
    if (ai < 0 || bi < 0) return toggleSel(entry.path)
    const [a, b] = ai < bi ? [ai, bi] : [bi, ai]
    setSelected(new Set(entries.slice(a, b + 1).map(e => e.path)))
  }

  const selectedPaths = [...selected]
  const totalSelSize = entries
    .filter(e => selected.has(e.path))
    .reduce((n, e) => n + (e.isDir ? 0 : e.size), 0)

  // ---- upload (chunked, resumable over WS with checksums) ----
  async function uploadFiles(files: FileList | File[], dir = path) {
    for (const file of Array.from(files)) {
      await uploadOne(file, dir).catch(e =>
        notify({ level: 'error', title: `upload ${file.name} failed`, body: String(e?.message ?? e) })
      )
    }
    load(path)
  }

  async function uploadOne(file: File, dir: string): Promise<void> {
    const transferId = `up-${Math.random().toString(36).slice(2, 10)}`
    transfers.upsert({ id: transferId, name: file.name, pct: 0, status: 'active' })
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(
      `${proto}://${location.host}/api/files/ws?host=${hostId}`
    )
    transfers.upsert({ id: transferId, name: file.name, pct: 0, status: 'active',
      cancel: () => {
        try { ws.send(JSON.stringify({ type: 'transfer.abort', payload: { transferId } })) } catch {}
        ws.close()
        transfers.upsert({ id: transferId, name: file.name, pct: 0, status: 'canceled' })
      } })
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res()
      ws.onerror = () => rej(new Error('ws connect failed'))
      setTimeout(() => rej(new Error('ws timeout')), 8000)
    })

    let resumeFrom = 0
    const acks = new Map<number, boolean>()
    const waitAck = (index: number) =>
      new Promise<void>((res, rej) => {
        const t0 = Date.now()
        const iv = setInterval(() => {
          if (acks.get(index)) {
            clearInterval(iv); res()
          } else if (Date.now() - t0 > 30000) {
            clearInterval(iv); rej(new Error('ack timeout'))
          }
        }, 40)
      })

    ws.onmessage = ev => {
      const env = JSON.parse(ev.data)
      if (env.type === 'transfer.ready') resumeFrom = env.payload.resumeFromChunk ?? 0
      if (env.type === 'transfer.ack') acks.set(env.payload.index, !!env.payload.ok || env.payload.error == null)
      if (env.type === 'transfer.error') {
        transfers.upsert({ id: transferId, name: file.name, pct: 0, status: 'error', note: env.payload.error })
        notify({ level: 'error', title: file.name, body: env.payload.error })
      }
    }

    const send = (obj: unknown) => ws.send(JSON.stringify(obj))
    send({
      type: 'transfer.begin',
      payload: { transferId, dir, name: file.name, size: file.size },
    })
    await new Promise(r => setTimeout(r, 150)) // let transfer.ready arrive
    void resumeFrom

    const total = Math.ceil(file.size / CHUNK) || 1
    for (let i = 0; i < total; i++) {
      const blob = file.slice(i * CHUNK, (i + 1) * CHUNK)
      const buf = await blob.arrayBuffer()
      const checksum = await sha256Hex(buf)
      send({
        type: 'transfer.chunk',
        payload: {
          transferId, index: i,
          dataBase64: btoa(String.fromCharCode(...new Uint8Array(buf))),
          checksum, final: i === total - 1,
        },
      })
      await waitAck(i)
      const pct = Math.round(((i + 1) / total) * 100)
      transfers.upsert({
        id: transferId, name: file.name, pct,
        status: 'active',
        note: `${humanSize((i + 1) * CHUNK)} / ${humanSize(file.size)}${resumeFrom ? ' (resumed)' : ''}`,
      })
    }
    transfers.upsert({ id: transferId, name: file.name, pct: 100, status: 'done' })
    ws.close()
  }

  // ---- URL upload ----
  async function urlUpload(url: string) {
    if (!url.startsWith('http')) return
    await mutate(async () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${location.host}/api/files/ws?host=${hostId}`)
      await new Promise(res => { ws.onopen = res })
      ws.send(JSON.stringify({ type: 'url.upload', payload: { url, dir: path } }))
      ws.onmessage = ev => {
        const env = JSON.parse(ev.data)
        if (env.type === 'transfer.done') { load(path); ws.close() }
        if (env.type === 'transfer.error') {
          notify({ level: 'error', title: 'url fetch failed', body: env.payload.error })
          ws.close()
        }
      }
    }, '')
  }

  async function deleteSelected() {
    if (selectedPaths.length === 0) return
    if (!confirm(`Delete ${selectedPaths.length} item(s)?\n${selectedPaths.join('\n').slice(0, 500)}`)) return
    await mutate(() =>
      api('/api/files/delete', { method: 'POST', body: { hostId, paths: selectedPaths } }),
      `deleted ${selectedPaths.length}`)
  }

  function crumbs(): Array<[string, string]> {
    const parts = path.split('/').filter(Boolean)
    const out: Array<[string, string]> = [['/', '/']]
    let cur = ''
    for (const p of parts) {
      cur += '/' + p
      out.push([p, cur])
    }
    return out
  }

  const filtered = searchQ
    ? entries.filter(e => e.name.toLowerCase().includes(searchQ.toLowerCase()))
    : entries

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="files-toolbar">
        <Dropdown button={<button>⬆ Upload ▾</button>} items={[
          { label: '① From local…', onClick: () => {
              const inp = document.createElement('input')
              inp.type = 'file'; inp.multiple = true
              inp.onchange = () => inp.files && uploadFiles(inp.files)
              inp.click()
            } },
          { label: '② From URL…', onClick: () => {
              const url = prompt('Download URL (http/https only):')
              if (url) urlUpload(url)
            } },
        ]} />
        <Dropdown button={<button>＋ Create ▾</button>} items={[
          { label: '① New folder', onClick: () => {
              const name = prompt('folder name:')
              if (name) mutate(() =>
                api('/api/files/mkdir', { method: 'POST', body: { hostId, path: join(path, name) } }), '')
            } },
          { label: '② New file', onClick: () => {
              const name = prompt('file name:')
              if (name) mutate(async () => {
                const full = join(path, name)
                await api('/api/editor/save', { method: 'POST', body: { hostId, path: full, content: '' } })
                onOpenInEditor?.(full)
              }, 'created')
            } },
        ]} />
        <Dropdown button={<button>☆ Bookmarks ▾</button>} items={[
          ...bookmarks.map(b => ({
            label: `${b.kind === 'file' ? '📄' : '📁'} ${b.label}`,
            onClick: () => b.kind === 'path'
              ? load(b.path)
              : onOpenInEditor?.(b.path),
          })),
          ...(bookmarks.length ? ['sep' as const] : []),
          { label: '📌 pin current path', onClick: () =>
              mutate(() => api('/api/bookmarks', { method: 'POST', body: { hostId, path, kind: 'path' } }), 'pinned') },
          ...(bookmarks.length ? [{ label: '🗑 remove all bookmarks', danger: true, onClick: () =>
            Promise.all(bookmarks.map(b =>
              api(`/api/bookmarks/${b.id}`, { method: 'DELETE' }))).then(() => setBookmarks([])) }] : []),
        ]} />
        <button className="ghost" style={{ marginLeft: 'auto' }}
          title={view === 'list' ? 'switch to tree view' : 'switch to list view'}
          onClick={() => setView(v => v === 'list' ? 'tree' : 'list')}>
          {view === 'list' ? '☰' : '🌲'}
        </button>
      </div>

      <div className="crumbs">
        {crumbs().map(([name, p], i) => (
          <span key={p} onClick={() => load(p)}>
            {i > 0 && ' / '}{name === '/' ? 'root' : name}
          </span>
        ))}
        <input placeholder="filter…" value={searchQ ?? ''}
          onChange={e => setSearchQ(e.target.value || null)}
          style={{ marginLeft: 12, width: 110, height: 22 }} />
      </div>

      <div className="file-list"
        onDragOver={e => { e.preventDefault(); dragDepth.current++ }}
        onDragLeave={() => dragDepth.current--}
        onDrop={e => {
          e.preventDefault()
          dragDepth.current = 0
          if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files)
        }}>
        {filtered.map(en => (
          <FileRow key={en.path}
            entry={en}
            selected={selected.has(en.path)}
            onMoveInto={(src, destDir) =>
              mutate(() => api('/api/files/move', {
                method: 'POST', body: { hostId, from: [src], destDir },
              }), 'moved')}
            onClick={(ev) => {
              if (en.isDir && !ev.ctrlKey && !ev.shiftKey) { load(en.path); return }
              if (ev.shiftKey) rangeSel(en)
              else toggleSel(en.path)
              setSelAnchor(en.path)
            }}
            onOpen={() => en.isDir ? load(en.path) : onOpenInEditor?.(en.path)}
            onMenu={action => {
              switch (action[0]) {
                case 'rename': {
                  const to = prompt('new name', en.name)
                  if (to && to !== en.name)
                    mutate(() => api('/api/files/rename', {
                      method: 'POST',
                      body: { hostId, from: en.path, to: join(path, to) },
                    }), 'renamed')
                  break
                }
                case 'move': {
                  const dest = prompt('move to directory:', path)
                  if (dest) mutate(() => api('/api/files/move', {
                    method: 'POST', body: { hostId, from: [en.path], destDir: dest },
                  }), 'moved')
                  break
                }
                case 'copy': {
                  const dest = prompt('copy to directory:', path)
                  if (dest) mutate(() => api('/api/files/copy', {
                    method: 'POST', body: { hostId, from: [en.path], destDir: dest },
                  }), 'copied')
                  break
                }
                case 'delete':
                  setSelected(new Set([en.path]))
                  setTimeout(deleteSelected, 30)
                  break
                case 'download': {
                  const a = document.createElement('a')
                  a.href = downloadUrl(hostId, [en.path])
                  a.click()
                  break
                }
                case 'perm': {
                  const mode = prompt('chmod octal (e.g. 644)', en.mode.replace(/^0/, ''))
                  if (mode) mutate(() => api('/api/files/chmod', {
                    method: 'POST', body: { hostId, path: en.path, mode },
                  }), 'permissions changed')
                  break
                }
                case 'editor':
                  onOpenInEditor?.(en.path)
                  break
                case 'bookmark':
                  mutate(() => api('/api/bookmarks', {
                    method: 'POST',
                    body: { hostId, path: en.path, kind: en.isDir ? 'path' : 'file', label: en.name },
                  }).then(() => api<Bookmark[]>(`/api/bookmarks?hostId=${hostId}`).then(setBookmarks)), 'pinned')
                  break
              }
            }}
          />
        ))}
        {filtered.length === 0 && (
          <div className="muted small" style={{ padding: 14 }}>empty — drop files here to upload</div>
        )}
      </div>

      {selectedPaths.length > 0 && (
        <div className="fab">
          <span className="small muted">{selectedPaths.length} sel · {humanSize(totalSelSize)}</span>
          <button className="danger small" onClick={deleteSelected}>Delete</button>
          <button className="small" onClick={() => {
            const a = document.createElement('a')
            a.href = downloadUrl(hostId, selectedPaths)
            a.download = 'download.zip'
            a.click()
          }}>⬇ zip</button>
          <button className="small" onClick={() => {
            const dest = prompt(`move ${selectedPaths.length} items to:`)
            if (dest) mutate(() => api('/api/files/move', {
              method: 'POST', body: { hostId, from: selectedPaths, destDir: dest },
            }), 'moved')
          }}>Move</button>
          <button className="small" onClick={() => {
            const dest = prompt(`copy ${selectedPaths.length} items to:`)
            if (dest) mutate(() => api('/api/files/copy', {
              method: 'POST', body: { hostId, from: selectedPaths, destDir: dest },
            }), 'copied')
          }}>Copy</button>
          <button className="ghost small" onClick={() => setSelected(new Set())}>✕</button>
        </div>
      )}
    </div>
  )
}

function join(dir: string, name: string): string {
  return (dir === '/' ? '' : dir) + '/' + name
}

function FileRow(props: {
  entry: FileEntry
  selected: boolean
  onClick: (ev: React.MouseEvent) => void
  onOpen: () => void
  onMenu: (a: [string]) => void
  onMoveInto?: (srcPath: string, destDir: string) => void
}) {
  const e = props.entry
  return (
    <div className={`file-row ${props.selected ? 'sel' : ''}`}
      draggable
      onDragStart={ev => ev.dataTransfer.setData('text/ks-path', e.path)}
      onDragOver={ev => { if (e.isDir) ev.preventDefault() }}
      onDrop={ev => {
        if (!e.isDir) return
        const src = ev.dataTransfer.getData('text/ks-path')
        const files = ev.dataTransfer.files
        if (files.length) return // handled by outer drop → upload
        if (src && src !== e.path && props.onMoveInto) {
          ev.preventDefault()
          ev.stopPropagation()
          props.onMoveInto(src, e.path)
        }
      }}
      onClick={props.onClick}
      onDoubleClick={props.onOpen}>
      <input type="checkbox" checked={props.selected}
        onClick={ev => ev.stopPropagation()}
        onChange={() => props.onClick({ ctrlKey: true } as React.MouseEvent)} />
      <FileIcon isDir={e.isDir} itemType={e.itemType} />
      <span className="file-name" title={`${e.perms} ${e.owner}:${e.group}`}>
        {e.name}
        {e.isSymlink && <span className="muted"> → {e.symlinkTarget}</span>}
      </span>
      <span className="file-perm">{e.mode}</span>
      <span className="file-size">
        {e.isDir ? '—' : humanSize(e.size)}
      </span>
      <Dropdown align="right"
        button={<button className="ghost icon-btn" style={{ width: 20, height: 20 }}>⋮</button>}
        items={[
          ...(e.isDir ? [] : [{ label: 'Open in editor', onClick: () => props.onMenu(['editor']) }]),
          { label: 'Rename…', onClick: () => props.onMenu(['rename']) },
          { label: 'Move…', onClick: () => props.onMenu(['move']) },
          { label: 'Copy…', onClick: () => props.onMenu(['copy']) },
          'sep',
          { label: 'Download', onClick: () => props.onMenu(['download']) },
          { label: 'Permissions…', onClick: () => props.onMenu(['perm']) },
          { label: 'Pin bookmark', onClick: () => props.onMenu(['bookmark']) },
          'sep',
          { label: 'Delete…', danger: true, onClick: () => props.onMenu(['delete']) },
        ]} />
    </div>
  )
}
