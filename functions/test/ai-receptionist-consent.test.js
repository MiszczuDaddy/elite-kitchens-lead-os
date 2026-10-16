// Phase 9 Step A: what the CUSTOMER experiences from the automatic receptionist (consultation consent, cancellation, availability, preferences). Real Firestore emulator; the model understands the
// customer (fake decisions: visit, change, question, availability and its status) and the receptionist code decides what is sent; WhatsApp is a recorder. Assertions look at OUTCOMES (was the customer asked
// about days before agreeing? was the cancellation claimed as done? was a day invented? was the preference kept for the owner?) through detectors that do not depend on the exact wording of a line.
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
const NOW = Date.UTC(2026, 9, 13, 10, 0), ts = (ms) => Timestamp.fromMillis(ms), H = 3600e3, MIN = 60e3;
const SINCE = NOW - 5 * H, LEAD_AT = NOW - 4 * H, TEMPLATE = 'elite_kitchens_new_lead', L = SCH.LINES;
const PHONES = ['353871110051', '353871110052', '353871110053', '353871110054', '353871110055', '353871110056'], USAGE = { input: 3000, output: 200, cacheRead: 0, cacheWrite: 0 };
const NOTES = 'Meta lead · Kitchen enquiry · 13 Oct 2026\nLead ID: 123456789\nRequirements: Shaker kitchen with island\nOther answers:\n• Eircode / postcode: K67 X123\n• Estimated budget: 15-20k';

// outcome detectors (what a message does, not how it is worded)
const asksDays = (t) => /\?/.test(t || '') && /\b(any day|which day|what day|day.{0,12}suit|week.{0,15}suit|suit you.{0,40}(week|day)|what time|when (would|are you|suits)|days or times)\b/i.test(t || '');
const offersVisit = (t) => /call out and have a look|stop by and have a look|have a look at your space/i.test(t || '');
const claimsDone = (t) => /\b(cancelled|canceled|has been cancelled|is cancelled|confirmed|booked in|all done|you are booked)\b/i.test(t || '');
const inventsTime = (t) => /\b(evening|evenings|tonight|tomorrow|today|am|pm|\d{1,2}:\d{2})\b/i.test(t || '');

function fake(script) { const m = { calls: [], async complete() { m.calls.push(1); const s = script[Math.min(m.calls.length - 1, script.length - 1)]; return { text: '', toolCalls: [], stopReason: 'end_turn', usage: USAGE, ...s }; } }; return m; }
const decision = (over = {}) => ({ toolCalls: [{ id: 'd1', name: 'reply_decision', input: { reply: '', intent: 'new_enquiry', visit: 'none', hasQuestion: false, change: 'none', schedule: { preference: null, opener: '' }, newFacts: [], handover: { needed: false, reason: null }, ...over } }], stopReason: 'tool_use' });
const pref = (p) => ({ schedule: { preference: { status: 'available', ...p }, opener: '' } });       // the model must give a status (none = unknown); 'available' unless the test says otherwise
const waFake = () => { const w = { sent: [], async sendText(to, body) { w.sent.push({ to, body }); return 'wamid.AUTO' + w.sent.length; } }; return w; };
const pushFake = () => { const p = { events: [], async notify(ev) { p.events.push(ev); } }; return p; };
const checked = () => db.doc('aiSettings/modelCheck').set(Object.fromEntries(Object.entries(ai.MODELS).map(([k, m]) => [k, { id: m.id, ok: true, name: m.label, lifecycle: 'active', at: ts(NOW) }])));
const conv = async (phone) => (await db.doc('conversations/' + phone).get()).data();

