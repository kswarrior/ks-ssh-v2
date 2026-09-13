import { useCallback, useEffect, useRef, useState } from 'react'

export type SshEntry = {
  id: string
  name: string
  token: string
  note: string
  online: boolean
}

type TermSession = { id: string; name: string }

/** Strip ANSI escape sequences but keep printable text. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Z]/g, '')
}

/** Apply a PTY output chunk to the visible buffer. Handles clear-screen. */
function applyChunk(prev: string, chunk: string): string {
  if (chunk.includes('\x1b[2J') || chunk.includes('\x1b[H\x1b[2J')) {
    return stripAnsi(chunk).slice(-20000)
  }
  let out = prev + stripAnsi(chunk)
  out = out.replace(/\r(?!\n)/g, '\n')
  if (out.length > 20000) out = out.slice(-20000)
  return out
}

type TermStatus = 'connecting' | 'online' | 'offline'

/** Copy text to the clipboard with a legacy fallback. */
function copyText(text: string): void {
  const fallback = () => {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.top = '0'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } finally {
        document.body.removeChild(ta)
      }
    } catch {
      // Clipboard unavailable — nothing else we can do.
    }
  }
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => {},
        () => fallback(),
      )
      return
    }
  } catch {
    // Permission / secure-context issue — use the fallback below.
  }
  fallback()
}

// Retained for upcoming terminal copy button — keeps noUnusedLocals happy.
void copyText

