/**
 * Relay shim: makes the pushed single-file bundle fully functional over WSS.
 *
 * Local `--port` mode: this module does nothing (native fetch/WebSocket).
 * Relay mode (CF Visit: `/v/TOKEN` iframe or `srcDoc` with injected globals):
 * `/api/*` fetch + `/v1/shell` WebSocket are tunnelled over one shared
 * `wss://<host>/v1/client?token=TOKEN` connection to the CLI agent, which
 * proxies them to its loopback-only server (same router/auth/DB/shells as
 * `--port`). The Worker relays `rpc-*` / `shell-*` opaquely by room.
 *
 * Plaintext by design (like the UI bundle itself); E2E `enc` stays for
 * future sealed session payloads. Token routes, never logged beyond routing.
 */

import {
  E2E_ALG,
  E2eChannel,
  fingerprint as e2eFingerprint,
  isEncEnvelope,
  readRelayKey,
  type EncEnvelope,
} from './relay-e2e.ts'

const RPC_RAW = 48 * 1024
const RPC_TIMEOUT_MS = 120_000
const SHELL_OPEN_TIMEOUT_MS = 10_000
const HELLO_TIMEOUT_MS = 10_000
/** Tokens are 9 chars fresh, 5 chars legacy — both route. */
const TOKEN_RE = /^[A-Za-z0-9]{5}$|^[A-Za-z0-9]{9}$/
const TOKEN_PATH_RE = /^\/v\/([A-Za-z0-9]{5}|[A-Za-z0-9]{9})(?:\/|$)/

type RelayGlobals = {
  __KS_RELAY_TOKEN__?: unknown
  __KS_RELAY_HOST__?: unknown
}

function relayToken(): string | null {
  try {
    const g = window as unknown as RelayGlobals
    const injected = typeof g.__KS_RELAY_TOKEN__ === 'string' ? g.__KS_RELAY_TOKEN__ : ''
    if (TOKEN_RE.test(injected)) return injected.toUpperCase()
  } catch {
    // Ignore — fall through to pathname parsing.
  }
  try {
    const host = window.location.host ?? ''
    // Local/LAN `--port` servers stay native even if someone opens /v/…
    // manually (their relay WSS would 404 anyway; direct fetch just works).
    if (
      host === '' ||
      host.startsWith('localhost') ||
      host.startsWith('127.') ||
      host === '[::1]' ||
      host.startsWith('192.168.') ||
      host.startsWith('10.') ||
      /^(172\.(1[6-9]|2\d|3[01])\.)/.test(host)
    ) {
      return null
    }
    const m = window.location.pathname.match(TOKEN_PATH_RE)
    if (m?.[1]) return m[1].toUpperCase()
  } catch {
    // Non-browser or opaque origin (srcDoc without injection) — not relay.
  }
  return null
}

function relayHost(): string {
  try {
    const g = window as unknown as RelayGlobals
    const injected = typeof g.__KS_RELAY_HOST__ === 'string' ? g.__KS_RELAY_HOST__ : ''
    if (injected) return injected
  } catch {
    // Ignore.
  }
  try {
    return window.location.host ?? ''
  } catch {
    return ''
  }
}

function b64encode(raw: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < raw.length; i += CHUNK) {
    const slice = raw.subarray(i, i + CHUNK)
    bin += String.fromCharCode(...slice)
  }
  return btoa(bin)
}

function b64decode(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
}

// ---------------------------------------------------------------------------
// Auth cookie jar (the agent's `ks_ssh_auth`, kept out of document.cookie).
// ---------------------------------------------------------------------------

const COOKIE_NAME = 'ks_ssh_auth'

function jarKey(token: string): string {
  return `ks-relay-cookie:${token}`
}

function loadJar(token: string): string {
  try {
    return localStorage.getItem(jarKey(token)) ?? ''
  } catch {
    return ''
  }
}

function saveJar(token: string, cookieValue: string): void {
  try {
    if (cookieValue) localStorage.setItem(jarKey(token), cookieValue)
    else localStorage.removeItem(jarKey(token))
  } catch {
    // Private mode — memory only (module-level cache below covers it).
  }
}

