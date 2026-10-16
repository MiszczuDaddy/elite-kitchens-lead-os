// Phase 9 Step A: the consultation policy (functions/lib/aiSchedule.js). Pure functions, no database. The tests describe what a CUSTOMER experiences (outcomes), using detectors that look at what a message
// does (offers a visit, asks about days, claims something is done) rather than at the exact words, so a rewording of a fixed line does not break them. The owner's approved wording is checked once, in the
// first test. The policy: answer -> offer a home visit ONCE -> wait for agreement -> ask about days -> record what they say -> hand over; interest, hello, ok, confusion and price questions are not agreement.
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('../lib/aiSchedule');

const TUE = Date.UTC(2026, 9, 13, 10, 0);          // Tuesday 13 Oct 2026
const L = S.LINES;
// what a message DOES, independent of its wording
const asksDays = (t) => /\?/.test(t || '') && /\b(any day|which day|what day|day.{0,12}suit|week.{0,15}suit|suit you.{0,40}(week|day)|what time|when (would|are you|suits)|days or times)\b/i.test(t || '');
const offersVisit = (t) => /call out and have a look|stop by and have a look|have a look at your space/i.test(t || '');
const claimsDone = (t) => /\b(cancelled|canceled|has been cancelled|is cancelled|confirmed|booked in|all done|you are booked)\b/i.test(t || '');
const base = { reply: '', intent: 'new_enquiry', visit: 'none', hasQuestion: false, change: 'none', schedule: { preference: null, opener: '' }, handover: { needed: false, reason: null } };
const D = (o = {}) => ({ ...base, ...o });
// The customer's own words about when they are free are put in the chat, since the plan checks the days and times against them (audit 16 Oct 2026, finding 5).
const P = (o = {}, ctx = {}) => { const w = o.schedule && o.schedule.preference && o.schedule.preference.text; return S.plan({ decision: D(o), consult: null, booked: false, nowMs: TUE, natural: true, ...ctx, messages: [...(ctx.messages || []), ...(w ? [{ direction: 'in', type: 'text', body: w }] : [])] }); };
const pref = (p) => ({ schedule: { preference: S.cleanPreference({ status: 'available', ...p }), opener: '' } });       // the model must give a status; these tests give 'available' unless they say otherwise
const out = (text, type = 'text') => ({ direction: 'out', type, body: text }), inn = (text) => ({ direction: 'in', type: 'text', body: text });
const sent = (p) => p.reply || '';

test('the owner\'s approved lines are in place and make no promise, no date and no availability claim (the price line is the only one with a figure)', () => {
  assert.deepEqual(Object.keys(L).sort(), ['acknowledge', 'ask_following_week', 'ask_next_week', 'asked_ai', 'cancel_ask', 'change_ask', 'complaint', 'no_preference', 'price_general', 'tentative', 'visit_offer']);
  assert.equal(L.visit_offer, 'Would you like us to call out and have a look at your space?'); assert.equal(L.cancel_ask, 'No problem, do you want to move it to any other date?'); assert.equal(L.tentative, 'No problem at all, just let us know when suits.');
  assert.equal(L.acknowledge, 'Perfect, I\'ll pass that on to the team and we\'ll confirm a time shortly.');
  for (const [k, l] of Object.entries(L)) if (k !== 'price_general') assert.doesNotMatch(l, /\b(booked|confirmed available|availability|\d)\b/i, k);
  assert.equal(S.MAX_ASKS, 2);
  assert.equal(offersVisit(L.visit_offer), true); assert.equal(asksDays(L.visit_offer), false, 'the offer never asks about days'); assert.equal(asksDays(L.ask_next_week), true); assert.equal(offersVisit(L.ask_next_week), false);
});