async function newLead(phone, { booked = false } = {}) {
  await db.recursiveDelete(db.doc('conversations/' + phone));
  await db.doc('contacts/' + phone).set({ phone, name: 'Aoife Kavanagh', projectType: 'Kitchen', location: 'Swords', budget: '15-20k', notes: NOTES, source: 'Meta Ads', createdAt: ts(LEAD_AT), metaLead: { leadId: '123456789', receivedAt: ts(LEAD_AT) } });
  await db.doc('conversations/' + phone).set({ phone, name: 'Aoife Kavanagh', inboxStatus: 'inbox', createdAt: ts(LEAD_AT), updatedAt: ts(LEAD_AT), unreadCount: 0 });
  await store.storeOutbound(db, phone, { wamid: 'wamid.WELCOME' + phone, type: 'template', body: `[template: ${TEMPLATE}] Hi Aoife, thanks for your enquiry with Elite Kitchens...` });
  await db.collection(`conversations/${phone}/messages`).doc('wamid.WELCOME' + phone).update({ createdAt: ts(LEAD_AT + 2000) }).catch(() => {});
  if (booked) await db.collection('appointments').doc('ap_' + phone).set({ phone, status: 'scheduled', type: 'consultation', version: 3, start: ts(NOW + 3 * 86400e3), end: ts(NOW + 3 * 86400e3 + H), customerName: 'Aoife Kavanagh', location: 'Swords' });
}
// One customer turn through the real receptionist code: the customer writes at `t`, the every-minute check runs two minutes later. Returns what the customer received.
let clock = NOW;
async function turn(phone, text, d, w, p) {
  clock += 10 * MIN; await store.storeInbound(db, { wamid: 'wamid.IN' + clock + phone, from: phone, type: 'text', body: text, name: 'Aoife Kavanagh', createdAt: new Date(clock) });
  const before = w.sent.length; const r = await REC.sweep({ db, wa: w, model: fake([d]), owners: OWNERS, push: p, welcomeTemplate: TEMPLATE }, clock + 2 * MIN);
  return { got: w.sent.slice(before).map((x) => x.body), r };
}
const appt = async (phone) => (await db.doc('appointments/ap_' + phone).get()).data();

beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await checked(); await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, replyAssistant: true, autoReply: true, autoReplySince: ts(SINCE), monthlyCapEur: 15, dailyCapEur: 2 });
  clock = NOW;
});

test('CONSENT: whatever the customer says, nobody is asked about days until they ask for a visit or say yes to the offer; the visit is offered at most once in the whole conversation', async () => {
  const openings = [['hello', { intent: 'greeting', reply: 'Hi Aoife, thanks for getting back to us.' }], ['confusion', { intent: 'greeting', reply: 'Hi Aoife, this is Elite Kitchens following up on your kitchen enquiry.' }], ['yes to the welcome message', { intent: 'answering_questions', reply: 'Great, thanks Aoife.' }],
    ['interested in a kitchen', { intent: 'new_enquiry', reply: 'Lovely, a shaker kitchen sounds great.' }], ['a general price question', { intent: 'asking_price_general' }], ['a project description', { intent: 'answering_questions', reply: 'A handleless kitchen sounds lovely.' }]];
  for (const [i, [what, d]] of openings.entries()) {
    const ph = PHONES[0] + '' + i, phone = ph.slice(0, 12); await newLead(phone); const w = waFake(), p = pushFake(); clock = NOW + i * 5 * H;
    const all = []; all.push(...(await turn(phone, 'first message: ' + what, decision(d), w, p)).got);
    for (const follow of ['ok', 'thanks', 'ok great']) all.push(...(await turn(phone, follow, decision({ intent: 'greeting', reply: 'Thanks again.' }), w, p)).got);
    assert.equal(all.some(asksDays), false, what + ': nobody is asked about days without agreeing: ' + JSON.stringify(all));
    assert.ok(all.filter(offersVisit).length <= 1, what + ': the visit is offered at most once: ' + JSON.stringify(all));
    assert.equal((await conv(phone)).consult && (await conv(phone)).consult.needsBooking, undefined, what + ': no booking request was created'); assert.equal(await db.collection('appointments').get().then((s) => s.size), 0);
  }
  // asked for a visit: straight to the days; said yes to the offer: the days; both never before
  await newLead(PHONES[1]); const w = waFake(), p = pushFake();
  const asked = await turn(PHONES[1], 'Can someone come out and have a look at the kitchen?', decision({ intent: 'wants_consultation', visit: 'asked' }), w, p); assert.equal(asked.got.length, 1); assert.equal(asksDays(asked.got[0]), true);
  await newLead(PHONES[2]); const w2 = waFake(), p2 = pushFake();
  const offer = await turn(PHONES[2], 'I am looking at a new kitchen', decision({ intent: 'new_enquiry', reply: 'Lovely, thanks Aoife.' }), w2, p2); assert.equal(offersVisit(offer.got[0]), true); assert.equal(asksDays(offer.got[0]), false);
  const yes = await turn(PHONES[2], 'Yes please', decision({ intent: 'answering_questions', visit: 'agreed' }), w2, p2); assert.equal(yes.got.length, 1); assert.equal(asksDays(yes.got[0]), true); assert.equal(offersVisit(yes.got[0]), false, 'the offer is not repeated');
  // "no thanks" to the offer: nothing more is asked or offered, the owner is told
  await newLead(PHONES[3]); const w3 = waFake(), p3 = pushFake();
  await turn(PHONES[3], 'Looking at a kitchen', decision({ intent: 'new_enquiry', reply: 'Lovely.' }), w3, p3);
  const no = await turn(PHONES[3], 'No thanks, not at the moment', decision({ intent: 'answering_questions', visit: 'declined' }), w3, p3); assert.deepEqual(no.got, []); assert.equal(p3.events.length, 1, 'the owner is told'); assert.equal(w3.sent.some((m) => asksDays(m.body)), false);
});

