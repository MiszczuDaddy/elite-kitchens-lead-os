'use strict';
// The Assistant writes ONE email to ONE customer, in a REAL browser: the owner switches the action on in Settings (it is OFF by default), opens a customer's chat, asks the Assistant to email them, sees the EXACT email (greeting and
// signature added for them) and nothing is sent; Approve sends exactly that text as a new email; the card says so; the customer's chat and the Emails tab show it; a customer who writes meanwhile makes it stale. Gmail is a fake
// that records what would be sent; the Assistant is the built-in DEMO model (AI_FAKE_MODEL=on, emulator only). Every name and number is made up. Run: bash test-ui/run.sh assistant-customer-email.e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const { getAuth } = fnRequire('firebase-admin/auth');
const ai = fnRequire('./lib/ai');
const ROOT = path.join(__dirname, '..'), URL0 = 'http://127.0.0.1:5075/';
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
}).listen(5075);
// the fake Gmail (the functions emulator is told to use it: MAIL_API_BASE in test-ui/run.sh)
const mails = [];
const gmail = http.createServer((req, res) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => { try { mails.push(Buffer.from(JSON.parse(Buffer.concat(c).toString()).raw, 'base64url').toString('utf8')); } catch (e) { /* ignore */ } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'g' + mails.length, threadId: 't' })); }); }).listen(9913);
const toOf = (raw) => (/^To: (.+)$/m.exec(raw) || [])[1];

