// Phase 12: WhatsApp messages about a visit (functions/lib/bookingNotices.js): confirmation, change, cancellation (a person presses a button) and the evening-before reminder (automatic).
// Real Firestore emulator and a fake Meta: no real message is ever sent. Every name and number is made up.
// What matters: EXACTLY ONE message however often it is asked for, never one to a customer who said stop, nothing sent that could not be confirmed is sent again by itself, the reminder never goes at night,
// never with a time the customer was not told, and the clock changes (last Sundays of March and October) are handled.
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
const BOOKING = { confirmation: { name: 'ek_confirmed', lang: 'en' }, change: { name: 'ek_changed', lang: 'en' }, reminder: { name: 'ek_reminder', lang: 'en' }, remindersOn: true };
const cfg = { allowedEmails: 'thomas@example.com', booking: BOOKING };
const MIN = 60e3, H = 60 * MIN;
const irish = (y, m, d, hh, mi) => A.dublinToMs(y, m, d, hh, mi);
const NOW = irish(2026, 10, 19, 10, 0);                                    // Monday 19 Oct 2026, 10:00 Irish time (summer time, UTC+1)
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
const send = (id, kind, nowMs = NOW, extra = {}) => BN.sendNotice(deps(), { id, kind, actor, nowMs, ...extra });

async function customer(p = P, { name = 'Anna Murphy', inbound = NOW - 1 * H, location = 'Swords', extra = {} } = {}) {
  await db.doc('contacts/' + p).set({ phone: p, name, createdAt: Timestamp.now() });
  await db.doc('conversations/' + p).set({ phone: p, name, location, createdAt: Timestamp.now(), updatedAt: Timestamp.now(), lastMessage: 'Hi', ...(inbound == null ? {} : { lastInboundAt: Timestamp.fromMillis(inbound) }), ...extra });
}
// A visit booked at `at` for Wednesday 21 Oct 2026 at 10:00 Irish time.
async function visit({ p = P, date = '2026-10-21', time = '10:00', type = 'consultation', at = NOW } = {}) { return (await A.create(db, actor, { phone: p, date, time, type, requestId: rid() }, at)).id; }
const appt = async (id) => (await db.doc('appointments/' + id).get()).data();
const notices = async () => (await db.collection('bookingNotices').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const msgs = async (p = P) => (await db.collection('conversations/' + p + '/messages').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const sentBodies = () => calls.map((c) => (c.type === 'text' ? c.text.body : '[template ' + c.template.name + '] ' + c.template.components[0].parameters.map((x) => x.text).join(' | ')));

beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  for (let i = 0; i < 100; i++) { const left = await Promise.all(['appointments', 'conversations', 'contacts', 'bookingNotices', 'projects'].map((c) => db.collection(c).limit(1).get())); if (left.every((x) => x.empty)) break; await new Promise((r) => setTimeout(r, 30)); }      // waitEmpty: the clear has finished before the next test writes
  calls.length = 0; mode = 'ok'; slow = null;
});

test('CONFIRMATION inside the 24-hour window goes as a normal message with the right words, once; asking again sends nothing', async () => {
  await customer(); const id = await visit();
  const r = await send(id, 'confirmation');
  assert.deepEqual([r.ok, r.existing, r.mode], [true, false, 'text']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'text');
  assert.equal(calls[0].text.body, 'Hi Anna, your consultation with Elite Kitchens is confirmed for Wednesday 21 October at 10:00. We will call out to you in Swords. If you need to change the time, just reply to this message and we will sort it out. Thank you!');
  const a = await appt(id);
  assert.deepEqual([a.customerNotice.kind, a.customerNotice.toldStart, a.customerNotice.at], ['confirmation', irish(2026, 10, 21, 10, 0), NOW]);
  assert.equal(R.nextAction(a, NOW), null, 'the button is gone');
  const m = await msgs(); assert.equal(m.length, 1); assert.equal(m[0].direction, 'out'); assert.equal(m[0].status, 'sent');
  const again = await send(id, 'confirmation'); assert.deepEqual([again.ok, again.existing], [true, true]); assert.equal(calls.length, 1, 'no second message');
  const n = await notices(); assert.equal(n.length, 1); assert.deepEqual([n[0].state, n[0].mode, n[0].kind], ['sent', 'text', 'confirmation']);
  assert.equal(n[0].error, null);
});

