// The Inbox "No reply" tab (public/noreply-model.js): who counts as a lead who never replied, who does not, the order, and the call link. Pure functions: no emulator, no browser.
const { test } = require('node:test');
const assert = require('node:assert');
const N = require('../../public/noreply-model.js');

const DAY = 86400000, NOW = Date.UTC(2026, 10, 1, 12, 0), ts = (t) => ({ toMillis: () => t });
const lead = (id, over = {}) => ({ id, name: 'Lead ' + id.slice(-3), inboxStatus: 'inbox', createdAt: ts(NOW - 5 * DAY), lastMessage: 'Hi, thanks for your enquiry', lastMessageDirection: 'out', unreadCount: 0, ...over });

test('who never replied: a New lead with no message of theirs; a record with no stage counts as a New lead; a lead nobody has messaged yet counts too', () => {
  assert.equal(N.neverWrote(lead('353870000001')), true);
  assert.equal(N.neverWrote(lead('353870000002', { inboxStatus: undefined })), true, 'no stage = New lead');
  assert.equal(N.neverWrote(lead('353870000003', { lastMessage: null, lastMessageDirection: null })), true, 'welcome never went: they have not replied either');
});

test('who did NOT: anyone who wrote (any time), anyone past New lead, anyone with unread messages, a customer who asked not to be contacted, nothing at all', () => {
  assert.equal(N.neverWrote(lead('353870000004', { lastInboundAt: ts(NOW - DAY) })), false, 'wrote once');
  assert.equal(N.neverWrote(lead('353870000005', { lastMessageDirection: 'in' })), false, 'their message is the last one');
  assert.equal(N.neverWrote(lead('353870000006', { unreadCount: 2 })), false, 'unread messages are theirs');
  for (const s of ['booked', 'quoted', 'won', 'closed']) assert.equal(N.neverWrote(lead('353870000007', { inboxStatus: s })), false, s);
  assert.equal(N.neverWrote(lead('353870000008', { doNotContact: { on: true } })), false);
  assert.equal(N.neverWrote(lead('353870000009', { doNotContact: { on: false } })), true);
  for (const v of [null, undefined]) assert.equal(N.neverWrote(v), false);
});

test('the list: oldest lead first, a lead with no date last; a chat the live list also has uses the live copy; a chat confirmed to have a message of theirs is left out', () => {
  const a = lead('353870000010', { createdAt: ts(NOW - 9 * DAY) }), b = lead('353870000011', { createdAt: ts(NOW - 2 * DAY) }), c = lead('353870000012', { createdAt: null, updatedAt: null });
  assert.deepEqual(N.rows([b, c], [a]).map((x) => x.id), ['353870000010', '353870000011', '353870000012']);
  const stale = lead('353870000013'), fresh = lead('353870000013', { lastInboundAt: ts(NOW - 1000) });
  assert.deepEqual(N.rows([fresh], [stale]).map((x) => x.id), [], 'they wrote since the older copy was read: gone');
  assert.deepEqual(N.rows([], [stale]).map((x) => x.id), ['353870000013']);
  assert.deepEqual(N.rows([a, b], [], new Map([['353870000010', true], ['353870000011', false]])).map((x) => x.id), ['353870000011'], 'a message of theirs was found in the chat itself (an older record)');
  assert.deepEqual(N.rows(null, undefined), []);
});

test('how long and the call link', () => {
  assert.deepEqual([0, 1, 2, 40].map((d) => N.ageText(d)), ['today', '1 day', '2 days', '40 days']); assert.equal(N.ageText(null), '');
  assert.equal(N.ageDays(lead('353870000014', { createdAt: ts(NOW - 5 * DAY - 3600e3) }), NOW), 5); assert.equal(N.ageDays(lead('353870000014', { createdAt: ts(NOW + DAY) }), NOW), 0);
  assert.equal(N.ageDays({ id: 'x' }, NOW), null);
  assert.equal(N.callHref('353871110091'), 'tel:+353871110091');
  for (const bad of ['', '123', 'abc', '35387111009x', null, undefined]) assert.equal(N.callHref(bad), null, String(bad));
});
