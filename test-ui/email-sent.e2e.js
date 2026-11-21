'use strict';
// "Sent from Gmail", in a REAL browser (docs/EMAIL_INBOX.md): an email YOU wrote to a customer from Gmail is found in the Sent folder, kept in their chat ("You emailed from Gmail"), listed in the Emails tab, shown as the newest
// email in the Inbox row, and the customer's earlier email no longer looks unanswered. An email to a stranger is looked at by recipient only and never kept. Gmail is a fake with an Inbox and a Sent folder.
// Every name and address is made up. Run: bash test-ui/run.sh email-sent.e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const { getAuth } = fnRequire('firebase-admin/auth');
const ROOT = path.join(__dirname, '..'), URL0 = 'http://127.0.0.1:5073/';
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
}).listen(5073);

// ---- the fake Gmail: an Inbox and a Sent folder (list by labelIds; get one message, headers only or in full) ----
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const NOW = Date.now(), MAILBOX = 'info@test.dev', MIN = 60000;
const msg = (id, label, from, to, subject, text, at) => ({ id, threadId: 'th_' + id, labelIds: [label], internalDate: String(at), payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: from }, { name: 'To', value: to }, { name: 'Subject', value: subject }, { name: 'Message-ID', value: `<${id}@mail.example>` }],
  parts: [{ mimeType: 'text/plain', body: { size: text.length, data: b64(text) } }] } });
const mailbox = [
  msg('a1b2c3d4', 'INBOX', 'Anna Apple <anna@example.com>', MAILBOX, 'Re: Your Elite Kitchens quote EK-0112', 'Hi, the price is fine. Can you call me tomorrow after 5?', NOW - 30 * MIN),
  msg('b2c3d4e5', 'SENT', `Elite Kitchens <${MAILBOX}>`, 'Anna Apple <anna@example.com>', 'Re: Your Elite Kitchens quote EK-0112', 'Hi Anna, yes of course. I will ring you tomorrow at 5.30pm.\n\nOn Sun, 15 Nov 2026 at 11:30, Anna Apple <anna@example.com> wrote:\n> Hi, the price is fine.', NOW - 10 * MIN),
  msg('c3d4e5f6', 'SENT', `Elite Kitchens <${MAILBOX}>`, 'Supplier <sales@supplier.example>', 'Hinge order', 'PRIVATE supplier order details that must never be kept', NOW - 9 * MIN),
];
const log = { gets: [], lists: [] };
const gmail = http.createServer((req, res) => {
  req.resume(); req.on('end', () => {
    res.setHeader('content-type', 'application/json'); const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && /\/messages$/.test(u.pathname)) { const label = u.searchParams.get('labelIds'); log.lists.push(label); return res.end(JSON.stringify({ messages: mailbox.filter((m) => m.labelIds.includes(label)).map((m) => ({ id: m.id })) })); }
    const m = /\/messages\/([0-9a-f]+)$/.exec(u.pathname);
    if (req.method === 'GET' && m) { const x = mailbox.find((y) => y.id === m[1]); const full = u.searchParams.get('format') === 'full'; log.gets.push({ id: m[1], full }); return res.end(JSON.stringify(full ? x : { id: x.id, threadId: x.threadId, labelIds: x.labelIds, internalDate: x.internalDate, payload: { headers: x.payload.headers } })); }
    res.statusCode = 404; res.end('{}');
  });
}).listen(9913);

