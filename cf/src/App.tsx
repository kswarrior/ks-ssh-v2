import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'

type PageId = 'home' | 'ssh' | 'view' | 'installation' | 'settings'

type NavItem = { id: PageId; label: string; hash: string }

const NAV: NavItem[] = [
  { id: 'home', label: 'Home', hash: '#/' },
  { id: 'ssh', label: 'SSH', hash: '#/ssh' },
  { id: 'view', label: 'View', hash: '#/view' },
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
  // Support deep links like #/view/ABCDE -> view page.
  if (clean === 'view' || clean.startsWith('view/')) return 'view'
  const found = NAV.find((p) => p.hash.replace(/^#\/?/, '') === clean)
  return found ? found.id : null
}

/** Extract a 5-char token from #/view/ABCDE or ?token=ABCDE. */
function hashToViewToken(hash: string): string | null {
  const m = hash.match(/^#\/view\/([A-Za-z0-9]{0,5})/)
  if (m?.[1] && /^[A-Za-z0-9]{5}$/.test(m[1])) return m[1].toUpperCase()
  try {
    const q = new URLSearchParams(window.location.search).get('token')
    if (q && /^[A-Za-z0-9]{5}$/.test(q)) return q.toUpperCase()
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

function HomePage() {
  return (
    <section className="page" aria-labelledby="page-title-home">
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
          text="Tokens stay in your browser. Nothing is uploaded or tracked."
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

      <h2>Features</h2>
      <div className="grid">
        <FeatureTile
          icon={
            <>
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </>
          }
          title="Token auth"
          text="Paste your token once, connect anytime."
        />
        <FeatureTile
          icon={<polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />}
          title="Live status"
          text="Green means go. See what is online at a glance."
        />
        <FeatureTile
          icon={
            <>
              <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
              <path d="M6 16h.01M10 16h.01" />
            </>
          }
          title="Local-first"
          text="Your list persists on this device. No account needed."
        />
        <FeatureTile
          icon={
            <>
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </>
          }
          title="One-tap reconnect"
          text="Dropped? Reconnect straight from the card."
        />
      </div>

      <h2>Screenshots</h2>
      <div className="shot-grid">
        {['Home', 'SSH list', 'Installation'].map((label) => (
          <div key={label} className="shot">
            <Icon>
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </Icon>
            <span>
              {label} — your screenshot here
            </span>
          </div>
        ))}
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

function ActiveSession({
  entry,
  onBack,
}: {
  entry: SshEntry
  onBack: () => void
}) {
  const [lines, setLines] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [agentOnline, setAgentOnline] = useState(false)
  const [hasUi, setHasUi] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)

  const push = (line: string) =>
    setLines((prev) => [...prev.slice(-99), line])

  const token = entry.token.trim().toUpperCase()
  useEffect(() => {
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(
      `${scheme}//${window.location.host}/v1/client?token=${token}`,
    )
    wsRef.current = ws
    push(`joining ${token} …`)
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', role: 'client', token }))
    }
    ws.onmessage = (e) => {
      const text = String(e.data)
      try {
        const msg = JSON.parse(text) as {
          type?: string
          agent?: boolean
          online?: boolean
          data?: unknown
          hasUi?: boolean
          size?: number
        }
        if (msg?.type === 'paired' || msg?.type === 'registered') {
          push(msg.agent ? 'paired — agent online' : 'paired — waiting for agent …')
          setAgentOnline(msg.agent === true)
          if (msg.hasUi === true) {
            setHasUi(true)
            push(`agent UI ready (${msg.size ?? '?'} bytes) — open View for fullscreen`)
          }
          return
        }
        if (msg?.type === 'agent') {
          push(msg.online ? 'agent online' : 'agent offline')
          setAgentOnline(msg.online === true)
          return
        }
        if (msg?.type === 'ui-ready') {
          setHasUi(true)
          push(`agent UI ready (${msg.size ?? '?'} bytes) — open View for fullscreen`)
          return
        }
        if (msg?.type === 'ui-pending') {
          push('agent UI uploading …')
          return
        }
        if (msg?.type === 'pong') return
        if (msg?.type === 'ack') {
          push('agent ack')
          return
        }
        if (typeof msg?.data === 'string') {
          push(msg.data)
          return
        }
      } catch {
        // Not JSON — show raw text below.
      }
      push(text)
    }
    ws.onerror = () => {
      push('socket error')
      setAgentOnline(false)
    }
    ws.onclose = () => {
      push('socket closed')
      setAgentOnline(false)
    }
    return () => {
      wsRef.current = null
      try {
        ws.close()
      } catch {
        // Already closed — ignore.
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  const send = (e: FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text || !wsRef.current) return
    wsRef.current.send(JSON.stringify({ type: 'data', data: text }))
    push(`> ${text}`)
    setDraft('')
  }

  return (
    <div className="card">
      <div className="page-head">
        <h2>
          {entry.name} <code>{token}</code>
        </h2>
        <div className="row-actions">
          <StatusTag online={agentOnline} />
          {hasUi && (
            <a className="btn btn-sm btn-primary" href={`#/view/${token}`}>
              Fullscreen UI
            </a>
          )}
          <button type="button" className="btn btn-sm" onClick={onBack}>
            Back
          </button>
        </div>
      </div>
      {hasUi && (
        <div className="banner-ui" role="status">
          <p>
            Agent pushed its full UI ({' '}
            <a href={`/v/${token}`} target="_blank" rel="noreferrer">
              /v/{token}
            </a>{' '}
            ). Open it fullscreen:
          </p>
          <div className="row-actions">
            <a className="btn btn-sm btn-primary" href={`#/view/${token}`}>
              Open fullscreen
            </a>
            <a
              className="btn btn-sm"
              href={`/v/${token}`}
              target="_blank"
              rel="noreferrer"
            >
              Open raw /v/{token}
            </a>
          </div>
        </div>
      )}
      {!agentOnline && (
        <>
          <p>Waiting for the agent. On the machine, run:</p>
          <CodeBlock code={`ks-ssh --no-serve --token=${token}`} />
        </>
      )}
      <div className="ws-log" ref={logRef} aria-live="polite">
        {lines.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
      <form className="form" onSubmit={send}>
        <label className="field">
          Send
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="type + Enter"
            autoComplete="off"
          />
        </label>
      </form>
    </div>
  )
}

function SSHPage({
  entries,
  onChange,
}: {
  entries: SshEntry[]
  onChange: (fn: (prev: SshEntry[]) => SshEntry[]) => void
}) {
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [token, setToken] = useState('')
  const [note, setNote] = useState('')
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const [visitingId, setVisitingId] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const socketsRef = useRef(new Map<string, WebSocket>())

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

  const attemptConnect = (entry: SshEntry) => {
    if (!entry || entry.online || connectingId) return
    const t = entry.token.trim().toUpperCase()
    if (!/^[A-Z0-9]{5}$/.test(t)) {
      setBanner('Token is 5 letters/numbers — run `ks-ssh --token=` to get one.')
      return
    }
    closeSocket(entry.id)
    setConnectingId(entry.id)
    setBanner(null)
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(
      `${scheme}//${window.location.host}/v1/client?token=${t}`,
    )
    socketsRef.current.set(entry.id, ws)
    const timeout = setTimeout(() => {
      if (socketsRef.current.get(entry.id) !== ws) return
      closeSocket(entry.id)
      setConnectingId((cur) => (cur === entry.id ? null : cur))
      setBanner('Relay timed out. Is the agent running (`ks-ssh --token=`)?')
    }, 8000)
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', role: 'client', token: t }))
    }
    ws.onmessage = (e) => {
      if (socketsRef.current.get(entry.id) !== ws) return
      try {
        const msg = JSON.parse(String(e.data)) as {
          type?: string
          online?: boolean
        }
        if (msg?.type === 'paired' || msg?.type === 'registered') {
          clearTimeout(timeout)
          setConnectingId((cur) => (cur === entry.id ? null : cur))
          onChange((prev) =>
            prev.map((x) => (x.id === entry.id ? { ...x, online: true } : x)),
          )
        } else if (msg?.type === 'agent' && msg.online === false) {
          closeSocket(entry.id)
          onChange((prev) =>
            prev.map((x) => (x.id === entry.id ? { ...x, online: false } : x)),
          )
        }
      } catch {
        // Binary relay payloads are handled in the session view.
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
    setVisitingId((cur) => (cur === id ? null : cur))
    onChange((prev) =>
      prev.map((x) => (x.id === id ? { ...x, online: false } : x)),
    )
  }

  const visitEntry = (entry: SshEntry) => {
    setVisitingId(entry.id)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const cleanName = name.trim()
    const cleanToken = token.trim().toUpperCase()
    if (!cleanName || !cleanToken) return
    if (!/^[A-Z0-9]{5}$/.test(cleanToken)) {
      setBanner('Token is 5 letters/numbers — run `ks-ssh --token=` to get one.')
      return
    }
    if (editingId) {
      onChange((prev) =>
        prev.map((x) =>
          x.id === editingId
            ? { ...x, name: cleanName, token: cleanToken, note: note.trim() }
            : x,
        ),
      )
      closeForm()
    } else {
      const id = `ssh-${Date.now().toString(36)}-${Math.floor(Math.random() * 10000)}`
      const next: SshEntry = {
        id,
        name: cleanName,
        token: cleanToken,
        note: note.trim(),
        online: false,
      }
      onChange((prev) => [...prev, next])
      closeForm()
      attemptConnect(next)
    }
  }

  const removeEntry = (id: string) => {
    closeSocket(id)
    setConnectingId((cur) => (cur === id ? null : cur))
    setVisitingId((cur) => (cur === id ? null : cur))
    onChange((prev) => prev.filter((x) => x.id !== id))
  }

  const visiting = entries.find((x) => x.id === visitingId) ?? null

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
                onChange={(e) => setToken(e.target.value.toUpperCase().slice(0, 5))}
                placeholder="A3K9Q"
                autoComplete="off"
                inputMode="text"
                maxLength={5}
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

      {visiting ? (
        <ActiveSession entry={visiting} onBack={() => setVisitingId(null)} />
      ) : entries.length === 0 && !formOpen ? (
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
                <div className="ssh-head">
                  <span className="ssh-icon" aria-hidden="true">
                    <SshGlyph />
                  </span>
                  <span className="ssh-name">{e.name}</span>
                  <StatusTag online={e.online} connecting={connecting} />
                </div>
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
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          onClick={() => visitEntry(e)}
                          aria-label={`Visit ${e.name}`}
                          title="Visit"
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
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                            <polyline points="15 3 21 3 21 9" />
                            <line x1="10" y1="14" x2="21" y2="3" />
                          </svg>
                        </button>
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

function InstallationPage() {
  return (
    <section className="page" aria-labelledby="page-title-installation">
      <h1 id="page-title-installation">Installation</h1>
      <p className="lead">Paste this in your terminal to download and run:</p>
      <div className="card">
        <CodeBlock code="curl -sSfL https://raw.githubusercontent.com/kswarrior/ks-ssh-v2/refs/heads/main/cli/release/ks-ssh -o ks-ssh && chmod +x ks-ssh && ./ks-ssh" />
      </div>
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
  const [backendOk, setBackendOk] = useState<boolean | null>(null)

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

  // Live backend status for the sidebar panel.
  useEffect(() => {
    let cancelled = false
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), 5000)
    const check = async () => {
      try {
        const res = await fetch('/api/health', { signal: ctrl.signal })
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean
        } | null
        if (!cancelled) setBackendOk(res.ok && data?.ok === true)
      } catch {
        if (!cancelled) setBackendOk(false)
      } finally {
        clearTimeout(timeout)
      }
    }
    void check()
    return () => {
      cancelled = true
      clearTimeout(timeout)
      ctrl.abort()
    }
  }, [])

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
          <div className="sidebar-spacer" aria-hidden="true" />
          <div className="sidebar-status">
            <div className="sidebar-status-row">
              <span
                className={`status-dot${backendOk === false ? ' off' : ''}`}
                aria-hidden="true"
              />
              <span>
                Backend{' '}
                {backendOk === null
                  ? '…'
                  : backendOk
                    ? 'online'
                    : 'offline'}
              </span>
            </div>
            <div className="sidebar-status-row">
              <span className="sidebar-status-label">Connections</span>
              <span className="sidebar-status-value">{entries.length}</span>
            </div>
            <div className="sidebar-status-row">
              <span className="sidebar-status-label">Online</span>
              <span className="sidebar-status-value">
                {entries.filter((x) => x.online).length}
              </span>
            </div>
          </div>
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
          {page === 'home' && <HomePage />}
          {page === 'ssh' && <SSHPage entries={entries} onChange={setEntries} />}
          {page === 'installation' && <InstallationPage />}
          {page === 'settings' && (
            <SettingsPage settings={settings} onChange={patchSettings} />
          )}
        </main>
      </div>
    </div>
  )
}
