'use strict';
// Elite OS service worker (Phase 6.2): deliberately tiny. It exists so the app can be installed, and so that a page load with no connection shows a calm
// "You're offline" page with a Retry button (offline.html) instead of the browser's error page.
// It stores NO app code and NO data. Staff always run the code the server sends, so a quote can never be sent by an old copy of the screen, and nothing about a
// customer is kept on the device by this file. The only thing cached is offline.html itself.
// It touches page loads only. Everything else (Firebase, Firestore, Storage, Cloud Functions, Google sign-in, the WhatsApp webhook, files, scripts) goes straight to
// the network, exactly as if this file did not exist.
const CACHE = 'ek-offline-v1';
const OFFLINE = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(new Request(OFFLINE, { cache: 'reload' }))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.mode !== 'navigate' || request.method !== 'GET') return;                       // not a page load: leave it alone
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;                                           // another site: leave it alone
  if (url.pathname.startsWith('/__/') || url.pathname === '/webhook' || url.pathname.startsWith('/webhook/')) return;   // sign-in handler, Firebase files, the WhatsApp webhook
  event.respondWith(fetch(request).catch(() => caches.match(OFFLINE)));                      // the network answers; only a failed connection gets the offline page
});
