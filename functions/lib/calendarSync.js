// Phase 5: one-way sync Elite OS -> Google Calendar. Elite OS is the source of truth: an appointment is always saved first and
// Google is brought in line afterwards (straight away when possible, otherwise by the sweeper every few minutes).
//
// State kept on each appointment, sync.google:
//   state          pending | synced | retrying | failed | off
//   eventId        chosen once by Elite OS (eventIdFor), so every attempt targets the same event: a retry can never duplicate
//   calendarId     pinned at the first attempt
//   created        Google has confirmed the event exists
//   syncedVersion  the appointment version Google shows; in sync when it equals the appointment's version
//   attempts, failingSince, nextAttemptAt, lastAttemptAt, syncedAt, htmlLink
//   lastError      a short code only (e.g. "forbidden"), never customer data
//   leaseUntil     a short claim so the immediate push, the sweeper and "Retry now" never work on one appointment at once
// What Google should show is worked out from the appointment as it is now (scheduled -> the event exists with these details;
// cancelled -> no event), so running a push again is always harmless.
const { Timestamp } = require('firebase-admin/firestore');
const { TYPES, isAppointmentId } = require('./appointments');
const { eventIdFor, GcalError } = require('./gcal');

const MIN = 60 * 1000, DAY = 24 * 60 * MIN;
const LEASE_MS = 60 * 1000;
const BACKOFF_MIN = [1, 5, 15, 30, 60];          // then hourly
const GIVE_UP_MS = DAY;                          // after 24 hours of failures: "failed", shown with a Retry now button
const INLINE_BUDGET_MS = 8000;                   // how long a booking waits for Google before saying "will update shortly"
const SWEEP_BUDGET_MS = 20000;
const log = (level, msg, extra) => console[level === 'error' ? 'error' : 'log'](JSON.stringify({ level, msg, ...extra }));
const ts = (ms) => Timestamp.fromMillis(ms);
const configOf = (deps) => ({ ...(deps && deps.calendar), enabled: !!(deps && deps.calendar && deps.calendar.enabled && deps.calendar.calendarId && deps.gcal) });
const syncOf = (a) => (a && a.sync && a.sync.google) || {};
const backoffMs = (attempts) => BACKOFF_MIN[Math.min(Math.max(attempts, 1), BACKOFF_MIN.length) - 1] * MIN;

function formatPhone(d) {
  d = String(d || '');
  return d.startsWith('353') && d.length === 12 ? `+353 ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8)}` : '+' + d;
}

// What the event says. Name, phone and location only: internal notes never leave Elite OS. No attendees, so nobody is emailed.
function eventBody(id, a, appUrl) {
  const tz = a.timeZone || 'Europe/Dublin';
  const lines = [`Phone: ${formatPhone(a.phone)}`];
  if (appUrl) lines.push(`Open in Elite OS: ${appUrl}/#c/${a.phone}`);
  lines.push('', 'Managed by Elite OS. Changes made here are not saved back.');
  return {
    summary: `${TYPES[a.type] || 'Appointment'} – ${a.customerName || formatPhone(a.phone)}`,
    location: a.location || '',
    description: lines.join('\n'),
    start: { dateTime: new Date(a.start.toMillis()).toISOString(), timeZone: tz },
    end: { dateTime: new Date(a.end.toMillis()).toISOString(), timeZone: tz },
    status: 'confirmed',
    transparency: 'opaque',
    reminders: { useDefault: true },                       // everyone's own notification settings for the shared calendar
    extendedProperties: { private: { ekAppointmentId: id, ekVersion: String(a.version) } },
  };
}

// ---- one push: claim -> talk to Google -> record the outcome ----
async function claim(db, cfg, id, nowMs, force) {
  const ref = db.collection('appointments').doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { outcome: 'gone' };
    const a = snap.data(), s = syncOf(a);
    const upToDate = s.state === 'synced' && s.syncedVersion === a.version;
    if (!cfg.enabled) {
      if (!upToDate && s.state !== 'off') tx.update(ref, { 'sync.google.state': 'off', 'sync.google.leaseUntil': null });
      return { outcome: upToDate ? 'synced' : 'off', s };
    }
    if (upToDate) return { outcome: 'synced', s };
    if (s.leaseUntil && s.leaseUntil.toMillis() > nowMs) return { outcome: 'busy', s };
    if (!force && s.state === 'failed') return { outcome: 'failed', s };                 // waits for "Retry now" or the next change
    if (!force && s.nextAttemptAt && s.nextAttemptAt.toMillis() > nowMs) return { outcome: 'waiting', s };
    const c = { outcome: 'claimed', a, s, calendarId: s.calendarId || cfg.calendarId, eventId: s.eventId || eventIdFor(id), attempts: (s.attempts || 0) + 1 };
    tx.update(ref, { 'sync.google.leaseUntil': ts(nowMs + LEASE_MS), 'sync.google.lastAttemptAt': ts(nowMs), 'sync.google.attempts': c.attempts,
      'sync.google.calendarId': c.calendarId, 'sync.google.eventId': c.eventId });
    return c;
  });
}

