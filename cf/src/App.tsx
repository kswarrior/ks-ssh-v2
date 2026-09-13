import { useEffect, useRef, useState, type FormEvent } from 'react'

type PageId = 'home' | 'servers' | 'installation' | 'settings'

type NavItem = { id: PageId; label: string; hash: string }

const NAV: NavItem[] = [
  { id: 'home', label: 'Home', hash: '#/' },
  { id: 'servers', label: 'Servers', hash: '#/servers' },
  { id: 'installation', label: 'Installation', hash: '#/installation' },
  { id: 'settings', label: 'Settings', hash: '#/settings' },
]

type Server = {
  id: string
  name: string
  host: string
  user: string
  port: number
}

type Settings = {
  defaultUser: string
  defaultPort: number
  confirmBeforeConnect: boolean
}

const DEFAULT_SETTINGS: Settings = {
  defaultUser: 'root',
  defaultPort: 22,
  confirmBeforeConnect: true,
}

const SEED_SERVERS: Server[] = [
  { id: 'seed-home-lab', name: 'Home Lab', host: '192.168.1.10', user: 'ks', port: 22 },
  { id: 'seed-vps', name: 'VPS', host: '203.0.113.20', user: 'root', port: 22 },
]

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
  const found = NAV.find((p) => p.hash.replace(/^#\/?/, '') === clean)
  return found ? found.id : null
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

function HomePage({
  serverCount,
  connectedServer,
  go,
}: {
  serverCount: number
  connectedServer: Server | null
  go: (id: PageId) => void
}) {
  return (
    <section className="page" aria-labelledby="page-title-home">
      <h1 id="page-title-home">Home</h1>
      <p className="lead">
        Welcome to KS SSH — keep all your SSH servers in one place and connect
        with one tap.
      </p>
      <div className="grid">
        <div className="card">
          <span className="stat">{serverCount}</span>
          <span>{serverCount === 1 ? 'Server saved' : 'Servers saved'}</span>
          <div className="row-actions">
            <button type="button" className="btn btn-primary" onClick={() => go('servers')}>
              View servers
            </button>
          </div>
        </div>
        <div className="card">
          <h2>Status</h2>
          <p>
            {connectedServer
              ? `Connected to ${connectedServer.name} (${connectedServer.user}@${connectedServer.host})`
              : 'Not connected'}
          </p>
          <div className="row-actions">
            <button type="button" className="btn" onClick={() => go('servers')}>
              {connectedServer ? 'Manage connection' : 'Connect a server'}
            </button>
          </div>
        </div>
        <div className="card">
          <h2>New here?</h2>
          <p>Install the backend, add your first server, and connect.</p>
          <div className="row-actions">
            <button
              type="button"
              className="btn"
              onClick={() => go('installation')}
            >
              Get started
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

function ServersPage({
  servers,
  connectedId,
  connectingId,
  busy,
  defaultUser,
  defaultPort,
  onConnect,
  onDisconnect,
  onRemove,
  onAdd,
}: {
  servers: Server[]
  connectedId: string | null
  connectingId: string | null
  busy: boolean
  defaultUser: string
  defaultPort: number
  onConnect: (s: Server) => void
  onDisconnect: () => void
  onRemove: (id: string) => void
  onAdd: (data: { name: string; host: string; user: string; port: number }) => void
}) {
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [user, setUser] = useState('')
  const [port, setPort] = useState('')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const cleanName = name.trim()
    const cleanHost = host.trim()
    if (!cleanName || !cleanHost) return
    onAdd({
      name: cleanName,
      host: cleanHost,
      user: user.trim() || defaultUser || 'root',
      port: Number.parseInt(port, 10) || defaultPort || 22,
    })
    setName('')
    setHost('')
    setUser('')
    setPort('')
  }

  return (
    <section className="page" aria-labelledby="page-title-servers">
      <h1 id="page-title-servers">Servers</h1>
      <p className="lead">
        All your SSH servers. Pick one and press <strong>Connect</strong>.
      </p>

      {servers.length === 0 ? (
        <div className="card">
          <h2>No servers yet</h2>
          <p>Add your first server with the form below.</p>
        </div>
      ) : (
        <ul className="server-list">
          {servers.map((s) => {
            const isConnected = s.id === connectedId
            const isConnecting = s.id === connectingId
            return (
              <li key={s.id} className="server-row">
                <div className="server-info">
                  <div className="server-name">{s.name}</div>
                  <div className="server-addr">
                    {s.user}@{s.host}:{s.port}
                  </div>
                </div>
                {isConnected ? (
                  <span className="badge connected">Connected</span>
                ) : isConnecting ? (
                  <span className="badge connecting">Connecting…</span>
                ) : null}
                <div className="row-actions">
                  {isConnected ? (
                    <button type="button" className="btn btn-sm" onClick={onDisconnect}>
                      Disconnect
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={isConnecting || busy}
                      onClick={() => onConnect(s)}
                    >
                      {isConnecting ? 'Connecting…' : 'Connect'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => onRemove(s.id)}
                    aria-label={`Remove ${s.name}`}
                  >
                    Remove
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <div className="card">
        <h2>Add a server</h2>
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
            />
          </label>
          <label className="field">
            Host
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.1.10"
              autoComplete="off"
              inputMode="url"
              required
            />
          </label>
          <label className="field">
            User
            <input
              type="text"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder={defaultUser || 'root'}
              autoComplete="username"
            />
          </label>
          <label className="field">
            Port
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder={String(defaultPort || 22)}
              min={1}
              max={65535}
            />
          </label>
          <div className="row-actions">
            <button type="submit" className="btn btn-primary">
              Add server
            </button>
          </div>
        </form>
      </div>
    </section>
  )
}

function InstallationPage({ go }: { go: (id: PageId) => void }) {
  return (
    <section className="page" aria-labelledby="page-title-installation">
      <h1 id="page-title-installation">Installation</h1>
      <p className="lead">
        Get KS SSH running in four steps: backend, key, server, connect.
      </p>

      <ol className="steps">
        <li className="card">
          <h2>1. Run the backend</h2>
          <p>From the repository root, start the KS SSH backend:</p>
          <CodeBlock code="cargo run -p ks-ssh" />
        </li>
        <li className="card">
          <h2>2. Create an SSH key</h2>
          <p>Generate a key on this machine (accept the defaults):</p>
          <CodeBlock code='ssh-keygen -t ed25519 -C "ks-ssh"' />
          <p>Copy it to your server so you can log in without a password:</p>
          <CodeBlock code="ssh-copy-id user@your-server" />
        </li>
        <li className="card">
          <h2>3. Add your server</h2>
          <p>
            Open the Servers page and fill in the name, host, user, and port
            of your machine.
          </p>
          <div className="row-actions">
            <button type="button" className="btn btn-primary" onClick={() => go('servers')}>
              Go to Servers
            </button>
          </div>
        </li>
        <li className="card">
          <h2>4. Connect</h2>
          <p>
            Press <strong>Connect</strong> next to the server. The equivalent
            terminal command is:
          </p>
          <CodeBlock code="ssh user@your-server" />
        </li>
      </ol>
    </section>
  )
}

function SettingsPage({
  settings,
  onChange,
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
}) {
  return (
    <section className="page" aria-labelledby="page-title-settings">
      <h1 id="page-title-settings">Settings</h1>
      <p className="lead">Settings save automatically on this device.</p>
      <div className="card">
        <div className="form">
          <label className="field">
            Default user
            <input
              type="text"
              value={settings.defaultUser}
              onChange={(e) => onChange({ defaultUser: e.target.value })}
              placeholder="root"
              autoComplete="username"
            />
          </label>
          <label className="field">
            Default port
            <input
              type="number"
              value={settings.defaultPort}
              onChange={(e) =>
                onChange({
                  defaultPort: Number.parseInt(e.target.value, 10) || 22,
                })
              }
              min={1}
              max={65535}
            />
          </label>
          <label className="field checkbox-row">
            <input
              type="checkbox"
              checked={settings.confirmBeforeConnect}
              onChange={(e) => onChange({ confirmBeforeConnect: e.target.checked })}
            />
            Ask for confirmation before connecting
          </label>
        </div>
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
  const isMobile = useIsMobile(768)
  const btnRef = useRef<HTMLButtonElement>(null)
  const asideRef = useRef<HTMLElement>(null)
  const mainRef = useRef<HTMLElement>(null)

  const [servers, setServers] = useState<Server[]>(() => {
    const saved = readJSON<unknown>('ks-ssh:servers', null)
    return Array.isArray(saved) ? (saved as Server[]) : SEED_SERVERS
  })
  const [settings, setSettings] = useState<Settings>(() =>
    readJSON<Settings>('ks-ssh:settings', DEFAULT_SETTINGS),
  )
  const [connectedId, setConnectedId] = useState<string | null>(null)
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const connectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
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
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Browser tab title follows the active page.
  useEffect(() => {
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
    writeJSON('ks-ssh:servers', servers)
  }, [servers])

  useEffect(() => {
    writeJSON('ks-ssh:settings', settings)
  }, [settings])

  useEffect(
    () => () => {
      if (connectTimer.current) clearTimeout(connectTimer.current)
    },
    [],
  )

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

  const go = (id: PageId) => {
    const target = NAV.find((p) => p.id === id)
    if (!target) return
    setPage(id)
    if (window.location.hash !== target.hash) {
      window.location.hash = target.hash
    }
  }

  const patchSettings = (patch: Partial<Settings>) =>
    setSettings((prev) => ({ ...prev, ...patch }))

  const connect = (s: Server) => {
    if (s.id === connectedId || s.id === connectingId) return
    if (settings.confirmBeforeConnect) {
      const current = servers.find((x) => x.id === connectedId)
      const msg = current
        ? `Disconnect from ${current.name} and connect to ${s.name} (${s.user}@${s.host})?`
        : `Connect to ${s.name} (${s.user}@${s.host})?`
      if (!window.confirm(msg)) return
    }
    if (connectTimer.current) clearTimeout(connectTimer.current)
    setConnectingId(s.id)
    connectTimer.current = setTimeout(() => {
      setConnectedId(s.id)
      setConnectingId(null)
    }, 900)
  }

  const disconnect = () => {
    if (connectTimer.current) clearTimeout(connectTimer.current)
    setConnectingId(null)
    setConnectedId(null)
  }

  const removeServer = (id: string) => {
    if (id === connectedId || id === connectingId) {
      if (connectTimer.current) clearTimeout(connectTimer.current)
      setConnectedId((prev) => (prev === id ? null : prev))
      setConnectingId((prev) => (prev === id ? null : prev))
    }
    setServers((prev) => prev.filter((s) => s.id !== id))
  }

  const addServer = (data: {
    name: string
    host: string
    user: string
    port: number
  }) => {
    const id = `srv-${Date.now().toString(36)}-${Math.floor(Math.random() * 10000)}`
    setServers((prev) => [...prev, { id, ...data }])
  }

  const connectedServer = servers.find((s) => s.id === connectedId) ?? null

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
                  onClick={() => {
                    if (isMobile) {
                      setOpen(false)
                      btnRef.current?.focus()
                    } else {
                      // Move screen-reader/keyboard focus to the new page.
                      window.requestAnimationFrame(() => {
                        mainRef.current?.focus({ preventScroll: true })
                      })
                    }
                  }}
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
            <span
              className="status-dot"
              role="status"
              aria-label={
                connectedServer ? `Connected to ${connectedServer.name}` : 'Online'
              }
              title={connectedServer ? `Connected to ${connectedServer.name}` : 'Online'}
            />
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
          </header>

          <main
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ref={mainRef as any}
          className="content"
          id="main"
          tabIndex={-1}
        >
          {page === 'home' && (
            <HomePage
              serverCount={servers.length}
              connectedServer={connectedServer}
              go={go}
            />
          )}
          {page === 'servers' && (
            <ServersPage
              servers={servers}
              connectedId={connectedId}
              connectingId={connectingId}
              busy={connectingId !== null}
              defaultUser={settings.defaultUser}
              defaultPort={settings.defaultPort}
              onConnect={connect}
              onDisconnect={disconnect}
              onRemove={removeServer}
              onAdd={addServer}
            />
          )}
          {page === 'installation' && <InstallationPage go={go} />}
          {page === 'settings' && (
            <SettingsPage settings={settings} onChange={patchSettings} />
          )}
        </main>
      </div>
    </div>
  )
}
