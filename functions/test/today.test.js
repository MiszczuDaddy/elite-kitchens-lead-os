// Phase 11 (docs/PHASE11_TODAY.md): what the Today tab stores: reminders and quote follow-up snoozes. Real Firestore emulator; nothing is sent to anyone. Every name and number is made up.
// What matters: staff only; strict input; pressing Add twice (or a retry) makes ONE reminder; done / undo / snooze / delete; a quote snooze is tied to the quote's sent time read by the SERVER and
// is undoable; erasing a customer erases their reminders and quote notes.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const h = require('../lib/handlers');
const T = require('../lib/today');
const M = require('../../public/today-model.js');

const PROJECT = 'demo-leados', BUCKET = 'demo-leados.firebasestorage.app';
initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
const db = getFirestore();
const cfg = { allowedEmails: 'thomas@example.com' };
const staff = { uid: 'u1', token: { email: 'thomas@example.com', email_verified: true, staff: true } };
const actor = { kind: 'staff', id: 'thomas@example.com' };
const NOW = Date.UTC(2026, 9, 18, 11, 0), DAY = 24 * 3600e3, ts = (t) => Timestamp.fromMillis(t);
const P = '353871110091', Q = 'q_' + 'ab'.repeat(12);
const rejects = (p, code, re) => assert.rejects(p, (e) => e.code === code && (!re || re.test(e.message)), `expected ${code}${re ? ' ' + re : ''}`);
const rem = (data, nowMs = NOW) => T.saveReminder({ db }, actor, data, { nowMs });
const create = (over = {}) => rem({ action: 'create', requestId: 'req-12345678', title: 'Ring Mr Doyle', dueDate: '2026-10-19', ...over });
const reminders = async () => (await db.collection('reminders').get()).docs.map((d) => ({ id: d.id, ...d.data() }));

beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await db.doc('contacts/' + P).set({ phone: P, name: 'Maeve Doyle', createdAt: ts(NOW - 9e8) });
  await db.doc('conversations/' + P).set({ phone: P, name: 'Maeve Doyle', createdAt: ts(NOW - 9e8), updatedAt: ts(NOW - 1e6) });
});

test('who may use it: staff only, through the real wrappers', async () => {
  await rejects(h.saveReminder(null, { action: 'create' }, { db, cfg }), 'unauthenticated');
  await rejects(h.snoozeQuote(null, { id: Q, days: 1 }, { db, cfg }), 'unauthenticated');
  const other = { uid: 'x', token: { email: 'other@example.com', email_verified: true, staff: true } };
  await rejects(h.saveReminder(other, { action: 'create' }, { db, cfg }), 'permission-denied');
  await rejects(h.snoozeQuote(other, { id: Q, days: 1 }, { db, cfg }), 'permission-denied');
  const r = await h.saveReminder(staff, { action: 'create', requestId: 'req-wrapper1', title: 'Via the wrapper', dueDate: dateOf(1) }, { db, cfg });
  assert.equal(r.ok, true);
});
const dateOf = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

test('CREATE: a reminder with an optional customer and time; the customer\'s name is copied from the server\'s own record; one reminder per request id', async () => {
  const r = await create({ phone: '+353 87 111 0091', dueTime: '16:00' });
  assert.equal(r.ok, true); assert.match(r.id, /^r_[0-9a-f]{24}$/);
  const d = (await db.doc('reminders/' + r.id).get()).data();
  assert.deepEqual([d.title, d.phone, d.customerName, d.dueDate, d.dueTime, d.status, d.createdBy], ['Ring Mr Doyle', P, 'Maeve Doyle', '2026-10-19', '16:00', 'open', 'thomas@example.com']);
  const again = await create({ phone: '+353 87 111 0091', dueTime: '16:00' });
  assert.deepEqual([again.id, again.existing], [r.id, true]); assert.equal((await reminders()).length, 1, 'pressing Add twice makes one');
  const second = await create({ requestId: 'req-87654321', title: 'No customer, no time', dueDate: '2026-10-18' });
  assert.equal((await db.doc('reminders/' + second.id).get()).data().phone, null); assert.equal((await reminders()).length, 2);
  assert.equal((await db.doc('reminders/' + second.id).get()).data().dueTime, null);
});

