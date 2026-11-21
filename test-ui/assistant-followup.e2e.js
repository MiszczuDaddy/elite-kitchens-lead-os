'use strict';
// The Assistant's "email all the leads who never replied", in a REAL browser: the owner switches the action on in Settings, asks in plain words, sees ONE card that lists everybody who would get the email and the exact
// text, nothing is sent until Approve, Approve sends one email to each lead (their own first name) and the card says so, asking again finds nobody left. Gmail is a fake that records what would be sent;
// the Assistant is the built-in DEMO model (AI_FAKE_MODEL=on, emulator only). Every name and number is made up. Run: bash test-ui/run.sh assistant-followup.e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const { getAuth } = fnRequire('firebase-admin/auth');
const ai = fnRequire('./lib/ai');
const ROOT = path.join(__dirname, '..'), URL0 = 'http://127.0.0.1:5066/';
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
}).listen(5066);
// the fake Gmail (the functions emulator is told to use it: MAIL_API_BASE in test-ui/run.sh)
const mails = [];
const gmail = http.createServer((req, res) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => { try { mails.push(Buffer.from(JSON.parse(Buffer.concat(c).toString()).raw, 'base64url').toString('utf8')); } catch (e) { /* ignore */ } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'g' + mails.length, threadId: 't' })); }); }).listen(9913);
const toOf = (raw) => (/^To: (.+)$/m.exec(raw) || [])[1];

