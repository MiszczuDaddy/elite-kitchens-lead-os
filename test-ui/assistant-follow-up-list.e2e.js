'use strict';
// The Assistant's follow-up LIST with tick boxes, in a REAL browser (docs/FOLLOW_UP_EMAIL.md): one card with the customers who got a quote and never answered AND the leads who never replied, each with how long it has been;
// whoever meets the rules starts ticked, a quote under two weeks old starts UNTICKED but can be ticked by hand; "Approve (n of N)" counts the ticks; only the ticked people are emailed; the owner chooses WHEN to send (now,
// the next morning, a time of their choice); a scheduled send waits (nothing goes out) and can be cancelled; the whole card fits a phone. Gmail is a fake that records what would be sent; the Assistant is the built-in DEMO
// model (AI_FAKE_MODEL=on, emulator only). Every name and number is made up. Run: bash test-ui/run.sh assistant-follow-up-list.e2e.js
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
const qid = (k) => 'q_' + String(k).padStart(24, '0');

(async () => {
  initializeApp({ projectId: 'demo-leados' }); const db = getFirestore(), T = (ms) => Timestamp.fromMillis(ms), now = Date.now(), DAY = 86400000;
  const token = await getAuth().createCustomToken((await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true })).uid);
  const ANNE = '353871170001', JOHN = '353871170002', JAY = '353871170003', OONA = '353871170011', PAT = '353871170012';
  const quote = async (k, phone, name, email, daysAgo) => {
    const at = now - daysAgo * DAY;
    await db.doc('contacts/' + phone).set({ phone, name, email, createdAt: T(now - 40 * DAY) });
    await db.doc('conversations/' + phone).set({ phone, name, projectType: 'Kitchen', location: 'Swords', inboxStatus: 'quoted', unreadCount: 0, lastMessage: 'Hi, your quotation', lastMessageDirection: 'out', createdAt: T(now - 40 * DAY), updatedAt: T(at) });
    await db.doc('quotes/' + qid(k)).set({ phone, ref: 'EK-01' + String(k).padStart(2, '0'), status: 'sent', sentAt: T(at), customerName: name, summary: { dearest: { incVat: 18000 } } });
  };
  const lead = async (phone, name, email, daysAgo) => {
    await db.doc('contacts/' + phone).set({ phone, name, email, createdAt: T(now - daysAgo * DAY) });
    await db.doc('conversations/' + phone).set({ phone, name, projectType: 'Kitchen', location: 'Balbriggan', inboxStatus: 'inbox', unreadCount: 0, lastMessage: 'Hi, thanks for your enquiry', lastMessageDirection: 'out', createdAt: T(now - daysAgo * DAY), updatedAt: T(now - daysAgo * DAY) });
  };
  await quote(1, ANNE, 'Anne Apple', 'anne@example.com', 5); await quote(2, JOHN, 'John Byrne', 'john@example.com', 15); await quote(3, JAY, 'Jay Casey', 'jay@example.com', 23);
  await lead(OONA, 'Oona Oldwait', 'oona@example.com', 6); await lead(PAT, 'Pat Pending', 'pat@example.com', 9);
  await db.doc('aiSettings/modelCheck').set(Object.fromEntries(Object.entries(ai.MODELS).map(([k, m]) => [k, { id: m.id, ok: true, name: m.label, lifecycle: 'active', at: T(now) }])));
  await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, actionsEnabled: true, actionKinds: { followUpEmails: true, quoteFollowUps: true }, monthlyCapEur: 15, dailyCapEur: 2 });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' }), errors = []; global.__errors = errors;
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } }), page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(URL0); await page.waitForSelector('#login:not([hidden])'); await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])');
  await page.evaluate(() => { if (location.hash === '#today') location.hash = ''; });
  console.log('ASSISTANT: THE FOLLOW-UP LIST WITH TICK BOXES E2E: real page + real functions + emulators + the demo model + a fake Gmail');
  await page.click('#nav-assistant'); await page.waitForSelector('#assistant:not([hidden]), [data-view=assistant]:not([hidden])');
  const ask = async (text) => { for (const d of (await db.collection('aiRate').get()).docs) await d.ref.delete(); await page.fill('#as-input', text); await page.press('#as-input', 'Enter'); };
  const tick = (id) => page.locator(`#as-tray input[type=checkbox][data-id="${id}"]`);
  const approveText = () => page.locator('#as-tray .as-card-actions .btn-primary').first().innerText();
  const pending = async () => (await db.collection('aiProposals').get()).docs.map((d) => ({ id: d.id, ...d.data() }));

  // ------------------------------------------------------------------ 1. ONE card: both groups, how long it has been, ticked or not
  await ask('follow up list'); await page.waitForSelector('#as-tray .as-card[data-state=pending] .as-pick-row');
  const tray = await page.locator('#as-tray').innerText();
  assert.match(tray, /Follow up 5 customers/); assert.match(tray, /Quotes nobody answered \(3\)/i); assert.match(tray, /Leads who never replied \(2\)/i);
  assert.match(tray, /Jay Casey · EK-0103 · sent 23 days ago/); assert.match(tray, /John Byrne · EK-0102 · sent 15 days ago/); assert.match(tray, /Anne Apple · EK-0101 · sent 5 days ago/);
  assert.match(tray, /Pat Pending · arrived 9 days ago/); assert.match(tray, /Oona Oldwait · arrived 6 days ago/);
  assert.ok(tray.indexOf('Jay Casey') < tray.indexOf('John Byrne') && tray.indexOf('John Byrne') < tray.indexOf('Anne Apple'), 'oldest quote first');
  assert.equal(await page.locator('#as-tray .as-card').count(), 1, 'ONE card for everyone, not one per person'); assert.equal(await page.locator('#as-tray .as-pick-row').count(), 5);
  ok('one card lists both the quotes nobody answered and the leads who never replied, oldest first, with how many days it has been');
  assert.equal(await tick(`q:${qid(3)}`).isChecked(), true); assert.equal(await tick(`q:${qid(2)}`).isChecked(), true); assert.equal(await tick(`l:${PAT}`).isChecked(), true); assert.equal(await tick(`l:${OONA}`).isChecked(), true);
  assert.equal(await tick(`q:${qid(1)}`).isChecked(), false, 'Anne (5 days) starts unticked'); assert.match(await page.locator('#as-tray .as-pick-row', { hasText: 'Anne Apple' }).innerText(), /under 2 weeks/);
  assert.equal(await approveText(), 'Approve (4 of 5)'); await page.evaluate(() => { document.getElementById('as-tray').scrollTop = 0; }); await page.screenshot({ path: path.join(SHOTS, 'assistant-follow-up-list-first.png') }); ok('whoever meets the rules starts ticked; the quote under two weeks old starts unticked and says why; the button counts the ticks: Approve (4 of 5)');

  // ------------------------------------------------------------------ 2. the owner decides: tick Anne by hand (no waiting for day 14), untick Pat; tick none / all
  await tick(`q:${qid(1)}`).check(); assert.equal(await approveText(), 'Approve (5 of 5)'); await tick(`l:${PAT}`).uncheck(); assert.equal(await approveText(), 'Approve (4 of 5)');
  assert.equal(await page.locator('#as-tray button:has-text("Tick none")').count(), 2, 'one Tick all / Tick none under each group'); for (const b of await page.locator('#as-tray button:has-text("Tick none")').all()) await b.click(); assert.equal(await approveText(), 'Approve (0 of 5)'); assert.equal(await page.locator('#as-tray .as-card-actions .btn-primary').first().isDisabled(), true, 'nobody ticked: Approve is off');
  for (const b of await page.locator('#as-tray button:has-text("Tick all")').all()) await b.click(); assert.equal(await approveText(), 'Approve (5 of 5)'); await tick(`l:${PAT}`).uncheck(); await tick(`q:${qid(1)}`).check();
  assert.equal(await approveText(), 'Approve (4 of 5)'); assert.equal(await tick(`q:${qid(1)}`).isChecked(), true);
  ok('a quote under two weeks old can be ticked by hand; Tick all / Tick none work; with nobody ticked Approve is switched off');
  await page.waitForTimeout(1500); assert.equal(await tick(`q:${qid(1)}`).isChecked(), true, 'the ticks survive the screen redrawing itself'); assert.equal(await tick(`l:${PAT}`).isChecked(), false);

  // ------------------------------------------------------------------ 3. when to send
  assert.equal(await page.locator('#as-tray .as-when-row').count(), 3); assert.match(await page.locator('#as-tray .as-when').innerText(), /Send now[\s\S]*Send \w{3},? \d+ \w{3},? 09:00[\s\S]*Send at a time I choose/i);
  await page.locator('#as-tray .as-when-row', { hasText: 'Send at a time I choose' }).locator('input').check(); await page.waitForSelector('#as-tray input.as-when-time'); assert.match(await page.locator('#as-tray .as-when').innerText(), /never between midnight and 07:00[\s\S]*cancel/i);
  await page.screenshot({ path: path.join(SHOTS, 'assistant-follow-up-list-desktop.png') });
  await page.locator('#as-tray input[type=radio][value=morning]').check(); assert.equal(await page.locator('#as-tray input.as-when-time').count(), 0, 'the time box is only there when you choose your own time');
  ok('"When to send": now, the next 09:00 (named with its date) or a time you pick; a later time says it is never between midnight and 07:00 and can be cancelled');

  // ------------------------------------------------------------------ 4. a phone: the whole card fits the screen, nothing scrolls sideways
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(400);
  const fit = await page.evaluate(() => { const t = document.getElementById('as-tray'), b = t.querySelector('.as-card-actions .btn-primary').getBoundingClientRect(); return { sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth, bottom: b.bottom, h: innerHeight, trayW: t.scrollWidth - t.clientWidth }; });
  assert.ok(fit.sideways <= 1 && fit.trayW <= 1, 'nothing scrolls sideways on a phone: ' + JSON.stringify(fit)); assert.ok(fit.bottom <= fit.h + 1, 'the Approve button is on the screen on a phone: ' + JSON.stringify(fit));
  await page.evaluate(() => { document.getElementById('as-tray').scrollTop = 0; }); await page.screenshot({ path: path.join(SHOTS, 'assistant-follow-up-list-phone-top.png') });
  const rowH = await page.locator('#as-tray .as-pick-row').first().evaluate((e) => e.getBoundingClientRect().height); assert.ok(rowH >= 40, 'rows are big enough to tap: ' + rowH);
  await page.screenshot({ path: path.join(SHOTS, 'assistant-follow-up-list-phone.png') }); await page.setViewportSize({ width: 1360, height: 900 }); await page.waitForTimeout(300);
  ok('on a phone the card fits the screen, Approve stays in view, rows are finger-sized');

  // ------------------------------------------------------------------ 5. schedule it: nothing is sent; the card moves to "Scheduled"; Cancel stops it
  await page.click('#as-tray .as-card-actions .btn-primary'); await page.waitForSelector('#as-tray .as-card[data-state=scheduled]');
  const sch = await page.locator('#as-tray').innerText(); assert.match(sch, /Scheduled \(1\)/i); assert.match(sch, /Scheduled for \w{3}, \d+ \w{3},? 09:00: 4 emails\. Elite OS sends them then\./); assert.match(sch, /Cancel/); assert.equal(mails.length, 0, 'scheduling sends nothing');
  let p = (await pending())[0]; assert.deepEqual([p.status, p.selected.length, p.selected.includes(`l:${PAT}`)], ['scheduled', 4, false]); assert.ok(p.scheduledFor.toMillis() > Date.now(), 'the time is kept');
  await page.screenshot({ path: path.join(SHOTS, 'assistant-follow-up-list-scheduled.png') });
  await page.click('#as-tray button:has-text("Cancel")'); await page.waitForSelector('.as-card[data-state=cancelled]'); assert.match(await page.locator('.as-card[data-state=cancelled]').innerText(), /Cancelled: nothing was sent/);
  await page.waitForFunction(() => document.getElementById('as-tray').hidden); p = (await pending())[0]; assert.equal(p.status, 'cancelled'); assert.equal(mails.length, 0);
  ok('a later send waits (nothing goes out), shows as Scheduled with its time and the number of emails, and Cancel stops it');

  // ------------------------------------------------------------------ 6. send now: exactly the ticked people, once, and the card says so
  await ask('follow up list'); await page.waitForSelector('#as-tray .as-card[data-state=pending] .as-pick-row');
  assert.equal(await approveText(), 'Approve (4 of 5)', 'a fresh list starts from the rules again'); await tick(`q:${qid(1)}`).check(); await tick(`l:${PAT}`).uncheck(); await tick(`q:${qid(2)}`).uncheck(); assert.equal(await approveText(), 'Approve (3 of 5)');
  await page.locator('#as-tray .as-when-row', { hasText: 'Send now' }).locator('input').check();
  await page.click('#as-tray .as-card-actions .btn-primary'); await page.waitForSelector('.as-card[data-state=applied]'); await page.waitForFunction(() => document.getElementById('as-tray').hidden);
  assert.match(await page.locator('.as-card[data-state=applied]').last().innerText(), /Done: 3 emails were sent\./);
  assert.deepEqual(mails.map(toOf).sort(), ['anne@example.com', 'jay@example.com', 'oona@example.com'], 'Anne (5 days, ticked by hand), Jay and Oona: not John (unticked), not Pat (unticked)');
  const anne = mails.find((m) => toOf(m) === 'anne@example.com'); assert.match(anne, /^Subject: Your Elite Kitchens quote EK-0101/m); assert.ok(anne.includes('Hi Anne,'));
  assert.ok((await db.doc('conversations/' + ANNE).get()).data().quoteMail[qid(1)], 'Anne is recorded as followed up'); assert.equal((await db.doc('conversations/' + JOHN).get()).data().quoteMail, undefined, 'John was not emailed');
  assert.equal((await db.doc('conversations/' + PAT).get()).data().followUp, undefined, 'Pat was not emailed');
  await page.screenshot({ path: path.join(SHOTS, 'assistant-follow-up-list-done.png') });
  ok('Approve sends exactly the ticked people (a 5-day-old quote ticked by hand included), once, from the follow-up mailbox; the unticked are left alone and the card says how many went');

  // ------------------------------------------------------------------ 7. who is left: John and Pat come back on the next list, the three emailed do not
  await ask('follow up list'); await page.waitForSelector('#as-tray .as-card[data-state=pending] .as-pick-row'); const left = await page.locator('#as-tray').innerText();
  assert.match(left, /John Byrne/); assert.match(left, /Pat Pending/); assert.doesNotMatch(left, /Jay Casey|Anne Apple|Oona Oldwait/); assert.equal(await page.locator('#as-tray .as-pick-row').count(), 2);
  await page.click('#as-tray .as-card-actions .btn-ghost'); await page.waitForSelector('.as-card[data-state=rejected]'); assert.equal(mails.length, 3, 'Reject sends nothing');
  ok('the people left unticked are on the next list; the ones emailed are not; Reject sends nothing');

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | ')); ok('no console or page errors');
  await browser.close(); web.close(); gmail.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e, '\nPAGE ERRORS:', global.__errors); web.close(); gmail.close(); process.exit(1); });
