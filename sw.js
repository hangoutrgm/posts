const CACHE_NAME = 'hangout-v184';

// All local assets to pre-cache on install (relative paths for GitHub Pages subfolder & custom domain support)
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './chat/index.html',
  './css/tailwind.min.css?v=3',
  './css/styles.css?v=12',
  './chat/css/styles.css?v=45',
  './js/renderers.js?v=67',
  './js/helpers.js?v=64',
  './js/games.js?v=58',
  './js/main.js?v=63',
  './js/myday.js?v=16',
  './js/voice-recorder.js?v=3',
  './chat/js/app.js?v=92',
  './js/users-cache.js?v=4',
  './config/emoji_riddles.json',
  './config/flags.json',
  './config/emojis.json',
  './config/elements.json',
  './config/trivia.json',
  './config/mythology.json',
  './config/logos.json',
  './config/jumbled.json',
  './config/riddle.json',
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
    // Network-first: always try fresh HTML, fall back to cache if offline.
    // `no-store` makes sure a fresh shell is never beaten by a stale HTTP-cached copy.
    event.respondWith(
      fetch(request, { cache: 'no-store' })
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
    // Cache-first for other local static assets (json, icons, images, unversioned assets):
    // Serve immediately from cache without background network fetch. Only fetch from network if missing.
    // `no-store` on the miss path stops a stale HTTP-cached copy (vercel.json serves .js with
    // max-age=86400) from surviving a CACHE_NAME bump.
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request, { cache: 'no-store' }).then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        });
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