test('CONFIRMATION outside the window goes as the approved template with the 5 values; the chat shows the words', async () => {
  await customer(P, { inbound: NOW - 30 * H }); const id = await visit({ type: 'site_visit' });
  const r = await send(id, 'confirmation'); assert.equal(r.mode, 'template');
  assert.equal(calls[0].template.name, 'ek_confirmed'); assert.equal(calls[0].template.language.code, 'en');
  assert.deepEqual(calls[0].template.components[0].parameters.map((x) => x.text), ['Anna', 'site visit', 'Wednesday 21 October', '10:00', 'Swords']);
  const m = await msgs(); assert.match(m[0].body, /^\[template: ek_confirmed\] Hi Anna, your site visit with Elite Kitchens is confirmed for Wednesday 21 October at 10:00/); assert.equal(m[0].type, 'template');
  assert.equal((await notices())[0].template, 'ek_confirmed');
});

test('a name or town that is missing never breaks the words: "there" and "your area"', async () => {
  await customer(P, { name: '', location: '' }); await db.doc('contacts/' + P).set({ phone: P, createdAt: Timestamp.now() }); const id = await visit();
  await send(id, 'confirmation');
  assert.match(calls[0].text.body, /^Hi there, your consultation .* We will call out to you in your area\./);
});

test('EXACTLY ONCE: two presses at the same moment, and two people, send ONE message', async () => {
  await customer(); const id = await visit();
  slow = () => new Promise((r) => setTimeout(r, 60));
  const res = await Promise.allSettled([send(id, 'confirmation'), send(id, 'confirmation'), send(id, 'confirmation')]);
  assert.equal(calls.length, 1, 'WhatsApp was contacted once');
  assert.equal(res.filter((x) => x.status === 'fulfilled').length >= 1, true);
  for (const x of res.filter((y) => y.status === 'rejected')) assert.match(x.reason.message, /already being sent|already sent|already knows|was already/i);
  assert.equal((await notices()).length, 1);
  assert.equal((await send(id, 'confirmation')).existing, true); assert.equal(calls.length, 1);
});

