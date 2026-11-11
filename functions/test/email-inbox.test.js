// The email inbox (functions/lib/emailInbound.js, emailReply.js, docs/EMAIL_INBOX.md): a customer's reply to a quote or follow-up email comes into THEIR chat, and "Reply by email" answers in the same Gmail conversation.
// Real Firestore + Storage emulators; Gmail is a fake that serves a small mailbox and records what is read and sent. Every name, address and number is made up.
// What matters: only a customer's own emails are read in full and kept (a stranger's headers are looked at, nothing is stored); nothing in `messages`, the WhatsApp window or the receptionist is touched; a reply by email counts as
// "they wrote to us"; one sweep or ten, an email is stored once; a reply goes out as the business, threaded, once; staff only; erased with the customer.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const h = require('../lib/handlers');
const Gmail = require('../lib/gmail');
const In = require('../lib/emailInbound');
const Reply = require('../lib/emailReply');
const NoReplyRule = require('../lib/noReplyRule');
const QF = require('../lib/quoteFollowUp');
const NoReply = require('../../public/noreply-model.js');

const PROJECT = 'demo-leados', BUCKET = 'demo-leados.firebasestorage.app';
initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
const db = getFirestore(), bucket = getStorage().bucket(BUCKET);
const NOW = Date.UTC(2026, 10, 10, 12, 0), DAY = 24 * 3600e3, ts = (t) => Timestamp.fromMillis(t);
const MAILBOX = 'info@elitekitchens.example';
const ANNA = '353871119601', BOB = '353871119602', CIARA = '353871119603', DEL = '353871119604';
const cfg = { allowedEmails: 'thomas@example.com' }, staff = { uid: 'u1', token: { email: 'thomas@example.com', email_verified: true, staff: true } };
const actor = { kind: 'staff', id: 'thomas@example.com' };
const rejects = (p, code, re) => assert.rejects(p, (e) => e.code === code && (!re || re.test(e.message)), `expected ${code}${re ? ' ' + re : ''}`);
const b64 = (s, enc = 'utf8') => Buffer.from(s, enc).toString('base64url');

// ---- a fake Gmail: a mailbox of messages (newest first), and a record of every call ----
function fakeMailbox(msgs = []) {
  const m = { msgs, listCalls: [], getCalls: [], listError: null,
    async list({ afterSec, pageToken, max } = {}) { m.listCalls.push({ afterSec, pageToken, max }); if (m.listError) throw m.listError; return { ids: m.msgs.map((x) => x.id), next: null }; },
    async get(id, { full = false } = {}) { m.getCalls.push({ id, full }); const x = m.msgs.find((y) => y.id === id); return full ? x : { id: x.id, threadId: x.threadId, labelIds: x.labelIds, internalDate: x.internalDate, payload: { headers: x.payload.headers } }; } };
  return m;
}
// one Gmail message: text and html parts, optional attachments
function gm(id, { from, to = MAILBOX, subject = 'Re: Your Elite Kitchens quote EK-0112', text = 'Hello', html = null, at = NOW - 3600e3, threadId = 'th_' + id, messageId = `<${id}@mail.example>`, references = '', labels = ['INBOX'], files = [], charset = 'utf-8' } = {}) {
  const parts = [{ mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: `text/plain; charset=${charset}` }], body: { size: text.length, data: charset === 'iso-8859-1' ? b64(text, 'latin1') : b64(text) } }];
  if (html) parts.push({ mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: { size: html.length, data: b64(html) } });
  for (const f of files) parts.push({ mimeType: 'application/pdf', filename: f, body: { size: 1234, attachmentId: 'att_' + f } });
  return { id, threadId, labelIds: labels, internalDate: String(at), payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: from }, { name: 'To', value: to }, { name: 'Subject', value: subject }, { name: 'Message-ID', value: messageId }, { name: 'Date', value: new Date(at).toUTCString() }, ...(references ? [{ name: 'References', value: references }] : [])], parts } };
}
const QUOTED = '\n\nOn Mon, 9 Nov 2026 at 10:00, Elite Kitchens <info@elitekitchens.example> wrote:\n> Hi Anna,\n> I just wanted to check that you received your quote.\n> Kind regards';

