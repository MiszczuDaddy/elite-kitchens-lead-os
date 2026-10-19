// Phase 12: the evening-before visit reminder (functions/lib/bookingNotices.js). Real Firestore emulator and a fake Meta: no real message is ever sent. Every name and number is made up.
// What matters: ONE reminder per visit time however many checks run, never to a customer who said stop, never at night, never for a visit that was just booked, a message WhatsApp could not confirm is never sent
// again by itself, a refusal is retried a few times and then shown, the clock changes (last Sundays of March and October) are handled, and the kill switch stops everything.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const h = require('../lib/handlers');
const A = require('../lib/appointments');
const BN = require('../lib/bookingNotices');
const R = require('../lib/bookingRules');
const store = require('../lib/store');
const { createClient } = require('../lib/whatsapp');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const actor = { kind: 'staff', id: 'thomas@example.com' };
const staff = { uid: 'u1', token: { email: 'thomas@example.com', email_verified: true, staff: true } };
const BOOKING = { reminder: { name: 'ek_reminder', lang: 'en' }, remindersOn: true };
const cfg = { allowedEmails: 'thomas@example.com', booking: BOOKING };
const MIN = 60e3, H = 60 * MIN, DAY = 24 * H;
const irish = (y, m, d, hh, mi) => A.dublinToMs(y, m, d, hh, mi);
const NOW = irish(2026, 10, 19, 10, 0);                                    // Monday 19 Oct 2026, 10:00 Irish time (summer time, UTC+1): when the visits are booked
const EVE = irish(2026, 10, 20, 17, 30);                                   // Tuesday 20 Oct, 17:30: the evening before a visit on Wednesday 21 Oct
const OPEN = irish(2026, 11, 1, 0, 0);                                     // "the customer wrote recently" for every time used below: the 24-hour window is open, so the reminder goes as a normal message
const P = '353851110001', Q = '353851110002';
let seq = 0;
const rid = () => 'req-' + (++seq) + '-abcdefgh';
const rejects = (p, code, msg) => assert.rejects(p, (e) => e.code === code && (!msg || msg.test(e.message)), `expected ${code}${msg ? ' ' + msg : ''}`);

// ---- fake Meta ----
const calls = []; let mode = 'ok', slow = null;
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const mockFetch = async (url, opts = {}) => {
  calls.push(JSON.parse(opts.body));
  if (slow) await slow();
  if (mode === 'refuse') return reply({ error: { code: 132001, message: 'Template name does not exist in the translation' } }, 400);
  if (mode === 'server') return reply({ error: { code: 1, message: 'Unknown error' } }, 500);
  return reply({ messages: [{ id: 'wamid.BK' + calls.length }] });
};
const wa = createClient({ phoneId: '111', token: 'tok', version: 'v21.0' }, mockFetch);
const deps = (over = {}) => ({ db, wa, cfg, ...over });
const sweep = (nowMs, over = {}) => BN.reminderSweep(deps(over), { nowMs });
const resolve = (id, outcome, nowMs = EVE + 10 * MIN) => BN.resolveNotice({ db }, actor, { id, outcome }, { nowMs });

async function customer(p = P, { name = 'Anna Murphy', inbound = OPEN, extra = {} } = {}) {
  await db.doc('contacts/' + p).set({ phone: p, ...(name ? { name } : {}), createdAt: Timestamp.now() });
  await db.doc('conversations/' + p).set({ phone: p, ...(name ? { name } : {}), createdAt: Timestamp.now(), updatedAt: Timestamp.now(), lastMessage: 'Hi', ...(inbound == null ? {} : { lastInboundAt: Timestamp.fromMillis(inbound) }), ...extra });
}
// A visit booked on Monday 10:00 for Wednesday 21 Oct 2026 at 10:00 Irish time (so it is "tomorrow" on the Tuesday evening).
async function visit({ p = P, date = '2026-10-21', time = '10:00', type = 'consultation', at = NOW } = {}) { return (await A.create(db, actor, { phone: p, date, time, type, requestId: rid() }, at)).id; }
const appt = async (id) => (await db.doc('appointments/' + id).get()).data();
const notices = async () => (await db.collection('bookingNotices').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const msgs = async (p = P) => (await db.collection('conversations/' + p + '/messages').get()).docs.map((d) => ({ id: d.id, ...d.data() }));

beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  for (let i = 0; i < 100; i++) { const left = await Promise.all(['appointments', 'conversations', 'contacts', 'bookingNotices', 'projects'].map((c) => db.collection(c).limit(1).get())); if (left.every((x) => x.empty)) break; await new Promise((r) => setTimeout(r, 30)); }      // the clear has finished before the next test writes
  calls.length = 0; mode = 'ok'; slow = null;
});