test('WhatsApp REFUSES (template not approved): nothing is recorded as told, the chat is untouched, the words are plain, and a retry works', async () => {
  await customer(P, { inbound: NOW - 30 * H }); const id = await visit();
  mode = 'refuse';
  await rejects(send(id, 'confirmation'), 'unavailable', /doesn't know this template/);
  const a = await appt(id); assert.equal(a.customerNotice, undefined, 'the customer was NOT told');
  assert.equal(R.nextAction(a, NOW), 'confirmation', 'the button is still there');
  assert.equal((await msgs()).length, 0, 'nothing written to the chat');
  const n = (await notices())[0]; assert.deepEqual([n.state, n.errorCode], ['failed', '132001']);
  mode = 'ok';
  const r = await send(id, 'confirmation', NOW + 5 * MIN); assert.equal(r.ok, true); assert.equal(calls.length, 2);
  const n2 = (await notices())[0]; assert.deepEqual([n2.state, n2.tries], ['sent', 2]);
  assert.equal((await send(id, 'confirmation', NOW + 6 * MIN)).existing, true); assert.equal(calls.length, 2);
});

test('NOT CONFIRMED (WhatsApp 5xx): said so, never sent again by itself, nothing recorded as told', async () => {
  await customer(); const id = await visit();
  mode = 'server';
  await rejects(send(id, 'confirmation'), 'unavailable', /Not confirmed/);
  mode = 'ok';
  await rejects(send(id, 'confirmation', NOW + 5 * MIN), 'failed-precondition', /Not confirmed/);
  await rejects(send(id, 'confirmation', NOW + 3 * H), 'failed-precondition', /Not confirmed/);
  assert.equal(calls.length, 1, 'no second message');
  assert.equal((await appt(id)).customerNotice, undefined); assert.equal((await notices())[0].state, 'unknown');
});

test('a claim that died while "sending" is treated as not confirmed after 3 minutes, never re-sent', async () => {
  await customer(); const id = await visit();
  const a = await appt(id);
  await db.collection('bookingNotices').doc(BN.noticeId(BN.noticeKey('confirmation', id, a))).set({ phone: P, appointmentId: id, kind: 'confirmation', state: 'sending', claimedAt: Timestamp.fromMillis(NOW), tries: 1 });
  await rejects(send(id, 'confirmation', NOW + MIN), 'failed-precondition', /already being sent/);
  await rejects(send(id, 'confirmation', NOW + 4 * MIN), 'failed-precondition', /Not confirmed/);
  assert.equal(calls.length, 0);
  const issue = (await appt(id)).noticeIssue; assert.deepEqual([issue.kind, issue.state], ['confirmation', 'unknown'], 'the visit says it is unconfirmed, so a person can resolve it');
  assert.equal((await resolve(id, 'confirmation', 'notArrived', NOW + 5 * MIN)).state, 'failed');
  assert.equal((await send(id, 'confirmation', NOW + 6 * MIN)).ok, true); assert.equal(calls.length, 1);
});

test('no template and the window closed: refused with a clear reason, nothing sent, no claim left behind', async () => {
  await customer(P, { inbound: NOW - 30 * H }); const id = await visit();
  await rejects(BN.sendNotice({ db, wa, cfg: { ...cfg, booking: { ...BOOKING, confirmation: null } } }, { id, kind: 'confirmation', actor, nowMs: NOW }), 'failed-precondition', /no WhatsApp template is set up/);
  assert.equal(calls.length, 0); assert.equal((await notices()).length, 0);
  const open = await customer(Q, { inbound: NOW - H }); const id2 = await visit({ p: Q });
  assert.equal((await BN.sendNotice({ db, wa, cfg: { ...cfg, booking: {} } }, { id: id2, kind: 'confirmation', actor, nowMs: NOW })).mode, 'text', 'inside the window no template is needed');
});

test('DO NOT CONTACT: refused inside the claim, nothing sent, for every message', async () => {
  await customer(P, { extra: { doNotContact: { on: true, at: Timestamp.now(), by: 'x', source: 'staff' } } }); const id = await visit();
  await rejects(send(id, 'confirmation'), 'failed-precondition', /asked not to be contacted/);
  assert.equal(calls.length, 0); assert.equal((await notices()).length, 0);
  await rejects(BN.sendNotice(deps(), { id, kind: 'reminder', actor: { id: 'auto' }, auto: true, nowMs: NOW }), 'failed-precondition');
  assert.equal(calls.length, 0);
});

test('CHANGE: only after a confirmation, only when the time moved, one per version of the visit', async () => {
  await customer(); const id = await visit();
  await rejects(send(id, 'change'), 'failed-precondition', /send the confirmation/);
  await send(id, 'confirmation');
  await rejects(send(id, 'change'), 'failed-precondition', /already knows this time/);
  await A.update(db, actor, { id, date: '2026-10-22', time: '14:30' }, NOW + H);
  const a = await appt(id); assert.equal(R.nextAction(a, NOW + H), 'change');
  const ok = await send(id, 'change', NOW + 2 * H, { expectedVersion: a.version }); assert.equal(ok.ok, true);
  assert.equal(calls[1].text.body, 'Hi Anna, an update on your consultation with Elite Kitchens: it is now on Thursday 22 October at 14:30. If you have any questions, just reply to this message and we will help. Thank you!');
  assert.equal((await appt(id)).customerNotice.toldStart, irish(2026, 10, 22, 14, 30));
  assert.equal((await send(id, 'change', NOW + 3 * H)).existing, true, 'the same version again sends nothing'); assert.equal(calls.length, 2);
  await A.update(db, actor, { id, time: '16:00' }, NOW + 4 * H);                          // moved AGAIN: a new version, a new message
  assert.equal((await send(id, 'change', NOW + 5 * H)).ok, true); assert.equal(calls.length, 3);
  assert.match(calls[2].text.body, /Thursday 22 October at 16:00/);
  await A.update(db, actor, { id, notes: 'internal only' }, NOW + 6 * H);                 // notes are internal: the customer is not told
  await rejects(send(id, 'change', NOW + 7 * H), 'failed-precondition', /already knows this time/);
});

test('CANCELLATION: only for a visit the customer was told about, once; a never-told visit needs nothing', async () => {
  await customer(); const id = await visit(), id2 = await visit({ time: '12:00' });
  await send(id, 'confirmation');
  await A.cancel(db, actor, { id }, NOW + H); await A.cancel(db, actor, { id: id2 }, NOW + H);
  await rejects(send(id2, 'cancellation', NOW + 2 * H), 'failed-precondition', /never told about this visit/);
  assert.equal(calls.length, 1);
  assert.equal((await send(id, 'cancellation', NOW + 2 * H)).ok, true);
  assert.equal(calls[1].text.body, 'Hi Anna, an update on your consultation with Elite Kitchens: it has been cancelled. If you have any questions, just reply to this message and we will help. Thank you!');
  assert.equal((await send(id, 'cancellation', NOW + 3 * H)).existing, true); assert.equal(calls.length, 2);
  assert.equal(R.nextAction(await appt(id), NOW + 3 * H), null);
  assert.equal((await send(id, 'confirmation', NOW + 4 * H)).existing, true, 'the confirmation was sent: asking again sends nothing'); assert.equal(calls.length, 2);
  await rejects(send(id2, 'confirmation', NOW + 4 * H), 'failed-precondition', /cancelled/);
});

test('a visit changed by someone else while you looked at it is refused (expected version), and other kinds of visit send nothing', async () => {
  await customer(); const id = await visit(), other = await visit({ type: 'other', time: '15:00' });
  await rejects(send(id, 'confirmation', NOW, { expectedVersion: 7 }), 'failed-precondition', /changed by someone else/);
  await rejects(send(other, 'confirmation'), 'failed-precondition', /does not send messages/);
  assert.equal(calls.length, 0);
  await rejects(send('a_nope', 'confirmation'), 'invalid-argument'); await rejects(send(id, 'surprise'), 'invalid-argument');
  await rejects(send('a_' + 'f'.repeat(24), 'confirmation'), 'not-found');
});

test('the callable: staff only, strict fields, the reminder cannot be sent by hand', async () => {
  await customer(); const id = await visit();
  await rejects(h.sendBookingNotice({ uid: 'x', token: { email: 'other@example.com', email_verified: true, staff: true } }, { id, kind: 'confirmation' }, deps()), 'permission-denied');
  await rejects(h.sendBookingNotice(null, { id, kind: 'confirmation' }, deps()), 'unauthenticated');
  for (const bad of [{ id, kind: 'reminder' }, { id, kind: 'x' }, { id, kind: 'confirmation', extra: 1 }, { id, kind: 'confirmation', expectedVersion: '1' }, null, [], { kind: 'confirmation' }]) await rejects(h.sendBookingNotice(staff, bad, deps()), 'invalid-argument', undefined);
  assert.equal(calls.length, 0);
});

// ================================================================ the evening reminder ====================================
const OPEN = irish(2026, 11, 1, 0, 0);                                         // the customer wrote 'recently' for every time used below: the 24-hour window is open, so these go as normal messages
const EVE = irish(2026, 10, 20, 17, 30);                                       // Tuesday 20 Oct 17:30 Irish time
const told = async (id, at = NOW) => send(id, 'confirmation', at);              // confirmed on Monday 10:00: more than 4 hours before the reminder
const sweep = (nowMs, over = {}) => BN.reminderSweep(deps(over), { nowMs });

test('REMINDER: the evening before, once; the words; a second sweep sends nothing', async () => {
  await customer(P, { inbound: OPEN }); const id = await visit(); await told(id); calls.length = 0;
  const r = await sweep(EVE); assert.deepEqual([r.sent, r.failed], [1, 0]);
  assert.equal(calls[0].text.body, 'Hi Anna, a reminder that your consultation with Elite Kitchens is tomorrow, Wednesday 21 October at 10:00. If you need to change it, just reply to this message. See you then!');
  const a = await appt(id); assert.equal(a.customerNotice.reminderFor, irish(2026, 10, 21, 10, 0)); assert.equal(a.customerNotice.kind, 'confirmation');
  assert.equal(R.describe(a, EVE).text, 'The customer was told, and reminded');
  const again = await sweep(EVE + 15 * MIN); assert.equal(again.sent, 0); assert.equal(calls.length, 1);
  const n = (await notices()).find((x) => x.kind === 'reminder'); assert.deepEqual([n.state, n.by], ['sent', 'auto']);
});

test('REMINDER outside the 24-hour window goes as the reminder template', async () => {
  await customer(P, { inbound: NOW - 5 * 24 * H }); const id = await visit(); await told(id); calls.length = 0;
  await sweep(EVE);
  assert.equal(calls[0].template.name, 'ek_reminder'); assert.deepEqual(calls[0].template.components[0].parameters.map((x) => x.text), ['Anna', 'consultation', 'Wednesday 21 October', '10:00']);
});

test('REMINDER time of day: nothing before 17:00, from 17:00, nothing from 19:30, nothing at night or in the morning', async () => {
  await customer(P, { inbound: OPEN }); const id = await visit(); await told(id); calls.length = 0;
  for (const [hh, mi] of [[0, 0], [8, 0], [12, 30], [16, 59], [19, 30], [19, 45], [22, 0], [23, 59]]) { const r = await sweep(irish(2026, 10, 20, hh, mi)); assert.equal(r.quiet, true, `${hh}:${mi}`); }
  assert.equal(calls.length, 0);
  assert.equal((await sweep(irish(2026, 10, 20, 19, 29))).sent, 1, '19:29 is still inside');
});

test('REMINDER: switched off by the kill switch it sends nothing at all', async () => {
  await customer(P, { inbound: OPEN }); const id = await visit(); await told(id); calls.length = 0;
  const r = await BN.reminderSweep({ db, wa, cfg: { ...cfg, booking: { ...BOOKING, remindersOn: false } } }, { nowMs: EVE });
  assert.equal(r.off, true); assert.equal(calls.length, 0);
});

test('REMINDER only for the right visits: tomorrow, told the current time, not told in the last 4 hours, scheduled, a customer-facing type', async () => {
  await customer(P, { inbound: OPEN }); await customer(Q, { name: 'Brian Kelly', inbound: OPEN });
  const ok = await visit(), later = await visit({ date: '2026-10-22' }), today = await visit({ date: '2026-10-20', time: '19:00' }), never = await visit({ time: '11:00' }), fresh = await visit({ time: '12:00' });
  const moved = await visit({ time: '13:00' }), cancelled = await visit({ time: '14:00' }), other = await visit({ time: '15:00', type: 'other' });
  for (const id of [ok, later, today, moved, cancelled]) await told(id);
  await send(fresh, 'confirmation', EVE - 3 * H);                                           // told 3 hours before the sweep
  await A.update(db, actor, { id: moved, time: '13:30' }, NOW + H);                         // moved and the customer was not told: no reminder with a time they do not know
  await A.cancel(db, actor, { id: cancelled }, NOW + H);
  calls.length = 0;
  const r = await sweep(EVE);
  assert.equal(r.sent, 1, JSON.stringify(r)); assert.equal(calls.length, 1); assert.match(calls[0].text.body, /Wednesday 21 October at 10:00/);
  assert.equal((await appt(ok)).customerNotice.reminderFor, irish(2026, 10, 21, 10, 0));
  for (const [name, id] of [['later', later], ['today', today], ['fresh', fresh], ['moved', moved], ['cancelled', cancelled]]) assert.ok(!((await appt(id)).customerNotice || {}).reminderFor, name + ' got no reminder');
  for (const id of [never, other]) assert.equal((await appt(id)).customerNotice, undefined);
});

test('REMINDER after a move: the change message first, then the NEW time gets its own reminder (the old one is never sent)', async () => {
  await customer(P, { inbound: OPEN }); const id = await visit(); await told(id);
  await sweep(irish(2026, 10, 20, 17, 0)); assert.equal(calls.length, 2, 'confirmation + reminder for the first time');
  await A.update(db, actor, { id, date: '2026-10-22', time: '09:00' }, irish(2026, 10, 20, 18, 0));
  assert.equal((await sweep(irish(2026, 10, 20, 18, 15))).sent, 0, 'moved, customer not told the new time: nothing');
  await send(id, 'change', irish(2026, 10, 20, 18, 30)); assert.equal(calls.length, 3);
  assert.equal((await sweep(irish(2026, 10, 21, 17, 30))).sent, 1, 'the evening before the NEW time, at least 4 hours after the change message');
  assert.match(calls[3].text.body, /tomorrow, Thursday 22 October at 09:00/);
  assert.equal((await sweep(irish(2026, 10, 21, 17, 45))).sent, 0); assert.equal(calls.length, 4);
});

test('REMINDER: told at 18:00 for tomorrow morning, no reminder 15 minutes later (they have just heard it)', async () => {
  await customer(P, { inbound: OPEN }); const id = await visit(); await send(id, 'confirmation', irish(2026, 10, 20, 18, 0)); calls.length = 0;
  assert.equal((await sweep(irish(2026, 10, 20, 18, 15))).sent, 0); assert.equal(calls.length, 0);
});

test('REMINDER failure handling: a refusal is retried at most 3 times, 30 minutes apart, then left alone; "not confirmed" is never retried', async () => {
  await customer(P, { inbound: NOW - 5 * 24 * H }); const id = await visit(); await told(id); calls.length = 0; mode = 'refuse';
  assert.equal((await sweep(irish(2026, 10, 20, 17, 0))).failed, 1);
  assert.equal((await sweep(irish(2026, 10, 20, 17, 15))).failed, 1, 'too soon: not even tried'); assert.equal(calls.length, 1);
  await sweep(irish(2026, 10, 20, 17, 31)); assert.equal(calls.length, 2);
  await sweep(irish(2026, 10, 20, 18, 2)); assert.equal(calls.length, 3);
  await sweep(irish(2026, 10, 20, 18, 40)); assert.equal(calls.length, 3, 'three tries and no more');
  assert.equal((await notices()).find((x) => x.kind === 'reminder').tries, 3);
  assert.equal((await appt(id)).customerNotice.reminderFor, null);
  // a different visit: the answer is lost
  const id2 = await visit({ time: '11:00' }); mode = 'ok'; await told(id2, NOW + 1); mode = 'server'; calls.length = 0;
  await sweep(irish(2026, 10, 20, 17, 0)); mode = 'ok'; await sweep(irish(2026, 10, 20, 18, 0)); await sweep(irish(2026, 10, 20, 19, 0));
  assert.equal(calls.filter((c) => c.type === 'text' && /11:00/.test(c.text.body)).length, 0);
  const lost = (await notices()).find((x) => x.kind === 'reminder' && x.appointmentId === id2); assert.equal(lost.state, 'unknown');
});

test('REMINDER: a customer who said stop gets none; one broken visit does not stop the others', async () => {
  await customer(P, { inbound: OPEN }); await customer(Q, { name: 'Brian Kelly', inbound: OPEN });
  const a = await visit({ p: Q }), b = await visit({ p: P, time: '11:00' });
  await told(a); await told(b);                                                              // both were told while contact was allowed
  await db.doc('conversations/' + Q).update({ doNotContact: { on: true, at: Timestamp.now(), by: 'x', source: 'customer' } }); calls.length = 0;
  const r = await sweep(EVE); assert.deepEqual([r.sent, r.failed], [1, 1]);
  assert.equal(calls.length, 1); assert.match(calls[0].text.body, /Hi Anna/);
});

// ---- the clock changes ----
test('CLOCK CHANGE (25 Oct 2026, clocks go back): the reminder window follows the Irish clock and "tomorrow" is the 25-hour day', () => {
  const w = BN.reminderWindow(irish(2026, 10, 24, 17, 0));
  assert.equal(w.open, true); assert.equal(w.from, irish(2026, 10, 25, 0, 0)); assert.equal(w.to, irish(2026, 10, 26, 0, 0));
  assert.equal(w.to - w.from, 25 * H, 'the day the clocks go back has 25 hours');
  assert.equal(BN.reminderWindow(irish(2026, 10, 24, 16, 59)).open, false); assert.equal(BN.reminderWindow(irish(2026, 10, 24, 19, 30)).open, false);
  // the evening of the change itself (now winter time, UTC+0)
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
  await customer(P, { inbound: OPEN });
  const first = await visit({ date: '2026-10-25', time: '00:15', at: irish(2026, 10, 20, 9, 0) }), last = await visit({ date: '2026-10-25', time: '23:45', at: irish(2026, 10, 20, 9, 0) }), next = await visit({ date: '2026-10-26', time: '00:15', at: irish(2026, 10, 20, 9, 0) });
  for (const id of [first, last, next]) await send(id, 'confirmation', irish(2026, 10, 20, 9, 30)); calls.length = 0;
  const r = await sweep(irish(2026, 10, 24, 17, 30)); assert.equal(r.sent, 2, JSON.stringify(r));
  assert.deepEqual(calls.map((c) => /Sunday 25 October at (00:15|23:45)/.test(c.text.body)), [true, true]);
});
test('the words use Irish time on both sides of a clock change', () => {
  assert.equal(BN.timeText(Date.UTC(2026, 9, 25, 23, 45)), '23:45'); assert.equal(BN.timeText(Date.UTC(2026, 9, 24, 23, 15)), '00:15');
  assert.equal(BN.dateText(Date.UTC(2026, 9, 24, 23, 15)), 'Sunday 25 October');
  assert.equal(BN.timeText(irish(2026, 3, 29, 10, 0)), '10:00'); assert.equal(BN.dateText(irish(2026, 3, 29, 10, 0)), 'Sunday 29 March');
});

// ---- erasure ----
test('ERASING A CUSTOMER erases their message records and nobody else\'s; a send that finishes after the erasure recreates nothing', async () => {
  await customer(P, { inbound: OPEN }); await customer(Q, { name: 'Brian Kelly', inbound: OPEN });
  const a = await visit(), b = await visit({ p: Q, time: '11:00' }); await send(a, 'confirmation'); await send(b, 'confirmation');
  assert.equal((await notices()).length, 2);
  await h.deleteCustomer(staff, { phone: P, confirm: P.slice(-4) }, { db, cfg, bucket: require('firebase-admin/storage').getStorage().bucket('demo-leados.appspot.com') });
  assert.deepEqual((await notices()).map((x) => x.phone), [Q]);
  assert.equal((await db.doc('conversations/' + P).get()).exists, false);
});
test('erased while the message is on its way: nothing is recreated', async () => {
  await customer(P, { inbound: OPEN }); const id = await visit();
  slow = async () => { await store.deleteCustomerData(db, require('firebase-admin/storage').getStorage().bucket('demo-leados.appspot.com'), P); };
  await send(id, 'confirmation').catch(() => {});
  assert.equal((await db.doc('conversations/' + P).get()).exists, false, 'no chat brought back'); assert.equal((await notices()).length, 0);
});

test('the browser cannot write these records: staff can read them, nobody can write', async () => {
  const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
  const env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'firestore.rules'), 'utf8'), host: process.env.FIRESTORE_EMULATOR_HOST.split(':')[0], port: +process.env.FIRESTORE_EMULATOR_HOST.split(':')[1] } });
  try {
    const s = env.authenticatedContext('staff1', { staff: true, staffUntil: Date.now() + 3600e3 }).firestore();
    await assertSucceeds(s.doc('bookingNotices/n_x').get()); await assertFails(s.doc('bookingNotices/n_x').set({ a: 1 })); await assertFails(s.doc('appointments/a_x').update({ customerNotice: 1 }));
    await assertFails(env.unauthenticatedContext().firestore().doc('bookingNotices/n_x').get());
  } finally { await env.cleanup(); }
});