(async () => {
  initializeApp({ projectId: 'demo-leados' }); const db = getFirestore(), T = (ms) => Timestamp.fromMillis(ms), DAY = 86400000;
  const token = await getAuth().createCustomToken((await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true })).uid);
  const P = { anna: '353871210001' };
  await db.doc('contacts/' + P.anna).set({ phone: P.anna, name: 'Anna Apple', email: 'anna@example.com', createdAt: T(NOW - 10 * DAY) });
  await db.doc('conversations/' + P.anna).set({ phone: P.anna, name: 'Anna Apple', inboxStatus: 'quoted', unreadCount: 0, lastMessage: 'Hi, as discussed, your quotation', lastMessageDirection: 'out', createdAt: T(NOW - 10 * DAY), updatedAt: T(NOW - 3 * DAY) });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' }), errors = []; global.__errors = errors;
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } }), page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(URL0); await page.waitForSelector('#login:not([hidden])'); await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])');
  await page.evaluate(() => { if (location.hash === '#today') location.hash = ''; });
  console.log('SENT FROM GMAIL E2E: real page + real functions + emulators + a fake Gmail');

  // ------------------------------------------------------------------ 1. check for new email: both folders
  await page.evaluate((id) => { location.hash = '#c/' + id; }, P.anna); await page.waitForSelector('#thread:not([hidden])'); await page.waitForSelector('#email-btn', { state: 'visible' });
  await page.click('#email-btn'); await page.waitForSelector('#em-dlg[open]');
  await page.click('#em-check'); await page.waitForFunction(() => /Found 1 new email from customers and 1 you sent from Gmail\./.test(document.getElementById('em-err').textContent));
  assert.deepEqual(log.lists.sort(), ['INBOX', 'SENT'], 'the Inbox and the Sent folder were both listed');
  assert.deepEqual(log.gets.filter((g) => g.full).map((g) => g.id).sort(), ['a1b2c3d4', 'b2c3d4e5'], 'the text of the customer\'s email and of YOUR email to the customer are read; the email to the supplier is not');
  assert.ok(log.gets.some((g) => g.id === 'c3d4e5f6' && !g.full), 'the supplier email\'s recipients were looked at'); await page.click('#em-cancel');
  await page.waitForSelector('#msgs .m.em.out');
  const out = await page.locator('#msgs .m.em.out').innerText();
  assert.match(out, /You emailed from Gmail · Re: Your Elite Kitchens quote EK-0112/); assert.match(out, /I will ring you tomorrow at 5\.30pm/); assert.doesNotMatch(out, /wrote:|the price is fine/, 'the quoted history is cut off');
  assert.equal(await page.locator('#msgs .m.em.in').count(), 1); assert.equal(await page.locator('#msgs .m.em.in .em-reply').count(), 0, 'you already answered from Gmail: no "Reply by email" waiting under their email');
  assert.doesNotMatch(JSON.stringify([(await db.collection('conversations').get()).docs.map((d) => d.data()), (await db.collection('emailLog').get()).docs.map((d) => d.data())]), /PRIVATE supplier|supplier\.example|Hinge order/, 'nothing about the supplier is kept');
  await page.screenshot({ path: path.join(SHOTS, 'email-sent-thread.png') });
  ok('"Check for new email" looks in the Inbox and the Sent folder: your Gmail email to the customer appears in their chat as "You emailed from Gmail" (history cut off) and their email no longer looks unanswered; the email to a supplier is looked at by recipient only and never kept');

  // ------------------------------------------------------------------ 2. the Inbox row and "emailed"
  await page.evaluate(() => { location.hash = ''; }); await page.waitForSelector('#list'); await page.click('#status-filters button[data-status="all"]');
  const row = page.locator(`#list .conv[data-phone="${P.anna}"]`); await until(async () => /✉ You: Re: Your Elite Kitchens quote EK-0112/.test(await row.innerText()), 'the Inbox row shows your email as the newest');
  const c = (await db.doc('conversations/' + P.anna).get()).data(); assert.equal(c.lastEmailDir, 'out'); assert.equal(c.unreadCount, 1, 'only THEIR email counts as unread'); assert.ok(c.emailInboundAt, 'their email still counts as "they wrote to us"');
  ok('the Inbox row shows "✉ You: subject" (your Gmail email is the newest), and only their email counts as unread');

  // ------------------------------------------------------------------ 3. the Emails tab
  await page.click('#nav-emails'); await page.waitForSelector('#emails', { state: 'visible' }); await until(async () => (await page.$$('#emp-list .ea-open')).length === 1, 'one customer listed');
  const kinds = await page.$$eval('#emp-list .ea-open', (els) => els.map((e) => [e.querySelector('.ea-kind').textContent, e.dataset.kind, e.querySelector('.ea-count').textContent]));
  assert.deepEqual(kinds, [['↗ Sent · from Gmail', 'gmail', '2 emails']], 'ONE row for Anna with both emails; it shows the newest, yours');
  await page.click('#emails .ea-chip[data-f="out"]'); assert.equal((await page.$$('#emp-list .ea-open')).length, 1, 'Sent includes the email you wrote from Gmail'); assert.equal(await page.innerText('#emp-list .ea-count'), '1 email'); await page.click('#emails .ea-chip[data-f="followups"]'); assert.equal((await page.$$('#emp-list .ea-open')).length, 0, 'it is not a follow-up');
  await page.click('#emails .ea-chip[data-f="all"]'); await page.click('#emp-list .ea-open[data-phone="' + P.anna + '"]'); await until(async () => (await page.innerText('#emp-thread')).includes('I will ring you tomorrow at 5.30pm'), 'the whole conversation');
  const msgs = await page.$$eval('#emp-thread .emp-msg', (els) => els.map((e) => [e.dataset.kind, e.querySelector('.ea-kind').textContent, (e.querySelector('.emp-msg-meta') || {}).textContent]));
  assert.deepEqual(msgs, [['customer', '↙ Received', 'From anna@example.com'], ['gmail', '↗ Sent · from Gmail', 'To anna@example.com · sent by Gmail']], 'their email, then yours, in ONE window, oldest first');
  await page.screenshot({ path: path.join(SHOTS, 'email-sent-list.png') });
  ok('the Emails tab shows ONE row for Anna (2 emails, the newest is yours: "Sent · from Gmail", under Sent and not under Follow-ups); choosing her opens the whole conversation: her email, then yours in full, to her, sent by Gmail');

  // ------------------------------------------------------------------ 4. once
  await page.click('#nav-inbox'); await page.evaluate((id) => { location.hash = '#c/' + id; }, P.anna); await page.waitForSelector('#email-btn', { state: 'visible' }); await page.click('#email-btn'); await page.waitForSelector('#em-dlg[open]');
  await page.click('#em-check'); await page.waitForFunction(() => /No new emails to or from customers/.test(document.getElementById('em-err').textContent)); await page.click('#em-cancel');
  assert.equal((await db.collection('conversations/' + P.anna + '/emails').get()).size, 2); assert.equal((await db.collection('emailLog').get()).size, 2);
  ok('checking again finds nothing new: each email is kept and listed once');

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | ')); ok('no console or page errors');
  await browser.close(); web.close(); gmail.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e, '\nPAGE ERRORS:', global.__errors); web.close(); gmail.close(); process.exit(1); });
