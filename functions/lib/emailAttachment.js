'use strict';
// Opening a file that came with an email, from the Emails page (22 Nov 2026, docs/EMAIL_ATTACHMENTS.md). The chat keeps only the NAME and size of each attachment; the file itself stays in Gmail. When a person clicks
// "View" the server asks Gmail for that one file (read-only sign-in) and hands it to the browser, which shows it; nothing is stored here, nothing is sent, nothing in Gmail changes.
//   in: { phone, emailId, index }  (the customer, the email's record in their chat, and which file: 0 is the first)  out: { name, mimeType, size, data (base64) }
// Only a file that the email's own record in the chat lists can be asked for (never an arbitrary Gmail message), the file found must have the very name that was recorded, and a file over MAX_BYTES is refused
// (it would not fit in the answer): open the email in Gmail. Every open is written to the audit log (who and which customer: never the file's name or contents).
const { HttpsError } = require('firebase-functions/v2/https');
const { Timestamp } = require('firebase-admin/firestore');
const { normalizePhone } = require('./whatsapp');
const { attachmentParts } = require('./emailInbound');

const MAX_BYTES = 8 * 1024 * 1024;                                         // a quote PDF is a few hundred KB; 8 MB of file is 11 MB once encoded for the answer
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,100}$/i;
const bad = (m) => new HttpsError('invalid-argument', m);
const refuse = (m) => new HttpsError('failed-precondition', m);

async function fetchOne({ db, inbox }, actor, data, { nowMs = Date.now() } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('Missing details.');
  for (const k of Object.keys(data)) if (!['phone', 'emailId', 'index'].includes(k)) throw bad(`Unknown field: ${k}`);
  const phone = normalizePhone(data.phone), emailId = data.emailId, index = data.index;
  if (!/^\d{9,15}$/.test(phone)) throw bad('Missing customer.');
  if (typeof emailId !== 'string' || !/^[A-Za-z0-9_-]{3,160}$/.test(emailId)) throw bad('Missing email.');
  if (!Number.isInteger(index) || index < 0 || index > 49) throw bad('Missing file number.');
  if (!inbox || !inbox.enabled || !inbox.reader) throw refuse('Reading the mailbox is not switched on, so the file cannot be fetched. Open the email in Gmail.');

  const snap = await db.collection('conversations').doc(phone).collection('emails').doc(emailId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'That email is no longer in the chat.');
  const rec = snap.data(), listed = Array.isArray(rec.attachments) ? rec.attachments : [], want = listed[index];
  if (!want || typeof want.name !== 'string') throw new HttpsError('not-found', 'That file is not listed on the email.');
  if (typeof rec.gmailId !== 'string' || !/^[0-9a-f]{6,32}$/i.test(rec.gmailId)) throw refuse('This email was not read from Gmail, so there is no file to fetch.');
  if (want.size > MAX_BYTES) throw refuse('This file is too big to open here (over 8 MB). Open the email in Gmail.');

  let msg;
  try { msg = await inbox.reader.get(rec.gmailId, { full: true }); }
  catch (e) { throw gone(e); }
  const part = attachmentParts(msg && msg.payload)[index];
  if (!part || String(part.filename).slice(0, 100) !== want.name) throw new HttpsError('not-found', 'The file in Gmail is not the one that was recorded (the email may have been changed or deleted). Open the email in Gmail.');
  const declared = Number(part.body && part.body.size) || 0;
  if (declared > MAX_BYTES) throw refuse('This file is too big to open here (over 8 MB). Open the email in Gmail.');
  let b64;                                                                                       // base64url from Gmail -> base64 for the browser
  if (part.body && part.body.attachmentId) {
    try { b64 = (await inbox.reader.attachment(rec.gmailId, part.body.attachmentId)).data; } catch (e) { throw gone(e); }
  } else if (part.body && typeof part.body.data === 'string') b64 = part.body.data;
  else throw new HttpsError('not-found', 'Gmail has no file for this one. Open the email in Gmail.');
  const buf = Buffer.from(b64, 'base64url');
  if (buf.length > MAX_BYTES) throw refuse('This file is too big to open here (over 8 MB). Open the email in Gmail.');
  await db.collection('auditLog').add({ action: 'emailAttachmentOpened', by: actor.id, phoneTail: phone.slice(-4), at: Timestamp.fromMillis(nowMs) }).catch(() => {});
  const mime = MIME_RE.test(String(part.mimeType || '')) ? String(part.mimeType).toLowerCase() : 'application/octet-stream';
  return { name: want.name, mimeType: mime, size: buf.length, data: buf.toString('base64') };
}
// Google refused or did not answer: say it plainly (the file is still in Gmail).
const gone = (e) => (e instanceof HttpsError ? e : new HttpsError('unavailable', e && e.code === 'forbidden' ? 'Google has not allowed Elite OS to read the mailbox yet.' : e && e.status === 404 ? 'Gmail no longer has that email. Open the mailbox to look for it.' : 'Could not get the file from Gmail just now. Try again in a moment, or open the email in Gmail.'));

module.exports = { fetchOne, MAX_BYTES };
