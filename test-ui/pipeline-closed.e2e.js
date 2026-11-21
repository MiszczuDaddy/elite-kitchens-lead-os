'use strict';
// The Pipeline has no Closed column or tab (10 Nov 2026): a Closed lead is off the board. Closed is still in every card's Move menu (that is how a dead lead is cleared), a closed customer is still found in
// Inbox > All and by searching, and on a phone the stage tabs are New lead / Booked / Quoted / Won. Real page + real functions + emulators. Every name and number is made up. Run: bash test-ui/run.sh pipeline-closed.e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const { getAuth } = fnRequire('firebase-admin/auth');
const ROOT = path.join(__dirname, '..'), URL0 = 'http://127.0.0.1:5069/';
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
}).listen(5069);

(async () => {
  initializeApp({ projectId: 'demo-leados' }); const db = getFirestore(), T = (ms) => Timestamp.fromMillis(ms), now = Date.now(), DAY = 86400000;
  const token = await getAuth().createCustomToken((await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true })).uid);
  const P = { fresh: '353871180001', quoted: '353871180002', gone: '353871180003', dead: '353871180004' };
  const seed = async (phone, name, inboxStatus, extra = {}) => {
    await db.doc('contacts/' + phone).set({ phone, name, location: 'Swords', projectType: 'Kitchen', createdAt: T(now - 20 * DAY) });
    await db.doc('conversations/' + phone).set({ phone, name, projectType: 'Kitchen', location: 'Swords', inboxStatus, unreadCount: 0, lastMessage: 'Hi', lastMessageDirection: 'out', createdAt: T(now - 20 * DAY), updatedAt: T(now - DAY), ...extra });
  };
  await seed(P.fresh, 'Fiona Fresh', 'inbox'); await seed(P.quoted, 'Quinn Quoted', 'quoted', { stageDates: { quoted: T(now - 8 * DAY) } });
  await seed(P.gone, 'Gerry Gone', 'quoted', { stageDates: { quoted: T(now - 9 * DAY) } }); await seed(P.dead, 'Dara Dead', 'closed', { stageDates: { quoted: T(now - 15 * DAY), closed: T(now - 5 * DAY) } });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' }), errors = []; global.__errors = errors;
  const open = async (viewport, phone) => {
    const ctx = await browser.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) }), page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(URL0); await page.waitForSelector('#login:not([hidden])'); await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])');
    await page.evaluate(() => { location.hash = '#pipeline'; }); await page.waitForSelector('.prow'); return { ctx, page };
  };
  console.log('PIPELINE WITHOUT A CLOSED COLUMN E2E: real page + real functions + emulators, in Chromium');

  // ------------------------------------------------------------------ 1. laptop: four columns, no Closed, the closed customer is off the board
  let { ctx, page } = await open({ width: 1360, height: 900 });
  assert.deepEqual(await page.$$eval('.lane', (ls) => ls.map((l) => l.dataset.stage)), ['inbox', 'booked', 'quoted', 'won'], 'four columns');
  assert.equal(await page.locator('.prow[data-phone="' + P.dead + '"]').count(), 0, 'the Closed customer is not on the board'); assert.equal(await page.locator('.prow').count(), 3);
  assert.doesNotMatch(await page.locator('#pipe-board').innerText(), /Closed/);
  ok('the board has New lead, Booked, Quoted and Won; there is no Closed column and a Closed customer is not on it');

  // ------------------------------------------------------------------ 2. Closed is still in the Move menu: it takes the card off the board, and the move is saved
  const card = page.locator('.prow[data-phone="' + P.gone + '"]'); await card.hover(); await card.locator('.prow-menu').click();
  const items = await page.$$eval('.move-menu button', (bs) => bs.map((b) => b.textContent.replace('✓', '').trim())); assert.deepEqual(items, ['New lead', 'Booked', 'Quoted', 'Won', 'Closed']);
  assert.match(await page.locator('.move-menu button[data-stage="closed"]').getAttribute('title'), /off the board[\s\S]*Inbox > All/);
  await page.click('.move-menu button[data-stage="closed"]');
  await until(async () => (await page.locator('.prow[data-phone="' + P.gone + '"]').count()) === 0, 'the card leaves the board');
  await until(async () => ((await db.doc('conversations/' + P.gone).get()).data().inboxStatus === 'closed'), 'the move is saved'); const c = (await db.doc('conversations/' + P.gone).get()).data(); assert.ok(c.stageDates.closed, 'the Closed date is stamped as before');
  ok('Closed is still in each card\'s Move menu (with a hint); choosing it saves the move, stamps the date and takes the card off the board');

  // ------------------------------------------------------------------ 3. closed customers are still found in Inbox > All and by searching
  await page.evaluate(() => { location.hash = ''; }); await page.waitForSelector('#list');
  await page.click('#status-filters button[data-status="all"]'); await page.fill('#search', 'Dara Dead');
  await page.waitForSelector('#list .conv[data-phone="' + P.dead + '"]'); assert.match(await page.locator('#list .conv[data-phone="' + P.dead + '"]').innerText(), /Dara Dead/);
  ok('a closed customer is still found in Inbox > All by searching');
  await ctx.close();

  // ------------------------------------------------------------------ 4. phone: four stage tabs
  ({ ctx, page } = await open({ width: 375, height: 812 }, true));
  assert.deepEqual(await page.$$eval('#pipe-stages button', (bs) => bs.map((b) => b.dataset.stage)), ['inbox', 'booked', 'quoted', 'won'], 'four tabs');
  assert.doesNotMatch(await page.locator('#pipe-stages').innerText(), /Closed/); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scrolling');
  await page.screenshot({ path: path.join(SHOTS, 'pipeline-no-closed-phone.png') });
  ok('on a 375px phone the stage tabs are New lead / Booked / Quoted / Won, with no Closed tab');

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | ')); ok('no console or page errors');
  await browser.close(); web.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e, '\nPAGE ERRORS:', global.__errors); web.close(); process.exit(1); });