// ================================================================ a message that could not be confirmed ====================================
const resolve = (id, kind, outcome, nowMs = NOW + 10 * MIN) => BN.resolveNotice({ db }, actor, { id, kind, outcome }, { nowMs });

test('UNCONFIRMED: the visit says so; "it arrived" records the customer as told and sends nothing; the button is gone and no reminder is blocked', async () => {
  await customer(P, { inbound: OPEN }); const id = await visit();
  mode = 'server'; await rejects(send(id, 'confirmation'), 'unavailable', /Not confirmed/); mode = 'ok';
  let a = await appt(id); assert.deepEqual([a.noticeIssue.kind, a.noticeIssue.state], ['confirmation', 'unknown']); assert.equal(a.customerNotice, undefined);
  const d = R.describe(a, NOW); assert.deepEqual([d.state, d.issue, d.kind, d.next], ['issue', 'unknown', 'confirmation', null]); assert.match(d.text, /did not say whether the last message/);
  const r = await resolve(id, 'confirmation', 'arrived'); assert.deepEqual([r.ok, r.state], [true, 'sent']);
  a = await appt(id); assert.equal(a.noticeIssue, undefined, 'the note is gone'); assert.deepEqual([a.customerNotice.kind, a.customerNotice.toldStart], ['confirmation', irish(2026, 10, 21, 10, 0)]);
  assert.equal(R.nextAction(a, NOW + 20 * MIN), null); assert.equal(calls.length, 1, 'nothing was sent by resolving');
  const n = (await notices())[0]; assert.deepEqual([n.state, n.resolved, n.resolvedBy], ['sent', 'arrived', 'thomas@example.com']);
  assert.equal((await resolve(id, 'confirmation', 'arrived')).existing, true, 'the same answer again changes nothing');
  assert.equal((await send(id, 'confirmation', NOW + H)).existing, true); assert.equal(calls.length, 1, 'and it is never sent as well');
  assert.equal((await sweep(EVE)).sent, 1, 'the evening reminder now works for this visit');
});