test('THE EVENING REMINDER goes by itself, as a normal message inside the 24-hour window, with the right words, once; later checks send nothing', async () => {
  await customer(); const id = await visit();
  assert.equal(calls.length, 0, 'booking a visit sends nothing');
  const r = await sweep(EVE); assert.deepEqual([r.sent, r.failed], [1, 0]);
  assert.equal(calls.length, 1); assert.equal(calls[0].type, 'text'); assert.equal(calls[0].to, P);
  assert.equal(calls[0].text.body, 'Hi Anna, a reminder that your consultation with Elite Kitchens is tomorrow, Wednesday 21 October at 10:00. If you need to change it, just reply to this message. See you then!');
  const a = await appt(id); assert.deepEqual([a.visitReminder.for, a.visitReminder.at], [irish(2026, 10, 21, 10, 0), EVE]);
  assert.deepEqual(R.describe(a, EVE), { state: 'told', text: 'Reminder sent' });
  const m = await msgs(); assert.equal(m.length, 1); assert.deepEqual([m[0].direction, m[0].status, m[0].type], ['out', 'sent', 'text']);
  const n = await notices(); assert.equal(n.length, 1); assert.deepEqual([n[0].kind, n[0].state, n[0].mode, n[0].by, n[0].startMs], ['reminder', 'sent', 'text', 'auto', irish(2026, 10, 21, 10, 0)]); assert.equal(n[0].error, null);
  for (const at of [EVE + 15 * MIN, EVE + 30 * MIN, EVE + 90 * MIN]) { const again = await sweep(at); assert.equal(again.sent, 0, 'no second reminder'); }
  assert.equal(calls.length, 1);
});

test('outside the 24-hour window the reminder goes as the approved template; the chat shows the words', async () => {
  await customer(P, { inbound: NOW - 5 * DAY }); const id = await visit({ type: 'site_visit' });
  await sweep(EVE);
  assert.equal(calls[0].type, 'template'); assert.equal(calls[0].template.name, 'ek_reminder'); assert.equal(calls[0].template.language.code, 'en');
  assert.deepEqual(calls[0].template.components[0].parameters.map((x) => x.text), ['Anna', 'site visit', 'Wednesday 21 October', '10:00']);
  const m = await msgs(); assert.match(m[0].body, /^\[template: ek_reminder\] Hi Anna, a reminder that your site visit with Elite Kitchens is tomorrow/); assert.equal(m[0].type, 'template');
  assert.equal((await notices())[0].template, 'ek_reminder'); assert.equal((await appt(id)).visitReminder.for, irish(2026, 10, 21, 10, 0));
});

test('a customer with no usable name is greeted "Hi there"', async () => {
  await customer(P, { name: '' }); await visit(); await sweep(EVE);
  assert.match(calls[0].text.body, /^Hi there, a reminder that your consultation/);
});

test('TIME OF DAY: nothing before 17:00, from 17:00, nothing from 19:30, nothing at night or in the morning', async () => {
  await customer(); await visit();
  for (const [hh, mi] of [[0, 0], [8, 0], [12, 30], [16, 59], [19, 30], [19, 45], [22, 0], [23, 59]]) { const r = await sweep(irish(2026, 10, 20, hh, mi)); assert.equal(r.quiet, true, `${hh}:${mi}`); }
  assert.equal(calls.length, 0);
  assert.equal((await sweep(irish(2026, 10, 20, 19, 29))).sent, 1, '19:29 is still inside');
});

test('THE KILL SWITCH: with reminders off nothing is ever sent', async () => {
  await customer(); await visit();
  const r = await BN.reminderSweep({ db, wa, cfg: { ...cfg, booking: { ...BOOKING, remindersOn: false } } }, { nowMs: EVE });
  assert.equal(r.off, true); assert.equal(calls.length, 0);
  assert.equal((await BN.reminderSweep({ db, wa, cfg: { allowedEmails: 'x' } }, { nowMs: EVE })).off, true, 'no setting at all is off too');
  assert.equal(calls.length, 0);
});

