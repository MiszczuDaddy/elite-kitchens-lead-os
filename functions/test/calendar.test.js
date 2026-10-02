// Phase 5 (M2): one-way Google Calendar sync. Real Firestore + Storage emulators and a local fake Google Calendar
// (no real Google account is ever contacted). The fake can be made to fail, lose answers, refuse access or be slow.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const h = require('../lib/handlers');
const A = require('../lib/appointments');
const sync = require('../lib/calendarSync');
const gcalLib = require('../lib/gcal');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT, storageBucket: 'demo-leados.firebasestorage.app' });
const db = getFirestore();
const bucket = getStorage().bucket();
const cfg = { allowedEmails: 'thomas@example.com' };
const staff = { uid: 'u1', token: { email: 'thomas@example.com', email_verified: true, staff: true } };
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code, `expected ${code}`);
const CAL = 'cal-test@group.calendar.google.com';
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const P = '353851111111', Q = '353852222222';
const dublinDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(new Date(ms));
const D1 = dublinDate(Date.now() + 2 * DAY), D2 = dublinDate(Date.now() + 3 * DAY);
let seq = 0;
const rid = () => 'cal-' + (++seq) + '-abcdefgh';

// ---------------- a fake Google Calendar ----------------
const F = { events: new Map(), calls: [], down: false, forbidden: false, loseNext: 0, delayMs: 0, hook: null, base: '' };
F.reset = () => { Object.assign(F, { down: false, forbidden: false, loseNext: 0, delayMs: 0, hook: null }); F.events.clear(); F.calls.length = 0; };
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const url = new URL(req.url, 'http://fake');
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
    const call = { method: req.method, cal: m && decodeURIComponent(m[1]), id: m && m[2] && decodeURIComponent(m[2]), query: url.search,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null, auth: req.headers.authorization };
    F.calls.push(call);
    const send = (status, obj) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(obj ? JSON.stringify(obj) : ''); };
    if (F.delayMs) await new Promise((r) => setTimeout(r, F.delayMs));
    if (F.hook) { const fn = F.hook; F.hook = null; await fn(call); }
    if (call.auth !== 'Bearer test-token') return send(401, { error: { message: 'invalid credentials' } });
    if (F.down) return send(503, { error: { message: 'backend error' } });
    if (F.forbidden) return send(403, { error: { message: 'forbidden', errors: [{ reason: 'requiredAccessLevel' }] } });
    if (!m) return send(404, { error: { message: 'not found' } });
    const key = (id) => `${call.cal}|${id}`;
    const link = (id) => `https://calendar.test/event?eid=${id}`;
    let status = 200, out = null;
    const e = call.id ? F.events.get(key(call.id)) : null;
    if (req.method === 'POST') {
      if (F.events.has(key(call.body.id))) return send(409, { error: { message: 'The requested identifier already exists.' } });
      out = { ...call.body, status: call.body.status || 'confirmed', htmlLink: link(call.body.id) };
      F.events.set(key(call.body.id), out);
    } else if (req.method === 'GET') {
      if (!e) return send(404, { error: { message: 'Not Found' } });
      out = e;
    } else if (req.method === 'PUT') {
      if (!e) return send(404, { error: { message: 'Not Found' } });
      out = { ...call.body, id: call.id, htmlLink: link(call.id) };
      F.events.set(key(call.id), out);
    } else if (req.method === 'PATCH') {
      if (!e) return send(404, { error: { message: 'Not Found' } });
      out = Object.assign(e, call.body);
    } else if (req.method === 'DELETE') {
      if (!e) return send(404, { error: { message: 'Not Found' } });
      if (e.status === 'cancelled') return send(410, { error: { message: 'Resource has been deleted' } });
      e.status = 'cancelled'; status = 204;
    }
    if (F.loseNext > 0) { F.loseNext--; return send(503, { error: { message: 'lost' } }); }   // the change happened; the answer was lost
    send(status, out);
  });
});
const live = () => [...F.events.values()].filter((e) => e.status !== 'cancelled');
const calls = (method) => F.calls.filter((c) => c.method === method);
let gcal;
const deps = (over = {}) => ({ db, cfg, bucket, calendar: { enabled: true, calendarId: CAL, appUrl: 'https://demo-leados.web.app' }, gcal, ...over });

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  F.base = `http://127.0.0.1:${server.address().port}`;
  gcal = gcalLib.createCalendarClient({ apiBase: F.base, tokens: { get: async () => 'test-token' } });
});
after(() => { server.closeAllConnections(); server.close(); });

