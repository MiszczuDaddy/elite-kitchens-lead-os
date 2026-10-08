// Phase 5 (M1): appointments. Real Firestore + Storage emulators; no Google Calendar or WhatsApp calls are involved.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing');
const h = require('../lib/handlers');
const store = require('../lib/store');
const A = require('../lib/appointments');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT, storageBucket: 'demo-leados.firebasestorage.app' });
const db = getFirestore();
const cfg = { allowedEmails: 'thomas@example.com' };
const staff = { uid: 'u1', token: { email: 'thomas@example.com', email_verified: true, staff: true } };
const actor = { kind: 'staff', id: 'thomas@example.com' };
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code, `expected ${code}`);

// Fixed clock for everything date-related: Friday 2 Oct 2026, 10:00 in Dublin (09:00 UTC, Irish summer time).
const MIN = 60 * 1000, DAY = 24 * 60 * MIN;
const NOW = Date.UTC(2026, 9, 2, 9, 0);
const P = '353851111111', Q = '353852222222';
let seq = 0;
const rid = () => 'req-' + (++seq) + '-abcdefgh';
const slot = (extra = {}) => ({ phone: P, date: '2026-10-08', time: '10:00', requestId: rid(), ...extra });
const make = (extra = {}, now = NOW) => A.create(db, actor, slot(extra), now);
const conv = async (p = P) => (await db.doc('conversations/' + p).get()).data();
const appt = async (id) => (await db.doc('appointments/' + id).get()).data();
const count = async () => (await db.collection('appointments').get()).size;
async function seed(p = P, extra = {}, name = 'Anna') {
  await db.doc('contacts/' + p).set({ phone: p, name, location: 'Swords', createdAt: Timestamp.now() });
  await db.doc('conversations/' + p).set({ phone: p, name, createdAt: Timestamp.now(), updatedAt: Timestamp.now(), lastMessage: 'Hi', unreadCount: 2, ...extra });
}
beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
});

// ---------------- who may call ----------------
test('only signed-in, allowlisted staff can create, reschedule or cancel; nothing is written otherwise', async () => {
  await seed();
  const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(new Date(Date.now() + DAY));
  const data = { phone: P, date: tomorrow, time: '10:00', requestId: rid() };
  const people = [[null, 'unauthenticated'],
    [{ uid: 'x', token: { email: 'stranger@gmail.com', email_verified: true, staff: true } }, 'permission-denied'],
    [{ uid: 'x', token: { email: 'thomas@example.com', email_verified: true } }, 'permission-denied']];      // allowlisted but no staff claim
  for (const [who, code] of people) {
    await rejects(h.createAppointment(who, data, { db, cfg }), code);
    await rejects(h.updateAppointment(who, { id: 'a_' + '0'.repeat(24), notes: 'x' }, { db, cfg }), code);
    await rejects(h.cancelAppointment(who, { id: 'a_' + '0'.repeat(24) }, { db, cfg }), code);
  }
  assert.equal(await count(), 0);
  assert.equal((await conv()).inboxStatus, undefined);
  const r = await h.createAppointment(staff, data, { db, cfg });                  // and staff can, through the real wrapper
  assert.equal((await appt(r.id)).createdBy.id, 'thomas@example.com');
});

// ---------------- input ----------------
test('input is validated: dates, 15-minute times, durations, types, lengths, unknown fields, the booking window', async () => {
  await seed();
  const badInputs = [
    { date: '' }, { date: '8/10/2026' }, { date: '2026-02-30' }, { time: '' }, { time: '10:10' }, { time: '24:00' }, { time: '9:00' },
    { durationMin: 0 }, { durationMin: 50 }, { durationMin: 495 }, { durationMin: '60' }, { durationMin: 60.5 },
    { type: 'showroom' }, { type: 'Consultation' }, { location: 'x'.repeat(201) }, { notes: 'x'.repeat(2001) }, { location: 5 },
    { colour: 'red' }, { requestId: '' }, { requestId: 'short' }, { requestId: 'has spaces in it' }, { phone: '123' },
    { date: '2026-09-30', time: '10:00' },          // two days ago
    { date: '2028-10-10' },                         // more than two years ahead
    { date: '2027-03-28', time: '01:30' },          // does not exist in Ireland: the clocks go from 01:00 to 02:00
  ];
  for (const b of badInputs) await rejects(make(b), 'invalid-argument');
  await rejects(A.create(db, actor, null, NOW), 'invalid-argument');
  assert.equal(await count(), 0);
  // the edges that are allowed
  for (const ok of [{ date: '2026-10-01', time: '10:30' }, { date: '2028-09-30', time: '09:00' }, { durationMin: 15 }, { durationMin: 480 }, { type: 'site_visit' }, { type: 'other' }]) await make(ok);
  assert.equal(await count(), 6);
});

