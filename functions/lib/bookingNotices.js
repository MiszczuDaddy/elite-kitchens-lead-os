'use strict';
// Phase 12 (docs/PHASE12_BOOKINGS.md): the evening-before WhatsApp reminder for a visit. It is the ONLY message Elite OS sends about a visit, it goes by itself (nobody presses anything), and it is OFF until the owner switches it on.
// Who gets one is decided by bookingRules.js (pure, shared with the screen). This file sends it, exactly once.
//
// EXACTLY ONCE: every reminder has a claim, bookingNotices/{n_<24 hex>}, whose id is worked out from the visit and its START TIME (a visit that is moved has a new start, so it can be reminded again; the same
// start is never reminded twice). The claim is made in a transaction BEFORE WhatsApp is contacted, together with the "do not contact" check, so two overlapping sweeps can never send twice.
// Same states as every other send in Elite OS:
//   sending   in progress (or the call died): another try is refused until it is old enough to count as not confirmed
//   sent      WhatsApp accepted it: asking again returns success and sends nothing
//   failed    WhatsApp refused it (4xx), so nothing was sent: tried again later, at most 3 times in all, 30 minutes apart
//   unknown   we cannot tell (5xx, no answer): NEVER sent again by itself (it may have arrived); a person looks at the chat and says whether it did
// When it went: appointments/{id}.visitReminder (see bookingRules.js) and the chat's own message list. Nothing is written to the chat if the message failed; the visit gets a note instead (noticeIssue) so it can be seen.
//   bookingNotices/{id} = { phone, appointmentId, kind: 'reminder', key, state, mode: 'text' | 'template', template, startMs, by, claimedAt, sentAt, wamid, error, errorCode, tries }
// Inside the 24-hour window the words go as a normal message; outside it, as the approved template elite_kitchens_consultation_reminder (the words live at Meta; the copy here is what staff see in the chat afterwards).
const crypto = require('crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const { Timestamp, FieldValue } = require('firebase-admin/firestore');
const R = require('./bookingRules');
const WS = require('./windowState');
const CB = require('./contactBlock');
const outbound = require('./outbound');
const A = require('./appointments');
const { refusalText, NOT_CONFIRMED } = require('./reopen');

const TZ = 'Europe/Dublin', MIN = 60000;
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
// params fill {{1}}, {{2}}... of the approved template in order; text is the same words for a normal message.
function compose({ first, type, startMs }) {
  const label = LABEL[type] || 'visit', d = dateText(startMs), t = timeText(startMs);
  return { params: [first, label, d, t], text: `Hi ${first}, a reminder that your ${label} with Elite Kitchens is tomorrow, ${d} at ${t}. If you need to change it, just reply to this message. See you then!` };
}

// ---- the claim's id ----
const noticeKey = (id, a) => `${id}|reminder|${ms(a.start)}`;
const noticeId = (key) => 'n_' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);

