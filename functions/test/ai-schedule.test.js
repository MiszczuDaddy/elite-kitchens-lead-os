// Phase 9 R2a: the consultation-arrangement flow (functions/lib/aiSchedule.js). Pure functions, no database. The wording of every scheduling line is written by code; the flow asks at most
// two questions, stops as soon as there is a reasonable preference, never confirms or promises anything, and records a clear summary with the real dates.
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('../lib/aiSchedule');

const TUE = Date.UTC(2026, 9, 13, 10, 0);          // Tuesday 13 Oct 2026
const dec = (o = {}) => ({ wantsConsultation: true, handover: { needed: false }, schedule: { preference: null, opener: 'Hi Anna, thanks for getting in touch.' }, ...o });
const withPref = (p, opener = '') => dec({ schedule: { preference: S.cleanPreference(p), opener } });
const out = (text) => ({ direction: 'out', body: text }), inn = (text) => ({ direction: 'in', body: text });

test('the scheduling lines are fixed and contain no promise, no date, no availability', () => {
  assert.deepEqual(S.LINES, {
    ask_next_week: 'Would any day next week suit you for a home consultation?',
    ask_following_week: 'No problem. Would the following week suit you? Do you have any particular days or times that work best?',
    acknowledge: 'Perfect, I\'ll pass that on to the team and we\'ll confirm a time shortly.',
    asked_ai: 'I\'m an automated assistant for Elite Kitchens, but I\'ll pass this on to the team and they\'ll be in touch.',
    price_general: 'All our kitchens are different, so each project is priced individually, but most of our kitchens range from €10k to €20k.',
    change_ask: 'No problem, would any day next week suit you better?',
    no_preference: 'No problem, I\'ll pass this on to the team and we\'ll be in touch to arrange a time.' });
  assert.equal(S.MAX_ASKS, 2);
  for (const [k, l] of Object.entries(S.LINES)) if (k !== 'price_general') assert.doesNotMatch(l, /\b(booked|confirmed|available|availability|\d)\b/i, k);
});

test('weeks run Monday to Sunday in Irish time, counted from today', () => {
  assert.equal(S.weekOf(TUE, 'this').label, 'Mon 12 Oct to Sun 18 Oct'); assert.equal(S.weekOf(TUE, 'next').label, 'Mon 19 Oct to Sun 25 Oct'); assert.equal(S.weekOf(TUE, 'following').label, 'Mon 26 Oct to Sun 1 Nov');
  assert.equal(S.weekOf(Date.UTC(2026, 9, 18, 12, 0), 'next').label, 'Mon 19 Oct to Sun 25 Oct', 'on a Sunday, next week starts tomorrow');
  assert.equal(S.weekOf(Date.UTC(2026, 9, 12, 8, 0), 'this').label, 'Mon 12 Oct to Sun 18 Oct', 'on a Monday, this week starts today');
  assert.equal(S.weekOf(Date.UTC(2026, 11, 29, 12, 0), 'next').label, 'Mon 4 Jan to Sun 10 Jan', 'across the new year');
  assert.equal(S.weekOf(Date.UTC(2026, 9, 18, 23, 30), 'this').label, 'Mon 19 Oct to Sun 25 Oct', 'just after midnight in Ireland (23:30 UTC is 00:30 on Monday)');
  assert.equal(S.weekOf(Date.UTC(2026, 9, 22, 12, 0), 'next').days[0].d, 26); assert.equal(S.weekOf(Date.UTC(2026, 9, 22, 12, 0), 'next').days[6].label, undefined);
});

test('what counts as a reasonable preference: a week, days, "any day" or a time of day; "not sure" and silence do not', () => {
  const ok = [{ weeks: 'next' }, { days: ['tuesday'] }, { anyDay: true }, { times: 'mornings' }, { weeks: 'other', text: 'the 28th' }, { days: ['monday', 'friday'], times: 'after 5pm' }];
  for (const p of ok) assert.equal(S.reasonable(S.cleanPreference(p)), true, JSON.stringify(p));
  for (const p of [null, undefined, {}, { text: 'not sure yet, I will let you know' }, { days: [] }, { days: ['funday'] }, { weeks: 'someday' }, { anyDay: 'yes' }, 'tuesday', { times: '   ' }]) assert.equal(S.reasonable(S.cleanPreference(p)), false, JSON.stringify(p));
  const c = S.cleanPreference({ weeks: 'next', days: ['Tuesday', 'tuesday', 'WEDNESDAY', 'x'], times: ' afternoons ', text: 'y'.repeat(400) });
  assert.deepEqual([c.weeks, c.days, c.times, c.text.length <= 160], ['next', ['tuesday', 'wednesday'], 'afternoons', true]);
});

