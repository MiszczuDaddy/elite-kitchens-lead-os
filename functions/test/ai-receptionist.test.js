// Phase 9 R3: the automatic receptionist (docs/AI.md). Real Firestore emulator; the "model" and "WhatsApp" are fakes; every name and message is made up.
// What matters: it answers only chats the owner switched on, only new messages, only with the fixed lines, never at night, never after a person replied or after a hand-over, never twice;
// anything else is handed over with a push and no reply; and it never books, changes or sends anything but the one text.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const ai = require('../lib/ai');
const REC = require('../lib/aiReceptionist');
const SCH = require('../lib/aiSchedule');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const OWNERS = 'thomas@example.com', actor = { kind: 'staff', id: 'thomas@example.com' }, other = { kind: 'staff', id: 'other@example.com' };
const NOW = Date.UTC(2026, 9, 13, 10, 0), ts = (ms) => Timestamp.fromMillis(ms);       // 11:00 in Ireland
const PH = '353871110031', PH2 = '353871110032', USAGE = { input: 3000, output: 200, cacheRead: 0, cacheWrite: 0 };
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code, `expected ${code}`);

function fake(script) {
  const m = { name: 'fake', calls: [], async complete(req) { m.calls.push(1); const s = script[Math.min(m.calls.length - 1, script.length - 1)], r = typeof s === 'function' ? await s(req) : s; return { text: '', toolCalls: [], stopReason: 'end_turn', usage: USAGE, ...r }; } };
  return m;
}
const decision = (over = {}) => ({ toolCalls: [{ id: 'd1', name: 'reply_decision', input: { reply: '', intent: 'wants_consultation', wantsConsultation: true, schedule: { preference: null, opener: '' }, newFacts: [], handover: { needed: false, reason: null }, ...over } }], stopReason: 'tool_use' });
const PREF = { preference: { weeks: 'next', days: ['tuesday'], times: 'afternoons', text: 'Tuesday afternoon' }, opener: '' };
function fakeWa(fail) { const w = { sent: [], async sendText(to, body) { if (fail) throw fail; w.sent.push({ to, body }); return 'wamid.AUTO' + w.sent.length; } }; return w; }
function fakePush() { const p = { events: [], async notify(ev) { p.events.push(ev); } }; return p; }
const checked = () => db.doc('aiSettings/modelCheck').set(Object.fromEntries(Object.entries(ai.MODELS).map(([k, m]) => [k, { id: m.id, ok: true, name: m.label, lifecycle: 'active', at: ts(NOW) }])));
const on = async (extra = {}) => { await checked(); await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, replyAssistant: true, autoReply: true, monthlyCapEur: 15, dailyCapEur: 2, ...extra }); };
const rec = async (phone = PH) => (await db.doc('conversations/' + phone).get()).data().receptionist;
const consult = async (phone = PH) => (await db.doc('conversations/' + phone).get()).data().consult || null;
const msgs = async (phone = PH) => (await db.collection(`conversations/${phone}/messages`).get()).docs.map((d) => d.data());

async function seed(phone = PH) {
  await db.doc('contacts/' + phone).set({ phone, name: 'Aoife Kavanagh', projectType: 'Kitchen', location: 'Swords', createdAt: ts(NOW - 9e8) });
  await db.doc('conversations/' + phone).set({ phone, name: 'Aoife Kavanagh', inboxStatus: 'inbox', createdAt: ts(NOW - 9e8), updatedAt: ts(NOW - 1e6), lastInboundAt: ts(NOW - 3600e3), lastMessageDirection: 'in', unreadCount: 1 });
  await db.collection(`conversations/${phone}/messages`).add({ direction: 'in', type: 'text', body: 'Hi', createdAt: ts(NOW - 3600e3) });
}
const fresh = async (phone = PH) => { await db.recursiveDelete(db.doc('conversations/' + phone)); await seed(phone); };       // a clean chat (earlier messages and claims removed)
// Switch the receptionist on for the chat 10 minutes before `t`, then let the customer write 2 minutes before `t`.
async function arm(t = NOW, body = 'I would like a kitchen consultation', phone = PH) {
  await ai.setReceptionist({ db, owners: OWNERS }, actor, { phone, on: true }, { nowMs: t - 600e3 });
  await db.collection(`conversations/${phone}/messages`).add({ direction: 'in', type: 'text', body, createdAt: ts(t - 120e3) });
  await db.doc('conversations/' + phone).update({ lastInboundAt: ts(t - 120e3), lastMessageDirection: 'in' });
}
const deps = (model, wa, push) => ({ db, wa, model, owners: OWNERS, push });
beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await seed(); await seed(PH2);
});

