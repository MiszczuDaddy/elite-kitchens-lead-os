// The receptionist's live review of 1 Nov 2026 (5 real conversations): four repairs. (1) A "yes" to the owner's greeting question that itself offers a consultation goes straight to asking about days (it used to be
// asked "Would you like us to call out…?" on top). (2) A business's own automatic away message, sent back within moments of our welcome, is not answered as if a person had written. (3) No "Perfect" in the
// acknowledgement (it sounded like the suggested day, or a question asked, was settled). (4) After 20:00 the automatic acknowledgement says "tomorrow", not "shortly". Real Firestore emulator for the chat tests; the
// model and WhatsApp are fakes. Every name and number is made up.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const ai = require('../lib/ai');
const REC = require('../lib/aiReceptionist');
const SCH = require('../lib/aiSchedule');
const AR = require('../lib/autoReply');
const store = require('../lib/store');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const OWNERS = 'thomas@example.com', TEMPLATE = 'elite_kitchens_new_lead';
const NOW = Date.UTC(2026, 9, 30, 20, 0), ts = (ms) => Timestamp.fromMillis(ms), H = 3600e3, SEC = 1000, USAGE = { input: 3000, output: 200, cacheRead: 0, cacheWrite: 0 };
const TUE = Date.UTC(2026, 9, 13, 10, 0), TUE_EVENING = Date.UTC(2026, 9, 13, 19, 30);            // 11:00 and 20:30 Irish time (summer time)
const STILL = 'Are you looking to arrange a consultation for your new kitchen?';                    // the owner's own greeting question (Knowledge Centre), which already offers a consultation

// ---------------------------------------------------------------- the plan (pure)
const base = { reply: '', intent: 'greeting', visit: 'none', hasQuestion: false, change: 'none', ack: 'hello', schedule: { preference: null, opener: '' }, handover: { needed: false, reason: null } };
const out = (text, type = 'text') => ({ direction: 'out', type, body: text }), inn = (text) => ({ direction: 'in', type: 'text', body: text });
const WELCOME = out('[template: elite_kitchens_new_lead] Hi Oona, thanks for your enquiry. Would you like us to arrange a free home consultation?', 'template');
const plan = (d, messages, over = {}) => SCH.plan({ decision: { ...base, ...d }, consult: null, booked: false, nowMs: TUE, natural: true, messages, who: { first: 'Oona' }, ...over });
const asked = [WELCOME, inn('Hi'), out('Hi Oona, thanks for getting back to us. ' + STILL)];
const callsOut = (t) => /call out and have a look/i.test(t || ''), asksDays = (t) => /any day next week suit you/i.test(t || '');

test('1. A YES TO OUR OWN CONSULTATION QUESTION GOES STRAIGHT TO THE DAYS: "Yep", "Probably yes", "if you can that would be great", "yes please" are agreement; the visit is not offered again on top', () => {
  for (const words of ['Yep', 'Probably yes how else', 'If you can will be great, if it’s too much I can send you the pictures and measurements'.replace('’', "'"), 'yes please', 'That would be great']) {
    const r = plan({}, [...asked, inn(words)], { ownLines: { still_looking: STILL } });
    assert.equal(r.step, 'ask_next_week', words); assert.equal(asksDays(r.reply), true, words); assert.equal(callsOut(r.reply), false, 'no second offer: ' + words);
  }
});

test('1b. ...but only a yes: "no", "hi", "thanks" or "maybe later" are not agreement; with the DEFAULT greeting question (which does not offer a visit) nothing changed: a yes gets the offer, as before', () => {
  for (const words of ['No thanks', 'Hi', 'Not right now', 'Yes but not this week']) {
    const r = plan({}, [...asked, inn(words)], { ownLines: { still_looking: STILL } });
    assert.notEqual(r.step, 'ask_next_week', words);
  }
  const plain = [WELCOME, inn('Hi'), out('Hi Oona, thanks for getting back to us. ' + SCH.LINES.still_looking)];
  const r = plan({}, [...plain, inn('Yep')]); assert.equal(r.step, 'offer_visit'); assert.equal(callsOut(r.reply), true);
  const staff = plan({}, [...asked, inn('Yep')], { ownLines: { still_looking: STILL }, natural: false }); assert.notEqual(staff.step, 'ask_next_week', 'the staff draft flow is untouched');
});

