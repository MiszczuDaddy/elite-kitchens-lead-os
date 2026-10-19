// Phase 12: who gets the evening-before reminder (functions/lib/bookingRules.js, shared with the screen). Pure functions: no emulator, no browser. Every name is made up.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const R = require('../lib/bookingRules');

const H = 3600e3, NOW = Date.UTC(2026, 9, 20, 16, 30), START = NOW + 17 * H;           // Tuesday 20 Oct 17:30 Irish time; the visit is tomorrow at 10:30
const ts = (t) => ({ toMillis: () => t });
const visit = (over = {}) => ({ type: 'consultation', status: 'scheduled', start: ts(START), createdAt: ts(NOW - 2 * 24 * H), updatedAt: ts(NOW - 2 * 24 * H), ...over });

test('a reminder is due for a visit to come that was booked or changed at least 4 hours ago and has not been reminded for this time', () => {
  assert.equal(R.reminderDue(visit(), NOW), true);
  assert.equal(R.reminderDue(visit({ updatedAt: ts(NOW - 3 * H) }), NOW), false, 'booked or changed 3 hours ago: the customer has just heard the time');
  assert.equal(R.reminderDue(visit({ updatedAt: ts(NOW - 4 * H) }), NOW), true, 'exactly 4 hours: due');
  assert.equal(R.reminderDue(visit({ updatedAt: undefined, createdAt: ts(NOW - H) }), NOW), false, 'no change time: the booking time counts');
  assert.equal(R.reminderDue(visit({ visitReminder: { for: START, at: NOW - H } }), NOW), false, 'already reminded about this time');
  assert.equal(R.reminderDue(visit({ visitReminder: { for: START - H, at: NOW - 30 * H } }), NOW), true, 'reminded about an OLD time: the new time gets one');
  assert.equal(R.reminderDue(visit({ visitReminder: { for: ts(START), at: ts(NOW - H) } }), NOW), false, 'a stored time stamp works as well as a number');
  assert.equal(R.reminderDue(visit({ start: ts(NOW - 5) }), NOW), false, 'past');
  assert.equal(R.reminderDue(visit({ start: undefined }), NOW), false);
  assert.equal(R.reminderDue(null, NOW), false);
});

test('only consultations and site visits are reminded; other, installation, cancelled and finished visits never are', () => {
  for (const type of ['other', 'installation', undefined, 'surprise']) assert.equal(R.reminderDue(visit({ type }), NOW), false, String(type));
  for (const status of ['cancelled', 'done', undefined]) assert.equal(R.reminderDue(visit({ status }), NOW), false, String(status));
  assert.equal(R.reminderDue(visit({ type: 'site_visit' }), NOW), true);
});

test('the words for the screen: nothing, "Reminder sent", or what went wrong', () => {
  assert.deepEqual(R.describe(visit(), NOW), { state: 'none', text: '' });
  assert.deepEqual(R.describe(visit({ visitReminder: { for: START, at: NOW } }), NOW), { state: 'told', text: 'Reminder sent' });
  assert.equal(R.describe(visit({ visitReminder: { for: START - H, at: NOW } }), NOW).state, 'none', 'a reminder for an older time is not "sent" for this one');
  const unknown = R.describe(visit({ noticeIssue: { kind: 'reminder', state: 'unknown', text: 'x', at: NOW } }), NOW);
  assert.deepEqual([unknown.state, unknown.issue, unknown.kind], ['issue', 'unknown', 'reminder']); assert.match(unknown.text, /did not say whether the reminder arrived/);
  const failed = R.describe(visit({ noticeIssue: { kind: 'reminder', state: 'failed', text: 'WhatsApp does not know this template', at: NOW } }), NOW);
  assert.equal(failed.state, 'failed'); assert.equal(failed.text, 'The reminder could not be sent: WhatsApp does not know this template');
  assert.equal(R.describe(visit({ type: 'other', noticeIssue: { kind: 'reminder', state: 'unknown', at: NOW } }), NOW).state, 'none');
  assert.equal(R.describe(visit({ start: ts(NOW - H), noticeIssue: { kind: 'reminder', state: 'unknown', at: NOW } }), NOW).state, 'none', 'a visit that has passed needs nothing');
  assert.equal(R.describe(visit({ status: 'cancelled', noticeIssue: { kind: 'reminder', state: 'unknown', at: NOW } }), NOW).state, 'none');
});

test('there is no message about a visit except the reminder', () => {
  assert.deepEqual(R.KINDS, ['reminder']); assert.equal(R.nextAction, undefined, 'no confirmation, change or cancellation message exists any more');
});

test('the browser copy public/booking-rules.js is identical to functions/lib/bookingRules.js, and loads as BookingRules', () => {
  const a = fs.readFileSync(path.join(__dirname, '../lib/bookingRules.js')), b = fs.readFileSync(path.join(__dirname, '../../public/booking-rules.js'));
  assert.ok(a.equals(b));
  const box = {}; vm.runInNewContext(b.toString(), box);
  assert.equal(typeof box.BookingRules.reminderDue, 'function');
});
