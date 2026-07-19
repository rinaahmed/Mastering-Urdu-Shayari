// Service worker: offline-first app shell. Everything works offline except
// /api/* (generation and judgment) and plan-declared external checkers —
// the app layer queues, retries, and marks results provisional.
//
// CACHE embeds the same build counter as public/version.json's "version"
// field — bump both together on every deploy. Browsers only reinstall a
// service worker (and thus refresh its cache) when the sw.js file's bytes
// change; without this literal number changing here too, the version badge
// can go stale-vs-live (it's fetched network-first) while the rest of the
// app silently keeps serving whatever was cached at the last sw.js change.

const CACHE = 'bayaz-v5';

const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/version.json',
  '/css/app.css',
  '/icons/icon.svg',
  '/fonts/noto-naskh-arabic.woff2',
  '/js/app.js',
  '/js/version.js',
  '/js/db.js',
  '/js/schema.js',
  '/js/migrate.js',
  '/js/ledger.js',
  '/js/checkers.js',
  '/js/assembler.js',
  '/js/context.js',
  '/js/api.js',
  '/js/session.js',
  '/js/exporter.js',
  '/js/views/today.js',
  '/js/views/lessons.js',
  '/js/views/lessonGroups.js',
  '/js/views/progress.js',
  '/js/views/portfolio.js',
  '/js/views/settings.js',
  '/plans/seed-plan.json',
  '/plans/plan.schema.json'
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

  // API and any cross-origin call (external checkers) are network-only —
  // the app layer handles queue-and-retry and provisional fallbacks.
  if (url.pathname.startsWith('/api/')) return;
  if (url.origin !== location.origin) return;
  if (event.request.method !== 'GET') return;

  // version.json is how the app tells the user which deploy they're looking
  // at, so it must be network-first — cache-first would let a stale badge
  // survive indefinitely. Fall back to the cached copy only when offline.
  if (url.pathname === '/version.json') {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return res;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res.ok) {
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