// ---- send one reminder ----
// deps: { db, wa, cfg } with cfg.booking = { reminder: {name, lang} } (a missing template means: only the 24-hour window can be used).
async function sendReminder({ db, wa, cfg }, { id, nowMs = Date.now() }) {
  const apptRef = A.isAppointmentId(id) ? db.collection('appointments').doc(id) : null;
  if (!apptRef) throw new HttpsError('invalid-argument', 'Missing appointment.');
  // 1. Claim, in one transaction. A claim that is stuck (the call died after claiming) or unconfirmed refuses with "not confirmed": the visit is then marked so a person can look at the chat and say what happened.
  const claim = await db.runTransaction(async (tx) => {
    const aSnap = await tx.get(apptRef);
    if (!aSnap.exists) throw new HttpsError('not-found', 'Appointment not found.');
    const a = aSnap.data();
    const key = noticeKey(id, a), nRef = db.collection('bookingNotices').doc(noticeId(key));
    const [nSnap, conv, contact] = await Promise.all([tx.get(nRef), tx.get(db.collection('conversations').doc(a.phone)), tx.get(db.collection('contacts').doc(a.phone))]);
    if (nSnap.exists) {                                                                      // the same reminder again: never a second one
      const n = nSnap.data(), age = nowMs - (ms(n.claimedAt) || 0);
      if (n.state === 'sent') return { existing: true, state: 'sent' };
      if (n.state === 'sending' && age < outbound.STUCK_MS) throw refused('This message is already being sent.', { reason: 'in_progress' });
      if (n.state !== 'failed') throw refused(NOT_CONFIRMED, { reason: 'not_confirmed' });
      if ((n.tries || 1) >= AUTO_TRIES || age < AUTO_RETRY_MS) throw refused('Not retried yet.', { reason: 'wait' });
    }
    if (!R.reminderDue(a, nowMs)) throw refused('No reminder is due for this visit.', { reason: 'not_due' });
    if (!conv.exists) throw new HttpsError('not-found', 'Customer not found.');
    const c = conv.data();
    CB.assertAllowed(c);                                                                     // Phase 10: "do not contact", inside the claim
    const mode = WS.isOpen(c, nowMs) ? 'text' : 'template';
    const first = WS.firstName((contact.exists && contact.data().name) || c.name);
    const msg = compose({ first, type: a.type, startMs: ms(a.start) });
    const tpl = cfg && cfg.booking && cfg.booking.reminder && cfg.booking.reminder.name ? cfg.booking.reminder : null;
    if (mode === 'template' && !tpl) throw refused('The customer last wrote more than 24 hours ago and no WhatsApp template is set up for the reminder, so it cannot be sent.', { reason: 'no_template' });
    const base = { phone: a.phone, appointmentId: id, kind: 'reminder', key, state: 'sending', mode, template: mode === 'template' ? tpl.name : null, startMs: ms(a.start), by: 'auto',
      claimedAt: ts(nowMs), sentAt: null, wamid: null, error: null, errorCode: null, tries: ((nSnap.exists && nSnap.data().tries) || 0) + 1 };
    if (nSnap.exists) tx.update(nRef, base); else tx.create(nRef, base);
    return { existing: false, phone: a.phone, nRef, mode, tpl, msg, startMs: ms(a.start) };
  }).catch(async (e) => {
    if (e && e.details && e.details.reason === 'not_confirmed') await markIssue(apptRef, 'unknown', NOT_CONFIRMED, nowMs);
    throw e;
  });
  if (claim.existing) return { ok: true, existing: true, state: 'sent' };

  // 2. Send. Meta refused (definite: nothing was sent) -> failed. Anything else -> not confirmed, never repeated by itself.
  const body = claim.mode === 'template' ? `[template: ${claim.tpl.name}] ${claim.msg.text}` : claim.msg.text;
  let wamid;
  try {
    wamid = claim.mode === 'text' ? await wa.sendText(claim.phone, claim.msg.text, { timeoutMs: SEND_TIMEOUT_MS })
      : await wa.sendTemplateByName(claim.phone, { name: claim.tpl.name, lang: claim.tpl.lang || 'en', params: claim.msg.params }, { timeoutMs: SEND_TIMEOUT_MS });
  } catch (e) {
    const definite = !!e && e.definite === true, text = definite ? refusalText(e) : NOT_CONFIRMED;
    log('error', definite ? 'booking reminder refused' : 'booking reminder not confirmed', { code: (e && e.code) || null });      // a code only: logs never hold customer details
    try { await claim.nRef.update({ state: definite ? 'failed' : 'unknown', error: text, errorCode: definite && e && e.code != null ? String(e.code) : null }); } catch (e2) { log('error', 'booking record failed', { kind: kindOfError(e2) }); }
    await markIssue(apptRef, definite ? 'failed' : 'unknown', text, nowMs);                // so the visit and Today can SAY it did not go
    throw new HttpsError('unavailable', text);
  }

  // 3. Meta accepted it: record it, the chat message and the visit's reminder in ONE transaction.
  try { await recordSent(db, claim, apptRef, { wamid, body, nowMs }); } catch (e) { log('error', 'booking record failed', { wamid, kind: kindOfError(e) }); }
  log('info', 'booking reminder sent', { mode: claim.mode, wamid });
  return { ok: true, existing: false, state: 'sent', mode: claim.mode };
}
// The note on the visit about the last try. A note about a message that could not be confirmed is never replaced by a plainer "refused": it still needs a person.
async function markIssue(apptRef, state, text, nowMs) {
  try {
    const cur = ((await apptRef.get()).data() || {}).noticeIssue;
    if (cur && cur.state === 'unknown' && state !== 'unknown') return;
    await apptRef.update({ noticeIssue: { kind: 'reminder', state, text, at: nowMs } });
  } catch (e) { /* the visit is gone: nothing to show */ }
}

