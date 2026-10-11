// Phase 7: the logic behind the Projects screen (public/project-model.js): the five steps, what is waiting to be ordered, the one-line status, the dashboard
// filters and counts, and the order of the list. No emulator, no browser.
const { test } = require('node:test');
const assert = require('node:assert');
const M = require('../../public/project-model.js');
const PR = require('../lib/projects');

const project = (ticked = [], extra = {}) => ({ status: 'active', steps: Object.fromEntries(M.STEPS.map((s) => [s.key, { done: ticked.includes(s.key) }])), ...extra });
const ts = (ms) => ({ toMillis: () => ms });

test('the five steps are exactly the owner\'s checklist, in that order, and the screen and the server agree on their names', () => {
  assert.deepEqual(M.STEPS.map((s) => s.label), ['Final 3D design approved', 'Carcasses ordered', 'Doors ordered', 'Ready for installation', 'Installation completed']);
  assert.deepEqual(M.STEPS.map((s) => s.key), PR.STEPS, 'project-model.js and functions/lib/projects.js must list the same steps');
});

test('doors and carcasses are independent: each one waits (or not) on its own, whatever else is ticked', () => {
  const k = (...keys) => M.waitingFor(project(keys));
  assert.deepEqual(k(), ['carcasses', 'doors']);
  assert.deepEqual(k('doorsOrdered'), ['carcasses'], 'doors ordered first: only the carcasses are still to order');
  assert.deepEqual(k('carcassesOrdered'), ['doors']);
  assert.deepEqual(k('carcassesOrdered', 'doorsOrdered'), []);
  assert.deepEqual(k('designApproved'), ['carcasses', 'doors'], 'an approved design does not mean anything is ordered');
  assert.deepEqual(k('readyForInstall', 'installed'), ['carcasses', 'doors'], 'nothing is assumed from later steps');
  assert.deepEqual(M.waitingFor(project([], { status: 'completed' })), [], 'a completed project waits for nothing');
  assert.deepEqual(M.waitingFor(null), []); assert.deepEqual(M.waitingFor({}), ['carcasses', 'doors']);
});

test('the one-line status: the most advanced fact wins, and an order gap is never hidden', () => {
  const s = (keys, extra) => M.statusOf(project(keys, extra)).key;
  assert.equal(s([]), 'design'); assert.equal(s(['designApproved']), 'to-order');
  assert.equal(s(['designApproved', 'carcassesOrdered']), 'to-order'); assert.equal(s(['doorsOrdered']), 'design');
  assert.equal(s(['carcassesOrdered', 'doorsOrdered']), 'ordered'); assert.equal(s(['designApproved', 'carcassesOrdered', 'doorsOrdered']), 'ordered');
  assert.equal(s(['readyForInstall']), 'ready'); assert.equal(s(['readyForInstall', 'installed']), 'installed'); assert.equal(s(['installed']), 'installed');
  assert.equal(s(['designApproved'], { status: 'completed' }), 'completed');
  assert.match(M.statusOf(project(['designApproved'])).label, /order what is missing/);
  assert.deepEqual(M.progress(project(['designApproved', 'doorsOrdered'])), { done: 2, total: 5 });
});

test('dashboard filters and counts: active, carcasses to order, doors to order, ready for installation, completed', () => {
  const list = [
    project([]),                                                                                  // 0 active, waiting for both
    project(['designApproved', 'doorsOrdered']),                                                  // 1 waiting for carcasses
    project(['designApproved', 'carcassesOrdered']),                                              // 2 waiting for doors
    project(['designApproved', 'carcassesOrdered', 'doorsOrdered', 'readyForInstall']),           // 3 ready
    project(['carcassesOrdered', 'doorsOrdered', 'readyForInstall', 'installed']),                // 4 installed, not yet completed
    project(['designApproved'], { status: 'completed' }),                                         // 5 completed (even with nothing ordered)
  ];
  const ids = (f) => list.map((p, i) => (M.matches(p, f) ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(ids('active'), [0, 1, 2, 3, 4]); assert.deepEqual(ids('carcasses'), [0, 1]); assert.deepEqual(ids('doors'), [0, 2]);
  assert.deepEqual(ids('ready'), [3], 'ready for installation = ticked ready and not yet installed'); assert.deepEqual(ids('completed'), [5]);
  assert.deepEqual(M.counts(list), { active: 5, carcasses: 2, doors: 2, ready: 1, completed: 1 });
  assert.deepEqual(M.counts([]), { active: 0, carcasses: 0, doors: 0, ready: 0, completed: 0 }); assert.deepEqual(M.counts(null), { active: 0, carcasses: 0, doors: 0, ready: 0, completed: 0 });
});

test('the list: the soonest installation first, no date last, then the newest; completed: the most recently completed first', () => {
  const a = { id: 'a', installDate: '2026-12-01', createdAt: ts(1) }, b = { id: 'b', installDate: '2026-11-05', createdAt: ts(2) }, c = { id: 'c', installDate: null, createdAt: ts(9) },
    d = { id: 'd', installDate: null, createdAt: ts(5) }, e = { id: 'e', installDate: '2026-11-05', createdAt: ts(7) };
  assert.deepEqual(M.sorted([a, b, c, d, e], 'active').map((p) => p.id), ['e', 'b', 'a', 'c', 'd']);
  assert.deepEqual(M.sorted([{ id: 'x', completedAt: ts(1) }, { id: 'y', completedAt: ts(3) }, { id: 'z', completedAt: ts(2) }], 'completed').map((p) => p.id), ['y', 'z', 'x']);
  const input = [a, b]; M.sorted(input, 'active'); assert.deepEqual(input.map((p) => p.id), ['a', 'b'], 'sorting never changes the list it was given');
});

test('search finds a project by customer name (accents ignored), quote number or phone digits; nothing typed shows everything', () => {
  const list = [{ id: 1, customerName: 'Siobhán Ó Briain', quoteRef: 'EK-0104', phone: '353851234567' }, { id: 2, customerName: 'Brian Byrne', quoteRef: null, phone: '353869999999' }];
  const ids = (q) => M.search(list, q).map((p) => p.id);
  assert.deepEqual(ids('siobhan'), [1]); assert.deepEqual(ids('0104'), [1]); assert.deepEqual(ids('ek-0104'), [1]); assert.deepEqual(ids('9999'), [2]); assert.deepEqual(ids('brian'), [2]);
  assert.deepEqual(ids('  '), [1, 2]); assert.deepEqual(ids(''), [1, 2]); assert.deepEqual(ids('zzz'), []);
  assert.deepEqual(ids('12'), [], 'fewer than three digits never matches a phone number');
  assert.deepEqual(M.search(list, 'anna', (p) => (p.id === 2 ? 'Anna' : 'Other')).map((p) => p.id), [2], 'the name shown on screen is what is searched');
});

test('dates and the reopened-quote note', () => {
  assert.equal(M.dateLabel('2026-11-20'), '20 Nov 2026'); assert.equal(M.dateLabel('2026-01-05'), '5 Jan 2026'); assert.equal(M.dateLabel(''), ''); assert.equal(M.dateLabel(null), ''); assert.equal(M.dateLabel('tomorrow'), '');
  assert.match(M.quoteNote({ quoteStatus: 'reopened' }), /reopened after it was accepted/); assert.equal(M.quoteNote({ quoteStatus: 'accepted' }), ''); assert.equal(M.quoteNote(null), '');
});
