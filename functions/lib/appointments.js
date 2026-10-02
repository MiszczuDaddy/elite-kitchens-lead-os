// Phase 5: appointments. Elite OS is the source of truth: every write goes through these functions (the browser only reads).
//   appointments/{id}   one document per appointment, linked to the customer by phone (= contacts/{phone} = conversations/{phone})
// Booking a New lead moves them to Booked in the same transaction, with exactly the same rules as a manual move (stage date,
// lastMove note, correction window). Every other stage is left alone, and rescheduling or cancelling never changes the stage.
// Cancelled appointments are kept (status "cancelled") together with their history.
const crypto = require('crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const { Timestamp } = require('firebase-admin/firestore');
const { planStatusChange } = require('./store');
const { normalizePhone } = require('./whatsapp');
const { eventIdFor } = require('./gcal');

const TZ = 'Europe/Dublin';
const MIN = 60 * 1000, DAY = 24 * 60 * MIN;
const TYPES = { consultation: 'Consultation', site_visit: 'Site visit', other: 'Other' };
const STEP_MIN = 15;
const DEFAULT_DURATION = 60;
const MAX_DURATION = 8 * 60;
const MAX_PAST_MS = DAY;              // a same-day appointment can still be entered a little late
const MAX_AHEAD_MS = 731 * DAY;       // up to two years ahead
const TEXT = { location: 200, notes: 2000, reason: 300 };
const HISTORY_MAX = 20;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
const APPT_ID = /^a_[0-9a-f]{24}$/;

const bad = (msg) => new HttpsError('invalid-argument', msg);

// ---- Dublin wall clock (Intl, no library) ----
function dublinParts(ms) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}
const offsetAt = (ms) => { const p = dublinParts(ms); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(ms / MIN) * MIN; };
// The instant Dublin's clock shows y-m-d h:mi, or null when that wall time does not exist (the hour skipped when the clocks
// go forward). In the hour that happens twice when they go back, the later one is used.
function dublinToMs(y, m, d, h, mi) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const ms = guess - offsetAt(guess - offsetAt(guess));
  const p = dublinParts(ms);
  return p.y === y && p.m === m && p.d === d && p.h === h && p.mi === mi ? ms : null;
}
const pad = (n) => String(n).padStart(2, '0');

// ---- input checks ----
function onlyKeys(data, allowed) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('Missing details.');
  for (const k of Object.keys(data)) if (!allowed.includes(k)) throw bad(`Unknown field: ${k}`);
}
function text(v, max, label) {
  if (v == null) return null;
  if (typeof v !== 'string') throw bad(`${label} must be text.`);
  const t = v.trim();
  if (t.length > max) throw bad(`${label} is too long (max ${max} characters).`);
  return t || null;
}
function typeOf(v) {
  if (!Object.hasOwn(TYPES, v)) throw bad('Choose Consultation, Site visit or Other.');
  return v;
}
// Date "YYYY-MM-DD" + time "HH:MM" (Dublin, 15-minute steps) + duration in minutes -> instants. No past/future check here.
function parseSlot({ date, time, durationMin }) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof date === 'string' ? date : '');
  if (!dm) throw bad('Choose a date.');
  const y = +dm[1], m = +dm[2], d = +dm[3];
  const real = new Date(Date.UTC(y, m - 1, d));
  if (real.getUTCFullYear() !== y || real.getUTCMonth() !== m - 1 || real.getUTCDate() !== d) throw bad('That date does not exist.');
  const tm = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(typeof time === 'string' ? time : '');
  if (!tm) throw bad('Choose a time.');
  const h = +tm[1], mi = +tm[2];
  if (mi % STEP_MIN) throw bad('Times go in 15-minute steps (e.g. 10:00, 10:15, 10:30).');
  const dur = durationMin == null ? DEFAULT_DURATION : durationMin;
  if (!Number.isInteger(dur) || dur < STEP_MIN || dur > MAX_DURATION || dur % STEP_MIN) throw bad('Duration must be between 15 minutes and 8 hours, in 15-minute steps.');
  const start = dublinToMs(y, m, d, h, mi);
  if (start == null) throw bad('That time does not exist in Ireland: the clocks go forward that night.');
  return { start, end: start + dur * MIN, durationMin: dur };
}
function checkWindow(start, nowMs) {
  if (start < nowMs - MAX_PAST_MS) throw bad('That is more than a day in the past.');
  if (start > nowMs + MAX_AHEAD_MS) throw bad('Appointments can be booked up to two years ahead.');
}
function checkVersion(a, expected) {
  if (expected == null) return;
  if (!Number.isInteger(expected)) throw bad('Bad version.');
  if (expected !== a.version) throw new HttpsError('failed-precondition', 'This appointment was changed by someone else. Please check it and try again.');
}
const isAppointmentId = (id) => typeof id === 'string' && APPT_ID.test(id);
function appointmentRef(db, id) {
  if (!isAppointmentId(id)) throw bad('Missing appointment.');
  return db.collection('appointments').doc(id);
}
// Google Calendar follows every change (see calendarSync.js): a new appointment starts as "pending" with the event id it will
// always use; any later change sets it back to "pending" so the new version is pushed.
const newSync = (id, at) => ({ google: { state: 'pending', eventId: eventIdFor(id), calendarId: null, created: false, syncedVersion: 0, attempts: 0,
  failingSince: null, nextAttemptAt: at, lastAttemptAt: null, syncedAt: null, lastError: null, htmlLink: null, leaseUntil: null } });