test('SWITCHES: the check does nothing unless the AI, real customer data, reply suggestions AND automatic replies are all on; it reads no chat otherwise', async () => {
  await arm();
  for (const extra of [{ enabled: false }, { customerDataApproved: false }, { replyAssistant: false }]) {
    await on(extra); const m = fake([decision()]), w = fakeWa(); const r = await REC.sweep(deps(m, w, fakePush()), NOW);
    assert.deepEqual(r, { skipped: 'off' }, JSON.stringify(extra)); assert.equal(m.calls.length + w.sent.length, 0);
  }
  await db.doc('aiSettings/current').delete(); assert.deepEqual(await REC.sweep(deps(fake([decision()]), fakeWa(), fakePush()), NOW), { skipped: 'off' }, 'no settings at all means off');
  await on(); assert.deepEqual(await REC.sweep(deps(null, fakeWa(), fakePush()), NOW), { skipped: 'no key' });
});

test('MASTER SWITCH OFF: a chat the owner switched on himself (testing one chat) is still answered, an automatically switched-on chat is not, and nothing new is switched on', async () => {
  await on({ autoReply: false }); await arm(); await arm(NOW, 'Hi there', PH2); await db.doc('conversations/' + PH2).update({ 'receptionist.auto': true });
  const m = fake([decision()]), w = fakeWa(); const r = await REC.sweep(deps(m, w, fakePush()), NOW);
  assert.deepEqual(w.sent.map((x) => x.to), [PH], 'only the chat the owner switched on'); assert.equal(r['sent:ask_next_week'], 1); assert.equal(r.activated, undefined);
});

test('SEND: the first question goes out once, in the fixed words, marked as automatic; the consultation flow moves on; nothing else is touched', async () => {
  await on(); await arm(); const m = fake([decision()]), w = fakeWa(), p = fakePush();
  const apptsBefore = (await db.collection('appointments').get()).size;
  assert.equal(await REC.processChat(deps(m, w, p), PH, NOW), 'sent:ask_next_week');
  assert.deepEqual(w.sent, [{ to: PH, body: SCH.LINES.ask_next_week }], 'exactly the fixed line (the chat already has messages from us, so no greeting)');
  const out = (await msgs()).filter((x) => x.direction === 'out' && x.auto); assert.equal(out.length, 1); assert.equal(out[0].body, SCH.LINES.ask_next_week);
  assert.deepEqual(await consult(), { stage: 'asked_next_week', asks: 1, offered: true }); const r = await rec(); assert.deepEqual([r.on, r.paused, r.count, r.last.step], [true, null, 1, 'ask_next_week']);
  assert.equal(p.events.length, 0, 'asking a question needs nobody');
  assert.equal(await REC.processChat(deps(m, w, p), PH, NOW + 60e3), 'handled', 'the same customer message is never answered twice'); assert.equal(w.sent.length, 1); assert.equal(m.calls.length, 1);
  assert.equal((await db.collection('appointments').get()).size, apptsBefore, 'nothing was booked');
});

