'use strict';
// Phase 12 browser test (docs/PHASE12_BOOKINGS.md): the evening-before reminder is automatic, so the screen has NO send button: booking a visit sends nothing and offers nothing. What the screen does show:
// "Reminder sent", a reminder WhatsApp refused, and a reminder WhatsApp gave no answer to (with "It arrived" / "It did not arrive"). And an installation date on a project is one calendar entry.
// Real page + real functions + emulators + a fake Meta that records every request: nothing real is ever contacted.
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getAuth } = fnRequire('firebase-admin/auth');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const ROOT = path.join(__dirname, '..');
assert.ok(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST, 'Demo emulators required');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
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
// A fake Google Calendar that accepts everything (the visit is saved first; the calendar only follows).
const calendar = http.createServer((req, res) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => {
  const body = c.length ? JSON.parse(Buffer.concat(c).toString()) : {}; res.statusCode = req.method === 'DELETE' ? 204 : 200; res.setHeader('content-type', 'application/json');
  res.end(req.method === 'DELETE' ? '' : JSON.stringify({ ...body, id: body.id || 'x', htmlLink: 'https://calendar.test/e' })); }); }).listen(9912);
calendar.keepAliveTimeout = 0;
// The fake Meta: records every request. The page must never cause one: the reminder is sent by the scheduled check, which does not run in this test.
const graph = [];
const meta = http.createServer((req, res) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => {
  graph.push(JSON.parse(Buffer.concat(c).toString() || '{}')); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ messages: [{ id: 'wamid.BKG' + graph.length }] })); }); }).listen(9911);
meta.keepAliveTimeout = 0;

const DAY = 86400000, H = 3600000, ago = (ms) => Timestamp.fromMillis(Date.now() - ms);
const dublin = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(new Date(ms));
const ph = { anna: '353860001001', dan: '353860001004', fiona: '353860001006', gina: '353860001007', hugh: '353860001008' };
const noticeDocId = (apptId, startMs) => 'n_' + crypto.createHash('sha256').update(`${apptId}|reminder|${startMs}`).digest('hex').slice(0, 24);

