/**
 * Pure rate-limit + routing helpers for the KS SSH relay (no DO types, so
 * `node scripts/relay-check.mjs` can unit-test this file directly).
 *
 * Tokens route; `k` seals. Guessing a token only reveals whether a room
 * exists + the public UI bundle (zero secrets) — data stays sealed inside
 * `enc` and (with `--relay-auth`) gated behind a PIN-inside-`enc` that the
 * relay never sees. Rate limits make token scans expensive.
 */

/** 5-char legacy tokens still route; fresh runs mint 9 chars. */
export const TOKEN_RE = /^[A-Z0-9]{5,9}$/

/** Fixed-window limits (per isolate; DO rooms add per-socket limits). */
export const RATE_IP_LIMIT = 120
export const RATE_IP_WINDOW_MS = 60_000
export const RATE_MISS_LIMIT = 20
export const RATE_MISS_WINDOW_MS = 60_000

export type LimitBucket = { n: number; reset: number }
export type LimitState = Map<string, { n: number; reset: number }>

/**
 * Fixed-window check. Mutates `state`. Returns `allowed` + `retryAfter`
 * seconds (0 when allowed). Pure time via `now` param for tests.
 */
export function checkLimit(
  state: LimitState,
  key: string,
  now: number,
  limit: number,
  windowMs: number,
): { allowed: boolean; retryAfter: number } {
  const cur = state.get(key)
  if (!cur || now >= cur.reset) {
    state.set(key, { n: 1, reset: now + windowMs })
    return { allowed: true, retryAfter: 0 }
  }
  if (cur.n < limit) {
    cur.n += 1
    return { allowed: true, retryAfter: 0 }
  }
  return { allowed: false, retryAfter: Math.max(1, Math.ceil((cur.reset - now) / 1000)) }
}

/** Normalize + validate a room token (query or path segment). */
export function validToken(raw: string | null | undefined): string | null {
  if (!raw) return null
  const t = raw.toUpperCase()
  return TOKEN_RE.test(t) ? t : null
}

/** Best-effort client IP for per-IP limits (never logged with secrets). */
export function clientIp(req: Request): string {
  const cf = req.headers.get('cf-connecting-ip')
  if (cf && cf.trim()) return cf.trim().slice(0, 64)
  const xff = req.headers.get('x-forwarded-for')
  if (xff && xff.trim()) return xff.split(',')[0]!.trim().slice(0, 64)
  return 'unknown'
}

/** 429 JSON with `Retry-After` (token scans + floods back off here). */
export function rateLimited(retryAfter: number): Response {
  return Response.json(
    { ok: false, error: 'rate limited — slow down and retry' },
    {
      status: 429,
      headers: {
        'retry-after': String(retryAfter),
        'cache-control': 'no-store',
      },
    },
  )
}
