// Both directions (functions/lib/emailInbound.js, docs/EMAIL_INBOX.md "Sent from Gmail"): an email YOU write to a customer from Gmail is found in the Sent folder, kept in their chat and listed, so a conversation is tracked
// whether you answer from Gmail or from Elite OS. Real Firestore emulator; Gmail is a fake that serves a small mailbox with folders. Every name, address and number is made up.
// What matters: only an email to a customer's address is read in full and kept (a stranger's recipients are looked at, nothing is stored); Elite OS's own emails (a reply from a chat, a follow-up, the quote) land in
// Sent too and are NOT listed twice; a brand-new email waits two minutes so Elite OS has finished recording its own; it never touches the unread count or "they wrote to us"; an older email found late moves nothing back;
// an email you wrote yourself stops Elite OS chasing (the lead follow-up, the quote follow-up) without the quote's own email ever blocking its follow-up.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const Gmail = require('../lib/gmail');
const In = require('../lib/emailInbound');
const Reply = require('../lib/emailReply');
const FU = require('../lib/followUp');
const QF = require('../lib/quoteFollowUp');
const EL = require('../lib/emailLog');
const h = require('../lib/handlers');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const NOW = Date.UTC(2026, 10, 15, 12, 0), DAY = 24 * 3600e3, MIN = 60e3, ts = (t) => Timestamp.fromMillis(t);
const MAILBOX = 'info@elitekitchens.example', ANNA = '353871119801', BOB = '353871119802', CIARA = '353871119803';
const actor = { kind: 'staff', id: 'thomas@example.com' };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : 0);
const emails = async (p) => (await db.collection(`conversations/${p}/emails`).get()).docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
const logOf = async (p) => (await db.collection('emailLog').where('phone', '==', p).get()).docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => ms(a.at) - ms(b.at));
const conv = async (p) => (await db.doc('conversations/' + p).get()).data();

// a Gmail with two folders: list({ label }) returns the messages that carry that label
function fakeMailbox(msgs) {
  const m = { msgs, listCalls: [], getCalls: [],
    async list({ afterSec, pageToken, max, label = 'INBOX' } = {}) { m.listCalls.push({ afterSec, label }); return { ids: m.msgs.filter((x) => x.labelIds.includes(label)).map((x) => x.id), next: null }; },
    async get(id, { full = false, headers } = {}) { m.getCalls.push({ id, full, headers }); const x = m.msgs.find((y) => y.id === id); return full ? x : { id: x.id, threadId: x.threadId, labelIds: x.labelIds, internalDate: x.internalDate, payload: { headers: x.payload.headers } }; } };
  return m;
}
const QUOTED = '\n\nOn Mon, 9 Nov 2026 at 10:00, Anna Apple <anna@example.com> wrote:\n> the price is fine';
function gm(id, { from = MAILBOX, to, cc = '', subject = 'Re: Your Elite Kitchens quote EK-0112', text = 'Hello', at = NOW - 30 * MIN, labels = ['SENT'], files = [] } = {}) {
  const parts = [{ mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }], body: { size: text.length, data: b64(text) } }];
  for (const f of files) parts.push({ mimeType: 'application/pdf', filename: f, body: { size: 1234, attachmentId: 'att_' + f } });
  return { id, threadId: 'th_' + id, labelIds: labels, internalDate: String(at), payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: from }, { name: 'To', value: to }, ...(cc ? [{ name: 'Cc', value: cc }] : []), { name: 'Subject', value: subject }, { name: 'Message-ID', value: `<${id}@mail.example>` }], parts } };
}
async function customer(phone, name, email, convOver = {}) {
  await db.doc('contacts/' + phone).set({ phone, name, ...(email ? { email } : {}) });
  await db.doc('conversations/' + phone).set({ phone, name, inboxStatus: 'quoted', unreadCount: 0, lastMessage: 'Hi Anna, as discussed, your quotation', lastMessageDirection: 'out', createdAt: ts(NOW - 20 * DAY), updatedAt: ts(NOW - 5 * DAY), ...convOver });
}
const sweep = (mb, now = NOW) => In.sweep({ db, reader: mb, mailbox: MAILBOX, nowMs: now });
beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await customer(ANNA, 'Anna Apple', 'Anna@Example.com'); await customer(BOB, 'Bob Byrne', 'bob@example.com'); await customer(CIARA, 'Ciara Casey', 'ciara@example.com');
});

