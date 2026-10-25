// The welcome switch (owner's request, 24 Oct 2026): the owner picks which approved WhatsApp welcome a new Meta lead gets (lib/welcome.js). The standard one is unchanged and is always the fallback:
// a new template that WhatsApp refuses outright is replaced by the standard one in the same run, never twice, and an answer we cannot confirm is never followed by a second message. The receptionist
// treats either welcome as ours, reads its words, sends "is this Tomasz?" to a person with the honest line, and does not take a "no" to the welcome's question as "not interested".
// Real Firestore emulator; Meta and the model are fakes. Every name and number is made up.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { createClient } = require('../lib/whatsapp');
const { handleLeadRequest } = require('../lib/leads');
const W = require('../lib/welcome');
const ai = require('../lib/ai');
const REC = require('../lib/aiReceptionist');
const SCH = require('../lib/aiSchedule');
const store = require('../lib/store');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const ts = (ms) => Timestamp.fromMillis(ms);

// ---- the lead intake, with a fake Meta that answers per template name
const KEY = 'test-key-1234567890-abcdefghij', STANDARD = 'elite_kitchens_new_lead', NEW = W.PERSONAL_TEMPLATE;
const cfg = { phoneId: '111', token: 'tok', template: STANDARD, lang: 'en', version: 'v21.0', apiKeys: KEY };
const sends = []; let answer = {};                                                // template name -> 'refuse' | 'unknown' | 'ratelimit'
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const mockFetch = async (url, opts = {}) => {
  const body = JSON.parse(opts.body); sends.push(body);
  const a = answer[body.template && body.template.name];
  if (a === 'refuse') return reply({ error: { code: 132001, message: 'Template name does not exist in the translation' } }, 400);
  if (a === 'unknown') return reply({ error: { code: 2, message: 'Service temporarily unavailable' } }, 503);
  if (a === 'ratelimit') return reply({ error: { code: 130429, message: 'Rate limit hit' } }, 429);
  return reply({ messages: [{ id: 'wamid.W' + sends.length }] });
};
const PHONE = '353891234567';
const lead = (id = '7770001111', phone = PHONE) => ({ leadId: id, formName: 'Test form', field_data: [{ name: 'full_name', values: ['Aoife Byrne'] }, { name: 'phone_number', values: ['+' + phone] }] });
const call = (body = lead()) => handleLeadRequest({ method: 'POST', headers: { authorization: `Bearer ${KEY}` }, rawBody: Buffer.from(JSON.stringify(body)), body }, { db, wa: createClient(cfg, mockFetch), cfg });
const msgs = async () => (await db.collection('conversations').doc(PHONE).collection('messages').get()).docs.map((d) => d.data());
const ledger = async (id = '7770001111') => (await db.doc('leads/' + id).get()).data();
const choose = (welcome) => db.doc('aiSettings/current').set({ welcome }, { merge: true });
const names = () => sends.map((s) => s.template.name);

beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  sends.length = 0; answer = {}; n = 0;
});

test('STANDARD (nothing chosen, or anything unknown): the original welcome, exactly as before', async () => {
  for (const setting of [null, 'standard', 'something else', 7]) {
    await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' }); sends.length = 0;
    if (setting !== null) await choose(setting);
    const r = await call();
    assert.equal(r.status, 200); assert.equal(r.body.status, 'processed'); assert.equal(r.body.welcome, 'sent', String(setting));
    assert.deepEqual(names(), [STANDARD], String(setting));
    assert.equal(sends[0].template.language.code, 'en'); assert.deepEqual(sends[0].template.components, [{ type: 'body', parameters: [{ type: 'text', text: 'Aoife' }] }]);
    const m = await msgs(); assert.equal(m.length, 1);
    assert.equal(m[0].body, '[template: elite_kitchens_new_lead] Hi Aoife, thanks for your enquiry with Elite Kitchens...', 'the chat copy is word for word what it always was');
    assert.equal((await ledger()).welcome.template, 'standard'); assert.equal((await ledger()).welcome.fellBack, undefined);
  }
});

