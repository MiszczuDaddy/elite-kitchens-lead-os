// The list of every email in and out (functions/lib/emailLog.js, docs/EMAIL_LIST.md): the "Emails" window on the Inbox. Real Firestore + Storage emulators; Gmail is a fake. Every name, address and number is made up.
// What matters: every email that arrives from a customer, every reply sent from a chat, every follow-up (to a lead, about a quote) and the quote email itself is listed once, with who, when, the subject and a SHORT
// preview; an email we could not confirm says so; the automatic follow-ups are also kept in the customer's own chat (so the thread shows what was sent) without moving the chat up the Inbox; a failure to list never
// stops an email; and everything is erased with the customer. (The quote email's own entries are tested in quote-email.test.js.)
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const Gmail = require('../lib/gmail');
const In = require('../lib/emailInbound');
const Reply = require('../lib/emailReply');
const FU = require('../lib/followUp');
const QF = require('../lib/quoteFollowUp');
const EL = require('../lib/emailLog');
const store = require('../lib/store');
const FT = require('../lib/followUpText');

const PROJECT = 'demo-leados', BUCKET = 'demo-leados.firebasestorage.app';
initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
const db = getFirestore(), bucket = getStorage().bucket(BUCKET);
const NOW = Date.UTC(2026, 10, 14, 12, 0), DAY = 24 * 3600e3, ts = (t) => Timestamp.fromMillis(t);
const MAILBOX = 'info@elitekitchens.example', ANNA = '353871119701', BOB = '353871119702', LEAD = '353871119703';
const actor = { kind: 'staff', id: 'thomas@example.com' };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const logOf = async (phone) => (await db.collection('emailLog').where('phone', '==', phone).get()).docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.at.toMillis() - b.at.toMillis());

function fakeMailbox(msgs) {
  return { async list() { return { ids: msgs.map((x) => x.id), next: null }; },
    async get(id, { full = false } = {}) { const x = msgs.find((y) => y.id === id); return full ? x : { id: x.id, threadId: x.threadId, labelIds: x.labelIds, internalDate: x.internalDate, payload: { headers: x.payload.headers } }; } };
}
function gm(id, { from, subject = 'Re: Your Elite Kitchens quote EK-0112', text = 'Hello', at = NOW - 3600e3 } = {}) {
  return { id, threadId: 'th_' + id, labelIds: ['INBOX'], internalDate: String(at), payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: from }, { name: 'To', value: MAILBOX }, { name: 'Subject', value: subject }, { name: 'Message-ID', value: `<${id}@mail.example>` }],
    parts: [{ mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }], body: { size: text.length, data: b64(text) } }] } };
}
function gmailOut(mode = 'ok') { const g = { sent: [], async sendRaw(raw) { g.sent.push(raw); if (mode === 'refused') throw new Gmail.GmailError('rate_limited', 429, true); if (mode === 'unknown') throw new Gmail.GmailError('network', 0, false); return { id: 'gm' + g.sent.length, threadId: 'th' + g.sent.length }; } }; return g; }
const mailer = (g) => ({ enabled: true, sender: 'followups@example.com', replyTo: MAILBOX, fromName: 'Elite Kitchens', gmail: g });
async function customer(phone, name, email, convOver = {}) {
  await db.doc('contacts/' + phone).set({ phone, name, ...(email ? { email } : {}) });
  await db.doc('conversations/' + phone).set({ phone, name, inboxStatus: 'inbox', unreadCount: 0, lastMessage: 'Hi, thanks for your enquiry', lastMessageDirection: 'out', createdAt: ts(NOW - 20 * DAY), updatedAt: ts(NOW - 2 * DAY), ...convOver });
}
beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await customer(ANNA, 'Anna Apple', 'anna@example.com'); await customer(BOB, 'Bob Byrne', 'bob@example.com'); await customer(LEAD, 'Lena Lead', 'lena@example.com', { createdAt: ts(NOW - 5 * DAY), updatedAt: ts(NOW - 5 * DAY) });
});

