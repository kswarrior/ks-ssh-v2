import { useEffect, useState } from 'react'
import TerminalPage, { type SshEntry } from './pages/Terminal'
import FilesPage from './pages/Files'
import PortsPage from './pages/Ports'
import HostPage from './pages/Host'

type TabId = 'terminal' | 'files' | 'ports' | 'host'

type TabItem = { id: TabId; label: string; hash: string }

const TABS: TabItem[] = [
  { id: 'terminal', label: 'Terminal', hash: '#/terminal' },
  { id: 'files', label: 'Files', hash: '#/files' },
  { id: 'ports', label: 'Ports', hash: '#/ports' },
]

// Host is not a tab — it opens only from the header icon button.
const HOST_ITEM: TabItem = { id: 'host', label: 'Host', hash: '#/host' }

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

/** Map a location hash to a tab, or null when it is not a tab route. */
function hashToTab(hash: string): TabId | null {
  const clean = hash.replace(/^#\/?/, '')
  const found = TABS.find((t) => t.hash.replace(/^#\/?/, '') === clean)
  if (found) return found.id
  if (HOST_ITEM.hash.replace(/^#\/?/, '') === clean) return HOST_ITEM.id
  return null
}

type PingTone = 'good' | 'mid' | 'bad' | 'off'

function pingTone(ms: number | null): PingTone {
  if (ms == null) return 'off'
  if (ms < 150) return 'good'
  if (ms < 400) return 'mid'
  return 'bad'
}

function PingBadge({ ms }: { ms: number | null }) {
  const tone = pingTone(ms)
  const lit = tone === 'good' ? 4 : tone === 'mid' ? 3 : tone === 'bad' ? 2 : 1
  const label =
    ms == null ? 'Server unreachable' : `Ping ${Math.round(ms)} milliseconds`
  return (
    <span className="ping-badge" data-tone={tone} role="status" aria-label={label} title={label}>
      <svg viewBox="0 0 24 18" aria-hidden="true">
        {[5, 9, 13, 17].map((h, i) => (
          <rect
            key={h}
            x={1 + i * 6}
            y={18 - h}
            width="4"
            height={h}
            rx="1"
            className={i < lit ? 'on' : undefined}
          />
        ))}
      </svg>
      <span className="ping-value">{ms == null ? '−−' : `${Math.round(ms)}ms`}</span>
    </span>
  )
}

export default function App() {
  const [tab, setTab] = useState<TabId>(
    () =>
      (typeof window !== 'undefined'
        ? hashToTab(window.location.hash)
        : null) ?? 'terminal',
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
  const [pingMs, setPingMs] = useState<number | null>(null)

  // Ping the local backend (UI <-> server RTT). Green <150ms,
  // yellow <400ms, red above that or unreachable.
  useEffect(() => {
    let alive = true
    let timer: number | undefined
    const check = async () => {
      const start = performance.now()
      try {
        const ctrl = new AbortController()
        const timeout = window.setTimeout(() => ctrl.abort(), 5000)
        const res = await fetch('/api/hello', {
          cache: 'no-store',
          signal: ctrl.signal,
        })
        window.clearTimeout(timeout)
        if (!res.ok) throw new Error(`http ${res.status}`)
        await res.text()
        if (alive) setPingMs(performance.now() - start)
      } catch {
        if (alive) setPingMs(null)
      }
      if (alive) timer = window.setTimeout(check, 5000)
    }
    void check()
    return () => {
      alive = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  // Keep tab in sync with the URL hash (back/forward buttons, deep links).
  // Unknown hashes (e.g. #main from the skip link) are ignored.
  useEffect(() => {
    const onHash = () => {
      const next = hashToTab(window.location.hash)
      if (next) setTab(next)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Browser tab title follows the active tab.
  useEffect(() => {
    const label =
      TABS.find((t) => t.id === tab)?.label ??
      (tab === HOST_ITEM.id ? HOST_ITEM.label : undefined)
    document.title = label ? `KS SSH — ${label}` : 'KS SSH'
  }, [tab])

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
    writeJSON('ks-ssh:ssh', entries)
  }, [entries])

  const go = (item: TabItem) => {
    setTab(item.id)
    if (window.location.hash !== item.hash) {
      window.location.hash = item.hash
    }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <div className="app-main">
        <header className="app-header">
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
          <PingBadge ms={pingMs} />

          <span className="header-spacer" />

          <nav className="header-tabs" aria-label="Primary">
            {TABS.map((item) => {
              const isActive = item.id === tab
              return (
                <a
                  key={item.id}
                  href={item.hash}
                  className={isActive ? 'active' : undefined}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={(e) => {
                    e.preventDefault()
                    go(item)
                  }}
                >
                  {item.label}
                </a>
              )
            })}
          </nav>

          <button
            type="button"
            className={`icon-btn${tab === 'host' ? ' active' : ''}`}
            aria-label="Host info"
            title="Host info"
            aria-current={tab === 'host' ? 'page' : undefined}
            onClick={() => go(HOST_ITEM)}
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
              <rect x="2" y="3" width="20" height="7" rx="2" />
              <rect x="2" y="14" width="20" height="7" rx="2" />
              <path d="M6 6.5h.01M6 17.5h.01" />
            </svg>
          </button>
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
          className={`content${tab === 'terminal' ? ' content-term' : tab === 'files' ? ' content-files' : tab === 'host' ? ' content-host' : ''}`}
          id="main"
          tabIndex={-1}
        >
          <div hidden={tab !== 'terminal'} className="tab-panel">
            <TerminalPage entries={entries} onChange={setEntries} />
          </div>
          <div hidden={tab !== 'files'} className="tab-panel">
            <FilesPage />
          </div>
          <div hidden={tab !== 'ports'} className="tab-panel">
            <PortsPage />
          </div>
          <div hidden={tab !== 'host'} className="tab-panel">
            <HostPage />
          </div>
        </main>

        <nav className="mobile-tabs" aria-label="Primary">
          {TABS.map((item) => {
            const isActive = item.id === tab
            return (
              <a
                key={item.id}
                href={item.hash}
                className={isActive ? 'active' : undefined}
                aria-current={isActive ? 'page' : undefined}
                onClick={(e) => {
                  e.preventDefault()
                  go(item)
                }}
              >
                {item.label}
              </a>
            )
          })}
        </nav>
      </div>
    </div>
  )
}
