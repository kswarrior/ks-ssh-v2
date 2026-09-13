import { useEffect, useRef, useState, type FormEvent } from 'react'

export type SshEntry = {
  id: string
  name: string
  token: string
  note: string
  online: boolean
}

const TOKEN_RE = /^[A-Z0-9]{5}$/
const PROMPT = '➜ ~'

export default function TerminalPage({
  entries: _entries,
  onChange: _onChange,
}: {
  entries: SshEntry[]
  onChange: (fn: (prev: SshEntry[]) => SshEntry[]) => void
}) {
  void _entries
  void _onChange

  const [opened, setOpened] = useState(false)
  const [token, setToken] = useState(() => {
    try {
      return (localStorage.getItem('ks-ssh:last-token') ?? '').toUpperCase()
    } catch {
      return ''
    }
  })
  const [connected, setConnected] = useState(false)
  const [agentOnline, setAgentOnline] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)

  const wsRef = useRef<WebSocket | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const push = (line: string) =>
    setLines((prev) => [...prev.slice(-499), line])

  // Auto-scroll + focus.
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines, opened, connected])

  useEffect(() => {
    if (opened) {
      const t = setTimeout(() => inputRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [opened, connected])

  // Cleanup socket on unmount.
  useEffect(
    () => () => {
      try {
        wsRef.current?.close()
      } catch {
        // Already closed — ignore.
      }
      wsRef.current = null
    },
    [],
  )

  const disconnect = () => {
    try {
      wsRef.current?.close()
    } catch {
      // Already closed — ignore.
    }
    wsRef.current = null
    setConnected(false)
    setAgentOnline(false)
  }

  const close = () => {
    disconnect()
    setOpened(false)
    setLines([])
    setInput('')
    setHistory([])
    setHistIdx(-1)
  }

  const connect = (t: string) => {
    const clean = t.trim().toUpperCase()
    if (!TOKEN_RE.test(clean)) {
      push(`invalid token "${t.trim()}" — want 5 letters/numbers`)
      return
    }
    try {
      wsRef.current?.close()
    } catch {
      // Already closed — ignore.
    }
    try {
      localStorage.setItem('ks-ssh:last-token', clean)
    } catch {
      // Storage unavailable — session still works.
    }
    setToken(clean)
    push(`connecting ${clean} …`)
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(
      `${scheme}//${window.location.host}/v1/client?token=${clean}`,
    )
    wsRef.current = ws
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', role: 'client', token: clean }))
    }
    ws.onmessage = (e) => {
      if (wsRef.current !== ws) return
      const text = String(e.data)
      try {
        const msg = JSON.parse(text) as {
          type?: string
          agent?: boolean
          online?: boolean
          data?: unknown
        }
        if (msg?.type === 'paired' || msg?.type === 'registered') {
          setConnected(true)
          const hasAgent = msg.agent === true
          setAgentOnline(hasAgent)
          push(
            hasAgent
              ? 'connected — agent online'
              : 'connected — waiting for agent …',
          )
          if (!hasAgent) {
            push(`on the machine, run:  ks-ssh --no-serve --token=${clean}`)
          }
          return
        }
        if (msg?.type === 'agent') {
          const on = msg.online === true
          setAgentOnline(on)
          push(on ? 'agent online' : 'agent offline')
          return
        }
        if (msg?.type === 'pong') return
        if (msg?.type === 'ack') return
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
      if (wsRef.current !== ws) return
      push('socket error')
      setAgentOnline(false)
    }
    ws.onclose = () => {
      if (wsRef.current !== ws) return
      wsRef.current = null
      setConnected(false)
      setAgentOnline(false)
      push('disconnected')
    }
  }

  const runLocal = (raw: string): boolean => {
    const cmd = raw.trim()
    if (cmd === 'clear') {
      setLines([])
      return true
    }
    if (cmd === 'help') {
      push('commands: clear, help, exit, <anything> sent to agent')
      return true
    }
    if (cmd === 'exit') {
      close()
      return true
    }
    return false
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const value = input
    setInput('')
    setHistIdx(-1)
    if (value.trim() !== '') {
      setHistory((prev) => [...prev.slice(-99), value])
    }
    if (!connected) {
      // Token stage: the typed line IS the token.
      if (value.trim() === '') return
      push(`token: ${value.trim().toUpperCase()}`)
      connect(value)
      return
    }
    push(`${PROMPT} ${value}`)
    if (runLocal(value)) return
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'data', data: value }))
    } else {
      push('not connected')
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (history.length === 0) return
      const next =
        histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1)
      setHistIdx(next)
      setInput(history[next] ?? '')
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (histIdx === -1) return
      const next = histIdx + 1
      if (next >= history.length) {
        setHistIdx(-1)
        setInput('')
      } else {
        setHistIdx(next)
        setInput(history[next] ?? '')
      }
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault()
      setLines([])
    }
  }

  const openTerminal = () => {
    setOpened(true)
    setLines(['KS SSH — web terminal', "enter token (5 letters/numbers), or type 'exit' to close"])
  }

  // First run: complete blank + centered button only.
  if (!opened) {
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
          onClick={openTerminal}
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
    <section
      className="page term-page"
      aria-labelledby="page-title-terminal"
    >
      <h1 id="page-title-terminal" className="sr-only">
        Terminal
      </h1>
      <div
        className="term-window"
        onClick={() => inputRef.current?.focus()}
      >
        <div className="term-titlebar">
          <span className="term-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="term-title">
            {connected ? (token ? `ssh ${token}` : 'ssh') : 'terminal'}
          </span>
          <span
            className={`term-status${connected ? (agentOnline ? ' on' : ' wait') : ''}`}
            role="status"
            title={connected ? (agentOnline ? 'Agent online' : 'Waiting for agent') : 'Offline'}
          />
          <button
            type="button"
            className="term-close"
            onClick={(e) => {
              e.stopPropagation()
              close()
            }}
            aria-label="Close terminal"
            title="Close terminal"
          >
            ×
          </button>
        </div>
        <div className="term-body" ref={bodyRef} aria-live="polite">
          {lines.map((l, i) => (
            <div key={i} className="term-line">
              {l}
            </div>
          ))}
          <form className="term-prompt-row" onSubmit={submit}>
            <span className="term-prompt" aria-hidden="true">
              {connected ? PROMPT : 'token:'}
            </span>
            <input
              ref={inputRef}
              className="term-input"
              type="text"
              value={input}
              onChange={(e) =>
                setInput(
                  connected ? e.target.value : e.target.value.toUpperCase().slice(0, 5),
                )
              }
              onKeyDown={onKeyDown}
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              aria-label={connected ? 'Terminal input' : 'Enter 5 character token'}
              placeholder={connected ? '' : 'A3K9Q'}
            />
            <span className="term-caret" aria-hidden="true" />
          </form>
        </div>
      </div>
    </section>
  )
}
