'use strict';
// Browser test: the Inbox "All" tab and the search across EVERY customer (docs/INBOX_ALL_AND_SEARCH.md). Real page + real functions + emulators. 340 recent chats fill the Inbox's live list of 300; the customers we look for are
// OLDER than that and closed, won or quoted, so only the directory can find them. Every name and number is made up.
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getAuth } = fnRequire('firebase-admin/auth');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const ROOT = path.join(__dirname, '..');
assert.ok(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST, 'Demo emulators required');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, msg, t = 20000) { const s = Date.now(); while (Date.now() - s < t) { try { if (await fn()) return; } catch (e) { /* not yet */ } await sleep(100); } throw new Error('timed out waiting for: ' + msg); }
let n = 0; const ok = (m) => console.log(`  PASS ${++n}. ${m}`);
const cfgJs = `firebase.initializeApp({apiKey:'fake',projectId:'demo-leados',authDomain:'localhost',storageBucket:'demo-leados.firebasestorage.app'});
firebase.auth().useEmulator('http://127.0.0.1:9099',{disableWarnings:true});
firebase.firestore().useEmulator('127.0.0.1',8085);
firebase.app().functions('europe-west1').useEmulator('127.0.0.1',5001);
firebase.storage().useEmulator('127.0.0.1',9199);`;
const web = http.createServer((req, res) => {
  const u = req.url.split('?')[0]; let f;
  if (u === '/__/firebase/init.js') { res.setHeader('content-type', 'text/javascript'); return res.end(cfgJs); }
  const m = /^\/__\/firebase\/[\d.]+\/(.+)$/.exec(u);
  f = m ? path.join(ROOT, 'node_modules/firebase', m[1]) : path.join(ROOT, 'public', u === '/' ? 'index.html' : u);
  fs.readFile(f, (e, d) => { if (e) { res.statusCode = 404; return res.end('nf'); }
    res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(f)] || 'application/octet-stream'); res.end(d); });
}).listen(5055, '127.0.0.1');

const DAY = 86400000, now = Date.now(), T = (ms) => Timestamp.fromMillis(ms);
const OLD = {
  zoe: { id: '353871110001', name: 'Zoe Oldham', stage: 'closed', town: 'Lucan', email: 'zoe.oldham@old-example.ie', days: 400, msg: 'Thanks, we decided not to go ahead.' },
  sean: { id: '353871110002', name: 'Seán Ó Briain', stage: 'won', town: 'Malahide', email: 'sean@briain.ie', days: 380, msg: 'The doors look great.' },
  pat: { id: '353871110003', name: 'Pat Quinn', stage: 'quoted', town: 'Naas', email: 'pat.quinn@example.com', days: 360, msg: 'Can you resend the quote?' },
  una: { id: '353871110004', name: 'Una Dunne', stage: 'inbox', town: 'Cork', email: 'una@example.com', days: 350, msg: 'Hi, interested in a kitchen.' },
};

