import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { SerializeAddon } from '@xterm/addon-serialize'
import { requestReplay } from './Recordings'
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
 * Recording consent banner (case 9): shown while session recording is on
 * (`GET /api/record/status`). Sessions capture timestamped input+output
 * frames for read-only replay under Recordings.
 */
function RecordBanner() {
  const [on, setOn] = useState<boolean | null>(null)

  useEffect(() => {
    let alive = true
    fetch('/api/record/status', { cache: 'no-store', credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive) setOn(d && typeof d.recording === 'boolean' ? d.recording : null)
      })
      .catch(() => {
        if (alive) setOn(null)
      })
    return () => {
      alive = false
    }
  }, [])

  if (on !== true) return null
  return (
    <div className="rec-banner" role="status">
      <span>● Session recording is ON — input + output are stored for replay.</span>
      <a className="btn btn-sm" href="#/recordings">
        View recordings
      </a>
    </div>
  )
}

/** Kill one backend shell explicitly so closing a tab never leaves a live orphan. */
async function killHostTerm(sid: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/terms/${encodeURIComponent(sid)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    })
    // 404 = already gone (double-click / race) — treat as killed.
    return res.ok || res.status === 404
  } catch {
    return false
  }
}

/** Client-side backend session id: 128-bit hex, matches `valid_session_id`. */
function newSid(): string {
  try {
    const b = new Uint8Array(16)
    crypto.getRandomValues(b)
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  } catch {
    return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`
  }
}

/**
 * Other terminals living on this host (SQLite `--db`, shared on purpose).
 *
 * Your own open tabs are hidden here — this lists only sessions you have
 * NOT attached in this browser, so a fresh page no longer scares you with
 * "anyone can attach" rows that are actually your own tabs. Live shells
 * reattach, ended ones replay their saved output. Hidden when the backend
 * has no list endpoint (relay view, old backend) or when there is nothing
 * else on the host.
 */
function HostTerms({
  sessions,
  onAttach,
}: {
  sessions: TermSession[]
  onAttach: (sid: string) => void
}) {
  const [host, setHost] = useState<HostTerm[] | null>(null)
  const [killing, setKilling] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/terms', {
        cache: 'no-store',
        credentials: 'same-origin',
      })
      if (!res.ok) {
        setHost((prev) => prev ?? null)
        return null
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
      setHost(list)
      return list
    } catch {
      setHost((prev) => prev ?? null)
      return null
    }
  }, [])

  useEffect(() => {
    let alive = true
    let first = true
    const tick = async () => {
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
    void tick()
    const id = window.setInterval(tick, 15000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [])

  const attached = new Set(
    sessions.map((t) => t.sid).filter((s): s is string => !!s),
  )
  // Hide your own open tabs — only show *other* host sessions. This is the
  // fix for "I didn't open these": previously your own tabs appeared here
  // as scary "shared — anyone can attach" rows.
  const others = (host ?? []).filter((h) => !attached.has(h.id))
  if (!host) return null
  if (others.length === 0) return null
  const onKill = async (sid: string) => {
    setKilling(sid)
    try {
      await killHostTerm(sid)
      await load()
    } finally {
      setKilling((cur) => (cur === sid ? null : cur))
    }
  }
  return (
    <div className="host-terms" aria-label="Other terminals on this host">
      <div className="host-terms-head">
        <span>Other sessions on this host ({others.length})</span>
        <span className="host-terms-sub">left by closed tabs — attach or clean up</span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void load()}
          title="Refresh the host session list"
        >
          Refresh
        </button>
      </div>
      <ul className="host-terms-list">
        {others.map((h) => (
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
              onClick={() => requestReplay(h.id)}
              title="Read-only replay of this session's recording"
            >
              Replay
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onAttach(h.id)}
              title={h.alive ? 'Take over this live shell (the other view is detached)' : 'Open this ended session’s saved output'}
            >
              Attach
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={killing === h.id}
              onClick={() => void onKill(h.id)}
              title="Kill this host shell and delete its history"
            >
              {killing === h.id ? '…' : 'Kill'}
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
  off0,
  fontSize,
  predict,
  onStatus,
  onReady,
  onProc,
  onHandle,
  onOffset,
  onLatency,
  onBell,
}: {
  id: string
  active: boolean
  /** Backend session id to reattach to (null = ask the backend for one). */
  sid: string | null
  /** Persisted resume offset for this tab (v2 stream bytes already seen). */
  off0: number
  fontSize: number
  /** Predictive local echo enabled (engages only above 50ms RTT). */
  predict: boolean
  onStatus: (id: string, s: TermStatus) => void
  onReady: (id: string, sid: string | null) => void
  onProc: (id: string, proc: string | null) => void
  onHandle: (id: string, h: TermHandle | null) => void
  onOffset: (id: string, off: number) => void
  onLatency: (id: string, ms: number | null) => void
  onBell: (id: string) => void
}) {
  const [status, setStatus] = useState<TermStatus>('offline')
  // "↓ latest" pill when the user scrolled up to read older output.
  const [stuck, setStuck] = useState(true)
  // Auto-reconnect attempt in flight (0 = steady). Drives the retry pill.
  const [retryAttempt, setRetryAttempt] = useState(0)
  // Last smoothed RTT for the retry pill + prediction gating.
  const [rttMs, setRttMs] = useState<number | null>(null)
  // Ctrl+F in-terminal search bar.
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [searchMiss, setSearchMiss] = useState(false)
  // Bump to tear down the socket and start a fresh shell.
  const [gen, setGen] = useState(0)

  const wsRef = useRef<WebSocket | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const serializeRef = useRef<SerializeAddon | null>(null)
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
  // v2 stream: next expected PTY byte offset. Advanced by every frame and
  // persisted (throttled) so refresh/resume never duplicates or loses.
  const offRef = useRef<number>(off0 >= 0 ? Math.floor(off0) : 0)
  // True once the server proved v2 (ready.v === 2). All v2-only traffic
  // (offsets, ping/ack) stays gated behind this — old backends keep v1.
  const v2Ref = useRef(false)
  // Auto-reconnect bookkeeping (refs: read inside socket callbacks).
  const attemptRef = useRef(0)
  const backoffTimerRef = useRef<number | undefined>(undefined)
  // RTT smoothing + watchdog.
  const rttRef = useRef<number | null>(null)
  const lastMsgRef = useRef(0)
  const lastAckRef = useRef(0)
  const lastSaveRef = useRef(0)
  const unackedRef = useRef(0)
  // Predictive echo: unconfirmed locally-echoed chars + their UTF-8 bytes.
  const predCharsRef = useRef<string[]>([])
  const predBytesRef = useRef<number[]>([])
  const altBufRef = useRef(false)
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

  // Latest-callback refs so long-lived socket handlers never go stale.
  const onOffsetRef = useRef(onOffset)
  onOffsetRef.current = onOffset
  const onLatencyRef = useRef(onLatency)
  onLatencyRef.current = onLatency
  const onBellRef = useRef(onBell)
  onBellRef.current = onBell
  const predictRef = useRef(predict)
  predictRef.current = predict

  /** Persist the resume watermark (throttled by the caller). */
  const saveOffset = () => {
    onOffsetRef.current(idRef.current, offRef.current)
  }

  /** Throttled v2 ack: received watermark for gap accounting. */
  const maybeAck = (force: boolean) => {
    if (!v2Ref.current) return
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const now = Date.now()
    if (!force && now - lastAckRef.current < 500 && unackedRef.current < 32768) {
      return
    }
    lastAckRef.current = now
    unackedRef.current = 0
    try {
      ws.send(JSON.stringify({ type: 'ack', seq: offRef.current }))
    } catch {
      // Socket died mid-send — the reconnect carries the offset anyway.
    }
  }

  /** Record an RTT sample (smoothed) for prediction gating + display. */
  const noteRtt = (rtt: number) => {
    if (!Number.isFinite(rtt) || rtt < 0) return
    const prev = rttRef.current
    const smooth = prev == null ? rtt : Math.round(prev * 0.7 + rtt * 0.3)
    rttRef.current = smooth
    setRttMs(smooth)
    onLatencyRef.current(idRef.current, smooth)
  }

  const clearRtt = () => {
    rttRef.current = null
    setRttMs(null)
    onLatencyRef.current(idRef.current, null)
  }

  // ---------- Predictive local echo (Mosh-lite) ----------
  // Printable keystrokes render dimmed immediately when the smoothed RTT
  // is high and the server has been quiet; the bytes are confirmed against
  // the returning server echo by prefix match and repaired to normal
  // intensity. Any conflict abandons (normalizes) the predictions.

  /** Approx cell width for cursor repair (wide CJK/emoji = 2). */
  const cellWidth = (ch: string): number => {
    const cp = ch.codePointAt(0) ?? 0
    if (cp < 0x1100) return 1
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x2600 && cp <= 0x27bf) ||
      cp === 0x231a ||
      cp === 0x231b
    ) {
      return 2
    }
    return 1
  }

  /** Rewrite pending predictions in normal intensity, keep them on screen. */
  const sealPredictions = () => {
    const chars = predCharsRef.current
    if (chars.length === 0) return
    const term = termRef.current
    predCharsRef.current = []
    predBytesRef.current = []
    if (!term) return
    try {
      let cells = 0
      for (const c of chars) cells += cellWidth(c)
      // Back up over the dimmed chars, rewrite them normal, restore cursor.
      term.write(`\x1b7\x1b[${cells}D\x1b[22m${chars.join('')}\x1b8`)
    } catch {
      // Repair is cosmetic — the chars themselves are already correct.
    }
  }

  const abandonPredictions = () => {
    // Conflict (server output that doesn't match): normalize what we showed
    // and stop predicting until the line goes quiet again.
    sealPredictions()
  }

  /** Confirm a prefix of the prediction queue against server bytes. */
  const confirmPredictions = (bytes: Uint8Array) => {
    let queue = predBytesRef.current
    if (queue.length === 0) return bytes
    let i = 0
    while (queue.length > 0 && i < bytes.length && queue[0] === bytes[i]) {
      queue.shift()
      i += 1
    }
    if (i === 0) {
      // Server said something else entirely — conflict.
      abandonPredictions()
      return bytes
    }
    // Drop fully-confirmed leading chars, repair them to normal intensity.
    const chars = predCharsRef.current
    let used = 0
    let count = 0
    while (count < chars.length) {
      const enc = new TextEncoder().encode(chars[count])
      if (used + enc.length > i) break
      used += enc.length
      count += 1
    }
    if (count > 0) {
      const done = chars.splice(0, count)
      predBytesRef.current = queue
      const term = termRef.current
      if (term) {
        try {
          let cells = 0
          for (const c of done) cells += cellWidth(c)
          term.write(`\x1b7\x1b[${cells}D\x1b[22m${done.join('')}\x1b8`)
        } catch {
          // Cosmetic only.
        }
      }
      queue = predBytesRef.current
    }
    predBytesRef.current = queue
    return bytes.subarray(i)
  }

  /** Maybe locally echo one typed char (returns nothing). */
  const predictInput = (data: string) => {
    if (
      !predictRef.current ||
      data.length !== 1 ||
      altBufRef.current ||
      predCharsRef.current.length >= PREDICT_MAX
    ) {
      return
    }
    const ch = data
    if (ch < ' ' || ch === '\x7f') return
    const rtt = rttRef.current
    if (rtt == null || rtt <= PREDICT_RTT_MS) return
    if (Date.now() - lastMsgRef.current < PREDICT_IDLE_MS) return
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const term = termRef.current
    if (!term) return
    try {
      term.write(`\x1b[2m${ch}\x1b[22m`)
      predCharsRef.current.push(ch)
      const enc = new TextEncoder().encode(ch)
      for (const b of enc) predBytesRef.current.push(b)
    } catch {
      // Prediction is best-effort only.
    }
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
      fontSize,
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
    const search = new SearchAddon()
    const serialize = new SerializeAddon()
    term.loadAddon(fit)
    try {
      // CJK/emoji width tables (v11) — must load before open for metrics.
      term.loadAddon(new Unicode11Addon())
      term.unicode.activeVersion = '11'
    } catch {
      // Older xterm — widths fall back to the built-in tables.
    }
    try {
      term.loadAddon(new WebLinksAddon())
    } catch {
      // Links just won't be clickable.
    }
    term.loadAddon(search)
    term.loadAddon(serialize)
    term.open(container)
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search
    serializeRef.current = serialize
    // Suspend predictive echo inside fullscreen apps (vim, less, htop):
    // their output never matches typed echo.
    const csiDisposers: { dispose: () => void }[] = []
    try {
      const hasAlt = (params: unknown): boolean => {
        try {
          const arr = (
            params as { toArray: () => (number | number[])[] }
          ).toArray()
          const flat: number[] = []
          for (const p of arr) {
            if (Array.isArray(p)) flat.push(...p)
            else flat.push(p)
          }
          return flat.includes(1049) || flat.includes(1047)
        } catch {
          return false
        }
      }
      csiDisposers.push(
        term.parser.registerCsiHandler({ final: 'h' }, (params) => {
          if (hasAlt(params)) {
            altBufRef.current = true
            abandonPredictions()
          }
          return false
        }),
        term.parser.registerCsiHandler({ final: 'l' }, (params) => {
          if (hasAlt(params)) altBufRef.current = false
          return false
        }),
      )
    } catch {
      // Old xterm without parser API — prediction stays enabled.
    }
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
      predictInput(data)
      send(data)
    })
    const onBell = term.onBell(() => {
      onBellRef.current(idRef.current)
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
    // Ctrl+F opens the in-terminal search bar instead of the browser find.
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        e.stopPropagation()
        setSearchOpen(true)
      }
    }
    container.addEventListener('keydown', onKeyDown, true)
    return () => {
      vp?.removeEventListener('scroll', onVpScroll)
      container.removeEventListener('keydown', onKeyDown, true)
      for (const d of csiDisposers) {
        try {
          d.dispose()
        } catch {
          // Already gone — ignore.
        }
      }
      onData.dispose()
      onBell.dispose()
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
      serializeRef.current = null
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

  // Apply the global font size live (touch bar A−/A+, ⋮ menu).
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    try {
      term.options.fontSize = fontSize
      fitRef.current?.fit()
    } catch {
      // Emulator gone — ignore.
    }
    sendResize()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontSize])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    gotExitRef.current = false
    sizeRef.current = null
    v2Ref.current = false
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    // v2 frames carry stream offsets; `from` resumes exactly where this tab
    // left off (persisted per tab) — no duplication, no loss.
    const base = `${scheme}//${window.location.host}/v1/shell`
    const url = sidRef.current
      ? `${base}?id=${encodeURIComponent(sidRef.current)}&v=2&from=${offRef.current}`
      : `${base}?v=2&from=${offRef.current}`
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
    lastMsgRef.current = 0

    const scheduleRetry = () => {
      if (attemptRef.current >= MAX_RETRIES) {
        setRetryAttempt(0)
        setStatus('offline')
        const hint =
          window.location.pathname.startsWith('/v/') ||
          window.location.hash.includes('/view/')
            ? 'disconnected (relay view has no local shell — open the local URL instead)'
            : 'disconnected — Reconnect to restart the shell'
        term.write(`\r\n${hint}\r\n`)
        return
      }
      const wait = backoffMs(attemptRef.current)
      attemptRef.current += 1
      setRetryAttempt(attemptRef.current)
      // Yellow dot while backing off (status stays 'connecting').
      setStatus('connecting')
      if (attemptRef.current === 1) {
        term.write('\r\nconnection lost — retrying…\r\n')
      }
      backoffTimerRef.current = window.setTimeout(() => {
        backoffTimerRef.current = undefined
        setGen((g) => g + 1)
      }, wait)
    }

    ws.onopen = () => {
      attemptRef.current = 0
      setRetryAttempt(0)
      setStatus('online')
      lastMsgRef.current = Date.now()
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
          const msg = JSON.parse(d) as {
            type?: string
            id?: string
            v?: number
            seq?: number
            behind?: boolean
            t?: number
          }
          if (msg?.type === 'ready' && typeof msg.id === 'string' && msg.id) {
            if (!sidRef.current) {
              sidRef.current = msg.id
              onReady(id, msg.id)
            }
            if (msg.v === 2) {
              v2Ref.current = true
              lastMsgRef.current = Date.now()
              // offRef stays at our watermark — the replayed tail advances
              // it frame by frame (overlap-trimmed), so nothing duplicates
              // and nothing is skipped.
              if (msg.behind === true) {
                term.write('\r\n[reconnected — some output was missed]\r\n')
              }
            }
            return
          }
          // v2 latency probe reply.
          if (msg?.type === 'pong' && typeof msg.t === 'number') {
            lastMsgRef.current = Date.now()
            noteRtt(Date.now() - msg.t)
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
        lastMsgRef.current = Date.now()
        if (!v2Ref.current) {
          // v1 fallback: raw PTY text — still confirm predictions.
          const bytes = new TextEncoder().encode(d)
          const rest = confirmPredictions(bytes)
          if (rest.length > 0) term.write(rest)
        } else {
          term.write(d)
        }
        return
      }
      const toBytes = (buf: ArrayBuffer): Uint8Array => new Uint8Array(buf)
      const handleBin = (raw: Uint8Array) => {
        lastMsgRef.current = Date.now()
        let bytes = raw
        if (v2Ref.current) {
          const frame = decodeFrame(raw)
          if (frame) {
            // Overlap (replay/live boundary, refresh): skip bytes we have.
            if (frame.base < offRef.current) {
              const skip = offRef.current - frame.base
              if (skip >= frame.bytes.length) return
              bytes = frame.bytes.subarray(skip)
            } else {
              bytes = frame.bytes
            }
            // Advance past the whole frame (even the trimmed prefix).
            offRef.current = frame.base + frame.bytes.length
            unackedRef.current += frame.bytes.length
          }
          // Reconcile predictive echo, then render only the new bytes.
          bytes = confirmPredictions(bytes)
        } else {
          const rest = confirmPredictions(bytes)
          bytes = rest
        }
        if (bytes.length > 0) term.write(bytes)
        maybeAck(false)
        const now = Date.now()
        if (now - lastSaveRef.current > 10000) {
          lastSaveRef.current = now
          saveOffset()
          maybeAck(true)
        }
      }
      if (d instanceof ArrayBuffer) {
        handleBin(toBytes(d))
        return
      }
      if (typeof Blob !== 'undefined' && d instanceof Blob) {
        void d
          .arrayBuffer()
          .then((b) => handleBin(toBytes(b)))
          .catch(() => {})
      }
    }
    ws.onerror = () => {
      // The close event follows with the real verdict — don't flap the UI
      // (or write) here; onclose decides between retry and offline.
    }
    ws.onclose = (e) => {
      if (wsRef.current !== ws) return
      wsRef.current = null
      clearRtt()
      saveOffset()
      // A real exit means nothing is running anymore; a plain disconnect
      // keeps the label (the detached shell may still be busy).
      if (gotExitRef.current) reportProc(null)
      if (gotExitRef.current) {
        // Dead shell — stay offline until the user reconnects manually
        // (which spawns a fresh session).
        setRetryAttempt(0)
        setStatus('offline')
        return
      }
      if (e.code === 4000) {
        // Same session attached elsewhere (another page/tab) — say so
        // instead of a generic "disconnected". No auto-retry: the other
        // owner holds the shell now.
        setRetryAttempt(0)
        setStatus('offline')
        term.write('\r\nattached elsewhere — Reconnect here to take over\r\n')
        return
      }
      // Abnormal drop (network, sleep, restart) — back off and reattach.
      // Pending keystrokes survive in pendingRef and flush on open.
      scheduleRetry()
    }

    // Heartbeat: v2 ping doubles as keepalive + RTT probe. If traffic
    // stalls entirely the path is dead — recycle the socket so the
    // backoff loop (not the user) re-establishes it.
    const beat = window.setInterval(() => {
      const live = wsRef.current
      if (!live || live !== ws || live.readyState !== WebSocket.OPEN) return
      const now = Date.now()
      if (v2Ref.current) {
        try {
          live.send(JSON.stringify({ type: 'ping', t: now }))
        } catch {
          // Send failed — the socket error/close path takes over.
        }
      }
      if (lastMsgRef.current > 0 && now - lastMsgRef.current > STALE_MS) {
        try {
          live.close()
        } catch {
          // Already dead — onclose handles the retry.
        }
      }
    }, PING_MS)

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
      window.clearInterval(beat)
      if (backoffTimerRef.current !== undefined) {
        window.clearTimeout(backoffTimerRef.current)
        backoffTimerRef.current = undefined
      }
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
    if (backoffTimerRef.current !== undefined) {
      window.clearTimeout(backoffTimerRef.current)
      backoffTimerRef.current = undefined
    }
    attemptRef.current = 0
    setRetryAttempt(0)
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
      offRef.current = 0
      saveOffset()
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

  const openSearch = () => {
    setSearchOpen(true)
    setSearchMiss(false)
    setTimeout(() => searchInputRef.current?.focus(), 30)
  }

  const runSearch = (dir: 1 | -1) => {
    const addon = searchRef.current
    if (!addon || !searchTerm) return
    try {
      const found = dir > 0 ? addon.findNext(searchTerm) : addon.findPrevious(searchTerm)
      setSearchMiss(!found)
    } catch {
      // Search backend unavailable — ignore.
    }
  }

  const closeSearch = () => {
    try {
      searchRef.current?.clearDecorations()
    } catch {
      // Already gone — ignore.
    }
    setSearchOpen(false)
    setSearchMiss(false)
    focusKeys()
  }

  const exportLog = () => {
    const addon = serializeRef.current
    if (!addon) return
    try {
      const text = addon.serialize()
      const short = (sidRef.current ?? 'terminal').slice(0, 8)
      downloadText(`terminal-${short}.txt`, text)
    } catch {
      // Serialize unavailable — nothing to download.
    }
    focusKeys()
  }

  /** Touch-bar key: tracked, queued and sent exactly like typed input. */
  const touchSend = (data: string) => {
    trackInput(data)
    send(data)
    focusKeys()
  }

  const touchPaste = () => {
    try {
      const clip = navigator.clipboard
      if (clip?.readText) {
        void clip.readText().then(
          (t) => {
            if (t) {
              trackInput(t)
              send(t)
            }
            focusKeys()
          },
          () => focusKeys(),
        )
        return
      }
    } catch {
      // Clipboard unavailable — nothing to paste.
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
    search: openSearch,
    exportLog,
  }
  useEffect(() => {
    const proxy: TermHandle = {
      clear: () => actionsRef.current?.clear(),
      stop: () => actionsRef.current?.stop(),
      reconnect: () => actionsRef.current?.reconnect(),
      copy: () => actionsRef.current?.copy(),
      search: () => actionsRef.current?.search(),
      exportLog: () => actionsRef.current?.exportLog(),
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
        {searchOpen && (
          <div
            className="term-search"
            role="search"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              ref={searchInputRef}
              type="text"
              value={searchTerm}
              placeholder="Find in scrollback…"
              aria-label="Find in terminal scrollback"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setSearchTerm(e.target.value)
                setSearchMiss(false)
                const addon = searchRef.current
                if (addon && e.target.value) {
                  try {
                    const found = addon.findNext(e.target.value)
                    setSearchMiss(!found)
                  } catch {
                    // Ignore mid-typing errors.
                  }
                } else {
                  try {
                    addon?.clearDecorations()
                  } catch {
                    // Ignore.
                  }
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  runSearch(e.shiftKey ? -1 : 1)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  closeSearch()
                }
              }}
            />
            {searchMiss && (
              <span className="term-search-miss" role="status">
                not found
              </span>
            )}
            <button
              type="button"
              className="term-search-btn"
              aria-label="Previous match"
              title="Previous match (Shift+Enter)"
              onClick={() => runSearch(-1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="term-search-btn"
              aria-label="Next match"
              title="Next match (Enter)"
              onClick={() => runSearch(1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="term-search-btn"
              aria-label="Close search"
              title="Close search (Esc)"
              onClick={closeSearch}
            >
              ✕
            </button>
          </div>
        )}
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
        {retryAttempt > 0 && status !== 'online' && (
          <div className="term-offline term-retrying" role="status">
            <span>
              reconnecting… (attempt {retryAttempt}
              {rttMs != null ? ` · last ${rttMs}ms` : ''})
            </span>
            <span className="term-offline-actions">
              <button
                type="button"
                className="term-pill-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  reconnect()
                }}
              >
                Retry now
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
        <div
          className="term-touchbar"
          aria-label="Touch keyboard extras"
          onClick={(e) => e.stopPropagation()}
        >
          {(
            [
              ['Esc', '\x1b'],
              ['Tab', '\t'],
              ['←', '\x1b[D'],
              ['↑', '\x1b[A'],
              ['↓', '\x1b[B'],
              ['→', '\x1b[C'],
              ['Home', '\x1b[H'],
              ['End', '\x1b[F'],
              ['^C', '\x03'],
              ['^D', '\x04'],
            ] as [string, string][]
          ).map(([label, seq]) => (
            <button
              key={label}
              type="button"
              className="term-touchkey"
              aria-label={label === '^C' ? 'Control C' : label === '^D' ? 'Control D' : label}
              onClick={() => touchSend(seq)}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            className="term-touchkey"
            aria-label="Paste from clipboard"
            onClick={touchPaste}
          >
            Paste
          </button>
        </div>
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
  // Global terminal font size (touch bar / menu A−/A+, persisted).
  const [fontSize, setFontSize] = useState<number>(loadFontSize)
  // Predictive local echo (Mosh-lite): engages only above 50ms RTT.
  const [predict, setPredict] = useState<boolean>(() => {
    try {
      return localStorage.getItem(PREDICT_KEY) !== '0'
    } catch {
      return true
    }
  })
  // Smoothed RTT per tab/session for the tab bar.
  const [latencies, setLatencies] = useState<Record<string, number | null>>({})
  // Bell: unread activity per tab + brief flash animation.
  const [unread, setUnread] = useState<Record<string, boolean>>({})
  const [flash, setFlash] = useState<Record<string, number>>({})
  // Ephemeral vertical split panes (tab id -> second session). Splits are
  // never persisted — a refresh drops them, the main tabs reattach.
  const [splits, setSplits] = useState<Record<string, TermSession>>({})
  const splitCounter = useRef(0)

  // Persist the font + prediction preferences.
  useEffect(() => {
    try {
      localStorage.setItem(FONT_KEY, String(fontSize))
    } catch {
      // Storage unavailable — applies for this session only.
    }
  }, [fontSize])
  useEffect(() => {
    try {
      localStorage.setItem(PREDICT_KEY, predict ? '1' : '0')
    } catch {
      // Storage unavailable — applies for this session only.
    }
  }, [predict])

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

  // Vertical split: a second live shell beside this tab's own (own backend
  // session + own socket — two panes must never share one PTY).
  const toggleSplit = (tabId: string) => {
    setSplits((prev) => {
      if (prev[tabId]) {
        handlesRef.current.delete(prev[tabId].id)
        const next = { ...prev }
        delete next[tabId]
        return next
      }
      splitCounter.current += 1
      const pane: TermSession = {
        id: `${tabId}-split-${splitCounter.current}`,
        name: 'split',
        sid: null,
        off: 0,
      }
      return { ...prev, [tabId]: pane }
    })
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
    setSplits((prev) => {
      if (!(id in prev)) return prev
      handlesRef.current.delete(prev[id].id)
      const next = { ...prev }
      delete next[id]
      return next
    })
    const dropKey = (prev: Record<string, boolean>) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    }
    setUnread(dropKey)
    setLatencies((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
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

  // Child persists its v2 resume watermark (throttled) — tabs and splits.
  const handleOffset = useCallback((id: string, off: number) => {
    setSessions((prev) => {
      const i = prev.findIndex((t) => t.id === id)
      if (i < 0 || prev[i].off === off) return prev
      const next = [...prev]
      next[i] = { ...next[i], off }
      return next
    })
    setSplits((prev) => {
      const cur = prev[id]
      if (!cur || cur.off === off) return prev
      return { ...prev, [id]: { ...cur, off } }
    })
  }, [])

  // Child reports smoothed RTT (null = unknown/offline).
  const handleLatency = useCallback((id: string, ms: number | null) => {
    setLatencies((prev) => (prev[id] === ms ? prev : { ...prev, [id]: ms }))
  }, [])

  // Bell from any pane: flash its tab; mark unread when not looking at it.
  const handleBell = useCallback(
    (id: string) => {
      const tabId = sessions.find((t) => t.id === id)
        ? id
        : Object.keys(splits).find((tab) => splits[tab]?.id === id) ?? id
      setFlash((prev) => ({ ...prev, [tabId]: (prev[tabId] ?? 0) + 1 }))
      window.setTimeout(() => {
        setFlash((prev) => {
          if (!(tabId in prev)) return prev
          const next = { ...prev }
          delete next[tabId]
          return next
        })
      }, 1200)
      if (tabId !== activeId) {
        setUnread((prev) => (prev[tabId] ? prev : { ...prev, [tabId]: true }))
      }
    },
    [sessions, splits, activeId],
  )

  // Looking at a tab clears its unread bell marker.
  useEffect(() => {
    if (!activeId) return
    setUnread((prev) => {
      if (!prev[activeId]) return prev
      const next = { ...prev }
      delete next[activeId]
      return next
    })
  }, [activeId])

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
        <RecordBanner />
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

  const bumpFont = (delta: number) => {
    setFontSize((f) => Math.max(10, Math.min(24, f + delta)))
  }

  /** One live emulator, main pane or split pane — same wiring. */
  const sessionEl = (s: TermSession, isActive: boolean) => (
    <ShellSession
      id={s.id}
      active={isActive}
      sid={s.sid}
      off0={s.off}
      fontSize={fontSize}
      predict={predict}
      onStatus={handleStatus}
      onReady={handleReady}
      onProc={handleProc}
      onHandle={handleHandle}
      onOffset={handleOffset}
      onLatency={handleLatency}
      onBell={handleBell}
    />
  )

  return (
    <section className="page term-page" aria-labelledby="page-title-terminal">
      <h1 id="page-title-terminal" className="sr-only">
        Terminal
      </h1>
      <RecordBanner />
      <HostTerms sessions={sessions} onAttach={attachHost} />
      <div className="term-bar" role="tablist" aria-label="Terminals">
        {sessions.map((t, i) => {
          const isActive = t.id === active.id
          const st = statuses[t.id] ?? 'connecting'
          // Label = running process, else "terminal" — max 8 chars + "...".
          const proc = procs[t.id] ?? null
          const label = tabLabel(proc)
          const fullTitle = proc ? `${t.name} — ${proc}` : t.name
          const rtt = latencies[t.id] ?? null
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
              className={`term-tab${isActive ? ' active' : ''}${flash[t.id] ? ' flash' : ''}`}
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
              {isActive && st === 'online' && rtt != null && (
                <span className="term-tab-ping" title={`Round-trip ${rtt} ms`}>
                  {rtt}ms
                </span>
              )}
              {unread[t.id] && !isActive && (
                <span className="term-tab-unread" title="Activity while away" aria-hidden="true" />
              )}
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
        {sessions.map((t) => {
          const pane = splits[t.id]
          return (
            <div key={t.id} hidden={t.id !== active.id}>
              {pane ? (
                <div className="term-split">
                  <div className="term-split-pane">{sessionEl(t, t.id === active.id)}</div>
                  <div className="term-split-pane">{sessionEl(pane, t.id === active.id)}</div>
                </div>
              ) : (
                sessionEl(t, t.id === active.id)
              )}
            </div>
          )
        })}
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
            <button
              type="button"
              role="menuitem"
              className="term-tab-menu-item"
              onClick={() => menuAction((h) => h.search())}
            >
              Search scrollback
            </button>
            <button
              type="button"
              role="menuitem"
              className="term-tab-menu-item"
              onClick={() => menuAction((h) => h.exportLog())}
            >
              Export log (.txt)
            </button>
            {menuTerm.sid && (
              <button
                type="button"
                role="menuitem"
                className="term-tab-menu-item"
                title="Read-only replay of this session's recording"
                onClick={() => {
                  const sid = menuTerm.sid
                  closeMenu()
                  if (sid) requestReplay(sid)
                }}
              >
                Replay recording
              </button>
            )}
            <div className="term-tab-menu-sep" aria-hidden="true" />
            <button
              type="button"
              role="menuitem"
              className="term-tab-menu-item"
              title="Dimmed local echo while typing on slow links (above 50ms)"
              onClick={() => {
                setPredict((p) => !p)
                closeMenu()
              }}
            >
              Predictive echo {predict ? '✓' : ''}
            </button>
            <div className="term-tab-menu-row" role="none">
              <button
                type="button"
                role="menuitem"
                className="term-tab-menu-item"
                aria-label="Decrease font size"
                onClick={() => {
                  bumpFont(-1)
                  closeMenu()
                }}
              >
                A−
              </button>
              <button
                type="button"
                role="menuitem"
                className="term-tab-menu-item"
                aria-label="Increase font size"
                onClick={() => {
                  bumpFont(1)
                  closeMenu()
                }}
              >
                A+
              </button>
            </div>
            <button
              type="button"
              role="menuitem"
              className="term-tab-menu-item"
              onClick={() => {
                if (menuTerm) toggleSplit(menuTerm.id)
                closeMenu()
              }}
            >
              {menuTerm && splits[menuTerm.id] ? 'Close split' : 'Split vertically'}
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
