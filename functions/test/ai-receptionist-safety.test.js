// Review of 16 Oct 2026 (audit findings 2, 3, 4 and 7, and the "Are you an AI?" false alarms). Real Firestore emulator; the model and WhatsApp are fakes. In customer terms:
//  - "Are you an AI?" is answered truthfully when they ask it, and is NOT triggered by questions about kitchens ("an automatic opening bin", "a machine used to cut the doors");
//  - an upset customer, or one who asks for a person, gets that line even when they also have a booking; the sales question about moving a visit never reaches them;
//  - a person who has written to the customer is never talked over, however many messages came in since, and also not when their message is still being sent;
//  - the switches, quiet hours and the 24-hour window are looked at again at the moment of sending, on the clock as it is then, inside the same transaction as the claim;
//  - if a run dies after WhatsApp accepted the message, the next run finishes the job (request for the owner, pause, push) and sends nothing again.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const ai = require('../lib/ai');
const REC = require('../lib/aiReceptionist');
const SCH = require('../lib/aiSchedule');
const KN = require('../lib/aiKnowledge');
const { SEED } = require('../lib/aiKnowledgeSeed');
const outbound = require('../lib/outbound');
const store = require('../lib/store');
const h = require('../lib/handlers');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const OWNERS = 'thomas@example.com', owner = { kind: 'staff', id: OWNERS };
const NOW = Date.UTC(2026, 9, 13, 10, 0), ts = (ms) => Timestamp.fromMillis(ms), H = 3600e3, SEC = 1000, L = SCH.LINES;
const LEAD_AT = NOW - 4 * H, TEMPLATE = 'elite_kitchens_new_lead', PH = '353871110081', USAGE = { input: 3000, output: 200, cacheRead: 0, cacheWrite: 0 };
const sleep = (n) => new Promise((r) => setTimeout(r, n));

const decision = (over = {}) => ({ text: '', toolCalls: [{ id: 'd1', name: 'reply_decision', input: { reply: '', intent: 'new_enquiry', visit: 'none', hasQuestion: false, change: 'none', ack: 'thanks', special: 'none', schedule: { preference: null, opener: '' }, newFacts: [], handover: { needed: false, reason: null }, ...over } }], stopReason: 'tool_use', usage: USAGE });
const model = (d = decision(), during) => { const m = { calls: 0, async complete() { m.calls++; if (during) await during(m.calls); return d; } }; return m; };
const waFake = () => { const w = { sent: [], async sendText(to, body) { w.sent.push(body); return 'wamid.AUTO' + w.sent.length; } }; return w; };
const pushFake = (failTimes = 0) => { const p = { events: [], failed: 0, async notify(ev) { if (p.failed < failTimes) { p.failed++; throw new Error('push down'); } p.events.push(ev); } }; return p; };
const checked = () => db.doc('aiSettings/modelCheck').set(Object.fromEntries(Object.entries(ai.MODELS).map(([k, m]) => [k, { id: m.id, ok: true, name: m.label, lifecycle: 'active', at: ts(NOW) }])));
const on = async (extra = {}) => { await checked(); await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, replyAssistant: true, autoReply: true, autoReplySince: ts(NOW - 5 * H), monthlyCapEur: 15, dailyCapEur: 2, ...extra }); };
const conv = async () => (await db.doc('conversations/' + PH).get()).data();
const deps = (m, w, p) => ({ db, wa: w, model: m, owners: OWNERS, push: p, welcomeTemplate: TEMPLATE });
let seq = 0;
const says = async (body, atMs) => { await store.storeInbound(db, { wamid: 'wamid.IN' + (++seq), from: PH, type: 'text', body, name: 'Aoife Kavanagh', createdAt: new Date(atMs) }); return atMs; };
// a chat the receptionist is on for, with one customer message at atMs
async function arm({ atMs = NOW - 60 * SEC, text = 'Hi, I am looking for a new kitchen', rec = {}, offered = false } = {}) {
  await db.recursiveDelete(db.doc('conversations/' + PH));
  await db.doc('contacts/' + PH).set({ phone: PH, name: 'Aoife Kavanagh', projectType: 'Kitchen', location: 'Swords', source: 'Meta Ads', createdAt: ts(LEAD_AT), metaLead: { leadId: '1', receivedAt: ts(LEAD_AT) } });
  await db.doc('conversations/' + PH).set({ phone: PH, name: 'Aoife Kavanagh', inboxStatus: 'inbox', createdAt: ts(LEAD_AT), updatedAt: ts(LEAD_AT), unreadCount: 0, ...(offered ? { consult: { stage: 'offered_visit', asks: 0, offered: true } } : {}) });
  await store.storeOutbound(db, PH, { wamid: 'wamid.WELCOME', type: 'template', body: `[template: ${TEMPLATE}] Hi Aoife...` }); await db.doc(`conversations/${PH}/messages/wamid.WELCOME`).update({ createdAt: ts(LEAD_AT + 2000) });
  if (offered) { await store.storeOutbound(db, PH, { wamid: 'wamid.OFFER', type: 'text', body: L.visit_offer, extra: { auto: true } }); await db.doc(`conversations/${PH}/messages/wamid.OFFER`).update({ createdAt: ts(atMs - 30 * SEC) }); }
  await says(text, atMs);
  await db.doc('conversations/' + PH).update({ receptionist: { on: true, auto: true, at: ts(LEAD_AT), by: 'auto', paused: null, handledMs: 0, count: 0, day: null, ...rec } });
  return atMs;
}
const run = (m, w, p, nowMs = NOW) => REC.processChat(deps(m, w, p), PH, nowMs);
const claims = async () => (await db.collection(`conversations/${PH}/sendRequests`).get()).docs.map((d) => ({ id: d.id, ...d.data() }));

