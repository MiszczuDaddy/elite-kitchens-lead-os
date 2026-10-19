// Phase 12: a project's installation date is one entry in the calendar (functions/lib/installVisits.js). Real Firestore emulator. Every name and number is made up.
// What matters: one entry per project however often the date is saved, it follows the date (create, move, clear, reinstate, delete the project), the time of day you edited is kept,
// a clash is a warning and never a block, moving or cancelling it in the calendar changes the project's date in the same step, clock changes, and no message to the customer.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const P = require('../lib/projects');
const A = require('../lib/appointments');
const IV = require('../lib/installVisits');
const R = require('../lib/bookingRules');
const { eventBodyFor } = (() => { try { return require('../lib/calendarSync'); } catch (e) { return {}; } })();

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const actor = { kind: 'staff', id: 'thomas@example.com' };
const irish = (y, m, d, hh, mi) => A.dublinToMs(y, m, d, hh, mi);
const NOW = irish(2026, 10, 19, 10, 0);
const PH = '353852220001';
let seq = 0;
const rid = () => 'req-' + (++seq) + '-abcdefgh';
const ts = (ms) => Timestamp.fromMillis(ms);

beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  for (let i = 0; i < 100; i++) { const left = await Promise.all(['appointments', 'conversations', 'contacts', 'bookingNotices', 'projects'].map((c) => db.collection(c).limit(1).get())); if (left.every((x) => x.empty)) break; await new Promise((r) => setTimeout(r, 30)); }      // waitEmpty: the clear has finished before the next test writes
  await db.doc('contacts/' + PH).set({ phone: PH, name: 'Orla Install', createdAt: Timestamp.now() });
  await db.doc('conversations/' + PH).set({ phone: PH, name: 'Orla Install', createdAt: Timestamp.now(), updatedAt: Timestamp.now(), lastMessage: 'Hi' });
});

