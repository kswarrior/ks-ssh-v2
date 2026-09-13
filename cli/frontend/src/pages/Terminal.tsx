import { useEffect, useRef, useState, type FormEvent } from 'react'

export type SshEntry = {
  id: string
  name: string
  token: string
  note: string
  online: boolean
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
          <button type="button" className="btn btn-sm" onClick={onBack}>
            Back
          </button>
        </div>
      </div>
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

export default function TerminalPage({
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
      setVisitingId(next.id)
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

  // First run: web-SSH style blank screen with only a centered + Terminal button.
  const isBlank = entries.length === 0 && !formOpen && !visiting && !banner
  if (isBlank) {
    return (
      <section
        className="page terminal-blank"
        aria-labelledby="page-title-terminal"
      >
        <h1 id="page-title-terminal" className="sr-only">
          Terminal
        </h1>
        <button
          type="button"
          className="btn btn-primary terminal-add-btn"
          onClick={openNew}
          autoFocus
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
          Terminal
        </button>
      </section>
    )
  }

  return (
    <section className="page" aria-labelledby="page-title-terminal">
      <div className="page-head">
        <h1 id="page-title-terminal">Terminal</h1>
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
              onClick={() => setBanner(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

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
                        >
                          Visit
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => disconnectEntry(e.id)}
                        >
                          Disconnect
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
