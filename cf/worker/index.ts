import { TunnelRoom } from './room.js'

export { TunnelRoom }

const TOKEN_RE = /^[A-Z0-9]{5}$/

function validToken(url: URL): string | null {
  const t = (url.searchParams.get('token') ?? '').toUpperCase()
  return TOKEN_RE.test(t) ? t : null
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
    if (url.pathname === '/v1/agent' || url.pathname === '/v1/client') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return Response.json(
          { ok: false, error: 'expected websocket' },
          { status: 426 },
        )
      }
      const token = validToken(url)
      if (!token) {
        return Response.json(
          { ok: false, error: 'bad token (want 5 letters/numbers)' },
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
    //   GET /v/ABCDE            -> single-file HTML (iframe / fullscreen)
    //   GET /api/ui/ABCDE/html  -> same HTML (fetch + srcdoc friendly)
    //   GET /api/ui/ABCDE/meta  -> { ok, hasUi, size, updatedAt }
    if (url.pathname === '/v' || url.pathname.startsWith('/v/')) {
      const token =
        pathToken(url.pathname + '/', '/v/') ?? validToken(url)
      if (!token) {
        return Response.json(
          { ok: false, error: 'bad token (want /v/ABCDE)' },
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
        return Response.json(
          { ok: false, error: 'bad token (want /api/ui/ABCDE/…)' },
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
      return Response.json({ ok: true, service: 'ks-ssh' })
    }

    if (url.pathname.startsWith('/api/ssh/')) {
      // No live SSH backend is wired up yet — answer honestly instead of
      // faking a connection. Run the KS SSH backend to enable this.
      return Response.json(
        {
          ok: false,
          error:
            'SSH backend not connected. Start it with `cargo run -p ks-ssh` and try again.',
        },
        { status: 501 },
      )
    }

    if (url.pathname.startsWith('/api/')) {
      return Response.json({ ok: false, error: 'Not found' }, { status: 404 })
    }

    // Non-API routes fall through to Static Assets (SPA fallback).
    return new Response(null, { status: 404 })
  },
} satisfies ExportedHandler<Env>