test('UNCONFIRMED: "it did not arrive" lets the message be sent again, once', async () => {
  await customer(P, { inbound: OPEN }); const id = await visit();
  mode = 'server'; await rejects(send(id, 'confirmation'), 'unavailable'); mode = 'ok';
  await rejects(send(id, 'confirmation', NOW + 5 * MIN), 'failed-precondition', /Not confirmed/);
  const r = await resolve(id, 'confirmation', 'notArrived'); assert.equal(r.state, 'failed');
  assert.equal((await appt(id)).noticeIssue, undefined); assert.equal((await notices())[0].state, 'failed');
  assert.equal((await send(id, 'confirmation', NOW + 15 * MIN)).ok, true); assert.equal(calls.length, 2);
  assert.equal((await send(id, 'confirmation', NOW + 20 * MIN)).existing, true); assert.equal(calls.length, 2);
  assert.equal((await appt(id)).customerNotice.kind, 'confirmation');
});

test('UNCONFIRMED: only an unconfirmed message can be resolved; strict input; staff only; a stuck "sending" counts after 3 minutes', async () => {
  await customer(P, { inbound: OPEN }); const id = await visit();
  await rejects(resolve(id, 'confirmation', 'arrived'), 'failed-precondition', /no unconfirmed message/);
  mode = 'refuse'; await rejects(send(id, 'confirmation'), 'unavailable'); mode = 'ok';
  await rejects(resolve(id, 'confirmation', 'arrived'), 'failed-precondition', /did not go/);
  assert.equal((await appt(id)).customerNotice, undefined, 'a refused message is not "told"');
  const a = await appt(id), nid = BN.noticeId(BN.noticeKey('cancellation', id, a));
  await db.collection('bookingNotices').doc(nid).set({ phone: P, appointmentId: id, kind: 'cancellation', state: 'sending', claimedAt: Timestamp.fromMillis(NOW), startMs: a.start.toMillis() });
  await rejects(resolve(id, 'cancellation', 'arrived', NOW + MIN), 'failed-precondition', /still being sent/);
  assert.equal((await resolve(id, 'cancellation', 'notArrived', NOW + 4 * MIN)).state, 'failed');
  for (const bad of [{ id, kind: 'x', outcome: 'arrived' }, { id, kind: 'confirmation', outcome: 'maybe' }, { id: 'a_nope', kind: 'confirmation', outcome: 'arrived' }]) await rejects(BN.resolveNotice({ db }, actor, bad), 'invalid-argument');
  await rejects(BN.resolveNotice({ db }, actor, { id: 'a_' + 'f'.repeat(24), kind: 'confirmation', outcome: 'arrived' }), 'not-found');
  await rejects(h.resolveBookingNotice({ uid: 'x', token: { email: 'other@example.com', email_verified: true, staff: true } }, { id, kind: 'confirmation', outcome: 'arrived' }, deps()), 'permission-denied');
  await rejects(h.resolveBookingNotice(staff, { id, kind: 'confirmation', outcome: 'arrived', extra: 1 }, deps()), 'invalid-argument');
});

