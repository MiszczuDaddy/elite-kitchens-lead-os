// Phase 9 R2b: when a consultation request card is shown, what it says, and the clash line in the booking form (public/consult-model.js). Pure functions.
const { test } = require('node:test');
const assert = require('node:assert');
const M = require('../../public/consult-model.js');

const NOW = Date.UTC(2026, 9, 15, 10, 0), TODAY = '2026-10-15';
const ts = (ms) => ({ toMillis: () => ms });
const pref = { summary: 'Next week (Mon 19 Oct to Sun 25 Oct) · Tuesday 20 Oct · afternoons', text: 'Tuesday afternoon would suit me', firstDate: '2026-10-20' };
const conv = (over = {}) => ({ id: '353871234567', name: 'Anna', consult: { stage: 'preference_given', needsBooking: true, preference: pref, at: NOW - 60000 }, ...over });

test('a request shows only when handed over, waiting for booking, and the customer has no appointment still to come', () => {
  const none = new Set(), r = M.requestOf(conv(), none, TODAY);
  assert.deepEqual([r.phone, r.noPreference, r.text, r.bookOn, r.customerWords], ['353871234567', false, pref.summary, '2026-10-20', 'Tuesday afternoon would suit me']);
  assert.equal(M.requestOf(conv(), null, TODAY), null, 'nothing is shown until the appointments have loaded');
  assert.equal(M.requestOf(conv(), new Set(['353871234567']), TODAY), null, 'a customer with an appointment to come has no card');
  assert.equal(M.requestOf(conv({ consult: { stage: 'preference_given', needsBooking: false, preference: pref } }), none, TODAY), null, '"Not needed" clears it');
  assert.equal(M.requestOf(conv({ consult: { stage: 'asked_next_week', asks: 1 } }), none, TODAY), null, 'still asking: not handed over yet');
  assert.equal(M.requestOf({ id: '1', name: 'x' }, none, TODAY), null);
});

test('no preference after two questions: a request with no days; the booking date is the first named day, never in the past', () => {
  const r = M.requestOf(conv({ consult: { stage: 'no_preference', needsBooking: true, asks: 2, at: NOW } }), new Set(), TODAY);
  assert.deepEqual([r.noPreference, r.text, r.bookOn], [true, '', null]);
  assert.equal(M.openDate('2026-10-20', TODAY), '2026-10-20'); assert.equal(M.openDate('2026-10-15', TODAY), '2026-10-15'); assert.equal(M.openDate('2026-10-14', TODAY), null, 'yesterday: the form uses its own default');
  assert.equal(M.openDate(null, TODAY), null); assert.equal(M.openDate('20 Oct', TODAY), null);
});

test('the time the booking form opens on follows what they said about the time of day', () => {
  const t = M.openTime;
  assert.deepEqual(['after 3pm', 'after 3 pm', 'after 3', '4-6pm', 'at 2:30pm', '11am', '8am', 'around 9', '7:40am'].map(t), ['15:00', '15:00', '15:00', '16:00', '14:30', '11:00', '08:00', '09:00', '07:30']);
  assert.deepEqual(['mornings', 'afternoons', 'evenings', 'lunchtime'].map(t), ['10:00', '14:00', '18:00', '13:00']);
  assert.deepEqual(['', null, undefined, 'whenever', 'after 10pm', '12am', 'x'].map(t), [null, null, null, null, null, null, null], 'anything unclear or outside 6:00-21:45: the form keeps its normal default');
  const r = M.requestOf(conv({ consult: { stage: 'preference_given', needsBooking: true, preference: { ...pref, times: 'after 3pm' } } }), new Set(), TODAY); assert.equal(r.bookAt, '15:00');
  assert.equal(M.requestOf(conv({ consult: { stage: 'no_preference', needsBooking: true } }), new Set(), TODAY).bookAt, null);
});

test('the count and the booked set', () => {
  const booked = M.bookedPhones([{ phone: '353871234567', status: 'scheduled', end: ts(NOW + 3600000) }, { phone: '353870000001', status: 'cancelled', end: ts(NOW + 3600000) }, { phone: '353870000002', status: 'scheduled', end: ts(NOW - 3600000) }], NOW);
  assert.deepEqual([...booked], ['353871234567'], 'only a scheduled appointment that has not ended counts');
  const convs = [conv(), conv({ id: '353870000001', name: 'Bo' }), conv({ id: '353870000002', consult: undefined })];
  assert.equal(M.countOf(convs, booked, TODAY), 1); assert.equal(M.countOf(convs, null, TODAY), 0);
});

test('the latest messages: the last few, as short plain lines, media named, empties skipped', () => {
  const rows = M.excerpt([{ direction: 'in', body: 'Hi' }, { direction: 'out', body: 'Hello' }, { direction: 'in', type: 'image', body: '' }, { direction: 'in', body: '' }, { direction: 'in', body: 'x'.repeat(400) }], 3);
  assert.equal(rows.length, 3); assert.deepEqual(rows[0], { mine: true, text: 'Hello' }); assert.equal(rows[1].text, '[image]'); assert.ok(rows[2].text.length <= 220);
});

test('the clash line: what is booked that day, and a warning only when the chosen time overlaps', () => {
  const H = 3600000, at = (h) => Date.UTC(2026, 9, 20, h, 0);       // October is Irish summer time (UTC+1)
  const list = [{ id: 'a', status: 'scheduled', start: ts(at(9)), end: ts(at(10)), customerName: 'Tomasz' }, { id: 'b', status: 'cancelled', start: ts(at(13)), end: ts(at(14)), customerName: 'Gone' }];
  assert.deepEqual(M.dayNote([], at(9), at(10)), { text: 'Nothing else booked that day.', clash: false });
  const free = M.dayNote(list, at(12), at(13)); assert.equal(free.clash, false); assert.match(free.text, /^Already booked that day: 10:00–11:00 Tomasz\.$/); assert.doesNotMatch(free.text, /Gone/, 'cancelled ones are not shown');
  const clash = M.dayNote(list, at(9) + H / 2, at(10) + H / 2); assert.equal(clash.clash, true); assert.match(clash.text, /^Clashes with: 10:00–11:00 Tomasz\.$/);
  assert.equal(M.dayNote(list, at(10), at(11)).clash, false, 'back to back is not a clash');
  assert.equal(M.dayNote(list, at(9), at(10), 'a').clash, false, 'the appointment being edited does not clash with itself');
});
