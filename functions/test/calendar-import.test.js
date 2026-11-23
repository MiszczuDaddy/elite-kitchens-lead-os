// Your phone calendar in Elite OS (functions/lib/calendarImport.js, docs/PHONE_CALENDAR.md): once a day, at midnight Irish time, the business Google Calendar your phone shows is READ and copied (title, place and time only) for the
// Calendar screen. Real Firestore emulator; Google Calendar is a fake that can only list events. Every name is made up.
// What matters: nothing is ever written to Google (the client has no way to), what Elite OS put there itself is skipped (no duplicates), nothing private beyond title/place/time is kept, a failed night changes nothing,
// and "Refresh now" cannot be used more than once every five minutes.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const CI = require('../lib/calendarImport');
const Gcal = require('../lib/gcal');
const h = require('../lib/handlers');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const NOW = Date.UTC(2026, 10, 23, 0, 0), DAY = 86400000, MIN = 60000, ts = (t) => Timestamp.fromMillis(t), iso = (t) => new Date(t).toISOString();
const rejects = (p, code, re) => assert.rejects(p, (e) => e.code === code && (!re || re.test(e.message)), `expected ${code}${re ? ' ' + re : ''}`);
const CAL = 'thomas@elitekitchens.example';
const timed = (id, summary, startMs, mins = 60, extra = {}) => ({ id, status: 'confirmed', summary, start: { dateTime: iso(startMs) }, end: { dateTime: iso(startMs + mins * MIN) }, htmlLink: 'https://www.google.com/calendar/event?eid=' + id, updated: iso(NOW), ...extra });
const allDay = (id, summary, day, days = 1) => ({ id, status: 'confirmed', summary, start: { date: day }, end: { date: new Date(Date.parse(day + 'T00:00:00Z') + days * DAY).toISOString().slice(0, 10) } });
// a Google Calendar that can only LIST (any other call is an error): pages of events, or a failure
function fakeGcal(pages, { fail } = {}) {
  const g = { calls: [], async listEvents(id, o) { g.calls.push([id, o]); if (fail) throw fail; const n = o.pageToken ? Number(o.pageToken) : 0; const p = typeof pages === 'function' ? pages(n) : pages[n] || []; return { items: p.items || p, next: p.next || null }; } };
  return g;
}
const run = (gcal, over = {}) => CI.run({ db, gcal, calendarId: CAL, nowMs: NOW, ...over });
const stored = async () => Object.fromEntries((await db.collection('externalEvents').get()).docs.map((d) => [d.id, d.data()]));
beforeEach(async () => { await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' }); });

test('WHAT IS KEPT: a timed event, an all-day event and a long one; the title, place and time only (never the description or the guests); a link only if it is a Google Calendar link', () => {
  const a = CI.parse({ ...timed('abc1', 'Dentist', NOW + 10 * 3600e3, 45, { location: 'Swords', description: 'secret notes', attendees: [{ email: 'friend@example.com', self: false }, { self: true, responseStatus: 'accepted' }] }) });
  assert.deepEqual([a.title, a.location, a.allDay, a.busy, a.private, a.source], ['Dentist', 'Swords', false, true, false, 'google']); assert.equal(a.end.toMillis() - a.start.toMillis(), 45 * MIN); assert.match(a.htmlLink, /^https:\/\/www\.google\.com\/calendar\/event\?eid=abc1$/);
  assert.equal(JSON.stringify(a).includes('secret notes'), false); assert.equal(JSON.stringify(a).includes('friend@example.com'), false); assert.deepEqual(Object.keys(a).sort(), ['allDay', 'busy', 'end', 'htmlLink', 'location', 'private', 'source', 'start', 'title']);
  const d = CI.parse(allDay('abc2', 'Bank holiday', '2026-12-25')); assert.equal(d.allDay, true); assert.equal(d.start.toMillis(), Date.UTC(2026, 11, 25, 0, 0), 'Irish midnight (winter time = UTC)'); assert.equal(d.end.toMillis(), Date.UTC(2026, 11, 26, 0, 0), 'the end day is exclusive');
  const sm = CI.parse(allDay('abc3', 'Summer', '2026-07-10')); assert.equal(sm.start.toMillis(), Date.UTC(2026, 6, 9, 23, 0), 'Irish midnight in summer time is 23:00 the day before in UTC');
  const trip = CI.parse(allDay('abc4', 'Holiday', '2026-12-28', 5)); assert.equal((trip.end.toMillis() - trip.start.toMillis()) / DAY, 5);
  assert.equal(CI.parse(timed('abc5', 'x'.repeat(500), NOW)).title.length, 200, 'a long title is shortened'); assert.equal(CI.parse({ ...timed('abc6', '', NOW), summary: undefined }).title, 'Busy', 'an event shared as busy only shows as Busy');
  assert.equal(CI.parse(timed('abc7', 'Link', NOW, 60, { htmlLink: 'https://evil.example/x' })).htmlLink, null, 'only a Google Calendar link is kept'); assert.equal(CI.parse(timed('abc8', 'Link', NOW, 60, { htmlLink: 'javascript:alert(1)' })).htmlLink, null);
  assert.equal(CI.parse(timed('abc9', 'Private', NOW, 60, { visibility: 'private' })).private, true); assert.equal(CI.parse(timed('abd1', 'Free', NOW, 60, { transparency: 'transparent' })).busy, false, 'an event marked "free" is not busy time');
  const fixed = CI.parse({ id: 'abd2', summary: 'Backwards', start: { dateTime: iso(NOW) }, end: { dateTime: iso(NOW - MIN) } }); assert.equal(fixed.end.toMillis() - fixed.start.toMillis(), 30 * MIN, 'an event that ends before it starts gets 30 minutes');
  assert.equal(CI.parse({ id: 'abd3', summary: 'No end', start: { dateTime: iso(NOW) } }).end.toMillis(), NOW + 30 * MIN);
});

test('WHAT IS SKIPPED: cancelled events, events Elite OS made itself (no duplicates), Google\'s working-location and birthday markers, events you declined, and anything without a start', () => {
  const osId = 'ek' + 'a1'.repeat(16);
  for (const ev of [timed('c1', 'Gone', NOW, 60, { status: 'cancelled' }), timed(osId, 'An appointment Elite OS created', NOW), timed('c2', 'Home', NOW, 60, { eventType: 'workingLocation' }), timed('c3', 'Mum birthday', NOW, 60, { eventType: 'birthday' }),
    timed('c4', 'Declined', NOW, 60, { attendees: [{ self: true, responseStatus: 'declined' }] }), { id: 'c5', summary: 'No start' }, { id: 'c6', summary: 'Bad', start: { dateTime: 'not a date' }, end: { dateTime: 'x' } }, { summary: 'No id', start: { dateTime: iso(NOW) } }, null, 'x', { id: 'c7', start: { date: 'tomorrow' }, end: { date: 'later' } }]) assert.equal(CI.parse(ev), null, JSON.stringify(ev));
  assert.ok(CI.parse(timed('c8', 'Accepted', NOW, 60, { attendees: [{ self: true, responseStatus: 'accepted' }] })), 'an event you accepted is kept'); assert.ok(CI.parse(timed('c9', 'Tentative', NOW, 60, { attendees: [{ self: true, responseStatus: 'tentative' }] })));
  assert.ok(CI.parse(timed('ekshort', 'Starts with ek but is not ours', NOW)), 'only the exact Elite OS id pattern is skipped'); assert.ok(CI.parse(timed('c10', 'Out', NOW, 60, { eventType: 'outOfOffice' })));
});

test('THE MIDNIGHT CHECK: reads 14 days back to 180 days ahead, keeps what is on the calendar and says how it went; nothing is written to Google (the client can only list)', async () => {
  const g = fakeGcal([[timed('e1', 'Dentist', NOW + 10 * 3600e3, 45, { location: 'Swords', description: 'private notes', attendees: [{ email: 'a@example.com' }] }), allDay('e2', 'Bank holiday', '2026-12-25'), timed('e3', 'Meeting', NOW + 2 * DAY)]]);
  const r = await run(g); assert.deepEqual([r.ok, r.count, r.written, r.removed], [true, 3, 3, 0]);
  assert.equal(g.calls.length, 1); assert.equal(g.calls[0][0], CAL); assert.equal(g.calls[0][1].timeMin, NOW - 14 * DAY); assert.equal(g.calls[0][1].timeMax, NOW + 180 * DAY);
  const s = await stored(); assert.deepEqual(Object.keys(s).sort(), ['g_e1', 'g_e2', 'g_e3']); assert.equal(s.g_e1.title, 'Dentist'); assert.equal(s.g_e1.importedAt.toMillis(), NOW); assert.doesNotMatch(JSON.stringify(s), /private notes|a@example\.com/, 'only title, place and time are kept');
  const st = (await db.doc('externalSync/state').get()).data(); assert.deepEqual([st.ok, st.count, st.truncated, st.by, st.error], [true, 3, false, 'midnight', null]); assert.equal(st.lastRunAt.toMillis(), NOW);
  const src = fs.readFileSync(path.join(__dirname, '../lib/calendarImport.js'), 'utf8').replace(/\/\/.*$/gm, ''); assert.equal(/insertEvent|updateEvent|patchEvent|deleteEvent|getEvent/.test(src), false, 'it has no way to change anything in Google Calendar');
  assert.deepEqual(Object.keys(Gcal.createCalendarClient({ tokens: { get: async () => 't' } })).includes('listEvents'), true);
});

test('THE NEXT NIGHT: only what changed is written; an event moved or renamed is updated; one deleted or declined in Google disappears; the same again writes nothing', async () => {
  await run(fakeGcal([[timed('e1', 'Dentist', NOW + 10 * 3600e3), timed('e2', 'Lunch', NOW + 12 * 3600e3), timed('e3', 'Gym', NOW + 14 * 3600e3)]]));
  const again = await run(fakeGcal([[timed('e1', 'Dentist', NOW + 10 * 3600e3), timed('e2', 'Lunch', NOW + 12 * 3600e3), timed('e3', 'Gym', NOW + 14 * 3600e3)]]), { nowMs: NOW + DAY }); assert.deepEqual([again.written, again.removed], [0, 0], 'unchanged: nothing is written');
  const r = await run(fakeGcal([[timed('e1', 'Dentist (moved)', NOW + 11 * 3600e3), timed('e3', 'Gym', NOW + 14 * 3600e3, 90), timed('e4', 'New one', NOW + 3 * DAY)]]), { nowMs: NOW + 2 * DAY });
  assert.deepEqual([r.written, r.removed, r.count], [3, 1, 3], 'e1 changed, e3 longer, e4 new; e2 is gone'); const s = await stored(); assert.deepEqual(Object.keys(s).sort(), ['g_e1', 'g_e3', 'g_e4']); assert.equal(s.g_e1.title, 'Dentist (moved)'); assert.equal(s.g_e1.start.toMillis(), NOW + 11 * 3600e3); assert.equal(s.g_e3.end.toMillis() - s.g_e3.start.toMillis(), 90 * MIN);
  const none = await run(fakeGcal([[]]), { nowMs: NOW + 3 * DAY }); assert.deepEqual([none.ok, none.count, none.removed], [true, 0, 3], 'an empty calendar really is empty: that is a real answer, not a failure'); assert.deepEqual(await stored(), {});
});

test('OLD EVENTS ARE TIDIED AWAY: what ended before the 14-day window is removed; the screen never grows without end', async () => {
  await db.doc('externalEvents/g_old').set({ source: 'google', title: 'Long ago', start: ts(NOW - 30 * DAY), end: ts(NOW - 30 * DAY + 3600e3), allDay: false, busy: true, private: false, htmlLink: null, location: null });
  await db.doc('externalEvents/g_recent').set({ source: 'google', title: 'Last week', start: ts(NOW - 5 * DAY), end: ts(NOW - 5 * DAY + 3600e3), allDay: false, busy: true, private: false, htmlLink: null, location: null });
  const r = await run(fakeGcal([[timed('recent', 'Last week', NOW - 5 * DAY)]])); assert.equal(r.removed, 1); const s = await stored(); assert.deepEqual(Object.keys(s), ['g_recent']);
});

test('A BAD NIGHT CHANGES NOTHING: Google refusing or not answering leaves every stored event as it was and the screen is told why', async () => {
  await run(fakeGcal([[timed('e1', 'Dentist', NOW + 3600e3), timed('e2', 'Lunch', NOW + 7200e3)]]));
  for (const code of ['forbidden', 'not_found', 'unavailable', 'timeout', 'auth']) {
    const r = await run(fakeGcal([], { fail: new Gcal.GcalError(code, 403, true) }), { nowMs: NOW + DAY }); assert.deepEqual([r.ok, r.error], [false, code]);
    assert.deepEqual(Object.keys(await stored()).sort(), ['g_e1', 'g_e2'], 'nothing was removed after ' + code); const st = (await db.doc('externalSync/state').get()).data(); assert.deepEqual([st.ok, st.error], [false, code]); assert.equal(st.lastRunAt.toMillis(), NOW, 'the last GOOD check is still shown'); assert.equal(st.triedAt.toMillis(), NOW + DAY);
  }
  assert.deepEqual(await CI.run({ db, gcal: null, calendarId: CAL, nowMs: NOW }), { ok: false, error: 'off' }); assert.deepEqual(await CI.run({ db, gcal: fakeGcal([]), calendarId: '', nowMs: NOW }), { ok: false, error: 'off' });
  const ok = await run(fakeGcal([[timed('e1', 'Dentist', NOW + 3600e3)]]), { nowMs: NOW + 2 * DAY }); assert.equal(ok.ok, true); assert.equal((await db.doc('externalSync/state').get()).data().error, null, 'the next good check clears the error');
});

test('MANY EVENTS: pages are joined; a list that is too long for six pages is cut short and says so, and then removes nothing it did not reach', async () => {
  const page = (n) => ({ items: Array.from({ length: 3 }, (_, i) => timed(`p${n}_${i}`, `Event ${n}.${i}`, NOW + (n * 3 + i + 1) * 3600e3)), next: n < 1 ? '1' : null });
  const r = await run(fakeGcal(page)); assert.deepEqual([r.count, r.truncated], [6, false]); assert.equal(Object.keys(await stored()).length, 6);
  await db.doc('externalEvents/g_unreached').set({ source: 'google', title: 'Further on', start: ts(NOW + 100 * DAY), end: ts(NOW + 100 * DAY + 3600e3), allDay: false, busy: true, private: false, htmlLink: null, location: null });
  const endless = (n) => ({ items: [timed('q' + n, 'Endless ' + n, NOW + (n + 1) * 3600e3)], next: String(n + 1) }); const g = fakeGcal(endless); const t = await run(g, { nowMs: NOW + DAY });
  assert.equal(g.calls.length, 6, 'at most six pages'); assert.equal(t.truncated, true); assert.equal((await db.doc('externalSync/state').get()).data().truncated, true); const s = await stored(); assert.ok(s.g_unreached, 'an event the list did not reach is not removed'); assert.ok(s.g_q0 && s.g_q5);
});

test('REFRESH NOW: the same check by a person, not more than once every five minutes (a failed one may be tried again at once)', async () => {
  const g = fakeGcal([[timed('e1', 'Dentist', NOW + 3600e3)]]);
  const first = await CI.refresh({ db, gcal: g, calendarId: CAL, nowMs: NOW }); assert.deepEqual([first.ok, first.count, first.tooSoon], [true, 1, undefined]); assert.equal((await db.doc('externalSync/state').get()).data().by, 'staff');
  const soon = await CI.refresh({ db, gcal: g, calendarId: CAL, nowMs: NOW + 2 * MIN }); assert.deepEqual([soon.ok, soon.tooSoon, soon.count], [true, true, 1]); assert.equal(g.calls.length, 1, 'Google was not asked again');
  const later = await CI.refresh({ db, gcal: g, calendarId: CAL, nowMs: NOW + 6 * MIN }); assert.equal(later.tooSoon, undefined); assert.equal(g.calls.length, 2);
  const bad = fakeGcal([], { fail: new Gcal.GcalError('forbidden', 403, true) }); await CI.refresh({ db, gcal: bad, calendarId: CAL, nowMs: NOW + 20 * MIN }); const retry = await CI.refresh({ db, gcal: g, calendarId: CAL, nowMs: NOW + 21 * MIN }); assert.equal(retry.ok, true); assert.equal(retry.tooSoon, undefined, 'after a failure there is no waiting');
});

test('WHO MAY ASK, AND WHEN IT IS OFF: only signed-in allowlisted staff; not switched on is a plain refusal; nothing else may be sent', async () => {
  const cfg = { allowedEmails: 'thomas@example.com' }, staff = { uid: 'u1', token: { email: 'thomas@example.com', email_verified: true, staff: true } }, gcal = fakeGcal([[timed('e1', 'Dentist', NOW + 3600e3)]]);
  const on = { db, cfg, gcal, phoneCal: { enabled: true, calendarId: CAL }, nowMs: NOW }, call = (auth, data, deps = on) => h.refreshPhoneCalendar(auth, data, deps);
  await rejects(call(null, undefined), 'unauthenticated'); await rejects(call({ uid: 'u2', token: { email: 'x@y.ie', email_verified: true, staff: true } }, undefined), 'permission-denied'); assert.equal(gcal.calls.length, 0, 'a stranger never reaches Google');
  await rejects(call(staff, { x: 1 }), 'invalid-argument'); await rejects(call(staff, [1]), 'invalid-argument'); await rejects(call(staff, 'x'), 'invalid-argument'); await rejects(call(staff, undefined, { ...on, phoneCal: { enabled: false, calendarId: CAL } }), 'failed-precondition', /not switched on/); await rejects(call(staff, undefined, { ...on, gcal: null }), 'failed-precondition');
  assert.deepEqual(await call(staff, undefined), { ok: true, count: 1 }); assert.deepEqual(await call(staff, {}, { ...on, nowMs: NOW + MIN }), { ok: true, count: 1, tooSoon: true });
  assert.deepEqual(await call(staff, undefined, { ...on, gcal: fakeGcal([], { fail: new Gcal.GcalError('forbidden', 403, true) }), nowMs: NOW + 30 * MIN }), { ok: false, error: 'forbidden' });
});

test('THE TIMER AND THE SWITCH: one run a day at midnight Irish time, off unless GCAL_IMPORT=on and a calendar is set; the callable exists', () => {
  const idx = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  assert.match(idx, /exports\.calendarImport = onSchedule\(\{ schedule: '0 0 \* \* \*', timeZone: 'Europe\/Dublin'/); assert.match(idx, /defineString\('GCAL_IMPORT', \{ default: 'off' \}\)/); assert.match(idx, /defineString\('GCAL_IMPORT_CALENDAR_ID', \{ default: '' \}\)/); assert.match(idx, /exports\.refreshPhoneCalendar = onCall\(/);
  assert.match(idx, /GCAL_IMPORT\.value\(\)\.trim\(\)\.toLowerCase\(\) === 'on' && !!calendarId/, 'off unless switched on and a calendar is named'); assert.match(idx, /if \(!d\.phoneCal\.enabled\) return;/, 'the timer does nothing when it is off');
});
