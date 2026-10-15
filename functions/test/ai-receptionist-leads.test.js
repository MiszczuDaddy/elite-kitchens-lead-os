// Phase 9 R3: the automatic receptionist handling NEW META LEADS end to end (docs/AI.md), the scenarios the owner asked to see before deployment.
// Real Firestore emulator; the "model" and "WhatsApp" are fakes; every name and message is made up. The journey: the Meta form is filled in, Make sends the approved welcome template (leadIntake),
// the customer replies, and the receptionist takes it from there without anybody switching anything on for that chat.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const ai = require('../lib/ai');
const REC = require('../lib/aiReceptionist');
const SCH = require('../lib/aiSchedule');
const store = require('../lib/store');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const OWNERS = 'thomas@example.com', owner = { kind: 'staff', id: 'thomas@example.com' };
const NOW = Date.UTC(2026, 9, 13, 10, 0), ts = (ms) => Timestamp.fromMillis(ms), H = 3600e3;      // 11:00 in Ireland
const SINCE = NOW - 5 * H, LEAD_AT = NOW - 4 * H, TEMPLATE = 'elite_kitchens_new_lead';
const PH = '353871110041', PH2 = '353871110042', PH3 = '353871110043', USAGE = { input: 3000, output: 200, cacheRead: 0, cacheWrite: 0 };
const LEAD_NOTES = 'Meta lead · Kitchen enquiry · 13 Oct 2026\nLead ID: 123456789\nRequirements: Shaker kitchen with island\nOther answers:\n• Eircode / postcode: K67 X123\n• Estimated budget: 15-20k';

function fake(script) { const m = { calls: [], async complete() { m.calls.push(1); const s = script[Math.min(m.calls.length - 1, script.length - 1)]; return { text: '', toolCalls: [], stopReason: 'end_turn', usage: USAGE, ...s }; } }; return m; }
const decision = (over = {}) => ({ toolCalls: [{ id: 'd1', name: 'reply_decision', input: { reply: '', intent: 'new_enquiry', wantsConsultation: false, schedule: { preference: null, opener: '' }, newFacts: [], handover: { needed: false, reason: null }, ...over } }], stopReason: 'tool_use' });
const PREF = { preference: { weeks: 'next', days: ['tuesday'], times: 'afternoons', text: 'Tuesday afternoon' }, opener: '' };
const waFake = () => { const w = { sent: [], async sendText(to, body) { w.sent.push({ to, body }); return 'wamid.AUTO' + w.sent.length; } }; return w; };
const pushFake = () => { const p = { events: [], async notify(ev) { p.events.push(ev); } }; return p; };
const checked = () => db.doc('aiSettings/modelCheck').set(Object.fromEntries(Object.entries(ai.MODELS).map(([k, m]) => [k, { id: m.id, ok: true, name: m.label, lifecycle: 'active', at: ts(NOW) }])));
const on = async (extra = {}) => { await checked(); await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, replyAssistant: true, autoReply: true, autoReplySince: ts(SINCE), monthlyCapEur: 15, dailyCapEur: 2, ...extra }); };
const deps = (model, wa, push) => ({ db, wa, model, owners: OWNERS, push, welcomeTemplate: TEMPLATE });
const conv = async (phone = PH) => (await db.doc('conversations/' + phone).get()).data();
const msgs = async (phone = PH) => (await db.collection(`conversations/${phone}/messages`).get()).docs.map((d) => d.data());
const apptCount = async () => (await db.collection('appointments').get()).size;

