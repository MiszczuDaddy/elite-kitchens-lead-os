// Phase 9 R1: the logic behind the reply-suggestion panel (public/reply-model.js): whether a sent message was the draft as suggested or an edit, and how the server's answer is presented.
const { test } = require('node:test');
const assert = require('node:assert');
const M = require('../../public/reply-model.js');

test('outcome: the draft sent exactly (ignoring spacing) is "unchanged"; anything else is "edited"', () => {
  assert.equal(M.outcomeOf('Hello there.', 'Hello there.'), 'used_unchanged'); assert.equal(M.outcomeOf('Hello  there.\n', '  Hello there.'), 'used_unchanged');
  assert.equal(M.outcomeOf('Hello there.', 'Hello there, Anna.'), 'used_edited'); assert.equal(M.outcomeOf('Hello', ''), 'used_edited'); assert.equal(M.outcomeOf('', ''), 'used_edited', 'an empty draft is never "unchanged"');
});

test('the panel view: readiness tone, known / from-chat / missing lists, warnings, handover and model labels come straight from the server answer; bad shapes are tolerated', () => {
  const v = M.viewOf({ draftId: 'ad_x', draft: 'Hi', model: 'haiku', costEur: 0.0004, structured: true, readiness: { state: 'almost', label: 'Wants a consultation: details still needed' },
    known: [{ label: 'Name', value: 'Anna' }], fromChat: [{ label: 'Preferred time', value: 'Tue' }], missing: [{ label: 'Project' }], warnings: ['contains a link'], handover: { needed: false, reason: null } });
  assert.deepEqual([v.readiness.tone, v.modelLabel, v.cost, v.otherLabel, v.handover, v.missing, v.warnings], ['warn', 'Haiku', 'under €0.001', 'Sonnet', false, ['Project'], ['contains a link']]);
  assert.deepEqual(v.known, [{ label: 'Name', value: 'Anna' }]); assert.deepEqual(v.fromChat, [{ label: 'Preferred time', value: 'Tue' }]);
  const s = M.viewOf({ model: 'sonnet', costEur: 0.0123, readiness: { state: 'handover', label: 'Hand over' }, handover: { needed: true, reason: 'upset' } });
  assert.deepEqual([s.otherLabel, s.cost, s.readiness.tone, s.handover, s.handoverReason, s.draft, s.known], ['Haiku', '€0.012', 'bad', true, 'upset', '', []]);
  assert.equal(M.viewOf({ readiness: { state: 'ready' } }).readiness.tone, 'good'); assert.equal(M.viewOf({ readiness: { state: 'booked' } }).readiness.tone, 'info'); assert.equal(M.viewOf({ structured: false }).structured, false);
  assert.equal(M.viewOf(null), null); assert.equal(M.viewOf('x'), null); assert.deepEqual(M.viewOf({ known: 'no', missing: 5, warnings: null }).known, []);
});
