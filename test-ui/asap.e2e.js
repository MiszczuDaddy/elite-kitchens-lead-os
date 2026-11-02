'use strict';
// The ⭐ "wants it as soon as possible", in a REAL browser: it shows beside the customer's name in the Inbox, in Today (a card and a "New leads today" row) and in the Pipeline, on a laptop and on a phone,
// only for customers whose conversation carries the flag (set from the lead form's answer in the Notes: functions/lib/asap.js), and it follows the flag live. Every name and number is made up.
// Run: bash test-ui/run.sh asap.e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const { getAuth } = fnRequire('firebase-admin/auth');
const ROOT = path.join(__dirname, '..'), URL0 = 'http://127.0.0.1:5064/';
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
http.createServer((req, res) => {
  const u = req.url.split('?')[0]; if (u === '/__/firebase/init.js') { res.setHeader('content-type', 'text/javascript'); return res.end(cfgJs); }
  const m = /^\/__\/firebase\/[\d.]+\/(.+)$/.exec(u), f = m ? path.join(ROOT, 'node_modules/firebase', m[1]) : path.join(ROOT, 'public', u === '/' ? 'index.html' : u);
  fs.readFile(f, (e, d) => { if (e) { res.statusCode = 404; return res.end('nf'); } res.setHeader('content-type', TYPES[path.extname(f)] || 'application/octet-stream'); res.setHeader('cache-control', 'no-store'); res.end(d); });
}).listen(5064);

