'use strict';
// Phase 12 browser test: the messages about a visit (docs/PHASE12_BOOKINGS_PLAN.md). Real page + real functions + emulators + a fake Meta (no real message is ever sent).
// A person books a visit, presses "Send confirmation", moves it and presses "Send the new time", cancels it and presses "Send cancellation message". Outside the 24-hour window the approved template is used.
// A customer who said stop gets no button. A refusal by WhatsApp is shown and can be retried. Nothing goes without a button press.
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
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
// The fake Meta: records every request; answers "refused" while refuseFor matches the customer.
const graph = []; let refuseFor = null, silentFor = null;
const meta = http.createServer((req, res) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => {
  const body = JSON.parse(Buffer.concat(c).toString() || '{}'); graph.push(body); res.setHeader('content-type', 'application/json');
  if (silentFor && body.to === silentFor) { res.statusCode = 500; return res.end(JSON.stringify({ error: { code: 1, message: 'Unknown error' } })); }
  if (refuseFor && body.to === refuseFor) { res.statusCode = 400; return res.end(JSON.stringify({ error: { code: 132001, message: 'Template name does not exist in the translation' } })); }
  res.end(JSON.stringify({ messages: [{ id: 'wamid.BKG' + graph.length }] })); }); }).listen(9911);
meta.keepAliveTimeout = 0;

const DAY = 86400000, H = 3600000, ago = (ms) => Timestamp.fromMillis(Date.now() - ms);
const dublin = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(new Date(ms));
const ph = { anna: '353860001001', brian: '353860001002', cara: '353860001003', dan: '353860001004', fiona: '353860001006' };