beforeEach(async () => { await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' }); await on(); seq = 0; });

// ====================== "Are you an AI?" ======================
test('ARE YOU AN AI: a question put to us gets the honest line; words that only belong to kitchens never do', () => {
  const yes = ['Are you a bot?', 'are you a robot', 'Is this automated?', 'Am I talking to a real person?', 'am i talking to a robot', 'Are you human', 'Are you an AI?', 'is this a bot', 'u a bot?', 'Are you a real person', 'Is this a person or a machine?'.replace('Is this a person or a machine?', 'are you a machine'), 'Are you actually a person?', 'Are you ChatGPT?'];
  const no = ['Do you have an automatic opening bin?', 'Are the drawers automatic?', 'Is the dishwasher machine included?', 'Can I see the computer design?', 'Is a machine used to cut the doors?', 'Do you fit a coffee machine and a tumble dryer?', 'Can you do automatic lighting?', 'is it an automatic oven you fit?',
    'Do you supply washing machines?', 'Do you do the electric and plumbing?', 'Who is doing the fitting?', 'Is there a human height option for the worktop?', 'Do you use AI for the design?', 'Are the units made by a person or by machine?', 'Is the bot-tom drawer soft close?', 'Hi', 'Thanks'];
  for (const q of yes) assert.equal(SCH.asksIfAi(q), true, 'should be an AI question: ' + q);
  for (const q of no) assert.equal(SCH.asksIfAi(q), false, 'should NOT be an AI question: ' + q);
  // the plan: the customer's own words decide, not a model reason that merely mentions a topic
  const D = (o) => ({ reply: '', intent: 'asking_info', visit: 'none', hasQuestion: true, change: 'none', ack: 'none', special: 'none', answerState: 'answered', links: [], topics: [], schedule: { preference: null, opener: '' }, handover: { needed: false, reason: null }, ...o });
  const P = (o, said) => SCH.plan({ decision: D(o), consult: null, messages: [{ direction: 'out', type: 'template', body: '[t]' }, { direction: 'in', type: 'text', body: said }], booked: false, nowMs: NOW, natural: true, kn: null });
  assert.equal(P({}, 'Do you have an automatic opening bin?').step, 'none', 'a kitchen question is not an AI question');
  assert.equal(P({ handover: { needed: true, reason: 'asks about automated bin opening' } }, 'Do you have an automatic opening bin?').step, 'none', 'a handover reason that mentions "automated" is not an AI question either');
  assert.equal(P({ handover: { needed: true, reason: 'asked if AI' } }, 'who are you?').step, 'asked_ai', 'the model\'s own label still works');
  assert.equal(P({ special: 'asked_if_ai' }, 'hello?').step, 'asked_ai');
  assert.equal(P({ handover: { needed: true, reason: 'customer asks whether this is a bot' } }, 'hmm').step, 'asked_ai');
  assert.equal(P({}, 'Are you a bot?').step, 'asked_ai', 'whatever the model labelled it');
});

// ====================== priority: who the customer IS comes before their booking ======================
test('PRIORITY (finding 7): asked-if-AI, then a complaint, then a person / language / area / declined job, then a booking change, then the rest', async () => {
  const K = KN.compile(KN.clean(SEED), 1), kn = { lines: K.lines, check: (x) => KN.checkAnswer(x, K), linksText: () => '' };
  const D = (o) => ({ reply: '', intent: 'other', visit: 'none', hasQuestion: false, change: 'none', ack: 'none', special: 'none', answerState: 'answered', links: [], topics: [], schedule: { preference: null, opener: '' }, handover: { needed: false, reason: null }, ...o });
  const P = (o, ctx = {}) => SCH.plan({ decision: D(o), consult: null, messages: [{ direction: 'out', type: 'text', body: 'x' }, { direction: 'in', type: 'text', body: 'my message' }], booked: true, nowMs: NOW, natural: true, kn, ...ctx });
  for (const change of ['cancel', 'move', 'move_specific', 'confirm', 'late']) {
    const c = P({ intent: 'complaint', change, handover: { needed: true, reason: 'upset' } }); assert.equal(c.step, 'complaint', 'complaint beats a booking change: ' + change); assert.equal(c.reply, L.complaint); assert.equal(c.handover.needed, true);
    for (const [special, step] of [['wants_person', 'human'], ['other_language', 'other_language'], ['outside_area', 'outside_area'], ['declined_job', 'declined_job']]) {
      const p = P({ special, change }); assert.equal(p.step, step, special + ' beats a booking change: ' + change); assert.equal(p.reply, K.lines[step]); assert.equal(p.handover.needed, true);
    }
  }
  // asked-if-AI still comes first of all
  assert.equal(P({ intent: 'complaint', special: 'asked_if_ai', change: 'cancel' }).step, 'asked_ai');
  // and a plain booking change with nothing else is unchanged
  assert.equal(P({ change: 'cancel' }).step, 'cancel_ask'); assert.equal(P({ change: 'move' }).step, 'change_ask'); assert.equal(P({ change: 'confirm' }).step, 'booking_confirm'); assert.equal(P({ change: 'late' }).step, 'late');
  // without published knowledge a complaint still gets the one line (it never needed knowledge), and a staff draft is untouched
  assert.equal(SCH.plan({ decision: D({ intent: 'complaint', change: 'cancel', handover: { needed: true, reason: 'upset' } }), consult: null, messages: [], booked: true, nowMs: NOW, natural: true, kn: null }).step, 'complaint');
  assert.equal(SCH.plan({ decision: D({ intent: 'complaint', change: 'cancel', handover: { needed: true, reason: 'upset' } }), consult: null, messages: [], booked: true, nowMs: NOW, natural: false, kn: null }).step, 'cancel_ask', 'the staff flow is a draft a person reads: unchanged');
});

// ====================== send time: switches, quiet hours, window, daily limit ======================
test('SEND TIME (finding 3): a switch turned off while the answer is being written stops it; nothing is claimed or sent; the customer is answered later when it is on again', async () => {
  for (const [patch, why] of [[{ autoReply: false }, 'the master switch'], [{ enabled: false }, 'the AI switch'], [{ customerDataApproved: false }, 'real customer data'], [{ replyAssistant: false }, 'reply suggestions']]) {
    await on(); await db.recursiveDelete(db.collection('aiDrafts')); await db.recursiveDelete(db.collection('aiRate')); await arm(); const w = waFake(), p = pushFake(), m = model(decision({ reply: 'x' }), async () => { await db.doc('aiSettings/current').update(patch); });
    assert.equal(await run(m, w, p), 'off', why); assert.equal(w.sent.length, 0, why + ': nothing sent'); assert.equal((await claims()).length, 0, why + ': nothing claimed');
    const c = (await conv()).receptionist; assert.deepEqual([c.paused, c.handledMs, c.count], [null, 0, 0], why + ': not paused, not marked answered');
    assert.equal(p.events.length, 0);
    const drafts = (await db.collection('aiDrafts').get()).docs.map((d) => d.data()); assert.ok(drafts.length === 1 && drafts[0].outcome === 'discarded', why + ': the draft is not used');
    await on(); assert.equal(await run(model(decision()), w, p), 'sent:offer_visit', why + ': answered once it is on again'); assert.equal(w.sent.length, 1);
  }
  // a chat the OWNER switched on himself is not stopped by the master switch (that is for automatic chats)
  await on(); await arm({ rec: { auto: false } }); const w2 = waFake(); assert.equal(await run(model(decision(), async () => { await db.doc('aiSettings/current').update({ autoReply: false }); }), w2, pushFake()), 'sent:offer_visit'); assert.equal(w2.sent.length, 1);
});

test('SEND TIME (finding 3): a run that starts before midnight but is ready after it does not send; the 07:00 check answers it', async () => {
  const before = Date.UTC(2026, 9, 15, 22, 59, 59, 0);                       // 23:59:59 in Ireland (summer time)
  await arm({ atMs: before - 60 * SEC }); const w = waFake(), p = pushFake();
  assert.equal(await run(model(decision(), () => sleep(1500)), w, p, before), 'quiet'); assert.equal(w.sent.length, 0); assert.equal((await claims()).length, 0);
  assert.equal((await conv()).receptionist.handledMs, 0, 'still unanswered');
  const morning = Date.UTC(2026, 9, 16, 6, 30); assert.equal(await run(model(decision()), w, p, morning), 'sent:offer_visit'); assert.equal(w.sent.length, 1, 'answered once after 07:00');
});

test('SEND TIME (finding 3): the 24-hour window that closes while the answer is written means nothing is sent', async () => {
  const t = NOW; await arm({ atMs: t - 24 * H + 800, rec: { at: ts(t - 30 * H) } }); const w = waFake();
  assert.equal(await run(model(decision(), () => sleep(1500)), w, pushFake(), t), 'window_closed'); assert.equal(w.sent.length, 0); assert.equal((await claims()).length, 0);
});

test('SEND TIME (finding 3): the daily limit is looked at again at the moment of sending', async () => {
  await arm(); const w = waFake(); const m = model(decision(), async () => { await db.doc('conversations/' + PH).update({ 'receptionist.day': ai.dayId(NOW), 'receptionist.count': 6 }); });
  assert.equal(await run(m, w, pushFake()), 'daily_limit'); assert.equal(w.sent.length, 0);
});

test('A CLAIM WITH A GUARD: the guard runs inside the claim\'s transaction; a refusal claims nothing; a pass records what must still happen after the send', async () => {
  await arm(); let sawTx = false;
  await assert.rejects(outbound.begin(db, PH, 'auto_1', NOW, { guard: async (tx, snap) => { sawTx = !!tx && snap.exists; return 'quiet'; }, effects: { x: 1 } }), (e) => e.details && e.details.reason === 'guard' && e.details.why === 'quiet');
  assert.equal(sawTx, true); assert.equal((await claims()).length, 0, 'nothing claimed');
  assert.deepEqual(await outbound.begin(db, PH, 'auto_1', NOW, { guard: async () => null, effects: { x: 1 } }), { go: true });
  assert.deepEqual([(await outbound.peek(db, PH, 'auto_1')).state, (await outbound.peek(db, PH, 'auto_1')).effects, (await outbound.peek(db, PH, 'auto_1')).effectsDone], ['sending', { x: 1 }, false]);
  await outbound.settle(db, PH, 'auto_1', { state: 'sent' }); assert.deepEqual(await outbound.begin(db, PH, 'auto_1', NOW, { guard: async () => 'should not run' }), { done: true, effects: { x: 1 }, effectsDone: false }, 'already sent: the guard is not asked, the effects are handed back');
});

// ====================== a person writing ======================
test('A PERSON WRITING (finding 2): recorded before WhatsApp is contacted, so it holds however many customer messages follow, and while their message is still being sent', async () => {
  // (a) the person's message is not in the window of the 12 newest: 15 more customer messages came in. Nothing was even stored for the person's message.
  await arm({ atMs: NOW - 120 * SEC }); await outbound.noteHuman(db, PH, LEAD_AT + 10 * 60 * SEC);
  for (let i = 0; i < 15; i++) await says('photo ' + i, NOW - 100 * SEC + i * 1000);
  const w = waFake(), p = pushFake(), m = model(decision());
  assert.equal(await run(m, w, p), 'staff_replied'); assert.equal(m.calls, 0, 'no model call'); assert.equal(w.sent.length, 0); assert.equal((await conv()).receptionist.paused, 'a person replied');
  // the event path agrees
  await arm({ atMs: NOW - 120 * SEC }); await outbound.noteHuman(db, PH, LEAD_AT + 10 * 60 * SEC);
  assert.equal(await REC.onInbound(deps(model(), w, p), PH, NOW - 120 * SEC, { sleep: async () => {}, now: () => NOW }), 'not_ours');
  // (b) a person presses Send while the receptionist's answer is being written: the staff claim is in progress, nothing of it is stored yet
  await arm(); const w2 = waFake();
  assert.equal(await run(model(decision(), async () => { await db.doc(`conversations/${PH}/sendRequests/staff-req-0001`).set({ state: 'sending', claimedAt: ts(NOW) }); }), w2, p), 'staff_replied'); assert.equal(w2.sent.length, 0, 'not talked over');
  // an old, stuck staff claim (over 3 minutes) is not a person writing now
  await arm(); const w3 = waFake();
  assert.equal(await run(model(decision(), async () => { await db.doc(`conversations/${PH}/sendRequests/staff-req-0002`).set({ state: 'sending', claimedAt: ts(NOW - 10 * 60 * SEC) }); }), w3, p), 'sent:offer_visit');
  // (c) the note is written WHILE the answer is being written
  await arm(); const w4 = waFake();
  assert.equal(await run(model(decision(), async () => { await outbound.noteHuman(db, PH, NOW + 1); }), w4, p), 'staff_replied'); assert.equal(w4.sent.length, 0);
  // a Reopen in progress counts too
  await arm(); const w5 = waFake();
  assert.equal(await run(model(decision(), async () => { await db.doc('conversations/' + PH).update({ reopen: { state: 'sending', claimedAt: ts(NOW) } }); }), w5, p), 'staff_replied');
  // switching the receptionist on again for this chat starts afresh
  await ai.setReceptionist({ db, owners: OWNERS }, owner, { phone: PH, on: true }, { nowMs: NOW + 1000 });
  assert.equal((await conv()).receptionist.humanAt, undefined, 'a fresh start forgets the old note');
});

test('A PERSON WRITING (finding 2): the staff send paths record the person BEFORE WhatsApp is contacted', async () => {
  await arm({ atMs: NOW - 5 * 60 * SEC });
  // the real sendReply: the note is on the chat once it has run
  const cfg = { phoneId: '111', token: 'tok', allowedEmails: 'thomas@example.com', template: TEMPLATE, lang: 'en', version: 'v21.0' }, staff = { uid: 'u1', token: { email: 'thomas@example.com', email_verified: true, staff: true } };
  const seen = []; const wa = { async sendText(to, body) { seen.push((await conv()).receptionist.humanAt); return 'wamid.STAFF1'; } };
  await db.doc('conversations/' + PH).update({ lastInboundAt: Timestamp.now() });
  await h.sendReply(staff, { phone: PH, body: 'Hi Aoife, Thomas here', requestId: 'req-sendreply-1' }, { db, cfg, wa });
  assert.equal(seen.length, 1); assert.ok(seen[0] && seen[0].toMillis() > 0, 'the note was already on the chat when WhatsApp was asked to send');
  assert.equal(await run(model(), waFake(), pushFake()), 'staff_replied');
  // the source order for the other paths: the note comes before the first call to WhatsApp
  const src = (f) => fs.readFileSync(path.join(__dirname, '../lib', f), 'utf8');
  const hs = src('handlers.js'); assert.ok(hs.indexOf('noteHuman', hs.indexOf('async function sendMedia')) < hs.indexOf('wa.uploadMedia(buf'), 'sendMedia');
  const qc = src('quoteChannels.js'); assert.ok(qc.indexOf("noteHuman(db, ctx.phone)") < qc.indexOf('wa.sendTemplateWithDocument(ctx.phone'), 'quote sends');
  const ro = src('reopen.js'); assert.ok(ro.indexOf('noteHuman(db, phone)') < ro.indexOf('wa.sendTemplateByName(phone'), 'Reopen');
});

test('DEPLOYMENT: the functions through which a person writes have their own stage, and it touches nothing else', () => {
  const sh = fs.readFileSync(path.join(__dirname, '../../scripts/deploy-quote-sending.sh'), 'utf8').replace(/\r\n/g, '\n'), idx = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  const list = /^STAFFSEND_FUNCS="([^"]*)"/m.exec(sh); assert.ok(list); const fns = list[1].trim().split(/\s+/);
  assert.deepEqual([...fns].sort(), ['deliverQuote', 'quoteChannels', 'reopenConversation', 'retryQuoteDelivery', 'sendMedia', 'sendReply']);
  for (const f of fns) assert.match(idx, new RegExp('^exports\\.' + f + '\\s*=\\s*onCall\\b', 'm'), f + ' is a callable in functions/index.js');
  const i = sh.indexOf('\n  staffsend)\n'); assert.ok(i >= 0); const stage = sh.slice(i, sh.indexOf('\n    ;;', i));
  assert.match(stage, /deploy_functions \$STAFFSEND_FUNCS/); assert.match(stage, /check_routing \$STAFFSEND_FUNCS/); assert.equal(/leadIntake|claimAccess|webhook|add-iam-policy-binding|access-compat/.test(stage.replace(/The Meta lead intake, the sign-in check and the webhook are NOT touched\./, '')), false, 'nothing else is deployed or made public');
  assert.ok(stage.indexOf('check_settings') < stage.indexOf('confirm "') && stage.indexOf('confirm "') < stage.indexOf('deploy_functions'), 'checks, then the question, then the deploy');
});