const syncPending = (at) => ({ 'sync.google.state': 'pending', 'sync.google.attempts': 0, 'sync.google.failingSince': null, 'sync.google.nextAttemptAt': at });
// The same request (double click, network retry, a future automation retrying) always lands on the same document.
const appointmentId = (phone, requestId) => 'a_' + crypto.createHash('sha256').update(phone + '|' + requestId).digest('hex').slice(0, 24);
const withHistory = (a, entry) => [...(a.history || []), entry].slice(-HISTORY_MAX);
const nameOf = (contact, conv) => (contact && contact.exists && contact.data().name) || (conv && conv.exists && conv.data().name) || null;
const summary = (id, a) => ({ id, status: a.status, version: a.version, start: a.start.toMillis(), end: a.end.toMillis() });

// ---- create ----
async function create(db, actor, data, nowMs = Date.now()) {
  onlyKeys(data, ['phone', 'date', 'time', 'durationMin', 'type', 'location', 'notes', 'requestId']);
  const phone = normalizePhone(data.phone);
  if (phone.length < 9) throw bad('Missing customer.');
  if (typeof data.requestId !== 'string' || !REQUEST_ID.test(data.requestId)) throw bad('Missing request id.');
  const slot = parseSlot(data);
  checkWindow(slot.start, nowMs);
  const type = data.type == null ? 'consultation' : typeOf(data.type);
  const location = text(data.location, TEXT.location, 'Location');
  const notes = text(data.notes, TEXT.notes, 'Notes');
  const id = appointmentId(phone, data.requestId);
  const ref = db.collection('appointments').doc(id);
  const convRef = db.collection('conversations').doc(phone), contactRef = db.collection('contacts').doc(phone);
  return db.runTransaction(async (tx) => {
    const [existing, conv, contact] = await Promise.all([tx.get(ref), tx.get(convRef), tx.get(contactRef)]);
    if (existing.exists) {               // the same request again: nothing new is written
      const a = existing.data();
      return { ...summary(id, a), existing: true, stage: a.movedToBooked ? { from: 'inbox', to: 'booked' } : null };
    }
    if (!conv.exists) throw new HttpsError('not-found', 'Customer not found.');
    const c = conv.data();
    let stage = null;
    if ((c.inboxStatus || 'inbox') === 'inbox') {      // New lead -> Booked, exactly like a manual move. Every other stage is left alone.
      const plan = planStatusChange(c, 'booked', nowMs);
      tx.update(convRef, plan.patch);
      stage = { from: 'inbox', to: 'booked', corrected: plan.result.corrected };
    }
    const at = Timestamp.fromMillis(nowMs), start = Timestamp.fromMillis(slot.start);
    const a = {
      phone, customerName: nameOf(contact, conv), type,
      start, end: Timestamp.fromMillis(slot.end), durationMin: slot.durationMin, timeZone: TZ,
      location, notes,             // notes are internal: they never leave Elite OS
      status: 'scheduled', version: 1, requestId: data.requestId, movedToBooked: !!stage,
      createdAt: at, createdBy: actor, updatedAt: at, updatedBy: actor,
      cancelledAt: null, cancelledBy: null, cancelReason: null,
      rescheduleCount: 0, history: [{ action: 'created', at, by: actor.id, start }],
      sync: newSync(id, at),
    };
    tx.set(ref, a);
    return { ...summary(id, a), existing: false, stage };
  });
}

