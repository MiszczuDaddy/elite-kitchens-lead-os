'use strict';
// A follow-up EMAIL about a quote that was sent and never answered (7 Nov 2026). From 14 Nov 2026 only once the quote is two weeks old: ONE friendly check-in, then leave them (owner's decision). Staff only; one email per press, written by a person's click (the text is shown first and can be changed: lib/followUpText.js).
//   conversations/{phone}.quoteMail.{quoteId} = { at, by, basis (the quote's sent time), confirmed, providerId, sendingUntil, sendBy }      (erased with the customer: it is part of the conversation)
// Every rule is decided HERE, again, whatever the screen showed: the quote must still be Sent (not accepted, declined or a draft) and at least 14 days (two weeks) old; the customer must not have asked not to be
// contacted, must have a valid email address and must not have written to you since the quote was sent; and ONE follow-up email per sending of the quote (sending the quote again allows one more).
// A double press, or two staff at once, sends ONE email (a claim inside a transaction). An answer we cannot confirm counts as sent: it is never retried by itself. After a send the quote's Today card is
// hidden for 7 days (the same note as "Followed up"), so it comes back for a phone call if there is still no answer.
const { HttpsError } = require('firebase-functions/v2/https');
const { Timestamp, FieldValue } = require('firebase-admin/firestore');
const { normalizePhone } = require('./whatsapp');
const Gmail = require('./gmail');
const Text = require('./followUpText');
const { GMAIL_TEXT, CLAIM_MS } = require('./followUp');
const TodayLib = require('./today');
const EmailLog = require('./emailLog');

const DAY = 24 * 3600e3, MIN_AGE_DAYS = 14, MIN_AGE_MS = MIN_AGE_DAYS * DAY, QUOTE_ID = /^q_[0-9a-f]{24}$/;
const bad = (m) => new HttpsError('invalid-argument', m);
const refuse = (m) => new HttpsError('failed-precondition', m);
const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : 0);
const when = (t) => new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', day: 'numeric', month: 'short' }).format(new Date(t));

// Why this quote may not be followed up by email now, in plain words; null when it may.
function refusal(c, quoteId, sentMs, nowMs) {
  if (c.doNotContact && c.doNotContact.on === true) return 'They asked not to be contacted.';
  if (nowMs - sentMs < MIN_AGE_MS) return 'This quote was sent less than 2 weeks ago. Give them a little longer.';
  if (ms(c.lastInboundAt) > sentMs || ms(c.emailInboundAt) > sentMs) return 'They have written to you since the quote was sent, so check the chat and reply there.';          // by WhatsApp or by email
  const m = (c.quoteMail && c.quoteMail[quoteId]) || null;
  if (m && ms(m.sendingUntil) > nowMs) return 'An email is being sent about this quote right now.';
  if (m && Number(m.basis) === sentMs && ms(m.at)) return `You already emailed them about this quote on ${when(ms(m.at))}.`;
  return null;
}