test('PARSING RECIPIENTS: every address in To and Cc, lower case, once each', () => {
  assert.deepEqual(In.parseAddresses('Aoife Byrne <A@B.ie>, c@d.ie; "Doe, Jane" <j@x.ie>, A@b.ie'), ['a@b.ie', 'c@d.ie', 'j@x.ie']);
  assert.deepEqual(In.parseAddresses(''), []); assert.deepEqual(In.parseAddresses(null), []); assert.deepEqual(In.parseAddresses('no address, <broken>'), []);
});

test('THE READER: the Sent folder can be listed (read-only) and nothing else; a bad folder is refused before any call', async () => {
  const calls = []; const fetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200, text: async () => JSON.stringify({ messages: [{ id: 'abc123' }] }) }; };
  const reader = Gmail.createGmailReader({ apiBase: 'https://gmail.test', fetchImpl, tokens: { get: async () => 'tok', clear() {} } });
  await reader.list({ afterSec: 1000 }); await reader.list({ afterSec: 1000, label: 'SENT' });
  assert.match(calls[0], /labelIds=INBOX/); assert.match(calls[1], /labelIds=SENT/); assert.equal(calls.length, 2);
  await assert.rejects(reader.list({ label: 'TRASH' }), (e) => e instanceof Gmail.GmailError && e.code === 'bad_request'); await assert.rejects(reader.list({ label: 'INBOX,SENT' }), (e) => e instanceof Gmail.GmailError); assert.equal(calls.length, 2);
});

test('YOU WROTE FROM GMAIL: the email is kept in their chat as sent by you (only what you wrote), listed, and counts as emailed; it changes neither the unread count nor "they wrote to us"', async () => {
  const before = await conv(ANNA);
  const mb = fakeMailbox([gm('aa11bb22', { to: 'Anna Apple <anna@example.com>', text: 'Hi Anna, I will ring you tomorrow at 5.' + QUOTED, files: ['plan.pdf'], at: NOW - 30 * MIN }),
    gm('bb22cc33', { to: 'Supplier <sales@supplier.example>', subject: 'Hinge order', text: 'PRIVATE supplier order details', at: NOW - 20 * MIN })]);
  const r = await sweep(mb);
  assert.deepEqual([r.ok, r.sentMatched, r.sentStored, r.stored], [true, 1, 1, 0]);
  const [e] = await emails(ANNA);
  assert.deepEqual([e.id, e.direction, e.kind, e.by, e.confirmed, e.to, e.fromEmail, e.subject, e.threadId, e.attachments, e.createdAt.toMillis()], ['g_aa11bb22', 'out', 'gmail', 'Gmail', true, 'anna@example.com', MAILBOX, 'Re: Your Elite Kitchens quote EK-0112', 'th_aa11bb22', [{ name: 'plan.pdf', size: 1234 }], NOW - 30 * MIN]);
  assert.equal(e.body, 'Hi Anna, I will ring you tomorrow at 5.', 'the quoted history is not kept');
  const c = await conv(ANNA);
  assert.deepEqual([c.lastEmailDir, c.lastEmailSubject, c.lastEmailAt.toMillis(), c.updatedAt.toMillis()], ['out', 'Re: Your Elite Kitchens quote EK-0112', NOW - 30 * MIN, NOW - 30 * MIN], 'the newest email, and the chat moves up the Inbox to that time');
  assert.deepEqual([c.unreadCount, c.emailInboundAt, c.lastInboundAt, c.lastMessage, c.lastMessageDirection], [0, undefined, undefined, before.lastMessage, 'out'], 'not unread, not "they wrote", WhatsApp untouched');
  const [l] = await logOf(ANNA); assert.deepEqual([l.id, l.direction, l.kind, l.by, l.gmailId, l.name, l.email, l.subject, l.snippet, l.at.toMillis()], ['g_aa11bb22', 'out', 'gmail', 'Gmail', 'aa11bb22', 'Anna Apple', 'anna@example.com', 'Re: Your Elite Kitchens quote EK-0112', 'Hi Anna, I will ring you tomorrow at 5.', NOW - 30 * MIN]);
  assert.deepEqual(mb.getCalls.filter((x) => x.full).map((x) => x.id), ['aa11bb22'], 'only the customer\'s email was read in full; the supplier\'s recipients were looked at, nothing else');
  assert.doesNotMatch(JSON.stringify([(await db.collection('conversations').get()).docs.map((d) => d.data()), (await db.collection('emailLog').get()).docs.map((d) => d.data())]), /PRIVATE supplier|supplier\.example|Hinge order/, 'nothing about the stranger is kept');
  assert.ok(mb.getCalls.find((x) => x.id === 'bb22cc33').headers.includes('Cc'), 'the Cc header is asked for');
  // twice is once
  await sweep(mb, NOW + 5 * MIN); await sweep(mb, NOW + 10 * MIN); assert.equal((await emails(ANNA)).length, 1); assert.equal((await logOf(ANNA)).length, 1);
});