test('times are Dublin wall-clock times, on both sides of the clock change; defaults are Consultation and 60 minutes', async () => {
  await seed();
  const summer = await appt((await make({ date: '2026-10-08', time: '10:00' })).id);
  assert.equal(summer.start.toMillis(), Date.UTC(2026, 9, 8, 9, 0));           // Irish summer time: UTC+1
  assert.equal(summer.end.toMillis(), Date.UTC(2026, 9, 8, 10, 0));
  const winter = await appt((await make({ date: '2027-01-14', time: '10:00' })).id);
  assert.equal(winter.start.toMillis(), Date.UTC(2027, 0, 14, 10, 0));        // winter: UTC+0
  assert.equal(summer.type, 'consultation'); assert.equal(summer.durationMin, 60); assert.equal(summer.timeZone, 'Europe/Dublin');
  const late = await appt((await make({ date: '2026-10-25', time: '01:30' })).id);   // the hour that happens twice: the later one
  assert.equal(late.start.toMillis(), Date.UTC(2026, 9, 25, 1, 30));
});

test('an appointment is linked to an existing customer only: unknown customers are refused and nothing is created', async () => {
  await rejects(make({ phone: '353800000000' }), 'not-found');
  assert.equal(await count(), 0);
  assert.equal((await db.doc('conversations/353800000000').get()).exists, false);
  assert.equal((await db.doc('contacts/353800000000').get()).exists, false);
  await seed();
  const a = await appt((await make({ phone: '+353 85 111 1111', location: '  12 Main St, Swords  ', notes: 'Side gate' })).id);
  assert.equal(a.phone, P); assert.equal(a.customerName, 'Anna');
  assert.equal(a.location, '12 Main St, Swords'); assert.equal(a.notes, 'Side gate');
  assert.equal(a.status, 'scheduled'); assert.equal(a.version, 1); assert.equal(a.rescheduleCount, 0);
  assert.deepEqual(a.history.map((x) => x.action), ['created']);
});

// ---------------- CRM stage ----------------
test('booking a New lead moves them to Booked exactly like a manual move, and nothing else on the customer changes', async () => {
  await seed(P); await seed(Q, {}, 'Brian');
  const before = await conv(P);
  const r = await make();
  assert.deepEqual(r.stage, { from: 'inbox', to: 'booked', corrected: false });
  await store.setConversationStatus(db, Q, 'booked', NOW);                      // the same move made by hand
  const [p, q] = [await conv(P), await conv(Q)];
  assert.equal(p.inboxStatus, 'booked');
  assert.ok(p.stageDates.booked instanceof Timestamp);
  assert.deepEqual(Object.keys(p.stageDates), Object.keys(q.stageDates));
  assert.deepEqual(p.lastMove, q.lastMove);
  const { inboxStatus, stageDates, lastMove, ...rest } = p;
  assert.deepEqual(rest, before);                                               // activity, unread, preview, name: untouched
  assert.equal((await appt(r.id)).movedToBooked, true);
});

test('Booked, Quoted, Won and Closed customers are not disturbed: their record is byte-for-byte unchanged', async () => {
  for (const s of ['booked', 'quoted', 'won', 'closed']) {
    await seed(P, { inboxStatus: s, stageDates: { [s]: Timestamp.fromMillis(NOW - 3 * DAY) }, lastMove: { from: 'inbox', to: s, at: Timestamp.fromMillis(NOW - 3 * DAY), prev: null } });
    const before = await conv();
    const r = await make();
    assert.equal(r.stage, null, s);
    assert.deepEqual(await conv(), before, s);
    assert.equal((await appt(r.id)).movedToBooked, false);
  }
});

test('customers from before Phase 4 (no status at all) are New leads and move to Booked', async () => {
  await seed();
  assert.equal((await conv()).inboxStatus, undefined);
  await make();
  assert.equal((await conv()).inboxStatus, 'booked');
});

test('correction rules still apply: booking right after a quick Booked -> New lead move restores the original Booked date', async () => {
  const original = Timestamp.fromMillis(NOW - 10 * DAY);
  await seed(P, { inboxStatus: 'booked', stageDates: { booked: original } });
  await store.setConversationStatus(db, P, 'inbox', NOW - 2 * MIN);             // moved back by hand two minutes ago
  const r = await make();
  assert.deepEqual(r.stage, { from: 'inbox', to: 'booked', corrected: true });
  const c = await conv();
  assert.equal(c.inboxStatus, 'booked');
  assert.equal(c.stageDates.booked.toMillis(), original.toMillis());           // the genuine earlier date, not re-stamped
  assert.equal(c.lastMove, undefined);
});