function parseSetCookie(header: string): string | null {
  // `ks_ssh_auth=abc; Path=/; HttpOnly; ...` or `ks_ssh_auth=; Expires=…` (logout).
  const first = header.split(';')[0]?.trim() ?? ''
  if (!first.startsWith(`${COOKIE_NAME}=`)) return null
  const value = first.slice(COOKIE_NAME.length + 1)
  return value ? `${COOKIE_NAME}=${value}` : ''
}

// ---------------------------------------------------------------------------
// Shared relay connection (one WSS per iframe).
// ---------------------------------------------------------------------------

type PendingRpc = {
  resolve: (res: Response) => void
  reject: (err: Error) => void
  timer: number
  status: number
  headers: Headers
  chunks: (string | null)[]
  expected: number
  received: number
  gotBegin: boolean
}

type JsonMsg = Record<string, unknown>

class RelayConnection {
  private token: string
  private host: string
  private ws: WebSocket | null = null
  private connecting: Promise<void> | null = null
  private cookie: string
  private rpcSeq = 0
  private pending = new Map<string, PendingRpc>()
  private shells = new Map<string, RelaySocket>()
  private keepalive: number | undefined
  private NativeWS: typeof WebSocket

  constructor(token: string, host: string, NativeWS: typeof WebSocket) {
    this.token = token
    this.host = host
    this.NativeWS = NativeWS
    this.cookie = loadJar(token)
  }

  get ready(): boolean {
    return this.ws !== null && this.ws.readyState === 1
  }

  ensure(): Promise<void> {
    if (this.ready) return Promise.resolve()
    if (this.connecting) return this.connecting
    this.connecting = new Promise((resolve, reject) => {
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      let ws: WebSocket
      try {
        ws = new this.NativeWS(`${scheme}//${this.host}/v1/client?token=${this.token}`)
      } catch (e) {
        this.connecting = null
        reject(e instanceof Error ? e : new Error('relay connect failed'))
        return
      }
      const timeout = window.setTimeout(() => {
        try {
          ws.close()
        } catch {
          // Ignore.
        }
        this.connecting = null
        reject(new Error('relay connect timed out'))
      }, 10_000)
      ws.onopen = () => {
        window.clearTimeout(timeout)
        try {
          ws.send(JSON.stringify({ type: 'hello', role: 'client', token: this.token }))
        } catch {
          // Hello is best-effort; pairing still works without it.
        }
        this.ws = ws
        this.connecting = null
        this.startKeepalive()
        ws.onmessage = (e) => {
          this.onMessage(e.data)
        }
        ws.onclose = () => {
          this.onClose()
        }
        ws.onerror = () => {
          // Close follows with the real verdict.
        }
        resolve()
      }
      ws.onerror = () => {
        window.clearTimeout(timeout)
        this.connecting = null
        reject(new Error('relay unreachable — is the CLI running with --token?'))
      }
    })
    return this.connecting
  }

  private startKeepalive(): void {
    if (this.keepalive !== undefined) return
    this.keepalive = window.setInterval(() => {
      try {
        this.ws?.send(JSON.stringify({ type: 'ping' }))
      } catch {
        // The socket error/close path handles reconnect.
      }
    }, 20_000)
  }

  private onClose(): void {
    this.ws = null
    if (this.keepalive !== undefined) {
      window.clearInterval(this.keepalive)
      this.keepalive = undefined
    }
    // Fail pending RPCs; close live shells so the UI retries cleanly.
    for (const [, p] of this.pending) {
      window.clearTimeout(p.timer)
      p.reject(new Error('relay disconnected'))
    }
    this.pending.clear()
    for (const [, sock] of this.shells) {
      sock.relayClosed(1006, 'relay disconnected')
    }
    this.shells.clear()
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string') return
    let msg: JsonMsg
    try {
      msg = JSON.parse(data) as JsonMsg
    } catch {
      return
    }
    const type = typeof msg.type === 'string' ? msg.type : ''
    if (type === 'pong' || type === 'paired' || type === 'ui-ready' || type === 'ui-pending') {
      return
    }
    if (type === 'rpc-begin' || type === 'rpc-chunk' || type === 'rpc-end' || type === 'rpc-error') {
      this.onRpc(msg, type)
      return
    }
    if (type === 'shell-recv' || type === 'shell-closed') {
      const id = typeof msg.id === 'string' ? msg.id : ''
      const sock = this.shells.get(id)
      if (sock) sock.onRelay(msg, type)
    }
  }

