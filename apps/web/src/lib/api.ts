// Fetch wrapper: same-origin cookies + CSRF double-submit header.
function csrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)ks_csrf=([^;]+)/)
  return m ? decodeURIComponent(m[1]) : ''
}

export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: unknown } = {}
): Promise<T> {
  const method = opts.method ?? 'GET'
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-CSRF-Token': csrfToken() } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    throw new ApiError(res.status, data?.code ?? '', data?.error ?? res.statusText)
  }
  return data as T
}

export function downloadUrl(hostId: number, paths: string[]): string {
  const q = encodeURIComponent(JSON.stringify(paths))
  return `/api/files/download?hostId=${hostId}&paths=${q}`
}

export function humanSize(n: number): string {
  if (!isFinite(n) || n < 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function fileUrlBase(): string {
  return location.origin
}