// ====================== after the send ======================
test('AFTER THE SEND (finding 4): if the run dies after WhatsApp accepted the message, the next run finishes the job; nothing is sent twice and the owner is told', async () => {
  const pref = { status: 'available', weeks: 'next', days: ['tuesday'], text: 'Tuesday works' };
  await arm({ text: 'Tuesday works for me', offered: true });
  const d = decision({ visit: 'agreed', intent: 'scheduling', schedule: { preference: pref, opener: '' } });
  const real = ai.draftOutcome; let broken = true; ai.draftOutcome = async (...a) => { if (broken && a[2] && a[2].outcome === 'used_unchanged') throw new Error('database hiccup'); return real(...a); };
  try {
    const w = waFake(), p = pushFake(), m = model(d);
    assert.equal(await run(m, w, p), 'error', 'the run died after the send'); assert.equal(w.sent.length, 1, 'the customer got the message'); assert.equal(w.sent[0], L.acknowledge);
    let c = await conv(); assert.equal(c.consult.needsBooking, undefined, 'the request for the owner is not there yet'); assert.equal(c.receptionist.handledMs, 0);
    const cl = (await claims())[0]; assert.deepEqual([cl.state, cl.effectsDone], ['sent', false]);
    broken = false; const calls = m.calls;
    assert.equal(await run(m, w, p, NOW + 5 * 60 * SEC), 'already_sent'); assert.equal(m.calls, calls, 'the model is not asked again'); assert.equal(w.sent.length, 1, 'nothing is sent twice');
    c = await conv(); assert.equal(c.consult.needsBooking, true, 'the request card for the owner exists'); assert.equal(c.consult.preference.days[0], 'tuesday'); assert.equal(c.receptionist.paused, 'consultation passed to you'); assert.ok(c.receptionist.handledMs > 0);
    assert.equal(p.events.length, 1, 'the owner is told, once'); assert.equal((await claims())[0].effectsDone, true);
    assert.equal(await run(m, w, p, NOW + 10 * 60 * SEC), 'paused'); assert.equal(w.sent.length, 1);
  } finally { ai.draftOutcome = real; }
});

