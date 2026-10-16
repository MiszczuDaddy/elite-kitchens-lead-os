// Audit finding 9C: WHICH customer message was answered. WhatsApp times are whole seconds, so two messages in the same second used to look like one: the second was treated as "already answered" and never
// got its own reply, and a message that arrived late could be lost the same way. Now every inbound message has a number in its conversation (store.storeInbound), "answered" and "a newer message" use that
// number, the claim of the answer is keyed by it, and a conversation from before the numbers existed keeps working by time. Real Firestore emulator; the model and WhatsApp are fakes.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const ai = require('../lib/ai');
const REC = require('../lib/aiReceptionist');
const SCH = require('../lib/aiSchedule');
const store = require('../lib/store');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const OWNERS = 'thomas@example.com';
const NOW = Date.UTC(2026, 9, 13, 10, 0), ts = (ms) => Timestamp.fromMillis(ms), H = 3600e3, SEC = 1000, L = SCH.LINES;
const LEAD_AT = NOW - 4 * H, TEMPLATE = 'elite_kitchens_new_lead', PH = '353871110091', USAGE = { input: 3000, output: 200, cacheRead: 0, cacheWrite: 0 };
const S = Math.floor((NOW - 120 * SEC) / 1000) * 1000;                                   // a whole second: the time WhatsApp gives

const decision = (over = {}) => ({ text: '', toolCalls: [{ id: 'd1', name: 'reply_decision', input: { reply: '', intent: 'new_enquiry', visit: 'none', hasQuestion: false, change: 'none', ack: 'thanks', special: 'none', schedule: { preference: null, opener: '' }, newFacts: [], handover: { needed: false, reason: null }, ...over } }], stopReason: 'tool_use', usage: USAGE });
const model = (d = decision(), during) => { const m = { calls: 0, texts: [], async complete(args) { m.calls++; m.texts.push(args.messages[0].text); if (during) await during(m.calls); return d; } }; return m; };
const waFake = () => { const w = { sent: [], async sendText(to, body) { w.sent.push(body); return 'wamid.AUTO' + w.sent.length; } }; return w; };
const pushFake = () => ({ events: [], async notify() {} });
const checked = () => db.doc('aiSettings/modelCheck').set(Object.fromEntries(Object.entries(ai.MODELS).map(([k, m]) => [k, { id: m.id, ok: true, name: m.label, lifecycle: 'active', at: ts(NOW) }])));
const on = async (extra = {}) => { await checked(); await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, replyAssistant: true, autoReply: true, autoReplySince: ts(NOW - 5 * H), monthlyCapEur: 15, dailyCapEur: 2, ...extra }); };
const deps = (m, w, p) => ({ db, wa: w, model: m, owners: OWNERS, push: p || pushFake(), welcomeTemplate: TEMPLATE });
const conv = async () => (await db.doc('conversations/' + PH).get()).data();
const msg = async (id) => (await db.doc(`conversations/${PH}/messages/${id}`).get()).data();
let n = 0;
const inbound = (body, atMs, wamid) => store.storeInbound(db, { wamid: wamid || 'wamid.IN' + (++n), from: PH, type: 'text', body, name: 'Aoife Kavanagh', createdAt: new Date(atMs) });
async function chat({ activated = true, rec = {} } = {}) {
  await db.recursiveDelete(db.doc('conversations/' + PH));
  await db.doc('contacts/' + PH).set({ phone: PH, name: 'Aoife Kavanagh', projectType: 'Kitchen', location: 'Swords', source: 'Meta Ads', createdAt: ts(LEAD_AT), metaLead: { leadId: '1', receivedAt: ts(LEAD_AT) } });
  await db.doc('conversations/' + PH).set({ phone: PH, name: 'Aoife Kavanagh', inboxStatus: 'inbox', createdAt: ts(LEAD_AT), updatedAt: ts(LEAD_AT), unreadCount: 0, ...(activated ? { receptionist: { on: true, auto: true, at: ts(LEAD_AT), by: 'auto', paused: null, handledMs: 0, count: 0, day: null, ...rec } } : {}) });
  await store.storeOutbound(db, PH, { wamid: 'wamid.WELCOME', type: 'template', body: `[template: ${TEMPLATE}] Hi...` }); await db.doc(`conversations/${PH}/messages/wamid.WELCOME`).update({ createdAt: ts(LEAD_AT + 2000) });
}
const claims = async () => (await db.collection(`conversations/${PH}/sendRequests`).get()).docs.map((d) => d.id);