async function perform(gcal, appUrl, id, c, deadline) {
  const t = () => { const left = deadline - Date.now(); if (left <= 0) throw new GcalError('timeout', 0, true); return { timeoutMs: left }; };
  if (c.a.status === 'cancelled') {                       // cancelled in Elite OS: the event goes (deleting nothing is fine)
    await gcal.deleteEvent(c.calendarId, c.eventId, t());
    return { exists: false, htmlLink: null };
  }
  const body = eventBody(id, c.a, appUrl);
  // The very first attempt simply creates the event. Any later attempt checks first, because a previous attempt may have
  // created it without us hearing back (Google does not promise to reject a second create with the same id).
  const firstEver = !c.s.created && !c.s.lastAttemptAt;
  const existing = firstEver ? null : await gcal.getEvent(c.calendarId, c.eventId, t());
  let ev;
  if (existing) ev = await gcal.updateEvent(c.calendarId, c.eventId, body, t());      // also brings back an event deleted by hand
  else {
    try { ev = await gcal.insertEvent(c.calendarId, { id: c.eventId, ...body }, t()); }
    catch (e) { if (e.code !== 'conflict') throw e; ev = await gcal.updateEvent(c.calendarId, c.eventId, body, t()); }
  }
  return { exists: true, htmlLink: (ev && ev.htmlLink) || null };
}

async function finish(db, id, c, result, nowMs) {
  const ref = db.collection('appointments').doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { state: 'gone' };                 // erased while we were talking to Google
    const a = snap.data(), s = syncOf(a);
    const changed = a.version !== c.a.version;
    const patch = { 'sync.google.leaseUntil': null };
    if (result.ok) {
      Object.assign(patch, { 'sync.google.created': result.exists, 'sync.google.htmlLink': result.htmlLink, 'sync.google.lastError': null, 'sync.google.failingSince': null, 'sync.google.attempts': 0 });
      if (changed) Object.assign(patch, { 'sync.google.state': 'pending', 'sync.google.nextAttemptAt': ts(nowMs) });     // push the newer version next
      else Object.assign(patch, { 'sync.google.state': 'synced', 'sync.google.syncedVersion': c.a.version, 'sync.google.syncedAt': ts(nowMs), 'sync.google.nextAttemptAt': null });
      tx.update(ref, patch);
      return { state: changed ? 'pending' : 'synced', htmlLink: result.htmlLink };
    }
    if (changed) {                                              // it changed meanwhile: try the newer version straight away
      tx.update(ref, { ...patch, 'sync.google.state': 'pending', 'sync.google.nextAttemptAt': ts(nowMs) });
      return { state: 'pending' };
    }
    const e = result.error, since = s.failingSince ? s.failingSince.toMillis() : nowMs;
    const giveUp = !e.retryable || nowMs - since >= GIVE_UP_MS;
    tx.update(ref, { ...patch, 'sync.google.state': giveUp ? 'failed' : 'retrying', 'sync.google.lastError': e.code || 'error',
      'sync.google.failingSince': ts(since), 'sync.google.nextAttemptAt': giveUp ? null : ts(nowMs + backoffMs(c.attempts)) });
    return { state: giveUp ? 'failed' : 'retrying', error: e.code || 'error' };
  });
}

const VISIBLE = { synced: 'synced', off: 'off', failed: 'failed', gone: 'gone' };
async function pushAppointment(deps, id, { budgetMs = INLINE_BUDGET_MS, force = false, now = Date.now } = {}) {
  const { db } = deps, cfg = configOf(deps);
  const deadline = Date.now() + budgetMs;
  for (let round = 0; round < 2; round++) {                     // a second round when the appointment changed during the first
    const c = await claim(db, cfg, id, now(), force && round === 0);
    if (c.outcome !== 'claimed') return { state: VISIBLE[c.outcome] || c.s.state || 'pending', htmlLink: (c.s && c.s.htmlLink) || null };
    let result;
    try { result = { ok: true, ...(await perform(deps.gcal, cfg.appUrl, id, c, deadline)) }; }
    catch (e) {
      result = { ok: false, error: e instanceof GcalError ? e : new GcalError('error', 0, true) };
      log('warn', 'calendar sync attempt failed', { appointment: id, code: result.error.code, status: result.error.status, attempt: c.attempts });
    }
    const r = await finish(db, id, c, result, now());
    if (r.state === 'gone') {                                    // the customer was erased mid-push: remove what we just wrote
      if (result.ok && result.exists) await removeEvents(deps, [{ calendarId: c.calendarId, eventId: c.eventId }]);
      return { state: 'gone' };
    }
    if (r.state !== 'pending' || Date.now() >= deadline) return r;
  }
  return { state: 'pending' };
}