// ---- reschedule / edit ----
// Any of date, time, durationMin, type, location, notes. Date/time/duration default to the current ones, so a duration-only
// change works. A new time must be within the booking window; editing the details of a past appointment is still allowed.
async function update(db, actor, data, nowMs = Date.now()) {
  onlyKeys(data, ['id', 'date', 'time', 'durationMin', 'type', 'location', 'notes', 'expectedVersion']);
  const ref = appointmentRef(db, data.id);
  const wantsSlot = data.date != null || data.time != null || data.durationMin != null;
  const type = data.type === undefined ? undefined : typeOf(data.type);
  const location = data.location === undefined ? undefined : text(data.location, TEXT.location, 'Location');
  const notes = data.notes === undefined ? undefined : text(data.notes, TEXT.notes, 'Notes');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Appointment not found.');
    const a = snap.data();
    if (a.status === 'cancelled') throw new HttpsError('failed-precondition', 'This appointment was cancelled. Book a new one instead.');
    checkVersion(a, data.expectedVersion);
    const [conv, contact] = await Promise.all([tx.get(db.collection('conversations').doc(a.phone)), tx.get(db.collection('contacts').doc(a.phone))]);
    const patch = {};
    let moved = false;
    if (wantsSlot) {
      const cur = dublinParts(a.start.toMillis());
      const slot = parseSlot({ date: data.date ?? `${cur.y}-${pad(cur.m)}-${pad(cur.d)}`, time: data.time ?? `${pad(cur.h)}:${pad(cur.mi)}`, durationMin: data.durationMin ?? a.durationMin });
      if (slot.start !== a.start.toMillis()) { checkWindow(slot.start, nowMs); patch.start = Timestamp.fromMillis(slot.start); moved = true; }
      if (slot.end !== a.end.toMillis()) { patch.end = Timestamp.fromMillis(slot.end); patch.durationMin = slot.durationMin; }
    }
    if (type !== undefined && type !== a.type) patch.type = type;
    if (location !== undefined && location !== a.location) patch.location = location;
    if (notes !== undefined && notes !== a.notes) patch.notes = notes;
    if (!Object.keys(patch).length) return { ...summary(ref.id, a), unchanged: true };
    const name = nameOf(contact, conv);
    if (name && name !== a.customerName) patch.customerName = name;     // keep the name current while the appointment changes
    const at = Timestamp.fromMillis(nowMs);
    const rescheduled = !!(patch.start || patch.end);
    Object.assign(patch, {
      version: a.version + 1, updatedAt: at, updatedBy: actor,
      rescheduleCount: (a.rescheduleCount || 0) + (moved ? 1 : 0),
      history: withHistory(a, { action: rescheduled ? 'rescheduled' : 'edited', at, by: actor.id, start: patch.start || a.start }),
    }, syncPending(at));
    tx.update(ref, patch);
    return { ...summary(ref.id, { ...a, ...patch }), unchanged: false };
  });
}

// ---- cancel ----
// Keeps the appointment and its history (status "cancelled"). Never touches the customer's stage. Cancelling twice is harmless.
async function cancel(db, actor, data, nowMs = Date.now()) {
  onlyKeys(data, ['id', 'reason', 'expectedVersion']);
  const ref = appointmentRef(db, data.id);
  const reason = text(data.reason, TEXT.reason, 'Reason');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Appointment not found.');
    const a = snap.data();
    if (a.status === 'cancelled') return { ...summary(ref.id, a), alreadyCancelled: true };
    checkVersion(a, data.expectedVersion);
    const at = Timestamp.fromMillis(nowMs);
    const patch = { status: 'cancelled', cancelledAt: at, cancelledBy: actor, cancelReason: reason,
      version: a.version + 1, updatedAt: at, updatedBy: actor, history: withHistory(a, { action: 'cancelled', at, by: actor.id }), ...syncPending(at) };
    tx.update(ref, patch);
    return { ...summary(ref.id, { ...a, ...patch }), alreadyCancelled: false };
  });
}

module.exports = { TYPES, TZ, DEFAULT_DURATION, HISTORY_MAX, create, update, cancel, dublinToMs, appointmentId, isAppointmentId };
