// Phase 8: the push part of the service worker (public/sw.js), run for real in a pretend browser, and the model behind the speed table (public/push-model.js). No emulator, no browser.
// What matters: the words on the screen are OURS (no customer in them), the worker reports the moment it woke up, Elite OS in front shows no alert, a click opens the right place, and
// the worker still stores nothing.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm');
const M = require('../../public/push-model.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');

function load({ windows = [], fetchImpl, now = () => 1000 } = {}) {
  const handlers = {}, shown = [], posted = [], fetches = [], opened = [], closed = [];
  const clients = { matchAll: async () => windows, openWindow: async (u) => { opened.push(u); } };
  const self = { location: { origin: 'https://app.test' }, addEventListener: (t, fn) => { handlers[t] = fn; }, skipWaiting: async () => {}, clients,
    registration: { showNotification: async (title, opts) => { shown.push({ title, ...opts }); } } };
  const win = (over) => ({ visibilityState: 'hidden', focused: false, focus: async function () { this.didFocus = true; }, postMessage: (m) => posted.push(m), ...over });
  const context = { self, Date: { now }, Request: class { constructor(u, i) { this.url = u; Object.assign(this, i); } }, URL, encodeURIComponent, JSON, Promise, caches: { open: async () => ({ add: async () => {} }), keys: async () => [], delete: async () => true, match: async () => null },
    fetch: async (u, o) => { fetches.push({ url: u, ...o, body: JSON.parse(o.body) }); if (fetchImpl) return fetchImpl(u, o); return { ok: true }; } };
  vm.runInNewContext(read('sw.js'), context, { filename: 'sw.js' });
  const fire = async (type, event) => { let p; handlers[type](Object.assign(event, { waitUntil: (x) => { p = x; } })); await p; };
  const push = (data, opts = {}) => fire('push', { data: opts.noData ? null : { json: () => (opts.raw !== undefined ? opts.raw : { data, from: '123', fcmMessageId: 'x' }) } });
  return { handlers, shown, posted, fetches, opened, closed, win, fire, push, self };
}
const D = { n: 'm_' + 'a'.repeat(24), d: 'b'.repeat(32), k: 'message', c: 'abcd1234' };

test('push: a message and a lead show OUR generic words (no customer in them); a test says so; the same customer replaces the earlier alert', async () => {
  const w = load(); await w.push(D);
  assert.equal(w.shown.length, 1); assert.deepEqual([w.shown[0].title, w.shown[0].body], ['New WhatsApp message', 'Open Elite OS to read it.']);
  assert.equal(w.shown[0].tag, 'ek-abcd1234'); assert.equal(w.shown[0].renotify, true); assert.deepEqual(w.shown[0].data, { n: D.n, d: D.d, k: 'message' }); assert.equal(w.shown[0].icon, '/icons/icon-192.png');
  await w.push({ ...D, k: 'lead', c: 'zz' }); assert.deepEqual([w.shown[1].title, w.shown[1].body], ['New lead', 'Open Elite OS to see the details.']);
  await w.push({ ...D, k: 'test' }); assert.equal(w.shown[2].title, 'Test notification');
  await w.push({ ...D, k: 'nonsense' }); assert.equal(w.shown[3].title, 'New WhatsApp message', 'an unknown kind falls back to the plain wording');
  const all = JSON.stringify(w.shown); for (const s of ['Anna', 'Murphy', '353', 'budget']) assert.ok(!all.includes(s));
  for (const raw of [{}, null, 'text']) { const x = load(); await x.push(null, { raw }); assert.equal(x.shown.length, 1, 'a push that cannot be read still shows the plain alert (Chrome requires one)'); }
  const y = load(); await y.push(null, { noData: true }); assert.equal(y.shown.length, 1);
  const z = load(); await z.fire('push', { data: { json: () => { throw new Error('bad json'); } } }); assert.equal(z.shown.length, 1);
});