(async () => {
  initializeApp({ projectId: 'demo-leados' });
  const db = getFirestore();
  const seed = async (id, name, conv = {}) => {
    await db.doc('conversations/' + id).set({ phone: id, name, location: 'Swords', createdAt: ago(10 * DAY), updatedAt: ago(H), lastMessage: 'Hi', lastMessageDirection: 'in', unreadCount: 0, ...conv });
    await db.doc('contacts/' + id).set({ phone: id, name, location: 'Swords', createdAt: ago(10 * DAY) });
  };
  await seed(ph.anna, 'Anna Murphy', { lastInboundAt: ago(H) });                                                   // wrote an hour ago: the window is open
  await seed(ph.brian, 'Brian Kelly', { lastInboundAt: ago(3 * DAY) });                                            // wrote 3 days ago: only a template can go
  await seed(ph.cara, 'Cara Doyle', { lastInboundAt: ago(H), doNotContact: { on: true, at: Timestamp.now(), by: 'staff', source: 'staff', note: null } });
  await seed(ph.dan, 'Dan Walsh', { lastInboundAt: ago(H) });
  await seed(ph.fiona, 'Fiona Flynn', { lastInboundAt: ago(H) });
  const apptsOf = async (p) => (await db.collection('appointments').where('phone', '==', p).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const u = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true });
  const token = await getAuth().createCustomToken(u.uid);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const msg = () => page.textContent('#d-appts-msg');
  const waitMsg = (re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('d-appts-msg').textContent), re.source);
  const openCustomer = async (p) => { await page.locator(`.conv[data-phone="${p}"]`).click(); await page.waitForSelector('#details:not([hidden])'); await page.waitForFunction(() => !/Loading/.test(document.getElementById('d-appts-list').textContent)); };
  const book = async (time = '10:30') => { await page.click('#d-appt-new'); await page.waitForSelector('#appt-dlg[open]'); await page.selectOption('#a-time', time); await page.click('#a-go'); await waitMsg(/Booked for/); };
  console.log('BOOKING MESSAGES E2E: real page + real functions + emulators + fake Meta');
  await page.goto('http://127.0.0.1:5055/');
  await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await page.waitForSelector('#app:not([hidden])'); await page.evaluate(() => { if (location.hash === '#today') location.hash = ''; });
  await page.waitForSelector(`.conv[data-phone="${ph.anna}"]`);

  // ---- confirmation (window open: a normal message) ----
  await openCustomer(ph.anna);
  await book('10:30');
  assert.equal(await page.locator('#d-appts-msg .appt-notice-go').innerText(), 'Send confirmation…', 'the button sits next to "Booked for ..."');
  assert.equal(graph.length, 0, 'booking sends nothing by itself');
  assert.match(await page.locator('#d-appts-list .appt-notice').innerText(), /The customer has not been told yet\./);
  await page.click('#d-appts-msg .appt-notice-go');
  await page.waitForSelector('#appt-notice-dlg[open]');
  assert.equal(await page.textContent('#an-title'), 'Send confirmation');
  assert.match(await page.textContent('#an-text'), /Send Anna Murphy a WhatsApp confirmation of their consultation on tomorrow at 10:30\?/);
  assert.equal(await page.textContent('#an-how'), 'It will go as a normal WhatsApp message.');
  await page.click('#an-go');
  await waitMsg(/Message sent to Anna Murphy\./);
  assert.equal(graph.length, 1); assert.equal(graph[0].to, ph.anna); assert.equal(graph[0].type, 'text');
  const tomorrow = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(Date.now() + DAY)).replace(',', '');
  assert.equal(graph[0].text.body, `Hi Anna, your consultation with Elite Kitchens is confirmed for ${tomorrow} at 10:30. We will call out to you in Swords. If you need to change the time, just reply to this message and we will sort it out. Thank you!`);
  await page.waitForFunction(() => /The customer was told\./.test(document.getElementById('d-appts-list').textContent));
  assert.equal(await page.locator('#d-appts-list .appt-notice-go').count(), 0, 'the button is gone once the customer was told');
  const a1 = (await apptsOf(ph.anna))[0]; assert.equal(a1.customerNotice.kind, 'confirmation');
  ok('booking sends nothing; the button sends one confirmation as a normal message with the right words; the visit then says the customer was told');

  // ---- change ----
  await page.click('#d-appts-list .d-appt-reschedule'); await page.waitForSelector('#appt-dlg[open]');
  await page.selectOption('#a-time', '14:00'); await page.click('#a-go'); await waitMsg(/Rescheduled for/);
  assert.equal(await page.locator('#d-appts-msg .appt-notice-go').innerText(), 'Send the new time…');
  assert.match(await page.locator('#d-appts-list .appt-notice').innerText(), /told a different time/);
  await page.click('#d-appts-msg .appt-notice-go'); await page.waitForSelector('#appt-notice-dlg[open]');
  assert.equal(await page.textContent('#an-title'), 'Tell the customer the new time'); assert.match(await page.textContent('#an-text'), /is now tomorrow at 14:00\?/);
  await page.click('#an-go'); await waitMsg(/Message sent to Anna Murphy\./);
  assert.equal(graph.length, 2); assert.match(graph[1].text.body, /^Hi Anna, an update on your consultation with Elite Kitchens: it is now on .* at 14:00\. /);
  ok('moving a told visit offers "Send the new time"; one change message goes with the new time');

  // ---- cancellation ----
  await page.click('#d-appts-list .d-appt-cancel'); await page.waitForSelector('#appt-cancel-dlg[open]'); await page.click('#ac-go'); await waitMsg(/Appointment cancelled/);
  assert.equal(await page.locator('#d-appts-msg .appt-notice-go').innerText(), 'Send cancellation message…');
  await page.click('#d-appts-msg .appt-notice-go'); await page.waitForSelector('#appt-notice-dlg[open]');
  assert.match(await page.textContent('#an-text'), /was cancelled\?/);
  await page.click('#an-go'); await waitMsg(/Message sent to Anna Murphy\./);
  assert.equal(graph.length, 3); assert.match(graph[2].text.body, /it has been cancelled\./);
  assert.equal((await apptsOf(ph.anna))[0].customerNotice.kind, 'cancellation');
  ok('cancelling a told visit offers "Send cancellation message"; one message goes');

  // ---- the window is closed: the approved template ----
  await openCustomer(ph.brian);
  await book('11:00'); await page.click('#d-appts-msg .appt-notice-go'); await page.waitForSelector('#appt-notice-dlg[open]');
  assert.match(await page.textContent('#an-how'), /more than 24 hours ago, so it will go as the approved WhatsApp message template/);
  await page.click('#an-go'); await waitMsg(/Message sent to Brian Kelly \(as the approved WhatsApp template\)\./);
  assert.equal(graph.length, 4); assert.equal(graph[3].type, 'template'); assert.equal(graph[3].template.name, 'elite_kitchens_consultation_confirmed');
  assert.deepEqual(graph[3].template.components[0].parameters.map((x) => x.text), ['Brian', 'consultation', tomorrow, '11:00', 'Swords']);
  ok('outside the 24-hour window it goes as the approved template with the five values');

  // ---- a customer who said stop ----
  await openCustomer(ph.cara);
  await book('12:00');
  assert.equal(await page.locator('#d-appts-msg .appt-notice-go').count(), 0, 'no button after booking');
  assert.equal(await page.locator('#d-appts-list .appt-notice-go').count(), 0);
  assert.match(await page.locator('#d-appts-list .appt-notice').innerText(), /asked not to be contacted/);
  assert.equal(graph.length, 4);
  ok('a customer who asked not to be contacted gets no button, and no message');

  // ---- WhatsApp refuses: shown, retried, sent once ----
  await openCustomer(ph.dan);
  await book('15:00'); refuseFor = ph.dan;
  await page.click('#d-appts-msg .appt-notice-go'); await page.waitForSelector('#appt-notice-dlg[open]'); await page.click('#an-go');
  await page.waitForFunction(() => /doesn't know this template/.test(document.getElementById('an-err').textContent));
  assert.equal(await page.locator('#appt-notice-dlg[open]').count(), 1, 'the window stays open so it can be tried again');
  assert.equal(await page.isDisabled('#an-go'), false);
  assert.equal((await apptsOf(ph.dan))[0].customerNotice, undefined, 'the customer was NOT recorded as told');
  refuseFor = null; const before = graph.length;
  await page.click('#an-go'); await waitMsg(/Message sent to Dan Walsh\./);
  assert.equal(graph.length, before + 1);
  assert.equal((await apptsOf(ph.dan))[0].customerNotice.kind, 'confirmation');
  ok('a refusal is shown in plain words, the visit is not marked as told, and a retry sends exactly one message');

  // ---- the Appointments screen: the menu and the visit detail ----
  await seed('353860001005', 'Eve Byrne', { lastInboundAt: ago(H) });
  const e = await db.collection('appointments').add({ phone: '353860001005', customerName: 'Eve Byrne', type: 'site_visit', start: Timestamp.fromMillis(Date.now() + 2 * DAY), end: Timestamp.fromMillis(Date.now() + 2 * DAY + H), durationMin: 60, status: 'scheduled', version: 1, createdAt: Timestamp.now(), updatedAt: Timestamp.now(), history: [], sync: { google: { state: 'off' } } });
  await page.click('#nav-appointments');
  await page.click('#appts-view button[data-view="list"]'); await page.waitForSelector('#appts-list:not([hidden])');
  const entry = page.locator(`.arow[data-id="${e.id}"]`); await entry.waitFor();
  assert.match(await entry.locator('.appt-notice').innerText(), /The customer has not been told yet\./);
  assert.equal(await entry.locator('.appt-notice-go').innerText(), 'Send confirmation');
  ok('the Appointments list shows what the customer knows and the button on a visit that was never confirmed');
  await entry.locator('.arow-menu').click(); assert.ok((await page.locator('.appt-menu button').allInnerTexts()).includes('Send confirmation…'), 'the visit menu offers it too'); await page.keyboard.press('Escape');

  // ---- WhatsApp gives no answer: never sent again by itself; a person says what happened ----
  await page.click('#nav-inbox').catch(() => {}); await page.evaluate(() => { location.hash = ''; });
  await page.waitForSelector('.conv[data-phone="' + ph.fiona + '"]');
  await openCustomer(ph.fiona);
  await book('16:30'); silentFor = ph.fiona;
  await page.click('#d-appts-msg .appt-notice-go'); await page.waitForSelector('#appt-notice-dlg[open]'); await page.click('#an-go');
  await page.waitForFunction(() => /Not confirmed/.test(document.getElementById('an-err').textContent));
  const silentSent = graph.length; silentFor = null;
  await page.click('#an-later');
  await page.waitForFunction(() => /did not say whether the last message to the customer arrived/.test(document.getElementById('d-appts-list').textContent));
  assert.equal(await page.locator('#d-appts-list .appt-notice-go[data-outcome="arrived"]').innerText(), 'It arrived');
  assert.equal(await page.locator('#d-appts-list .appt-notice-go[data-kind]').count(), 0, 'no send button while it is unconfirmed');
  await page.click('#d-appts-list .appt-notice-go[data-outcome="notArrived"]');
  await page.waitForFunction(() => /Recorded: it did not arrive\. You can send it again\./.test(document.getElementById('d-appts-msg').textContent));
  await page.waitForFunction(() => !!document.querySelector('#d-appts-list .appt-notice-go[data-kind="confirmation"]'));
  assert.equal(graph.length, silentSent, 'pressing "it did not arrive" sends nothing');
  await page.click('#d-appts-list .appt-notice-go[data-kind="confirmation"]'); await page.waitForSelector('#appt-notice-dlg[open]'); await page.click('#an-go');
  await waitMsg(/Message sent to Fiona Flynn\./);
  assert.equal(graph.length, silentSent + 1); assert.equal((await apptsOf(ph.fiona))[0].customerNotice.kind, 'confirmation'); assert.equal((await apptsOf(ph.fiona))[0].noticeIssue, undefined);
  ok('a message WhatsApp gave no answer to is never repeated by itself; the visit says so with "It arrived" / "It did not arrive"; saying it did not arrive lets it be sent once more');

  // ---- an installation date on a project is one entry in the calendar ----
  const PID = 'm_' + 'cd'.repeat(12), blank = () => Object.fromEntries(['designApproved', 'carcassesOrdered', 'doorsOrdered', 'readyForInstall', 'installed'].map((k) => [k, { done: false, at: null, by: null }]));
  await db.doc('projects/' + PID).set({ phone: ph.dan, customerName: 'Dan Walsh', quoteId: null, quoteRef: null, quoteOption: null, quoteStatus: null, status: 'active', steps: blank(), installDate: null, notes: null, render: null, rev: 1, createdVia: 'manual', createdAt: Timestamp.now(), createdBy: { kind: 'staff', id: 'x' }, completedAt: null, completedBy: null, updatedAt: Timestamp.now(), updatedBy: { kind: 'staff', id: 'x' }, history: [] });
  await page.evaluate((id) => { location.hash = '#projects/' + id; }, PID);
  await page.waitForSelector('#pj-date'); await page.waitForFunction(() => /Dan Walsh/.test(document.getElementById('pj-project-view').textContent)); await new Promise((r) => setTimeout(r, 600));
  const sentBefore = graph.length;
  await page.fill('#pj-date', dublin(Date.now() + DAY)); await page.click('#pj-save');
  await page.waitForFunction(() => /Saved\. In the calendar: .*08:00 to 16:00\./.test(document.getElementById('pj-save-msg').textContent));
  const saveMsg = await page.textContent('#pj-save-msg'); assert.match(saveMsg, /Heads up: it overlaps .*Dan Walsh at 15:00\./, 'a clash is a warning: ' + saveMsg);
  const inst = (await apptsOf(ph.dan)).filter((a) => a.type === 'installation'); assert.equal(inst.length, 1); assert.equal(inst[0].projectId, PID);
  assert.equal(graph.length, sentBefore, 'nothing is sent to the customer about an installation');
  await page.click('#nav-appointments'); await page.click('#appts-view button[data-view="list"]'); await page.waitForSelector('#appts-list:not([hidden])');
  const irow = page.locator('.arow', { hasText: 'Installation' }); await irow.first().waitFor();
  assert.equal(await irow.first().locator('.appt-notice').count(), 0, 'no message is ever offered for an installation');
  await irow.first().locator('.arow-menu').click();
  assert.equal((await page.locator('.appt-menu button').allInnerTexts()).some((t) => /Send/.test(t)), false);
  await page.locator('.appt-menu button', { hasText: 'Edit appointment' }).click(); await page.waitForSelector('#appt-dlg[open]');
  assert.equal(await page.inputValue('#a-type'), 'installation', 'editing it keeps its type'); await page.click('#a-cancel');
  ok('an installation date makes one calendar entry (with a clash warning), the entry offers no customer message, and editing it keeps its type');

  // ---- the phone ----
  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => { location.hash = ''; });
  await openCustomer(ph.brian).catch(() => {});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scrolling on a phone');
  await page.screenshot({ path: path.join(SHOTS, 'booking-phone.png') });
  ok('no sideways scrolling on a phone');

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | '));
  await browser.close(); web.close(); calendar.close(); meta.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.stack || e.message || e); process.exit(1); });