test('CREATE: strict input (words, date, time, customer); nothing is stored when it is refused', async () => {
  for (const [over, re] of [[{ title: '' }, /what to remember/], [{ title: '   ' }, /what to remember/], [{ title: 'x'.repeat(121) }, /too long/], [{ title: 5 }, /what to remember/],
    [{ dueDate: '2026-10-17' }, /today or a later day/], [{ dueDate: '2026-02-30' }, /Choose a date/], [{ dueDate: 'tomorrow' }, /Choose a date/], [{ dueDate: '2029-01-01' }, /too far/],
    [{ dueTime: '25:00' }, /time like 16:00/], [{ dueTime: '9:00' }, /time like 16:00/], [{ requestId: 'x' }, /request id/], [{ phone: '12' }, /does not look right/], [{ extra: 1 }, /Unknown field/]]) {
    await rejects(create(over), 'invalid-argument', re);
  }
  await rejects(create({ phone: '353870000000' }), 'not-found', /Customer not found/);
  await rejects(rem({ action: 'explode' }), 'invalid-argument'); await rejects(rem(null), 'invalid-argument'); await rejects(rem([]), 'invalid-argument');
  assert.equal((await reminders()).length, 0);
  const title = (await create({ requestId: 'req-spaces01', title: '  Ring   Mr \n Doyle  ' })); assert.equal((await db.doc('reminders/' + title.id).get()).data().title, 'Ring Mr Doyle');
});

test('DONE, UNDO, SNOOZE, DELETE: each changes one reminder; the same press twice changes nothing more; an unknown reminder is a plain refusal', async () => {
  const { id } = await create({ dueDate: '2026-10-18' });
  assert.deepEqual(await rem({ action: 'done', id }), { ok: true });
  let d = (await db.doc('reminders/' + id).get()).data(); assert.deepEqual([d.status, d.doneBy], ['done', 'thomas@example.com']); assert.ok(d.doneAt);
  assert.deepEqual(await rem({ action: 'done', id }), { ok: true, unchanged: true });
  assert.deepEqual(await rem({ action: 'undo', id }), { ok: true }); d = (await db.doc('reminders/' + id).get()).data(); assert.deepEqual([d.status, d.doneAt], ['open', null]);
  assert.deepEqual(await rem({ action: 'snooze', id, dueDate: '2026-10-21', dueTime: '09:30' }), { ok: true, dueDate: '2026-10-21', dueTime: '09:30' });
  d = (await db.doc('reminders/' + id).get()).data(); assert.deepEqual([d.dueDate, d.dueTime, d.status], ['2026-10-21', '09:30', 'open']);
  await rem({ action: 'done', id }); await rem({ action: 'snooze', id, dueDate: '2026-10-22' });
  assert.equal((await db.doc('reminders/' + id).get()).data().status, 'open', 'snoozing a done reminder opens it again (it is wanted again)');
  await rejects(rem({ action: 'snooze', id, dueDate: '2026-10-10' }), 'invalid-argument', /today or a later day/);
  await rejects(rem({ action: 'done', id: 'r_' + '0'.repeat(24) }), 'not-found'); await rejects(rem({ action: 'done', id: 'nope' }), 'invalid-argument', /Missing reminder/);
  await rejects(rem({ action: 'done', id, extra: 1 }), 'invalid-argument');
  assert.deepEqual(await rem({ action: 'delete', id }), { ok: true }); assert.equal((await reminders()).length, 0);
  assert.deepEqual(await rem({ action: 'delete', id }), { ok: true, unchanged: true });
});

// ================================================================ quote snooze =========================================
async function sentQuote(over = {}) {
  await db.doc('quotes/' + Q).set({ phone: P, ref: 'EK-0112', status: 'sent', sentAt: ts(NOW - 8 * DAY), customerName: 'Maeve Doyle', ...over });
}
const snooze = (days, nowMs = NOW) => T.snoozeQuote({ db }, actor, { id: Q, days }, { nowMs });
const mark = async () => { const s = await db.doc('todayMarks/quote_' + Q).get(); return s.exists ? s.data() : null; };