test('the summary for the person who books it: the real dates, the days, the time of day, the customer\'s own words', () => {
  const d = (p) => S.describe(S.cleanPreference(p), TUE);
  assert.equal(d({ weeks: 'next', days: ['tuesday', 'wednesday'], times: 'afternoons', text: 'Tue or Wed pm' }).text, 'Next week (Mon 19 Oct to Sun 25 Oct) · Tuesday 20 Oct, Wednesday 21 Oct · afternoons');
  assert.deepEqual(d({ weeks: 'next', days: ['tuesday', 'wednesday'], times: 'afternoons', text: 'Tue or Wed pm' }).dayLabels, ['Tuesday 20 Oct', 'Wednesday 21 Oct']);
  assert.equal(d({ weeks: 'following', anyDay: true }).text, 'The week after next (Mon 26 Oct to Sun 1 Nov) · any day'); assert.equal(d({ weeks: 'this', days: ['friday'] }).text, 'This week (Mon 12 Oct to Sun 18 Oct) · Friday 16 Oct');
  assert.equal(d({ anyDay: true }).text, 'any day'); assert.equal(d({ times: 'mornings' }).text, 'mornings'); assert.equal(d({ days: ['monday'] }).text, 'Monday', 'no week known: no invented date');
  assert.equal(d({ weeks: 'other', text: 'sometime in November' }).text, ''); assert.equal(d({ weeks: 'other', times: 'evenings', text: 'sometime in November' }).customerWords, 'sometime in November');
  assert.equal(S.describe(null, TUE), null); assert.equal(S.describe(S.cleanPreference({ text: 'maybe' }), TUE), null);
});

test('a GENERAL price question is answered with the owner\'s own line, followed by the next consultation question when one is due; a specific price, a quote or a discount is not answered', () => {
  const g = (o = {}, extra = {}) => S.plan({ decision: dec({ intent: 'asking_price_general', wantsConsultation: false, schedule: { preference: null, opener: '' }, ...o }), consult: null, messages: [], booked: false, nowMs: TUE, ...extra });
  const alone = g(); assert.deepEqual([alone.step, alone.reply, alone.handover], ['price_general', S.LINES.price_general, null], 'no consultation asked yet and none wanted: just the price line');
  const both = g({ wantsConsultation: true }); assert.deepEqual([both.step, both.reply], ['ask_next_week', S.LINES.price_general + ' ' + S.LINES.ask_next_week], 'the price line, then the usual question (the step counts as the first question)');
  assert.equal(g({ wantsConsultation: true }, { consult: { stage: 'asked_next_week', asks: 1 } }).reply, S.LINES.price_general + ' ' + S.LINES.ask_following_week);
  assert.equal(g({ wantsConsultation: true }, { consult: { stage: 'preference_given', asks: 1 } }).reply, S.LINES.price_general, 'already handed over: just the price line');
  assert.equal(g({ wantsConsultation: true }, { booked: true }).step, 'price_general', 'booked: just the price line');
  const withPref = g({ wantsConsultation: true, schedule: { preference: S.cleanPreference({ days: ['friday'], text: 'Fri' }), opener: '' } }); assert.deepEqual([withPref.step, withPref.reply, withPref.handover.needed], ['acknowledge', S.LINES.price_general + ' ' + S.LINES.acknowledge, true]);
  assert.equal(g({ intent: 'asking_price', handover: { needed: true, reason: 'asks about price' } }).step, 'none', 'a specific price is not answered here');
  assert.equal(g({ handover: { needed: true, reason: 'wants a discount' } }).step, 'none');
  assert.equal(S.advance(null, 'price_general', null, 1), null);
});