test('ONLY THE RIGHT VISITS: tomorrow, scheduled, a customer-facing type, not booked or changed in the last 4 hours', async () => {
  await customer(); await customer(Q, { name: 'Brian Kelly' });
  const ok = await visit(), site = await visit({ p: Q, type: 'site_visit', time: '11:00' }), later = await visit({ date: '2026-10-22', time: '12:00' }), today = await visit({ date: '2026-10-20', time: '19:00' });
  const fresh = await visit({ time: '13:00', at: irish(2026, 10, 20, 15, 0) }), other = await visit({ time: '14:00', type: 'other' }), cancelled = await visit({ time: '15:00' });
  await A.cancel(db, actor, { id: cancelled }, NOW + H);
  const inst = await visit({ time: '16:00' }); await db.doc('appointments/' + inst).update({ type: 'installation' });
  const r = await sweep(EVE);
  assert.equal(r.sent, 2, JSON.stringify(r)); assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.to).sort(), [P, Q].sort()); assert.ok(calls.some((c) => /site visit .* 11:00/.test(c.text.body)) && calls.some((c) => /consultation .* 10:00/.test(c.text.body)));
  for (const [name, id] of [['ok', ok], ['site', site]]) assert.equal((await appt(id)).visitReminder.for, irish(2026, 10, 21, name === 'ok' ? 10 : 11, 0));
  for (const [name, id] of [['later', later], ['today', today], ['fresh', fresh], ['other', other], ['cancelled', cancelled], ['installation', inst]]) assert.equal((await appt(id)).visitReminder, undefined, name + ' got no reminder');
});

test('A MOVED VISIT: the new time gets its own reminder the evening before it; the old time is never reminded twice', async () => {
  await customer(); const id = await visit();
  assert.equal((await sweep(irish(2026, 10, 20, 17, 0))).sent, 1); assert.equal(calls.length, 1);
  await A.update(db, actor, { id, date: '2026-10-22', time: '10:00' }, irish(2026, 10, 20, 17, 20));      // moved to Thursday just after the reminder
  assert.equal((await sweep(irish(2026, 10, 20, 17, 40))).sent, 0, 'changed 20 minutes ago: nobody is reminded at once'); assert.equal(calls.length, 1);
  assert.equal((await sweep(irish(2026, 10, 21, 17, 30))).sent, 1, 'the evening before Thursday');
  assert.match(calls[1].text.body, /tomorrow, Thursday 22 October at 10:00/);
  assert.equal((await sweep(irish(2026, 10, 21, 17, 45))).sent, 0); assert.equal(calls.length, 2);
  assert.equal((await appt(id)).visitReminder.for, irish(2026, 10, 22, 10, 0));
  assert.equal((await notices()).length, 2, 'one record per time');
});

test('A VISIT BOOKED THE SAME DAY gets no reminder (the customer has just heard it); one booked more than 4 hours ago does', async () => {
  await customer(); const id = await visit({ at: irish(2026, 10, 20, 16, 0) });                              // booked at 16:00, 90 minutes before the check
  assert.equal((await sweep(EVE)).sent, 0); assert.equal(calls.length, 0);
  await db.doc('appointments/' + id).update({ updatedAt: Timestamp.fromMillis(irish(2026, 10, 20, 12, 0)) });
  assert.equal((await sweep(EVE + MIN)).sent, 1);
});

test('EXACTLY ONCE: two checks at the same moment send ONE reminder', async () => {
  await customer(); await visit();
  slow = () => new Promise((r) => setTimeout(r, 60));
  const res = await Promise.all([sweep(EVE), sweep(EVE), sweep(EVE)]);
  assert.equal(calls.length, 1, 'WhatsApp was contacted once'); assert.equal(res.reduce((n, x) => n + x.sent, 0), 1);
  assert.equal((await notices()).length, 1);
});

