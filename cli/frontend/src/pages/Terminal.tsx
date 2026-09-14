import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { SerializeAddon } from '@xterm/addon-serialize'
import 'xterm/css/xterm.css'

export type SshEntry = {
  id: string
  name: string
  token: string
  note: string
  online: boolean
}

type TermSession = { id: string; name: string; sid: string | null; off: number }

type TermStatus = 'connecting' | 'online' | 'offline'

const TERMS_KEY = 'ks-ssh:terms'
const TERMS_ACTIVE_KEY = 'ks-ssh:terms:active'
const FONT_KEY = 'ks-ssh:term-font'
const PREDICT_KEY = 'ks-ssh:term-predict'

/** v2 wire protocol: Binary frames are u64-LE offset + raw PTY bytes. */
const FRAME_OFF_LEN = 8

function decodeFrame(frame: Uint8Array): { base: number; bytes: Uint8Array } | null {
  if (frame.length < FRAME_OFF_LEN) return null
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  // Offsets stay far below 2^53 for any real session.
  const base = Number(view.getBigUint64(0, true))
  return { base, bytes: frame.subarray(FRAME_OFF_LEN) }
}

/** Auto-reconnect backoff: 500ms doubling to a 5s cap. */
function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** Math.max(0, attempt), 5000)
}
const MAX_RETRIES = 10
/** Client ping every 5s doubles as keepalive + RTT probe (v2 only). */
const PING_MS = 5000
/** No traffic this long → assume the path died, recycle the socket. */
const STALE_MS = 12000
/** Predictive echo only engages above this smoothed RTT. */
const PREDICT_RTT_MS = 50
/** Server silence required before new predictions (conflict avoidance). */
const PREDICT_IDLE_MS = 300
const PREDICT_MAX = 64

function loadFontSize(): number {
  try {
    const n = parseInt(localStorage.getItem(FONT_KEY) ?? '', 10)
    if (Number.isFinite(n)) return Math.max(10, Math.min(24, n))
  } catch {
    // Storage unavailable — fall through to default.
  }
  return 14
}

/** Save a blob download (scrollback export). */
function downloadText(filename: string, text: string): void {
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    window.setTimeout(() => {
      URL.revokeObjectURL(url)
      a.remove()
    }, 500)
  } catch {
    // Download unavailable — nothing else we can do.
  }
}