test('asked whether it is a person or an AI: one honest line (written by code, never by the model), handed over, whether or not a consultation is booked', () => {
  for (const booked of [false, true]) { const p = S.plan({ decision: dec({ wantsConsultation: false, handover: { needed: true, reason: 'asked if AI' }, reply: 'No, I am Sean' }), consult: null, messages: [], booked, nowMs: TUE }); assert.deepEqual([p.step, p.reply, p.handover.needed, p.handover.reason], ['asked_ai', S.LINES.asked_ai, true, 'asked if AI']); assert.match(p.reply, /automated assistant/); assert.doesNotMatch(p.reply, /Sean/); }
  assert.equal(S.advance(null, 'asked_ai', null, 1), null);
});

test('changing a booked consultation: ask about next week once; if they already said when, or we already asked, only pass it on; never today or tomorrow', () => {
  const change = (o = {}, extra = {}) => S.plan({ decision: dec({ wantsConsultation: false, handover: { needed: true, reason: 'wants to change booking' }, ...o }), consult: null, messages: [], booked: true, nowMs: TUE, ...extra });
  const a = change(); assert.deepEqual([a.step, a.reply, a.handover.needed, a.handover.reason], ['change_ask', 'No problem, would any day next week suit you better?', true, 'wants to change booking']); assert.doesNotMatch(a.reply, /today|tomorrow|\d/);
  const g = change({ schedule: { preference: { weeks: 'next', days: ['tuesday'], times: 'afternoons', text: 'Tuesday afternoon please' } } }); assert.deepEqual([g.step, g.reply, g.preference.firstDate], ['change_given', S.LINES.acknowledge, '2026-10-20']);
  const asked = change({}, { messages: [{ direction: 'out', body: 'No problem, would any day next week suit you better?' }] }); assert.deepEqual([asked.step, asked.reply], ['change_pass_on', S.LINES.no_preference], 'never asked twice');
  assert.equal(S.plan({ decision: dec({ wantsConsultation: false, handover: { needed: true, reason: 'upset customer' } }), consult: null, messages: [], booked: true, nowMs: TUE }).step, 'none', 'other hand-overs are left alone');
  assert.equal(S.plan({ decision: dec({ handover: { needed: true, reason: 'wants to change booking' } }), consult: null, messages: [], booked: false, nowMs: TUE }).step, 'none', 'not booked: not a change');
  assert.equal(S.advance(null, 'change_ask', null, 1), null); assert.equal(S.advance(null, 'change_given', { text: 'x' }, 1), null, 'a change of a booked consultation leaves no request to book');
});

test('R2b: the date the booking form opens on is the first day they named; with only a week it is the Monday of that week; with no week it is nothing', () => {
  const d = (p) => S.describe(S.cleanPreference(p), TUE);
  assert.equal(d({ weeks: 'next', days: ['wednesday', 'tuesday'] }).firstDate, '2026-10-20'); assert.equal(d({ weeks: 'following', days: ['thursday'] }).firstDate, '2026-10-29');
  assert.equal(d({ weeks: 'next', anyDay: true }).firstDate, '2026-10-19'); assert.equal(d({ weeks: 'next', times: 'mornings' }).firstDate, '2026-10-19');
  assert.equal(d({ days: ['monday'] }).firstDate, null, 'no week known: no invented date'); assert.equal(d({ anyDay: true }).firstDate, null);
});

test('R2b: only the two hand-over steps leave the customer waiting for a person to book; asking questions does not', () => {
  assert.equal(S.advance(null, 'ask_next_week', null, 1).needsBooking, undefined); assert.equal(S.advance({ asks: 1 }, 'ask_following_week', null, 1).needsBooking, undefined);
  assert.equal(S.advance({ asks: 2 }, 'acknowledge', { text: 'x' }, 1).needsBooking, true); assert.equal(S.advance({ asks: 2 }, 'no_preference', null, 1).needsBooking, true);
});

test('how many scheduling questions were already asked: from what a person sent, and from our own earlier messages in the chat; never more than two', () => {
  assert.equal(S.asksSoFar(null, []), 0); assert.equal(S.asksSoFar({ asks: 1 }, []), 1); assert.equal(S.asksSoFar({ asks: 9 }, []), 2); assert.equal(S.asksSoFar({ asks: -3 }, []), 0); assert.equal(S.asksSoFar({ asks: 'x' }, []), 0);
  assert.equal(S.asksSoFar(null, [out('Hi Anna. Would any day next week suit you for a home consultation?'), inn('hello')]), 1, 'typed or sent by the draft: the same');
  assert.equal(S.asksSoFar(null, [out('Do you think next week suits you?')]), 1);
  assert.equal(S.asksSoFar(null, [out('Would any day next week suit you?'), out('No problem. Would the following week suit you?')]), 2);
  assert.equal(S.asksSoFar({ asks: 1 }, [out('what about the following week?')]), 2); assert.equal(S.asksSoFar(null, [inn('Would any day next week suit you?')]), 0, 'only OUR messages count');
});