test('ANSWER BEFORE OFFERING: a question that needs a person gets no offer and no question about days (a person answers it); a price question gets the owner\'s line first', async () => {
  await newLead(PHONES[0]); const w = waFake(), p = pushFake();
  const q = await turn(PHONES[0], 'Do you do fitted wardrobes as well?', decision({ intent: 'asking_info', hasQuestion: true }), w, p);
  assert.deepEqual(q.got, [], 'nothing is offered or asked while a question is waiting for a person'); assert.equal(p.events.length, 1, 'the owner is told about the question'); assert.match((await conv(PHONES[0])).receptionist.paused, /needs you|question|handover/i);
  await newLead(PHONES[1]); const w2 = waFake(), p2 = pushFake();
  const price = await turn(PHONES[1], 'How much does a kitchen cost?', decision({ intent: 'asking_price_general' }), w2, p2);
  assert.equal(price.got.length, 1); assert.ok(price.got[0].startsWith(L.price_general), 'the answer comes first'); assert.equal(offersVisit(price.got[0]), true, 'then the offer'); assert.equal(asksDays(price.got[0]), false);
  assert.equal((await turn(PHONES[1], 'Is 10k enough for a kitchen?', decision({ intent: 'asking_price', hasQuestion: true }), w2, p2)).got.length, 0, 'a question about their own budget goes to a person: no invented answer, no new offer');
});

test('CANCELLATION: a booked customer who cancels is asked once if they want to move it; nothing is said as done, no days are asked, the appointment is untouched and the owner is told; "no, just cancel" goes to the owner silently', async () => {
  await newLead(PHONES[0], { booked: true }); const w = waFake(), p = pushFake(), before = await appt(PHONES[0]);
  const first = await turn(PHONES[0], 'I need to cancel my appointment please', decision({ intent: 'scheduling', change: 'cancel', handover: { needed: true, reason: 'wants to change booking' } }), w, p);
  assert.deepEqual(first.got, [L.cancel_ask]); assert.equal(asksDays(first.got[0]), false); assert.equal(claimsDone(first.got[0]), false); assert.equal(p.events.length, 1, 'the owner is told straight away');
  assert.equal((await conv(PHONES[0])).receptionist.paused, null, 'the chat stays open for their answer');
  const second = await turn(PHONES[0], 'No, I do not want to rebook, just cancel it please', decision({ intent: 'scheduling', change: 'cancel', handover: { needed: true, reason: 'wants to cancel' } }), w, p);
  assert.deepEqual(second.got, [], 'no second question, no rebooking pitch'); assert.ok((await conv(PHONES[0])).receptionist.paused, 'a person takes it from here');
  assert.deepEqual(await appt(PHONES[0]), before, 'the appointment is exactly as it was: only a person changes or cancels it'); assert.equal((await conv(PHONES[0])).consult && (await conv(PHONES[0])).consult.needsBooking, undefined, 'no new booking request');
  assert.equal(w.sent.some((m) => claimsDone(m.body) || asksDays(m.body)), false);
  // "yes, move it": it becomes a booking change
  await newLead(PHONES[1], { booked: true }); const w2 = waFake(), p2 = pushFake();
  await turn(PHONES[1], 'Cancel my appointment', decision({ intent: 'scheduling', change: 'cancel' }), w2, p2);
  const mv = await turn(PHONES[1], 'Actually yes, can we move it?', decision({ intent: 'scheduling', change: 'move' }), w2, p2); assert.equal(mv.got.length, 1); assert.equal(asksDays(mv.got[0]) || /better/i.test(mv.got[0]), true);
  const given = await turn(PHONES[1], 'Wednesday afternoon next week', decision({ intent: 'scheduling', change: 'move', ...pref({ weeks: 'next', days: ['wednesday'], times: 'afternoons', text: 'Wednesday afternoon next week' }) }), w2, p2); assert.deepEqual(given.got, [L.acknowledge]);
});

