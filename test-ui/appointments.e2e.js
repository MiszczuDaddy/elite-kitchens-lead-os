'use strict';
// Phase 5 browser test: booking from the customer profile, the Appointments screen, reschedule, cancel, Google Calendar status
// (with a local fake Google Calendar - no real Google account is contacted), and the phone layout.
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getAuth } = fnRequire('firebase-admin/auth');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
}).listen(5055);

// A fake Google Calendar (the functions emulator is pointed at it by GCAL_API_BASE in test-ui/run.sh).
const cal = { events: new Map(), down: false };
const calendar = http.createServer((req, res) => {
  const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => {
    const send = (s, o) => { res.statusCode = s; res.setHeader('content-type', 'application/json'); res.end(o ? JSON.stringify(o) : ''); };
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/?]+))?/.exec(req.url);
    if (req.headers.authorization !== 'Bearer emulator-token') return send(401, { error: { message: 'bad token' } });
    if (cal.down) return send(503, { error: { message: 'backend error' } });
    if (!m) return send(404, {});
    const body = c.length ? JSON.parse(Buffer.concat(c).toString()) : null, id = m[2] && decodeURIComponent(m[2]), e = id && cal.events.get(id);
    const link = (i) => 'https://calendar.test/event?eid=' + i;
    if (req.method === 'POST') { if (cal.events.has(body.id)) return send(409, { error: { message: 'exists' } }); const ev = { ...body, htmlLink: link(body.id) }; cal.events.set(body.id, ev); return send(200, ev); }
    if (!e) return send(404, { error: { message: 'Not Found' } });
    if (req.method === 'GET') return send(200, e);
    if (req.method === 'PUT') { const ev = { ...body, id, htmlLink: link(id) }; cal.events.set(id, ev); return send(200, ev); }
    if (req.method === 'PATCH') { Object.assign(e, body); return send(200, e); }
    if (req.method === 'DELETE') { if (e.status === 'cancelled') return send(410, {}); e.status = 'cancelled'; return send(204); }
    send(405, {});
  });
}).listen(9912);
calendar.keepAliveTimeout = 0;
const live = () => [...cal.events.values()].filter((e) => e.status !== 'cancelled');
const evFor = (phone) => live().filter((e) => e.description.includes('/#c/' + phone));

const DAY = 86400000, ago = (d) => Timestamp.fromMillis(Date.now() - d * DAY);
const dublin = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(new Date(ms));
const D1 = dublin(Date.now() + DAY), D2 = dublin(Date.now() + 2 * DAY);
const ph = { lead: '353860000001', quoted: '353860000002', closed: '353860000003' };