async function customer(phone, name, email, convOver = {}) {
  await db.doc('contacts/' + phone).set({ phone, name, ...(email ? { email } : {}) });
  await db.doc('conversations/' + phone).set({ phone, name, inboxStatus: 'quoted', unreadCount: 0, lastMessage: 'Hi Anna, as discussed, your quotation', lastMessageDirection: 'out', createdAt: ts(NOW - 20 * DAY), updatedAt: ts(NOW - 2 * DAY), ...convOver });
}
const conv = async (p) => (await db.doc('conversations/' + p).get()).data();
const emails = async (p) => (await db.collection(`conversations/${p}/emails`).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const sweep = (mailbox, now = NOW) => In.sweep({ db, reader: mailbox, mailbox: MAILBOX, nowMs: now });
beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await customer(ANNA, 'Anna Apple', 'Anna@Example.com'); await customer(BOB, 'Bob Byrne', 'bob@example.com');
});

// ================================================================== reading one message ======================================================
test('READING A MESSAGE: addresses, the plain text or the html turned into text, the history cut off, attachments listed', () => {
  assert.deepEqual(In.parseAddress('Anna Apple <Anna@Example.com>'), { email: 'anna@example.com', name: 'Anna Apple' });
  assert.deepEqual(In.parseAddress('"Apple, Anna" <a@b.ie>'), { email: 'a@b.ie', name: 'Apple, Anna' }); assert.deepEqual(In.parseAddress('plain@b.ie'), { email: 'plain@b.ie', name: '' });
  for (const bad of ['', 'no address', '<>', 'a@b', null]) assert.equal(In.parseAddress(bad), null, String(bad));
  assert.equal(In.textOf(gm('a1', { from: 'x@y.ie', text: 'Plain words', html: '<p>Html words</p>' }).payload), 'Plain words', 'text/plain wins');
  assert.equal(In.textOf({ parts: [{ mimeType: 'text/html', body: { data: b64('<div>Hello<br>there &amp; thanks</div><p>Bye</p>') } }] }), 'Hello\nthere & thanks\nBye\n'.trimEnd() + '\n', 'html only: tags removed, entities decoded');
  assert.equal(In.textOf(gm('a2', { from: 'x@y.ie', text: 'Café €500', charset: 'iso-8859-1' }).payload).startsWith('Café'), true, 'another character set is decoded');
  assert.equal(In.stripQuoted('Yes please, call me.' + QUOTED), 'Yes please, call me.');
  assert.equal(In.stripQuoted('Thanks!\n\n-----Original Message-----\nFrom: Elite\nSent: Monday\nOld words'), 'Thanks!');
  assert.equal(In.stripQuoted('Fine by me\n\nFrom: Elite Kitchens <info@x.ie>\nSent: 9 Nov 2026 10:00\nTo: Anna\nSubject: quote\n\nOld words'), 'Fine by me');
  assert.equal(In.stripQuoted('On Mon, 9 Nov 2026 at 10:00, Someone\n<someone@x.ie> wrote:\n> old'.replace(/^/, 'Answer here\n')), 'Answer here', 'an "On ... wrote:" line wrapped over two lines');
  assert.equal(In.stripQuoted('> only quoted words'), '> only quoted words', 'never an empty email: when nothing is left the original is kept');
  assert.deepEqual(In.attachmentsOf(gm('a3', { from: 'x@y.ie', files: ['photo-wall.pdf', 'plan.pdf'] }).payload), [{ name: 'photo-wall.pdf', size: 1234 }, { name: 'plan.pdf', size: 1234 }]);
});

