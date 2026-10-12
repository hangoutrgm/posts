const CACHE_NAME = 'hangout-v312';
const MEDIA_CACHE_NAME = 'hangout-cloudinary-v2';
const MAX_MEDIA_ITEMS = 250;
// Third-party static assets (Tailwind CDN, Font Awesome, Google Fonts, the
// pinned Firebase SDK, DiceBear): cache-first so repeat visits paint instantly
// without touching the network. API hosts are NOT listed — auth/db traffic
// is never intercepted. Bump the version suffix to force a re-download.
const CDN_CACHE_NAME = 'hangout-cdn-v1';
const MAX_CDN_ITEMS = 150;
const STATIC_CDN_HOSTS = [
  'cdn.tailwindcss.com',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'www.gstatic.com',
  'api.dicebear.com'
];
// YouTube artwork (i.ytimg.com). The music app renders one thumbnail per
// library row, so caching these locally removes nearly all repeat image
// traffic. Bump the version suffix if the caching strategy ever changes.
const YTIMG_CACHE_NAME = 'hangout-ytimg-v1';
const MAX_YTIMG_ITEMS = 200;

// Caches that must survive an activate() sweep.
const PERSISTENT_CACHES = [CACHE_NAME, MEDIA_CACHE_NAME, YTIMG_CACHE_NAME, CDN_CACHE_NAME];

/** Trims any cache to its newest `maxItems` entries (oldest evicted first). */
async function trimCache(cacheName, maxItems) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > maxItems) {
      const toDelete = keys.slice(0, keys.length - maxItems);
      await Promise.all(toDelete.map((req) => cache.delete(req)));
    }
  } catch (_) {}
}

// All local assets to pre-cache on install (relative paths for GitHub Pages subfolder & custom domain support)
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './chat/index.html',
  './css/tailwind.min.css?v=15',
  './css/styles.css?v=29',
  // Arena SPA (/arena) — tournament hub, lobby bridge, brackets
  './arena/index.html',
  './arena/arena.css?v=17',
  './arena/arena.js?v=25',
  './arena/bracket-engine.js',
  './chat/css/styles.css?v=54',
  './js/renderers.js?v=98',
  './js/helpers.js?v=71',
  './js/games.js?v=63',
  './js/main.js?v=103',
  './js/myday.js?v=28',
  './js/voice-recorder.js?v=3',
  './chat/js/app.js?v=108',
  // Lazy mini widgets — pre-cached so their first tap costs zero network.
  './chat/mini-chat.js?v=8',
  './music/mini-player.js?v=5',
  // Standalone Music SPA (/music) — keep these ?v= in sync with music/index.html
  './music/index.html',
  './music/music.css?v=6',
  './music/music-app.js?v=12',
  './music/youtube-player.js?v=7',
  // Standalone Pet SPA (/pet) — account gate + RTDB 3 cloud saves
  './pet/index.html',
  './pet/pet.js?v=3',
  './js/users-cache.js?v=6',
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
      Promise.all(keys.filter((key) => !PERSISTENT_CACHES.includes(key)).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Cloudinary image & poster cache handler (Cache-First)
  if (request.method === 'GET' && url.hostname === 'res.cloudinary.com') {
    // Only cache images and poster frames, NOT video streams (Range requests can cause issues in CacheStorage)
    const isImageOrPoster = url.pathname.includes('/image/upload/') ||
                            url.pathname.includes('/video/upload/so_') ||
                            /\.(jpg|jpeg|png|webp|avif|gif)(\?|#|$)/i.test(url.pathname);
    if (isImageOrPoster) {
      event.respondWith(
        caches.open(MEDIA_CACHE_NAME).then((cache) => {
          return cache.match(request).then((cached) => {
            // An opaque response can ONLY be returned to a 'no-cors' request.
            // If the incoming request is 'cors' (e.g. fetch() in window.viewImage), an opaque response
            // triggers: "an 'opaque' response was used for a request whose type is not no-cors".
            if (cached && (cached.type !== 'opaque' || request.mode === 'no-cors')) {
              return cached;
            }
            return fetch(request).then((response) => {
              if (response && (response.ok || response.type === 'opaque')) {
                const copy = response.clone();
                cache.put(request, copy).then(() => trimCache(MEDIA_CACHE_NAME, MAX_MEDIA_ITEMS)).catch(() => {});
              }
              return response;
            }).catch(() => (request.mode === 'no-cors' ? cached : null));
          });
        })
      );
      return;
    }
    // Let video streams bypass directly to network
    return;
  }

  // YouTube artwork cache handler (Cache-First) — used by the Music app's track
  // rows and the main-site mini player. <img> requests are 'no-cors', so the responses
  // are opaque; an opaque response may only be replayed to another 'no-cors'
  // request (same guard as the Cloudinary branch above).
  if (request.method === 'GET' && url.hostname === 'i.ytimg.com') {
    event.respondWith(
      caches.open(YTIMG_CACHE_NAME).then((cache) =>
        cache.match(request).then((cached) => {
          if (cached && (cached.type !== 'opaque' || request.mode === 'no-cors')) return cached;
          return fetch(request).then((response) => {
            if (response && (response.ok || response.type === 'opaque')) {
              const copy = response.clone();
              cache.put(request, copy).then(() => trimCache(YTIMG_CACHE_NAME, MAX_YTIMG_ITEMS)).catch(() => {});
            }
            return response;
          }).catch(() => (request.mode === 'no-cors' ? cached : null));
        })
      )
    );
    return;
  }

  // Third-party static assets (SDK/CDN): cache-first for instant repeat paints.
  // Guarded to GET + specific hosts/paths so auth (identitytoolkit), DB traffic
  // and mutable gstatic content are never cached.
  if (request.method === 'GET' && STATIC_CDN_HOSTS.includes(url.hostname)) {
    if (url.hostname === 'www.gstatic.com' && !url.pathname.startsWith('/firebasejs/')) return;
    event.respondWith(
      caches.open(CDN_CACHE_NAME).then((cache) => cache.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response && (response.ok || response.type === 'opaque')) {
            const copy = response.clone();
            cache.put(request, copy).then(() => trimCache(CDN_CACHE_NAME, MAX_CDN_ITEMS)).catch(() => {});
          }
          return response;
        });
      }))
    );
    return;
  }

  // Only handle same-origin GET requests
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Skip Firebase, external CDNs — let browser handle those
  if (url.hostname !== self.location.hostname) return;

  const isVersionedAsset = url.search.includes('v=');
  const isHtml = request.destination === 'document' || url.pathname.endsWith('.html') || url.pathname.endsWith('/') || !url.pathname.split('/').pop().includes('.');

  if (isVersionedAsset) {
    // Cache-first: versioned JS/CSS files rarely change; serve from cache instantly.
    // `no-store` on the miss path bypasses the HTTP cache (vercel.json serves .js
    // with max-age=86400), so a version bump can never be answered by a stale copy.
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
  } else if (isHtml && (url.pathname === '/pet' || url.pathname.startsWith('/pet/'))) {
    // Pet shell — INSTANT paint: stale-while-revalidate scoped to /pet only.
    // Cached HTML renders immediately while a background fetch refreshes it for
    // the next visit; the versioned pet.js?v= assets still resolve cache-first.
    event.respondWith(
      caches.match(request).then((cached) => cached || caches.match('./pet/index.html')).then((cached) => {
        const refresh = fetch(request, { cache: 'no-store' }).then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        }).catch(() => cached);
        return cached || refresh;
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