test('TIMING: not before 45 seconds after the customer\'s last message; not between midnight and 7:00 Irish time (it waits and answers after 7:00)', async () => {
  await on(); await arm(); const m = fake([decision()]), w = fakeWa();
  await db.doc('conversations/' + PH).update({ lastInboundAt: ts(NOW - 20e3) }); assert.equal(await REC.processChat(deps(m, w, fakePush()), PH, NOW), 'wait'); assert.equal(m.calls.length, 0);
  assert.equal(await REC.processChat(deps(m, w, fakePush()), PH, NOW + 40e3), 'sent:ask_next_week', '60 seconds after: answered');
  assert.deepEqual([REC.quiet(Date.UTC(2026, 9, 13, 22, 59)), REC.quiet(Date.UTC(2026, 9, 13, 23, 0)), REC.quiet(Date.UTC(2026, 9, 14, 5, 59)), REC.quiet(Date.UTC(2026, 9, 14, 6, 0)), REC.quiet(Date.UTC(2026, 11, 14, 6, 30))],
    [false, true, true, false, true], 'Irish time: 23:59 is before midnight (summer UTC+1: 22:59 UTC = 23:59), 00:00-06:59 is quiet, 07:00 is not; in winter 06:30 UTC is 06:30');
  const night = Date.UTC(2026, 9, 14, 3, 0); await arm(night, 'Are you there?', PH2);
  const w2 = fakeWa(); assert.deepEqual(await REC.sweep(deps(fake([decision()]), w2, fakePush()), night), { skipped: 'quiet hours' }); assert.equal(w2.sent.length, 0, 'nothing is sent at night');
  const morning = Date.UTC(2026, 9, 14, 6, 5);                         // 07:05 in Ireland: the customer's message (03:00) is older than the arming, so use a fresh one
  await db.collection(`conversations/${PH2}/messages`).add({ direction: 'in', type: 'text', body: 'Hello?', createdAt: ts(morning - 120e3) }); await db.doc('conversations/' + PH2).update({ lastInboundAt: ts(morning - 120e3) });
  const r = await REC.sweep(deps(fake([decision()]), w2, fakePush()), morning); assert.equal(r['sent:ask_next_week'], 1); assert.equal(w2.sent.length, 1);
});

test('SCOPE: only chats the owner switched on are read; only messages after it was switched on are answered; off means off', async () => {
  await on(); await arm(); const m = fake([decision()]), w = fakeWa();
  const r = await REC.sweep(deps(m, w, fakePush()), NOW); assert.equal(m.calls.length, 1, 'only the switched-on chat was answered'); assert.equal(await rec(PH2), undefined, 'the other customer was not touched'); assert.deepEqual(w.sent.map((x) => x.to), [PH]);
  assert.equal(await REC.processChat(deps(m, w, fakePush()), PH2, NOW), 'off');
  await ai.setReceptionist({ db, owners: OWNERS }, actor, { phone: PH2, on: true }, { nowMs: NOW }); assert.equal(await REC.processChat(deps(m, w, fakePush()), PH2, NOW + 3600e3), 'nothing_new', 'its older messages are not answered');
  await ai.setReceptionist({ db, owners: OWNERS }, actor, { phone: PH, on: false }, { nowMs: NOW }); await db.doc('conversations/' + PH).update({ lastInboundAt: ts(NOW + 100e3) }); assert.equal(await REC.processChat(deps(m, w, fakePush()), PH, NOW + 300e3), 'off');
  assert.equal(w.sent.length, 1); assert.equal((await rec()).count, 1, 'switching off keeps the record');
});

