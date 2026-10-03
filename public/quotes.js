'use strict';
// Elite Kitchens Lead OS: quotes (Phase 6, docs/QUOTES.md). The Quotes screen (list, one quote, Quote Settings), the Quotes
// block in the customer profile, and the accept / decline / reopen dialogs. Reads Firestore directly (staff-only rules); every
// change goes through the quote callables. Prices shown while editing come from the calculator (quote-engine.js); the server
// recalculates them on every save. The form itself is quote-builder.js. Sending (with the customer PDF) is switched on in M4.
// Loaded after app.js (shares its helpers).
window.QUOTES = (() => {
  const LIMIT = 300;
  const STATUS = { draft: 'Draft', sent: 'Sent', accepted: 'Accepted', declined: 'Declined' };
  const SEND_LATER = 'Sending, with the customer PDF, is switched on in the next step.';
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
    return (isExpired(q) ? `Expired: valid until ${fmtDate(q.validUntil, false)} (sent ${tsShort(q.sentAt)})` : `Sent ${tsShort(q.sentAt)} · valid until ${fmtDate(q.validUntil, false)}`) + extra;
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
    Q.unsubQuote = db.collection('quotes').doc(id).onSnapshot((d) => {
      if (Q.id !== id) return;
      Q.quote = d.exists ? { id, ...d.data() } : null; Q.quoteLoaded = true;
      if (Q.quote) watchQuoteContact(Q.quote.phone);
      renderQuote();
    }, (e) => { if (Q.id === id) { Q.quoteLoaded = true; note('Cannot load the quote: ' + errText(e), 'err'); } });
    Q.unsubVersions = db.collection('quotes').doc(id).collection('versions').onSnapshot((snap) => {
      if (Q.id !== id) return;
      Q.versions = new Map(snap.docs.map((d) => [d.data().n, d.data()])); Q.versionsLoaded = true;
      renderQuote();
    }, () => {});
  }
  function closeQuote() {
    if (Q.unsubQuote) { Q.unsubQuote(); Q.unsubQuote = null; }
    if (Q.unsubVersions) { Q.unsubVersions(); Q.unsubVersions = null; }
    watchQuoteContact(null);
    if (Q.builder) { Q.builder.destroy(); Q.builder = null; }
    Object.assign(Q, { quote: null, quoteLoaded: false, versions: new Map(), versionsLoaded: false, builderKey: null, answers: null, dirty: false, sheet: null, errors: [], problems: [], notesDirty: false, built: null });
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
    for (const id of ['qa-dlg', 'qd-dlg', 'qr-dlg', 'qc-dlg', 'nq-dlg']) closeDialog($(id));
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
    if (q.draftVersion) {
      msgs.push(q.sentVersion ? `Draft v${q.draftVersion}: these changes are not sent. The customer has v${q.sentVersion}, sent ${tsDate(q.sentAt)}.` : 'Draft: not sent yet.');
      if (dv && Q.settings && (JSON.stringify(dv.priceList) !== JSON.stringify(Q.settings.priceList) || dv.vatRate !== Q.settings.vatRate)) msgs.push('prices');
    } else if (q.status === 'sent') {
      msgs.push(isExpired(q) ? `Expired: it was valid until ${fmtDate(q.validUntil)}. Nothing has changed: you can still mark it accepted, revise it or send it again.` : `Sent ${tsDate(q.sentAt)} · valid until ${fmtDate(q.validUntil)}.`);
    } else if (q.status === 'accepted') msgs.push(`Accepted ${tsDate(q.acceptedAt)}: ${q.acceptedOption.name}, ${euros(q.acceptedOption.incVat)} (v${q.acceptedOption.version}).`);
    else if (q.status === 'declined') msgs.push(`Declined ${tsDate(q.declinedAt)}` + (q.declineReason ? `: ${q.declineReason}.` : '.') + ' It can be reopened or revised if the customer comes back.');
    banner.replaceChildren(...msgs.map((m) => {
      if (m !== 'prices') { const p = el('p', 'qv-msg', m); if (isExpired(q) && !q.draftVersion) p.classList.add('warn'); return p; }
      const p = el('p', 'qv-msg', 'Prices in Quote Settings have changed since this draft was priced. ');
      const b = el('button', 'linkbtn', 'Use today\'s prices'); b.type = 'button'; b.id = 'qv-use-current'; b.onclick = () => saveDraft(true);
      p.append(b); return p;
    }));
    if (q.draftVersion) {
      if (!dv) { body.replaceChildren(el('p', 'appts-empty', 'Loading…')); return; }
      const key = q.draftVersion + '|' + JSON.stringify(dv.priceList);
      if (Q.builderKey !== key && !Q.dirty) {
        if (!QuoteBuilder.supports(dv.engine)) { body.replaceChildren(el('p', 'appts-empty', 'This quote was made with a calculator this screen cannot edit.')); return; }
        const host = el('div', 'qv-builder'); body.replaceChildren(host);
        Q.answers = dv.answers;
        Q.builder = QuoteBuilder.mount(host, { answers: dv.answers, priceList: dv.priceList, onChange: (a) => { Q.answers = a; Q.dirty = true; Q.editSeq++; recalc(); renderActions(); } });
        Q.builderKey = key;
      } else if (!Q.dirty && Q.builder && JSON.stringify(Q.answers) !== JSON.stringify(dv.answers)) {
        Q.answers = dv.answers; Q.builder.set(dv.answers);            // saved (here or elsewhere) and nothing typed since
      }
      recalc();
      return;
    }
    if (Q.builder) { Q.builder.destroy(); Q.builder = null; Q.builderKey = null; Q.answers = null; Q.dirty = false; }
    body.replaceChildren(sv ? sentView(q, sv) : el('p', 'appts-empty', 'Loading…'));
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
    if (d.inKitchen.length) lists.append(list('In your kitchen', d.inKitchen));
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
      if (editing && Q.problems.length) { const p = el('p', 'qv-warn-line', 'Before sending: ' + Q.problems.join(' ')); nodes.push(p); }
    } else nodes.push(el('p', 'qb-note', 'Loading…'));
    host.replaceChildren(...nodes);
  }
  function button(label, cls, onClick, id) { const b = el('button', 'btn btn-sm ' + cls, label); b.type = 'button'; if (id) b.id = id; b.onclick = onClick; return b; }
  // The buttons are built once per state of the quote; while typing only Save's state changes. (Rebuilding them on every
  // keystroke could swallow a click on Save made straight after typing: the field's change event redrew the button mid-click.)
  function renderActions() {
    const host = part('actions'); if (!host || !Q.quote) return;
    const q = Q.quote, key = [q.status, q.draftVersion, q.sentVersion].join('|');
    if (host.dataset.key !== key) { buildActions(host, q); host.dataset.key = key; }
    const save = $('qv-save');
    if (save) { save.disabled = Q.saving || !Q.dirty; save.textContent = Q.saving ? 'Saving…' : 'Save draft'; }
    const hint = host.querySelector('.qv-hint');
    if (hint && q.draftVersion) hint.textContent = Q.dirty ? 'Unsaved changes.' : SEND_LATER;
  }
  function buildActions(host, q) {
    const nodes = [el('h3', null, 'Actions')], row = el('div', 'qv-buttons');
    const disabled = (b, why) => { b.disabled = true; b.title = why; return b; };
    if (q.draftVersion) {
      row.append(button('Save draft', 'btn-primary', () => saveDraft(false), 'qv-save'), disabled(button('Send…', 'btn-ghost', () => {}, 'qv-send'), SEND_LATER));
      if (q.sentVersion) row.append(button('Discard draft…', 'btn-ghost', confirmDiscard, 'qv-discard'));
      else row.append(button('Delete quote…', 'btn-ghost qv-danger', confirmDelete, 'qv-delete'));
      nodes.push(row, el('p', 'qb-note qv-hint', SEND_LATER));
    } else if (q.status === 'sent') {
      row.append(button('Mark accepted…', 'btn-primary', openAccept, 'qv-accept'), button('Mark declined…', 'btn-ghost', openDecline, 'qv-decline'),
        button('Revise', 'btn-ghost', revise, 'qv-revise'), disabled(button('Send again…', 'btn-ghost', () => {}, 'qv-renew'), SEND_LATER));
      nodes.push(row, el('p', 'qb-note', 'Revise starts a new version with the same prices. ' + SEND_LATER));
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
      if (v.pdf) { const b = el('button', 'linkbtn', 'PDF'); b.type = 'button'; b.onclick = () => openPdf(v.n, b); r.append(b); }
      nodes.push(r);
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
    if (!Q.notesDirty) ta.value = Q.quote.notes || '';
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
    for (const h of (q.history || [])) lines.push([h.at, `${h.action}${h.version ? ' v' + h.version : ''}${h.option ? ' (' + h.option + ')' : ''} · ${h.by}`]);
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
    const seq = Q.editSeq; Q.saving = true; renderActions();
    try {
      const data = { id: q.id, expectedRev: q.rev, answers: Q.answers };
      if (useCurrentPrices) data.useCurrentPrices = true;
      await call('saveQuoteDraft')(data);
      // Nothing typed since: the saved draft (as the server stored it, and repriced if asked) replaces the form when it arrives.
      if (Q.editSeq === seq) Q.dirty = false;
      note(useCurrentPrices ? 'Draft repriced with today\'s prices.' : 'Draft saved.');
    } catch (err) {
      note(errText(err), 'err');
      if (err.details && err.details.errors && Q.builder) Q.builder.showErrors(err.details.errors);
    } finally { Q.saving = false; renderActions(); }
  }
  async function saveNotes() {
    const q = Q.quote; if (!q) return;
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
      r.onchange = () => { $('qa-value').value = CRM.money(o.incVat); acceptEffect(); };
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