const project = async () => { const r = await P.create({ db }, actor, { phone: PH, requestId: rid() }, { nowMs: NOW }); return r.id; };
const proj = async (id) => (await db.doc('projects/' + id).get()).data();
const setDate = async (id, date, at = NOW) => P.save({ db }, actor, { id, expectedRev: (await proj(id)).rev, installDate: date }, { nowMs: at });
const installs = async (id) => (await db.collection('appointments').where('projectId', '==', id).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const clock = (t) => { const p = A.dublinParts(t.toMillis()); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')} ${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`; };

test('SETTING THE DATE creates ONE installation visit, 08:00 to 16:00 Irish time, for the customer, queued for Google Calendar, with no customer message', async () => {
  const id = await project();
  const r = await setDate(id, '2026-11-20');
  assert.deepEqual([r.install.action, r.install.id], ['created', IV.installId(id)]);
  const [a] = await installs(id); assert.equal((await installs(id)).length, 1);
  assert.deepEqual([a.type, a.status, a.phone, a.customerName, a.version, a.projectId, a.durationMin], ['installation', 'scheduled', PH, 'Orla Install', 1, id, 480]);
  assert.deepEqual([clock(a.start), clock(a.end)], ['2026-11-20 08:00', '2026-11-20 16:00']);
  assert.equal(a.sync.google.state, 'pending'); assert.equal(a.sync.google.eventId.length > 10, true);
  assert.equal(R.nextAction(a, NOW), null, 'no message is ever offered for an installation'); assert.equal(R.reminderDue({ ...a, customerNotice: { kind: 'confirmation', toldStart: a.start.toMillis(), at: 0 } }, NOW), false);
  assert.equal((await proj(id)).installDate, '2026-11-20');
});

test('SAVING AGAIN never makes a second visit: the same date, the same date with new notes, and a changed date all use the one entry', async () => {
  const id = await project(); await setDate(id, '2026-11-20');
  const same = await setDate(id, '2026-11-20', NOW + 1000);
  assert.equal(same.install, undefined, 'the date did not change: the calendar is not touched');
  const notes = await P.save({ db }, actor, { id, expectedRev: (await proj(id)).rev, notes: 'Bring the long ladder' }, { nowMs: NOW + 2000 }); assert.equal(notes.install, undefined);
  const moved = await setDate(id, '2026-11-24', NOW + 3000); assert.equal(moved.install.action, 'moved');
  const all = await installs(id); assert.equal(all.length, 1);
  assert.deepEqual([clock(all[0].start), all[0].version, all[0].rescheduleCount, all[0].history.map((h) => h.action)], ['2026-11-24 08:00', 2, 1, ['created', 'rescheduled']]);
  assert.equal(all[0].sync.google.state, 'pending');
});

test('THE TIME OF DAY YOU EDITED IS KEPT when the date changes later', async () => {
  const id = await project(); await setDate(id, '2026-11-20');
  await A.update(db, actor, { id: IV.installId(id), time: '09:30', durationMin: 360 }, NOW);
  await setDate(id, '2026-11-26', NOW + 1000);
  const [a] = await installs(id); assert.deepEqual([clock(a.start), clock(a.end)], ['2026-11-26 09:30', '2026-11-26 15:30']);
});

test('CLEARING THE DATE cancels the entry (kept, with its history); setting a date again brings the SAME entry back', async () => {
  const id = await project(); await setDate(id, '2026-11-20');
  const cleared = await setDate(id, '', NOW + 1000); assert.equal(cleared.install.action, 'cancelled');
  let [a] = await installs(id); assert.deepEqual([a.status, a.cancelReason, a.version, a.sync.google.state], ['cancelled', 'The installation date was cleared on the project', 2, 'pending']);
  assert.equal((await proj(id)).installDate, null);
  assert.equal((await setDate(id, '', NOW + 2000)).install, undefined, 'clearing an already clear date does nothing');
  const back = await setDate(id, '2026-12-01', NOW + 3000); assert.equal(back.install.action, 'reinstated');
  [a] = await installs(id); assert.equal((await installs(id)).length, 1);
  assert.deepEqual([a.status, a.cancelReason, clock(a.start), a.version], ['scheduled', null, '2026-12-01 08:00', 3]);
});

test('DELETING THE PROJECT cancels its installation entry; other visits of the customer are untouched', async () => {
  const id = await project(); await setDate(id, '2026-11-20');
  const other = (await A.create(db, actor, { phone: PH, date: '2026-11-22', time: '10:00', requestId: rid() }, NOW)).id;
  const r = await P.remove({ db }, actor, { id }, { nowMs: NOW + 1000 }); assert.equal(r.removed, true);
  assert.equal((await db.doc('appointments/' + IV.installId(id)).get()).data().status, 'cancelled');
  assert.equal((await db.doc('appointments/' + other).get()).data().status, 'scheduled');
  assert.equal((await db.doc('projects/' + id).get()).exists, false);
  const none = await project(); const gone = await P.remove({ db }, actor, { id: none }, { nowMs: NOW }); assert.equal(gone.removed, true, 'a project that never had a date deletes as before');
});

test('A CLASH is a warning, never a block: it names the visit that overlaps; other days and cancelled visits are not clashes', async () => {
  const id = await project();
  const c1 = (await A.create(db, actor, { phone: PH, date: '2026-11-20', time: '10:00', requestId: rid() }, NOW)).id;
  const c2 = (await A.create(db, actor, { phone: PH, date: '2026-11-20', time: '17:00', requestId: rid() }, NOW)).id;        // after 16:00: no overlap
  const c3 = (await A.create(db, actor, { phone: PH, date: '2026-11-20', time: '12:00', requestId: rid() }, NOW)).id;
  await A.cancel(db, actor, { id: c3 }, NOW);
  await A.create(db, actor, { phone: PH, date: '2026-11-21', time: '10:00', requestId: rid() }, NOW);
  const r = await setDate(id, '2026-11-20');
  assert.equal(r.install.action, 'created');
  assert.deepEqual(r.install.clashes.map((c) => c.id), [c1]); assert.equal(r.install.clashes[0].name, 'Orla Install'); assert.equal(r.install.clashes[0].type, 'consultation');
  assert.equal((await installs(id)).length, 1, 'it was created anyway'); assert.equal((await proj(id)).installDate, '2026-11-20');
  const clear = await setDate(id, '2026-11-21', NOW + 1000); assert.equal(clear.install.clashes.length, 1);
  const free = await setDate(id, '2026-11-23', NOW + 2000); assert.deepEqual(free.install.clashes, []);
});

test('MOVING THE ENTRY IN THE CALENDAR to another day changes the project\'s date in the same step; a change of time on the same day does not', async () => {
  const id = await project(); await setDate(id, '2026-11-20'); const rev = (await proj(id)).rev, vid = IV.installId(id);
  await A.update(db, actor, { id: vid, time: '09:00' }, NOW + 1000);
  assert.deepEqual([(await proj(id)).installDate, (await proj(id)).rev], ['2026-11-20', rev], 'same day: the project is not touched');
  await A.update(db, actor, { id: vid, date: '2026-11-27' }, NOW + 2000);
  const p = await proj(id); assert.deepEqual([p.installDate, p.rev], ['2026-11-27', rev + 1]);
  assert.match(p.history.at(-1).action, /installation date set to 2026-11-27 \(moved in the calendar\)/);
  const again = await setDate(id, '2026-11-27', NOW + 3000); assert.equal(again.install, undefined, 'the date already matches: nothing to do');
  assert.equal((await installs(id)).length, 1);
});

test('CANCELLING THE ENTRY IN THE CALENDAR clears the project\'s date; a consultation with a project number on it is never linked', async () => {
  const id = await project(); await setDate(id, '2026-11-20'); const rev = (await proj(id)).rev;
  await A.cancel(db, actor, { id: IV.installId(id) }, NOW + 1000);
  const p = await proj(id); assert.deepEqual([p.installDate, p.rev], [null, rev + 1]); assert.match(p.history.at(-1).action, /cleared \(cancelled in the calendar\)/);
  const again = await A.cancel(db, actor, { id: IV.installId(id) }, NOW + 2000); assert.equal(again.alreadyCancelled, true); assert.equal((await proj(id)).rev, rev + 1);
  const other = await project(); await db.doc('appointments/' + (await A.create(db, actor, { phone: PH, date: '2026-12-05', time: '10:00', requestId: rid() }, NOW)).id).update({ projectId: other });
  await setDate(other, '2026-12-05'); const o = await proj(other); const c = (await installs(other)).find((x) => x.type === 'consultation');
  await A.cancel(db, actor, { id: c.id }, NOW + 3000); assert.equal((await proj(other)).installDate, '2026-12-05', 'only an installation entry is linked to the date');
});

test('CLOCK CHANGES: 08:00 Irish time is 08:00 UTC in winter and 07:00 UTC in summer; a time that does not exist moves to the next hour', async () => {
  const id = await project();
  await setDate(id, '2026-10-25'); let [a] = await installs(id); assert.equal(a.start.toMillis(), Date.UTC(2026, 9, 25, 8, 0)); assert.equal(a.end.toMillis(), Date.UTC(2026, 9, 25, 16, 0), 'the day the clocks go back');
  await setDate(id, '2026-03-29', NOW + 1000); [a] = await installs(id); assert.equal(a.start.toMillis(), Date.UTC(2026, 2, 29, 7, 0), 'the day the clocks go forward: 08:00 summer time');
  assert.equal(a.end.toMillis() - a.start.toMillis(), 8 * 3600e3);
  const slot = IV.slotFor('2026-03-29', { start: ts(Date.UTC(2026, 2, 28, 1, 30)), durationMin: 60 });        // 01:30 does not exist on 29 March 2026
  assert.equal(A.dublinParts(slot.start).h, 2); assert.equal(A.dublinParts(slot.start).mi, 30);
});

test('THE CALENDAR SHOWS IT AS "Installation – name", and erasing the customer erases it', async () => {
  const id = await project(); await setDate(id, '2026-11-20');
  assert.equal(A.TYPES.installation, 'Installation');
  const cs = require('../lib/calendarSync'); const [a] = await installs(id);
  if (cs.eventBody) assert.equal(cs.eventBody(a.id, a, 'https://example.test').summary, 'Installation – Orla Install');
  const store = require('../lib/store');
  await store.deleteCustomerData(db, require('firebase-admin/storage').getStorage().bucket('demo-leados.appspot.com'), PH);
  assert.equal((await installs(id)).length, 0);
});

test('a date that is not a date, or a stale revision, is refused and changes nothing in the calendar', async () => {
  const id = await project(); await setDate(id, '2026-11-20');
  await assert.rejects(P.save({ db }, actor, { id, expectedRev: (await proj(id)).rev, installDate: '2026-02-30' }, { nowMs: NOW }), (e) => e.code === 'invalid-argument');
  await assert.rejects(P.save({ db }, actor, { id, expectedRev: 99, installDate: '2026-11-25' }, { nowMs: NOW }), (e) => e.code === 'failed-precondition');
  const [a] = await installs(id); assert.equal(clock(a.start), '2026-11-20 08:00');
});