test('WHO IT WAS SENT TO: a customer only in Cc counts; an address on the record in other letters counts; mail to yourself or to a stranger is ignored; one email to two customers goes to the first', async () => {
  const mb = fakeMailbox([gm('c1', { to: 'stranger@x.example', cc: 'BOB@Example.com', text: 'cc to Bob', at: NOW - 40 * MIN }), gm('c2', { to: MAILBOX, text: 'to myself', at: NOW - 39 * MIN }),
    gm('c3', { to: 'ciara@example.com, anna@example.com', text: 'to two of you', at: NOW - 38 * MIN }), gm('c4', { to: 'nobody@x.example', text: 'nobody', at: NOW - 37 * MIN })]);
  const r = await sweep(mb); assert.deepEqual([r.sentMatched, r.sentStored], [2, 2]);
  assert.deepEqual((await emails(BOB)).map((x) => [x.body, x.to]), [['cc to Bob', 'bob@example.com']]);
  assert.deepEqual((await emails(CIARA)).map((x) => x.body), ['to two of you']); assert.equal((await emails(ANNA)).length, 0, 'the first customer addressed gets it');
  assert.deepEqual(mb.getCalls.filter((x) => x.full).map((x) => x.id).sort(), ['c1', 'c3'], 'myself and the stranger were never read in full');
});

test('A BRAND-NEW EMAIL WAITS: under two minutes old it is left for the next sweep (so Elite OS has recorded its own send); then it is kept once', async () => {
  const mb = fakeMailbox([gm('d1', { to: 'anna@example.com', text: 'just now', at: NOW - 30e3 })]);
  const r1 = await sweep(mb); assert.deepEqual([r1.sentStored, (await emails(ANNA)).length], [0, 0]); assert.equal(mb.getCalls.filter((x) => x.full).length, 0, 'not even read');
  assert.ok(!(await db.doc('emailSync/state').get()).data().seen.includes('d1'), 'not marked as seen');
  const r2 = await sweep(mb, NOW + 3 * MIN); assert.equal(r2.sentStored, 1); assert.equal((await emails(ANNA)).length, 1);
});

