// Phase 9.1 formatting work: the customer summary is built by code (functions/lib/aiSummary.js), so every model gives the same answer. Pure functions, no database.
// What matters: a fact that is not in the records is never invented ("not recorded"), free-text budgets are only reshaped when the meaning is clear, test records are flagged briefly,
// and the template always comes out in the same order.
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('../lib/aiSummary');

test('budget: clear cases become €XX,XXX–€XX,XXX; anything unclear is shown exactly as recorded, never guessed', () => {
  const b = (x) => S.budgetOf(x).text;
  const cases = [['15-20k', '€15,000–€20,000'], ['15k-20k', '€15,000–€20,000'], ['€15,000 - €20,000', '€15,000–€20,000'], ['€15,000–€20,000', '€15,000–€20,000'], ['15 000 to 20 000', '€15,000–€20,000'], ['10k to 15k', '€10,000–€15,000'],
    ['20k-15k', '€15,000–€20,000'], ['€5k', '€5,000'], ['5k', '€5,000'], ['€12,500', '€12,500'], ['under 10k', 'Up to €10,000'], ['up to €8,000', 'Up to €8,000'], ['over 20k', 'Over €20,000'], ['30k+', 'Over €30,000'],
    ['around 12k', 'Around €12,000'], ['€1.5m', '€1,500,000']];
  for (const [raw, want] of cases) assert.equal(b(raw), want, raw);
  for (const raw of ['flexible', 'not sure', '15-20', '3', '€200', '1k, 2k, 3k', 'Budget: tbc', '99999999999']) { const r = S.budgetOf(raw); assert.equal(r.parsed, false, raw); assert.equal(r.text, raw + ' (as recorded)', raw); }
  for (const raw of ['', null, undefined, '   ']) assert.equal(S.budgetOf(raw).text, null);
  assert.equal(S.budgetOf('x'.repeat(200)).text.length <= 80, true);
});

test('Eircode: taken from the saved address first, then the notes; a missing or conflicting code is not recorded, never guessed', () => {
  assert.equal(S.eircodeOf('12 Main Street, Swords, K67 X123'), 'K67 X123');
  assert.equal(S.eircodeOf('12 Main Street, k67x123'), 'K67 X123');
  assert.equal(S.eircodeOf('Estate, D6W F4E2'), 'D6W F4E2');
  assert.equal(S.eircodeOf('12 Main Street, Swords', 'Eircode: D02 X285'), 'D02 X285', 'the notes are used when the address has none');
  assert.equal(S.eircodeOf('Address K67 X123', 'Eircode: D02 X285'), 'K67 X123', 'the saved address wins');
  assert.equal(S.eircodeOf('K67 X123 or D02 X285'), null, 'two different codes: a conflict, so not recorded');
  assert.equal(S.eircodeOf('K67 X123, K67X123'), 'K67 X123', 'the same code twice is one code');
  for (const none of [null, undefined, '', '12 Main Street', 'Eircode: unknown', 'K67 X12', 'B12 3456', 5]) assert.equal(S.eircodeOf(none), null, String(none));
});

test('dates and quote status: Irish time in one fixed shape; a sent quote past its valid-until date says so', () => {
  assert.equal(S.when(Date.UTC(2026, 9, 20, 9, 0)), 'Tue 20 Oct 2026, 10:00');         // summer time
  assert.equal(S.when(Date.UTC(2026, 11, 8, 9, 5)), 'Tue 8 Dec 2026, 09:05');          // winter time
  assert.equal(S.dayLabel('2026-11-20'), '20 Nov 2026'); assert.equal(S.dayLabel('nonsense'), '');
  const today = '2026-10-13';
  assert.equal(S.quoteLabel({ status: 'sent', validUntil: '2026-11-12' }, today), 'Sent'); assert.equal(S.quoteLabel({ status: 'sent', validUntil: '2026-10-01' }, today), 'Sent (expired)');
  assert.equal(S.quoteLabel({ status: 'accepted', validUntil: '2026-10-01' }, today), 'Accepted'); assert.equal(S.quoteLabel({ status: 'draft' }, today), 'Draft'); assert.equal(S.quoteLabel({ status: 'declined' }, today), 'Declined');
  assert.equal(S.quoteLabel({ status: 'weird' }, today), 'weird'); assert.equal(S.quoteLabel(null, today), 'Unknown');
});