test('DO NOT CONTACT: nothing is sent, however many checks run; the other customers are still reminded', async () => {
  await customer(P, { extra: { doNotContact: { on: true, at: Timestamp.now(), by: 'x', source: 'customer' } } }); await customer(Q, { name: 'Brian Kelly' });
  const a = await visit(), b = await visit({ p: Q, time: '11:00' });
  const r = await sweep(EVE); assert.deepEqual([r.sent, r.failed], [1, 1]);
  assert.equal(calls.length, 1); assert.equal(calls[0].to, Q);
  assert.equal((await appt(a)).visitReminder, undefined); assert.equal((await appt(b)).visitReminder.for, irish(2026, 10, 21, 11, 0));
  assert.equal((await notices()).length, 1, 'no claim for the customer who said stop');
  await sweep(EVE + 15 * MIN); assert.equal(calls.length, 1);
  await db.doc('conversations/' + P).update({ doNotContact: { on: false, at: Timestamp.now(), by: 'staff', source: 'staff' } });
  assert.equal((await sweep(EVE + 30 * MIN)).sent, 1, 'allowed again: the reminder goes');
});

test('NO TEMPLATE and the window closed: nothing is sent and no claim is left behind; inside the window no template is needed', async () => {
  await customer(P, { inbound: NOW - 5 * DAY }); const id = await visit();
  const noTpl = { db, wa, cfg: { ...cfg, booking: { ...BOOKING, reminder: null } } };
  const r = await BN.reminderSweep(noTpl, { nowMs: EVE }); assert.deepEqual([r.sent, r.failed], [0, 1]);
  assert.equal(calls.length, 0); assert.equal((await notices()).length, 0); assert.equal((await appt(id)).visitReminder, undefined);
  await customer(Q, { name: 'Brian Kelly' }); const id2 = await visit({ p: Q, time: '11:00' });
  assert.equal((await BN.reminderSweep(noTpl, { nowMs: EVE + MIN })).sent, 1, 'inside the window it is a normal message'); assert.equal(calls[0].type, 'text');
  assert.equal((await appt(id2)).visitReminder.for, irish(2026, 10, 21, 11, 0));
});

test('A CUSTOMER WHO HAS NO CHAT is counted as not sent; the others still get theirs', async () => {
  await customer(); await visit(); const ghost = await visit({ p: '353851119999', time: '11:00' }).catch(() => null);
  await db.doc('appointments/' + (ghost || 'a_' + 'e'.repeat(24))).set({ phone: '353851119999', type: 'consultation', status: 'scheduled', start: Timestamp.fromMillis(irish(2026, 10, 21, 11, 0)), end: Timestamp.fromMillis(irish(2026, 10, 21, 12, 0)), createdAt: Timestamp.fromMillis(NOW), updatedAt: Timestamp.fromMillis(NOW), version: 1 });
  const r = await sweep(EVE); assert.deepEqual([r.sent, r.failed], [1, 1]); assert.equal(calls.length, 1);
});

