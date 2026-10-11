// Phase 6.2: the installable app. No emulator, no browser: the manifest, the icons, the page wiring, the headers, and the REAL sw.js and pwa.js run inside a pretend browser.
// What matters most: the service worker must never store app code or data (staff must always run the code the server sends: a quote must not be sent by an old copy of the
// screen), it must only touch page loads, and it must leave Firebase, Google sign-in and the WhatsApp webhook alone.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm');

const ROOT = path.join(__dirname, '..', '..'), PUBLIC = path.join(ROOT, 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\r\n/g, '\n');
const pngSize = (f) => { const b = fs.readFileSync(path.join(PUBLIC, f)); assert.equal(b.toString('latin1', 1, 4), 'PNG', f + ' is not a PNG'); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
const manifest = () => JSON.parse(read('manifest.webmanifest'));

// ---------------------------------------------------------------- the manifest and the icons
test('the manifest has what Chrome and Edge need to offer installation, and every icon is the size it says', () => {
  const m = manifest();
  for (const k of ['name', 'short_name', 'start_url', 'scope', 'display', 'icons', 'theme_color', 'background_color']) assert.ok(m[k], 'manifest.' + k);
  assert.equal(m.display, 'standalone'); assert.equal(m.start_url, '/'); assert.equal(m.scope, '/'); assert.equal(m.id, '/');
  assert.ok(m.short_name.length <= 12, 'a short name that fits under an icon');
  const purposes = (size, purpose) => m.icons.filter((i) => i.sizes === size && i.purpose === purpose);
  assert.equal(purposes('192x192', 'any').length, 1); assert.equal(purposes('512x512', 'any').length, 1); assert.equal(purposes('512x512', 'maskable').length, 1);
  for (const i of m.icons) {
    assert.equal(i.type, 'image/png'); assert.ok(i.src.startsWith('/'), 'icons are found from the root');
    const [w, h] = pngSize(i.src.slice(1)); assert.deepEqual([w, h], i.sizes.split('x').map(Number), i.src + ' is not ' + i.sizes);
    assert.ok(i.purpose === 'any' || i.purpose === 'maskable', 'one purpose per icon (a combined "any maskable" icon is cropped badly on Android): ' + i.purpose);
  }
  assert.deepEqual(pngSize('icons/favicon-32.png'), [32, 32]); assert.deepEqual(pngSize('icons/favicon-48.png'), [48, 48]);
});

test('the installed app uses the same light colours as the page', () => {
  const html = read('index.html'), m = manifest();
  assert.equal(/<meta name="theme-color" content="([^"]+)"/.exec(html)[1].toLowerCase(), m.theme_color.toLowerCase());
  const css = read('app.css'); assert.equal(/--bg:\s*(#[0-9a-f]{6})/i.exec(css)[1].toLowerCase(), m.background_color.toLowerCase());
});

// ---------------------------------------------------------------- the page and the headers
test('the page links the manifest, loads pwa.js, and the two install buttons are hidden until the browser offers installation', () => {
  const html = read('index.html');
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html, /<link rel="icon"[^>]*href="\/icons\/favicon-32\.png"/);
  assert.match(html, /<script src="\/pwa\.js"><\/script>/);
  assert.ok(html.indexOf('/pwa.js') < html.indexOf('firebase-app-compat.js'), 'pwa.js loads first, so it hears the browser\'s install offer');
  for (const id of ['install-app', 'install-app-m']) {
    const tag = new RegExp('<button id="' + id + '"[^>]*>').exec(html); assert.ok(tag, id + ' is missing');
    assert.match(tag[0], /\bdata-install-app\b/); assert.match(tag[0], /\shidden[\s>]/, id + ' must be hidden until installation is possible'); assert.match(tag[0], /aria-label="Install Elite OS"/);
  }
  assert.ok(html.indexOf('id="install-app"') < html.indexOf('id="signout"'), 'the install button sits above Sign out');
});

test('the service worker, the manifest, the offline page and pwa.js are never cached by the browser (an old service worker must not outlive an update)', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  const blocks = cfg.hosting.headers;
  const noCache = blocks.find((b) => /sw\.js/.test(b.source));
  assert.ok(noCache, 'no header rule mentions sw.js');
  for (const f of ['sw.js', 'pwa.js', 'offline.html', 'manifest.webmanifest']) {
    assert.ok(noCache.source.split(/[(|)]/).includes(f), f + ' is not in the no-cache rule');
    assert.ok(fs.existsSync(path.join(PUBLIC, f)), f + ' does not exist');
  }
  assert.equal(noCache.headers.find((h) => h.key === 'Cache-Control').value, 'no-cache');
  const mf = blocks.find((b) => b.source === '/manifest.webmanifest'); assert.ok(mf, 'the manifest needs its own content type');
  assert.equal(mf.headers.find((h) => h.key === 'Content-Type').value, 'application/manifest+json');
  assert.deepEqual(cfg.hosting.rewrites.map((r) => r.source), ['/webhook'], 'the webhook rewrite must be exactly as it was');
});

