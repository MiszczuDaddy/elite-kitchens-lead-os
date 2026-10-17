'use strict';
// Phase 10 (docs/PHASE10_SAFETY_NET.md): "Do not contact". One switch on the customer's chat record that EVERY way a message can leave Elite OS checks on the server: a typed reply, a file,
// a new conversation, Reopen, a quote by WhatsApp or email (also a retry, and "Download PDF and mark as sent"), the automatic welcome for a new Meta lead and the automatic receptionist.
// Where a send is claimed in a transaction (outbound.begin, reopen, the quote delivery claim) the check is inside that same transaction, so a switch set while a send is being prepared
// still stops it. A person sets it (with an optional note), or it is set by itself when the customer writes "stop messaging me" and the like (the receptionist's own words, aiSchedule.STOP).
// Only a person switches it off again ("Allow contact again"). Nothing here sends anything, and the customer's own messages still arrive as normal.
//   conversations/{phone}.doNotContact          { on, at, by, source: 'staff' | 'customer', note }
//   conversations/{phone}.doNotContactHistory   the last 20 changes: { on, at, by, source }
const { HttpsError } = require('firebase-functions/v2/https');
const { Timestamp } = require('firebase-admin/firestore');
const { normalizePhone } = require('./whatsapp');

const TEXT = 'Not sent: this customer asked not to be contacted. To contact them again, open their chat and press "Allow contact again".';
const CUSTOMER_NOTE = 'The customer asked us to stop messaging them.';
const NOTE_MAX = 200, HISTORY_MAX = 20;
const bad = (m) => new HttpsError('invalid-argument', m);

const blocked = (conv) => !!(conv && conv.doNotContact && conv.doNotContact.on === true);
const refusal = () => new HttpsError('failed-precondition', TEXT, { reason: 'do_not_contact' });
const isRefusal = (e) => !!(e && e.details && e.details.reason === 'do_not_contact');
function assertAllowed(conv) { if (blocked(conv)) throw refusal(); }
// For a send that has no transaction of its own to put the check in: the chat as it is now (no chat yet = nothing to block).
async function assertPhoneAllowed(db, phone) {
  const s = await db.collection('conversations').doc(String(phone)).get();
  if (s.exists) assertAllowed(s.data());
}

const entry = (on, nowMs, by, source, note) => ({ on, at: Timestamp.fromMillis(nowMs), by, source, note: on ? note || null : null });
const historyOf = (c, e) => [...(Array.isArray(c.doNotContactHistory) ? c.doNotContactHistory : []), { on: e.on, at: e.at, by: e.by, source: e.source }].slice(-HISTORY_MAX);

// Staff: switch it on (with an optional note) or off. The same state again changes nothing.
async function set({ db }, actor, data, { nowMs = Date.now() } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('Missing details.');
  for (const k of Object.keys(data)) if (!['phone', 'on', 'note'].includes(k)) throw bad(`Unknown field: ${k}`);
  const phone = normalizePhone(data.phone);
  if (phone.length < 9) throw bad('Missing customer.');
  if (typeof data.on !== 'boolean') throw bad('Say whether this customer may be contacted.');
  if (data.note != null && typeof data.note !== 'string') throw bad('The note must be text.');
  const note = String(data.note || '').replace(/\s+/g, ' ').trim();
  if (note.length > NOTE_MAX) throw bad(`The note is too long (max ${NOTE_MAX} characters).`);
  const ref = db.collection('conversations').doc(phone);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) throw new HttpsError('not-found', 'Customer not found.');
    const c = s.data();
    if (blocked(c) === data.on) return { ok: true, on: data.on, unchanged: true };
    const e = entry(data.on, nowMs, actor.id, 'staff', note);
    tx.update(ref, { doNotContact: e, doNotContactHistory: historyOf(c, e) });
    return { ok: true, on: data.on };
  });
}

// The customer asked us to stop (set by code from their own words; never switched off by code). Returns true when it was switched on now.
async function customerAsked(db, phone, nowMs = Date.now()) {
  const ref = db.collection('conversations').doc(String(phone));
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists || blocked(s.data())) return false;
    const e = entry(true, nowMs, 'customer', 'customer', CUSTOMER_NOTE);
    tx.update(ref, { doNotContact: e, doNotContactHistory: historyOf(s.data(), e) });
    return true;
  });
}

module.exports = { TEXT, CUSTOMER_NOTE, NOTE_MAX, HISTORY_MAX, blocked, refusal, isRefusal, assertAllowed, assertPhoneAllowed, set, customerAsked };
