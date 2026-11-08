// Follow-up EMAIL about a quote nobody answered (functions/lib/quoteFollowUp.js, docs/FOLLOW_UP_EMAIL.md). Real Firestore emulator; Gmail is a fake that records what would be sent. Every name and number is made up.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const h = require('../lib/handlers');
const Q = require('../lib/quoteFollowUp');
const Gmail = require('../lib/gmail');
const Text = require('../lib/followUpText');
const M = require('../../public/today-model.js');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const NOW = Date.UTC(2026, 10, 9, 12, 0), DAY = 24 * 3600e3, ts = (t) => Timestamp.fromMillis(t), P = '353871119401', QID = 'q_' + 'ab'.repeat(12), SENT = NOW - 8 * DAY;
const cfg = { allowedEmails: 'thomas@example.com' };
const staff = { uid: 'u1', token: { email: 'thomas@example.com', email_verified: true, staff: true } };
const actor = { kind: 'staff', id: 'thomas@example.com' };
const rejects = (p, code, re) => assert.rejects(p, (e) => e.code === code && (!re || re.test(e.message)), `expected ${code}${re ? ' ' + re : ''}`);

function gmail(mode = 'ok') { const g = { sent: [], async sendRaw(raw) { g.sent.push(Buffer.from(raw, 'base64url').toString('utf8')); if (mode === 'refused') throw new Gmail.GmailError('rate_limited', 429, true); if (mode === 'unknown') throw new Gmail.GmailError('unavailable', 503, false); return { id: 'gm' + g.sent.length, threadId: 't' }; } }; return g; }
const mailer = (g, over = {}) => ({ enabled: true, sender: 'followups@example.com', replyTo: 'info@example.com', fromName: 'Elite Kitchens', gmail: g, ...over });
const go = (g, data = { quoteId: QID }, over = {}, now = NOW) => Q.send({ db, mailer: over.mailer || mailer(g) }, actor, data, { nowMs: now });
const conv = async () => (await db.doc('conversations/' + P).get()).data();
const mark = async () => { const s = await db.doc('todayMarks/quote_' + QID).get(); return s.exists ? s.data() : null; };
const bodyOf = (raw) => raw.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (m, x) => String.fromCharCode(parseInt(x, 16)));
async function quote(over = {}) { await db.doc('quotes/' + QID).set({ phone: P, ref: 'EK-0112', status: 'sent', sentAt: ts(SENT), customerName: 'Maeve Doyle', ...over }); }
async function customer(convOver = {}, contact = {}) {
  await db.doc('contacts/' + P).set({ phone: P, name: 'Maeve Doyle', email: 'maeve@example.com', ...contact });
  await db.doc('conversations/' + P).set({ phone: P, name: 'Maeve Doyle', inboxStatus: 'quoted', createdAt: ts(NOW - 30 * DAY), updatedAt: ts(SENT), lastMessageDirection: 'out', unreadCount: 0, ...convOver });
}
beforeEach(async () => { await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' }); await quote(); await customer(); });

test('SENDING: one email to the customer\'s own address, from the follow-up mailbox, replies to the business mailbox, with the fixed text, their first name and the quote number; it is recorded and the Today card is hidden for 7 days', async () => {
  const g = gmail(); const r = await go(g); assert.equal(r.ok, true);
  assert.equal(g.sent.length, 1); const raw = g.sent[0];
  assert.match(raw, /^From: "Elite Kitchens" <followups@example\.com>/m); assert.match(raw, /^To: maeve@example\.com/m); assert.match(raw, /^Reply-To: info@example\.com/m); assert.match(raw, /^Subject: Your Elite Kitchens quote EK-0112/m);
  const body = bodyOf(raw); assert.match(body, /Hi Maeve,/); assert.match(body, /received your quote \(EK-0112\), and to see if you have any questions about it/); assert.match(body, /Kind regards,\nElite Kitchens|Kind regards,\r?\nElite Kitchens/);
  assert.doesNotMatch(body, /€|\d,\d{3}|warranty|guarantee/i, 'no price and no promise about the work');
  const m = (await conv()).quoteMail[QID]; assert.deepEqual([m.confirmed, m.by, m.basis, m.at.toMillis()], [true, 'thomas@example.com', SENT, NOW]); assert.equal(m.sendingUntil, undefined, 'the claim is released');
  const k = await mark(); assert.deepEqual([k.kind, k.quoteId, k.basis, k.snoozeUntil.toMillis() > NOW + 6 * DAY], ['quote', QID, SENT, true], 'the card is hidden for about 7 days, for THIS sending of the quote');
});

test('THE SCREEN KNOWS: after the email the card says it was emailed (this sending only), and a quote sent again is a new one', async () => {
  const g = gmail(); await go(g);
  const convs = [{ id: P, ...(await conv()) }], quotes = [{ id: QID, ...(await db.doc('quotes/' + QID).get()).data() }];
  const card = (qs, now = NOW + 8 * DAY) => M.build({ convs, quotes: qs, marks: {}, now }).cards.find((c) => c.kind === 'quote');
  assert.equal(card(quotes).emailedAt, NOW, 'emailed: the card says so');
  assert.equal(card([{ ...quotes[0], sentAt: ts(NOW + DAY) }], NOW + 8 * DAY).emailedAt, 0, 'the quote was sent AGAIN: not "emailed"');
});

test('YOUR OWN WORDS: an edited subject and body are what is sent (within limits); anything else in the request is refused', async () => {
  const g = gmail(); await go(g, { quoteId: QID, subject: 'Quick check on your quote', body: 'Hi Maeve, just checking the quote reached you and everything makes sense.' });
  assert.match(g.sent[0], /^Subject: Quick check on your quote/m); assert.ok(bodyOf(g.sent[0]).includes('just checking the quote reached you'));
  await db.doc('conversations/' + P).update({ quoteMail: require('firebase-admin/firestore').FieldValue.delete() }); const g2 = gmail();
  for (const data of [{ quoteId: QID, subject: 'Two\nlines' }, { quoteId: QID, subject: 'x'.repeat(121) }, { quoteId: QID, body: 'short' }, { quoteId: QID, body: 'x'.repeat(2001) }, { quoteId: QID, to: 'someone@else.ie' }, { quoteId: 'q_nope' }, { quoteId: 5 }, {}, null, []]) await rejects(go(g2, data), 'invalid-argument');
  assert.equal(g2.sent.length, 0);
});

test('WHO MAY BE FOLLOWED UP: only a Sent, unanswered quote that is 3 days old, for a customer with an address who has not written since and did not ask to be left alone', async () => {
  const g = gmail();
  for (const status of ['draft', 'accepted', 'declined']) { await quote({ status }); await rejects(go(g), 'failed-precondition', /sent and not answered/); }
  await quote({ sentAt: null }); await rejects(go(g), 'failed-precondition', /sent and not answered/);
  await quote({ sentAt: ts(NOW - 2 * DAY) }); await rejects(go(g), 'failed-precondition', /less than 3 days/);
  await quote(); await customer({ lastInboundAt: ts(SENT + 3600e3) }); await rejects(go(g), 'failed-precondition', /written to you since the quote was sent/);
  await customer({ doNotContact: { on: true } }); await rejects(go(g), 'failed-precondition', /not to be contacted/);
  await customer({}, { email: '' }); await rejects(go(g), 'failed-precondition', /no email address/);
  await customer({}, { email: 'not an address' }); await rejects(go(g), 'failed-precondition', /does not look right/);
  await customer(); await rejects(go(g, { quoteId: QID }, { mailer: mailer(g, { enabled: false }) }), 'failed-precondition', /not switched on/); await rejects(Q.send({ db, mailer: null }, actor, { quoteId: QID }, { nowMs: NOW }), 'failed-precondition', /not switched on/);
  await db.doc('quotes/' + QID).delete(); await rejects(go(g), 'not-found', /quote is no longer there/);
  await quote(); await db.doc('conversations/' + P).delete(); await rejects(go(g), 'not-found', /customer is no longer there/);
  await customer(); await quote({ phone: null }); await rejects(go(g), 'failed-precondition', /no customer phone number/);
  assert.equal(g.sent.length, 0); assert.equal(await mark(), null);
  await quote(); await customer({ lastInboundAt: ts(SENT - 3600e3) }); assert.equal((await go(g)).ok, true, 'a message from them BEFORE the quote was sent does not stop it');
});

test('ONCE PER SENDING: a second press is refused with the date; a double press sends one email; sending the quote again allows one more', async () => {
  const g = gmail(); await go(g);
  await rejects(go(g, { quoteId: QID }, {}, NOW + 3600e3), 'failed-precondition', /already emailed them about this quote on 9 Nov/); assert.equal(g.sent.length, 1);
  await db.doc('conversations/' + P).update({ quoteMail: require('firebase-admin/firestore').FieldValue.delete() }); const g2 = gmail();
  const both = await Promise.allSettled([go(g2), go(g2)]); assert.equal(both.filter((x) => x.status === 'fulfilled').length, 1, 'exactly one of two presses at once sends'); assert.equal(g2.sent.length, 1);
  await db.doc('quotes/' + QID).update({ sentAt: ts(NOW - 4 * DAY) }); const g3 = gmail(); assert.equal((await go(g3)).ok, true, 'a quote sent again may be followed up once more'); assert.equal(g3.sent.length, 1);
});

test('GOOGLE REFUSES: nothing is recorded, the card is not hidden, and the customer can be tried again; an answer we cannot confirm counts as sent and is never retried by itself', async () => {
  const g = gmail('refused'); await rejects(go(g), 'failed-precondition', /limiting how fast email can be sent[\s\S]*Nothing was sent/);
  const c = await conv(); assert.ok(!c.quoteMail || !c.quoteMail[QID] || !c.quoteMail[QID].at, 'not recorded'); assert.equal(await mark(), null, 'the card stays');
  assert.equal((await go(gmail())).ok, true, 'the claim was released: they can try again');
  await db.doc('conversations/' + P).update({ quoteMail: require('firebase-admin/firestore').FieldValue.delete() });
  const u = gmail('unknown'); await rejects(go(u), 'unavailable', /Not confirmed[\s\S]*Sent folder of followups@example\.com/);
  const m = (await conv()).quoteMail[QID]; assert.deepEqual([m.confirmed, !!m.at], [false, true], 'counted as sent');
  await rejects(go(gmail()), 'failed-precondition', /already emailed/);
});

test('STAFF ONLY: the callable wrapper refuses a signed-out or non-staff caller and sends nothing', async () => {
  const g = gmail(); const run = (auth) => h.sendQuoteFollowUp(auth, { quoteId: QID }, { db, cfg, mailer: mailer(g) });
  await rejects(run(null), 'unauthenticated'); await rejects(run({ uid: 'u2', token: { email: 'other@example.com', email_verified: true, staff: true } }), 'permission-denied');
  assert.equal(g.sent.length, 0); assert.equal((await run(staff)).ok, true); assert.equal(g.sent.length, 1);
});

test('THE WORDS: the quote email text is the same on the screen and the server', () => {
  const fs = require('fs'), path = require('path');
  assert.equal(fs.readFileSync(path.join(__dirname, '../lib/followUpText.js'), 'utf8'), fs.readFileSync(path.join(__dirname, '../../public/followup-text.js'), 'utf8'));
  assert.equal(Text.quoteSubject('EK-0104'), 'Your Elite Kitchens quote EK-0104'); assert.equal(Text.quoteSubject(''), 'Your Elite Kitchens quote');
  assert.match(Text.quoteBodyFor({ first: 'Maeve', ref: 'EK-0104' }), /^Hi Maeve,\n\nI just wanted to check that you received your quote \(EK-0104\), and to see if you have any questions about it\./);
  assert.match(Text.quoteBodyFor({}), /^Hi there,\n\nI just wanted to check that you received your quote, and/);
});