test('the opener: only the first message of a conversation, a short greeting or thanks, never a question or anything about times, promises or prices', () => {
  assert.equal(S.opener('Hi Anna, thanks for getting in touch.', false), 'Hi Anna, thanks for getting in touch.'); assert.equal(S.opener('Hello Anna!', false), 'Hello Anna!'); assert.equal(S.opener('Thank you for your enquiry.', false), 'Thank you for your enquiry.');
  for (const bad of ['Hi Anna, thanks for getting in touch.']) assert.equal(S.opener(bad, true), '', 'an ongoing chat has no opener');
  for (const bad of ['Hi Anna, what kind of kitchen?', 'Hi, see you on 5th', 'Hi, we are available any day', 'Hi, your visit is confirmed', 'Hi, I promise', 'Hi, kitchens cost €5k', 'Great idea!', '', null, 'Hi ' + 'x'.repeat(100), 'Hi, thanks for choosing us for your kitchen week'])
    assert.equal(S.opener(bad, false), '', String(bad));
});

test('THE FLOW: ask next week, then the following week, stop at any reasonable preference, never more than two questions, no promise', () => {
  const plan = (decision, o = {}) => S.plan({ decision, consult: null, messages: [], booked: false, nowMs: TUE, ...o });
  // first contact: the opener plus ask 1
  const first = plan(dec());
  assert.deepEqual([first.step, first.reply, first.handover], ['ask_next_week', 'Hi Anna, thanks for getting in touch. Would any day next week suit you for a home consultation?', null]);
  // an ongoing chat: no opener
  assert.equal(plan(dec(), { messages: [out('Hi Anna, thanks!'), inn('yes please')] }).reply, 'Would any day next week suit you for a home consultation?');
  // next week did not work: ask 2, once
  const second = plan(dec(), { consult: { stage: 'asked_next_week', asks: 1 }, messages: [out('Would any day next week suit you?'), inn('not next week sorry')] });
  assert.deepEqual([second.step, second.reply, second.handover], ['ask_following_week', S.LINES.ask_following_week, null]);
  // a reasonable preference: acknowledge + hand over, with the summary
  const given = plan(withPref({ weeks: 'following', days: ['wednesday'], times: 'mornings', text: 'Wednesday morning the week after' }), { consult: { stage: 'asked_following_week', asks: 2 } });
  assert.equal(given.step, 'acknowledge'); assert.equal(given.reply, S.LINES.acknowledge); assert.deepEqual(given.handover, { needed: true, reason: 'consultation preference received: over to you to book' });
  assert.equal(given.preference.text, 'The week after next (Mon 26 Oct to Sun 1 Nov) · Wednesday 28 Oct · mornings');
  // already stated availability: nothing is asked
  const already = plan(withPref({ days: ['thursday'] }), { messages: [inn('Hi, I want a kitchen, Thursday suits me for a visit')] }); assert.equal(already.step, 'acknowledge'); assert.equal(already.reply, S.LINES.acknowledge);
  // after two questions and still nothing: hand over
  const none = plan(dec(), { consult: { stage: 'asked_following_week', asks: 2 } }); assert.deepEqual([none.step, none.reply, none.handover], ['no_preference', S.LINES.no_preference, { needed: true, reason: 'no preference given after two questions' }]);
  assert.equal(plan(dec(), { messages: [out('Would any day next week suit you?'), out('Would the following week suit you?')] }).step, 'no_preference', 'two questions typed by a person count too');
  // "not sure" is not a preference
  assert.equal(plan(withPref({ text: 'not sure yet' })).step, 'ask_next_week');
  // already handed over, nothing new: say nothing about scheduling
  assert.equal(plan(dec(), { consult: { stage: 'preference_given', asks: 1 } }).step, 'none'); assert.equal(plan(withPref({ days: ['friday'] }), { consult: { stage: 'preference_given', asks: 1 } }).step, 'acknowledge', 'an updated preference is acknowledged again');
  // not about a consultation, already booked, or handed over for another reason: nothing about scheduling
  for (const [d, o] of [[dec({ wantsConsultation: false }), {}], [dec(), { booked: true }], [dec({ handover: { needed: true, reason: 'upset' } }), {}]]) assert.deepEqual(plan(d, o), { step: 'none', reply: null, handover: null, preference: null });
  // the model's own wording about times is never used
  const sneaky = plan(dec({ reply: 'We are free Tuesday at 10, see you then!', schedule: { preference: null, opener: 'Hi, we can do Tuesday at 3.' } }));
  assert.equal(sneaky.reply, S.LINES.ask_next_week); assert.doesNotMatch(sneaky.reply, /Tuesday|\d/);
  for (const p of [first, second, given, none]) assert.doesNotMatch(p.reply, /\b(booked|confirmed for|see you|available on)\b/i);
});

