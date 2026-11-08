'use strict';
// "Best time to contact" on the Pipeline's New lead cards, in a REAL browser: a New lead who picked a time on the lead form shows it on their card ("Best time: Morning (9am-12pm)"); a lead who did not, and a customer
// who is already booked or quoted, show nothing; it follows the conversation live; on a laptop and on a phone. Every name and number is made up. Run: bash test-ui/run.sh contact-time.e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const { getAuth } = fnRequire('firebase-admin/auth');
const ROOT = path.join(__dirname, '..'), URL0 = 'http://127.0.0.1:5068/';
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, msg, t = 20000) { const s = Date.now(); while (Date.now() - s < t) { try { if (await fn()) return; } catch (e) { /* not yet */ } await sleep(120); } throw new Error('timed out waiting for: ' + msg); }
let n = 0; const ok = (m) => console.log(`  PASS ${++n}. ${m}`);
const cfgJs = `firebase.initializeApp({apiKey:'fake',projectId:'demo-leados',authDomain:'localhost',storageBucket:'demo-leados.firebasestorage.app'});
firebase.auth().useEmulator('http://127.0.0.1:9099',{disableWarnings:true});
firebase.firestore().useEmulator('127.0.0.1',8085);
firebase.app().functions('europe-west1').useEmulator('127.0.0.1',5001);
firebase.storage().useEmulator('127.0.0.1',9199);`;
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const web = http.createServer((req, res) => {
  const u = req.url.split('?')[0]; if (u === '/__/firebase/init.js') { res.setHeader('content-type', 'text/javascript'); return res.end(cfgJs); }
  const m = /^\/__\/firebase\/[\d.]+\/(.+)$/.exec(u), f = m ? path.join(ROOT, 'node_modules/firebase', m[1]) : path.join(ROOT, 'public', u === '/' ? 'index.html' : u);
  fs.readFile(f, (e, d) => { if (e) { res.statusCode = 404; return res.end('nf'); } res.setHeader('content-type', TYPES[path.extname(f)] || 'application/octet-stream'); res.setHeader('cache-control', 'no-store'); res.end(d); });
}).listen(5068);

(async () => {
  initializeApp({ projectId: 'demo-leados' }); const db = getFirestore(), T = (ms) => Timestamp.fromMillis(ms), now = Date.now(), DAY = 86400000;
  const token = await getAuth().createCustomToken((await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true })).uid);
  const P = { morning: '353871170001', none: '353871170002', booked: '353871170003', long: '353871170004' };
  const chat = async (phone, name, over) => {
    await db.doc('contacts/' + phone).set({ phone, name, location: 'Swords', projectType: 'Kitchen', createdAt: T(now - 2 * DAY) });
    await db.doc('conversations/' + phone).set({ phone, name, projectType: 'Kitchen', location: 'Swords', inboxStatus: 'inbox', unreadCount: 0, lastMessage: '[template: welcome]', lastMessageDirection: 'out', createdAt: T(now - 2 * DAY), updatedAt: T(now - 3600e3), ...over });
  };
  await chat(P.morning, 'Maura Morning', { contactTime: 'Morning (9am-12pm)' });
  await chat(P.none, 'Nuala Nothing', {});
  await chat(P.booked, 'Bobby Booked', { inboxStatus: 'booked', stageDates: { booked: T(now - DAY) }, contactTime: 'Evening after 5pm' });
  await chat(P.long, 'Lena Longanswer', { contactTime: 'Any time, but please not on Sundays or on bank holidays when I am away with the family' });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' }), errors = []; global.__errors = errors;
  const open = async (viewport, phone) => {
    const ctx = await browser.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) }), page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(URL0); await page.waitForSelector('#login:not([hidden])'); await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])');
    await page.evaluate(() => { location.hash = '#pipeline'; }); await page.waitForSelector('.prow'); return { ctx, page };
  };
  const timeOf = (page, p) => page.locator(`.prow[data-phone="${p}"] .prow-time`);
  console.log('CONTACT TIME E2E: real page + real functions + emulators, in Chromium');

  // ------------------------------------------------------------------ 1. laptop
  let { ctx, page } = await open({ width: 1360, height: 900 });
  await until(async () => (await timeOf(page, P.morning).count()) === 1, 'the time appears on the New lead card');
  assert.equal((await timeOf(page, P.morning).innerText()).trim(), 'Best time: Morning (9am-12pm)');
  assert.equal(await timeOf(page, P.none).count(), 0, 'a lead who did not pick a time shows nothing'); assert.equal(await timeOf(page, P.booked).count(), 0, 'a booked customer shows nothing: the time no longer matters');
  assert.match(await page.locator(`.prow[data-phone="${P.long}"] .prow-time`).innerText(), /not on Sundays or on bank holidays when I am away with the family/, 'a long answer is not cut off');
  await page.screenshot({ path: path.join(SHOTS, 'contact-time-laptop.png') });
  ok('the New lead card shows "Best time: …" for a lead who picked one; nothing for a lead who did not, nor for a booked customer; a long answer is not cut off');

  // ------------------------------------------------------------------ 2. it follows the conversation live
  await db.doc('conversations/' + P.none).update({ contactTime: 'Afternoon' });
  await until(async () => (await timeOf(page, P.none).count()) === 1, 'a new answer appears by itself'); assert.equal((await timeOf(page, P.none).innerText()).trim(), 'Best time: Afternoon');
  await db.doc('conversations/' + P.morning).update({ contactTime: null }); await until(async () => (await timeOf(page, P.morning).count()) === 0, 'and goes when the answer is removed');
  await db.doc('conversations/' + P.booked).update({ inboxStatus: 'inbox' }); await until(async () => (await timeOf(page, P.booked).count()) === 1, 'a customer moved back to New lead shows it again');
  ok('it follows the conversation live: it appears, changes and goes by itself');
  await ctx.close();

  // ------------------------------------------------------------------ 3. phone
  ({ ctx, page } = await open({ width: 375, height: 812 }, true));
  await until(async () => (await timeOf(page, P.none).count()) === 1, 'the time shows on the phone');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scrolling on the phone');
  const box = await timeOf(page, P.none).boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= 375, 'the line fits inside the screen: ' + JSON.stringify(box));
  await page.screenshot({ path: path.join(SHOTS, 'contact-time-phone.png') });
  ok('on a 375px phone the line fits and the page does not scroll sideways');

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | ')); ok('no console or page errors');
  await browser.close(); web.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e, '\nPAGE ERRORS:', global.__errors); web.close(); process.exit(1); });
