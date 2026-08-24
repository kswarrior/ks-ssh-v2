// KS SSH service worker — network-first for API, cache-first shell fallback.
const SHELL = 'ks-shell-v1'
self.addEventListener('install', e => {
  self.skipWaiting()
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(['/', '/icon.svg'])))
})
self.addEventListener('activate', e => {
  e.waitUntil(clients.claim())
})
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET') return
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/port/')) {
    return // never cache API/proxy traffic
  }
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone()
        caches.open(SHELL).then(c => c.put(e.request, copy)).catch(() => {})
        return res
      })
      .catch(() => caches.match(e.request).then(hit => hit || caches.match('/')))
  )
})
