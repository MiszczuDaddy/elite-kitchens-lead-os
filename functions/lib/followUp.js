'use strict';
// Follow-up emails to leads who never replied (docs/FOLLOW_UP_EMAIL.md). Staff only; one email per press, written by a person's click (the text is fixed and shown first: lib/followUpText.js).
//   conversations/{phone}.followUp = { emailCount, emailAt, emailBy, confirmed, sendingUntil, sendBy }      (erased with the customer: it is part of the conversation)
// Every rule is decided HERE, again, whatever the screen showed: the lead must still be a New lead, must never have written (also checked against the chat's own messages), must not have asked
// not to be contacted, must have a valid email address, must be at least a day old, and may be emailed at most twice, 14 days apart. A double press, or two staff at once, sends ONE email (a claim
// inside a transaction). An answer we cannot confirm counts as sent: it is never retried by itself.
const { HttpsError } = require('firebase-functions/v2/https');
const { Timestamp, FieldValue } = require('firebase-admin/firestore');
const { normalizePhone } = require('./whatsapp');
const Gmail = require('./gmail');
const Text = require('./followUpText');

const DAY = 24 * 3600e3, MIN_AGE_MS = DAY, COOLDOWN_MS = 14 * DAY, MAX_EMAILS = 2, CLAIM_MS = 60e3;
const bad = (m) => new HttpsError('invalid-argument', m);
const refuse = (m) => new HttpsError('failed-precondition', m);
const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : 0);
const STAGES = ['inbox', 'booked', 'quoted', 'won', 'closed'];
const stageOf = (c) => (c && STAGES.includes(c.inboxStatus) ? c.inboxStatus : 'inbox');
const when = (t) => new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', day: 'numeric', month: 'short' }).format(new Date(t));

// The same rule as the "No reply" tab (public/noreply-model.js; a test keeps them in step).
function neverWrote(c) {
  if (!c || stageOf(c) !== 'inbox') return false;
  if (c.lastInboundAt || c.lastMessageDirection === 'in') return false;
  if (typeof c.unreadCount === 'number' && c.unreadCount > 0) return false;
  if (c.doNotContact && c.doNotContact.on === true) return false;
  return true;
}

// Why this lead may not be emailed now, in plain words; null when they may.
function refusal(c, nowMs) {
  if (c.doNotContact && c.doNotContact.on === true) return 'They asked not to be contacted.';
  if (stageOf(c) !== 'inbox') return 'They are no longer a New lead.';
  if (!neverWrote(c)) return 'They have already written to you, so there is nothing to chase.';
  const born = ms(c.createdAt) || ms(c.updatedAt);
  if (born && nowMs - born < MIN_AGE_MS) return 'They only arrived in the last 24 hours. Give them a day first.';
  const f = c.followUp || {};
  if (ms(f.sendingUntil) > nowMs) return 'An email is being sent to them right now.';
  if ((f.emailCount || 0) >= MAX_EMAILS) return 'They have already had two follow-up emails.';
  if (f.emailAt && nowMs - ms(f.emailAt) < COOLDOWN_MS) return `They were emailed on ${when(ms(f.emailAt))}. Wait until ${when(ms(f.emailAt) + COOLDOWN_MS)} before another.`;
  return null;
}

const GMAIL_TEXT = {
  rate_limited: 'Google is limiting how fast email can be sent. Try again in a few minutes.',
  forbidden: 'Google does not allow Elite OS to send as that mailbox. The Workspace authorisation or the mailbox needs checking.',
  bad_request: 'Google did not accept the address or the message.',
};

