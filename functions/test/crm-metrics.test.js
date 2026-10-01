// Phase 4: pipeline maths (public/crm.js), tested as plain functions. No emulator needed.
const { test } = require('node:test');
const assert = require('node:assert');
const C = require('../../public/crm.js');

const D = (iso) => Date.parse(iso);
const NOW = D('2026-10-15T12:00:00Z');
const ts = (iso) => ({ toMillis: () => D(iso) });                      // looks like a Firestore Timestamp
const conv = (id, o = {}) => ({ id, name: 'N' + id, createdAt: ts('2026-10-02T09:00:00Z'), updatedAt: ts('2026-10-10T09:00:00Z'), ...o });
const rows = (convs, contacts = []) => C.buildRows(convs, contacts);

test('stages: the five backend values map to the five pipeline labels; unknown or missing = New lead', () => {
  assert.deepEqual(C.STAGES, ['inbox', 'booked', 'quoted', 'won', 'closed']);
  assert.equal(C.LABELS.inbox, 'New lead'); assert.equal(C.LABELS.closed, 'Closed');
  for (const v of [undefined, null, '', 'archived', 'Booked', 42]) assert.equal(C.stageOf({ inboxStatus: v }), 'inbox');
  assert.equal(C.stageOf(null), 'inbox'); assert.equal(C.stageOf({ inboxStatus: 'won' }), 'won');
});

test('old-shape customers never break: no dates, no quote value, no contact, odd values', () => {
  const r = rows([{ id: '1' }, { id: '2', inboxStatus: 'quoted' }, { id: '3', createdAt: null, stageDates: {}, name: null },
    { id: '4', inboxStatus: 'won', stageDates: { won: 'garbage' } }], [{ id: '2', quoteValue: 'lots' }, { id: '4', quoteValue: -3 }]);
  assert.equal(r.length, 4);
  for (const x of r) assert.equal(x.quoteValue, null);
  assert.equal(r[3].stageDates.won, null);
  const o = C.overview(r, null); assert.equal(o.won.count, 1); assert.equal(o.won.value, 0); assert.equal(o.won.avg, null);
  assert.equal(C.daysInStage(r[0], NOW), null); assert.equal(C.daysInStage(r[1], NOW), null);
  assert.deepEqual(C.overview([], null).quoteToWon, { num: 0, den: 0 });
  assert.equal(C.rate({ num: 0, den: 0 }), '—');
});

test('rows join the conversation with the contact (quote value, source, name)', () => {
  const [r] = rows([conv('7', { name: 'WA name', inboxStatus: 'quoted', stageDates: { quoted: ts('2026-10-05T10:00:00Z') } })],
    [{ id: '7', name: 'Anna Murphy', source: 'Meta Ads', quoteValue: 14500, location: 'Swords', projectType: 'Kitchen' }]);
  assert.deepEqual([r.name, r.source, r.quoteValue, r.location, r.projectType, r.status], ['Anna Murphy', 'Meta Ads', 14500, 'Swords', 'Kitchen', 'quoted']);
  assert.equal(r.stageDates.quoted, D('2026-10-05T10:00:00Z'));
});

test('lanes: grouped by stage with counts, quoted value and a count of quotes still missing a value', () => {
  const r = rows([conv('1'), conv('2', { inboxStatus: 'quoted' }), conv('3', { inboxStatus: 'quoted' }), conv('4', { inboxStatus: 'won' }), conv('5', { inboxStatus: 'closed' })],
    [{ id: '2', quoteValue: 14500 }, { id: '3' }, { id: '4', quoteValue: 16000 }]);
  const l = C.lanes(r);
  assert.deepEqual(C.STAGES.map((s) => l[s].rows.length), [1, 0, 2, 1, 1]);
  assert.equal(l.quoted.value, 14500); assert.equal(l.quoted.missingValue, 1); assert.equal(l.won.value, 16000);
});

test('Dublin periods: this month and custom ranges use Irish calendar days, across the clock change', () => {
  const m = C.rangeFor('month', NOW);
  assert.equal(new Date(m.from).toISOString(), '2026-09-30T23:00:00.000Z');       // 1 Oct 00:00 in Dublin (summer time)
  assert.equal(new Date(m.to).toISOString(), '2026-11-01T00:00:00.000Z');         // 1 Nov 00:00 (clocks went back on 25 Oct)
  const c = C.rangeFor('custom', NOW, { from: '2026-10-26', to: '2026-10-26' });
  assert.equal(new Date(c.from).toISOString(), '2026-10-26T00:00:00.000Z'); assert.equal(new Date(c.to).toISOString(), '2026-10-27T00:00:00.000Z');
  assert.equal(C.rangeFor('all', NOW), null); assert.equal(C.rangeFor('custom', NOW, {}), null);
  assert.deepEqual(C.rangeFor('custom', NOW, { from: '2026-10-01' }).to, null);
  assert.ok(C.inRange(D('2026-10-31T23:59:59Z'), m)); assert.ok(!C.inRange(D('2026-11-01T00:00:00Z'), m)); assert.ok(!C.inRange(null, m));
  assert.equal(new Date(C.rangeFor('30d', NOW).from).toISOString(), '2026-09-15T23:00:00.000Z');
});

