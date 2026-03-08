/* =====================================================
   C1 English Tracker – Service Worker
   Enables PWA installability and push notifications
   ===================================================== */

const CACHE_NAME = 'c1-tracker-v1';
const ASSETS = [
    './',
    './index.html',
    './script.js',
    './styles.css',
    './manifest.json'
];

// ── Install: pre-cache static assets ──────────────────
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS).catch((err) => {
                // Non-fatal – continue install even if some assets fail
                console.warn('[C1 Tracker SW] Asset pre-cache failed:', err);
            });
        })
    );
    self.skipWaiting();
});

// ── Activate: clean up old caches ─────────────────────
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
            )
        )
    );
    self.clients.claim();
});

// ── Fetch: serve from cache, fall back to network ─────
self.addEventListener('fetch', (event) => {
    // Only handle same-origin GET requests
    if (event.request.method !== 'GET') return;
    if (!event.request.url.startsWith(self.location.origin)) return;

    event.respondWith(
        caches.match(event.request).then((cached) => {
            return cached || fetch(event.request).then((response) => {
                // Cache successful responses for app assets
                if (response && response.status === 200 && response.type === 'basic') {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            });
        }).catch(() => caches.match('./index.html'))
    );
});

// ── Push: receive push message and show notification ──
self.addEventListener('push', (event) => {
    let data = { title: 'C1 English Tracker 📚', body: 'Time to study!' };
    if (event.data) {
        try { data = { ...data, ...event.data.json() }; } catch { /* use defaults */ }
    }
    event.waitUntil(
        self.registration.showNotification(data.title, {
            body: data.body,
            tag: 'c1-tracker-reminder',
            renotify: true,
            requireInteraction: false,
            data: { url: self.location.origin }
        })
    );
});

// ── Notification click: open / focus the app ──────────
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = (event.notification.data && event.notification.data.url) || self.location.origin;
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
            for (const client of clients) {
                if (client.url === targetUrl && 'focus' in client) return client.focus();
            }
            if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
        })
    );
});