test('ELITE OS\'S OWN EMAILS ARE NOT LISTED TWICE: a reply from a chat (by Google\'s id), a quote email or follow-up (the same subject to the same customer a few minutes apart); anything else you wrote is kept', async () => {
  // 1. a reply sent from Anna's chat: Elite OS records it with Google's id, and it then appears in Sent
  await db.doc(`conversations/${ANNA}/emails/g_in1`).set({ direction: 'in', gmailId: 'in1', subject: 'Re: quote', fromEmail: 'anna@example.com', to: MAILBOX, body: 'Any update?', createdAt: ts(NOW - 3 * DAY), threadId: 'th_in1', messageId: '<in1@mail.example>', references: [], attachments: [] });
  const sender = { sent: [], async sendRaw(raw) { sender.sent.push(raw); return { id: 'e0e0e0e0', threadId: 'th_in1' }; } };
  await Reply.send({ db, mailer: { enabled: true, sender: MAILBOX, replyTo: MAILBOX, fromName: 'Elite Kitchens', gmail: sender } }, actor, { phone: ANNA, body: 'Of course, I will ring you tomorrow at 10.' }, { nowMs: NOW - 20 * MIN });
  assert.equal((await logOf(ANNA)).find((x) => x.kind === 'reply').gmailId, 'e0e0e0e0');
  // 2. a quote email sent earlier by Elite OS (listed without Google's id, as before this feature) and the same email in Sent a few seconds later
  await EL.record(db, { id: 'qd_old_1', phone: BOB, name: 'Bob Byrne', direction: 'out', kind: 'quote', subject: 'Elite Kitchens — Kitchen Quote EK-0118 v1', text: 'Dear Bob, please find attached', email: 'bob@example.com', atMs: NOW - 50 * MIN });
  // 3. a follow-up from Elite OS
  await EL.keepSent(db, { phone: CIARA, name: 'Ciara Casey', id: 'fu_1', sender: MAILBOX, to: 'ciara@example.com', subject: 'Your kitchen enquiry with Elite Kitchens', body: 'Hi Ciara, checking in', kind: 'followup', atMs: NOW - 60 * MIN, confirmed: true, by: 'thomas@example.com', providerId: 'f0f0f0f0' });
  const mb = fakeMailbox([
    gm('e0e0e0e0', { to: 'anna@example.com', subject: 'Re: quote', text: 'Of course, I will ring you tomorrow at 10.', at: NOW - 20 * MIN }),
    gm('b9b9b9b9', { to: 'bob@example.com', subject: 'Elite Kitchens — Kitchen Quote EK-0118 v1', text: 'Dear Bob, please find attached', at: NOW - 50 * MIN + 20e3, files: ['EliteKitchens-EK-0118-v1.pdf'] }),
    gm('f0f0f0f0', { to: 'ciara@example.com', subject: 'Your kitchen enquiry with Elite Kitchens', text: 'Hi Ciara, checking in', at: NOW - 60 * MIN }),
    gm('99aa99aa', { to: 'bob@example.com', subject: 'Something different about the worktops', text: 'Bob, a quick note on the worktops.', at: NOW - 45 * MIN }),
    gm('88bb88bb', { to: 'bob@example.com', subject: 'Elite Kitchens — Kitchen Quote EK-0118 v1', text: 'the same subject a long time later', at: NOW - 50 * MIN + 30 * MIN }),
  ]);
  const r = await sweep(mb);
  assert.deepEqual([r.sentMatched, r.sentStored], [5, 2], 'Anna\'s reply, Bob\'s quote and Ciara\'s follow-up were Elite OS\'s own; only the two you wrote yourself were kept');
  assert.deepEqual((await emails(BOB)).filter((x) => x.kind === 'gmail').map((x) => x.subject).sort(), ['Elite Kitchens — Kitchen Quote EK-0118 v1', 'Something different about the worktops'], 'the same subject 30 minutes later is a different email');
  assert.equal((await emails(ANNA)).filter((x) => x.kind === 'gmail').length, 0); assert.equal((await emails(CIARA)).filter((x) => x.kind === 'gmail').length, 0);
  assert.deepEqual((await logOf(ANNA)).map((x) => x.kind), ['reply'], 'Anna: only the reply Elite OS sent itself, listed once'); assert.equal((await logOf(CIARA)).length, 1);
});