beforeEach(async () => { await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' }); await on(); n = 0; });

test('NUMBERING: every inbound message gets the next number, even in the same second and at the same moment; a duplicate delivery gets none; an older conversation starts at 1', async () => {
  await chat(); const a = await inbound('first', S), b = await inbound('second', S), dup = await inbound('second again', S, 'wamid.IN2');
  assert.deepEqual([a, b, dup], [true, true, false], 'the duplicate delivery of wamid.IN2 is refused as before');
  assert.deepEqual([(await msg('wamid.IN1')).seq, (await msg('wamid.IN2')).seq], [1, 2]); const c = await conv(); assert.equal(c.inboundSeq, 2); assert.equal(c.unreadCount, 2, 'a duplicate never counts twice'); assert.equal(c.lastInboundAt.toMillis(), S);
  assert.equal((await msg('wamid.IN2')).body, 'second', 'the duplicate did not change the stored message');
  // five at once: five different numbers
  await chat(); await Promise.all([1, 2, 3, 4, 5].map((i) => inbound('m' + i, S + i * 1000, 'wamid.PAR' + i)));
  const seqs = (await Promise.all([1, 2, 3, 4, 5].map((i) => msg('wamid.PAR' + i)))).map((m) => m.seq).sort(); assert.deepEqual(seqs, [1, 2, 3, 4, 5]); assert.equal((await conv()).inboundSeq, 5);
  // a conversation from before the numbers existed (no inboundSeq anywhere) numbers its next message 1
  await chat(); await db.doc(`conversations/${PH}/messages/wamid.OLD`).set({ wamid: 'wamid.OLD', direction: 'in', type: 'text', body: 'old', createdAt: ts(S - 1000), status: 'received' }); await db.doc('conversations/' + PH).update({ lastInboundAt: ts(S - 1000) });
  await inbound('new', S + 5000, 'wamid.NEW'); assert.equal((await msg('wamid.NEW')).seq, 1); assert.equal((await conv()).inboundSeq, 1);
});

test('TWO MESSAGES IN THE SAME SECOND: both are in what the model reads, in the order they arrived, and they are answered once', async () => {
  await chat(); await inbound('Hi, I am looking for a kitchen', S); await inbound('We have a shaker style in mind', S);
  const m = model(), w = waFake();
  assert.equal(await REC.processChat(deps(m, w), PH, NOW), 'sent:offer_visit'); assert.equal(w.sent.length, 1);
  const text = m.texts[0]; assert.ok(text.includes('Hi, I am looking for a kitchen') && text.includes('We have a shaker style in mind'), 'both messages were read');
  assert.ok(text.indexOf('Hi, I am looking') < text.indexOf('We have a shaker'), 'in the order they arrived');
  const r = (await conv()).receptionist; assert.deepEqual([r.handledSeq, r.handledMs], [2, S]); assert.deepEqual(await claims(), ['auto_s2']);
  assert.equal(await REC.processChat(deps(m, w), PH, NOW + 60 * SEC), 'handled'); assert.equal(w.sent.length, 1);
});

test('THE EVENT PATH: of two events for messages in the same second only the last goes on; one reply; two deliveries of the same event are one reply', async () => {
  await chat({ activated: false }); await on(); const t = []; let clock = NOW;
  const a = await inbound('Hi', S, 'wamid.EVA'), b = await inbound('I want a kitchen', S, 'wamid.EVB'); assert.deepEqual([a, b], [true, true]);
  const m = model(), w = waFake(), opts = (seq) => ({ sleep: async (x) => { t.push(x); clock += x; }, now: () => clock, seq });
  assert.equal(await REC.onInbound(deps(m, w), PH, S, opts(1)), 'superseded', 'the first message: a newer one (same second, higher number) is there'); assert.equal(m.calls, 0);
  const results = await Promise.all([REC.onInbound(deps(m, w), PH, S, opts(2)), REC.onInbound(deps(m, w), PH, S, opts(2))]);          // the same event delivered twice
  assert.equal(w.sent.length, 1, 'one reply: ' + JSON.stringify(results)); assert.equal(results.filter((x) => x === 'sent:offer_visit').length, 1);
  assert.ok(m.texts[0].includes('Hi') && m.texts[0].includes('I want a kitchen'));
  assert.equal(await REC.onInbound(deps(m, w), PH, S, opts(2)), 'handled', 'a later duplicate delivery is already answered');
  // onMessage passes the number from the stored message
  await chat({ activated: false }); await inbound('one', S, 'wamid.M1'); await inbound('two', S, 'wamid.M2');
  assert.equal(await REC.onMessage(deps(model(), waFake()), PH, await msg('wamid.M1'), opts(null)), 'superseded', 'onMessage reads the number from the message');
});

test('THE BUG THAT WAS: a message in the same second as one already answered is NOT "already answered": it gets its own reply', async () => {
  await chat(); await inbound('Hi, interested in a kitchen', S); const m = model(), w = waFake();
  assert.equal(await REC.processChat(deps(m, w), PH, NOW), 'sent:offer_visit'); assert.equal(w.sent.length, 1);
  await inbound('Do you supply the appliances?', S);                                      // the same second as the one answered
  const m2 = model(decision({ intent: 'asking_info', hasQuestion: true, handover: { needed: true, reason: 'question' }, answerState: 'none' }));
  const res = await REC.processChat(deps(m2, w), PH, NOW + 60 * SEC); assert.notEqual(res, 'handled', 'before the numbers this was "handled" and the message was never answered'); assert.equal(m2.calls, 1);
  assert.ok(m2.texts[0].includes('Do you supply the appliances?'));
});

test('A LATE WEBHOOK: a message that arrives after the answer, with an older time, is a new message: it is answered once; a duplicate of it is not', async () => {
  await chat(); await inbound('Hi, interested in a kitchen', S + 20 * SEC); const w = waFake(), m = model();
  assert.equal(await REC.processChat(deps(m, w), PH, NOW), 'sent:offer_visit');
  assert.equal(await inbound('Sorry, also an island please', S + 10 * SEC, 'wamid.LATE'), true);       // sent 10 seconds BEFORE the other, delivered after our answer
  const c = await conv(); assert.equal(c.inboundSeq, 2); assert.equal(c.lastInboundAt.toMillis(), S + 20 * SEC, 'the latest time is kept');
  const m2 = model(); const res = await REC.processChat(deps(m2, w), PH, NOW + 60 * SEC); assert.notEqual(res, 'handled'); assert.equal(m2.calls, 1, 'it is looked at once'); assert.ok(m2.texts[0].includes('also an island'));
  assert.equal(await inbound('Sorry, also an island please', S + 10 * SEC, 'wamid.LATE'), false, 'the same message delivered again is refused');
  assert.equal(await REC.processChat(deps(m2, w), PH, NOW + 120 * SEC), 'handled'); assert.equal(m2.calls, 1, 'and not looked at again');
});

test('A NEWER MESSAGE WHILE THE ANSWER IS WRITTEN counts even in the same second: nothing stale is sent, and the next run answers both', async () => {
  await chat(); await inbound('Hi', S); const w = waFake();
  const m = model(decision(), async (call) => { if (call === 1) await inbound('and one more thing', S); });          // arrives in the same second while the model works
  assert.equal(await REC.processChat(deps(m, w), PH, NOW), 'newer_message'); assert.equal(w.sent.length, 0); assert.equal((await conv()).receptionist.handledSeq, undefined, 'not answered');
  const m2 = model(); assert.equal(await REC.processChat(deps(m2, w), PH, NOW + 10 * SEC), 'sent:offer_visit'); assert.equal(w.sent.length, 1); assert.ok(m2.texts[0].includes('Hi') && m2.texts[0].includes('and one more thing'));
});

test('COMPATIBILITY: a conversation from before the numbers works by time as before (and its claim is keyed by the time); after its next message it moves to numbers without answering anything twice', async () => {
  await chat({ rec: { handledMs: S } });                                                  // answered up to S by the old code
  await db.doc(`conversations/${PH}/messages/wamid.OLD1`).set({ wamid: 'wamid.OLD1', direction: 'in', type: 'text', body: 'Hi', createdAt: ts(S), status: 'received' }); await db.doc('conversations/' + PH).update({ lastInboundAt: ts(S) });
  const w = waFake(), m = model();
  assert.equal(await REC.processChat(deps(m, w), PH, NOW), 'handled', 'no numbers, answered by time: still handled'); assert.equal(m.calls, 0);
  // an older, unanswered message with no numbers: answered, keyed by the time
  await db.doc('conversations/' + PH).update({ lastInboundAt: ts(S + 5 * SEC), 'receptionist.handledMs': 0 }); await db.doc(`conversations/${PH}/messages/wamid.OLD2`).set({ wamid: 'wamid.OLD2', direction: 'in', type: 'text', body: 'Anyone there?', createdAt: ts(S + 5 * SEC), status: 'received' });
  assert.equal(await REC.processChat(deps(m, w), PH, NOW), 'sent:offer_visit'); assert.deepEqual(await claims(), ['auto_' + (S + 5 * SEC)]); const r = (await conv()).receptionist; assert.deepEqual([r.handledMs, r.handledSeq], [S + 5 * SEC, undefined]);
  // the next message gets number 1, which is above "answered 0": answered; then handled
  await inbound('Yes please, come and have a look', S + 60 * SEC); const c = await conv(); assert.equal(c.inboundSeq, 1);
  const m2 = model(decision({ visit: 'asked', intent: 'wants_consultation' })); assert.equal(await REC.processChat(deps(m2, w), PH, NOW + 5 * SEC), 'sent:ask_next_week'); assert.equal(m2.calls, 1); assert.deepEqual((await claims()).sort(), ['auto_' + (S + 5 * SEC), 'auto_s1'].sort());
  assert.equal(await REC.processChat(deps(m2, w), PH, NOW + 70 * SEC), 'handled'); assert.equal(w.sent.length, 2, 'two replies for two different messages, none twice');
  // an old claim of the time that was still unfinished when the numbers arrived does not block the new message either
  assert.equal((await conv()).receptionist.handledSeq, 1);
});

test('DEPLOYMENT: only the webhook stores customer messages, it has its own stage, and that stage deploys nothing else', () => {
  const fs = require('fs'), path = require('path'), sh = fs.readFileSync(path.join(__dirname, '../../scripts', 'deploy-quote-sending.sh'), 'utf8').replace(/\r\n/g, '\n');
  const lib = (f) => fs.readFileSync(path.join(__dirname, '../lib', f), 'utf8');
  const users = fs.readdirSync(path.join(__dirname, '../lib')).filter((f) => f.endsWith('.js') && /storeInbound\(/.test(lib(f)) && f !== 'store.js'); assert.deepEqual(users, ['handlers.js'], 'storeInbound is used by the webhook handler only');
  assert.match(sh, /^WEBHOOK_FUNCS="webhook"/m); const i = sh.indexOf('\n  webhook)\n'); assert.ok(i >= 0); const stage = sh.slice(i, sh.indexOf('\n    ;;', i));
  assert.match(stage, /deploy_functions \$WEBHOOK_FUNCS/); assert.match(stage, /check_routing \$WEBHOOK_FUNCS/); assert.equal(/add-iam-policy-binding|access-compat|PUSH_|OLDER_FUNCS/.test(stage), false, 'nothing else is deployed or made public');
  assert.ok(stage.indexOf('check_settings') < stage.indexOf('confirm "') && stage.indexOf('confirm "') < stage.indexOf('deploy_functions'), 'checks, then the question, then the deploy');
});

test('NOTHING ELSE MOVED: the inbox fields stay as they were (last message, unread count, last inbound time); a person writing still stops it; a duplicate webhook changes nothing', async () => {
  await chat({ activated: false }); await inbound('Hello', S); const c1 = await conv();
  assert.deepEqual([c1.lastMessage, c1.lastMessageDirection, c1.unreadCount, c1.lastInboundAt.toMillis()], ['Hello', 'in', 1, S]);
  await inbound('Hello', S, 'wamid.IN1'); const c2 = await conv(); assert.deepEqual([c2.unreadCount, c2.inboundSeq], [1, 1]);
  await chat(); await inbound('Hi', S); const outbound = require('../lib/outbound'); await outbound.noteHuman(db, PH, S + 1000); assert.equal(await REC.processChat(deps(model(), waFake()), PH, NOW), 'staff_replied');
});
