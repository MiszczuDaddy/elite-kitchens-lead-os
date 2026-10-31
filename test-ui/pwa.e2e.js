'use strict';
// Phase 6.2, the installable app, in a REAL browser: Chrome itself judges whether the app can be installed (manifest + icons), the service worker takes over and
// stores nothing but the offline page, a page load with no connection shows "You're offline" with a Retry button (and Retry works), sign-in is not disturbed by the
// worker, and "Install Elite OS" appears only when the browser offers installation (rail on a desktop, header on a phone) and never inside the installed app.
// Real page + real functions + emulators. Run: bash test-ui/run.sh pwa.e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getAuth } = fnRequire('firebase-admin/auth');
const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const ok = (m) => console.log(`  PASS ${++n}. ${m}`);
const URL0 = 'http://127.0.0.1:5056/';

const cfgJs = `firebase.initializeApp({apiKey:'fake',projectId:'demo-leados',authDomain:'localhost',storageBucket:'demo-leados.firebasestorage.app'});
firebase.auth().useEmulator('http://127.0.0.1:9099',{disableWarnings:true});
firebase.firestore().useEmulator('127.0.0.1',8085);
firebase.app().functions('europe-west1').useEmulator('127.0.0.1',5001);
firebase.storage().useEmulator('127.0.0.1',9199);`;
// the same types and headers Firebase Hosting gives these files (firebase.json): the manifest's type, and no-cache for the worker
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const web = http.createServer((req, res) => {
  const u = req.url.split('?')[0]; let f;
  if (u === '/__/firebase/init.js') { res.setHeader('content-type', 'text/javascript'); return res.end(cfgJs); }
  const m = /^\/__\/firebase\/[\d.]+\/(.+)$/.exec(u);
  f = m ? path.join(ROOT, 'node_modules/firebase', m[1]) : path.join(ROOT, 'public', u === '/' ? 'index.html' : u);
  fs.readFile(f, (e, d) => { if (e) { res.statusCode = 404; return res.end('nf'); } res.setHeader('content-type', TYPES[path.extname(f)] || 'application/octet-stream'); res.setHeader('cache-control', 'no-cache'); res.end(d); });
}).listen(5056);