(async () => {
  initializeApp({ projectId: 'demo-leados' }); const db = getFirestore(), T = (ms) => Timestamp.fromMillis(ms), now = Date.now(), DAY = 86400000;
  const token = await getAuth().createCustomToken((await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true })).uid);
  const RAY = '353871160001', NOEMAIL = '353871160002';
  const customer = async (phone, name, email) => {
    await db.doc('contacts/' + phone).set({ phone, name, ...(email ? { email } : {}), createdAt: T(now - 20 * DAY) });
    await db.doc('conversations/' + phone).set({ phone, name, projectType: 'Kitchen', location: 'Swords', inboxStatus: 'quoted', unreadCount: 0, lastMessage: 'Hi Ray, your quotation', lastMessageDirection: 'out', createdAt: T(now - 20 * DAY), updatedAt: T(now - 9 * DAY) });
  };
  await customer(RAY, 'Ray Ryan', 'ray@example.com'); await customer(NOEMAIL, 'Nora Noemail', null);
  await db.doc('aiSettings/modelCheck').set(Object.fromEntries(Object.entries(ai.MODELS).map(([k, m]) => [k, { id: m.id, ok: true, name: m.label, lifecycle: 'active', at: T(now) }])));
  await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, actionsEnabled: true, actionKinds: { customerNote: true, projectUpdate: true }, monthlyCapEur: 15, dailyCapEur: 2 });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' }), errors = []; global.__errors = errors;
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } }), page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(URL0); await page.waitForSelector('#login:not([hidden])'); await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])');
  await page.evaluate(() => { if (location.hash === '#today') location.hash = ''; });
  console.log('ASSISTANT: ONE EMAIL TO ONE CUSTOMER E2E: real page + real functions + emulators + the demo model + a fake Gmail');
  const toAssistantFrom = async (phone) => { await page.evaluate((id) => { location.hash = '#c/' + id; }, phone); await page.waitForSelector('#thread:not([hidden])'); await page.click('#nav-assistant'); await page.waitForSelector('#assistant', { state: 'visible' }); await page.waitForFunction(() => !document.getElementById('as-input').disabled); };
  const WORDS = 'Thanks again for getting in touch about your kitchen. I just wanted to check that you received our quote and to see if you have any questions about it.';
  const ask = async (text) => { await page.fill('#as-input', text); await page.press('#as-input', 'Enter'); };

  // ------------------------------------------------------------------ 1. off by default: nothing is prepared; the owner switches it on in Settings
  await toAssistantFrom(RAY); await ask('email: ' + WORDS); await sleep(2500);
  assert.equal(await page.locator('.as-card').count(), 0, 'with the action off nothing is prepared'); assert.equal(mails.length, 0);
  await page.click('#as-settings'); await page.waitForSelector('#as-dlg[open]'); await page.waitForFunction(() => /this month/.test(document.getElementById('as-set-spent').textContent));
  assert.equal(await page.locator('#as-set-kind-customerEmail').count(), 1); assert.equal(await page.locator('#as-set-kind-customerEmail').isChecked(), false, 'off by default');
  assert.match(await page.locator('#as-set-kinds').innerText(), /An email to one customer, written by the Assistant \(sends an email, after you press Approve\)/);
  await page.check('#as-set-kind-customerEmail'); await page.click('#as-set-save'); await page.waitForFunction(() => !document.getElementById('as-dlg').open);
  assert.equal((await db.doc('aiSettings/current').get()).data().actionKinds.customerEmail, true);
  ok('the one-customer email is OFF by default, labelled as one that sends an email, and the owner switches it on in Settings');
  for (const d of (await db.collection('aiRate').get()).docs) await d.ref.delete();

  // ------------------------------------------------------------------ 2. ask: ONE card with the exact email (greeting and signature added), nothing sent
  await page.click('#as-new'); await toAssistantFrom(RAY); await ask('email: ' + WORDS);
  await page.waitForSelector('#as-tray .as-card[data-state=pending]');
  const tray = await page.locator('#as-tray').innerText();
  assert.match(tray, /Email Ray Ryan/); assert.match(tray, /Who gets it/i); assert.match(tray, /Ray Ryan · ray@example\.com/); assert.match(tray, /subject: Your Elite Kitchens kitchen/i);
  assert.match(tray, /Hi Ray,[\s\S]*Thanks again for getting in touch about your kitchen[\s\S]*Kind regards,\s*Elite Kitchens/); assert.match(tray, /sent exactly as written above[\s\S]*Nothing is sent before you press Approve/); assert.match(tray, /Approve[\s\S]*Reject/);
  assert.equal(mails.length, 0, 'nothing is sent before Approve'); assert.equal((await db.collection(`conversations/${RAY}/emails`).get()).size, 0);
  const box = await page.locator('#as-tray .as-card-text').evaluate((e) => [e.clientHeight, e.scrollHeight]); assert.ok(box[1] <= box[0] + 1, 'the whole email is readable without scrolling inside its box: ' + box);
  await page.screenshot({ path: path.join(SHOTS, 'assistant-customer-email-card.png') });
  ok('asking prepares ONE card: who gets it, the exact email with the greeting and the signature added by Elite OS, and nothing is sent yet');

  // ------------------------------------------------------------------ 3. Approve: sent exactly as shown, as a new email; the card, the chat and the Emails tab say so
  await page.click('#as-tray button:has-text("Approve")'); await page.waitForSelector('.as-card[data-state=applied]'); await page.waitForSelector('#as-tray', { state: 'hidden' });
  assert.match(await page.locator('.as-card[data-state=applied]').innerText(), /Done: The email was sent to Ray Ryan\./);
  assert.equal(mails.length, 1); const raw = mails[0]; assert.equal(toOf(raw), 'ray@example.com'); assert.match(raw, /^Subject: Your Elite Kitchens kitchen/m); assert.match(raw, /^From: "?[^\n]*<info@test\.dev>/m); assert.doesNotMatch(raw, /^In-Reply-To:/m);
  const body = decodeURIComponent(raw.split(/\r?\n\r?\n/).slice(1).join('\n').replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, '%$1')); assert.match(body, /Hi Ray,[\s\S]*Thanks again for getting in touch about your kitchen[\s\S]*Kind regards,\s*Elite Kitchens/);
  const c = (await db.doc('conversations/' + RAY).get()).data(); assert.equal(c.lastEmailDir, 'out');
  await page.evaluate((id) => { location.hash = '#c/' + id; }, RAY); await page.waitForSelector('#msgs .m.em.out');
  assert.match(await page.locator('#msgs .m.em.out').innerText(), /You emailed \(written by the Assistant\) · Your Elite Kitchens kitchen[\s\S]*Thanks again for getting in touch/);
  await page.click('#nav-emails'); await page.waitForSelector('#emails', { state: 'visible' }); await page.waitForSelector('#emp-list .ea-open');
  assert.equal(await page.locator('#emp-list .ea-open .ea-kind').first().innerText(), '↗ Sent · written by the Assistant');
  ok('Approve sends exactly that text to Ray as a new email; the card says so, the chat shows "You emailed (written by the Assistant)" and the Emails tab lists it');

  // ------------------------------------------------------------------ 4. a customer who writes meanwhile makes it stale; no address: no card
  await page.click('#nav-inbox'); await toAssistantFrom(RAY); await page.click('#as-new'); await toAssistantFrom(RAY); for (const d of (await db.collection('aiRate').get()).docs) await d.ref.delete();
  await ask('email: ' + WORDS + ' Also, one more question.'); await page.waitForSelector('#as-tray .as-card[data-state=pending]');
  await db.doc('conversations/' + RAY).update({ lastInboundAt: T(Date.now() + 1000) });
  await page.click('#as-tray button:has-text("Approve")'); await page.waitForSelector('.as-card[data-state=stale]'); assert.match(await page.locator('.as-card[data-state=stale]').innerText(), /They wrote to you after this was prepared, so check the chat first/); assert.equal(mails.length, 1, 'nothing more was sent');
  await page.click('#as-new'); await toAssistantFrom(NOEMAIL); for (const d of (await db.collection('aiRate').get()).docs) await d.ref.delete();
  await ask('email: ' + WORDS); await page.waitForFunction(() => /no email address/i.test(document.getElementById('as-msgs').innerText), null, { timeout: 20000 }).catch(() => {}); assert.equal(await page.locator('#as-tray .as-card').count(), 0, 'a customer with no email address: no card');
  ok('a customer who writes after it was prepared makes it stale (nothing is sent); a customer with no email address gets no card');

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | ')); ok('no console or page errors');
  await browser.close(); web.close(); gmail.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e, '\nPAGE ERRORS:', global.__errors); web.close(); gmail.close(); process.exit(1); });