/** Tabs persisted across refresh so their shells can be reattached. */
function loadTerms(): TermSession[] {
  try {
    const raw = localStorage.getItem(TERMS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return (parsed as Partial<TermSession>[])
      .filter(
        (t) =>
          t &&
          typeof t.id === 'string' &&
          typeof t.name === 'string' &&
          (t.sid === null || typeof t.sid === 'string') &&
          (t.off === undefined || typeof t.off === 'number'),
      )
      .map((t) => ({
        id: t.id as string,
        name: t.name as string,
        sid: (t.sid as string | null) ?? null,
        off: typeof t.off === 'number' && t.off >= 0 ? Math.floor(t.off) : 0,
      }))
  } catch {
    return []
  }
}

function loadActiveId(fallback: string | null): string | null {
  try {
    const raw = localStorage.getItem(TERMS_ACTIVE_KEY)
    return typeof raw === 'string' && raw ? raw : fallback
  } catch {
    return fallback
  }
}

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

/** Actions a tab's ⋮ menu can invoke on its live emulator session. */
type TermHandle = {
  clear: () => void
  stop: () => void
  reconnect: () => void
  copy: () => void
  search: () => void
  exportLog: () => void
}

/**
 * Tab label: the running process, or "terminal" when idle.
 * Capped at 8 chars + "..." so long names never stretch the tab bar.
 */
function tabLabel(proc: string | null): string {
  const base = proc && proc.trim() ? proc.trim() : 'terminal'
  return base.length > 8 ? `${base.slice(0, 8)}...` : base
}

/**
 * Best-effort foreground process from a submitted shell line:
 * first program word (`sudo apt update` → `apt`, `./serve.sh` → `serve.sh`).
 * Returns null for empty lines.
 */function procFromLine(line: string): string | null {
  const segment = line.split(/[;&|]+/)[0]?.trim() ?? ''
  if (!segment) return null
  const skip = new Set([
    'sudo',
    'command',
    'builtin',
    'exec',
    'nohup',
    'time',
    'env',
  ])
  for (const raw of segment.split(/\s+/)) {
    const tok = raw.replace(/^['"]+|['"]+$/g, '')
    if (!tok || skip.has(tok) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      continue
    }
    const prog = tok.split('/').pop() ?? ''
    if (!prog || prog === '.' || prog === '..' || prog === '-') continue
    return prog
  }
  return null
}

type HostTerm = {
  id: string
  alive: boolean
  idle_secs: number
  bytes: number
}

function timeAgo(idle: number): string {
  if (!Number.isFinite(idle) || idle < 0) return ''
  if (idle < 10) return 'just now'
  if (idle < 60) return `${Math.floor(idle)}s ago`
  const m = Math.floor(idle / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/**
 * Terminals living on the host (SQLite `--db`, shared on purpose).
 * Any visitor sees them here and can attach — live shells reattach,
 * ended ones replay their saved output. Hidden when the backend has no
 * list endpoint (relay view, old backend) or when the host has none yet.
 */
function HostTerms({
  sessions,
  onAttach,
}: {
  sessions: TermSession[]
  onAttach: (sid: string) => void
}) {
  const [host, setHost] = useState<HostTerm[] | null>(null)

  useEffect(() => {
    let alive = true
    let first = true
    const load = async () => {
      try {
        const res = await fetch('/api/terms', {
          cache: 'no-store',
          credentials: 'same-origin',
        })
        if (!res.ok) {
          // Endpoint missing (relay view) or logged out — hide on first
          // load, keep the old list on later polls.
          if (first && alive) setHost(null)
          return
        }
        const data = (await res.json()) as {
          sessions?: Partial<HostTerm>[]
        }
        const list = Array.isArray(data.sessions)
          ? data.sessions.filter(
              (s): s is HostTerm =>
                !!s &&
                typeof s.id === 'string' &&
                typeof s.alive === 'boolean',
            )
          : []
        if (alive) {
          first = false
          setHost(list)
        }
      } catch {
        if (first && alive) setHost(null)
      }
    }
    void load()
    const id = window.setInterval(load, 15000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [])

  if (!host || host.length === 0) return null
  const attached = new Set(
    sessions.map((t) => t.sid).filter((s): s is string => !!s),
  )
  return (
    <div className="host-terms" aria-label="Terminals on this host">
      <div className="host-terms-head">
        <span>On this host</span>
        <span className="host-terms-sub">shared — anyone can attach</span>
      </div>
      <ul className="host-terms-list">
        {host.map((h) => (
          <li key={h.id} className="host-term">
            <span
              className={`term-tab-dot${h.alive ? ' on' : ''}`}
              title={h.alive ? 'live' : 'ended'}
              aria-hidden="true"
            />
            <code className="host-term-id" title={h.id}>
              {h.id.slice(0, 8)}
            </code>
            <span className="host-term-meta">
              {h.alive ? 'live' : 'ended'} · {timeAgo(h.idle_secs)}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onAttach(h.id)}
            >
              {attached.has(h.id) ? 'Open' : 'Attach'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ShellSession({
  id,
  active,
  sid,
  onStatus,
  onReady,
  onProc,
  onHandle,
}: {
  id: string
  active: boolean
  /** Backend session id to reattach to (null = ask the backend for one). */
  sid: string | null
  onStatus: (id: string, s: TermStatus) => void
  onReady: (id: string, sid: string | null) => void
  onProc: (id: string, proc: string | null) => void
  onHandle: (id: string, h: TermHandle | null) => void
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
  // Backend session id for this tab — survives refresh via localStorage
  // (parent prop on mount) and reconnects reattach to the same shell.
  const sidRef = useRef<string | null>(sid)
  // Current input line (not yet submitted) + running process guess for the
  // tab label. Refs so the xterm listeners (mounted once) always see them.
  const lineRef = useRef('')
  const procRef = useRef<string | null>(null)
  const idRef = useRef(id)
  idRef.current = id
  const onProcRef = useRef(onProc)
  onProcRef.current = onProc

  const reportProc = (proc: string | null) => {
    if (procRef.current === proc) return
    procRef.current = proc
    onProcRef.current(idRef.current, proc)
  }

  /**
   * Watch keystrokes for the tab label: submitting a line sets the label to
   * its program (`python app.py` → `python`), Ctrl+C clears it back to
   * "terminal". Best effort per page view — a refresh resets to "terminal"
   * even if the reattached shell is still busy.
   */
  const trackInput = (data: string) => {
    for (const ch of data) {
      if (ch === '\x03') {
        // Ctrl+C — foreground process stopped.
        lineRef.current = ''
        reportProc(null)
      } else if (ch === '\r' || ch === '\n') {
        const proc = procFromLine(lineRef.current)
        lineRef.current = ''
        // Empty Enter leaves the label alone (it may be input to a running
        // program, not a new idle prompt).
        if (proc) reportProc(proc)
      } else if (ch === '\x7f' || ch === '\b') {
        lineRef.current = lineRef.current.slice(0, -1)
      } else if (ch === '\x15') {
        // Ctrl+U — line cleared.
        lineRef.current = ''
      } else if (ch >= ' ' || ch === '\t') {
        lineRef.current += ch
        if (lineRef.current.length > 256) {
          lineRef.current = lineRef.current.slice(-256)
        }
      }
      // Other control chars (arrows, etc.) are ignored — they edit the line
      // mid-buffer, which a linear tracker can't follow exactly.
    }
  }

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
    const onData = term.onData((data) => {
      trackInput(data)
      send(data)
    })
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
    const url = sidRef.current
      ? `${scheme}//${window.location.host}/v1/shell?id=${encodeURIComponent(sidRef.current)}`
      : `${scheme}//${window.location.host}/v1/shell`
    const ws = new WebSocket(url)
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
        // Session handshake — a fresh tab learns its backend id here and
        // persists it so a refresh reattaches to the same shell.
        try {
          const msg = JSON.parse(d) as { type?: string; id?: string }
          if (msg?.type === 'ready' && typeof msg.id === 'string' && msg.id) {
            if (!sidRef.current) {
              sidRef.current = msg.id
              onReady(id, msg.id)
            }
            return
          }
        } catch {
          // Not JSON — PTY text or the exit sentinel below.
        }
        // Exact sentinel only: shell output such as
        // `echo '{"type":"exit"}'` keeps the socket open, so it must NOT
        // flip the tab offline — only the backend close does that.
        if (d.trim() === EXIT_SENTINEL) {
          gotExitRef.current = true
          reportProc(null)
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
    ws.onclose = (e) => {
      if (wsRef.current !== ws) return
      wsRef.current = null
      // Always go offline — a failed connect must not stick on amber.
      setStatus('offline')
      // A real exit means nothing is running anymore; a plain disconnect
      // keeps the label (the detached shell may still be busy).
      if (gotExitRef.current) reportProc(null)
      if (e.code === 4000) {
        // Same session attached elsewhere (another page/tab) — say so
        // instead of a generic "disconnected".
        term.write('\r\nattached elsewhere — Reconnect here to take over\r\n')
      } else if (!gotExitRef.current) {
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
    // A dead shell can't be reattached to — drop the id so the backend
    // spawns a fresh session (and reports the new id via `ready`).
    if (gotExitRef.current) {
      sidRef.current = null
      onReady(id, null)
    }
    gotExitRef.current = false
    sizeRef.current = null
    lineRef.current = ''
    reportProc(null)
    setStuck(true)
    setStatus('connecting')
    setGen((g) => g + 1)
    focusKeys()
  }

  const clearTerm = () => {
    try {
      termRef.current?.clear()
    } catch {
      // Emulator gone — ignore.
    }
    focusKeys()
  }

  const stopProc = () => {
    // SIGINT to the foreground process; the label drops back to "terminal".
    lineRef.current = ''
    reportProc(null)
    send('\x03')
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

  // Latest actions for the parent tab ⋮ menu — a stable proxy registered
  // once, forwarding to the current implementations above.
  const actionsRef = useRef<TermHandle | null>(null)
  actionsRef.current = {
    clear: clearTerm,
    stop: stopProc,
    reconnect,
    copy: copyAll,
  }
  useEffect(() => {
    const proxy: TermHandle = {
      clear: () => actionsRef.current?.clear(),
      stop: () => actionsRef.current?.stop(),
      reconnect: () => actionsRef.current?.reconnect(),
      copy: () => actionsRef.current?.copy(),
    }
    onHandle(id, proxy)
    return () => {
      onHandle(id, null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

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
  return { id: `term-${Date.now().toString(36)}-${termCounter}`, name: `terminal ${termCounter}`, sid: null, off: 0 }
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

  const [sessions, setSessions] = useState<TermSession[]>(() => {
    const stored = loadTerms()
    // Keep the "terminal N" counter ahead of restored names.
    for (const t of stored) {
      const m = /^terminal (\d+)$/.exec(t.name)
      if (m) termCounter = Math.max(termCounter, parseInt(m[1], 10))
    }
    return stored
  })
  const [activeId, setActiveId] = useState<string | null>(() =>
    loadActiveId(loadTerms().length > 0 ? (loadTerms()[0]?.id ?? null) : null),
  )
  const [statuses, setStatuses] = useState<Record<string, TermStatus>>({})
  // Running process per tab for the tab label (null = idle → "terminal").
  const [procs, setProcs] = useState<Record<string, string | null>>({})
  // Pending close confirmation — the kill only happens after Confirm.
  const [confirmId, setConfirmId] = useState<string | null>(null)
  // Open ⋮ tab menu + its viewport anchor. Rendered via portal to
  // document.body so no transformed/filtered ancestor can hijack the fixed
  // positioning or clip it inside the scrollable tab bar.
  const [menuId, setMenuId] = useState<string | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<{
    top: number | null
    bottom: number | null
    right: number
  } | null>(null)
  // Live session actions per tab, registered by each ShellSession.
  const handlesRef = useRef(new Map<string, TermHandle>())

  // Persist tabs so a refresh or revisit reattaches to the same shells.
  useEffect(() => {
    try {
      localStorage.setItem(TERMS_KEY, JSON.stringify(sessions))
      if (activeId) localStorage.setItem(TERMS_ACTIVE_KEY, activeId)
      else localStorage.removeItem(TERMS_ACTIVE_KEY)
    } catch {
      // Storage unavailable — tabs just won't survive a refresh.
    }
  }, [sessions, activeId])

  const addTerminal = () => {
    const t = nextTerm()
    setSessions((prev) => [...prev, t])
    setStatuses((prev) => ({ ...prev, [t.id]: 'connecting' }))
    setActiveId(t.id)
  }

  // Attach a shared host terminal (from On-this-host): reuse the local tab
  // when it is already attached, otherwise open a new tab on its session id
  // (the socket reattaches + replays, like after a refresh).
  const attachHost = (sid: string) => {
    const existing = sessions.find((t) => t.sid === sid)
    if (existing) {
      setActiveId(existing.id)
      return
    }
    const t = { ...nextTerm(), sid }
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
    setMenuId((cur) => (cur === id ? null : cur))
    handlesRef.current.delete(id)
    setStatuses((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    setProcs((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const requestClose = (id: string) => {
    setMenuId(null)
    setConfirmId(id)
  }

  const confirmClose = () => {
    if (confirmId) closeTerminal(confirmId)
    setConfirmId(null)
  }

  // Stable identity — child reports status without refiring every render.
  const handleStatus = useCallback((id: string, s: TermStatus) => {
    setStatuses((prev) => (prev[id] === s ? prev : { ...prev, [id]: s }))
  }, [])

  // Child reports its backend session id so tabs reattach after refresh.
  const handleReady = useCallback((id: string, sid: string | null) => {
    setSessions((prev) =>
      prev.map((t) => (t.id === id && t.sid !== sid ? { ...t, sid } : t)),
    )
  }, [])

  // Child reports its running process so the tab shows it (null = idle).
  const handleProc = useCallback((id: string, proc: string | null) => {
    setProcs((prev) => (prev[id] === proc ? prev : { ...prev, [id]: proc }))
  }, [])

  // Child registers its live actions for the ⋮ tab menu.
  const handleHandle = useCallback((id: string, h: TermHandle | null) => {
    if (h) handlesRef.current.set(id, h)
    else handlesRef.current.delete(id)
  }, [])

  // Escape closes the open ⋮ tab menu.
  useEffect(() => {
    if (!menuId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuId(null)
        setMenuAnchor(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuId])

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
        <HostTerms sessions={sessions} onAttach={attachHost} />
      </section>
    )
  }

  const active = sessions.find((t) => t.id === activeId) ?? sessions[0]
  const confirmTerm = confirmId
    ? sessions.find((t) => t.id === confirmId) ?? null
    : null
  const menuTerm =
    menuId && menuAnchor
      ? sessions.find((t) => t.id === menuId) ?? null
      : null

  const openMenu = (t: TermSession, anchor: HTMLElement) => {
    setActiveId(t.id)
    if (menuId === t.id) {
      setMenuId(null)
      setMenuAnchor(null)
      return
    }
    const r = anchor.getBoundingClientRect()
    // Drop down by default; drop upward when there is not enough room
    // below but more room above (short landscape phones, zoomed pages).
    // The menu itself also caps at viewport height and scrolls inside.
    const MENU_EST = 280
    const spaceBelow = window.innerHeight - r.bottom
    const right = Math.max(8, window.innerWidth - r.right)
    setMenuId(t.id)
    if (spaceBelow >= MENU_EST || r.top <= spaceBelow) {
      setMenuAnchor({
        top: Math.max(8, Math.min(r.bottom + 6, window.innerHeight - MENU_EST)),
        bottom: null,
        right,
      })
    } else {
      setMenuAnchor({
        top: null,
        bottom: Math.max(
          8,
          Math.min(window.innerHeight - r.top + 6, window.innerHeight - MENU_EST),
        ),
        right,
      })
    }
  }

  const closeMenu = () => {
    setMenuId(null)
    setMenuAnchor(null)
  }

  const menuAction = (fn: (h: TermHandle) => void) => {
    if (menuTerm) {
      const h = handlesRef.current.get(menuTerm.id)
      // Session actions refocus the terminal themselves.
      if (h) fn(h)
    }
    closeMenu()
  }

  return (
    <section className="page term-page" aria-labelledby="page-title-terminal">
      <h1 id="page-title-terminal" className="sr-only">
        Terminal
      </h1>
      <HostTerms sessions={sessions} onAttach={attachHost} />
      <div className="term-bar" role="tablist" aria-label="Terminals">
        {sessions.map((t, i) => {
          const isActive = t.id === active.id
          const st = statuses[t.id] ?? 'connecting'
          // Label = running process, else "terminal" — max 8 chars + "...".
          const proc = procs[t.id] ?? null
          const label = tabLabel(proc)
          const fullTitle = proc ? `${t.name} — ${proc}` : t.name
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
                } else if (e.key === 'Escape') {
                  setMenuId(null)
                  setMenuAnchor(null)
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
              <span className="term-tab-name" title={fullTitle}>
                {label}
              </span>
              <span
                className={`term-tab-dot${st === 'online' ? ' on' : st === 'connecting' ? ' wait' : ''}`}
                title={st}
                aria-hidden="true"
              />
              <button
                type="button"
                className="term-tab-dots"
                aria-label={`Actions for ${fullTitle}`}
                title={`Actions for ${fullTitle}`}
                aria-haspopup="menu"
                aria-expanded={menuId === t.id}
                onClick={(e) => {
                  e.stopPropagation()
                  openMenu(t, e.currentTarget)
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="5" r="1.8" />
                  <circle cx="12" cy="12" r="1.8" />
                  <circle cx="12" cy="19" r="1.8" />
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
              sid={t.sid}
              onStatus={handleStatus}
              onReady={handleReady}
              onProc={handleProc}
              onHandle={handleHandle}
            />
          </div>
        ))}
      </div>
      {menuTerm && menuAnchor
        ? createPortal(
            <>
              <div
                className="term-menu-overlay"
                onClick={closeMenu}
                aria-hidden="true"
              />
              <div
                className="term-tab-menu"
                role="menu"
                aria-label={`Actions for ${menuTerm.name}`}
                style={
                  menuAnchor.top != null
                    ? { top: menuAnchor.top, right: menuAnchor.right }
                    : { bottom: menuAnchor.bottom ?? 8, right: menuAnchor.right }
                }
                onClick={(e) => e.stopPropagation()}
              >
            <div className="term-tab-menu-head" title={menuTerm.name}>
              {(procs[menuTerm.id] ?? null)
                ? `Running: ${procs[menuTerm.id]}`
                : menuTerm.name}
            </div>
            <button
              type="button"
              role="menuitem"
              className="term-tab-menu-item"
              disabled={
                (statuses[menuTerm.id] ?? 'connecting') !== 'online' ||
                !(procs[menuTerm.id] ?? null)
              }
              title="Send Ctrl+C to the foreground process"
              onClick={() => menuAction((h) => h.stop())}
            >
              Stop process
            </button>
            <button
              type="button"
              role="menuitem"
              className="term-tab-menu-item"
              onClick={() => menuAction((h) => h.clear())}
            >
              Clear screen
            </button>
            <button
              type="button"
              role="menuitem"
              className="term-tab-menu-item"
              onClick={() => menuAction((h) => h.reconnect())}
            >
              Reconnect
            </button>
            <button
              type="button"
              role="menuitem"
              className="term-tab-menu-item"
              onClick={() => menuAction((h) => h.copy())}
            >
              Copy output
            </button>
            <div className="term-tab-menu-sep" aria-hidden="true" />
            <button
              type="button"
              role="menuitem"
              className="term-tab-menu-item danger"
              onClick={() => {
                const id = menuTerm.id
                closeMenu()
                requestClose(id)
              }}
            >
              Delete terminal
            </button>
          </div>
        </>,
        document.body,
      )
        : null}
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