test('A BOOKED CUSTOMER ASKING FOR SOMETHING SPECIFIC (tomorrow, earlier that day, confirm, running late) goes to the owner with no reply and no suggestion of next week; the booking is untouched', async () => {
  for (const [i, [text, change]] of [['Can we do it tomorrow instead?', 'move_specific'], ['Is it possible to do it earlier that day, say 9?', 'move_specific'], ['Can you confirm my appointment is still on?', 'confirm'], ['I am running 20 minutes late', 'late']].entries()) {
    const phone = PHONES[i]; await newLead(phone, { booked: true }); const w = waFake(), p = pushFake(), before = await appt(phone);
    const r = await turn(phone, text, decision({ intent: 'scheduling', change }), w, p); assert.deepEqual(r.got, [], text); assert.equal(p.events.length, 1, text + ': the owner is told'); assert.deepEqual(await appt(phone), before, text);
    assert.equal((await conv(phone)).receptionist.paused !== null, true, text);
  }
});

test('AVAILABILITY IS NEVER INVENTED: "abroad", "I work all day" and "I will let you know" create no booking request and no time; what they said is kept in their own words', async () => {
  const cases = [['abroad for a few weeks', pref({ status: 'unavailable', weeks: 'other', text: 'abroad for a few weeks' })], ['I work all day though', pref({ status: 'unavailable', text: 'I work all day' })], ['I will know on Friday', pref({ status: 'tentative', text: 'I will know on Friday' })], ['not sure yet', pref({ status: 'tentative', text: 'not sure yet' })]];
  for (const [i, [text, sched]] of cases.entries()) {
    const phone = PHONES[i]; await newLead(phone); const w = waFake(), p = pushFake();
    const r = await turn(phone, text, decision({ intent: 'scheduling', visit: 'agreed', ...sched }), w, p); const c = await conv(phone);
    assert.equal(r.got.some(inventsTime), false, text + ': no day or time invented: ' + JSON.stringify(r.got)); assert.equal(r.got.some((g) => claimsDone(g)), false);
    assert.notEqual(c.consult && c.consult.needsBooking, true, text + ': no booking request'); assert.equal(await db.collection('appointments').get().then((s) => s.size), 0);
    if (c.consult && c.consult.note) { assert.deepEqual([c.consult.note.days, c.consult.note.times], [[], null], text + ': the note has no days or times'); assert.match(c.consult.note.text, /abroad|work all day|Friday|not sure/); assert.match(c.consult.note.summary, /Will let us know|Not available/); }
  }
  // the one thing that is asked again is "the following week" (after the first question), never a made-up day
  await newLead(PHONES[4]); const w = waFake(), p = pushFake();
  await turn(PHONES[4], 'Can someone come and look?', decision({ intent: 'wants_consultation', visit: 'asked' }), w, p);
  const after = await turn(PHONES[4], 'Not that week, I work all day', decision({ intent: 'scheduling', visit: 'agreed', ...pref({ status: 'unavailable', text: 'I work all day' }) }), w, p);
  assert.equal(after.got.length, 1); assert.equal(inventsTime(after.got[0]), false); assert.equal((await conv(PHONES[4])).consult.needsBooking, undefined);
});

