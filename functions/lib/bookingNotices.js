'use strict';
// Phase 12 (docs/PHASE12_BOOKINGS_PLAN.md): the WhatsApp messages about a visit: confirmation, change, cancellation (a person presses a button) and the evening-before reminder (automatic).
// Which message a visit needs is decided by bookingRules.js (pure, shared with the screen). This file sends it, exactly once.
//
// EXACTLY ONCE: every message has a claim, bookingNotices/{n_<24 hex>}, whose id is worked out from the visit and the message (confirmation: one per visit; change: one per VERSION of the visit;
// cancellation: one per visit; reminder: one per visit START TIME). The claim is made in a transaction BEFORE WhatsApp is contacted, together with the "do not contact" check, so a double click,
// a retry, two people or two overlapping sweeps can never send twice. Same states as every other send in Elite OS:
//   sending   in progress (or the call died): another try is refused until it is old enough to count as not confirmed
//   sent      WhatsApp accepted it: asking again returns success and sends nothing
//   failed    WhatsApp refused it (4xx), so nothing was sent: a person may try again (the automatic reminder tries at most 3 times, 30 minutes apart)
//   unknown   we cannot tell (5xx, no answer): NEVER sent again by itself
// When it went: appointments/{id}.customerNotice (see bookingRules.js) and the chat's own message list. Nothing is written to the chat if the message failed.
//   bookingNotices/{id} = { phone, appointmentId, kind, key, state, mode: 'text' | 'template', template, startMs, by, claimedAt, sentAt, wamid, error, errorCode, tries }
// Inside the 24-hour window the words go as a normal message; outside it, as the approved template (the words live at Meta; the copy here is what staff see in the chat afterwards).
const crypto = require('crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const { Timestamp, FieldValue } = require('firebase-admin/firestore');
const R = require('./bookingRules');
const WS = require('./windowState');
const CB = require('./contactBlock');
const store = require('./store');
const outbound = require('./outbound');
const A = require('./appointments');
const { refusalText, NOT_CONFIRMED } = require('./reopen');

const TZ = 'Europe/Dublin', MIN = 60000, HOUR = 3600000;
const REMIND_FROM_MIN = 17 * 60, REMIND_TO_MIN = 19 * 60 + 30;        // the reminder goes out between 17:00 and 19:30 Irish time, never at night
const AUTO_TRIES = 3, AUTO_RETRY_MS = 30 * MIN, SEND_TIMEOUT_MS = 20000;
const log = (level, msg, extra) => console[level === 'error' ? 'error' : 'log'](JSON.stringify({ level, msg, ...extra }));
const kindOfError = (e) => String((e && (e.code || e.name)) || 'Error').slice(0, 60);
const refused = (msg, details) => new HttpsError('failed-precondition', msg, details);
const ts = (ms) => Timestamp.fromMillis(ms);
const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : typeof t === 'number' ? t : null);

// ---- the words ----
const FMT_DATE = new Intl.DateTimeFormat('en-IE', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
const FMT_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const LABEL = { consultation: 'consultation', site_visit: 'site visit' };
const dateText = (t) => FMT_DATE.format(new Date(t)).replace(',', '');
const timeText = (t) => FMT_TIME.format(new Date(t));
// The customer's area: the TOWN only (never the full address), as the template says. Nothing known: "your area".
const areaOf = (conv, contact) => { const t = String((conv && conv.location) || (contact && contact.location) || '').replace(/\s+/g, ' ').trim(); return t && t.length <= 60 ? t : 'your area'; };
// kind -> { template: which setting, params: what fills {{1}}, {{2}}... of the approved template, text: the same words for a normal message }.
function compose(kind, { first, type, startMs, area }) {
  const label = LABEL[type] || 'visit', d = dateText(startMs), t = timeText(startMs);
  if (kind === 'confirmation') return { template: 'confirmation', params: [first, label, d, t, area],
    text: `Hi ${first}, your ${label} with Elite Kitchens is confirmed for ${d} at ${t}. We will call out to you in ${area}. If you need to change the time, just reply to this message and we will sort it out. Thank you!` };
  if (kind === 'reminder') return { template: 'reminder', params: [first, label, d, t],
    text: `Hi ${first}, a reminder that your ${label} with Elite Kitchens is tomorrow, ${d} at ${t}. If you need to change it, just reply to this message. See you then!` };
  const phrase = kind === 'cancellation' ? 'it has been cancelled' : `it is now on ${d} at ${t}`;             // change and cancellation share ONE approved template: the news is the {{3}}
  return { template: 'change', params: [first, label, phrase], text: `Hi ${first}, an update on your ${label} with Elite Kitchens: ${phrase}. If you have any questions, just reply to this message and we will help. Thank you!` };
}

// ---- the claim's id ----
function noticeKey(kind, id, a) {
  if (kind === 'confirmation' || kind === 'cancellation') return `${id}|${kind}`;
  if (kind === 'change') return `${id}|change|v${a.version}`;
  return `${id}|reminder|${ms(a.start)}`;
}
const noticeId = (key) => 'n_' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);

