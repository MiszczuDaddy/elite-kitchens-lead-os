'use strict';
// Your phone calendar in Elite OS (23 Nov 2026, docs/PHONE_CALENDAR.md). Once a day, at midnight Irish time, Elite OS reads the business Google Calendar that the phone shows (read-only: it never creates, changes or
// deletes anything in it) and keeps a copy of what is on it, so the Calendar screen can show it in its own colour beside the appointments.
//   externalEvents/{g_<event id>} = { source: 'google', title, location, start, end, allDay, busy, private, htmlLink, importedAt }
//   externalSync/state            = { ok, lastRunAt, count, truncated, by, error?, triedAt? }   (what the Calendar screen says about the last check)
// Only a window is kept: 14 days back to 180 days ahead. What is stored is the title, place and time: never the description or the guests. An event Elite OS itself put in Google Calendar (an appointment: its id
// starts with "ek") is skipped, so nothing shows twice. A check that fails (Google down, the calendar not shared) changes NOTHING already stored, so a bad night never empties the screen; the screen says it failed.
const { Timestamp } = require('firebase-admin/firestore');
const { dublinToMs } = require('./appointments');

const DAY = 24 * 3600e3, PAST_DAYS = 14, FUTURE_DAYS = 180, PAGE_MAX = 6, KEEP_MAX = 3000, MIN_GAP_MS = 5 * 60e3, BATCH = 400;
const OS_EVENT = /^ek[0-9a-f]{32}$/;                                   // the id Elite OS gives the events it creates (gcal.js eventIdFor)
const SKIP_TYPES = ['workingLocation', 'birthday'];                    // Google's own noise: "Home / Office" markers and contact birthdays
const text = (v, n) => { const s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); return s ? (s.length > n ? s.slice(0, n - 1) + '…' : s) : null; };
const docIdOf = (id) => 'g_' + String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 150);
const linkOf = (u) => (typeof u === 'string' && /^https:\/\/(www\.)?google\.com\/calendar\//.test(u) ? u.slice(0, 600) : null);
const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : typeof t === 'number' ? t : null);

// One Google event -> what is kept, or null when it is not for the screen.
function parse(ev) {
  if (!ev || typeof ev !== 'object' || typeof ev.id !== 'string' || !ev.id) return null;
  if (ev.status === 'cancelled' || OS_EVENT.test(ev.id) || SKIP_TYPES.includes(ev.eventType)) return null;
  const me = Array.isArray(ev.attendees) ? ev.attendees.find((a) => a && a.self) : null; if (me && me.responseStatus === 'declined') return null;     // you said no to it
  const s = ev.start || {}, e = ev.end || {}, allDay = !!s.date && !s.dateTime;
  let start, end;
  if (allDay) { const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.date), b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(e.date || ''); if (!a) return null; start = dublinToMs(+a[1], +a[2], +a[3], 0, 0); end = b ? dublinToMs(+b[1], +b[2], +b[3], 0, 0) : start + DAY; }
  else { start = Date.parse(s.dateTime); end = Date.parse(e.dateTime); if (!Number.isFinite(start)) return null; if (!Number.isFinite(end)) end = start + 30 * 60e3; }
  if (end <= start) end = start + (allDay ? DAY : 30 * 60e3);
  return { source: 'google', title: text(ev.summary, 200) || 'Busy', location: text(ev.location, 200), start: Timestamp.fromMillis(start), end: Timestamp.fromMillis(end), allDay, busy: ev.transparency !== 'transparent',
    private: ev.visibility === 'private' || ev.visibility === 'confidential', htmlLink: linkOf(ev.htmlLink) };
}
const same = (a, b) => ['title', 'location', 'allDay', 'busy', 'private', 'htmlLink'].every((k) => (a[k] == null ? null : a[k]) === (b[k] == null ? null : b[k])) && ms(a.start) === ms(b.start) && ms(a.end) === ms(b.end);

// The check itself. deps: { db, gcal (the Calendar client), calendarId, nowMs, by }. Returns { ok, count, written, removed } or { ok: false, error }.
async function run({ db, gcal, calendarId, nowMs = Date.now(), by = 'midnight' }) {
  const stateRef = db.doc('externalSync/state'), timeMin = nowMs - PAST_DAYS * DAY, timeMax = nowMs + FUTURE_DAYS * DAY;
  if (!calendarId || !gcal) return { ok: false, error: 'off' };
  let items = [], token = null, pages = 0, truncated = false;
  try {
    do { const r = await gcal.listEvents(calendarId, { timeMin, timeMax, pageToken: token }); items = items.concat(r.items); token = r.next; pages++; if (token && pages >= PAGE_MAX) { truncated = true; token = null; } } while (token);
  } catch (e) {
    const code = String((e && e.code) || 'unknown').slice(0, 40);
    await stateRef.set({ ok: false, error: code, triedAt: Timestamp.fromMillis(nowMs), by }, { merge: true }).catch(() => {});                       // the earlier copy stays as it was
    return { ok: false, error: code };
  }
  const fresh = {}; for (const ev of items) { const d = parse(ev); if (d) fresh[docIdOf(ev.id)] = d; }
  const have = await db.collection('externalEvents').limit(KEEP_MAX).get(), ops = [];
  const known = {}; for (const d of have.docs) known[d.id] = d.data();
  for (const [id, d] of Object.entries(fresh)) if (!known[id] || !same(known[id], d)) ops.push({ id, set: { ...d, importedAt: Timestamp.fromMillis(nowMs) } });
  for (const [id, d] of Object.entries(known)) {
    if (id in fresh) continue;
    const inWindow = ms(d.end) > timeMin;                                                                       // inside what was asked for: it is gone from Google (deleted or moved)
    if (!inWindow || !truncated) ops.push({ id, remove: true });                                                 // old ones are tidied away; a list cut short never removes what it did not reach
  }
  for (let n = 0; n < ops.length; n += BATCH) {
    const b = db.batch();
    for (const o of ops.slice(n, n + BATCH)) { const ref = db.collection('externalEvents').doc(o.id); if (o.remove) b.delete(ref); else b.set(ref, o.set); }
    await b.commit();
  }
  await stateRef.set({ ok: true, lastRunAt: Timestamp.fromMillis(nowMs), count: Object.keys(fresh).length, truncated, by, error: null, triedAt: Timestamp.fromMillis(nowMs) }, { merge: true });
  return { ok: true, count: Object.keys(fresh).length, written: ops.filter((o) => o.set).length, removed: ops.filter((o) => o.remove).length, truncated };
}

// "Refresh now" from the Calendar screen: the same check, but not more than once every five minutes (the screen is told).
async function refresh(deps) {
  const st = await deps.db.doc('externalSync/state').get(), last = st.exists ? ms(st.data().triedAt) || ms(st.data().lastRunAt) : null, nowMs = deps.nowMs || Date.now();
  if (last && nowMs - last < MIN_GAP_MS && st.data().ok === true) return { ok: true, tooSoon: true, count: st.data().count || 0 };
  return run({ ...deps, nowMs, by: 'staff' });
}

module.exports = { run, refresh, parse, OS_EVENT, PAST_DAYS, FUTURE_DAYS, MIN_GAP_MS };