  private onRpc(msg: JsonMsg, type: string): void {
    const id = typeof msg.id === 'string' ? msg.id : ''
    if (!id) return
    const p = this.pending.get(id)
    if (!p) return
    if (type === 'rpc-error') {
      this.pending.delete(id)
      window.clearTimeout(p.timer)
      const status = typeof msg.status === 'number' ? msg.status : 502
      const message = typeof msg.message === 'string' ? msg.message : 'relay request failed'
      p.reject(Object.assign(new Error(message), { status }))
      return
    }
    if (type === 'rpc-begin') {
      const status = typeof msg.status === 'number' ? msg.status : 200
      const headers = new Headers()
      const rawHeaders = msg.headers as Record<string, string> | undefined
      let setCookie: string | null = null
      if (rawHeaders && typeof rawHeaders === 'object') {
        for (const [k, v] of Object.entries(rawHeaders)) {
          if (typeof v !== 'string') continue
          if (k.toLowerCase() === 'set-cookie') {
            setCookie = v
            continue
          }
          try {
            headers.append(k, v)
          } catch {
            // Skip unloadable headers.
          }
        }
      }
      if (setCookie) this.ingestSetCookie(setCookie)
      const chunks = typeof msg.chunks === 'number' ? msg.chunks : 0
      if (chunks === 0) {
        // Empty body — resolve immediately (no chunks/end follow).
        this.pending.delete(id)
        window.clearTimeout(p.timer)
        p.resolve(new Response(new Uint8Array(0), { status, headers }))
        return
      }
      if (!Number.isInteger(chunks) || chunks <= 0 || chunks > 2048) {
        this.pending.delete(id)
        window.clearTimeout(p.timer)
        p.reject(new Error('bad relay response'))
        return
      }
      // Chunked body — store response head, wait for chunks + end.
      p.status = status
      p.headers = headers
      p.chunks = new Array(chunks).fill(null)
      p.expected = chunks
      p.received = 0
      p.gotBegin = true
      return
    }
    if (type === 'rpc-chunk') {
      if (!p.gotBegin) return
      const i = typeof msg.i === 'number' ? msg.i : -1
      const data = typeof msg.data === 'string' ? msg.data : ''
      if (Number.isInteger(i) && i >= 0 && i < p.chunks.length && data && p.chunks[i] === null) {
        p.chunks[i] = data
        p.received += 1
      }
      return
    }
    // rpc-end
    if (!p.gotBegin) return
    this.pending.delete(id)
    window.clearTimeout(p.timer)
    if (p.chunks.some((c) => c === null)) {
      p.reject(new Error('incomplete relay response'))
      return
    }
    try {
      const parts: Uint8Array[] = []
      let len = 0
      for (const c of p.chunks) {
        const raw = b64decode(c ?? '')
        parts.push(raw)
        len += raw.length
      }
      const body = new Uint8Array(len)
      let off = 0
      for (const part of parts) {
        body.set(part, off)
        off += part.length
      }
      p.resolve(new Response(body, { status: p.status, headers: p.headers }))
    } catch {
      p.reject(new Error('relay response decode failed'))
    }
  }

  private ingestSetCookie(header: string): void {
    const parsed = parseSetCookie(header)
    if (parsed === null) return
    if (parsed === '') {
      this.cookie = ''
      saveJar(this.token, '')
    } else {
      this.cookie = parsed
      saveJar(this.token, parsed)
    }
  }