test('weeks run Monday to Sunday in Irish time, counted from today', () => {
  assert.equal(S.weekOf(TUE, 'this').label, 'Mon 12 Oct to Sun 18 Oct'); assert.equal(S.weekOf(TUE, 'next').label, 'Mon 19 Oct to Sun 25 Oct'); assert.equal(S.weekOf(TUE, 'following').label, 'Mon 26 Oct to Sun 1 Nov');
  assert.equal(S.weekOf(Date.UTC(2026, 9, 18, 12, 0), 'next').label, 'Mon 19 Oct to Sun 25 Oct', 'on a Sunday, next week starts tomorrow');
  assert.equal(S.weekOf(Date.UTC(2026, 9, 12, 8, 0), 'this').label, 'Mon 12 Oct to Sun 18 Oct', 'on a Monday, this week starts today');
  assert.equal(S.weekOf(Date.UTC(2026, 11, 29, 12, 0), 'next').label, 'Mon 4 Jan to Sun 10 Jan', 'across the new year');
  assert.equal(S.weekOf(Date.UTC(2026, 9, 18, 23, 30), 'this').label, 'Mon 19 Oct to Sun 25 Oct', 'just after midnight in Ireland (23:30 UTC is 00:30 on Monday)');
});

test('AVAILABILITY INTEGRITY: only what the customer OFFERED can become a booking request; unavailable, tentative and unknown never do, and nothing is inferred', () => {
  const ok = [{ weeks: 'next' }, { days: ['tuesday'] }, { anyDay: true }, { times: 'mornings' }, { days: ['monday', 'friday'], times: 'after 5pm' }, { weeks: 'following', times: 'mornings' }];
  for (const p of ok) assert.equal(S.reasonable(S.cleanPreference({ status: 'available', ...p })), true, JSON.stringify(p));
  for (const p of ok) assert.equal(S.reasonable(S.cleanPreference(p)), false, 'no status from the model: never "available" (audit 16 Oct 2026, finding 5): ' + JSON.stringify(p));
  const notOk = [null, undefined, {}, { text: 'not sure yet, I will let you know' }, { days: [] }, { days: ['funday'] }, { weeks: 'someday' }, { anyDay: 'yes' }, 'tuesday', { times: '   ' },
    { weeks: 'other', text: 'abroad for a few weeks' }, { weeks: 'other', text: 'the 28th' },                                       // "another time" alone is not a day or a time they offered
    { status: 'unavailable', text: 'I work all day' }, { status: 'tentative', text: 'I will know on Friday' }, { status: 'tentative', days: ['friday'], text: 'maybe Friday' }, { status: 'unknown', days: ['monday'] }];
  for (const p of notOk) assert.equal(S.reasonable(S.cleanPreference(p)), false, JSON.stringify(p));
  const c = S.cleanPreference({ weeks: 'next', days: ['Tuesday', 'tuesday', 'WEDNESDAY', 'x'], times: ' afternoons ', text: 'y'.repeat(400) });
  assert.deepEqual([c.weeks, c.days, c.times, c.text.length <= 160, c.status], ['next', ['tuesday', 'wednesday'], 'afternoons', true, 'unknown']);
  assert.equal(S.cleanPreference({ status: 'bogus', days: ['monday'] }).status, 'unknown'); assert.equal(S.cleanPreference({ text: 'maybe' }).status, 'unknown');
  const n = S.noteOf(S.cleanPreference({ status: 'tentative', text: 'I will know on Friday' })); assert.deepEqual([n.days, n.times, n.status, n.customerWords], [[], null, 'tentative', 'I will know on Friday']); assert.match(n.text, /I will know on Friday/);
  assert.equal(S.noteOf(S.cleanPreference({ status: 'available', days: ['monday'] })), null, 'an available customer has a preference, not a note');
  // the days and times must be in what the customer wrote
  const h = (p, said) => S.heard(S.cleanPreference({ status: 'available', ...p }), said);
  assert.deepEqual(h({ days: ['tuesday', 'friday'], times: 'afternoons' }, 'Tues afternoon works').days, ['tuesday']); assert.equal(h({ days: ['tuesday'], times: 'afternoons' }, 'Tues afternoon works').times, 'afternoons');
  assert.equal(h({ times: 'evenings' }, 'I work all day though').times, null); assert.equal(h({ times: 'after 5pm' }, 'any day after 5 is fine').times, 'after 5pm'); assert.deepEqual(h({ days: ['friday'] }, 'the fridge is staying').days, []);
  assert.deepEqual(h({ days: ['saturday', 'sunday'] }, 'weekends, saturdays best').days, ['saturday']); assert.equal(S.heard(null, 'x'), null);
});