test('NEW chosen: the new template goes out once, with the first name and the same language; the chat copy has its words', async () => {
  await choose('personal');
  const r = await call();
  assert.equal(r.body.welcome, 'sent'); assert.deepEqual(names(), [NEW]);
  assert.equal(sends[0].template.language.code, 'en'); assert.deepEqual(sends[0].template.components, [{ type: 'body', parameters: [{ type: 'text', text: 'Aoife' }] }]);
  const m = await msgs(); assert.equal(m.length, 1); assert.equal(m[0].type, 'template'); assert.equal(m[0].direction, 'out');
  assert.equal(m[0].body, W.bodyOf('personal', STANDARD, 'Aoife')); assert.ok(m[0].body.startsWith('[template: ' + NEW + '] Hi Aoife'), m[0].body);
  assert.equal((await ledger()).welcome.template, 'personal');
  // the same lead again (Make retries): nothing more is sent
  const again = await call(); assert.equal(again.body.status, 'duplicate'); assert.equal(sends.length, 1);
});

test('NEW refused by WhatsApp (not approved yet, paused, wrong language): the standard welcome goes instead, in the same run, once; one welcome in the chat', async () => {
  await choose('personal'); answer[NEW] = 'refuse';
  const r = await call();
  assert.equal(r.status, 200); assert.equal(r.body.welcome, 'sent'); assert.deepEqual(names(), [NEW, STANDARD], 'tried the new one, then the standard one');
  const m = await msgs(); assert.equal(m.length, 1, 'no failed-message record: the customer did get a welcome'); assert.equal(m[0].body, W.bodyOf('standard', STANDARD, 'Aoife'));
  const l = await ledger(); assert.equal(l.welcome.template, 'standard'); assert.equal(l.welcome.fellBack, true); assert.equal(l.state, 'done');
});

test('NEW with no clear answer (WhatsApp 5xx): never a second message; a person is told in the chat', async () => {
  await choose('personal'); answer[NEW] = 'unknown';
  const r = await call();
  assert.equal(r.body.welcome, 'unknown'); assert.deepEqual(names(), [NEW], 'nothing else was sent: it may have gone');
  const m = await msgs(); assert.equal(m.length, 1); assert.equal(m[0].status, 'failed'); assert.ok(m[0].body.startsWith('[template: ' + NEW + ']'), 'the chat names the template that may have gone');
  assert.match(m[0].error, /status unknown/);
});

test('NEW rate-limited (429): Make tries again later and then it goes, once; never the standard one as well', async () => {
  await choose('personal'); answer[NEW] = 'ratelimit';
  const r1 = await call(); assert.equal(r1.status, 503); assert.equal(r1.body.status, 'retry'); assert.deepEqual(names(), [NEW]);
  answer = {};
  const r2 = await call(); assert.equal(r2.body.welcome, 'sent'); assert.deepEqual(names(), [NEW, NEW]);
  const m = await msgs(); assert.equal(m.filter((x) => x.direction === 'out').length, 1); assert.equal(m[0].body, W.bodyOf('personal', STANDARD, 'Aoife'));
});

test('BOTH refused: the customer is saved, the welcome is marked failed and the chat says so (no third try)', async () => {
  await choose('personal'); answer[NEW] = 'refuse'; answer[STANDARD] = 'refuse';
  const r = await call();
  assert.equal(r.status, 200); assert.equal(r.body.welcome, 'failed'); assert.deepEqual(names(), [NEW, STANDARD]);
  const m = await msgs(); assert.equal(m.length, 1); assert.equal(m[0].status, 'failed'); assert.ok(m[0].body.startsWith('[template: ' + STANDARD + ']'));
  assert.ok((await db.doc('contacts/' + PHONE).get()).exists, 'the lead itself is never lost');
});

test('THE SETTING CANNOT BE READ (database hiccup): the standard welcome, never no welcome', async () => {
  const broken = { doc: () => ({ get: async () => { throw new Error('unavailable'); } }) };
  assert.equal(await W.chosen(broken), 'standard');
  assert.equal(await W.chosen({ doc: () => ({ get: async () => ({ exists: false }) }) }), 'standard');
  assert.equal(await W.chosen({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ welcome: 'personal' }) }) }) }), 'personal');
});