test('THE GMAIL READER: read-only requests with the right addresses and scope; errors are classified; the sender can put a reply in a conversation', async () => {
  const calls = []; const fetchImpl = async (url, o) => { calls.push({ url, o }); return { ok: true, status: 200, text: async () => JSON.stringify(url.includes('/messages?') ? { messages: [{ id: 'abc123' }, { id: 'def456' }], nextPageToken: 'NEXT' } : { id: 'abc123' }) }; };
  const reader = Gmail.createGmailReader({ apiBase: 'https://gmail.test', fetchImpl, tokens: { get: async () => 'tok', clear() {} } });
  assert.deepEqual(await reader.list({ afterSec: 1700000000.9, pageToken: 'P1', max: 500 }), { ids: ['abc123', 'def456'], next: 'NEXT' });
  const u = new URL(calls[0].url); assert.equal(u.pathname, '/gmail/v1/users/me/messages'); assert.deepEqual([u.searchParams.get('labelIds'), u.searchParams.get('q'), u.searchParams.get('pageToken'), u.searchParams.get('maxResults')], ['INBOX', 'after:1700000000', 'P1', '100']);
  assert.equal(calls[0].o.method, 'GET'); assert.equal(calls[0].o.headers.authorization, 'Bearer tok'); assert.equal(calls[0].o.body, undefined, 'it only reads');
  await reader.get('abc123'); assert.match(calls[1].url, /messages\/abc123\?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject/);
  await reader.get('abc123', { full: true }); assert.match(calls[2].url, /messages\/abc123\?format=full$/);
  await assert.rejects(reader.get('../../etc'), (e) => e.code === 'bad_request');
  const failing = (status) => Gmail.createGmailReader({ fetchImpl: async () => ({ ok: false, status, text: async () => '{}' }), tokens: { get: async () => 'tok', clear() {} } });
  for (const [status, code] of [[403, 'forbidden'], [401, 'forbidden'], [429, 'rate_limited'], [500, 'unavailable']]) await assert.rejects(failing(status).list({}), (e) => e.code === code, String(status));
  // sending: a reply can name the Gmail conversation; an ordinary send does not
  const bodies = []; const sender = Gmail.createGmailClient({ apiBase: 'https://gmail.test', fetchImpl: async (url, o) => { bodies.push(JSON.parse(o.body)); return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'm1', threadId: 't1' }) }; }, tokens: { get: async () => 'tok', clear() {} } });
  await sender.sendRaw('RAW', { threadId: 'th_9' }); await sender.sendRaw('RAW'); assert.deepEqual(bodies, [{ raw: 'RAW', threadId: 'th_9' }, { raw: 'RAW' }]);
  // the sign-in asks for exactly the scope it is given
  const claims = []; const tp = Gmail.delegatedTokenProvider({ serviceAccount: 'mailer@x.iam', sender: MAILBOX, scope: Gmail.GMAIL_READ_SCOPE, now: () => 1700000000000,
    fetchImpl: async (url, o) => { if (url.includes('computeMetadata')) return { ok: true, status: 200, text: async () => '{"access_token":"rt"}' }; if (url.includes('signJwt')) { claims.push(JSON.parse(JSON.parse(o.body).payload)); return { ok: true, status: 200, text: async () => '{"signedJwt":"sj"}' }; } return { ok: true, status: 200, text: async () => '{"access_token":"gt","expires_in":3600}' }; } });
  assert.equal(await tp.get(), 'gt'); assert.deepEqual([claims[0].scope, claims[0].sub], ['https://www.googleapis.com/auth/gmail.readonly', MAILBOX]); assert.notEqual(Gmail.GMAIL_READ_SCOPE, Gmail.GMAIL_SCOPE);
  assert.throws(() => Gmail.buildTextMessage({ from: 'a@b.ie', to: 'c@d.ie', subject: 's', text: 'x', inReplyTo: '<bad id>' }), /message id/);
});