test('A REFUSAL leaves a note on the visit ("the last try failed") that disappears when the message finally goes', async () => {
  await customer(P, { inbound: NOW - 30 * H }); const id = await visit();
  mode = 'refuse'; await rejects(send(id, 'confirmation'), 'unavailable');
  let a = await appt(id); assert.deepEqual([a.noticeIssue.state, a.noticeIssue.kind], ['failed', 'confirmation']); assert.match(a.noticeIssue.text, /doesn't know this template/);
  const d = R.describe(a, NOW); assert.deepEqual([d.state, d.next], ['needs', 'confirmation']); assert.match(d.text, /not been told yet \(the last try failed\)/);
  mode = 'ok'; await send(id, 'confirmation', NOW + 5 * MIN); a = await appt(id); assert.equal(a.noticeIssue, undefined);
});

test('UNCONFIRMED REMINDER: resolving "it arrived" records the reminder for that time, so it is never sent a second time', async () => {
  await customer(P, { inbound: OPEN }); const id = await visit(); await told(id); calls.length = 0;
  mode = 'server'; assert.equal((await sweep(EVE)).failed, 1); mode = 'ok';
  assert.equal((await appt(id)).noticeIssue.kind, 'reminder');
  assert.equal((await sweep(EVE + 15 * MIN)).sent, 0, 'an unconfirmed reminder is never repeated by the sweep'); assert.equal(calls.length, 1);
  await resolve(id, 'reminder', 'arrived', EVE + 20 * MIN);
  const a = await appt(id); assert.equal(a.customerNotice.reminderFor, irish(2026, 10, 21, 10, 0)); assert.equal(a.customerNotice.kind, 'confirmation'); assert.equal(a.noticeIssue, undefined);
  assert.equal((await sweep(EVE + 30 * MIN)).sent, 0); assert.equal(calls.length, 1);
});
