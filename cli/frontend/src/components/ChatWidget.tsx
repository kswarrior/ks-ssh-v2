import { useCallback, useEffect, useRef, useState } from 'react'

type ChatMessage = { id: number; ts: number; username: string; message: string }

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', ...init })
  if (res.status === 401) {
    window.dispatchEvent(
      new CustomEvent('ks-ssh:auth', { detail: { protected: true, authenticated: false } }),
    )
    throw Object.assign(new Error('Session expired — please log in again.'), { status: 401 })
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error || `Request failed (${res.status})`
    throw Object.assign(new Error(msg), { status: res.status })
  }
  return data as T
}

function fmtTime(ts: number): string {
  if (!ts) return ''
  try {
    return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

export default function ChatWidget() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const lastIdRef = useRef(0)
  const listRef = useRef<HTMLDivElement | null>(null)
  const openRef = useRef(open)
  openRef.current = open

  const scrollBottom = useCallback(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  const loadAll = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const data = await request<{ messages: ChatMessage[] }>('/api/chat?since=0&limit=200', {
        cache: 'no-store',
      })
      const rows = data.messages ?? []
      setMessages(rows)
      lastIdRef.current = rows.length ? rows[rows.length - 1].id : 0
      requestAnimationFrame(scrollBottom)
    } catch (e) {
      const err = e as Error & { status?: number }
      if (err.status !== 401) setLoadError(err.message)
    } finally {
      setLoading(false)
    }
  }, [scrollBottom])

  // Initial load + poll for new messages while open.
  useEffect(() => {
    if (!open) return
    void loadAll()
    const id = window.setInterval(async () => {
      if (!openRef.current) return
      try {
        const data = await request<{ messages: ChatMessage[] }>(
          `/api/chat?since=${lastIdRef.current}&limit=200`,
          { cache: 'no-store' },
        )
        const rows = data.messages ?? []
        if (rows.length) {
          setMessages((prev) => [...prev, ...rows])
          lastIdRef.current = rows[rows.length - 1].id
          requestAnimationFrame(scrollBottom)
        }
      } catch {
        // Keep old messages — next tick retries. 401 flips app to login via event.
      }
    }, 3000)
    return () => window.clearInterval(id)
  }, [open, loadAll, scrollBottom])

  const send = async (ev: React.FormEvent) => {
    ev.preventDefault()
    const text = input.trim()
    if (!text || sending) return
    setSendError(null)
    setSending(true)
    try {
      const saved = await request<ChatMessage>('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })
      setMessages((prev) => {
        if (prev.some((m) => m.id === saved.id)) return prev
        return [...prev, saved]
      })
      lastIdRef.current = Math.max(lastIdRef.current, saved.id)
      setInput('')
      requestAnimationFrame(scrollBottom)
    } catch (e) {
      const err = e as Error & { status?: number }
      if (err.status !== 401) setSendError(err.message)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="chat-fab-wrap">
      {open && (
        <section className="chat-panel" role="dialog" aria-label="Chat" aria-modal="false">
          <div className="chat-panel-head">
            <span>Chat</span>
            <button
              type="button"
              className="icon-btn chat-close"
              aria-label="Close chat"
              title="Close chat"
              onClick={() => setOpen(false)}
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
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="chat-list" ref={listRef} role="log" aria-live="polite" aria-label="Messages">
            {loading && messages.length === 0 && <p className="chat-empty">Loading…</p>}
            {!loading && messages.length === 0 && !loadError && (
              <p className="chat-empty">No messages yet. Say hello!</p>
            )}
            {loadError && messages.length === 0 && (
              <p className="login-error" role="alert">
                {loadError}{' '}
                <button type="button" className="btn btn-sm" onClick={() => void loadAll()}>
                  Retry
                </button>
              </p>
            )}
            {messages.map((m) => (
              <div key={m.id} className="chat-row">
                <div className="chat-row-head">
                  <span className="chat-username">{m.username}</span>
                  <span className="chat-time">{fmtTime(m.ts)}</span>
                </div>
                <div className="chat-text">{m.message}</div>
              </div>
            ))}
          </div>

          {sendError && (
            <p className="login-error chat-send-error" role="alert">
              {sendError}
            </p>
          )}
          <form className="chat-form" onSubmit={send}>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type a message…"
              maxLength={2000}
              aria-label="Type a message"
            />
            <button type="submit" className="btn btn-primary btn-sm" disabled={sending || !input.trim()}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </form>
        </section>
      )}

      {!open && (
        <button
          type="button"
          className="chat-fab"
          aria-label="Open chat"
          title="Open chat"
          aria-expanded={open}
          onClick={() => setOpen(true)}
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
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </button>
      )}
    </div>
  )
}