test('what is remembered once a person sent the suggested message: the flow moves on, never back, and a discarded draft changes nothing', () => {
  assert.deepEqual(S.advance(null, 'ask_next_week', null, 5), { stage: 'asked_next_week', asks: 1 });
  assert.deepEqual(S.advance({ stage: 'asked_next_week', asks: 1 }, 'ask_following_week', null, 5), { stage: 'asked_following_week', asks: 2 });
  assert.deepEqual(S.advance({ stage: 'asked_following_week', asks: 2 }, 'no_preference', null, 5), { stage: 'no_preference', asks: 2, at: 5, needsBooking: true });
  assert.deepEqual(S.advance({ stage: 'asked_next_week', asks: 1 }, 'acknowledge', { text: 'Tue' }, 7), { stage: 'preference_given', asks: 1, preference: { text: 'Tue' }, at: 7, needsBooking: true });
  assert.equal(S.advance({ stage: 'preference_given', asks: 1 }, 'ask_next_week', null, 9), null, 'never move back once handed over');
  assert.equal(S.advance(null, 'none', null, 1), null); assert.equal(S.advance({ stage: 'asked_next_week', asks: 2 }, 'ask_next_week', null, 1).asks, 2, 'the count only goes up');
  assert.deepEqual(S.advance({ stage: 'preference_given', asks: 1 }, 'acknowledge', { text: 'Fri' }, 9).preference, { text: 'Fri' });
});

test('R3: the automatic receptionist puts a short checked acknowledgement before the FIRST question only; the staff flow and every other line stay exactly as they were', () => {
  const d = (reply, o = {}) => dec({ reply, ...o });
  const nat = (decision, extra = {}) => S.plan({ decision, consult: null, messages: [], booked: false, nowMs: TUE, natural: true, ...extra });
  assert.equal(nat(d('Thanks for the details, Aoife.')).reply, 'Thanks for the details, Aoife. ' + S.LINES.ask_next_week);
  const bare = { schedule: { preference: null, opener: '' } };
  assert.equal(nat(d('Is that right?', bare)).reply, S.LINES.ask_next_week, 'a question in the acknowledgement: dropped'); assert.equal(nat(d('It costs 5000', bare)).reply, S.LINES.ask_next_week); assert.equal(nat(d('', bare)).reply, S.LINES.ask_next_week);
  assert.equal(S.plan({ decision: d('Thanks for the details, Aoife.', bare), consult: null, messages: [], booked: false, nowMs: TUE }).reply, S.LINES.ask_next_week, 'the staff flow does not use it');
  assert.equal(nat(d('Thanks for the details, Aoife.', bare), { consult: { stage: 'asked_next_week', asks: 1 } }).reply, S.LINES.ask_following_week, 'no acknowledgement in front of the second question');
  assert.equal(nat(d('Thanks!', { schedule: { preference: S.cleanPreference({ days: ['friday'], text: 'Fri' }) } })).reply, S.LINES.acknowledge, 'the "I\'ll pass that on" line is never changed');
  assert.equal(nat(d('Thanks for the details, Aoife.', { wantsConsultation: false })).step, 'none', 'the plan itself still needs a consultation request (the receptionist sets it for ordinary enquiries)');
});