test('QUOTE SNOOZE: until 08:00 Irish time N days ahead; the sent time comes from the SERVER\'s quote, never the screen; the model then hides exactly this send; undo removes it', async () => {
  await sentQuote();
  const r = await snooze(5); assert.equal(r.ok, true);
  const m = await mark(); assert.deepEqual([m.kind, m.quoteId, m.phone, m.ref, m.by, m.basis], ['quote', Q, P, 'EK-0112', 'thomas@example.com', NOW - 8 * DAY]);
  assert.equal(m.snoozeUntil.toMillis(), Date.UTC(2026, 9, 23, 7, 0), '08:00 Irish time on 23 Oct (UTC+1 until the clocks go back on 25 Oct)');
  const quotes = [{ id: Q, ...(await db.doc('quotes/' + Q).get()).data() }], marks = { [M.quoteKey(Q)]: { basis: m.basis, snoozeUntil: m.snoozeUntil, at: m.at } };
  const shown = (k) => M.build({ quotes, marks: k, now: NOW }).cards.length;
  assert.equal(shown({}), 1, 'before the note: listed'); assert.equal(shown(marks), 0, 'with the note: hidden');
  assert.equal(M.build({ quotes, marks, now: Date.UTC(2026, 9, 23, 8, 0) }).cards.length, 1, 'the snooze ended: back');
  await db.doc('quotes/' + Q).update({ sentAt: ts(NOW - 6 * DAY) });
  assert.equal(M.build({ quotes: [{ id: Q, ...(await db.doc('quotes/' + Q).get()).data() }], marks, now: NOW }).cards.length, 1, 'the quote was sent AGAIN: back');
  assert.deepEqual(await snooze(0), { ok: true, undone: true }); assert.equal(await mark(), null);
  assert.deepEqual(await snooze(0), { ok: true, undone: true }, 'undo twice is harmless');
  for (const days of [1, 3, 5, 7]) { await snooze(days); assert.ok(await mark()); }
});

test('QUOTE SNOOZE: only a sent, unanswered quote; strict input; extra fields refused', async () => {
  await rejects(snooze(5), 'not-found');
  for (const status of ['draft', 'accepted', 'declined']) { await sentQuote({ status }); await rejects(snooze(5), 'failed-precondition', /sent and not answered/); }
  await sentQuote({ status: 'sent', sentAt: null }); await rejects(snooze(5), 'failed-precondition');
  await sentQuote();
  for (const days of [2, 10, -1, '3', null, undefined, 1.5]) await rejects(T.snoozeQuote({ db }, actor, { id: Q, days }, { nowMs: NOW }), 'invalid-argument', /1, 3, 5 or 7/);
  for (const data of [{ days: 5 }, { id: 'q_nope', days: 5 }, { id: Q, days: 5, extra: 1 }, null]) await rejects(T.snoozeQuote({ db }, actor, data, { nowMs: NOW }), 'invalid-argument');
  assert.equal(await mark(), null);
});

test('ERASING A CUSTOMER erases their reminders and quote notes, and nobody else\'s', async () => {
  const bucket = getStorage().bucket(BUCKET);
  await create({ phone: P }); await create({ requestId: 'req-other001', title: 'Nobody', dueDate: '2026-10-19' }); await sentQuote(); await snooze(3);
  await db.doc('todayMarks/quote_q_' + 'cd'.repeat(12)).set({ kind: 'quote', phone: '353870000000', basis: 1, snoozeUntil: ts(NOW + DAY) });
  await h.deleteCustomer(staff, { phone: P, confirm: P.slice(-4) }, { db, cfg, bucket });
  assert.deepEqual((await reminders()).map((r) => r.title), ['Nobody'], 'their reminder is gone; the one with no customer stays');
  assert.equal(await mark(), null); assert.equal((await db.collection('todayMarks').get()).size, 1, 'another customer\'s note stays');
});

test('the browser cannot write these records: staff can read them, nobody can write', async () => {
  const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
  const env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'firestore.rules'), 'utf8'), host: process.env.FIRESTORE_EMULATOR_HOST.split(':')[0], port: +process.env.FIRESTORE_EMULATOR_HOST.split(':')[1] } });
  try {
    const s = env.authenticatedContext('staff1', { staff: true, staffUntil: Date.now() + 3600e3 }).firestore();
    for (const p of ['reminders/r_x', 'todayMarks/quote_x']) { await assertSucceeds(s.doc(p).get()); await assertFails(s.doc(p).set({ a: 1 })); await assertFails(s.doc(p).delete()); }
    await assertFails(env.unauthenticatedContext().firestore().doc('reminders/r_x').get());
  } finally { await env.cleanup(); }
});