// ================================================================== the sweep ================================================================
test('THE SWEEP: a customer\'s reply is kept in their chat (only what they wrote, with its thread), counted as unread, and counted as "they wrote to us"; a stranger\'s email is looked at only by its sender, never kept', async () => {
  const mb = fakeMailbox([
    gm('aaa111', { from: 'Anna Apple <anna@example.com>', text: 'Hi, the price looks fine. Can you call me tomorrow?' + QUOTED, references: '<q0@mail.example>', files: ['wall.pdf'], at: NOW - 3600e3 }),
    gm('bbb222', { from: 'Supplier <sales@supplier.example>', subject: 'Invoice for hinges', text: 'Pay us. Private bank details inside.' }),
    gm('ccc333', { from: `Elite Kitchens <${MAILBOX}>`, subject: 'Your quote', text: 'our own mail' }),
    gm('ddd444', { from: 'Anna Apple <anna@example.com>', labels: ['INBOX', 'SENT'], text: 'a copy of something sent' }),
  ]);
  const before = await conv(ANNA), r = await sweep(mb);
  assert.deepEqual([r.ok, r.listed, r.matched, r.stored], [true, 4, 1, 1]);
  const [e] = await emails(ANNA); assert.equal(e.id, 'g_aaa111');
  assert.deepEqual([e.direction, e.subject, e.fromEmail, e.fromName, e.to, e.threadId, e.messageId, e.references, e.attachments], ['in', 'Re: Your Elite Kitchens quote EK-0112', 'anna@example.com', 'Anna Apple', MAILBOX, 'th_aaa111', '<aaa111@mail.example>', ['<q0@mail.example>'], [{ name: 'wall.pdf', size: 1234 }]]);
  assert.equal(e.body, 'Hi, the price looks fine. Can you call me tomorrow?', 'the quoted history is not kept'); assert.equal(e.createdAt.toMillis(), NOW - 3600e3);
  const c = await conv(ANNA); assert.deepEqual([c.unreadCount, c.emailInboundAt.toMillis(), c.lastEmailSubject, c.lastEmailDir], [1, NOW - 3600e3, 'Re: Your Elite Kitchens quote EK-0112', 'in']); assert.ok(ms(c.lastEmailAt) >= ms(c.updatedAt) && ms(c.updatedAt) > ms(before.updatedAt), 'the chat moves to the top of the Inbox');
  assert.deepEqual([c.lastMessage, c.lastMessageDirection, c.lastInboundAt], [before.lastMessage, 'out', undefined], 'WhatsApp\'s own fields are untouched: the 24-hour window and the receptionist see nothing');
  assert.equal((await db.collection(`conversations/${ANNA}/messages`).get()).size, 0, 'nothing in messages');
  assert.deepEqual(mb.getCalls.filter((x) => x.full).map((x) => x.id), ['aaa111'], 'the stranger\'s text was never read, only its headers');
  const allDocs = JSON.stringify(await Promise.all(['conversations', 'contacts'].map(async (cl) => (await db.collection(cl).get()).docs.map((d) => d.data())))); assert.doesNotMatch(allDocs, /Private bank details|Invoice for hinges|supplier\.example/, 'nothing about the stranger is kept');
  const st = (await db.doc('emailSync/state').get()).data(); assert.deepEqual([...st.seen].sort(), ['aaa111', 'bbb222', 'ccc333', 'ddd444']); assert.equal(st.lastSweepAt.toMillis(), NOW); assert.equal(st.lastError, undefined);
});
const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : 0);

test('SWEEPING AGAIN: nothing is read twice or stored twice; the unread count goes up once; a new email is added; the window starts a little before the last sweep', async () => {
  const mb = fakeMailbox([gm('aaa111', { from: 'anna@example.com', text: 'first' })]);
  await sweep(mb); await sweep(mb, NOW + 300e3); await sweep(mb, NOW + 600e3);
  assert.equal((await emails(ANNA)).length, 1); assert.equal((await conv(ANNA)).unreadCount, 1); assert.equal(mb.getCalls.length, 2, 'one metadata look and one full read, the other sweeps found nothing new');
  assert.equal(mb.listCalls[0].afterSec, Math.floor((NOW - 3 * DAY - 15 * 60e3) / 1000), 'the first time: the last 3 days'); assert.equal(mb.listCalls[1].afterSec, Math.floor((NOW - 15 * 60e3) / 1000), 'then from just before the last sweep');
  mb.msgs.unshift(gm('eee555', { from: 'anna@example.com', text: 'second', at: NOW + 400e3 })); await sweep(mb, NOW + 900e3);
  assert.deepEqual((await emails(ANNA)).map((x) => x.body).sort(), ['first', 'second']); const c = await conv(ANNA); assert.deepEqual([c.unreadCount, c.emailInboundAt.toMillis()], [2, NOW + 400e3]);
  await sweep(mb, NOW + 1200e3); assert.equal((await emails(ANNA)).length, 2);
  mb.msgs.push(gm('old111', { from: 'anna@example.com', text: 'an older one that turned up late', at: NOW - 5 * DAY })); await sweep(mb, NOW + 1500e3);
  assert.equal((await conv(ANNA)).emailInboundAt.toMillis(), NOW + 400e3, 'an older email never moves "last emailed" back');
});