// A Meta lead as the lead intake leaves it: contact with the form answers and metaLead, a conversation created at that moment, and our approved welcome template.
async function newLead(phone, { receivedAt = LEAD_AT, convCreatedAt = receivedAt, meta = true, welcome = true } = {}) {
  await db.recursiveDelete(db.doc('conversations/' + phone));
  await db.doc('contacts/' + phone).set({ phone, name: 'Aoife Kavanagh', projectType: 'Kitchen', location: 'Swords', budget: '15-20k', notes: meta ? LEAD_NOTES : null, source: meta ? 'Meta Ads' : null, createdAt: ts(convCreatedAt), ...(meta ? { metaLead: { leadId: '123456789', receivedAt: ts(receivedAt) } } : {}) });
  await db.doc('conversations/' + phone).set({ phone, name: 'Aoife Kavanagh', inboxStatus: 'inbox', createdAt: ts(convCreatedAt), updatedAt: ts(convCreatedAt), unreadCount: 0 });
  if (welcome) await store.storeOutbound(db, phone, { wamid: 'wamid.WELCOME' + phone, type: 'template', body: `[template: ${TEMPLATE}] Hi Aoife, thanks for your enquiry with Elite Kitchens...` });
  await db.collection(`conversations/${phone}/messages`).doc('wamid.WELCOME' + phone).update({ createdAt: ts(receivedAt + 2000) }).catch(() => {});
}
// The customer writes (through the same inbox code the WhatsApp webhook uses, so duplicates are handled the real way).
const says = (phone, body, at, wamid = 'wamid.IN' + at + phone) => store.storeInbound(db, { wamid, from: phone, type: 'text', body, name: 'Aoife Kavanagh', createdAt: new Date(at) });