// ================================================================ when WhatsApp does not accept it ====================================
test('WHATSAPP REFUSES (template not approved): nothing is recorded as sent, the chat is untouched, the visit says why, and it is tried again 30 minutes later, at most 3 times in all', async () => {
  await customer(P, { inbound: NOW - 5 * DAY }); const id = await visit();
  mode = 'refuse';
  assert.equal((await sweep(irish(2026, 10, 20, 17, 0))).failed, 1);
  let a = await appt(id); assert.equal(a.visitReminder, undefined); assert.deepEqual([a.noticeIssue.state, a.noticeIssue.kind], ['failed', 'reminder']); assert.match(a.noticeIssue.text, /doesn't know this template/);
  assert.equal(R.describe(a, EVE).state, 'failed'); assert.match(R.describe(a, EVE).text, /^The reminder could not be sent: /);
  assert.equal((await msgs()).length, 0, 'nothing is written to the chat');
  const n = (await notices())[0]; assert.deepEqual([n.state, n.errorCode, n.tries], ['failed', '132001', 1]);
  assert.equal((await sweep(irish(2026, 10, 20, 17, 15))).failed, 1); assert.equal(calls.length, 1, 'too soon: not even tried');
  await sweep(irish(2026, 10, 20, 17, 31)); assert.equal(calls.length, 2);
  await sweep(irish(2026, 10, 20, 18, 2)); assert.equal(calls.length, 3);
  await sweep(irish(2026, 10, 20, 18, 40)); assert.equal(calls.length, 3, 'three tries and no more');
  assert.equal((await notices())[0].tries, 3); assert.equal((await appt(id)).visitReminder, undefined); assert.equal((await appt(id)).noticeIssue.state, 'failed', 'still shown, so you can message the customer yourself');
});

test('A REFUSAL THAT IS LATER FIXED: the next try sends it and the note on the visit disappears', async () => {
  await customer(P, { inbound: NOW - 5 * DAY }); const id = await visit();
  mode = 'refuse'; await sweep(irish(2026, 10, 20, 17, 0)); assert.equal((await appt(id)).noticeIssue.state, 'failed');
  mode = 'ok'; assert.equal((await sweep(irish(2026, 10, 20, 17, 40))).sent, 1);
  const a = await appt(id); assert.equal(a.noticeIssue, undefined); assert.equal(a.visitReminder.for, irish(2026, 10, 21, 10, 0)); assert.equal((await notices())[0].state, 'sent');
});

test('NOT CONFIRMED (WhatsApp 5xx): said so on the visit, never sent again by itself, however long we wait', async () => {
  await customer(); const id = await visit();
  mode = 'server'; assert.equal((await sweep(irish(2026, 10, 20, 17, 0))).failed, 1); mode = 'ok';
  const a = await appt(id); assert.deepEqual([a.noticeIssue.state, a.visitReminder], ['unknown', undefined]); assert.equal((await notices())[0].state, 'unknown');
  const d = R.describe(a, EVE); assert.deepEqual([d.state, d.issue], ['issue', 'unknown']);
  for (const at of [irish(2026, 10, 20, 17, 20), irish(2026, 10, 20, 18, 0), irish(2026, 10, 20, 19, 0)]) await sweep(at);
  assert.equal(calls.length, 1, 'no second message');
});

test('A CLAIM THAT DIED while "sending" counts as not confirmed after 3 minutes, is shown on the visit, and is never re-sent', async () => {
  await customer(); const id = await visit(); const a = await appt(id);
  await db.collection('bookingNotices').doc(BN.noticeId(BN.noticeKey(id, a))).set({ phone: P, appointmentId: id, kind: 'reminder', state: 'sending', claimedAt: Timestamp.fromMillis(EVE - 10 * MIN), startMs: a.start.toMillis(), tries: 1 });
  assert.equal((await sweep(EVE)).failed, 1); assert.equal(calls.length, 0);
  assert.deepEqual([(await appt(id)).noticeIssue.kind, (await appt(id)).noticeIssue.state], ['reminder', 'unknown']);
  const young = await appt(id); await db.collection('bookingNotices').doc(BN.noticeId(BN.noticeKey(id, young))).update({ claimedAt: Timestamp.fromMillis(EVE + 14 * MIN) });
  assert.equal((await sweep(EVE + 15 * MIN)).failed, 1); assert.equal(calls.length, 0, 'a young claim is "already being sent"');
});

test('"IT ARRIVED": the visit is recorded as reminded and nothing is sent; asking again changes nothing', async () => {
  await customer(); const id = await visit();
  mode = 'server'; await sweep(irish(2026, 10, 20, 17, 0)); mode = 'ok'; calls.length = 0;
  const r = await resolve(id, 'arrived'); assert.deepEqual([r.ok, r.state], [true, 'sent']);
  const a = await appt(id); assert.equal(a.noticeIssue, undefined); assert.equal(a.visitReminder.for, irish(2026, 10, 21, 10, 0)); assert.equal(R.describe(a, EVE).state, 'told');
  const n = (await notices())[0]; assert.deepEqual([n.state, n.resolved, n.resolvedBy], ['sent', 'arrived', 'thomas@example.com']);
  assert.equal((await resolve(id, 'arrived')).existing, true); assert.equal((await sweep(irish(2026, 10, 20, 18, 30))).sent, 0); assert.equal(calls.length, 0, 'never sent as well');
});

test('"IT DID NOT ARRIVE": the next check sends it again, once', async () => {
  await customer(); const id = await visit();
  mode = 'server'; await sweep(irish(2026, 10, 20, 17, 0)); mode = 'ok';
  const r = await resolve(id, 'notArrived', irish(2026, 10, 20, 17, 5)); assert.equal(r.state, 'failed'); assert.equal((await appt(id)).noticeIssue, undefined);
  assert.equal((await sweep(irish(2026, 10, 20, 17, 10))).sent, 0, 'not before 30 minutes after the last try');
  assert.equal((await sweep(irish(2026, 10, 20, 17, 35))).sent, 1); assert.equal(calls.length, 2);
  assert.equal((await sweep(irish(2026, 10, 20, 17, 50))).sent, 0); assert.equal(calls.length, 2);
  assert.equal((await appt(id)).visitReminder.for, irish(2026, 10, 21, 10, 0));
});

test('RESOLVING: only an unconfirmed reminder can be resolved; strict input; staff only', async () => {
  await customer(); const id = await visit();
  await rejects(resolve(id, 'arrived'), 'failed-precondition', /no unconfirmed reminder/);
  mode = 'refuse'; await sweep(irish(2026, 10, 20, 17, 0)); mode = 'ok';
  await rejects(resolve(id, 'arrived'), 'failed-precondition', /did not go/);
  assert.equal((await appt(id)).visitReminder, undefined, 'a refused reminder is not "sent"');
  const a = await appt(id), nid = BN.noticeId(BN.noticeKey(id, a));
  await db.collection('bookingNotices').doc(nid).update({ state: 'sending', claimedAt: Timestamp.fromMillis(EVE) });
  await rejects(resolve(id, 'arrived', EVE + MIN), 'failed-precondition', /still being sent/);
  assert.equal((await resolve(id, 'notArrived', EVE + 4 * MIN)).state, 'failed');
  for (const bad of [{ id, outcome: 'maybe' }, { id: 'a_nope', outcome: 'arrived' }, { outcome: 'arrived' }]) await rejects(BN.resolveNotice({ db }, actor, bad), 'invalid-argument');
  await rejects(BN.resolveNotice({ db }, actor, { id: 'a_' + 'f'.repeat(24), outcome: 'arrived' }), 'not-found');
  await rejects(h.resolveBookingNotice({ uid: 'x', token: { email: 'other@example.com', email_verified: true, staff: true } }, { id, outcome: 'arrived' }, { db, cfg }), 'permission-denied');
  await rejects(h.resolveBookingNotice(null, { id, outcome: 'arrived' }, { db, cfg }), 'unauthenticated');
  for (const bad of [{ id, outcome: 'arrived', extra: 1 }, { id, outcome: 'arrived', kind: 'confirmation' }, null, []]) await rejects(h.resolveBookingNotice(staff, bad, { db, cfg }), 'invalid-argument');
});

test('A NOTE ABOUT A MESSAGE WE COULD NOT CONFIRM is never replaced by a plainer "refused"', async () => {
  await customer(); const id = await visit();
  mode = 'server'; await sweep(irish(2026, 10, 20, 17, 0)); mode = 'refuse';
  const a = await appt(id); await db.collection('bookingNotices').doc(BN.noticeId(BN.noticeKey(id, a))).update({ state: 'failed', claimedAt: Timestamp.fromMillis(irish(2026, 10, 20, 17, 0)), tries: 1 });
  await sweep(irish(2026, 10, 20, 17, 40));                                                               // a refused retry
  assert.equal((await appt(id)).noticeIssue.state, 'unknown', 'still needs a person');
});

// ================================================================ words, clock changes, erasure ====================================
test('CLOCK CHANGE (25 Oct 2026, clocks go back): the window follows the Irish clock and "tomorrow" is the 25-hour day', () => {
  const w = BN.reminderWindow(irish(2026, 10, 24, 17, 0));
  assert.equal(w.open, true); assert.equal(w.from, irish(2026, 10, 25, 0, 0)); assert.equal(w.to, irish(2026, 10, 26, 0, 0));
  assert.equal(w.to - w.from, 25 * H, 'the day the clocks go back has 25 hours');
  assert.equal(BN.reminderWindow(irish(2026, 10, 24, 16, 59)).open, false); assert.equal(BN.reminderWindow(irish(2026, 10, 24, 19, 30)).open, false);
  const w2 = BN.reminderWindow(irish(2026, 10, 25, 17, 0)); assert.equal(w2.open, true); assert.equal(w2.from, irish(2026, 10, 26, 0, 0)); assert.equal(w2.to - w2.from, 24 * H);
  assert.equal(Date.UTC(2026, 9, 25, 17, 0), irish(2026, 10, 25, 17, 0), '17:00 Irish is 17:00 UTC once the clocks have gone back');
});
test('CLOCK CHANGE (29 Mar 2026, clocks go forward): "tomorrow" is the 23-hour day and the window is 17:00 Irish time on both sides', () => {
  const w = BN.reminderWindow(irish(2026, 3, 28, 17, 0));
  assert.equal(w.open, true); assert.equal(w.from, irish(2026, 3, 29, 0, 0)); assert.equal(w.to, irish(2026, 3, 30, 0, 0)); assert.equal(w.to - w.from, 23 * H);
  assert.equal(BN.reminderWindow(irish(2026, 3, 29, 17, 0)).open, true, '17:00 summer time the next evening');
  assert.equal(Date.UTC(2026, 2, 29, 16, 0), irish(2026, 3, 29, 17, 0));
  assert.equal(BN.reminderWindow(Date.UTC(2026, 2, 29, 15, 59)).open, false, '16:59 Irish is still before 17:00');
});
test('CLOCK CHANGE: visits at the edges of the 25-hour day are in the window, the next day\'s first minute is not', async () => {
  await customer();
  const book = irish(2026, 10, 20, 9, 0);
  await visit({ date: '2026-10-25', time: '00:15', at: book }); await visit({ date: '2026-10-25', time: '23:45', at: book }); await visit({ date: '2026-10-26', time: '00:15', at: book });
  const r = await sweep(irish(2026, 10, 24, 17, 30)); assert.equal(r.sent, 2, JSON.stringify(r));
  assert.deepEqual(calls.map((c) => /Sunday 25 October at (00:15|23:45)/.test(c.text.body)), [true, true]);
});
test('the words use Irish time on both sides of a clock change', () => {
  assert.equal(BN.timeText(Date.UTC(2026, 9, 25, 23, 45)), '23:45'); assert.equal(BN.timeText(Date.UTC(2026, 9, 24, 23, 15)), '00:15');
  assert.equal(BN.dateText(Date.UTC(2026, 9, 24, 23, 15)), 'Sunday 25 October');
  assert.equal(BN.timeText(irish(2026, 3, 29, 10, 0)), '10:00'); assert.equal(BN.dateText(irish(2026, 3, 29, 10, 0)), 'Sunday 29 March');
});

test('ERASING A CUSTOMER erases their reminder records and nobody else\'s', async () => {
  await customer(); await customer(Q, { name: 'Brian Kelly' });
  await visit(); await visit({ p: Q, time: '11:00' }); await sweep(EVE);
  assert.equal((await notices()).length, 2);
  await h.deleteCustomer(staff, { phone: P, confirm: P.slice(-4) }, { db, cfg, bucket: require('firebase-admin/storage').getStorage().bucket('demo-leados.appspot.com') });
  assert.deepEqual((await notices()).map((x) => x.phone), [Q]);
  assert.equal((await db.doc('conversations/' + P).get()).exists, false);
});
test('erased while the reminder is on its way: nothing is recreated', async () => {
  await customer(); await visit();
  slow = async () => { await store.deleteCustomerData(db, require('firebase-admin/storage').getStorage().bucket('demo-leados.appspot.com'), P); };
  await sweep(EVE);
  assert.equal((await db.doc('conversations/' + P).get()).exists, false, 'no chat brought back'); assert.equal((await notices()).length, 0);
});

test('the browser cannot write these records: staff can read them, nobody can write', async () => {
  const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
  const env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'firestore.rules'), 'utf8'), host: process.env.FIRESTORE_EMULATOR_HOST.split(':')[0], port: +process.env.FIRESTORE_EMULATOR_HOST.split(':')[1] } });
  try {
    const s = env.authenticatedContext('staff1', { staff: true, staffUntil: Date.now() + 3600e3 }).firestore();
    await assertSucceeds(s.doc('bookingNotices/n_x').get()); await assertFails(s.doc('bookingNotices/n_x').set({ a: 1 })); await assertFails(s.doc('appointments/a_x').update({ visitReminder: 1 }));
    await assertFails(env.unauthenticatedContext().firestore().doc('bookingNotices/n_x').get());
  } finally { await env.cleanup(); }
});

test('THERE IS NO WAY TO SEND A CONFIRMATION, A NEW TIME OR A CANCELLATION: the functions and the words do not exist', () => {
  assert.equal(h.sendBookingNotice, undefined); assert.equal(BN.sendNotice, undefined);
  assert.deepEqual(Object.keys(BN.compose({ first: 'Anna', type: 'consultation', startMs: irish(2026, 10, 21, 10, 0) })).sort(), ['params', 'text']);
  assert.ok(!/BOOKING_(CONFIRM|CHANGE)_TEMPLATE/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8')), 'the two removed template settings are gone');
});