test('3 and 4. NO "PERFECT"; AFTER 20:00 THE AUTOMATIC ACKNOWLEDGEMENT SAYS "TOMORROW"; A STAFF DRAFT IS ALWAYS THE DAYTIME WORDING', () => {
  const sat = { schedule: { preference: SCH.cleanPreference({ status: 'available', days: ['saturday'], text: 'Hope Saturday is fine by you' }), opener: '' }, intent: 'scheduling', visit: 'agreed' };
  const msgs = [WELCOME, inn('Hope Saturday is fine by you')];
  const day = plan(sat, msgs), evening = plan(sat, msgs, { nowMs: TUE_EVENING }), draft = plan(sat, msgs, { nowMs: TUE_EVENING, natural: false });
  assert.equal(day.step, 'acknowledge'); assert.equal(day.reply, "Thanks, I'll pass that on to the team and we'll confirm a time with you shortly.");
  assert.equal(evening.reply, "Thanks, I'll pass that on to the team and we'll confirm a time with you tomorrow.");
  assert.equal(draft.reply, day.reply, 'a draft a person reads keeps the daytime wording');
  for (const r of [day, evening, draft]) assert.doesNotMatch(r.reply, /perfect/i);
  const edge = (h, m = 0) => plan(sat, msgs, { nowMs: Date.UTC(2026, 9, 13, h - 1, m) }).reply;
  assert.match(edge(19, 59), /shortly/); assert.match(edge(20, 0), /tomorrow/); assert.match(edge(23, 30), /tomorrow/); assert.match(edge(7, 30), /shortly/);
});

// ---------------------------------------------------------------- a business's own away message (pure detector)
test('2a. WHAT COUNTS AS A BUSINESS\'S OWN AUTOMATIC MESSAGE: the real one from the live review, and the usual away messages; never a customer\'s own thanks or greeting', () => {
  const sonata = 'Thank you for contacting Sonata Petrule! Please let us know how we can help you. My Number is [phone] If you want visit my face book, https://www.facebook.com/share/abc There you can find prices. Delivery happening on saturdays';
  for (const t of [sonata, 'We are currently away. We will get back to you as soon as possible.', 'Hi! Our business hours are Mon-Fri 9 to 5.', 'We\'re currently away from our phones, we will reply soon', 'This is an automatic reply, we will be in touch', 'Thank you for contacting us, we\'ll get back to you shortly']) assert.equal(AR.looksAutomatic(t), true, t);
  for (const t of ['Hi', 'Yes please', 'Thank you for your message', 'Thanks for getting in touch, I would like a new kitchen', 'Hi, thanks for contacting me back, yes I am interested', 'I work office hours so Saturday suits', 'I\'m currently away until Monday', 'Can you ring outside business hours?', '', null, undefined]) assert.equal(AR.looksAutomatic(t), false, String(t));
});