test('test records: flagged from fixed signals, briefly (at most three reasons); an ordinary record is not flagged', () => {
  assert.deepEqual(S.testReasons({ name: 'Anna Kowalska', email: 'anna@gmail.com', phone: '353851234599', notes: 'Wants a shaker kitchen.', quoteRefs: ['EK-0104'] }), []);
  assert.deepEqual(S.testReasons({ name: 'Test Customer' }), ['name contains "test"']);
  assert.deepEqual(S.testReasons({ name: 'Demo Person', quoteRefs: ['EK-0001'] }), ['name contains "demo"']);
  assert.deepEqual(S.testReasons({ email: 'someone@example.com' }), ['test-style email address']); assert.deepEqual(S.testReasons({ email: 'test@gmail.com' }), ['test-style email address']);
  assert.deepEqual(S.testReasons({ email: 'a@staff.test.dev' }), ['test-style email address']);
  assert.deepEqual(S.testReasons({ phone: '353860000000' }), ['placeholder-looking phone number']); assert.deepEqual(S.testReasons({ phone: '353851234567' }), ['placeholder-looking phone number']);
  assert.deepEqual(S.testReasons({ notes: 'this is a test lead' }), ['notes mention "test"']); assert.deepEqual(S.testReasons({ quoteRefs: ['EK-0104', 'TEST-0003'] }), ['test-numbered quote TEST-0003']);
  assert.equal(S.testReasons({ name: 'Test X', email: 't@example.com', phone: '353860000000', notes: 'test', quoteRefs: ['TEST-1'] }).length, 3, 'never more than three reasons');
  for (const fine of ['Contest Winner', 'Attest Murphy', 'Fastest Kitchens']) assert.deepEqual(S.testReasons({ name: fine }), [], fine);
  assert.deepEqual(S.testReasons({}), []);
});

test('notes: only what is useful at a glance; lead-form boilerplate, the address, the Eircode and the budget are left out (they have their own lines)', () => {
  const lead = 'Meta lead · Kitchen form · 11 Oct 2026\nLead ID: 123456789\nRequirements: Shaker kitchen with island | Wants quartz worktop\nOther answers:\n• Eircode / postcode: K67 X123\n• Estimated budget: 15-20k\n• Home address: 12 Main St\n• Preferred contact time: Evenings';
  assert.equal(S.notesOf({ notes: lead, projectType: 'Kitchen' }), 'Kitchen · Requirements: Shaker kitchen with island | Wants quartz worktop · Preferred contact time: Evenings');
  assert.equal(S.notesOf({ notes: 'Wants shaker doors.' }), 'Wants shaker doors.');
  assert.equal(S.notesOf({ notes: '', projectType: '', project: null }), null); assert.equal(S.notesOf({}), null); assert.equal(S.notesOf({ notes: 'Lead ID: 1\nOther answers:' }), null);
  assert.equal(S.notesOf({ notes: 'Call after 5pm', project: 'Project: Everything ordered, installation 20 Nov 2026' }), 'Call after 5pm · Project: Everything ordered, installation 20 Nov 2026');
  assert.equal(S.notesOf({ notes: 'same\nsame', projectType: 'same' }), 'same', 'no repeats');
  const long = S.notesOf({ notes: Array.from({ length: 40 }, (_, i) => 'line number ' + i + ' ' + 'x'.repeat(50)).join('\n') }); assert.ok(long.length <= 260 && long.endsWith('…'));
});

test('the template: always the same fields in the same order; missing facts are labelled, never invented; Notes only when there is something; the test warning comes last', () => {
  const full = { name: 'Anna Kowalska', budget: '€15,000–€20,000', location: 'Swords', eircode: 'K67 X123', latestQuote: { ref: 'EK-0104', label: 'Sent' }, nextAppointment: 'Tue 20 Oct 2026, 10:00', notes: 'Kitchen · wants quartz', testReasons: [] };
  assert.equal(S.formatSummary(full), ['**Anna Kowalska**', '- Budget: €15,000–€20,000', '- Location: Swords', '- Eircode: K67 X123', '- Latest quote: EK-0104 — Sent', '- Next appointment: Tue 20 Oct 2026, 10:00', '- Notes: Kitchen · wants quartz'].join('\n'));
  const sparse = S.formatSummary({ name: 'Brian Byrne' });
  assert.equal(sparse, ['**Brian Byrne**', '- Budget: not recorded', '- Location: not recorded', '- Eircode: not recorded', '- Latest quote: none yet', '- Next appointment: none scheduled'].join('\n'));
  assert.ok(!/Notes/.test(sparse));
  const test = S.formatSummary({ ...full, testReasons: ['name contains "test"', 'test-numbered quote TEST-0003'] });
  assert.ok(test.endsWith('\n\n⚠ Possible test record: name contains "test"; test-numbered quote TEST-0003.'));
  assert.match(S.formatSummary({}), /^\*\*Unnamed customer\*\*/);
  const labels = (s) => s.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2, l.indexOf(':')));
  assert.deepEqual(labels(full && S.formatSummary(full)), ['Budget', 'Location', 'Eircode', 'Latest quote', 'Next appointment', 'Notes']);
  assert.equal(S.formatSummary({ name: 'x'.repeat(300) }).split('\n')[0].length <= 90, true);
});
