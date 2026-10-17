'use strict';
// Staff text and file messages (the older send paths: sendReply, sendMedia). Audit finding 6: they had no claim, so a send whose answer was
// lost, or whose chat record failed after WhatsApp had accepted the message, looked like a failure and invited a duplicate.
//
// A request id (sent by the screen with each message) is claimed in the conversation BEFORE WhatsApp is contacted:
//   sending   in progress (or the call died): another try is refused until it is old enough to count as not confirmed
//   sent      WhatsApp accepted it: the same request again returns success and sends nothing
//   failed    WhatsApp refused it (4xx), so nothing was sent: the same request may be tried again
//   unknown   we cannot tell (5xx, no answer): the same request is never sent again by itself
// The claim lives under the conversation, so erasing the customer erases it. The request id is optional (older screens send none): without one
// the message is sent as before, except that "accepted" is still never reported as "failed".
const { HttpsError } = require('firebase-functions/v2/https');
const { Timestamp } = require('firebase-admin/firestore');
const CB = require('./contactBlock');

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const STUCK_MS = 3 * 60 * 1000;                      // "sending" for longer than this is "not confirmed"
const NOT_CONFIRMED = 'Not confirmed: we could not tell whether WhatsApp sent this message. Check this chat before sending it again; Elite OS will not send it a second time by itself.';

function requestIdOf(data) {
  if (data == null || data.requestId == null) return null;
  if (typeof data.requestId !== 'string' || !REQUEST_ID.test(data.requestId)) throw new HttpsError('invalid-argument', 'Bad request id.');
  return data.requestId;
}
const claimRef = (db, phone, requestId) => db.collection('conversations').doc(phone).collection('sendRequests').doc(requestId);

// A PERSON is writing to this customer (a staff text, a file, a quote, a Reopen): recorded on the conversation BEFORE WhatsApp is contacted, so the automatic receptionist can never talk over them, however
// many messages the customer sent in between (audit 16 Oct 2026, finding 2). Best effort: it must never stop a staff send.
async function noteHuman(db, phone, nowMs = Date.now()) {
  try { await db.collection('conversations').doc(phone).update({ 'receptionist.humanAt': Timestamp.fromMillis(nowMs) }); } catch (e) { /* no such conversation: nothing to note */ }
}
// A staff send that is claimed and not finished yet (the receptionist treats it as a person writing).
const staffSending = (docs, nowMs) => docs.some((x) => !x.id.startsWith('auto_') && x.data().state === 'sending' && nowMs - (x.data().claimedAt ? x.data().claimedAt.toMillis() : 0) < STUCK_MS);

// Claim the request. { go: true } = send it; { done: true } = it was already sent (answer with success, send nothing).
// guard(tx, conversationSnapshot): for the automatic receptionist. It runs INSIDE the same transaction as the claim, just before the claim is made, and returns null (go on) or a reason (nothing is claimed,
// nothing is sent). effects: what must still happen after the send (kept in the claim, so a run that dies after WhatsApp accepted the message can finish the job).
async function begin(db, phone, requestId, nowMs = Date.now(), { guard = null, effects = null } = {}) {
  if (!requestId) return { go: true };
  const ref = claimRef(db, phone, requestId), convRef = db.collection('conversations').doc(phone);
  return db.runTransaction(async (tx) => {
    const [s, conv] = await Promise.all([tx.get(ref), tx.get(convRef)]);
    if (!conv.exists) throw new HttpsError('not-found', 'Conversation not found.');            // erased meanwhile: no claim is left behind
    const now = Timestamp.fromMillis(nowMs);
    if (s.exists && s.data().state === 'sent') return { done: true, effects: s.data().effects || null, effectsDone: s.data().effectsDone === true };
    CB.assertAllowed(conv.data());                                                                 // Phase 10: "do not contact", inside the claim (a switch set while this send was prepared stops it)
    if (guard) { const why = await guard(tx, conv); if (why) throw new HttpsError('failed-precondition', 'Not sent: ' + why, { reason: 'guard', why }); }
    if (!s.exists) { tx.create(ref, { state: 'sending', claimedAt: now, ...(effects ? { effects, effectsDone: false } : {}) }); return { go: true }; }
    const d = s.data();
    if (d.state === 'failed') { tx.update(ref, { state: 'sending', claimedAt: now, ...(effects ? { effects, effectsDone: false } : {}) }); return { go: true }; }
    const age = nowMs - (d.claimedAt ? d.claimedAt.toMillis() : 0);
    if (d.state === 'sending' && age < STUCK_MS) throw new HttpsError('failed-precondition', 'This message is already being sent.', { reason: 'in_progress' });
    throw new HttpsError('failed-precondition', NOT_CONFIRMED, { reason: 'not_confirmed' });    // unknown, or "sending" for too long: nobody has resolved it
  });
}

// Record how it ended. Best effort: a failure here must never change what the customer already received.
async function settle(db, phone, requestId, patch) {
  if (!requestId) return;
  try { await claimRef(db, phone, requestId).update({ ...patch, at: Timestamp.now() }); } catch (e) { /* the claim is only a safeguard */ }
}

// The claim as it stands (for the receptionist: was this customer message already answered, and are its effects finished?).
async function peek(db, phone, requestId) {
  const s = await claimRef(db, phone, requestId).get();
  return s.exists ? { state: s.data().state, effects: s.data().effects || null, effectsDone: s.data().effectsDone === true } : null;
}
module.exports = { requestIdOf, begin, settle, noteHuman, staffSending, peek, claimRef, STUCK_MS, NOT_CONFIRMED, REQUEST_ID };
