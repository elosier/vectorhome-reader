// Vectorhome Reader service worker: app-shell caching + limited API fallback.
// Bump CACHE_VERSION whenever a shell file changes so clients pick it up.
const CACHE_VERSION = 'v3'; // v3: never handle the /admin console (separate app); v2: PNG launcher icons
const SHELL_CACHE = `shell-${CACHE_VERSION}`;
const API_CACHE = `api-${CACHE_VERSION}`;
const SHELL = ['/', '/app.js', '/style.css', '/favicon.svg', '/icons/all-read.png', '/vendor/qrcode.js', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== API_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // never touch writes
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // The admin console (/admin/*) is a separate app on this origin. It manages its
  // own freshness and must never be cached by the reader's worker — otherwise its
  // /admin/api/* reads fall into the cache-first branch below and go stale. Bypass
  // it entirely so its assets and API always hit the network.
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return;

  // Auth endpoints must always hit the network (session/login correctness).
  if (url.pathname.startsWith('/api/auth') || url.pathname === '/login') return;

  if (url.pathname.startsWith('/api/')) {
    // API reads: network first; fall back to the last good copy when offline,
    // so previously loaded articles stay readable.
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(API_CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || Response.error())),
    );
    return;
  }

  // Shell/static: cache first (instant paint), refresh the cache in the background.
  // Never cache a redirected response — an expired session redirects to /login,
  // and that page must not replace the cached app shell.
  e.respondWith(
    caches.match(req).then((hit) => {
      const fetching = fetch(req).then((res) => {
        if (res.ok && !res.redirected) { const copy = res.clone(); caches.open(SHELL_CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || fetching;
    }),
  );
});
