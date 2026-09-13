import { useEffect, useRef, useState } from 'react'

const NAV = [
  { label: 'Home', href: '#' },
  { label: 'Servers', href: '#' },
  { label: 'SSH Keys', href: '#' },
  { label: 'Sessions', href: '#' },
  { label: 'Settings', href: '#' },
]

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

export default function App() {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState('Home')
  const isMobile = useIsMobile(768)
  const btnRef = useRef<HTMLButtonElement>(null)
  const asideRef = useRef<HTMLElement>(null)

  // Derived state: drawer can only be open on phones; resizing to desktop
  // auto-closes it without a setState-in-effect cascade.
  const drawerOpen = isMobile && open

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

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

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
        <span className="brand">KS SSH</span>
        <span className="header-spacer" />
        <span
          className="status-dot"
          role="status"
          aria-label="Online"
          title="Online"
        />
      </header>

      <div className="app-body">
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
              const isActive = item.label === active
              return (
                <a
                  key={item.label}
                  href={item.href}
                  className={isActive ? 'active' : undefined}
                  aria-current={isActive ? 'page' : undefined}
                  tabIndex={drawerHidden ? -1 : undefined}
                  onClick={(e) => {
                    // '#' links would jump to top + pollute history; treat as SPA nav
                    e.preventDefault()
                    setActive(item.label)
                    if (isMobile) {
                      setOpen(false)
                      btnRef.current?.focus()
                    }
                  }}
                >
                  {item.label}
                </a>
              )
            })}
          </nav>
        </aside>

        <main className="content" id="main" tabIndex={-1}>
          <h1>Hello World</h1>
          <p>React + TS on Cloudflare Workers (root /cf)</p>
        </main>
      </div>
    </div>
  )
}
