// Phase 10: the arithmetic behind "Needs attention" (public/attention-model.js). Pure functions, no emulator, no browser. Everything is made up.
const { test } = require('node:test');
const assert = require('node:assert');
const M = require('../../public/attention-model.js');

const NOW = Date.UTC(2026, 9, 18, 9, 0), MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const t = (ms) => ({ toMillis: () => ms });

test('what needs a person: open problems (newest first), hand-over alerts that did not reach a phone, open rejected leads; nothing else counts', () => {
  const s = M.build({
    issues: [{ id: 'lead_key', kind: 'lead_key', status: 'open', title: 'Leads are arriving with the wrong key', help: 'Check Make.', openedAt: t(NOW - 2 * HOUR), count: 3 },
      { id: 'whatsapp_auth', kind: 'whatsapp_auth', status: 'open', title: 'WhatsApp is refusing', openedAt: t(NOW - HOUR), alert: { state: 'failed' } },
      { id: 'ai_budget', kind: 'ai_budget', status: 'resolved', title: 'x', openedAt: t(NOW) }],
    convs: [{ id: '353871110071', name: 'Aoife', receptionist: { notifyFailed: { at: t(NOW - 5 * MIN), why: 'handover: price', alert: { emailOk: true } } } }, { id: '353871110072', receptionist: { on: true } }],
    leads: [{ id: 'L1', leadId: 'L1', status: 'open', name: 'Sean', phoneTyped: '087 12', reasonText: 'Bad number', receivedAt: t(NOW - DAY) }, { id: 'L2', status: 'dismissed', name: null }],
    heartbeats: { healthSweepAt: t(NOW - 5 * MIN) },
  }, NOW);
  assert.deepEqual(s.problems.map((p) => p.kind), ['whatsapp_auth', 'lead_key']);
  assert.equal(s.problems[0].alert, 'failed'); assert.equal(s.problems[1].count, 3);
  assert.deepEqual(s.alerts.map((a) => [a.phone, a.emailed]), [['353871110071', true]]);
  assert.deepEqual(s.leads.map((l) => [l.leadId, l.phoneTyped, l.reason]), [['L1', '087 12', 'Bad number']]);
  assert.equal(s.count, 4);
  assert.equal(M.build({}, NOW).count, 0);
});

test('the health check itself stopping is shown as a problem (nothing else could report it), but not before it has ever run', () => {
  assert.equal(M.build({ heartbeats: { healthSweepAt: t(NOW - 25 * MIN) } }, NOW).count, 0);
  const s = M.build({ heartbeats: { healthSweepAt: t(NOW - 45 * MIN) } }, NOW);
  assert.equal(s.count, 1); assert.equal(s.problems[0].kind, 'health_check_stopped'); assert.equal(s.problems[0].local, true, 'no "Mark as fixed" for it');
  assert.equal(M.build({ heartbeats: null }, NOW).count, 0);
  assert.match(M.checksText(null, NOW), /has not run yet/);
  assert.match(M.checksText({ healthSweepAt: t(NOW - 3 * MIN) }, NOW), /3 minutes ago\. It checks every 10 minutes/);
  assert.match(M.checksText({ healthSweepAt: t(NOW - 2 * HOUR) }, NOW), /overdue/);
});

test('words: the bar, the backups line, the do-not-contact note; the lead warning setting accepts 0 to 720 whole hours only', () => {
  assert.equal(M.barText(1), '1 thing needs attention'); assert.equal(M.barText(3), '3 things need attention');
  assert.match(M.backupText(null, NOW), /no restore test recorded yet/);
  assert.match(M.backupText({ lastDrillAt: t(NOW - DAY), ok: true, backupTime: '2026-10-17T02:00:00Z' }, NOW), /last restore test 17 Oct 2026 of the backup taken 17 Oct 2026: OK\.$/);
  assert.match(M.backupText({ lastDrillAt: t(NOW - 200 * DAY), ok: true }, NOW), /over 4 months old/);
  assert.match(M.backupText({ lastDrillAt: t(NOW - DAY), ok: false }, NOW), /FAILED/);
  for (const [v, want] of [['72', 72], ['0', 0], ['720', 720], [' 24 ', 24], ['721', null], ['-1', null], ['1.5', null], ['', null], ['abc', null], [null, null]]) assert.equal(M.hoursOf(v), want, String(v));
  assert.equal(M.dncText(null, NOW), null); assert.equal(M.dncText({ on: false }, NOW), null);
  assert.match(M.dncText({ on: true, source: 'customer', by: 'customer', at: t(NOW - 5 * MIN), note: 'The customer asked us to stop messaging them.' }, NOW), /^The customer asked us to stop messaging them \(5 minutes ago\)\. Messages, files, templates and quotes to them are blocked\.$/);
  assert.match(M.dncText({ on: true, source: 'staff', by: 'thomas@example.com', at: t(NOW - 3 * HOUR), note: 'asked on the phone' }, NOW), /Marked "do not contact" by thomas@example\.com \(3 hours ago\): asked on the phone\./);
});
