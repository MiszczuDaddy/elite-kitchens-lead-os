'use strict';
// Staying signed in on a phone (owner's report, 27 Oct 2026: "Elite OS keeps making me log in again every time I open it on my phone").
// Root cause: the sign-in page was the page's starting screen. Firebase keeps the session (it is stored in the browser), but the app hid the sign-in page only after the server had
// renewed the staff access (claimAccess). On a phone opened after a while that takes several seconds (the function starts cold), so the owner saw "Sign in with Google" and signed in
// again; and any hiccup in that call (a weak signal) showed the sign-in page with "not authorised".
// This test closes and reopens a phone-sized, touch, PERSISTENT browser profile (what closing and reopening the installed app does) with a slow and an unreliable server, and checks the
// security rules are unchanged: someone not allowed, a session that was ended, and an explicit sign-out still get the sign-in page.
// Real page + real functions + emulators. Run: bash test-ui/run.sh signin.e2e.js
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getAuth } = fnRequire('firebase-admin/auth');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const ok = (m) => console.log(`  PASS ${++n}. ${m}`);

const cfgJs = `firebase.initializeApp({apiKey:'fake',projectId:'demo-leados',authDomain:'localhost',storageBucket:'demo-leados.firebasestorage.app'});
firebase.auth().useEmulator('http://127.0.0.1:9099',{disableWarnings:true});
firebase.firestore().useEmulator('127.0.0.1',8085);
firebase.app().functions('europe-west1').useEmulator('127.0.0.1',5001);
firebase.storage().useEmulator('127.0.0.1',9199);`;
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const PORT = 5059, URL = `http://127.0.0.1:${PORT}/`;
const web = http.createServer((req, res) => {
  const u = req.url.split('?')[0]; let f;
  if (u === '/__/firebase/init.js') { res.setHeader('content-type', 'text/javascript'); return res.end(cfgJs); }
  const m = /^\/__\/firebase\/[\d.]+\/(.+)$/.exec(u);
  f = m ? path.join(ROOT, 'node_modules/firebase', m[1]) : path.join(ROOT, 'public', u === '/' ? 'index.html' : u);
  fs.readFile(f, (e, d) => { if (e) { res.statusCode = 404; return res.end('nf'); } res.setHeader('content-type', TYPES[path.extname(f)] || 'application/octet-stream'); res.end(d); });
}).listen(PORT);