test('WHO IS A CUSTOMER: the address is matched in lower case; an address on two customers goes to the chat that was active most recently; one with no chat is skipped; HTML-only emails work', async () => {
  await customer(CIARA, 'Ciara Casey', 'shared@example.com', { updatedAt: ts(NOW - 10 * DAY) }); await customer(DEL, 'Dara Daly', 'SHARED@example.com', { updatedAt: ts(NOW - DAY) });
  await db.doc('contacts/353871119699').set({ phone: '353871119699', name: 'No Chat', email: 'nochat@example.com' });
  const mb = fakeMailbox([gm('s1', { from: 'Shared <shared@EXAMPLE.com>', text: 'for one of you' }), gm('n1', { from: 'nochat@example.com', text: 'nobody home' }), gm('h1', { from: 'bob@example.com', text: '', html: '<p>Hi, I am <b>happy</b> with the quote.</p>' })]);
  const r = await sweep(mb); assert.deepEqual([r.matched, r.stored], [3, 2]);
  assert.equal((await emails(DEL)).length, 1); assert.equal((await emails(CIARA)).length, 0, 'the busier chat gets it'); assert.equal((await emails('353871119699')).length, 0);
  assert.equal((await emails(BOB))[0].body, 'Hi, I am happy with the quote.');
});

test('WHEN GOOGLE SAYS NO: the error is recorded and nothing throws; an allowed run clears it; a mailbox with too much new mail is taken in steps without skipping any', async () => {
  const mb = fakeMailbox([gm('aaa111', { from: 'anna@example.com' })]); mb.listError = new Gmail.GmailError('forbidden', 403, true);
  const r = await sweep(mb); assert.deepEqual([r.ok, r.error], [false, 'forbidden']); assert.equal((await db.doc('emailSync/state').get()).data().lastError.code, 'forbidden'); assert.equal((await emails(ANNA)).length, 0);
  mb.listError = null; assert.equal((await sweep(mb, NOW + 60e3)).ok, true); assert.equal((await db.doc('emailSync/state').get()).data().lastError, undefined); assert.equal((await emails(ANNA)).length, 1);
  const many = fakeMailbox(Array.from({ length: In.MAX_PER_RUN + 5 }, (_, i) => gm('f' + String(i).padStart(5, '0'), { from: 'stranger' + i + '@x.example' })));
  const t1 = await sweep(many, NOW + 120e3); assert.equal(t1.truncated, true); assert.equal(many.getCalls.length, In.MAX_PER_RUN);
  const before = ms((await db.doc('emailSync/state').get()).data().lastSweepAt); assert.equal(before, NOW + 60e3, 'the window did not move on: the rest is taken next time');
  const t2 = await sweep(many, NOW + 180e3); assert.equal(t2.truncated, false); assert.equal(many.getCalls.length, In.MAX_PER_RUN + 5, 'every message looked at exactly once');
});

test('"THEY WROTE" COUNTS EMAIL: a lead who replied by email is not "never replied" (the No reply tab, follow-up emails, the assistant) and a quote is not chased by email after they wrote', () => {
  const lead = { inboxStatus: 'inbox', lastMessageDirection: 'out', unreadCount: 0 };
  for (const c of [lead, { ...lead, emailInboundAt: ts(NOW) }, { ...lead, emailInboundAt: null }]) assert.equal(NoReplyRule.neverWrote(c), NoReply.neverWrote(c), 'the server and the screen agree');
  assert.equal(NoReplyRule.neverWrote(lead), true); assert.equal(NoReplyRule.neverWrote({ ...lead, emailInboundAt: ts(NOW) }), false);
  const sent = NOW - 8 * DAY;
  assert.match(QF.refusal({ emailInboundAt: ts(sent + 3600e3) }, 'q_x', sent, NOW), /written to you since the quote was sent/); assert.equal(QF.refusal({ emailInboundAt: ts(sent - 3600e3) }, 'q_x', sent, NOW), null, 'an email from before the quote does not stop it');
});

