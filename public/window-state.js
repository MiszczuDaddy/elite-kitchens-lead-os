'use strict';
// Elite Kitchens Lead OS: the WhatsApp 24-hour window and "Reopen conversation" (Phase 6.1 M1, docs/PHASE6_1_PLAN.md).
// Pure functions only: no DOM, no Firebase. The same file runs on the server (which enforces the rules) and in the browser
// (which shows them), so the two can never disagree.
// functions/lib/windowState.js is the original. public/window-state.js must be an identical copy (a test checks it).
//
// The state is WORKED OUT, never stored, from the customer's last message (conversations/{phone}.lastInboundAt, written by the
// webhook) and the last Reopen template (conversations/{phone}.reopen, written by reopen.js):
//   open      the customer wrote within the last 24 hours: normal messages and files are allowed
//   awaiting  a Reopen template was sent after their last message (within 24 hours) and has not failed: still NO normal messages
//             until the CUSTOMER replies. Sending the template does not reopen anything.
//   closed    otherwise: only an approved template can be sent (at most one Reopen per customer per 24 hours)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.WindowState = factory();
})(this, function () {
  const HOUR = 3600 * 1000;
  const WINDOW_MS = 24 * HOUR;                 // WhatsApp's customer-service window
  const REOPEN_CAP_MS = 24 * HOUR;             // at most one Reopen template per customer in this time
  const STUCK_MS = 3 * 60 * 1000;              // a send still "sending" after this long is treated as not confirmed
  const BLOCKS_RETRY = /^(131049|131050)\b/;   // Meta: "wait 24 hours" / "the customer opted out": an undelivered template with these still counts

  const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : typeof t === 'number' ? t : null);
  const isOpen = (conv, nowMs) => { const lastIn = ms(conv && conv.lastInboundAt); return !!lastIn && nowMs - lastIn < WINDOW_MS; };

  // What happened to the last Reopen template. msg = its stored chat message ({status, error}) when known: Meta's delivery
  // statuses reach it through the webhook. waiting: it may be in the customer's hands. counts: it uses up the 24-hour allowance.
  // A template Meta refused, or reports as never delivered (for example it expired), does not count: the customer never saw it.
  function reopenOutcome(r, nowMs, msg) {
    if (!r || !r.state) return null;
    const at = ms(r.sentAt) || ms(r.claimedAt);
    if (!at) return null;
    if (r.state === 'failed') return { kind: 'refused', at, error: r.error || null, waiting: false, counts: false };
    if (r.state === 'unknown') return { kind: 'unsure', at, error: r.error || null, waiting: true, counts: true };
    if (r.state === 'sending') {
      return nowMs - at > STUCK_MS ? { kind: 'unsure', at, error: null, waiting: true, counts: true }
        : { kind: 'sending', at, error: null, waiting: true, counts: true };
    }
    if (r.state === 'sent') {
      const st = msg && msg.status;
      if (st === 'failed') { const error = (msg && msg.error) || null; return { kind: 'undelivered', at, error, waiting: false, counts: BLOCKS_RETRY.test(String(error || '')) }; }
      return { kind: st === 'read' ? 'read' : st === 'delivered' ? 'delivered' : 'sent', at, error: null, waiting: true, counts: true };
    }
    return null;
  }

  // conv: the conversation document. reopenMsg: the stored message of conv.reopen.wamid, or null.
  function windowStatus(conv, nowMs, reopenMsg) {
    const lastIn = ms(conv && conv.lastInboundAt);
    if (isOpen(conv, nowMs)) return { state: 'open', openUntil: lastIn + WINDOW_MS, canReopen: false, nextReopenAt: null, reopen: null };
    const r = reopenOutcome(conv && conv.reopen, nowMs, reopenMsg);
    const out = { state: 'closed', openUntil: null, canReopen: true, nextReopenAt: null, reopen: r };
    if (!r) return out;
    const young = nowMs - r.at < REOPEN_CAP_MS;
    if (r.counts && young) { out.canReopen = false; out.nextReopenAt = r.at + REOPEN_CAP_MS; }
    if (r.waiting && young && (!lastIn || r.at > lastIn)) out.state = 'awaiting';
    return out;
  }

  // The customer's first name for the template: the first word of their name, or "there" when there is no usable name.
  function firstName(name) {
    const t = String(name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    const first = t.split(' ')[0] || '';
    return !first || first.length > 40 || /^[+\d()\-.]+$/.test(first) ? 'there' : first;
  }

  // The wording of the approved Reopen template (docs/PHASE6_1_PLAN.md, "Meta templates"). The words themselves live at Meta;
  // this copy is what staff see before sending and in the chat afterwards, so keep it in step with the approved template.
  const reopenText = (first) => `Hi ${first}, it's Elite Kitchens. We have a quick question regarding your project. When you have a moment, please reply here and we'll continue the conversation.`;

  return { WINDOW_MS, REOPEN_CAP_MS, STUCK_MS, isOpen, windowStatus, reopenOutcome, firstName, reopenText };
});
