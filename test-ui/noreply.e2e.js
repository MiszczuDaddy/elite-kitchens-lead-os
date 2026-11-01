'use strict';
// The Inbox "No reply" tab (replaces the Closed tab), in a REAL browser: it lists every New lead who never wrote back, oldest first, including leads older than the live list's 300 chats,
// leaves out anyone who wrote, anyone moved on, and anyone marked "do not contact", shows how long and a Call button that does not open the chat, and updates live. Every name and number is made up.
// Run: bash test-ui/run.sh noreply.e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const { getAuth } = fnRequire('firebase-admin/auth');
const ROOT = path.join(__dirname, '..'), URL0 = 'http://127.0.0.1:5058/';
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
}).listen(5058);

(async () => {
  initializeApp({ projectId: 'demo-leados' }); const db = getFirestore(), T = (ms) => Timestamp.fromMillis(ms), now = Date.now(), DAY = 86400000;
  const token = await getAuth().createCustomToken((await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true })).uid);
  const P = { oldwait: '353871120001', recent: '353871120002', nomsg: '353871120003', wrote: '353871120004', oldrecord: '353871120005', closed: '353871120006', booked: '353871120007', dnc: '353871120008', oldwrote: '353871120009' };
  const conv = (phone, name, over) => db.doc('conversations/' + phone).set({ phone, name, projectType: 'Kitchen', location: 'Swords', inboxStatus: 'inbox', unreadCount: 0, ...over });
  // 320 busy chats, all newer than the old leads: the live list (300 newest) cannot hold the old leads
  for (let i = 0; i < 320; i += 160) { const b = db.batch(); for (let j = i; j < i + 160; j++) { const p = '3538700' + String(20000 + j); b.set(db.doc('conversations/' + p), { phone: p, name: 'Busy ' + j, inboxStatus: 'booked', unreadCount: 0, lastMessage: 'ok', lastMessageDirection: 'in', lastInboundAt: T(now - 60e3 - j * 1000), createdAt: T(now - 90 * DAY), updatedAt: T(now - 60e3 - j * 1000) }); } await b.commit(); }
  const out = (over) => ({ lastMessage: 'Hi, thanks for your enquiry with Elite Kitchens', lastMessageDirection: 'out', ...over });
  await conv(P.oldwait, 'Oona Oldwait', out({ createdAt: T(now - 40 * DAY), updatedAt: T(now - 40 * DAY) }));
  await conv(P.recent, 'Rory Recent', out({ createdAt: T(now - 2 * DAY), updatedAt: T(now - 1000) }));
  await conv(P.nomsg, 'Nora Nomsg', { createdAt: T(now - 1 * DAY), updatedAt: T(now - 2000) });                       // the welcome never went
  await conv(P.wrote, 'Wendy Wrote', { createdAt: T(now - 5 * DAY), updatedAt: T(now - 3000), lastMessage: 'Yes please', lastMessageDirection: 'in', lastInboundAt: T(now - 3000), unreadCount: 1 });
  await conv(P.oldrecord, 'Olive Oldrecord', out({ createdAt: T(now - 30 * DAY), updatedAt: T(now - 30 * DAY) }));        // wrote once, but this old record never noted it
  await db.doc(`conversations/${P.oldrecord}/messages/m1`).set({ direction: 'in', type: 'text', body: 'Hello', createdAt: T(now - 29 * DAY) });
  await conv(P.oldwrote, 'Oscar Oldwrote', out({ createdAt: T(now - 35 * DAY), updatedAt: T(now - 35 * DAY), lastInboundAt: T(now - 34 * DAY) }));
  await conv(P.closed, 'Cathal Closed', out({ inboxStatus: 'closed', createdAt: T(now - 50 * DAY), updatedAt: T(now - 50 * DAY) }));
  await conv(P.booked, 'Bridie Booked', out({ inboxStatus: 'booked', createdAt: T(now - 12 * DAY), updatedAt: T(now - 12 * DAY) }));
  await conv(P.dnc, 'Declan Dnc', out({ doNotContact: { on: true }, createdAt: T(now - 20 * DAY), updatedAt: T(now - 20 * DAY) }));

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' }), errors = [];
  const open = async (viewport, phone) => {
    const ctx = await browser.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) }), page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(URL0); await page.waitForSelector('#login:not([hidden])'); await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])');
    await page.evaluate(() => { location.hash = ''; }); await page.waitForSelector('.conv'); return { ctx, page };
  };
  const names = (page) => page.$$eval('#list .conv .conv-name', (els) => els.map((e) => e.textContent));
  console.log('NO REPLY E2E: real page + real functions + emulators, in Chromium');
  let { ctx, page } = await open({ width: 1360, height: 900 });

  // ------------------------------------------------------------------ 1. the tab replaces Closed
  assert.deepEqual(await page.locator('#status-filters button').allInnerTexts(), ['All', 'New lead', 'Booked', 'Quoted', 'Won', 'No reply']);
  assert.equal(await page.evaluate(() => S.live.length), 300, 'the live list holds only the 300 newest chats'); assert.equal(await page.evaluate(() => S.live.some((c) => c.id === '353871120001')), false, 'the old lead is NOT in the live list');
  ok('the Closed tab is gone and "No reply" is the last tab');

  // ------------------------------------------------------------------ 2. who is listed
  await page.click('#status-filters button[data-status="noreply"]');
  await until(async () => /3 leads have never replied/.test(await page.innerText('#list-note')), 'the checking finishes and three leads are listed');
  assert.deepEqual(await names(page), ['Oona Oldwait', 'Rory Recent', 'Nora Nomsg'], 'oldest first; includes a lead older than the live list; leaves out who wrote (even in an old record), closed, booked, do-not-contact');
  const sub = (name) => page.locator('#list .conv', { hasText: name }).locator('.conv-sub').innerText();
  assert.match(await sub('Oona Oldwait'), /^40 days, no reply · Kitchen · Swords/); assert.match(await sub('Rory Recent'), /^2 days, no reply/);
  assert.match(await page.locator('#list .conv', { hasText: 'Nora Nomsg' }).locator('.conv-prev .t').innerText(), /No message has been sent to them yet/);
  ok('No reply lists the leads who never wrote, oldest first, including one older than the live list, with how long; not those who wrote (even in an old record), closed, booked or do-not-contact');

  // ------------------------------------------------------------------ 3. Call rings; it does not open the chat
  assert.equal(await page.locator('#list .conv .conv-call').count(), 3);
  assert.equal(await page.locator('#list .conv', { hasText: 'Oona Oldwait' }).locator('.conv-call').getAttribute('href'), 'tel:+353871120001');
  await page.evaluate(() => document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('.conv-call')) e.preventDefault(); }, true));       // the test browser has no phone app
  await page.locator('#list .conv', { hasText: 'Oona Oldwait' }).locator('.conv-call').click(); await sleep(400);
  assert.equal(await page.evaluate(() => S.selected || null), null, 'pressing Call did not open the chat');
  await page.locator('#list .conv', { hasText: 'Oona Oldwait' }).locator('.conv-name').click(); await page.waitForFunction(() => S.selected === '353871120001');
  ok('each lead has a Call button (tel: link); pressing it does not open the chat, pressing the row does');

  // ------------------------------------------------------------------ 4. live: a reply removes the lead; a search still looks through everyone
  await page.click('#status-filters button[data-status="noreply"]'); await until(async () => (await names(page)).length === 3, 'back on the tab');
  await db.doc('conversations/' + P.recent).update({ lastMessage: 'Hello, yes', lastMessageDirection: 'in', lastInboundAt: T(Date.now()), unreadCount: 1 });
  await until(async () => !(await names(page)).includes('Rory Recent'), 'a lead who writes leaves the tab by itself');
  await page.fill('#search', 'Cathal'); await until(async () => (await names(page)).includes('Cathal Closed'), 'search finds a Closed customer from this tab'); assert.equal(await page.locator('#list .conv-call').count(), 0, 'no Call buttons in search results');
  await page.fill('#search', ''); await until(async () => (await names(page)).length === 2, 'the tab again');
  ok('a lead who writes leaves the tab at once; search still looks through every stage (a Closed customer is found by name)');

  // ------------------------------------------------------------------ 5. phone
  await ctx.close(); ({ ctx, page } = await open({ width: 390, height: 780 }, true));
  await page.tap('#status-filters button[data-status="noreply"]'); await until(async () => /2 leads have never replied/.test(await page.innerText('#list-note')), 'phone: the tab');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scrolling');
  const noteTop = (await page.locator('#list-note').boundingBox()).y, pinnedBottom = (await page.locator('.list-sticky').boundingBox()); assert.ok(noteTop >= pinnedBottom.y + pinnedBottom.height - 1, 'the note is not hidden under the pinned filters and search: ' + JSON.stringify([noteTop, pinnedBottom]));
  const call = await page.locator('#list .conv-call').first().boundingBox(); assert.ok(call.height >= 40 && call.x + call.width <= 390, 'the Call button is easy to tap and inside the screen');
  await page.screenshot({ path: path.join(SHOTS, 'no-reply-phone.png') });
  ok('phone: the tab works, no sideways scrolling, the Call button is easy to tap');
  await ctx.close();

  assert.deepEqual(errors, [], 'no JavaScript errors: ' + JSON.stringify(errors)); ok('no JavaScript errors in the browser');
  console.log(`ALL ${n} CHECKS PASSED`); await browser.close(); process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