(async () => {
  initializeApp({ projectId: 'demo-leados', storageBucket: 'demo-leados.firebasestorage.app' });
  const user = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true });
  const token = await getAuth().createCustomToken(user.uid);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const errors = [];
  const newPage = async (options = {}, init) => { const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, ...options }); if (init) await ctx.addInitScript(init); const page = await ctx.newPage(); global.__page = page; page.on('pageerror', (e) => errors.push(e.message)); return { ctx, page }; };
  const signIn = async (page) => { await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])'); await page.evaluate(() => { if (location.hash === '#today') location.hash = ''; }); };
  // a fake "the browser offers installation" event, with a spy for prompt()
  const offerInstall = (page) => page.evaluate(() => { window.__prompts = 0; const e = new Event('beforeinstallprompt', { cancelable: true }); e.prompt = () => { window.__prompts++; return Promise.resolve(); }; e.userChoice = Promise.resolve({ outcome: 'accepted' }); window.dispatchEvent(e); return e.defaultPrevented; });
  console.log('PWA E2E: real page + real functions + emulators, in Chromium');

  // ------------------------------------------------------------------ 1. Chrome's own verdict on the manifest
  let { ctx, page } = await newPage();
  await page.goto(URL0); await page.waitForSelector('#login:not([hidden])');
  const cdp = await ctx.newCDPSession(page); await cdp.send('Page.enable');
  const { data, errors: manifestErrors, url } = await cdp.send('Page.getAppManifest');
  assert.ok(/manifest\.webmanifest$/.test(url), 'Chrome must find the manifest from the page: ' + url);
  assert.deepEqual(manifestErrors, [], 'the manifest must parse without errors: ' + JSON.stringify(manifestErrors));
  const parsed = JSON.parse(data); assert.equal(parsed.display, 'standalone'); assert.equal(parsed.short_name, 'Elite OS');
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  assert.deepEqual(installabilityErrors, [], 'Chrome says the app cannot be installed: ' + JSON.stringify(installabilityErrors));
  ok('Chrome reads the manifest without errors and reports NO reason why the app could not be installed (icons, name, start address, display mode)');

  // ------------------------------------------------------------------ 2. the worker takes over and stores nothing but the offline page
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); await page.waitForSelector('#login:not([hidden])');
  assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true, 'the worker must control the page after a reload');
  const stored = await page.evaluate(async () => { const out = {}; for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname); return out; });
  assert.deepEqual(stored, { 'ek-offline-v1': ['/offline.html'] }, 'nothing but the offline page may be stored: ' + JSON.stringify(stored));
  ok('the service worker is active and has stored ONLY the offline page: no app code, no data');

  // ------------------------------------------------------------------ 3. the app still works with the worker in charge, and still loads fresh code
  const served = []; page.on('response', (r) => { if (/\/app\.js$/.test(r.url())) served.push(r.fromServiceWorker()); });
  await page.reload(); await page.waitForSelector('#login:not([hidden])');
  await signIn(page); assert.equal(await page.isVisible('#app'), true);
  assert.ok(served.length >= 1, 'app.js must have loaded'); assert.ok(served.every((fromWorker) => fromWorker === false), 'app.js must come from the network, never from the worker: ' + JSON.stringify(served));
  ok('signing in works with the worker active, and the app code comes from the network (never from the worker)');

  // ------------------------------------------------------------------ 4. "Install Elite OS" on a desktop: hidden, then offered, then used once
  assert.equal(await page.isVisible('#install-app'), false, 'hidden until the browser offers installation');
  assert.equal(await offerInstall(page), true, 'our page must take over the install offer (preventDefault)');
  await page.waitForSelector('#install-app', { state: 'visible' });
  assert.equal(await page.isVisible('#install-app-m'), false, 'the phone button is not shown on a desktop');
  assert.match((await page.textContent('#install-app')).trim(), /Install Elite OS/);
  const box = await page.locator('#install-app').boundingBox(), out = await page.locator('#signout').boundingBox();
  assert.ok(box.y < out.y, 'the install option sits above Sign out');
  await page.screenshot({ path: path.join(SHOTS, 'pwa-install-rail.png') });
  await page.click('#install-app');
  assert.equal(await page.evaluate(() => window.__prompts), 1, 'the browser\'s install dialog must be asked for'); assert.equal(await page.isVisible('#install-app'), false, 'hidden again straight after');
  await page.click('#install-app', { timeout: 500, trial: true }).then(() => assert.fail('the hidden button must not be clickable'), () => {});
  await page.evaluate(() => { const e = new Event('beforeinstallprompt', { cancelable: true }); e.prompt = () => Promise.resolve(); e.userChoice = Promise.resolve({}); window.dispatchEvent(e); });
  await page.waitForSelector('#install-app', { state: 'visible' });
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await page.waitForSelector('#install-app', { state: 'hidden' });
  ok('on a desktop "Install Elite OS" is hidden, appears when the browser offers installation, asks the browser once, and disappears when the app is installed');

  // ------------------------------------------------------------------ 5. offline: the calm page, Retry, and back
  const mainCtx = ctx;
  await mainCtx.setOffline(true);
  await page.goto(URL0 + '?offline-check=1');
  await page.waitForSelector('#retry'); assert.match(await page.textContent('h1'), /You're offline/);
  assert.match(await page.textContent('main'), /internet connection/i); assert.ok(await page.title(), 'the page has a title');
  await page.screenshot({ path: path.join(SHOTS, 'pwa-offline.png') });
  await page.click('#retry'); await page.waitForSelector('#retry');                                 // still offline: Retry shows the page again, no error page
  assert.match(await page.textContent('h1'), /You're offline/);
  await mainCtx.setOffline(false);
  await page.click('#retry').catch(() => {});                                                        // the page may already have retried by itself ("online" event)
  await page.waitForSelector('#login:not([hidden]), #app:not([hidden])', { timeout: 15000 });
  assert.equal(await page.locator('#retry').count(), 0, 'back online the real app is shown, not the offline page');
  ok('with no connection a page load shows "You\'re offline" with a Retry button (Retry offline stays calm), and when the connection is back the real app returns');

  // ------------------------------------------------------------------ 6. a phone: the option is in the header, the rail is not there
  ({ ctx, page } = await newPage({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true }));
  await page.goto(URL0); await page.waitForSelector('#login:not([hidden])'); await signIn(page);
  assert.equal(await page.isVisible('#install-app-m'), false);
  const headingBefore = await page.locator('.pane-head h1').boundingBox();
  await offerInstall(page);
  await page.waitForSelector('#install-app-m', { state: 'visible' }); assert.equal(await page.isVisible('#install-app'), false, 'the desktop rail is not shown on a phone');
  const headingAfter = await page.locator('.pane-head h1').boundingBox(), vw = 390, btn = await page.locator('#install-app-m').boundingBox();
  assert.deepEqual([headingAfter.width, headingAfter.height], [headingBefore.width, headingBefore.height], 'the header (the "Inbox" heading) must look exactly the same with the option offered: ' + JSON.stringify([headingBefore, headingAfter]));
  assert.ok(headingAfter.height < 40, 'the heading stays on one line');
  assert.ok(btn.x >= 0 && btn.x + btn.width <= vw && btn.height >= 36, 'the option fits the screen and is easy to tap: ' + JSON.stringify(btn));
  assert.ok(btn.y > headingAfter.y + headingAfter.height, 'the option is in the section buttons under the header, not among the header buttons');
  await page.screenshot({ path: path.join(SHOTS, 'pwa-install-phone.png') });
  await page.tap('#install-app-m'); assert.equal(await page.evaluate(() => window.__prompts), 1); await page.waitForSelector('#install-app-m', { state: 'hidden' });
  ok('on a phone the option is one of the section buttons under the header (the header looks exactly the same), asks the browser once, and goes away');
  await ctx.close();

  // ------------------------------------------------------------------ 7. inside the installed app the option never appears
  ({ ctx, page } = await newPage({}, () => { const real = window.matchMedia.bind(window); window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : real(q)); }));
  await page.goto(URL0); await page.waitForSelector('#login:not([hidden])'); await signIn(page);
  await offerInstall(page); await sleep(400);
  assert.equal(await page.isVisible('#install-app'), false); assert.equal(await page.isVisible('#install-app-m'), false);
  ok('inside the installed app (standalone window) "Install Elite OS" is never shown');
  await ctx.close();

  assert.deepEqual(errors.filter((e) => !/permission|insufficient|PERMISSION/i.test(e)), [], 'browser errors: ' + JSON.stringify(errors)); ok('no unexpected JavaScript errors');
  console.log(`ALL ${n} CHECKS PASSED`);
  await browser.close(); web.close(); process.exit(0);
})().catch(async (e) => { console.error('FAILED:', e && e.stack || e); try { await global.__page?.screenshot({ path: path.join(SHOTS, 'pwa-fail.png') }); } catch (_) { /* no page */ } process.exit(1); });