test('a stage change made at the same moment is never downgraded: Quoted always wins over the booking', async () => {
  for (let i = 0; i < 6; i++) {
    const p = '35385900000' + i;
    await seed(p);
    await Promise.all([make({ phone: p }), store.setConversationStatus(db, p, 'quoted', NOW)]);
    assert.equal((await conv(p)).inboxStatus, 'quoted', 'customer ' + i);
  }
});

// ---------------- idempotency ----------------
test('the same request twice (double click, retry) creates one appointment and moves the stage once', async () => {
  await seed();
  const data = slot();
  const first = await A.create(db, actor, data, NOW);
  const lm = (await conv()).lastMove;
  const again = await A.create(db, actor, data, NOW + MIN);
  assert.equal(again.id, first.id); assert.equal(again.existing, true);
  assert.deepEqual(again.stage, { from: 'inbox', to: 'booked' });
  assert.deepEqual((await conv()).lastMove, lm);
  assert.equal(await count(), 1);
  const burst = await Promise.all(Array.from({ length: 5 }, () => A.create(db, actor, { ...data, requestId: 'burst-request-1' }, NOW)));
  assert.equal(new Set(burst.map((r) => r.id)).size, 1);
  assert.equal(await count(), 2);
  const second = await make();                                                   // a genuinely new request: a second appointment
  assert.equal(second.stage, null);                                             // already Booked: no further stage change
  assert.equal(await count(), 3);
});

// ---------------- reschedule / edit ----------------
test('rescheduling changes the time, keeps the stage, and records the history', async () => {
  await seed();
  const { id } = await make();
  const before = await conv();
  const r = await A.update(db, actor, { id, date: '2026-10-09', time: '14:30' }, NOW + MIN);
  assert.equal(r.version, 2);
  const a = await appt(id);
  assert.equal(a.start.toMillis(), Date.UTC(2026, 9, 9, 13, 30));
  assert.equal(a.end.toMillis(), Date.UTC(2026, 9, 9, 14, 30));
  assert.equal(a.rescheduleCount, 1);
  assert.deepEqual(a.history.map((x) => x.action), ['created', 'rescheduled']);
  assert.deepEqual(await conv(), before);
  await A.update(db, actor, { id, durationMin: 90 }, NOW + 2 * MIN);             // duration only: same start, later end
  const b = await appt(id);
  assert.equal(b.start.toMillis(), a.start.toMillis()); assert.equal(b.end.toMillis(), Date.UTC(2026, 9, 9, 15, 0));
  assert.equal(b.rescheduleCount, 1); assert.equal(b.version, 3);
});

test('editing details: type, location and notes; clearing; a no-op writes nothing', async () => {
  await seed();
  const { id } = await make({ notes: 'Bring samples' });
  await A.update(db, actor, { id, type: 'site_visit', location: 'Swords', notes: '' }, NOW);
  const a = await appt(id);
  assert.equal(a.type, 'site_visit'); assert.equal(a.location, 'Swords'); assert.equal(a.notes, null);
  assert.equal(a.rescheduleCount, 0); assert.equal(a.history.at(-1).action, 'edited'); assert.equal(a.version, 2);
  const same = await A.update(db, actor, { id, type: 'site_visit', date: '2026-10-08', time: '10:00', durationMin: 60 }, NOW);
  assert.equal(same.unchanged, true); assert.equal((await appt(id)).version, 2);
  await rejects(A.update(db, actor, { id, type: 'showroom' }, NOW), 'invalid-argument');
  await rejects(A.update(db, actor, { id, phone: Q }, NOW), 'invalid-argument');        // an appointment cannot move to another customer
});

test('reschedule guards: changed by someone else, cancelled, unknown, past appointments, history cap', async () => {
  await seed();
  const { id } = await make();
  await rejects(A.update(db, actor, { id, notes: 'x', expectedVersion: 7 }, NOW), 'failed-precondition');
  await A.update(db, actor, { id, notes: 'x', expectedVersion: 1 }, NOW);
  await rejects(A.update(db, actor, { id: 'a_' + 'f'.repeat(24), notes: 'x' }, NOW), 'not-found');
  await rejects(A.update(db, actor, { id: 'nope', notes: 'x' }, NOW), 'invalid-argument');
  const later = NOW + 30 * DAY;                                                 // the appointment is now in the past
  await A.update(db, actor, { id, notes: 'went well' }, later);                 // its details can still be edited
  await rejects(A.update(db, actor, { id, date: '2026-10-08', time: '11:00' }, later), 'invalid-argument');   // but not moved into the past
  for (let i = 0; i < 25; i++) await A.update(db, actor, { id, notes: 'edit ' + i }, NOW);
  assert.equal((await appt(id)).history.length, A.HISTORY_MAX);
  await A.cancel(db, actor, { id }, NOW);
  await rejects(A.update(db, actor, { id, date: '2026-10-10' }, NOW), 'failed-precondition');
});

