'use strict';
// The email inbox, in a REAL browser (docs/EMAIL_INBOX.md): a customer's reply to a quote email comes into their chat (with the quoted history cut off and a link to Gmail for the attachment), the Inbox row shows it as unread,
// a lead who replied by email leaves the No reply tab, a stranger's email is never kept, and "Email" answers in the same Gmail conversation. Gmail is a fake that serves a small mailbox and records what is read and sent.
// Every name and address is made up. Run: bash test-ui/run.sh email-inbox.e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const { getAuth } = fnRequire('firebase-admin/auth');
const ROOT = path.join(__dirname, '..'), URL0 = 'http://127.0.0.1:5070/';
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
}).listen(5070);

// ---- the fake Gmail: a mailbox to read (list + get) and a send that records what was sent ----
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const NOW = Date.now(), MAILBOX = 'info@test.dev';
const msg = (id, from, subject, text, extra = {}) => ({ id, threadId: 'th_' + id, labelIds: ['INBOX'], internalDate: String(NOW - 600e3), payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: from }, { name: 'To', value: MAILBOX }, { name: 'Subject', value: subject }, { name: 'Message-ID', value: `<${id}@mail.example>` }],
  parts: [{ mimeType: 'text/plain', body: { size: text.length, data: b64(text) } }, ...(extra.files || []).map((f) => ({ mimeType: 'application/pdf', filename: f, body: { size: 999, attachmentId: 'a' } }))] } });
const mailbox = [
  msg('a1b2c3d4', 'Anna Apple <anna@example.com>', 'Re: Your Elite Kitchens quote EK-0112', 'Hi, the price is fine. Can you call me tomorrow after 5?\n\nOn Mon, 9 Nov 2026 at 10:00, Elite Kitchens <info@test.dev> wrote:\n> Hi Anna, just checking you received your quote.', { files: ['our-kitchen-wall.pdf'] }),
  msg('b2c3d4e5', 'Bob Byrne <bob@example.com>', 'Re: Your kitchen enquiry', 'Yes, I would love a consultation. Thursday works.'),
  msg('c3d4e5f6', 'Supplier <sales@supplier.example>', 'Hinge prices', 'SECRET supplier prices that must never be kept'),
];
const log = { lists: 0, gets: [], sent: [] };
const gmail = http.createServer((req, res) => {
  const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => {
    res.setHeader('content-type', 'application/json'); const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && /\/messages\/send$/.test(u.pathname)) { const j = JSON.parse(Buffer.concat(c).toString()); log.sent.push({ raw: Buffer.from(j.raw, 'base64url').toString('utf8'), threadId: j.threadId || null }); return res.end(JSON.stringify({ id: 'e5f6a7b8' + log.sent.length, threadId: j.threadId || 'newthread' })); }
    if (req.method === 'GET' && /\/messages$/.test(u.pathname)) { log.lists++; return res.end(JSON.stringify({ messages: mailbox.map((m) => ({ id: m.id })) })); }
    const m = /\/messages\/([0-9a-f]+)$/.exec(u.pathname);
    if (req.method === 'GET' && m) { const x = mailbox.find((y) => y.id === m[1]); const full = u.searchParams.get('format') === 'full'; log.gets.push({ id: m[1], full }); return res.end(JSON.stringify(full ? x : { id: x.id, threadId: x.threadId, labelIds: x.labelIds, internalDate: x.internalDate, payload: { headers: x.payload.headers } })); }
    res.statusCode = 404; res.end('{}');
  });
}).listen(9913);