test('push: the worker reports the moment it woke up (device clock) to /pushReceipt, before anything slow; a failed report never stops the alert', async () => {
  let clock = 5000; const w = load({ now: () => clock++ }); await w.push(D);
  assert.equal(w.fetches.length, 1); const r = w.fetches[0];
  assert.equal(r.url, '/pushReceipt'); assert.equal(r.method, 'POST'); assert.equal(r.keepalive, true); assert.deepEqual(r.body, { n: D.n, d: D.d, p: 'received', t: 5000 });
  const bad = load({ fetchImpl: async () => { throw new TypeError('offline'); } }); await bad.push(D); assert.equal(bad.shown.length, 1, 'offline: the alert is still shown');
  const none = load(); await none.push({ k: 'message' }); assert.equal(none.fetches.length, 0, 'nothing to report without ids'); assert.equal(none.shown.length, 1);
});

test('push: with Elite OS open and in front there is no alert (the page tells itself); hidden or unfocused windows still get the alert', async () => {
  const a = load(); const front = a.win({ visibilityState: 'visible', focused: true }); a.self.clients.matchAll = async () => [front, a.win()];
  await a.push(D); assert.equal(a.shown.length, 0); assert.deepEqual(a.posted, [{ type: 'ek-push', n: D.n }, { type: 'ek-push', n: D.n }]); assert.equal(a.fetches.length, 1, 'still reported');
  const b = load(); b.self.clients.matchAll = async () => [b.win({ visibilityState: 'visible', focused: false }), b.win()]; await b.push(D); assert.equal(b.shown.length, 1);
});

test('click: closes the alert, reports the click, focuses an open Elite OS and tells it which notification, or opens it with that id when it is closed', async () => {
  const open = load(); const w = open.win(); open.self.clients.matchAll = async () => [w]; const closedFlags = [];
  await open.fire('notificationclick', { notification: { data: { n: D.n, d: D.d, k: 'message' }, close: () => closedFlags.push(1) } });
  assert.equal(closedFlags.length, 1); assert.equal(w.didFocus, true); assert.deepEqual(open.posted, [{ type: 'ek-open', n: D.n }]); assert.equal(open.opened.length, 0);
  assert.deepEqual(open.fetches[0].body, { n: D.n, d: D.d, p: 'clicked', t: 1000 });
  const shut = load(); await shut.fire('notificationclick', { notification: { data: { n: D.n, d: D.d }, close: () => {} } });
  assert.deepEqual(shut.opened, ['/?n=' + D.n], 'the chat is found from the opaque id after sign-in; no customer in the address');
  const odd = load(); await odd.fire('notificationclick', { notification: { data: null, close: () => {} } }); assert.deepEqual(odd.opened, ['/?n=']); assert.equal(odd.fetches.length, 0);
});