test('HAND-OVER: a preference is acknowledged in the fixed words, the request is left for the owner to book, the owner gets a push, and the receptionist then stays out', async () => {
  await on(); await arm(NOW, 'Tuesday afternoon would suit me'); const m = fake([decision({ schedule: PREF })]), w = fakeWa(), p = fakePush();
  assert.equal(await REC.processChat(deps(m, w, p), PH, NOW), 'sent:acknowledge'); assert.deepEqual(w.sent.map((x) => x.body), [SCH.LINES.acknowledge]);
  const c = await consult(); assert.deepEqual([c.stage, c.needsBooking, c.preference.firstDate], ['preference_given', true, '2026-10-20']);
  assert.deepEqual(p.events.map((e) => [e.kind, e.phone]), [['handover', PH]]); assert.equal((await rec()).paused, 'consultation passed to you');
  await db.collection(`conversations/${PH}/messages`).add({ direction: 'in', type: 'text', body: 'Thanks, what time?', createdAt: ts(NOW + 60e3) }); await db.doc('conversations/' + PH).update({ lastInboundAt: ts(NOW + 60e3) });
  assert.equal(await REC.processChat(deps(m, w, p), PH, NOW + 200e3), 'paused'); assert.equal(w.sent.length, 1, 'after the hand-over it says nothing more'); assert.equal(m.calls.length, 1);
});

test('PERSON TAKES OVER: anything a person sent since it was switched on stops it for good (until switched on again); no push, no reply', async () => {
  await on(); await arm(); await db.collection(`conversations/${PH}/messages`).add({ direction: 'out', type: 'text', body: 'Hi Aoife, it\'s Thomas.', createdAt: ts(NOW - 60e3) });
  const m = fake([decision()]), w = fakeWa(), p = fakePush();
  assert.equal(await REC.processChat(deps(m, w, p), PH, NOW), 'staff_replied'); assert.equal(m.calls.length + w.sent.length + p.events.length, 0); assert.equal((await rec()).paused, 'a person replied');
  await db.doc('conversations/' + PH).update({ lastInboundAt: ts(NOW + 100e3) }); assert.equal(await REC.processChat(deps(m, w, p), PH, NOW + 300e3), 'paused');
  await ai.setReceptionist({ db, owners: OWNERS }, actor, { phone: PH, on: true }, { nowMs: NOW + 400e3 }); assert.equal((await rec()).paused, null, 'switching it on again starts a fresh page');
});

test('NOT A SIMPLE CASE: an unclear message or a question about prices is handed over with a push and NO reply (a complaint has its own test)', async () => {
  await on();
  for (const [name, d] of [['unclear', decision({ intent: 'other', wantsConsultation: false, reply: 'Hmm' })], ['price', decision({ intent: 'pricing', wantsConsultation: false, handover: { needed: true, reason: 'asks about price' }, reply: 'It costs 5000 euro' })]]) {
    await fresh(); await arm(); const m = fake([d]), w = fakeWa(), p = fakePush();
    assert.equal(await REC.processChat(deps(m, w, p), PH, NOW), 'handed_over', name); assert.equal(w.sent.length, 0, name + ': nothing sent'); assert.equal(p.events.length, 1, name + ': the owner is told'); assert.ok((await rec()).paused, name);
    const drafts = (await db.collection('aiDrafts').get()).docs.map((x) => x.data()); assert.ok(drafts.every((x) => x.outcome === 'discarded'), name + ': the draft is recorded as not used'); await db.recursiveDelete(db.collection('aiDrafts'));
  }
});

test('ASKED IF AI: the honest line is sent (the model never writes it), then the chat is the owner\'s', async () => {
  await on(); await arm(NOW, 'Am I talking to a robot?'); const m = fake([decision({ wantsConsultation: false, handover: { needed: true, reason: 'asked if AI' }, reply: 'No, I am Sean from the office' })]), w = fakeWa(), p = fakePush();
  assert.equal(await REC.processChat(deps(m, w, p), PH, NOW), 'sent:asked_ai'); assert.deepEqual(w.sent.map((x) => x.body), [SCH.LINES.asked_ai]); assert.match(w.sent[0].body, /automated assistant/); assert.doesNotMatch(w.sent[0].body, /Sean/);
  assert.equal(p.events.length, 1); assert.equal((await rec()).paused, 'asked if AI');
});

