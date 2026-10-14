'use strict';
// Elite Kitchens Lead OS: consultation requests waiting for a person (Phase 9 R2b, docs/AI.md). When the consultation flow has handed a customer over, this shows
//   * a card at the top of that customer's chat: what days and times they prefer (real dates), their own words, the latest messages, and two buttons,
//   * a "Needs booking" count on the Inbox (a filter above the list, and a badge on the Inbox item on wide screens),
//   * the "Book appointment" button, which opens the EXISTING booking form with this customer selected.
// It books nothing, sends nothing and confirms nothing: you choose the time and press Book in the normal form. The card goes away by itself once the customer has an appointment
// still to come, or when you press "Not needed". Everything shown is drawn as plain text. Loaded after app.js (shares its helpers). If anything here fails, the inbox works as before.
window.CONSULT = (() => {
  const M = window.ConsultModel;
  const C = { booked: null, unsub: null, filter: false, busy: false, error: '', openMsgs: false };
  const today = () => dayKey(new Date());
  const reqOf = (conv) => M.requestOf(conv, C.booked, today());
  const has = (conv) => !!reqOf(conv);
  const count = () => M.countOf(S.convs, C.booked, today());

  // Appointments still to come, for every customer: one small listener (a plain range on `start`, so no extra index). Until it has answered, no card is shown.
  function start() {
    if (C.unsub) return;
    const from = firebase.firestore.Timestamp.fromMillis(Date.now() - 8 * 60 * 60000);       // appointments last at most eight hours
    C.unsub = db.collection('appointments').where('start', '>=', from).orderBy('start').limit(400).onSnapshot((snap) => {
      C.booked = M.bookedPhones(snap.docs.map((d) => d.data()), Date.now()); render(); if (window.renderList) renderList();
    }, () => { if (C.unsub) { C.unsub(); C.unsub = null; } C.booked = null; render(); });
  }
  function stop() { if (C.unsub) { C.unsub(); C.unsub = null; } C.booked = null; C.filter = false; C.error = ''; C.busy = false; render(); }

  function render() {
    const n = count(), bar = $('consult-bar'), btn = $('consult-filter'), badge = $('consult-badge');
    if (!n) C.filter = false;                                                // nothing left to show: back to the normal list
    bar.hidden = !n; $('consult-count').textContent = n; btn.setAttribute('aria-pressed', String(C.filter));
    badge.hidden = !n; badge.textContent = n > 9 ? '9+' : n;
    drawCard();
  }
  function drawCard() {
    const box = $('consult-card'), conv = S.selected ? S.convs.find((c) => c.id === S.selected) : null, r = conv ? reqOf(conv) : null;
    if (!r) { box.hidden = true; box.replaceChildren(); C.error = ''; return; }
    const head = el('div', 'consult-head'); head.append(el('strong', '', 'Consultation request'), el('span', 'consult-state', 'Waiting for you to book'));
    if (r.since) head.append(el('span', 'consult-meta', 'since ' + listTime(r.since)));
    const pref = el('div', 'consult-pref');
    if (r.noPreference) { pref.append(el('div', 'reply-label', 'Preferred days and times'), el('div', 'consult-pref-text', 'None given. They did not say when suits, so please get in touch to arrange a time.')); }
    else { pref.append(el('div', 'reply-label', 'Preferred days and times'), el('div', 'consult-pref-text', r.text)); if (r.customerWords) pref.append(el('div', 'consult-meta', 'Their words: "' + r.customerWords + '"')); }
    const facts = [conv.projectType, conv.location].filter(Boolean).join(' · ');
    const rows = M.excerpt(S.msgs, 4), more = el('details', 'consult-msgs'); more.open = C.openMsgs; more.ontoggle = () => { C.openMsgs = more.open; };
    more.append(el('summary', '', 'Latest messages'));
    if (rows.length) for (const m of rows) more.append(el('div', 'consult-msg' + (m.mine ? ' mine' : ''), (m.mine ? 'You: ' : 'Customer: ') + m.text)); else more.append(el('div', 'consult-meta', 'No messages loaded yet.'));
    const bar = el('div', 'consult-actions'), book = el('button', 'btn btn-primary btn-sm', 'Book appointment'), no = el('button', 'btn btn-ghost btn-sm', 'Not needed');
    book.type = no.type = 'button'; book.disabled = !window.APPT || !APPT.openBook; no.disabled = C.busy;
    book.onclick = () => { if (window.APPT && APPT.openBook) APPT.openBook(r.phone, r.bookOn); };
    no.onclick = () => dismiss(r.phone);
    bar.append(book, no);
    box.replaceChildren(head, ...(facts ? [el('div', 'consult-meta', facts)] : []), pref, more, el('p', 'consult-note', 'Nothing is booked or confirmed yet. You choose the time; the customer hears nothing until you message them.'), ...(C.error ? [el('p', 'reply-err', C.error)] : []), bar);
    box.hidden = false;
  }
  async function dismiss(phone) {
    if (C.busy) return;
    C.busy = true; C.error = ''; drawCard();
    try { await call('aiDismissConsult')({ phone }); } catch (e) { C.error = (e && e.message ? e.message : 'Could not clear this.').replace(/^(functions\/)?[\w-]+:\s*/, '').slice(0, 200); }
    C.busy = false; drawCard();                                              // the card itself goes when the conversation list updates
  }
  $('consult-filter').onclick = () => { C.filter = !C.filter; $('list').scrollTop = 0; if (window.renderList) renderList(); render(); };
  return Object.assign(C, { start, stop, render, has, count });
})();
