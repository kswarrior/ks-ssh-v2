import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  E2E_ALG,
  checkTofu,
  extractKeyFromText,
  fingerprintK,
  parseFragmentKey,
  type E2eStatus,
} from './e2e'

/**
 * Inject relay globals into a WSS-fetched UI bundle before rendering it as
 * `srcDoc`. `srcDoc` iframes have an opaque origin (`about:srcdoc`), so the
 * bundled relay shim cannot parse `/v/TOKEN` from its own URL — it reads
 * `window.__KS_RELAY_TOKEN__` / `window.__KS_RELAY_HOST__` instead and opens
 * its own `wss://<host>/v1/client?token=…` for full-function rpc/shell.
 * The `/v/TOKEN` src path needs no injection (the shim parses the pathname).
 */
/** Token pattern: 9 chars fresh, 5 chars legacy — both route. */
const TOKEN_EXACT_RE = /^(?:[A-Za-z0-9]{5}|[A-Za-z0-9]{9})$/

function withRelayGlobals(html: string, token: string, host: string): string {
  const safeToken = token.replace(/[^A-Za-z0-9]/g, '').slice(0, 9)
  const safeHost = host.replace(/[^A-Za-z0-9.:-]/g, '').slice(0, 253)
  if (!TOKEN_EXACT_RE.test(safeToken) || !safeHost) return html
  const tag = `<script>window.__KS_RELAY_TOKEN__=${JSON.stringify(safeToken)};window.__KS_RELAY_HOST__=${JSON.stringify(safeHost)};</script>`
  const idx = html.indexOf('<head')
  if (idx >= 0) {
    const end = html.indexOf('>', idx)
    if (end >= 0) return `${html.slice(0, end + 1)}${tag}${html.slice(end + 1)}`
  }
  return `${tag}${html}`
}

type PageId = 'home' | 'ssh' | 'session' | 'installation' | 'settings'

type NavItem = { id: PageId; label: string; hash: string }

const NAV: NavItem[] = [
  { id: 'home', label: 'Home', hash: '#/' },
  { id: 'ssh', label: 'SSH', hash: '#/ssh' },
  { id: 'installation', label: 'Installation', hash: '#/installation' },
  { id: 'settings', label: 'Settings', hash: '#/settings' },
]

type Settings = {
  relayHost: string
  connectTimeoutMs: number
  requireE2E: boolean
}

const DEFAULT_RELAY_HOST = ''
// Empty = same origin that served this page (the deployed Worker).
// Set to e.g. "ks-ssh-v2.kswarriorpro.workers.dev" to point at another relay.

const DEFAULT_SETTINGS: Settings = {
  relayHost: DEFAULT_RELAY_HOST,
  connectTimeoutMs: 8000,
  requireE2E: true,
}

function normalizeSettings(raw: unknown): Settings {
  const o = (raw ?? {}) as Partial<Settings>
  const relayHost =
    typeof o.relayHost === 'string'
      ? o.relayHost.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').slice(0, 253)
      : DEFAULT_RELAY_HOST
  const n = Number(o.connectTimeoutMs)
  const connectTimeoutMs = Number.isFinite(n)
    ? Math.min(30000, Math.max(3000, Math.round(n)))
    : DEFAULT_SETTINGS.connectTimeoutMs
  return { relayHost, connectTimeoutMs, requireE2E: o.requireE2E !== false }
}

/** Base URL for relay HTTP ('' = same origin). Never includes secrets. */
function relayHttpBase(settings: Settings): string {
  const h = settings.relayHost.trim()
  if (!h || h === window.location.host) return ''
  return `https://${h}`
}

/** Host for relay WSS (custom relay or the page origin). */
function relayWsHost(settings: Settings): string {
  const h = settings.relayHost.trim()
  return h || window.location.host
}

type Theme = 'light' | 'dark'

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem('ks-ssh:theme')
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    // Storage unavailable — fall through to system preference.
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJSON(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage unavailable (private mode) — app still works for this session.
  }
}