test('the summary for the person who books it: the real dates, the days, the time of day, the customer\'s own words', () => {
  const d = (p) => S.describe(S.cleanPreference({ status: 'available', ...p }), TUE);
  assert.equal(d({ weeks: 'next', days: ['tuesday', 'wednesday'], times: 'afternoons', text: 'Tue or Wed pm' }).text, 'Next week (Mon 19 Oct to Sun 25 Oct) · Tuesday 20 Oct, Wednesday 21 Oct · afternoons');
  assert.deepEqual(d({ weeks: 'next', days: ['tuesday', 'wednesday'], times: 'afternoons', text: 'Tue or Wed pm' }).dayLabels, ['Tuesday 20 Oct', 'Wednesday 21 Oct']);
  assert.equal(d({ weeks: 'following', anyDay: true }).text, 'The week after next (Mon 26 Oct to Sun 1 Nov) · any day'); assert.equal(d({ weeks: 'this', days: ['friday'] }).text, 'This week (Mon 12 Oct to Sun 18 Oct) · Friday 16 Oct');
  assert.equal(d({ anyDay: true }).text, 'any day'); assert.equal(d({ times: 'mornings' }).text, 'mornings'); assert.equal(d({ days: ['monday'] }).text, 'Monday', 'no week known: no invented date');
  assert.equal(d({ weeks: 'other', times: 'evenings', text: 'sometime in November' }).customerWords, 'sometime in November');
  assert.equal(d({ weeks: 'other', text: 'sometime in November' }), null, 'nothing bookable: no summary at all (it used to produce an empty one)'); assert.equal(S.describe(null, TUE), null); assert.equal(S.describe(S.cleanPreference({ text: 'maybe' }), TUE), null);
  const firstDate = (p) => d(p).firstDate;
  assert.equal(firstDate({ weeks: 'next', days: ['wednesday', 'tuesday'] }), '2026-10-20'); assert.equal(firstDate({ weeks: 'following', days: ['thursday'] }), '2026-10-29');
  assert.equal(firstDate({ weeks: 'next', anyDay: true }), '2026-10-19'); assert.equal(firstDate({ weeks: 'next', times: 'mornings' }), '2026-10-19'); assert.equal(firstDate({ days: ['monday'] }), null, 'no week known: no invented date');
});

test('CONSENT: interest, hello, ok, thanks, confusion, a project description and "yes" to the welcome message are NOT agreement: no question about days, ever, until they ask for a visit or say yes to the offer', () => {
  const nothingAboutDays = [
    ['interested in a kitchen', P({ intent: 'new_enquiry', reply: 'Lovely, a shaker kitchen sounds great.' })], ['yes to the welcome message', P({ intent: 'answering_questions', reply: 'Great, thanks Aoife.' })],
    ['project details', P({ intent: 'answering_questions', reply: 'A handleless kitchen sounds lovely.' })], ['already has other quotes', P({ intent: 'new_enquiry', reply: 'That makes sense.' })],
    ['hello', P({ intent: 'greeting', reply: 'Hi Eimear, thanks for getting back to us.' })], ['??', P({ intent: 'greeting', reply: 'Hi Brian, this is Elite Kitchens following up on your kitchen enquiry.' })],
    ['a thumbs-up', P({ intent: 'greeting', reply: 'Lovely, thanks Fiona.' })], ['general price question', P({ intent: 'asking_price_general' })], ['budget mentioned', P({ intent: 'answering_questions', reply: 'Thanks for letting us know.' })],
    ['"not until after Christmas"', P({ intent: 'answering_questions', reply: 'No rush at all.' })]];
  for (const [what, p] of nothingAboutDays) { assert.equal(asksDays(sent(p)), false, what + ': ' + sent(p)); assert.equal(p.preference, null, what); }
  // asked for a visit or agreed to the offer -> now, and only now, the question about days
  for (const v of ['asked', 'agreed']) { const p = P({ visit: v, intent: 'wants_consultation' }, { messages: [out(L.visit_offer), inn('yes please')] }); assert.equal(p.step, 'ask_next_week'); assert.equal(asksDays(sent(p)), true, v); }
  assert.equal(P({ visit: 'asked', intent: 'wants_consultation' }, { messages: [inn('can someone call out to measure?')] }).step, 'ask_next_week', 'they asked for a visit in their own words');
  for (const v of ['asked', 'agreed']) assert.equal(P({ visit: v, intent: 'wants_consultation' }, { messages: [inn('yes')] }).step, 'offer_visit', 'labelled agreement with no offer and no request for a visit: offered, not assumed (audit 16 Oct 2026, finding 5)');
  // volunteering when they are free is agreement too: recorded, nothing asked
  const vol = P({ intent: 'scheduling', ...pref({ weeks: 'next', days: ['tuesday'], text: 'free Tuesday' }) }); assert.equal(vol.step, 'acknowledge'); assert.equal(asksDays(sent(vol)), false); assert.ok(vol.preference && vol.preference.days[0] === 'tuesday');
});

