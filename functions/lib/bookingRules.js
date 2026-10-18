'use strict';
// Elite Kitchens Lead OS: which message a visit needs next (Phase 12, docs/PHASE12_BOOKINGS_PLAN.md). Pure functions only: no DOM, no Firebase, no clock of its own.
// The same file runs on the server (which enforces the rules) and in the browser (which shows the button), so the two can never disagree.
// functions/lib/bookingRules.js is the original. public/booking-rules.js must be an identical copy (a test checks it).
//
// What Elite OS remembers about what the customer was told: appointments/{id}.customerNotice = { kind, toldStart, at, wamid, reminderFor }
//   kind         the last message that went: 'confirmation' | 'change' | 'cancellation'
//   toldStart    the start time (ms) the customer was last told about
//   at           when it was sent (ms)
//   reminderFor  the start time (ms) the evening-before reminder was sent for (it is never sent twice for the same time)
// Everything else is WORKED OUT from that and the visit itself, never stored:
//   confirmation   a scheduled visit that is still to come and the customer was never told about
//   change         a scheduled visit the customer was told about, whose start has moved since
//   cancellation   a cancelled visit the customer was told about (and not yet told it was cancelled)
//   reminder       (automatic) a scheduled visit tomorrow, the customer was told its CURRENT time, not in the last 4 hours, no reminder for this time yet
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.BookingRules = factory();
})(this, function () {
  const HOUR = 3600000;
  const FRESH_MS = 4 * HOUR;                                    // told less than this ago: they have just heard it, so no reminder yet
  const NOTIFIED_TYPES = ['consultation', 'site_visit'];        // the customer is messaged about these only ('other' and 'installation' are internal)
  const KINDS = ['confirmation', 'change', 'cancellation', 'reminder'];
  const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : typeof t === 'number' && isFinite(t) ? t : null);
  const noticeOf = (a) => { const n = a && a.customerNotice; return n && typeof n === 'object' ? { kind: n.kind, toldStart: ms(n.toldStart), at: ms(n.at), reminderFor: ms(n.reminderFor) } : null; };
  const notified = (a) => !!a && NOTIFIED_TYPES.includes(a.type);

  // The button: the one message a person may send for this visit right now (or null).
  function nextAction(a, nowMs) {
    if (!notified(a)) return null;
    const n = noticeOf(a), start = ms(a.start);
    if (a.status === 'cancelled') return n && n.kind !== 'cancellation' ? 'cancellation' : null;
    if (a.status !== 'scheduled' || start == null || start <= nowMs) return null;
    if (!n) return 'confirmation';
    return n.toldStart !== start ? 'change' : null;
  }
  // The automatic evening-before reminder: due for this visit (the sweep also checks the time of day and the kill switch).
  function reminderDue(a, nowMs) {
    if (!notified(a) || a.status !== 'scheduled') return false;
    const n = noticeOf(a), start = ms(a.start);
    if (!n || start == null || start <= nowMs || n.kind === 'cancellation' || n.toldStart !== start) return false;
    if (n.reminderFor === start) return false;
    return nowMs - (n.at || 0) >= FRESH_MS;
  }
  // Words for the screen: what the customer knows.
  function describe(a, nowMs) {
    if (!notified(a)) return { state: 'none', text: '' };
    const n = noticeOf(a), start = ms(a.start), next = nextAction(a, nowMs), issue = a.noticeIssue && typeof a.noticeIssue === 'object' ? a.noticeIssue : null;
    // WhatsApp gave no answer: it may have arrived, so it is never sent again by itself. A person looks at the chat and says what happened.
    if (issue && issue.state === 'unknown') return { state: 'issue', issue: 'unknown', kind: issue.kind, next: null, text: 'WhatsApp did not say whether the last message to the customer arrived. Check the chat' };
    const tried = issue && issue.state === 'failed' ? ' (the last try failed)' : '';
    if (next === 'confirmation') return { state: 'needs', next, text: 'The customer has not been told yet' + tried };
    if (next === 'change') return { state: 'needs', next, text: 'The customer was told a different time' + tried };
    if (next === 'cancellation') return { state: 'needs', next, text: 'The customer has not been told it was cancelled' + tried };
    if (!n) return { state: 'none', text: '' };
    if (n.kind === 'cancellation') return { state: 'told', text: 'The customer was told it was cancelled' };
    return { state: 'told', text: n.reminderFor === start ? 'The customer was told, and reminded' : 'The customer was told' };
  }
  return { FRESH_MS, NOTIFIED_TYPES, KINDS, nextAction, reminderDue, describe, noticeOf };
});
