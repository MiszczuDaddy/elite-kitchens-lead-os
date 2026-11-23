'use strict';
// The phone calendar on the Calendar screen, in a REAL browser (docs/PHONE_CALENDAR.md): the events of the business Google Calendar (read once a day, at midnight) are shown in purple beside the Elite OS appointments in the Month,
// Week and Day views and in the day list, so they can never be taken for an appointment; they open a small read-only box; a tickbox hides them (and is remembered); the screen says when it was last updated, or that the last
// check failed and why; "Refresh now" reads the calendar again (a local fake Google Calendar that can only be READ); and on a phone it fits. The events are written the way the server writes them (the server side is tested
// in functions/test/calendar-import.test.js). Every name is made up. Run: bash test-ui/run.sh phone-calendar.e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const { getAuth } = fnRequire('firebase-admin/auth');
const ROOT = path.join(__dirname, '..'), URL0 = 'http://127.0.0.1:5076/';
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
}).listen(5076);
// the fake Google Calendar (the functions emulator is told to use it: GCAL_API_BASE in test-ui/run.sh). It can only be READ: any request that is not a GET is recorded as a failure of the test.
const seen = []; let reply = { items: [] }, replyStatus = 200;
const gcal = http.createServer((req, res) => { seen.push([req.method, req.url]); res.setHeader('content-type', 'application/json'); res.statusCode = replyStatus; res.end(JSON.stringify(reply)); }).listen(9912);

// Irish wall-clock time -> milliseconds (right in summer and winter)
const dublinMs = (y, m, d, h, min) => {
  let t = Date.UTC(y, m - 1, d, h, min);
  for (let i = 0; i < 2; i++) { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)])); t += Date.UTC(y, m - 1, d, h, min) - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute); }
  return t;
};
const keyOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(new Date(ms));
const at = (key, h, min = 0) => { const [y, m, d] = key.split('-').map(Number); return dublinMs(y, m, d, h, min); };