test('PREFERENCES ARE KEPT: a day given together with a question that needs a person is recorded for the owner (with the question noted); a complaint with a day is not a booking', async () => {
  await newLead(PHONES[0]); const w = waFake(), p = pushFake();
  await turn(PHONES[0], 'Can someone come and look at the kitchen?', decision({ intent: 'wants_consultation', visit: 'asked' }), w, p);
  const r = await turn(PHONES[0], 'Monday afternoon works for me. Is that free to come out to Cork?', decision({ intent: 'asking_info', visit: 'agreed', hasQuestion: true, handover: { needed: true, reason: 'asks if the visit is free' }, ...pref({ weeks: 'next', days: ['monday'], times: 'afternoons', text: 'Monday afternoon works for me' }) }), w, p);
  const c = await conv(PHONES[0]);
  assert.deepEqual(r.got, [L.acknowledge]); assert.equal(c.consult.needsBooking, true, 'the request card and the Needs booking count are there'); assert.deepEqual([c.consult.preference.days, c.consult.preference.times], [['monday'], 'afternoons']); assert.match(c.consult.preference.text, /Monday afternoon works/);
  assert.match(c.receptionist.paused, /consultation passed to you/); assert.equal(p.events.length, 1);
  await newLead(PHONES[1]); const w2 = waFake(), p2 = pushFake();
  const angry = await turn(PHONES[1], 'Your fitter wrecked my floor, come Tuesday and fix it', decision({ intent: 'complaint', handover: { needed: true, reason: 'upset customer' }, ...pref({ days: ['tuesday'], text: 'come Tuesday' }) }), w2, p2);
  assert.deepEqual(angry.got, [SCH.LINES.complaint], 'one line, no offer, no days'); assert.notEqual((await conv(PHONES[1])).consult && (await conv(PHONES[1])).consult.needsBooking, true, 'a complaint is not a booking request'); assert.equal(p2.events.length, 1);
});

test('GOOD WORDING IS NOT BLOCKED: an acknowledgement that mentions the Eircode before the offer, and the second scheduling question, are sent; they are no longer "asks for the address again" / "asks for the time again"', async () => {
  await newLead(PHONES[0]); const w = waFake(), p = pushFake();
  const a = await turn(PHONES[0], 'Yes please. My eircode is K67 X123 if you need it.', decision({ intent: 'answering_questions', ack: 'details', reply: 'Thanks for the Eircode, Aoife.' }), w, p);
  assert.equal(a.got.length, 1, 'sent, not handed over'); assert.match(a.got[0], /^Thanks for the details, Aoife\. /, 'the acknowledgement is written by code (audit 16 Oct 2026, finding 1)'); assert.equal(offersVisit(a.got[0]), true); assert.equal((await conv(PHONES[0])).receptionist.paused, null);
  await newLead(PHONES[1]); const w2 = waFake(), p2 = pushFake();
  await turn(PHONES[1], 'Yes, can you call out?', decision({ intent: 'wants_consultation', visit: 'asked' }), w2, p2);
  const b = await turn(PHONES[1], 'I am not sure which week suits', decision({ intent: 'scheduling', visit: 'agreed', ...pref({ status: 'unavailable', text: 'not sure which week' }) }), w2, p2);
  assert.equal(b.got.length, 1, 'the second question is sent'); assert.equal(asksDays(b.got[0]), true); assert.equal((await conv(PHONES[1])).receptionist.paused, null, 'not handed over because of a draft check');
});

test('SAFETY IS KEPT: the receptionist never books, edits or cancels anything and never writes a price, a promise or a day of its own, in any of the Step A flows', async () => {
  const flows = [['I want a kitchen', decision({ intent: 'new_enquiry', reply: 'We can do it for 5000 euro and be there tomorrow, guaranteed!' })], ['hi', decision({ intent: 'greeting', reply: 'Hi, booked for Monday at 9am.' })], ['how much?', decision({ intent: 'asking_price_general', reply: 'About 8000 euro' })]];
  for (const [i, [text, d]] of flows.entries()) {
    const phone = PHONES[i]; await newLead(phone); const w = waFake(), p = pushFake(); const r = await turn(phone, text, d, w, p);
    for (const g of r.got) { assert.doesNotMatch(g, /5000|8000|tomorrow|guarantee|booked for|9am/i, g); }
    assert.equal(await db.collection('appointments').get().then((s) => s.size), 0);
  }
  const src = require('fs').readFileSync(require('path').join(__dirname, '../lib/aiReceptionist.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/createAppointment|updateAppointment|cancelAppointment|collection\('appointments'\)|sendTemplate|sendMedia/.test(src), false);
});
