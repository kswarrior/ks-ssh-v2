// TunnelRoom — pairs one CLI agent with web clients by 5-char token.
// The room name is `pair:<TOKEN>` (see worker/index.ts), so each token
// gets its own isolated relay. Payloads are passed through untouched.

type Role = 'agent' | 'client'

export class TunnelRoom implements DurableObject {
  private state: DurableObjectState
  private agent: WebSocket | null = null
  private clients = new Set<WebSocket>()

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
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }
    const url = new URL(request.url)
    const role: Role = url.searchParams.get('role') === 'client' ? 'client' : 'agent'

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
    } else {
      this.clients.add(server)
      this.send(server, { type: 'paired', agent: this.agent !== null })
      if (this.agent) this.send(this.agent, { type: 'paired' })
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    // Answer keepalive without needing the other side.
    if (typeof message === 'string') {
      try {
        const msg = JSON.parse(message) as { type?: string }
        if (msg?.type === 'ping') {
          this.send(ws, { type: 'pong' })
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