test('ANSWER FIRST, OFFER ONCE: the offer follows the reply to what they said; it is never repeated, never combined with a question about days, and never made to someone who is upset, asked a question or said no', () => {
  const first = P({ intent: 'new_enquiry', ack: 'project', reply: 'Lovely, a shaker kitchen with an island sounds great.' }, { who: { name: 'Anna', projectType: 'Kitchen' } });
  assert.equal(first.step, 'offer_visit'); assert.equal(offersVisit(sent(first)), true); assert.equal(asksDays(sent(first)), false); assert.equal(sent(first), 'Lovely, a new kitchen sounds great. ' + L.visit_offer, 'what they said is acknowledged first, in words written by code');
  assert.equal(sent(P({ intent: 'new_enquiry', reply: 'Lovely, a shaker kitchen with an island sounds great.' })), L.visit_offer, 'the model\'s own sentence is never sent');
  // after the offer: no second offer, no question about days, however they reply without agreeing
  const ctx = { messages: [out(L.visit_offer)], consult: { stage: 'offered_visit', offered: true } };
  for (const o of [{ intent: 'greeting' }, { intent: 'answering_questions', reply: 'Thanks.' }, { intent: 'new_enquiry', reply: 'Nice.' }]) { const p = P(o, ctx); assert.equal(offersVisit(sent(p)) || asksDays(sent(p)), false, JSON.stringify(o)); assert.equal(p.step, 'none'); }
  assert.equal(P({ intent: 'new_enquiry', reply: 'x' }, { consult: { offered: true } }).step, 'none', 'remembered from the record as well as from the chat');
  // a general price question: the owner's line, THEN the offer (once), never days
  const price = P({ intent: 'asking_price_general' }); assert.equal(price.step, 'price_offer'); assert.ok(sent(price).startsWith(L.price_general)); assert.equal(offersVisit(sent(price)), true); assert.equal(asksDays(sent(price)), false);
  assert.equal(P({ intent: 'asking_price_general' }, ctx).step, 'price_general', 'already offered: the price line alone');
  // a question that needs a person: nothing is offered or asked meanwhile
  for (const o of [{ hasQuestion: true, intent: 'asking_info' }, { intent: 'asking_price', handover: { needed: true, reason: 'asks about price' } }, { hasQuestion: true, intent: 'new_enquiry' }])
    { const p = P(o); assert.equal(p.step, 'none'); assert.equal(p.reply, null); }
  // said no / not now: nothing is offered or asked, a person is told
  const no = P({ visit: 'declined' }); assert.equal(no.step, 'none'); assert.equal(no.handover.needed, true);
  assert.equal(P({ visit: 'declined' }, ctx).reply, null);
  // booked: never a visit offer or a question about days
  const booked = P({ intent: 'answering_questions', reply: 'Thanks.' }, { booked: true }); assert.equal(booked.step, 'none');
  // the staff flow (no automatic acknowledgement) follows the same policy, with the greeting opener
  const staff = S.plan({ decision: D({ intent: 'new_enquiry', schedule: { preference: null, opener: 'Hi Anna, thanks for getting in touch.' } }), consult: null, messages: [], booked: false, nowMs: TUE, natural: false }); assert.equal(staff.step, 'offer_visit'); assert.equal(asksDays(sent(staff)), false); assert.match(sent(staff), /^Hi Anna, thanks for getting in touch\./);
});