// ================================================================== replying =================================================================
const gmailOut = (mode = 'ok') => { const g = { sent: [], opts: [], async sendRaw(raw, o = {}) { g.sent.push(Buffer.from(raw, 'base64url').toString('utf8')); g.opts.push(o); if (mode === 'refused') throw new Gmail.GmailError('rate_limited', 429, true); if (mode === 'unknown') throw new Gmail.GmailError('unavailable', 503, false); return { id: 'sent' + g.sent.length, threadId: o.threadId || 'newthread' }; } }; return g; };
const mailer = (g, over = {}) => ({ enabled: true, sender: MAILBOX, replyTo: MAILBOX, fromName: 'Elite Kitchens', gmail: g, ...over });
const reply = (g, data = { phone: ANNA, body: 'Of course, I will ring you tomorrow at 10.' }, over = {}, now = NOW) => Reply.send({ db, mailer: over.mailer || mailer(g) }, actor, data, { nowMs: now });
const bodyOf = (raw) => raw.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (m, x) => String.fromCharCode(parseInt(x, 16)));
async function arrived() { await sweep(fakeMailbox([gm('aaa111', { from: 'Anna Apple <anna@example.com>', subject: 'Quote EK-0112', text: 'Please call me.', references: '<q0@mail.example>' })])); }

test('REPLY BY EMAIL: goes to the address they wrote from, as the business mailbox, in the same Gmail conversation with the right headers; it is kept in the chat; one press, one email', async () => {
  await arrived(); const g = gmailOut(); const r = await reply(g, { phone: ANNA, body: 'Of course, I will ring you tomorrow at 10.' }, {}, NOW + 3600e3);
  assert.deepEqual([r.ok, r.to], [true, 'anna@example.com']); assert.equal(g.sent.length, 1); const raw = g.sent[0];
  assert.match(raw, /^From: "Elite Kitchens" <info@elitekitchens\.example>/m); assert.match(raw, /^To: anna@example\.com/m); assert.match(raw, /^Subject: Re: Quote EK-0112/m);
  assert.match(raw, /^In-Reply-To: <aaa111@mail\.example>/m); assert.match(raw, /^References: <q0@mail\.example> <aaa111@mail\.example>/m); assert.deepEqual(g.opts[0], { threadId: 'th_aaa111' });
  assert.equal(bodyOf(raw), 'Of course, I will ring you tomorrow at 10.');
  const out = (await emails(ANNA)).find((x) => x.direction === 'out'); assert.deepEqual([out.subject, out.to, out.by, out.confirmed, out.threadId, out.body], ['Re: Quote EK-0112', 'anna@example.com', 'thomas@example.com', true, 'th_aaa111', 'Of course, I will ring you tomorrow at 10.']);
  const c = await conv(ANNA); assert.deepEqual([c.lastEmailDir, c.lastEmailSubject, c.emailSendingUntil], ['out', 'Re: Quote EK-0112', undefined]); assert.equal(c.unreadCount, 1, 'sending does not change what is unread');
  const g2 = gmailOut(); const both = await Promise.allSettled([reply(g2, undefined, {}, NOW + 7200e3), reply(g2, undefined, {}, NOW + 7200e3)]); assert.equal(both.filter((x) => x.status === 'fulfilled').length, 1, 'a double press sends one'); assert.equal(g2.sent.length, 1);
});

test('REPLY BY EMAIL, OTHER CASES: your own subject, a customer who never emailed (their address on file, no thread), strict input, switches, and the rules', async () => {
  const g = gmailOut(); await reply(g, { phone: BOB, subject: 'About your quote', body: 'Hi Bob, any questions?' }); assert.match(g.sent[0], /^To: bob@example\.com/m); assert.match(g.sent[0], /^Subject: About your quote/m); assert.doesNotMatch(g.sent[0], /In-Reply-To/); assert.deepEqual(g.opts[0], {});
  await rejects(reply(gmailOut(), { phone: CIARA, body: 'Hello there' }), 'not-found');
  await customer(CIARA, 'Ciara Casey', null); await rejects(reply(gmailOut(), { phone: CIARA, subject: 's', body: 'Hello there' }), 'failed-precondition', /no email address/);
  await rejects(reply(gmailOut(), { phone: BOB, body: 'Hello there' }), 'invalid-argument', /Write a subject/);
  await arrived(); const g3 = gmailOut();
  for (const data of [{ phone: ANNA, body: '' }, { phone: ANNA, body: 'x' }, { phone: ANNA, body: 'x'.repeat(5001) }, { phone: ANNA, subject: 'Two\nlines', body: 'Hello there' }, { phone: ANNA, subject: 'x'.repeat(201), body: 'Hello there' }, { phone: ANNA, body: 'Hello there', to: 'other@x.ie' }, { phone: '12', body: 'Hello there' }, {}, null, []]) await rejects(reply(g3, data), 'invalid-argument');
  await rejects(reply(g3, undefined, { mailer: mailer(g3, { enabled: false }) }), 'failed-precondition', /not switched on/); await rejects(Reply.send({ db, mailer: null }, actor, { phone: ANNA, body: 'Hello there' }, { nowMs: NOW }), 'failed-precondition', /not switched on/);
  await db.doc('conversations/' + ANNA).update({ doNotContact: { on: true } }); await rejects(reply(g3), 'failed-precondition', /not to be contacted/); assert.equal(g3.sent.length, 0);
});