beforeEach(async () => { await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' }); await on(); });

// what a message DOES (independent of its exact words)
const asksDays = (t) => /\?/.test(t || '') && /\b(any day|which day|what day|day.{0,12}suit|week.{0,15}suit|suit you.{0,40}(week|day)|what time|when (would|are you|suits)|days or times)\b/i.test(t || '');
const offersVisit = (t) => /call out and have a look|stop by and have a look|have a look at your space/i.test(t || '');

test('JOURNEY: a new Meta lead replies to the welcome template; nobody switches anything on; it answers what they said and OFFERS a visit once; it asks about days only after they say yes; it collects the preference and hands over with a push; nothing is booked', async () => {
  await newLead(PH); const w = waFake(), p = pushFake(), a0 = await apptCount();
  await says(PH, 'Hi, yes I am interested, I want a new kitchen', NOW - 120e3);
  const m1 = fake([decision({ intent: 'new_enquiry', reply: 'Thanks for getting back to us, Aoife.' })]);
  const r1 = await REC.sweep(deps(m1, w, p), NOW); assert.equal(r1.activated, 1, 'switched on by itself because it is a new Meta lead'); assert.equal(r1['sent:offer_visit'], 1);
  assert.deepEqual(w.sent, [{ to: PH, body: 'Thanks for getting back to us, Aoife. ' + SCH.LINES.visit_offer }], 'what they said is acknowledged, then the visit is OFFERED');
  assert.equal(asksDays(w.sent[0].body), false, 'interest is not agreement: no question about days'); assert.equal(offersVisit(w.sent[0].body), true); assert.equal(p.events.length, 0, 'an offer needs nobody');
  assert.doesNotMatch(w.sent[0].body, /eircode|postcode|what kind|budget|project/i, 'nothing the lead form already answered is asked again');
  assert.deepEqual((await conv()).consult, { stage: 'offered_visit', offered: true });
  // they say yes: now, and only now, the question about days
  await says(PH, 'Yes please, that would be great', NOW + 600e3);
  const m2 = fake([decision({ intent: 'answering_questions', visit: 'agreed' })]); const r2 = await REC.sweep(deps(m2, w, p), NOW + 780e3);
  assert.equal(r2['sent:ask_next_week'], 1); assert.equal(asksDays(w.sent[1].body), true); assert.equal(offersVisit(w.sent[1].body), false, 'the offer is not repeated'); assert.deepEqual((await conv()).consult, { stage: 'asked_next_week', asks: 1, offered: true });
  // they give a day
  await says(PH, 'Tuesday afternoon would suit me', NOW + 1500e3);
  const m3 = fake([decision({ intent: 'scheduling', visit: 'agreed', schedule: PREF })]), r3 = await REC.sweep(deps(m3, w, p), NOW + 1680e3);
  assert.equal(r3['sent:acknowledge'], 1); assert.equal(w.sent[2].body, SCH.LINES.acknowledge);
  const c = await conv(); assert.deepEqual([c.consult.stage, c.consult.needsBooking, c.consult.preference.firstDate, c.receptionist.paused], ['preference_given', true, '2026-10-20', 'consultation passed to you']);
  assert.deepEqual(p.events.map((e) => [e.kind, e.phone]), [['handover', PH]], 'the owner gets a push');
  // and it stays out from here
  await says(PH, 'Thanks, what time will that be?', NOW + 2400e3); const r4 = await REC.sweep(deps(m3, w, p), NOW + 2600e3); assert.equal(r4.paused, 1); assert.equal(w.sent.length, 3); assert.equal(await apptCount(), a0, 'nothing was booked');
});

test('ORDINARY MESSAGES: an enquiry is answered and a visit offered; "hello" or confusion gets a friendly reply and NO offer; a model sentence with a question, money, a promise or a day in it is dropped; nobody is asked about days', async () => {
  await newLead(PH); await says(PH, 'Hi, looking for a shaker style kitchen with an island', NOW - 120e3); const w = waFake();
  await REC.sweep(deps(fake([decision({ intent: 'answering_questions', reply: 'Lovely, a shaker kitchen with an island sounds great.' })]), w, pushFake()), NOW);
  assert.equal(w.sent[0].body, 'Lovely, a shaker kitchen with an island sounds great. ' + SCH.LINES.visit_offer);
  await newLead(PH2); await says(PH2, 'Hello', NOW - 120e3); const w2 = waFake(), p2 = pushFake();
  const r2 = await REC.sweep(deps(fake([decision({ intent: 'greeting', reply: 'Hi Aoife, thanks for getting back to us.' })]), w2, p2), NOW); assert.equal(r2['sent:ack_only'], 1);
  assert.deepEqual(w2.sent.map((x) => x.body), ['Hi Aoife, thanks for getting back to us.']); assert.equal(offersVisit(w2.sent[0].body) || asksDays(w2.sent[0].body), false, '"hello" is not agreement and not an invitation to pitch'); assert.equal((await conv(PH2)).receptionist.paused, null, 'still the receptionist\'s chat');
  await newLead(PH3); await says(PH3, 'Looking at a new kitchen', NOW - 120e3); const w3 = waFake();
  await REC.sweep(deps(fake([decision({ intent: 'new_enquiry', reply: 'Is that a good time? We can do it for 5000 euro, see you tomorrow!' })]), w3, pushFake()), NOW);
  assert.equal(w3.sent[0].body, SCH.LINES.visit_offer, 'the unsafe sentence is dropped: only the fixed offer goes out');
  for (const bad of ['Is that right?', 'It will cost 5000.', 'We can come tomorrow.', 'Tuesday works for us.', 'Hi, I am a bot.', 'See www.example.com for ideas.', 'Booked for you.', 'Free quote for you.']) assert.equal(SCH.acknowledgement(bad), '', bad);
  assert.equal(SCH.acknowledgement('Thanks for the details, Aoife.'), 'Thanks for the details, Aoife.'); assert.equal(SCH.acknowledgement('x'.repeat(120)), '');
});

test('NEVER INVENTED: prices, availability, delivery or fitting dates, photos, a complaint, or "are you a person?" are not answered by guessing: a price question is handed over with no reply and a push', async () => {
  const cases = [['price', decision({ intent: 'asking_price', handover: { needed: true, reason: 'asks about price' }, reply: 'It will be around 12000 euro' })],
    ['availability', decision({ intent: 'scheduling', handover: { needed: true, reason: 'asks about fitting dates' }, reply: 'We can fit it in March' })],
    ['complaint', decision({ intent: 'complaint', handover: { needed: true, reason: 'upset customer' }, reply: 'Sorry about that' })],
    ['photo', decision({ intent: 'other', reply: '' })]];
  for (const [name, d] of cases) {
    await newLead(PH); await says(PH, 'message about ' + name, NOW - 120e3); const w = waFake(), p = pushFake();
    const r = await REC.sweep(deps(fake([d]), w, p), NOW); assert.equal(r.handed_over, 1, name); assert.equal(w.sent.length, 0, name + ': nothing said'); assert.equal(p.events.length, 1, name + ': the owner is told'); assert.ok((await conv()).receptionist.paused, name);
  }
  await newLead(PH); await says(PH, 'Am I talking to a robot?', NOW - 120e3); const w = waFake(), p = pushFake();
  await REC.sweep(deps(fake([decision({ handover: { needed: true, reason: 'asked if AI' }, reply: 'No, I am Sean' })]), w, p), NOW); assert.deepEqual(w.sent.map((x) => x.body), [SCH.LINES.asked_ai]); assert.equal(p.events.length, 1);
});

test('ONLY NEW META LEADS: existing conversations, customers who are not Meta leads, returning customers and leads from before the master switch went on are never switched on', async () => {
  const w = waFake(), m = fake([decision()]);
  await newLead(PH, { receivedAt: SINCE - 3 * H, convCreatedAt: SINCE - 3 * H });                   // a lead that arrived before the master switch: an existing conversation
  await newLead(PH2, { meta: false, convCreatedAt: NOW - 3 * H });                                // a new WhatsApp customer who is not from Meta
  await newLead(PH3, { receivedAt: NOW - 3 * H, convCreatedAt: SINCE - 20 * H });                  // a returning customer whose OLD chat gets a new lead form
  for (const ph of [PH, PH2, PH3]) await says(ph, 'Hi, I would like a kitchen', NOW - 120e3);
  const r = await REC.sweep(deps(m, w, pushFake()), NOW);
  assert.equal(r.activated, undefined); assert.equal(m.calls.length + w.sent.length, 0, 'not one model call, not one message');
  assert.equal((await conv(PH)).receptionist, undefined, 'an existing conversation is left exactly as it was'); assert.equal((await conv(PH3)).receptionist, undefined); assert.equal((await conv(PH2)).receptionist.on, false, 'decided once: not a Meta lead');
  await db.doc('aiSettings/current').update({ autoReplySince: ts(0) }); assert.equal((await REC.sweep(deps(m, w, pushFake()), NOW + 60e3)).chats, 3); assert.equal(w.sent.length, 0, 'without a start time nothing is ever activated');
});

test('MASTER SWITCH: off means nothing happens; switching it on records the start time, so leads that arrived before are never touched; one switch is all there is', async () => {
  await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, replyAssistant: true, autoReply: false });
  await newLead(PH, { receivedAt: NOW - 3 * H }); await says(PH, 'Hi, interested', NOW - 120e3); const w = waFake(), m = fake([decision()]);
  const r0 = await REC.sweep(deps(m, w, pushFake()), NOW); assert.equal(r0.activated, undefined); assert.equal(m.calls.length + w.sent.length, 0, 'master off: no lead is switched on and nothing is sent'); assert.equal((await conv()).receptionist, undefined);
  const st = await ai.saveSettings({ db, model: null, owners: OWNERS }, owner, { autoReply: true }, { nowMs: NOW + 60e3 }); assert.equal(st.autoReply, true);
  assert.equal((await ai.loadSettings(db)).autoReplySince, NOW + 60e3, 'the start time is the moment the switch went on');
  const r = await REC.sweep(deps(m, w, pushFake()), NOW + 120e3); assert.equal(r.activated, undefined, 'the lead that arrived before the switch is not handled'); assert.equal(w.sent.length, 0);
  await ai.saveSettings({ db, model: null, owners: OWNERS }, owner, { autoReply: false }, { nowMs: NOW + 180e3 }); await ai.saveSettings({ db, model: null, owners: OWNERS }, owner, { autoReply: true }, { nowMs: NOW + 240e3 });
  assert.equal((await ai.loadSettings(db)).autoReplySince, NOW + 240e3, 'switched off and on again: a new start time');
});