(async () => {
  initializeApp({ projectId: 'demo-leados', storageBucket: 'demo-leados.firebasestorage.app' });
  const db = getFirestore();
  await db.doc('conversations/353860000071').set({ phone: '353860000071', name: 'Aoife Murphy', createdAt: Timestamp.now(), updatedAt: Timestamp.now(), lastMessage: 'Hi', unreadCount: 0 });
  const staff = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true });
  const stranger = await getAuth().createUser({ email: 'stranger@test.dev', emailVerified: true });
  const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'elite-signin-'));                // one phone profile for the whole test: closing it and opening it again is "closing the app"
  const errors = [];
  let ctx = null, page = null, claimMode = { delayMs: 0, failFirst: 0 }, claimCalls = 0;
  // Open the "app": a phone-sized, touch, persistent profile (its storage survives closing, like the installed app's). claimAccess can be made slow or unreliable.
  async function openApp() {
    ctx = await chromium.launchPersistentContext(PROFILE, { executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    page = ctx.pages()[0] || await ctx.newPage(); global.__page = page;
    page.on('pageerror', (e) => errors.push(e.message));
    await ctx.route(/\/claimAccess$/, async (route) => {
      claimCalls++;
      if (claimMode.failFirst > 0) { claimMode.failFirst--; return route.abort('connectionfailed'); }
      if (claimMode.delayMs) await sleep(claimMode.delayMs);
      return route.continue();
    });
    // Record, from the very first paint, whether the sign-in page or the app was ever on screen
    await page.addInitScript(() => {
      window.__seen = { login: 0, app: 0, boot: 0, bootText: '', notAuthorised: 0 };
      const look = () => {
        const vis = (id) => { const e = document.getElementById(id); return !!e && !e.hidden && e.offsetParent !== null; };
        if (vis('login')) window.__seen.login++;
        if (vis('app')) window.__seen.app++;
        if (vis('boot')) { window.__seen.boot++; window.__seen.bootText = document.getElementById('boot').innerText; }
        if (/not authorised/i.test((document.getElementById('loginmsg') || {}).textContent || '')) window.__seen.notAuthorised++;
      };
      new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      setInterval(look, 25);
    });
    await page.goto(URL);
  }
  async function closeApp() { await ctx.close(); ctx = null; page = null; }
  const seen = () => page.evaluate(() => window.__seen);
  const appShown = () => page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
  console.log('SIGN-IN E2E: closing and reopening a phone profile, with a slow and an unreliable server');

  // 1. First time: the sign-in page (nobody is signed in on this phone yet). Signing in opens the app.
  await openApp();
  await page.waitForSelector('#login:not([hidden])'); assert.equal(await page.isVisible('#app'), false);
  const staffToken = await getAuth().createCustomToken(staff.uid);
  await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), staffToken);
  await appShown();
  ok('first time on this phone: the sign-in page, then the app once signed in');

  // 2. THE OWNER'S CASE: close the app and open it again later, with the server slow to wake up (4 seconds). The sign-in page must never appear: a short "opening" screen, then the app.
  await closeApp(); claimMode = { delayMs: 4000, failFirst: 0 }; claimCalls = 0;
  await openApp();
  await appShown();
  let s = await seen();
  assert.equal(s.login, 0, 'the sign-in page was never shown while the server woke up'); assert.equal(s.notAuthorised, 0);
  assert.ok(s.boot > 0 && /Opening Elite OS/i.test(s.bootText), 'a short "Opening Elite OS…" screen was shown instead: ' + JSON.stringify(s));
  assert.equal(await page.isVisible('#boot'), false, 'the opening screen is gone once the app is open');
  assert.equal(await page.evaluate(() => firebase.auth().currentUser && firebase.auth().currentUser.email), 'staff@test.dev', 'still signed in: nothing was typed or tapped');
  assert.ok(claimCalls >= 1, 'staff access was still checked with the server before anything was shown');
  await page.screenshot({ path: path.join(SHOTS, 'signin-reopen.png') });
  ok('closing and reopening Elite OS keeps you signed in: a short "Opening Elite OS…" screen while the server wakes up, never the sign-in page');

  // 3. A weak signal: the access check fails twice, then works. You stay signed in; the app opens by itself; no "not authorised".
  await closeApp(); claimMode = { delayMs: 0, failFirst: 2 }; claimCalls = 0;
  await openApp();
  await page.waitForFunction(() => /can.t reach elite os/i.test(document.getElementById('boot-msg').textContent), null, { timeout: 15000 });
  assert.equal(await page.isVisible('#boot-retry'), true, 'a Try again button is offered');
  await page.screenshot({ path: path.join(SHOTS, 'signin-retry.png') });
  await appShown();
  s = await seen(); assert.equal(s.login, 0, 'never the sign-in page'); assert.equal(s.notAuthorised, 0, 'never "not authorised" for a connection problem');
  assert.ok(claimCalls >= 3, 'it tried again by itself: ' + claimCalls);
  ok('a weak connection while opening: "Can\'t reach Elite OS, trying again" and the app opens by itself; you stay signed in');

  // 4. Restarting the phone is the same as closing the browser profile: still signed in, straight into the app.
  await closeApp(); claimMode = { delayMs: 0, failFirst: 0 };
  await openApp(); await appShown(); s = await seen(); assert.equal(s.login, 0);
  const canRead = () => page.evaluate(async () => { try { await firebase.firestore().collection('conversations').limit(1).get({ source: 'server' }); return true; } catch (e) { return String(e.code || e.message); } });
  assert.equal(await canRead(), true, 'and the data is served (the staff claim is valid)');
  ok('after a restart: still signed in, straight into the app, data served');

  // 5. Security unchanged: an explicit sign-out stays signed out after reopening.
  await page.evaluate(() => firebase.auth().signOut()); await page.waitForSelector('#login:not([hidden])');
  await closeApp(); await openApp();
  await page.waitForSelector('#login:not([hidden])'); await sleep(1500);
  assert.equal(await page.isVisible('#app'), false); assert.equal(await page.isVisible('#boot'), false);
  ok('signing out is remembered: reopening shows the sign-in page');

  // 6. Security unchanged: someone who is not on the staff list gets "not authorised" and no data.
  await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), await getAuth().createCustomToken(stranger.uid));
  await page.waitForFunction(() => /not authorised/i.test(document.getElementById('loginmsg').textContent), null, { timeout: 20000 });
  assert.equal(await page.isVisible('#app'), false); assert.equal(await page.isVisible('#login-signout'), true);
  assert.notEqual(await canRead(), true, 'Firestore refuses them');
  await page.click('#login-signout'); await page.waitForFunction(() => !firebase.auth().currentUser);
  ok('someone not on the staff list: "not authorised", a Sign out button, and no data (unchanged)');

  // 7. Security unchanged: a session that was ended (account disabled) is not kept: reopening ends at the sign-in page, not in the app.
  await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), staffToken); await appShown();
  await closeApp();
  await getAuth().updateUser(staff.uid, { disabled: true });
  await openApp();
  await page.waitForSelector('#login:not([hidden])', { timeout: 30000 }); await sleep(1500);
  assert.equal(await page.isVisible('#app'), false, 'the app is not shown'); assert.equal(await page.evaluate(() => !!firebase.auth().currentUser), false, 'signed out');
  await getAuth().updateUser(staff.uid, { disabled: false });
  ok('a session that was ended (account disabled) is signed out on the next open (unchanged)');

  const real = errors.filter((e) => !/network|fetch|Failed to load|connection/i.test(e));
  assert.deepEqual(real, [], 'no page errors');
  ok('no page errors');
  await closeApp(); fs.rmSync(PROFILE, { recursive: true, force: true });
  web.close();
  console.log(`ALL ${n} CHECKS PASSED`);
  process.exit(0);
})().catch(async (e) => { console.error('FAILED:', e && e.stack || e); try { await global.__page?.screenshot({ path: path.join(SHOTS, 'signin-fail.png') }); } catch (_) { /* no page */ } process.exit(1); });