// ---------------- cancel ----------------
test('cancelling keeps the appointment and its history, never moves the stage back, and is harmless twice', async () => {
  await seed();
  const { id } = await make();
  assert.equal((await conv()).inboxStatus, 'booked');
  const before = await conv();
  const r = await A.cancel(db, actor, { id, reason: 'Customer asked to postpone' }, NOW + MIN);
  assert.equal(r.status, 'cancelled'); assert.equal(r.version, 2);
  const a = await appt(id);
  assert.equal(a.status, 'cancelled'); assert.equal(a.cancelReason, 'Customer asked to postpone');
  assert.deepEqual(a.cancelledBy, actor); assert.deepEqual(a.history.map((x) => x.action), ['created', 'cancelled']);
  assert.deepEqual(await conv(), before);                                       // still Booked
  const again = await A.cancel(db, actor, { id, expectedVersion: 1 }, NOW + 2 * MIN);
  assert.equal(again.alreadyCancelled, true); assert.equal((await appt(id)).version, 2);
  assert.equal(await count(), 1);
});

test('cancel guards and Closed customers: a stale version is refused, and Closed stays Closed throughout', async () => {
  await seed(P, { inboxStatus: 'closed' });
  const { id } = await make();
  await rejects(A.cancel(db, actor, { id, expectedVersion: 5 }, NOW), 'failed-precondition');
  await rejects(A.cancel(db, actor, { id, reason: 'x'.repeat(301) }, NOW), 'invalid-argument');
  await rejects(A.cancel(db, actor, { id: 'a_' + 'e'.repeat(24) }, NOW), 'not-found');
  await A.update(db, actor, { id, time: '12:00' }, NOW);
  await A.cancel(db, actor, { id, expectedVersion: 2 }, NOW);
  assert.equal((await conv()).inboxStatus, 'closed');
});

// ---------------- erasure ----------------
test('deleteCustomer also erases that customer\'s appointments (and nobody else\'s); the response is unchanged', async () => {
  await seed(P); await seed(Q, {}, 'Brian');
  await make(); await make(); await make({ phone: Q });
  const bucket = getStorage().bucket();
  const r = await h.deleteCustomer(staff, { phone: P, confirm: '1111' }, { db, cfg, bucket });
  assert.deepEqual(r, { messages: 0, files: 0 });
  const left = (await db.collection('appointments').get()).docs.map((d) => d.data().phone);
  assert.deepEqual(left, [Q]);
  const audit = (await db.collection('auditLog').get()).docs.map((d) => d.data());
  assert.equal(audit.length, 1); assert.equal(audit[0].appointments, 2);
  assert.equal(JSON.stringify(audit[0]).includes(P), false);                    // still no phone number in the audit
});

// ---------------- security rules ----------------
test('security rules: staff can read appointments; strangers cannot; nobody can write them from a browser', async () => {
  await seed();
  const { id } = await make();
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  const env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { host, port: +port, rules: fs.readFileSync(path.join(__dirname, '../../firestore.rules'), 'utf8') } });
  try {
    const s = env.authenticatedContext('s1', { staff: true, staffUntil: Date.now() + 3600000, email: 'thomas@example.com' }).firestore();
    assert.equal((await s.doc('appointments/' + id).get()).data().phone, P);
    await assertFails(s.doc('appointments/' + id).update({ status: 'cancelled' }));
    await assertFails(s.doc('appointments/a_new').set({ phone: P }));
    await assertFails(s.doc('appointments/' + id).delete());
    const stranger = env.authenticatedContext('x', { email: 'x@gmail.com' }).firestore();
    await assertFails(stranger.doc('appointments/' + id).get());
  } finally { await env.cleanup(); }
});

// ---------------- shared stage rules ----------------
test('planStatusChange: no-op for the current stage; same decisions setConversationStatus has always made', () => {
  assert.equal(store.planStatusChange({ inboxStatus: 'booked' }, 'booked', NOW), null);
  assert.equal(store.planStatusChange({}, 'inbox', NOW), null);
  const g = store.planStatusChange({}, 'booked', NOW);
  assert.deepEqual(g.result, { corrected: false });
  assert.equal(g.patch.inboxStatus, 'booked'); assert.deepEqual(g.patch.lastMove.from, 'inbox');
  const lm = { from: 'quoted', to: 'won', at: Timestamp.fromMillis(NOW - MIN), prev: null };
  assert.deepEqual(store.planStatusChange({ inboxStatus: 'won', lastMove: lm }, 'quoted', NOW).result, { corrected: true, undone: 'won' });
  assert.deepEqual(store.planStatusChange({ inboxStatus: 'won', lastMove: lm }, 'quoted', NOW + 10 * MIN).result, { corrected: false });
});
