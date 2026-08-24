import type { Envelope } from '@shared'

// WsClient speaks the {type,seq,ts,payload} envelope protocol,
// auto-reconnects and replays from the last seen sequence number
// so no output is lost across network cuts.
export class WsClient {
  private ws: WebSocket | null = null
  private url: string
  private handlers = new Map<string, Array<(payload: any, env: Envelope) => void>>()
  private anyHandlers = new Set<(env: Envelope) => void>()
  private closedByUser = false
  private retry = 500
  private lastSeq = 0
  private pingTimer: ReturnType<typeof setInterval> | null = null

  constructor(url: string) {
    this.url = url
  }

  connect(fromSeq = 0) {
    this.closedByUser = false
    if (fromSeq > 0) this.lastSeq = fromSeq
    const sep = this.url.includes('?') ? '&' : '?'
    const url = `${this.url}${sep}from=${this.lastSeq}`
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    this.ws = new WebSocket(`${proto}://${location.host}${url}`)
    this.ws.onopen = () => {
      this.retry = 500
      if (!this.pingTimer) {
        this.pingTimer = setInterval(() => this.send('ws.ping', {}), 5000)
      }
      this.emit('_open', {})
    }
    this.ws.onmessage = ev => {
      try {
        const env: Envelope = JSON.parse(ev.data)
        if (env.seq > 0) {
          if (this.lastSeq > 0 && env.seq > this.lastSeq + 1) {
            // gap detected: request replay from our position
            this.reconnectFrom(this.lastSeq)
            return
          }
          this.lastSeq = Math.max(this.lastSeq, env.seq)
        }
        for (const h of this.handlers.get(env.type) ?? []) h(env.payload, env)
        this.anyHandlers.forEach(h => h(env))
      } catch {
        /* malformed frame ignored */
      }
    }
    this.ws.onclose = () => {
      if (this.pingTimer) {
        clearInterval(this.pingTimer)
        this.pingTimer = null
      }
      this.emit('_close', {})
      if (!this.closedByUser) {
        setTimeout(() => this.connect(0), this.retry)
        this.retry = Math.min(this.retry * 2, 10000)
      }
    }
    this.ws.onerror = () => this.ws?.close()
  }

  private reconnectFrom(seq: number) {
    this.ws?.close()
    setTimeout(() => this.connect(seq), 200)
  }

  get currentSeq() {
    return this.lastSeq
  }

  on(type: string, fn: (payload: any, env: Envelope) => void): () => void {
    const list = this.handlers.get(type) ?? []
    list.push(fn)
    this.handlers.set(type, list)
    return () => {
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    }
  }

  private emit(type: string, payload: any) {
    ;(this.handlers.get(type) ?? []).forEach(h =>
      h(payload, { type, seq: 0, ts: 0, payload: undefined }))
  }

  send(type: string, payload: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, seq: 0, ts: Date.now(), payload }))
    }
  }

  close() {
    this.closedByUser = true
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    this.ws?.close()
  }
}