test('STANDARD refused when it was the choice: no fallback to the new one (the new one is used only when chosen)', async () => {
  answer[STANDARD] = 'refuse';
  const r = await call(); assert.equal(r.body.welcome, 'failed'); assert.deepEqual(names(), [STANDARD]);
});

// ---- the switch (Assistant > Settings)
const OWNER = 'thomas@example.com';
test('THE SWITCH: owner only, two choices only, shown with both texts; the next lead uses it with no redeploy', async () => {
  const deps = { db, model: null, owners: OWNER };
  let s = await ai.status(deps, { id: OWNER }, {});
  assert.equal(s.welcome.chosen, 'standard', 'standard until the owner chooses'); assert.equal(s.welcome.personalTemplate, NEW);
  assert.ok(s.welcome.texts.standard.startsWith('Hi {{1}}, thanks for your enquiry')); assert.ok(s.welcome.texts.personal.startsWith('Hi {{1}}'));
  await assert.rejects(ai.saveSettings(deps, { id: 'staff@example.com' }, { welcome: 'personal' }), (e) => e.code === 'permission-denied', 'staff who are not the owner cannot change it');
  for (const bad of ['', 'Personal', 'new', null, true, 1, {}]) await assert.rejects(ai.saveSettings(deps, { id: OWNER }, { welcome: bad }), (e) => e.code === 'invalid-argument', JSON.stringify(bad));
  assert.equal((await db.doc('aiSettings/current').get()).exists, false, 'nothing was saved by the refused attempts');
  s = await ai.saveSettings(deps, { id: OWNER }, { welcome: 'personal' });
  assert.equal(s.welcome.chosen, 'personal');
  const log = (await db.collection('auditLog').where('action', '==', 'aiSettings').get()).docs.map((d) => d.data());
  assert.equal(log.length, 1); assert.deepEqual(log[0].values, { welcome: 'personal' }); assert.equal(log[0].by, OWNER);
  const cur = (await db.doc('aiSettings/current').get()).data(); assert.equal(cur.enabled, undefined, 'nothing else changed'); assert.equal(cur.autoReply, undefined);
  await call(); assert.deepEqual(names(), [NEW], 'the very next lead gets the new welcome');
  s = await ai.saveSettings(deps, { id: OWNER }, { welcome: 'standard' }); assert.equal(s.welcome.chosen, 'standard');
  await call(lead('7770002222', '353891234568')); assert.deepEqual(names(), [NEW, STANDARD], 'and back (another customer: the same number gets no second welcome within an hour)');
});

// ---- the receptionist
const NOW = Date.UTC(2026, 9, 13, 10, 0), H = 3600e3, SEC = 1000, LEAD_AT = NOW - 4 * H, PH = '353871110095', L = SCH.LINES;
const USAGE = { input: 3000, output: 200, cacheRead: 0, cacheWrite: 0 };
const decision = (over = {}) => ({ text: '', toolCalls: [{ id: 'd1', name: 'reply_decision', input: { reply: '', intent: 'new_enquiry', visit: 'none', hasQuestion: false, change: 'none', ack: 'thanks', special: 'none', schedule: { preference: null, opener: '' }, newFacts: [], handover: { needed: false, reason: null }, ...over } }], stopReason: 'tool_use', usage: USAGE });
const model = (d = decision()) => { const m = { calls: 0, texts: [], async complete(args) { m.calls++; m.texts.push(args.messages[0].text); return d; } }; return m; };
const waFake = () => { const w = { sent: [], async sendText(to, body) { w.sent.push(body); return 'wamid.AUTO' + w.sent.length; } }; return w; };
const recDeps = (m, w) => ({ db, wa: w, model: m, owners: OWNER, push: { async notify() {} }, welcomeTemplate: STANDARD });
let n = 0;
const inbound = (body, atMs) => store.storeInbound(db, { wamid: 'wamid.IN' + (++n), from: PH, type: 'text', body, name: 'Aoife Kavanagh', createdAt: new Date(atMs) });
async function chat(welcomeBody) {
  await db.doc('aiSettings/modelCheck').set(Object.fromEntries(Object.entries(ai.MODELS).map(([k, x]) => [k, { id: x.id, ok: true, name: x.label, lifecycle: 'active', at: ts(NOW) }])));
  await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, replyAssistant: true, autoReply: true, autoReplySince: ts(NOW - 5 * H), monthlyCapEur: 15, dailyCapEur: 2 });
  await db.doc('contacts/' + PH).set({ phone: PH, name: 'Aoife Kavanagh', projectType: 'Kitchen', location: 'Swords', source: 'Meta Ads', createdAt: ts(LEAD_AT), metaLead: { leadId: '1', receivedAt: ts(LEAD_AT) } });
  await db.doc('conversations/' + PH).set({ phone: PH, name: 'Aoife Kavanagh', inboxStatus: 'inbox', createdAt: ts(LEAD_AT), updatedAt: ts(LEAD_AT), unreadCount: 0, receptionist: { on: true, auto: true, at: ts(LEAD_AT), by: 'auto', paused: null } });
  await store.storeOutbound(db, PH, { wamid: 'wamid.WELCOME', type: 'template', body: welcomeBody }); await db.doc(`conversations/${PH}/messages/wamid.WELCOME`).update({ createdAt: ts(LEAD_AT + 2000) });
}