test('A BOOKED CUSTOMER CHANGING THE BOOKING: asked about next week once; then passed on; never asked twice; the owner is told', async () => {
  await on(); await db.collection('appointments').add({ phone: PH, status: 'scheduled', type: 'consultation', start: ts(NOW + 3 * 86400e3), end: ts(NOW + 3 * 86400e3 + 3600e3), customerName: 'Aoife' });
  await arm(NOW, 'Can I change my consultation to a different day?'); const change = decision({ wantsConsultation: false, handover: { needed: true, reason: 'wants to change booking' } }), m = fake([change]), w = fakeWa(), p = fakePush();
  assert.equal(await REC.processChat(deps(m, w, p), PH, NOW), 'sent:change_ask'); assert.equal(w.sent[0].body, SCH.LINES.change_ask); assert.equal(p.events.length, 1); assert.equal((await rec()).paused, null, 'it waits for their answer');
  await db.collection(`conversations/${PH}/messages`).add({ direction: 'in', type: 'text', body: 'Tuesday afternoon please', createdAt: ts(NOW + 100e3) }); await db.doc('conversations/' + PH).update({ lastInboundAt: ts(NOW + 100e3) });
  const m2 = fake([decision({ wantsConsultation: false, handover: { needed: true, reason: 'wants to change booking' }, schedule: PREF })]);
  assert.equal(await REC.processChat(deps(m2, w, p), PH, NOW + 300e3), 'sent:change_given'); assert.equal(w.sent[1].body, SCH.LINES.acknowledge); assert.equal((await rec()).paused, 'consultation passed to you');
  assert.notEqual(((await consult()) || {}).needsBooking, true, 'no request to book is left: the owner moves the existing booking');
});

test('LIMITS: at most 6 automatic messages a day; overlapping checks never both answer; a refused send hands over; a failing model is tried 3 times then handed over; the budget stops it', async () => {
  await on(); await arm(); const day = ai.dayId(NOW), w0 = fakeWa();
  await db.doc('conversations/' + PH).update({ 'receptionist.day': day, 'receptionist.count': 6 }); assert.equal(await REC.processChat(deps(fake([decision()]), w0, fakePush()), PH, NOW), 'daily_limit'); assert.equal(w0.sent.length, 0);
  await db.doc('conversations/' + PH).update({ 'receptionist.count': 0 });
  const m = fake([async () => { await new Promise((r) => setTimeout(r, 150)); return decision(); }]), w = fakeWa(); const both = await Promise.all([REC.processChat(deps(m, w, fakePush()), PH, NOW), REC.processChat(deps(m, w, fakePush()), PH, NOW)]);
  assert.equal(w.sent.length, 1, 'one message only: ' + both.join(',')); assert.equal(both.filter((x) => x === 'sent:ask_next_week').length, 1); assert.ok(both.some((x) => x === 'busy' || x === 'handled'), 'the other one stood aside: ' + both.join(',')); assert.equal((await rec()).lockUntil, 0, 'the lock is released');
  // a refused send: nothing recorded as sent, the owner is told
  await fresh(); await arm(NOW, 'Hello', PH); const refused = Object.assign(new Error('rejected'), { definite: true, code: 131047 }), wf = fakeWa(refused), p = fakePush();
  assert.equal(await REC.processChat(deps(fake([decision()]), wf, p), PH, NOW), 'send_failed'); assert.equal((await msgs()).filter((x) => x.auto).length, 0); assert.equal(p.events.length, 1); assert.equal((await rec()).paused, 'send failed');
  // a failing model
  await fresh(); await arm(NOW, 'Hello again'); const boom = fake([async () => { throw Object.assign(new Error('down'), { status: 500 }); }]), pw = fakePush(), ww = fakeWa();
  assert.deepEqual([await REC.processChat(deps(boom, ww, pw), PH, NOW), await REC.processChat(deps(boom, ww, pw), PH, NOW + 60e3), await REC.processChat(deps(boom, ww, pw), PH, NOW + 120e3)], ['retry', 'retry', 'failed']);
  assert.equal(ww.sent.length, 0); assert.equal(pw.events.length, 1); assert.match((await rec()).paused, /ai failed 3 times/);
  // the budget
  await fresh(); await arm(NOW, 'Hello third'); await on({ dailyCapEur: 0.0001 }); const pb = fakePush(), wb = fakeWa(), mb = fake([decision()]);
  assert.equal(await REC.processChat(deps(mb, wb, pb), PH, NOW), 'refused'); assert.equal(mb.calls.length + wb.sent.length, 0); assert.equal(pb.events.length, 1); assert.match((await rec()).paused, /ai unavailable/);
});