(async () => {
  initializeApp({ projectId: 'demo-leados' }); const db = getFirestore(), T = (ms) => Timestamp.fromMillis(ms), now = Date.now(), DAY = 86400000;
  const token = await getAuth().createCustomToken((await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true })).uid);
  const TODAY = keyOf(now), dow = new Date(TODAY + 'T12:00:00Z').getUTCDay(), OTHER = keyOf(dow === 0 ? now - DAY : now + DAY);          // a second day in the same week (Monday first)
  const ANNA = '353871300001';
  await db.doc('contacts/' + ANNA).set({ phone: ANNA, name: 'Anna Apple', createdAt: T(now - 5 * DAY) }); await db.doc('conversations/' + ANNA).set({ phone: ANNA, name: 'Anna Apple', inboxStatus: 'booked', unreadCount: 0, createdAt: T(now - 5 * DAY), updatedAt: T(now) });
  await db.doc('appointments/e2e-anna').set({ phone: ANNA, customerName: 'Anna Apple', type: 'consultation', status: 'scheduled', version: 1, start: T(at(TODAY, 10)), end: T(at(TODAY, 11)), location: 'Swords', sync: { google: { state: 'synced' } } });
  const ev = (id, title, start, end, extra = {}) => db.doc('externalEvents/g_' + id).set({ source: 'google', title, location: null, start: T(start), end: T(end), allDay: false, busy: true, private: false, htmlLink: 'https://www.google.com/calendar/event?eid=' + id, importedAt: T(now), ...extra });
  await ev('dentist', 'Dentist', at(TODAY, 9, 30), at(TODAY, 10, 30), { location: 'Swords' }); await ev('lunch', 'Lunch with Mum', at(TODAY, 13), at(TODAY, 14), { htmlLink: 'https://evil.example/x' });
  const NEXT = keyOf(at(TODAY, 12) + DAY); await ev('bankhol', 'Bank holiday', at(TODAY, 0), at(NEXT, 0), { allDay: true, htmlLink: null });
  await ev('pickup', 'School pick-up', at(OTHER, 16), at(OTHER, 17)); await ev('busy', 'Busy', at(OTHER, 11), at(OTHER, 12), { private: true });
  await db.doc('externalSync/state').set({ ok: true, lastRunAt: T(now - 2 * 3600e3), count: 5, truncated: false, by: 'midnight', error: null, triedAt: T(now - 2 * 3600e3) });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' }), errors = []; global.__errors = errors;
  const open = async (viewport, phone) => {
    const ctx = await browser.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) }), page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(URL0); await page.waitForSelector('#login:not([hidden])'); await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])');
    await page.evaluate(() => { if (location.hash === '#today') location.hash = ''; }); return { ctx, page };
  };
  console.log('PHONE CALENDAR E2E: real page + real functions + emulators + a fake Google Calendar (read-only)');
  const { page } = await open({ width: 1360, height: 900 });
  const view = async (v) => { await page.click(`#appts-view button[data-view="${v}"]`); await sleep(300); };
  const bg = (sel) => page.locator(sel).first().evaluate((e) => getComputedStyle(e).backgroundColor);

  // ------------------------------------------------------------------ 1. the Month view: a purple chip with how many, the appointment unchanged
  await page.click('#nav-appointments'); await page.waitForSelector('#cal-grid .cal-cell'); await view('calendar');
  await until(async () => (await page.locator(`.cal-cell[data-day="${TODAY}"] .cal-ev.ext`).count()) === 1, 'the purple chip on today');
  assert.equal(await page.locator(`.cal-cell[data-day="${TODAY}"] .cal-ev.ext`).innerText(), 'Phone · 3'); assert.equal(await page.locator(`.cal-cell[data-day="${TODAY}"] .cal-ev:not(.ext)`).count(), 1, 'the appointment chip is still there');
  assert.equal(await page.locator(`.cal-cell[data-day="${TODAY}"] .cal-ev:not(.ext) .cal-ev-name`).innerText(), 'Anna Apple'); assert.equal(await page.locator(`.cal-cell[data-day="${OTHER}"] .cal-ev.ext`).count(), 1);
  assert.notEqual(await bg(`.cal-cell[data-day="${TODAY}"] .cal-ev.ext`), await bg(`.cal-cell[data-day="${TODAY}"] .cal-ev:not(.ext)`), 'purple is not the colour of an appointment');
  assert.match(await page.getAttribute(`.cal-cell[data-day="${TODAY}"]`, 'aria-label'), /1 appointment, 3 from your phone calendar/);
  assert.equal(await page.locator(`.cal-cell[data-day="${TODAY}"] .cal-dot.ext`).count(), 1, 'and a purple dot for the phone layout');
  ok('Month: a day with phone-calendar events gets a purple "Phone · 3" chip (and a purple dot); the Elite OS appointment is unchanged and a different colour');

  // ------------------------------------------------------------------ 2. the day list: appointments first, then the phone events, read-only
  await page.click(`.cal-cell[data-day="${TODAY}"] .cal-select`); await page.waitForSelector('.agenda-ext');
  assert.match(await page.innerText('.agenda-count'), /^1 appointment$/, 'the appointment count is only appointments'); assert.equal(await page.locator('.agenda-entry').count(), 1);
  assert.match(await page.innerText('.agenda-ext-head'), /^From your phone calendar · 3$/); const rows = await page.$$eval('.agenda-ext-row', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  assert.deepEqual(rows, ['All day Bank holiday', '09:30–10:30 Dentist Swords', '13:00–14:00 Lunch with Mum'], 'in time order, all-day first');
  const order = await page.evaluate(() => { const a = document.querySelector('.agenda-entry'), x = document.querySelector('.agenda-ext'); return !!(a.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING); }); assert.equal(order, true, 'the appointments come first');
  ok('the day list shows the appointment first and, under "From your phone calendar", the phone events in time order; the appointment count stays "1 appointment"');

  // ------------------------------------------------------------------ 3. a phone event opens a small read-only box
  await page.click('.agenda-ext-row:has-text("Dentist")'); await page.waitForSelector('#ext-dlg[open]');
  assert.equal(await page.innerText('#ext-dlg-title'), 'Dentist'); assert.match(await page.innerText('#ext-dlg-when'), /09:30–10:30/); assert.equal(await page.innerText('#ext-dlg-where'), 'Swords'); assert.match(await page.innerText('#ext-dlg .hint:last-of-type'), /Elite OS only reads it/);
  assert.equal(await page.isVisible('#ext-dlg-open'), true); assert.match(await page.getAttribute('#ext-dlg-open', 'href'), /^https:\/\/www\.google\.com\/calendar\/event\?eid=dentist$/); assert.equal(await page.getAttribute('#ext-dlg-open', 'target'), '_blank'); assert.match(await page.getAttribute('#ext-dlg-open', 'rel'), /noopener/);
  assert.equal(await page.locator('#ext-dlg input, #ext-dlg textarea, #ext-dlg select').count(), 0, 'nothing to edit: it is read-only');
  await page.click('#ext-dlg-close'); await page.waitForFunction(() => !document.getElementById('ext-dlg').open);
  await page.click('.agenda-ext-row:has-text("Lunch")'); await page.waitForSelector('#ext-dlg[open]'); assert.equal(await page.isVisible('#ext-dlg-open'), false, 'a link that is not a Google Calendar link is never offered'); assert.equal(await page.isVisible('#ext-dlg-where'), false, 'no place: nothing shown');
  await page.click('#ext-dlg-close'); await page.click('.agenda-ext-row:has-text("Bank holiday")'); await page.waitForSelector('#ext-dlg[open]'); assert.match(await page.innerText('#ext-dlg-when'), /all day/); await page.click('#ext-dlg-close');
  ok('choosing a phone event opens a read-only box (time, place, a link to open it in Google Calendar only when it is a real Google Calendar link; nothing to edit)');

  // ------------------------------------------------------------------ 4. Week and Day: purple blocks beside the appointment, an all-day strip
  await view('week'); await page.waitForSelector('.time-column'); await until(async () => (await page.locator('.time-event.ext').count()) === 4, 'four purple blocks in the week: Dentist, Lunch, School pick-up and Busy');
  const blocks = await page.$$eval('.time-event.ext', (els) => els.map((e) => e.querySelector('strong').textContent).sort()); assert.deepEqual(blocks, ['Busy', 'Dentist', 'Lunch with Mum', 'School pick-up'], 'every timed phone event of the week (the all-day one is not a block)');
  assert.equal(await page.locator('.time-event:not(.ext)').count(), 1, 'the one appointment'); assert.notEqual(await bg('.time-event.ext'), await bg('.time-event:not(.ext)'));
  const colData = await page.evaluate((day) => { const col = document.querySelector(`.time-column[data-day="${day}"]`), r = (e) => e.getBoundingClientRect(), a = col.querySelector('.time-event:not(.ext)'), d = [...col.querySelectorAll('.time-event.ext')].find((x) => x.textContent.includes('Dentist')); return { a: r(a), d: r(d) }; }, TODAY);
  assert.ok(colData.a.left !== colData.d.left || colData.a.width < 100, 'the Dentist (09:30–10:30) overlaps the appointment (10:00–11:00): they sit side by side, so a clash is visible'); assert.ok(colData.a.right <= colData.d.left + 1 || colData.d.right <= colData.a.left + 1, 'not on top of each other');
  assert.match(await page.innerText('.time-allday'), /Phone: Bank holiday/); assert.match(await page.innerText('.time-status'), /^Purple blocks come from your phone calendar \(read-only\)/);
  await page.screenshot({ path: path.join(SHOTS, 'phone-calendar-week.png') });
  await page.click('.time-event.ext >> text=Dentist'); await page.waitForSelector('#ext-dlg[open]'); assert.equal(await page.innerText('#ext-dlg-title'), 'Dentist'); await page.click('#ext-dlg-close');
  await page.click('.time-event:not(.ext)'); await page.waitForSelector('#appt-detail-dlg[open]'); await page.click('#appt-detail-close');
  await view('day'); await until(async () => (await page.locator('.time-event.ext').count()) === 2, 'the day shows today\'s two timed events'); assert.equal(await page.locator('.time-event:not(.ext)').count(), 1);
  await page.screenshot({ path: path.join(SHOTS, 'phone-calendar-day.png') });
  ok('Week and Day: the phone events are purple blocks beside the appointment (an overlap shows side by side); the all-day event is a "Phone:" line under the day; a block opens the read-only box and an appointment still opens its own details');

  // ------------------------------------------------------------------ 5. the tickbox hides them and is remembered
  await view('calendar'); await page.uncheck('#ext-show'); await sleep(300);
  assert.equal(await page.locator('.cal-ev.ext, .cal-dot.ext').count(), 0, 'hidden in Month'); await page.click(`.cal-cell[data-day="${TODAY}"] .cal-select`); assert.equal(await page.locator('.agenda-ext').count(), 0, 'hidden in the day list');
  await view('week'); assert.equal(await page.locator('.time-event.ext').count(), 0, 'hidden in Week'); assert.match(await page.innerText('.time-status'), /^Blank times show no Elite OS appointment/, 'the usual note is back'); assert.equal(await page.locator('.time-event:not(.ext)').count(), 1, 'the appointment stays');
  await page.reload(); await page.waitForSelector('#app:not([hidden])'); await page.click('#nav-appointments'); await page.waitForSelector('#appts-view');
  assert.equal(await page.isChecked('#ext-show'), false, 'the choice is remembered'); await page.check('#ext-show'); await view('calendar'); await until(async () => (await page.locator('.cal-ev.ext').count()) >= 2, 'back on');
  ok('"Phone calendar" tickbox hides them everywhere (Month, day list, Week) and the choice is remembered; ticking it brings them back');

  // ------------------------------------------------------------------ 6. what the screen says about the last check
  assert.match(await page.innerText('#ext-status'), /^updated .* · 5 events$/); assert.equal(await page.locator('#ext-status.bad').count(), 0);
  await db.doc('externalSync/state').set({ ok: false, error: 'forbidden', lastRunAt: T(now - 30 * 3600e3), count: 5, triedAt: T(now - 3600e3), by: 'midnight' }); await until(async () => /the last check failed/.test(await page.innerText('#ext-status')), 'the failure is shown');
  assert.match(await page.innerText('#ext-status'), /the last check failed \(the calendar is not shared with Elite OS yet\)\. Last good check: /); assert.equal(await page.locator('#ext-status.bad').count(), 1, 'in the error colour'); assert.ok((await page.locator('.cal-ev.ext').count()) >= 2, 'what was kept is still shown after a bad night');
  await db.doc('externalSync/state').delete(); await until(async () => (await page.innerText('#ext-status')) === 'not connected yet', 'not connected');
  ok('the screen says when it was last updated and how many events; after a failed check it says why in plain words and keeps showing what it has; before the first check it says "not connected yet"');

  // ------------------------------------------------------------------ 7. Refresh now: reads the calendar again (GET only), replaces what was there, and cannot be hammered
  reply = { items: [{ id: 'fresh1', status: 'confirmed', summary: 'Fresh from Google', location: 'Balbriggan', start: { dateTime: new Date(at(TODAY, 15)).toISOString() }, end: { dateTime: new Date(at(TODAY, 16)).toISOString() }, htmlLink: 'https://www.google.com/calendar/event?eid=fresh1' }, { id: 'ek' + 'ab'.repeat(16), status: 'confirmed', summary: 'An appointment Elite OS made', start: { dateTime: new Date(at(TODAY, 8)).toISOString() }, end: { dateTime: new Date(at(TODAY, 9)).toISOString() } }] };
  await page.click(`.cal-cell[data-day="${TODAY}"] .cal-select`); await page.click('#ext-refresh'); await page.waitForFunction(() => /Phone calendar updated/.test(document.getElementById('appts-toast').textContent)); assert.match(await page.innerText('#appts-toast'), /Phone calendar updated: 1 event\./);
  await until(async () => (await page.locator('.agenda-ext-row').count()) === 1, 'the screen follows'); assert.match(await page.innerText('.agenda-ext-row'), /Fresh from Google/); const kept = (await db.collection('externalEvents').get()).docs.map((d) => d.id); assert.deepEqual(kept, ['g_fresh1'], 'the old copies are gone and the appointment Elite OS made itself was not copied');
  assert.ok(seen.length >= 1 && seen.every(([m]) => m === 'GET'), 'Google Calendar was only ever READ: ' + JSON.stringify(seen.map((x) => x[0]))); assert.match(seen[0][1], /\/calendar\/v3\/calendars\/phone%40test\.dev\/events\?/); assert.match(seen[0][1], /singleEvents=true/); assert.doesNotMatch(seen[0][1], /description|attendees%28email/);
  assert.match(await page.innerText('#ext-status'), /^updated .* · 1 event$/);
  const calls = seen.length; await page.click('#ext-refresh'); await page.waitForFunction(() => /a moment ago/.test(document.getElementById('appts-toast').textContent)); assert.equal(seen.length, calls, 'pressed again at once: Google was not asked again');
  await page.screenshot({ path: path.join(SHOTS, 'phone-calendar-month.png') });
  ok('"Refresh now" reads the calendar (GET only, no description or guests asked for), replaces the stored copies, skips what Elite OS made itself, updates the status, and pressing it again at once does not ask Google again');

  // ------------------------------------------------------------------ 8. a phone
  await ev('dentist', 'Dentist', at(TODAY, 9, 30), at(TODAY, 10, 30), { location: 'Swords' }); await ev('lunch', 'Lunch with Mum', at(TODAY, 13), at(TODAY, 14)); await db.doc('externalSync/state').set({ ok: true, lastRunAt: T(Date.now() - 600e3), count: 3, truncated: false, by: 'midnight', error: null, triedAt: T(Date.now() - 600e3) });
  const m = await open({ width: 375, height: 812 }, true); await m.page.tap('#to-appointments'); await m.page.waitForSelector('#cal-grid .cal-cell');
  const fits = async (label) => assert.equal(await m.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scrolling: ' + label);
  await until(async () => (await m.page.locator(`.cal-cell[data-day="${TODAY}"] .cal-dot.ext`).count()) === 1, 'the purple dot on the phone'); await fits('month');
  assert.equal(await m.page.isVisible('#ext-bar'), true); const bar = await m.page.locator('#ext-bar').boundingBox(); assert.ok(bar.x >= 0 && bar.x + bar.width <= 376, 'the status bar fits: ' + JSON.stringify(bar)); assert.ok((await m.page.locator('#ext-refresh').boundingBox()).height >= 30);
  await m.page.click(`.cal-cell[data-day="${TODAY}"] .cal-select`); await m.page.waitForSelector('.agenda-ext-row'); const row = await m.page.locator('.agenda-ext-row').first().boundingBox(); assert.ok(row.height >= 44 && row.x >= 0 && row.x + row.width <= 376, 'the phone rows are easy to tap and fit: ' + JSON.stringify(row)); await fits('day list');
  await m.page.screenshot({ path: path.join(SHOTS, 'phone-calendar-phone-day.png') });
  await m.page.click('#appts-view button[data-view="day"]'); await m.page.waitForSelector('.time-column'); await until(async () => (await m.page.locator('.time-event.ext').count()) >= 1, 'a purple block on the phone'); await fits('day timeline');
  await m.page.screenshot({ path: path.join(SHOTS, 'phone-calendar-phone-timeline.png') });
  ok('on a 375px phone: a purple dot in the month, the status line and day-list rows fit and are easy to tap, and the day timeline shows the purple blocks; no sideways scrolling');

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | ')); ok('no console or page errors');
  await browser.close(); web.close(); gcal.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e, '\nPAGE ERRORS:', global.__errors); web.close(); gcal.close(); process.exit(1); });