test('OLDER MAIL FOUND LATE MOVES NOTHING BACK; a quote emailed by Elite OS never blocks its own follow-up', async () => {
  await customer(ANNA, 'Anna Apple', 'anna@example.com', { lastEmailAt: ts(NOW - 10 * MIN), lastEmailSubject: 'newest', lastEmailDir: 'in', updatedAt: ts(NOW - 10 * MIN) });
  await sweep(fakeMailbox([gm('o1', { to: 'anna@example.com', text: 'an older one that turned up late', at: NOW - 3 * 60 * MIN })]));
  const c = await conv(ANNA); assert.deepEqual([c.lastEmailSubject, c.lastEmailDir, c.updatedAt.toMillis()], ['newest', 'in', NOW - 10 * MIN]); assert.equal((await emails(ANNA)).length, 1, 'it is kept in the thread');
  // the quote follow-up rule: an email you wrote WELL after the quote stops it; the quote's own email (seconds after) does not
  const sent = NOW - 20 * DAY;
  assert.equal(QF.refusal({ lastEmailDir: 'out', lastEmailAt: ts(sent + 30e3) }, 'q_x', sent, NOW), null, 'the quote\'s own email');
  assert.match(QF.refusal({ lastEmailDir: 'out', lastEmailAt: ts(sent + 2 * DAY) }, 'q_x', sent, NOW), /You emailed them on 28 Oct, after the quote was sent[\s\S]*check the chat first/);
  assert.equal(QF.refusal({ lastEmailDir: 'in', lastEmailAt: ts(sent + 2 * DAY) }, 'q_x', sent, NOW), null, 'only an email from you counts here (theirs is "they wrote")'); assert.equal(QF.refusal({}, 'q_x', sent, NOW), null);
});

test('AN EMAIL YOU WROTE STOPS THE CHASING: a lead you emailed from Gmail is not followed up for two weeks, and the Assistant counts them as emailed', async () => {
  const lead = { inboxStatus: 'inbox', lastMessageDirection: 'out', unreadCount: 0, createdAt: ts(NOW - 5 * DAY), updatedAt: ts(NOW - 5 * DAY) };
  assert.equal(FU.refusal(lead, NOW), null);
  assert.match(FU.refusal({ ...lead, lastEmailDir: 'out', lastEmailAt: ts(NOW - 3 * DAY) }, NOW), /You emailed them on 12 Nov \(from Gmail or from their chat\)\. Wait until 26 Nov/);
  assert.equal(FU.refusal({ ...lead, lastEmailDir: 'out', lastEmailAt: ts(NOW - 20 * DAY) }, NOW), null, 'after two weeks they may be followed up');
  // end to end: a Gmail email to a lead, then the lead follow-up is refused and the Assistant's count says "emailed"
  await customer(BOB, 'Bob Byrne', 'bob@example.com', { ...lead, inboxStatus: 'inbox' });
  await sweep(fakeMailbox([gm('f1', { to: 'bob@example.com', subject: 'Your kitchen', text: 'Hi Bob, I tried to call.', at: NOW - 3 * DAY })]), NOW);
  const g = { sent: [], async sendRaw(raw) { g.sent.push(raw); return { id: 'zz' }; } };
  await assert.rejects(FU.send({ db, mailer: { enabled: true, sender: 'f@x.ie', replyTo: 'f@x.ie', fromName: 'EK', gmail: g } }, actor, { phone: BOB }, { nowMs: NOW }), (e) => e.code === 'failed-precondition' && /You emailed them on 12 Nov/.test(e.message)); assert.equal(g.sent.length, 0);
  const T = require('../lib/aiTools'); const r = await T.run({ db, nowMs: NOW }, 'find_leads', { neverReplied: true, emailed: true }); assert.deepEqual(r.customers.map((x) => x.name), ['Bob Byrne']); assert.match(r.lines[0], /Emailed 12 Nov$/);
});

test('"CHECK FOR NEW EMAIL" tells what it found in both folders', async () => {
  const mb = fakeMailbox([gm('i1', { from: 'anna@example.com', to: MAILBOX, labels: ['INBOX'], text: 'hello', at: NOW - 30 * MIN }), gm('s1', { to: 'bob@example.com', text: 'from Gmail', at: NOW - 20 * MIN })]);
  const r = await h.checkEmail({ uid: 'u1', token: { email: 'thomas@example.com', email_verified: true, staff: true } }, undefined, { db, cfg: { allowedEmails: 'thomas@example.com' }, inbox: { enabled: true, reader: mb, mailbox: MAILBOX } });
  assert.deepEqual([r.ok, r.stored, r.matched, r.sentStored, r.sentMatched], [true, 1, 1, 1, 1]);
});
