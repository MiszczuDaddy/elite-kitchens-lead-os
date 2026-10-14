'use strict';
// Phase 9 R2a: arranging an initial consultation, by a FIXED flow decided by code (docs/AI.md). The AI never picks slots, never promises availability and never confirms anything:
//   1. the customer is interested in a home consultation -> ask "Would any day next week suit you?"
//   2. if next week does not work -> ask once about the following week and about particular days or times
//   3. as soon as there is any reasonable preference ("Tuesday", "any day", "mornings") -> record it, acknowledge it, STOP asking and hand over to a person
//   4. at most two scheduling questions in total; if the customer still gives nothing, hand over with "no preference given"
//   5. if the customer already said when they are free, nothing is asked: straight to the acknowledgement
// The wording of every scheduling line is below, written by code. The model only reads the chat: it says whether the customer wants a consultation and extracts what they said about
// days and times; it may add one short friendly opener ("Hi Anna, thanks for getting in touch.") to the first message of a conversation. Everything else is decided here.
const TZ = 'Europe/Dublin';
const MAX_ASKS = 2;
const LINES = {
  ask_next_week: 'Would any day next week suit you for a home consultation?',
  ask_following_week: 'No problem. Would the following week suit you? Do you have any particular days or times that work best?',
  acknowledge: 'Perfect, I\'ll pass that on to the team and we\'ll confirm a time shortly.',
  no_preference: 'No problem, I\'ll pass this on to the team and we\'ll be in touch to arrange a time.',
};
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const WEEKS = ['this', 'next', 'following', 'other'];
const SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };

// ---- Irish calendar dates (weeks run Monday to Sunday) ----
function ymdOf(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, dow: SHORT.indexOf(p.weekday) };       // dow: 0 = Monday
}
const plusDays = ({ y, m, d }, n) => { const t = new Date(Date.UTC(y, m - 1, d + n)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: (t.getUTCDay() + 6) % 7 }; };
const label = (x) => `${SHORT[x.dow]} ${x.d} ${MONTHS[x.m - 1]}`;
function weekOf(nowMs, which) {
  const t = ymdOf(nowMs), monday = plusDays(t, -t.dow + { this: 0, next: 7, following: 14 }[which]);
  const days = WEEKDAYS.map((_, i) => plusDays(monday, i));
  return { monday, sunday: days[6], days, label: `${label(monday)} to ${label(days[6])}` };
}

// ---- what the customer said about when they are free ----
function cleanPreference(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const days = [...new Set((Array.isArray(raw.days) ? raw.days : []).map((d) => String(d).toLowerCase()).filter((d) => WEEKDAYS.includes(d)))];
  return { weeks: WEEKS.includes(raw.weeks) ? raw.weeks : null, days, anyDay: raw.anyDay === true, times: typeof raw.times === 'string' && raw.times.trim() ? clip(raw.times, 60) : null, text: clip(raw.text, 160) };
}
// "Reasonable": a week, some days, "any day", or a time of day. "Not sure" and silence are not.
const reasonable = (p) => !!(p && (p.weeks || p.days.length || p.anyDay || p.times));
// A clear summary for the person who will book it, with the real dates.
function describe(pref, nowMs) {
  if (!reasonable(pref)) return null;
  const week = pref.weeks && pref.weeks !== 'other' ? weekOf(nowMs, pref.weeks) : null;
  const weekLabel = week ? `${{ this: 'This week', next: 'Next week', following: 'The week after next' }[pref.weeks]} (${week.label})` : null;
  const days = pref.days.map((d) => { const i = WEEKDAYS.indexOf(d), cap = d[0].toUpperCase() + d.slice(1); return week ? `${cap} ${week.days[i].d} ${MONTHS[week.days[i].m - 1]}` : cap; });
  const parts = [weekLabel, pref.anyDay ? 'any day' : null, days.length ? days.join(', ') : null, pref.times].filter(Boolean);
  return { weeks: pref.weeks, days: pref.days, anyDay: pref.anyDay, times: pref.times, customerWords: pref.text, weekLabel, dayLabels: days, text: parts.join(' · ') };
}

// ---- how many scheduling questions have already been asked ----
// From what was recorded when a suggested question was sent, and (in case a person typed it themselves) from our own earlier messages in the chat.
function asksSoFar(consult, messages) {
  let n = Math.min(MAX_ASKS, Math.max(0, (consult && Number.isInteger(consult.asks) ? consult.asks : 0)));
  for (const m of messages || []) {
    if (m.direction !== 'out') continue;
    if (/\bfollowing week\b/i.test(m.body || '')) n = Math.max(n, 2);
    else if (/\bany day next week\b|\bnext week suits?\b/i.test(m.body || '')) n = Math.max(n, 1);
  }
  return n;
}
// The model's opener: only for the first message we send in a chat, short, a greeting or thanks, no question, nothing about times or promises.
function opener(text, hasOutbound) {
  const t = clip(text, 90);
  if (!t || hasOutbound || t.length > 80 || /[?]/.test(t) || /\d/.test(t) || /\b(book|booked|confirm|confirmed|available|availability|slot|date|time|day|days|week|weeks|tuesday|monday|wednesday|thursday|friday|saturday|sunday|promise|guarantee|price|cost|€)\b/i.test(t)) return '';
  if (!/\b(hi|hello|hey|thanks|thank you|good (?:morning|afternoon|evening))\b/i.test(t)) return '';
  return t;
}

// The plan for this message. Returns { step, reply, handover, preference }:
//   step 'none'                       nothing about scheduling is said by the system (the model's own reply is used)
//   step ask_next_week / ask_following_week / acknowledge / no_preference     a fixed line; the last two hand over
function plan({ decision, consult, messages, booked, nowMs }) {
  const none = { step: 'none', reply: null, handover: null, preference: null };
  if (!decision.wantsConsultation || booked || (decision.handover && decision.handover.needed)) return none;
  const pref = describe(decision.schedule && decision.schedule.preference, nowMs);
  if (pref) return { step: 'acknowledge', reply: LINES.acknowledge, handover: { needed: true, reason: 'consultation preference received: over to you to book' }, preference: pref };
  if (consult && consult.stage === 'preference_given') return none;                       // already handed over; nothing new to ask
  const asks = asksSoFar(consult, messages), hasOutbound = (messages || []).some((m) => m.direction === 'out');
  if (asks >= MAX_ASKS) return { step: 'no_preference', reply: LINES.no_preference, handover: { needed: true, reason: 'no preference given after two questions' }, preference: null };
  const step = asks === 0 ? 'ask_next_week' : 'ask_following_week', o = opener(decision.schedule && decision.schedule.opener, hasOutbound);
  return { step, reply: (o ? o + ' ' : '') + LINES[step], handover: null, preference: null };
}

// What to remember on the conversation once a person has sent the suggested message.
function advance(consult, step, preference, nowMs) {
  const cur = consult && typeof consult === 'object' ? consult : {};
  if (cur.stage === 'preference_given' && step !== 'acknowledge') return null;            // never move back
  if (step === 'ask_next_week') return { stage: 'asked_next_week', asks: Math.max(1, cur.asks || 0) };
  if (step === 'ask_following_week') return { stage: 'asked_following_week', asks: 2 };
  if (step === 'acknowledge') return { stage: 'preference_given', asks: cur.asks || 0, preference: preference || null, at: nowMs };
  if (step === 'no_preference') return { stage: 'no_preference', asks: 2, at: nowMs };
  return null;
}

module.exports = { LINES, MAX_ASKS, WEEKDAYS, WEEKS, cleanPreference, reasonable, describe, weekOf, asksSoFar, opener, plan, advance };
