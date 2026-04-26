// Minimal SW - just handles cache cleanup and stays out of the way
const CACHE_NAME = 'chearb-v6'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET') return
  if (url.pathname.startsWith('/api/')) return

  // Cache-first for hashed static assets
  if (/\/assets\/.*\.(js|css|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached
        return fetch(event.request).then((resp) => {
          if (resp.ok) {
            const clone = resp.clone()
            caches.open(CACHE_NAME).then((c) => c.put(event.request, clone))
          }
          return resp
        })
      })
    )
    return
  }

  // Cache-first for Google Fonts
  if (/fonts\.(googleapis|gstatic)\.com/.test(url.hostname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached
        return fetch(event.request).then((resp) => {
          if (resp.ok) {
            const clone = resp.clone()
            caches.open(CACHE_NAME).then((c) => c.put(event.request, clone))
          }
          return resp
        })
      })
    )
    return
  }
})