// Why a message may not go, in the words a person reads.
function whyNot(kind, a) {
  const n = R.noticeOf(a);
  if (!R.NOTIFIED_TYPES.includes(a.type)) return 'This kind of visit does not send messages to the customer.';
  if (kind === 'confirmation') return n ? 'The customer was already sent a confirmation.' : a.status !== 'scheduled' ? 'This visit is cancelled.' : 'This visit is in the past.';
  if (kind === 'change') return !n ? 'The customer has not been told about this visit yet: send the confirmation.' : a.status !== 'scheduled' ? 'This visit is cancelled.' : 'The customer already knows this time.';
  if (kind === 'cancellation') return !n ? 'The customer was never told about this visit, so there is nothing to cancel on their side.' : a.status !== 'cancelled' ? 'This visit is not cancelled.' : 'The customer was already told it was cancelled.';
  return 'No reminder is due for this visit.';
}

// ---- send one message ----
// deps: { db, wa, cfg } with cfg.booking = { confirmation: {name, lang}, change: {...}, reminder: {...} } (a missing one means "no template": only the 24-hour window can be used).
async function sendNotice({ db, wa, cfg }, { id, kind, actor, auto = false, expectedVersion = null, nowMs = Date.now() }) {
  if (!R.KINDS.includes(kind)) throw new HttpsError('invalid-argument', 'Unknown message.');
  const apptRef = A.isAppointmentId(id) ? db.collection('appointments').doc(id) : null;
  if (!apptRef) throw new HttpsError('invalid-argument', 'Missing appointment.');
  // 1. Claim, in one transaction.
  const claim = await db.runTransaction(async (tx) => {
    const aSnap = await tx.get(apptRef);
    if (!aSnap.exists) throw new HttpsError('not-found', 'Appointment not found.');
    const a = aSnap.data();
    if (!R.NOTIFIED_TYPES.includes(a.type)) throw refused(whyNot(kind, a));
    if (expectedVersion != null && expectedVersion !== a.version) throw refused('This visit was changed by someone else. Please check it and try again.');
    const key = noticeKey(kind, id, a), nRef = db.collection('bookingNotices').doc(noticeId(key));
    const convRef = db.collection('conversations').doc(a.phone);
    const [nSnap, conv, contact] = await Promise.all([tx.get(nRef), tx.get(convRef), tx.get(db.collection('contacts').doc(a.phone))]);
    if (nSnap.exists) {                                                                      // the same message again: never a second one
      const n = nSnap.data(), age = nowMs - (ms(n.claimedAt) || 0);
      if (n.state === 'sent') return { existing: true, state: 'sent' };
      if (n.state === 'sending' && age < outbound.STUCK_MS) throw refused('This message is already being sent.', { reason: 'in_progress' });
      if (n.state !== 'failed') throw refused(NOT_CONFIRMED, { reason: 'not_confirmed' });
      if (auto && ((n.tries || 1) >= AUTO_TRIES || nowMs - (ms(n.claimedAt) || 0) < AUTO_RETRY_MS)) throw refused('Not retried yet.', { reason: 'wait' });
    }
    const due = kind === 'reminder' ? R.reminderDue(a, nowMs) : R.nextAction(a, nowMs) === kind;
    if (!due) throw refused(whyNot(kind, a));
    if (!conv.exists) throw new HttpsError('not-found', 'Customer not found.');
    const c = conv.data();
    CB.assertAllowed(c);                                                                     // Phase 10: "do not contact", inside the claim
    const mode = WS.isOpen(c, nowMs) ? 'text' : 'template';
    const first = WS.firstName((contact.exists && contact.data().name) || c.name);
    const msg = compose(kind, { first, type: a.type, startMs: ms(a.start), area: areaOf(c, contact.exists ? contact.data() : null) });
    const tpl = cfg && cfg.booking && cfg.booking[msg.template] && cfg.booking[msg.template].name ? cfg.booking[msg.template] : null;
    if (mode === 'template' && !tpl) throw refused('The customer last wrote more than 24 hours ago and no WhatsApp template is set up for this message, so it cannot be sent.', { reason: 'no_template' });
    const base = { phone: a.phone, appointmentId: id, kind, key, state: 'sending', mode, template: mode === 'template' ? tpl.name : null, startMs: ms(a.start), by: actor.id,
      claimedAt: ts(nowMs), sentAt: null, wamid: null, error: null, errorCode: null, tries: ((nSnap.exists && nSnap.data().tries) || 0) + 1 };
    if (nSnap.exists) tx.update(nRef, base); else tx.create(nRef, base);
    return { existing: false, phone: a.phone, nRef, mode, tpl, msg, startMs: ms(a.start), version: a.version };
  });
  if (claim.existing) return { ok: true, existing: true, state: 'sent' };

  // 2. Send. Meta refused (definite: nothing was sent) -> failed. Anything else -> not confirmed, never repeated by itself.
  if (!auto) await outbound.noteHuman(db, claim.phone);                                      // a person is writing: the automatic receptionist stays out
  const body = claim.mode === 'template' ? `[template: ${claim.tpl.name}] ${claim.msg.text}` : claim.msg.text;
  let wamid;
  try {
    wamid = claim.mode === 'text' ? await wa.sendText(claim.phone, claim.msg.text, { timeoutMs: SEND_TIMEOUT_MS })
      : await wa.sendTemplateByName(claim.phone, { name: claim.tpl.name, lang: claim.tpl.lang || 'en', params: claim.msg.params }, { timeoutMs: SEND_TIMEOUT_MS });
  } catch (e) {
    const definite = !!e && e.definite === true, text = definite ? refusalText(e) : NOT_CONFIRMED;
    log('error', definite ? 'booking message refused' : 'booking message not confirmed', { kind, code: (e && e.code) || null });      // a code only: logs never hold customer details
    try { await claim.nRef.update({ state: definite ? 'failed' : 'unknown', error: text, errorCode: definite && e && e.code != null ? String(e.code) : null }); } catch (e2) { log('error', 'booking record failed', { kind: kindOfError(e2) }); }
    throw new HttpsError('unavailable', text);
  }

  // 3. Meta accepted it: record it, the chat message and what the customer now knows in ONE transaction. If the visit changed meanwhile, the message still really went: the record says what it said.
  try { await recordSent(db, claim, apptRef, { wamid, body, kind, nowMs }); } catch (e) { log('error', 'booking record failed', { wamid, kind: kindOfError(e) }); }
  log('info', 'booking message sent', { kind, mode: claim.mode, wamid });
  return { ok: true, existing: false, state: 'sent', mode: claim.mode };
}

