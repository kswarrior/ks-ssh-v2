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
  // CSI ... letter, OSC ... BEL, charset selects, plus single-char FE escapes.
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Z]|\x1b[c=>M78]/g, '')
}

/** Emulate the few line-editing controls a plain <pre> can honour. */
function emulateEdits(s: string): string {
  // Normalise CRLF first so lone-CR handling below only sees real overwrites.
  s = s.replace(/\r\n/g, '\n')
  // Backspace (BS) deletes the previous visible char.
  if (s.includes('\x08')) {
    let out = ''
    for (const ch of s) {
      if (ch === '\x08') out = out.slice(0, -1)
      else out += ch
    }
    s = out
  }
  // Lone CR returns the cursor to the line start: keep the last segment
  // (progress bars, spinners) instead of stacking garbage lines.
  if (s.includes('\r')) {
    s = s
      .split('\n')
      .map((line) => {
        if (!line.includes('\r')) return line
        const parts = line.split('\r')
        return parts[parts.length - 1] ?? ''
      })
      .join('\n')
  }
  // Drop the terminal bell.
  return s.replace(/\x07/g, '')
}

/** Apply a PTY output chunk to the visible buffer. Handles clear-screen. */
function applyChunk(prev: string, chunk: string): string {
  const clearSeqs = ['\x1b[2J', '\x1b[3J', '\x1bc', '\x1b[H\x1b[2J']
  let lastClear = -1
  for (const seq of clearSeqs) {
    const idx = chunk.lastIndexOf(seq)
    if (idx > lastClear) lastClear = idx
  }
  if (lastClear >= 0) {
    // Discard everything before (and including) the last clear sequence —
    // `clear` must wipe, not append.
    const after = chunk.slice(lastClear)
    return emulateEdits(stripAnsi(after)).slice(-20000)
  }
  const out = prev + emulateEdits(stripAnsi(chunk))
  if (out.length > 20000) return out.slice(-20000)
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

const EXIT_SENTINEL = '{"type":"exit"}'

async function messageToText(data: unknown): Promise<string> {
  if (typeof data === 'string') return data
  try {
    if (data instanceof Blob) return await data.text()
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
    // Some browsers deliver Blob-like objects without instanceof matching.
    const maybe = data as { arrayBuffer?: () => Promise<ArrayBuffer>; text?: () => Promise<string> }
    if (maybe && typeof maybe.text === 'function') return await maybe.text()
    if (maybe && typeof maybe.arrayBuffer === 'function') {
      return new TextDecoder().decode(await maybe.arrayBuffer())
    }
  } catch {
    return ''
  }
  return String(data ?? '')
}

function ShellSession({
  id,
  active,
  onStatus,
}: {
  id: string
  active: boolean
  onStatus: (id: string, s: TermStatus) => void
}) {
  const [output, setOutput] = useState('')
  const [status, setStatus] = useState<TermStatus>('offline')
  // "↓ latest" pill when the user scrolled up to read older output.
  const [stuck, setStuck] = useState(true)
  // Bump to tear down the socket and start a fresh shell.
  const [gen, setGen] = useState(0)

  const wsRef = useRef<WebSocket | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const winRef = useRef<HTMLDivElement | null>(null)
  const keyRef = useRef<HTMLInputElement | null>(null)
  // Keystrokes typed while the socket is still connecting.
  const pendingRef = useRef<string[]>([])
  // Chunk batching: coalesce bursty PTY output into one setState.
  const outBufRef = useRef('')
  const outTimerRef = useRef<number | undefined>(undefined)
  // Whether the view is pinned to the bottom.
  const stickRef = useRef(true)
  // True once the backend announced exit (JSON + close); distinguishes a
  // real exit from shell output that merely looks like the sentinel.
  const gotExitRef = useRef(false)

  const focusKeys = () => {
    setTimeout(() => keyRef.current?.focus({ preventScroll: true }), 30)
  }

  // Focus when this tab becomes the visible one.
  useEffect(() => {
    if (active) focusKeys()
  }, [active])

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

  const sendResize = useCallback(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const el = bodyRef.current
    // Measure the real terminal box, not the window (header/tab bars eat
    // space). Fall back to the window when the box is not laid out yet.
    const w = el?.clientWidth ?? window.innerWidth
    const h = el?.clientHeight ?? window.innerHeight
    // 14px mono ≈ 8.4px wide, 21.7px tall (14 * 1.55 line-height).
    // Subtract body padding so the shell does not think it is taller
    // than the visible box (hidden bottom lines otherwise).
    const cols = Math.max(20, Math.min(500, Math.floor((w - 28) / 8.4)))
    const rows = Math.max(5, Math.min(300, Math.floor((h - 28) / 21.7)))
    try {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    } catch {
      // Socket died between the readyState check and send — ignore.
    }
  }, [])

  useEffect(() => {
    gotExitRef.current = false
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${scheme}//${window.location.host}/v1/shell`)
    wsRef.current = ws
    // Binary blobs arrive as Blob objects (needs async decode below).
    try {
      ws.binaryType = 'blob'
    } catch {
      // Older browsers — messageToText still handles ArrayBuffer.
    }
    setStatus('connecting')
    setOutput((prev) => (gen === 0 ? 'connecting…\n' : prev + '\n[reconnecting…]\n'))

    const flushOut = () => {
      outTimerRef.current = undefined
      const chunk = outBufRef.current
      outBufRef.current = ''
      if (chunk) setOutput((prev) => applyChunk(prev, chunk))
    }
    const queueChunk = (text: string) => {
      if (!text) return
      outBufRef.current += text
      // Bound the batch so a runaway `cat` still renders progressively.
      if (outBufRef.current.length > 60000) flushOut()
      else if (outTimerRef.current === undefined) {
        outTimerRef.current = window.setTimeout(flushOut, 30)
      }
    }

    ws.onopen = () => {
      setStatus('online')
      for (const p of pendingRef.current.splice(0)) {
        if (ws.readyState === WebSocket.OPEN) ws.send(p)
      }
      sendResize()
    }
    ws.onmessage = (e) => {
      void messageToText(e.data).then((text) => {
        if (!text) return
        // Exact sentinel only: shell output such as
        // `echo '{"type":"exit"}'` keeps the socket open, so it must NOT
        // flip the tab offline — only the backend close does that.
        if (text.trim() === EXIT_SENTINEL) {
          gotExitRef.current = true
          queueChunk('\n[shell exited]\n')
          return
        }
        queueChunk(text)
      })
    }
    ws.onerror = () => {
      queueChunk('\nsocket error\n')
      setStatus('offline')
    }
    ws.onclose = () => {
      if (wsRef.current !== ws) return
      wsRef.current = null
      if (outBufRef.current) flushOut()
      // Always go offline — a failed connect must not stick on amber.
      setStatus('offline')
      setOutput((prev) => {
        if (gotExitRef.current) return prev.endsWith('\n') ? prev : prev + '\n'
        const hint =
          window.location.pathname.startsWith('/v/') ||
          window.location.hash.includes('/view/')
            ? 'disconnected (relay view has no local shell — open the local URL instead)\n'
            : 'disconnected — Reconnect to restart the shell\n'
        return prev.endsWith('\n') ? prev + hint : prev + '\n' + hint
      })
    }

    const onResize = () => sendResize()
    window.addEventListener('resize', onResize)
    // Watch the terminal box itself (split views, mobile bars, zoom).
    const ro =
      typeof ResizeObserver !== 'undefined' && bodyRef.current
        ? new ResizeObserver(() => sendResize())
        : null
    if (ro && bodyRef.current) ro.observe(bodyRef.current)
    if (active) focusKeys()

    return () => {
      window.removeEventListener('resize', onResize)
      ro?.disconnect()
      if (outTimerRef.current !== undefined) {
        window.clearTimeout(outTimerRef.current)
        outTimerRef.current = undefined
      }
      outBufRef.current = ''
      if (wsRef.current === ws) wsRef.current = null
      try {
        ws.close()
      } catch {
        // Already closed — ignore.
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen])

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

  const reconnect = () => {
    try {
      wsRef.current?.close()
    } catch {
      // Ignore — a fresh socket is created below regardless.
    }
    wsRef.current = null
    gotExitRef.current = false
    stickRef.current = true
    setStuck(true)
    setStatus('connecting')
    setGen((g) => g + 1)
    focusKeys()
  }

  const copyAll = () => {
    copyText(output.slice(-20000) || output)
    focusKeys()
  }

  const sendCtrl = (ch: string, e: React.KeyboardEvent<HTMLInputElement>) => {
    // With selected text on Ctrl+C: let the browser copy AND interrupt.
    if (ch === '\x03') {
      const sel = window.getSelection()
      const hasSel = !!sel && !sel.isCollapsed && sel.toString() !== ''
      if (!hasSel) e.preventDefault()
      send(ch)
      return
    }
    e.preventDefault()
    send(ch)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      send('\r')
    } else if (e.key === 'Backspace') {
      e.preventDefault()
      send('\x7f')
    } else if (e.key === 'Delete') {
      e.preventDefault()
      send('\x1b[3~')
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
    } else if (e.key === 'Home') {
      e.preventDefault()
      send('\x1b[H')
    } else if (e.key === 'End') {
      e.preventDefault()
      send('\x1b[F')
    } else if (e.key === 'PageUp') {
      e.preventDefault()
      send('\x1b[5~')
    } else if (e.key === 'PageDown') {
      e.preventDefault()
      send('\x1b[6~')
    } else if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
      sendCtrl('\x03', e)
    } else if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault()
      send('\x04')
    } else if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault()
      send('\x0c')
    } else if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault()
      send('\x1a')
    } else if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault()
      send('\x01')
    } else if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'e' || e.key === 'E')) {
      e.preventDefault()
      send('\x05')
    } else if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'u' || e.key === 'U')) {
      e.preventDefault()
      send('\x15')
    } else if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault()
      send('\x0b')
    } else if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'w' || e.key === 'W')) {
      e.preventDefault()
      send('\x17')
    } else if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault()
      send('\x12')
    } else if (e.key.length === 1 && !e.metaKey && (!e.ctrlKey || (e.ctrlKey && e.altKey))) {
      // Printable path (AltGr = Ctrl+Alt produces length-1 keys on EU
      // layouts and must still type). IME compositions bypass keydown and
      // arrive via onChange below, so this stays single-send on desktop.
      e.preventDefault()
      send(e.key)
    }
  }

  return (
    <div className="term-window" ref={winRef} onClick={focusKeys}>
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
        {status === 'offline' && (
          <div className="term-offline" role="status">
            <span>shell offline</span>
            <span className="term-offline-actions">
              <button
                type="button"
                className="term-pill-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  reconnect()
                }}
              >
                Reconnect
              </button>
              <button
                type="button"
                className="term-pill-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  copyAll()
                }}
              >
                Copy
              </button>
            </span>
          </div>
        )}
      </div>
      <input
        ref={keyRef}
        className="term-keycapture"
        type="text"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="enter"
        aria-label="Shell input — tap terminal then type"
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          const t = e.clipboardData?.getData('text')
          if (t) {
            e.preventDefault()
            send(t)
          }
        }}
        onChange={() => {
          const el = keyRef.current
          if (el && el.value) {
            // IME / mobile keyboards / autofill land here.
            send(el.value)
            el.value = ''
          }
        }}
        onBlur={() => {
          // Keep the keyboard alive while this tab is the visible one:
          // a stray blur (scroll, pill tap) refocuses unless the user
          // moved to another tab or an overlay button.
          if (active && status === 'online') {
            const ae = document.activeElement
            if (ae instanceof HTMLElement && winRef.current?.contains(ae)) return
            if (ae === document.body) focusKeys()
          }
        }}
      />
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
                } else if (e.key === 'Home') {
                  e.preventDefault()
                  const first = sessions[0]
                  if (first) setActiveId(first.id)
                } else if (e.key === 'End') {
                  e.preventDefault()
                  const last = sessions[sessions.length - 1]
                  if (last) setActiveId(last.id)
                } else if (e.key === 'Delete') {
                  e.preventDefault()
                  closeTerminal(t.id)
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
            <ShellSession
              id={t.id}
              active={t.id === active.id}
              onStatus={handleStatus}
            />
          </div>
        ))}
      </div>
    </section>
  )
}
