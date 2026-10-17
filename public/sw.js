'use strict';
// Elite OS service worker (Phase 6.2): deliberately tiny. It exists so the app can be installed, and so that a page load with no connection shows a calm
// "You're offline" page with a Retry button (offline.html) instead of the browser's error page.
// (Phase 8 added push notifications below; they store nothing either.)
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

// ---- Push notifications (Phase 8, docs/PUSH.md). The push carries only opaque ids (n = the notification, d = this device, k = what kind, c = which customer, as a tag): the words below are ours,
// so nothing about a customer ever appears on a lock screen or passes through Google. Nothing is stored here: not the push, not a name, not a number.
const WORDS = {
  message: ['New WhatsApp message', 'Open Elite OS to read it.'],
  lead: ['New lead', 'Open Elite OS to see the details.'],
  handover: ['A chat is waiting for you', 'The receptionist passed a chat to you. Open Elite OS.'],
  alert: ['Elite OS needs attention', 'Open Elite OS to see what needs doing.'],             // Phase 10: a problem or a lead that could not be added ("Needs attention")
  test: ['Test notification', 'If you can read this, notifications work on this device.'],
};
// Tell the server the moment this device woke up (and when the notification was clicked), so the real delivery time can be measured. The server's own clock at the moment the report
// arrives is recorded too. Best effort: a device with no connection simply sends no report.
function report(d, phase, t) {
  if (!d || !d.n || !d.d) return Promise.resolve();
  return fetch('/pushReceipt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ n: d.n, d: d.d, p: phase, t }), keepalive: true }).catch(() => {});
}
self.addEventListener('push', (event) => {
  const woke = Date.now();                                                                  // the earliest moment our code on this device knows about the push
  let d = {};
  try { const p = event.data ? event.data.json() : {}; d = (p && p.data) || p || {}; } catch (e) { d = {}; }
  const kind = WORDS[d.k] ? d.k : 'message';
  event.waitUntil((async () => {
    const reported = report(d, 'received', woke);
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.some((w) => w.visibilityState === 'visible' && w.focused)) {                // Elite OS is open and in front: it shows the message itself, no alert
      for (const w of windows) w.postMessage({ type: 'ek-push', n: d.n });
    } else {
      await self.registration.showNotification(WORDS[kind][0], { body: WORDS[kind][1], tag: 'ek-' + (d.c || d.n || 'x'), renotify: true, icon: '/icons/icon-192.png', data: { n: d.n, d: d.d, k: kind } });
    }
    await reported;
  })());
});
self.addEventListener('notificationclick', (event) => {
  const d = event.notification.data || {};
  event.notification.close();
  event.waitUntil((async () => {
    const reported = report(d, 'clicked', Date.now());
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((w) => typeof w.focus === 'function');
    if (open) { await open.focus(); open.postMessage({ type: 'ek-open', n: d.n }); }          // Elite OS is already open: bring it to the front and show the chat
    else await self.clients.openWindow('/?n=' + encodeURIComponent(d.n || ''));              // closed: open it; the app finds the chat from the id after sign-in
    await reported;
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.mode !== 'navigate' || request.method !== 'GET') return;                       // not a page load: leave it alone
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;                                           // another site: leave it alone
  if (url.pathname.startsWith('/__/') || url.pathname === '/webhook' || url.pathname.startsWith('/webhook/')) return;   // sign-in handler, Firebase files, the WhatsApp webhook
  event.respondWith(fetch(request).catch(() => caches.match(OFFLINE)));                      // the network answers; only a failed connection gets the offline page
});
