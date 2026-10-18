'use strict';
// Phase 8 browser test: push notifications. Real page + real functions + emulators. Firebase Cloud Messaging itself cannot be reached from a test, so the pieces are checked where they can be:
// the Notifications dialog (Enable, turn off, blocked, test), the real device registration, the "Notification speed" table, a click opening the right chat, and the REAL service worker of
// the app receiving a push (delivered through the browser's debugging protocol) with Elite OS CLOSED: it must show the generic alert and report the arrival to the real /pushReceipt function.
// Real delivery over the internet is measured on real devices after the deploy (docs/PUSH.md). Run: bash test-ui/run.sh push.e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getAuth } = fnRequire('firebase-admin/auth');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const ok = (m) => console.log(`  PASS ${++n}. ${m}`);
const ORIGIN = 'http://127.0.0.1:5057';
// like production's automatic config, which has the sender id and the web app id (without them the messaging library stops before it ever looks for its service worker file)
const cfgJs = `firebase.initializeApp({apiKey:'fake',projectId:'demo-leados',authDomain:'localhost',storageBucket:'demo-leados.firebasestorage.app',messagingSenderId:'812360112616',appId:'1:812360112616:web:2d739fad9219ebb92eec5d'});
firebase.auth().useEmulator('http://127.0.0.1:9099',{disableWarnings:true});
firebase.firestore().useEmulator('127.0.0.1',8085);
firebase.app().functions('europe-west1').useEmulator('127.0.0.1',5001);
firebase.storage().useEmulator('127.0.0.1',9199);`;
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const web = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/pushReceipt') {                                                                    // what the Hosting rewrite does in production: the public receipt function
    const proxy = http.request({ host: '127.0.0.1', port: 5001, path: '/demo-leados/europe-west1/pushReceipt', method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json' } }, (r) => { res.statusCode = r.statusCode; r.pipe(res); });
    proxy.on('error', () => { res.statusCode = 502; res.end(); }); return req.pipe(proxy);
  }
  if (u === '/__/firebase/init.js') { res.setHeader('content-type', 'text/javascript'); return res.end(cfgJs); }
  const m = /^\/__\/firebase\/[\d.]+\/(.+)$/.exec(u);
  const f = m ? path.join(ROOT, 'node_modules/firebase', m[1]) : path.join(ROOT, 'public', u === '/' ? 'index.html' : u);
  fs.readFile(f, (e, d) => { if (e) { res.statusCode = 404; return res.end('nf'); } res.setHeader('content-type', TYPES[path.extname(f)] || 'application/octet-stream'); res.setHeader('cache-control', 'no-cache'); res.end(d); });
}).listen(5057);