test('A GREETING gets one friendly acknowledgement and nothing else; after our first reply "ok" and "thanks" need no answer', () => {
  const hello = P({ intent: 'greeting', ack: 'hello', reply: 'Hi Eimear, we are a family-run firm.' }, { who: { name: 'Eimear Byrne' } }); assert.equal(hello.step, 'ack_only'); assert.equal(sent(hello), 'Hi Eimear, thanks for getting back to us.');
  const unsafe = P({ intent: 'greeting', reply: 'Hi, call tomorrow at 5pm?' }); assert.equal(unsafe.step, 'none'); assert.equal(unsafe.handover.needed, true, 'no safe words: a person looks at it, nobody is left in silence without an alert');
  assert.equal(P({ intent: 'greeting', reply: 'Thanks again.' }, { messages: [out(L.visit_offer, 'text'), inn('ok')] }).step, 'none');
  assert.equal(P({ intent: 'greeting', ack: 'thanks' }, { messages: [out('welcome...', 'template')] }).step, 'ack_only', 'our welcome template is not "our first reply"');
});

test('THE FLOW AFTER AGREEMENT: next week, then the following week once, then "no preference"; at most two questions; a customer who gives when they are free is acknowledged and nothing more is asked', () => {
  const agreed = (o = {}, ctx = {}) => P({ visit: 'agreed', intent: 'wants_consultation', ...o }, { ...ctx, consult: { offered: true, ...(ctx.consult || {}) } });       // we offered a visit (the flow records that)
  const q1 = agreed(); assert.equal(q1.step, 'ask_next_week'); assert.equal(q1.handover, null);
  const q2 = agreed({}, { consult: { stage: 'asked_next_week', asks: 1 }, messages: [out(L.ask_next_week)] }); assert.equal(q2.step, 'ask_following_week');
  const q3 = agreed({}, { consult: { stage: 'asked_following_week', asks: 2 }, messages: [out(L.ask_next_week), out(L.ask_following_week)] }); assert.deepEqual([q3.step, q3.handover.needed], ['no_preference', true]);
  const given = agreed(pref({ weeks: 'next', days: ['thursday'], times: 'mornings', text: 'Thursday morning' })); assert.equal(given.step, 'acknowledge'); assert.equal(given.handover.needed, true); assert.equal(asksDays(sent(given)), false);
  assert.equal(given.preference.firstDate, '2026-10-22', 'the first day they named');
  assert.equal(agreed({}, { consult: { stage: 'preference_given', asks: 1 } }).step, 'none', 'already handed over: never asked again');
  const fixed = agreed(pref({ days: ['friday'], text: 'sorry, Friday instead' }), { consult: { stage: 'preference_given', asks: 1 } }); assert.equal(fixed.step, 'acknowledge', 'a customer who corrects their day after the hand-over is recorded again');
  // the first question may carry a short acknowledgement; later ones do not
  assert.equal(sent(agreed({ ack: 'thanks' }, { who: { name: 'Anna' } })), 'Thanks, Anna. ' + L.ask_next_week);
  assert.equal(sent(agreed({ ack: 'thanks' }, { who: { name: 'Anna' }, consult: { asks: 1 }, messages: [out(L.ask_next_week)] })), L.ask_following_week);
  // the model's words about days, prices, promises or questions are never sent
  for (const bad of ['Is Tuesday good?', 'We can do it for 5000 euro', 'See you tomorrow', 'You are booked in']) assert.equal(sent(agreed({ reply: bad })), L.ask_next_week, bad);
  // price + agreement: the owner's line then the first question
  assert.equal(sent(P({ intent: 'asking_price_general', visit: 'asked' }, { messages: [inn('How much is a kitchen? Could someone come out and measure?')] })), L.price_general + ' ' + L.ask_next_week);
});

