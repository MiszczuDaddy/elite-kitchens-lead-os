'use strict';
// "Reply by email" from a customer's chat (10 Nov 2026, docs/EMAIL_INBOX.md). Staff only; one email per press, written by a person. It goes out from the business mailbox (the one the customer wrote to), in the same
// Gmail conversation (threadId, In-Reply-To, References), and is kept in the chat's email list so the thread reads in order. The server decides: the customer must not have asked not to be contacted, the address is the one
// they wrote from (or, if they never emailed, the one on their record), a double press sends ONE email (a claim inside a transaction), and an answer we cannot confirm counts as sent and is never retried by itself.
const crypto = require('crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const { Timestamp, FieldValue } = require('firebase-admin/firestore');
const { normalizePhone } = require('./whatsapp');
const Gmail = require('./gmail');
const { GMAIL_TEXT, CLAIM_MS } = require('./followUp');

const LIMIT = { subject: 200, body: 5000, bodyMin: 2 }, SAME_EMAIL_MS = 2 * 60e3;          // the very same words to the same customer twice within two minutes is a double press or a retry, not a second reply
const fingerprint = (to, subject, body) => crypto.createHash('sha256').update([to, subject.trim(), body].join('\n')).digest('hex').slice(0, 24);
const bad = (m) => new HttpsError('invalid-argument', m);
const refuse = (m) => new HttpsError('failed-precondition', m);
const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : 0);
const reSubject = (s) => { const t = String(s || '').replace(/[\r\n]+/g, ' ').trim(); return /^re:/i.test(t) ? t : 'Re: ' + (t || 'your enquiry'); };

// The newest email the customer sent us (for the address, the subject and the thread), from the newest few: no index needed.
async function latestInbound(convRef) {
  const snap = await convRef.collection('emails').orderBy('createdAt', 'desc').limit(20).get();
  const d = snap.docs.map((x) => x.data()).find((x) => x.direction === 'in');
  return d || null;
}
// mailer: { enabled, sender, replyTo, fromName, gmail } (the BUSINESS mailbox, not the follow-up one: the reply must come from the address they wrote to)
async function send({ db, mailer }, actor, data, { nowMs = Date.now() } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('Missing details.');
  for (const k of Object.keys(data)) if (!['phone', 'subject', 'body'].includes(k)) throw bad(`Unknown field: ${k}`);
  const phone = normalizePhone(data.phone);
  if (!/^\d{9,15}$/.test(phone)) throw bad('Missing customer.');
  if (!mailer || !mailer.enabled || !mailer.sender) throw refuse('Email sending is not switched on yet.');
  const convRef = db.collection('conversations').doc(phone), [conv, contact] = await Promise.all([convRef.get(), db.collection('contacts').doc(phone).get()]);
  if (!conv.exists) throw new HttpsError('not-found', 'That customer is no longer there.');
  const c = conv.data(), k = contact.exists ? contact.data() : {};
  if (c.doNotContact && c.doNotContact.on === true) throw refuse('They asked not to be contacted.');
  const inb = await latestInbound(convRef), to = inb ? inb.fromEmail : String(k.email || '').trim();
  if (!to) throw refuse('This customer has no email address. Add one in their Details first.');
  if (!Gmail.EMAIL_RE.test(to)) throw refuse('The email address does not look right. Check it in their Details.');
  const subject = data.subject == null || data.subject === '' ? (inb ? reSubject(inb.subject) : '') : data.subject, body = data.body;
  if (typeof subject !== 'string' || /[\r\n]/.test(subject) || !subject.trim() || subject.length > LIMIT.subject) throw bad(`Write a subject: one line of up to ${LIMIT.subject} characters.`);
  if (typeof body !== 'string' || body.trim().length < LIMIT.bodyMin || body.length > LIMIT.body) throw bad(`The email must be between ${LIMIT.bodyMin} and ${LIMIT.body} characters.`);

  const fp = fingerprint(to, subject, body);
  await db.runTransaction(async (tx) => {                                                     // one send at a time per customer
    const s = await tx.get(convRef);
    if (!s.exists) throw new HttpsError('not-found', 'That customer is no longer there.');
    const d = s.data(), last = d.emailLast || null;
    if (ms(d.emailSendingUntil) > nowMs) throw refuse('An email is being sent to them right now.');
    if (last && last.hash === fp && nowMs - ms(last.at) < SAME_EMAIL_MS) throw refuse('That email was just sent. Wait a couple of minutes before sending the same words again.');
    tx.update(convRef, { emailSendingUntil: Timestamp.fromMillis(nowMs + CLAIM_MS) });
  });
  const release = () => convRef.update({ emailSendingUntil: FieldValue.delete() }).catch(() => {});
  let raw;
  try {
    raw = Gmail.toRaw(Gmail.buildTextMessage({ from: mailer.sender, fromName: mailer.fromName || 'Elite Kitchens', to, replyTo: mailer.replyTo || mailer.sender, subject: subject.trim(), text: body,
      ...(inb && inb.messageId ? { inReplyTo: inb.messageId, references: [...(inb.references || []), inb.messageId] } : {}) }));
  } catch (e) { await release(); throw bad('The email could not be put together (the subject or an address is not valid). Nothing was sent.'); }
  const keep = async (confirmed, sent) => {
    const id = 'g_' + (sent && sent.id ? sent.id : 'u' + nowMs);
    await convRef.collection('emails').doc(id).set({ direction: 'out', gmailId: sent && sent.id || null, threadId: (sent && sent.threadId) || (inb && inb.threadId) || null, messageId: null, references: [], subject: subject.trim().slice(0, 200), fromEmail: mailer.sender, fromName: null, to,
      body: body.slice(0, 5000), attachments: [], createdAt: Timestamp.fromMillis(nowMs), by: actor.id, confirmed });
    await convRef.update({ lastEmailAt: FieldValue.serverTimestamp(), lastEmailSubject: subject.trim().slice(0, 120), lastEmailDir: 'out', updatedAt: FieldValue.serverTimestamp(), emailSendingUntil: FieldValue.delete(), emailLast: { hash: fp, at: Timestamp.fromMillis(nowMs) } });
  };
  try {
    const r = await mailer.gmail.sendRaw(raw, inb && inb.threadId ? { threadId: inb.threadId } : {});
    await keep(true, r);
    return { ok: true, sentAt: nowMs, to };
  } catch (e) {
    if (e instanceof Gmail.GmailError && e.definite) { await release(); throw refuse(`${GMAIL_TEXT[e.code] || `Google refused the email (code ${e.status}).`} Nothing was sent.`); }
    await keep(false, null);                                                                  // Google may or may not have sent it: kept in the thread, never retried by itself
    throw new HttpsError('unavailable', `Not confirmed: we could not tell whether Google sent the email. Check the Sent folder of ${mailer.sender}. Elite OS will not send it again by itself.`);
  }
}

module.exports = { send, latestInbound, reSubject, LIMIT };