function ShellSession({
  id,
  onStatus,
}: {
  id: string
  onStatus: (id: string, s: TermStatus) => void
}) {
  const [output, setOutput] = useState('')
  const [status, setStatus] = useState<TermStatus>('offline')
  // "↓ latest" pill when the user scrolled up to read older output.
  const [stuck, setStuck] = useState(true)

  const wsRef = useRef<WebSocket | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const keyRef = useRef<HTMLInputElement | null>(null)
  // Keystrokes typed while the socket is still connecting.
  const pendingRef = useRef<string[]>([])
  // Whether the view is pinned to the bottom.
  const stickRef = useRef(true)

  const focusKeys = () => {
    setTimeout(() => keyRef.current?.focus({ preventScroll: true }), 30)
  }

  const send = (data: string) => {
    if (!data) return
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data)
    } else if (ws && ws.readyState === WebSocket.CONNECTING) {
      // Queue keystrokes typed while connecting; flushed on open.
      pendingRef.current.push(data)
      if (pendingRef.current.length > 256) {
        pendingRef.current.splice(0, pendingRef.current.length - 256)
      }
    }
  }

  const sendResize = () => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const cols = Math.max(20, Math.min(500, Math.floor(window.innerWidth / 9)))
    const rows = Math.max(5, Math.min(300, Math.floor(window.innerHeight / 19)))
    ws.send(JSON.stringify({ type: 'resize', cols, rows }))
  }

  useEffect(() => {
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${scheme}//${window.location.host}/v1/shell`)
    wsRef.current = ws
    setStatus('connecting')
    setOutput('connecting…\n')

    ws.onopen = () => {
      setStatus('online')
      for (const p of pendingRef.current.splice(0)) {
        if (ws.readyState === WebSocket.OPEN) ws.send(p)
      }
      sendResize()
    }
    ws.onmessage = (e) => {
      const text = typeof e.data === 'string' ? e.data : String(e.data)
      try {
        const msg = JSON.parse(text) as { type?: string }
        if (msg?.type === 'exit') {
          setOutput((prev) => prev + '\n[shell exited]\n')
          setStatus('offline')
          return
        }
      } catch {
        // Not JSON — PTY bytes below.
      }
      setOutput((prev) => applyChunk(prev, text))
    }
    ws.onerror = () => {
      setOutput((prev) => prev + '\nsocket error\n')
      setStatus('offline')
    }
    ws.onclose = () => {
      if (wsRef.current !== ws) return
      wsRef.current = null
      // Always go offline — a failed connect must not stick on amber.
      setStatus('offline')
      setOutput((prev) =>
        prev.endsWith('\n') ? prev + 'disconnected\n' : prev + '\ndisconnected\n',
      )
    }

    const onResize = () => sendResize()
    window.addEventListener('resize', onResize)
    focusKeys()

    return () => {
      window.removeEventListener('resize', onResize)
      if (wsRef.current === ws) wsRef.current = null
      try {
        ws.close()
      } catch {
        // Already closed — ignore.
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-scroll only while pinned to the bottom — never yank a user
  // who scrolled up to read older output.
  useEffect(() => {
    const el = bodyRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [output])

  useEffect(() => {
    onStatus(id, status)
  }, [id, status, onStatus])

  const onScroll = () => {
    const el = bodyRef.current
    if (!el) return
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 48
    stickRef.current = nearBottom
    setStuck(nearBottom)
  }

  const jumpToBottom = () => {
    stickRef.current = true
    setStuck(true)
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
    focusKeys()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      send('\r')
    } else if (e.key === 'Backspace') {
      e.preventDefault()
      send('\x7f')
    } else if (e.key === 'Tab') {
      e.preventDefault()
      send('\t')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      send('\x1b')
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      send('\x1b[A')
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      send('\x1b[B')
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      send('\x1b[C')
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      send('\x1b[D')
    } else if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
      // With selected text: native copy AND interrupt the process.
      // Without selection: pure interrupt. (Only preventDefault when
      // there is nothing to copy, so the browser copy is not blocked.)
      const sel = window.getSelection()
      const hasSel = !!sel && !sel.isCollapsed && sel.toString() !== ''
      if (!hasSel) e.preventDefault()
      send('\x03')
    } else if (e.ctrlKey && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault()
      send('\x04')
    } else if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault()
      send('\x0c')
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      send(e.key)
    }
  }

  return (
    <div className="term-window" onClick={focusKeys}>
      <div
        className="term-body"
        ref={bodyRef}
        aria-live="polite"
        onScroll={onScroll}
      >
        <pre className="term-output">{output}</pre>
        <span className="term-cursor" aria-hidden="true">
          █
        </span>
        {!stuck && (
          <button
            type="button"
            className="term-jump"
            onClick={(e) => {
              e.stopPropagation()
              jumpToBottom()
            }}
          >
            ↓ latest
          </button>
        )}
        <input
          ref={keyRef}
          className="term-keycapture"
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Shell input — tap terminal then type"
          onKeyDown={onKeyDown}
          onChange={() => {
            const el = keyRef.current
            if (el && el.value) {
              send(el.value)
              el.value = ''
            }
          }}
        />
      </div>
    </div>
  )
}

let termCounter = 0
function nextTerm(): TermSession {
  termCounter += 1
  return { id: `term-${Date.now().toString(36)}-${termCounter}`, name: `terminal ${termCounter}` }
}

export default function TerminalPage({
  entries: _entries,
  onChange: _onChange,
}: {
  entries: SshEntry[]
  onChange: (fn: (prev: SshEntry[]) => SshEntry[]) => void
}) {
  void _entries
  void _onChange

  const [sessions, setSessions] = useState<TermSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<Record<string, TermStatus>>({})

  const addTerminal = () => {
    const t = nextTerm()
    setSessions((prev) => [...prev, t])
    setStatuses((prev) => ({ ...prev, [t.id]: 'connecting' }))
    setActiveId(t.id)
  }

  const closeTerminal = (id: string) => {
    const next = sessions.filter((t) => t.id !== id)
    setSessions(next)
    if (activeId === id) {
      setActiveId(next.length > 0 ? next[next.length - 1].id : null)
    }
    setStatuses((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  // Stable identity — child reports status without refiring every render.
  const handleStatus = useCallback((id: string, s: TermStatus) => {
    setStatuses((prev) => (prev[id] === s ? prev : { ...prev, [id]: s }))
  }, [])

  // First run: complete blank + centered button only.
  if (sessions.length === 0) {
    return (
      <section
        className="page terminal-blank"
        aria-labelledby="page-title-terminal"
      >
        <h1 id="page-title-terminal" className="sr-only">
          Terminal
        </h1>
        <button
          type="button"
          className="btn btn-primary terminal-add-btn"
          onClick={addTerminal}
          autoFocus
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          Terminal
        </button>
      </section>
    )
  }

  const active = sessions.find((t) => t.id === activeId) ?? sessions[0]

  return (
    <section className="page term-page" aria-labelledby="page-title-terminal">
      <h1 id="page-title-terminal" className="sr-only">
        Terminal
      </h1>
      <div className="term-bar" role="tablist" aria-label="Terminals">
        {sessions.map((t, i) => {
          const isActive = t.id === active.id
          const st = statuses[t.id] ?? 'connecting'
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
              className={`term-tab${isActive ? ' active' : ''}`}
              onClick={() => setActiveId(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setActiveId(t.id)
                } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault()
                  const dir = e.key === 'ArrowRight' ? 1 : -1
                  const next =
                    sessions[(i + dir + sessions.length) % sessions.length]
                  if (next) setActiveId(next.id)
                }
              }}
            >
              <span
                className={`term-tab-dot${st === 'online' ? ' on' : st === 'connecting' ? ' wait' : ''}`}
                aria-hidden="true"
              />
              <span className="term-tab-name">{t.name}</span>
              <button
                type="button"
                className="term-tab-close"
                aria-label={`Close ${t.name}`}
                title={`Close ${t.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  closeTerminal(t.id)
                }}
              >
                ×
              </button>
            </div>
          )
        })}
        <button
          type="button"
          className="term-tab-add"
          onClick={addTerminal}
          aria-label="New terminal"
          title="New terminal"
        >
          +
        </button>
      </div>
      <div className="term-opened">
        {sessions.map((t) => (
          <div key={t.id} hidden={t.id !== active.id}>
            <ShellSession id={t.id} onStatus={handleStatus} />
          </div>
        ))}
      </div>
    </section>
  )
}