test('OWNER ONLY: only the owner switches the receptionist (and its master switch); it is audited without any customer words', async () => {
  await rejects(ai.setReceptionist({ db, owners: OWNERS }, other, { phone: PH, on: true }), 'permission-denied'); await rejects(ai.setReceptionist({ db, owners: '' }, actor, { phone: PH, on: true }), 'permission-denied');
  await rejects(ai.setReceptionist({ db, owners: OWNERS }, actor, { phone: 'abc', on: true }), 'invalid-argument'); await rejects(ai.setReceptionist({ db, owners: OWNERS }, actor, { phone: PH, on: 'yes' }), 'invalid-argument');
  await rejects(ai.setReceptionist({ db, owners: OWNERS }, actor, { phone: PH, on: true, x: 1 }), 'invalid-argument'); await rejects(ai.setReceptionist({ db, owners: OWNERS }, actor, { phone: '353800000999', on: true }), 'not-found');
  assert.equal((await rec()), undefined, 'refused calls changed nothing');
  await ai.setReceptionist({ db, owners: OWNERS }, actor, { phone: PH, on: true }, { nowMs: NOW }); assert.equal((await rec()).on, true);
  await rejects(ai.saveSettings({ db, model: null, owners: OWNERS }, other, { autoReply: true }), 'permission-denied'); await rejects(ai.saveSettings({ db, model: null, owners: OWNERS }, actor, { autoReply: 'yes' }), 'invalid-argument');
  await ai.saveSettings({ db, model: null, owners: OWNERS }, actor, { autoReply: true }); assert.equal((await ai.loadSettings(db)).autoReply, true); assert.equal((await ai.status({ db, model: null, owners: OWNERS }, actor, {})).autoReply, true);
  const log = (await db.collection('auditLog').where('action', '==', 'receptionist').get()).docs.map((d) => d.data()); assert.equal(log.length, 1); assert.deepEqual(Object.keys(log[0]).sort(), ['action', 'at', 'by', 'on', 'phoneTail']);
});

test('ERASURE AND SAFETY: the receptionist state goes with the customer; the module never books, edits or sends anything but one text through the claim', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/aiReceptionist.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/sendTemplate|sendMedia|createAppointment|updateAppointment|appointments|quotes|projects|updateContact|setConversationStatus/.test(src), false, 'no booking, quote, project or contact change');
  assert.equal((src.match(/wa\.sendText\(/g) || []).length, 1, 'exactly one place sends, after the claim'); assert.ok(src.indexOf('outbound.begin(') < src.indexOf('wa.sendText('));
  const sch = fs.readFileSync(path.join(__dirname, '../lib/aiSchedule.js'), 'utf8');   // Step C: the sets of steps moved to aiSchedule.js (the test screen needs them too); the ones the receptionist sends before Step C are unchanged
  assert.ok(sch.includes("SEND_STEPS = new Set(['offer_visit', 'price_offer', 'ack_only', 'cancel_ask', 'tentative', 'price_general', 'ask_next_week', 'ask_following_week', 'acknowledge', 'no_preference', 'asked_ai', 'change_ask', 'change_given', 'change_pass_on',"));
  assert.ok(src.includes("require('./aiSchedule')") && !/new Set\(\['offer_visit'/.test(src));
});