// For the callables: never throws, never holds a booking up for more than the budget.
async function pushNow(deps, id, opts) {
  try { return await pushAppointment(deps, id, opts); }
  catch (e) { log('error', 'calendar push crashed', { appointment: id, err: String(e && e.message).slice(0, 200) }); return { state: 'pending' }; }
}

// "Retry now": start the 24-hour clock again and push straight away, whatever state it is in.
async function retryNow(deps, id) {
  if (!isAppointmentId(id)) return { state: 'unknown' };
  const ref = deps.db.collection('appointments').doc(id);
  const exists = await deps.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const s = syncOf(snap.data());
    if (s.state !== 'synced') tx.update(ref, { 'sync.google.state': 'pending', 'sync.google.attempts': 0, 'sync.google.failingSince': null, 'sync.google.nextAttemptAt': ts(Date.now()) });
    return true;
  });
  return exists ? pushNow(deps, id, { force: true }) : { state: 'unknown' };
}

// ---- erasure ----
// Read before the customer's records are deleted: which events may exist for them.
async function erasureTargets(db, phone) {
  const snap = await db.collection('appointments').where('phone', '==', phone).get();
  return snap.docs.map((d) => syncOf(d.data())).filter((s) => s.calendarId && s.eventId).map((s) => ({ calendarId: s.calendarId, eventId: s.eventId }));
}
async function scrubAndDelete(gcal, calendarId, eventId, deadline) {
  const t = () => { const left = deadline - Date.now(); if (left <= 0) throw new GcalError('timeout', 0, true); return { timeoutMs: left }; };
  const kept = await gcal.patchEvent(calendarId, eventId, { summary: 'Removed', description: '', location: '' }, t());   // blank it first
  if (kept === null) return;                                                                                       // nothing there
  await gcal.deleteEvent(calendarId, eventId, t());
}
// Removes events now when possible; anything that fails becomes a clean-up record holding only the calendar and event ids.
async function removeEvents(deps, targets, { budgetMs = INLINE_BUDGET_MS } = {}) {
  const deadline = Date.now() + budgetMs;
  let removed = 0, queued = 0;
  for (const t of targets) {
    try {
      if (!configOf(deps).enabled && !deps.gcal) throw new GcalError('off', 0, true);
      await scrubAndDelete(deps.gcal, t.calendarId, t.eventId, deadline);
      removed++;
    } catch (e) {
      await deps.db.collection('calendarCleanup').doc(t.eventId).set({ calendarId: t.calendarId, eventId: t.eventId, createdAt: ts(Date.now()),
        attempts: 0, nextAttemptAt: ts(Date.now()), lastError: (e && e.code) || 'error' });
      queued++;
    }
  }
  if (targets.length) log('info', 'calendar events removed for erasure', { removed, queued });
  return { removed, queued };
}

// ---- the sweeper (every few minutes) ----
async function sweep(deps, { now = Date.now, limit = 100, budgetMs = 4 * 60 * 1000 } = {}) {
  const cfg = configOf(deps), started = Date.now();
  const out = { pushed: 0, synced: 0, retrying: 0, failed: 0, cleaned: 0, cleanupWaiting: 0 };
  if (!cfg.enabled) return { ...out, skipped: 'off' };
  const due = (s) => !s.nextAttemptAt || s.nextAttemptAt.toMillis() <= now();
  const snap = await deps.db.collection('appointments').where('sync.google.state', 'in', ['pending', 'retrying', 'off']).limit(limit).get();
  for (const d of snap.docs) {
    if (Date.now() - started > budgetMs) break;
    if (!due(syncOf(d.data()))) continue;
    const r = await pushNow(deps, d.id, { budgetMs: SWEEP_BUDGET_MS, now });
    out.pushed++;
    if (r.state in out) out[r.state]++;
  }
  const tombs = await deps.db.collection('calendarCleanup').limit(limit).get();
  for (const d of tombs.docs) {
    if (Date.now() - started > budgetMs) break;
    const t = d.data();
    if (!due(t)) { out.cleanupWaiting++; continue; }
    try { await scrubAndDelete(deps.gcal, t.calendarId, t.eventId, Date.now() + SWEEP_BUDGET_MS); await d.ref.delete(); out.cleaned++; }
    catch (e) {
      const attempts = (t.attempts || 0) + 1;              // keeps trying (hourly at most): erasure must finish eventually
      await d.ref.update({ attempts, lastError: (e && e.code) || 'error', nextAttemptAt: ts(now() + backoffMs(attempts)) });
      out.cleanupWaiting++;
      if (now() - t.createdAt.toMillis() > DAY) log('error', 'calendar clean-up still failing after 24 hours', { attempts, code: (e && e.code) || 'error' });
    }
  }
  return out;
}

module.exports = { pushAppointment, pushNow, retryNow, erasureTargets, removeEvents, sweep, eventBody, formatPhone, BACKOFF_MIN, LEASE_MS, GIVE_UP_MS };