test('RECEIVED: a customer\'s email is listed once (a short preview, who, when); a stranger\'s is not; a second sweep adds nothing', async () => {
  const long = 'Please call me about the island. ' + 'x'.repeat(400);
  const box = fakeMailbox([gm('aaa111', { from: 'Anna Apple <anna@example.com>', subject: 'Re: Quote EK-0112', text: long, at: NOW - 3600e3 }), gm('zzz999', { from: 'Stranger <stranger@elsewhere.example>', text: 'Buy my product' })]);
  await In.sweep({ db, reader: box, mailbox: MAILBOX, nowMs: NOW }); await In.sweep({ db, reader: box, mailbox: MAILBOX, nowMs: NOW + 60e3 });
  const all = (await db.collection('emailLog').get()).docs.map((d) => d.data()); assert.equal(all.length, 1, 'one entry, only for the customer');
  const [e] = await logOf(ANNA);
  assert.deepEqual([e.id, e.direction, e.kind, e.name, e.subject, e.email, e.confirmed, e.at.toMillis()], ['g_aaa111', 'in', 'customer', 'Anna Apple', 'Re: Quote EK-0112', 'anna@example.com', true, NOW - 3600e3]);
  assert.equal(e.snippet.length, EL.SNIPPET_MAX); assert.ok(e.snippet.startsWith('Please call me about the island.'), 'a short preview only: the whole email stays in the chat');
  assert.equal(JSON.stringify(e).includes('x'.repeat(300)), false);
});

test('A REPLY FROM THE CHAT: listed as sent by you, with who sent it; one we could not confirm says so', async () => {
  await In.sweep({ db, reader: fakeMailbox([gm('aaa111', { from: 'Anna Apple <anna@example.com>', text: 'Hi, any update?' })]), mailbox: MAILBOX, nowMs: NOW });
  const g = gmailOut(); await Reply.send({ db, mailer: mailer(g) }, actor, { phone: ANNA, body: 'Of course, I will ring you tomorrow at 10.' }, { nowMs: NOW });
  const list = await logOf(ANNA); assert.deepEqual(list.map((x) => [x.direction, x.kind]), [['in', 'customer'], ['out', 'reply']]);
  const out = list[1]; assert.deepEqual([out.name, out.subject, out.email, out.by, out.confirmed, out.at.toMillis(), out.snippet], ['Anna Apple', 'Re: Your Elite Kitchens quote EK-0112', 'anna@example.com', 'thomas@example.com', true, NOW, 'Of course, I will ring you tomorrow at 10.']);
  const g2 = gmailOut('unknown'); await assert.rejects(Reply.send({ db, mailer: mailer(g2) }, actor, { phone: ANNA, body: 'And another thing, the date works for us.' }, { nowMs: NOW + 5 * 60e3 }), (e) => e.code === 'unavailable');
  assert.deepEqual((await logOf(ANNA)).map((x) => x.confirmed), [true, true, false], 'the unconfirmed one is listed and says so');
  const g3 = gmailOut('refused'); await assert.rejects(Reply.send({ db, mailer: mailer(g3) }, actor, { phone: ANNA, body: 'Never sent this one at all.' }, { nowMs: NOW + 9 * 60e3 }), (e) => e.code === 'failed-precondition'); assert.equal((await logOf(ANNA)).length, 3, 'Google refused: nothing was sent, nothing is listed');
});

