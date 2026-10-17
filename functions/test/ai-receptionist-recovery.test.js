// Audit repairs of 17 Oct 2026, the owner's alerts and other run-level fixes (real Firestore emulator; the model, WhatsApp and push are fakes; no AI call, every name is made up).
//   Astra F1: an unfinished owner alert after a sent message was unreachable once the customer wrote again ("thanks"), and a hand-over with no message ignored a failed push.
//   Also found in the repair: push.safeNotify never throws, so every failed push used to count as delivered, and a retry under the same key only found the first attempt's record.
//   Astra F5: a plain "thanks" the model marked as needing nobody became a silent "needs a person" pause.  Astra F9: a link asked for again was suppressed although the reply promised it.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const ai = require('../lib/ai');
const REC = require('../lib/aiReceptionist');
const KN = require('../lib/aiKnowledge');
const { SEED } = require('../lib/aiKnowledgeSeed');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const OWNERS = 'thomas@example.com', actor = { kind: 'staff', id: OWNERS };
const NOW = Date.UTC(2026, 9, 19, 10, 0), ts = (ms) => Timestamp.fromMillis(ms);              // Mon 19 Oct 2026, 11:00 in Ireland
const PH = '353871110061', USAGE = { input: 3000, output: 200, cacheRead: 0, cacheWrite: 0 };
const fake = (input) => { const m = { calls: 0, async complete() { m.calls++; return { text: '', stopReason: 'tool_use', usage: USAGE, toolCalls: [{ id: 'd1', name: 'reply_decision', input: { reply: '', intent: 'other', visit: 'none', hasQuestion: false, change: 'none', special: 'none', ack: 'none', schedule: { preference: null, opener: '' }, newFacts: [], handover: { needed: false, reason: null }, ...input } }] }; } }; return m; };
const noModel = { async complete() { throw new Error('the model must not be asked'); } };
const wa = () => { const w = { sent: [], async sendText(to, body) { w.sent.push(body); return 'wamid.AUTO' + w.sent.length; } }; return w; };
const noWa = { async sendText() { throw new Error('nothing may be sent'); } };
// a push hook that answers like push.safeNotify: { sent, failed } after trying; `script` says what each call answers
const pushOf = (...script) => { const p = { events: [], async notify(ev) { p.events.push(ev); return script[Math.min(p.events.length - 1, script.length - 1)]; } }; return p; };
const DELIVERED = { sent: 1, failed: 0 }, NOT_DELIVERED = { sent: 0, failed: 1 };
const conv = async () => (await db.doc('conversations/' + PH).get()).data();
const deps = (model, w, push) => ({ db, wa: w, model, owners: OWNERS, push, welcomeTemplate: 'welcome' });

beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await db.doc('aiSettings/modelCheck').set(Object.fromEntries(Object.entries(ai.MODELS).map(([k, m]) => [k, { id: m.id, ok: true, name: m.label, lifecycle: 'active', at: ts(NOW) }])));
  await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, replyAssistant: true, autoReply: true, monthlyCapEur: 15, dailyCapEur: 2 });
});
async function chat(rec, { seq = 1, lastIn = NOW - 120e3, messages = [['in', 'Hi, can you tell me about your kitchens?', lastIn]] } = {}) {
  await db.doc('contacts/' + PH).set({ phone: PH, name: 'Aoife Kavanagh', projectType: 'Kitchen', location: 'Swords' });
  await db.doc('conversations/' + PH).set({ phone: PH, name: 'Aoife Kavanagh', inboxStatus: 'inbox', createdAt: ts(NOW - 9e6), inboundSeq: seq, lastInboundAt: ts(lastIn), receptionist: { on: true, at: ts(NOW - 3600e3), paused: null, handledMs: 0, count: 0, day: null, ...rec } });
  for (const [dir, body, at] of messages) await db.collection(`conversations/${PH}/messages`).add({ direction: dir, type: 'text', body, createdAt: ts(at), ...(dir === 'out' ? { auto: true } : {}) });
}

test('ASTRA F1: an unfinished alert after a sent message is finished even after the customer wrote again (newer message), with no model call and nothing sent', async () => {
  for (const newer of [false, true]) {
    await db.recursiveDelete(db.doc('conversations/' + PH));
    const lastIn = NOW - 120e3;
    await chat({ paused: 'handover: question', handledSeq: 0 }, { seq: newer ? 2 : 1, lastIn: lastIn + (newer ? 60e3 : 0) });
    // the state after one real send whose push failed once: the claim says sent, the job is not done (Astra's exact reproduction)
    await db.doc(`conversations/${PH}/sendRequests/auto_s1`).set({ state: 'sent', effectsDone: false, pushTries: 1, effects: { step: 'holding', pause: 'handover: question', notify: true, lastIn, seq: 1, key: 's1', day: '2026-10-19' } });
    const p = pushOf(DELIVERED);
    const r = await REC.processChat(deps(noModel, noWa, p), PH, NOW);
    const claim = (await db.doc(`conversations/${PH}/sendRequests/auto_s1`).get()).data();
    assert.equal(p.events.length, 1, `newer=${newer}: the owner is alerted`);
    assert.equal(claim.effectsDone, true, `newer=${newer}: the job is finished`);
    assert.equal(r, 'already_sent', `newer=${newer}`);
    assert.equal(p.events[0].sourceId, PH + '|s1.1', 'the retry uses its own key (the first attempt\'s record would block it)');
  }
});

