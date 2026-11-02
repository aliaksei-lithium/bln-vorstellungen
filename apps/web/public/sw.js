/* global self, caches, fetch, Response, URL */
// BLN Vorstellungen service worker: keeps the app shell so the installed app opens offline. Page loads go to the
// network first; the last good shell is the fallback. Assets (hashed) and the API are never touched here.
const SHELL = 'bln-shell-v2';
/** Static pages served as their own files, not the app: never kept as the shell. */
const STATIC = /^\/(privacy|terms)(\.html)?\/?$/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && !STATIC.test(new URL(event.request.url).pathname)) {
          const copy = res.clone();
          event.waitUntil(caches.open(SHELL).then((c) => c.put('/', copy)));
        }
        return res;
      })
      .catch(() => caches.match('/').then((cached) => cached ?? Response.error())),
  );
});