async function recordSent(db, claim, apptRef, { wamid, body, nowMs }) {
  const convRef = db.collection('conversations').doc(claim.phone), msgRef = convRef.collection('messages').doc(wamid);
  return db.runTransaction(async (tx) => {
    const [n, a, conv, msg] = await Promise.all([tx.get(claim.nRef), tx.get(apptRef), tx.get(convRef), tx.get(msgRef)]);
    if (!n.exists || !conv.exists) return false;                                            // the customer was erased meanwhile: nothing is recreated
    tx.update(claim.nRef, { state: 'sent', sentAt: ts(nowMs), wamid });
    const type = claim.mode === 'template' ? 'template' : 'text';
    const base = { wamid, direction: 'out', type, body, media: null, createdAt: Timestamp.now(), bookingNotice: 'reminder' };
    if (msg.exists) tx.set(msgRef, base, { merge: true }); else tx.set(msgRef, { ...base, status: 'sent', error: null });
    tx.update(convRef, { updatedAt: FieldValue.serverTimestamp(), lastMessage: String(body).replace(/^\[template:[^\]]*\]\s*/, '').slice(0, 120), lastMessageType: type, lastMessageDirection: 'out' });
    if (a.exists) tx.update(apptRef, { visitReminder: { for: claim.startMs, at: nowMs, wamid }, noticeIssue: FieldValue.delete() });
    return true;
  });
}

// ---- a reminder we could not confirm: a person looks at the chat and says what happened ----
// "unknown" (WhatsApp gave no answer) is never sent again by itself, because it may have arrived. After looking at the chat a person says:
//   arrived      it did arrive: the visit is recorded as reminded (nothing is sent)
//   notArrived   it did not: the reminder may be sent again by the next check
async function resolveNotice({ db }, actor, { id, outcome }, { nowMs = Date.now() } = {}) {
  if (!['arrived', 'notArrived'].includes(outcome)) throw new HttpsError('invalid-argument', 'Say whether the message arrived.');
  if (!A.isAppointmentId(id)) throw new HttpsError('invalid-argument', 'Missing appointment.');
  const apptRef = db.collection('appointments').doc(id);
  return db.runTransaction(async (tx) => {
    const aSnap = await tx.get(apptRef);
    if (!aSnap.exists) throw new HttpsError('not-found', 'Appointment not found.');
    const a = aSnap.data(), nRef = db.collection('bookingNotices').doc(noticeId(noticeKey(id, a))), nSnap = await tx.get(nRef);
    if (!nSnap.exists) throw refused('There is no unconfirmed reminder for this visit.');
    const n = nSnap.data(), stuck = n.state === 'sending' && nowMs - (ms(n.claimedAt) || 0) >= outbound.STUCK_MS;
    if (n.state === 'sent') return { ok: true, existing: true, state: 'sent' };
    if (n.state !== 'unknown' && !stuck) throw refused(n.state === 'failed' ? 'That reminder did not go (WhatsApp refused it): it is tried again by itself.' : 'That reminder is still being sent.');
    if (outcome === 'arrived') {
      tx.update(nRef, { state: 'sent', sentAt: ts(nowMs), resolved: 'arrived', resolvedBy: actor.id });
      tx.update(apptRef, { visitReminder: { for: n.startMs != null ? n.startMs : ms(a.start), at: nowMs, wamid: null }, noticeIssue: FieldValue.delete() });
      return { ok: true, state: 'sent' };
    }
    tx.update(nRef, { state: 'failed', error: null, resolved: 'notArrived', resolvedBy: actor.id });
    tx.update(apptRef, { noticeIssue: FieldValue.delete() });
    return { ok: true, state: 'failed' };
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
    try { const r = await sendReminder({ db, wa, cfg }, { id: d.id, nowMs }); if (!r.existing) out.sent++; }
    catch (e) { out.failed++; log('error', 'booking reminder not sent', { code: kindOfError(e), reason: (e.details && e.details.reason) || null }); }
  }
  return out;
}

module.exports = { sendReminder, resolveNotice, reminderSweep, reminderWindow, compose, noticeKey, noticeId, dateText, timeText, REMIND_FROM_MIN, REMIND_TO_MIN };