  async rpc(method: string, path: string, init?: RequestInit): Promise<Response> {
    await this.ensure()
    const headersIn = new Headers(init?.headers)
    const accept = headersIn.get('accept') ?? undefined
    const contentType = headersIn.get('content-type') ?? undefined
    const bodyBytes = await readBodyBytes(init?.body)
    if (!contentType && bodyBytes && typeof init?.body === 'string') {
      // fetch() defaults string bodies to text/plain — mirror that.
      headersIn.set('content-type', 'text/plain;charset=UTF-8')
    }
    const outHeaders: Record<string, string> = {}
    const ct = headersIn.get('content-type')
    if (ct) outHeaders['content-type'] = ct
    if (accept) outHeaders['accept'] = accept
    const range = headersIn.get('range')
    if (range) outHeaders['range'] = range
    if (this.cookie) outHeaders['cookie'] = this.cookie

    const id = `r${++this.rpcSeq}-${Date.now().toString(36)}`
    const chunks: string[] = []
    if (bodyBytes && bodyBytes.length > 0) {
      for (let off = 0; off < bodyBytes.length; off += RPC_RAW) {
        chunks.push(b64encode(bodyBytes.subarray(off, off + RPC_RAW)))
      }
    }
    return new Promise<Response>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('relay request timed out — is the CLI still running?'))
      }, RPC_TIMEOUT_MS)
      // Register first: the agent's response (begin/chunks/end) resolves here.
      this.pending.set(id, {
        resolve: (res: Response) => {
          window.clearTimeout(timer)
          resolve(res)
        },
        reject: (err: Error) => {
          window.clearTimeout(timer)
          reject(err)
        },
        timer,
        status: 0,
        headers: new Headers(),
        chunks: [],
        expected: 0,
        received: 0,
        gotBegin: false,
      })
      this.send({ type: 'rpc-begin', id, method, path, headers: outHeaders, body_len: bodyBytes?.length ?? 0, chunks: chunks.length })
      if (chunks.length === 0) return
      chunks.forEach((data, i) => {
        this.send({ type: 'rpc-chunk', id, i, data })
      })
      this.send({ type: 'rpc-end', id, chunks: chunks.length })
    })
  }

  openShell(sock: RelaySocket, opts: { sid: string | null; v: number; from: number }): void {
    this.shells.set(sock.channelId, sock)
    this.send({
      type: 'shell-open',
      id: sock.channelId,
      sid: opts.sid,
      v: opts.v,
      from: opts.from,
      cookie: this.cookie || undefined,
    })
  }

  sendShell(id: string, isText: boolean, raw: Uint8Array): void {
    this.send({ type: 'shell-send', id, is_text: isText, data: b64encode(raw) })
  }

  closeShell(id: string): void {
    this.send({ type: 'shell-close', id })
    // The agent answers shell-closed; the socket also guards by timeout.
  }

  forgetShell(id: string): void {
    this.shells.delete(id)
  }

  private send(value: JsonMsg): void {
    try {
      this.ws?.send(JSON.stringify(value))
    } catch {
      // The pending rpc/shell timeouts surface the failure.
    }
  }
}

async function readBodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array | null> {
  if (body === null || body === undefined) return null
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString())
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer())
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    throw new Error('FormData upload is not supported over relay')
  }
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    const reader = body.getReader()
    const parts: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) parts.push(value instanceof Uint8Array ? value : new Uint8Array(value))
    }
    const len = parts.reduce((n, p) => n + p.length, 0)
    const out = new Uint8Array(len)
    let off = 0
    for (const p of parts) {
      out.set(p, off)
      off += p.length
    }
    return out
  }
  return new TextEncoder().encode(String(body))
}

// ---------------------------------------------------------------------------
// WebSocket façade for `/v1/shell`.
// ---------------------------------------------------------------------------

type SocketHandler = ((ev: unknown) => void) | null

class RelaySocket {
  readonly channelId: string
  readonly url: string
  readyState: number = 0
  binaryType: 'blob' | 'arraybuffer' = 'blob'
  onopen: SocketHandler = null
  onmessage: SocketHandler = null
  onclose: SocketHandler = null
  onerror: SocketHandler = null
  private conn: RelayConnection
  private opened = false
  private queue: Uint8Array[] = []
  private queueIsText: boolean[] = []
  private listeners = new Map<string, Set<(ev: unknown) => void>>()
  private openTimer: number | undefined
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  constructor(conn: RelayConnection, url: string, sid: string | null, v: number, from: number) {
    this.conn = conn
    this.url = url
    this.channelId = randomId('sh')
    this.openTimer = window.setTimeout(() => {
      if (!this.opened) {
        this.readyState = RelaySocket.CLOSED
        const err = new Error('shell open timed out')
        this.emit('error', err)
        this.emit('close', { code: 1011, reason: 'timeout', wasClean: false })
      }
    }, SHELL_OPEN_TIMEOUT_MS)
    conn.openShell(this, { sid, v, from })
  }

