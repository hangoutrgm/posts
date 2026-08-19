const CACHE_NAME = 'hangout-v10';

// All local assets to pre-cache on install
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/chat/index.html',
  '/js/renderers.js?v=10',
  '/js/helpers.js?v=10',
  '/js/games.js?v=10',
  '/js/main.js?v=10',
  '/chat/js/app.js?v=2',
];

// Install: pre-cache all shell assets
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS).catch(() => {}))
  );
});

// Activate: delete old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Skip Firebase, external CDN — let browser handle those
  if (url.hostname !== self.location.hostname) return;

  const isVersionedAsset = url.search.includes('v=');
  const isHtml = request.destination === 'document' || url.pathname.endsWith('.html') || url.pathname === '/';

  if (isVersionedAsset) {
    // Cache-first: versioned JS files rarely change; serve from cache instantly
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
          }
          return response;
        });
      })
    );
  } else if (isHtml) {
    // Network-first: always try fresh HTML, fall back to cache if offline
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
  }
  // All other requests (CSS, images, etc.) — pass through unchanged
});