test('REPLY BY EMAIL, WHEN GOOGLE REFUSES OR CANNOT CONFIRM: nothing is kept after a refusal and they can try again; an unclear answer is kept in the chat as not confirmed and never retried by itself', async () => {
  await arrived(); await rejects(reply(gmailOut('refused')), 'failed-precondition', /limiting how fast email can be sent[\s\S]*Nothing was sent/);
  assert.equal((await emails(ANNA)).filter((x) => x.direction === 'out').length, 0); assert.equal((await conv(ANNA)).emailSendingUntil, undefined);
  assert.equal((await reply(gmailOut())).ok, true, 'the claim was released: they can try again');
  await rejects(reply(gmailOut('unknown'), undefined, {}, NOW + 3600e3), 'unavailable', /Not confirmed[\s\S]*Sent folder of info@elitekitchens\.example/);
  const outs = (await emails(ANNA)).filter((x) => x.direction === 'out'); assert.equal(outs.length, 2); assert.deepEqual(outs.map((x) => x.confirmed).sort(), [false, true]);
});

test('STAFF ONLY, AND THE CHECK BUTTON: the callables refuse a signed-out or other caller; "check now" needs the inbox switched on and says what it found', async () => {
  await arrived(); const g = gmailOut(); const run = (auth, data) => h.sendEmailReply(auth, data, { db, cfg, mailer: mailer(g) });
  await rejects(run(null, { phone: ANNA, body: 'Hello there' }), 'unauthenticated'); await rejects(run({ uid: 'u2', token: { email: 'x@y.ie', email_verified: true, staff: true } }, { phone: ANNA, body: 'Hello there' }), 'permission-denied'); assert.equal(g.sent.length, 0);
  assert.equal((await run(staff, { phone: ANNA, body: 'Hello there' })).ok, true);
  const mb = fakeMailbox([gm('zzz999', { from: 'bob@example.com', text: 'ok thanks' })]); const check = (auth, inbox, data) => h.checkEmail(auth, data, { db, cfg, inbox });
  await rejects(check(null, { enabled: true, reader: mb, mailbox: MAILBOX }), 'unauthenticated'); await rejects(check(staff, { enabled: false }), 'failed-precondition', /not switched on/); await rejects(check(staff, null), 'failed-precondition'); await rejects(check(staff, { enabled: true, reader: mb, mailbox: MAILBOX }, { x: 1 }), 'invalid-argument');
  assert.deepEqual(await check(staff, { enabled: true, reader: mb, mailbox: MAILBOX }), { ok: true, stored: 1, matched: 1 });
  mb.listError = new Gmail.GmailError('forbidden', 403, true); assert.deepEqual(await check(staff, { enabled: true, reader: mb, mailbox: MAILBOX }), { ok: false, stored: 0, matched: 0, error: 'forbidden' });
});

test('ERASURE: deleting a customer also deletes their emails', async () => {
  await arrived(); await reply(gmailOut(), undefined, {}, NOW + 3600e3); assert.equal((await emails(ANNA)).length, 2);
  const r = await h.deleteCustomer(staff, { phone: ANNA, confirm: ANNA.slice(-4) }, { db, cfg, bucket }); assert.ok(r);
  assert.equal((await emails(ANNA)).length, 0); assert.equal((await db.doc('conversations/' + ANNA).get()).exists, false);
});
