import { TunnelRoom } from './room.js'

export { TunnelRoom }

const TOKEN_RE = /^[A-Z0-9]{5}$/

function validToken(url: URL): string | null {
  const t = (url.searchParams.get('token') ?? '').toUpperCase()
  return TOKEN_RE.test(t) ? t : null
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

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
      const id = env.TUNNEL.idFromName(`pair:${token}`)
      const stub = env.TUNNEL.get(id)
      const relayUrl = new URL(request.url)
      relayUrl.searchParams.set('role', role)
      return stub.fetch(new Request(relayUrl, request))
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