test('A HAND-OVER WITH NO MESSAGE keeps its alert until it is delivered: a failed push is tried again by the next run; three failures are marked on the chat, never dropped silently', async () => {
  // the model hands over (a question it cannot answer, no knowledge published): nothing is sent, a push is due
  await chat({});
  const p = pushOf(NOT_DELIVERED, DELIVERED);
  assert.equal(await REC.processChat(deps(fake({ intent: 'other', hasQuestion: true, handover: { needed: true, reason: 'a question for the team' } }), noWa, p), PH, NOW), 'handed_over');
  let c = await conv();
  assert.ok(c.receptionist.paused);
  assert.equal(c.receptionist.notify && c.receptionist.notify.tries, 1, 'the alert is still owed after a push that reached no device');
  // the 5-minute check runs the paused chat again: the alert goes out, under a new key
  assert.equal(await REC.processChat(deps(noModel, noWa, p), PH, NOW + 300e3), 'paused');
  c = await conv();
  assert.equal(c.receptionist.notify, undefined, 'delivered: nothing owed any more');
  assert.equal(p.events.length, 2); assert.notEqual(p.events[0].sourceId, p.events[1].sourceId);
  // nothing ever delivered: marked visibly after three tries, and not tried a fourth time
  await db.recursiveDelete(db.doc('conversations/' + PH)); await chat({});
  const bad = pushOf(NOT_DELIVERED);
  await REC.processChat(deps(fake({ intent: 'other', hasQuestion: true, handover: { needed: true, reason: 'q' } }), noWa, bad), PH, NOW);
  for (let i = 1; i <= 3; i++) await REC.processChat(deps(noModel, noWa, bad), PH, NOW + i * 300e3);
  c = await conv();
  assert.equal(bad.events.length, 3, 'three attempts');
  assert.ok(c.receptionist.notifyFailed && c.receptionist.notifyFailed.tries === 3, 'marked on the chat');
  assert.equal(c.receptionist.notify, undefined);
  // a push hook that cannot even try (safeNotify's { failed: true }) is not delivered either
  await db.recursiveDelete(db.doc('conversations/' + PH)); await chat({});
  await REC.processChat(deps(fake({ intent: 'other', hasQuestion: true, handover: { needed: true, reason: 'q' } }), noWa, pushOf({ failed: true })), PH, NOW);
  assert.equal((await conv()).receptionist.notify.tries, 1);
});

test('ASTRA F5 (A054, B028, B030): a plain "thanks" the model marks as needing nobody is not a silent hand-over', async () => {
  for (const [said, ack] of [['Thanks, I will send the plans there.', 'thanks'], ['Thanks for the message, I\'m still at work.', 'thanks'], ['I meant yes to getting information, not a visit.', 'thanks']]) {
    await db.recursiveDelete(db.doc('conversations/' + PH));
    await chat({}, { messages: [['in', 'What is your email address?', NOW - 600e3], ['out', 'Our email is info@elitekitchens.ie.', NOW - 500e3], ['in', said, NOW - 120e3]] });
    const p = pushOf(DELIVERED), w = wa();
    const r = await REC.processChat(deps(fake({ intent: 'other', ack, hasQuestion: false, handover: { needed: false } }), w, p), PH, NOW);
    assert.equal(r, 'quiet_skip', said);
    assert.equal((await conv()).receptionist.paused, null, said + ': not paused');
    assert.equal(p.events.length, 0, said + ': nobody alerted'); assert.equal(w.sent.length, 0);
  }
  // unchanged: an unclear message the model did NOT mark as a thanks or hello is still a person's
  await db.recursiveDelete(db.doc('conversations/' + PH)); await chat({});
  assert.equal(await REC.processChat(deps(fake({ intent: 'other', reply: 'Hmm' }), wa(), pushOf(DELIVERED)), PH, NOW), 'handed_over');
});

test('ASTRA F9 (A051): a link the customer asks for again is sent again', async () => {
  await db.doc('aiKnowledge/live').set({ version: 1, data: KN.clean(SEED), publishedAt: ts(NOW - 86400e3) });
  await chat({}, { messages: [['in', 'Can I see photos of your previous work?', NOW - 900e3], ['out', 'Of course.\nYou can see some of our work here: elitekitchens.ie and instagram.com/elite_kitchens_ie', NOW - 800e3], ['in', 'Do you have an Instagram page as well?', NOW - 120e3]] });
  const w = wa();
  const r = await REC.processChat(deps(fake({ reply: 'Yes, we do. The Instagram page is there with the link above, and I\'ll pop it in again here.', intent: 'asking_info', hasQuestion: true, answerState: 'answered', links: ['instagram'], topics: ['portfolio-when'] }), w, pushOf(DELIVERED)), PH, NOW);
  assert.match(r, /^sent:/, r);
  assert.match(w.sent[0], /instagram\.com\/elite_kitchens_ie/, w.sent[0]);
});