test('the worker still stores nothing and still leaves everything else alone (push added handlers, not storage)', () => {
  const src = read('sw.js').replace(/\/\/.*$/gm, '');
  assert.ok(!/\.put\s*\(|addAll|localStorage|indexedDB|sessionStorage/i.test(src)); assert.equal((src.match(/\.add\s*\(/g) || []).length, 1, 'only the offline page is cached');
  assert.ok(!/\b(name|phone|customer|wamid|profile)\b/i.test(src.slice(src.indexOf('const WORDS'), src.indexOf("self.addEventListener('fetch'"))), 'nothing about a customer is read from the push');
  const w = load(); assert.deepEqual(Object.keys(w.handlers).sort(), ['activate', 'fetch', 'install', 'notificationclick', 'push']);
});

test('push.js falls back to the Firebase web app id when the automatic config lacks it, and never overrides one that is there', () => {
  const src = read('push.js');
  assert.match(src, /const WEB_APP_ID = '1:812360112616:web:[0-9a-f]{20,}';/); assert.match(src, /if \(options && !options\.appId\) options\.appId = WEB_APP_ID;/);
  assert.ok(src.indexOf('options.appId = WEB_APP_ID') < src.indexOf('firebase.messaging().getToken'), 'the id is set before messaging is used');
  assert.match(src, /const VAPID_KEY = 'B[\w-]{80,100}';/, 'this project\'s own public Web Push key'); assert.match(src, /getToken\(\{ vapidKey: VAPID_KEY, serviceWorkerRegistration: reg \}\)/, 'and it is passed to getToken');
});

// ---------------------------------------------------------------- the model behind the speed table
const ev = { id: 'm_x', kind: 'message', status: 'sent', eventAt: 1000, backendReceivedAt: 1800, sendStartedAt: 1850, createdAt: { toMillis: () => 1800 },
  devices: { w: { platform: 'windows', ok: true, acceptedAt: 2100 }, a: { platform: 'android', ok: true, acceptedAt: 2150 }, x: { platform: 'android', ok: false, acceptedAt: 2100, error: 'messaging/internal-error' } },
  receipts: { w: { received: { deviceAt: 2900, serverAt: 3000 }, clicked: { deviceAt: 9000, serverAt: 9100 } } } };
test('speed model: every gap is a difference of two recorded times; a missing report is "not reported", never a zero; Firebase accepted is kept apart from delivery', () => {
  const rows = M.rowsOf(ev), by = Object.fromEntries(rows.map((r) => [r.deviceId, r]));
  assert.equal(rows.length, 3);
  assert.deepEqual([by.w.metaToBackend, by.w.backendToSend, by.w.sendToAccepted, by.w.acceptedToDevice, by.w.total], [800, 50, 250, 900, 1200]);
  assert.equal(by.w.received, true); assert.equal(by.w.clicked, true); assert.equal(by.w.deviceClockGap, 100); assert.equal(by.w.clockSuspect, false);
  assert.equal(by.a.received, false); assert.equal(by.a.acceptedToDevice, null); assert.equal(by.a.total, null); assert.equal(by.a.sendToAccepted, 300);
  assert.equal(by.x.ok, false); assert.equal(by.x.sendToAccepted, null); assert.equal(by.x.error, 'messaging/internal-error');
  assert.equal(by.w.createdMs, 1800); assert.deepEqual(M.rowsOf({}), []); assert.deepEqual(M.rowsOf(null), []);
  const skew = M.rowsOf({ ...ev, receipts: { w: { received: { deviceAt: 3000 - 120000, serverAt: 3000 } } } })[0]; assert.equal(skew.clockSuspect, true, 'a device clock two minutes off is flagged');
  const back = M.rowsOf({ ...ev, receipts: { w: { received: { deviceAt: 3100, serverAt: 3000 } } } })[0]; assert.equal(back.deviceClockGap, -100); assert.equal(back.clockSuspect, false);
  assert.equal(M.rowsOf({ ...ev, eventAt: null })[0].metaToBackend, null, 'no Meta time: no Meta figure');
});
test('speed model: median and 95th percentile per device type from the numbers that exist; fmt', () => {
  assert.equal(M.percentile([5, 1, 3, 2, 4], 50), 3); assert.equal(M.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10); assert.equal(M.percentile([7], 95), 7); assert.equal(M.percentile([], 50), null); assert.equal(M.percentile([null, NaN, 2], 50), 2);
  const mk = (platform, total, received = true, ok = true) => ({ platform, ok, received, total, acceptedToDevice: total, metaToBackend: null, backendToSend: 40, sendToAccepted: 200 });
  const s = M.summarize([mk('windows', 1000), mk('windows', 2000), mk('windows', 3000), mk('windows', null, false), mk('android', 5000), mk('android', null, false, false)]);
  assert.deepEqual([s.windows.sent, s.windows.received, s.windows.stats.total.n, s.windows.stats.total.median, s.windows.stats.total.p95], [4, 3, 3, 2000, 3000]);
  assert.deepEqual([s.android.sent, s.android.failed, s.android.received, s.android.stats.total.median], [1, 1, 1, 5000]); assert.equal(s.windows.stats.metaToBackend.n, 0); assert.equal(s.windows.stats.metaToBackend.median, null);
  assert.deepEqual(M.summarize([]), {}); assert.equal(M.rowsOfAll([ev, ev]).length, 6);
  assert.deepEqual([M.fmt(null), M.fmt(NaN), M.fmt(230), M.fmt(999.6), M.fmt(1000), M.fmt(1460), M.fmt(12345)], ['–', '–', '230 ms', '1000 ms', '1.0 s', '1.5 s', '12.3 s']);
});
