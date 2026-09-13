// TunnelRoom — pairs one CLI agent with web clients by 5-char token.
// The room name is `pair:<TOKEN>` (see worker/index.ts), so each token
// gets its own isolated relay. Payloads are passed through untouched,
// EXCEPT the agent UI bundle (ui-begin/ui-chunk/ui-end) which is cached
// per room so CF can serve it fullscreen over HTTPS (/v/TOKEN) and replay
// it to late-joining clients.

type Role = 'agent' | 'client'

const MAX_UI_BYTES = 5 * 1024 * 1024
const MAX_UI_CHUNKS = 256
const UI_REPLAY_RAW = 48 * 1024

export class TunnelRoom implements DurableObject {
  private state: DurableObjectState
  private agent: WebSocket | null = null
  private clients = new Set<WebSocket>()

  // Cached single-file UI pushed by the CLI agent.
  private uiHtml: string | null = null
  private uiUpdatedAt = 0
  private uiLoaded = false
  // In-progress upload from the agent (base64 chunks, independently padded).
  private uiPending: (string | null)[] | null = null
  private uiPendingSize = 0

  constructor(state: DurableObjectState) {
    this.state = state
    // Recover live sockets after hibernation (eviction).
    for (const ws of this.state.getWebSockets()) {
      const role = this.roleOf(ws)
      if (role === 'agent') {
        if (!this.agent) this.agent = ws
      } else if (role === 'client') {
        this.clients.add(ws)
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // Plain HTTP (no Upgrade) = UI retrieval for this token room.
    if (request.headers.get('Upgrade') !== 'websocket') {
      if (url.searchParams.get('ui') === 'meta') {
        await this.ensureUiLoaded()
        return Response.json({
          ok: true,
          hasUi: this.uiHtml !== null,
          size: this.uiHtml ? this.uiHtml.length : 0,
          updatedAt: this.uiUpdatedAt,
        })
      }
      await this.ensureUiLoaded()
      if (this.uiHtml === null) {
        return Response.json(
          {
            ok: false,
            error:
              'No UI pushed for this token yet. Run the CLI with --token=<TOKEN> (without --no-ui) and retry.',
          },
          { status: 404 },
        )
      }
      return new Response(this.uiHtml, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        },
      })
    }

    const role: Role =
      url.searchParams.get('role') === 'client' ? 'client' : 'agent'

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    this.state.acceptWebSocket(server)
    server.serializeAttachment(JSON.stringify({ role }))

    if (role === 'agent') {
      if (this.agent && this.agent !== server) {
        try {
          this.agent.close(4001, 'agent replaced')
        } catch {
          // Already gone — ignore.
        }
        this.agent = null
      }
      this.agent = server
      this.send(server, { type: 'registered' })
      this.broadcast({ type: 'agent', online: true })
      // If we already have a UI, tell the fresh agent (no re-push needed).
      // If we lost it (eviction without storage), ask for it.
      void this.ensureUiLoaded().then(() => {
        if (this.uiHtml) {
          this.send(server, {
            type: 'ui-stored',
            size: this.uiHtml!.length,
          })
        } else {
          this.send(server, { type: 'ui-request' })
        }
      })
    } else {
      this.clients.add(server)
      await this.ensureUiLoaded()
      this.send(server, {
        type: 'paired',
        agent: this.agent !== null,
        hasUi: this.uiHtml !== null,
        uiSize: this.uiHtml ? this.uiHtml.length : 0,
      })
      if (this.uiHtml !== null) {
        this.send(server, {
          type: 'ui-ready',
          size: this.uiHtml.length,
          updatedAt: this.uiUpdatedAt,
        })
      }
      if (this.agent) this.send(this.agent, { type: 'paired' })
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    // Answer keepalive without needing the other side.
    if (typeof message === 'string') {
      try {
        const msg = JSON.parse(message) as {
          type?: string
          encoding?: string
          size?: number
          chunks?: number
          i?: number
          data?: string
        }
        if (msg?.type === 'ping') {
          this.send(ws, { type: 'pong' })
          return
        }
        const role = this.roleOf(ws)
        // --- Agent UI upload ---
        if (role === 'agent' && msg?.type === 'ui-begin') {
          const chunks = Math.floor(Number(msg.chunks) || 0)
          const size = Math.floor(Number(msg.size) || 0)
          if (
            !Number.isFinite(chunks) ||
            chunks <= 0 ||
            chunks > MAX_UI_CHUNKS ||
            !Number.isFinite(size) ||
            size <= 0 ||
            size > MAX_UI_BYTES
          ) {
            this.send(ws, { type: 'ui-error', error: 'bad ui-begin' })
            return
          }
          this.uiPending = new Array(chunks).fill(null)
          this.uiPendingSize = size
          return // don't relay upload traffic to clients
        }
        if (role === 'agent' && msg?.type === 'ui-chunk') {
          if (!this.uiPending) return
          const i = Math.floor(Number(msg.i) || -1)
          const data = typeof msg.data === 'string' ? msg.data : ''
          if (
            !Number.isInteger(i) ||
            i < 0 ||
            i >= this.uiPending.length ||
            !data ||
            data.length > 128 * 1024
          ) {
            return
          }
          this.uiPending[i] = data
          return // don't relay
        }
        if (role === 'agent' && msg?.type === 'ui-end') {
          if (!this.uiPending || this.uiPending.some((c) => c === null)) {
            this.send(ws, { type: 'ui-error', error: 'incomplete ui upload' })
            this.uiPending = null
            return
          }
          try {
            const html = decodeUiChunks(this.uiPending as string[])
            if (!html || html.length > MAX_UI_BYTES) {
              throw new Error('ui too large')
            }
            this.uiHtml = html
            this.uiUpdatedAt = Date.now()
            this.uiPending = null
            try {
              await this.state.storage.put('uiHtml', html)
              await this.state.storage.put('uiUpdatedAt', this.uiUpdatedAt)
            } catch {
              // Storage full/unavailable — keep in-memory copy only.
            }
            this.send(ws, { type: 'ui-stored', size: html.length })
            this.broadcast({
              type: 'ui-ready',
              size: html.length,
              updatedAt: this.uiUpdatedAt,
            })
          } catch {
            this.uiPending = null
            this.send(ws, { type: 'ui-error', error: 'ui decode failed' })
          }
          return
        }
        // --- Client asks for the UI ---
        if (role === 'client' && msg?.type === 'ui-request') {
          await this.ensureUiLoaded()
          if (this.uiHtml !== null) {
            this.replayUi(ws, this.uiHtml)
          } else if (this.agent) {
            // No cache — ask the agent to (re)push; client waits for ui-ready.
            this.send(this.agent, { type: 'ui-request' })
            this.send(ws, { type: 'ui-pending' })
          } else {
            this.send(ws, { type: 'ui-missing' })
          }
          return
        }
      } catch {
        // Not JSON — treat as opaque payload below.
      }
    }
    const role = this.roleOf(ws)
    const targets: WebSocket[] =
      role === 'agent' ? [...this.clients] : this.agent ? [this.agent] : []
    for (const t of targets) {
      try {
        t.send(message)
      } catch {
        // Dead socket — cleaned up on close/error.
      }
    }
  }

  webSocketClose(ws: WebSocket) {
    this.drop(ws)
  }

  webSocketError(ws: WebSocket) {
    this.drop(ws)
  }

  private drop(ws: WebSocket) {
    if (this.agent === ws) {
      this.agent = null
      this.broadcast({ type: 'agent', online: false })
    }
    this.clients.delete(ws)
  }

  private async ensureUiLoaded(): Promise<void> {
    if (this.uiLoaded) return
    this.uiLoaded = true
    try {
      const [html, ts] = await Promise.all([
        this.state.storage.get<string>('uiHtml'),
        this.state.storage.get<number>('uiUpdatedAt'),
      ])
      if (typeof html === 'string' && html.length > 0) {
        this.uiHtml = html
        this.uiUpdatedAt = typeof ts === 'number' ? ts : 0
      }
    } catch {
      // Storage unavailable — in-memory only.
    }
  }

  /** Replay the cached UI to one client in base64 chunks. */
  private replayUi(ws: WebSocket, html: string) {
    try {
      const bytes = new TextEncoder().encode(html)
      const raws: string[] = []
      for (let off = 0; off < bytes.length; off += UI_REPLAY_RAW) {
        const slice = bytes.slice(off, off + UI_REPLAY_RAW)
        let bin = ''
        for (let i = 0; i < slice.length; i++) {
          bin += String.fromCharCode(slice[i])
        }
        raws.push(btoa(bin))
      }
      this.send(ws, {
        type: 'ui-begin',
        encoding: 'base64',
        size: bytes.length,
        chunks: raws.length,
      })
      raws.forEach((data, i) => {
        this.send(ws, { type: 'ui-chunk', i, data })
      })
      this.send(ws, { type: 'ui-end', chunks: raws.length })
    } catch {
      this.send(ws, { type: 'ui-error', error: 'ui replay failed' })
    }
  }

  private roleOf(ws: WebSocket): Role | null {
    try {
      const raw = ws.deserializeAttachment() as string | null
      if (!raw) return null
      const parsed = JSON.parse(raw) as { role?: Role }
      return parsed.role === 'client' ? 'client' : 'agent'
    } catch {
      return null
    }
  }

  private send(ws: WebSocket, payload: unknown) {
    try {
      ws.send(JSON.stringify(payload))
    } catch {
      // Dead socket — ignore.
    }
  }

  private broadcast(payload: unknown) {
    const text = JSON.stringify(payload)
    for (const c of this.clients) {
      try {
        c.send(text)
      } catch {
        // Dead socket — cleaned up on close/error.
      }
    }
  }
}

/** Decode independently-padded base64 chunks into a UTF-8 string. */
function decodeUiChunks(chunks: string[]): string {
  let total = 0
  const parts: Uint8Array[] = chunks.map((b64) => {
    const bin = atob(b64)
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) {
      arr[i] = bin.charCodeAt(i)
    }
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