const book = (extra = {}, d = deps()) => h.createAppointment(staff, { phone: P, date: D1, time: '10:00', requestId: rid(), ...extra }, d);
const appt = async (id) => (await db.doc('appointments/' + id).get()).data();
const conv = async (p = P) => (await db.doc('conversations/' + p).get()).data();
async function seed(p = P, extra = {}, name = 'Anna') {
  await db.doc('contacts/' + p).set({ phone: p, name, createdAt: Timestamp.now() });
  await db.doc('conversations/' + p).set({ phone: p, name, createdAt: Timestamp.now(), updatedAt: Timestamp.now(), lastMessage: 'Hi', unreadCount: 0, ...extra });
}
beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  F.reset();
});

// ---------------- the happy path ----------------
test('booking creates exactly one Google event with the agreed details: name, phone, location; no notes, no attendees', async () => {
  await seed(); await seed(Q, {}, 'Brian');
  const r = await book({ location: '12 Main St, Swords', notes: 'Internal: dog in the garden' });
  assert.equal(r.calendar.state, 'synced');
  const a = await appt(r.id), s = a.sync.google;
  assert.equal(s.state, 'synced'); assert.equal(s.syncedVersion, 1); assert.equal(s.created, true); assert.equal(s.calendarId, CAL);
  assert.equal(s.eventId, gcalLib.eventIdFor(r.id)); assert.ok(s.htmlLink);
  assert.equal(live().length, 1);
  const e = live()[0];
  assert.equal(e.id, s.eventId);
  assert.equal(e.summary, 'Consultation – Anna');
  assert.equal(e.location, '12 Main St, Swords');
  assert.match(e.description, /Phone: \+353 85 111 1111/);
  assert.match(e.description, /Open in Elite OS: https:\/\/demo-leados\.web\.app\/#c\/353851111111/);
  assert.equal(JSON.stringify(e).includes('dog'), false);                       // internal notes never leave Elite OS
  assert.equal(e.attendees, undefined);
  assert.equal(e.start.timeZone, 'Europe/Dublin');
  assert.equal(Date.parse(e.start.dateTime), a.start.toMillis()); assert.equal(Date.parse(e.end.dateTime), a.end.toMillis());
  assert.deepEqual(e.reminders, { useDefault: true });
  assert.equal(e.extendedProperties.private.ekAppointmentId, r.id);
  assert.deepEqual(F.calls.map((c) => c.method), ['POST']);                      // the first attempt simply creates it
  assert.ok(F.calls.every((c) => c.query.includes('sendUpdates=none')));        // Google never emails anyone
  const sv = await book({ phone: Q, type: 'site_visit' });
  assert.equal(F.events.get(`${CAL}|${gcalLib.eventIdFor(sv.id)}`).summary, 'Site visit – Brian');
  assert.equal(F.events.get(`${CAL}|${gcalLib.eventIdFor(sv.id)}`).location, '');
});

test('sync switched off: nothing is sent and the appointment says "off"; switching it on later catches up', async () => {
  await seed();
  const off = deps({ calendar: { enabled: false, calendarId: CAL } });
  const r = await book({}, off);
  assert.equal(r.calendar.state, 'off'); assert.equal((await appt(r.id)).sync.google.state, 'off');
  const gone = await book({ time: '12:00' }, off);
  await h.cancelAppointment(staff, { id: gone.id }, off);                        // made and cancelled while sync was off
  assert.equal(F.calls.length, 0);
  assert.equal((await sync.sweep(off)).skipped, 'off');
  const out = await sync.sweep(deps());
  assert.equal(out.synced, 2);
  assert.equal(live().length, 1);
  assert.equal(live()[0].extendedProperties.private.ekAppointmentId, r.id);
  assert.equal((await appt(gone.id)).sync.google.state, 'synced');             // nothing to remove: no event was ever made for it
});

// ---------------- Google trouble ----------------
test('Google down when booking: the booking still succeeds; the sweeper retries on schedule and creates one event', async () => {
  await seed(); F.down = true;
  const r = await book();
  assert.equal(r.calendar.state, 'retrying');
  assert.equal((await conv()).inboxStatus, 'booked');                            // Elite OS saved it, stage and all
  let s = (await appt(r.id)).sync.google;
  assert.equal(s.attempts, 1); assert.equal(s.lastError, 'unavailable');
  const wait = s.nextAttemptAt.toMillis() - s.lastAttemptAt.toMillis();
  assert.ok(wait >= MIN && wait < MIN + 10000, 'first retry after about a minute');
  F.down = false;
  assert.equal((await sync.sweep(deps())).pushed, 0);                            // not due yet
  assert.equal(live().length, 0);
  assert.equal((await sync.sweep(deps(), { now: () => Date.now() + 2 * MIN })).synced, 1);
  assert.equal(live().length, 1);
  s = (await appt(r.id)).sync.google;
  assert.equal(s.state, 'synced'); assert.equal(s.attempts, 0); assert.equal(s.lastError, null); assert.equal(s.failingSince, null);
});

test('a lost answer (Google created the event but we never heard back) still ends with exactly one event', async () => {
  await seed(); F.loseNext = 1;
  const r = await book();
  assert.equal(r.calendar.state, 'retrying');
  assert.equal(F.events.size, 1);                                                // it does exist in Google
  await sync.sweep(deps(), { now: () => Date.now() + 2 * MIN });
  assert.equal(live().length, 1);
  assert.deepEqual(F.calls.map((c) => c.method), ['POST', 'GET', 'PUT']);         // checked first, then updated: no second create
  assert.equal((await appt(r.id)).sync.google.state, 'synced');
});

test('if an event with our id already exists, it is updated, never duplicated', async () => {
  await seed();
  const requestId = rid(), eid = gcalLib.eventIdFor(A.appointmentId(P, requestId));
  F.events.set(`${CAL}|${eid}`, { id: eid, summary: 'stale', status: 'confirmed' });
  const r = await book({ requestId });
  assert.equal(r.calendar.state, 'synced');
  assert.equal(live().length, 1); assert.equal(live()[0].summary, 'Consultation – Anna');
  assert.deepEqual(F.calls.map((c) => c.method), ['POST', 'PUT']);
});

test('rescheduling updates the same event; several reschedules during an outage end on the latest time', async () => {
  await seed();
  const r = await book();
  const u = await h.updateAppointment(staff, { id: r.id, date: D2, time: '14:30' }, deps());
  assert.equal(u.calendar.state, 'synced');
  assert.equal(live().length, 1);
  assert.equal(Date.parse(live()[0].start.dateTime), (await appt(r.id)).start.toMillis());
  assert.equal(calls('POST').length, 1);
  F.down = true;
  for (const time of ['09:00', '11:15', '16:45']) assert.equal((await h.updateAppointment(staff, { id: r.id, time }, deps())).calendar.state, 'retrying');
  F.down = false;
  await sync.sweep(deps(), { now: () => Date.now() + 2 * MIN });
  const a = await appt(r.id);
  assert.equal(a.version, 5); assert.equal(a.sync.google.syncedVersion, 5); assert.equal(a.sync.google.state, 'synced');
  assert.equal(live().length, 1);
  assert.equal(Date.parse(live()[0].start.dateTime), a.start.toMillis());
  assert.equal(live()[0].extendedProperties.private.ekVersion, '5');
  assert.equal(calls('POST').length, 1);
});

test('a change made while Google is being updated is pushed straight after, so Google ends on the newest version', async () => {
  await seed();
  const requestId = rid(), id = A.appointmentId(P, requestId);
  F.hook = async (call) => { if (call.method === 'POST') await A.update(db, { kind: 'staff', id: 'dad@example.com' }, { id, time: '15:00' }); };
  const r = await book({ requestId });
  assert.equal(r.calendar.state, 'synced');
  const a = await appt(id);
  assert.equal(a.version, 2); assert.equal(a.sync.google.syncedVersion, 2);
  assert.equal(Date.parse(live()[0].start.dateTime), a.start.toMillis());
  assert.equal(live().length, 1);
});

test('cancelling removes the event from Google but keeps the cancelled appointment in Elite OS; the stage stays', async () => {
  await seed();
  const r = await book();
  const c = await h.cancelAppointment(staff, { id: r.id, reason: 'Postponed' }, deps());
  assert.equal(c.calendar.state, 'synced');
  assert.equal(live().length, 0);                                                // gone from everyone's phone
  const a = await appt(r.id);
  assert.equal(a.status, 'cancelled'); assert.equal(a.sync.google.created, false);
  assert.deepEqual(a.history.map((x) => x.action), ['created', 'cancelled']);
  assert.equal((await conv()).inboxStatus, 'booked');
  F.down = true;                                                                 // booked while Google was down, cancelled before it recovered
  const r2 = await book({ time: '13:00' });
  F.down = false;
  const c2 = await h.cancelAppointment(staff, { id: r2.id }, deps());
  assert.equal(c2.calendar.state, 'synced');
  assert.equal(F.events.has(`${CAL}|${gcalLib.eventIdFor(r2.id)}`), false);      // no event was ever created for it
});

test('the immediate push, the sweeper and Retry now all at once still produce exactly one event', async () => {
  await seed(); F.down = true;
  const r = await book();
  F.down = false; F.delayMs = 250;                                               // a slow Google, so the attempts overlap
  await Promise.all([sync.pushNow(deps(), r.id, { force: true }), sync.pushNow(deps(), r.id, { force: true }), sync.retryNow(deps(), r.id),
    sync.sweep(deps(), { now: () => Date.now() + 2 * MIN })]);
  F.delayMs = 0;
  await sync.sweep(deps(), { now: () => Date.now() + 10 * MIN });
  assert.equal(F.events.size, 1); assert.equal(live().length, 1);
  assert.equal((await appt(r.id)).sync.google.state, 'synced');
  // only one of the four talked to Google (the others saw the claim, then "synced"): the failed first try, then one check and one create
  assert.equal(calls('POST').length, 2); assert.equal(calls('GET').length, 1); assert.equal(calls('PUT').length, 0);
});

test('calendar not shared (403): retried with growing gaps, marked failed after 24 hours, fixed by Retry now once shared', async () => {
  await seed(); F.forbidden = true;
  const r = await book();
  let s = (await appt(r.id)).sync.google;
  assert.equal(s.state, 'retrying'); assert.equal(s.lastError, 'forbidden');
  const t1 = Date.now() + 2 * MIN;
  await sync.sweep(deps(), { now: () => t1 });
  s = (await appt(r.id)).sync.google;
  assert.equal(s.attempts, 2);
  const gap = s.nextAttemptAt.toMillis() - t1;
  assert.ok(gap >= 5 * MIN - 1000 && gap <= 5 * MIN + 10000, 'second retry after about five minutes');
  await db.doc('appointments/' + r.id).update({ 'sync.google.failingSince': Timestamp.fromMillis(Date.now() - 25 * HOUR) });
  await sync.sweep(deps(), { now: () => Date.now() + HOUR });
  s = (await appt(r.id)).sync.google;
  assert.equal(s.state, 'failed'); assert.equal(s.nextAttemptAt, null);
  const n = F.calls.length;
  await sync.sweep(deps(), { now: () => Date.now() + 3 * HOUR });                // the sweeper leaves failed ones alone
  assert.equal(F.calls.length, n);
  F.forbidden = false;
  const x = await h.retryCalendarSync(staff, { id: r.id }, deps());
  assert.equal(x.calendar.state, 'synced'); assert.equal(live().length, 1);
  assert.equal((await appt(r.id)).sync.google.failingSince, null);
});

test('token or credential problems are retried and never break a booking', async () => {
  await seed();
  const noToken = gcalLib.createCalendarClient({ apiBase: F.base, tokens: { get: async () => { throw new gcalLib.GcalError('token', 0, true); } } });
  const r = await book({}, deps({ gcal: noToken }));
  assert.equal(r.calendar.state, 'retrying');
  const a = await appt(r.id);
  assert.equal(a.status, 'scheduled'); assert.equal(a.sync.google.lastError, 'token');
  const wrongToken = gcalLib.createCalendarClient({ apiBase: F.base, tokens: { get: async () => 'expired-token' } });
  const r2 = await book({ time: '11:00' }, deps({ gcal: wrongToken }));
  assert.equal((await appt(r2.id)).sync.google.lastError, 'auth');
  assert.equal(live().length, 0);
});

test('an event deleted by hand in Google comes back when the appointment next changes', async () => {
  await seed();
  const r = await book();
  const key = `${CAL}|${gcalLib.eventIdFor(r.id)}`;
  F.events.get(key).status = 'cancelled';                                        // deleted by the calendar owner
  await h.updateAppointment(staff, { id: r.id, time: '11:00' }, deps());
  assert.equal(F.events.get(key).status, 'confirmed');
  F.events.delete(key);                                                          // or gone completely
  await h.updateAppointment(staff, { id: r.id, time: '12:00' }, deps());
  assert.equal(live().length, 1);
  assert.equal(Date.parse(live()[0].start.dateTime), (await appt(r.id)).start.toMillis());
});

// ---------------- erasure ----------------
test('erasure: the customer\'s events are blanked and deleted; if Google is down, a clean-up record finishes the job later', async () => {
  await seed(P); await seed(Q, {}, 'Brian');
  const r1 = await book(), r2 = await book({ time: '15:00' }), rq = await book({ phone: Q });
  assert.equal(live().length, 3);
  assert.deepEqual(await h.deleteCustomer(staff, { phone: P, confirm: '1111' }, deps()), { messages: 0, files: 0 });
  assert.deepEqual(live().map((e) => e.extendedProperties.private.ekAppointmentId), [rq.id]);
  for (const id of [r1.id, r2.id]) {
    const e = F.events.get(`${CAL}|${gcalLib.eventIdFor(id)}`);
    assert.equal(e.status, 'cancelled'); assert.equal(e.summary, 'Removed'); assert.equal(e.description, ''); assert.equal(e.location, '');
  }
  assert.equal((await db.collection('calendarCleanup').get()).size, 0);
  await book({ phone: Q, time: '16:00' });
  F.down = true;
  await h.deleteCustomer(staff, { phone: Q, confirm: '2222' }, deps());           // Google down during the erasure
  const tombs = (await db.collection('calendarCleanup').get()).docs.map((d) => d.data());
  assert.equal(tombs.length, 2);
  for (const t of tombs) assert.deepEqual(Object.keys(t).sort(), ['attempts', 'calendarId', 'createdAt', 'eventId', 'lastError', 'nextAttemptAt']);
  assert.equal(JSON.stringify(tombs).includes('Brian') || JSON.stringify(tombs).includes(Q), false);   // ids only: no personal data
  F.down = false;
  const out = await sync.sweep(deps());
  assert.equal(out.cleaned, 2);
  assert.equal(live().length, 0);
  assert.equal((await db.collection('calendarCleanup').get()).size, 0);
});

test('erasure while Google is being updated: the event that push creates is removed as well', async () => {
  await seed();
  const requestId = rid(), id = A.appointmentId(P, requestId);
  F.hook = async (call) => { if (call.method === 'POST') await h.deleteCustomer(staff, { phone: P, confirm: '1111' }, deps()); };
  const r = await book({ requestId });
  assert.equal(r.calendar.state, 'gone');
  assert.equal(await appt(id), undefined);
  assert.equal(live().length, 0);
  assert.equal((await db.collection('calendarCleanup').get()).size, 0);
});

// ---------------- safety ----------------
test('privacy: logs and stored errors never contain names, phone numbers or emails', async () => {
  await seed();
  const lines = [], orig = { log: console.log, error: console.error };
  console.log = (...x) => lines.push(x.join(' ')); console.error = console.log;
  let lastError;
  try {
    F.down = true;
    const r = await book({ location: '12 Main St' });
    lastError = (await appt(r.id)).sync.google.lastError;
    await h.deleteCustomer(staff, { phone: P, confirm: '1111' }, deps());
  } finally { console.log = orig.log; console.error = orig.error; F.down = false; }
  assert.equal(lastError, 'unavailable');
  const text = lines.join('\n');
  assert.ok(lines.length > 0);
  for (const bad of ['Anna', '353851111111', '85 111 1111', 'Main St', 'thomas@example.com']) assert.equal(text.includes(bad), false, bad);
});

test('retryCalendarSync is for staff only, and checks the appointment', async () => {
  await seed();
  const r = await book();
  await rejects(h.retryCalendarSync(null, { id: r.id }, deps()), 'unauthenticated');
  await rejects(h.retryCalendarSync({ uid: 'x', token: { email: 'stranger@gmail.com', email_verified: true, staff: true } }, { id: r.id }, deps()), 'permission-denied');
  await rejects(h.retryCalendarSync(staff, { id: 'nope' }, deps()), 'invalid-argument');
  await rejects(h.retryCalendarSync(staff, { id: 'a_' + 'f'.repeat(24) }, deps()), 'not-found');
  assert.equal((await h.retryCalendarSync(staff, { id: r.id }, deps())).calendar.state, 'synced');
});

test('keyless sign-in: runtime identity -> IAM generateAccessToken for the calendar account, calendar.events scope only, cached', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, opts });
    if (url.startsWith('http://meta.test')) return new Response(JSON.stringify({ access_token: 'runtime-tok', expires_in: 3599 }), { status: 200 });
    return new Response(JSON.stringify({ accessToken: 'cal-tok', expireTime: new Date(Date.now() + HOUR).toISOString() }), { status: 200 });
  };
  const sa = 'ek-calendar@elite-kitchens-lead-os.iam.gserviceaccount.com';
  const p = gcalLib.serviceAccountTokenProvider({ serviceAccount: sa, fetchImpl, metadataBase: 'http://meta.test', iamBase: 'https://iam.test' });
  assert.equal(await p.get(), 'cal-tok');
  assert.equal(await p.get(), 'cal-tok');
  assert.equal(seen.length, 2);                                                  // the second call came from the cache
  assert.equal(seen[0].url, 'http://meta.test/computeMetadata/v1/instance/service-accounts/default/token');
  assert.equal(seen[0].opts.headers['Metadata-Flavor'], 'Google');
  assert.equal(seen[1].url, `https://iam.test/v1/projects/-/serviceAccounts/${encodeURIComponent(sa)}:generateAccessToken`);
  assert.equal(seen[1].opts.headers.authorization, 'Bearer runtime-tok');
  assert.deepEqual(JSON.parse(seen[1].opts.body), { scope: ['https://www.googleapis.com/auth/calendar.events'], lifetime: '3600s' });
  p.clear(); await p.get();
  assert.equal(seen.length, 4);
  const refused = gcalLib.serviceAccountTokenProvider({ serviceAccount: sa, metadataBase: 'http://meta.test', iamBase: 'https://iam.test',
    fetchImpl: async (url) => (url.startsWith('http://meta.test') ? new Response(JSON.stringify({ access_token: 'x' }), { status: 200 }) : new Response('{}', { status: 403 })) });
  await assert.rejects(refused.get(), (e) => e.code === 'token' && e.retryable === true);
  await assert.rejects(gcalLib.serviceAccountTokenProvider({ serviceAccount: '' }).get(), (e) => e.code === 'token');
});

test('event ids are fixed per appointment and valid for Google; event text for other numbers and missing names', () => {
  const id = A.appointmentId(P, 'req-x-abcdefgh');
  assert.equal(gcalLib.eventIdFor(id), gcalLib.eventIdFor(id));
  assert.match(gcalLib.eventIdFor(id), /^[a-v0-9]{5,1024}$/);
  assert.notEqual(gcalLib.eventIdFor(id), gcalLib.eventIdFor(A.appointmentId(P, 'req-y-abcdefgh')));
  assert.equal(sync.formatPhone('353851234567'), '+353 85 123 4567');
  assert.equal(sync.formatPhone('447700900123'), '+447700900123');
  const body = sync.eventBody('a_1', { phone: '447700900123', customerName: null, type: 'other', location: null,
    start: Timestamp.fromMillis(0), end: Timestamp.fromMillis(HOUR), version: 3 }, null);
  assert.equal(body.summary, 'Other – +447700900123');
  assert.equal(body.location, '');
  assert.equal(body.description.includes('Open in Elite OS'), false);
  assert.equal(body.extendedProperties.private.ekVersion, '3');
});