(async () => {
  initializeApp({ projectId: 'demo-leados' }); const db = getFirestore(), T = (ms) => Timestamp.fromMillis(ms), now = Date.now(), DAY = 86400000;
  const token = await getAuth().createCustomToken((await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true })).uid);
  const P = { oona: '353871150001', finn: '353871150002', nora: '353871150003', wrote: '353871150004' };
  const lead = async (phone, name, email, days, over = {}) => {
    await db.doc('contacts/' + phone).set({ phone, name, ...(email ? { email } : {}), createdAt: T(now - days * DAY) });
    await db.doc('conversations/' + phone).set({ phone, name, projectType: 'Kitchen', location: 'Swords', inboxStatus: 'inbox', unreadCount: 0, lastMessage: 'Hi, thanks for your enquiry', lastMessageDirection: 'out', createdAt: T(now - days * DAY), updatedAt: T(now - days * DAY), ...over });
  };
  await lead(P.oona, 'Oona Oldwait', 'oona@example.com', 12); await lead(P.finn, 'Finn Fairley', 'finn@example.com', 4); await lead(P.nora, 'Nora Noemail', null, 6);
  await lead(P.wrote, 'Wrote Back', 'wrote@example.com', 8, { lastInboundAt: T(now - DAY), lastMessageDirection: 'in', unreadCount: 1 });
  await db.doc('aiSettings/modelCheck').set(Object.fromEntries(Object.entries(ai.MODELS).map(([k, m]) => [k, { id: m.id, ok: true, name: m.label, lifecycle: 'active', at: T(now) }])));
  await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, actionsEnabled: true, actionKinds: { customerNote: true, projectUpdate: true }, monthlyCapEur: 15, dailyCapEur: 2 });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' }), errors = []; global.__errors = errors;
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } }), page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(URL0); await page.waitForSelector('#login:not([hidden])'); await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])');
  await page.click('#nav-assistant'); await page.waitForSelector('#assistant', { state: 'visible' });
  const answers = () => page.locator('#as-msgs .as-msg.assistant:not(.pending)');
  const ask = async (text) => { const before = await answers().count(); await page.fill('#as-input', text); await page.press('#as-input', 'Enter'); await page.waitForFunction((c) => document.querySelectorAll('#as-msgs .as-msg.assistant:not(.pending)').length > c, before); };
  console.log('ASSISTANT FOLLOW-UP EMAILS E2E: real page + real functions + emulators + the demo model + a fake Gmail');

  // ------------------------------------------------------------------ 1. the switch: off by default, owner-only box, on in Settings
  await page.waitForFunction(() => !document.getElementById('as-input').disabled);
  await ask('write a follow up email to all leads that did not reply');
  assert.equal(await page.locator('.as-card').count(), 0, 'with the follow-up email action off nothing is prepared'); assert.equal(mails.length, 0);
  await page.click('#as-settings'); await page.waitForSelector('#as-dlg[open]'); await page.waitForFunction(() => /this month/.test(document.getElementById('as-set-spent').textContent));
  assert.equal(await page.locator('#as-set-kind-followUpEmails').count(), 1); assert.equal(await page.locator('#as-set-kind-followUpEmails').isChecked(), false, 'off by default');
  assert.match(await page.locator('#as-set-kinds').innerText(), /Follow-up emails to leads who never replied \(sends emails, after you press Approve\)/);
  await page.check('#as-set-kind-followUpEmails'); await page.click('#as-set-save'); await page.waitForFunction(() => !document.getElementById('as-dlg').open);
  assert.equal((await db.doc('aiSettings/current').get()).data().actionKinds.followUpEmails, true);
  ok('the follow-up email action is OFF by default, labelled as one that sends emails, and the owner switches it on in Settings');
  for (const d of (await db.collection('aiRate').get()).docs) await d.ref.delete();

  // ------------------------------------------------------------------ 2. ask in plain words: ONE card, everybody listed, the exact email, nothing sent
  await ask('write a follow up email to all leads that did not reply');
  await page.waitForSelector('#as-tray .as-card[data-state=pending]');
  const tray = await page.locator('#as-tray').innerText();
  assert.match(tray, /Email 2 leads who never replied/); assert.match(tray, /Who gets it \(2\)/i); assert.match(tray, /Oona Oldwait · oona@example\.com/); assert.match(tray, /Finn Fairley · finn@example\.com/);
  assert.doesNotMatch(tray, /Nora Noemail|Wrote Back/, 'no address, or already wrote: not on the list');
  assert.match(tray, /Hi \{first name\},[\s\S]*free home consultation/); assert.doesNotMatch(tray, /rather not hear/);
  assert.match(tray, /Nothing is sent before you press Approve/); assert.match(tray, /Approve[\s\S]*Reject/);
  assert.equal(mails.length, 0, 'nothing is sent before Approve');
  assert.equal((await db.doc('conversations/' + P.oona).get()).data().followUp, undefined);
  assert.match(await answers().last().innerText(), /Prepared for your approval: Email 2 leads who never replied/);
  await page.screenshot({ path: path.join(SHOTS, 'assistant-followup-card.png') });
  ok('asking in plain words prepares ONE card: who gets it, the exact email, and nothing is sent yet');

  // ------------------------------------------------------------------ 3. Approve: one email each, with their own first name
  await page.click('#as-tray button:has-text("Approve")'); await page.waitForSelector('.as-card[data-state=applied]'); await page.waitForSelector('#as-tray', { state: 'hidden' });
  assert.match(await page.locator('.as-card[data-state=applied]').innerText(), /Done: 2 emails were sent\./);
  assert.equal(mails.length, 2); assert.deepEqual(mails.map(toOf).sort(), ['finn@example.com', 'oona@example.com']);
  const oona = mails.find((m) => toOf(m) === 'oona@example.com'), finn = mails.find((m) => toOf(m) === 'finn@example.com');
  assert.ok(oona.includes('Hi Oona,') && !oona.includes('Hi Finn,') && finn.includes('Hi Finn,'));
  assert.match(oona, /^Reply-To: info@test\.dev/m); assert.match(oona, /^Subject: Your kitchen enquiry with Elite Kitchens/m);
  for (const p of [P.oona, P.finn]) { const f = (await db.doc('conversations/' + p).get()).data().followUp; assert.equal(f.emailCount, 1); assert.equal(f.emailBy, 'staff@test.dev'); }
  assert.equal((await db.doc('conversations/' + P.nora).get()).data().followUp, undefined);
  assert.deepEqual((await db.collection('auditLog').where('action', '==', 'aiProposal').get()).docs.map((d) => d.data().event).sort(), ['applied', 'created']);
  await page.screenshot({ path: path.join(SHOTS, 'assistant-followup-done.png') });
  ok('Approve sends one email to each lead on the list with their own first name, records it on the lead, audits it, and the card says how many were sent');

  // ------------------------------------------------------------------ 4. asking again: nobody left; no second email
  for (const d of (await db.collection('aiRate').get()).docs) await d.ref.delete();
  await ask('email all the leads again');
  assert.equal(await page.locator('#as-tray .as-card').count(), 0, 'no new card'); assert.equal(mails.length, 2);
  ok('asking again finds nobody left to email: no new card and no second email');

  // ------------------------------------------------------------------ 5. the card on a phone
  const pctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true }), ph = await pctx.newPage(); ph.on('pageerror', (e) => errors.push(e.message));
  await lead('353871150011', 'Phone Person', 'phone@example.com', 5); await lead('353871150012', 'Second Person', 'second@example.com', 7);
  await ph.goto(URL0); await ph.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await ph.waitForSelector('#app:not([hidden])'); await ph.evaluate(() => { if (location.hash === '#today') location.hash = ''; });
  await ph.waitForSelector('#to-assistant', { state: 'visible' }); await ph.click('#to-assistant'); await ph.waitForSelector('#assistant', { state: 'visible' });
  await ph.waitForFunction(() => !document.getElementById('as-input').disabled);
  for (const d of (await db.collection('aiRate').get()).docs) await d.ref.delete();
  await ph.fill('#as-input', 'follow up emails please'); await ph.press('#as-input', 'Enter'); await ph.waitForSelector('#as-tray .as-card[data-state=pending]');
  const box = await ph.locator('#as-tray button:has-text("Approve")').boundingBox(); assert.ok(box && box.y >= 0 && box.y + box.height <= 812, 'the Approve button is on screen without scrolling: ' + JSON.stringify(box));
  assert.equal(await ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scrolling');
  await ph.screenshot({ path: path.join(SHOTS, 'assistant-followup-phone.png') });
  ok('on a 375px phone the card (list and email) fits, the Approve button is on screen, and the page does not scroll sideways');

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | '));
  ok('no console or page errors');
  await browser.close(); web.close(); gmail.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e, '\nPAGE ERRORS:', global.__errors); web.close(); gmail.close(); process.exit(1); });