(async () => {
  initializeApp({ projectId: 'demo-leados' });
  const db = getFirestore();
  const seed = async (id, conv, contact) => {
    await db.doc('conversations/' + id).set({ phone: id, name: contact.name, createdAt: ago(10), updatedAt: ago(1), lastMessage: 'Hi', unreadCount: 0, ...conv });
    await db.doc('contacts/' + id).set({ phone: id, createdAt: ago(10), ...contact });
  };
  await seed(ph.lead, {}, { name: 'Lena Lead', location: 'Swords' });                                                       // New lead (no status at all)
  await seed(ph.quoted, { inboxStatus: 'quoted', stageDates: { quoted: ago(4) } }, { name: 'Quinn Quoted', location: 'Malahide' });
  await seed(ph.closed, { inboxStatus: 'closed', stageDates: { closed: ago(6) } }, { name: 'Cathal Closed' });
  const apptsOf = async (p) => (await db.collection('appointments').where('phone', '==', p).get()).docs.map((d) => ({ id: d.id, ...d.data() }));

  const u = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true });
  const token = await getAuth().createCustomToken(u.uid);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const row = (p) => page.locator(`.arow[data-phone="${p}"]`);
  const custMsg = (re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('d-appts-msg').textContent), re.source);
  console.log('APPOINTMENTS E2E: real page + real functions + emulators + fake Google Calendar');
  await page.goto('http://127.0.0.1:5055/');
  await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await page.waitForSelector('#app:not([hidden])');

  // ---- rail ----
  assert.equal(await page.locator('#nav-appointments').innerText(), 'Appointments');
  await page.click('.nav-future summary');
  assert.doesNotMatch(await page.locator('.planned-areas').innerText(), /Appointments/);
  assert.match(await page.locator('.planned-areas').innerText(), /Quotes/);
  ok('the rail has Appointments; it is no longer listed under "Coming later"');

  // ---- book a New lead from the customer profile ----
  await page.locator(`.conv[data-phone="${ph.lead}"]`).click();
  await page.waitForSelector('#details:not([hidden])');
  await page.waitForFunction(() => /No upcoming appointments/.test(document.getElementById('d-appts-list').textContent));
  await page.click('#d-appt-new');
  await page.waitForSelector('#appt-dlg[open]');
  assert.equal(await page.inputValue('#a-date'), D1);
  assert.equal(await page.inputValue('#a-time'), '10:00'); assert.equal(await page.inputValue('#a-duration'), '60');
  assert.equal(await page.inputValue('#a-type'), 'consultation');
  await page.waitForFunction(() => document.getElementById('a-location').value === 'Swords');      // prefilled from the customer (even if their details were still loading)
  assert.deepEqual(await page.locator('#a-type option').allInnerTexts(), ['Consultation', 'Site visit', 'Other']);
  const times = await page.locator('#a-time option').allInnerTexts();
  assert.ok(times.includes('10:15') && times.includes('10:30') && !times.includes('10:10'), '15-minute steps');
  await page.selectOption('#a-time', '10:30');
  await page.fill('#a-location', '12 Main St, Swords'); await page.fill('#a-notes', 'Dog in the garden');
  await page.click('#a-go');
  await custMsg(/moved to Booked/);
  assert.match(await page.textContent('#d-appts-msg'), /Booked for tomorrow at 10:30\. Lena Lead moved to Booked\. Added to Google Calendar\./);
  await page.waitForFunction(() => document.getElementById('conversation-status').value === 'booked');
  await page.waitForSelector('#d-appts-list .d-appt');
  assert.match(await page.locator('#d-appts-list .d-appt').innerText(), /Tomorrow, 10:30–11:30/);
  assert.equal(await page.locator('#d-appts-list .sync').innerText(), 'In Google Calendar');
  assert.equal(await page.locator('#d-appts-list .sync-open').innerText(), 'Open in Google Calendar');
  const conv = (await db.doc('conversations/' + ph.lead).get()).data();
  assert.equal(conv.inboxStatus, 'booked'); assert.ok(conv.stageDates.booked);
  assert.equal(evFor(ph.lead).length, 1);
  const ev = evFor(ph.lead)[0];
  assert.equal(ev.summary, 'Consultation – Lena Lead'); assert.equal(ev.location, '12 Main St, Swords');
  assert.match(ev.description, /\+353 86 000 0001/); assert.equal(JSON.stringify(ev).includes('Dog'), false);
  await page.screenshot({ path: path.join(SHOTS, 'appointments-profile.png') });
  ok('booking a New lead from Details: 15-minute times, 60-minute default, moves them to Booked, and creates one Google event (name, phone, location; no notes)');

  // ---- Quoted and Closed customers are not disturbed ----
  const bookFor = async (phone, filter, { date, time } = {}) => {
    await page.click(`#status-filters button[data-status="${filter}"]`);
    await page.locator(`.conv[data-phone="${phone}"]`).click();
    await page.waitForFunction(() => /No upcoming appointments/.test(document.getElementById('d-appts-list').textContent));
    await page.click('#d-appt-new'); await page.waitForSelector('#appt-dlg[open]');
    if (date) await page.fill('#a-date', date);
    if (time) await page.selectOption('#a-time', time);
    await page.click('#a-go');
  };
  await bookFor(ph.quoted, 'quoted');
  await custMsg(/stays in Quoted/);
  assert.equal((await db.doc('conversations/' + ph.quoted).get()).data().inboxStatus, 'quoted');
  await bookFor(ph.closed, 'closed', { date: D2, time: '09:00' });
  await custMsg(/stays in Closed/);
  assert.equal((await db.doc('conversations/' + ph.closed).get()).data().inboxStatus, 'closed');
  await page.click('#d-appt-new'); await page.waitForSelector('#appt-dlg[open]');
  await page.click('#a-cancel');
  assert.equal(await page.locator('#appt-dlg[open]').count(), 0);
  assert.equal((await apptsOf(ph.closed)).length, 1);
  ok('Quoted and Closed customers keep their stage when booked; closing the dialog books nothing');

  // ---- the Appointments calendar (the default on desktop) ----
  const toastSays = (re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('appts-toast').textContent), re.source);
  const monthTitle = (y, m) => new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-IE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const TODAY = dublin(Date.now()), [TY, TM] = TODAY.split('-').map(Number);
  const toThisMonth = (pg) => pg.evaluate(() => { const b = document.getElementById('cal-today'); if (!b.disabled) b.click(); });
  async function showDay(pg, k) {                    // the month containing day k (tomorrow may already be next month)
    await toThisMonth(pg);
    for (let i = 0; i < 2 && !(await pg.locator(`.cal-cell[data-day="${k}"]`).count()); i++) {
      const was = await pg.textContent('#cal-title'); await pg.click('#cal-next');
      await pg.waitForFunction((t) => document.getElementById('cal-title').textContent !== t, was);
    }
    await pg.locator(`.cal-cell[data-day="${k}"]`).waitFor();
  }
  await page.click('#nav-appointments');
  await page.waitForSelector('#appts-cal:not([hidden]) .cal-cell');
  assert.equal(await page.getAttribute('#app', 'data-view'), 'appointments');
  assert.equal(await page.getAttribute('#appts-view button[data-view="calendar"]', 'aria-pressed'), 'true');
  assert.equal(await page.isVisible('#appts-list'), false);
  assert.equal(await page.textContent('#cal-title'), monthTitle(TY, TM));
  assert.deepEqual(await page.locator('.cal-dow').allInnerTexts(), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.equal(await page.locator('.cal-cell.today').count(), 1);
  assert.equal(await page.locator('.cal-cell.today').getAttribute('data-day'), TODAY);
  assert.equal(await page.locator('.cal-cell.today').getAttribute('aria-current'), 'date');
  assert.equal(await page.isDisabled('#cal-today'), true);
  await showDay(page, D1);
  const d1 = page.locator(`.cal-cell[data-day="${D1}"]`);
  await d1.locator('.cal-ev').nth(1).waitFor();
  assert.deepEqual(await d1.locator('.cal-ev').evaluateAll((es) => es.map((e) => [e.dataset.phone, e.dataset.status, e.innerText.replace(/\s+/g, ' ').trim()])),
    [[ph.quoted, 'quoted', '10:00 Quinn Quoted'], [ph.lead, 'booked', '10:30 Lena Lead']]);
  assert.notEqual(await d1.locator('.cal-ev').nth(0).evaluate((e) => getComputedStyle(e).borderLeftColor), await d1.locator('.cal-ev').nth(1).evaluate((e) => getComputedStyle(e).borderLeftColor));
  await showDay(page, D2);
  assert.match(await page.locator(`.cal-cell[data-day="${D2}"] .cal-ev`).innerText(), /09:00\s+Cathal Closed/);
  await showDay(page, D1);
  await page.screenshot({ path: path.join(SHOTS, 'appointments-calendar.png') });
  ok('Calendar is the default on desktop: a Monday-first month with today highlighted; each appointment sits in its day with time, name and a subtle stage colour');

  await d1.locator(`.cal-ev[data-phone="${ph.lead}"]`).click();
  await page.waitForSelector('.appt-pop');
  assert.match(await page.locator('.appt-pop').innerText(), /Lena Lead[\s\S]*Booked[\s\S]*Tomorrow, 10:30–11:30[\s\S]*Consultation · 12 Main St, Swords[\s\S]*In Google Calendar/);
  assert.deepEqual(await page.locator('.appt-pop .pop-actions button').allInnerTexts(), ['Open customer', 'Reschedule', 'Cancel']);
  await page.screenshot({ path: path.join(SHOTS, 'appointments-calendar-card.png') });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.appt-pop').count(), 0);
  await showDay(page, D2);
  await page.locator(`.cal-cell[data-day="${D2}"] .cal-ev[data-phone="${ph.closed}"]`).click();
  await page.click('.appt-pop button:has-text("Reschedule")');
  await page.waitForSelector('#appt-dlg[open]');
  assert.equal(await page.inputValue('#a-time'), '09:00');
  await page.selectOption('#a-time', '09:30'); await page.click('#a-go');
  await page.waitForFunction((k) => /09:30\s+Cathal Closed/.test((document.querySelector(`.cal-cell[data-day="${k}"] .cal-ev`) || {}).innerText || ''), D2);
  await toastSays(/Moved to/);
  assert.match(await page.textContent('#appts-toast'), /Moved to .* at 09:30\. Google Calendar updated\./);
  ok('clicking an appointment opens a card with its details and Open customer / Reschedule / Cancel; Reschedule from the card moves it in the calendar');

  const D5 = dublin(Date.now() + 5 * DAY), [y5, m5, dd5] = D5.split('-').map(Number);
  for (let i = 0; i < 4; i++) {                       // a busy day, written straight to the database for this check and removed after it
    await db.doc('appointments/e2e-busy-' + i).set({ phone: ph.quoted, customerName: 'Busy ' + (i + 1), type: 'consultation', status: 'scheduled', version: 1,
      start: Timestamp.fromMillis(Date.UTC(y5, m5 - 1, dd5, 8 + i)), end: Timestamp.fromMillis(Date.UTC(y5, m5 - 1, dd5, 9 + i)), sync: { google: { state: 'synced' } } });
  }
  await showDay(page, D5);
  const d5 = page.locator(`.cal-cell[data-day="${D5}"]`);
  await d5.locator('.cal-more').waitFor();
  assert.equal(await d5.locator('.cal-ev').count(), 3); assert.equal(await d5.locator('.cal-more').innerText(), '+1 more');
  await d5.locator('.cal-more').click();
  await page.waitForSelector('.day-pop');
  assert.equal(await page.locator('.day-pop .cal-ev').count(), 4);
  await page.locator('.day-pop .cal-ev').nth(3).click();
  await page.waitForSelector('.appt-pop:not(.day-pop)');
  assert.match(await page.locator('.appt-pop').innerText(), /Busy 4/);
  await page.keyboard.press('Escape');
  for (let i = 0; i < 4; i++) await db.doc('appointments/e2e-busy-' + i).delete();
  await page.waitForFunction((k) => !document.querySelector(`.cal-cell[data-day="${k}"] .cal-more`), D5);
  ok('a busy day shows three appointments and "+1 more", which lists them all and opens each one');

  await toThisMonth(page);
  await page.waitForFunction((t) => document.getElementById('cal-title').textContent === t, monthTitle(TY, TM));
  const next = new Date(Date.UTC(TY, TM, 1)), prev = new Date(Date.UTC(TY, TM - 2, 1));
  await page.click('#cal-next');
  await page.waitForFunction((t) => document.getElementById('cal-title').textContent === t, monthTitle(next.getUTCFullYear(), next.getUTCMonth() + 1));
  assert.equal(await page.isDisabled('#cal-today'), false);
  await page.click('#cal-prev'); await page.click('#cal-prev');
  await page.waitForFunction((t) => document.getElementById('cal-title').textContent === t, monthTitle(prev.getUTCFullYear(), prev.getUTCMonth() + 1));
  await page.click('#cal-today');
  await page.waitForFunction((t) => document.getElementById('cal-title').textContent === t, monthTitle(TY, TM));
  assert.equal(await page.locator('.cal-cell.today').count(), 1);
  ok('Previous month / Today / Next month navigation; Today returns to the current month');

  // ---- the Appointments list (the existing view), remembered for the session ----
  await page.click('#appts-view button[data-view="list"]');
  await page.waitForSelector('.arow');
  assert.equal(await page.isVisible('#appts-cal'), false);
  await page.reload();
  await page.waitForSelector('#app:not([hidden])');
  await page.waitForSelector('.arow');
  assert.equal(await page.getAttribute('#appts-view button[data-view="list"]', 'aria-pressed'), 'true');
  ok('Calendar | List toggle: List shows the upcoming list, and the choice is remembered after a reload');
  assert.equal(await page.getAttribute('#app', 'data-view'), 'appointments');
  assert.equal(await page.locator('#nav-appointments').getAttribute('aria-current'), 'page');
  assert.equal(await page.locator('#nav-inbox').getAttribute('aria-current'), null);
  const heads = await page.locator('.appts-day').allInnerTexts();
  assert.equal(heads.length, 2); assert.match(heads[0], /^Tomorrow/);
  assert.deepEqual(await page.locator('.arow').evaluateAll((rs) => rs.map((r) => r.dataset.phone)), [ph.quoted, ph.lead, ph.closed]);
  assert.match(await row(ph.lead).innerText(), /10:30[\s\S]*11:30[\s\S]*Lena Lead[\s\S]*Booked[\s\S]*Consultation · 12 Main St, Swords[\s\S]*In Google Calendar/);
  assert.match(await row(ph.quoted).locator('.arow-stage').innerText(), /Quoted/);
  assert.match(await row(ph.closed).locator('.arow-stage').innerText(), /Closed/);
  await page.screenshot({ path: path.join(SHOTS, 'appointments-desktop.png') });
  await page.setViewportSize({ width: 1024, height: 768 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1360, height: 860 });
  ok('Appointments lists upcoming appointments by day (Tomorrow, then the date), in time order, with stage and Google Calendar status; no sideways scroll at tablet width');

  // ---- reschedule from the screen ----
  await row(ph.lead).hover(); await row(ph.lead).locator('.arow-menu').click();
  await page.click('.appt-menu button:has-text("Reschedule")');
  await page.waitForSelector('#appt-dlg[open]');
  assert.equal(await page.textContent('#appt-title'), 'Reschedule appointment');
  assert.equal(await page.inputValue('#a-time'), '10:30'); assert.equal(await page.inputValue('#a-notes'), 'Dog in the garden');
  await page.selectOption('#a-time', '14:00');
  await page.click('#a-go');
  await page.waitForFunction((p) => /^14:00/.test((document.querySelector(`.arow[data-phone="${p}"] .arow-time`) || {}).textContent || ''), ph.lead);
  await toastSays(/Moved to/);                         // the row moves as soon as the save lands; the message follows once Google is updated
  assert.match(await page.textContent('#appts-toast'), /Moved to tomorrow at 14:00\. Google Calendar updated\./);
  const [moved] = await apptsOf(ph.lead);
  assert.equal(moved.version, 2); assert.equal(moved.rescheduleCount, 1);
  assert.equal(evFor(ph.lead).length, 1); assert.equal(Date.parse(evFor(ph.lead)[0].start.dateTime), moved.start.toMillis());
  assert.deepEqual(await page.locator('.arow').evaluateAll((rs) => rs.map((r) => r.dataset.phone)), [ph.quoted, ph.lead, ph.closed]);
  ok('Reschedule from the row menu: prefilled, moved to 14:00, the same Google event updated');

  // ---- cancel from the screen ----
  await row(ph.quoted).hover(); await row(ph.quoted).locator('.arow-menu').click();
  await page.click('.appt-menu button:has-text("Cancel appointment")');
  await page.waitForSelector('#appt-cancel-dlg[open]');
  assert.match(await page.textContent('#ac-text'), /Quinn Quoted[\s\S]*removed from Google Calendar[\s\S]*stage does not change/);
  await page.fill('#ac-reason', 'Asked to postpone');
  await page.click('#ac-go');
  await page.waitForFunction((p) => !document.querySelector(`.arow[data-phone="${p}"]`), ph.quoted);
  await toastSays(/Appointment cancelled/);
  assert.match(await page.textContent('#appts-toast'), /Appointment cancelled\. Removed from Google Calendar\./);
  assert.equal(evFor(ph.quoted).length, 0);
  const [gone] = await apptsOf(ph.quoted);
  assert.equal(gone.status, 'cancelled'); assert.equal(gone.cancelReason, 'Asked to postpone');
  assert.equal((await db.doc('conversations/' + ph.quoted).get()).data().inboxStatus, 'quoted');
  await page.check('#appts-show-cancelled');
  await row(ph.quoted).waitFor();
  assert.match(await row(ph.quoted).innerText(), /Cancelled[\s\S]*Removed from Google Calendar/);
  assert.equal(await row(ph.quoted).locator('.arow-menu').count(), 1);
  await page.uncheck('#appts-show-cancelled');
  ok('Cancel from the row menu: removed from Google Calendar, kept in Elite OS (shown with "Show cancelled"), stage unchanged');
  await page.click('#appts-view button[data-view="calendar"]');
  await showDay(page, D1);
  await page.locator(`.cal-cell[data-day="${D1}"] .cal-ev[data-phone="${ph.lead}"]`).waitFor();
  assert.equal(await page.locator(`.cal-cell[data-day="${D1}"] .cal-ev[data-phone="${ph.quoted}"]`).count(), 0);   // cancelled: not cluttering the calendar
  await page.check('#appts-show-cancelled');
  const gone2 = page.locator(`.cal-cell[data-day="${D1}"] .cal-ev[data-phone="${ph.quoted}"]`);
  await gone2.waitFor();
  assert.match(await gone2.getAttribute('class'), /\bcancelled\b/);
  await gone2.click();
  await page.waitForSelector('.appt-pop');
  assert.match(await page.locator('.appt-pop').innerText(), /Cancelled[\s\S]*Removed from Google Calendar/);
  assert.deepEqual(await page.locator('.appt-pop .pop-actions button').allInnerTexts(), ['Open customer']);
  await page.keyboard.press('Escape');
  await page.uncheck('#appts-show-cancelled');
  await page.click('#appts-view button[data-view="list"]');
  await page.waitForSelector('.arow');
  ok('the calendar leaves cancelled appointments out by default; "Show cancelled" brings them back, struck through, with only Open customer');

  // ---- Google down, then "failed", then Retry now ----
  await row(ph.lead).locator('.arow-name').click();
  await page.waitForSelector('#thread:not([hidden])');
  assert.equal(await page.getAttribute('#app', 'data-view'), 'thread');
  await page.waitForSelector('#d-appts-list .d-appt');
  cal.down = true;
  await page.click('#d-appt-new'); await page.waitForSelector('#appt-dlg[open]');
  await page.selectOption('#a-time', '16:00'); await page.click('#a-go');
  await custMsg(/Google Calendar will update shortly/);
  await page.waitForFunction(() => document.querySelectorAll('#d-appts-list .d-appt').length === 2);
  assert.equal(await page.locator('#d-appts-list .d-appt').nth(1).locator('.sync').innerText(), 'Waiting to sync');
  const late = (await apptsOf(ph.lead)).find((a) => a.version === 1);
  await db.doc('appointments/' + late.id).update({ 'sync.google.state': 'failed', 'sync.google.lastError': 'forbidden' });   // as after 24 hours of failures
  await page.waitForFunction(() => /Not in Google Calendar/.test(document.getElementById('d-appts-list').textContent));
  await page.click('#nav-appointments');
  await page.waitForSelector('#appts-failed:not([hidden])');
  assert.match(await page.textContent('#appts-failed'), /1 appointment is not up to date in Google Calendar \(the calendar is not shared with Elite OS\)/);
  cal.down = false;
  await page.locator(`.arow[data-id="${late.id}"] .sync-retry`).click();
  await page.waitForFunction((id) => /In Google Calendar/.test((document.querySelector(`.arow[data-id="${id}"] .sync`) || {}).textContent || ''), late.id);
  await page.waitForSelector('#appts-failed', { state: 'hidden' });
  await toastSays(/Google Calendar is up to date/);
  assert.equal(evFor(ph.lead).length, 2);
  ok('Google down: the booking still succeeds ("will update shortly", "Waiting to sync"); a failed one is flagged with the reason and fixed by Retry now');

  // ---- navigation stays consistent with the Pipeline ----
  await page.click('#nav-pipeline');
  await page.waitForSelector(`.lane[data-stage="booked"] .prow[data-phone="${ph.lead}"]`);
  assert.equal(await page.locator('#nav-pipeline').getAttribute('aria-current'), 'page');
  assert.equal(await page.locator('#nav-appointments').getAttribute('aria-current'), null);
  await page.click('#nav-appointments'); await page.waitForSelector('.arow');
  await page.click('#nav-inbox'); await page.waitForSelector('.conv');
  assert.equal(await page.getAttribute('#app', 'data-view'), 'list');
  assert.equal(await page.locator('#nav-appointments').getAttribute('aria-current'), null);
  ok('the booked customer is in the Booked column of the Pipeline; Inbox, Pipeline and Appointments switch cleanly');

  // ---- phone ----
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const mp = await mctx.newPage(); mp.on('pageerror', (e) => errors.push('mobile: ' + e.message));
  await mp.goto('http://127.0.0.1:5055/');
  await mp.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await mp.waitForSelector('#app:not([hidden])');
  await mp.tap('#to-appointments');
  await mp.waitForSelector('.arow');
  assert.equal(await mp.getAttribute('#app', 'data-view'), 'appointments');
  assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.equal(await mp.locator('.arow').count(), 3);
  await mp.screenshot({ path: path.join(SHOTS, 'appointments-phone.png') });
  await mp.locator(`.arow[data-phone="${ph.closed}"] .arow-menu`).tap();
  await mp.tap('.appt-menu button:has-text("Open customer")');
  await mp.waitForSelector('#thread:not([hidden])');
  await mp.tap('#back');
  await mp.waitForSelector('.arow');
  assert.equal(await mp.getAttribute('#app', 'data-view'), 'appointments');
  await mp.tap('#appts-back');
  await mp.waitForSelector('.conv');
  assert.equal(await mp.getAttribute('#app', 'data-view'), 'list');
  await mp.tap('#status-filters button[data-status="booked"]');
  await mp.locator(`.conv[data-phone="${ph.lead}"]`).tap();
  await mp.waitForSelector('#thread:not([hidden])');
  await mp.tap('#details-btn'); await mp.waitForSelector('#details:not([hidden])');
  await mp.waitForSelector('#d-appts-list .d-appt');
  await mp.tap('#d-appt-new'); await mp.waitForSelector('#appt-dlg[open]');
  const box = await mp.locator('#appt-dlg').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, 'the booking dialog fits the phone screen');
  await mp.screenshot({ path: path.join(SHOTS, 'appointments-phone-dialog.png') });
  await mp.tap('#a-cancel');
  ok('phone: Appointments opens from the Inbox header with no sideways scroll; Open customer and Back return to it; the booking dialog fits the screen');
  await mp.evaluate(() => { location.hash = '#appointments'; });
  await mp.waitForSelector('.arow');
  assert.equal(await mp.getAttribute('#appts-view button[data-view="list"]', 'aria-pressed'), 'true');      // phones start with the list
  await mp.tap('#appts-view button[data-view="calendar"]');
  await mp.waitForSelector('#appts-cal:not([hidden]) .cal-cell');
  await showDay(mp, D1);
  assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const md1 = mp.locator(`.cal-cell[data-day="${D1}"]`);
  await md1.locator('.cal-dot').first().waitFor();
  assert.equal(await md1.locator('.cal-ev').first().isVisible(), false);               // names do not fit: dots instead
  assert.equal(await md1.locator('.cal-dot').count(), 2);
  await md1.tap();
  await mp.waitForFunction((k) => document.querySelector(`.cal-cell[data-day="${k}"]`).classList.contains('sel'), D1);
  await mp.locator('#cal-day .arow').nth(1).waitFor();
  assert.equal(await mp.locator('#cal-day .arow').count(), 2);
  assert.match(await mp.locator('#cal-day .appts-day').innerText(), /^Tomorrow/);
  await mp.screenshot({ path: path.join(SHOTS, 'appointments-phone-calendar.png') });
  ok('phone: List by default; Calendar shows a compact month with dots, and tapping a day lists its appointments underneath, with no sideways scroll');
  await mctx.close();

  assert.deepEqual(errors, [], 'browser errors: ' + JSON.stringify(errors)); ok('no JavaScript errors in the browser');
  await browser.close(); web.close(); calendar.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.stack || e.message || e); process.exit(1); });