test('A LEAD FOLLOW-UP: listed, and kept in the lead\'s chat as the newest email WITHOUT moving the chat up the Inbox; unconfirmed says so; refused is not listed', async () => {
  const before = (await db.doc('conversations/' + LEAD).get()).data(), g = gmailOut();
  await FU.send({ db, mailer: mailer(g) }, actor, { phone: LEAD }, { nowMs: NOW });
  const [e] = await logOf(LEAD); assert.deepEqual([e.id, e.direction, e.kind, e.name, e.subject, e.email, e.by, e.confirmed, e.at.toMillis()], [LEAD + '_fu_' + NOW, 'out', 'followup', 'Lena Lead', FT.SUBJECT, 'lena@example.com', 'thomas@example.com', true, NOW]);
  assert.equal(e.snippet, FT.bodyFor({ first: 'Lena' }).replace(/\s+/g, ' ').trim().slice(0, EL.SNIPPET_MAX));
  const kept = (await db.doc(`conversations/${LEAD}/emails/fu_${NOW}`).get()).data();
  assert.deepEqual([kept.direction, kept.kind, kept.subject, kept.to, kept.fromEmail, kept.confirmed, kept.by, kept.body], ['out', 'followup', FT.SUBJECT, 'lena@example.com', 'followups@example.com', true, 'thomas@example.com', FT.bodyFor({ first: 'Lena' })], 'the thread shows exactly what was sent');
  const after = (await db.doc('conversations/' + LEAD).get()).data();
  assert.deepEqual([after.lastEmailDir, after.lastEmailSubject, after.updatedAt.toMillis()], ['out', FT.SUBJECT, before.updatedAt.toMillis()], 'the chat shows the email as its newest but does not move up the Inbox');
  assert.equal(after.followUp.emailCount, 1);
  // unconfirmed: listed as such; refused: nothing listed
  await customer(BOB, 'Bob Byrne', 'bob@example.com', { createdAt: ts(NOW - 5 * DAY) });
  const gu = gmailOut('unknown'); await assert.rejects(FU.send({ db, mailer: mailer(gu) }, actor, { phone: BOB }, { nowMs: NOW }), (x) => x.code === 'unavailable'); assert.deepEqual((await logOf(BOB)).map((x) => x.confirmed), [false]);
  await customer(ANNA, 'Anna Apple', 'anna@example.com', { createdAt: ts(NOW - 5 * DAY) });
  const gr = gmailOut('refused'); await assert.rejects(FU.send({ db, mailer: mailer(gr) }, actor, { phone: ANNA }, { nowMs: NOW }), (x) => x.code === 'failed-precondition'); assert.equal((await logOf(ANNA)).length, 0);
});

test('A QUOTE FOLLOW-UP: listed with the quote number, and kept in the customer\'s chat; the id is per sending of the quote, so a second sending is a second entry', async () => {
  const QID = 'q_' + 'cd'.repeat(12), sent1 = NOW - 16 * DAY;
  await customer(ANNA, 'Anna Apple', 'anna@example.com', { inboxStatus: 'quoted', updatedAt: ts(sent1) });
  await db.doc('quotes/' + QID).set({ phone: ANNA, ref: 'EK-0112', status: 'sent', sentAt: ts(sent1), customerName: 'Anna Apple' });
  const g = gmailOut(); await QF.send({ db, mailer: mailer(g) }, actor, { quoteId: QID }, { nowMs: NOW });
  const [e] = await logOf(ANNA); assert.deepEqual([e.id, e.direction, e.kind, e.quoteRef, e.subject, e.name, e.confirmed, e.by], [`${ANNA}_qf_${QID}_${sent1}`, 'out', 'quotefollowup', 'EK-0112', 'Your Elite Kitchens quote EK-0112', 'Anna Apple', true, 'thomas@example.com']);
  assert.match(e.snippet, /^Hi Anna, I just wanted to check that you received your quote \(EK-0112\)/);
  const kept = (await db.doc(`conversations/${ANNA}/emails/qf_${QID}_${sent1}`).get()).data(); assert.deepEqual([kept.kind, kept.quoteRef, kept.direction], ['quotefollowup', 'EK-0112', 'out']);
  assert.equal((await db.doc('conversations/' + ANNA).get()).data().updatedAt.toMillis(), sent1, 'the chat did not move up the Inbox');
  await db.doc('quotes/' + QID).update({ sentAt: ts(NOW - 15 * DAY) });                                                             // sent again: a new sending
  await QF.send({ db, mailer: mailer(g) }, actor, { quoteId: QID }, { nowMs: NOW + 1000 }); assert.equal((await logOf(ANNA)).length, 2);
});