// ---------------------------------------------------------------- the service worker, run for real in a pretend browser
function loadWorker({ origin = 'https://app.test', fetchImpl } = {}) {
  const handlers = {}, calls = { open: [], add: [], put: [], del: [], skipWaiting: 0, claim: 0 };
  const store = { 'ek-offline-v1': {}, 'ek-old-cache': {} };
  const offlinePage = { offline: true };
  class Request { constructor(url, init) { this.url = url; Object.assign(this, init); } }
  const self = {
    location: { origin }, addEventListener: (type, fn) => { handlers[type] = fn; }, skipWaiting: () => { calls.skipWaiting++; return Promise.resolve(); }, clients: { claim: () => { calls.claim++; return Promise.resolve(); } },
  };
  const caches = {
    open: async (name) => { calls.open.push(name); return { add: async (r) => { calls.add.push(r); }, put: async (...a) => { calls.put.push(a); }, addAll: async () => { throw new Error('addAll must not be used'); } }; },
    keys: async () => Object.keys(store), delete: async (k) => { calls.del.push(k); delete store[k]; return true; },
    match: async (r) => (r === '/offline.html' ? offlinePage : undefined),
  };
  const context = { self, caches, Request, URL, fetch: fetchImpl || (async () => ({ network: true })), Promise };
  vm.runInNewContext(read('sw.js'), context, { filename: 'sw.js' });
  const waited = async (type, event) => { let p; handlers[type](Object.assign(event || {}, { waitUntil: (x) => { p = x; } })); await p; };
  const navigate = async (request) => { let answered; const event = { request, respondWith: (x) => { answered = x; } }; handlers.fetch(event); return { intercepted: answered !== undefined, answer: answered && (await answered) }; };
  return { handlers, calls, store, offlinePage, waited, navigate };
}
const nav = (url, extra = {}) => ({ mode: 'navigate', method: 'GET', url, ...extra });

test('service worker: installing stores only the offline page (fetched fresh), and activating removes every other cache', async () => {
  const w = loadWorker(); await w.waited('install');
  assert.deepEqual(w.calls.open, ['ek-offline-v1']); assert.equal(w.calls.add.length, 1); assert.equal(w.calls.add[0].url, '/offline.html'); assert.equal(w.calls.add[0].cache, 'reload');
  assert.equal(w.calls.put.length, 0); assert.equal(w.calls.skipWaiting, 1);
  await w.waited('activate'); assert.deepEqual(w.calls.del, ['ek-old-cache'], 'only the other caches go'); assert.equal(w.calls.claim, 1);
  assert.deepEqual(Object.keys(w.store), ['ek-offline-v1']);
});

