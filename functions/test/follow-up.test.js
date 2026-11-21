// Follow-up emails to leads who never replied (functions/lib/followUp.js, docs/FOLLOW_UP_EMAIL.md). Real Firestore emulator; Gmail is a fake that records what would be sent. Every name and number is made up.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const h = require('../lib/handlers');
const F = require('../lib/followUp');
const Gmail = require('../lib/gmail');
const Text = require('../lib/followUpText');
const NoReply = require('../../public/noreply-model.js');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const NOW = Date.UTC(2026, 10, 5, 12, 0), DAY = 24 * 3600e3, ts = (t) => Timestamp.fromMillis(t), P = '353871119301';
const cfg = { allowedEmails: 'thomas@example.com' };
const staff = { uid: 'u1', token: { email: 'thomas@example.com', email_verified: true, staff: true } };
const actor = { kind: 'staff', id: 'thomas@example.com' };
const rejects = (p, code, re) => assert.rejects(p, (e) => e.code === code && (!re || re.test(e.message)), `expected ${code}${re ? ' ' + re : ''}`);

// a Gmail that records the messages it is asked to send; `mode` decides what it answers
function gmail(mode = 'ok') { const g = { sent: [], async sendRaw(raw) { g.sent.push(Buffer.from(raw, 'base64url').toString('utf8')); if (mode === 'refused') throw new Gmail.GmailError('rate_limited', 429, true); if (mode === 'unknown') throw new Gmail.GmailError('unavailable', 503, false); return { id: 'gm' + g.sent.length, threadId: 't' }; } }; return g; }
const mailer = (g, over = {}) => ({ enabled: true, sender: 'followups@example.com', replyTo: 'info@example.com', fromName: 'Elite Kitchens', gmail: g, ...over });
const go = (g, data = { phone: P }, over = {}, now = NOW) => F.send({ db, mailer: over.mailer || mailer(g) }, actor, data, { nowMs: now });
const conv = async () => (await db.doc('conversations/' + P).get()).data();
async function lead(over = {}, contact = {}) {
  await db.doc('contacts/' + P).set({ phone: P, name: 'Oona Oldwait', email: 'oona@example.com', ...contact });
  await db.doc('conversations/' + P).set({ phone: P, name: 'Oona Oldwait', inboxStatus: 'inbox', createdAt: ts(NOW - 5 * DAY), updatedAt: ts(NOW - 5 * DAY), lastMessage: 'Hi Oona, thanks for your enquiry', lastMessageDirection: 'out', unreadCount: 0, ...over });
}
beforeEach(async () => { await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' }); await lead(); });

test('SENDING: one email to the lead\'s own address, from the follow-up mailbox, replies to the business mailbox, with the fixed text and the lead\'s first name; the conversation records it', async () => {
  const g = gmail(); const r = await go(g); assert.equal(r.ok, true);
  assert.equal(g.sent.length, 1); const raw = g.sent[0];
  assert.match(raw, /^From: "Elite Kitchens" <followups@example\.com>/m); assert.match(raw, /^To: oona@example\.com/m); assert.match(raw, /^Reply-To: info@example\.com/m); assert.match(raw, /^Subject: Your kitchen enquiry with Elite Kitchens/m);
  const body = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (m, x) => String.fromCharCode(parseInt(x, 16)));
  assert.match(body, /Hi Oona,/); assert.match(body, /free home consultation/);
  const f = (await conv()).followUp; assert.deepEqual([f.emailCount, f.confirmed, f.emailBy, f.emailAt.toMillis()], [1, true, 'thomas@example.com', NOW]); assert.equal(f.sendingUntil, undefined, 'the claim is released');
});

test('YOUR OWN WORDS: an edited subject and body are what is sent (within limits); anything else in the request is refused', async () => {
  const g = gmail(); await go(g, { phone: P, subject: 'Quick question about your kitchen', body: 'Hi Oona, just checking you are still interested in a new kitchen?' });
  assert.match(g.sent[0], /^Subject: Quick question about your kitchen/m); assert.ok(g.sent[0].includes('just checking you are still interested'));
  await lead(); const g2 = gmail();
  for (const data of [{ phone: P, subject: 'Two\nlines' }, { phone: P, subject: 'x'.repeat(121) }, { phone: P, body: 'short' }, { phone: P, body: 'x'.repeat(2001) }, { phone: P, to: 'someone@else.ie' }, { phone: '12' }, {}, null]) await rejects(go(g2, data), 'invalid-argument');
  assert.equal(g2.sent.length, 0);
});

test('WHO MAY BE EMAILED: only a New lead who never wrote; not one who wrote (in the record or only in the chat), moved on, asked not to be contacted, or arrived less than a day ago', async () => {
  const g = gmail();
  for (const [over, re, label] of [
    [{ lastInboundAt: ts(NOW - DAY) }, /already written/, 'wrote'], [{ lastMessageDirection: 'in' }, /already written/, 'their message is last'], [{ unreadCount: 2 }, /already written/, 'unread'],
    [{ inboxStatus: 'booked' }, /no longer a New lead/, 'booked'], [{ inboxStatus: 'closed' }, /no longer a New lead/, 'closed'], [{ doNotContact: { on: true } }, /not to be contacted/, 'do not contact'],
    [{ createdAt: ts(NOW - 3600e3), updatedAt: ts(NOW - 3600e3) }, /last 24 hours/, 'too new'],
  ]) { await lead(over); await rejects(go(g), 'failed-precondition', re); assert.ok(!(await conv()).followUp, label + ': nothing recorded'); }
  await lead(); await db.doc(`conversations/${P}/messages/old1`).set({ direction: 'in', type: 'text', body: 'Hello', createdAt: ts(NOW - 3 * DAY) });
  await rejects(go(g), 'failed-precondition', /already written/);                                          // an old record that never noted it
  assert.equal(g.sent.length, 0);
});

test('THEIR ADDRESS AND THE SWITCH: no email, a bad email, or email sending off: nothing is sent', async () => {
  const g = gmail();
  await lead({}, { email: '' }); await rejects(go(g), 'failed-precondition', /no email address/);
  await lead({}, { email: 'not an email' }); await rejects(go(g), 'failed-precondition', /does not look right/);
  await lead(); await rejects(go(g, { phone: P }, { mailer: mailer(g, { enabled: false }) }), 'failed-precondition', /not switched on/);
  await rejects(go(g, { phone: '353870000000' }), 'not-found');
  assert.equal(g.sent.length, 0);
});

test('NOT TWICE: a second press gets a plain refusal; after 14 days one more is allowed; never a third; two presses at the same moment send ONE', async () => {
  const g = gmail(); await go(g);
  await rejects(go(g, { phone: P }, {}, NOW + 3600e3), 'failed-precondition', /were emailed on .* Wait until/);
  assert.equal((await go(g, { phone: P }, {}, NOW + 15 * DAY)).ok, true); assert.equal((await conv()).followUp.emailCount, 2);
  await rejects(go(g, { phone: P }, {}, NOW + 40 * DAY), 'failed-precondition', /two follow-up emails/); assert.equal(g.sent.length, 2);
  await lead(); const g2 = gmail(); const results = await Promise.allSettled([go(g2), go(g2), go(g2)]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1, 'exactly one went'); assert.equal(g2.sent.length, 1);
});

test('WHEN GOOGLE SAYS NO: a clear refusal sends nothing and counts nothing (try again later); an answer we cannot confirm counts as sent and is not retried by itself', async () => {
  await rejects(go(gmail('refused')), 'failed-precondition', /limiting how fast.*Nothing was sent/);
  let f = (await conv()).followUp || {}; assert.ok(!f.emailCount, 'not counted'); assert.equal(f.sendingUntil, undefined, 'the claim is released');
  assert.equal((await go(gmail())).ok, true, 'and it can be tried again at once'); await lead();
  const u = gmail('unknown'); await rejects(go(u), 'unavailable', /Not confirmed.*Sent folder of followups@example\.com/);
  f = (await conv()).followUp; assert.deepEqual([f.emailCount, f.confirmed], [1, false]);
  await rejects(go(gmail(), { phone: P }, {}, NOW + 3600e3), 'failed-precondition', /were emailed on/);
});

test('ONLY STAFF, through the real wrapper', async () => {
  const g = gmail(), deps = (a) => ({ db, cfg, mailer: mailer(g) });
  await rejects(h.sendFollowUpEmail(null, { phone: P }, deps()), 'unauthenticated');
  await rejects(h.sendFollowUpEmail({ uid: 'x', token: { email: 'other@example.com', email_verified: true, staff: true } }, { phone: P }, deps()), 'permission-denied');
  assert.equal((await h.sendFollowUpEmail(staff, { phone: P }, deps())).ok, true); assert.equal(g.sent.length, 1);
});

test('THE SCREEN AND THE SERVER AGREE: the two copies of the email text are identical, and the "never wrote" rule gives the same answer as the No reply tab', () => {
  assert.ok(fs.readFileSync(path.join(__dirname, '../lib/followUpText.js')).equals(fs.readFileSync(path.join(__dirname, '../../public/followup-text.js'))), 'copy functions/lib/followUpText.js over public/followup-text.js');
  const base = { inboxStatus: 'inbox', unreadCount: 0, lastMessageDirection: 'out' };
  for (const c of [base, { ...base, inboxStatus: undefined }, { ...base, inboxStatus: 'booked' }, { ...base, lastInboundAt: ts(1) }, { ...base, lastMessageDirection: 'in' }, { ...base, unreadCount: 1 }, { ...base, doNotContact: { on: true } }, { ...base, doNotContact: { on: false } }, {}, { lastMessageDirection: null }])
    assert.equal(F.neverWrote(c), NoReply.neverWrote(c), JSON.stringify(c));
  assert.equal(Text.firstNameOf('MARANG'), 'Marang'); for (const bad of ['', 'x', 'a@b.ie', 'Unit 4', null]) assert.equal(Text.firstNameOf(bad), 'there');
});
