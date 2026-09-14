import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  E2E_ALG,
  E2eSession,
  extractKeyFromText,
  parseFragmentKey,
  type E2eStatus,
  type EncEnvelope,
} from './e2e'

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
  // E2E: `k` lives in memory only — never localStorage, never query/fetch.
  const [e2eKey, setE2eKey] = useState<string | null>(() => parseFragmentKey())
  const [e2eStatus, setE2eStatus] = useState<E2eStatus>(() =>
    parseFragmentKey() ? 'on' : 'off',
  )
  const [peerE2e, setPeerE2e] = useState<boolean | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const e2eRef = useRef<E2eSession | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)

  const push = (line: string) =>
    setLines((prev) => [...prev.slice(-99), line])

  const token = entry.token.trim().toUpperCase()
  useEffect(() => {
    let cancelled = false
    let ws: WebSocket | null = null
    e2eRef.current = null
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    // NOTE: token in query only (routing). `k` never leaves the fragment/memory.
    const open = async () => {
      if (e2eKey) {
        try {
          e2eRef.current = await E2eSession.create(e2eKey, token)
          if (cancelled) return
          setE2eStatus('on')
        } catch {
          if (cancelled) return
          e2eRef.current = null
          setE2eStatus('error')
          push('E2E setup failed — check the pasted link')
          return
        }
      } else {
        setE2eStatus('off')
      }
      try {
        ws = new WebSocket(
          `${scheme}//${window.location.host}/v1/client?token=${token}`,
        )
      } catch {
        push('socket error')
        return
      }
      wsRef.current = ws
      push(e2eKey ? `joining ${token} … (🔒 E2E)` : `joining ${token} … (⚠️ no E2E key)`)
      ws.onopen = () => {
        // hello carries token+role only (no k); e2e advertises capability.
        ws?.send(
          JSON.stringify(
            e2eRef.current
              ? { type: 'hello', role: 'client', token, e2e: E2E_ALG }
              : { type: 'hello', role: 'client', token },
          ),
        )
      }
      ws.onmessage = (e) => {
        void handleRelayMessage(String(e.data))
      }
      ws.onerror = () => {
        push('socket error')
        setAgentOnline(false)
      }
      ws.onclose = () => {
        push('socket closed')
        setAgentOnline(false)
      }
    }

    const handleInner = (inner: { type?: string; data?: unknown }) => {
      if (inner?.type === 'ack') {
        push('agent ack')
        return
      }
      if (typeof inner?.data === 'string') {
        push(inner.data)
        return
      }
    }

    const handleRelayMessage = async (text: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let msg: any = null
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        msg = JSON.parse(text)
      } catch {
        push(text)
        return
      }
      // Sealed payloads: decrypt (seq-checked), then handle inner JSON.
      // NOTE: check `type === 'enc'` manually (no type-guard narrowing) —
      // `ct` bytes are never logged or stored.
      if (msg?.type === 'enc') {
        const sess = e2eRef.current
        if (!sess) {
          push('got enc but no E2E key — paste the full link with #k=...')
          setE2eStatus('off')
          return
        }
        try {
          const pt = await sess.decryptNext(msg as unknown as EncEnvelope)
          const inner = JSON.parse(new TextDecoder().decode(pt)) as {
            type?: string
            data?: unknown
          }
          handleInner(inner)
        } catch {
          // Wrong key / tampered tag — generic message, no details.
          push('E2E decrypt failed')
          setE2eStatus('error')
        }
        return
      }
      if (!msg) {
        push(text)
        return
      }
      // Peer capability (agent hello forwarded by the room).
      if (msg?.type === 'hello') {
        if (msg.e2e === E2E_ALG) {
          setPeerE2e(true)
          push('peer supports E2E')
        } else {
          setPeerE2e(false)
          if (e2eRef.current) push('peer is legacy (no E2E) — relay-visible for its messages')
        }
        return
      }
      if (msg?.type === 'paired' || msg?.type === 'registered') {
        push(msg.agent ? 'paired — agent online' : 'paired — waiting for agent …')
        setAgentOnline(msg.agent === true)
        return
      }
      if (msg?.type === 'agent') {
        push(msg.online ? 'agent online' : 'agent offline')
        setAgentOnline(msg.online === true)
        return
      }
      if (msg?.type === 'pong') return
      if (msg?.type === 'ack') {
        push('agent ack')
        return
      }
      if (typeof msg?.data === 'string') {
        // Plaintext data while E2E is on = legacy peer, relay-visible.
        if (e2eRef.current) push('(plaintext, relay-visible)')
        push(msg.data)
        return
      }
      push(text)
    }

    void open()
    return () => {
      cancelled = true
      wsRef.current = null
      try {
        ws?.close()
      } catch {
        // Already closed — ignore.
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, e2eKey])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  const send = (e: FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text || !wsRef.current) return
    const ws = wsRef.current
    const sess = e2eRef.current
    if (sess) {
      // Wrap sensitive payloads in enc; ack comes back inside enc.
      void sess
        .encryptNext(JSON.stringify({ type: 'data', data: text }))
        .then((env) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(env))
          push(`> ${text}`)
          setDraft('')
        })
        .catch(() => {
          push('E2E encrypt failed')
          setE2eStatus('error')
        })
    } else {
      ws.send(JSON.stringify({ type: 'data', data: text }))
      push(`> ${text}`)
      setDraft('')
    }
  }

  const unlock = (e: FormEvent) => {
    e.preventDefault()
    const k = extractKeyFromText(keyInput.trim())
    if (!k) {
      setKeyError('Paste the full link with #k=... (43 chars, fragment only).')
      return
    }
    setKeyError(null)
    // In-memory only — never persisted.
    setKeyInput('')
    setE2eKey(k)
    push('E2E key set (memory only) — reconnecting …')
  }

  return (
    <div className="card">
      <div className="page-head">
        <h2>
          {entry.name} <code>{token}</code>
        </h2>
        <div className="row-actions">
          <StatusTag online={agentOnline} />
          <E2eBadge status={e2eKey ? e2eStatus : 'off'} />
          <button type="button" className="btn btn-sm" onClick={onBack}>
            Back
          </button>
        </div>
      </div>
      {!e2eKey && (
        <div className="banner-error" role="alert">
          <p>
            ⚠️ Relay-visible (legacy): no E2E key. Paste the full link with{' '}
            <code>#k=...</code> to enable 🔒 E2E. The key stays in memory only —
            never fetched over HTTP, never stored.
          </p>
          <form className="form" onSubmit={unlock}>
            <label className="field">
              Full link (with #k=...)
              <input
                type="text"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder="https://…/v/ABCDE#k=…"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            {keyError && <p>{keyError}</p>}
            <div className="row-actions">
              <button type="submit" className="btn btn-sm btn-primary">
                Enable E2E
              </button>
            </div>
          </form>
        </div>
      )}
      {e2eKey && peerE2e === false && (
        <div className="banner-error" role="alert">
          <p>⚠️ Relay is NOT end-to-end encrypted for this peer (legacy agent without E2E).</p>
        </div>
      )}
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
      // Presence check only (no secrets). Include e2e capability when the
      // fragment carries `k` so the agent can distinguish E2E vs legacy.
      // `k` itself never leaves the fragment/memory.
      const k = parseFragmentKey()
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
        }
        // `enc` payloads are opaque here — handled in the session view.
        if (msg?.type === 'enc') return
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

function ViewPage() {
  const [token, setToken] = useState(() => hashToViewToken(window.location.hash) ?? '')
  const [activeToken, setActiveToken] = useState<string | null>(() =>
    hashToViewToken(window.location.hash),
  )
  const [meta, setMeta] = useState<{ hasUi: boolean; size: number } | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [srcDoc, setSrcDoc] = useState<string | null>(null)
  const [cacheBust, setCacheBust] = useState(0)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)

  // Deep link support: #/view/ABCDE loads that token.
  useEffect(() => {
    const onHash = () => {
      const t = hashToViewToken(window.location.hash)
      if (t) {
        setToken(t)
        setActiveToken(t)
      }
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

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
        const res = await fetch(`/api/ui/${activeToken}/meta`, {
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
        await loadViaWss(activeToken, ctrl.signal, cancelled, {
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
  }, [activeToken, cacheBust])

  // Live reload: when the agent re-pushes, the room broadcasts ui-ready.
  useEffect(() => {
    if (!activeToken || srcDoc !== null) return
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    let ws: WebSocket | null = null
    try {
      ws = new WebSocket(
        `${scheme}//${window.location.host}/v1/client?token=${activeToken}`,
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
        const msg = JSON.parse(String(e.data)) as { type?: string }
        // `enc` is opaque sealed traffic — ignore here (UI is plaintext).
        if (msg?.type === 'enc') return
        if (msg?.type === 'ui-ready') {
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
  }, [activeToken, srcDoc])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const t = token.trim().toUpperCase()
    if (!/^[A-Z0-9]{5}$/.test(t)) {
      setError('Token is 5 letters/numbers.')
      return
    }
    window.location.hash = `#/view/${t}`
    setActiveToken(t)
  }

  const openFullscreen = async () => {
    try {
      const el = wrapRef.current
      if (el?.requestFullscreen) {
        await el.requestFullscreen()
      } else {
        // Fallback: raw /v/ page in a new tab is already fullscreen-capable.
        window.open(`/v/${activeToken}`, '_blank', 'noopener')
      }
    } catch {
      setError('Fullscreen blocked — use "Open raw" in a new tab instead.')
    }
  }

  const frameSrc =
    activeToken && meta?.hasUi && srcDoc === null
      ? `/v/${activeToken}${cacheBust ? `?t=${cacheBust}` : ''}`
      : undefined

  return (
    <section className="page page-view" aria-labelledby="page-title-view">
      <div className="page-head">
        <h1 id="page-title-view">View</h1>
        {activeToken && (meta?.hasUi || srcDoc) && (
          <div className="row-actions">
            <E2eBadge status={parseFragmentKey() ? 'on' : 'off'} />
            <button type="button" className="btn btn-sm btn-primary" onClick={openFullscreen}>
              Fullscreen
            </button>
            <a
              className="btn btn-sm"
              href={`/v/${activeToken}`}
              target="_blank"
              rel="noreferrer"
            >
              Open raw
            </a>
          </div>
        )}
      </div>
      <p className="lead">
        Open the full UI pushed by your CLI over WSS — no port forwarding.
        Run <code>ks-ssh --no-serve --token=ABCDE</code>, then enter the token.
        UI bundle is public (plaintext); session content needs the full link
        with <code>#k=...</code> for 🔒 E2E.
      </p>
      <div className="card">
        <form className="form" onSubmit={submit}>
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
          <div className="row-actions">
            <button type="submit" className="btn btn-primary">
              Load UI
            </button>
            {activeToken && (
              <button
                type="button"
                className="btn"
                onClick={() => setCacheBust((n) => n + 1)}
              >
                Reload
              </button>
            )}
          </div>
        </form>
        {checking && <p aria-live="polite">Checking for agent UI …</p>}
        {error && (
          <div className="banner-error" role="alert">
            <p>{error}</p>
          </div>
        )}
        {activeToken && !checking && !meta?.hasUi && !srcDoc && !error && (
          <p>
            Waiting for the agent UI for <code>{activeToken}</code>. On the
            machine, run: <code>ks-ssh --no-serve --token={activeToken}</code>
          </p>
        )}
      </div>

      {activeToken && (meta?.hasUi || srcDoc) && (
        <div className="view-wrap" ref={wrapRef}>
          <div className="view-bar">
            <code>/v/{activeToken}</code>
            {meta && <span>{Math.round(meta.size / 1024)} KB</span>}
            <span className="header-spacer" />
            <button type="button" className="btn btn-sm btn-primary" onClick={openFullscreen}>
              Fullscreen
            </button>
          </div>
          {srcDoc !== null ? (
            <iframe
              ref={frameRef}
              title={`Agent UI ${activeToken}`}
              className="view-frame"
              srcDoc={srcDoc}
              allow="fullscreen"
              allowFullScreen
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          ) : (
            <iframe
              ref={frameRef}
              title={`Agent UI ${activeToken}`}
              className="view-frame"
              src={frameSrc}
              allow="fullscreen"
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
      ws = new WebSocket(`${scheme}//${window.location.host}/v1/client?token=${token}`)
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
          `No UI for ${token} yet. Run: ks-ssh --no-serve --token=${token}`,
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
            hooks.setError(`No UI for ${token} yet. Run: ks-ssh --no-serve --token=${token}`)
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
        hooks.setError(`No UI for ${token} yet. Run: ks-ssh --no-serve --token=${token}`)
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
          {page === 'view' && <ViewPage />}
          {page === 'installation' && <InstallationPage />}
          {page === 'settings' && (
            <SettingsPage settings={settings} onChange={patchSettings} />
          )}
        </main>
      </div>
    </div>
  )
}
