// Opening a file that came with an email, from the Emails page (functions/lib/emailAttachment.js, docs/EMAIL_ATTACHMENTS.md). The chat keeps only the name and size of each attachment; "View" asks Gmail for that one file when
// clicked and hands it over. Nothing is stored, sent or changed; only staff; only a file the email's own record lists; every open is audited (who and which customer, never the file's name). Real Firestore emulator; Gmail
// is a fake mailbox. Every name, address and file is made up.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const Gmail = require('../lib/gmail');
const In = require('../lib/emailInbound');
const A = require('../lib/emailAttachment');
const h = require('../lib/handlers');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const NOW = Date.UTC(2026, 10, 22, 12, 0), ts = (t) => Timestamp.fromMillis(t);
const ANNA = '353871119801', cfg = { allowedEmails: 'thomas@example.com' };
const staff = { uid: 'u1', token: { email: 'thomas@example.com', email_verified: true, staff: true } };
const actor = { kind: 'staff', id: 'thomas@example.com' };
const rejects = (p, code, re) => assert.rejects(p, (e) => e.code === code && (!re || re.test(e.message)), `expected ${code}${re ? ' ' + re : ''}`);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n'), PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const GMAIL_ID = 'abc123def456';

// a Gmail message with a text part and two files: a PDF (fetched by attachment id) and a small image (inline in the message)
const message = (over = {}) => ({ id: GMAIL_ID, threadId: 't1', payload: { mimeType: 'multipart/mixed', parts: [
  { mimeType: 'text/plain', filename: '', body: { size: 5, data: Buffer.from('Hello').toString('base64url') } },
  { mimeType: 'application/pdf', filename: 'Quote QU54797.pdf', body: { size: PDF.length, attachmentId: 'ATT_PDF_1' } },
  { mimeType: 'image/png', filename: 'plan.png', body: { size: PNG.length, data: PNG.toString('base64url') } },
] }, ...over });
function mailbox(msg = message(), { attachments = { ATT_PDF_1: PDF.toString('base64url') }, failGet, failAtt } = {}) {
  const calls = { get: [], attachment: [] };
  return { calls, enabled: true, mailbox: 'info@example.com', reader: {
    async get(id, o) { calls.get.push([id, o]); if (failGet) throw failGet; return msg; },
    async attachment(id, attId) { calls.attachment.push([id, attId]); if (failAtt) throw failAtt; if (!(attId in attachments)) throw new Gmail.GmailError('refused', 404, true); return { size: 1, data: attachments[attId] }; },
  } };
}
async function chatEmail(over = {}, id = 'g_' + GMAIL_ID) {
  await db.doc('conversations/' + ANNA).set({ phone: ANNA, name: 'Anna Apple', inboxStatus: 'inbox', unreadCount: 0, createdAt: ts(NOW - 5 * 86400e3), updatedAt: ts(NOW) });
  await db.doc(`conversations/${ANNA}/emails/${id}`).set({ direction: 'in', gmailId: GMAIL_ID, subject: 'Re: quote', fromEmail: 'anna@example.com', body: 'Hello', attachments: [{ name: 'Quote QU54797.pdf', size: PDF.length }, { name: 'plan.png', size: PNG.length }], createdAt: ts(NOW), ...over });
}
const open = (inbox, data, o) => A.fetchOne({ db, inbox }, actor, data, { nowMs: NOW, ...o });
beforeEach(async () => { await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' }); await chatEmail(); });

test('OPENING A FILE: the PDF is fetched from Gmail when asked (by its attachment id), an inline file comes with the message; the answer is the file, its name, type and size; nothing is stored', async () => {
  const mb = mailbox(); const before = JSON.stringify((await db.collection('conversations').get()).docs.map((d) => [d.id, d.data()]));
  const r = await open(mb, { phone: ANNA, emailId: 'g_' + GMAIL_ID, index: 0 });
  assert.deepEqual([r.name, r.mimeType, r.size], ['Quote QU54797.pdf', 'application/pdf', PDF.length]); assert.ok(Buffer.from(r.data, 'base64').equals(PDF), 'the exact bytes, as base64');
  assert.deepEqual(mb.calls.get, [[GMAIL_ID, { full: true }]]); assert.deepEqual(mb.calls.attachment, [[GMAIL_ID, 'ATT_PDF_1']]);
  const img = await open(mb, { phone: ANNA, emailId: 'g_' + GMAIL_ID, index: 1 }); assert.deepEqual([img.name, img.mimeType, img.size], ['plan.png', 'image/png', PNG.length]); assert.ok(Buffer.from(img.data, 'base64').equals(PNG)); assert.equal(mb.calls.attachment.length, 1, 'the inline one needed no second call');
  assert.equal(JSON.stringify((await db.collection('conversations').get()).docs.map((d) => [d.id, d.data()])), before, 'nothing about the customer or the email changed');
  assert.equal((await db.collection('emailLog').get()).size, 0, 'nothing was added to the list');
});

test('AUDIT: every open is written down (who, which customer by its last four digits, when); never the file name or what is in it', async () => {
  await open(mailbox(), { phone: ANNA, emailId: 'g_' + GMAIL_ID, index: 0 });
  const log = (await db.collection('auditLog').where('action', '==', 'emailAttachmentOpened').get()).docs.map((d) => d.data());
  assert.equal(log.length, 1); assert.deepEqual([log[0].by, log[0].phoneTail], ['thomas@example.com', ANNA.slice(-4)]); assert.equal(log[0].at.toMillis(), NOW);
  assert.doesNotMatch(JSON.stringify(log), /Quote|pdf|Anna|anna@|%PDF/i);
});

test('ONLY A FILE THE EMAIL LISTS: strict input; an unknown email, file number, or an email not read from Gmail is refused; Gmail is never asked about an arbitrary message', async () => {
  const mb = mailbox(), ok = { phone: ANNA, emailId: 'g_' + GMAIL_ID, index: 0 };
  await rejects(open(mb, null), 'invalid-argument'); await rejects(open(mb, []), 'invalid-argument'); await rejects(open(mb, { ...ok, extra: 1 }), 'invalid-argument', /Unknown field: extra/);
  await rejects(open(mb, { ...ok, phone: 'abc' }), 'invalid-argument', /Missing customer/); await rejects(open(mb, { ...ok, emailId: '../x' }), 'invalid-argument', /Missing email/); await rejects(open(mb, { ...ok, emailId: 5 }), 'invalid-argument');
  for (const index of [-1, 1.5, '0', 50, null, undefined]) await rejects(open(mb, { ...ok, index }), 'invalid-argument', /Missing file number/);
  await rejects(open(mb, { ...ok, emailId: 'g_nothere1' }), 'not-found', /no longer in the chat/); await rejects(open(mb, { ...ok, index: 2 }), 'not-found', /not listed/);
  await chatEmail({ gmailId: null }); await rejects(open(mb, ok), 'failed-precondition', /not read from Gmail/); await chatEmail({ gmailId: '../../etc' }); await rejects(open(mb, ok), 'failed-precondition', /not read from Gmail/);
  assert.equal(mb.calls.get.length, 0, 'Gmail was not asked about any of these');
  await chatEmail(); await rejects(open({ enabled: false, reader: mb.reader }, ok), 'failed-precondition', /not switched on/); await rejects(open(null, ok), 'failed-precondition', /not switched on/); assert.equal(mb.calls.get.length, 0);
  assert.equal((await db.collection('auditLog').get()).size, 0, 'a refused request is not an open');
});

test('THE FILE MUST BE THE RECORDED ONE: a different name in Gmail, a missing part, or a file with nothing to fetch is refused; so is a file that is too big (listed, declared or actual)', async () => {
  const ok = { phone: ANNA, emailId: 'g_' + GMAIL_ID, index: 0 }, other = message(); other.payload.parts[1].filename = 'Something else.pdf';
  await rejects(open(mailbox(other), ok), 'not-found', /not the one that was recorded/);
  await rejects(open(mailbox(message({ payload: { parts: [] } })), ok), 'not-found', /not the one that was recorded/);
  const none = message(); none.payload.parts[1].body = { size: 10 }; await rejects(open(mailbox(none), ok), 'not-found', /no file for this one/);
  await chatEmail({ attachments: [{ name: 'Quote QU54797.pdf', size: A.MAX_BYTES + 1 }] }); const mb = mailbox(); await rejects(open(mb, ok), 'failed-precondition', /too big/); assert.equal(mb.calls.get.length, 0, 'a file listed as too big is not even fetched');
  await chatEmail(); const big = message(); big.payload.parts[1].body.size = A.MAX_BYTES + 1; await rejects(open(mailbox(big), ok), 'failed-precondition', /too big/);
  const huge = Buffer.alloc(A.MAX_BYTES + 10, 1).toString('base64url'); await rejects(open(mailbox(message(), { attachments: { ATT_PDF_1: huge } }), ok), 'failed-precondition', /too big/);
});

test('THE TYPE IS WHAT GMAIL SAYS, CHECKED: a odd or missing type becomes a plain download type; the name is the one recorded, never one Gmail sends now', async () => {
  const ok = { phone: ANNA, emailId: 'g_' + GMAIL_ID, index: 0 };
  for (const [t, want] of [['APPLICATION/PDF', 'application/pdf'], ['text/html; charset=utf-8', 'application/octet-stream'], ['no slash', 'application/octet-stream'], [undefined, 'application/octet-stream'], ['application/x"><script>', 'application/octet-stream']]) {
    const m = message(); m.payload.parts[1].mimeType = t; assert.equal((await open(mailbox(m), ok)).mimeType, want, String(t));
  }
});

test('GOOGLE REFUSES OR DOES NOT ANSWER: a plain message that says what to do; nothing is audited', async () => {
  const ok = { phone: ANNA, emailId: 'g_' + GMAIL_ID, index: 0 };
  await rejects(open(mailbox(message(), { failGet: new Gmail.GmailError('forbidden', 403, true) }), ok), 'unavailable', /not allowed Elite OS to read the mailbox/);
  await rejects(open(mailbox(message(), { failGet: new Gmail.GmailError('unavailable', 503, false) }), ok), 'unavailable', /Could not get the file from Gmail just now/);
  await rejects(open(mailbox(message(), { failAtt: new Gmail.GmailError('refused', 404, true) }), ok), 'unavailable', /no longer has that email/);
  await rejects(open(mailbox(message(), { failAtt: new Gmail.GmailError('unavailable', 500, false) }), ok), 'unavailable', /open the email in Gmail/);
  assert.equal((await db.collection('auditLog').get()).size, 0);
});

test('WHO MAY ASK: only signed-in, allowlisted staff (through the handler); the lookup is read-only (no send, no change in Gmail)', async () => {
  const mb = mailbox(), data = { phone: ANNA, emailId: 'g_' + GMAIL_ID, index: 0 }, run = (auth) => h.getEmailAttachment(auth, data, { db, cfg, inbox: mb });
  await rejects(run(null), 'unauthenticated'); await rejects(run({ uid: 'u2', token: { email: 'x@y.ie', email_verified: true, staff: true } }), 'permission-denied'); assert.equal(mb.calls.get.length, 0, 'a stranger never reaches Gmail');
  assert.equal((await run(staff)).name, 'Quote QU54797.pdf');
  const src = require('fs').readFileSync(require('path').join(__dirname, '../lib/emailAttachment.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.equal(/sendRaw|\.send\(|\.modify|\.trash|\.delete\(|\.update\(|\.set\(/.test(src), false, 'it only reads');
  const idx = require('fs').readFileSync(require('path').join(__dirname, '../index.js'), 'utf8'); assert.match(idx, /exports\.getEmailAttachment = onCall\(/);
});

test('THE MAILBOX READER: attachment() asks for exactly that message and file with a read-only sign-in; bad ids never reach Google; an error is classified', async () => {
  const seen = []; const fetchImpl = async (url, o) => { seen.push([url, o && o.method || 'GET']); return { ok: true, status: 200, text: async () => JSON.stringify({ size: 12, data: 'QUJD' }) }; };
  const reader = Gmail.createGmailReader({ apiBase: 'http://gmail.test', fetchImpl, tokens: { get: async () => 'tok' } });
  assert.deepEqual(await reader.attachment('abc123def456', 'ANGjdJ_x-Y'), { size: 12, data: 'QUJD' }); assert.deepEqual(seen, [['http://gmail.test/gmail/v1/users/me/messages/abc123def456/attachments/ANGjdJ_x-Y', 'GET']]);
  for (const [m, a] of [['zz', 'ok'], ['abc123def456', '../x'], ['abc123def456', ''], ['abc123/../x', 'ok'], ['abc123def456', 'a'.repeat(2001)]]) await assert.rejects(reader.attachment(m, a), (e) => e.code === 'bad_request');
  assert.equal(seen.length, 1, 'nothing bad was sent');
  const failing = Gmail.createGmailReader({ apiBase: 'http://gmail.test', fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }), tokens: { get: async () => 'tok' } });
  await assert.rejects(failing.attachment('abc123def456', 'ok'), (e) => e.code === 'refused' && e.status === 404);
  const nodata = Gmail.createGmailReader({ apiBase: 'http://gmail.test', fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ size: 1 }) }), tokens: { get: async () => 'tok' } });
  await assert.rejects(nodata.attachment('abc123def456', 'ok'), (e) => e.code === 'no_data');
});

test('ONE RULE FOR "FILE NUMBER N": the list kept in the chat and the lookup use the same parts in the same order', () => {
  const payload = message().payload; payload.parts.splice(1, 0, { mimeType: 'multipart/related', filename: '', parts: [{ mimeType: 'application/zip', filename: 'nested.zip', body: { size: 3, attachmentId: 'ATT_Z' } }] });
  assert.deepEqual(In.attachmentsOf(payload).map((x) => x.name), In.attachmentParts(payload).map((p) => String(p.filename).slice(0, 100)));
  assert.deepEqual(In.attachmentParts(payload).map((p) => p.filename), ['nested.zip', 'Quote QU54797.pdf', 'plan.png'], 'a file inside a nested part is found too');
});