const A = '353860000031';
(async () => {
  initializeApp({ projectId: 'demo-leados', storageBucket: 'demo-leados.firebasestorage.app' });
  const db = getFirestore();
  await db.doc('conversations/' + A).set({ phone: A, name: 'Anna Apple', createdAt: Timestamp.now(), updatedAt: Timestamp.now(), lastMessage: 'Hi', unreadCount: 0 });
  await db.doc('contacts/' + A).set({ phone: A, name: 'Anna Apple', createdAt: Timestamp.now() });
  const until = async (fn, what, ms = 15000) => { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch (e) { /* not yet */ } if (Date.now() - t > ms) throw new Error('timed out waiting for: ' + what); await sleep(120); } };
  const u = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true });
  const token = await getAuth().createCustomToken(u.uid);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const errors = [];
  const open = async (ctx, signedIn = true) => {
    const page = await ctx.newPage(); global.__page = page; page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(ORIGIN + '/'); if (signedIn) { await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])'); await page.evaluate(() => { if (location.hash === '#today') location.hash = ''; }); }
    return page;
  };
  // Firebase Cloud Messaging cannot be reached from a test: the page gets a fixed address instead. Everything else (permission, registration, the server) is real.
  const fakeFcm = (page) => page.evaluate(() => { const f = () => ({ getToken: async () => 'fcm-e2e-token-' + 'x'.repeat(130), deleteToken: async () => true }); f.isSupported = () => true; firebase.messaging = f; PUSH.render(); });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, permissions: ['notifications'] });
  let page = await open(ctx);
  await fakeFcm(page);
  console.log('PUSH E2E: real page + real functions + emulators, real service worker');

  // ------------------------------------------------------------------ 1. the dialog, off at first
  await page.waitForSelector('#notif-open:not([hidden])'); await page.click('#notif-open'); await page.waitForSelector('#notif-dlg[open]');
  assert.match(await page.textContent('#notif-state'), /off for this device/); assert.equal(await page.textContent('#notif-toggle'), 'Enable notifications'); assert.equal(await page.isDisabled('#notif-test'), true);
  assert.match(await page.textContent('#notif-dlg'), /never who or what/);
  await page.screenshot({ path: path.join(SHOTS, 'push-dialog-off.png') });
  ok('the Notifications button is there, the dialog says notifications are off and never show who or what, and Send a test is switched off until they are on');

  // ------------------------------------------------------------------ 2. enabling registers this device on the server
  await page.click('#notif-toggle'); await page.waitForFunction(() => /ON for this device/.test(document.getElementById('notif-state').textContent));
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('ek-push-device'))); assert.match(stored.id, /^[0-9a-f]{32}$/);
  const dev = (await db.doc('pushDevices/' + stored.id).get()).data(); const ua = await page.evaluate(() => navigator.userAgent);
  assert.equal(dev.email, 'staff@test.dev'); assert.equal(dev.enabled, true); assert.equal(dev.platform, /Android/i.test(ua) ? 'android' : /Windows/i.test(ua) ? 'windows' : 'other'); assert.equal(dev.token, stored.token);
  assert.equal(await page.textContent('#notif-toggle'), 'Turn off on this device'); assert.equal(await page.isDisabled('#notif-test'), false);
  ok('"Enable notifications" asks the browser for permission, registers this device with the server (staff only), and the dialog turns ON');

  // ------------------------------------------------------------------ 3. a test notification: the request is made, an event is recorded (Firebase cannot be reached from here)
  await page.click('#notif-test');
  const ev = await until(async () => (await db.collection('pushEvents').where('kind', '==', 'test').get()).docs[0], 'the test event');
  assert.match(ev.id, /^t_[0-9a-f]{24}$/); assert.equal(ev.data().phone, null); assert.ok(ev.data().backendReceivedAt <= Date.now());
  await page.waitForFunction(() => document.getElementById('notif-test').textContent && !document.getElementById('notif-toggle').disabled);
  ok('"Send a test notification" asks the server, which records a measurement of its own (no customer in it)');

  // ------------------------------------------------------------------ 4. the speed table
  const t0 = Date.now() - 5000, id1 = 'm_' + 'c'.repeat(24);
  await db.doc('pushEvents/' + id1).set({ kind: 'message', phone: A, status: 'sent', createdAt: Timestamp.fromMillis(t0), eventAt: t0 - 700, backendReceivedAt: t0, sendStartedAt: t0 + 40,
    devices: { [stored.id]: { platform: 'windows', ok: true, acceptedAt: t0 + 240 }, ['d'.repeat(32)]: { platform: 'android', ok: true, acceptedAt: t0 + 260 } },
    receipts: { [stored.id]: { received: { deviceAt: t0 + 1100, serverAt: t0 + 1200 }, clicked: { deviceAt: t0 + 4000, serverAt: t0 + 4100 } } } });
  await page.click('#notif-speed summary'); await page.waitForFunction(() => document.querySelectorAll('#notif-rows tr').length >= 2);
  const rows = await page.locator('#notif-rows tr').allInnerTexts(); const winRow = rows.find((r) => /WhatsApp/.test(r) && /Windows/.test(r)), andRow = rows.find((r) => /Android/.test(r));
  assert.match(winRow, /WhatsApp/); assert.match(winRow, /700 ms/); assert.match(winRow, /40 ms/); assert.match(winRow, /200 ms/); assert.match(winRow, /960 ms/); assert.match(winRow, /1\.2 s/); assert.match(winRow, /yes/);
  assert.match(andRow, /no report/, 'a device that did not report back is "no report", not a number');
  const sum = await page.textContent('#notif-summary'); assert.match(sum, /Windows: 1 sent, 1 reported back/); assert.match(sum, /Android: 1 sent, 0 reported back/);
  assert.match(await page.textContent('#notif-speed'), /not<\/strong> when the device got it|NOT|not when the device got it/i);
  await page.screenshot({ path: path.join(SHOTS, 'push-dialog-speed.png') });
  ok('the speed table shows every gap per device (Meta to us, us to send, Firebase accepted, accepted to device, total), a silent device as "no report", and says Firebase accepted is not delivery');
  await page.click('#notif-close');

  // ------------------------------------------------------------------ 5. the REAL service worker, with Elite OS closed
  const keeper = await ctx.newPage(); const cdp = await ctx.newCDPSession(keeper); await cdp.send('ServiceWorker.enable');
  let regs = []; cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => { regs = e.registrations; });
  await page.evaluate(() => navigator.serviceWorker.ready); await keeper.goto('about:blank');
  const reg = await until(() => regs.find((r) => r.scopeURL.startsWith(ORIGIN)), 'the service worker registration'); await page.close();
  const id2 = 'm_' + 'e'.repeat(24);
  await db.doc('pushEvents/' + id2).set({ kind: 'message', phone: A, status: 'sent', createdAt: Timestamp.now(), backendReceivedAt: Date.now(), sendStartedAt: Date.now(), devices: { [stored.id]: { platform: 'windows', ok: true, acceptedAt: Date.now() } } });
  const sentAt = Date.now();
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: ORIGIN, registrationId: reg.registrationId, data: JSON.stringify({ data: { n: id2, d: stored.id, k: 'message', c: 'abcd1234' }, from: '1', fcmMessageId: 'x' }) });
  const got = await until(async () => { const r = (await db.doc('pushEvents/' + id2).get()).data().receipts; return r && r[stored.id] && r[stored.id].received; }, 'the device report reaching the server through /pushReceipt');
  assert.ok(got.deviceAt >= sentAt - 50 && got.deviceAt <= Date.now(), 'the device clock'); assert.ok(got.serverAt >= got.deviceAt - 50 && got.serverAt <= Date.now(), 'the server clock when the report arrived');
  page = await ctx.newPage(); await page.goto(ORIGIN + '/'); global.__page = page;
  const shown = await until(async () => { const l = await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((x) => ({ title: x.title, body: x.body, tag: x.tag }))); return l.length ? l : null; }, 'the alert');
  assert.deepEqual(shown, [{ title: 'New WhatsApp message', body: 'Open Elite OS to read it.', tag: 'ek-abcd1234' }]); assert.ok(!JSON.stringify(shown).match(/Anna|Apple|353/), 'no customer on the alert');
  ok('with Elite OS closed the real service worker wakes on a push, shows the generic alert (no name, number or text), and reports the arrival to the real receipt function (device clock and server clock)');

  // ------------------------------------------------------------------ 6. clicking the alert: the right chat opens (closed app: found from the opaque id; open app: told by the worker)
  await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])'); await page.evaluate(() => { if (location.hash === '#today') location.hash = ''; });
  await page.goto(ORIGIN + '/?n=' + id2); await page.waitForSelector('#app:not([hidden])'); await page.evaluate(() => { if (location.hash === '#today') location.hash = ''; });
  await page.waitForFunction((p) => location.hash === '#c/' + p, A); assert.doesNotMatch(page.url(), /[?&]n=/); await page.waitForSelector('#thread:not([hidden])');
  assert.match(await page.textContent('#thread'), /Anna Apple/);
  await page.evaluate(() => { location.hash = ''; }); await page.waitForFunction(() => location.hash === '');
  await page.evaluate((n) => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'ek-open', n } })), id2); await page.waitForFunction((p) => location.hash === '#c/' + p, A);
  await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'ek-open', n: 'not-an-id' } })));
  await page.goto(ORIGIN + '/?n=' + 't_' + 'f'.repeat(24)); await page.waitForSelector('#app:not([hidden])'); await page.evaluate(() => { if (location.hash === '#today') location.hash = ''; }); assert.doesNotMatch(page.url(), /[?&]n=/);
  ok('a clicked notification opens the right chat (a closed app finds it from the opaque id after sign-in; an open one is told by the worker); an unknown or bad id changes nothing');

  // ------------------------------------------------------------------ 6b. the lockout of 2026-10-12: with notifications ALREADY allowed, a fresh page load must still sign in
  const fresh = await ctx.newPage(); global.__page = fresh; const freshErrors = []; fresh.on('pageerror', (e) => freshErrors.push(e.message));
  await fresh.goto(ORIGIN + '/');                                                                  // permission is granted; the real messaging library is loaded, the call to claimAccess asks it for a token
  await fresh.waitForSelector('#app:not([hidden])', { timeout: 20000 });
  assert.equal(await fresh.isVisible('#login'), false); assert.doesNotMatch(await fresh.textContent('#loginmsg'), /Messaging|not authorised/);
  // the exact step that failed for the owner: with nothing set up in the page, the messaging library looks for its default service worker file. It must be found (what happens after that needs the internet).
  const lookup = await fresh.evaluate(() => Promise.race([firebase.messaging().getToken().then(() => 'ok', (e) => String((e && (e.code || e.message)) || e)), new Promise((r) => setTimeout(() => r('still working'), 12000))]));
  assert.doesNotMatch(lookup, /failed-service-worker-registration|unable to register the default service worker|404/, 'the default look-up file must exist: ' + lookup);
  await fresh.close(); page = await ctx.newPage(); await page.goto(ORIGIN + '/'); await page.waitForSelector('#app:not([hidden])'); await page.evaluate(() => { if (location.hash === '#today') location.hash = ''; }); global.__page = page;
  ok('with notifications already allowed, a fresh page load still signs in (the real messaging library does not break the first function call)');

  // ------------------------------------------------------------------ 7. turning it off
  await fakeFcm(page); await page.click('#notif-open'); await page.waitForSelector('#notif-dlg[open]');
  assert.match(await page.textContent('#notif-state'), /ON for this device/);
  await page.click('#notif-toggle'); await page.waitForFunction(() => /off for this device/.test(document.getElementById('notif-state').textContent));
  await until(async () => !(await db.doc('pushDevices/' + stored.id).get()).exists, 'the device forgotten by the server'); assert.equal(await page.evaluate(() => localStorage.getItem('ek-push-device')), null);
  assert.equal(await page.isDisabled('#notif-test'), true); await page.click('#notif-close');
  ok('"Turn off on this device" makes the server forget the device and the dialog says off');
  await ctx.close();

  // ------------------------------------------------------------------ 8. permission blocked, and a phone
  const blocked = await browser.newContext({ viewport: { width: 1360, height: 900 }, permissions: [] }); let bp = await open(blocked); await fakeFcm(bp);
  await bp.click('#notif-open'); await bp.waitForSelector('#notif-dlg[open]');
  await bp.waitForFunction(() => /blocked/i.test(document.getElementById('notif-state').textContent)); assert.equal(await bp.isDisabled('#notif-toggle'), true, 'nothing to press while the browser blocks notifications');
  assert.equal((await db.collection('pushDevices').get()).size, 0, 'nothing is registered without permission'); await blocked.close();
  const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true, permissions: ['notifications'] }); const mp = await open(phone); await fakeFcm(mp);
  assert.equal(await mp.isVisible('#notif-open-m'), true); assert.equal(await mp.isVisible('#notif-open'), false, 'the desktop rail is not shown on a phone');
  assert.equal(await mp.locator('.pane-head h1').evaluate((h) => h.getBoundingClientRect().height < 40), true, 'the header is unchanged');
  await mp.tap('#notif-open-m'); await mp.waitForSelector('#notif-dlg[open]');
  assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scrolling');
  const box = await mp.locator('#notif-dlg').boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 390, 'the dialog fits the phone: ' + JSON.stringify(box));
  await mp.screenshot({ path: path.join(SHOTS, 'push-phone.png') }); await phone.close();
  ok('when the browser blocks notifications the dialog says so and nothing is registered; on a phone the option is a small link, the header is unchanged and the dialog fits the screen');

  assert.deepEqual(errors.filter((e) => !/permission|insufficient|PERMISSION|credential|messaging|FCM/i.test(e)), [], 'browser errors: ' + JSON.stringify(errors)); ok('no unexpected JavaScript errors');
  console.log(`ALL ${n} CHECKS PASSED`);
  await browser.close(); web.close(); process.exit(0);
})().catch(async (e) => { console.error('FAILED:', e && e.stack || e); try { await global.__page?.screenshot({ path: path.join(SHOTS, 'push-fail.png') }); } catch (_) { /* no page */ } process.exit(1); });