test('RECEPTIONIST: the new welcome is OUR welcome (not a person taking over), and the AI reads its words; any other template still means a person wrote', async () => {
  const body = W.bodyOf('personal', STANDARD, 'Aoife');
  await chat(body); await inbound('Hi, I am looking for a new kitchen', NOW - 120 * SEC);
  const m = model(), w = waFake();
  assert.equal(await REC.processChat(recDeps(m, w), PH, NOW), 'sent:offer_visit', 'answered as usual');
  const flat = (t) => t.replace(/\s+/g, ' ');                                            // the chat the model reads puts each message on one line
  assert.ok(flat(m.texts[0]).includes(flat(body.replace(/^\[template: [^\]]+\] /, ''))), 'the model read the words of the new welcome, all of them');
  // the standard one, as before
  await db.recursiveDelete(db.doc('conversations/' + PH));
  await chat(W.bodyOf('standard', STANDARD, 'Aoife')); await inbound('Hi, I am looking for a new kitchen', NOW - 120 * SEC);
  assert.equal(await REC.processChat(recDeps(model(), waFake()), PH, NOW), 'sent:offer_visit');
  // a different template sent by a person (Reopen) is a person writing: the receptionist stops, as before
  await db.recursiveDelete(db.doc('conversations/' + PH));
  await chat(body); await inbound('Hi, I am looking for a new kitchen', NOW - 120 * SEC);
  await store.storeOutbound(db, PH, { wamid: 'wamid.REOPEN', type: 'template', body: '[template: elite_kitchens_reopen] Hi Aoife' }); await db.doc(`conversations/${PH}/messages/wamid.REOPEN`).update({ createdAt: ts(NOW - 60 * SEC) });
  assert.equal(await REC.processChat(recDeps(model(), waFake()), PH, NOW), 'staff_replied');
});

const out = (body, type = 'text') => ({ direction: 'out', type, body }), inn = (body) => ({ direction: 'in', type: 'text', body });
const NEW_WELCOME = out(W.bodyOf('personal', STANDARD, 'Aoife'), 'template'), OLD_WELCOME = out(W.bodyOf('standard', STANDARD, 'Aoife'), 'template');
const base = { reply: '', intent: 'new_enquiry', visit: 'none', hasQuestion: false, change: 'none', special: 'none', answerState: null, links: [], topics: [], unknown: '', newFacts: [], schedule: { preference: null, opener: '' }, handover: { needed: false, reason: null } };
const plan = (over, messages) => SCH.plan({ decision: { ...base, ...over }, consult: null, messages, booked: false, nowMs: NOW, natural: true, who: { name: 'Aoife Kavanagh', projectType: 'Kitchen' } });

