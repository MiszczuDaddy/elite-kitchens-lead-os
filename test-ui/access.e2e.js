'use strict';
// Audit finding 5 on the real screen: staff access EXPIRES, and the app renews it while the person is still allowed. A person who is removed
// is signed out at the next renewal. Real page + real functions + emulators with the REAL security rules (so an expired claim is refused by
// Firestore itself). A controllable clock lets "half an hour later" and "half a day later" happen in seconds.
// Run: bash test-ui/run.sh access.e2e.js
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

const cfgJs = `firebase.initializeApp({apiKey:'fake',projectId:'demo-leados',authDomain:'localhost',storageBucket:'demo-leados.firebasestorage.app'});
firebase.auth().useEmulator('http://127.0.0.1:9099',{disableWarnings:true});
firebase.firestore().useEmulator('127.0.0.1',8085);
firebase.app().functions('europe-west1').useEmulator('127.0.0.1',5001);
firebase.storage().useEmulator('127.0.0.1',9199);`;
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.woff2': 'font/woff2' };
const web = http.createServer((req, res) => {
  const u = req.url.split('?')[0]; let f;
  if (u === '/__/firebase/init.js') { res.setHeader('content-type', 'text/javascript'); return res.end(cfgJs); }
  const m = /^\/__\/firebase\/[\d.]+\/(.+)$/.exec(u);
  f = m ? path.join(ROOT, 'node_modules/firebase', m[1]) : path.join(ROOT, 'public', u === '/' ? 'index.html' : u);
  fs.readFile(f, (e, d) => { if (e) { res.statusCode = 404; return res.end('nf'); } res.setHeader('content-type', TYPES[path.extname(f)] || 'application/octet-stream'); res.end(d); });
}).listen(5055);

(async () => {
  initializeApp({ projectId: 'demo-leados', storageBucket: 'demo-leados.firebasestorage.app' });
  const db = getFirestore();
  await db.doc('conversations/353860000061').set({ phone: '353860000061', name: 'Anna Murphy', createdAt: Timestamp.now(), updatedAt: Timestamp.now(), lastMessage: 'Hi', unreadCount: 0 });
  const u = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true });
  const token = await getAuth().createCustomToken(u.uid);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage(); global.__page = page;
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const claimCalls = []; page.on('request', (r) => { if (r.method() === 'POST' && /\/claimAccess$/.test(r.url())) claimCalls.push(Date.now()); });
  console.log('ACCESS E2E: real page + real functions + emulators + the real security rules');

  await page.clock.install();                                                    // from here the page's clock is ours to move
  await page.goto('http://127.0.0.1:5055/');
  await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await page.waitForSelector('#app:not([hidden])');
  const claims = () => page.evaluate(async () => (await firebase.auth().currentUser.getIdTokenResult()).claims);
  const c1 = await claims();
  assert.equal(c1.staff, true); assert.ok(typeof c1.staffUntil === 'number' && c1.staffUntil > Date.now() + 11 * 3600 * 1000 && c1.staffUntil < Date.now() + 13 * 3600 * 1000, 'the claim must carry an expiry about 12 hours ahead: ' + c1.staffUntil);
  const canRead = () => page.evaluate(async () => { try { await firebase.firestore().collection('conversations').limit(1).get({ source: 'server' }); return true; } catch (e) { return String(e.code || e.message); } });
  assert.equal(await canRead(), true);
  ok('signing in gives a staff claim with an expiry about 12 hours ahead, and Firestore serves the person while it is valid');

  const before = claimCalls.length;
  await page.clock.fastForward('31:00');                                         // half an hour passes
  await page.waitForFunction(() => true); await sleep(1500);
  assert.equal(claimCalls.length, before + 1, 'the app must renew the claim after 30 minutes');
  const c2 = await claims();
  assert.ok(c2.staffUntil >= c1.staffUntil, 'the renewed claim must not be older than the first');
  assert.equal(await canRead(), true); assert.equal(await page.isVisible('#app'), true);
  ok('while the window stays open the claim is renewed every 30 minutes, and the person is never interrupted');

  // a hiccup (offline) during a renewal: nothing breaks, the next one tries again
  await page.route('**/claimAccess', (route) => route.abort('failed'));
  await page.clock.fastForward('31:00'); await sleep(1500);
  assert.equal(await page.isVisible('#app'), true, 'a failed renewal must not sign anyone out');
  await page.unroute('**/claimAccess');
  const mid = claimCalls.length;
  await page.clock.fastForward('31:00'); await sleep(1500);
  assert.equal(claimCalls.length, mid + 1); assert.equal(await page.isVisible('#app'), true);
  ok('a renewal that fails because the connection is down is retried next time and does not sign the person out');

  // the person has been removed from the list: the next renewal is refused, and they are signed out with a clear message
  await page.route('**/claimAccess', (route) => route.fulfill({ status: 403, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'This Google account is not authorised for Elite Kitchens.' } }) }));
  await page.clock.fastForward('31:00');
  await page.waitForSelector('#login:not([hidden])', { timeout: 15000 });
  assert.equal(await page.isVisible('#app'), false);
  assert.match(await page.textContent('#loginmsg'), /no longer authorised/i);
  ok('a person removed from the list is signed out at the next renewal, with a plain message');
  await page.unroute('**/claimAccess');

  // and the rules themselves: a claim that has EXPIRED is refused by Firestore, whatever the app does
  await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await page.waitForSelector('#app:not([hidden])');
  await getAuth().setCustomUserClaims(u.uid, { staff: true, staffUntil: Date.now() - 60 * 1000 });          // an expired claim, as a retained session would carry
  await page.evaluate(() => firebase.auth().currentUser.getIdToken(true));
  assert.notEqual(await canRead(), true, 'an expired staff claim must be refused by Firestore');
  await getAuth().setCustomUserClaims(u.uid, { staff: true });                                                // the OLD kind of claim: no expiry at all
  await page.evaluate(() => firebase.auth().currentUser.getIdToken(true));
  assert.notEqual(await canRead(), true, 'an old-style staff claim (no expiry) must be refused by Firestore');
  ok('Firestore itself refuses an expired claim and an old-style claim with no expiry (what a person who was removed would still be holding)');

  assert.deepEqual(errors.filter((e) => !/permission|insufficient|PERMISSION/i.test(e)), [], 'browser errors: ' + JSON.stringify(errors)); ok('no unexpected JavaScript errors');
  console.log(`ALL ${n} CHECKS PASSED`);
  await browser.close(); web.close(); process.exit(0);
})().catch(async (e) => { console.error('FAILED:', e && e.stack || e); try { await global.__page?.screenshot({ path: path.join(SHOTS, 'access-fail.png') }); } catch (_) { /* no page */ } process.exit(1); });