test('PER-CHAT CONTROL: switching a chat off stays off (it is never switched on again by itself); switching it on starts afresh and only later messages are answered', async () => {
  await newLead(PH); await says(PH, 'Hi, interested in a kitchen', NOW - 120e3); const w = waFake(), m = fake([decision()]);
  await REC.sweep(deps(m, w, pushFake()), NOW); assert.equal(w.sent.length, 1); assert.equal((await conv()).receptionist.auto, true);
  await ai.setReceptionist({ db, owners: OWNERS }, owner, { phone: PH, on: false }, { nowMs: NOW + 100e3 });
  await says(PH, 'Still there?', NOW + 200e3); const r = await REC.sweep(deps(m, w, pushFake()), NOW + 400e3); assert.equal(w.sent.length, 1, 'off stays off'); assert.equal(r.activated, undefined); assert.equal((await conv()).receptionist.on, false);
  await ai.setReceptionist({ db, owners: OWNERS }, owner, { phone: PH, on: true }, { nowMs: NOW + 500e3 }); assert.equal((await REC.sweep(deps(m, w, pushFake()), NOW + 520e3)).nothing_new, 1, 'what the customer wrote before it was switched on again is not answered');
  await says(PH, 'Any day next week is fine', NOW + 600e3); await REC.sweep(deps(fake([decision({ intent: 'scheduling', wantsConsultation: true, schedule: { preference: { weeks: 'next', anyDay: true, text: 'any day' } } })]), w, pushFake()), NOW + 700e3); assert.equal(w.sent[1].body, SCH.LINES.acknowledge);
});