// mailer: { enabled, sender, replyTo, fromName, gmail }
async function send({ db, mailer }, actor, data, { nowMs = Date.now() } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('Missing details.');
  for (const k of Object.keys(data)) if (!['quoteId', 'subject', 'body'].includes(k)) throw bad(`Unknown field: ${k}`);
  if (typeof data.quoteId !== 'string' || !QUOTE_ID.test(data.quoteId)) throw bad('Missing quote.');
  if (!mailer || !mailer.enabled || !mailer.sender) throw refuse('Email sending is not switched on yet.');
  const quoteId = data.quoteId, qs = await db.collection('quotes').doc(quoteId).get();
  if (!qs.exists) throw new HttpsError('not-found', 'That quote is no longer there.');
  const q = qs.data(), sentMs = ms(q.sentAt);
  if (q.status !== 'sent' || !sentMs) throw refuse('Only a quote that was sent and not answered can be followed up.');
  const phone = normalizePhone(q.phone);
  if (!/^\d{9,15}$/.test(phone)) throw refuse('This quote has no customer phone number, so it cannot be followed up from here.');
  const cRef = db.collection('conversations').doc(phone), kRef = db.collection('contacts').doc(phone);
  const [conv, contact] = await Promise.all([cRef.get(), kRef.get()]);
  if (!conv.exists) throw new HttpsError('not-found', 'That customer is no longer there.');
  const c = conv.data(), k = contact.exists ? contact.data() : {}, to = String(k.email || '').trim();
  if (!to) throw refuse('This customer has no email address. Add one in their Details first.');
  if (!Gmail.EMAIL_RE.test(to)) throw refuse('The email address on this customer does not look right. Check it in their Details.');
  const why = refusal(c, quoteId, sentMs, nowMs); if (why) throw refuse(why);

  const first = Text.firstNameOf(k.name || c.name || q.customerName), ref = typeof q.ref === 'string' ? q.ref.slice(0, 40) : '';
  const subject = data.subject == null || data.subject === '' ? Text.quoteSubject(ref) : data.subject, body = data.body == null || data.body === '' ? Text.quoteBodyFor({ first, ref }) : data.body;
  if (typeof subject !== 'string' || /[\r\n]/.test(subject) || !subject.trim() || subject.length > Text.LIMIT.subject) throw bad(`The subject must be one line of up to ${Text.LIMIT.subject} characters.`);
  if (typeof body !== 'string' || body.trim().length < Text.LIMIT.bodyMin || body.length > Text.LIMIT.body) throw bad(`The email must be between ${Text.LIMIT.bodyMin} and ${Text.LIMIT.body} characters.`);

  // claim: one send at a time per quote (a double press, a second person), decided inside a transaction on fresh data
  const path = (f) => `quoteMail.${quoteId}.${f}`;
  await db.runTransaction(async (tx) => {
    const s = await tx.get(cRef);
    if (!s.exists) throw new HttpsError('not-found', 'That customer is no longer there.');
    const again = refusal(s.data(), quoteId, sentMs, nowMs); if (again) throw refuse(again);
    tx.update(cRef, { [path('sendingUntil')]: Timestamp.fromMillis(nowMs + CLAIM_MS), [path('sendBy')]: actor.id });
  });

  const release = () => cRef.update({ [path('sendingUntil')]: FieldValue.delete() }).catch(() => {});
  let raw;
  try { raw = Gmail.toRaw(Gmail.buildTextMessage({ from: mailer.sender, fromName: mailer.fromName || 'Elite Kitchens', to, replyTo: mailer.replyTo || mailer.sender, subject: subject.trim(), text: body })); }
  catch (e) { await release(); throw bad('The email could not be put together (the subject or an address is not valid). Nothing was sent.'); }
  const done = async (confirmed, providerId) => {
    await cRef.update({ [path('at')]: Timestamp.fromMillis(nowMs), [path('by')]: actor.id, [path('basis')]: sentMs, [path('confirmed')]: confirmed, [path('providerId')]: providerId || null, [path('sendingUntil')]: FieldValue.delete() });
    try { await TodayLib.snoozeQuote({ db }, actor, { id: quoteId, days: 7 }, { nowMs }); } catch (e) { /* the email is sent and recorded; only the Today note is missing, and the card says "emailed" */ }
  };
  try {
    const r = await mailer.gmail.sendRaw(raw);
    await done(true, r.id);
    await EmailLog.keepSent(db, { phone, name: k.name || c.name || q.customerName, id: `qf_${quoteId}_${sentMs}`, sender: mailer.sender, to, subject: subject.trim(), body, kind: 'quotefollowup', atMs: nowMs, confirmed: true, by: actor.id, providerId: r.id, quoteRef: ref });
    return { ok: true, sentAt: nowMs };
  } catch (e) {
    if (e instanceof Gmail.GmailError && e.definite) { await release(); throw refuse(`${GMAIL_TEXT[e.code] || `Google refused the email (code ${e.status}).`} Nothing was sent.`); }
    await done(false, null);                                                                  // Google may or may not have sent it: counted as sent, never retried by itself
    await EmailLog.keepSent(db, { phone, name: k.name || c.name || q.customerName, id: `qf_${quoteId}_${sentMs}`, sender: mailer.sender, to, subject: subject.trim(), body, kind: 'quotefollowup', atMs: nowMs, confirmed: false, by: actor.id, quoteRef: ref });
    throw new HttpsError('unavailable', `Not confirmed: we could not tell whether Google sent the email. Check the Sent folder of ${mailer.sender}. Elite OS will not send it again by itself.`);
  }
}

module.exports = { send, refusal, MIN_AGE_MS, MIN_AGE_DAYS };
