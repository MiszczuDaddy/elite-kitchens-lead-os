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
  assert.ok(m.texts[0].includes(body.replace(/^\[template: [^\]]+\] /, '')), 'the model read the words of the new welcome');
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

test('A "NO" TO THE NEW WELCOME\'S QUESTION is not "not interested": no "if you change your mind" line; clear words still count as a no; the standard welcome is unchanged', () => {
  const declinedLine = (p) => p.step === 'declined' || p.step === 'thinking' || /declined|wants to wait/.test((p.handover && p.handover.reason) || '');
  for (const no of ['No', 'No not yet', 'not yet', 'No I dont have any', 'nope, nothing yet', 'Not at the moment', 'I\'ll get back to you with them']) {
    assert.equal(declinedLine(plan({ visit: 'declined' }, [NEW_WELCOME, inn(no)])), false, no);
  }
  for (const clear of ['No thanks, not interested', 'Found someone else', 'I filled it in by mistake', 'Stop messaging me', 'no longer looking', 'I don\'t want a new kitchen']) {
    assert.equal(declinedLine(plan({ visit: 'declined' }, [NEW_WELCOME, inn(clear)])) || /stop/i.test((plan({ visit: 'declined' }, [NEW_WELCOME, inn(clear)]).handover || {}).reason || ''), true, clear);
  }
  assert.equal(declinedLine(plan({ visit: 'declined' }, [OLD_WELCOME, inn('No not yet')])), true, 'the standard welcome behaves exactly as before');
  // only the FIRST answer to the welcome: after we wrote something else, a no is a no again
  assert.equal(declinedLine(plan({ visit: 'declined' }, [NEW_WELCOME, inn('I want a new kitchen'), out(L.visit_offer), inn('No not yet')])), true, 'a no to our offer of a visit');
});