test('MANUAL TAKE-OVER: anything a person sends stops the automatic replies for good until the owner reactivates the chat; our own welcome template is not a take-over', async () => {
  await newLead(PH); await says(PH, 'Hi, interested', NOW - 120e3); const w = waFake(), m = fake([decision()]), p = pushFake();
  const r1 = await REC.sweep(deps(m, w, p), NOW); assert.equal(r1['sent:offer_visit'], 1, 'the welcome template that Make sent did not count as a person');
  await store.storeOutbound(db, PH, { wamid: 'wamid.HUMAN1', type: 'text', body: 'Hi Aoife, Thomas here, I will call you shortly.' });         // the owner replies by hand
  await says(PH, 'Great, thanks', NOW + 300e3); assert.equal((await REC.sweep(deps(m, w, p), NOW + 420e3)).staff_replied, 1); assert.equal(w.sent.length, 1, 'silent after a person replied');
  await says(PH, 'Hello again', NOW + 900e3); assert.equal((await REC.sweep(deps(m, w, p), NOW + 1000e3)).paused, 1); assert.equal(w.sent.length, 1); assert.equal(p.events.length, 0, 'no alert: the owner is already in the chat');
  await ai.setReceptionist({ db, owners: OWNERS }, owner, { phone: PH, on: true }, { nowMs: NOW + 1100e3 }); assert.equal((await conv()).receptionist.paused, null, 'explicitly reactivated');
});