(async () => {
  initializeApp({ projectId: 'demo-leados' }); const db = getFirestore(), T = (ms) => Timestamp.fromMillis(ms), now = Date.now(), DAY = 86400000;
  const token = await getAuth().createCustomToken((await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true })).uid);
  const P = { rush: '353871130001', calm: '353871130002', rushQuoted: '353871130003', rushNew: '353871130004', calmNew: '353871130005' };
  const chat = (phone, name, over) => db.doc('conversations/' + phone).set({ phone, name, projectType: 'Kitchen', location: 'Swords', inboxStatus: 'inbox', unreadCount: 1, createdAt: T(now - 30 * DAY), updatedAt: T(now - 3600e3), ...over });
  const waiting = { lastMessage: 'Can you tell me more?', lastMessageDirection: 'in', lastInboundAt: T(now - 3 * 3600e3) };
  await chat(P.rush, 'Rita Rush', { ...waiting, asap: true });
  await chat(P.calm, 'Colm Calm', waiting);
  await chat(P.rushQuoted, 'Quinn Quoted', { inboxStatus: 'quoted', lastMessage: 'Sent', lastMessageDirection: 'out', unreadCount: 0, asap: true });
  for (const [phone, name, asap, leadId] of [[P.rushNew, 'Nuala Newrush', true, 'LEADRUSH01'], [P.calmNew, 'Neil Newcalm', false, 'LEADCALM01']]) {
    await chat(phone, name, { createdAt: T(now - 120e3), updatedAt: T(now - 120e3), lastMessage: '[template: welcome]', lastMessageDirection: 'out', unreadCount: 0, receptionist: { on: true, auto: true, paused: null }, ...(asap ? { asap: true } : {}) });
    await db.doc('contacts/' + phone).set({ phone, name, createdAt: T(now - 120e3), metaLead: { leadId, receivedAt: T(now - 120e3) } });
    await db.doc('leads/' + leadId).set({ leadId, state: 'done', receivedAt: T(now - 120e3), welcome: { state: 'sent' } });
  }
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' }), errors = [];
  const open = async (viewport, phone) => {
    const ctx = await browser.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) }), page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(URL0); await page.waitForSelector('#login:not([hidden])'); await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])'); return { ctx, page };
  };
  const star = (page, sel) => page.locator(sel + ' .asap-star').count();
  console.log('ASAP STAR E2E: real page + real functions + emulators, in Chromium');

  // ------------------------------------------------------------------ 1. Inbox (laptop)
  let { ctx, page } = await open({ width: 1360, height: 900 });
  await page.evaluate(() => { location.hash = ''; }); await page.click('#status-filters button[data-status="inbox"]'); await page.waitForSelector(`.conv[data-phone="${P.rush}"]`);
  assert.equal(await star(page, `.conv[data-phone="${P.rush}"]`), 1); assert.equal(await star(page, `.conv[data-phone="${P.calm}"]`), 0, 'no star without the flag');
  assert.match(await page.locator(`.conv[data-phone="${P.rush}"] .asap-star`).getAttribute('aria-label'), /as soon as possible/i);
  assert.match(await page.locator(`.conv[data-phone="${P.rush}"]`).getAttribute('aria-label'), /wants it as soon as possible/i);
  ok('Inbox: the star is beside the name of a customer with the flag, not beside one without it');

  // ------------------------------------------------------------------ 2. Today: a card and a New leads today row
  await page.evaluate(() => { location.hash = '#today'; }); await page.waitForSelector(`.td-card[data-key="c|${P.rush}"]`);
  assert.equal(await star(page, `.td-card[data-key="c|${P.rush}"]`), 1); assert.equal(await star(page, `.td-card[data-key="c|${P.calm}"]`), 0);
  await page.waitForSelector(`.td-lead[data-phone="${P.rushNew}"]`);
  assert.equal(await star(page, `.td-lead[data-phone="${P.rushNew}"]`), 1); assert.equal(await star(page, `.td-lead[data-phone="${P.calmNew}"]`), 0);
  ok('Today: the star is on the card and on the "New leads today" row of a customer with the flag only');

  // ------------------------------------------------------------------ 3. Pipeline
  await page.evaluate(() => { location.hash = '#pipeline'; }); await page.waitForSelector(`.prow[data-phone="${P.rushQuoted}"]`);
  assert.equal(await star(page, `.prow[data-phone="${P.rushQuoted}"]`), 1); assert.equal(await star(page, `.prow[data-phone="${P.rush}"]`), 1); assert.equal(await star(page, `.prow[data-phone="${P.calm}"]`), 0);
  ok('Pipeline: the star is on the card of a customer with the flag, in any stage');

  // ------------------------------------------------------------------ 4. live: the star follows the flag
  await page.evaluate(() => { location.hash = ''; }); await page.waitForSelector(`.conv[data-phone="${P.rush}"]`);
  await db.doc('conversations/' + P.rush).update({ asap: false }); await until(async () => (await star(page, `.conv[data-phone="${P.rush}"]`)) === 0, 'the star goes when the flag goes');
  await db.doc('conversations/' + P.calm).update({ asap: true }); await until(async () => (await star(page, `.conv[data-phone="${P.calm}"]`)) === 1, 'the star appears when the flag is set');
  await db.doc('conversations/' + P.rush).update({ asap: true }); await db.doc('conversations/' + P.calm).update({ asap: false });
  await until(async () => (await star(page, `.conv[data-phone="${P.rush}"]`)) === 1 && (await star(page, `.conv[data-phone="${P.calm}"]`)) === 0, 'back to the start');
  ok('the star follows the flag live in both directions');
  await ctx.close();

  // ------------------------------------------------------------------ 5. phone: the star does not push the time off the row, and nothing scrolls sideways
  ({ ctx, page } = await open({ width: 390, height: 780 }, true));
  await page.evaluate(() => { location.hash = ''; }); await page.tap('#status-filters button[data-status="inbox"]'); await page.waitForSelector(`.conv[data-phone="${P.rush}"] .asap-star`);
  const row = await page.locator(`.conv[data-phone="${P.rush}"]`).boundingBox(), st = await page.locator(`.conv[data-phone="${P.rush}"] .asap-star`).boundingBox(), tm = await page.locator(`.conv[data-phone="${P.rush}"] .conv-time`).boundingBox();
  assert.ok(st.x >= row.x && st.x + st.width <= row.x + row.width && tm.x + tm.width <= row.x + row.width + 1 && st.x + st.width <= tm.x + 1, 'the star sits inside the row, before the time: ' + JSON.stringify({ row, st, tm }));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scrolling');
  await page.screenshot({ path: path.join(SHOTS, 'asap-star-phone.png') });
  ok('phone: the star sits inside the row before the time, and nothing scrolls sideways');
  await ctx.close();

  assert.deepEqual(errors, [], 'no JavaScript errors: ' + JSON.stringify(errors)); ok('no JavaScript errors in the browser');
  console.log(`ALL ${n} CHECKS PASSED`); await browser.close(); process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
