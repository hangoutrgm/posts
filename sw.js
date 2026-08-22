const CACHE_NAME = 'hangout-v40';

// All local assets to pre-cache on install (relative paths for GitHub Pages subfolder & custom domain support)
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './chat/index.html',
  './css/styles.css',
  './chat/css/styles.css?v=2',
  './js/renderers.js?v=24',
  './js/helpers.js?v=33',
  './js/games.js?v=29',
  './js/main.js?v=25',
  './chat/js/app.js?v=8',
  './config/emoji_riddles.json',
  './config/flags.json',
  './config/emojis.json',
  './config/elements.json',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './favicon.ico'
];

// Install: pre-cache all shell assets
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS).catch((err) => {
      console.warn('[SW] Pre-cache warning:', err);
    }))
  );
});

// Activate: delete old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Skip Firebase, external CDNs — let browser handle those
  if (url.hostname !== self.location.hostname) return;

  const isVersionedAsset = url.search.includes('v=');
  const isHtml = request.destination === 'document' || url.pathname.endsWith('.html') || url.pathname.endsWith('/') || !url.pathname.split('/').pop().includes('.');

  if (isVersionedAsset) {
    // Cache-first: versioned JS/CSS files rarely change; serve from cache instantly
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
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
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(request).then((res) => res || caches.match('./index.html')))
    );
  } else {
    // Stale-while-revalidate for other local assets (json, icons, css)
    event.respondWith(
      caches.match(request).then((cached) => {
        const fetchPromise = fetch(request).then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
  }
});

// Focus or open app window when clicking notifications
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