test('DUPLICATES AND RETRIES: a webhook delivered twice stores one message; overlapping checks and repeated checks send exactly one reply', async () => {
  await newLead(PH); const first = await says(PH, 'Hi, interested', NOW - 120e3, 'wamid.SAME'), second = await says(PH, 'Hi, interested', NOW - 120e3, 'wamid.SAME');
  assert.deepEqual([first, second], [true, false], 'the second delivery is recognised and ignored'); assert.equal((await msgs()).filter((x) => x.direction === 'in').length, 1);
  const w = waFake(), m = fake([async () => 0, decision()].map((x) => (typeof x === 'function' ? decision() : x)));
  const slow = { calls: 0, async complete(req) { slow.calls++; await new Promise((r) => setTimeout(r, 120)); return { text: '', stopReason: 'tool_use', usage: USAGE, ...decision() }; } };
  const runs = await Promise.all([REC.sweep(deps(slow, w, pushFake()), NOW), REC.sweep(deps(slow, w, pushFake()), NOW), REC.sweep(deps(slow, w, pushFake()), NOW)]);
  assert.equal(w.sent.length, 1, 'three overlapping checks: one message: ' + JSON.stringify(runs)); await REC.sweep(deps(m, w, pushFake()), NOW + 60e3); await REC.sweep(deps(m, w, pushFake()), NOW + 120e3); assert.equal(w.sent.length, 1, 'later checks add nothing');
  assert.equal((await msgs()).filter((x) => x.direction === 'out' && x.auto).length, 1);
});

test('WHATSAPP RULES AND QUIET HOURS: nothing between midnight and 7:00 (answered after 7:00); nothing once the 24-hour window has closed; nothing sent but plain text', async () => {
  await newLead(PH); const night = Date.UTC(2026, 9, 14, 0, 30);                                                        // 01:30 in Ireland
  await says(PH, 'Hi, interested', night - 120e3); const w = waFake(), m = fake([decision()]);
  assert.deepEqual(await REC.sweep(deps(m, w, pushFake()), night), { skipped: 'quiet hours' }); assert.equal(w.sent.length, 0);
  const morning = Date.UTC(2026, 9, 14, 6, 5); assert.equal((await REC.sweep(deps(m, w, pushFake()), morning)).activated, 1); assert.equal(w.sent.length, 1, 'answered after 7:00 (07:05 in Ireland)');
  await newLead(PH2); await says(PH2, 'Hi, interested', NOW - 25 * H); const late = fake([decision()]), w2 = waFake();
  await REC.sweep(deps(late, w2, pushFake()), NOW); assert.equal(late.calls.length + w2.sent.length, 0, 'the customer last wrote more than 24 hours ago: nothing can be sent as free text'); assert.equal((await conv(PH2)).receptionist, undefined, 'and that chat is not even looked at');
  assert.deepEqual(Object.keys(w).sort(), ['sendText', 'sent'], 'the only thing the receptionist can send is a text message');
});

test('NOTHING BOOKED, NOTHING CHANGED: the receptionist never books, edits or cancels anything, and leaves a consultation request (not an appointment) for the owner', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/aiReceptionist.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/sendTemplate|sendMedia|createAppointment|updateAppointment|cancelAppointment|collection\('appointments'\)|quotes|projects|updateContact|setConversationStatus/.test(src), false);
  assert.equal((src.match(/wa\.sendText\(/g) || []).length, 1);
  await newLead(PH); await says(PH, 'Tuesday afternoon next week suits me', NOW - 120e3); const a0 = await apptCount(), status0 = (await conv()).inboxStatus;
  await REC.sweep(deps(fake([decision({ intent: 'scheduling', wantsConsultation: true, schedule: PREF })]), waFake(), pushFake()), NOW);
  assert.equal(await apptCount(), a0); assert.equal((await conv()).inboxStatus, status0, 'the customer stays where they were'); assert.equal((await conv()).consult.needsBooking, true);
});

