'use strict';
// Phase 12 (docs/PHASE12_BOOKINGS_PLAN.md): a project's installation date is one entry in the calendar. Setting the date creates it, changing the date moves it, clearing the date (or deleting the project) cancels it.
// It is an ordinary appointment (type "installation", appointments/{a_<24 hex>}) with one fixed id per project, so the date can never produce two entries, and it reaches the shared Google Calendar like any visit.
//   projectId        the project it belongs to
//   default time     08:00 to 16:00 Irish time on the install date; the time of day can be edited on the visit, and a later date change keeps what was edited
// The other direction: moving or cancelling the installation visit in the calendar changes the project's date in the SAME transaction (appointments.js), so the two never disagree.
// No message is ever sent to the customer about an installation (Phase 12 sends them only for consultations and site visits).
// All reads happen first (prepare), then the writes (apply), inside the caller's transaction.
const crypto = require('crypto');
const { Timestamp } = require('firebase-admin/firestore');
const A = require('./appointments');

const DEFAULT_HOUR = 8, DEFAULT_MIN = 8 * 60, MIN = 60000, HOUR = 3600000;
const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : null);
const pad = (n) => String(n).padStart(2, '0');
const installId = (projectId) => 'a_' + crypto.createHash('sha256').update('install|' + projectId).digest('hex').slice(0, 24);
const dateKeyOf = (t) => { const p = A.dublinParts(t); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };

// What the visit would be on `date` ("YYYY-MM-DD"): the time of day of the existing entry if there is one, else 08:00; the length of the existing entry, else 8 hours.
function slotFor(date, existing) {
  const [y, m, d] = date.split('-').map(Number);
  let hh = DEFAULT_HOUR, mi = 0, dur = DEFAULT_MIN;
  if (existing) { const cur = A.dublinParts(ms(existing.start)); hh = cur.h; mi = cur.mi; dur = existing.durationMin || DEFAULT_MIN; }
  const start = A.dublinToMs(y, m, d, hh, mi) ?? A.dublinToMs(y, m, d, hh + 1, mi);          // the hour that does not exist when the clocks go forward: the next one
  return { start, end: start + dur * MIN, durationMin: dur };
}

// Reads. date: the new install date or null (cleared / the project is deleted).
async function prepare(tx, db, projectId, date) {
  const id = installId(projectId), ref = db.collection('appointments').doc(id), snap = await tx.get(ref);
  const existing = snap.exists ? snap.data() : null, slot = date ? slotFor(date, existing) : null;
  let clashes = [];
  if (slot) {                                                                                  // a warning only: it never stops the date being set
    const near = await tx.get(db.collection('appointments').where('start', '>=', Timestamp.fromMillis(slot.start - 12 * HOUR)).where('start', '<', Timestamp.fromMillis(slot.end)).limit(60));
    clashes = near.docs.filter((d) => d.id !== id && d.data().status === 'scheduled' && ms(d.data().end) > slot.start && ms(d.data().start) < slot.end)
      .slice(0, 5).map((d) => ({ id: d.id, name: d.data().customerName || null, type: d.data().type, start: ms(d.data().start) }));
  }
  return { id, ref, existing, slot, clashes, date };
}

// Writes. Returns what happened, for the screen: { action: 'created' | 'moved' | 'reinstated' | 'cancelled' | 'unchanged' | 'none', id, start, end, clashes }.
function apply(tx, ctx, { p, projectId, actor, nowMs }) {
  const { id, ref, existing: a, slot, date } = ctx, at = Timestamp.fromMillis(nowMs);
  const entry = (action, start) => [...((a && a.history) || []), { action, at, by: actor.id, start: start || (a && a.start) || null }].slice(-A.HISTORY_MAX);
  if (!date) {
    if (!a || a.status === 'cancelled') return { action: 'none', id };
    tx.update(ref, { status: 'cancelled', cancelledAt: at, cancelledBy: actor, cancelReason: 'The installation date was cleared on the project', version: a.version + 1, updatedAt: at, updatedBy: actor, history: entry('cancelled'), ...A.syncPending(at) });
    return { action: 'cancelled', id };
  }
  const out = { id, start: slot.start, end: slot.end, clashes: ctx.clashes };
  if (!a) {
    tx.set(ref, { phone: p.phone, customerName: p.customerName || null, type: 'installation', start: Timestamp.fromMillis(slot.start), end: Timestamp.fromMillis(slot.end), durationMin: slot.durationMin, timeZone: A.TZ,
      location: null, notes: null, status: 'scheduled', version: 1, requestId: 'install-' + projectId, projectId, movedToBooked: false,
      createdAt: at, createdBy: actor, updatedAt: at, updatedBy: actor, cancelledAt: null, cancelledBy: null, cancelReason: null, rescheduleCount: 0,
      history: [{ action: 'created', at, by: actor.id, start: Timestamp.fromMillis(slot.start) }], sync: A.newSync(id, at) });
    return { action: 'created', ...out };
  }
  const reinstated = a.status === 'cancelled';
  if (!reinstated && ms(a.start) === slot.start && ms(a.end) === slot.end) return { action: 'unchanged', ...out };
  tx.update(ref, { status: 'scheduled', start: Timestamp.fromMillis(slot.start), end: Timestamp.fromMillis(slot.end), durationMin: slot.durationMin, customerName: p.customerName || a.customerName || null,
    cancelledAt: null, cancelledBy: null, cancelReason: null, version: a.version + 1, updatedAt: at, updatedBy: actor, rescheduleCount: (a.rescheduleCount || 0) + (reinstated ? 0 : 1),
    history: entry(reinstated ? 'reinstated' : 'rescheduled', Timestamp.fromMillis(slot.start)), ...A.syncPending(at) });
  return { action: reinstated ? 'reinstated' : 'moved', ...out };
}

module.exports = { installId, dateKeyOf, slotFor, prepare, apply, DEFAULT_MIN };
