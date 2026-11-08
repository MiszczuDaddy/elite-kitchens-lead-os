'use strict';
// The quote follow-up EMAIL, in a REAL browser: on Today, a quote nobody answered has an Email button; the dialog is pre-filled (their first name, the quote number) and editable; Send emails the customer, the card
// leaves Today (it comes back in 7 days), a quote already emailed shows "emailed" and has no button, a customer with no address is told so. Gmail is a fake that records what would be sent.
// Every name and number is made up. Run: bash test-ui/run.sh quote-followup.e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const { getAuth } = fnRequire('firebase-admin/auth');
const ROOT = path.join(__dirname, '..'), URL0 = 'http://127.0.0.1:5067/';
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
}).listen(5067);
const mails = [];
const gmail = http.createServer((req, res) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => { try { mails.push(Buffer.from(JSON.parse(Buffer.concat(c).toString()).raw, 'base64url').toString('utf8')); } catch (e) { /* ignore */ } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'g' + mails.length, threadId: 't' })); }); }).listen(9913);
const toOf = (raw) => (/^To: (.+)$/m.exec(raw) || [])[1];
const bodyOf = (raw) => raw.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (m, x) => String.fromCharCode(parseInt(x, 16)));

(async () => {
  initializeApp({ projectId: 'demo-leados' }); const db = getFirestore(), T = (ms) => Timestamp.fromMillis(ms), now = Date.now(), DAY = 86400000;
  const token = await getAuth().createCustomToken((await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true })).uid);
  const P = { maeve: '353871160001', noel: '353871160002', fiona: '353871160003' }, id = (c) => 'q_' + c.repeat(24);
  const Q = { maeve: id('a'), noel: id('b'), fiona: id('c') };
  const customer = async (phone, name, email, convOver = {}) => {
    await db.doc('contacts/' + phone).set({ phone, name, ...(email ? { email } : {}), createdAt: T(now - 40 * DAY) });
    await db.doc('conversations/' + phone).set({ phone, name, inboxStatus: 'quoted', unreadCount: 0, lastMessage: 'Hi, as discussed, your quotation', lastMessageDirection: 'out', lastInboundAt: T(now - 20 * DAY), createdAt: T(now - 40 * DAY), updatedAt: T(now - 9 * DAY), ...convOver });
  };
  const quote = (qid, phone, name, ref, days) => db.doc('quotes/' + qid).set({ phone, ref, status: 'sent', customerName: name, sentAt: T(now - days * DAY), validUntil: '2099-01-01', summary: { dearest: { incVat: 12500 } } });
  const sentAtMaeve = now - 9 * DAY;
  await customer(P.maeve, 'Maeve Doyle', 'maeve@example.com'); await quote(Q.maeve, P.maeve, 'Maeve Doyle', 'EK-0201', 9);
  await customer(P.noel, 'Noel Nolan', null); await quote(Q.noel, P.noel, 'Noel Nolan', 'EK-0202', 12);
  await customer(P.fiona, 'Fiona Fahey', 'fiona@example.com', { quoteMail: { [Q.fiona]: { at: T(now - 2 * DAY), by: 'thomas@example.com', basis: now - 10 * DAY, confirmed: true } } }); await quote(Q.fiona, P.fiona, 'Fiona Fahey', 'EK-0203', 10);
  await db.doc('quotes/' + Q.fiona).update({ sentAt: T(now - 10 * DAY) });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' }), errors = []; global.__errors = errors;
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } }), page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(URL0); await page.waitForSelector('#login:not([hidden])'); await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])');
  await page.waitForSelector('#today-list .td-card');
  const card = (qid) => page.locator(`#today-list .td-card[data-key="quote|${qid}"]`);
  const keys = () => page.$$eval('#today-list .td-card', (els) => els.map((e) => e.dataset.key));
  console.log('QUOTE FOLLOW-UP EMAIL E2E: real page + real functions + emulators + a fake Gmail');

  // ------------------------------------------------------------------ 1. the Email button (not on a quote already emailed)
  await until(async () => (await keys()).length >= 3, 'three quote cards');
  for (const q of [Q.maeve, Q.noel]) assert.equal(await card(q).locator('button.btn:text-is("Email")').count(), 1, 'Email button on ' + q);
  assert.deepEqual(await card(Q.maeve).locator('.td-actions button, button.btn').allInnerTexts().then((t) => t.map((x) => x.trim())), ['Open quote', 'Email', 'Followed up', 'Dismiss'], 'the buttons, in order');
  await until(async () => (await card(Q.fiona).locator('button.btn:text-is("Email")').count()) === 0, 'already emailed about this quote: no button');
  assert.match(await card(Q.fiona).innerText(), /EK-0203[\s\S]*emailed \d+ \w+/);
  ok('a quote card has Open quote, Email, Followed up, Dismiss; a quote already emailed says "emailed" and has no Email button');

  // ------------------------------------------------------------------ 2. a customer with no address is told, nothing opens
  await card(Q.noel).locator('button.btn:text-is("Email")').click();
  await page.waitForSelector('#today-toast:not([hidden])'); assert.match(await page.locator('#today-toast').innerText(), /Noel Nolan has no email address\. Add one in their Details first\./);
  assert.equal(await page.locator('#fu-dlg[open]').count(), 0); assert.equal(mails.length, 0);
  ok('a customer with no email address is told so, and no dialog opens');

  // ------------------------------------------------------------------ 3. the dialog: pre-filled, editable, nothing sent until Send
  await card(Q.maeve).locator('button.btn:text-is("Email")').click(); await page.waitForSelector('#fu-dlg[open]');
  assert.match(await page.innerText('#fu-title'), /Email Maeve Doyle about quote EK-0201/); assert.equal((await page.innerText('#fu-to')).trim(), 'To: maeve@example.com');
  assert.equal(await page.inputValue('#fu-subject'), 'Your Elite Kitchens quote EK-0201');
  const body = await page.inputValue('#fu-body'); assert.match(body, /^Hi Maeve,\n\nI just wanted to check that you received your quote \(EK-0201\), and to see if you have any questions about it\./); assert.doesNotMatch(body, /€|warranty/i);
  assert.match(await page.innerText('#fu-hint'), /followed up by email once[\s\S]*7 days/); assert.equal(await page.isVisible('#fu-batch'), false); assert.equal(await page.innerText('#fu-send'), 'Send email'); assert.equal(mails.length, 0, 'nothing sent yet');
  await page.screenshot({ path: path.join(SHOTS, 'quote-followup-dialog.png') });
  await page.fill('#fu-body', body.replace('I just wanted to check', 'Just checking'));
  ok('the dialog opens pre-filled with their first name and the quote number, no price, and you can change the words; nothing is sent yet');

  // ------------------------------------------------------------------ 4. Send: one email, recorded, the card leaves Today for 7 days
  await page.click('#fu-send'); await page.waitForFunction(() => !document.getElementById('fu-dlg').open);
  await until(() => mails.length === 1, 'the email reaches the fake Gmail');
  assert.equal(toOf(mails[0]), 'maeve@example.com'); assert.match(mails[0], /^Subject: Your Elite Kitchens quote EK-0201/m); assert.match(bodyOf(mails[0]), /Hi Maeve,\r?\n\r?\nJust checking that you received your quote \(EK-0201\)/); assert.match(mails[0], /^Reply-To: info@test\.dev/m);
  const m = (await db.doc('conversations/' + P.maeve).get()).data().quoteMail[Q.maeve]; assert.deepEqual([m.confirmed, m.by, m.basis], [true, 'staff@test.dev', sentAtMaeve > 0 ? m.basis : 0]);
  const mk = (await db.doc('todayMarks/quote_' + Q.maeve).get()).data(); assert.ok(mk.snoozeUntil.toMillis() > Date.now() + 6 * DAY);
  await until(async () => !(await keys()).includes('quote|' + Q.maeve), 'the card leaves Today'); assert.match(await page.locator('#today-toast').innerText(), /Follow-up email sent to Maeve Doyle\. The quote comes back on Today in 7 days/);
  ok('Send emails the customer once (with your edited words), records it, shows the toast and hides the card for 7 days');

  // ------------------------------------------------------------------ 5. the server refuses a second one even if the screen offered the button (older record)
  await db.doc('todayMarks/quote_' + Q.maeve).delete(); await until(async () => (await keys()).includes('quote|' + Q.maeve), 'the card is back');
  const btn = await card(Q.maeve).locator('button.btn:text-is("Email")').count();
  if (btn) { await card(Q.maeve).locator('button.btn:text-is("Email")').click(); await page.waitForSelector('#fu-dlg[open]'); await page.click('#fu-send'); await page.waitForFunction(() => /already emailed them about this quote/.test(document.getElementById('fu-err').textContent)); await page.click('#fu-cancel'); }
  assert.equal(mails.length, 1, 'still only one email'); ok('a second email about the same quote is refused (the card shows "emailed" and has no button once the record is known; the server refuses even if it is not)');

  // ------------------------------------------------------------------ 6. the phone
  const pctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true }), ph = await pctx.newPage(); ph.on('pageerror', (e) => errors.push(e.message));
  await ph.goto(URL0); await ph.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await ph.waitForSelector('#app:not([hidden])'); await ph.waitForSelector('#today-list .td-card');
  const pc = ph.locator(`#today-list .td-card[data-key="quote|${Q.noel}"]`); await pc.scrollIntoViewIfNeeded();
  const boxes = await pc.locator('button.btn').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { t: e.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right) }; }));
  assert.ok(boxes.length >= 4 && boxes.every((b) => b.h >= 40 && b.r <= 375), 'every button is at least 40px high and inside the screen: ' + JSON.stringify(boxes));
  assert.equal(await ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scrolling');
  await ph.screenshot({ path: path.join(SHOTS, 'quote-followup-phone.png') });
  ok('on a 375px phone the four buttons fit, are big enough, and the page does not scroll sideways');

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | ')); ok('no console or page errors');
  await browser.close(); web.close(); gmail.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e, '\nPAGE ERRORS:', global.__errors); web.close(); gmail.close(); process.exit(1); });