function sample() {      // a small, realistic month
  const convs = [
    conv('1', { createdAt: ts('2026-10-01T10:00:00Z') }),                                                                             // new lead
    conv('2', { createdAt: ts('2026-10-02T10:00:00Z'), inboxStatus: 'booked', stageDates: { booked: ts('2026-10-04T10:00:00Z') } }),
    conv('3', { createdAt: ts('2026-10-03T10:00:00Z'), inboxStatus: 'quoted', stageDates: { booked: ts('2026-10-05T10:00:00Z'), quoted: ts('2026-10-08T10:00:00Z') } }),
    conv('4', { createdAt: ts('2026-10-03T10:00:00Z'), inboxStatus: 'quoted', stageDates: { quoted: ts('2026-10-09T10:00:00Z') } }),    // quoted, no value yet
    conv('5', { createdAt: ts('2026-09-10T10:00:00Z'), inboxStatus: 'won', stageDates: { quoted: ts('2026-09-20T10:00:00Z'), won: ts('2026-10-06T10:00:00Z') } }),
    conv('6', { createdAt: ts('2026-10-04T10:00:00Z'), inboxStatus: 'won', stageDates: { booked: ts('2026-10-05T10:00:00Z'), quoted: ts('2026-10-07T10:00:00Z'), won: ts('2026-10-12T10:00:00Z') } }),
    conv('7', { createdAt: ts('2026-10-04T10:00:00Z'), inboxStatus: 'closed', stageDates: { booked: ts('2026-10-06T10:00:00Z'), quoted: ts('2026-10-09T10:00:00Z'), closed: ts('2026-10-14T10:00:00Z') } }),
    conv('8', { createdAt: ts('2026-10-05T10:00:00Z'), inboxStatus: 'closed', stageDates: { closed: ts('2026-10-06T10:00:00Z') } }),            // lost before booking
    conv('9', { createdAt: ts('2026-10-06T10:00:00Z'), inboxStatus: 'quoted', stageDates: { quoted: ts('2026-10-10T10:00:00Z'), won: ts('2026-10-11T10:00:00Z') } }),  // was Won, moved back: not a win
  ];
  const contacts = [{ id: '3', quoteValue: 14500 }, { id: '5', quoteValue: 20000 }, { id: '6', quoteValue: 16000 }, { id: '7', quoteValue: 9000 }, { id: '9', quoteValue: 8000 }];
  return rows(convs, contacts);
}

test('overview for a month: counts, values, average job and conversion', () => {
  const o = C.overview(sample(), C.rangeFor('month', NOW));
  assert.equal(o.newLeads, 8);                                              // 1,2,3,4,6,7,8,9 were created in October; 5 was September
  assert.equal(o.booked, 4);                                                // 2,3,6,7 entered Booked this month
  assert.deepEqual(o.quoted, { count: 5, value: 14500 + 16000 + 9000 + 8000 });   // entered Quoted in October: 3,4,6,7,9 (5 was quoted in September; 4 has no value yet)
  assert.equal(o.won.count, 2); assert.equal(o.won.value, 36000); assert.equal(o.won.avg, 18000);   // 5 and 6 only; 9 was moved back out of Won
  assert.equal(o.closed, 2);
  assert.deepEqual(o.openQuotes, { count: 3, value: 14500 + 8000, missingValue: 1 });
  assert.deepEqual(o.leadToBooked, { num: 6, den: 8 });                     // 2,3,4,6,7,9 reached Booked or later; 1 and 8 did not
  assert.deepEqual(o.quoteToWon, { num: 1, den: 5 });                       // of the 8 October leads, 5 reached Quoted (3,4,6,7,9); only 6 is Won
});

test('Closed means lost: a Won customer stays Won and counts as a win; Closed is never a win and never adds value', () => {
  const o = C.overview(sample(), null);
  assert.equal(o.won.count, 2); assert.equal(o.won.value, 36000);
  assert.equal(o.closed, 2);
  assert.ok(o.won.value === 20000 + 16000);
  const rr = rows([conv('1', { inboxStatus: 'closed', stageDates: { won: ts('2026-10-06T10:00:00Z'), closed: ts('2026-10-14T10:00:00Z') } })], [{ id: '1', quoteValue: 5000 }]);
  assert.equal(C.overview(rr, null).won.count, 0);                          // even with an old win date: current stage decides
});

