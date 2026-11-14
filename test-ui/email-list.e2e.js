'use strict';
// The Emails window, in a REAL browser (docs/EMAIL_LIST.md): the Emails button (left rail, or the section buttons on a phone) opens one list of every email in and out, newest first, with who, when, what kind, the subject and a short preview; "Received" and
// "Sent" filter it; an email we could not confirm says so; a new email appears while the window is open; tapping a row opens that customer's chat; customers' names are shown as text, never as code; and it fits a phone.
// The entries are written the way the server writes them (the server paths are tested in functions/test/email-list.test.js). Every name and address is made up. Run: bash test-ui/run.sh email-list.e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const { getAuth } = fnRequire('firebase-admin/auth');
const ROOT = path.join(__dirname, '..'), URL0 = 'http://127.0.0.1:5072/';
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
}).listen(5072);

(async () => {
  initializeApp({ projectId: 'demo-leados' }); const db = getFirestore(), T = (ms) => Timestamp.fromMillis(ms), NOW = Date.now(), MIN = 60000, DAY = 86400000;
  const token = await getAuth().createCustomToken((await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true })).uid);
  const P = { anna: '353871200001', bob: '353871200002', cara: '353871200003' };
  const customer = async (phone, name) => {
    await db.doc('contacts/' + phone).set({ phone, name, email: phone + '@example.com', createdAt: T(NOW - 10 * DAY) });
    await db.doc('conversations/' + phone).set({ phone, name, inboxStatus: 'quoted', unreadCount: 0, lastMessage: 'Hi, as discussed, your quotation', lastMessageDirection: 'out', createdAt: T(NOW - 10 * DAY), updatedAt: T(NOW - 3 * DAY) });
  };
  await customer(P.anna, 'Anna Apple'); await customer(P.bob, 'Bob Byrne'); await customer(P.cara, '"><script>window.__pwned=1</script>Cara <b>Cole</b>');
  const entry = (id, phone, name, direction, kind, subject, snippet, atMs, extra = {}) => db.doc('emailLog/' + id).set({ phone, name, direction, kind, subject, snippet, email: phone + '@example.com', at: T(atMs), confirmed: true, ...extra });
  await entry('g_1', P.anna, 'Anna Apple', 'in', 'customer', 'Re: Your Elite Kitchens quote EK-0112', 'Hi, the price is fine. Can you call me tomorrow after 5?', NOW - 20 * MIN);
  await entry(P.bob + '_fu_1', P.bob, 'Bob Byrne', 'out', 'followup', 'Your kitchen enquiry with Elite Kitchens', 'Hi Bob, Thanks for your enquiry with Elite Kitchens. I just wanted to check in', NOW - 3 * DAY, { by: 'staff@test.dev' });
  await entry(P.anna + '_qf_1', P.anna, 'Anna Apple', 'out', 'quotefollowup', 'Your Elite Kitchens quote EK-0112', 'Hi Anna, I just wanted to check that you received your quote (EK-0112)', NOW - 2 * DAY, { quoteRef: 'EK-0112' });
  await entry('qd_1', P.bob, 'Bob Byrne', 'out', 'quote', 'Elite Kitchens — Kitchen Quote EK-0118 v1', 'Dear Bob, Please find attached your quotation', NOW - 5 * DAY, { quoteRef: 'EK-0118', confirmed: false });
  await entry('g_2', P.cara, '"><script>window.__pwned=1</script>Cara <b>Cole</b>', 'in', 'customer', '<img src=x onerror=window.__pwned=1>', 'Thanks <script>window.__pwned=1</script>', NOW - 40 * MIN);
  await entry(P.anna + '_reply_1', P.anna, 'Anna Apple', 'out', 'reply', 'Re: Your Elite Kitchens quote EK-0112', 'Of course, I will ring you tomorrow at 5.', NOW - 10 * MIN, { by: 'staff@test.dev' });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' }), errors = []; global.__errors = errors;
  const open = async (viewport, phone) => {
    const ctx = await browser.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) }), page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(URL0); await page.waitForSelector('#login:not([hidden])'); await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])');
    await page.evaluate(() => { if (location.hash === '#today') location.hash = ''; }); return { ctx, page };
  };
  console.log('EMAIL LIST E2E: real page + real functions + emulators');
  const { page } = await open({ width: 1360, height: 900 });
  const rows = () => page.$$eval('#ea-list .ea-open', (els) => els.map((e) => ({ name: e.querySelector('.ea-name').textContent, kind: e.querySelector('.ea-kind').textContent, subject: e.querySelector('.ea-subject').textContent, snip: e.querySelector('.ea-snip').textContent, warn: !!e.querySelector('.ea-warn'), ref: (e.querySelector('.ea-ref') || {}).textContent || null, id: e.dataset.kind })));

  // ------------------------------------------------------------------ 1. open: everything, newest first
  assert.equal(await page.locator('#emails-rail').isVisible(), true, 'Emails is in the left rail'); assert.equal(await page.locator('.pane-head .icon-btn').count(), 1, 'the Inbox header still has only the + button');
  await page.click('#emails-rail'); await page.waitForSelector('#ea-dlg[open]'); await until(async () => (await rows()).length === 6, 'six emails');
  const all = await rows();
  assert.deepEqual(all.map((r) => r.id), ['reply', 'customer', 'customer', 'quotefollowup', 'followup', 'quote'], 'newest first: your reply (10 min ago), Anna (20 min), Cara (40 min), then the older follow-ups and the quote email');
  assert.deepEqual(all.map((r) => r.kind), ['↗ Sent · your reply', '↙ Received', '↙ Received', '↗ Sent · quote follow-up', '↗ Sent · follow-up', '↗ Sent · quote']);
  assert.equal(all[0].name, 'Anna Apple'); assert.equal(all[0].snip, 'Of course, I will ring you tomorrow at 5.'); assert.equal(all[1].subject, 'Re: Your Elite Kitchens quote EK-0112');
  assert.equal(all[3].ref, 'EK-0112'); assert.equal((await page.innerText('#ea-list .ea-open:nth-child(1) .ea-when')).length > 0, true);
  ok('Emails in the rail opens one list of every email, newest first: your reply, what customers sent, the follow-ups and the quote email, each with who, what kind, the subject and a short preview');

  // ------------------------------------------------------------------ 2. not confirmed; filters
  assert.deepEqual(all.map((r) => r.warn), [false, false, false, false, false, true], 'only the quote email Google did not confirm carries the warning');
  assert.match(await page.locator('#ea-list .ea-warn').getAttribute('title'), /Google did not confirm/);
  await page.click('#ea-dlg .ea-chip[data-f="in"]'); assert.deepEqual((await rows()).map((r) => r.id), ['customer', 'customer']); assert.equal(await page.getAttribute('#ea-dlg .ea-chip[data-f="in"]', 'aria-pressed'), 'true');
  await page.click('#ea-dlg .ea-chip[data-f="out"]'); assert.deepEqual((await rows()).map((r) => r.id), ['reply', 'quotefollowup', 'followup', 'quote']);
  await page.click('#ea-dlg .ea-chip[data-f="all"]'); assert.equal((await rows()).length, 6);
  ok('an email Google did not confirm says "Not confirmed"; Received shows only what customers sent, Sent only what went out, All everything');

  // ------------------------------------------------------------------ 3. names and subjects are text, never code
  const cara = all[2]; assert.ok(cara.name.includes('<script>') && cara.subject.startsWith('<img src=x'), 'shown literally: ' + JSON.stringify([cara.name, cara.subject]));
  assert.equal(await page.evaluate(() => window.__pwned || 0), 0, 'nothing ran'); assert.equal(await page.locator('#ea-list script, #ea-list img, #ea-list b').count(), 0, 'no element was created from a name or subject');
  ok('a customer name or subject with code in it is shown as text: nothing runs, no element is created from it');

  // ------------------------------------------------------------------ 4. live: a new email appears while the window is open
  await entry('g_3', P.bob, 'Bob Byrne', 'in', 'customer', 'Re: Your kitchen enquiry', 'Yes, I would love a consultation. Thursday works.', Date.now());
  await until(async () => (await rows()).length === 7, 'the new email appears'); assert.deepEqual((await rows())[0].snip, 'Yes, I would love a consultation. Thursday works.');
  ok('a new email appears at the top while the window is open, without reloading');

  // ------------------------------------------------------------------ 5. tapping a row opens that customer's chat
  await page.click('#ea-list .ea-open[data-phone="' + P.anna + '"]'); await page.waitForSelector('#ea-dlg:not([open])', { state: 'attached' }); await page.waitForSelector('#thread:not([hidden])');
  await until(async () => (await page.evaluate(() => location.hash)).includes(P.anna), 'the chat of Anna is open'); assert.match(await page.innerText('#t-name'), /Anna Apple/);
  ok('tapping a row closes the window and opens that customer\'s chat');

  // ------------------------------------------------------------------ 6. empty state, and a phone
  await db.collection('emailLog').get().then((s) => Promise.all(s.docs.map((d) => d.ref.delete())));
  await page.click('#emails-rail'); await page.waitForSelector('#ea-dlg[open]'); await until(async () => /No emails yet/.test(await page.innerText('#ea-note')), 'the empty message'); await page.click('#ea-close');
  await entry('g_9', P.anna, 'Anna Apple', 'in', 'customer', 'Re: Your quote with a quite long subject that has to wrap properly on a small screen', 'A long preview '.repeat(30), Date.now());
  await entry('g_10', P.bob, 'Bob Byrne', 'out', 'followup', 'Your kitchen enquiry with Elite Kitchens', 'Hi Bob, Thanks for your enquiry with Elite Kitchens. I just wanted to check in', Date.now() - 3 * DAY);
  await entry('g_11', P.anna, 'Anna Apple', 'out', 'quotefollowup', 'Your Elite Kitchens quote EK-0112', 'Hi Anna, I just wanted to check that you received your quote (EK-0112)', Date.now() - 2 * DAY, { quoteRef: 'EK-0112' });
  await entry('g_12', P.bob, 'Bob Byrne', 'out', 'quote', 'Elite Kitchens \u2014 Kitchen Quote EK-0118 v1', 'Dear Bob, Please find attached your quotation', Date.now() - 5 * DAY, { quoteRef: 'EK-0118', confirmed: false });
  const m = await open({ width: 375, height: 812 }, true);
  await m.page.click('#to-emails'); await m.page.waitForSelector('#ea-dlg[open]'); await m.page.waitForSelector('#ea-list .ea-open');
  const box = await m.page.locator('#ea-dlg').boundingBox(), row = await m.page.locator('#ea-list .ea-open').first().boundingBox(), eb = await m.page.locator('#to-emails').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 376 && row.height >= 44 && row.x + row.width <= 376, 'the window and its rows fit a 375px phone: ' + JSON.stringify([box, row]));
  assert.equal(await m.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scrolling'); await m.page.screenshot({ path: path.join(SHOTS, 'email-list-phone.png') });
  await m.page.click('#ea-close'); assert.ok(eb && eb.width >= 56 && eb.height >= 56 && eb.x >= 0 && eb.x + eb.width <= 375, 'the Emails button is on screen and big enough to tap');
  ok('empty: a plain message; on a 375px phone the window and its rows fit, with no sideways scrolling and a button big enough to tap');

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | ')); ok('no console or page errors');
  await browser.close(); web.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e, '\nPAGE ERRORS:', global.__errors); web.close(); process.exit(1); });
