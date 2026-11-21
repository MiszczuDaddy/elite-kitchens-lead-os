'use strict';
// Follow-up emails to leads who never replied (docs/FOLLOW_UP_EMAIL.md), in the Inbox's "No reply" tab: an Email button on each lead who has an address, and "Email all" for the lot. Nothing is sent without a
// person reading the email first and pressing Send; the server decides again who may be emailed (functions/lib/followUp.js). Loaded after app.js (it uses its S, $, el, call, ms, toast and noReplyRows).
window.FOLLOWUP = (() => {
  const DAY = 86400000, COOLDOWN = 14 * DAY, MAX_BATCH = 30, TX = window.FollowUpText;
  const showDialog = (d) => { if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', ''); };
  const hideDialog = (d) => { if (typeof d.close === 'function') d.close(); else d.removeAttribute('open'); };
  const F = { rows: [], one: null, busy: false, quote: null };
  const say = (text) => (window.TODAY && typeof TODAY.toast === 'function' ? TODAY.toast(text) : toast(text));          // the quote buttons are on Today: its own message line is the one on screen
  const HINT_LEAD = 'It goes out from Elite Kitchens by email, and their reply comes to your normal inbox. A lead is emailed at most twice, 14 days apart.', HINT_QUOTE = 'It goes out from Elite Kitchens by email, and their reply comes to your normal inbox. Each quote is followed up by email once. The quote comes back on Today in 7 days if there is still no answer.';

  const emailOf = (c) => String(((S.dirMap && S.dirMap.get(c.id)) || {}).email || '').trim();
  const firstOf = (c) => TX.firstNameOf(c.name);
  const fmtDay = (t) => new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', day: 'numeric', month: 'short' }).format(new Date(t));
  // The screen's own check (the server checks again): a day old, an address, not emailed twice, not emailed in the last 14 days.
  function canEmail(c, now = Date.now()) {
    if (!emailOf(c)) return false;
    const days = NoReply.ageDays(c, now); if (days == null || days < 1) return false;
    const f = c.followUp || {}, at = ms(f.emailAt);
    return !((f.emailCount || 0) >= 2 || (at && now - at < COOLDOWN));
  }
  const emailedText = (c) => { const f = c.followUp || {}; return f.emailAt ? 'emailed ' + fmtDay(ms(f.emailAt)) : ''; };
  const eligible = () => (typeof noReplyRows === 'function' ? noReplyRows() : []).filter((c) => canEmail(c));

  // the bar above the list: only in the No reply tab, only when someone can be emailed
  function render() {
    const bar = $('nr-bar'); if (!bar) return;
    const on = S.statusFilter === 'noreply' && !S.query.trim(), n = on ? Math.min(eligible().length, MAX_BATCH) : 0;
    bar.hidden = !n; if (n) $('nr-email-all').textContent = 'Email all (' + n + ')';
  }

  function openFor(rows) {
    F.rows = rows; F.one = rows.length === 1 ? rows[0] : null; F.quote = null; $('fu-err').textContent = ''; $('fu-hint').textContent = HINT_LEAD;
    const dlg = $('fu-dlg'), batch = rows.length > 1;
    $('fu-title').textContent = batch ? `Email ${rows.length} leads who never replied` : 'Email ' + (rows[0].name || 'this lead');
    $('fu-to').textContent = batch ? 'Each email starts with that lead\'s first name ({first}). Read it, change it if you like, then press Send.' : 'To: ' + emailOf(rows[0]);
    $('fu-subject').value = TX.SUBJECT;
    $('fu-body').value = TX.bodyFor({ first: batch ? '{first}' : firstOf(rows[0]) });
    const list = $('fu-batch'); list.hidden = !batch; list.replaceChildren();
    if (batch) for (const c of rows) list.append(el('div', 'fu-rcpt', (c.name || formatPhone(c.id)) + ' · ' + emailOf(c)));
    $('fu-send').disabled = false; $('fu-send').textContent = batch ? `Send ${rows.length} emails` : 'Send email'; $('fu-cancel').textContent = 'Cancel';
    showDialog(dlg); $('fu-body').focus();
  }
  const openOne = (id) => { const c = eligible().find((x) => x.id === id) || (typeof noReplyRows === 'function' ? noReplyRows() : []).find((x) => x.id === id); if (c && emailOf(c)) openFor([c]); };
  const openAll = () => { const rows = eligible().slice(0, MAX_BATCH); if (rows.length) openFor(rows); };

  // the row now says it was emailed, at once (the server's record arrives a moment later; an older lead outside the live list has no live copy to update)
  const markSent = (c) => { c.followUp = { ...(c.followUp || {}), emailAt: { toMillis: () => Date.now() }, emailCount: ((c.followUp || {}).emailCount || 0) + 1 }; renderList(); };

  // A quote that was sent and never answered: the card on Today. The customer's address is read when the button is pressed (it is not on the card).
  async function openQuote(c) {
    if (F.busy) return;
    let email = '', name = c.name || '';
    try { const k = await db.collection('contacts').doc(c.phone).get(); if (k.exists) { email = String(k.data().email || '').trim(); name = name || String(k.data().name || ''); } }
    catch (e) { say('Could not look up their email address. Try again.'); return; }
    if (!email) { say((name || 'This customer') + ' has no email address. Add one in their Details first.'); return; }
    F.rows = []; F.one = null; F.quote = { quoteId: c.quoteId, name, first: TX.firstNameOf(name) }; $('fu-err').textContent = ''; $('fu-hint').textContent = HINT_QUOTE;
    $('fu-title').textContent = 'Email ' + (name || 'this customer') + (c.ref ? ' about quote ' + c.ref : ' about their quote'); $('fu-to').textContent = 'To: ' + email;
    $('fu-subject').value = TX.quoteSubject(c.ref); $('fu-body').value = TX.quoteBodyFor({ first: F.quote.first, ref: c.ref });
    $('fu-batch').hidden = true; $('fu-send').disabled = false; $('fu-send').textContent = 'Send email'; $('fu-cancel').textContent = 'Cancel';
    showDialog($('fu-dlg')); $('fu-body').focus();
  }
  async function sendQuote() {
    F.busy = true; $('fu-send').disabled = true; $('fu-send').textContent = 'Sending…'; $('fu-err').textContent = '';
    const q = F.quote;
    try { await call('sendQuoteFollowUp')({ quoteId: q.quoteId, subject: $('fu-subject').value, body: $('fu-body').value }); }
    catch (e) { F.busy = false; $('fu-err').textContent = errText(e); $('fu-send').disabled = false; $('fu-send').textContent = 'Send email'; return; }
    F.busy = false; hideDialog($('fu-dlg')); say('Follow-up email sent to ' + (q.name || 'the customer') + '. The quote comes back on Today in 7 days if there is still no answer.');
  }

  async function send() {
    if (F.busy) return; if (F.quote) return sendQuote();
    F.busy = true; $('fu-send').disabled = true; $('fu-err').textContent = '';
    const subject = $('fu-subject').value, template = $('fu-body').value, rows = F.rows.slice(), fn = call('sendFollowUpEmail');
    let sent = 0, failed = null;
    for (const [i, c] of rows.entries()) {
      $('fu-send').textContent = rows.length > 1 ? `Sending ${i + 1} of ${rows.length}…` : 'Sending…';
      try { await fn({ phone: c.id, subject, body: template.split('{first}').join(firstOf(c)) }); sent++; markSent(c); }
      catch (e) { failed = { c, text: errText(e) }; break; }
    }
    F.busy = false;
    if (failed) {
      $('fu-err').textContent = (rows.length > 1 ? `${sent} sent. Stopped at ${failed.c.name || 'a lead'}: ` : '') + failed.text;
      $('fu-send').disabled = false; $('fu-send').textContent = rows.length > 1 ? `Send the other ${rows.length - sent}` : 'Send email';
      F.rows = rows.slice(sent); if (rows.length > 1 && sent) F.rows = rows.slice(sent);
      if (sent) toast(`${sent} email${sent === 1 ? '' : 's'} sent.`);
      return;
    }
    hideDialog($('fu-dlg')); toast(rows.length > 1 ? `${sent} follow-up emails sent.` : 'Follow-up email sent to ' + (rows[0].name || 'the lead') + '.');
  }

  function init() {
    if (!$('fu-dlg')) return;
    $('fu-send').onclick = send; $('fu-cancel').onclick = () => { if (!F.busy) hideDialog($('fu-dlg')); };
    $('nr-email-all').onclick = openAll;
  }
  init();
  return { canEmail, emailedText, emailOf, render, openOne, openAll, openQuote };
})();