test('all-time view counts customers from before stage dates existed by their current stage', () => {
  const legacy = rows([conv('1', { inboxStatus: 'won' }), conv('2', { inboxStatus: 'quoted' }), conv('3', { inboxStatus: 'booked' }), conv('4', { inboxStatus: 'closed' }), conv('5')],
    [{ id: '1', quoteValue: 12000 }, { id: '2', quoteValue: 7000 }]);
  const o = C.overview(legacy, null);
  assert.equal(o.newLeads, 5); assert.equal(o.won.count, 1); assert.equal(o.won.value, 12000);
  assert.equal(o.quoted.count, 2);                                          // quoted + won both necessarily had a quote
  assert.equal(o.booked, 3); assert.equal(o.closed, 1);
  assert.deepEqual(o.quoteToWon, { num: 1, den: 2 }); assert.deepEqual(o.leadToBooked, { num: 3, den: 5 });
  const month = C.overview(legacy, C.rangeFor('month', NOW));               // undated customers do not pollute a specific period
  assert.equal(month.won.count, 0); assert.equal(month.quoted.count, 0); assert.equal(month.booked, 0);
});

test('conversion can never exceed 100% and shows a plain fraction until there are enough customers', () => {
  const o = C.overview(sample(), null);
  assert.ok(o.quoteToWon.num <= o.quoteToWon.den); assert.ok(o.leadToBooked.num <= o.leadToBooked.den);
  assert.equal(C.rate({ num: 3, den: 4 }), '3 of 4'); assert.equal(C.rate({ num: 3, den: 9 }), '3 of 9 · 33%'); assert.equal(C.rate({ num: 0, den: 0 }), '—');
});

test('filters: stage-independent search, source and added-date; digits match Irish and international forms', () => {
  const r = rows([conv('353851111111', { name: 'Anna Murphy', location: 'Swords' }), conv('353862222222', { name: 'Brian', createdAt: ts('2026-08-01T10:00:00Z') })],
    [{ id: '353851111111', source: 'Meta Ads', projectType: 'Kitchen' }, { id: '353862222222', source: 'Referral' }]);
  assert.deepEqual(C.filterRows(r, { query: 'anna' }).map((x) => x.id), ['353851111111']);
  assert.deepEqual(C.filterRows(r, { query: 'swords' }).length, 1);
  assert.deepEqual(C.filterRows(r, { query: '085 111 1111' }).length, 1);
  assert.deepEqual(C.filterRows(r, { query: '+353 86 222 2222' }).length, 1);
  assert.deepEqual(C.filterRows(r, { query: 'meta' }).length, 1);
  assert.deepEqual(C.filterRows(r, { source: 'Referral' }).map((x) => x.name), ['Brian']);
  assert.deepEqual(C.filterRows(r, { added: C.rangeFor('month', NOW) }).map((x) => x.name), ['Anna Murphy']);
  assert.deepEqual(C.filterRows(r, {}).length, 2); assert.deepEqual(C.sourcesOf(r), ['Meta Ads', 'Referral']);
});

test('days in stage: from the stage date, from the lead date for New lead, unknown for old customers', () => {
  const [a, b, c] = rows([conv('1', { createdAt: ts('2026-10-13T09:00:00Z') }), conv('2', { inboxStatus: 'quoted', stageDates: { quoted: ts('2026-10-05T12:00:00Z') } }), conv('3', { inboxStatus: 'won' })]);
  assert.equal(C.daysInStage(a, NOW), 2); assert.equal(C.daysInStage(b, NOW), 10); assert.equal(C.daysInStage(c, NOW), null);
});

test('money: typed values are cleaned; junk is rejected rather than guessed', () => {
  assert.equal(C.parseMoney('€14,500'), 14500); assert.equal(C.parseMoney(' 14500 '), 14500); assert.equal(C.parseMoney('14.5k'), 14500);
  assert.equal(C.parseMoney('14500.40'), 14500); assert.equal(C.parseMoney(''), null); assert.equal(C.parseMoney(null), null);
  for (const bad of ['abc', '14,5,0x', '€-5', '1e5', '12.345', '14500 euro']) assert.ok(Number.isNaN(C.parseMoney(bad)), bad);
  assert.equal(C.money(14500), '€14,500'); assert.equal(C.money(null), '');
});
