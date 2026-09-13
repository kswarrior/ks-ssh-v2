import { useEffect, useRef, useState } from 'react'

export type SshEntry = {
  id: string
  name: string
  token: string
  note: string
  online: boolean
}

/** Strip ANSI escape sequences but keep printable text. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Z]/g, '')
}

/** Apply a PTY output chunk to the visible buffer. Handles clear-screen. */
function applyChunk(prev: string, chunk: string): string {
  // Full-screen clear? Start fresh.
  if (chunk.includes('\x1b[2J') || chunk.includes('\x1b[H\x1b[2J')) {
    const clean = stripAnsi(chunk)
    return clean.slice(-20000)
  }
  let out = prev + stripAnsi(chunk)
  // Handle carriage returns + backspaces simply.
  out = out.replace(/\r(?!\n)/g, '\n')
  if (out.length > 20000) out = out.slice(-20000)
  return out
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

  const [opened, setOpened] = useState(false)
  const [output, setOutput] = useState('')
  const [status, setStatus] = useState<'connecting' | 'online' | 'offline'>('offline')

  const wsRef = useRef<WebSocket | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const keyRef = useRef<HTMLInputElement | null>(null)

  const focusKeys = () => {
    // Timeout so mobile keyboards open reliably after tap.
    setTimeout(() => keyRef.current?.focus({ preventScroll: true }), 30)
  }

  const send = (data: string) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN && data) {
      ws.send(data)
    }
  }

  const sendResize = () => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    // Rough cols/rows from viewport — backend clamps to sane bounds.
    const cols = Math.max(20, Math.min(500, Math.floor(window.innerWidth / 9)))
    const rows = Math.max(5, Math.min(300, Math.floor(window.innerHeight / 19)))
    ws.send(JSON.stringify({ type: 'resize', cols, rows }))
  }

  // Open shell.
  const openTerminal = () => {
    setOpened(true)
    setOutput('')
    setStatus('connecting')
  }

  const close = () => {
    try {
      wsRef.current?.close()
    } catch {
      // Already closed — ignore.
    }
    wsRef.current = null
    setOpened(false)
    setOutput('')
    setStatus('offline')
  }

  // Connect WS when the terminal window appears.
  useEffect(() => {
    if (!opened) return
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${scheme}//${window.location.host}/v1/shell`)
    wsRef.current = ws
    setStatus('connecting')
    setOutput('connecting…\n')

    ws.onopen = () => {
      setStatus('online')
      sendResize()
    }
    ws.onmessage = (e) => {
      const text = typeof e.data === 'string' ? e.data : String(e.data)
      try {
        const msg = JSON.parse(text) as { type?: string }
        if (msg?.type === 'exit') {
          setOutput((prev) => prev + '\n[shell exited — tap × to close]\n')
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
      setStatus((s) => (s === 'online' ? 'offline' : s))
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
  }, [opened])

  // Auto-scroll.
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [output, opened])

  // Char-mode keyboard: every key goes straight to the PTY.
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
      e.preventDefault()
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

  // First run: complete blank + centered button only.
  if (!opened) {
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
          onClick={openTerminal}
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

  return (
    <section className="page term-page" aria-labelledby="page-title-terminal">
      <h1 id="page-title-terminal" className="sr-only">
        Terminal
      </h1>
      <div className="term-window" onClick={focusKeys}>
        <div className="term-titlebar">
          <span className="term-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="term-title">shell — {status}</span>
          <span
            className={`term-status${status === 'online' ? ' on' : status === 'connecting' ? ' wait' : ''}`}
            role="status"
            title={status}
          />
          <button
            type="button"
            className="term-close"
            onClick={(e) => {
              e.stopPropagation()
              close()
            }}
            aria-label="Close terminal"
            title="Close terminal"
          >
            ×
          </button>
        </div>
        <div className="term-body" ref={bodyRef} aria-live="polite">
          <pre className="term-output">{output}</pre>
          <span className="term-cursor" aria-hidden="true">
            █
          </span>
          {/* Invisible capture input — opens the mobile keyboard and
              funnels every keystroke to the PTY (char mode, sshx.io style). */}
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
              // IME / autocomplete fallback: flush any composed text.
              const el = keyRef.current
              if (el && el.value) {
                send(el.value)
                el.value = ''
              }
            }}
          />
        </div>
      </div>
    </section>
  )
}
