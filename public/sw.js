// Service worker: offline-first app shell. Everything works offline except
// /api/* (generation and judgment), which the app queues and retries itself.

const CACHE = 'mus-shell-v1';

const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/css/app.css',
  '/icons/icon.svg',
  '/js/app.js',
  '/js/db.js',
  '/js/schema.js',
  '/js/ledger.js',
  '/js/checkers.js',
  '/js/assembler.js',
  '/js/context.js',
  '/js/api.js',
  '/js/session.js',
  '/js/exporter.js',
  '/js/views/today.js',
  '/js/views/progress.js',
  '/js/views/portfolio.js',
  '/js/views/settings.js',
  '/plans/urdu-shayari-plan.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API calls are network-only — the app layer handles queue-and-retry.
  if (url.pathname.startsWith('/api/')) return;

  if (event.request.method !== 'GET') return;

  // Cache-first for the shell, falling back to network (and caching same-origin
  // responses opportunistically).
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      }).catch(() => {
        if (event.request.mode === 'navigate') return caches.match('/index.html');
        throw new Error('offline and not cached');
      });
    })
  );
});