test('THE LIST NEVER STOPS AN EMAIL: when it cannot be written the email is still sent and recorded; bad entries are refused; text is clipped', async () => {
  const broken = { collection: (c) => { if (c === 'emailLog') throw new Error('boom'); return db.collection(c); } };
  assert.equal(await EL.record(broken, { id: 'x_1', phone: ANNA, direction: 'in', kind: 'customer', subject: 's', text: 't', atMs: NOW }), false, 'returns false, never throws');
  for (const bad of [null, {}, { id: 'a b', phone: ANNA, direction: 'in', kind: 'customer' }, { id: 'ok_1', phone: '12', direction: 'in', kind: 'customer' }, { id: 'ok_1', phone: ANNA, direction: 'sideways', kind: 'customer' }, { id: 'ok_1', phone: ANNA, direction: 'in', kind: 'spam' }]) assert.equal(await EL.record(db, bad), false, JSON.stringify(bad));
  assert.equal((await db.collection('emailLog').get()).size, 0);
  assert.equal(await EL.record(db, { id: 'ok_1', phone: ANNA, name: 'N'.repeat(300), direction: 'out', kind: 'reply', subject: 'S\n'.repeat(300), text: 'T '.repeat(500), email: 'a@b.ie', atMs: NOW }), true);
  const e = (await db.doc('emailLog/ok_1').get()).data(); assert.ok(e.name.length <= 80 && e.subject.length <= 200 && e.snippet.length <= 200); assert.equal(/\n/.test(e.subject), false);
  // a follow-up whose entry cannot be written is still sent and recorded on the customer
  const g = gmailOut(); const real = db.collection.bind(db);
  db.collection = (c) => { if (c === 'emailLog') throw new Error('boom'); return real(c); };
  try { assert.equal((await FU.send({ db, mailer: mailer(g) }, actor, { phone: LEAD }, { nowMs: NOW })).ok, true); } finally { db.collection = real; }
  assert.equal(g.sent.length, 1); assert.equal((await db.doc('conversations/' + LEAD).get()).data().followUp.emailCount, 1);
});

test('ERASURE: deleting a customer deletes their entries and nobody else\'s', async () => {
  await EL.record(db, { id: 'g_a', phone: ANNA, direction: 'in', kind: 'customer', subject: 'a', text: 'a', atMs: NOW });
  await EL.record(db, { id: `${ANNA}_fu_1`, phone: ANNA, direction: 'out', kind: 'followup', subject: 'b', text: 'b', atMs: NOW });
  await EL.record(db, { id: 'g_b', phone: BOB, direction: 'in', kind: 'customer', subject: 'c', text: 'c', atMs: NOW });
  await store.deleteCustomerData(db, bucket, ANNA);
  assert.equal((await logOf(ANNA)).length, 0); assert.equal((await logOf(BOB)).length, 1);
});

test('THE CATCH-UP: emails already in the chats are added to the list once; a dry run only counts; the automatic ones that were never kept are not invented', async () => {
  await db.doc(`conversations/${ANNA}/emails/g_old1`).set({ direction: 'in', gmailId: 'old1', subject: 'Re: quote', fromEmail: 'anna@example.com', body: 'Fine by me.', createdAt: ts(NOW - 3 * DAY), attachments: [] });
  await db.doc(`conversations/${ANNA}/emails/g_old2`).set({ direction: 'out', gmailId: 'old2', subject: 'Re: quote', to: 'anna@example.com', body: 'Great, thanks.', createdAt: ts(NOW - 2 * DAY), by: 'thomas@example.com', confirmed: true });
  await db.doc(`conversations/${BOB}/emails/fu_5`).set({ direction: 'out', kind: 'followup', subject: 'Your kitchen enquiry', to: 'bob@example.com', body: 'Hi Bob, checking in.', createdAt: ts(NOW - DAY), by: 'thomas@example.com', confirmed: false });
  await db.doc('conversations/bad/emails/g_x').set({ direction: 'in', subject: 'not a phone number', createdAt: ts(NOW) });                           // not a customer: ignored
  const dry = await EL.backfill(db); assert.deepEqual(dry, { read: 4, missing: 3, written: 0 }); assert.equal((await db.collection('emailLog').get()).size, 0, 'a dry run changes nothing');
  const done = await EL.backfill(db, { apply: true }); assert.deepEqual(done, { read: 4, missing: 3, written: 3 });
  const a = await logOf(ANNA), b = await logOf(BOB);
  assert.deepEqual(a.map((x) => [x.id, x.direction, x.kind, x.name, x.email, x.snippet]), [['g_old1', 'in', 'customer', 'Anna Apple', 'anna@example.com', 'Fine by me.'], ['g_old2', 'out', 'reply', 'Anna Apple', 'anna@example.com', 'Great, thanks.']]);
  assert.deepEqual(b.map((x) => [x.id, x.kind, x.confirmed, x.by]), [[BOB + '_fu_5', 'followup', false, 'thomas@example.com']]);
  assert.deepEqual(await EL.backfill(db, { apply: true }), { read: 4, missing: 0, written: 0 }, 'a second run adds nothing');
});
