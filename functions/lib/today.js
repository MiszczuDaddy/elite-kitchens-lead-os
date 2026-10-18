'use strict';
// Phase 11 (docs/PHASE11_TODAY.md): the only two things the Today tab stores. Everything else on Today is worked out from what Elite OS already knows (public/today-model.js).
//   reminders/{r_<24 hex>}      the person's own reminder or call-back: { title, phone|null, customerName|null, dueDate 'YYYY-MM-DD', dueTime 'HH:MM'|null, status open|done, doneAt, createdAt, createdBy }
//   todayMarks/quote_<quoteId>  "do not show this quote's follow-up until ...": { kind, quoteId, phone, ref, basis (the quote's sent time: a quote sent AGAIN comes back), snoozeUntil, at, by }
// Both are written only here (staff-only callables); the browser only reads. A reminder id comes from the request id, so pressing Add twice, or a bad connection, makes ONE reminder.
// Erasing a customer erases their reminders and quote notes (store.deleteCustomerData).
const crypto = require('crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const { Timestamp } = require('firebase-admin/firestore');
const { normalizePhone } = require('./whatsapp');
const { dublinToMs } = require('./appointments');

const TZ = 'Europe/Dublin', DAY = 24 * 3600e3;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/, REMINDER_ID = /^r_[0-9a-f]{24}$/, QUOTE_ID = /^q_[0-9a-f]{24}$/, TITLE_MAX = 120;
const SNOOZE_DAYS = [1, 3, 5, 7];
const bad = (m) => new HttpsError('invalid-argument', m);

const dateKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ms));          // 2026-10-18
const keyParts = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof k === 'string' ? k : ''); return m ? [+m[1], +m[2], +m[3]] : null; };
const addDays = (k, n) => { const [y, m, d] = keyParts(k), t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); };
function onlyKeys(data, allowed) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('Missing details.');
  for (const k of Object.keys(data)) if (!allowed.includes(k)) throw bad(`Unknown field: ${k}`);
}
function dueOf(data, nowMs) {
  const p = keyParts(data.dueDate);
  if (!p || new Date(Date.UTC(p[0], p[1] - 1, p[2])).toISOString().slice(0, 10) !== data.dueDate) throw bad('Choose a date.');
  const today = dateKey(nowMs);
  if (data.dueDate < today) throw bad('Choose today or a later day.');
  if (data.dueDate > addDays(today, 731)) throw bad('That date is too far ahead (two years at most).');
  let dueTime = null;
  if (data.dueTime != null && data.dueTime !== '') {
    if (typeof data.dueTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.dueTime)) throw bad('Choose a time like 16:00, or leave it empty.');
    dueTime = data.dueTime;
  }
  return { dueDate: data.dueDate, dueTime };
}
const reminderRef = (db, id) => { if (typeof id !== 'string' || !REMINDER_ID.test(id)) throw bad('Missing reminder.'); return db.collection('reminders').doc(id); };

