// ─── Cache version ────────────────────────────────────────────────────────────
// To push an update to users: bump this version string (e.g. v2, v3 …),
// then deploy.  The browser will install the new SW, delete the old cache,
// and serve fresh assets on the next page load.
const CACHE_NAME = 'drum-kit-canvas-v1.22';

// ─── Assets to pre-cache on install ───────────────────────────────────────────
const ASSETS = [
    '/',
    '/index.html',
    '/manifest.json',
    '/css/reset.css',
    '/css/main.css?v=0999f4b4',
    '/js/main.js?v=c62877ce',
    '/js/vendor/howler.js',
    '/audio/bass.mp3',
    '/audio/crash.mp3',
    '/audio/floortom.mp3',
    '/audio/hihat.mp3',
    '/audio/lion.mp3',
    '/audio/monkey.mp3',
    '/audio/moo.mp3',
    '/audio/pig.mp3',
    '/audio/snare.mp3',
    '/audio/tiger.mp3',
    '/audio/tom.mp3',
    '/img/bass.svg',
    '/img/crash.svg',
    '/img/floortom.svg',
    '/img/hihat.svg',
    '/img/snare.svg',
    '/img/tom.svg',
    '/img/icon-16x16.png',
    '/img/icon-32x32.png',
    '/img/icon-48x48.png',
    '/img/icon-64x64.png',
    '/img/icon-128x128.png',
    '/img/icon-192x192.png',
    '/img/icon-256x256.png',
    '/img/icon-512x512.png',
    '/img/apple-touch-icon.png',
    '/img/favicon.ico',
    '/fonts/sniglet.woff2',
    '/fonts/sniglet.woff',
];

// ─── Install: pre-cache all assets ────────────────────────────────────────────
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
    );
    self.skipWaiting();
});

// ─── Activate: purge old caches ───────────────────────────────────────────────
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
            )
        )
    );
    self.clients.claim();
});

// ─── Fetch: cache-first, fall back to network ─────────────────────────────────
self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) return cached;

            return fetch(event.request).then(response => {
                if (response.ok) {
                    const responseToCache = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, responseToCache);
                    });
                }
                return response;
            });
        })
    );
});