test('THEY WILL LET US KNOW / ARE NOT AVAILABLE: no booking request, no pressure, their own words are kept; "I work all day" is not evenings; "abroad" is not a preference', () => {
  const t = P({ visit: 'agreed', ...pref({ status: 'tentative', text: 'I will know on Friday' }) });
  assert.deepEqual([t.step, sent(t), t.handover.needed], ['tentative', L.tentative, true]); assert.match(t.preference.text, /I will know on Friday/); assert.deepEqual([t.preference.days, t.preference.times, t.preference.status], [[], null, 'tentative']);
  const abroad = P({ visit: 'agreed', ...pref({ status: 'unavailable', weeks: 'other', text: 'abroad for a few weeks' }) }); assert.equal(abroad.step, 'tentative'); assert.equal(S.reasonable(S.cleanPreference({ status: 'unavailable', weeks: 'other' })), false);
  const allDay = P({ visit: 'agreed', ...pref({ status: 'unavailable', text: 'I work all day' }) }, { consult: { asks: 1 }, messages: [out(L.ask_next_week)] }); assert.equal(allDay.step, 'ask_following_week'); assert.equal(allDay.preference, null, 'no evenings are invented');
  assert.equal(P({ visit: 'agreed', ...pref({ status: 'unavailable', text: 'not that week either' }) }, { consult: { asks: 2 }, messages: [out(L.ask_next_week), out(L.ask_following_week)] }).step, 'no_preference');
  // none of these ever creates a booking request when remembered
  for (const step of ['tentative']) { const a = S.advance(null, step, t.preference, 5); assert.equal(a.needsBooking, undefined); assert.equal(a.stage, 'tentative'); assert.equal(a.note.status, 'tentative'); }
});

test('PREFERENCES ARE KEPT: a day given together with a question that needs a person is recorded and handed over with the question noted; a complaint with a day is not a booking', () => {
  const both = P({ visit: 'agreed', hasQuestion: true, intent: 'asking_info', handover: { needed: true, reason: 'asks if the visit is free' }, ...pref({ weeks: 'next', days: ['monday'], times: 'afternoons', text: 'Monday afternoon works' }) });
  assert.equal(both.step, 'acknowledge'); assert.ok(both.preference && both.preference.days[0] === 'monday' && both.preference.times === 'afternoons'); assert.match(both.handover.reason, /asked something that needs you/); assert.match(both.handover.reason, /asks if the visit is free/);
  const q2 = P({ hasQuestion: true, intent: 'asking_info', ...pref({ days: ['thursday'], text: 'Thursday works' }) }); assert.equal(q2.step, 'acknowledge'); assert.ok(q2.preference);
  const angry = P({ intent: 'complaint', handover: { needed: true, reason: 'upset' }, ...pref({ days: ['tuesday'], text: 'come Tuesday and fix it' }) }); assert.equal(angry.preference, null); assert.equal(angry.step, 'complaint'); assert.equal(angry.reply, L.complaint);
});

test('CANCELLATION IS NOT RESCHEDULING: a booked customer who cancels is asked once if they want to move it; nothing is claimed as done, no days are asked, a person is told; "no, just cancel" goes to a person silently', () => {
  const first = P({ change: 'cancel' }, { booked: true });
  assert.equal(first.step, 'cancel_ask'); assert.equal(sent(first), L.cancel_ask); assert.equal(claimsDone(sent(first)), false); assert.equal(asksDays(sent(first)), false); assert.equal(first.handover.needed, true); assert.equal(first.handover.reason, 'wants to cancel booking'); assert.equal(first.preference, null);
  const second = P({ change: 'cancel' }, { booked: true, messages: [out(L.cancel_ask)] }); assert.deepEqual([second.step, second.reply, second.handover.needed, second.handover.reason], ['none', null, true, 'wants to cancel booking'], 'never asked twice, never a rebooking pitch');
  // they answer "yes, move it": now it is a booking change
  const move = P({ change: 'move' }, { booked: true, messages: [out(L.cancel_ask)] }); assert.equal(move.step, 'change_ask');
  assert.equal(P({ change: 'move', ...pref({ weeks: 'next', days: ['wednesday'], times: 'afternoons', text: 'Wednesday afternoon' }) }, { booked: true, messages: [out(L.cancel_ask)] }).step, 'change_given');
  // cancel never leaves a booking request
  assert.equal(S.advance(null, 'cancel_ask', null, 1), null);
});