test('AFTER THE SEND (finding 4): a push that could not be delivered is tried again by the next run (the same key, never twice), and gives up after three tries', async () => {
  await arm({ text: 'My kitchen door fell off, this is terrible' });
  const d = decision({ intent: 'complaint', handover: { needed: true, reason: 'upset' } });
  const w = waFake(), p = pushFake(1), m = model(d);
  assert.equal(await run(m, w, p), 'error'); assert.equal(w.sent.length, 1); assert.equal(w.sent[0], L.complaint); assert.equal(p.events.length, 0);
  assert.equal(await run(m, w, p, NOW + 5 * 60 * SEC), 'already_sent'); assert.equal(w.sent.length, 1); assert.equal(p.events.length, 1, 'told on the second run'); assert.equal(p.events[0].sourceId, PH + '|' + (NOW - 60 * SEC));
  assert.equal((await conv()).receptionist.paused, 'handover: complaint: upset customer');
  // a push that never works: three tries, then the chat is still finished (paused, answered), not stuck forever
  await arm({ text: 'This is a disgrace' }); const w2 = waFake(), p2 = pushFake(99), m2 = model(d);
  assert.equal(await run(m2, w2, p2), 'error'); assert.equal(await run(m2, w2, p2, NOW + 5 * 60 * SEC), 'error'); assert.equal(await run(m2, w2, p2, NOW + 10 * 60 * SEC), 'already_sent'); assert.equal(w2.sent.length, 1);
  const c = (await conv()).receptionist; assert.ok(c.handledMs > 0 && c.paused, 'finished after three tries'); assert.equal((await claims())[0].effectsDone, true);
});

test('AFTER THE SEND (finding 4): the normal send still records everything, once: the count, the last step, the pause, the push and the finished claim', async () => {
  await arm({ text: 'My kitchen door fell off, this is terrible' });
  const w = waFake(), p = pushFake(); assert.equal(await run(model(decision({ intent: 'complaint', handover: { needed: true, reason: 'upset' } })), w, p), 'sent:complaint');
  const c = (await conv()).receptionist; assert.deepEqual([c.count, c.day, c.last.step, c.handledMs], [1, ai.dayId(NOW), 'complaint', NOW - 60 * SEC]); assert.equal(c.paused, 'handover: complaint: upset customer'); assert.equal(p.events.length, 1);
  const cl = (await claims())[0]; assert.deepEqual([cl.id, cl.state, cl.effectsDone], ['auto_' + (NOW - 60 * SEC), 'sent', true]);
});
