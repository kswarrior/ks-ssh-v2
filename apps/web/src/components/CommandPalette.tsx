import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../stores/appStore'
import { useTerm } from '../stores/termStore'
import { splitActive } from './Workspace'

interface Cmd {
  id: string
  title: string
  hint?: string
  run: () => void
}

export default function CommandPalette() {
  const { paletteOpen, setPaletteOpen, hosts, setActiveHost, setOverlay, setRightTab,
    statuses } = useApp()
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (paletteOpen) {
      setQ(''); setSel(0)
      setTimeout(() => inputRef.current?.focus(), 10)
    }
  }, [paletteOpen])

  const cmds = useMemo<Cmd[]>(() => {
    const out: Cmd[] = [
      { id: 'new-term', title: 'Terminal: new tab', hint: 'host', run: () => {
        const h = useApp.getState().activeHostId
        if (h) useTerm.getState().openTab(h)
      } },
      { id: 'split-right', title: 'Terminal: split right', run: () => splitActive('right') },
      { id: 'split-down', title: 'Terminal: split down', run: () => splitActive('down') },
      { id: 'monitor', title: 'View: resource monitor', run: () => setOverlay('monitor') },
      { id: 'sysinfo', title: 'View: system info', run: () => setOverlay('sysinfo') },
      { id: 'settings', title: 'View: settings', run: () => setOverlay('settings') },
      { id: 'search', title: 'Search: global search & replace', hint: 'Ctrl+K', run: () => setOverlay('search') },
      { id: 'files', title: 'Panel: files', run: () => setRightTab('files') },
      { id: 'ports', title: 'Panel: ports & processes', run: () => setRightTab('ports') },
      { id: 'tunnels', title: 'Panel: tunnels', run: () => setRightTab('tunnels') },
      { id: 'ops', title: 'Panel: git / docker / services / cron / logs', run: () => setRightTab('ops') },
      { id: 'snippets', title: 'Panel: snippets & multi-exec', run: () => setRightTab('snippets') },
      { id: 'audit', title: 'Panel: audit & recordings', run: () => setRightTab('audit') },
    ]
    for (const h of hosts) {
      out.push({
        id: `host-${h.id}`,
        title: `Host: ${h.name}`,
        hint: `${statuses[h.id]?.connected ? '●' : '○'} ${h.username}@${h.hostname}`,
        run: () => setActiveHost(h.id),
      })
    }
    return out
  }, [hosts, statuses, setActiveHost, setOverlay, setRightTab])

  const filtered = q
    ? cmds.filter(c =>
      c.title.toLowerCase().includes(q.toLowerCase()) ||
      c.hint?.toLowerCase().includes(q.toLowerCase()))
    : cmds

  if (!paletteOpen) return null

  const exec = (c?: Cmd) => {
    c?.run()
    setPaletteOpen(false)
  }

  return (
    <div className="overlay-bg" style={{ background: 'transparent', alignItems: 'flex-start' }}
      onMouseDown={() => setPaletteOpen(false)}>
      <div className="palette" onMouseDown={e => e.stopPropagation()}>
        <input ref={inputRef} value={q} placeholder="type a command…"
          onChange={e => { setQ(e.target.value); setSel(0) }}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, filtered.length - 1)) }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)) }
            if (e.key === 'Enter') exec(filtered[sel])
            if (e.key === 'Escape') setPaletteOpen(false)
          }} />
        <div className="palette-list">
          {filtered.map((c, i) => (
            <div key={c.id}
              className={`palette-item ${i === sel ? 'sel' : ''}`}
              onClick={() => exec(c)}
              onMouseEnter={() => setSel(i)}>
              <span>{c.title}</span>
              {c.hint && <span className="hint">{c.hint}</span>}
            </div>
          ))}
          {filtered.length === 0 && <div className="muted small" style={{ padding: 10 }}>no match</div>}
        </div>
      </div>
    </div>
  )
}
