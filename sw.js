self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
    // Basic fetch listener to pass the PWA install criteria.
    // It doesn't cache anything by default, just passes the request through.
});
