import { useEffect, useState } from 'react'

const NAV = [
  { label: 'Home', href: '#', active: true },
  { label: 'Servers', href: '#' },
  { label: 'SSH Keys', href: '#' },
  { label: 'Sessions', href: '#' },
  { label: 'Settings', href: '#' },
]

export default function App() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app-shell">
      <header className="app-header">
        <button
          type="button"
          className={`hamburger${open ? ' is-open' : ''}`}
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span />
          <span />
          <span />
        </button>
        <span className="brand">ks-ssh-v2</span>
        <span className="header-spacer" />
        <span className="status-dot" title="online" />
      </header>

      <div className="app-body">
        <div
          className={`overlay${open ? ' show' : ''}`}
          onClick={() => setOpen(false)}
          aria-hidden={!open}
        />
        <aside className={`sidebar${open ? ' open' : ''}`} aria-hidden={!open}>
          <nav>
            {NAV.map((item) => (
              <a
                key={item.label}
                href={item.href}
                className={item.active ? 'active' : ''}
                onClick={() => setOpen(false)}
              >
                {item.label}
              </a>
            ))}
          </nav>
        </aside>

        <main className="content">
          <h1>Hello World</h1>
          <p>React + TS on Cloudflare Workers (root /cf)</p>
        </main>
      </div>
    </div>
  )
}
