'use strict';
// Elite Kitchens Lead OS: the evening-before visit reminder (Phase 12, docs/PHASE12_BOOKINGS.md). Pure functions only: no DOM, no Firebase, no clock of its own.
// The same file runs on the server (which decides who gets a reminder) and in the browser (which shows what happened), so the two can never disagree.
// functions/lib/bookingRules.js is the original. public/booking-rules.js must be an identical copy (a test checks it).
//
// The only message Elite OS sends about a visit is the REMINDER, by itself, the evening before. What it remembers on the visit:
//   appointments/{id}.visitReminder = { for, at, wamid }   the reminder was sent for the visit's start time `for` (ms), at `at` (ms). A visit that is moved has a new start, so it can be reminded again.
//   appointments/{id}.noticeIssue   = { kind: 'reminder', state: 'failed' | 'unknown', text, at }   the last try did not go (failed: WhatsApp refused it; unknown: WhatsApp gave no answer, it may have arrived)
// Everything else is WORKED OUT, never stored.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.BookingRules = factory();
})(this, function () {
  const HOUR = 3600000;
  const FRESH_MS = 4 * HOUR;                                    // a visit booked or changed less than this long ago gets no reminder: the customer has just heard the time
  const NOTIFIED_TYPES = ['consultation', 'site_visit'];        // only these are reminded ('other' and 'installation' are internal)
  const KINDS = ['reminder'];
  const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : typeof t === 'number' && isFinite(t) ? t : null);
  const notified = (a) => !!a && NOTIFIED_TYPES.includes(a.type);
  const reminderOf = (a) => { const r = a && a.visitReminder; return r && typeof r === 'object' ? { for: ms(r.for), at: ms(r.at) } : null; };

  // Is a reminder due for this visit? (The sweep also checks the time of day, "tomorrow" and the kill switch.)
  function reminderDue(a, nowMs) {
    if (!notified(a) || a.status !== 'scheduled') return false;
    const start = ms(a.start);
    if (start == null || start <= nowMs) return false;
    const r = reminderOf(a);
    if (r && r.for === start) return false;                     // already reminded about this time
    return nowMs - (ms(a.updatedAt) || ms(a.createdAt) || 0) >= FRESH_MS;
  }
  // Words for the screen. state: 'none' | 'told' (the reminder went) | 'issue' (no answer from WhatsApp: a person looks at the chat) | 'failed' (WhatsApp refused it).
  function describe(a, nowMs) {
    if (!notified(a)) return { state: 'none', text: '' };
    const start = ms(a.start), issue = a.noticeIssue && typeof a.noticeIssue === 'object' ? a.noticeIssue : null, r = reminderOf(a);
    if (issue && a.status === 'scheduled' && start != null && start > nowMs) {
      if (issue.state === 'unknown') return { state: 'issue', issue: 'unknown', kind: 'reminder', text: 'WhatsApp did not say whether the reminder arrived. Check the chat' };
      return { state: 'failed', kind: 'reminder', text: 'The reminder could not be sent' + (issue.text ? ': ' + issue.text : '') };
    }
    if (r && r.for === start && a.status === 'scheduled') return { state: 'told', text: 'Reminder sent' };
    return { state: 'none', text: '' };
  }
  return { FRESH_MS, NOTIFIED_TYPES, KINDS, reminderDue, describe, reminderOf };
});