async function recordSent(db, claim, apptRef, { wamid, body, kind, nowMs }) {
  const convRef = db.collection('conversations').doc(claim.phone), msgRef = convRef.collection('messages').doc(wamid);
  return db.runTransaction(async (tx) => {
    const [n, a, conv, msg] = await Promise.all([tx.get(claim.nRef), tx.get(apptRef), tx.get(convRef), tx.get(msgRef)]);
    if (!n.exists || !conv.exists) return false;                                            // the customer was erased meanwhile: nothing is recreated
    tx.update(claim.nRef, { state: 'sent', sentAt: ts(nowMs), wamid });
    const type = claim.mode === 'template' ? 'template' : 'text';
    const base = { wamid, direction: 'out', type, body, media: null, createdAt: Timestamp.now(), bookingNotice: kind };
    if (msg.exists) tx.set(msgRef, base, { merge: true }); else tx.set(msgRef, { ...base, status: 'sent', error: null });
    tx.update(convRef, { updatedAt: FieldValue.serverTimestamp(), lastMessage: String(body).replace(/^\[template:[^\]]*\]\s*/, '').slice(0, 120), lastMessageType: type, lastMessageDirection: 'out' });
    if (a.exists) {
      const prev = R.noticeOf(a.data()) || {};
      tx.update(apptRef, { customerNotice: kind === 'reminder'
        ? { kind: prev.kind || 'confirmation', toldStart: prev.toldStart != null ? prev.toldStart : claim.startMs, at: prev.at != null ? prev.at : nowMs, wamid: (a.data().customerNotice || {}).wamid || wamid, reminderFor: claim.startMs, reminderAt: nowMs }
        : { kind, toldStart: kind === 'cancellation' ? (prev.toldStart != null ? prev.toldStart : claim.startMs) : claim.startMs, at: nowMs, wamid, reminderFor: null } });
    }
    return true;
  });
}

// ---- the automatic evening-before reminder ----
// Irish time now, and the Irish calendar day that starts after it: { open, from, to } where from/to bound "tomorrow". Never outside 17:00 to 19:30; clock-change days follow the Irish clock.
function reminderWindow(nowMs) {
  const p = A.dublinParts(nowMs), minutes = p.h * 60 + p.mi;
  const day = (add) => { const d = new Date(Date.UTC(p.y, p.m - 1, p.d + add)); return A.dublinToMs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, 0); };
  return { open: minutes >= REMIND_FROM_MIN && minutes < REMIND_TO_MIN, from: day(1), to: day(2) };
}
async function reminderSweep({ db, wa, cfg }, { nowMs = Date.now() } = {}) {
  const out = { sent: 0, skipped: 0, failed: 0 };
  if (!cfg || !cfg.booking || cfg.booking.remindersOn !== true) return { ...out, off: true };           // the kill switch
  const win = reminderWindow(nowMs);
  if (!win.open) return { ...out, quiet: true };
  const snap = await db.collection('appointments').where('start', '>=', ts(win.from)).where('start', '<', ts(win.to)).limit(300).get();
  for (const d of snap.docs) {
    if (!R.reminderDue(d.data(), nowMs)) { out.skipped++; continue; }
    try { const r = await sendNotice({ db, wa, cfg }, { id: d.id, kind: 'reminder', actor: { id: 'auto' }, auto: true, nowMs }); if (!r.existing) out.sent++; }
    catch (e) { out.failed++; log('error', 'booking reminder not sent', { code: kindOfError(e), reason: (e.details && e.details.reason) || null }); }
  }
  return out;
}

module.exports = { sendNotice, reminderSweep, reminderWindow, compose, noticeKey, noticeId, whyNot, dateText, timeText, REMIND_FROM_MIN, REMIND_TO_MIN };