  onRelay(msg: JsonMsg, type: string): void {
    if (type === 'shell-closed') {
      if (this.openTimer !== undefined) {
        window.clearTimeout(this.openTimer)
        this.openTimer = undefined
      }
      const code = typeof msg.code === 'number' ? msg.code : 1005
      const reason = typeof msg.reason === 'string' ? msg.reason : ''
      const wasClean = code === 1000 || code === 1005
      if (!this.opened && code !== 1000) {
        this.readyState = RelaySocket.CLOSED
        this.emit('error', new Error(reason || 'shell unavailable over relay'))
      }
      this.readyState = RelaySocket.CLOSED
      this.conn.forgetShell(this.channelId)
      this.emit('close', { code, reason, wasClean })
      return
    }
    // shell-recv
    const isText = msg.is_text !== false
    const data = typeof msg.data === 'string' ? msg.data : ''
    let raw: Uint8Array
    try {
      raw = b64decode(data)
    } catch {
      return
    }
    if (!this.opened) {
      this.opened = true
      this.readyState = RelaySocket.OPEN
      if (this.openTimer !== undefined) {
        window.clearTimeout(this.openTimer)
        this.openTimer = undefined
      }
      this.emit('open', {})
      // Flush keystrokes typed during CONNECTING (mirrors Terminal's own
      // pending queue, but harmless if duplicated — the shell dedups by
      // offset on v2).
      for (let i = 0; i < this.queue.length; i++) {
        this.conn.sendShell(this.channelId, this.queueIsText[i] ?? true, this.queue[i] as Uint8Array)
      }
      this.queue = []
      this.queueIsText = []
    }
    if (isText) {
      const text = new TextDecoder().decode(raw)
      this.emit('message', { data: text })
    } else if (this.binaryType === 'arraybuffer') {
      const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
      this.emit('message', { data: buf })
    } else {
      this.emit('message', { data: new Blob([raw as unknown as BlobPart]) })
    }
  }

  relayClosed(code: number, reason: string): void {
    if (this.readyState === RelaySocket.CLOSED) return
    if (this.openTimer !== undefined) {
      window.clearTimeout(this.openTimer)
      this.openTimer = undefined
    }
    this.readyState = RelaySocket.CLOSED
    this.emit('close', { code, reason, wasClean: false })
  }

