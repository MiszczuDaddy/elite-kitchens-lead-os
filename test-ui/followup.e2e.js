'use strict';
// Follow-up emails to leads who never replied, in a REAL browser: the Email button in the No reply tab (only for a lead with an address, a day old, and not emailed lately), the preview dialog with the first name,
// sending one email, "Email all", and the row saying it was emailed. Gmail is a fake that records what would be sent. Every name and number is made up. Run: bash test-ui/run.sh followup.e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const { getAuth } = fnRequire('firebase-admin/auth');
const ROOT = path.join(__dirname, '..'), URL0 = 'http://127.0.0.1:5065/';
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
}).listen(5065);
// the fake Gmail (the functions emulator is told to use it: MAIL_API_BASE in test-ui/run.sh)
const mails = [];
http.createServer((req, res) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => { try { mails.push(Buffer.from(JSON.parse(Buffer.concat(c).toString()).raw, 'base64url').toString('utf8')); } catch (e) { /* ignore */ } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'g' + mails.length, threadId: 't' })); }); }).listen(9913);
const toOf = (raw) => (/^To: (.+)$/m.exec(raw) || [])[1];

(async () => {
  initializeApp({ projectId: 'demo-leados' }); const db = getFirestore(), T = (ms) => Timestamp.fromMillis(ms), now = Date.now(), DAY = 86400000;
  const token = await getAuth().createCustomToken((await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true })).uid);
  const P = { oona: '353871140001', finn: '353871140002', rory: '353871140003', nora: '353871140004', tia: '353871140005', evan: '353871140006' };
  const lead = async (phone, name, email, days, over = {}) => {
    await db.doc('contacts/' + phone).set({ phone, name, ...(email ? { email } : {}), createdAt: T(now - days * DAY) });
    await db.doc('conversations/' + phone).set({ phone, name, projectType: 'Kitchen', location: 'Swords', inboxStatus: 'inbox', unreadCount: 0, lastMessage: 'Hi, thanks for your enquiry', lastMessageDirection: 'out', createdAt: T(now - days * DAY), updatedAt: T(now - days * DAY), ...over });
  };
  await lead(P.oona, 'Oona Oldwait', 'oona@example.com', 40); await lead(P.finn, 'Finn Fairley', 'finn@example.com', 10); await lead(P.rory, 'Rory Recent', 'rory@example.com', 3);
  await lead(P.nora, 'Nora Noemail', null, 5); await lead(P.tia, 'Tia Tooneweb', 'tia@example.com', 0.1);
  await lead(P.evan, 'Evan Emailed', 'evan@example.com', 6, { followUp: { emailCount: 1, emailAt: T(now - 2 * DAY), emailBy: 'thomas@example.com', confirmed: true } });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' }), errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } }), page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL0); await page.waitForSelector('#login:not([hidden])'); await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])');
  await page.evaluate(() => { location.hash = ''; }); await page.waitForSelector('.conv');
  const row = (p) => page.locator(`#list .conv[data-phone="${p}"]`);
  console.log('FOLLOW-UP EMAIL E2E: real page + real functions + emulators, in Chromium');

  // ------------------------------------------------------------------ 1. who gets an Email button
  await page.click('#status-filters button[data-status="noreply"]');
  await until(async () => (await row(P.oona).locator('.conv-mail').count()) === 1, 'the directory loads and the Email button appears');
  await page.waitForSelector('#nr-bar:not([hidden])');
  for (const [p, label] of [[P.finn, 'a lead with an address'], [P.rory, 'a lead with an address']]) assert.equal(await row(p).locator('.conv-mail').count(), 1, label);
  assert.equal(await row(P.nora).locator('.conv-mail').count(), 0, 'no address: no button'); assert.equal(await row(P.tia).locator('.conv-mail').count(), 0, 'arrived 2 hours ago: no button');
  assert.equal(await row(P.evan).locator('.conv-mail').count(), 0, 'emailed 2 days ago: no button'); assert.match(await row(P.evan).locator('.conv-sub').innerText(), /emailed \d+ \w+/);
  assert.equal(await page.innerText('#nr-email-all'), 'Email all (3)');
  ok('the Email button is only on leads with an address who are a day old and were not emailed lately; "Email all (3)" counts exactly those; an emailed lead says when');

  // ------------------------------------------------------------------ 2. one email: read it, send it
  await row(P.oona).locator('.conv-mail').click(); await page.waitForSelector('#fu-dlg[open]');
  assert.match(await page.innerText('#fu-to'), /oona@example\.com/); assert.equal(await page.inputValue('#fu-subject'), 'Your kitchen enquiry with Elite Kitchens');
  const body = await page.inputValue('#fu-body'); assert.match(body, /^Hi Oona,/); assert.match(body, /free home consultation/); assert.equal(await page.evaluate(() => S.selected || null), null, 'pressing Email did not open the chat');
  await page.screenshot({ path: path.join(SHOTS, 'followup-dialog.png') });
  await page.click('#fu-send'); await page.waitForFunction(() => !document.getElementById('fu-dlg').open);
  await until(async () => mails.length === 1, 'the email reached Gmail'); assert.equal(toOf(mails[0]), 'oona@example.com'); assert.match(mails[0], /^Subject: Your kitchen enquiry with Elite Kitchens/m);
  await until(async () => (await row(P.oona).locator('.conv-mail').count()) === 0, 'the button goes after sending'); assert.match(await row(P.oona).locator('.conv-sub').innerText(), /emailed/);
  assert.equal((await db.doc('conversations/' + P.oona).get()).data().followUp.emailCount, 1);
  ok('Email opens the email with her first name for you to read; Send sends one email to her address; the row then says it was emailed and the button is gone');

  // ------------------------------------------------------------------ 3. Email all
  assert.equal(await page.innerText('#nr-email-all'), 'Email all (2)');
  await page.click('#nr-email-all'); await page.waitForSelector('#fu-dlg[open]');
  assert.match(await page.innerText('#fu-title'), /Email 2 leads/); assert.match(await page.inputValue('#fu-body'), /^Hi \{first\},/); assert.equal(await page.locator('#fu-batch .fu-rcpt').count(), 2);
  await page.click('#fu-send'); await page.waitForFunction(() => !document.getElementById('fu-dlg').open);
  await until(async () => mails.length === 3, 'two more emails went'); assert.deepEqual(mails.slice(1).map(toOf).sort(), ['finn@example.com', 'rory@example.com']);
  assert.ok(mails.slice(1).every((m) => !m.includes('{first}')), 'every {first} was replaced'); assert.ok(mails.some((m) => /Hi Finn,/.test(m)) && mails.some((m) => /Hi Rory,/.test(m)));
  await until(async () => (await page.locator('#nr-bar').isHidden()), 'nobody is left to email');
  ok('"Email all" sends each lead their own email (their first name filled in), and nobody is emailed twice');

  // ------------------------------------------------------------------ 4. the server refuses what the screen shouldn't have offered (a lead who wrote since)
  await db.doc('conversations/' + P.nora).update({ lastInboundAt: T(Date.now()) }); assert.equal(mails.length, 3);
  assert.equal(await page.evaluate(async (phone) => { try { await call('sendFollowUpEmail')({ phone }); return 'sent'; } catch (e) { return e.code || 'error'; } }, P.nora), 'functions/failed-precondition', 'no address / has written: refused by the server');
  assert.equal(mails.length, 3, 'nothing more was sent');
  ok('the server refuses a lead who cannot be emailed, whatever the screen says');

  assert.deepEqual(errors, [], 'no JavaScript errors: ' + JSON.stringify(errors)); ok('no JavaScript errors in the browser');
  console.log(`ALL ${n} CHECKS PASSED`); await browser.close(); process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