/** Map a location hash to a page, or null when it is not a page route. */
function hashToPage(hash: string): PageId | null {
  const clean = hash.replace(/^#\/?/, '')
  // Session deep links like #/session/ABCDE render the session page.
  if (clean === 'session' || clean.startsWith('session/')) return 'session'
  const found = NAV.find((p) => p.hash.replace(/^#\/?/, '') === clean)
  return found ? found.id : null
}

/** Extract a session token from #/session/TOKEN or ?token=TOKEN. */
function hashToSessionToken(hash: string): string | null {
  // Supports `#/session/ABCDE` and `#/session/ABCDE#k=...` (fragment key
  // ignored here; use parseFragmentKey() for `k` — never query/fetch).
  const m = hash.match(new RegExp(`^#/session/([A-Za-z0-9]{5,9})`))
  if (m?.[1] && TOKEN_EXACT_RE.test(m[1])) return m[1].toUpperCase()
  try {
    const q = new URLSearchParams(window.location.search).get('token')
    if (q && TOKEN_EXACT_RE.test(q)) return q.toUpperCase()
  } catch {
    // URL parsing unavailable — ignore.
  }
  return null
}

function useIsMobile(breakpoint = 768): boolean {
  const getMatch = () =>
    typeof window !== 'undefined'
      ? window.matchMedia(`(max-width: ${breakpoint}px)`).matches
      : false
  const [isMobile, setIsMobile] = useState(getMatch)

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`)
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [breakpoint])

  return isMobile
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const copy = async () => {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text)
      } else {
        throw new Error('clipboard unavailable')
      }
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      } catch {
        // Clipboard unavailable — nothing else we can do.
      }
    }
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button type="button" className="btn btn-sm" onClick={copy}>
      {copied ? 'Copied ✓' : 'Copy'}
    </button>
  )
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="codeblock">
      <pre>
        <code>{code}</code>
      </pre>
      <CopyButton text={code} />
    </div>
  )
}

function SshGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fff"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M12 15h5" />
    </svg>
  )
}

function StatusTag({
  online,
  connecting,
}: {
  online: boolean
  connecting?: boolean
}) {
  if (connecting) {
    return (
      <span className="tag connecting">
        <span className="tag-dot" aria-hidden="true" />
        Connecting…
      </span>
    )
  }
  return online ? (
    <span className="tag online">
      <span className="tag-dot" aria-hidden="true" />
      Online
    </span>
  ) : (
    <span className="tag offline">
      <span className="tag-dot" aria-hidden="true" />
      Offline
    </span>
  )
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

function FeatureTile({
  icon,
  title,
  text,
}: {
  icon: ReactNode
  title: string
  text: string
}) {
  return (
    <div className="card feature">
      <span className="feature-icon" aria-hidden="true">
        <Icon>{icon}</Icon>
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  )
}

type SshEntry = {
  id: string
  name: string
  token: string
  note: string
  online: boolean
  // E2E expected for this connection (persisted flag only — the raw `k`
  // itself lives in SSHPage memory (`e2eKeys`), never in localStorage).
  e2e?: boolean
}

function HomePage() {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [index, setIndex] = useState(0)
  const [dir, setDir] = useState<1 | -1>(1)
  const touchX = useRef<number | null>(null)
  const tiltRef = useRef<HTMLDivElement | null>(null)
  const pausedRef = useRef(false)

  const features: Array<{ title: string; text: string; src: string; alt: string }> = [
    { title: 'Terminal', text: 'Real PTY, multi-tab + vertical split, gap-free resume, predictive echo, CJK/IME + search & export, touch bar.', src: '/images/terminal.png', alt: 'Terminal' },
    { title: 'Files', text: 'HOME-jailed files & editor (1/5/100 MB caps), lexical path handling, zip/unzip, and media previews.', src: '/images/files.png', alt: 'Files' },
    { title: 'Ports', text: 'Live /proc ports with process list, per-port kill, and connection tracking over WSS.', src: '/images/ports.png', alt: 'Ports' },
    { title: 'Host', text: 'Per-core/RAM/swap/df-filtered host monitoring, metrics and system info – same as local --port.', src: '/images/host.png', alt: 'Host' },
  ]

  const count = features.length
  const goTo = (i: number, direction?: 1 | -1) => {
    setIndex((prev) => {
      const nextIdx = ((i % count) + count) % count
      if (direction) setDir(direction)
      else setDir(nextIdx > prev ? 1 : -1)
      return nextIdx
    })
  }
  const prev = () => {
    setDir(-1)
    setIndex((i) => (i - 1 + count) % count)
  }
  const next = () => {
    setDir(1)
    setIndex((i) => (i + 1) % count)
  }
  const current = features[index] ?? features[0]!

  // Arrow-key navigation for the carousel (ignored while lightbox is open).
  useEffect(() => {
    if (expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        setDir(-1)
        setIndex((i) => (i - 1 + count) % count)
      } else if (e.key === 'ArrowRight') {
        setDir(1)
        setIndex((i) => (i + 1) % count)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded, count])

  // Auto-play: advance every 6s unless hovered/focused or lightbox open.
  useEffect(() => {
    if (expanded) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const t = setInterval(() => {
      if (pausedRef.current || document.hidden) return
      setDir(1)
      setIndex((i) => (i + 1) % count)
    }, 6000)
    return () => clearInterval(t)
  }, [expanded, count])

  const onTiltMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = tiltRef.current
    if (!el) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    if (window.matchMedia('(pointer: coarse)').matches) return
    const r = e.currentTarget.getBoundingClientRect()
    const px = (e.clientX - r.left) / r.width - 0.5
    const py = (e.clientY - r.top) / r.height - 0.5
    el.style.transform = `rotateX(${(-py * 7).toFixed(2)}deg) rotateY(${(px * 10).toFixed(2)}deg) translateZ(0)`
  }
  const onTiltLeave = () => {
    const el = tiltRef.current
    if (!el) return
    el.style.transform = 'rotateX(0deg) rotateY(0deg) translateZ(0)'
  }

  if (expanded) {
    return (
      <section className="page page-feature-lightbox" aria-labelledby="page-title-home">
        <div className="feature-lightbox card">
          <div className="feature-lightbox-head">
            <h2 style={{ margin: 0 }}>Preview</h2>
            <button type="button" className="btn btn-sm" onClick={() => setExpanded(null)} aria-label="Close preview">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
              Close
            </button>
          </div>
          <div className="feature-lightbox-body" onClick={() => setExpanded(null)} role="button" tabIndex={0} aria-label="Close preview" onKeyDown={(e) => { if (e.key === 'Escape' || e.key === 'Enter') setExpanded(null) }}>
            <img src={expanded} alt="Preview" className="feature-lightbox-img" />
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="page page-home" aria-labelledby="page-title-home">
      <div
        className="showcase-3d"
        aria-roledescription="carousel"
        aria-label="App screenshots"
        onMouseEnter={() => {
          pausedRef.current = true
        }}
        onMouseLeave={() => {
          pausedRef.current = false
        }}
        onFocus={() => {
          pausedRef.current = true
        }}
        onBlur={() => {
          pausedRef.current = false
        }}
      >
        <div className="showcase-ambient" aria-hidden="true" />
        <div
          className="showcase-viewport"
          onMouseMove={onTiltMove}
          onMouseLeave={onTiltLeave}
          onTouchStart={(e) => {
            touchX.current = e.touches[0]?.clientX ?? null
          }}
          onTouchEnd={(e) => {
            if (touchX.current === null) return
            const dx = (e.changedTouches[0]?.clientX ?? touchX.current) - touchX.current
            touchX.current = null
            if (Math.abs(dx) < 30) return
            if (dx > 0) prev()
            else next()
          }}
        >
          <div ref={tiltRef} className="showcase-tilt">
            <div className="showcase-frame">
              <div className={`showcase-stage${dir === 1 ? ' is-next' : ' is-prev'}`}>
                <div className="showcase-caption" aria-live="polite">
                  <strong key={`t-${index}`} className="showcase-caption-title showcase-rise">
                    {current.title}
                  </strong>
                  <span key={`d-${index}`} className="showcase-caption-text showcase-rise showcase-rise-2">
                    {current.text}
                  </span>
                </div>
                <img
                  key={current.src}
                  src={current.src}
                  alt={current.alt}
                  className="showcase-image"
                  onClick={() => setExpanded(current.src)}
                  style={{ cursor: 'zoom-in' }}
                  draggable={false}
                />
                <div className="showcase-shine" aria-hidden="true" />
                <span className="showcase-counter" aria-hidden="true">
                  {index + 1} / {count}
                </span>
                <div key={`p-${index}`} className="showcase-progress" aria-hidden="true" />
              </div>
              <button
                type="button"
                className="showcase-nav showcase-nav-prev"
                onClick={prev}
                aria-label={`Previous image: ${features[(index - 1 + count) % count]?.title}`}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
              <button
                type="button"
                className="showcase-nav showcase-nav-next"
                onClick={next}
                aria-label={`Next image: ${features[(index + 1) % count]?.title}`}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
              <button
                type="button"
                className="feature-image-expand-btn showcase-expand"
                aria-label={`Expand ${current.title} image`}
                onClick={() => setExpanded(current.src)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              </button>
            </div>
          </div>
        </div>
        <div className="showcase-dots" role="tablist" aria-label="Choose screenshot">
          {features.map((f, i) => (
            <button
              key={f.title}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-label={`Show ${f.title}`}
              title={f.title}
              className={`showcase-dot${i === index ? ' is-active' : ''}`}
              onClick={() => goTo(i)}
            >
              <span className="showcase-dot-label">{f.title}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="hero card">
        <span className="eyebrow">KS SSH</span>
        <h1 id="page-title-home">Shell access, minus the hassle.</h1>
        <p className="lead">
          Save your connections, see live status, and reconnect in one tap —
          from your phone or desktop.
        </p>
        <div className="row-actions">
          <a className="btn btn-primary" href="#/ssh">
            Open SSH
          </a>
          <a className="btn" href="#/installation">
            Install
          </a>
        </div>
      </div>

      <h2>Why us</h2>
      <div className="grid">
        <FeatureTile
          icon={<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />}
          title="Fast"
          text="Connect in one tap with your saved token. No typing addresses twice."
        />
        <FeatureTile
          icon={<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />}
          title="Private"
          text="Tokens stay in your browser. Shell traffic is E2E-sealed with AES-256-GCM."
        />
        <FeatureTile
          icon={
            <>
              <rect x="5" y="2" width="14" height="20" rx="2" />
              <path d="M12 18h.01" />
            </>
          }
          title="Everywhere"
          text="The same interface on phone and desktop, with offline-first data."
        />
      </div>
    </section>
  )
}

function E2eBadge({ status }: { status: E2eStatus }) {
  if (status === 'on') {
    return (
      <span className="tag online" title="End-to-end encrypted (AES-256-GCM)">
        🔒 E2E
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="tag offline" title="E2E decrypt failed — wrong key or tampered message">
        🔒 E2E error
      </span>
    )
  }
  return (
    <span className="tag offline" title="Relay can see plaintext (legacy peer or missing key)">
      ⚠️ relay-visible
    </span>
  )
}

function SSHPage({
  entries,
  onChange,
  settings,
}: {
  entries: SshEntry[]
  onChange: (fn: (prev: SshEntry[]) => SshEntry[]) => void
  settings: Settings
}) {
  const relayBase = relayHttpBase(settings)
  const wsHost = relayWsHost(settings)
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [token, setToken] = useState('')
  const [note, setNote] = useState('')
  // Per-connection E2E (form state). The raw `k` is memory-only by design:
  // it never enters `SshEntry` (which is persisted to localStorage) — only
  // the `e2e` flag persists. Keys live in `e2eKeys` below + the URL fragment.
  const [e2eOn, setE2eOn] = useState(false)
  const [e2eKey, setE2eKey] = useState('')
  const [e2eError, setE2eError] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  // Fingerprint cache for exactly one key (fp only — never the key itself
  // beyond `k` as the cache key, matching the SessionPage TOFU pattern).
  const [keyFp, setKeyFp] = useState<{ k: string; fp: string } | null>(null)
  // Memory-only E2E keys by entry id (cleared on reload — never persisted).
  const [e2eKeys, setE2eKeys] = useState<Record<string, string>>({})
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const socketsRef = useRef(new Map<string, WebSocket>())

  // Parsed key for the form (derived during render — no cascading render).
  const parsedFormKey = e2eOn ? extractKeyFromText(e2eKey) : null
  const formFp = parsedFormKey && keyFp && keyFp.k === parsedFormKey ? keyFp.fp : null

  // Fingerprint preview for the typed key (async continuation only, so no
  // cascading render; stale keys never display — render gates on `k`).
  useEffect(() => {
    if (!parsedFormKey) return
    if (keyFp && keyFp.k === parsedFormKey) return
    let alive = true
    const k = parsedFormKey
    void fingerprintK(k)
      .then((f) => {
        if (alive) setKeyFp({ k, fp: f })
      })
      .catch(() => {
        // Invalid key — preview stays empty (render already gates on `k`).
      })
    return () => {
      alive = false
    }
  }, [parsedFormKey, keyFp])

  useEffect(
    () => () => {
      for (const ws of socketsRef.current.values()) {
        try {
          ws.close()
        } catch {
          // Already closed — ignore.
        }
      }
      socketsRef.current.clear()
    },
    [],
  )

  const closeSocket = (id: string) => {
    const ws = socketsRef.current.get(id)
    socketsRef.current.delete(id)
    try {
      ws?.close()
    } catch {
      // Already closed — ignore.
    }
  }

  const resetForm = () => {
    setEditingId(null)
    setName('')
    setToken('')
    setNote('')
    setE2eOn(false)
    setE2eKey('')
    setE2eError(null)
    setShowKey(false)
  }

  const openNew = () => {
    resetForm()
    setFormOpen(true)
  }

  const openEdit = (e: SshEntry) => {
    setEditingId(e.id)
    setName(e.name)
    setToken(e.token)
    setNote(e.note)
    setE2eOn(e.e2e === true)
    // Memory-only: prefill only if the key is still in this session.
    // After a reload it is intentionally empty (never persisted).
    setE2eKey(e2eKeys[e.id] ?? '')
    setE2eError(null)
    setShowKey(false)
    setFormOpen(true)
  }

  const closeForm = () => {
    setFormOpen(false)
    resetForm()
  }

  const attemptConnect = (entry: SshEntry) => {
    if (!entry || entry.online || connectingId) return
    const t = entry.token.trim().toUpperCase()
    if (!TOKEN_EXACT_RE.test(t)) {
      setBanner('Token is 5 or 9 letters/numbers — run `ks-ssh --token=` to get one.')
      return
    }
    closeSocket(entry.id)
    setConnectingId(entry.id)
    setBanner(null)
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${scheme}//${wsHost}/v1/client?token=${t}`)
    socketsRef.current.set(entry.id, ws)
    const timeoutMs = settings.connectTimeoutMs
    const timeout = setTimeout(() => {
      if (socketsRef.current.get(entry.id) !== ws) return
      closeSocket(entry.id)
      setConnectingId((cur) => (cur === entry.id ? null : cur))
      setBanner('Relay timed out. Is the agent running (`ks-ssh --token=`)?')
    }, timeoutMs)
    ws.onopen = () => {
      // Presence check only (no secrets). Include e2e capability when a key
      // is available — per-entry memory key first, then the URL fragment.
      // `k` itself never leaves memory/fragment.
      const k = e2eKeys[entry.id] ?? parseFragmentKey()
      ws.send(
        JSON.stringify(
          k
            ? { type: 'hello', role: 'client', token: t, e2e: E2E_ALG }
            : { type: 'hello', role: 'client', token: t },
        ),
      )
    }
    ws.onmessage = (e) => {
      if (socketsRef.current.get(entry.id) !== ws) return
      try {
        const msg = JSON.parse(String(e.data)) as {
          type?: string
          online?: boolean
          agent?: boolean
        }
        // `enc` payloads are opaque here — handled in the active session.
        if (msg?.type === 'enc') return
        if (msg?.type === 'paired') {
          clearTimeout(timeout)
          setConnectingId((cur) => (cur === entry.id ? null : cur))
          const agentPresent = msg.agent === true
          if (agentPresent) {
            onChange((prev) =>
              prev.map((x) => (x.id === entry.id ? { ...x, online: true } : x)),
            )
          } else {
            closeSocket(entry.id)
            onChange((prev) =>
              prev.map((x) => (x.id === entry.id ? { ...x, online: false } : x)),
            )
          }
        } else if (msg?.type === 'registered') {
          clearTimeout(timeout)
          setConnectingId((cur) => (cur === entry.id ? null : cur))
        } else if (msg?.type === 'agent') {
          const isOnline = msg.online === true
          if (isOnline) {
            onChange((prev) =>
              prev.map((x) => (x.id === entry.id ? { ...x, online: true } : x)),
            )
          } else {
            closeSocket(entry.id)
            onChange((prev) =>
              prev.map((x) => (x.id === entry.id ? { ...x, online: false } : x)),
            )
          }
        }
      } catch {
        // Binary relay payloads are handled in the active session.
      }
    }
    ws.onerror = () => {
      if (socketsRef.current.get(entry.id) !== ws) return
      clearTimeout(timeout)
      closeSocket(entry.id)
      setConnectingId((cur) => (cur === entry.id ? null : cur))
      setBanner('Relay connection failed. Is the Worker deployed with WSS support?')
    }
    ws.onclose = () => {
      if (socketsRef.current.get(entry.id) !== ws) return
      socketsRef.current.delete(entry.id)
      clearTimeout(timeout)
      setConnectingId((cur) => (cur === entry.id ? null : cur))
      onChange((prev) =>
        prev.map((x) => (x.id === entry.id ? { ...x, online: false } : x)),
      )
    }
  }

  const disconnectEntry = (id: string) => {
    closeSocket(id)
    setConnectingId((cur) => (cur === id ? null : cur))
    onChange((prev) =>
      prev.map((x) => (x.id === id ? { ...x, online: false } : x)),
    )
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const cleanName = name.trim()
    const cleanToken = token.trim().toUpperCase()
    if (!cleanName || !cleanToken) return
    if (!TOKEN_EXACT_RE.test(cleanToken)) {
      setBanner('Token is 5 or 9 letters/numbers — run `ks-ssh --token=` to get one.')
      return
    }
    // E2E key stays in memory only — validate (full link or raw `k`) but
    // never put it into `SshEntry` (persisted to localStorage).
    let cleanKey: string | null = null
    if (e2eOn) {
      cleanKey = extractKeyFromText(e2eKey)
      if (!cleanKey) {
        setE2eError('Enter the E2E key — paste the full share link (with #k=…) or the raw key.')
        return
      }
    }
    setE2eError(null)
    if (editingId) {
      const id = editingId
      onChange((prev) =>
        prev.map((x) =>
          x.id === id
            ? { ...x, name: cleanName, token: cleanToken, note: note.trim(), e2e: e2eOn }
            : x,
        ),
      )
      // Sync the memory-only key map (drop it when E2E is toggled off).
      setE2eKeys((prev) => {
        const next = { ...prev }
        if (e2eOn && cleanKey) next[id] = cleanKey
        else delete next[id]
        return next
      })
      // Drop the pasted text from form memory immediately.
      setE2eKey('')
      closeForm()
    } else {
      const id = `ssh-${Date.now().toString(36)}-${Math.floor(Math.random() * 10000)}`
      const next: SshEntry = {
        id,
        name: cleanName,
        token: cleanToken,
        note: note.trim(),
        online: false,
        e2e: e2eOn,
      }
      if (e2eOn && cleanKey) {
        const k = cleanKey
        setE2eKeys((prev) => ({ ...prev, [id]: k }))
      }
      onChange((prev) => [...prev, next])
      // Drop the pasted text from form memory immediately.
      setE2eKey('')
      closeForm()
      attemptConnect(next)
    }
  }

  const removeEntry = (id: string) => {
    closeSocket(id)
    setConnectingId((cur) => (cur === id ? null : cur))
    setE2eKeys((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    onChange((prev) => prev.filter((x) => x.id !== id))
  }

  // Visit URL: per-entry memory key first, then the URL fragment — so E2E
  // survives the navigation to raw /v/TOKEN. `k` stays in the fragment only.
  const visitUrl = (entry: SshEntry): string => {
    const t = entry.token.trim().toUpperCase()
    const k = e2eKeys[entry.id] ?? parseFragmentKey()
    return k ? `${relayBase}/v/${t}#k=${k}` : `${relayBase}/v/${t}`
  }

  const total = entries.length
  const online = entries.filter((x) => x.online).length

  return (
    <section className="page" aria-labelledby="page-title-ssh">
      <div className="page-head">
        <h1 id="page-title-ssh">SSH</h1>        <button
          type="button"
          className="btn btn-primary ssh-connect-btn"
          onClick={openNew}
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
          <span className="btn-label">Connect</span>
        </button>
      </div>

      <div className="grid">
        <div className="card">
          <span className="stat">{total}</span>
          <span>Total SSH</span>
        </div>
        <div className="card">
          <span className="stat">{online}</span>
          <span>Online</span>
        </div>
        <div className="card">
          <span className="stat">{total - online}</span>
          <span>Offline</span>
        </div>
      </div>

      {banner && (
        <div className="banner-error" role="alert">
          <p>{banner}</p>
          <div className="row-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                window.location.hash = '#/installation'
              }}
            >
              Open installation guide
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setBanner(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {formOpen && (
        <div className="card">
          <h2>{editingId ? 'Edit connection' : 'New connection'}</h2>          <form className="form" onSubmit={submit}>
            <label className="field">
              Name
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Home Lab"
                autoComplete="off"
                required
                autoFocus
              />
            </label>
            <label className="field">
              Token
              <input
                type="text"
                value={token}
                onChange={(e) => setToken(e.target.value.toUpperCase().slice(0, 9))}
                placeholder="A3K9Q"
                autoComplete="off"
                inputMode="text"
                maxLength={9}
                required
              />
            </label>
            <label className="field checkbox-row" style={{ gridColumn: '1 / -1' }}>
              <input
                type="checkbox"
                checked={e2eOn}
                onChange={(e) => {
                  setE2eOn(e.target.checked)
                  setE2eError(null)
                }}
              />
              E2E encrypted
            </label>
            {e2eOn && (
              <label className="field ssh-note-field">
                E2E key
                <span style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={e2eKey}
                    onChange={(e) => {
                      setE2eKey(e.target.value)
                      setE2eError(null)
                    }}
                    placeholder="Paste full share link (…/v/TOKEN#k=…) or raw key"
                    autoComplete="off"
                    spellCheck={false}
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setShowKey((v) => !v)}
                    aria-label={showKey ? 'Hide E2E key' : 'Show E2E key'}
                  >
                    {showKey ? 'Hide' : 'Show'}
                  </button>
                </span>
                {e2eError ? (
                  <span className="session-status" role="alert">
                    {e2eError}
                  </span>
                ) : formFp ? (
                  <span className="session-status session-hint">
                    🔒 fingerprint <code>{formFp}</code> (memory-only — re-enter after reload)
                  </span>
                ) : (
                  <span className="session-status session-hint">
                    Key stays in memory only — never stored. Paste once per session.
                  </span>
                )}
              </label>
            )}
            <label className="field ssh-note-field">
              Note
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What is this machine for? (optional)"
                autoComplete="off"
              />
            </label>
            <div className="row-actions">
              <button type="button" className="btn" onClick={closeForm}>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                {editingId ? 'Save' : 'Connect'}
              </button>
            </div>
          </form>
        </div>
      )}

      {entries.length === 0 && !formOpen ? (
        <div className="card" style={{ textAlign: 'center', padding: '48px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
          <h2 style={{ margin: 0 }}>No connections yet</h2>
          <svg
            width="120"
            height="120"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ opacity: 0.18 }}
          >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M7 9l3 3-3 3M12 15h5" />
          </svg>
        </div>
      ) : (
        <ul className="ssh-list">
          {entries.map((e) => {
            const connecting = e.id === connectingId
            const hasKey = Boolean(e2eKeys[e.id] ?? parseFragmentKey())
            return (
              <li key={e.id} className="card ssh-card">
                <div className="ssh-head">
                  <span className="ssh-icon" aria-hidden="true">
                    <SshGlyph />
                  </span>
                  <span className="ssh-name">{e.name}</span>
                  <StatusTag online={e.online} connecting={connecting} />
                </div>
                {e.e2e === true && (
                  <p className="session-status session-hint" style={{ margin: 0 }}>
                    {hasKey ? '🔒 E2E on' : '🔒 E2E on — key missing (edit to re-enter)'}
                  </p>
                )}
                <div className="ssh-foot">
                  {e.note ? <p className="ssh-note">{e.note}</p> : null}
                  <div className="row-actions">
                    {!e.online && (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={connecting}
                        onClick={() => attemptConnect(e)}
                      >
                        {connecting ? 'Connecting…' : 'Connect'}
                      </button>
                    )}
                      {e.online && (
                        <>
                          <a
                            className="btn btn-sm btn-primary"
                            href={visitUrl(e)}
                            aria-label={`Visit ${e.name}`}
                            title="Visit — open the full CLI frontend (Terminal, Files, Ports, Host) for this machine"
                          >
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1 2-2h6" />
                              <polyline points="15 3 21 3 21 9" />
                              <line x1="10" y1="14" x2="21" y2="3" />
                            </svg>
                            <span>Visit</span>
                          </a>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => disconnectEntry(e.id)}
                          aria-label={`Disconnect ${e.name}`}
                          title="Disconnect"
                        >
                          <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
                            <line x1="12" y1="2" x2="12" y2="12" />
                          </svg>
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => openEdit(e)}
                      aria-label={`Edit ${e.name}`}
                      title="Edit"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={() => removeEntry(e.id)}
                      aria-label={`Delete ${e.name}`}
                      title="Delete"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M3 6h18" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        <path d="M10 11v6M14 11v6" />
                      </svg>
                    </button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function SessionPage({
  token,
  name,
  settings,
}: {
  token: string | null
  name: string | null
  settings: Settings
}) {
  const relayBase = relayHttpBase(settings)
  const wsHost = relayWsHost(settings)
  const activeToken = token
  const [meta, setMeta] = useState<{ hasUi: boolean; size: number } | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [srcDoc, setSrcDoc] = useState<string | null>(null)
  const [cacheBust, setCacheBust] = useState(0)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // E2E lobby state: `k` lives ONLY in the fragment + memory (never fetch,
  // never storage). Missing `k` → paste-link prompt; wrong `k` surfaces as
  // `E2E error` from the live UI shim (decrypt-failed). Fingerprint TOFU
  // mirrors the CLI's printed `E2E fingerprint:` line.
  const [fragKey, setFragKey] = useState<string | null>(() => parseFragmentKey())
  const [paste, setPaste] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  // Fingerprint resolved for exactly `fpKey` (never stored — fp only).
  const [fpState, setFpState] = useState<{
    k: string
    fp: string
    changed: boolean
    first: boolean
  } | null>(null)
  const [gated, setGated] = useState(false)

  // Keep `k` in sync with the fragment (back/forward, paste-apply below).
  useEffect(() => {
    const onHash = () => setFragKey(parseFragmentKey())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Fingerprint + TOFU from the fragment key (async continuation only, so
  // no cascading render; stale keys never display — render gates on `k`).
  useEffect(() => {
    if (!fragKey || !activeToken) return
    let alive = true
    const k = fragKey
    const t = activeToken
    void fingerprintK(k)
      .then((f) => {
        if (!alive) return
        const tofu = checkTofu(t, f)
        setFpState({ k, fp: f, changed: tofu.changed, first: tofu.first })
      })
      .catch(() => {
        if (alive) setFpState(null)
      })
    return () => {
      alive = false
    }
  }, [fragKey, activeToken])

  const fp = fpState && fpState.k === fragKey ? fpState.fp : null
  const tofuChanged = fpState !== null && fpState.k === fragKey && fpState.changed
  const tofuFirst = fpState !== null && fpState.k === fragKey && fpState.first

  const applyPaste = () => {
    const k = extractKeyFromText(paste)
    if (!k) {
      setPasteError('No valid key found — paste the full link the CLI printed (it contains #k=…).')
      return
    }
    // Fragment-only: the key never touches query/fetch/storage. The pasted
    // text itself is dropped from memory immediately.
    const h = window.location.hash || '#/'
    const base = h.split('#k=')[0]!.split('&k=')[0]!.split('?k=')[0]!
    window.location.hash = `${base}#k=${k}`
    setPaste('')
    setPasteError(null)
    setFragKey(k)
  }

  const e2eStatus: E2eStatus = tofuChanged ? 'error' : fragKey ? 'on' : 'off'

  // Browser tab title follows the session.
  useEffect(() => {
    document.title =
      name != null
        ? `KS SSH — ${name}`
        : activeToken != null
          ? `KS SSH — Session ${activeToken}`
          : 'KS SSH — Session'
  }, [name, activeToken])

  // Check /api/ui/<token>/meta, then prefer raw /v/<token> iframe.
  // Fall back to WSS ui-request -> srcdoc when HTTP has no UI yet.
  useEffect(() => {
    if (!activeToken) return
    let cancelled = false
    const ctrl = new AbortController()
    setChecking(true)
    setError(null)
    setMeta(null)
    setSrcDoc(null)
    const load = async () => {
      try {
        const res = await fetch(`${relayBase}/api/ui/${activeToken}/meta`, {
          signal: ctrl.signal,
        })
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean
          hasUi?: boolean
          size?: number
        } | null
        if (cancelled) return
        if (res.ok && data?.hasUi) {
          setMeta({ hasUi: true, size: Number(data.size) || 0 })
          setChecking(false)
          return
        }
        // HTTP has nothing yet — try live WSS (agent may be mid-upload).
        await loadViaWss(activeToken, wsHost, ctrl.signal, cancelled, {
          setMeta,
          setSrcDoc,
          setError,
          setChecking,
        })
      } catch (e) {
        if (cancelled || ctrl.signal.aborted) return
        setError(e instanceof Error ? e.message : 'check failed')
        setChecking(false)
      }
    }
    void load()
    return () => {
      cancelled = true
      ctrl.abort()
    }
  }, [activeToken, cacheBust, relayBase, wsHost])

  // Live reload: when the agent re-pushes, the room broadcasts ui-ready.
  useEffect(() => {
    if (!activeToken || srcDoc !== null) return
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    let ws: WebSocket | null = null
    try {
      ws = new WebSocket(`${scheme}//${wsHost}/v1/client?token=${activeToken}`,
      )
    } catch {
      return
    }
    ws.onopen = () => {
      try {
        // Advertise E2E capability when the fragment carries `k`
        // (UI itself stays plaintext by design; session payloads use enc).
        const k = parseFragmentKey()
        ws?.send(
          JSON.stringify(
            k
              ? { type: 'hello', role: 'client', token: activeToken, e2e: E2E_ALG }
              : { type: 'hello', role: 'client', token: activeToken },
          ),
        )
      } catch {
        // Ignore — reload happens on next check.
      }
    }
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data)) as {
          type?: string
          gated?: boolean
          relay_auth?: boolean
          online?: boolean
        }
        // `enc` is opaque sealed traffic — ignore here (UI is plaintext).
        if (msg?.type === 'enc') return
        // Agent presence: surface offline errors instead of hanging.
        if (msg?.type === 'agent' && msg.online === false) {
          setError('Agent went offline — is the CLI still running?')
          try { ws?.close() } catch { /* already closed */ }
          return
        }
        // `--relay-auth`: the room/agent advertises gating so the lobby can
        // prompt for the PIN (enforcement is agent-side, PIN inside `enc`).
        if (msg?.gated === true || msg?.relay_auth === true) setGated(true)
        if (msg?.type === 'ui-ready') {
          if (msg?.gated === true) setGated(true)
          setCacheBust((n) => n + 1)
        }
      } catch {
        // Non-JSON relay traffic — ignore here.
      }
    }
    return () => {
      try {
        ws?.close()
      } catch {
        // Already closed — ignore.
      }
    }
  }, [activeToken, srcDoc, wsHost])

  const openFullscreen = async () => {
    try {
      const el = wrapRef.current
      if (el?.requestFullscreen) {
        await el.requestFullscreen()
      } else if (activeToken) {
        // Fallback: raw /v/ page in a new tab is already fullscreen-capable.
        // Preserve #k=... so E2E survives.
        const k = parseFragmentKey()
        window.open(k ? `${relayBase}/v/${activeToken}#k=${k}` : `${relayBase}/v/${activeToken}`, '_blank', 'noopener')
      }
    } catch {
      setError('Fullscreen blocked — use "Open raw" in a new tab instead.')
    }
  }

  // WSS-fetched bundles render as srcDoc (opaque origin) — inject the relay
  // token/host so the bundled shim tunnels /api/* + /v1/shell over WSS to
  // the agent's loopback server (same functionality as local --port).
  // (Above the empty-token early return: hooks must run unconditionally.)
  const injectedSrcDoc = useMemo(() => {
    if (srcDoc === null || !activeToken) return null
    try {
      return withRelayGlobals(srcDoc, activeToken, wsHost)
    } catch {
      return srcDoc
    }
  }, [srcDoc, activeToken, wsHost])

  if (!activeToken) {
    return (
      <section className="page" aria-labelledby="page-title-session">
        <h1 id="page-title-session">Session</h1>
        <p className="lead">No session selected.</p>
        <div className="card">
          <p>Pick a connection from the SSH page to open its fullscreen UI.</p>
          <div className="row-actions">
            <a className="btn btn-primary" href="#/ssh">
              Open SSH
            </a>
          </div>
        </div>
      </section>
    )
  }

  const frameSrc =
    meta?.hasUi && srcDoc === null
      ? `${relayBase}/v/${activeToken}${cacheBust ? `?t=${cacheBust}` : ''}`
      : undefined

  return (
    <section className="page page-session-full" aria-labelledby="page-title-session">
      <div className="page-head session-head">
        <h1 id="page-title-session">{name ?? `Session ${activeToken}`}</h1>
        <div className="row-actions session-actions">
          <E2eBadge status={e2eStatus} />
          {(meta?.hasUi || srcDoc) && (
            <>
              <button type="button" className="btn btn-sm" onClick={() => setCacheBust((n) => n + 1)}>
                Reload
              </button>
              <button type="button" className="btn btn-sm btn-primary" onClick={openFullscreen}>
                Fullscreen
              </button>
              <a
                className="btn btn-sm"
                href={(() => {
                  const k = parseFragmentKey()
                  return k
                    ? `${relayBase}/v/${activeToken}#k=${k}`
                    : `${relayBase}/v/${activeToken}`
                })()}
                target="_blank"
                rel="noreferrer"
              >
                Open raw
              </a>
            </>
          )}
          <a className="btn btn-sm" href="#/ssh">
            Back
          </a>
        </div>
      </div>
      {tofuChanged && fp && (
        <div className="banner-error" role="alert">
          <p>
            🔒 E2E fingerprint changed (<code>{fp}</code>) — the agent key
            rotated or this link is wrong. Verify against the CLI&apos;s
            printed <code>E2E fingerprint</code> before continuing.
          </p>
        </div>
      )}
      {!fragKey && (
        <div className="card" role="group" aria-labelledby="e2e-paste-title">
          <h2 id="e2e-paste-title">End-to-end encrypted link required</h2>
          <p className="lead">
            This session seals terminal and file traffic with AES-256-GCM, and
            the key opens only from the full link the CLI printed
            (<code>/v/{activeToken}#k=…</code>). Paste it once — the key stays
            in the fragment and memory, never in fetch URLs or storage.
          </p>
          <div className="form">
            <label className="field">
              Full share link (with <code>#k=…</code>)
              <input
                type="text"
                value={paste}
                onChange={(e) => {
                  setPaste(e.target.value)
                  setPasteError(null)
                }}
                placeholder={`https://…/v/${activeToken}#k=…`}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          </div>
          {pasteError && (
            <p className="session-status" role="alert">
              {pasteError}
            </p>
          )}
          <div className="row-actions">
            <button type="button" className="btn btn-sm btn-primary" onClick={applyPaste}>
              Unlock with pasted link
            </button>
          </div>
        </div>
      )}
      {fragKey && fp && (
        <p className="session-status session-hint">
          🔒 E2E fingerprint <code>{fp}</code>
          {tofuFirst ? ' (first seen on this device — compare with the CLI)' : ' (matches this device)'}
          {gated ? ' · 🔐 viewer PIN required inside the live UI' : ''}.
        </p>
      )}
      {fragKey && gated && (
        <p className="session-status session-hint">
          This link is PIN-gated (<code>--relay-auth</code>): the live UI will
          prompt for the viewer PIN. The PIN travels inside E2E only — never
          in query strings or logs.
        </p>
      )}
      {checking && (
        <p className="session-status" aria-live="polite">
          Checking for agent UI …
        </p>
      )}
      {meta?.hasUi && !srcDoc && (
        <p className="session-status session-hint">
          Live from your CLI over WSS — Terminal, Files, Ports, Host in one page
          {typeof meta.size === 'number' && meta.size > 0
            ? ` · ${Math.round(meta.size / 1024)} KB`
            : ''}
          .
        </p>
      )}
      {error && (
        <div className="banner-error" role="alert">
          <p>{error}</p>
          <div className="row-actions">
            <button type="button" className="btn btn-sm" onClick={() => setCacheBust((n) => n + 1)}>
              Retry
            </button>
          </div>
        </div>
      )}
      {!checking && !meta?.hasUi && !srcDoc && !error && (
        <div className="card">
          <p>
            Waiting for the agent UI for <code>{activeToken}</code>. On the
            machine, run: <code>ks-ssh --token={activeToken}</code> (same UI
            as <code>--port</code>, pushed over WSS — no port forwarding).
          </p>
          <div className="row-actions">
            <button type="button" className="btn btn-sm" onClick={() => setCacheBust((n) => n + 1)}>
              Reload
            </button>
          </div>
        </div>
      )}

      {(meta?.hasUi || injectedSrcDoc) && (
        <div className="session-wrap-full" ref={wrapRef}>
          {injectedSrcDoc !== null ? (
            <iframe
              title={`Agent UI ${activeToken} — Terminal, Files, Ports, Host`}
              className="session-frame-full"
              srcDoc={injectedSrcDoc}
              allow="fullscreen; clipboard-read; clipboard-write"
              allowFullScreen
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
            />
          ) : (
            <iframe
              title={`Agent UI ${activeToken} — Terminal, Files, Ports, Host`}
              className="session-frame-full"
              src={frameSrc}
              allow="fullscreen; clipboard-read; clipboard-write"
              allowFullScreen
            />
          )}
        </div>
      )}
    </section>
  )
}

async function loadViaWss(
  token: string,
  wsHost: string,
  signal: AbortSignal,
  cancelled: boolean,
  hooks: {
    setMeta: (m: { hasUi: boolean; size: number } | null) => void
    setSrcDoc: (s: string | null) => void
    setError: (s: string | null) => void
    setChecking: (b: boolean) => void
  },
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || cancelled) {
      resolve()
      return
    }
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    let ws: WebSocket
    try {
      ws = new WebSocket(`${scheme}//${wsHost}/v1/client?token=${token}`)
    } catch {
      hooks.setError(`No UI for ${token} yet — is the CLI running with --token=${token}?`)
      hooks.setChecking(false)
      resolve()
      return
    }
    let chunks: (string | null)[] | null = null
    const timeout = setTimeout(() => {
      try {
        ws.close()
      } catch {
        // Already closed — ignore.
      }
      if (!cancelled && !signal.aborted) {
        hooks.setError(
          `No UI for ${token} yet. Run: ks-ssh --token=${token}`,
        )
        hooks.setChecking(false)
      }
      resolve()
    }, 10000)
    const done = (ok: boolean) => {
      clearTimeout(timeout)
      try {
        ws.close()
      } catch {
        // Already closed — ignore.
      }
      resolve()
      void ok
    }
    signal.addEventListener('abort', () => {
      clearTimeout(timeout)
      try {
        ws.close()
      } catch {
        // Already closed — ignore.
      }
      resolve()
    })
    ws.onopen = () => {
      // hello carries token+role only (no k); e2e advertises capability.
      // `k` never leaves fragment/memory. ui-request stays plaintext
      // (UI bundle exception — public build output).
      const k = parseFragmentKey()
      ws.send(
        JSON.stringify(
          k
            ? { type: 'hello', role: 'client', token, e2e: E2E_ALG }
            : { type: 'hello', role: 'client', token },
        ),
      )
      ws.send(JSON.stringify({ type: 'ui-request' }))
    }
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data)) as {
          type?: string
          encoding?: string
          size?: number
          chunks?: number
          i?: number
          data?: string
        }
        // `enc` is opaque sealed session traffic — ignore for UI fetch.
        if (msg?.type === 'enc') return
        if (msg?.type === 'ui-begin') {
          const n = Number(msg.chunks) || 0
          if (n > 0 && n <= 256) chunks = new Array(n).fill(null)
          return
        }
        if (msg?.type === 'ui-chunk' && chunks) {
          const i = Number(msg.i)
          if (Number.isInteger(i) && i >= 0 && i < chunks.length && typeof msg.data === 'string') {
            chunks[i] = msg.data
          }
          return
        }
        if (msg?.type === 'ui-end' && chunks) {
          if (chunks.some((c) => c === null)) return
          try {
            const html = decodeUiChunks(chunks as string[])
            if (cancelled || signal.aborted) {
              done(false)
              return
            }
            hooks.setSrcDoc(html)
            hooks.setMeta({ hasUi: true, size: html.length })
            hooks.setChecking(false)
          } catch {
            hooks.setError('UI decode failed — try Reload.')
            hooks.setChecking(false)
          }
          done(true)
          return
        }
        if (msg?.type === 'ui-missing' || msg?.type === 'ui-error') {
          if (!cancelled && !signal.aborted) {
            hooks.setError(`No UI for ${token} yet. Run: ks-ssh --token=${token}`)
            hooks.setChecking(false)
          }
          done(false)
        }
      } catch {
        // Opaque relay traffic — ignore.
      }
    }
    ws.onerror = () => {
      if (!cancelled && !signal.aborted && chunks === null) {
        hooks.setError(`No UI for ${token} yet. Run: ks-ssh --token=${token}`)
        hooks.setChecking(false)
      }
      done(false)
    }
  })
}

function decodeUiChunks(chunks: string[]): string {
  let total = 0
  const parts: Uint8Array[] = chunks.map((b64) => {
    const bin = atob(b64)
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    total += arr.length
    return arr
  })
  const all = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    all.set(p, off)
    off += p.length
  }
  return new TextDecoder().decode(all)
}

function InstallationPage() {
  return (
    <section className="page" aria-labelledby="page-title-installation">
      <h1 id="page-title-installation">Installation</h1>
      <div className="card">
        <h2>1. Download the agent</h2>
        <p>Paste this in your terminal to download and run:</p>
        <CodeBlock code="curl -sSfL https://raw.githubusercontent.com/kswarrior/ks-ssh-v2/refs/heads/main/cli/release/ks-ssh -o ks-ssh && chmod +x ks-ssh && ./ks-ssh --help" />
      </div>
      <div className="card">
        <h2>2. Local UI (same machine)</h2>
        <p>Serves Terminal, Files, Ports and Host on loopback:</p>
        <CodeBlock code="./ks-ssh --port 8080" />
        <p className="session-status session-hint">Open http://127.0.0.1:8080 in a browser on that machine.</p>
      </div>
      <div className="card">
        <h2>3. Relay (no open port)</h2>
        <p>Registers a fresh 9-character token and prints a share link with #k=…:</p>
        <CodeBlock code="./ks-ssh --no-serve --token=" />
        <p>Paste the printed token into the SSH page, then open it from the full share link so E2E works.</p>
      </div>
      <div className="card">
        <h2>4. Relay + local UI together</h2>
        <CodeBlock code="./ks-ssh --token=ABCDE1234" />
        <p className="session-status session-hint">Reuses your token; omit the value (--token=) to mint a fresh one.</p>
      </div>
      <div className="card">
        <h2>5. Viewer PIN (optional)</h2>
        <p>Require a one-time PIN sealed inside E2E before any shell or file bridge:</p>
        <CodeBlock code="./ks-ssh --no-serve --token= --relay-auth" />
      </div>
      <div className="card">
        <h2>Verify</h2>
        <p>Confirm this relay answers, then check a token:</p>
        <CodeBlock code={`curl -s ${typeof window !== 'undefined' ? window.location.origin : 'https://<relay-host>'}/api/health`} />
        <CodeBlock code={`curl -s "${typeof window !== 'undefined' ? window.location.origin : 'https://<relay-host>'}/api/ssh/status?token=ABCDE1234"`} />
        <div className="row-actions">
          <a className="btn btn-sm btn-primary" href="#/ssh">
            Open SSH
          </a>
        </div>
      </div>
    </section>
  )
}

function SettingsPage({
  settings,
  onChange,
  theme,
  onTheme,
  entryCount,
  onClearData,
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  theme: Theme
  onTheme: (t: Theme) => void
  entryCount: number
  onClearData: () => void
}) {
  const [confirmClear, setConfirmClear] = useState(false)
  return (
    <section className="page" aria-labelledby="page-title-settings">
      <h1 id="page-title-settings">Settings</h1>
      <p className="lead">Settings save automatically on this device and take effect immediately.</p>
      <div className="card">
        <h2>Relay</h2>
        <div className="form">
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            Relay host (empty = this Worker)
            <input
              type="text"
              value={settings.relayHost}
              onChange={(e) => onChange({ relayHost: e.target.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').slice(0, 253) })}
              placeholder={typeof window !== 'undefined' ? window.location.host : 'ks-ssh-v2.kswarriorpro.workers.dev'}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="field">
            Presence timeout (ms)
            <input
              type="number"
              value={settings.connectTimeoutMs}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10)
                onChange({ connectTimeoutMs: Number.isFinite(n) ? Math.min(30000, Math.max(3000, n)) : 8000 })
              }}
              min={3000}
              max={30000}
              step={1000}
            />
          </label>
          <label className="field checkbox-row">
            <input
              type="checkbox"
              checked={settings.requireE2E}
              onChange={(e) => onChange({ requireE2E: e.target.checked })}
            />
            Require E2E key (#k=…) for live sessions
          </label>
        </div>
        <div className="row-actions">
          <button type="button" className="btn btn-sm" onClick={() => onChange({ relayHost: DEFAULT_RELAY_HOST })}>
            Reset relay host
          </button>
          <span className="session-status session-hint">
            WSS connects to {relayWsHost(settings)} · HTTP via {relayHttpBase(settings) || '(same origin)'} · timeout{' '}
            {Math.round(settings.connectTimeoutMs / 1000)}s
          </span>
        </div>
      </div>
      <div className="card">
        <h2>Appearance</h2>
        <div className="row-actions">
          <button
            type="button"
            className={`btn btn-sm${theme === 'light' ? ' btn-primary' : ''}`}
            aria-pressed={theme === 'light'}
            onClick={() => onTheme('light')}
          >
            Light
          </button>
          <button
            type="button"
            className={`btn btn-sm${theme === 'dark' ? ' btn-primary' : ''}`}
            aria-pressed={theme === 'dark'}
            onClick={() => onTheme('dark')}
          >
            Dark
          </button>
        </div>
      </div>
      <div className="card">
        <h2>Local data</h2>
        <p>
          {entryCount} saved connection{entryCount === 1 ? '' : 's'} on this device (tokens stay in your browser).
        </p>
        {!confirmClear ? (
          <div className="row-actions">
            <button type="button" className="btn btn-sm btn-danger" onClick={() => setConfirmClear(true)}>
              Clear all local data
            </button>
          </div>
        ) : (
          <div className="row-actions">
            <span className="session-status">Delete all connections and settings on this device?</span>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => {
                onClearData()
                setConfirmClear(false)
              }}
            >
              Yes, delete everything
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setConfirmClear(false)}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </section>
  )
}

export default function App() {
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<PageId>(
    () =>
      (typeof window !== 'undefined'
        ? hashToPage(window.location.hash)
        : null) ?? 'home',
  )
  const [sessionToken, setSessionToken] = useState<string | null>(() =>
    typeof window !== 'undefined'
      ? hashToSessionToken(window.location.hash)
      : null,
  )
  const isMobile = useIsMobile(768)
  const btnRef = useRef<HTMLButtonElement>(null)
  const asideRef = useRef<HTMLElement>(null)
  const mainRef = useRef<HTMLElement>(null)

  const [settings, setSettings] = useState<Settings>(() =>
    normalizeSettings(readJSON<unknown>('ks-ssh:settings', DEFAULT_SETTINGS)),
  )
  const [entries, setEntries] = useState<SshEntry[]>(() => {
    try {
      // Drop the legacy demo store if it exists.
      localStorage.removeItem('ks-ssh:servers')
    } catch {
      // Storage unavailable — nothing to clean.
    }
    const saved = readJSON<unknown>('ks-ssh:ssh', null)
    if (!Array.isArray(saved)) return []
    // Drop demo seeds and malformed rows — only real user data survives.
    return (saved as SshEntry[]).filter(
      (x) =>
        x &&
        typeof x.id === 'string' &&
        !x.id.startsWith('seed-') &&
        typeof x.name === 'string' &&
        x.name.trim() !== '',
    )
  })
  const [theme, setTheme] = useState<Theme>(initialTheme)

  // Derived state: drawer can only be open on phones; resizing to desktop
  // auto-closes it without a setState-in-effect cascade.
  const drawerOpen = isMobile && open

  // Keep page in sync with the URL hash (back/forward buttons, deep links).
  // Unknown hashes (e.g. #main from the skip link) are ignored.
  useEffect(() => {
    const onHash = () => {
      const next = hashToPage(window.location.hash)
      if (next) setPage(next)
      setSessionToken(hashToSessionToken(window.location.hash))
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Browser tab title follows the active page.
  // (The session page sets its own title with the connection name.)
  useEffect(() => {
    if (page === 'session') return
    const label = NAV.find((p) => p.id === page)?.label
    document.title = label && label !== 'Home' ? `KS SSH — ${label}` : 'KS SSH'
  }, [page])

  // Apply + persist the neumorphic light/dark theme.
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    try {
      localStorage.setItem('ks-ssh:theme', theme)
    } catch {
      // Storage unavailable — theme still applies for this session.
    }
  }, [theme])

  useEffect(() => {
    writeJSON('ks-ssh:settings', settings)
  }, [settings])

  useEffect(() => {
    writeJSON('ks-ssh:ssh', entries)
  }, [entries])

  // Lock background scroll while the phone drawer is open
  useEffect(() => {
    if (!drawerOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [drawerOpen])

  // Escape closes + returns focus to the hamburger
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        btnRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen])

  // Keep hidden drawer out of keyboard / screen-reader flow on phones.
  // (toggleAttribute avoids React `inert` typing gaps across versions.)
  useEffect(() => {
    const el = asideRef.current
    if (!el) return
    const hidden = isMobile && !drawerOpen
    el.toggleAttribute('inert', hidden)
  }, [isMobile, drawerOpen])

  const drawerHidden = isMobile && !drawerOpen

  const patchSettings = (patch: Partial<Settings>) =>
    setSettings((prev) => normalizeSettings({ ...prev, ...patch }))

  const clearAllData = () => {
    setEntries([])
    setSettings({ ...DEFAULT_SETTINGS })
    try {
      localStorage.removeItem('ks-ssh:ssh')
      localStorage.removeItem('ks-ssh:settings')
      sessionStorage.clear()
    } catch {
      // Storage unavailable — in-memory state already cleared.
    }
  }

  const sessionName =
    sessionToken != null
      ? (entries.find(
          (x) => x.token.trim().toUpperCase() === sessionToken,
        )?.name ?? null)
      : null

  const onNavClick = () => {
    if (isMobile) {
      setOpen(false)
      btnRef.current?.focus()
    } else {
      // Move screen-reader/keyboard focus to the new page.
      window.requestAnimationFrame(() => {
        mainRef.current?.focus({ preventScroll: true })
      })
    }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <div
        className={`overlay${drawerOpen ? ' show' : ''}`}
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />
      <aside
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ref={asideRef as any}
          id="app-sidebar"
          className={`sidebar${drawerOpen ? ' open' : ''}`}
          aria-hidden={drawerHidden ? true : undefined}
          aria-label="Primary"
        >
          <nav aria-label="Primary">
            {NAV.map((item) => {
              const isActive = item.id === page
              return (
                <a
                  key={item.id}
                  href={item.hash}
                  className={isActive ? 'active' : undefined}
                  aria-current={isActive ? 'page' : undefined}
                  tabIndex={drawerHidden ? -1 : undefined}
                  onClick={onNavClick}
                >
                  {item.label}
                </a>
              )
            })}
            {page === 'session' && sessionToken && (
              <a
                key="session"
                href={`#/session/${sessionToken}`}
                className="active"
                aria-current="page"
                tabIndex={drawerHidden ? -1 : undefined}
                onClick={onNavClick}
              >
                {sessionName ?? `Session ${sessionToken}`}
              </a>
            )}
          </nav>
        </aside>

        <div className="app-main">
          <header className="app-header">
            <button
              ref={btnRef}
              type="button"
              className={`hamburger${drawerOpen ? ' is-open' : ''}`}
              aria-label={drawerOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={drawerOpen}
              aria-controls="app-sidebar"
              onClick={() => setOpen((v) => !v)}
            >
              <span aria-hidden="true" />
              <span aria-hidden="true" />
              <span aria-hidden="true" />
            </button>
            <span className="header-brand" aria-label="KS SSH">
              <svg viewBox="0 0 32 32" aria-hidden="true">
                <defs>
                  <linearGradient id="ks-logo-g" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" style={{ stopColor: 'var(--accent-hi)' }} />
                    <stop offset="0.6" style={{ stopColor: 'var(--accent-lo)' }} />
                    <stop offset="1" style={{ stopColor: 'var(--accent-glow)' }} />
                  </linearGradient>
                </defs>
                <rect
                  x="1"
                  y="1"
                  width="30"
                  height="30"
                  rx="8"
                  fill="url(#ks-logo-g)"
                  stroke="rgba(255,255,255,0.25)"
                />
                <path
                  d="M10 12l5 4-5 4M17 20h6"
                  stroke="#fff"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
              <span className="header-brand-text" aria-hidden="true">
                KS SSH
              </span>
            </span>
            <span className="header-spacer" />
            <button
              type="button"
              className="icon-btn"
              aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
              title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
              onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
            >
              {theme === 'light' ? (
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              ) : (
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                </svg>
              )}
            </button>
          </header>

          <main
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ref={mainRef as any}
          className={`content${page === 'session' ? ' content-session' : ''}`}
          id="main"
          tabIndex={-1}
        >
          {page === 'home' && <HomePage />}
          {page === 'ssh' && <SSHPage entries={entries} onChange={setEntries} settings={settings} />}
          {page === 'session' && (
            <SessionPage
              key={sessionToken ?? 'none'}
              token={sessionToken}
              name={sessionName}
              settings={settings}
            />
          )}
          {page === 'installation' && <InstallationPage />}
          {page === 'settings' && (
            <SettingsPage
              settings={settings}
              onChange={patchSettings}
              theme={theme}
              onTheme={setTheme}
              entryCount={entries.length}
              onClearData={clearAllData}
            />
          )}
        </main>
      </div>
    </div>
  )
}