  send(data: string | ArrayBuffer | Uint8Array | Blob): void {
    if (this.readyState === RelaySocket.CONNECTING) {
      // Mirror native behaviour (Terminal queues on its side too).
      throw new DOMException('Still in CONNECTING state', 'InvalidStateError')
    }
    if (this.readyState !== RelaySocket.OPEN) return
    if (typeof data === 'string') {
      this.conn.sendShell(this.channelId, true, new TextEncoder().encode(data))
      return
    }
    if (data instanceof Uint8Array) {
      this.conn.sendShell(this.channelId, false, data)
      return
    }
    if (data instanceof ArrayBuffer) {
      this.conn.sendShell(this.channelId, false, new Uint8Array(data))
      return
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      void data.arrayBuffer().then((buf) => {
        if (this.readyState === RelaySocket.OPEN) {
          this.conn.sendShell(this.channelId, false, new Uint8Array(buf))
        }
      })
      return
    }
    this.conn.sendShell(this.channelId, true, new TextEncoder().encode(String(data)))
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === RelaySocket.CLOSED) return
    this.readyState = RelaySocket.CLOSING
    try {
      this.conn.closeShell(this.channelId)
    } finally {
      window.setTimeout(() => {
        if (this.readyState !== RelaySocket.CLOSED) {
          this.readyState = RelaySocket.CLOSED
          this.conn.forgetShell(this.channelId)
          this.emit('close', { code, reason, wasClean: true })
        }
      }, 2000)
    }
  }

  addEventListener(kind: string, fn: (ev: unknown) => void): void {
    let set = this.listeners.get(kind)
    if (!set) {
      set = new Set()
      this.listeners.set(kind, set)
    }
    set.add(fn)
  }

  removeEventListener(kind: string, fn: (ev: unknown) => void): void {
    this.listeners.get(kind)?.delete(fn)
  }

  private emit(kind: string, ev: unknown): void {
    const prop =
      kind === 'open' ? this.onopen : kind === 'message' ? this.onmessage : kind === 'close' ? this.onclose : this.onerror
    try {
      if (typeof prop === 'function') (prop as (e: unknown) => void).call(this, ev)
    } catch {
      // Listener errors must not break the socket.
    }
    const set = this.listeners.get(kind)
    if (set) {
      for (const fn of [...set]) {
        try {
          fn.call(this, ev)
        } catch {
          // Ignore.
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Install.
// ---------------------------------------------------------------------------

function sameOriginApi(input: RequestInfo | URL): string | null {
  try {
    const url = typeof input === 'string' ? new URL(input, window.location.href) : input instanceof URL ? input : null
    if (url) {
      if (url.origin !== window.location.origin) return null
      return url.pathname.startsWith('/api/') ? `${url.pathname}${url.search}` : null
    }
    // Request objects: resolve against the current base (srcDoc inherits it).
    const req = input as Request
    const url2 = new URL(req.url, window.location.href)
    if (url2.origin !== window.location.origin) return null
    return url2.pathname.startsWith('/api/') ? `${url2.pathname}${url2.search}` : null
  } catch {
    return null
  }
}

function shellTarget(url: string): { sid: string | null; v: number; from: number } | null {
  try {
    const u = new URL(url, window.location.href)
    // Only the local shell endpoint is tunnelled; the relay WSS itself uses
    // the native socket (saved before overriding).
    if (!u.pathname.endsWith('/v1/shell')) return null
    return {
      sid: u.searchParams.get('id'),
      v: Number(u.searchParams.get('v') ?? 0) || 0,
      from: Number(u.searchParams.get('from') ?? 0) || 0,
    }
  } catch {
    return null
  }
}

let installed = false

export function installRelayShim(): boolean {
  if (installed) return true
  const token = relayToken()
  const host = relayHost()
  if (!token || !host) return false
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return false

  const NativeFetch = window.fetch.bind(window)
  const NativeWS = window.WebSocket
  const conn = new RelayConnection(token, host, NativeWS)
  // Warm the relay in the background so the first Terminal/Files paint is fast.
  void conn.ensure().catch(() => {})

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = sameOriginApi(input)
    if (!path) {
      return NativeFetch(input as RequestInfo, init)
    }
    // Preserve Request-object details (method/headers/body) when present.
    let method = init?.method ?? 'GET'
    let headers: HeadersInit | undefined = init?.headers
    let body: BodyInit | null | undefined = init?.body
    let credentials: RequestCredentials | undefined = init?.credentials
    if (typeof input !== 'string' && !(input instanceof URL)) {
      try {
        const req = input as Request
        method = init?.method ?? req.method ?? 'GET'
        headers = init?.headers ?? req.headers
        credentials = init?.credentials ?? req.credentials
        if (init?.body === undefined) {
          try {
            body = (await req.clone().arrayBuffer()) as unknown as BodyInit
            if (body && (body as unknown as ArrayBuffer).byteLength === 0) body = null
          } catch {
            body = null
          }
        }
      } catch {
        // Fall through with init-only values.
      }
    }
    void credentials
    try {
      return await conn.rpc(method, path, { method, headers, body })
    } catch (e) {
      // Relay down (agent offline?) — surface a real Response so the UI's
      // existing error cards render instead of an unhandled rejection.
      const message = e instanceof Error ? e.message : 'relay request failed'
      const status = (e as { status?: number })?.status ?? 502
      return new Response(message, { status, headers: { 'content-type': 'text/plain' } })
    }
  }) as typeof window.fetch

  const RelayWS = function (this: unknown, url: string | URL, protocols?: string | string[]): unknown {
    const target = shellTarget(String(url))
    if (!target) {
      return new NativeWS(url as string, protocols as string[])
    }
    const sock = new RelaySocket(conn, String(url), target.sid, target.v || 2, target.from)
    return sock
  } as unknown as typeof WebSocket
  RelayWS.prototype = NativeWS.prototype
  const statics = RelayWS as unknown as Record<string, number>
  statics['CONNECTING'] = 0
  statics['OPEN'] = 1
  statics['CLOSING'] = 2
  statics['CLOSED'] = 3
  window.WebSocket = RelayWS

  installMediaBridge(conn)
  installed = true
  return true
}

function installMediaBridge(conn: RelayConnection): void {
  void conn
  // Anchor downloads (`<a href="/api/files/download…">`) bypass fetch —
  // capture the click and serve the relay bytes as a blob download.
  document.addEventListener(
    'click',
    (e) => {
      try {
        const anchor = (e.target as Element | null)?.closest?.('a[href^="/api/"]') as HTMLAnchorElement | null
        if (!anchor || anchor.target === '_blank') return
        const path = sameOriginApi(anchor.getAttribute('href') ?? '')
        if (!path) return
        e.preventDefault()
        e.stopPropagation()
        void (async () => {
          const res = await window.fetch(path)
          if (!res.ok) {
            const text = await res.text().catch(() => `download failed (${res.status})`)
            throw new Error(text)
          }
          const blob = await res.blob()
          const name = fileNameFrom(res, anchor.getAttribute('download') || path.split('?')[0]?.split('/').pop() || 'download')
          const objectUrl = URL.createObjectURL(blob)
          const helper = document.createElement('a')
          helper.href = objectUrl
          helper.download = name
          document.body.appendChild(helper)
          helper.click()
          helper.remove()
          window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000)
        })().catch(() => {})
      } catch {
        // Let the native navigation happen as a fallback.
      }
    },
    true,
  )

  // Media previews (`<img>/<video>/<audio>/<iframe src="/api/…">`) also
  // bypass fetch — swap them for relay blob URLs as they appear.
  const upgrade = (el: Element): void => {
    try {
      if (!(el instanceof HTMLElement)) return
      const tag = el.tagName.toLowerCase()
      const attr = tag === 'source' ? 'src' : 'src'
      const current = el.getAttribute(attr)
      if (!current || !current.startsWith('/api/')) return
      if (el.hasAttribute('data-relay-blob')) return
      el.setAttribute('data-relay-blob', 'loading')
      void (async () => {
        const res = await window.fetch(current)
        if (!res.ok) throw new Error(`preview failed (${res.status})`)
        const blob = await res.blob()
        const objectUrl = URL.createObjectURL(blob)
        el.setAttribute(attr, objectUrl)
        el.setAttribute('data-relay-blob', 'done')
      })().catch(() => {
        el.removeAttribute('data-relay-blob')
      })
    } catch {
      // Keep the original src on any failure.
    }
  }
  const scan = (root: ParentNode): void => {
    for (const el of root.querySelectorAll('img[src^="/api/"],video[src^="/api/"],audio[src^="/api/"],iframe[src^="/api/"],source[src^="/api/"]')) {
      upgrade(el)
    }
  }
  scan(document)
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes') {
        upgrade(m.target as Element)
      } else {
        for (const node of m.addedNodes) {
          if (node instanceof Element) {
            if (/^(IMG|VIDEO|AUDIO|IFRAME|SOURCE)$/.test(node.tagName)) upgrade(node)
            if (typeof node.querySelectorAll === 'function') scan(node as unknown as ParentNode)
          }
        }
      }
    }
  })
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })
}

function fileNameFrom(res: Response, fallback: string): string {
  try {
    const disposition = res.headers.get('content-disposition') ?? ''
    const m = disposition.match(/filename\*?=(?:UTF-8''|")?([^";\n]+)/i)
    if (m?.[1]) return decodeURIComponent(m[1].replace(/["']/g, '').trim()) || fallback
  } catch {
    // Fall through to the URL-derived fallback.
  }
  return fallback || 'download'
}