test('service worker: it can never store app code or data (the source has no way to write to a cache except the offline page)', () => {
  const src = read('sw.js').replace(/\/\/.*$/gm, '');
  assert.ok(!/\.put\s*\(/.test(src) && !/addAll/.test(src), 'only cache.add of the offline page is allowed');
  assert.equal((src.match(/\.add\s*\(/g) || []).length, 1); assert.ok(!/localStorage|indexedDB|IndexedDB|postMessage|sync|push/i.test(src), 'no storage, sync or push of any kind');
});

test('service worker: a page load goes to the network and gets the network answer; only a failed connection gets the offline page', async () => {
  const net = { network: true, body: 'the app' };
  const online = loadWorker({ fetchImpl: async () => net });
  const r = await online.navigate(nav('https://app.test/'));
  assert.equal(r.intercepted, true); assert.strictEqual(r.answer, net, 'the network answer must be returned untouched');
  assert.equal(online.calls.put.length, 0, 'a page that loaded is never stored');
  const offline = loadWorker({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  const o = await offline.navigate(nav('https://app.test/#quotes')); assert.strictEqual(o.answer, offline.offlinePage);
  // an error the SERVER sent (for example a 500) is a network answer, not "offline"
  const server500 = { status: 500 }; const s = await loadWorker({ fetchImpl: async () => server500 }).navigate(nav('https://app.test/')); assert.strictEqual(s.answer, server500);
});

test('service worker: everything that is not a page load of this site is left alone (scripts, data, other sites, sign-in, webhook, posts)', async () => {
  const w = loadWorker({ fetchImpl: async () => { throw new Error('the worker must not fetch these itself'); } });
  for (const [what, request] of [
    ['a script', { mode: 'no-cors', method: 'GET', url: 'https://app.test/app.js' }],
    ['a data request', { mode: 'cors', method: 'GET', url: 'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel' }],
    ['a form post that navigates', nav('https://app.test/', { method: 'POST' })],
    ['another site', nav('https://example.com/')],
    ['the Google sign-in handler', nav('https://app.test/__/auth/handler?apiKey=x')],
    ['the Firebase scripts', nav('https://app.test/__/firebase/10.14.1/firebase-app-compat.js')],
    ['the WhatsApp webhook', nav('https://app.test/webhook')],
    ['the webhook with a path', nav('https://app.test/webhook/verify')],
  ]) { const r = await w.navigate(request); assert.equal(r.intercepted, false, what + ' must not be intercepted'); }
  // but a page that merely starts with the same letters is a normal page
  const ok = loadWorker({ fetchImpl: async () => ({ ok: 1 }) }); assert.equal((await ok.navigate(nav('https://app.test/webhooks-info'))).intercepted, true);
});

// ---------------------------------------------------------------- pwa.js, run for real in a pretend browser
function loadPage({ standalone = false, registerFails = false } = {}) {
  const win = { handlers: {}, standalone: undefined }, doc = { handlers: {} }, calls = { register: [], prompts: 0 };
  const buttons = [{ hidden: true }, { hidden: true }];
  win.addEventListener = (t, fn) => { win.handlers[t] = fn; }; doc.addEventListener = (t, fn) => { doc.handlers[t] = fn; };
  doc.querySelectorAll = (sel) => { assert.equal(sel, '[data-install-app]'); return buttons; };
  win.matchMedia = (q) => ({ matches: standalone && q === '(display-mode: standalone)' });
  win.navigator = { serviceWorker: { register: (u) => { calls.register.push(u); return registerFails ? Promise.reject(new Error('no')) : Promise.resolve({}); } } };
  const context = { window: win, document: doc, navigator: win.navigator, Promise }; win.document = doc;
  vm.runInNewContext(read('pwa.js'), context, { filename: 'pwa.js' });
  const offer = () => { let prevented = false, accepted; const e = { preventDefault: () => { prevented = true; }, prompt: () => { calls.prompts++; }, userChoice: Promise.resolve({ outcome: 'accepted' }) }; win.handlers.beforeinstallprompt(e); return { e, prevented: () => prevented }; };
  const click = (inside = true) => doc.handlers.click({ target: { closest: (s) => { assert.equal(s, '[data-install-app]'); return inside ? buttons[0] : null; } } });
  return { win, buttons, calls, offer, click };
}

test('pwa.js: the service worker is registered once the page has loaded, and a registration that fails changes nothing', async () => {
  const p = loadPage(); assert.deepEqual(p.calls.register, [], 'not before the page has loaded'); p.win.handlers.load(); assert.deepEqual(p.calls.register, ['/sw.js']);
  const bad = loadPage({ registerFails: true }); bad.win.handlers.load(); await new Promise((r) => setImmediate(r));              // no unhandled rejection: node would stop this test run
  assert.equal(bad.buttons[0].hidden, true);
});

test('pwa.js: "Install Elite OS" appears only when the browser offers installation, works once, and disappears once installed', () => {
  const p = loadPage(); assert.equal(p.buttons.every((b) => b.hidden), true, 'hidden at the start (browsers that cannot install never show it)');
  const { prevented } = p.offer(); assert.equal(prevented(), true, 'the browser\'s own mini bar is replaced by our button'); assert.equal(p.buttons.every((b) => b.hidden === false), true, 'both buttons (desktop rail and phone header) appear');
  p.click(false); assert.equal(p.calls.prompts, 0, 'a click elsewhere does nothing');
  p.click(); assert.equal(p.calls.prompts, 1); assert.equal(p.buttons.every((b) => b.hidden), true, 'hidden again straight away');
  p.click(); assert.equal(p.calls.prompts, 1, 'the offer can be used once');
  p.offer(); assert.equal(p.buttons[0].hidden, false); p.win.handlers.appinstalled(); assert.equal(p.buttons.every((b) => b.hidden), true, 'gone once installed');
});

test('pwa.js: inside the installed app the button is never shown', () => {
  const p = loadPage({ standalone: true }); p.offer(); assert.equal(p.buttons.every((b) => b.hidden), true);
});