test('A BOOKED CUSTOMER: a change is asked about once and then passed on; "tomorrow", "earlier that day", "confirm" and "running late" go to a person with the request, never to next week; nothing is promised', () => {
  const move = (o = {}, ctx = {}) => P({ change: 'move', ...o }, { booked: true, ...ctx });
  const a = move(); assert.deepEqual([a.step, a.reply, a.handover.needed, a.handover.reason], ['change_ask', L.change_ask, true, 'wants to move booking']); assert.doesNotMatch(a.reply, /today|tomorrow|\d/);
  const g = move(pref({ weeks: 'next', days: ['tuesday'], times: 'afternoons', text: 'Tuesday afternoon please' })); assert.deepEqual([g.step, g.reply, g.preference.firstDate], ['change_given', L.acknowledge, '2026-10-20']);
  const asked = move({}, { messages: [out(L.change_ask)] }); assert.deepEqual([asked.step, asked.reply], ['change_pass_on', L.no_preference], 'never asked twice');
  for (const [change, why] of [['move_specific', /specific time/], ['confirm', /confirm/], ['late', /late/]]) { const p = P({ change }, { booked: true }); assert.equal(p.step, 'none'); assert.equal(p.reply, null); assert.match(p.handover.reason, why); }
  // the old marker (a hand-over reason that says "change booking") still works
  assert.equal(P({ handover: { needed: true, reason: 'wants to change booking' } }, { booked: true }).step, 'change_ask');
  // not booked: a "change" means nothing
  assert.notEqual(P({ change: 'cancel' }).step, 'cancel_ask');
  assert.equal(S.advance(null, 'change_ask', null, 1), null); assert.equal(S.advance(null, 'change_given', { text: 'x' }, 1), null, 'a change of a booked consultation leaves no new booking request');
});

test('asked whether it is a person or an AI: one honest line (written by code), handed over, whether or not a consultation is booked', () => {
  for (const booked of [false, true]) { const p = P({ intent: 'other', handover: { needed: true, reason: 'asked if AI' }, reply: 'No, I am Sean' }, { booked }); assert.deepEqual([p.step, p.reply, p.handover.needed, p.handover.reason], ['asked_ai', L.asked_ai, true, 'asked if AI']); assert.doesNotMatch(p.reply, /Sean/); }
});

test('GENERAL PRICE: the owner\'s line only; booked, declined or already handed over: the line alone; with a preference: recorded; a specific price, quote or discount is never answered', () => {
  assert.equal(sent(P({ intent: 'asking_price_general' }, { booked: true })), L.price_general); assert.equal(sent(P({ intent: 'asking_price_general', visit: 'declined' })), L.price_general);
  assert.equal(sent(P({ intent: 'asking_price_general' }, { consult: { stage: 'preference_given' } })), L.price_general);
  const withPref = P({ intent: 'asking_price_general', ...pref({ days: ['friday'], text: 'Fri' }) }); assert.deepEqual([withPref.step, sent(withPref), withPref.handover.needed], ['acknowledge', L.price_general + ' ' + L.acknowledge, true]);
  for (const o of [{ intent: 'asking_price', handover: { needed: true, reason: 'asks about price' } }, { handover: { needed: true, reason: 'wants a discount' }, intent: 'asking_price_general' }]) { const p = P(o); assert.equal(p.step, 'none'); assert.equal(p.reply, null); }
  assert.equal(S.advance(null, 'price_general', null, 1), null);
});

