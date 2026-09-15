import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import {
  E2E_ALG,
  extractKeyFromText,
  fingerprintK,
  parseFragmentKey,
} from './e2e'

/** Token pattern: 9 chars fresh, 5 chars legacy — both route. */
const TOKEN_EXACT_RE = /^(?:[A-Za-z0-9]{5}|[A-Za-z0-9]{9})$/

type PageId = 'home' | 'ssh' | 'ssh-add' | 'ssh-edit' | 'ssh-visit' | 'installation' | 'settings'

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

const E2E_KEYS_STORAGE = 'ks-ssh:e2e'

/** Saved E2E keys by entry id (survives reload; dropped with the entry). */
function readE2eKeys(): Record<string, string> {
  try {
    const raw = localStorage.getItem(E2E_KEYS_STORAGE)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [id, k] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof id === 'string' && typeof k === 'string' && k.length > 0) {
        out[id] = k
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeE2eKeys(keys: Record<string, string>) {
  try {
    if (Object.keys(keys).length === 0) {
      localStorage.removeItem(E2E_KEYS_STORAGE)
    } else {
      localStorage.setItem(E2E_KEYS_STORAGE, JSON.stringify(keys))
    }
  } catch {
    // Storage unavailable (private mode) — keys still work for this session.
  }
}

/** Map a location hash to a page, or null when it is not a page route. */
function hashToPage(hash: string): PageId | null {
  const clean = hash.replace(/^#\/?/, '')
  if (clean === 'ssh/add' || clean === 'ssh-add') return 'ssh-add'
  if (clean.startsWith('ssh/edit/') || clean.startsWith('ssh-edit/')) return 'ssh-edit'
  if (clean.startsWith('ssh/visit/') || clean.startsWith('ssh-visit/')) return 'ssh-visit'
  const found = NAV.find((p) => p.hash.replace(/^#\/?/, '') === clean)
  return found ? found.id : null
}

function hashToSshEditId(hash: string): string | null {
  const m = hash.match(/^#\/?ssh\/edit\/([^/?#]+)/) ?? hash.match(/^#\/?ssh-edit\/([^/?#]+)/)
  return m?.[1] ? decodeURIComponent(m[1]) : null
}

function hashToSshVisitId(hash: string): string | null {
  const m = hash.match(/^#\/?ssh\/visit\/([^/?#]+)/) ?? hash.match(/^#\/?ssh-visit\/([^/?#]+)/)
  return m?.[1] ? decodeURIComponent(m[1]) : null
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

function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode
  delay?: number
  className?: string
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(() => {
    if (typeof window === 'undefined') return true
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true
    if (typeof IntersectionObserver === 'undefined') return true
    return false
  })

  useEffect(() => {
    if (visible) return
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setVisible(true)
            obs.disconnect()
          }
        }
      },
      { threshold: 0.1, rootMargin: '0px 0px -6% 0px' },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [visible])

  return (
    <div
      ref={ref}
      className={`reveal${visible ? ' is-visible' : ''}${className ? ` ${className}` : ''}`}
      style={{ '--reveal-delay': `${delay}ms` } as CSSProperties}
    >
      {children}
    </div>
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
  // itself lives in the saved `e2eKeys` map, never in the entry row).
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
      <Reveal>
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
      </div>
      </Reveal>

      <Reveal delay={110}>
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
      </Reveal>

      <Reveal delay={60}>
        <h2 className="home-section-title">Why us</h2>
      </Reveal>
      <div className="grid home-grid">
        <Reveal delay={0} className="home-tile">
        <FeatureTile
          icon={<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />}
          title="Fast"
          text="Connect in one tap with your saved token. No typing addresses twice."
        />
        </Reveal>
        <Reveal delay={110} className="home-tile">
        <FeatureTile
          icon={<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />}
          title="Private"
          text="Tokens stay in your browser. Shell traffic is E2E-sealed with AES-256-GCM."
        />
        </Reveal>
        <Reveal delay={220} className="home-tile">
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
        </Reveal>
        <Reveal delay={330} className="home-tile">
        <FeatureTile
          icon={
            <>
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </>
          }
          title="Everything in one panel"
          text="Terminal, Files, Ports and Host in a single UI — a real PTY with tabs and splits, a HOME-jailed file editor, live ports with per-port kill, and per-core host metrics."
        />
        </Reveal>
        <Reveal delay={440} className="home-tile">
        <FeatureTile
          icon={
            <>
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </>
          }
          title="Identity and audit"
          text="Multi-user login with Argon2id passwords, admin/operator/viewer roles plus TOTP and optional SSO — every shell recorded for replay and every action kept in an exportable audit log."
        />
        </Reveal>
        <Reveal delay={550} className="home-tile">
        <FeatureTile
          icon={
            <>
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </>
          }
          title="Local, relay, or both"
          text="Serve the UI on your own port, reach it with no open ports over the relay, or run both together from one command — the same UI everywhere."
        />
        </Reveal>
      </div>
    </section>
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
  // Saved E2E keys by entry id (persisted to localStorage, survives reload).
  const [e2eKeys, setE2eKeys] = useState<Record<string, string>>(() =>
    readE2eKeys(),
  )

  // Persist the key map (dropping the storage row when empty).
  useEffect(() => {
    writeE2eKeys(e2eKeys)
  }, [e2eKeys])
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const socketsRef = useRef(new Map<string, WebSocket>())
  const didInitialRefresh = useRef(false)

  const openWatchSocket = (entry: SshEntry) => {
    const t = entry.token.trim().toUpperCase()
    if (!TOKEN_EXACT_RE.test(t)) return
    if (socketsRef.current.has(entry.id)) return
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    let ws: WebSocket
    try {
      ws = new WebSocket(`${scheme}//${wsHost}/v1/client?token=${t}`)
    } catch {
      return
    }
    socketsRef.current.set(entry.id, ws)
    ws.onopen = () => {
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
        if (msg?.type === 'enc') return
        if (msg?.type === 'paired') {
          const agentPresent = msg.agent === true
          onChange((prev) =>
            prev.map((x) => (x.id === entry.id ? { ...x, online: agentPresent } : x)),
          )
          if (!agentPresent) closeSocket(entry.id)
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
        // Non-JSON or opaque — ignore.
      }
    }
    ws.onclose = () => {
      if (socketsRef.current.get(entry.id) !== ws) return
      socketsRef.current.delete(entry.id)
      onChange((prev) =>
        prev.map((x) => (x.id === entry.id ? { ...x, online: false } : x)),
      )
    }
    ws.onerror = () => {
      if (socketsRef.current.get(entry.id) !== ws) return
      closeSocket(entry.id)
      onChange((prev) =>
        prev.map((x) => (x.id === entry.id ? { ...x, online: false } : x)),
      )
    }
  }

  const refreshStatuses = async () => {
    if (entries.length === 0) return
    setRefreshing(true)
    setBanner(null)
    try {
      const results = await Promise.all(
        entries.map(async (e) => {
          const t = e.token.trim().toUpperCase()
          if (!TOKEN_EXACT_RE.test(t)) return { id: e.id, online: false }
          try {
            const res = await fetch(
              `${relayBase}/api/ssh/status?token=${encodeURIComponent(t)}`,
              { cache: 'no-store' },
            )
            if (!res.ok) return { id: e.id, online: false }
            const data = (await res.json()) as {
              ok?: boolean
              agentOnline?: boolean
            }
            return { id: e.id, online: data.agentOnline === true }
          } catch {
            return { id: e.id, online: false }
          }
        }),
      )
      const map = new Map(results.map((r) => [r.id, r.online]))
      let newlyOnline: SshEntry[] = []
      onChange((prev) => {
        const next = prev.map((x) => {
          const v = map.get(x.id)
          if (v === undefined) return x
          if (x.online !== v) {
            if (!v) closeSocket(x.id)
            return { ...x, online: v }
          }
          return x
        })
        newlyOnline = next.filter((x) => x.online && !socketsRef.current.has(x.id))
        return next
      })
      // Give React a tick to flush state, then open watches for online entries.
      // Use the freshly computed list.
      setTimeout(() => {
        for (const e of newlyOnline) openWatchSocket(e)
      }, 0)
    } finally {
      setRefreshing(false)
    }
  }

  // On page load / refresh, recheck relay so stale persisted `online:true` never shows.
  useEffect(() => {
    if (didInitialRefresh.current) return
    didInitialRefresh.current = true
    if (entries.length === 0) return
    void refreshStatuses()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, [])

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

  const openNew = () => {
    window.location.hash = '#/ssh/add'
  }

  const openEdit = (e: SshEntry) => {
    window.location.hash = `#/ssh/edit/${encodeURIComponent(e.id)}`
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
      // is available — saved per-entry key first, then the URL fragment.
      // `k` itself never leaves storage/fragment.
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

  const total = entries.length
  const online = entries.filter((x) => x.online).length

  return (
    <section className="page page-ssh" aria-labelledby="page-title-ssh">
      <div className="page-head">
        <h1 id="page-title-ssh">SSH</h1>
        <div className="row-actions" style={{ marginTop: 0, paddingTop: 0, marginLeft: 'auto' }}>
          <button
            type="button"
            className="btn ssh-refresh-btn"
            onClick={() => void refreshStatuses()}
            disabled={refreshing || entries.length === 0}
            aria-label="Refresh status"
            title={refreshing ? 'Refreshing…' : 'Refresh — recheck relay for live status'}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              style={refreshing ? { animation: 'spin 0.9s linear infinite' } : undefined}
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            <span className="btn-label">{refreshing ? 'Refreshing…' : 'Refresh'}</span>
          </button>
          <button
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
      </div>

      <Reveal delay={60}>
      <div className="grid ssh-stats">
        <div className="card stat-card">
          <span className="stat">{total}</span>
          <span>Total SSH</span>
        </div>
        <div className="card stat-card">
          <span className="stat">{online}</span>
          <span>Online</span>
        </div>
        <div className="card stat-card">
          <span className="stat">{total - online}</span>
          <span>Offline</span>
        </div>
      </div>
      </Reveal>

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

      {entries.length === 0 ? (
        <Reveal>
        <div className="card empty-card" style={{ textAlign: 'center', padding: '48px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
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
        </Reveal>
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
                  <div className="ssh-head-main">
                    <span className="ssh-name">{e.name}</span>
                    {e.e2e === true && (
                      <span className="tag e2e-tag">
                        {hasKey ? '🔒 E2E on' : '🔒 E2E on — key missing'}
                      </span>
                    )}
                  </div>
                  <StatusTag online={e.online} connecting={connecting} />
                </div>
                <div className="ssh-foot">
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
                            href={`#/ssh/visit/${encodeURIComponent(e.id)}`}
                            aria-label={`Visit ${e.name}`}
                            title="Visit — open the full CLI frontend via CF loader (Terminal, Files, Ports, Host)"
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

function SshAddPage({
  entries,
  onChange,
  settings,
}: {
  entries: SshEntry[]
  onChange: (fn: (prev: SshEntry[]) => SshEntry[]) => void
  settings: Settings
}) {
  const relayBase = relayHttpBase(settings)
  const [name, setName] = useState('')
  const [token, setToken] = useState('')
  const [e2eOn, setE2eOn] = useState(false)
  const [e2eKey, setE2eKey] = useState('')
  const [e2eError, setE2eError] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [keyFp, setKeyFp] = useState<{ k: string; fp: string } | null>(null)
  const [banner, setBanner] = useState<string | null>(null)

  const parsedFormKey = e2eOn ? extractKeyFromText(e2eKey) : null
  const formFp = parsedFormKey && keyFp && keyFp.k === parsedFormKey ? keyFp.fp : null

  useEffect(() => {
    if (!parsedFormKey) return
    if (keyFp && keyFp.k === parsedFormKey) return
    let alive = true
    const k = parsedFormKey
    void fingerprintK(k)
      .then((f) => {
        if (alive) setKeyFp({ k, fp: f })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [parsedFormKey, keyFp])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const cleanName = name.trim()
    const cleanToken = token.trim().toUpperCase()
    if (!cleanName || !cleanToken) return
    if (!TOKEN_EXACT_RE.test(cleanToken)) {
      setBanner('Token is 5 or 9 letters/numbers — run `ks-ssh --token=` to get one.')
      return
    }
    let cleanKey: string | null = null
    if (e2eOn) {
      cleanKey = extractKeyFromText(e2eKey)
      if (!cleanKey) {
        setE2eError('Enter the E2E key — paste the full share link (with #k=…) or the raw key.')
        return
      }
    }
    setE2eError(null)
    const id = `ssh-${Date.now().toString(36)}-${Math.floor(Math.random() * 10000)}`
    const next: SshEntry = {
      id,
      name: cleanName,
      token: cleanToken,
      note: '',
      online: false,
      e2e: e2eOn,
    }
    if (e2eOn && cleanKey) {
      const k = cleanKey
      const map = readE2eKeys()
      map[id] = k
      writeE2eKeys(map)
    }
    onChange((prev) => [...prev, next])
    setE2eKey('')
    window.location.hash = '#/ssh'
    // Optional: probe relay immediately so the new entry shows online without manual refresh.
    void (async () => {
      try {
        const res = await fetch(`${relayBase}/api/ssh/status?token=${encodeURIComponent(cleanToken)}`, { cache: 'no-store' })
        if (res.ok) {
          const data = (await res.json()) as { agentOnline?: boolean }
          if (data.agentOnline === true) {
            onChange((prev) => prev.map((x) => (x.id === id ? { ...x, online: true } : x)))
          }
        }
      } catch {}
    })()
    void entries
  }

  return (
    <section className="page page-ssh" aria-labelledby="page-title-ssh-add">
      <div className="page-head">
        <a className="btn btn-sm" href="#/ssh" aria-label="Back to SSH">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back
        </a>
        <h1 id="page-title-ssh-add" style={{ margin: 0, flex: 1 }}>New connection</h1>
      </div>
      <Reveal>
        <div className="card form-card">
          <form className="form" onSubmit={submit}>
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
                    🔒 fingerprint <code>{formFp}</code> (saved on this device with this connection)
                  </span>
                ) : (
                  <span className="session-status session-hint">
                    Saved on this device with this connection — deleting it drops the key too.
                  </span>
                )}
              </label>
            )}
            {banner && (
              <div className="banner-error" role="alert" style={{ gridColumn: '1 / -1' }}>
                <p>{banner}</p>
              </div>
            )}
            <div className="row-actions">
              <a className="btn" href="#/ssh">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
                Cancel
              </a>
              <button type="submit" className="btn btn-primary">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                Connect
              </button>
            </div>
          </form>
        </div>
      </Reveal>
    </section>
  )
}

function SshEditPage({
  entries,
  onChange,
  settings,
  editId,
}: {
  entries: SshEntry[]
  onChange: (fn: (prev: SshEntry[]) => SshEntry[]) => void
  settings: Settings
  editId: string | null
}) {
  void settings
  const entry = editId ? entries.find((x) => x.id === editId) ?? null : null
  const [name, setName] = useState(() => entry?.name ?? '')
  const [token, setToken] = useState(() => entry?.token ?? '')
  const [e2eOn, setE2eOn] = useState(() => entry?.e2e === true)
  const [e2eKey, setE2eKey] = useState(() => {
    if (!entry) return ''
    try {
      const map = readE2eKeys()
      return map[entry.id] ?? ''
    } catch {
      return ''
    }
  })
  const [e2eError, setE2eError] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [keyFp, setKeyFp] = useState<{ k: string; fp: string } | null>(null)
  const [banner, setBanner] = useState<string | null>(null)

  // Keep form in sync if entry loads late (e.g. after storage hydration)
  useEffect(() => {
    if (entry) {
      setName(entry.name)
      setToken(entry.token)
      setE2eOn(entry.e2e === true)
      try {
        const map = readE2eKeys()
        setE2eKey(map[entry.id] ?? '')
      } catch {
        setE2eKey('')
      }
    }
  }, [entry?.id])

  const parsedFormKey = e2eOn ? extractKeyFromText(e2eKey) : null
  const formFp = parsedFormKey && keyFp && keyFp.k === parsedFormKey ? keyFp.fp : null

  useEffect(() => {
    if (!parsedFormKey) return
    if (keyFp && keyFp.k === parsedFormKey) return
    let alive = true
    const k = parsedFormKey
    void fingerprintK(k)
      .then((f) => {
        if (alive) setKeyFp({ k, fp: f })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [parsedFormKey, keyFp])

  if (!entry) {
    return (
      <section className="page page-ssh" aria-labelledby="page-title-ssh-edit">
        <div className="page-head">
          <a className="btn btn-sm" href="#/ssh" aria-label="Back to SSH">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Back
          </a>
          <h1 id="page-title-ssh-edit" style={{ margin: 0, flex: 1 }}>Edit connection</h1>
        </div>
        <div className="card">
          <p>Connection not found.</p>
          <div className="row-actions">
            <a className="btn btn-primary" href="#/ssh">
              Back to SSH
            </a>
          </div>
        </div>
      </section>
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
    let cleanKey: string | null = null
    if (e2eOn) {
      cleanKey = extractKeyFromText(e2eKey)
      if (!cleanKey) {
        setE2eError('Enter the E2E key — paste the full share link (with #k=…) or the raw key.')
        return
      }
    }
    setE2eError(null)
    onChange((prev) =>
      prev.map((x) =>
        x.id === entry.id ? { ...x, name: cleanName, token: cleanToken, e2e: e2eOn, online: false } : x,
      ),
    )
    const map = readE2eKeys()
    if (e2eOn && cleanKey) map[entry.id] = cleanKey
    else delete map[entry.id]
    writeE2eKeys(map)
    setE2eKey('')
    window.location.hash = '#/ssh'
  }

  return (
    <section className="page page-ssh" aria-labelledby="page-title-ssh-edit">
      <div className="page-head">
        <a className="btn btn-sm" href="#/ssh" aria-label="Back to SSH">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back
        </a>
        <h1 id="page-title-ssh-edit" style={{ margin: 0, flex: 1 }}>Edit connection</h1>
      </div>
      <Reveal>
        <div className="card form-card">
          <form className="form" onSubmit={submit}>
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
                    🔒 fingerprint <code>{formFp}</code> (saved on this device with this connection)
                  </span>
                ) : (
                  <span className="session-status session-hint">
                    Saved on this device with this connection — deleting it drops the key too.
                  </span>
                )}
              </label>
            )}
            {banner && (
              <div className="banner-error" role="alert" style={{ gridColumn: '1 / -1' }}>
                <p>{banner}</p>
              </div>
            )}
            <div className="row-actions">
              <a className="btn" href="#/ssh">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
                Cancel
              </a>
              <button type="submit" className="btn btn-primary">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                Save
              </button>
            </div>
          </form>
        </div>
      </Reveal>
    </section>
  )
}

function SshVisitPage({
  entries,
  settings,
  visitId,
}: {
  entries: SshEntry[]
  settings: Settings
  visitId: string | null
}) {
  const entry = visitId ? entries.find((x) => x.id === visitId) ?? null : null
  const relayBase = relayHttpBase(settings)
  const wsHost = relayWsHost(settings)
  const token = entry?.token.trim().toUpperCase() ?? null
  // e2e key for this entry (persisted) or fragment — never in query
  const e2eKey = entry ? (readE2eKeys()[entry.id] ?? parseFragmentKey()) : null
  const [progress, setProgress] = useState(0)
  const [phase, setPhase] = useState('Initializing…')
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [iframeSrc, setIframeSrc] = useState<string | null>(null)
  const [iframeLoaded, setIframeLoaded] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  const visitUrl = token ? `${relayBase}/v/${token}${e2eKey ? `#k=${e2eKey}` : ''}` : ''

  useEffect(() => {
    if (!entry || !token) return
    let cancelled = false
    const ctrl = new AbortController()
    let ws: WebSocket | null = null

    // Fast-load: add preconnect hints for relay host
    try {
      const hint = document.createElement('link')
      hint.rel = 'preconnect'
      hint.href = `https://${wsHost}`
      hint.crossOrigin = ''
      document.head.appendChild(hint)
      setTimeout(() => {
        try { hint.remove() } catch {}
      }, 10000)
    } catch {}

    const safeProgress = (p: number, text: string) => {
      if (cancelled) return
      setProgress((prev) => (p > prev ? p : prev))
      setPhase(text)
    }

    const run = async () => {
      try {
        safeProgress(5, 'Resolving relay…')
        // Parallel fast checks: status + meta + DNS prefetch
        safeProgress(12, 'Checking agent…')
        const statusP = fetch(`${relayBase}/api/ssh/status?token=${encodeURIComponent(token)}`, {
          signal: ctrl.signal,
          cache: 'no-store',
        })
          .then((r) => r.json().catch(() => null))
          .catch(() => null)
        const metaP = fetch(`${relayBase}/api/ui/${token}/meta`, {
          signal: ctrl.signal,
          cache: 'no-store',
        })
          .then((r) => r.json().catch(() => null))
          .catch(() => null)

        // Also start WSS early for fast handshake (parallel)
        const wsReady = new Promise<boolean>((resolve) => {
          const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
          try {
            ws = new WebSocket(`${scheme}//${wsHost}/v1/client?token=${token}`)
          } catch {
            resolve(false)
            return
          }
          const t = setTimeout(() => {
            try { ws?.close() } catch {}
            resolve(false)
          }, Math.min(settings.connectTimeoutMs, 7000))
          const onPaired = (ok: boolean) => {
            clearTimeout(t)
            try { ws?.close() } catch {}
            resolve(ok)
          }
          ws.onopen = () => {
            safeProgress(38, 'Secure channel…')
            try {
              const k = readE2eKeys()[entry.id] ?? parseFragmentKey()
              ws?.send(JSON.stringify(k ? { type: 'hello', role: 'client', token, e2e: E2E_ALG } : { type: 'hello', role: 'client', token }))
              ws?.send(JSON.stringify({ type: 'ui-request' }))
            } catch {}
          }
          ws.onmessage = (ev) => {
            try {
              const msg = JSON.parse(String(ev.data)) as { type?: string; agent?: boolean; online?: boolean }
              if (msg?.type === 'enc') return
              if (msg?.type === 'paired') onPaired(msg.agent === true)
              else if (msg?.type === 'agent' && msg.online === false) onPaired(false)
              else if (msg?.type === 'ui-ready' || msg?.type === 'ui-begin') {
                safeProgress(62, 'UI bundle streaming…')
              }
            } catch {}
          }
          ws.onerror = () => onPaired(false)
          ws.onclose = () => {
            clearTimeout(t)
            // if not yet resolved, treat as offline
            setTimeout(() => {
              // @ts-ignore - closure check
              if (!cancelled) resolve(false)
            }, 50)
          }
        })

        const statusData = (await statusP) as { agentOnline?: boolean; hasUi?: boolean } | null
        if (cancelled) return
        if (!statusData || statusData.agentOnline !== true) {
          setError('Agent offline — start the CLI with `ks-ssh --token=' + token + '`')
          safeProgress(22, 'Agent offline')
        } else {
          safeProgress(28, 'Agent online')
        }

        const metaData = (await metaP) as { hasUi?: boolean; size?: number } | null
        if (cancelled) return
        if (metaData?.hasUi) safeProgress(42, `UI cached · ${Math.round((metaData.size ?? 0) / 1024)} KB`)
        else safeProgress(42, 'UI not yet pushed — requesting…')

        const ok = await wsReady
        if (cancelled) return
        if (ok) safeProgress(68, 'Channel secured')
        else if (!error) safeProgress(58, 'Channel ready')

        // Preload HTML via HTTP for fast paint (warms DO cache, then iframe reuses it)
        safeProgress(75, 'Loading frontend…')
        try {
          // Use no-store but keep connection warm; body is not needed — just headers for cache
          await fetch(`${relayBase}/v/${token}`, { signal: ctrl.signal, cache: 'no-store', method: 'GET' }).then((r) => r.text().then(() => r).catch(() => r)).catch(() => null)
          if (!cancelled) safeProgress(88, 'Frontend fetched')
        } catch {
          if (!cancelled) safeProgress(82, 'Frontend pending…')
        }

        if (cancelled) return
        // Prepare iframe src (the real CLI frontend)
        safeProgress(92, 'Finalizing…')
        setIframeSrc(visitUrl)
        // Progress will go to 100 on iframe onLoad; fallback timer
        setTimeout(() => {
          if (!cancelled && !ready) safeProgress(96, 'Rendering…')
        }, 600)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Load failed')
      }
    }
    void run()
    return () => {
      cancelled = true
      ctrl.abort()
      try { ws?.close() } catch {}
    }
  }, [entry?.id, token])

  useEffect(() => {
    if (iframeLoaded) {
      setProgress(100)
      setPhase('Ready — opening…')
      const t = setTimeout(() => setReady(true), 220)
      return () => clearTimeout(t)
    }
  }, [iframeLoaded])

  if (!entry || !token) {
    return (
      <section className="page page-visit" aria-labelledby="page-title-visit">
        <div className="page-head">
          <a className="btn btn-sm" href="#/ssh">Back</a>
          <h1 id="page-title-visit" style={{ margin: 0, flex: 1 }}>Visit</h1>
        </div>
        <div className="card">
          <p>Connection not found.</p>
          <div className="row-actions">
            <a className="btn btn-primary" href="#/ssh">Back to SSH</a>
          </div>
        </div>
      </section>
    )
  }

  const pct = Math.min(100, Math.max(0, Math.round(progress)))

  return (
    <section className="page page-visit" aria-labelledby="page-title-visit">
      <div className="page-head">
        <a className="btn btn-sm" href="#/ssh" aria-label="Back to SSH">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back
        </a>
        <h1 id="page-title-visit" style={{ margin: 0, flex: 1 }}>{entry.name}</h1>
        <div className="row-actions" style={{ marginTop: 0, paddingTop: 0 }}>
          <a className="btn btn-sm" href={visitUrl} target="_blank" rel="noreferrer">
            Open raw
          </a>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              const el = wrapRef.current
              if (el?.requestFullscreen) void el.requestFullscreen()
              else window.open(visitUrl, '_blank', 'noopener')
            }}
            disabled={!iframeSrc}
          >
            Fullscreen
          </button>
        </div>
      </div>

      {!ready || !iframeSrc ? (
        <div className="card visit-loader-card">
          <div className="visit-loader-head">
            <span className="visit-loader-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M7 9l3 3-3 3M12 15h5" />
              </svg>
            </span>
            <div>
              <h2 style={{ margin: 0 }}>{entry.name}</h2>
              <p className="visit-token">{token}</p>
            </div>
            <span className="tag online" style={{ marginLeft: 'auto' }}>
              {pct}% — {phase}
            </span>
          </div>

          <div className="visit-progress-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Loading frontend">
            <div className="visit-progress-bar" style={{ width: `${pct}%` }} />
            <div className="visit-progress-glow" style={{ left: `calc(${pct}% - 12px)` }} />
          </div>
          <div className="visit-progress-meta">
            <span className="visit-phase">{phase}</span>
            <span className="visit-pct">{pct}%</span>
          </div>

          <ul className="visit-steps">
            <li className={pct >= 15 ? 'done' : ''}><span className="dot" /> Relay</li>
            <li className={pct >= 35 ? 'done' : ''}><span className="dot" /> Agent</li>
            <li className={pct >= 62 ? 'done' : ''}><span className="dot" /> WSS</li>
            <li className={pct >= 88 ? 'done' : ''}><span className="dot" /> Frontend</li>
          </ul>

          {error ? (
            <div className="banner-error" role="alert">
              <p>{error}</p>
              <div className="row-actions">
                <a className="btn btn-sm btn-primary" href={`#/ssh/visit/${encodeURIComponent(entry.id)}`}>
                  Retry
                </a>
                <a className="btn btn-sm" href="#/ssh">
                  Back
                </a>
              </div>
            </div>
          ) : (
            <p className="session-status session-hint">
              Authenticating via WSS and fetching the embedded frontend bundle — not a fake timer. Progress tracks real relay status, UI meta, WSS handshake and HTML preload; on 100% the CLI frontend (same as <code>--port</code>) opens below.
            </p>
          )}

          {/* Hidden preload iframe to warm cache — visibility hidden until ready */}
          {iframeSrc && !ready && (
            <iframe
              title={`Preload ${token}`}
              src={iframeSrc}
              style={{ position: 'absolute', width: 0, height: 0, border: 0, opacity: 0, pointerEvents: 'none' }}
              tabIndex={-1}
              aria-hidden="true"
              onLoad={() => setIframeLoaded(true)}
            />
          )}
        </div>
      ) : null}

      {iframeSrc && (
        <div
          className="visit-frame-wrap"
          ref={wrapRef}
          style={{ display: ready ? 'block' : 'none' }}
        >
          <iframe
            title={`Agent UI ${token} — Terminal, Files, Ports, Host`}
            src={iframeSrc}
            className="visit-frame"
            allow="fullscreen; clipboard-read; clipboard-write"
            allowFullScreen
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
            onLoad={() => setIframeLoaded(true)}
          />
        </div>
      )}
    </section>
  )
}

function InstallationPage() {
  const origin =
    typeof window !== 'undefined'
      ? window.location.origin
      : 'https://<relay-host>'
  const steps: Array<{
    tag: string
    title: string
    body: string
    codes: string[]
    hint?: ReactNode
  }> = [
    {
      tag: 'Start',
      title: 'Download the agent',
      body: 'One single binary — local UI, relay agent and embedded frontend in ~19 MB. Paste this in your terminal to download it and list every flag:',
      codes: [
        'curl -sSfL https://raw.githubusercontent.com/kswarrior/ks-ssh-v2/refs/heads/main/cli/release/ks-ssh -o ks-ssh && chmod +x ks-ssh && ./ks-ssh --help',
      ],
    },
    {
      tag: 'Serve',
      title: 'Local UI on this machine',
      body: 'Serves Terminal, Files, Ports and Host on loopback, with PTY reattach, scrollback and resize:',
      codes: ['./ks-ssh --port 8080'],
      hint: (
        <>
          Open <code>http://127.0.0.1:8080</code> in a browser on that machine.
          Prefer <code>--host 127.0.0.1</code> — only bind <code>0.0.0.0</code>{' '}
          behind proxy auth on untrusted networks.
        </>
      ),
    },
    {
      tag: 'Protect',
      title: 'Lock it with a login',
      body: 'Show a login page and make that account the admin — its password confirms user edits and deletes. More accounts live on the Users page with Argon2id hashes, admin/operator/viewer roles, TOTP and optional OIDC SSO:',
      codes: [`./ks-ssh --user admin --pass 'choose-a-long-password'`],
      hint: (
        <>
          Single sign-on: <code>--oidc-issuer</code> +{' '}
          <code>--oidc-client-id</code> (auto-provisions as viewer,{' '}
          <code>--oidc-allow-domain</code> whitelists one domain).
        </>
      ),
    },
    {
      tag: 'Serve',
      title: 'Relay with no open port',
      body: 'Pushes an outbound WSS tunnel plus the full UI bundle to this relay and prints a share link with #k=… — nothing to forward, no ingress:',
      codes: ['./ks-ssh --no-serve --token='],
      hint: (
        <>
          Paste the printed token into the SSH page, then open it from the full
          share link so E2E works. Tokens are exactly 5 or 9 letters/numbers.
        </>
      ),
    },
    {
      tag: 'Serve',
      title: 'Relay + local UI together',
      body: 'The same UI both ways at once — serve loopback and the relay from one command:',
      codes: ['./ks-ssh --token=ABCDE1234'],
      hint: (
        <>
          Reuses your token; omit the value (<code>--token=</code>) to mint a
          fresh 9-character one.
        </>
      ),
    },
    {
      tag: 'Protect',
      title: 'Reuse keys, trim the push',
      body: 'Keep the same E2E key across restarts, or skip the UI-bundle push when only shell access matters:',
      codes: [
        `./ks-ssh --no-serve --token=ABCDE1234 --e2e-key='<k-from-your-last-link>'`,
        './ks-ssh --no-serve --token= --no-ui',
      ],
      hint: (
        <>
          <code>--no-e2e</code> is a legacy plaintext escape hatch only — loud
          startup warning plus an audit row.
        </>
      ),
    },
    {
      tag: 'Protect',
      title: 'Viewer PIN (optional)',
      body: 'Require a one-time PIN sealed inside E2E before any shell or file bridge — the agent prints it once and signed-in local users can mint fresh ones:',
      codes: ['./ks-ssh --no-serve --token= --relay-auth'],
      hint: <>One-time PIN with a 15-minute life — never in query strings or logs.</>,
    },
    {
      tag: 'Keep',
      title: 'Audit and recordings',
      body: 'Every login, file write, port kill and shell attach lands in an append-only SQLite audit log, and every shell is recorded for replay. Tune retention per box:',
      codes: [
        './ks-ssh --audit-retain-days 90 --record-max-mb 10',
        './ks-ssh --no-record',
      ],
      hint: (
        <>
          The Audit page filters and exports JSON/CSV; the Recordings page
          replays with play, pause, speed and scrub. Recording defaults on
          while auth is on.
        </>
      ),
    },
    {
      tag: 'Verify',
      title: 'Check the relay',
      body: 'Confirm this relay answers, then check a token is live before sharing it:',
      codes: [
        `curl -s ${origin}/api/health`,
        `curl -s "${origin}/api/ssh/status?token=ABCDE1234"`,
      ],
    },
  ]

  return (
    <section className="page page-install" aria-labelledby="page-title-installation">
      <Reveal>
        <div className="install-head">
          <span className="eyebrow">Guide</span>
          <h1 id="page-title-installation">Installation</h1>
          <p className="lead">
            One binary, three ways to serve it — locked, audited and recorded.
            Follow the steps in order.
          </p>
        </div>
      </Reveal>
      <ol className="steps install-steps">
        {steps.map((s, i) => (
          <li key={s.title}>
            <Reveal delay={Math.min(i, 6) * 70}>
              <div className="card step-card">
                <div className="step-top">
                  <span className="step-num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <div className="step-titles">
                    <span className="step-tag">{s.tag}</span>
                    <h2>{s.title}</h2>
                  </div>
                </div>
                <p>{s.body}</p>
                {s.codes.map((c) => (
                  <CodeBlock key={c} code={c} />
                ))}
                {s.hint ? (
                  <p className="session-status session-hint">{s.hint}</p>
                ) : null}
              </div>
            </Reveal>
          </li>
        ))}
      </ol>
      <Reveal>
        <div className="card habits-card">
          <h2>Good habits</h2>
          <ul className="habits-list">
            <li>
              Mint a fresh <code>--token=</code> per session and compare the
              viewer&apos;s fingerprint with the CLI&apos;s on first connect.
            </li>
            <li>
              Keep <code>k</code> and PINs out of query strings, fetch URLs
              and logs — they travel in the fragment and sealed traffic only.
            </li>
            <li>
              Files stay jailed to <code>$HOME</code>; port kills are
              PID-scoped and never touch PID 1 or the agent itself.
            </li>
          </ul>
          <div className="row-actions">
            <a className="btn btn-sm btn-primary" href="#/ssh">
              Open SSH
            </a>
            <a className="btn btn-sm" href="#/settings">
              Settings
            </a>
          </div>
        </div>
      </Reveal>
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
    <section className="page page-settings" aria-labelledby="page-title-settings">
      <Reveal>
        <div className="settings-head">
          <span className="eyebrow">Tuning</span>
          <h1 id="page-title-settings">Settings</h1>
          <p className="lead">Settings save automatically on this device and take effect immediately.</p>
        </div>
      </Reveal>
      <Reveal delay={70}>
      <div className="card settings-card">
        <div className="settings-card-top">
          <span className="settings-icon" aria-hidden="true">
            <Icon>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </Icon>
          </span>
          <h2>Relay</h2>
        </div>
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
      </Reveal>
      <Reveal delay={140}>
      <div className="card settings-card">
        <div className="settings-card-top">
          <span className="settings-icon" aria-hidden="true">
            <Icon>
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </Icon>
          </span>
          <h2>Appearance</h2>
        </div>
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
      </Reveal>
      <Reveal delay={210}>
      <div className="card settings-card settings-danger">
        <div className="settings-card-top">
          <span className="settings-icon settings-icon-danger" aria-hidden="true">
            <Icon>
              <path d="M3 6h18" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </Icon>
          </span>
          <h2>Local data</h2>
        </div>
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
      </Reveal>
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
  const [sshEditId, setSshEditId] = useState<string | null>(() =>
    typeof window !== 'undefined' ? hashToSshEditId(window.location.hash) : null,
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
    // Force offline on load: persisted `online` is stale after reload/close.
    // Real presence is rechecked from the relay (SSH page refresh).
    return (saved as SshEntry[])
      .filter(
        (x) =>
          x &&
          typeof x.id === 'string' &&
          !x.id.startsWith('seed-') &&
          typeof x.name === 'string' &&
          x.name.trim() !== '',
      )
      .map((x) => ({ ...x, online: false }))
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
      setSshEditId(hashToSshEditId(window.location.hash))
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Browser tab title follows the active page.
  useEffect(() => {
    if (page === 'ssh-add') {
      document.title = 'KS SSH — New connection'
      return
    }
    if (page === 'ssh-edit') {
      document.title = 'KS SSH — Edit connection'
      return
    }
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
      localStorage.removeItem('ks-ssh:e2e')
      sessionStorage.clear()
    } catch {
      // Storage unavailable — in-memory state already cleared.
    }
  }

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
              const isActive =
                item.id === page || (item.id === 'ssh' && (page === 'ssh-add' || page === 'ssh-edit'))
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
          className="content"
          id="main"
          tabIndex={-1}
        >
          {page === 'home' && <HomePage />}
          {page === 'ssh' && <SSHPage entries={entries} onChange={setEntries} settings={settings} />}
          {page === 'ssh-add' && <SshAddPage entries={entries} onChange={setEntries} settings={settings} />}
          {page === 'ssh-edit' && <SshEditPage entries={entries} onChange={setEntries} settings={settings} editId={sshEditId} />}
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
