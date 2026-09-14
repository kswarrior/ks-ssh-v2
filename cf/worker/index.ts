import { TunnelRoom } from './room.js'
import {
  RATE_IP_LIMIT,
  RATE_IP_WINDOW_MS,
  RATE_MISS_LIMIT,
  RATE_MISS_WINDOW_MS,
  checkLimit,
  clientIp,
  rateLimited,
  validToken as validTokenQ,
  type LimitState,
} from './limit.js'

export { TunnelRoom }

const TOKEN_RE = /^[A-Z0-9]{5,9}$/

// Per-isolate fixed windows: IP-wide + per-IP token-miss (scan) budgets.
// (DO rooms additionally enforce per-socket message rates in room.ts.)
const ipHits: LimitState = new Map()
const tokenMiss: LimitState = new Map()

function validToken(url: URL): string | null {
  return validTokenQ(url.searchParams.get('token'))
}

function pathToken(pathname: string, prefix: string): string | null {
  // prefix like "/v/" or "/api/ui/" — token is the next segment.
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length).split('/')[0] ?? ''
  const t = rest.toUpperCase()
  return TOKEN_RE.test(t) ? t : null
}

function stubFor(env: Env, token: string) {
  const id = env.TUNNEL.idFromName(`pair:${token}`)
  return env.TUNNEL.get(id)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const now = Date.now()

    // Per-IP budget first (429s make token scans expensive).
    const ip = clientIp(request)
    const ipCheck = checkLimit(ipHits, ip, now, RATE_IP_LIMIT, RATE_IP_WINDOW_MS)
    if (!ipCheck.allowed) return rateLimited(ipCheck.retryAfter)

    // E2E secret `k` lives ONLY in the URL fragment (never sent to the
    // server). If it ever shows up in the query string, reject loudly —
    // the caller pasted the full link into a fetch URL by mistake.
    if (url.searchParams.has('k')) {
      console.warn('rejected request with E2E secret in query (?k=) — use fragment #k= only')
      return Response.json(
        { ok: false, error: 'E2E secret must stay in the URL fragment (#k=), never in query' },
        { status: 400 },
      )
    }

    // WSS relay: CLI agent registers, web clients join — by token.
    // Bad tokens burn the per-IP scan budget (token scans 429 quickly).
    if (url.pathname === '/v1/agent' || url.pathname === '/v1/client') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return Response.json(
          { ok: false, error: 'expected websocket' },
          { status: 426 },
        )
      }
      const token = validToken(url)
      if (!token) {
        const miss = checkLimit(tokenMiss, `miss:${ip}`, now, RATE_MISS_LIMIT, RATE_MISS_WINDOW_MS)
        if (!miss.allowed) return rateLimited(miss.retryAfter)
        return Response.json(
          { ok: false, error: 'bad token (want 5-9 letters/numbers)' },
          { status: 400 },
        )
      }
      const role = url.pathname === '/v1/client' ? 'client' : 'agent'
      const stub = stubFor(env, token)
      const relayUrl = new URL(request.url)
      relayUrl.searchParams.set('role', role)
      return stub.fetch(new Request(relayUrl, request))
    }

    // Fullscreen UI pushed by the CLI over WSS, cached per token.
    // Public build output by design (zero secrets — proven by the
    // `ui_bundle_carries_zero_secrets` Rust test + `no-store` below); all
    // live session data inside it travels via `enc` and (with
    // `--relay-auth`) only after a PIN-inside-`enc` the relay never sees.
    //   GET /v/ABCDE            -> single-file HTML (iframe / fullscreen)
    //   GET /api/ui/ABCDE/html  -> same HTML (fetch + srcdoc friendly)
    //   GET /api/ui/ABCDE/meta  -> { ok, hasUi, size, updatedAt }
    if (url.pathname === '/v' || url.pathname.startsWith('/v/')) {
      const token =
        pathToken(url.pathname + '/', '/v/') ?? validToken(url)
      if (!token) {
        const miss = checkLimit(tokenMiss, `miss:${ip}`, now, RATE_MISS_LIMIT, RATE_MISS_WINDOW_MS)
        if (!miss.allowed) return rateLimited(miss.retryAfter)
        return Response.json(
          { ok: false, error: 'bad token (want /v/ABCDE…; 5-9 letters/numbers)' },
          { status: 400 },
        )
      }
      const stub = stubFor(env, token)
      const inner = new URL(request.url)
      inner.searchParams.set('role', 'ui-http')
      return stub.fetch(new Request(inner, request))
    }
    if (url.pathname.startsWith('/api/ui/')) {
      const token = pathToken(url.pathname + '/', '/api/ui/')
      if (!token) {
        const miss = checkLimit(tokenMiss, `miss:${ip}`, now, RATE_MISS_LIMIT, RATE_MISS_WINDOW_MS)
        if (!miss.allowed) return rateLimited(miss.retryAfter)
        return Response.json(
          { ok: false, error: 'bad token (want /api/ui/ABCDE…; 5-9 letters/numbers)' },
          { status: 400 },
        )
      }
      const stub = stubFor(env, token)
      const inner = new URL(request.url)
      inner.searchParams.set('role', 'ui-http')
      if (url.pathname.endsWith('/meta')) {
        inner.searchParams.set('ui', 'meta')
      }
      return stub.fetch(new Request(inner, request))
    }

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, service: 'ks-ssh', now: Date.now() })
    }

    // Live relay status backed by the token room (fully functional —
    // reports whether the CLI agent is online, whether it pushed its UI,
    // and whether viewers need a PIN). Used by the SSH list, the home
    // dashboard, and the installation health check.
    //   GET /api/ssh/status?token=ABCDE  -> { ok, agentOnline, hasUi, ... }
    //   GET /api/relay/ABCDE/status      -> same (path form)
    if (url.pathname === '/api/ssh/status' || url.pathname === '/api/relay/status') {
      const token = validToken(url)
      if (!token) {
        const miss = checkLimit(tokenMiss, `miss:${ip}`, now, RATE_MISS_LIMIT, RATE_MISS_WINDOW_MS)
        if (!miss.allowed) return rateLimited(miss.retryAfter)
        return Response.json(
          { ok: false, error: 'bad token (want 5-9 letters/numbers)' },
          { status: 400 },
        )
      }
      const stub = stubFor(env, token)
      const inner = new URL(request.url)
      inner.searchParams.set('role', 'ui-http')
      inner.searchParams.set('ui', 'status')
      return stub.fetch(new Request(inner, request))
    }
    if (url.pathname.startsWith('/api/relay/')) {
      const token = pathToken(url.pathname + '/', '/api/relay/')
      const tail = url.pathname.slice(('/api/relay/' + (token ?? '')).length)
      if (token && (tail === '/status' || tail === '' || tail === '/')) {
        const stub = stubFor(env, token)
        const inner = new URL(request.url)
        inner.searchParams.set('role', 'ui-http')
        inner.searchParams.set('ui', 'status')
        return stub.fetch(new Request(inner, request))
      }
    }
    if (url.pathname.startsWith('/api/ssh/')) {
      return Response.json(
        { ok: false, error: 'Not found (use /api/ssh/status?token=ABCDE)' },
        { status: 404 },
      )
    }

    if (url.pathname.startsWith('/api/')) {
      return Response.json({ ok: false, error: 'Not found' }, { status: 404 })
    }

    // Non-API routes fall through to Static Assets (SPA fallback).
    return new Response(null, { status: 404 })
  },
} satisfies ExportedHandler<Env>