(async () => {
  initializeApp({ projectId: 'demo-leados' });
  const db = getFirestore();
  const seed = async (id, name, conv = {}) => {
    await db.doc('conversations/' + id).set({ phone: id, name, location: 'Swords', createdAt: ago(10 * DAY), updatedAt: ago(H), lastMessage: 'Hi', lastMessageDirection: 'in', unreadCount: 0, lastInboundAt: ago(H), ...conv });
    await db.doc('contacts/' + id).set({ phone: id, name, location: 'Swords', createdAt: ago(10 * DAY) });
  };
  for (const [k, name] of [['anna', 'Anna Murphy'], ['dan', 'Dan Walsh'], ['fiona', 'Fiona Flynn'], ['gina', 'Gina Gill'], ['hugh', 'Hugh Hayes']]) await seed(ph[k], name);
  const apptsOf = async (p) => (await db.collection('appointments').where('phone', '==', p).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  // visits made directly in the database, one for each thing the screen can say about a reminder (they start tomorrow at the times given)
  const tomorrow = Date.now() + DAY, key = dublin(tomorrow).split('-').map(Number);
  const at = (hh) => { const guess = Date.UTC(key[0], key[1] - 1, key[2], hh, 0), shown = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'Europe/Dublin' })).getTime(), utc = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'UTC' })).getTime(); return guess - (shown - utc); };      // hh o'clock Irish time, summer or winter
  const mk = async (key, phone, name, hh, extra = {}) => {
    const id = 'a_' + crypto.createHash('sha256').update('e2e|' + key).digest('hex').slice(0, 24), start = at(hh);
    await db.doc('appointments/' + id).set({ phone, customerName: name, type: 'consultation', start: Timestamp.fromMillis(start), end: Timestamp.fromMillis(start + H), durationMin: 60, timeZone: 'Europe/Dublin', location: null, notes: null, status: 'scheduled', version: 1,
      createdAt: ago(3 * DAY), createdBy: { kind: 'staff', id: 'x' }, updatedAt: ago(3 * DAY), updatedBy: { kind: 'staff', id: 'x' }, history: [], sync: { google: { state: 'off' } }, ...extra });
    return { id, start };
  };
  const hugh = await mk('hugh', ph.hugh, 'Hugh Hayes', 9, { visitReminder: { for: at(9), at: Date.now() - H, wamid: 'wamid.X' } });
  const danV = await mk('dan', ph.dan, 'Dan Walsh', 10, { noticeIssue: { kind: 'reminder', state: 'failed', text: "WhatsApp doesn't know this template. It may not be approved yet. (code 132001)", at: Date.now() - H } });
  const fionaV = await mk('fiona', ph.fiona, 'Fiona Flynn', 11, { noticeIssue: { kind: 'reminder', state: 'unknown', text: 'x', at: Date.now() - H } });
  const ginaV = await mk('gina', ph.gina, 'Gina Gill', 12, { noticeIssue: { kind: 'reminder', state: 'unknown', text: 'x', at: Date.now() - H } });
  for (const [v, phone] of [[fionaV, ph.fiona], [ginaV, ph.gina]]) await db.doc('bookingNotices/' + noticeDocId(v.id, v.start)).set({ phone, appointmentId: v.id, kind: 'reminder', key: v.id + '|reminder|' + v.start, state: 'unknown', mode: 'text', template: null, startMs: v.start, by: 'auto', claimedAt: ago(H), sentAt: null, wamid: null, error: 'Not confirmed', errorCode: null, tries: 1 });

  const u = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true });
  const token = await getAuth().createCustomToken(u.uid);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const waitMsg = (re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('d-appts-msg').textContent), re.source);
  console.log('VISIT REMINDER E2E: real page + real functions + emulators + fake Meta');
  await page.goto('http://127.0.0.1:5055/');
  await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await page.waitForSelector('#app:not([hidden])'); await page.evaluate(() => { if (location.hash === '#today') location.hash = ''; });
  await page.waitForSelector(`.conv[data-phone="${ph.anna}"]`);

  // ---- booking a visit sends nothing and offers nothing ----
  await page.locator(`.conv[data-phone="${ph.anna}"]`).click(); await page.waitForSelector('#details:not([hidden])');
  await page.waitForFunction(() => !/Loading/.test(document.getElementById('d-appts-list').textContent));
  await page.click('#d-appt-new'); await page.waitForSelector('#appt-dlg[open]'); await page.selectOption('#a-time', '10:30'); await page.click('#a-go'); await waitMsg(/Booked for/);
  assert.equal(await page.locator('#d-appts-msg button').count(), 0, 'no button next to "Booked for ..."');
  assert.equal(await page.locator('#d-appts-list .appt-notice').count(), 0, 'nothing is said about a reminder on a fresh booking');
  assert.equal(await page.locator('#appt-notice-dlg').count(), 0, 'the confirmation window no longer exists');
  assert.equal((await apptsOf(ph.anna)).length, 1);
  await page.click('#d-appts-list .d-appt-reschedule'); await page.waitForSelector('#appt-dlg[open]'); await page.selectOption('#a-time', '14:00'); await page.click('#a-go'); await waitMsg(/Rescheduled for/);
  await page.click('#d-appts-list .d-appt-cancel'); await page.waitForSelector('#appt-cancel-dlg[open]'); await page.click('#ac-go'); await waitMsg(/Appointment cancelled/);
  assert.equal(await page.locator('#d-appts-msg button').count(), 0, 'moving and cancelling offer nothing either');
  assert.equal(graph.length, 0, 'booking, moving and cancelling send nothing to the customer');
  ok('booking, moving and cancelling a visit send nothing and offer no button (the reminder is automatic)');

  // ---- what the Appointments list says about each reminder ----
  await page.click('#nav-appointments'); await page.click('#appts-view button[data-view="list"]'); await page.waitForSelector('#appts-list:not([hidden])');
  const row = (v) => page.locator(`.arow[data-id="${v.id}"]`);
  await row(hugh).waitFor();
  assert.match(await row(hugh).locator('.appt-notice').innerText(), /^Reminder sent\.$/);
  assert.match(await row(danV).locator('.appt-notice').innerText(), /^The reminder could not be sent: WhatsApp doesn't know this template/);
  assert.equal(await row(danV).locator('.appt-notice button').count(), 0, 'a refusal has no button: message the customer yourself');
  assert.match(await row(fionaV).locator('.appt-notice').innerText(), /WhatsApp did not say whether the reminder arrived\. Check the chat\./);
  assert.deepEqual(await row(fionaV).locator('.appt-notice button').allInnerTexts(), ['It arrived', 'It did not arrive']);
  ok('the list says "Reminder sent", why a reminder could not be sent, and offers It arrived / It did not arrive only when WhatsApp gave no answer');

  // ---- "It arrived" and "It did not arrive" ----
  await row(fionaV).locator('button[data-outcome="arrived"]').click();
  await page.waitForFunction(() => /Recorded: the customer was reminded\./.test(document.getElementById('appts-toast').textContent));
  await page.waitForFunction((id) => /^Reminder sent\.$/.test((document.querySelector(`.arow[data-id="${id}"] .appt-notice`) || {}).textContent || ''), fionaV.id);
  const f = (await db.doc('appointments/' + fionaV.id).get()).data(); assert.equal(f.noticeIssue, undefined); assert.equal(f.visitReminder.for, fionaV.start);
  assert.equal((await db.doc('bookingNotices/' + noticeDocId(fionaV.id, fionaV.start)).get()).data().state, 'sent');
  await row(ginaV).locator('button[data-outcome="notArrived"]').click();
  await page.waitForFunction(() => /Recorded: it did not arrive\./.test(document.getElementById('appts-toast').textContent));
  await page.waitForFunction((id) => !document.querySelector(`.arow[data-id="${id}"] .appt-notice`), ginaV.id);
  const g = (await db.doc('appointments/' + ginaV.id).get()).data(); assert.equal(g.noticeIssue, undefined); assert.equal(g.visitReminder, undefined);
  assert.equal((await db.doc('bookingNotices/' + noticeDocId(ginaV.id, ginaV.start)).get()).data().state, 'failed', 'the next check may try again');
  assert.equal(graph.length, 0, 'pressing either button sends nothing');
  ok('"It arrived" records the visit as reminded; "It did not arrive" lets the next check try again; neither sends anything');

  // ---- no send item anywhere ----
  await row(hugh).locator('.arow-menu').click();
  assert.equal((await page.locator('.appt-menu button').allInnerTexts()).some((t) => /Send|confirm|new time/i.test(t)), false, 'the visit menu has no send item');
  await page.keyboard.press('Escape');
  ok('the visit menu has no message item');

  // ---- an installation date on a project is one entry in the calendar ----
  await page.evaluate(() => { location.hash = ''; }); await page.waitForSelector(`.conv[data-phone="${ph.dan}"]`);
  const PID = 'm_' + 'cd'.repeat(12), blank = () => Object.fromEntries(['designApproved', 'carcassesOrdered', 'doorsOrdered', 'readyForInstall', 'installed'].map((k) => [k, { done: false, at: null, by: null }]));
  await db.doc('projects/' + PID).set({ phone: ph.dan, customerName: 'Dan Walsh', quoteId: null, quoteRef: null, quoteOption: null, quoteStatus: null, status: 'active', steps: blank(), installDate: null, notes: null, render: null, rev: 1, createdVia: 'manual', createdAt: Timestamp.now(), createdBy: { kind: 'staff', id: 'x' }, completedAt: null, completedBy: null, updatedAt: Timestamp.now(), updatedBy: { kind: 'staff', id: 'x' }, history: [] });
  await page.evaluate((id) => { location.hash = '#projects/' + id; }, PID);
  await page.waitForSelector('#pj-date'); await page.waitForFunction(() => /Dan Walsh/.test(document.getElementById('pj-project-view').textContent)); await new Promise((r) => setTimeout(r, 600));
  await page.fill('#pj-date', dublin(Date.now() + DAY)); await page.click('#pj-save');
  await page.waitForFunction(() => /Saved\. In the calendar: .*08:00 to 16:00\./.test(document.getElementById('pj-save-msg').textContent));
  const saveMsg = await page.textContent('#pj-save-msg'); assert.match(saveMsg, /Heads up: it overlaps .*Dan Walsh at 10:00/, 'a clash is a warning: ' + saveMsg);
  const inst = (await apptsOf(ph.dan)).filter((a) => a.type === 'installation'); assert.equal(inst.length, 1); assert.equal(inst[0].projectId, PID);
  await page.click('#nav-appointments'); await page.click('#appts-view button[data-view="list"]'); await page.waitForSelector('#appts-list:not([hidden])');
  const irow = page.locator('.arow', { hasText: 'Installation' }); await irow.first().waitFor();
  assert.equal(await irow.first().locator('.appt-notice').count(), 0, 'an installation is never messaged');
  await irow.first().locator('.arow-menu').click();
  await page.locator('.appt-menu button', { hasText: 'Edit appointment' }).click(); await page.waitForSelector('#appt-dlg[open]');
  assert.equal(await page.inputValue('#a-type'), 'installation', 'editing it keeps its type'); await page.click('#a-cancel');
  assert.equal(graph.length, 0, 'nothing is sent to the customer about an installation');
  ok('an installation date makes one calendar entry (with a clash warning); it offers no customer message, and editing it keeps its type');

  // ---- the phone ----
  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => { location.hash = ''; });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scrolling on a phone');
  await page.screenshot({ path: path.join(SHOTS, 'booking-phone.png') });
  ok('no sideways scrolling on a phone');

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | '));
  await browser.close(); web.close(); calendar.close(); meta.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.stack || e.message || e); process.exit(1); });
