import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useApp } from '../stores/appStore'
import { Modal, Confirm } from './ui'

// ---- Ops panels: git / docker / services / cron / logs ----

type OpTab = 'git' | 'docker' | 'services' | 'cron' | 'logs'

export default function OpsPanels({ hostId }: { hostId: number }) {
  const [tab, setTab] = useState<OpTab>('git')
  const [dir, setDir] = useState('')
  const { notify } = useApp()

  return (
    <div style={{ padding: 6 }}>
      <div className="row small" style={{ gap: 4, marginBottom: 8 }}>
        {(['git', 'docker', 'services', 'cron', 'logs'] as const).map(t => (
          <button key={t} className={tab === t ? 'primary' : 'ghost'}
            style={{ fontSize: 11 }} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      {(tab === 'git' || tab === 'logs') && (
        <div className="row small" style={{ marginBottom: 6 }}>
          <span className="muted">{tab === 'git' ? 'repo dir:' : 'file path:'}</span>
          <input style={{ flex: 1 }} value={dir} placeholder="/srv/app"
            onChange={e => setDir(e.target.value)} />
        </div>
      )}
      {tab === 'git' && <GitPanel hostId={hostId} dir={dir} />}
      {tab === 'docker' && <DockerPanel hostId={hostId} />}
      {tab === 'services' && <ServicesPanel hostId={hostId} />}
      {tab === 'cron' && <CronPanel hostId={hostId} />}
      {tab === 'logs' && dir && <LogViewer hostId={hostId} path={dir} />}
    </div>
  )
}

function GitPanel({ hostId, dir }: { hostId: number; dir: string }) {
  const [st, setSt] = useState<any>(null)
  const [log, setLog] = useState<any[]>([])
  const [branches, setBranches] = useState<string[]>([])
  const [msg, setMsg] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const { notify } = useApp()

  const load = useCallback(async () => {
    if (!dir) return
    try {
      const s = await api<any>('/api/git/status', { method: 'POST', body: { hostId, dir } })
      setSt(s)
      setLog(await api<any[]>(`/api/git/log?hostId=${hostId}&dir=${encodeURIComponent(dir)}`))
      setBranches(await api<string[]>(`/api/git/branches?hostId=${hostId}&dir=${encodeURIComponent(dir)}`))
    } catch (e: any) {
      notify({ level: 'error', title: 'git status', body: e.message })
    }
  }, [hostId, dir, notify])

  useEffect(() => { load() }, [load])

  async function action(kind: string, extra?: object) {
    try {
      const r = await api<any>(`/api/git/${kind}`, {
        method: 'POST', body: { hostId, dir, ...extra },
      })
      if (r?.output) notify({ level: 'info', title: `git ${kind}`, body: r.output.slice(0, 200) })
      load()
    } catch (e: any) {
      notify({ level: 'error', title: `git ${kind}`, body: e.message })
    }
  }

  return (
    <div>
      {!dir && <div className="muted small">enter a repo directory above</div>}
      {st && (
        <>
          <div className="row small" style={{ marginBottom: 6 }}>
            <b>{st.branch}</b>
            <span className="muted">↑{st.ahead} ↓{st.behind}</span>
            <select defaultValue="" onChange={e => e.target.value && action('switch', { branch: e.target.value })}
              style={{ marginLeft: 'auto' }}>
              <option value="">switch branch…</option>
              {branches.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div style={{ maxHeight: 160, overflowY: 'auto', marginBottom: 8 }}>
            {st.files.map((f: any) => (
              <label key={f.path + f.x} className="file-row">
                <input type="checkbox"
                  checked={sel.has(f.path)}
                  onChange={() => setSel(s => {
                    const n = new Set(s)
                    n.has(f.path) ? n.delete(f.path) : n.add(f.path)
                    return n
                  })} />
                <span className="badge">{f.x}{f.y}</span>
                <span className="file-name mono">{f.path}</span>
              </label>
            ))}
            {st.clean && <div className="muted small">working tree clean ✓</div>}
          </div>
          <div className="row" style={{ marginBottom: 8 }}>
            <button className="small" disabled={!sel.size}
              onClick={() => action('stage', { paths: [...sel] }).then(() => setSel(new Set()))}>Stage</button>
            <button className="small" disabled={!sel.size}
              onClick={() => action('unstage', { paths: [...sel] }).then(() => setSel(new Set()))}>Unstage</button>
            <input placeholder="commit message…" style={{ flex: 1 }}
              value={msg} onChange={e => setMsg(e.target.value)} />
            <button className="primary small" disabled={!msg.trim()}
              onClick={() => { action('commit', { message: msg }); setMsg('') }}>Commit</button>
            <button className="small" onClick={() => action('pull')}>⬇ pull</button>
            <button className="small" onClick={() => action('push')}>⬆ push</button>
          </div>
          <table className="data">
            <thead><tr><th>hash</th><th>author</th><th>date</th><th>subject</th></tr></thead>
            <tbody>
              {log.map((l, i) => (
                <tr key={i}><td className="mono">{l.hash}</td><td>{l.author}</td>
                  <td>{String(l.date).slice(0, 10)}</td><td className="prewrap">{l.subject}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

function DockerPanel({ hostId }: { hostId: number }) {
  const [cs, setCs] = useState<any[]>([])
  const [err, setErr] = useState('')
  const [logC, setLogC] = useState<string | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const { notify } = useApp()

  async function load() {
    try {
      setCs(await api<any[]>(`/api/docker/ps?hostId=${hostId}`))
      setErr('')
    } catch (e: any) {
      setErr(e.message)
    }
  }
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t) }, []) // eslint-disable-line

  function openLogs(id: string) {
    setLogC(id); setLines([])
    wsRef.current?.close()
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/api/docker/logs/ws?host=${hostId}&container=${encodeURIComponent(id)}`)
    wsRef.current = ws
    ws.onmessage = ev => {
      const env = JSON.parse(ev.data)
      if (env.type === 'log.line') setLines(ls => [...ls.slice(-400), env.payload.line])
    }
  }

  async function act(id: string, action: string) {
    try {
      await api('/api/docker/action', { method: 'POST', body: { hostId, id, action } })
      load()
    } catch (e: any) {
      notify({ level: 'error', title: `docker ${action}`, body: e.message })
    }
  }

  return (
    <div>
      {err && <div className="err-text">{err}</div>}
      <table className="data">
        <thead><tr><th>name</th><th>image</th><th>state</th><th>status</th><th /></tr></thead>
        <tbody>
          {cs.map(c => (
            <tr key={c.id}>
              <td>{c.names}</td><td className="prewrap">{c.image}</td>
              <td className={c.state === 'running' ? 'dot-ok' : ''}>{c.state}</td>
              <td className="small">{c.status}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="small" onClick={() => act(c.id, 'start')}>▶</button>{' '}
                <button className="small" onClick={() => act(c.id, 'stop')}>■</button>{' '}
                <button className="small" onClick={() => act(c.id, 'restart')}>↻</button>{' '}
                <button className="small" onClick={() => openLogs(c.id)}>logs</button>{' '}
                <ExecButton hostId={hostId} id={c.id} />
              </td>
            </tr>
          ))}
          {cs.length === 0 && !err && <tr><td colSpan={5} className="muted">no containers</td></tr>}
        </tbody>
      </table>
      {logC && (
        <Modal title={`logs ${logC.slice(0, 12)}`} onClose={() => { setLogC(null); wsRef.current?.close() }}>
          <div className="prewrap scroll-y" style={{ maxHeight: 380 }}>
            {lines.join('\n')}
          </div>
        </Modal>
      )}
    </div>
  )
}

function ExecButton({ hostId, id }: { hostId: number; id: string }) {
  const [open, setOpen] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const termRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (!open) return
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/api/docker/exec/ws?host=${hostId}&container=${encodeURIComponent(id)}`)
    let started = false
    ws.onopen = () => {
      started = true
      // trigger shell by sending a newline after attach
      setTimeout(() => ws.send(JSON.stringify({ type: 'exec.in', payload: { data: '\n' } })), 500)
    }
    ws.onmessage = ev => {
      const env = JSON.parse(ev.data)
      if (env.type === 'exec.out') setLines(ls => [...ls.slice(-500), env.payload.data])
    }
    const onKey = (e: KeyboardEvent) => {
      if (!started) return
      if (e.key === 'Enter') ws.send(JSON.stringify({ type: 'exec.in', payload: { data: '\n' } }))
      else if (e.key === 'Backspace') ws.send(JSON.stringify({ type: 'exec.in', payload: { data: '\x7f' } }))
      else if (e.key.length === 1) ws.send(JSON.stringify({ type: 'exec.in', payload: { data: e.key } }))
    }
    window.addEventListener('keydown', onKey)
    return () => { ws.close(); window.removeEventListener('keydown', onKey) }
  }, [open, hostId, id])

  return (
    <>
      <button className="small" onClick={() => setOpen(true)}>exec</button>
      {open && (
        <Modal title={`exec ${id.slice(0, 12)}`} onClose={() => setOpen(false)} width={700}>
          <pre ref={termRef} tabIndex={0}
            className="prewrap scroll-y"
            style={{ maxHeight: 380, outline: 'none', background: 'var(--bg)', padding: 10 }}>
            {lines.join('')}
          </pre>
          <div className="muted small">keyboard is attached — click the output then type</div>
        </Modal>
      )}
    </>
  )
}

function ServicesPanel({ hostId }: { hostId: number }) {
  const [units, setUnits] = useState<any[]>([])
  const [err, setErr] = useState('')
  const [confirmU, setConfirmU] = useState<{ unit: string; action: string } | null>(null)
  const { notify } = useApp()

  const load = useCallback(async () => {
    try {
      setUnits(await api<any[]>(`/api/services?hostId=${hostId}`))
      setErr('')
    } catch (e: any) { setErr(e.message) }
  }, [hostId])

  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t) }, [load])

  async function doAction(unit: string, action: string) {
    try {
      await api('/api/services/action', { method: 'POST', body: { hostId, unit, action } })
      notify({ level: 'info', title: `${action} ${unit}` })
      load()
    } catch (e: any) {
      notify({ level: 'error', title: `${action} failed`, body: e.message })
    }
  }

  return (
    <div>
      {err && <div className="err-text">{err}</div>}
      <input placeholder="filter units…" style={{ width: '100%', marginBottom: 6 }}
        onInput={e => {
          const q = (e.target as HTMLInputElement).value.toLowerCase()
          document.querySelectorAll('#svc-table tr[data-u]').forEach(tr => {
            ; (tr as HTMLElement).style.display =
              (tr.getAttribute('data-u') ?? '').includes(q) ? '' : 'none'
          })
        }} />
      <table className="data" id="svc-table" style={{ maxHeight: 300 }}>
        <thead><tr><th>unit</th><th>active</th><th>sub</th><th /></tr></thead>
        <tbody>
          {units.filter(u => u.unit.endsWith('.service')).map(u => (
            <tr key={u.unit} data-u={u.unit}>
              <td>{u.unit}</td>
              <td className={u.active === 'active' ? 'dot-ok' : 'dot-err'}>● {u.active}/{u.sub}</td>
              <td className="small muted prewrap">{u.description}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="small" onClick={() => setConfirmU({ unit: u.unit, action: 'start' })}>▶</button>{' '}
                <button className="small" onClick={() => setConfirmU({ unit: u.unit, action: 'stop' })}>■</button>{' '}
                <button className="small" onClick={() => setConfirmU({ unit: u.unit, action: 'restart' })}>↻</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {confirmU && (
        <Confirm title={`${confirmU.action} ${confirmU.unit}?`}
          body={`systemctl ${confirmU.action} ${confirmU.unit}`}
          danger onYes={() => doAction(confirmU.unit, confirmU.action)}
          onClose={() => setConfirmU(null)} />
      )}
    </div>
  )
}

function CronPanel({ hostId }: { hostId: number }) {
  const [lines, setLines] = useState<{ line: string; comment: boolean }[]>([])
  const [draft, setDraft] = useState('')
  const { notify } = useApp()

  const load = useCallback(async () => {
    try {
      setLines(await api<any[]>(`/api/cron?hostId=${hostId}`))
      setDraft(await api<any[]>(`/api/cron?hostId=${hostId}`).then(l => l.map((x: any) => x.line).join('\n')))
    } catch (e: any) { notify({ level: 'error', title: 'cron read', body: e.message }) }
  }, [hostId, notify])

  useEffect(() => { load() }, [load])

  return (
    <div>
      <div className="muted small" style={{ marginBottom: 4 }}>
        crontab (root) — edit carefully; saved atomically via crontab -
      </div>
      <textarea rows={12} style={{ width: '100%', fontFamily: 'var(--font)', fontSize: 11.5 }}
        value={draft} onChange={e => setDraft(e.target.value)} />
      <div className="row" style={{ marginTop: 6 }}>
        <button className="primary small" onClick={async () => {
          try {
            await api('/api/cron', { method: 'POST', body: { hostId, lines: draft.split('\n') } })
            notify({ level: 'info', title: 'crontab saved' })
          } catch (e: any) {
            notify({ level: 'error', title: 'cron save failed', body: e.message })
          }
        }}>Save crontab</button>
        <button className="small" onClick={load}>Reload</button>
      </div>
    </div>
  )
}

function LogViewer({ hostId, path }: { hostId: number; path: string }) {
  const [lines, setLines] = useState<string[]>([])
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState('')
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(
      `${proto}://${location.host}/api/logs/ws?host=${hostId}&path=${encodeURIComponent(path)}`)
    wsRef.current = ws
    ws.onmessage = ev => {
      if (paused) return
      const env = JSON.parse(ev.data)
      if (env.type === 'log.line') setLines(ls => [...ls.slice(-800), env.payload.line])
    }
    return () => ws.close()
  }, [hostId, path, paused])

  const shown = filter ? lines.filter(l => l.includes(filter)) : lines

  return (
    <div>
      <div className="row small" style={{ marginBottom: 4 }}>
        <button className="small" onClick={() => setPaused(p => !p)}>
          {paused ? '▶ resume' : '⏸ pause'}
        </button>
        <input placeholder="filter substring…" style={{ flex: 1 }}
          value={filter} onChange={e => setFilter(e.target.value)} />
        <a className="small" download href={
          'data:text/plain;charset=utf-8,' + encodeURIComponent(lines.join('\n'))
        }>⬇ download</a>
      </div>
      <div className="prewrap scroll-y" style={{ maxHeight: 340 }}>
        {shown.map((l, i) => (
          <div key={i} style={{
            background: highlight(l, filter),
          }}>{l}</div>
        ))}
        {!shown.length && <span className="muted">waiting for lines…</span>}
      </div>
    </div>
  )
}

function highlight(line: string, filter: string): string | undefined {
  return filter && line.includes(filter) ? 'rgba(234,179,8,.18)' : undefined
}