test('"IS THIS TOMASZ?": the honest line and a person, whatever the model says; a friendly "Thanks Tomasz" is just a message', () => {
  for (const q of ['Is this Tomasz?', 'is that tomasz', 'Are you Tomasz?', 'Am I talking to Tomasz?', 'You\'re Tomasz, right?', 'Hi, who is Tomasz?', 'Is it Tomek?']) for (const welcome of [NEW_WELCOME, OLD_WELCOME]) {
    const p = plan({ intent: 'new_enquiry' }, [welcome, inn(q)]);
    assert.equal(p.step, 'asked_ai', q); assert.equal(p.reply, L.asked_ai); assert.equal(p.handover.needed, true); assert.equal(p.handover.reason, 'asked if this is Tomasz', q);
  }
  assert.equal(plan({}, [NEW_WELCOME, inn('Are you a bot?')]).handover.reason, 'asked if AI', 'the existing question keeps its reason');
  for (const fine of ['Thanks Tomasz', 'Hi Tomasz, yes I have some plans', 'Tomasz was recommended to me', 'thanks tomasz, talk soon']) assert.notEqual(plan({}, [NEW_WELCOME, inn(fine)]).step, 'asked_ai', fine);
});


// ---- the New welcome OFFERS the free home consultation: its first answer is an answer to that offer. Run exactly as the receptionist does it: plan -> analyse -> what is sent (labels test pattern).
const R = require('../lib/aiReply');
const KN = require('../lib/aiKnowledge');
const { SEED } = require('../lib/aiKnowledgeSeed');
const K = KN.compile(KN.clean(SEED), 1);
const knFor = (messages) => { const said = messages.filter((m) => m.direction === 'in').map((m) => m.body).join(' '); return { lines: K.lines, check: (x) => KN.checkAnswer(x, K, { extra: said }), linksText: () => '' }; };
function send(over, messages, { knowledge = false } = {}) {
  const d = { ...base, ...over, wantsConsultation: ['asked', 'agreed'].includes(over.visit), schedule: { preference: null, opener: '', ...(over.schedule || {}) }, handover: { needed: false, reason: null, ...(over.handover || {}) } };
  const p = SCH.plan({ decision: d, consult: null, messages, booked: false, nowMs: NOW, natural: true, kn: knowledge ? knFor(messages) : null, who: { name: 'Aoife Kavanagh', projectType: 'Kitchen' } });
  const decision = p.step === 'none' ? (p.handover ? { ...d, handover: p.handover } : d) : { ...d, reply: p.reply, handover: p.handover || d.handover };
  const sheet = { known: [{ field: 'name', label: 'Name', value: 'Aoife Kavanagh' }], messages, window: { state: 'open' }, consult: null, nextAppointment: null };
  const a = R.analyse(sheet, decision, p, { knowledge });
  return { step: p.step, sent: S_SEND(p, decision, a) ? decision.reply : '', handover: decision.handover };
}
const S_SEND = (p, decision, a) => SCH.SEND_STEPS.has(p.step) && !!decision.reply && !a.warnings.length;
const asksDays = (t) => t.includes(L.ask_next_week);

test('THE NEW WELCOME OFFERS THE CONSULTATION: a yes in the first reply gets the question about days (never the offer again), whatever the model labelled it', () => {
  assert.ok(W.offersVisitBody(NEW_WELCOME.body)); assert.equal(W.offersVisitBody(OLD_WELCOME.body), false);
  for (const yes of ['Yes please', 'yes', 'Yeah that would be great', 'Sure', 'Yes interested', 'definitely']) for (const visit of ['agreed', 'asked', 'none']) for (const intent of ['answering_questions', 'wants_consultation', 'greeting', 'new_enquiry']) for (const knowledge of [false, true]) {
    const r = send({ visit, intent }, [NEW_WELCOME, inn(yes)], { knowledge });
    assert.equal(r.step, 'ask_next_week', `"${yes}" visit:${visit} intent:${intent} knowledge:${knowledge} -> ${r.step}`);
    assert.ok(asksDays(r.sent), `the days question is SENT (no warning blocked it): ${yes}`); assert.ok(!r.sent.includes(L.visit_offer), 'never the offer again');
  }
  // the standard welcome is unchanged: a yes to it is never agreement (the visit is offered first)
  for (const yes of ['Yes please', 'yes']) for (const visit of ['agreed', 'asked']) assert.notEqual(send({ visit, intent: 'answering_questions' }, [OLD_WELCOME, inn(yes)]).step, 'ask_next_week', yes);
});