test('WHAT IS REMEMBERED: the offer is remembered once; questions leave no booking request; only a recorded preference or "no preference" does; the flow never moves back', () => {
  assert.deepEqual(S.advance(null, 'offer_visit', null, 1), { stage: 'offered_visit', offered: true }); assert.deepEqual(S.advance(null, 'price_offer', null, 1), { stage: 'offered_visit', offered: true });
  assert.equal(S.advance({ asks: 1, stage: 'asked_next_week' }, 'offer_visit', null, 1), null, 'an offer never overwrites a flow that already asked about days');
  assert.deepEqual(S.advance({ stage: 'offered_visit', offered: true }, 'ask_next_week', null, 5), { stage: 'asked_next_week', asks: 1, offered: true });
  assert.deepEqual(S.advance({ stage: 'asked_next_week', asks: 1 }, 'ask_following_week', null, 5), { stage: 'asked_following_week', asks: 2, offered: true });
  assert.equal(S.advance(null, 'ask_next_week', null, 1).needsBooking, undefined); assert.equal(S.advance({ asks: 1 }, 'ask_following_week', null, 1).needsBooking, undefined);
  assert.deepEqual(S.advance({ stage: 'asked_following_week', asks: 2 }, 'no_preference', null, 5), { stage: 'no_preference', asks: 2, at: 5, needsBooking: true });
  assert.deepEqual(S.advance({ stage: 'asked_next_week', asks: 1 }, 'acknowledge', { text: 'Tue' }, 7), { stage: 'preference_given', asks: 1, preference: { text: 'Tue' }, at: 7, needsBooking: true });
  assert.equal(S.advance({ stage: 'preference_given', asks: 1 }, 'ask_next_week', null, 9), null, 'never move back once handed over'); assert.equal(S.advance({ stage: 'preference_given' }, 'tentative', {}, 9), null);
  assert.equal(S.advance(null, 'none', null, 1), null); assert.equal(S.advance(null, 'ack_only', null, 1), null); assert.equal(S.advance({ stage: 'asked_next_week', asks: 2 }, 'ask_next_week', null, 1).asks, 2, 'the count only goes up');
  assert.deepEqual(S.advance({ stage: 'preference_given', asks: 1 }, 'acknowledge', { text: 'Fri' }, 9).preference, { text: 'Fri' });
});

test('how many scheduling questions were already asked: from the record and from our own earlier messages in the chat; never more than two; the visit offer is not a question about days', () => {
  assert.equal(S.asksSoFar(null, []), 0); assert.equal(S.asksSoFar({ asks: 1 }, []), 1); assert.equal(S.asksSoFar({ asks: 9 }, []), 2); assert.equal(S.asksSoFar({ asks: -3 }, []), 0); assert.equal(S.asksSoFar({ asks: 'x' }, []), 0);
  assert.equal(S.asksSoFar(null, [out('Hi Anna. Would any day next week suit you for a home consultation?'), inn('hello')]), 1, 'typed or sent by the draft: the same');
  assert.equal(S.asksSoFar(null, [out('Do you think next week suits you?')]), 1);
  assert.equal(S.asksSoFar(null, [out('Would any day next week suit you for a visit?'), out('No problem. Would the following week suit you?')]), 2);
  assert.equal(S.asksSoFar({ asks: 1 }, [out('what about the following week?')]), 2); assert.equal(S.asksSoFar(null, [inn('Would any day next week suit you?')]), 0, 'only OUR messages count');
  assert.equal(S.asksSoFar(null, [out(L.visit_offer)]), 0); assert.equal(S.asksSoFar(null, [out(L.change_ask)]), 0, 'the booking-change question is not a first-visit question');
});

test('the opener and the acknowledgement: short, safe, no question, nothing about days, times, prices, promises or AI; anything else is dropped', () => {
  assert.equal(S.opener('Hi Anna, thanks for getting in touch.', false), 'Hi Anna, thanks for getting in touch.'); assert.equal(S.opener('Hello Anna!', false), 'Hello Anna!'); assert.equal(S.opener('Thank you for your enquiry.', false), 'Thank you for your enquiry.');
  assert.equal(S.opener('Hi Anna, thanks for getting in touch.', true), '', 'an ongoing chat has no opener');
  for (const bad of ['Hi Anna, what kind of kitchen?', 'Hi, see you on 5th', 'Hi, we are available any day', 'Hi, your visit is confirmed', 'Hi, I promise', 'Hi, kitchens cost €5k', 'Great idea!', '', null, 'Hi ' + 'x'.repeat(100), 'Hi, thanks for choosing us for your kitchen week']) assert.equal(S.opener(bad, false), '', String(bad));
  assert.equal(S.acknowledgement('Thanks for the details, Aoife.'), 'Thanks for the details, Aoife.'); assert.equal(S.acknowledgement('Lovely, a whole downstairs renovation in Swords sounds like a great project.').length > 0, true);
  for (const bad of ['Is that right?', 'It will cost 5000.', 'We can come tomorrow.', 'Tuesday works for us.', 'Hi, I am a bot.', 'See www.example.com for ideas.', 'Booked for you.', 'Free quote for you.', 'x'.repeat(120), '']) assert.equal(S.acknowledgement(bad), '', bad);
});