// ---------------------------------------------------------------- a business's own away message (a real chat)
const decision = (over = {}) => ({ text: '', toolCalls: [{ id: 'd1', name: 'reply_decision', input: { reply: '', intent: 'greeting', visit: 'none', hasQuestion: false, change: 'none', ack: 'hello', special: 'none', schedule: { preference: null, opener: '' }, newFacts: [], handover: { needed: false, reason: null }, ...over } }], stopReason: 'tool_use', usage: USAGE });
const model = () => { const m = { calls: 0, async complete() { m.calls++; return decision(); } }; return m; };
const waFake = () => { const w = { sent: [], async sendText(to, body) { w.sent.push({ to, body }); return 'wamid.AUTO' + w.sent.length; } }; return w; };
const pushFake = () => { const p = { events: [], async notify(ev) { p.events.push(ev); } }; return p; };
const checked = () => db.doc('aiSettings/modelCheck').set(Object.fromEntries(Object.entries(ai.MODELS).map(([k, m]) => [k, { id: m.id, ok: true, name: m.label, lifecycle: 'active', at: ts(NOW) }])));
const on = async () => { await checked(); await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, replyAssistant: true, autoReply: true, autoReplySince: ts(NOW - 5 * H), monthlyCapEur: 15, dailyCapEur: 2 }); };
const deps = (m, w, p) => ({ db, wa: w, model: m, owners: OWNERS, push: p, welcomeTemplate: TEMPLATE });
const PHONE = '353871119001', AUTO = 'Thank you for contacting Sonata Petrule! Please let us know how we can help you. Delivery happening on saturdays, orders need to place till Thursdays. https://example.com/shop';
let seq = 0;
// our welcome at `welcomeAt`, then the customer's first message `gap` ms later
async function chat(body, gap = 1000) {
  const welcomeAt = NOW - 30 * 60 * SEC;
  await db.recursiveDelete(db.doc('conversations/' + PHONE));
  await db.doc('contacts/' + PHONE).set({ phone: PHONE, name: 'Sonata', projectType: 'Kitchen', source: 'Meta Ads', createdAt: ts(welcomeAt - H), metaLead: { leadId: '1', receivedAt: ts(welcomeAt - H) } });
  await db.doc('conversations/' + PHONE).set({ phone: PHONE, name: 'Sonata', inboxStatus: 'inbox', createdAt: ts(welcomeAt - H), updatedAt: ts(welcomeAt - H), unreadCount: 0 });
  await store.storeOutbound(db, PHONE, { wamid: 'wamid.W1', type: 'template', body: `[template: ${TEMPLATE}] Hi Sonata, thanks for your enquiry.` }); await db.doc(`conversations/${PHONE}/messages/wamid.W1`).update({ createdAt: ts(welcomeAt) });
  await store.storeInbound(db, { wamid: 'wamid.IN' + (++seq), from: PHONE, type: 'text', body, name: 'Sonata', createdAt: new Date(welcomeAt + gap) });
  await db.doc('conversations/' + PHONE).update({ receptionist: { on: true, auto: true, at: ts(welcomeAt - H), by: 'auto', paused: null, handledMs: 0, count: 0, day: null } });
}
const rec = async () => (await db.doc('conversations/' + PHONE).get()).data().receptionist;
beforeEach(async () => { await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' }); await on(); seq = 0; });

test('2b. A BUSINESS\'S AWAY MESSAGE ANSWERING OUR WELCOME IS NOT ANSWERED: no AI call, nothing sent, nobody alerted, the chat is not paused; the lead\'s real answer afterwards IS answered', async () => {
  await chat(AUTO);
  const m = model(), w = waFake(), p = pushFake();
  assert.equal(await REC.processChat(deps(m, w, p), PHONE, NOW), 'auto_reply');
  assert.equal(m.calls, 0, 'the AI was not asked'); assert.equal(w.sent.length, 0, 'nothing sent'); assert.equal(p.events.length, 0, 'nobody alerted');
  const r = await rec(); assert.equal(r.paused, null, 'not paused'); assert.equal(r.on, true); assert.ok(r.handledMs > 0, 'marked handled, so it is not looked at again');
  assert.equal(await REC.processChat(deps(m, w, p), PHONE, NOW + 60 * SEC), 'handled', 'the same message is not picked up again');
  await store.storeInbound(db, { wamid: 'wamid.IN' + (++seq), from: PHONE, type: 'text', body: 'Hi, yes I am interested in a kitchen', name: 'Sonata', createdAt: new Date(NOW + 2 * 60 * SEC) });
  assert.notEqual(await REC.processChat(deps(m, w, p), PHONE, NOW + 5 * 60 * SEC), 'auto_reply'); assert.equal(m.calls, 1, 'a real answer is read by the AI as usual');
});

test('2c. NOT FOR A PERSON: a real first reply, even a long one, a later message, or an away-looking message that comes long after our welcome, is answered as usual', async () => {
  for (const [body, gap, label] of [['Hi', 1000, 'a plain hello'], ['Thanks for getting in touch, I would like a new kitchen, can someone call me?', 1000, 'a real thanks'], [AUTO, 20 * 60 * SEC, 'looks automatic but came 20 minutes after our welcome']]) {
    await chat(body, gap);
    const m = model(), w = waFake(), p = pushFake(), out = await REC.processChat(deps(m, w, p), PHONE, NOW);
    assert.notEqual(out, 'auto_reply', label); assert.equal(m.calls, 1, label + ': the AI was asked');
  }
});