(async () => {
  initializeApp({ projectId: 'demo-leados' });
  const db = getFirestore();
  // 340 recent chats (they fill the live list of 300; 220 of them are New leads), then the four old customers
  for (let i = 0; i < 340; i += 200) {
    const b = db.batch();
    for (let j = i; j < Math.min(i + 200, 340); j++) {
      const id = '35387000' + String(1000 + j);
      b.set(db.doc('conversations/' + id), { phone: id, name: 'Recent ' + j, location: 'Swords', projectType: 'Kitchen', inboxStatus: j % 3 === 0 ? 'booked' : j % 3 === 1 ? 'inbox' : 'quoted', createdAt: T(now - 5 * DAY), updatedAt: T(now - j * 60000), lastMessage: 'Hello ' + j, lastMessageDirection: 'in', unreadCount: 0 });
      b.set(db.doc('contacts/' + id), { phone: id, name: 'Recent ' + j, location: 'Swords', createdAt: T(now - 5 * DAY) });
    }
    await b.commit();
  }
  for (const o of Object.values(OLD)) {
    await db.doc('conversations/' + o.id).set({ phone: o.id, name: o.name, location: o.town, projectType: 'Kitchen', inboxStatus: o.stage, createdAt: T(now - (o.days + 20) * DAY), updatedAt: T(now - o.days * DAY), lastMessage: o.msg, lastMessageDirection: 'in', unreadCount: 0 });
    await db.doc('contacts/' + o.id).set({ phone: o.id, name: o.name, location: o.town, email: o.email, createdAt: T(now - (o.days + 20) * DAY) });
    await db.collection(`conversations/${o.id}/messages`).add({ direction: 'in', type: 'text', body: o.msg, createdAt: T(now - o.days * DAY) });
  }
  const u = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true });
  const token = await getAuth().createCustomToken(u.uid);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const rows = () => page.locator('#list .conv');
  const names = async () => (await page.locator('#list .conv .conv-name').allInnerTexts());
  const search = async (q) => { await page.fill('#search', q); await sleep(150); };
  console.log('INBOX "ALL" TAB AND SEARCH E2E: real page + real functions + emulators');
  await page.goto('http://127.0.0.1:5055/');
  await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await page.waitForSelector('#app:not([hidden])'); await page.evaluate(() => { if (location.hash === '#today') location.hash = ''; });
  await page.waitForSelector('#list .conv');

  // ------------------------------------------------------------ 1. the tabs: All is added, the others are unchanged
  assert.deepEqual(await page.locator('#status-filters button').allInnerTexts(), ['All', 'New lead', 'Booked', 'Quoted', 'Won', 'Closed']);
  assert.equal(await page.getAttribute('#status-filters button[data-status="inbox"]', 'aria-pressed'), 'true', 'the Inbox still opens on New lead');
  const liveInbox = await page.evaluate(() => S.live.filter((c) => inboxStatus(c) === 'inbox').length);
  assert.equal(await rows().count(), liveInbox, 'New lead shows exactly the live New leads, as before');
  assert.equal(await page.evaluate(() => S.live.length), 300, 'the live list is still the 300 newest');
  await page.click('#status-filters button[data-status="closed"]'); assert.equal(await rows().count(), await page.evaluate(() => S.live.filter((c) => inboxStatus(c) === 'closed').length));
  await page.click('#status-filters button[data-status="inbox"]');
  assert.equal(await page.locator('#list .conv', { hasText: 'Zoe Oldham' }).count(), 0, 'the old closed customer is not among the live 300');
  ok('"All" is added as the first tab; New lead is still the default and every stage tab still shows exactly its live conversations');

  // ------------------------------------------------------------ 2. the All tab lists everyone, 100 at a time
  await page.click('#status-filters button[data-status="all"]');
  await until(async () => /344 customers/.test(await page.textContent('#list-note')), 'every customer counted (' + (await page.textContent('#list-note')) + ')');
  assert.equal(await rows().count(), 100); assert.match(await page.textContent('.list-more'), /Show 100 more \(244 left\)/);
  await page.click('.list-more'); assert.equal(await rows().count(), 200);
  await page.click('.list-more'); await page.click('.list-more'); assert.equal(await rows().count(), 344, 'everyone, of every stage'); assert.equal(await page.locator('.list-more').count(), 0);
  const all = await names(); assert.ok(all.includes('Zoe Oldham') && all.includes('Seán Ó Briain') && all.includes('Pat Quinn') && all.includes('Una Dunne'), 'the old customers of every stage are there');
  assert.equal(all[all.length - 1], 'Zoe Oldham', 'newest first: the oldest is last');
  assert.match(await page.locator('#list .conv', { hasText: 'Zoe Oldham' }).locator('.conv-sub').innerText(), /^Closed/, 'each row says its stage');
  await page.screenshot({ path: path.join(SHOTS, 'inbox-all-tab.png') });
  ok('the All tab lists every customer of every stage (344, the old ones too), newest first, 100 at a time with "Show more", each row saying its stage');

  // ------------------------------------------------------------ 3. one search bar: name, phone, email, town; old and closed included
  await page.click('#status-filters button[data-status="inbox"]');
  await search('zoe'); await until(async () => (await names()).includes('Zoe Oldham'), 'Zoe found by name from the New lead tab');
  assert.deepEqual(await names(), ['Zoe Oldham']);
  assert.match(await page.locator('#list .conv').first().locator('.conv-sub').innerText(), /^Closed/);
  await search('sean'); assert.deepEqual(await names(), ['Seán Ó Briain'], 'accents do not matter');
  await search('briain.ie'); assert.deepEqual(await names(), ['Seán Ó Briain'], 'found by email (the email is on the contact, not on the chat)');
  await search('OLD-EXAMPLE'); assert.deepEqual(await names(), ['Zoe Oldham'], 'capitals do not matter, part of an email is enough');
  await search('087 111 0003'); assert.deepEqual(await names(), ['Pat Quinn'], 'a phone number with spaces and the leading 0');
  await search('+353 87 111 0004'); assert.deepEqual(await names(), ['Una Dunne']);
  await search('353871110002'); assert.deepEqual(await names(), ['Seán Ó Briain']);
  await search('cork'); assert.deepEqual(await names(), ['Una Dunne'], 'by town');
  await search('pat naas'); assert.deepEqual(await names(), ['Pat Quinn'], 'every word must match');
  await search('pat cork'); assert.deepEqual(await names(), []); assert.match(await page.textContent('#list-empty'), /No conversations match your search/);
  await search('recent 7'); assert.ok((await names()).includes('Recent 7') && (await names()).includes('Recent 70'), 'the recent chats are searched too');
  await search(''); assert.equal(await rows().count(), liveInbox, 'clearing the search brings back the stage tab');
  ok('one search bar finds old, closed and won customers by name, phone (any way of typing it), email and town, from any tab; every word must match');

  // ------------------------------------------------------------ 4. an old customer opens as a complete chat
  await search('zoe'); await rows().first().click();
  await page.waitForSelector('#thread:not([hidden])');
  assert.equal(await page.textContent('#t-name'), 'Zoe Oldham'); assert.match(await page.textContent('#t-phone'), /\+353 87 111 0001 · Lucan/);
  await until(async () => /decided not to go ahead/.test(await page.textContent('#msgs')), 'the old messages load');
  assert.equal(await page.inputValue('#conversation-status'), 'closed', 'the stage is shown');
  assert.equal(await page.evaluate(() => S.convs.some((c) => c.id === '353871110001')), true, 'the whole screen can see this customer');
  assert.equal(await page.isDisabled('#text'), true, 'the 24-hour window of a 400-day-old chat is closed, so the message box is off, exactly as for any old chat (Reopen is offered)');
  assert.equal(await page.evaluate(() => document.getElementById('profile-name').textContent), 'Zoe Oldham');
  await page.click('#status-filters button[data-status="all"]');
  assert.ok((await names()).includes('Zoe Oldham'), 'and she stays in the list while open');
  await page.screenshot({ path: path.join(SHOTS, 'inbox-old-customer.png') });
  ok('an old customer found by search opens as a complete chat: name, phone, town, stage, old messages and the message box (not a half-empty header)');

  // ------------------------------------------------------------ 5. leaving them tidies up; live changes still arrive
  await search(''); await page.click('#status-filters button[data-status="inbox"]'); await page.locator('#list .conv').first().click();
  await until(async () => (await page.evaluate(() => S.convs.length)) === 300, 'the old customer left the live list again');
  await db.doc('conversations/353871110003').update({ location: 'Newbridge' });
  await search('pat'); await page.locator('#list .conv', { hasText: 'Pat Quinn' }).click();
  await until(async () => /Newbridge/.test(await page.textContent('#t-phone')), 'a change to the open old customer arrives live (' + (await page.textContent('#t-phone')) + ')');
  ok('an old customer is only watched while open; changes to them still arrive live; the live list goes back to the 300 newest');

  // ------------------------------------------------------------ 6. phone
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await mctx.newPage(); mp.on('pageerror', (e) => errors.push(e.message));
  await mp.goto('http://127.0.0.1:5055/'); await mp.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await mp.waitForSelector('#app:not([hidden])'); await mp.evaluate(() => { if (location.hash === '#today') location.hash = ''; }); await mp.waitForSelector('#list .conv');
  const m = await mp.evaluate(() => { const r = (e) => e.getBoundingClientRect(), tabs = [...document.querySelectorAll('#status-filters button')]; return { tabs: tabs.length, fits: tabs.every((b) => r(b).right <= innerWidth + 1 && r(b).left >= -1), widths: tabs.map((b) => b.textContent.trim() + ':' + Math.round(r(b).width)).join(' '), clipped: tabs.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent.trim()), scrollOk: document.documentElement.scrollWidth <= innerWidth + 1 }; });
  assert.equal(m.tabs, 6); assert.equal(m.fits, true, 'six tabs fit on a phone, in two rows of three'); assert.equal(m.scrollOk, true); assert.deepEqual(m.clipped, [], 'no tab label is cut off: ' + m.widths);
  await mp.click('#status-filters button[data-status="all"]'); await until(async () => /344 customers/.test(await mp.textContent('#list-note')), 'phone: all customers');
  await mp.fill('#search', 'zoe'); await until(async () => (await mp.locator('#list .conv .conv-name').allInnerTexts()).includes('Zoe Oldham'), 'phone: search finds the old customer');
  assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await mp.screenshot({ path: path.join(SHOTS, 'inbox-all-phone.png') });
  ok('on a phone the six tabs fit, the All tab and the search work, and nothing scrolls sideways');

  assert.deepEqual(errors, [], 'no browser errors: ' + errors.join(' | '));
  await browser.close(); web.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.stack || e.message || e); process.exit(1); });
