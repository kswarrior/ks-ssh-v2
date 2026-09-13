import { useEffect, useRef, useState, type FormEvent } from 'react'

type PageId = 'home' | 'ssh' | 'installation' | 'settings'

type NavItem = { id: PageId; label: string; hash: string }

const NAV: NavItem[] = [
  { id: 'home', label: 'Home', hash: '#/' },
  { id: 'ssh', label: 'SSH', hash: '#/ssh' },
  { id: 'installation', label: 'Installation', hash: '#/installation' },
  { id: 'settings', label: 'Settings', hash: '#/settings' },
]

type Settings = {
  defaultUser: string
  defaultPort: number
}

const DEFAULT_SETTINGS: Settings = {
  defaultUser: 'root',
  defaultPort: 22,
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

function HomePage({ go }: { go: (id: PageId) => void }) {
  return (
    <section className="page" aria-labelledby="page-title-home">
      <h1 id="page-title-home">Home</h1>
      <div className="grid">
        <div className="card">
          <h2>New here?</h2>
          <p>Install the backend, set up your key, and connect in minutes.</p>
          <div className="row-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => go('installation')}
            >
              Get started
            </button>
          </div>
        </div>
        <div className="card">
          <h2>Settings</h2>
          <p>Tune the defaults KS SSH uses for your connections.</p>
          <div className="row-actions">
            <button
              type="button"
              className="btn"
              onClick={() => go('settings')}
            >
              Open settings
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

type SshEntry = {
  id: string
  name: string
  token: string
  note: string
  online: boolean
}

async function apiConnect(
  entry: { name: string; token: string },
  signal: AbortSignal,
): Promise<{ online: boolean; message?: string }> {
  try {
    const res = await fetch('/api/ssh/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: entry.name, token: entry.token }),
      signal,
    })
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean
      online?: boolean
      error?: string
    } | null
    if (res.ok && data && data.ok && data.online !== false) {
      return { online: true }
    }
    return {
      online: false,
      message:
        (data && data.error) ||
        `Backend refused the connection (HTTP ${res.status}).`,
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { online: false, message: 'aborted' }
    }
    return {
      online: false,
      message: 'Cannot reach the KS SSH backend. Start it, then try again.',
    }
  }
}

function SSHPage() {
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
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [token, setToken] = useState('')
  const [note, setNote] = useState('')
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    writeJSON('ks-ssh:ssh', entries)
  }, [entries])

  useEffect(
    () => () => {
      abortRef.current?.abort()
    },
    [],
  )

  const resetForm = () => {
    setEditingId(null)
    setName('')
    setToken('')
    setNote('')
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
    setFormOpen(true)
  }

  const closeForm = () => {
    setFormOpen(false)
    resetForm()
  }

  const attemptConnect = async (id: string) => {
    const entry = entries.find((x) => x.id === id)
    if (!entry || entry.online || connectingId) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, 8000)
    setConnectingId(id)
    setBanner(null)
    let result: { online: boolean; message?: string }
    try {
      result = await apiConnect(
        { name: entry.name, token: entry.token },
        ctrl.signal,
      )
    } finally {
      clearTimeout(timeout)
    }
    if (abortRef.current !== ctrl) return // superseded or unmounted
    abortRef.current = null
    setConnectingId(null)
    if (result.online) {
      setEntries((prev) =>
        prev.map((x) => (x.id === id ? { ...x, online: true } : x)),
      )
    } else if (result.message === 'aborted') {
      if (timedOut) {
        setBanner('Connection timed out after 8s. Check the backend and try again.')
      }
      // Otherwise silenced: superseded by a newer attempt or unmounted.
    } else {
      setEntries((prev) =>
        prev.map((x) => (x.id === id ? { ...x, online: false } : x)),
      )
      setBanner(result.message ?? 'Connection failed.')
    }
  }

  const stopPending = (id: string) => {
    if (id === connectingId) {
      abortRef.current?.abort()
      abortRef.current = null
      setConnectingId(null)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const cleanName = name.trim()
    const cleanToken = token.trim()
    if (!cleanName || !cleanToken) return
    if (editingId) {
      setEntries((prev) =>
        prev.map((x) =>
          x.id === editingId
            ? { ...x, name: cleanName, token: cleanToken, note: note.trim() }
            : x,
        ),
      )
      closeForm()
    } else {
      const id = `ssh-${Date.now().toString(36)}-${Math.floor(Math.random() * 10000)}`
      setEntries((prev) => [
        ...prev,
        {
          id,
          name: cleanName,
          token: cleanToken,
          note: note.trim(),
          online: false,
        },
      ])
      closeForm()
      markOnline(id)
    }
  }

  const removeEntry = (id: string) => {
    if (id === connectingId) {
      if (timer.current) clearTimeout(timer.current)
      setConnectingId(null)
    }
    setEntries((prev) => prev.filter((x) => x.id !== id))
  }

  const disconnect = (id: string) => {
    if (id === connectingId) {
      if (timer.current) clearTimeout(timer.current)
      setConnectingId(null)
    }
    setEntries((prev) =>
      prev.map((x) => (x.id === id ? { ...x, online: false } : x)),
    )
  }

  return (
    <section className="page" aria-labelledby="page-title-ssh">
      <div className="page-head">
        <h1 id="page-title-ssh">SSH</h1>
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

      {formOpen && (
        <div className="card">
          <h2>{editingId ? 'Edit connection' : 'New connection'}</h2>
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
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="••••••••"
                autoComplete="off"
                required
              />
            </label>
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
        <div className="card">
          <h2>No connections yet</h2>
          <p>Press Connect to add your first one.</p>
        </div>
      ) : (
        <ul className="ssh-list">
          {entries.map((e) => {
            const connecting = e.id === connectingId
            return (
              <li key={e.id} className="card ssh-card">
                <span className="ssh-icon" aria-hidden="true">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#fff"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <path d="M7 9l3 3-3 3M12 15h5" />
                  </svg>
                </span>
                <div className="ssh-main">
                  <div className="ssh-top">
                    <span className="ssh-name">{e.name}</span>
                    {connecting ? (
                      <span className="tag connecting">
                        <span className="tag-dot" aria-hidden="true" />
                        Connecting…
                      </span>
                    ) : e.online ? (
                      <span className="tag online">
                        <span className="tag-dot" aria-hidden="true" />
                        Online
                      </span>
                    ) : (
                      <span className="tag offline">
                        <span className="tag-dot" aria-hidden="true" />
                        Offline
                      </span>
                    )}
                  </div>
                  {e.note ? <p className="ssh-note">{e.note}</p> : null}
                  <div className="row-actions">
                    {e.online ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => disconnect(e.id)}
                      >
                        Disconnect
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={connecting}
                        onClick={() => markOnline(e.id)}
                      >
                        {connecting ? 'Connecting…' : 'Connect'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => openEdit(e)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={() => removeEntry(e.id)}
                      aria-label={`Delete ${e.name}`}
                    >
                      Delete
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

function InstallationPage() {
  return (
    <section className="page" aria-labelledby="page-title-installation">
      <h1 id="page-title-installation">Installation</h1>
      <p className="lead">
        Get KS SSH running in three steps: backend, key, connect.
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
          <h2>3. Connect</h2>
          <p>Open a terminal and connect to your server:</p>
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

  const [settings, setSettings] = useState<Settings>(() =>
    readJSON<Settings>('ks-ssh:settings', DEFAULT_SETTINGS),
  )
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
    writeJSON('ks-ssh:settings', settings)
  }, [settings])

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
            <span
              className="status-dot"
              role="status"
              aria-label="Online"
              title="Online"
            />
          </header>

          <main
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ref={mainRef as any}
          className="content"
          id="main"
          tabIndex={-1}
        >
          {page === 'home' && <HomePage go={go} />}
          {page === 'ssh' && <SSHPage />}
          {page === 'installation' && <InstallationPage />}
          {page === 'settings' && (
            <SettingsPage settings={settings} onChange={patchSettings} />
          )}
        </main>
      </div>
    </div>
  )
}