// mailer: { enabled, sender, replyTo, fromName, gmail }
async function send({ db, mailer }, actor, data, { nowMs = Date.now() } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('Missing details.');
  for (const k of Object.keys(data)) if (!['phone', 'subject', 'body'].includes(k)) throw bad(`Unknown field: ${k}`);
  const phone = normalizePhone(data.phone);
  if (!/^\d{9,15}$/.test(phone)) throw bad('Missing customer.');
  if (!mailer || !mailer.enabled || !mailer.sender) throw refuse('Email sending is not switched on yet.');
  const cRef = db.collection('conversations').doc(phone), kRef = db.collection('contacts').doc(phone);
  const [conv, contact] = await Promise.all([cRef.get(), kRef.get()]);
  if (!conv.exists) throw new HttpsError('not-found', 'That customer is no longer there.');
  const c = conv.data(), k = contact.exists ? contact.data() : {}, to = String(k.email || '').trim();
  if (!to) throw refuse('This lead has no email address. Add one in their Details first.');
  if (!Gmail.EMAIL_RE.test(to)) throw refuse('The email address on this lead does not look right. Check it in their Details.');
  const why = refusal(c, nowMs); if (why) throw refuse(why);
  if (!(await cRef.collection('messages').where('direction', '==', 'in').limit(1).get()).empty) throw refuse('They have already written to you, so there is nothing to chase.');   // an older record may not say so

  const subject = data.subject == null || data.subject === '' ? Text.SUBJECT : data.subject, body = data.body == null || data.body === '' ? Text.bodyFor({ first: Text.firstNameOf(k.name || c.name) }) : data.body;
  if (typeof subject !== 'string' || /[\r\n]/.test(subject) || !subject.trim() || subject.length > Text.LIMIT.subject) throw bad(`The subject must be one line of up to ${Text.LIMIT.subject} characters.`);
  if (typeof body !== 'string' || body.trim().length < Text.LIMIT.bodyMin || body.length > Text.LIMIT.body) throw bad(`The email must be between ${Text.LIMIT.bodyMin} and ${Text.LIMIT.body} characters.`);

  // claim: one send at a time per lead (a double press, a second person), decided inside a transaction on fresh data
  await db.runTransaction(async (tx) => {
    const s = await tx.get(cRef);
    if (!s.exists) throw new HttpsError('not-found', 'That customer is no longer there.');
    const again = refusal(s.data(), nowMs); if (again) throw refuse(again);
    tx.update(cRef, { 'followUp.sendingUntil': Timestamp.fromMillis(nowMs + CLAIM_MS), 'followUp.sendBy': actor.id });
  });

  const release = () => cRef.update({ 'followUp.sendingUntil': FieldValue.delete() }).catch(() => {});
  let raw;
  try { raw = Gmail.toRaw(Gmail.buildTextMessage({ from: mailer.sender, fromName: mailer.fromName || 'Elite Kitchens', to, replyTo: mailer.replyTo || mailer.sender, subject: subject.trim(), text: body })); }
  catch (e) { await release(); throw bad('The email could not be put together (the subject or an address is not valid). Nothing was sent.'); }
  const done = (confirmed, providerId) => cRef.update({ 'followUp.emailCount': FieldValue.increment(1), 'followUp.emailAt': Timestamp.fromMillis(nowMs), 'followUp.emailBy': actor.id, 'followUp.confirmed': confirmed, 'followUp.providerId': providerId || null, 'followUp.sendingUntil': FieldValue.delete() });
  try {
    const r = await mailer.gmail.sendRaw(raw);
    await done(true, r.id);
    return { ok: true, sentAt: nowMs };
  } catch (e) {
    if (e instanceof Gmail.GmailError && e.definite) { await release(); throw refuse(`${GMAIL_TEXT[e.code] || `Google refused the email (code ${e.status}).`} Nothing was sent.`); }
    await done(false, null);                                                                  // Google may or may not have sent it: counted as sent, never retried by itself
    throw new HttpsError('unavailable', `Not confirmed: we could not tell whether Google sent the email. Check the Sent folder of ${mailer.sender}. Elite OS will not send it again by itself.`);
  }
}

module.exports = { send, refusal, neverWrote, MIN_AGE_MS, COOLDOWN_MS, MAX_EMAILS };
