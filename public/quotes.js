'use strict';
// Elite Kitchens Lead OS: quotes (Phase 6, docs/QUOTES.md). The Quotes screen (list, one quote, Quote Settings), the Quotes
// block in the customer profile, and the accept / decline / reopen dialogs. Reads Firestore directly (staff-only rules); every
// change goes through the quote callables. Prices shown while editing come from the calculator (quote-engine.js); the server
// recalculates them on every save. The form itself is quote-builder.js; the customer document is quote-document.js.
// Loaded after app.js (shares its helpers).
window.QUOTES = (() => {
  const LIMIT = 300;
  const STATUS = { draft: 'Draft', sent: 'Sent', accepted: 'Accepted', declined: 'Declined' };
  const SEND_HINT = 'Send makes the customer PDF, keeps an exact copy with the quote and marks it sent.';
  const Q = {
    active: false, view: 'list', id: null, hash: '#quotes', cameFrom: null, backTo: null,
    list: [], listLoaded: false, hitLimit: false, unsubList: null, filter: 'open', query: '',
    settings: null, counter: null, settingsLoaded: false, unsubSettings: null, unsubCounter: null,
    quote: null, quoteLoaded: false, versions: new Map(), versionsLoaded: false, unsubQuote: null, unsubVersions: null,
    contact: null, unsubContact: null,
    builder: null, builderKey: null, answers: null, dirty: false, editSeq: 0, saving: false, sheet: null, errors: [], problems: [],
    notesDirty: false, built: null, busy: false,
    customer: null, custList: [], custLoaded: false, unsubCust: null,
    dlg: null,
    deliveries: [], unsubDeliveries: null, mailInfo: null,        // Phase 6.1: how this quote was sent, channel by channel (quotes/{id}/deliveries)
  };
  const QUOTE_ID = /^q_[0-9a-f]{24}$/;
  const newRequestId = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12));
  const showDialog = (d) => { if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', ''); };
  const closeDialog = (d) => { if (typeof d.close === 'function') { if (d.open) d.close(); } else d.removeAttribute('open'); };
  const convOf = (phone) => S.convs.find((c) => c.id === phone) || null;

  // ---------- money, dates, status ----------
  const euros = (n) => (n == null ? '—' : CRM.money(n));
  const euros2 = (n) => '€' + Number(n).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const today = () => dayKey(new Date());                                             // YYYY-MM-DD in Europe/Dublin
  function fmtDate(k, withYear = true) {
    if (!k) return '';
    const [y, m, d] = k.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
  }
  const tsDate = (t) => (t && t.toDate ? fmtDate(dayKey(t.toDate())) : '');
  const tsShort = (t) => (t && t.toDate ? fmtDate(dayKey(t.toDate()), false) : '');
  const tsTime = (t) => (t && t.toDate ? tsShort(t) + ' ' + hhmm(t.toDate()) : '');
  const isExpired = (q) => q.status === 'sent' && !!q.validUntil && today() > q.validUntil;   // a label only: nothing is stored
  const statusKey = (q) => (isExpired(q) ? 'expired' : q.status);
  const statusText = (q) => (isExpired(q) ? 'Expired' : STATUS[q.status] || q.status);
  function chip(q) {
    const c = el('span', 'qchip', statusText(q)); c.dataset.qstatus = statusKey(q);
    return c;
  }
  const shownSummary = (q) => (q.sent && q.sent.summary) || q.summary || { options: [], dearest: null };
  function priceOf(q) {                                                    // the accepted option, else the dearest option
    if (q.status === 'accepted' && q.acceptedOption) return { amount: q.acceptedOption.incVat, note: q.acceptedOption.name };
    const d = shownSummary(q).dearest;
    return d ? { amount: d.incVat, note: shownSummary(q).options.length > 1 ? 'up to' : d.name } : { amount: null, note: '' };
  }
  function lineOf(q) {
    if (q.status === 'draft') return 'Draft, not sent · updated ' + tsShort(q.updatedAt);
    if (q.status === 'accepted') return `Accepted ${tsShort(q.acceptedAt)}: ${q.acceptedOption ? q.acceptedOption.name : ''}`;
    if (q.status === 'declined') return 'Declined ' + tsShort(q.declinedAt) + (q.declineReason ? ': ' + q.declineReason : '');
    const extra = q.draftVersion ? ` · draft v${q.draftVersion} not sent` : '';
    const via = sentVia(q) ? ' via ' + sentVia(q) : '';
    return (isExpired(q) ? `Expired: valid until ${fmtDate(q.validUntil, false)} (sent ${tsShort(q.sentAt)}${via})` : `Sent ${tsShort(q.sentAt)}${via} · valid until ${fmtDate(q.validUntil, false)}`) + extra;
  }
  // How the customer's current version was sent, when a channel confirmed it (quotes marked sent by hand say nothing).
  function sentVia(q) {
    const h = [...(q.history || [])].reverse().find((x) => x.action === 'sent');
    return h && h.via && h.via !== 'manual' ? QuoteSend.CHANNEL_NAME[h.via] || h.via : '';
  }
  const stageName = (s) => INBOX_STATUSES[s] || 'New lead';

  // ---------- data ----------
  function listenCommon() {
    if ($('app').hidden) return;
    if (!Q.unsubSettings) Q.unsubSettings = db.collection('quoteSettings').doc('current').onSnapshot((d) => {
      Q.settings = d.exists ? d.data() : null; Q.settingsLoaded = true; QuoteSettings.update(Q.settings, Q.counter); render();
    }, () => { Q.unsubSettings = null; });
    if (!Q.unsubCounter) Q.unsubCounter = db.collection('counters').doc('quoteNumber').onSnapshot((d) => {
      Q.counter = d.exists ? d.data() : null; QuoteSettings.update(Q.settings, Q.counter);
    }, () => { Q.unsubCounter = null; });
  }
  function stopCommon() {
    if (Q.unsubSettings) { Q.unsubSettings(); Q.unsubSettings = null; }
    if (Q.unsubCounter) { Q.unsubCounter(); Q.unsubCounter = null; }
    Q.settings = null; Q.counter = null; Q.settingsLoaded = false;
  }
  function startList() {
    if (Q.unsubList || $('app').hidden) return;
    Q.unsubList = db.collection('quotes').orderBy('updatedAt', 'desc').limit(LIMIT).onSnapshot((snap) => {
      Q.list = snap.docs.map((d) => ({ id: d.id, ...d.data() })); Q.listLoaded = true; Q.hitLimit = snap.size >= LIMIT;
      if (Q.view === 'list') renderList();
    }, (e) => { stopList(); note('Cannot load quotes: ' + errText(e), 'err'); });
  }
  function stopList() { if (Q.unsubList) { Q.unsubList(); Q.unsubList = null; } Q.list = []; Q.listLoaded = false; }
  function openQuote(id) {
    if (Q.unsubQuote && Q.id === id) return;
    closeQuote();
    Q.id = id;
    Q.tick = setInterval(tickDeliveries, 15000);                       // what depends on the clock is redrawn (audit 11)
    Q.unsubQuote = db.collection('quotes').doc(id).onSnapshot((d) => {
      if (Q.id !== id) return;
      Q.quote = d.exists ? { id, ...d.data() } : null; Q.quoteLoaded = true;
      if (Q.quote) watchQuoteContact(Q.quote.phone);
      renderQuote(); if (Q.deliveriesChanged) Q.deliveriesChanged();
    }, (e) => { if (Q.id === id) { Q.quoteLoaded = true; note('Cannot load the quote: ' + errText(e), 'err'); } });
    Q.unsubVersions = db.collection('quotes').doc(id).collection('versions').onSnapshot((snap) => {
      if (Q.id !== id) return;
      Q.versions = new Map(snap.docs.map((d) => [d.data().n, d.data()])); Q.versionsLoaded = true;
      renderQuote();
    }, () => {});
    Q.unsubDeliveries = db.collection('quotes').doc(id).collection('deliveries').onSnapshot((snap) => {
      if (Q.id !== id) return;
      Q.deliveries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderQuote(); if (Q.deliveriesChanged) Q.deliveriesChanged();
    }, () => {});
  }
  // A delivery that has been "sending" for over 3 minutes is "not confirmed", and one left waiting can be sent now: both are decided by the CLOCK, not by
  // a change in the data, so nothing would redraw them (audit finding 11). Every 15 seconds the parts that show deliveries are drawn again.
  function tickDeliveries() {
    if (!Q.active || Q.view !== 'quote' || !Q.quote || !Q.quoteLoaded) return;
    if (Q.quote.preparedSend) renderMain();
    if (Q.deliveries.some((x) => x.state === 'sending' || x.state === 'queued')) renderVersions();
    const d = sendDlg(); if (d && d.view === 'results') renderResults();
  }
  function closeQuote() {
    if (Q.tick) { clearInterval(Q.tick); Q.tick = null; }
    if (Q.unsubQuote) { Q.unsubQuote(); Q.unsubQuote = null; }
    if (Q.unsubVersions) { Q.unsubVersions(); Q.unsubVersions = null; }
    if (Q.unsubDeliveries) { Q.unsubDeliveries(); Q.unsubDeliveries = null; }
    Q.deliveries = [];
    watchQuoteContact(null);
    if (Q.builder) { Q.builder.destroy(); Q.builder = null; }
    Object.assign(Q, { formRev: null, notesBase: null, quote: null, quoteLoaded: false, versions: new Map(), versionsLoaded: false, builderKey: null, answers: null, dirty: false, sheet: null, errors: [], problems: [], notesDirty: false, built: null });
  }
  function watchQuoteContact(phone) {
    if (Q.contactPhone === phone) return;
    if (Q.unsubContact) { Q.unsubContact(); Q.unsubContact = null; }
    Q.contactPhone = phone || null; Q.contact = null;
    if (!phone) return;
    Q.unsubContact = db.collection('contacts').doc(phone).onSnapshot((d) => { if (Q.contactPhone === phone) { Q.contact = d.exists ? d.data() : {}; if (Q.view === 'quote') renderSide(); } }, () => {});
  }

  // ---------- show / hide (called by routeFromHash in app.js) ----------
  const handles = (hash) => /^#quotes(\/|$)/.test(hash || '');
  function parse(hash) {
    const rest = String(hash || '').replace(/^#quotes\/?/, '');
    if (rest === 'settings') return { view: 'settings', id: null };
    if (QUOTE_ID.test(rest)) return { view: 'quote', id: rest };
    return { view: 'list', id: null };
  }
  function setNav(on) {
    const n = $('nav-quotes');
    n.classList.toggle('active', on);
    if (on) {
      n.setAttribute('aria-current', 'page');
      for (const id of ['nav-inbox', 'nav-pipeline', 'nav-appointments']) { $(id).classList.remove('active'); $(id).removeAttribute('aria-current'); }
    } else {
      n.removeAttribute('aria-current');
      $('nav-inbox').classList.add('active'); $('nav-inbox').setAttribute('aria-current', 'page');
    }
  }
  function show(hash) {
    const r = parse(hash);
    if (r.view !== 'quote') closeQuote();
    if (r.view !== 'settings' && Q.view === 'settings') QuoteSettings.stop();
    Q.active = true; Q.view = r.view; Q.hash = '#quotes' + (r.view === 'settings' ? '/settings' : r.id ? '/' + r.id : '');
    setNav(true); listenCommon();
    if (r.view === 'list') startList(); else stopList();
    if (r.view === 'quote') { if (!Q.cameFrom) Q.cameFrom = '#quotes'; openQuote(r.id); } else Q.cameFrom = null;
    setView();
    render();
    $('q-scroll').scrollTop = 0;
  }
  function hide() {
    Q.active = false; closeQuote(); stopList(); stopCommon(); QuoteSettings.stop(); setNav(false);
    Q.cameFrom = null; note('');
    for (const id of ['qa-dlg', 'qd-dlg', 'qr-dlg', 'qc-dlg', 'nq-dlg', 'qsend-dlg', 'qdoc-dlg']) closeDialog($(id));
  }
  function stop() {                      // sign-out: forget everything
    hide(); Q.backTo = null; Q.view = 'list'; Q.filter = 'open'; Q.query = ''; $('q-search').value = '';
    watchCustomer(null);
  }
  // Leaving a quote (or Quote Settings) with unsaved changes asks first. Returns false to stay (the address bar is put back).
  function mayLeave(nextHash) {
    if (!Q.active) return true;
    const staying = handles(nextHash) && parse(nextHash).view === Q.view && (Q.view !== 'quote' || parse(nextHash).id === Q.id);
    if (staying) return true;
    let okay = true;
    if (Q.view === 'quote' && (Q.dirty || Q.notesDirty)) {
      okay = window.confirm('You have unsaved changes to this quote. Leave without saving?');
      if (okay) { Q.dirty = false; Q.notesDirty = false; }
    } else if (Q.view === 'settings') okay = QuoteSettings.mayLeave();
    if (!okay) history.replaceState(null, '', Q.hash);
    return okay;
  }
  const isDirty = () => Q.active && ((Q.view === 'quote' && (Q.dirty || Q.notesDirty)) || (Q.view === 'settings' && QuoteSettings.isDirty()));
  window.addEventListener('beforeunload', (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- the screen ----------
  function note(text, kind) {
    const t = $('q-toast'); t.textContent = text || ''; t.hidden = !text; t.classList.toggle('err', kind === 'err');
    clearTimeout(note.h); if (text) note.h = setTimeout(() => { t.hidden = true; }, 9000);
  }
  function render() {
    if (!Q.active) return;
    $('q-list-view').hidden = Q.view !== 'list';
    $('q-quote-view').hidden = Q.view !== 'quote';
    $('q-settings-view').hidden = Q.view !== 'settings';
    $('q-head-actions').hidden = Q.view !== 'list';
    $('q-back').classList.toggle('only-mobile', Q.view === 'list');      // on the list, Back (to the Inbox) is only needed on a phone
    $('q-back').setAttribute('aria-label', Q.view === 'list' ? 'Back to inbox' : Q.view === 'settings' ? 'Back to quotes' : 'Back');
    const setup = $('q-setup');
    setup.hidden = !(Q.settingsLoaded && !Q.settings && Q.view !== 'settings');
    if (!setup.hidden) {
      const a = el('a', 'linkbtn', 'Set up Quote Settings'); a.href = '#quotes/settings';
      setup.replaceChildren(el('span', null, 'Quote Settings are not set up yet: enter your prices and business details before making quotes. '), a);
    }
    if (Q.view === 'list') { $('q-title').textContent = 'Quotes'; $('q-subtitle').textContent = ''; document.title = 'Quotes · Elite Kitchens'; renderList(); }
    else if (Q.view === 'settings') { $('q-title').textContent = 'Quote Settings'; $('q-subtitle').textContent = 'Prices for new quotes, VAT, validity and business details'; document.title = 'Quote Settings · Elite Kitchens'; QuoteSettings.show($('q-settings-view')); QuoteSettings.update(Q.settings, Q.counter); }
    else renderQuote();
  }

  // ---------- list ----------
  const FILTERS = { open: (q) => q.status === 'draft' || q.status === 'sent', draft: (q) => q.status === 'draft', sent: (q) => q.status === 'sent' && !isExpired(q),
    expired: (q) => isExpired(q), accepted: (q) => q.status === 'accepted', declined: (q) => q.status === 'declined', all: () => true };
  function matches(q, s) {
    if (!s) return true;
    if (String(q.customerName || '').toLowerCase().includes(s) || String(q.ref || '').toLowerCase().includes(s)) return true;
    const d = digits(s);
    return !!d && (q.phone.includes(d) || (d.startsWith('0') && q.phone.includes(d.slice(1))) || String(q.number || '').padStart(4, '0').includes(d));
  }
  function renderList() {
    const host = $('q-list'), s = Q.query.trim().toLowerCase();
    for (const b of $('q-filter').querySelectorAll('button[data-filter]')) {
      const k = b.dataset.filter, nShown = Q.list.filter(FILTERS[k]).length;
      b.setAttribute('aria-pressed', String(k === Q.filter));
      let c = b.querySelector('.stage-n'); if (!c) { c = el('span', 'stage-n'); b.append(c); }
      c.textContent = Q.listLoaded && k !== 'all' ? String(nShown) : '';
    }
    if (!Q.listLoaded) { host.replaceChildren(el('p', 'appts-empty', 'Loading quotes…')); $('q-list-note').hidden = true; return; }
    const shown = Q.list.filter(FILTERS[Q.filter]).filter((q) => matches(q, s));
    if (!shown.length) {
      host.replaceChildren(el('p', 'appts-empty', s ? 'No quotes match your search.' : Q.list.length ? 'No quotes here.' : 'No quotes yet. Create one from a customer\'s profile, or with New quote.'));
    } else host.replaceChildren(...shown.map(rowNode));
    $('q-list-note').hidden = !Q.hitLimit; $('q-list-note').textContent = 'Showing the ' + LIMIT + ' most recently changed quotes.';
  }
  function rowNode(q) {
    const row = el('div', 'qrow'); row.setAttribute('role', 'listitem'); row.tabIndex = 0; row.dataset.id = q.id; row.dataset.phone = q.phone;
    const ref = el('div', 'qrow-ref', q.ref || ''); ref.append(el('span', null, 'v' + (q.sentVersion || q.currentVersion || 1)));
    const main = el('div', 'qrow-main');
    const top = el('div', 'qrow-top'); top.append(el('span', 'qrow-name', q.customerName || formatPhone(q.phone)), chip(q));
    main.append(top, el('div', 'qrow-sub', lineOf(q)));
    const p = priceOf(q), price = el('div', 'qrow-price', euros(p.amount)); if (p.note) price.append(el('span', null, p.note));
    row.append(ref, main, price);
    row.setAttribute('aria-label', `${q.ref}, ${q.customerName || formatPhone(q.phone)}, ${statusText(q)}, ${euros(p.amount)}. Open quote`);
    const open = () => { Q.cameFrom = '#quotes'; location.hash = '#quotes/' + q.id; };
    row.onclick = open; row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
    return row;
  }

  // ---------- one quote ----------
  const draftV = () => (Q.quote && Q.quote.draftVersion ? Q.versions.get(Q.quote.draftVersion) : null);
  const sentV = () => (Q.quote && Q.quote.sentVersion ? Q.versions.get(Q.quote.sentVersion) : null);
  function skeleton() {
    const v = $('q-quote-view');
    const wrap = el('div', 'qv');
    const main = el('div', 'qv-main'); main.append(el('div', 'qv-banner'), el('div', 'qv-body'));
    const side = el('aside', 'qv-side'); side.setAttribute('aria-label', 'Quote status and actions');
    for (const k of ['totals', 'actions', 'customer', 'versions', 'notes', 'activity']) { const s = el('section', 'qv-sec qv-' + k); side.append(s); }
    wrap.append(main, side);
    v.replaceChildren(wrap);
    Q.built = Q.id;
  }
  const part = (k) => $('q-quote-view').querySelector('.qv-' + k);
  function renderQuote() {
    if (!Q.active || Q.view !== 'quote') return;
    const q = Q.quote;
    if (!Q.quoteLoaded) { $('q-title').textContent = 'Quote'; $('q-quote-view').replaceChildren(el('p', 'appts-empty', 'Loading the quote…')); Q.built = null; return; }
    if (!q) {
      $('q-title').textContent = 'Quote'; $('q-subtitle').textContent = '';
      const a = el('a', 'linkbtn', 'Back to all quotes'); a.href = '#quotes';
      const p = el('p', 'appts-empty', 'This quote no longer exists. '); p.append(a);
      $('q-quote-view').replaceChildren(p); Q.built = null; return;
    }
    $('q-title').textContent = q.ref + ' · v' + (q.draftVersion || q.sentVersion || q.currentVersion);
    $('q-subtitle').textContent = (q.customerName || formatPhone(q.phone)) + ' · ' + statusText(q) + (q.draftVersion && q.sentVersion ? ' · draft v' + q.draftVersion + ' not sent' : '');
    document.title = q.ref + ' · Quotes · Elite Kitchens';
    if (Q.built !== Q.id) skeleton();
    renderMain(); renderSide();
  }
  function renderMain() {
    const q = Q.quote, banner = $('q-quote-view').querySelector('.qv-banner'), body = $('q-quote-view').querySelector('.qv-body');
    const msgs = [];
    const dv = draftV(), sv = sentV();
    if (staleEdit()) msgs.push('conflict');
    if (q.draftVersion) {
      msgs.push(q.sentVersion ? `Draft v${q.draftVersion}: these changes are not sent. The customer has v${q.sentVersion}, sent ${tsDate(q.sentAt)}.` : 'Draft: not sent yet.');
      if (dv && Q.settings && (JSON.stringify(dv.priceList) !== JSON.stringify(Q.settings.priceList) || dv.vatRate !== Q.settings.vatRate)) msgs.push('prices');
    } else if (q.status === 'sent') {
      msgs.push(isExpired(q) ? `Expired: it was valid until ${fmtDate(q.validUntil)}. Nothing has changed: you can still mark it accepted, revise it or send it again.` : `Sent ${tsDate(q.sentAt)} · valid until ${fmtDate(q.validUntil)}.`);
    } else if (q.status === 'accepted') msgs.push(`Accepted ${tsDate(q.acceptedAt)}: ${q.acceptedOption.name}, ${euros(q.acceptedOption.incVat)} (v${q.acceptedOption.version}).`);
    else if (q.status === 'declined') msgs.push(`Declined ${tsDate(q.declinedAt)}` + (q.declineReason ? `: ${q.declineReason}.` : '.') + ' It can be reopened or revised if the customer comes back.');
    banner.replaceChildren(...msgs.map((m) => {
      if (m === 'conflict') {
        const p = el('p', 'qv-msg warn'); p.id = 'qv-conflict'; p.setAttribute('role', 'alert');
        p.append('Someone else changed this quote while you were editing, so your changes are not saved. ');
        const r = el('button', 'linkbtn', 'Load their version (my changes are lost)'); r.type = 'button'; r.id = 'qv-conflict-reload'; r.onclick = reloadTheirs;
        const k = el('button', 'linkbtn', 'Keep my changes and replace theirs'); k.type = 'button'; k.id = 'qv-conflict-keep'; k.onclick = keepMine;
        p.append(r, ' · ', k); return p;
      }
      if (m !== 'prices') { const p = el('p', 'qv-msg', m); if (isExpired(q) && !q.draftVersion) p.classList.add('warn'); return p; }
      const p = el('p', 'qv-msg', 'Prices in Quote Settings have changed since this draft was priced. ');
      const b = el('button', 'linkbtn', 'Use today\'s prices'); b.type = 'button'; b.id = 'qv-use-current'; b.onclick = () => saveDraft(true);
      p.append(b); return p;
    }));
    if (q.preparedSend) banner.append(sendStatePanel(q));
    if (q.draftVersion) {
      if (!dv) { body.replaceChildren(el('p', 'appts-empty', 'Loading…')); return; }
      if (!Q.dirty) Q.formRev = q.rev;                    // nothing typed: the form IS the saved draft, so it is based on this revision (audit 2)
      const key = q.draftVersion + '|' + JSON.stringify(dv.priceList);
      if (Q.builderKey !== key && !Q.dirty) {
        if (!QuoteBuilder.supports(dv.engine)) { body.replaceChildren(el('p', 'appts-empty', 'This quote was made with a calculator this screen cannot edit.')); return; }
        const host = el('div', 'qv-builder'); body.replaceChildren(host);
        Q.answers = dv.answers;
        Q.builder = QuoteBuilder.mount(host, { answers: dv.answers, priceList: dv.priceList, catalogue: catalogueFor(dv), onChange: (a) => { Q.answers = a; Q.dirty = true; Q.editSeq++; recalc(); renderActions(); } });
        Q.builderKey = key;
      } else if (!Q.dirty && Q.builder && JSON.stringify(Q.answers) !== JSON.stringify(dv.answers)) {
        Q.answers = dv.answers; Q.builder.set(dv.answers);            // saved (here or elsewhere) and nothing typed since
      }
      if (Q.builder) Q.builder.setCatalogue(catalogueFor(dv));        // Quote Settings changed: the buttons follow at once
      recalc();
      return;
    }
    if (Q.builder) { Q.builder.destroy(); Q.builder = null; Q.builderKey = null; Q.answers = null; Q.dirty = false; }
    body.replaceChildren(sv ? sentView(q, sv) : el('p', 'appts-empty', 'Loading…'));
  }
  // Audit finding 2. The form on screen is based on the revision it was loaded from (Q.formRev), NOT on the newest one the live listener has seen:
  // when someone else saves while this person has unsaved inputs, the screen says so and the save is disabled until they decide, instead of quietly
  // adopting the newer revision and saving the old inputs on top of the other person's work. A save by this person moves the base to its own revision.
  // (Not while this person's own save is in flight: its live update can arrive before the save's reply, and is not someone else's change.)
  const staleEdit = () => !!(!Q.saving && Q.dirty && Q.quote && Q.quote.draftVersion && Q.formRev != null && Q.quote.rev !== Q.formRev);
  function reloadTheirs() { Q.dirty = false; Q.builderKey = null; renderQuote(); }          // the form is rebuilt from what is saved
  function keepMine() { Q.formRev = Q.quote.rev; renderMain(); renderActions(); }          // an explicit decision: the next save replaces theirs
  // The extras offered as quick-select buttons: Quote Settings as they are now (they only fill in a row, which keeps its own
  // price), or the draft's own list until the settings have loaded.
  function catalogueFor(dv) {
    const live = Q.settings && Q.settings.priceList && Q.settings.priceList.extras;
    return Array.isArray(live) ? live : ((dv.priceList && dv.priceList.extras) || []);
  }
  // What the customer was sent: the option cards and the wording, from the frozen version.
  function sentView(q, v) {
    const box = el('div', 'qv-sent');
    box.append(el('h2', 'qv-h', `What the customer was sent (v${v.n})`));
    const cards = el('div', 'qv-cards');
    for (const o of v.sheet.options) {
      const c = el('div', 'qv-opt'); c.dataset.key = o.key;
      if (q.acceptedOption && q.acceptedOption.key === o.key) { c.classList.add('chosen'); c.append(el('span', 'qv-chosen', 'Chosen')); }
      c.append(el('div', 'qv-opt-name', o.name));
      const ul = el('ul', 'qv-lines'); o.lines.forEach((l) => ul.append(el('li', null, l))); c.append(ul);
      c.append(el('div', 'qv-opt-price', euros(o.incVat)), el('div', 'qv-opt-vat', `including VAT at ${v.vatRate}%` + (v.sheet.document.showExVat ? ` · ${euros(o.exVatWhole)} excluding VAT` : '')));
      cards.append(c);
    }
    box.append(cards);
    const d = v.sheet.document, lists = el('div', 'qv-lists');
    const list = (title, items, cls) => { const s = el('div', 'qv-list ' + (cls || '')); s.append(el('h3', null, title)); const ul = el('ul'); items.forEach((t) => ul.append(el('li', null, t))); s.append(ul); return s; };
    if (d.items.length) lists.append(list(QuoteDocument.wording(d.project).items, d.items));
    lists.append(list('Work included', d.workIncluded), list('Not included', d.notIncluded, 'not'));
    box.append(lists);
    const facts = el('dl', 'qb-figures qv-facts'); d.facts.forEach((f) => facts.append(el('dt', null, f.label), el('dd', null, f.value + (f.note ? ' (' + f.note + ')' : ''))));
    box.append(facts);
    if (v.customer) box.append(el('p', 'qb-note', `On the quote: ${[v.customer.name, v.customer.address, v.customer.email, formatPhone(v.customer.phone)].filter(Boolean).join(' · ')} · issued ${fmtDate(v.issueDate)}, valid until ${fmtDate(v.validUntil)}.`));
    if (QuoteBuilder.supports(v.engine)) {
      const det = el('details', 'qv-figs'); det.append(el('summary', null, 'Figures (internal, for the invoice in the old app)'), QuoteBuilder.figures(v.answers, v.priceList));
      box.append(det);
    }
    return box;
  }
  function recalc() {
    const dv = draftV(); if (!dv || !Q.builder) return;
    let eng;
    try { eng = QuoteEngine.get(dv.engine); } catch (e) { return; }
    const r = eng.validate(Q.answers);
    Q.errors = r.errors;
    Q.sheet = r.ok ? eng.calculate(r.answers, dv.priceList, { vatRate: dv.vatRate }) : null;
    Q.problems = r.ok ? eng.sendProblems(r.answers) : [];
    Q.builder.showErrors(r.errors);
    renderTotals();
  }
  // A send is in progress (prepared, but no channel has confirmed yet): the quote is NOT marked sent. Each channel's state on its
  // own, and what to do next: retry a failed one, settle one we could not confirm, send it yourself, or cancel.
  function sendStatePanel(q) {
    const box = el('div', 'qv-sendstate'); box.id = 'qv-sendstate';
    const list = Q.deliveries.filter((x) => x.requestId === q.preparedSend.requestId), now = Date.now(), sum = QuoteSend.summarize(list, now);
    box.append(el('h3', null, `A send is in progress: v${q.preparedSend.version} is not marked sent`), el('p', 'qv-msg', list.length ? sum.text : 'Checking the send…'));
    if (list.length) box.append(deliveryRows(list, q));
    const row = el('div', 'qv-buttons');
    row.append(button('Download PDF', 'btn-ghost', (ev) => openPdf(q.preparedSend.version, ev.currentTarget), 'qv-prep-pdf'),
      button('I sent it myself: mark as sent', 'btn-ghost', markPreparedSent, 'qv-prep-manual'));
    if (list.length && !sum.sent && !list.some((x) => ['sending', 'unknown'].includes(QuoteSend.effective(x, now)))) row.append(button('Cancel this send', 'btn-ghost', cancelPreparedSend, 'qv-prep-cancel'));
    box.append(row);
    return box;
  }
  function renderSide() {
    if (!Q.quote || Q.built !== Q.id) return;
    renderTotals(); renderActions(); renderCustomerPart(); renderVersions(); renderNotes(); renderActivity();
  }
  function renderTotals() {
    const host = part('totals'); if (!host) return;
    const q = Q.quote, editing = !!q.draftVersion;
    const sheet = editing ? Q.sheet : (sentV() || {}).sheet;
    const nodes = [el('h3', null, editing ? 'Totals' : 'Prices')];
    if (editing && !sheet) {
      nodes.push(el('p', 'qb-note', 'Fix the highlighted fields to see the totals.'));
      const ul = el('ul', 'qv-problems'); Q.errors.slice(0, 6).forEach((e) => ul.append(el('li', null, e.message))); nodes.push(ul);
    } else if (sheet) {
      if (!sheet.options.length) nodes.push(el('p', 'qb-note', 'No option is offered yet.'));
      for (const o of sheet.options) {
        const r = el('div', 'qv-total'); r.dataset.key = o.key;
        const name = el('span', 'qv-total-name', o.name);
        if (sheet.options.length > 1 && sheet.dearest === o.key) name.append(el('span', 'qv-tag', 'highest'));
        const amt = el('span', 'qv-total-amt', euros(o.incVat));
        r.append(name, amt, el('span', 'qv-total-ex', euros2(o.exVat) + ' excl. VAT'));
        nodes.push(r);
      }
      nodes.push(el('p', 'qb-note', `Including VAT at ${sheet.vatRate}%, rounded to the euro as on the quote.`));
      if (sheet.options.length) nodes.push(costBreakdown(sheet));
      if (editing && Q.problems.length) { const p = el('p', 'qv-warn-line', 'Before sending: ' + Q.problems.join(' ')); nodes.push(p); }
    } else nodes.push(el('p', 'qb-note', 'Loading…'));
    host.replaceChildren(...nodes);
  }
  // What each option is made of, before VAT (staff only, never on the quote), as the original app's "Internal Summary": every
  // figure comes from the calculator's price sheet. Rows that are €0 for every option are left out. It stays open or closed
  // as staff left it while they type.
  function costBreakdown(sheet) {
    const opts = sheet.options, sh = sheet.shared || {};
    const rows = [['Doors', (o) => o.breakdown.cabinets], ['Top boxes', (o) => o.breakdown.topBoxCabinets], ['Drawer boxes', (o) => o.breakdown.drawerBoxes],
      ['Premium Plus extras', (o) => o.breakdown.ownExtras], ['Extras', () => sh.extras], ['Worktop', () => sh.worktop], ['Glazed doors', () => sh.glazing]]
      .filter(([label, f]) => label === 'Doors' || opts.some((o) => f(o) > 0));
    const line = (cls, label, cells) => { const tr = el('tr', cls); tr.append(el('th', null, label), ...cells); return tr; };
    const head = el('thead'); head.append(line(null, '', opts.map((o) => el('th', null, o.name))));
    const body = el('tbody');
    for (const [label, f] of rows) body.append(line(null, label, opts.map((o) => el('td', null, euros2(f(o) || 0)))));
    body.append(line('qv-cost-total', 'Total excl. VAT', opts.map((o) => el('td', null, euros2(o.exVat)))));
    const t = el('table', 'qv-cost-t'); t.append(head, body);
    const d = el('details', 'qv-cost'); d.open = !!Q.costOpen;
    d.addEventListener('toggle', () => { Q.costOpen = d.open; });
    d.append(el('summary', null, 'Cost breakdown (excl. VAT, staff only)'), t);
    return d;
  }
  function button(label, cls, onClick, id) { const b = el('button', 'btn btn-sm ' + cls, label); b.type = 'button'; if (id) b.id = id; b.onclick = onClick; return b; }
  // The buttons are built once per state of the quote; while typing only Save's state changes. (Rebuilding them on every
  // keystroke could swallow a click on Save made straight after typing: the field's change event redrew the button mid-click.)
  function renderActions() {
    const host = part('actions'); if (!host || !Q.quote) return;
    const q = Q.quote, key = [q.status, q.draftVersion, q.sentVersion, q.preparedSend ? 'sending' : ''].join('|');
    if (host.dataset.key !== key) { buildActions(host, q); host.dataset.key = key; }
    const save = $('qv-save');
    if (save) { save.disabled = Q.saving || !Q.dirty || staleEdit(); save.textContent = Q.saving ? 'Saving…' : 'Save draft'; }
    const send = $('qv-send');
    if (send) {
      const why = Q.errors.length ? 'Fix the highlighted fields first.' : Q.problems.length ? Q.problems[0] : '';
      send.disabled = Q.saving || !!why; send.title = why;
    }
    const hint = host.querySelector('.qv-hint');
    if (hint && q.draftVersion) hint.textContent = Q.dirty ? 'Unsaved changes: Send saves them first.' : SEND_HINT;
  }
  function buildActions(host, q) {
    const nodes = [el('h3', null, 'Actions')], row = el('div', 'qv-buttons');
    if (q.preparedSend) {                                   // locked while a send is prepared: the box at the top has the choices
      host.replaceChildren(...nodes, el('p', 'qb-note', 'A send is in progress, so this draft cannot be edited, discarded or deleted until it is finished or cancelled. Choose what to do in the box at the top of the quote.'));
      return;
    }
    if (q.draftVersion) {
      row.append(button('Save draft', 'btn-primary', () => saveDraft(false), 'qv-save'), button('Send…', 'btn-ghost', () => openSend('send'), 'qv-send'),
        button('Preview', 'btn-ghost', openPreview, 'qv-preview'));
      if (q.sentVersion) row.append(button('Discard draft…', 'btn-ghost', confirmDiscard, 'qv-discard'));
      else row.append(button('Delete quote…', 'btn-ghost qv-danger', confirmDelete, 'qv-delete'));
      nodes.push(row, el('p', 'qb-note qv-hint', SEND_HINT));
    } else if (q.status === 'sent') {
      row.append(button('Mark accepted…', 'btn-primary', openAccept, 'qv-accept'), button('Mark declined…', 'btn-ghost', openDecline, 'qv-decline'),
        button('Revise', 'btn-ghost', revise, 'qv-revise'), button('Send again…', 'btn-ghost', () => openSend('renew'), 'qv-renew'),
        button('Send this version…', 'btn-ghost', () => openSend('resend'), 'qv-resend'));
      nodes.push(row, el('p', 'qb-note', 'Revise starts a new version with the same prices to change. Send again sends the same quote with a new date and validity. Send this version sends the PDF the customer already has, by WhatsApp or email.'));
    } else if (q.status === 'accepted') {
      row.append(button('Reopen…', 'btn-ghost', openReopen, 'qv-reopen'));
      nodes.push(row);
    } else if (q.status === 'declined') {
      row.append(button('Reopen…', 'btn-ghost', openReopen, 'qv-reopen'), button('Revise', 'btn-ghost', revise, 'qv-revise'));
      nodes.push(row);
    }
    host.replaceChildren(...nodes);
  }
  function renderCustomerPart() {
    const host = part('customer'); if (!host) return;
    const q = Q.quote, c = convOf(q.phone), ct = Q.contact || {};
    const nodes = [el('h3', null, 'Customer')];
    const name = el('button', 'linkbtn qv-cust', ct.name || q.customerName || formatPhone(q.phone)); name.type = 'button'; name.id = 'qv-open-customer';
    name.onclick = () => { Q.backTo = Q.hash; S.statusFilter = c ? inboxStatus(c) : S.statusFilter; location.hash = '#c/' + q.phone; };
    nodes.push(name);
    if (c) { const st = el('span', 'arow-stage', stageName(inboxStatus(c))); st.dataset.status = inboxStatus(c); nodes.push(st); }
    const lines = [formatPhone(q.phone), ct.email, ct.address].filter(Boolean);
    nodes.push(el('p', 'qv-cust-sub', lines.join(' · ')));
    if (!ct.address && q.draftVersion) nodes.push(el('p', 'qb-note', 'No address yet: add it in the customer\'s Details to have it printed on the quote.'));
    if (typeof ct.quoteValue === 'number') nodes.push(el('p', 'qv-cust-sub', 'Pipeline value ' + euros(ct.quoteValue)));
    host.replaceChildren(...nodes);
  }
  function renderVersions() {
    const host = part('versions'); if (!host) return;
    const sent = [...Q.versions.values()].filter((v) => v.state === 'sent').sort((a, b) => b.n - a.n);
    if (!sent.length) { host.replaceChildren(); host.hidden = true; return; }
    host.hidden = false;
    const nodes = [el('h3', null, 'Sent versions')];
    for (const v of sent) {
      const r = el('div', 'qv-ver');
      const d = v.sheet.options.reduce((m, o) => (!m || o.incVat > m.incVat ? o : m), null);
      r.append(el('span', null, `v${v.n} · ${fmtDate(v.issueDate)} · ${euros(d && d.incVat)}`));
      if (v.pdf) {
        const links = el('span', 'qv-ver-links');
        const b = el('button', 'linkbtn', 'PDF'); b.type = 'button'; b.onclick = () => openPdf(v.n, b);
        const s = el('button', 'linkbtn', 'Send…'); s.type = 'button'; s.dataset.version = String(v.n); s.title = `Send v${v.n} to the customer again, by WhatsApp or email`; s.onclick = () => openSend('resend', v.n);   // audit 14
        links.append(s, b); r.append(links);
      }
      nodes.push(r);
      // How this version reached the customer, channel by channel (a failed attempt is hidden once the same channel has since delivered).
      const all = Q.deliveries.filter((x) => x.version === v.n && x.state !== 'cancelled');
      const shown = all.filter((x) => !(x.state === 'failed' && all.some((y) => y.channel === x.channel && y.state === 'sent')));
      if (shown.length) { const rows = deliveryRows(shown, Q.quote); rows.classList.add('qv-vdel'); nodes.push(rows); }
      else if (v.pdf && !all.length) nodes.push(el('p', 'qv-vnote', 'Marked sent: no channel recorded.'));
    }
    host.replaceChildren(...nodes);
  }
  function renderNotes() {
    const host = part('notes'); if (!host) return;
    let ta = host.querySelector('textarea');
    if (!ta) {
      ta = el('textarea'); ta.rows = 3; ta.maxLength = 2000; ta.id = 'qv-notes'; ta.placeholder = 'Only for Elite Kitchens: never printed.'; ta.setAttribute('aria-label', 'Internal notes');
      const save = button('Save notes', 'btn-ghost', saveNotes, 'qv-notes-save'); save.disabled = true;
      ta.oninput = () => { Q.notesDirty = true; save.disabled = false; };
      host.append(el('h3', null, 'Internal notes'), ta, save);
    }
    if (!Q.notesDirty) { ta.value = Q.quote.notes || ''; Q.notesBase = Q.quote.notes || ''; }       // what the box was filled from (audit 2)
  }
  function renderActivity() {
    const host = part('activity'); if (!host) return;
    const q = Q.quote, nodes = [el('h3', null, 'Activity')];
    const lines = [];
    for (const c of (q.pipelineChanges || [])) {
      const bits = [];
      if (c.stage) bits.push(`${stageName(c.stage.from)} → ${stageName(c.stage.to)}${c.stage.corrected ? ' (correction)' : ''}`);
      if (c.value) bits.push(`pipeline value ${euros(c.value.from)} → ${euros(c.value.to)}`);
      if (bits.length) lines.push([c.at, `${c.action} v${c.version}: ${bits.join('; ')}`]);
    }
    for (const h of (q.history || [])) lines.push([h.at, `${h.action}${h.version ? ' v' + h.version : ''}${h.option ? ' (' + h.option + ')' : ''}${h.via ? ' via ' + (h.via === 'manual' ? 'staff (by hand)' : QuoteSend.CHANNEL_NAME[h.via] || h.via) : ''} · ${h.by}`]);
    lines.sort((a, b) => ((b[0] && b[0].toMillis ? b[0].toMillis() : 0) - (a[0] && a[0].toMillis ? a[0].toMillis() : 0)));
    const ul = el('ul', 'qv-activity-list'); lines.slice(0, 12).forEach(([at, text]) => ul.append(el('li', null, tsTime(at) + ' · ' + text)));
    nodes.push(ul);
    host.replaceChildren(...nodes);
  }

  // ---------- actions ----------
  async function saveDraft(useCurrentPrices) {
    const q = Q.quote; if (!q || Q.saving) return;
    if (!useCurrentPrices && !Q.dirty) return;
    if (Q.errors.length) { note('Fix the highlighted fields first: ' + Q.errors[0].message, 'err'); return; }
    if (staleEdit()) { renderMain(); renderActions(); return; }                       // decide first: see the box at the top (audit 2)
    const seq = Q.editSeq; Q.saving = true; renderActions();
    try {
      const data = { id: q.id, expectedRev: Q.dirty && Q.formRev != null ? Q.formRev : q.rev, answers: Q.answers };      // the revision the FORM is based on
      if (useCurrentPrices) data.useCurrentPrices = true;
      const saved = (await call('saveQuoteDraft')(data)).data;
      if (saved && Number.isInteger(saved.rev)) Q.formRev = saved.rev;                 // what is on screen is now based on this person's own save
      // Nothing typed since: the saved draft (as the server stored it, and repriced if asked) replaces the form when it arrives.
      if (Q.editSeq === seq) Q.dirty = false;
      note(useCurrentPrices ? 'Draft repriced with today\'s prices.' : 'Draft saved.');
    } catch (err) {
      note(errText(err), 'err');
      if (err.details && err.details.errors && Q.builder) Q.builder.showErrors(err.details.errors);
    } finally { Q.saving = false; if (Q.quote) renderMain(); renderActions(); }          // judged again now that the save is over
  }
  async function saveNotes() {
    const q = Q.quote; if (!q) return;
    if ((q.notes || '') !== (Q.notesBase || '')) {                       // someone else changed the notes since this box was filled
      Q.notesBase = q.notes || '';                                       // pressing Save notes AGAIN is the explicit decision to replace theirs
      note('Someone else changed the notes while you were typing, so yours were not saved yet. Press Save notes again to replace theirs with yours.', 'err'); return;
    }
    const b = $('qv-notes-save'); b.disabled = true;
    try { await call('setQuoteNotes')({ id: q.id, expectedRev: q.rev, notes: $('qv-notes').value }); Q.notesDirty = false; note('Notes saved.'); }
    catch (err) { note(errText(err), 'err'); b.disabled = false; }
  }
  async function revise() {
    const q = Q.quote; if (!q || Q.busy) return;
    Q.busy = true;
    try { const r = (await call('reviseQuote')({ id: q.id, expectedRev: q.rev })).data; note(`Revision v${r.draftVersion} started with the same prices. Change what you need, then send it.`); }
    catch (err) { note(errText(err), 'err'); }
    finally { Q.busy = false; }
  }
  async function openPdf(n, btn) {
    btn.disabled = true;
    try { const r = (await call('quotePdfUrl')({ id: Q.quote.id, version: n })).data; window.open(r.url, '_blank', 'noopener'); }
    catch (err) { note(errText(err), 'err'); }
    finally { btn.disabled = false; }
  }
  // Generic confirmation (discard a draft revision, delete a never-sent quote).
  function confirmBox(title, text, go, fn) {
    Q.dlg = { kind: 'confirm', fn };
    $('qc-title').textContent = title; $('qc-text').textContent = text; $('qc-go').textContent = go; $('qc-go').disabled = false; $('qc-err').textContent = '';
    showDialog($('qc-dlg')); $('qc-cancel').focus();
  }
  function confirmDiscard() {
    const q = Q.quote;
    confirmBox('Discard draft', `Throw away draft v${q.draftVersion}? The quote goes back to v${q.sentVersion}, the version the customer has.`, 'Discard draft', async () => {
      await call('discardQuoteDraft')({ id: q.id, expectedRev: q.rev }); Q.dirty = false; note('Draft discarded.');
    });
  }
  function confirmDelete() {
    const q = Q.quote;
    confirmBox('Delete quote', `Delete ${q.ref}? It was never sent, so nothing is kept. Its number is not reused.`, 'Delete quote', async () => {
      await call('deleteQuoteDraft')({ id: q.id, expectedRev: q.rev }); Q.dirty = false;
      const back = Q.cameFrom && Q.cameFrom !== Q.hash ? Q.cameFrom : '#quotes'; Q.cameFrom = null; location.hash = back;
      setTimeout(() => { if (back.startsWith('#c/')) setCustMsg(q.ref + ' deleted.', 'ok'); else note(q.ref + ' deleted.'); }, 50);
    });
  }
  $('qc-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Q.dlg; if (!d || d.kind !== 'confirm') return;
    $('qc-go').disabled = true; $('qc-err').textContent = '';
    try { closeDialog($('qc-dlg')); Q.dlg = null; await d.fn(); }
    catch (err) { note(errText(err), 'err'); }
  });
  $('qc-cancel').onclick = () => { closeDialog($('qc-dlg')); Q.dlg = null; };

  // What will happen to the pipeline, in words (the server applies the same rules: functions/lib/quotePipeline.js). The dialogs
  // read the customer's stage and pipeline value fresh, so a change made a moment ago (e.g. an accept) is already counted.
  async function freshCustomer(phone) {
    const [c, ct] = await Promise.all([db.collection('conversations').doc(phone).get().catch(() => null), db.collection('contacts').doc(phone).get().catch(() => null)]);
    const conv = c && c.exists ? c.data() : convOf(phone);
    const contact = ct && ct.exists ? ct.data() : Q.contact || {};
    return { stage: conv ? inboxStatus(conv) : 'inbox', value: typeof contact.quoteValue === 'number' ? contact.quoteValue : null };
  }
  const nameFor = (q) => (Q.contact && Q.contact.name) || q.customerName || formatPhone(q.phone);
  // A value about to be set (null = left as it is).
  function valuePreview(from, to) {
    if (to == null || to === from) return from == null ? 'There is no pipeline value.' : `The pipeline value stays ${euros(from)}.`;
    return from == null ? `Pipeline value set to ${euros(to)}.` : `Pipeline value ${euros(from)} → ${euros(to)}.`;
  }
  // A change the server made ({ from, to }; to = null means it was cleared).
  const valueChange = (c) => (c.to == null ? `Pipeline value ${euros(c.from)} cleared.` : c.from == null ? `Pipeline value set to ${euros(c.to)}.` : `Pipeline value ${euros(c.from)} → ${euros(c.to)}.`);

  // ---------- accept ----------
  async function openAccept() {
    const q = Q.quote, v = sentV(); if (!q || !v) return;
    const { stage, value } = await freshCustomer(q.phone);
    Q.dlg = { kind: 'accept', q, v, stage, value };
    $('qa-who').textContent = `${q.ref} v${v.n} for ${nameFor(q)}.`;
    $('qa-expired').hidden = !isExpired(q);
    $('qa-expired').textContent = `This quote's validity ended on ${fmtDate(q.validUntil)}. You can still mark it accepted.`;
    const opts = $('qa-options'); opts.replaceChildren();
    for (const o of v.sheet.options) {
      const l = el('label', 'q-radio'), r = el('input'); r.type = 'radio'; r.name = 'qa-option'; r.value = o.key;
      r.onchange = () => { $('qa-value').value = o.incVat >= 1 ? CRM.money(o.incVat) : ''; acceptEffect(); };
      l.append(r, el('span', null, `${o.name} · ${euros(o.incVat)}`)); opts.append(l);
    }
    $('qa-closed-row').hidden = stage !== 'closed';
    $('qa-move-closed').checked = false;
    $('qa-closed-text').textContent = `Also move ${nameFor(q)} to Won (they are in Closed)`;
    $('qa-value').value = '';
    $('qa-err').textContent = ''; $('qa-go').disabled = false;
    acceptEffect();
    showDialog($('qa-dlg')); (opts.querySelector('input') || $('qa-cancel')).focus();
  }
  function acceptEffect() {
    const d = Q.dlg; if (!d || d.kind !== 'accept') return;
    const who = nameFor(d.q), s = d.stage, moveClosed = $('qa-move-closed').checked;
    const stageText = ['inbox', 'booked', 'quoted'].includes(s) || (s === 'closed' && moveClosed) ? `${who} will move from ${stageName(s)} to Won.` : `${who} stays in ${stageName(s)}.`;
    const typed = CRM.parseMoney($('qa-value').value);
    $('qa-effect').textContent = stageText + ' ' + (Number.isNaN(typed) ? '' : valuePreview(d.value, typed));
  }
  $('qa-move-closed').onchange = acceptEffect;
  $('qa-value').oninput = acceptEffect;
  $('qa-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Q.dlg; if (!d || d.kind !== 'accept') return;
    const chosen = $('qa-options').querySelector('input:checked');
    if (!chosen) { $('qa-err').textContent = 'Choose the option the customer chose.'; return; }
    const value = CRM.parseMoney($('qa-value').value);
    if (Number.isNaN(value) || (value !== null && (value < 1 || value > 1000000))) { $('qa-err').textContent = 'The pipeline value should be a number of euros, e.g. 14500 or €14,500, or empty.'; return; }
    $('qa-go').disabled = true; $('qa-err').textContent = '';
    try {
      const r = (await call('acceptQuote')({ id: d.q.id, expectedRev: d.q.rev, option: chosen.value, pipeline: { moveClosed: $('qa-move-closed').checked, value } })).data;
      closeDialog($('qa-dlg')); Q.dlg = null;
      const who = nameFor(d.q), o = d.v.sheet.options.find((x) => x.key === chosen.value);
      note([`Accepted: ${o.name}, ${euros(o.incVat)}.`, r.stage ? `${who} moved from ${stageName(r.stage.from)} to Won.` : `${who}'s stage did not change.`, r.value ? valueChange(r.value) : ''].filter(Boolean).join(' '));
    } catch (err) { $('qa-err').textContent = errText(err); $('qa-go').disabled = false; }
  });
  $('qa-cancel').onclick = () => { closeDialog($('qa-dlg')); Q.dlg = null; };

  // ---------- decline ----------
  function openDecline() {
    const q = Q.quote; if (!q) return;
    Q.dlg = { kind: 'decline', q };
    $('qd-who').textContent = `${q.ref} v${q.sentVersion} for ${nameFor(q)}.`;
    $('qd-reason').value = ''; $('qd-err').textContent = ''; $('qd-go').disabled = false;
    showDialog($('qd-dlg')); $('qd-reason').focus();
  }
  $('qd-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Q.dlg; if (!d || d.kind !== 'decline') return;
    $('qd-go').disabled = true; $('qd-err').textContent = '';
    try {
      await call('declineQuote')({ id: d.q.id, expectedRev: d.q.rev, reason: $('qd-reason').value });
      closeDialog($('qd-dlg')); Q.dlg = null;
      note('Marked declined. The customer\'s stage did not change.');
    } catch (err) { $('qd-err').textContent = errText(err); $('qd-go').disabled = false; }
  });
  $('qd-cancel').onclick = () => { closeDialog($('qd-dlg')); Q.dlg = null; };

  // ---------- reopen ----------
  async function openReopen() {
    const q = Q.quote; if (!q) return;
    const last = q.status === 'accepted' ? [...(q.pipelineChanges || [])].reverse().find((c) => c.action === 'accepted') || {} : {};
    const { stage, value } = await freshCustomer(q.phone);
    const canMove = !!(last.stage && stage === last.stage.to), canRestore = !!(last.value && value === last.value.to);
    Q.dlg = { kind: 'reopen', q, last, canMove, canRestore };
    $('qr-who').textContent = `${q.ref} goes back to Sent (it was ${statusText(q).toLowerCase()}).`;
    $('qr-move-row').hidden = !canMove; $('qr-move').checked = canMove;
    if (canMove) $('qr-move-text').textContent = `Move ${nameFor(q)} back from ${stageName(last.stage.to)} to ${stageName(last.stage.from)}`;
    $('qr-value-row').hidden = !canRestore; $('qr-value').checked = canRestore;
    if (canRestore) $('qr-value-text').textContent = last.value.from == null ? 'Clear the pipeline value set when it was accepted' : `Put the pipeline value back to ${euros(last.value.from)}`;
    reopenEffect();
    $('qr-err').textContent = ''; $('qr-go').disabled = false;
    showDialog($('qr-dlg')); $('qr-go').focus();
  }
  function reopenEffect() {
    const d = Q.dlg; if (!d || d.kind !== 'reopen') return;
    const parts = [];
    if (d.q.status === 'declined') parts.push('Declining did not change the pipeline, so nothing else changes.');
    else {
      parts.push(d.canMove && $('qr-move').checked ? 'Within 5 minutes of accepting, this counts as a correction and leaves no trace.' : `${nameFor(d.q)}'s stage does not change.`);
      if (!d.canMove && d.last.stage) parts.push('(The customer was moved since, so moving them back is not offered.)');
      if (!$('qr-value').checked || !d.canRestore) parts.push('The pipeline value does not change.');
    }
    $('qr-effect').textContent = parts.join(' ');
  }
  $('qr-move').onchange = reopenEffect; $('qr-value').onchange = reopenEffect;
  $('qr-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Q.dlg; if (!d || d.kind !== 'reopen') return;
    $('qr-go').disabled = true; $('qr-err').textContent = '';
    try {
      const pipeline = d.q.status === 'accepted' ? { moveBack: d.canMove && $('qr-move').checked, restoreValue: d.canRestore && $('qr-value').checked } : {};
      const r = (await call('reopenQuote')({ id: d.q.id, expectedRev: d.q.rev, pipeline })).data;
      closeDialog($('qr-dlg')); Q.dlg = null;
      const who = nameFor(d.q);
      note(['Reopened: the quote is Sent again.', r.stage ? `${who} moved back to ${stageName(r.stage.to)}${r.stage.corrected ? ' (a correction: the move to Won will not be counted)' : ''}.` : '', r.value ? valueChange(r.value) : ''].filter(Boolean).join(' '));
    } catch (err) { $('qr-err').textContent = errText(err); $('qr-go').disabled = false; }
  });
  $('qr-cancel').onclick = () => { closeDialog($('qr-dlg')); Q.dlg = null; };

  // ---------- send (Phase 6.1): through WhatsApp and/or email, resend a version, or send it yourself ----------
  // "Send quote" makes the customer PDF here and uploads it; the server then prepares it, delivers it through each ticked channel
  // and marks the quote Sent ONLY once a channel confirms delivery (functions/lib/quoteDelivery.js). Every channel's result is shown
  // on its own, with Retry for a failed one and "It arrived / It did not arrive" for one we could not confirm: nothing is ever
  // sent twice by itself. "Send this version" delivers an already-sent version's stored PDF through more channels. "Prefer to send
  // it yourself" is Phase 6's way: the PDF is made and kept, the quote marked sent at once, then Download PDF and an email draft.
  // The PDF is made here from the frozen draft, the customer's details and the business details read fresh; the server refuses the
  // send if any of them changed meanwhile, so the stored copy is always what the customer gets.
  const addDays = (k, n) => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  const MAX_RENDERS = 5;
  const ids = ['qsend-go', 'qsend-send', 'qsend-preview', 'qsend-cancel', 'qsend-renders', 'qsend-wa', 'qsend-em', 'qsend-wa-text', 'qsend-em-text', 'qsend-em-subject', 'qsend-wa-reopen'];
  const setBusy = (on) => { for (const id of ids) { $(id).disabled = on ? true : $(id).dataset.off === '1'; } };
  // A resend whose answer never arrived is continued as the SAME request (same id) if the dialog is opened again within half an hour, so the server
  // recognises it and nothing is sent twice (audit 10). Kept in this browser tab only.
  const REQ_KEY = 'ek-resend-request';
  function rememberedRequest(key) { try { const v = JSON.parse(sessionStorage.getItem(REQ_KEY) || 'null'); return v && v.key === key && Date.now() - v.at < 30 * 60 * 1000 ? v.requestId : null; } catch (e) { return null; } }
  function rememberRequest(key, requestId) { try { sessionStorage.setItem(REQ_KEY, JSON.stringify({ key, requestId, at: Date.now() })); } catch (e) { /* private window: the request is simply not remembered */ } }
  function forgetRequest() { try { sessionStorage.removeItem(REQ_KEY); } catch (e) { /* nothing to forget */ } }
  const UNSURE_CODES = ['functions/internal', 'functions/unavailable', 'functions/deadline-exceeded', 'functions/unknown'];
  const looksUnsure = (e) => UNSURE_CODES.includes(e && e.code) || /network|fetch|timed? ?out|offline/i.test((e && e.message) || '');
  async function sendContext(q) {
    const f = db.collection('quotes').doc(q.id);
    const [qs, settings, conv, contact] = await Promise.all([f.get(), db.collection('quoteSettings').doc('current').get(),
      db.collection('conversations').doc(q.phone).get(), db.collection('contacts').doc(q.phone).get()]);
    if (!qs.exists) throw new Error('This quote no longer exists.');
    if (!settings.exists) throw new Error('Quote Settings are not set up.');
    const ct = contact.exists ? contact.data() : {}, cv = conv.exists ? conv.data() : {};
    return { quote: { id: q.id, ...qs.data() }, settings: settings.data(), stage: conv.exists ? inboxStatus(cv) : 'inbox',
      value: typeof ct.quoteValue === 'number' ? ct.quoteValue : null, conv: conv.exists ? cv : null, contactDoc: ct,
      customer: { name: ct.name || cv.name || null, email: ct.email || null, address: ct.address || null } };
  }
  const versionDoc = async (id, n) => { const d = await db.collection('quotes').doc(id).collection('versions').doc(String(n)).get(); return d.exists ? d.data() : null; };
  function documentData(q, n, sheet, ctx, issueDate, renders, draft) {
    return { ref: `${q.ref}-v${n}`, issueDate, validUntil: addDays(issueDate, ctx.settings.validityDays), customer: { ...ctx.customer, phone: q.phone },
      business: ctx.settings.business, sheet, renders: renders || [], draft: !!draft };
  }
  const sendDlg = () => { const d = Q.dlg; return d && d.kind === 'send' ? d : null; };
  const err = (t) => { $('qsend-err').textContent = t || ''; };

  async function openSend(mode, ver) {
    const q = Q.quote; if (!q || Q.busy) return;
    if (mode === 'send') {
      if (Q.dirty) { await saveDraft(false); if (Q.dirty) return; }                // send exactly what is saved
      if (Q.errors.length || Q.problems.length) { note(Q.errors.length ? 'Fix the highlighted fields first.' : Q.problems[0], 'err'); return; }
    }
    if (mode !== 'resend' && q.preparedSend) { note('A send is already in progress for this quote: see the box at the top of the quote.', 'err'); return; }
    Q.busy = true;
    try {
      const ctx = await sendContext(q);
      const fq = ctx.quote, resend = mode === 'resend';
      const n = resend ? (ver || fq.sentVersion || fq.currentVersion) : mode === 'send' ? fq.draftVersion : (fq.currentVersion || fq.sentVersion) + 1;      // audit 14: a resend can name ANY sent version
      const base = await versionDoc(fq.id, resend ? n : mode === 'send' ? fq.draftVersion : fq.sentVersion);
      if (!base || (resend && base.state !== 'sent')) throw new Error(resend ? 'That version was not sent, so there is nothing to send again.' : 'This quote changed. Please try again.');
      const issueDate = resend ? base.issueDate : today();
      const b = ctx.settings.business || {}, trading = b.tradingName || 'Elite Kitchens', w = QuoteDocument.wording(base.sheet.document.project);
      const d = Q.dlg = { kind: 'send', mode, q: fq, ctx, n, sheet: base.sheet, base, issueDate, renders: [], requestId: (resend && rememberedRequest(`${fq.id}|${n}`)) || newRequestId(), blobUrl: null, view: 'form',
        conv: ctx.conv, contactDoc: ctx.contactDoc, reopenMsg: null, started: false, committed: null, result: null };
      d.defaults = { whatsapp: QuoteSend.whatsappText({ name: ctx.customer.name, ref: fq.ref, version: n, trading }), emailSubject: QuoteSend.emailSubject({ trading, wording: w, ref: fq.ref, version: n }),
        email: QuoteSend.emailText({ name: ctx.customer.name, ref: fq.ref, version: n, trading, wording: w, options: base.sheet.options.length, validityDays: ctx.settings.validityDays, business: b }) };
      $('qsend-wa-text').value = d.defaults.whatsapp; $('qsend-em-subject').value = d.defaults.emailSubject; $('qsend-em-text').value = d.defaults.email;
      $('qsend-title').textContent = mode === 'send' ? `Send ${fq.ref} v${n}` : mode === 'renew' ? `Send ${fq.ref} again (as v${n})` : `Send ${fq.ref} v${n} to the customer`;
      $('qsend-who').textContent = mode === 'send' ? 'Elite OS makes the customer PDF, keeps an exact copy with the quote, sends it, and marks the quote sent once a channel accepts it for delivery.'
        : mode === 'renew' ? 'The same options and prices as v' + fq.sentVersion + ', with a new date and validity. Elite OS keeps an exact copy of the PDF and marks the quote sent once a channel accepts it for delivery.'
        : `Sends the stored PDF of v${n}, exactly as it was. Nothing about the quote changes.`;
      const facts = $('qsend-facts'); facts.replaceChildren();
      const fact = (k, v) => facts.append(el('dt', null, k), el('dd', null, v));
      fact('Customer', ctx.customer.name || formatPhone(fq.phone));
      fact('Address', resend ? ((base.customer && base.customer.address) || '— (none)') : ctx.customer.address || '— (none)');
      fact('Email', ctx.customer.email || '— (none)');
      fact('Date', fmtDate(issueDate));
      fact('Valid until', fmtDate(resend ? base.validUntil : addDays(issueDate, ctx.settings.validityDays)) + ` (${ctx.settings.validityDays} days)`);
      fact('Options', base.sheet.options.map((o) => `${o.name} ${euros(o.incVat)}`).join(' · '));
      const warn = [!resend && !ctx.customer.address && 'There is no address: the quote will show only the name. Add it in the customer\'s Details first if it should be printed.',
        !ctx.customer.email && 'There is no email address: the email draft will have no recipient.'].filter(Boolean);
      $('qsend-warn').hidden = !warn.length; $('qsend-warn').textContent = warn.join(' ');
      $('qsend-renders').value = ''; $('qsend-thumbs').replaceChildren();
      $('qsend-reopen-row').hidden = ctx.stage !== 'closed'; $('qsend-reopen').checked = false;
      $('qsend-reopen-text').textContent = `Reopen: move ${ctx.customer.name || 'the customer'} from Closed to Quoted`;
      const dearest = base.sheet.options.find((o) => o.key === base.sheet.dearest);
      $('qsend-value').value = dearest && dearest.incVat >= 1 ? CRM.money(dearest.incVat) : '';      // a €0 quote proposes no value
      $('qsend-new-only').hidden = resend; $('qsend-manual-row').hidden = resend; $('qsend-preview').hidden = resend;
      $('qsend-progress').textContent = ''; err('');
      $('qsend-form').hidden = false; $('qsend-results').hidden = true; $('qsend-done').hidden = true;
      for (const id of ids) $(id).dataset.off = '0';
      $('qsend-wa').checked = false; $('qsend-em').checked = false;
      setBusy(false);
      renderChannels(true);
      sendEffect();
      showDialog($('qsend-dlg')); $('qsend-send').focus();
      loadChannelInfo(d);
    } catch (e) { note(errText(e), 'err'); }
    finally { Q.busy = false; }
  }

  // --- which channels can be used, and why not (the logic is quote-send-model.js; this only draws it) ---
  async function loadChannelInfo(d) {
    try {
      if (!Q.mailInfo) { const r = (await call('quoteChannels')({})).data || {}; Q.mailInfo = r.email || { enabled: false }; Q.waInfo = r.whatsapp || { enabled: true, template: false }; }
    } catch (e) { Q.mailInfo = { enabled: false }; Q.waInfo = { enabled: true, template: false }; }
    await loadReopenMsg(d);
    if (sendDlg() === d) renderChannels(false);
  }
  async function loadReopenMsg(d) {
    const w = d.conv && d.conv.reopen && d.conv.reopen.wamid;
    if (!w) { d.reopenMsg = null; return; }
    try { const m = await db.collection('conversations').doc(d.q.phone).collection('messages').doc(w).get(); d.reopenMsg = m.exists ? m.data() : null; } catch (e) { d.reopenMsg = null; }
  }
  function channelStatesNow(d) {
    return QuoteSend.channelStates({ conv: d.conv, contact: d.contactDoc, mail: Q.mailInfo || null, nowMs: Date.now(), reopenMsg: d.reopenMsg, template: Q.waInfo ? !!Q.waInfo.template : null });
  }
  const ticked = () => ['whatsapp', 'email'].filter((c) => $(c === 'whatsapp' ? 'qsend-wa' : 'qsend-em').checked);
  function renderChannels(first) {
    const d = sendDlg(); if (!d || d.view !== 'form') return;
    const st = channelStatesNow(d);
    const rows = { whatsapp: ['qsend-wa', 'qsend-wa-state', 'qsend-wa-box'], email: ['qsend-em', 'qsend-em-state', 'qsend-em-box'] };
    // One channel is ticked for staff until they choose for themselves (once the server has said whether email is switched on).
    if (!d.userTouched && Q.mailInfo && !ticked().length) for (const c of QuoteSend.defaultChannels(st)) $(rows[c][0]).checked = true;
    for (const c of ['whatsapp', 'email']) {
      const [cb, stateEl, box] = rows[c], s = st[c];
      if (!s.usable) $(cb).checked = false;
      $(cb).dataset.off = s.usable ? '0' : '1'; $(cb).disabled = !s.usable || !!d.working;
      $(stateEl).textContent = s.text; $(stateEl).dataset.state = s.state;
      $(box).hidden = !$(cb).checked;
    }
    const wa = st.whatsapp;
    // The message box follows the route. Window open: the staff's own caption (editable). Window closed with the approved template: the
    // template's fixed words, read-only, because WhatsApp does not let them be changed. If the customer replies while the dialog is
    // open, the box goes back to the caption staff had (or the default). The server decides again at the moment of sending.
    const box = $('qsend-wa-text');
    if (wa.route === 'template') {
      if (d.waRoute !== 'template') d.waCaption = box.value;
      box.value = QuoteSend.templateText({ name: d.ctx.customer.name, ref: d.q.ref, version: d.n }); box.readOnly = true;
      $('qsend-wa-note').textContent = '(the fixed words of the approved quotation template, with the PDF attached)';
    } else if (wa.route === 'document') {
      if (d.waRoute === 'template') box.value = d.waCaption != null ? d.waCaption : d.defaults.whatsapp;
      box.readOnly = false; $('qsend-wa-note').textContent = '(sent with the PDF)';
    }
    if (wa.route) d.waRoute = wa.route;
    $('qsend-wa-reopen').hidden = !(wa.state === 'closed' && wa.canReopen);
    $('qsend-wa-reopen').dataset.off = $('qsend-wa-reopen').hidden ? '1' : '0';
    const any = ticked().length > 0;
    $('qsend-send').dataset.off = any ? '0' : '1'; $('qsend-send').disabled = !any || !!d.working;
    $('qsend-send').title = any ? '' : 'Choose WhatsApp or email first.';
    $('qsend-via-note').textContent = any ? (ticked().length > 1 ? 'Both are sent. If one fails, the other still counts, and you can retry just the one that failed.' : '')
      : 'Neither channel can be used right now. Reopen the WhatsApp conversation (the customer must reply before it opens), add an email address in their Details, or send it yourself below.';
    sendEffect();
  }
  for (const id of ['qsend-wa', 'qsend-em']) $(id).addEventListener('change', () => { const d = sendDlg(); if (d) d.userTouched = true; renderChannels(false); });
  $('qsend-wa-reopen').onclick = () => { const d = sendDlg(); if (d && window.openReopenFor) window.openReopenFor(d.q.phone, d.reopenMsg); };
  // The customer's conversation changed (they replied, or a Reopen template was sent): the WhatsApp row follows at once. Called by app.js.
  Q.convChanged = async () => {
    const d = sendDlg(); if (!d || d.view !== 'form') return;
    const c = convOf(d.q.phone); if (!c) return;
    const { id, ...data } = c; d.conv = data; await loadReopenMsg(d);
    if (sendDlg() === d) renderChannels(false);
  };

  function sendEffect() {
    const d = sendDlg(); if (!d) return;
    if (d.mode === 'resend') { $('qsend-effect').textContent = 'Sending an earlier version again does not change the quote or the customer\'s stage.'; return; }
    const who = d.ctx.customer.name || 'The customer', s = d.ctx.stage;
    const moves = s === 'inbox' || s === 'booked' || (s === 'closed' && $('qsend-reopen').checked);
    const typed = CRM.parseMoney($('qsend-value').value);
    $('qsend-effect').textContent = (moves ? `${who} will move from ${stageName(s)} to Quoted.` : `${who} stays in ${stageName(s)}.`) + ' ' + (Number.isNaN(typed) ? '' : valuePreview(d.ctx.value, typed))
      + (ticked().length ? ' This happens once a channel accepts it for delivery.' : '');
  }
  $('qsend-reopen').onchange = sendEffect;
  $('qsend-value').oninput = sendEffect;
  $('qsend-renders').onchange = async (e) => {
    const d = sendDlg(); if (!d) return;
    const files = [...e.target.files].slice(0, MAX_RENDERS);
    err(e.target.files.length > MAX_RENDERS ? `Only the first ${MAX_RENDERS} images are used.` : '');
    $('qsend-progress').textContent = files.length ? 'Reading the images…' : '';
    try {
      d.renders = await Promise.all(files.map((f) => QuoteDocument.readRender(f)));
      $('qsend-thumbs').replaceChildren(...d.renders.map((u, i) => { const img = el('img'); img.src = u; img.alt = 'Render ' + (i + 1); return img; }));
      $('qsend-progress').textContent = d.renders.length ? `${d.renders.length} render${d.renders.length > 1 ? 's' : ''} added, each on its own page.` : '';
    } catch (e2) { d.renders = []; $('qsend-thumbs').replaceChildren(); $('qsend-progress').textContent = ''; err(errText(e2)); }
  };
  $('qsend-preview').onclick = () => {
    const d = sendDlg(); if (!d) return;
    showPreview(documentData(d.q, d.n, d.sheet, d.ctx, d.issueDate, d.renders, true), `Preview of ${d.q.ref} v${d.n} — not sent yet`);
  };

  // --- the PDF: made once per dialog (a repeat of the same request must carry the same file) ---
  async function makePdfAndUpload(d, n, sheet, progress) {
    if (!d.upload) {
      progress('Making the PDF…');
      const data = documentData(d.q, n, sheet, d.ctx, d.issueDate, d.renders, false);
      d.filename = `EliteKitchens-${d.q.ref}-v${n}.pdf`;
      d.blob = await QuoteDocument.toPdf(data, { filename: d.filename });
      d.upload = true;
    }
    progress('Uploading the PDF…');
    const path = `uploads/${auth.currentUser.uid}/${Date.now()}-${d.q.ref}-v${n}.pdf`;
    await firebase.storage().ref(path).put(d.blob, { contentType: 'application/pdf' });
    return path;
  }
  function pipelineChoice(d) {
    const value = CRM.parseMoney($('qsend-value').value);
    if (Number.isNaN(value) || (value !== null && (value < 1 || value > 1000000))) { err('The pipeline value should be a number of euros, e.g. 14500 or €14,500, or empty.'); return null; }
    return { reopen: $('qsend-reopen').checked, value };
  }

  // --- Send quote: through the ticked channels ---
  $('qsend-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = sendDlg(); if (!d || d.working || d.view !== 'form') return;
    const channels = ticked();
    if (!channels.length) { err('Choose WhatsApp or email first.'); return; }
    const messages = {}, wa = $('qsend-wa-text').value.trim(), em = $('qsend-em-text').value.trim(), subject = $('qsend-em-subject').value.trim();
    if (channels.includes('whatsapp')) { if (!wa) { err('Write the WhatsApp message.'); return; } if (wa.length > 1024) { err('The WhatsApp message is too long (max 1,024 characters).'); return; } messages.whatsapp = wa; }
    if (channels.includes('email')) { if (!em) { err('Write the email message.'); return; } if (!subject) { err('Write the email subject.'); return; } messages.email = em; }
    const resend = d.mode === 'resend';
    const pipeline = resend ? null : pipelineChoice(d); if (!resend && !pipeline) return;
    d.working = true; err(''); setBusy(true);
    const progress = (t) => { $('qsend-progress').textContent = t; };
    try {
      let n = d.n, expectedRev = d.q.rev, sheet = d.sheet, r;
      if (resend) {
        progress('Sending…');
        r = (await call('deliverQuote')({ id: d.q.id, version: n, requestId: d.requestId, channels, messages, ...(messages.email ? { subject, recipients: { email: (d.contactDoc && d.contactDoc.email) || '' } } : {}) })).data;      // the address the Email row showed (audit 3)
      } else {
        if (d.mode === 'renew' && !d.revisedTo) {                          // the next version, a copy with the same prices (once per dialog)
          progress('Starting v' + n + '…');
          const rv = (await call('reviseQuote')({ id: d.q.id, expectedRev })).data;
          d.revisedTo = rv.draftVersion; d.reviseRev = rv.rev;
          const v = await versionDoc(d.q.id, d.revisedTo); d.sheet = v.sheet;
        }
        if (d.mode === 'renew') { n = d.revisedTo; expectedRev = d.reviseRev; sheet = d.sheet; }
        const path = await makePdfAndUpload(d, n, sheet, progress);
        progress('Sending…');
        r = (await call('deliverQuote')({ id: d.q.id, expectedRev, requestId: d.requestId, issueDate: d.issueDate, settingsRev: d.ctx.settings.rev,
          customer: d.ctx.customer, pdfUploadPath: path, pipeline, channels, messages, ...(messages.email ? { subject } : {}) })).data;
        Q.dirty = false; d.sentN = n; d.sheetSent = sheet;
        if (d.blob) { if (d.blobUrl) URL.revokeObjectURL(d.blobUrl); d.blobUrl = URL.createObjectURL(d.blob); }
      }
      progress(''); if (resend) forgetRequest(); showResults(d, r);
    } catch (e2) {
      progress('');
      d.working = false;                                                  // BEFORE the controls are redrawn: they follow this flag, and the message below tells staff to press Send again (audit 10)
      if (resend) { if (looksUnsure(e2)) rememberRequest(`${d.q.id}|${d.n}`, d.requestId); else forgetRequest(); }       // an unsure resend continues as the SAME request
      if (looksUnsure(e2)) {
        err('The connection dropped while sending, so we do not know whether it went. Nothing is ever sent twice by itself: press Send quote again to check (it is safe), or look at the quote page, which shows exactly what happened.');
      } else {
        err('Not sent: ' + errText(e2) + (d.revisedTo ? ` A draft v${d.revisedTo} was started: send it or discard it.` : ''));
      }
      setBusy(false); renderChannels(false);
    } finally { if (Q.dlg === d) d.working = false; }
  });

  // --- "Prefer to send it yourself": Phase 6's way, unchanged ---
  $('qsend-go').onclick = async () => {
    const d = sendDlg(); if (!d || d.working || d.view !== 'form' || d.mode === 'resend') return;
    const pipeline = pipelineChoice(d); if (!pipeline) return;
    d.working = true; err(''); setBusy(true);
    const progress = (t) => { $('qsend-progress').textContent = t; };
    let revised = false, expectedRev = d.q.rev, sheet = d.sheet, n = d.n;
    try {
      if (d.mode === 'renew') {                                         // the next version, a copy with the same prices
        progress('Starting v' + n + '…');
        const rv = (await call('reviseQuote')({ id: d.q.id, expectedRev })).data;
        revised = true; expectedRev = rv.rev; n = rv.draftVersion;
        const v = await versionDoc(d.q.id, n); sheet = v.sheet;
      }
      progress('Making the PDF…');
      const data = documentData(d.q, n, sheet, d.ctx, d.issueDate, d.renders, false);
      const filename = `EliteKitchens-${d.q.ref}-v${n}.pdf`;
      const blob = await QuoteDocument.toPdf(data, { filename });
      progress('Uploading the PDF…');
      const path = `uploads/${auth.currentUser.uid}/${Date.now()}-${d.q.ref}-v${n}.pdf`;
      await firebase.storage().ref(path).put(blob, { contentType: 'application/pdf' });
      progress('Marking the quote sent…');
      const r = (await call('sendQuote')({ id: d.q.id, expectedRev, requestId: d.requestId, issueDate: d.issueDate, settingsRev: d.ctx.settings.rev,
        customer: d.ctx.customer, pdfUploadPath: path, pipeline })).data;
      Q.dirty = false;
      d.blobUrl = URL.createObjectURL(blob); d.filename = filename; d.sentN = n; d.sheetSent = sheet;
      const who = d.ctx.customer.name || 'The customer';
      $('qsend-done-text').textContent = [`${d.q.ref} v${n} is marked sent, valid until ${fmtDate(r.validUntil)}.`,
        r.stage ? `${who} moved from ${stageName(r.stage.from)} to Quoted.` : `${who}'s stage did not change.`, r.value ? valueChange(r.value) : ''].filter(Boolean).join(' ');
      $('qsend-download').href = d.blobUrl; $('qsend-download').download = filename;
      $('qsend-email').disabled = false;
      $('qsend-form').hidden = true; $('qsend-done').hidden = false; $('qsend-download').focus();
    } catch (e2) {
      progress('');
      err('Not sent: ' + errText(e2) + (revised ? ` A draft v${n} was started: send it or discard it.` : ''));
      setBusy(false); renderChannels(false);
    } finally { if (Q.dlg === d) d.working = false; }
  };

  // --- the result: each channel on its own ---
  function showResults(d, r) {
    d.view = 'results'; d.result = r; if (r.committed) d.committed = r.committed;
    $('qsend-form').hidden = true; $('qsend-done').hidden = true; $('qsend-results').hidden = false;
    renderResults(); $('qsend-res-close').focus();
  }
  // One row per delivery, with the actions that make sense (shared by this dialog and the quote page).
  function deliveryRows(list, quote) {
    const ul = el('ul', 'qsend-res'), now = Date.now();
    for (const x of [...list].sort(QuoteSend.byChannel)) {
      const dsc = QuoteSend.describe(x, now), li = el('li', 'qsend-res-row tone-' + dsc.tone); li.dataset.channel = x.channel; li.dataset.state = dsc.state;
      li.append(el('span', 'qsend-mark', dsc.mark));
      const main = el('div', 'qsend-res-main'); main.append(el('strong', null, dsc.title));
      if (dsc.detail) main.append(el('p', 'qsend-res-detail', dsc.detail));
      const acts = el('div', 'qsend-res-acts');
      for (const a of dsc.actions) {
        const label = a === 'retry' ? `Retry ${QuoteSend.CHANNEL_NAME[x.channel] || ''}`.trim() : a === 'resume' ? `Send ${QuoteSend.CHANNEL_NAME[x.channel] || ''} now`.trim() : a === 'arrived' ? 'It arrived' : 'It did not arrive';
        const b = el('button', 'btn btn-ghost btn-sm', label); b.type = 'button'; b.dataset.action = a;
        b.onclick = () => deliveryAction(a, x, b);
        acts.append(b);
      }
      if (acts.childNodes.length) main.append(acts);
      li.append(main); ul.append(li);
    }
    return ul;
  }
  function liveDeliveries(requestId, fallback) {
    const live = Q.deliveries.filter((x) => x.requestId === requestId);
    const byId = new Map((fallback || []).map((x) => [x.id, x]));
    for (const x of live) byId.set(x.id, x);                            // the live record wins over the answer to the call
    return [...byId.values()];
  }
  function renderResults() {
    const d = sendDlg(); if (!d || d.view !== 'results') return;
    const list = liveDeliveries(d.requestId, d.result && d.result.deliveries), sum = QuoteSend.summarize(list, Date.now());
    const q = Q.quote && Q.quote.id === d.q.id ? Q.quote : null, n = d.sentN || d.n, who = d.ctx.customer.name || 'The customer';
    $('qsend-res-title').textContent = `${d.q.ref} v${n}: ${sum.sent ? 'sent' : 'not sent yet'}`;
    $('qsend-res-summary').textContent = sum.text;
    $('qsend-res-list').replaceChildren(...deliveryRows(list, d.q).childNodes);
    const c = d.committed;
    $('qsend-res-effect').textContent = sum.sent && d.mode !== 'resend' ? [c && c.stage ? `${who} moved from ${stageName(c.stage.from)} to Quoted.` : `${who}'s stage did not change.`, c && c.value ? valueChange(c.value) : ''].filter(Boolean).join(' ') : '';
    const prepared = !!(q && q.preparedSend && q.preparedSend.requestId === d.requestId);
    const settled = !list.some((x) => ['sending', 'unknown'].includes(QuoteSend.effective(x, Date.now())));
    $('qsend-res-manual').hidden = !prepared; $('qsend-res-cancel').hidden = !(prepared && settled && !sum.sent);
    const dl = $('qsend-res-download'); dl.hidden = !(d.blobUrl || prepared || d.mode === 'resend');
    if (d.blobUrl) { dl.href = d.blobUrl; dl.download = d.filename; dl.onclick = null; }
    else { dl.href = '#'; dl.removeAttribute('download'); dl.onclick = (ev) => { ev.preventDefault(); openPdf(d.sentN || d.n, dl); }; }
  }
  $('qsend-res-close').onclick = () => closeSend(true);
  $('qsend-res-manual').onclick = () => markPreparedSent();
  $('qsend-res-cancel').onclick = () => cancelPreparedSend();

  // --- retry, settle, cancel, mark sent by hand (from the dialog or the quote page) ---
  async function deliveryAction(action, x, btn) {
    const q = Q.quote; if (!q || Q.busy) return;
    Q.busy = true; if (btn) btn.disabled = true;
    try {
      const r = action === 'retry' || action === 'resume' ? (await call('retryQuoteDelivery')({ id: q.id, deliveryId: x.id })).data
        : (await call('resolveQuoteDelivery')({ id: q.id, deliveryId: x.id, outcome: action === 'arrived' ? 'delivered' : 'not_delivered' })).data;
      const d = sendDlg(); if (d && d.view === 'results' && d.requestId === r.requestId) { d.result = r; if (r.committed) d.committed = r.committed; renderResults(); }
      const dsc = (r.deliveries.find((y) => y.id === x.id));
      note(action === 'retry' || action === 'resume' ? `${QuoteSend.CHANNEL_NAME[x.channel]}: ${dsc && dsc.state === 'sent' ? 'sent.' : dsc && dsc.state === 'unknown' ? 'delivery not confirmed.' : 'failed again.'}` : action === 'arrived' ? 'Recorded as delivered.' : 'Recorded as not delivered: you can retry it.', dsc && dsc.state === 'failed' ? 'err' : undefined);
    } catch (e) { note(errText(e), 'err'); if (btn) btn.disabled = false; }
    finally { Q.busy = false; }
  }
  async function markPreparedSent() {
    const q = Q.quote; if (!q || !q.preparedSend || Q.busy) return;
    if (!window.confirm(`Mark ${q.ref} v${q.preparedSend.version} as sent by you? Nothing is sent to the customer from here: only do this if you sent them the PDF yourself.`)) return;
    Q.busy = true;
    try {
      const r = (await call('markQuoteSent')({ id: q.id, expectedRev: q.rev })).data;
      const d = sendDlg(); if (d && d.view === 'results') { d.result = r; if (r.committed) d.committed = r.committed; renderResults(); }
      note(`${q.ref} v${q.preparedSend.version} is marked sent (by you).`);
    } catch (e) { note(errText(e), 'err'); }
    finally { Q.busy = false; }
  }
  async function cancelPreparedSend() {
    const q = Q.quote; if (!q || !q.preparedSend || Q.busy) return;
    Q.busy = true;
    try {
      await call('cancelQuoteSend')({ id: q.id, expectedRev: q.rev });
      note('The send was cancelled and nothing was sent: the draft can be edited again.');
      if (sendDlg()) closeSend(true);
    } catch (e) { note(errText(e), 'err'); }
    finally { Q.busy = false; }
  }
  Q.deliveriesChanged = () => { renderResults(); };

  function closeSend(force) {
    const d = Q.dlg;
    if (d && d.kind === 'send') { if (d.working && !force) return; if (d.blobUrl) setTimeout(() => URL.revokeObjectURL(d.blobUrl), 60000); }
    closeDialog($('qsend-dlg')); if (Q.dlg === d) Q.dlg = null;
  }
  $('qsend-cancel').onclick = () => closeSend();
  $('qsend-close').onclick = () => closeSend();
  $('qsend-dlg').addEventListener('cancel', (e) => { const d = Q.dlg; if (d && d.kind === 'send' && d.working) e.preventDefault(); });
  // The usual email, from Gmail (the customer's address, the subject and the wording filled in, naming what the quote is
  // for). The PDF is attached by hand. (The fallback for "send it yourself"; direct sending does not need it.)
  $('qsend-email').onclick = () => {
    const d = sendDlg(); if (!d) return;
    const b = d.ctx.settings.business || {}, trading = b.tradingName || 'Elite Kitchens', c = d.ctx.customer;
    const sheet = d.sheetSent || d.sheet, w = QuoteDocument.wording(sheet.document.project);
    const subject = QuoteSend.emailSubject({ trading, wording: w, ref: d.q.ref, version: d.sentN });
    const body = QuoteSend.emailText({ name: c.name, ref: d.q.ref, version: d.sentN, trading, wording: w, options: sheet.options.length, validityDays: d.ctx.settings.validityDays, business: b });
    const url = 'https://mail.google.com/mail/?view=cm&fs=1' + (c.email ? '&to=' + encodeURIComponent(c.email) : '') + '&su=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
    window.open(url, '_blank', 'noopener');
  };

  // ---------- preview (marked "Draft · not sent") ----------
  async function showPreview(data, title) {
    $('qdoc-title').textContent = title;
    const page = $('qdoc-page'); page.replaceChildren(); page.style.transform = ''; page.style.height = '';
    showDialog($('qdoc-dlg'));
    const f = await QuoteDocument.show(page, data);
    const pages = Number(f.dataset.pages) || 1;
    $('qdoc-title').textContent = `${title} · ${pages} page${pages > 1 ? 's' : ''}`;
    const avail = $('qdoc-scroll').clientWidth - 24, w = f.offsetWidth;
    const scale = Math.min(1, avail / w);                                 // a phone shows the whole A4 width, smaller
    page.style.transform = scale < 1 ? `scale(${scale})` : ''; page.style.height = (f.offsetHeight * scale) + 'px'; page.style.width = (w * scale) + 'px';
    $('qdoc-close').focus();
  }
  async function openPreview() {
    const q = Q.quote, dv = draftV(); if (!q || !dv) return;
    if (!Q.sheet) { note('Fix the highlighted fields first.', 'err'); return; }
    try {
      const ctx = await sendContext(q);
      showPreview(documentData(q, q.draftVersion, Q.sheet, ctx, today(), [], true), `Preview of ${q.ref} v${q.draftVersion}${Q.dirty ? ' (with unsaved changes)' : ''} — not sent`);
    } catch (err) { note(errText(err), 'err'); }
  }
  $('qdoc-close').onclick = () => closeDialog($('qdoc-dlg'));
  $('qdoc-dlg').addEventListener('close', () => $('qdoc-page').replaceChildren());

  // ---------- new quote ----------
  async function createFor(phone, report) {
    try {
      const r = (await call('createQuote')({ phone, requestId: newRequestId() })).data;
      return r.id;
    } catch (err) { report(errText(err) + (/Quote Settings/.test(errText(err)) ? ' (Quotes > Quote Settings)' : '')); return null; }
  }
  function openNew() {
    Q.dlg = { kind: 'new' };
    $('nq-search').value = ''; $('nq-err').textContent = '';
    renderPicker(); showDialog($('nq-dlg')); $('nq-search').focus();
  }
  function renderPicker() {
    const s = $('nq-search').value.trim().toLowerCase();
    const found = S.convs.filter((c) => !s || matchesQuery(c, s)).slice(0, 8);
    $('nq-results').replaceChildren(...(found.length ? found.map((c) => {
      const b = el('button', 'nq-pick'); b.type = 'button'; b.setAttribute('role', 'listitem'); b.dataset.phone = c.id;
      const st = el('span', 'arow-stage', stageName(inboxStatus(c))); st.dataset.status = inboxStatus(c);
      b.append(el('span', 'nq-name', displayName(c)), el('span', 'nq-sub', [formatPhone(c.id), c.location].filter(Boolean).join(' · ')), st);
      b.onclick = async () => {
        b.disabled = true;
        const id = await createFor(c.id, (t) => { $('nq-err').textContent = t; });
        b.disabled = false;
        if (id) { closeDialog($('nq-dlg')); Q.dlg = null; Q.cameFrom = '#quotes'; location.hash = '#quotes/' + id; }
      };
      return b;
    }) : [el('p', 'd-appts-none', s ? 'No customer matches. Add them as a new customer below.' : 'No customers yet.')]));
  }
  $('nq-search').oninput = renderPicker;
  $('nq-form').addEventListener('submit', (e) => e.preventDefault());
  $('nq-cancel').onclick = () => { closeDialog($('nq-dlg')); Q.dlg = null; };
  $('nq-add').onclick = () => {
    closeDialog($('nq-dlg')); Q.dlg = null;
    openAddCustomer({}, async (phone) => {
      const id = await createFor(phone, (t) => note(t, 'err'));
      if (id) { Q.cameFrom = '#quotes'; location.hash = '#quotes/' + id; }
    });
  };
  $('q-new').onclick = openNew;

  // ---------- the customer profile block ----------
  function setCustMsg(text, kind) { const m = $('d-quotes-msg'); m.textContent = text || ''; m.className = 'd-msg' + (kind ? ' ' + kind : ''); }
  function watchCustomer(id) {
    if (Q.unsubCust) { Q.unsubCust(); Q.unsubCust = null; }
    Q.customer = id || null; Q.custList = []; Q.custLoaded = false; setCustMsg('');
    renderCustomer();
    if (!id) return;
    Q.unsubCust = db.collection('quotes').where('phone', '==', id).onSnapshot((snap) => {
      if (Q.customer !== id) return;
      Q.custList = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt ? b.createdAt.toMillis() : 0) - (a.createdAt ? a.createdAt.toMillis() : 0));
      Q.custLoaded = true; renderCustomer();
    }, (e) => { if (Q.customer === id) { Q.custLoaded = true; renderCustomer(); setCustMsg('Cannot load quotes: ' + errText(e), 'err'); } });
  }
  function renderCustomer() {
    const host = $('d-quotes-list');
    $('d-quote-new').disabled = !Q.customer;
    if (!Q.customer) { host.replaceChildren(); return; }
    if (!Q.custLoaded) { host.replaceChildren(el('p', 'd-appts-none', 'Loading…')); return; }
    if (!Q.custList.length) { host.replaceChildren(el('p', 'd-appts-none', 'No quotes yet.')); return; }
    host.replaceChildren(...Q.custList.map((q) => {
      const b = el('button', 'd-quote'); b.type = 'button'; b.dataset.id = q.id;
      const top = el('span', 'd-quote-top'); const p = priceOf(q);
      top.append(el('span', 'd-quote-ref', q.ref), chip(q), el('span', 'd-quote-price', euros(p.amount)));
      b.append(top, el('span', 'd-appt-sub', lineOf(q)));
      b.onclick = () => { Q.cameFrom = '#c/' + q.phone; location.hash = '#quotes/' + q.id; };
      return b;
    }));
  }
  $('d-quote-new').onclick = async () => {
    const phone = Q.customer; if (!phone) return;
    $('d-quote-new').disabled = true; setCustMsg('Creating the quote…');
    const id = await createFor(phone, (t) => setCustMsg(t, 'err'));
    $('d-quote-new').disabled = !Q.customer;
    if (id && Q.customer === phone) { setCustMsg(''); Q.cameFrom = '#c/' + phone; location.hash = '#quotes/' + id; }
  };

  // ---------- wiring ----------
  $('q-filter').addEventListener('click', (e) => { const b = e.target.closest('button[data-filter]'); if (b) { Q.filter = b.dataset.filter; renderList(); } });
  $('q-search').addEventListener('input', (e) => { Q.query = e.target.value; renderList(); });
  $('q-back').onclick = () => {
    if (Q.view === 'list') { location.hash = ''; return; }
    if (Q.view === 'settings') { location.hash = '#quotes'; return; }
    const back = Q.cameFrom && Q.cameFrom !== Q.hash ? Q.cameFrom : '#quotes';
    location.hash = back;
  };
  $('to-quotes').onclick = () => { location.hash = '#quotes'; };
  $('nav-quotes').addEventListener('click', (e) => { if (Q.active && Q.view === 'list') e.preventDefault(); });   // already here

  return Object.assign(Q, { handles, show, hide, stop, mayLeave, isDirty, watchCustomer, isExpired });
})();