// One callable for the reminder buttons: { action: 'create' | 'done' | 'undo' | 'snooze' | 'delete', ... }.
async function saveReminder({ db }, actor, data, { nowMs = Date.now() } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('Missing details.');
  const now = Timestamp.fromMillis(nowMs);
  switch (data.action) {
    case 'create': {
      onlyKeys(data, ['action', 'requestId', 'title', 'dueDate', 'dueTime', 'phone']);
      if (typeof data.requestId !== 'string' || !REQUEST_ID.test(data.requestId)) throw bad('Missing request id.');
      const title = typeof data.title === 'string' ? data.title.replace(/\s+/g, ' ').trim() : '';
      if (!title) throw bad('Write what to remember.');
      if (title.length > TITLE_MAX) throw bad(`That is too long (${TITLE_MAX} characters at most).`);
      const due = dueOf(data, nowMs);
      const phone = data.phone ? normalizePhone(data.phone) : null;
      if (data.phone && phone.length < 9) throw bad('That customer number does not look right.');
      const id = 'r_' + crypto.createHash('sha256').update(actor.id + '|' + data.requestId).digest('hex').slice(0, 24), ref = db.collection('reminders').doc(id);
      return db.runTransaction(async (tx) => {
        const [existing, conv, contact] = await Promise.all([tx.get(ref), phone ? tx.get(db.collection('conversations').doc(phone)) : null, phone ? tx.get(db.collection('contacts').doc(phone)) : null]);
        if (existing.exists) return { ok: true, id, existing: true };
        if (phone && !conv.exists) throw new HttpsError('not-found', 'Customer not found.');
        const customerName = phone ? (contact.exists && contact.data().name) || conv.data().name || null : null;
        tx.create(ref, { title, phone, customerName, ...due, status: 'open', requestId: data.requestId, createdAt: now, createdBy: actor.id, updatedAt: now, doneAt: null, doneBy: null });
        return { ok: true, id };
      });
    }
    case 'done': case 'undo': case 'delete': {
      onlyKeys(data, ['action', 'id']);
      const ref = reminderRef(db, data.id);
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (!s.exists) { if (data.action === 'delete') return { ok: true, unchanged: true }; throw new HttpsError('not-found', 'That reminder is no longer there.'); }
        if (data.action === 'delete') { tx.delete(ref); return { ok: true }; }
        const want = data.action === 'done' ? 'done' : 'open';
        if (s.data().status === want) return { ok: true, unchanged: true };
        tx.update(ref, want === 'done' ? { status: 'done', doneAt: now, doneBy: actor.id, updatedAt: now } : { status: 'open', doneAt: null, doneBy: null, updatedAt: now });
        return { ok: true };
      });
    }
    case 'snooze': {
      onlyKeys(data, ['action', 'id', 'dueDate', 'dueTime']);
      const ref = reminderRef(db, data.id), due = dueOf(data, nowMs);
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (!s.exists) throw new HttpsError('not-found', 'That reminder is no longer there.');
        tx.update(ref, { ...due, status: 'open', doneAt: null, doneBy: null, updatedAt: now });
        return { ok: true, ...due };
      });
    }
    default: throw bad('Unknown action.');
  }
}

// "Followed up" / "Snooze" on a quote: hide its follow-up until 08:00 Irish time N days ahead (1, 3, 5 or 7). 0 = undo. The note is tied to the quote's sent time, which the SERVER reads
// (never the screen), so sending the quote again brings the follow-up back by itself.
async function snoozeQuote({ db }, actor, data, { nowMs = Date.now() } = {}) {
  onlyKeys(data, ['id', 'days']);
  if (typeof data.id !== 'string' || !QUOTE_ID.test(data.id)) throw bad('Missing quote.');
  if (data.days !== 0 && !SNOOZE_DAYS.includes(data.days)) throw bad('Choose 1, 3, 5 or 7 days.');
  const qRef = db.collection('quotes').doc(data.id), mRef = db.collection('todayMarks').doc('quote_' + data.id);
  return db.runTransaction(async (tx) => {
    const q = await tx.get(qRef);
    if (data.days === 0) { tx.delete(mRef); return { ok: true, undone: true }; }
    if (!q.exists) throw new HttpsError('not-found', 'That quote is no longer there.');
    const d = q.data();
    if (d.status !== 'sent' || !d.sentAt) throw new HttpsError('failed-precondition', 'Only a quote that was sent and not answered can be followed up.');
    const [y, m, day] = keyParts(addDays(dateKey(nowMs), data.days)), until = dublinToMs(y, m, day, 8, 0);
    tx.set(mRef, { kind: 'quote', quoteId: data.id, phone: d.phone || null, ref: d.ref || null, basis: d.sentAt.toMillis(), snoozeUntil: Timestamp.fromMillis(until), at: Timestamp.fromMillis(nowMs), by: actor.id });
    return { ok: true, until };
  });
}

module.exports = { saveReminder, snoozeQuote, SNOOZE_DAYS, TITLE_MAX, dateKey };