test('THE NEW WELCOME: a no in the first reply gets the owner\'s "no problem" line (or a person), never the offer or the days; "stop" goes to a person', () => {
  for (const no of ['No thanks', 'No', 'Not right now', 'not yet', 'Maybe later', 'Nah, just looking at prices for now']) for (const visit of ['declined', 'none']) {
    const r = send({ visit, intent: 'answering_questions' }, [NEW_WELCOME, inn(no)], { knowledge: true });
    assert.ok(['declined', 'thinking'].includes(r.step) || /declined|wants to wait/.test((r.handover && r.handover.reason) || ''), `"${no}" visit:${visit} -> ${r.step}`);
    assert.ok(!r.sent.includes(L.visit_offer) && !asksDays(r.sent), no);
  }
  const stop = send({ visit: 'declined', intent: 'answering_questions' }, [NEW_WELCOME, inn('No, stop messaging me')], { knowledge: true });
  assert.equal(stop.sent, ''); assert.match(stop.handover.reason, /stop messaging/);
});

test('THE NEW WELCOME: anything else in the first reply goes on as before (one offer from the receptionist, a price question gets the price line); from the second reply on, nothing is different', () => {
  const r1 = send({ visit: 'none', intent: 'new_enquiry' }, [NEW_WELCOME, inn('Hi, I am looking for a new kitchen, shaker style')]);
  assert.equal(r1.step, 'offer_visit', 'they did not answer the question: the receptionist asks once, in its own words'); assert.ok(r1.sent.includes(L.visit_offer));
  const r2 = send({ visit: 'none', intent: 'asking_price_general' }, [NEW_WELCOME, inn('How much would a kitchen cost roughly?')]);
  assert.ok(r2.sent.startsWith(L.price_general), r2.sent); assert.ok(!asksDays(r2.sent), 'no days before a yes');
  // second reply: the welcome's offer no longer decides anything (a yes to "are you still looking?" is not agreement to a visit)
  const later = [NEW_WELCOME, inn('Hi'), out(L.still_looking), inn('yes')];
  assert.notEqual(send({ visit: 'none', intent: 'greeting' }, later).step, 'ask_next_week');
  // a staff draft (Suggest reply) is untouched by this rule: a person reads it first
  const draft = SCH.plan({ decision: { ...base, visit: 'none', intent: 'greeting' }, consult: null, messages: [NEW_WELCOME, inn('yes')], booked: false, nowMs: NOW, natural: false });
  assert.notEqual(draft.step, 'ask_next_week');
});

test('THE AI IS TOLD what the welcome said: "our welcome message asked whether they would like a free home consultation" (and the old wording for the standard one)', () => {
  const sheet = (welcome) => ({ known: [], lead: [], messages: [{ ...welcome, at: '24 Oct, 10:00' }], consult: null, window: { state: 'open' }, nextAppointment: null, stage: 'inbox', now: 'Sat 24 Oct 10:05' });
  assert.match(R.sheetText(sheet(NEW_WELCOME)), /our welcome message asked whether they would like a free home consultation/);
  assert.match(R.sheetText(sheet(OLD_WELCOME)), /we have NOT offered a home visit yet/);
});

test('RECEPTIONIST (end to end): "Yes please" to the New welcome is answered with the days question, once', async () => {
  await chat(W.bodyOf('personal', STANDARD, 'Aoife')); await inbound('Yes please', NOW - 120 * SEC);
  const w = waFake();
  assert.equal(await REC.processChat(recDeps(model(decision({ intent: 'answering_questions', visit: 'agreed', ack: 'thanks' })), w), PH, NOW), 'sent:ask_next_week');
  assert.equal(w.sent.length, 1); assert.ok(w.sent[0].includes(L.ask_next_week), w.sent[0]);
});
