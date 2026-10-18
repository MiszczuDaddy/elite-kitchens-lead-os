// Phase 12: which message a visit needs next (functions/lib/bookingRules.js, shared with the screen). Pure functions: no emulator, no browser. Every name is made up.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const R = require('../lib/bookingRules');

const H = 3600e3, NOW = Date.UTC(2026, 9, 20, 16, 30), START = NOW + 17 * H;           // Tuesday 20 Oct 17:30 Irish time; the visit is tomorrow
const ts = (t) => ({ toMillis: () => t });
const visit = (over = {}) => ({ type: 'consultation', status: 'scheduled', start: ts(START), ...over });
const told = (over = {}) => ({ kind: 'confirmation', toldStart: START, at: NOW - 6 * H, reminderFor: null, ...over });

test('the button: confirmation for a coming visit nobody told; change when the time moved; cancellation when a told visit was cancelled; otherwise nothing', () => {
  assert.equal(R.nextAction(visit(), NOW), 'confirmation');
  assert.equal(R.nextAction(visit({ customerNotice: told() }), NOW), null, 'already told this time');
  assert.equal(R.nextAction(visit({ customerNotice: told({ toldStart: START - 2 * H }) }), NOW), 'change');
  assert.equal(R.nextAction(visit({ status: 'cancelled', customerNotice: told() }), NOW), 'cancellation');
  assert.equal(R.nextAction(visit({ status: 'cancelled' }), NOW), null, 'never told: nothing to take back');
  assert.equal(R.nextAction(visit({ status: 'cancelled', customerNotice: told({ kind: 'cancellation' }) }), NOW), null, 'already told it was cancelled');
  assert.equal(R.nextAction(visit({ start: ts(NOW - 1) }), NOW), null, 'a visit in the past needs no confirmation');
  assert.equal(R.nextAction(visit({ start: ts(NOW - 1), customerNotice: told({ toldStart: NOW - 5 * H }) }), NOW), null);
  assert.equal(R.nextAction(visit({ status: 'done' }), NOW), null);
  assert.equal(R.nextAction(null, NOW), null);
});

test('only consultations and site visits message the customer; other and installation never do', () => {
  for (const type of ['other', 'installation', undefined, 'surprise']) { assert.equal(R.nextAction(visit({ type }), NOW), null, String(type)); assert.equal(R.reminderDue(visit({ type, customerNotice: told() }), NOW), false); }
  assert.equal(R.nextAction(visit({ type: 'site_visit' }), NOW), 'confirmation');
});

test('the reminder is due only when the customer was told the CURRENT time, not in the last 4 hours, and has not been reminded for this time', () => {
  assert.equal(R.reminderDue(visit({ customerNotice: told() }), NOW), true);
  assert.equal(R.reminderDue(visit(), NOW), false, 'never told: no reminder');
  assert.equal(R.reminderDue(visit({ customerNotice: told({ at: NOW - 3 * H }) }), NOW), false, 'told 3 hours ago: they have just heard it');
  assert.equal(R.reminderDue(visit({ customerNotice: told({ at: NOW - 4 * H }) }), NOW), true, 'exactly 4 hours: due');
  assert.equal(R.reminderDue(visit({ customerNotice: told({ reminderFor: START }) }), NOW), false, 'already reminded for this time');
  assert.equal(R.reminderDue(visit({ customerNotice: told({ reminderFor: START - H }) }), NOW), true, 'reminded for an OLD time: the new time gets one');
  assert.equal(R.reminderDue(visit({ customerNotice: told({ toldStart: START - H }) }), NOW), false, 'moved and the customer was not told: no reminder with a time they do not know');
  assert.equal(R.reminderDue(visit({ status: 'cancelled', customerNotice: told() }), NOW), false);
  assert.equal(R.reminderDue(visit({ customerNotice: told({ kind: 'cancellation' }) }), NOW), false);
  assert.equal(R.reminderDue(visit({ start: ts(NOW - 5), customerNotice: told({ toldStart: NOW - 5 }) }), NOW), false, 'past');
  assert.equal(R.reminderDue(visit({ customerNotice: { kind: 'confirmation', toldStart: ts(START), at: ts(NOW - 6 * H) } }), NOW), true, 'a stored time stamp works as well as a number');
});

test('the words for the screen', () => {
  assert.equal(R.describe(visit(), NOW).text, 'The customer has not been told yet');
  assert.equal(R.describe(visit({ customerNotice: told() }), NOW).text, 'The customer was told');
  assert.equal(R.describe(visit({ customerNotice: told({ reminderFor: START }) }), NOW).text, 'The customer was told, and reminded');
  assert.equal(R.describe(visit({ customerNotice: told({ toldStart: START - H }) }), NOW).next, 'change');
  assert.equal(R.describe(visit({ status: 'cancelled', customerNotice: told() }), NOW).next, 'cancellation');
  assert.equal(R.describe(visit({ type: 'other' }), NOW).state, 'none');
});

test('the browser copy public/booking-rules.js is identical to functions/lib/bookingRules.js, and loads as BookingRules', () => {
  const a = fs.readFileSync(path.join(__dirname, '../lib/bookingRules.js')), b = fs.readFileSync(path.join(__dirname, '../../public/booking-rules.js'));
  assert.ok(a.equals(b));
  const box = {}; vm.runInNewContext(b.toString(), box);
  assert.equal(typeof box.BookingRules.nextAction, 'function');
});
