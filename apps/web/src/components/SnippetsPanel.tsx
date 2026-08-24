import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useApp } from '../stores/appStore'

// ---- Snippets library + multi-exec fan-out with per-host exit codes ----

export default function SnippetsPanel({ hostId }: { hostId: number }) {
  const [snippets, setSnippets] = useState<any[]>([])
  const [command, setCommand] = useState('')
  const [targets, setTargets] = useState<Set<number>>(new Set([hostId]))
  const [saveHostId, setSaveHostId] = useState<string>('') // '' = global
  const [outputs, setOutputs] = useState<Record<number, string[]>>({})
  const [exits, setExits] = useState<Record<number, number | null>>({})
  const [running, setRunning] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const { notify, hosts } = useApp()

  useEffect(() => {
    api<string[]>(`/api/history?hostId=${hostId}`).then(setHistory).catch(() => {})
  }, [hostId])

  const load = useCallback(async () => {
    try {
      setSnippets(await api<any[]>('/api/snippets'))
    } catch (e: any) {
      notify({ level: 'error', title: 'snippets', body: e.message })
    }
  }, [notify])

  useEffect(() => { load() }, [load])

  async function addSnippet() {
    const name = prompt('snippet name:')
    if (!name || !command.trim()) return
    const hid = saveHostId === '' ? null : Number(saveHostId)
    await api('/api/snippets', { method: 'POST', body: { name, command, hostId: hid } }).catch(e =>
      notify({ level: 'error', title: 'save failed', body: e.message }))
    load()
  }

  const [histFilter, setHistFilter] = useState('')
  const shownHistory = history.filter(h => h.includes(histFilter)).slice(-40).reverse()

  function run() {
    if (!command.trim()) return
    const list = [...targets]
    if (list.length === 0) return
    setOutputs({}); setExits({}); setRunning(true)

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/api/snippets/ws/multi-run`)
    wsRef.current = ws
    let confirmed = false

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'multi.run', payload: { command, hostIds: list } }))
    }
    ws.onmessage = ev => {
      const env = JSON.parse(ev.data)
      if (env.type === 'multi.dangerous' && !confirmed) {
        confirmed = window.confirm(
          `⚠ Dangerous command detected:\n\n${env.payload.command}\n\nRun anyway on ${list.length} host(s)?`
        )
        if (confirmed) {
          ws.send(JSON.stringify({ type: 'multi.run', payload: { command, hostIds: list } }))
        } else {
          ws.close(); setRunning(false)
        }
        return
      }
      if (env.type === 'multi.output') {
        setOutputs(o => ({
          ...o,
          [env.payload.hostId]: [
            ...(o[env.payload.hostId] ?? []),
            `${env.payload.stream === 'stderr' ? '⨯' : ''}${env.payload.data}`,
          ],
        }))
      }
      if (env.type === 'multi.exit') {
        setExits(x => ({ ...x, [env.payload.hostId]: env.payload.exitCode }))
        if (Object.keys(exits).length + 1 >= list.length) setRunning(false)
      }
    }
    ws.onclose = () => setRunning(false)
  }

  function stopAll() {
    wsRef.current?.send(JSON.stringify({ type: 'multi.stop' }))
  }

  return (
    <div style={{ padding: 8 }}>
      <div className="small muted" style={{ marginBottom: 4 }}>run one command on N hosts</div>
      <textarea rows={3} style={{ width: '100%', fontFamily: 'var(--font)' }}
        placeholder="command…" value={command} onChange={e => setCommand(e.target.value)} />
      <div className="row" style={{ margin: '6px 0', flexWrap: 'wrap' }}>
        {hosts.map(h => (
          <label key={h.id} className="row small" style={{ gap: 3 }}>
            <input type="checkbox"
              checked={targets.has(h.id)}
              onChange={() => setTargets(s => {
                const n = new Set(s)
                n.has(h.id) ? n.delete(h.id) : n.add(h.id)
                return n
              })} />
            {h.name}
          </label>
        ))}
      </div>
      <div className="row">
        {!running
          ? <button className="primary small" onClick={run}>▶ Run on {targets.size}</button>
          : <button className="danger small" onClick={stopAll}>■ Stop all</button>}
        <select className="small" value={saveHostId} title="snippet scope"
          onChange={e => setSaveHostId(e.target.value)}>
          <option value="">🌐 global scope</option>
          {hosts.map(h => <option key={h.id} value={h.id}>host: {h.name}</option>)}
        </select>
        <button className="ghost small" onClick={addSnippet}>💾 save as snippet</button>
      </div>

      {Object.keys(outputs).length > 0 && (
        <div className="row" style={{ marginTop: 10, gap: 6, flexWrap: 'wrap' }}>
          {[...targets].map(hid => (
            <div key={hid} style={{
              flex: '1 1 220px', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', padding: 6, minWidth: 0,
            }}>
              <div className="row small" style={{ justifyContent: 'space-between' }}>
                <b>{hosts.find(h => h.id === hid)?.name ?? hid}</b>
                <span className={`badge ${exits[hid] === 0 ? 'ok' : exits[hid] == null ? '' : 'err'}`}>
                  {exits[hid] != null ? `exit ${exits[hid]}` : running ? '…' : '—'}
                </span>
              </div>
              <pre className="prewrap scroll-y" style={{ maxHeight: 140, margin: 0 }}>
                {(outputs[hid] ?? []).join('')}
              </pre>
            </div>
          ))}
        </div>
      )}

      <h4 style={{ margin: '14px 0 4px' }}>Library</h4>
      {snippets.map(sn => (
        <div key={sn.id} className="file-row">
          <FileIconDot dangerous={sn.dangerous} />
          <span className="file-name">{sn.name}
            <span className="muted mono"> · {sn.command.slice(0, 60)}</span>
          </span>
          <button className="ghost small" onClick={() => setCommand(sn.command)}>load</button>
          <button className="ghost small danger" onClick={() =>
            api(`/api/snippets/${sn.id}`, { method: 'DELETE' }).then(load)}>✕</button>
        </div>
      ))}
      {snippets.length === 0 && <div className="muted small">no snippets yet</div>}

      <h4 style={{ margin: '14px 0 4px' }}>Shell history</h4>
      <input placeholder="search history…" className="small" style={{ width: '100%', marginBottom: 4 }}
        value={histFilter} onChange={e => setHistFilter(e.target.value)} />
      <div className="scroll-y" style={{ maxHeight: 140 }}>
        {shownHistory.map((h, i) => (
          <div key={i} className="file-row mono" style={{ cursor: 'pointer', fontSize: 11 }}
            onClick={() => setCommand(h)}>
            {h}
          </div>
        ))}
        {shownHistory.length === 0 && <div className="muted small">no history yet</div>}
      </div>
    </div>
  )
}

function FileIconDot({ dangerous }: { dangerous: boolean }) {
  return <span className="host-dot" style={{ background: dangerous ? 'var(--err)' : 'var(--ok)' }} />
}
