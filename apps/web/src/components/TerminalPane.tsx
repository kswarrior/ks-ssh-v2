import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { WsClient } from '../lib/ws'
import { useApp } from '../stores/appStore'

// Sticky modifiers: tap CTRL then C → sends Ctrl+C.
type Sticky = null | 'ctrl' | 'alt'

interface Props {
  hostId: number
  paneId: string
  onDead?: () => void
}

const KEYBAR_KEYS: Array<{ label: string; seq: string | 'CTRL' | 'ALT' }> = [
  { label: 'ESC', seq: '\x1b' },
  { label: 'TAB', seq: '\t' },
  { label: 'BKSP', seq: '\x7f' },
  { label: 'CTRL', seq: 'CTRL' },
  { label: 'ALT', seq: 'ALT' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
]

function themeFor(name: string) {
  if (name === 'light') {
    return { background: '#fafafa', foreground: '#171717', cursor: '#171717' }
  }
  return {
    background: '#0a0a0a',
    foreground: '#e8e8e8',
    cursor: '#e8e8e8',
    selectionBackground: '#3b3b3b',
  }
}

export default function TerminalPane({ hostId, paneId, onDead }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WsClient | null>(null)
  const stickyRef = useRef<Sticky>(null)
  const [stickyUI, setStickyUI] = useState<Sticky>(null)
  const [keyBarOn, setKeyBarOn] = useState(
    () => localStorage.getItem(`ks-keybar-${paneId}`) ??
      useApp.getState().settings.keyBarDefault ?? 'true'
  )
  const [status, setStatus] = useState<'connecting' | 'live' | 'down'>('connecting')
  const settings = useApp(s => s.settings)

  useEffect(() => {
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', Menlo, Consolas, monospace",
      fontSize: Number(settings.fontSize) || 14,
      cursorBlink: true,
      theme: themeFor(settings.terminalTheme),
      scrollback: 10000,
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    try {
      term.open(bodyRef.current!)
      const gl = new WebglAddon()
      term.loadAddon(gl)
    } catch {
      /* WebGL unsupported — canvas renderer fallback */
    }

    let resizeTimer: number | undefined
    const sendResize = () => {
      fit.fit()
      wsRef.current?.send('pty.resize', { cols: term.cols, rows: term.rows })
    }

    const ws = new WsClient(
      `/api/terminal/ws?host=${hostId}&session=${encodeURIComponent(paneId)}&cols=${term.cols || 120}&rows=${term.rows || 40}`
    )
    wsRef.current = ws

    ws.on('pty.out', p => term.write(p.data))
    ws.on('pty.attached', () => {
      setStatus('live')
      setTimeout(sendResize, 30)
    })
    ws.on('_close', () => {
      setStatus('down')
      // auto-reconnect happens inside WsClient with replay from last seq
    })
    ws.on('_open', () => {
      setStatus('connecting')
    })
    ws.on('ws.pong', () => {
      if (wsRef.current && status !== 'live') {
        // pong proves the socket is healthy even without output yet
        useApp.getState()
      }
    })

    ws.connect()

    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(sendResize, 80)
    })
    ro.observe(bodyRef.current!)

    const onData = term.onData(d => {
      const st = stickyRef.current
      if (st === 'ctrl') {
        const code = d.toUpperCase().charCodeAt(0)
        if (code >= 64 && code <= 95) {
          ws.send('pty.in', { data: String.fromCharCode(code & 0x1f) })
          stickyRef.current = null
          setStickyUI(null)
          return
        }
        stickyRef.current = null
        setStickyUI(null)
      } else if (st === 'alt') {
        ws.send('pty.in', { data: `\x1b${d}` })
        stickyRef.current = null
        setStickyUI(null)
        return
      }
      ws.send('pty.in', { data: d })
    })

    // bracketed-paste guard: warn before pasting multi-line commands
    const onPaste = term.onData(() => {}) // keep onData as source of truth
    bodyRef.current?.addEventListener('paste', ev => {
      const text = ev.clipboardData?.getData('text') ?? ''
      if ((text.match(/\r?\n/) ?? []).length >= 1 && !window.confirm(
        `Paste multi-line content?\n\n${text.slice(0, 300)}${text.length > 300 ? '…' : ''}`
      )) {
        ev.preventDefault()
        ev.stopPropagation()
      }
    }, true)
    void onPaste
    term.focus()

    return () => {
      clearInterval(resizeTimer)
      onData.dispose()
      ro.disconnect()
      ws.close()
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, paneId])

  function tapKey(k: (typeof KEYBAR_KEYS)[number]) {
    if (k.seq === 'CTRL' || k.seq === 'ALT') {
      const cur = stickyRef.current
      const want = k.seq.toLowerCase() as Sticky // 'ctrl' | 'alt'
      const next: Sticky = cur === null ? want : cur === want ? null : want
      stickyRef.current = next
      setStickyUI(next)
      return
    }
    wsRef.current?.send('pty.in', { data: k.seq })
    termRef.current?.focus()
  }

  const host = useApp(s => s.hosts.find(h => h.id === hostId))

  return (
    <div className="pane">
      {keyBarOn === 'true' && (
        <div className="keybar">
          {KEYBAR_KEYS.map(k => (
            <button key={k.label}
              className={`keybtn ${stickyUI === k.seq ? 'sticky' : ''}`}
              onMouseDown={e => e.preventDefault()}
              onClick={() => tapKey(k)}>
              {k.label}
            </button>
          ))}
          <span className="term-host">
            {host?.username}@{host?.hostname}
            {' · '}
            <span style={{ color: status === 'live' ? 'var(--ok)' : status === 'down' ? 'var(--err)' : 'var(--warn)' }}>
              ● {status}
            </span>
            <button className="ghost" title="toggle key bar"
              onClick={() => {
                setKeyBarOn('false')
                localStorage.setItem(`ks-keybar-${paneId}`, 'false')
              }}
              style={{ marginLeft: 6 }}>⏻</button>
          </span>
        </div>
      )}
      {keyBarOn === 'false' && (
        <div style={{ textAlign: 'right', padding: '2px 6px', borderBottom: '1px solid var(--border)' }}>
          <button className="ghost" title="show key bar"
            onClick={() => {
              setKeyBarOn('true')
              localStorage.setItem(`ks-keybar-${paneId}`, 'true')
            }}>⏻</button>
        </div>
      )}
      <div ref={bodyRef} className="term-body" />
    </div>
  )
}
