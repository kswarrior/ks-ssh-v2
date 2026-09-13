export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

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
