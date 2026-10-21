'use strict';
// Elite Kitchens Lead OS: the "Today" tab (Phase 11, docs/PHASE11_TODAY.md). The daily action centre: what is waiting for you, how urgent it is, and every new lead of the day with how it is going.
// Nothing here is a stored task. The cards are WORKED OUT, on every change, from live data by today-model.js (replies waiting, receptionist hand-overs, visits to book, quote follow-ups, reminders,
// rejected leads), so they appear and disappear by themselves, and one customer is one card. Only reminders and quote follow-up snoozes are stored (through staff-only functions).
// It asks the database directly for what it needs (not the 300 newest chats the Inbox shows), so a lead is never hidden by how many chats there are. Loaded after app.js and attention.js.
window.TODAY = (() => {
  const M = window.TodayModel, TS = firebase.firestore.Timestamp, DAY = 86400000;
  const REQUIRED = ['recent', 'booking', 'created', 'contacts', 'quotes', 'reminders', 'marks', 'appts'];
  const T = { active: false, started: false, filter: null, fromToday: false, unsubs: [], dayUnsubs: [], docs: new Map(), loaded: {}, recent: new Map(), booking: new Map(), created: new Map(), extra: new Map(),
    contactsToday: [], ledger: {}, quotes: [], reminders: [], doneRem: [], marks: {}, appts: null, issues: 0, leadIssues: [], day: '', result: null, busy: new Set(), snoozeFor: null, ticker: null, raf: 0, dlg: null, toastTimer: 0, error: '' };
  const NAV = ['nav-inbox', 'nav-pipeline', 'nav-appointments', 'nav-quotes', 'nav-projects', 'nav-assistant'];
  const rid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12));
  const showDlg = (d) => { if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', ''); };
  const hideDlg = (d) => { if (typeof d.close === 'function') { if (d.open) d.close(); } else d.removeAttribute('open'); };
  const hhmm = (t) => new Intl.DateTimeFormat('en-IE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t));
  const dayWord = (key) => new Intl.DateTimeFormat('en-IE', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(key + 'T12:00:00Z'));
  const plain = (e) => (e && e.message ? e.message : 'Something went wrong. Try again.').replace(/^(functions\/)?[\w-]+:\s*/, '');
  const nameOf = (c) => c.name || (c.phone ? formatPhone(c.phone) : '') || 'Customer';

  // ---------- live data ----------
  const loaded = () => REQUIRED.every((k) => T.loaded[k]);
  function listen(list, name, query, fn) {
    list.push(query.onSnapshot((snap) => { fn(snap); T.loaded[name] = true; T.error = ''; schedule(); }, (e) => { T.loaded[name] = true; T.error = 'Some of Today could not load: ' + plain(e); schedule(); }));
  }
  function startDay() {                                                // the three questions that depend on "today": restarted when the day changes
    for (const u of T.dayUnsubs) u(); T.dayUnsubs = []; T.created = new Map(); T.contactsToday = []; T.doneRem = [];
    T.day = M.dateKey(Date.now()); const t0 = TS.fromMillis(M.dayStart(Date.now()));
    listen(T.dayUnsubs, 'created', db.collection('conversations').where('createdAt', '>=', t0).limit(300), (s) => { T.created = new Map(s.docs.map((d) => [d.id, { id: d.id, ...d.data() }])); watchExtras(); });
    listen(T.dayUnsubs, 'contacts', db.collection('contacts').where('metaLead.receivedAt', '>=', t0).limit(300), (s) => { T.contactsToday = s.docs.map((d) => ({ id: d.id, ...d.data() })); watchExtras(); });
    listen(T.dayUnsubs, 'doneRem', db.collection('reminders').where('doneAt', '>=', t0).limit(100), (s) => { T.doneRem = s.docs.map((d) => ({ id: d.id, ...d.data() })); });
  }
  function start() {
    if (T.started) return; T.started = true;
    const now = Date.now();
    listen(T.unsubs, 'recent', db.collection('conversations').where('lastInboundAt', '>=', TS.fromMillis(now - 60 * DAY)).orderBy('lastInboundAt', 'desc').limit(500), (s) => { T.recent = new Map(s.docs.map((d) => [d.id, { id: d.id, ...d.data() }])); watchExtras(); });
    listen(T.unsubs, 'booking', db.collection('conversations').where('consult.needsBooking', '==', true).limit(200), (s) => { T.booking = new Map(s.docs.map((d) => [d.id, { id: d.id, ...d.data() }])); });
    listen(T.unsubs, 'quotes', db.collection('quotes').where('status', '==', 'sent').limit(300), (s) => { T.quotes = s.docs.map((d) => ({ id: d.id, ...d.data() })); });
    listen(T.unsubs, 'reminders', db.collection('reminders').where('status', '==', 'open').limit(300), (s) => { T.reminders = s.docs.map((d) => ({ id: d.id, ...d.data() })); });
    listen(T.unsubs, 'marks', db.collection('todayMarks').orderBy('at', 'desc').limit(300), (s) => { T.marks = {}; for (const d of s.docs) { const x = d.data(); if (x.kind === 'quote' && x.quoteId) T.marks['quote|' + x.quoteId] = x; } });
    listen(T.unsubs, 'appts', db.collection('appointments').where('start', '>=', TS.fromMillis(now - 8 * 3600e3)).orderBy('start').limit(400), (s) => { T.appts = s.docs.map((d) => ({ id: d.id, ...d.data() })); });
    listen(T.unsubs, 'issues', db.collection('healthIssues').where('status', '==', 'open'), (s) => { T.issues = s.size; });
    listen(T.unsubs, 'leadIssues', db.collection('leadIssues').where('status', '==', 'open').limit(100), (s) => { T.leadIssues = s.docs.map((d) => ({ id: d.id, ...d.data() })); });
    startDay();
    T.ticker = setInterval(() => { if (M.dateKey(Date.now()) !== T.day) startDay(); schedule(); }, 60000);       // waiting times grow, urgency changes, midnight passes
  }
  function stop() {
    for (const u of [...T.unsubs, ...T.dayUnsubs]) u(); for (const w of T.docs.values()) w.unsub(); clearInterval(T.ticker); cancelAnimationFrame(T.raf); clearTimeout(T.idleTimer); T.idleTimer = 0; T.raf = 0;
    Object.assign(T, { started: false, unsubs: [], dayUnsubs: [], docs: new Map(), loaded: {}, recent: new Map(), booking: new Map(), created: new Map(), extra: new Map(), contactsToday: [], ledger: {}, quotes: [], reminders: [], doneRem: [], marks: {}, appts: null,
      issues: 0, leadIssues: [], result: null, filter: null, snoozeFor: null, busy: new Set(), error: '' });
    hide(); badges();
  }
  // A lead's chat (and the lead ledger entry that says whether its welcome message went) may not be among the chats already loaded: each is watched on its own, a handful at most.
  function watchExtras() {
    const have = (id) => T.recent.has(id) || T.created.has(id) || T.booking.has(id), want = new Set();
    for (const c of T.contactsToday) { if (!have(c.id)) want.add('conversations/' + c.id); if (c.metaLead && c.metaLead.leadId) want.add('leads/' + c.metaLead.leadId); }
    for (const [p, w] of T.docs) if (!want.has(p)) { w.unsub(); T.docs.delete(p); if (p.startsWith('conversations/')) T.extra.delete(p.slice(14)); else delete T.ledger[p.slice(6)]; }
    for (const p of want) if (!T.docs.has(p)) {
      const conv = p.startsWith('conversations/'), id = p.split('/')[1];
      T.docs.set(p, { unsub: db.doc(p).onSnapshot((d) => { if (conv) { if (d.exists) T.extra.set(id, { id, ...d.data() }); else T.extra.delete(id); } else if (d.exists) T.ledger[id] = d.data(); else delete T.ledger[id]; schedule(); }, () => {}) });
    }
  }
  function compute() {
    const convs = [...new Map([...T.extra, ...T.created, ...T.booking, ...T.recent]).values()];
    T.result = M.build({ convs, appts: T.appts, quotes: T.quotes, reminders: [...T.reminders, ...T.doneRem], marks: T.marks, leadIssues: T.leadIssues, contactsToday: T.contactsToday, ledger: T.ledger, now: Date.now() });
    return T.result;
  }
  // Drawn on the next frame while Today is open. While it is NOT open only the menu badge and the Inbox's "Today" button depend on the result, so a burst of changes (a busy inbox) is worked out at most once
  // every 3 seconds instead of once per change (review of 18 Oct 2026).
  function schedule() {
    if (T.active) { if (T.raf) return; T.raf = requestAnimationFrame(() => { T.raf = 0; render(); }); return; }
    if (T.idleTimer) return;
    T.idleTimer = setTimeout(() => { T.idleTimer = 0; render(); }, 3000);
  }

  // ---------- navigation ----------
  const handles = (hash) => hash === '#today';
  function setNav(on) {
    const n = $('nav-today'); n.classList.toggle('active', on);
    if (on) { n.setAttribute('aria-current', 'page'); for (const id of NAV) { $(id).classList.remove('active'); $(id).removeAttribute('aria-current'); } }
    else { n.removeAttribute('aria-current'); $('nav-inbox').classList.add('active'); $('nav-inbox').setAttribute('aria-current', 'page'); }
  }
  function show() { T.active = true; setNav(true); setView(); render(); $('today-scroll').scrollTop = 0; }
  function hide() { if (!T.active) return; T.active = false; setNav(false); setView(); hideDlg($('rem-dlg')); T.dlg = null; toast(''); }
  const go = (hash) => { T.fromToday = /^#c\//.test(hash); location.hash = hash; };

  // ---------- drawing ----------
  function badges(r) {
    const red = r ? r.redTotal : 0, all = r ? r.cards.length : 0;
    const b = $('today-badge'); b.hidden = !red; b.textContent = red > 9 ? '9+' : red;
    const n = $('today-link-n'); n.hidden = !all; n.textContent = all; n.classList.toggle('red', red > 0);
    $('to-today').classList.toggle('urgent', red > 0);
  }
  const UTYPE = { reply: 'Reply', handover: 'Handover', booking: 'Book a visit', notice: 'Reminder check', quote: 'Quote', reminder: 'Reminder', leadfix: 'Lead to fix' };
  const btn = (text, cls, fn, busyKey) => { const b = el('button', 'btn btn-sm ' + cls, text); b.type = 'button'; b.disabled = !!(busyKey && T.busy.has(busyKey)); b.onclick = (e) => { e.stopPropagation(); fn(); }; return b; };
  function dueText(c) {
    const today = M.dateKey(Date.now()), when = c.dueTime ? ' at ' + c.dueTime : '';
    if (c.dueDate === today) return 'Due today' + when;
    return (c.dueDate < today ? 'Overdue: ' : 'Due ') + dayWord(c.dueDate) + when;
  }
  function reasonLine(c, r, now) {
    let t = r.text;
    if (r.type === 'reminder') t = dueText(c);
    else if (r.type === 'reply' || r.type === 'handover') t += ' · waiting ' + M.since(r.since, now);
    else if (r.type === 'booking' && r.since) t += ' · since ' + M.since(r.since, now) + ' ago';
    if (r.type === 'reply' && r.windowClosed) t += ' · the 24-hour window is closed: use Reopen';
    if (r.alertFailed) t += ' · your phone alert did not arrive';
    return el('div', 'td-reason', t);
  }
  function target(c) {
    if (c.kind === 'customer' || c.kind === 'notice') return () => go('#c/' + c.phone);
    if (c.kind === 'quote') return () => go('#quotes/' + c.quoteId);
    if (c.kind === 'reminder' && c.phone) return () => go('#c/' + c.phone);
    if (c.kind === 'lead') return () => window.ATTN && ATTN.addLead(c.lead);
    return null;
  }
  async function act(key, fn, okText, undo) {
    if (T.busy.has(key)) return; T.busy.add(key); schedule();
    try { await fn(); if (okText) toast(okText, undo); } catch (e) { toast(plain(e), null, true); }
    T.busy.delete(key); schedule();
  }
  const reminder = (data) => call('saveReminder')(data);
  const snoozeQuote = (id, days) => call('snoozeQuote')({ id, days });
  function snoozeChoices(c) {
    const today = M.dateKey(Date.now()), row = el('div', 'td-snooze'); row.append(el('span', 'td-snooze-l', 'Snooze until'));
    const pick = (label, n) => btn(label, 'btn-ghost', () => { T.snoozeFor = null;
      if (c.kind === 'quote') act('q' + c.quoteId, () => snoozeQuote(c.quoteId, n), `${c.ref || 'Quote'} snoozed. It comes back ${n === 1 ? 'tomorrow' : 'in ' + n + ' days'}.`, () => snoozeQuote(c.quoteId, 0));
      else { const was = { dueDate: c.dueDate, dueTime: c.dueTime }; act('r' + c.reminderId, () => reminder({ action: 'snooze', id: c.reminderId, dueDate: M.addDaysKey(today, n) }), 'Reminder moved.', () => reminder({ action: 'snooze', id: c.reminderId, dueDate: was.dueDate < today ? today : was.dueDate, ...(was.dueTime ? { dueTime: was.dueTime } : {}) })); } }, null);
    row.append(pick('Tomorrow', 1), pick('3 days', 3), pick(c.kind === 'quote' ? 'A week' : 'Next week', 7));
    if (c.kind === 'reminder') row.append(btn('Pick a day…', 'btn-ghost', () => { T.snoozeFor = null; openReminder({ id: c.reminderId, title: c.title }); }, null));
    return row;
  }
  function actionsOf(c) {
    const row = el('div', 'td-actions'), open = target(c);
    if (c.kind === 'customer') {
      row.append(btn('Open chat', 'btn-primary', open, null));
      const bk = c.reasons.find((r) => r.type === 'booking');
      if (bk) { const b = btn('Book visit', 'btn-ghost', () => window.APPT && APPT.openBook && APPT.openBook(c.phone, bk.bookOn, bk.bookAt), null); b.disabled = !window.APPT; row.append(b,
        btn('Not needed', 'btn-link', () => act('n' + c.phone, () => call('aiDismissConsult')({ phone: c.phone }), 'Cleared. Nothing was sent.'), 'n' + c.phone)); }
    } else if (c.kind === 'notice') {
      if (c.next === 'resolve') {
        const done = (text) => toast(text), say = (outcome) => () => window.APPT && APPT.resolveNotice(c.appt, outcome, done);
        row.append(btn('Open chat', 'btn-primary', open, null), btn('It arrived', 'btn-ghost', say('arrived'), 'n' + c.apptId), btn('It did not arrive', 'btn-ghost', say('notArrived'), 'n' + c.apptId));
      } else row.append(btn('Open chat', 'btn-primary', open, null));              // WhatsApp refused the reminder: message the customer yourself
    } else if (c.kind === 'quote') {
      row.append(btn('Open quote', 'btn-primary', open, null), btn('Followed up', 'btn-ghost', () => act('q' + c.quoteId, () => snoozeQuote(c.quoteId, 5), `${c.ref || 'Quote'}: followed up. It comes back in 5 days if there is no answer.`, () => snoozeQuote(c.quoteId, 0)), 'q' + c.quoteId),
        btn('Snooze', 'btn-ghost', () => { T.snoozeFor = T.snoozeFor === c.key ? null : c.key; schedule(); }, null));
    } else if (c.kind === 'reminder') {
      row.append(btn('Done', 'btn-primary', () => act('r' + c.reminderId, () => reminder({ action: 'done', id: c.reminderId }), 'Reminder done.', () => reminder({ action: 'undo', id: c.reminderId })), 'r' + c.reminderId),
        btn('Snooze', 'btn-ghost', () => { T.snoozeFor = T.snoozeFor === c.key ? null : c.key; schedule(); }, null));
      if (c.phone) row.append(btn('Open chat', 'btn-ghost', open, null));
      row.append(btn('Delete', 'btn-link', () => { if (window.confirm('Delete this reminder?')) act('r' + c.reminderId, () => reminder({ action: 'delete', id: c.reminderId }), 'Reminder deleted.'); }, 'r' + c.reminderId));
    } else if (c.kind === 'lead') {
      row.append(btn('Add as customer', 'btn-primary', open, null), btn('Dismiss', 'btn-ghost', () => { const p = window.ATTN && ATTN.dismissLead(c.lead); if (p) act('l' + c.leadId, () => p, 'Lead dismissed.'); }, 'l' + c.leadId));
    }
    return row;
  }
  function cardNode(c, now) {
    const card = el('article', 'td-card u' + c.urgency); card.dataset.key = c.key; card.dataset.kind = c.kind;
    const open = target(c), main = el(open ? 'button' : 'div', 'td-open'); if (open) { main.type = 'button'; main.onclick = open; }
    const top = el('div', 'td-top'), title = c.kind === 'reminder' ? c.title : nameOf(c);
    top.append(el('span', 'td-dot'), el('strong', 'td-name', title));
    const tags = el('span', 'td-tags'); for (const t of new Set(c.reasons.map((r) => r.type))) tags.append(el('span', 'td-tag t-' + t, UTYPE[t])); top.append(tags);
    main.append(top);
    if (c.kind === 'reminder' && c.name) main.append(el('div', 'td-meta', 'About ' + c.name));
    if (c.kind === 'quote') main.append(el('div', 'td-meta', [c.ref ? 'Quote ' + c.ref : '', c.name, c.price ? '€' + Number(c.price).toLocaleString('en-IE') : ''].filter(Boolean).join(' · ')));
    if (c.kind === 'lead') main.append(el('div', 'td-meta', ['Number as typed: ' + (c.phoneTyped || 'none'), c.email, c.location].filter(Boolean).join(' · ')));
    for (const r of c.reasons) main.append(reasonLine(c, r, now));
    if (c.kind === 'customer') { if (c.facts) main.append(el('div', 'td-meta', c.facts)); if (c.last && c.last.text) main.append(el('div', 'td-meta td-last', (c.last.mine ? 'You: ' : 'Customer: ') + c.last.text)); }
    card.append(main, actionsOf(c));
    if (T.snoozeFor === c.key) card.append(snoozeChoices(c));
    return card;
  }
  function leadRow(l) {
    const open = l.phone ? () => go('#c/' + l.phone) : () => window.ATTN && ATTN.addLead(l.lead);
    const b = el('button', 'td-lead s-' + l.status); b.type = 'button'; b.onclick = open; b.dataset.status = l.status; if (l.phone) b.dataset.phone = l.phone;
    const top = el('div', 'td-top'); top.append(el('strong', 'td-name', l.name || (l.phone ? formatPhone(l.phone) : 'Lead')), el('span', 'td-status st-' + l.status, M.STATUS_LABEL[l.status]));
    b.append(top, el('div', 'td-reason', l.text), el('div', 'td-meta', [l.at ? hhmm(l.at) : '', l.source, l.facts].filter(Boolean).join(' · ')));
    return b;
  }
  const VTYPE = { consultation: "", site_visit: "Site visit", installation: "Installation", other: "Other" };
  function upRow(v, now) {
    const key = M.dateKey(v.start), today = M.dateKey(now), word = key === today ? 'Today' : key === M.addDaysKey(today, 1) ? 'Tomorrow' : new Intl.DateTimeFormat('en-IE', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(v.start));
    const b = el('button', 'td-up'); b.type = 'button'; b.dataset.id = v.id; b.setAttribute('aria-label', `${word} at ${hhmm(v.start)}: ${v.name || 'visit'}. Open the details`);
    const when = el('span', 'td-up-when'); when.append(el('strong', null, word), el('span', null, hhmm(v.start)));
    const who = el('span', 'td-up-who'); who.append(el('strong', 'td-up-name', v.name || formatPhone(v.phone)), el('span', 'td-up-loc', [v.location, VTYPE[v.type]].filter(Boolean).join(' · ') || ' '));
    b.append(when, who); b.onclick = () => { if (window.APPT && APPT.openDetail) APPT.openDetail(v.appt); };
    return b;
  }
  function render() {
    const r = compute(); badges(r);
    if (!T.active) return;
    const now = Date.now(), ready = loaded();
    $('today-sub').textContent = new Intl.DateTimeFormat('en-IE', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(now));
    // system problems (Phase 10)
    const problems = window.ATTN && ATTN.problemCount ? ATTN.problemCount() : T.issues, h = $('today-health'); h.replaceChildren();
    if (problems) { const b = el('button', 'td-bad', problems === 1 ? '1 system problem needs attention. See what to do' : problems + ' system problems need attention. See what to do'); b.type = 'button'; b.onclick = () => ATTN.open(); h.append(b); }
    else h.append(el('span', 'td-ok', ready ? 'All systems clear' : 'Loading…'));
    if (T.error) h.append(el('div', 'td-err', T.error));
    // the counters: each one filters the list below
    const counts = $('today-counts'); counts.replaceChildren();
    for (const t of M.TYPES) {
      const b = el('button', 'td-count' + (r.red[t] ? ' red' : '') + (r.counts[t] ? '' : ' zero')); b.type = 'button'; b.dataset.type = t; b.setAttribute('aria-pressed', String(T.filter === t));
      b.setAttribute('aria-label', `${M.LABEL[t]}: ${r.counts[t]}${r.red[t] ? ', ' + r.red[t] + ' overdue' : ''}. ${T.filter === t ? 'Showing only these. Press to show everything.' : 'Press to show only these.'}`);
      b.append(el('span', 'td-count-n', String(r.counts[t])), el('span', 'td-count-l', M.LABEL[t])); b.onclick = () => { T.filter = T.filter === t ? null : t; schedule(); }; counts.append(b);
    }
    // the Upcoming visits panel (right-hand column): the next 10 visits, soonest first; each one opens its details
    const up = $('today-upcoming'); up.replaceChildren();
    if (!ready) up.append(el('p', 'td-empty', 'Loading…')); else if (!r.upcoming.length) up.append(el('p', 'td-empty', 'No visits booked.')); else up.append(...r.upcoming.map((v) => upRow(v, now)));
    // the list
    const shown = M.filterCards(r.cards, T.filter), list = $('today-list'), keep = $('today-scroll').scrollTop;
    list.replaceChildren(...shown.map((c) => cardNode(c, now))); $('today-scroll').scrollTop = keep;
    $('today-todo-n').textContent = shown.length ? '(' + shown.length + (T.filter ? ' of ' + r.cards.length : '') + ')' : '';
    const empty = $('today-empty'); empty.hidden = !ready || shown.length > 0;
    empty.textContent = T.filter ? `Nothing in "${M.LABEL[T.filter]}" right now. Press the number again to see everything.` : 'Nothing waiting. Well done.';
    // new leads today: separate from the list above
    const nl = r.newLeads;
    $('today-leads-n').textContent = nl.total ? '(' + nl.total + ')' : ''; $('today-leads-empty').hidden = !ready || nl.total > 0;
    const chips = $('today-lead-chips'); chips.replaceChildren();
    if (nl.total) for (const s of ['failed', 'needs', 'ai', 'contacted']) chips.append(el('span', 'td-status st-' + s + (nl.counts[s] ? '' : ' zero'), `${M.STATUS_LABEL[s]} ${nl.counts[s]}`));
    $('today-leads').replaceChildren(...nl.items.map(leadRow));
    // coming up, and done today (with Undo)
    const lt = $('today-later'); lt.hidden = !r.later.length; $('today-later-n').textContent = r.later.length ? '(' + r.later.length + ')' : ''; $('today-later-list').replaceChildren(...r.later.map((c) => cardNode(c, now)));
    const dn = $('today-done'); dn.hidden = !r.doneToday.length; $('today-done-n').textContent = r.doneToday.length ? '(' + r.doneToday.length + ')' : '';
    $('today-done-list').replaceChildren(...r.doneToday.map((d) => { const row = el('div', 'td-done'); row.append(el('span', 'td-done-t', d.title + ' · ' + hhmm(d.at)),
      btn('Undo', 'btn-ghost', () => act('u' + d.id, () => (d.kind === 'quote' ? snoozeQuote(d.id, 0) : reminder({ action: 'undo', id: d.id })), 'Back on your list.'), 'u' + d.id)); return row; }));
  }
  function toast(text, undo, error) {
    const t = $('today-toast'); clearTimeout(T.toastTimer); t.replaceChildren(); t.hidden = !text; t.className = 'toast q-toast' + (error ? ' err' : '');
    if (!text) return; t.append(document.createTextNode(text + ' '));
    if (undo) { const u = el('button', 'linkbtn', 'Undo'); u.type = 'button'; u.onclick = () => { toast(''); act('undo', undo, 'Undone.'); }; t.append(u); }
    if (!error) T.toastTimer = setTimeout(() => { t.hidden = true; }, 9000);
  }

  // ---------- reminders ----------
  const dlg = () => $('rem-dlg');
  function openReminder(opts) {
    const today = M.dateKey(Date.now()), snooze = !!opts.id;
    T.dlg = { id: opts.id || null, phone: opts.phone || null, requestId: rid() };
    $('rem-title').textContent = snooze ? 'Move reminder' : 'Add reminder'; $('rem-go').textContent = snooze ? 'Move reminder' : 'Add reminder';
    $('rem-title-label').hidden = snooze; $('rem-text').required = !snooze; $('rem-text').value = snooze ? opts.title || '' : '';
    $('rem-date').min = today; $('rem-date').value = snooze ? M.addDaysKey(today, 1) : today; $('rem-time').value = '';
    const who = $('rem-who'); who.hidden = !(opts.name || opts.phone) || snooze; who.textContent = opts.name || opts.phone ? 'About ' + (opts.name || formatPhone(opts.phone)) : '';
    $('rem-err').textContent = ''; $('rem-go').disabled = false; showDlg(dlg()); (snooze ? $('rem-date') : $('rem-text')).focus();
  }
  $('rem-cancel').onclick = () => hideDlg(dlg());
  $('rem-form').addEventListener('submit', async (e) => {
    e.preventDefault(); const d = T.dlg; if (!d) return;
    const dueDate = $('rem-date').value, dueTime = $('rem-time').value;
    $('rem-go').disabled = true; $('rem-err').textContent = '';
    try {
      if (d.id) await reminder({ action: 'snooze', id: d.id, dueDate, ...(dueTime ? { dueTime } : {}) });
      else await reminder({ action: 'create', requestId: d.requestId, title: $('rem-text').value, dueDate, ...(dueTime ? { dueTime } : {}), ...(d.phone ? { phone: d.phone } : {}) });     // the same request id on a retry: one reminder
      hideDlg(dlg()); toast(d.id ? 'Reminder moved.' : 'Reminder added.');
    } catch (err) { $('rem-err').textContent = plain(err); $('rem-go').disabled = false; }
  });
  $('today-add').onclick = () => openReminder({});
  $('remind-btn').onclick = () => { const c = S.selected && S.convs.find((x) => x.id === S.selected); openReminder({ phone: S.selected, name: c ? c.name : '' }); };
  $('today-back').onclick = () => { history.replaceState(null, '', location.pathname + location.search); routeFromHash(); };

  return Object.assign(T, { start, stop, handles, show, hide, render, schedule, openReminder });
})();