(async () => {
  initializeApp({ projectId: 'demo-leados' }); const db = getFirestore(), T = (ms) => Timestamp.fromMillis(ms), DAY = 86400000;
  const token = await getAuth().createCustomToken((await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true })).uid);
  const P = { anna: '353871190001', bob: '353871190002', eve: '353871190003' };
  const customer = async (phone, name, email, stage, extra = {}) => {
    await db.doc('contacts/' + phone).set({ phone, name, ...(email ? { email } : {}), createdAt: T(NOW - 10 * DAY) });
    await db.doc('conversations/' + phone).set({ phone, name, inboxStatus: stage, unreadCount: 0, lastMessage: 'Hi, as discussed, your quotation', lastMessageDirection: 'out', createdAt: T(NOW - 10 * DAY), updatedAt: T(NOW - 3 * DAY), ...extra });
  };
  await customer(P.anna, 'Anna Apple', 'anna@example.com', 'quoted'); await customer(P.bob, 'Bob Byrne', 'bob@example.com', 'inbox'); await customer(P.eve, 'Eve Noemail', null, 'inbox');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' }), errors = []; global.__errors = errors;
  const open = async (viewport, phone) => {
    const ctx = await browser.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) }), page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(URL0); await page.waitForSelector('#login:not([hidden])'); await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])');
    await page.evaluate(() => { if (location.hash === '#today') location.hash = ''; }); return { ctx, page };
  };
  console.log('EMAIL INBOX E2E: real page + real functions + emulators + a fake Gmail');
  const { ctx, page } = await open({ width: 1360, height: 900 });
  const row = (p) => page.locator(`#list .conv[data-phone="${p}"]`);

  // ------------------------------------------------------------------ 1. before: Bob has never replied; the Email button is on a chat with an address and not on one without
  await page.click('#status-filters button[data-status="noreply"]'); await page.waitForSelector(`#list .conv[data-phone="${P.bob}"]`);
  ok('before any email: Bob (a lead who never replied) is in the No reply tab');
  await page.evaluate((id) => { location.hash = '#c/' + id; }, P.eve); await page.waitForSelector('#thread:not([hidden])'); await sleep(500);
  assert.equal(await page.locator('#email-btn').isVisible(), false, 'no address and no email: no Email button');
  await page.evaluate((id) => { location.hash = '#c/' + id; }, P.anna); await page.waitForSelector('#thread:not([hidden])'); await page.waitForSelector('#email-btn', { state: 'visible' });
  ok('the Email button shows on a chat that has an address, and not on one with none');

  // ------------------------------------------------------------------ 2. check for new email (the five-minute check, started by hand): replies come into the chats
  await page.click('#email-btn'); await page.waitForSelector('#em-dlg[open]');
  assert.equal(await page.locator('#em-last').isVisible(), false, 'no email from them yet'); assert.equal((await page.innerText('#em-to')).trim(), 'To: anna@example.com');
  await page.click('#em-check'); await page.waitForFunction(() => /Found 2 new emails from customers/.test(document.getElementById('em-err').textContent));
  assert.deepEqual(log.gets.filter((g) => g.full).map((g) => g.id).sort(), ['a1b2c3d4', 'b2c3d4e5'], 'the text of a customer\'s email is read; the supplier\'s is not');
  assert.ok(log.gets.some((g) => g.id === 'c3d4e5f6' && !g.full), 'the stranger\'s sender was looked at'); await page.click('#em-cancel');
  await page.waitForSelector('#msgs .m.em.in');
  const bubble = page.locator('#msgs .m.em.in').first(); const text = await bubble.innerText();
  assert.match(text, /Email · Re: Your Elite Kitchens quote EK-0112/); assert.match(text, /the price is fine\. Can you call me tomorrow after 5\?/); assert.doesNotMatch(text, /just checking you received|wrote:/, 'the quoted history is cut off');
  assert.equal(await bubble.locator('.em-att').getAttribute('href'), 'https://mail.google.com/mail/u/0/#all/a1b2c3d4'); assert.match(await bubble.locator('.em-att').innerText(), /our-kitchen-wall\.pdf \(open in Gmail\)/);
  assert.equal((await db.collection('conversations/' + P.eve + '/emails').get()).size, 0); assert.doesNotMatch(JSON.stringify((await db.collection('conversations').get()).docs.map((d) => d.data())), /SECRET supplier|supplier\.example/, 'nothing about the stranger is kept');
  ok('"Check for new email" brings the customer\'s reply into their chat with the history cut off and a Gmail link for the attachment; the stranger\'s email is looked at by sender only and never kept');
  assert.equal(await bubble.locator('.em-reply').innerText(), 'Reply by email', 'a clear button right under their email'); assert.equal((await page.innerText('#email-btn')).trim(), 'Reply by email', 'and the button by the message box says so too');
  await page.screenshot({ path: path.join(SHOTS, 'email-thread.png') });

  // ------------------------------------------------------------------ 3. the Inbox row, unread, and "they wrote to us"
  await page.evaluate(() => { location.hash = ''; }); await page.waitForSelector('#list');
  await page.click('#status-filters button[data-status="all"]');
  await until(async () => /Re: Your kitchen enquiry/.test(await row(P.bob).innerText()), 'Bob\'s row shows the email'); assert.match(await row(P.bob).innerText(), /✉ Re: Your kitchen enquiry/); assert.equal((await row(P.bob).locator('.badge').innerText()).trim(), '1');
  await page.click('#status-filters button[data-status="noreply"]'); await sleep(1500);
  assert.equal(await page.locator(`#list .conv[data-phone="${P.bob}"]`).count(), 0, 'Bob wrote by email: he is no longer "never replied"');
  ok('the Inbox row shows "✉ subject" and an unread badge, and a lead who replied by email leaves the No reply tab');

  // ------------------------------------------------------------------ 4. reply by email: the same conversation, as the business mailbox
  await page.evaluate((id) => { location.hash = '#c/' + id; }, P.anna); await page.waitForSelector('#msgs .m.em.in'); await page.click('#msgs .m.em.in .em-reply'); await page.waitForSelector('#em-dlg[open]');
  assert.equal(await page.inputValue('#em-subject'), 'Re: Your Elite Kitchens quote EK-0112'); assert.match(await page.innerText('#em-last'), /Their last email · Re: Your Elite Kitchens quote EK-0112[\s\S]*the price is fine/);
  await page.fill('#em-body', 'Hi Anna, of course. I will ring you tomorrow at 5.30pm.'); await page.screenshot({ path: path.join(SHOTS, 'email-reply-dialog.png') });
  await page.click('#em-send'); await page.waitForFunction(() => !document.getElementById('em-dlg').open); await page.waitForSelector('#msgs .m.em.out');
  assert.equal(log.sent.length, 1); const s = log.sent[0]; assert.equal(s.threadId, 'th_a1b2c3d4'); assert.match(s.raw, /^To: anna@example\.com/m); assert.match(s.raw, /^From: "Elite Kitchens" <info@test\.dev>/m); assert.match(s.raw, /^In-Reply-To: <a1b2c3d4@mail\.example>/m); assert.match(s.raw, /^Subject: Re: Your Elite Kitchens quote EK-0112/m);
  assert.match(await page.locator('#msgs .m.em.out').innerText(), /You emailed · Re: Your Elite Kitchens quote EK-0112[\s\S]*ring you tomorrow at 5\.30pm/); assert.match(await page.locator('#toast').innerText(), /Email sent to Anna Apple/);
  ok('Email opens a reply to the address they wrote from, in their Gmail conversation, as the business mailbox; the sent reply is kept in the thread');
  assert.equal(await page.locator('#msgs .m.em.in .em-reply').count(), 0, 'once answered, the button under their email goes'); await page.click('#email-btn'); await page.waitForSelector('#em-dlg[open]'); await page.fill('#em-body', 'Hi Anna, of course. I will ring you tomorrow at 5.30pm.'); await page.click('#em-send');
  await page.waitForFunction(() => /was just sent/.test(document.getElementById('em-err').textContent)); assert.equal(log.sent.length, 1, 'the same words twice in a row are refused'); await page.click('#em-cancel');
  ok('the very same email sent again straight away is refused (a double press cannot send twice)');
  await ctx.close();

  // ------------------------------------------------------------------ 5. phone
  const m = await open({ width: 375, height: 812 }, true);
  await m.page.evaluate((id) => { location.hash = '#c/' + id; }, P.anna); await m.page.waitForSelector('#msgs .m.em'); await m.page.waitForSelector('#email-btn', { state: 'visible' });
  const box = await m.page.locator('#email-btn').boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= 375 && box.height >= 40, 'the Email button is on screen and big enough: ' + JSON.stringify(box));
  assert.equal(await m.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scrolling'); await m.page.screenshot({ path: path.join(SHOTS, 'email-phone.png') });
  ok('on a 375px phone the emails fit in the chat and the Email button is on screen');

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | ')); ok('no console or page errors');
  await browser.close(); web.close(); gmail.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e, '\nPAGE ERRORS:', global.__errors); web.close(); gmail.close(); process.exit(1); });
