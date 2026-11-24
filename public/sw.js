const CACHE = 'tareas-hogar-v11';
const SHELL = ['/', '/styles.css', '/app.js', '/manifest.json', '/icon.svg'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.pathname.startsWith('/socket.io/') || url.pathname.startsWith('/api/')) return;
  // Network First: clients receive the newest app shell whenever the server is reachable.
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); return response;
  }).catch(() => caches.match(event.request).then(cached => cached || caches.match('/'))));
});
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch { payload = { body: event.data?.text() || '' }; }
  const title = payload.title || 'Tareas del Hogar';
  event.waitUntil(self.registration.showNotification(title, {
    body: payload.body || 'Tienes una tarea pendiente.',
    icon: '/icon.svg',
    badge: '/icon.svg',
    vibrate: [300, 100, 300],
    tag: payload.tag || `tareas-${Date.now()}`,
    data: { url: payload.url || '/' }
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    let target = new URL(event.notification.data?.url || '/', self.location.origin);
    if (target.origin !== self.location.origin) target = new URL('/', self.location.origin);
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of list) {
      if ('focus' in client) {
        if ('navigate' in client) await client.navigate(target.href);
        return client.focus();
      }
    }
    return clients.openWindow(target.href);
  })());
});