test('THE MODEL IS TOLD IT IS UNATTENDED: the automatic mode note is added for the receptionist only; staff drafts keep the model\'s own reply; the automatic receptionist offers a visit but never pushes one', async () => {
  const seen = []; const spy = { async complete(req) { seen.push(req.system); return { text: '', stopReason: 'tool_use', usage: USAGE, ...decision({ intent: 'new_enquiry', reply: 'Thanks, Aoife.' }) }; } };
  await newLead(PH); await says(PH, 'Hi, I want a kitchen', NOW - 120e3);
  const manual = await ai.suggestReply({ db, model: spy, owners: OWNERS }, owner, { phone: PH }, { uid: 'u1', nowMs: NOW }); assert.equal(manual.schedule.step, 'none', 'staff drafts: the model\'s own reply is the draft; the person decides about an offer'); assert.equal(manual.draft, 'Thanks, Aoife.');
  await ai.setReceptionist({ db, owners: OWNERS }, owner, { phone: PH, on: true }, { nowMs: NOW - 600e3 });
  const auto = await ai.suggestReply({ db, model: spy, owners: OWNERS }, owner, { phone: PH }, { uid: 'u2', nowMs: NOW, receptionist: true }); assert.equal(auto.schedule.step, 'offer_visit'); assert.equal(auto.draft, 'Thanks, Aoife. ' + SCH.LINES.visit_offer); assert.equal(asksDays(auto.draft), false);
  assert.doesNotMatch(seen[0], /AUTOMATIC MODE/); assert.match(seen[1], /AUTOMATIC MODE[\s\S]*no member of staff reads it first[\s\S]*Do NOT push a consultation[\s\S]*ONE short, natural sentence[\s\S]*hand over/);
  assert.equal((await db.collection('aiDrafts').where('auto', '==', true).get()).size, 1, 'the draft record says it was automatic');
});

test('GENERAL PRICE QUESTIONS: answered with the owner\'s own line, then the offer of a visit (once, never a question about days); a specific price, a quote or a discount is handed over; the model never writes a figure', async () => {
  await newLead(PH); await says(PH, 'How much does a kitchen cost?', NOW - 120e3); const w = waFake(), p = pushFake();
  await REC.sweep(deps(fake([decision({ intent: 'asking_price_general', reply: 'Around 8000 euro, we can do 5k if you pay cash' })]), w, p), NOW);
  assert.deepEqual(w.sent.map((x) => x.body), [SCH.LINES.price_general + ' ' + SCH.LINES.visit_offer], 'the owner\'s words, never the model\'s figure; then the offer');
  assert.equal(asksDays(w.sent[0].body), false); assert.equal(p.events.length, 0); assert.deepEqual((await conv()).consult, { stage: 'offered_visit', offered: true }, 'the offer is remembered: it is not repeated');
  // they ask the price again later: the line alone (the offer was made)
  await says(PH, 'And roughly what would a kitchen cost?', NOW + 600e3); const w1 = waFake();
  await REC.sweep(deps(fake([decision({ intent: 'asking_price_general' })]), w1, pushFake()), NOW + 800e3); assert.deepEqual(w1.sent.map((x) => x.body), [SCH.LINES.price_general]);
  // a customer who is already booked asks the same thing: the line alone, no offer, no hand-over
  await newLead(PH2); await db.collection('appointments').add({ phone: PH2, status: 'scheduled', type: 'consultation', start: ts(NOW + 3 * 86400e3), end: ts(NOW + 3 * 86400e3 + 3600e3), customerName: 'Aoife' });
  await says(PH2, 'Roughly what do your kitchens cost?', NOW - 120e3); const w2 = waFake();
  await REC.sweep(deps(fake([decision({ intent: 'asking_price_general' })]), w2, pushFake()), NOW); assert.deepEqual(w2.sent.map((x) => x.body), [SCH.LINES.price_general]); assert.equal((await conv(PH2)).receptionist.paused, null, 'still the receptionist\'s chat');
  // specific questions: no answer, hand over, push (also when the model forgets to flag the hand-over)
  for (const [name, d] of [['quote', decision({ intent: 'asking_price', handover: { needed: true, reason: 'wants a quote' } })], ['unflagged', decision({ intent: 'asking_price' })], ['discount', decision({ intent: 'asking_price', handover: { needed: true, reason: 'asks for a discount' } })]]) {
    await newLead(PH3); await says(PH3, 'message about ' + name, NOW - 120e3); const w3 = waFake(), p3 = pushFake();
    await REC.sweep(deps(fake([d]), w3, p3), NOW); assert.equal(w3.sent.length, 0, name); assert.equal(p3.events.length, 1, name); assert.ok((await conv(PH3)).receptionist.paused, name);
  }
});
