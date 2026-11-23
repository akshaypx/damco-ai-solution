// ponytail: network-first app shell cache, just enough for installability + offline shell. Never caches /api.
const C = 'shell-v1'
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()))
self.addEventListener('fetch', (e) => {
  const { request: r } = e
  if (r.method !== 'GET' || new URL(r.url).pathname.startsWith('/api')) return
  e.respondWith(
    fetch(r)
      .then((res) => {
        const copy = res.clone()
        caches.open(C).then((c) => c.put(r, copy))
        return res
      })
      .catch(() => caches.match(r))
  )
})
