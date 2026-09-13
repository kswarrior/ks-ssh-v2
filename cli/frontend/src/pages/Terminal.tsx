import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import 'xterm/css/xterm.css'

export type SshEntry = {
  id: string
  name: string
  token: string
  note: string
  online: boolean
}

type TermSession = { id: string; name: string }

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

function ShellSession({
  id,
  active,
  onStatus,
}: {
  id: string
  active: boolean
  onStatus: (id: string, s: TermStatus) => void
}) {
  const [status, setStatus] = useState<TermStatus>('offline')
  // "↓ latest" pill when the user scrolled up to read older output.
  const [stuck, setStuck] = useState(true)
  // Bump to tear down the socket and start a fresh shell.
  const [gen, setGen] = useState(0)

  const wsRef = useRef<WebSocket | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // Keystrokes typed while the socket is still connecting.
  const pendingRef = useRef<string[]>([])
  // Last size sent to the shell — resizes that change nothing are skipped.
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const resizeTimerRef = useRef<number | undefined>(undefined)
  // True once the backend announced exit (JSON + close); distinguishes a
  // real exit from shell output that merely looks like the sentinel.
  const gotExitRef = useRef(false)

  const focusKeys = () => {
    setTimeout(() => termRef.current?.focus(), 30)
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

  const sendResize = useCallback(() => {
    const ws = wsRef.current
    const fit = fitRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || !fit) return
    // Fit first so the emulator grid matches the visible box, then report
    // the real grid size (a hidden tab has no box — skip until visible).
    try {
      fit.fit()
    } catch {
      return
    }
    const dims = fit.proposeDimensions()
    if (!dims?.cols || !dims?.rows) return
    const cols = Math.max(2, Math.min(500, Math.floor(dims.cols)))
    const rows = Math.max(2, Math.min(300, Math.floor(dims.rows)))
    // Skip when nothing changed — every resize is a SIGWINCH and bash
    // reprints the prompt on each one, so redundant resizes only churn.
    const last = sizeRef.current
    if (last && last.cols === cols && last.rows === rows) return
    sizeRef.current = { cols, rows }
    try {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    } catch {
      // Socket died between the readyState check and send — ignore.
    }
  }, [])

  // Debounced resize for drag/zoom storms — the immediate send above is
  // still used once on connect.
  const scheduleResize = useCallback(() => {
    if (resizeTimerRef.current !== undefined) return
    resizeTimerRef.current = window.setTimeout(() => {
      resizeTimerRef.current = undefined
      sendResize()
    }, 150)
  }, [sendResize])

  // The emulator instance lives for the whole tab; only the socket
  // reconnects (so scrollback survives a reconnect).
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 14,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      lineHeight: 1.5,
      scrollback: 5000,
      rightClickSelectsWord: true,
      macOptionIsMeta: true,
      theme: {
        background: '#000000',
        foreground: '#e6edf3',
        cursor: '#28c840',
        cursorAccent: '#000000',
        selectionBackground: 'rgba(139, 124, 255, 0.35)',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term
    fitRef.current = fit
    // Ctrl/⌘+C copies when text is selected (otherwise SIGINT goes to the
    // shell); Ctrl/⌘+V pastes via the helper textarea (fires onData).
    term.attachCustomKeyEventHandler((e) => {
      const mod = e.ctrlKey || e.metaKey
      if ((e.key === 'c' || e.key === 'C') && mod && term.hasSelection()) {
        return false
      }
      if ((e.key === 'v' || e.key === 'V') && mod && !e.altKey) {
        return false
      }
      return true
    })
    const onData = term.onData((data) => send(data))
    // xterm owns its scroll viewport — watch it for the "↓ latest" pill.
    const vp = container.querySelector('.xterm-viewport')
    const onVpScroll = () => {
      const el = vp as HTMLElement | null
      if (!el) return
      const nearBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < 48
      setStuck((prev) => (prev === nearBottom ? prev : nearBottom))
    }
    vp?.addEventListener('scroll', onVpScroll)
    return () => {
      vp?.removeEventListener('scroll', onVpScroll)
      onData.dispose()
      termRef.current = null
      fitRef.current = null
      try {
        term.dispose()
      } catch {
        // Already gone — ignore.
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fit + focus when this tab becomes the visible one (fit needs a
  // laid-out box, so hidden tabs only size up once shown).
  useEffect(() => {
    if (!active) return
    focusKeys()
    requestAnimationFrame(() => sendResize())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    gotExitRef.current = false
    sizeRef.current = null
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${scheme}//${window.location.host}/v1/shell`)
    wsRef.current = ws
    try {
      ws.binaryType = 'arraybuffer'
    } catch {
      // Older browsers — Blob path below still works.
    }
    setStatus('connecting')
    // No "connecting…" line in the terminal — the tab-bar dot already
    // shows connecting (yellow) / online (green) / offline (red).

    ws.onopen = () => {
      setStatus('online')
      for (const p of pendingRef.current.splice(0)) {
        if (ws.readyState === WebSocket.OPEN) ws.send(p)
      }
      sendResize()
    }
    ws.onmessage = (e) => {
      const d: unknown = e.data
      if (typeof d === 'string') {
        // Exact sentinel only: shell output such as
        // `echo '{"type":"exit"}'` keeps the socket open, so it must NOT
        // flip the tab offline — only the backend close does that.
        if (d.trim() === EXIT_SENTINEL) {
          gotExitRef.current = true
          term.write('\r\n[shell exited]\r\n')
          return
        }
        term.write(d)
        return
      }
      if (d instanceof ArrayBuffer) {
        term.write(new Uint8Array(d))
        return
      }
      if (typeof Blob !== 'undefined' && d instanceof Blob) {
        void d
          .arrayBuffer()
          .then((b) => term.write(new Uint8Array(b)))
          .catch(() => {})
      }
    }
    ws.onerror = () => {
      term.write('\r\nsocket error\r\n')
      setStatus('offline')
    }
    ws.onclose = () => {
      if (wsRef.current !== ws) return
      wsRef.current = null
      // Always go offline — a failed connect must not stick on amber.
      setStatus('offline')
      if (!gotExitRef.current) {
        const hint =
          window.location.pathname.startsWith('/v/') ||
          window.location.hash.includes('/view/')
            ? 'disconnected (relay view has no local shell — open the local URL instead)'
            : 'disconnected — Reconnect to restart the shell'
        term.write(`\r\n${hint}\r\n`)
      }
    }

    const onResize = () => scheduleResize()
    window.addEventListener('resize', onResize)
    // Watch the terminal box itself (split views, mobile bars, zoom).
    const ro =
      typeof ResizeObserver !== 'undefined' && containerRef.current
        ? new ResizeObserver(() => scheduleResize())
        : null
    if (ro && containerRef.current) ro.observe(containerRef.current)
    if (active) focusKeys()

    return () => {
      window.removeEventListener('resize', onResize)
      ro?.disconnect()
      if (resizeTimerRef.current !== undefined) {
        window.clearTimeout(resizeTimerRef.current)
        resizeTimerRef.current = undefined
      }
      if (wsRef.current === ws) wsRef.current = null
      try {
        ws.close()
      } catch {
        // Already closed — ignore.
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen])

  useEffect(() => {
    onStatus(id, status)
  }, [id, status, onStatus])

  const jumpToBottom = () => {
    termRef.current?.scrollToBottom()
    setStuck(true)
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
    sizeRef.current = null
    setStuck(true)
    setStatus('connecting')
    setGen((g) => g + 1)
    focusKeys()
  }

  const copyAll = () => {
    const term = termRef.current
    if (term) {
      try {
        term.selectAll()
        const sel = term.getSelection()
        term.clearSelection()
        if (sel) copyText(sel)
      } catch {
        // Selection unsupported — nothing to copy.
      }
    }
    focusKeys()
  }

  return (
    <div className="term-window" onClick={focusKeys}>
      <div className="term-body">
        <div
          ref={containerRef}
          className="term-xterm"
          aria-label="Linux shell terminal — tap then type"
        />
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
  // Pending close confirmation — the kill only happens after Confirm.
  const [confirmId, setConfirmId] = useState<string | null>(null)

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
    if (confirmId === id) setConfirmId(null)
    setStatuses((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const requestClose = (id: string) => setConfirmId(id)

  const confirmClose = () => {
    if (confirmId) closeTerminal(confirmId)
    setConfirmId(null)
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
  const confirmTerm = confirmId
    ? sessions.find((t) => t.id === confirmId) ?? null
    : null

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
                  requestClose(t.id)
                }
              }}
            >
              <svg
                className="term-tab-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <path d="m7 9 3 3-3 3M13 15h4" />
              </svg>
              <span className="term-tab-name">{t.name}</span>
              <span
                className={`term-tab-dot${st === 'online' ? ' on' : st === 'connecting' ? ' wait' : ''}`}
                aria-hidden="true"
              />
              <button
                type="button"
                className="term-tab-close"
                aria-label={`Close ${t.name}`}
                title={`Close ${t.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  requestClose(t.id)
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
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
      {confirmTerm && (
        <div
          className="term-confirm-overlay"
          onClick={() => setConfirmId(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setConfirmId(null)
          }}
        >
          <div
            className="term-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="term-confirm-title"
            onClick={(e) => e.stopPropagation()}
          >
            <svg
              className="term-confirm-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m7 9 3 3-3 3M13 15h4" />
            </svg>
            <h2 id="term-confirm-title">Close {confirmTerm.name}?</h2>
            <p>The shell session will be killed.</p>
            <div className="term-confirm-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setConfirmId(null)}
                autoFocus
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={confirmClose}
              >
                Close terminal
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
