export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname.startsWith('/api/')) {
      return Response.json({ name: 'Cloudflare' })
    }

    // Non-API routes fall through to Static Assets (SPA fallback).
    return new Response(null, { status: 404 })
  },
} satisfies ExportedHandler<Env>
