import { useEffect, useState } from 'react'
import TerminalPage, { type SshEntry } from './pages/Terminal'
import FilesPage from './pages/Files'
import PortsPage from './pages/Ports'

type TabId = 'terminal' | 'files' | 'ports'

type TabItem = { id: TabId; label: string; hash: string }

const TABS: TabItem[] = [
  { id: 'terminal', label: 'Terminal', hash: '#/terminal' },
  { id: 'files', label: 'Files', hash: '#/files' },
  { id: 'ports', label: 'Ports', hash: '#/ports' },
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

/** Map a location hash to a tab, or null when it is not a tab route. */
function hashToTab(hash: string): TabId | null {
  const clean = hash.replace(/^#\/?/, '')
  const found = TABS.find((t) => t.hash.replace(/^#\/?/, '') === clean)
  return found ? found.id : null
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
    const label = TABS.find((t) => t.id === tab)?.label
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
          className={`content${tab === 'terminal' ? ' content-term' : ''}`}
          id="main"
          tabIndex={-1}
        >
          <div hidden={tab !== 'terminal'}>
            <TerminalPage entries={entries} onChange={setEntries} />
          </div>
          <div hidden={tab !== 'files'}>
            <FilesPage />
          </div>
          <div hidden={tab !== 'ports'}>
            <PortsPage />
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
