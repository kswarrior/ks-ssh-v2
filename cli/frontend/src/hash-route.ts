/**
 * Hash routing that preserves the relay E2E key (`k`) in the URL fragment.
 *
 * Problem: the share link is `/v/TOKEN#k=KEY`, but tab navigation used to do
 * `window.location.hash = '#/files'`, which REPLACED `#k=KEY` with `#/files`
 * and dropped the key from the URL (reload => E2E 426 "open the full link").
 *
 * New format (requested): `/v/TOKEN#k=KEY/files`
 * - `k` stays in the fragment (never query — Worker rejects `?k=` with 400).
 * - route stays in the same fragment after the key, so copy/reload keeps both.
 * - `parseKeyFromHash` already finds `k` via /[?#&;]k=([A-Za-z0-9_-]{40,50})/
 *   — `/` terminates the match, so `#k=KEY/files` parses fine, no change needed.
 *
 * Helpers here are the single place that reads/writes the fragment route.
 */

const KEY_RE = /[?#&;]k=([A-Za-z0-9_-]{40,50})/

/** Raw `k` value from a hash fragment (no strict 32-byte validation here — relay-e2e validates). */
export function getRelayKeyFromHash(hash: string): string | null {
  try {
    const m = hash.match(KEY_RE)
    const k = m?.[1] ?? null
    if (k && /^[A-Za-z0-9_-]{40,50}$/.test(k)) return k
    return null
  } catch {
    return null
  }
}

/**
 * Route path from a hash that may also contain `k`.
 * `#k=KEY/files` -> `/files`, `#/files` -> `/files`, `#k=KEY` -> ``.
 */
export function getRouteFromHash(hash: string): string {
  try {
    // Strip the key first: `#k=KEY/files` -> `#/files`, `#k=KEY` -> `#`.
    const withoutKey = hash.replace(/[?#&;]k=[A-Za-z0-9_-]{40,50}/g, '')
    const m = withoutKey.match(
      /\/(terminal|files|ports|host|more|users|audit|recordings|settings)\b/,
    )
    return m ? `/${m[1]}` : ''
  } catch {
    return ''
  }
}

/**
 * Build the fragment for a route while preserving `k` when present.
 * `#/files` + current `#k=KEY...` -> `#k=KEY/files`.
 * No `k` in the current URL -> unchanged `#/files` (local --port mode).
 */
export function buildHashForRoute(routeHash: string): string {
  let route = routeHash.replace(/^#/, '')
  if (!route.startsWith('/')) route = `/${route.replace(/^\/*/, '')}`
  try {
    const current = typeof window !== 'undefined' ? window.location.hash || '' : ''
    const k = getRelayKeyFromHash(current)
    if (k) return `#k=${k}${route}`
  } catch {
    // Storage/DOM unavailable — fall through to plain route.
  }
  return `#${route}`
}

/** Navigate without dropping `k` (replaces direct `window.location.hash = ...`). */
export function navToRoute(routeHash: string): void {
  try {
    const next = buildHashForRoute(routeHash)
    if (window.location.hash !== next) window.location.hash = next
  } catch {
    // Non-browser — ignore.
  }
}
