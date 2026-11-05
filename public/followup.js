'use strict';
// Follow-up emails to leads who never replied (docs/FOLLOW_UP_EMAIL.md), in the Inbox's "No reply" tab: an Email button on each lead who has an address, and "Email all" for the lot. Nothing is sent without a
// person reading the email first and pressing Send; the server decides again who may be emailed (functions/lib/followUp.js). Loaded after app.js (it uses its S, $, el, call, ms, toast and noReplyRows).
window.FOLLOWUP = (() => {
  const DAY = 86400000, COOLDOWN = 14 * DAY, MAX_BATCH = 30, TX = window.FollowUpText;
  const showDialog = (d) => { if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', ''); };
  const hideDialog = (d) => { if (typeof d.close === 'function') d.close(); else d.removeAttribute('open'); };
  const F = { rows: [], one: null, busy: false };

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
    F.rows = rows; F.one = rows.length === 1 ? rows[0] : null; $('fu-err').textContent = '';
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

  async function send() {
    if (F.busy) return; F.busy = true; $('fu-send').disabled = true; $('fu-err').textContent = '';
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
  return { canEmail, emailedText, emailOf, render, openOne, openAll };
})();
