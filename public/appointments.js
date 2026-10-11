'use strict';
// Elite Kitchens Lead OS: appointments (Phase 5). The Appointments screen, the Appointments block in the customer profile, and
// the book / reschedule / cancel dialogs. Reads Firestore directly (staff-only rules); every change goes through the appointment
// callables, which also bring the shared Google Calendar in line. Loaded after app.js (shares its helpers).
window.APPT = (() => {
  const LIMIT = 300;
  const TYPES = { consultation: 'Consultation', site_visit: 'Site visit', other: 'Other' };
  const A = {
    active: false, origin: false,
    list: [], loaded: false, hitLimit: false, failed: [], unsub: null, unsubFailed: null, showCancelled: false, menu: null, stale: false,
    customer: null, custList: [], custLoaded: false, unsubCust: null, showPast: false,
    dlg: null,                 // { mode: 'create' | 'update', phone, appt, requestId }
    cancelling: null,
    view: null,                // 'calendar' | 'list' (remembered for the browser session)
    month: null,               // { y, m } shown in the calendar (Dublin)
    selDay: null, expanded: null, pickerDate: null, detailId: null,
    calError: '', calLimited: false, drag: null,
    leadPhone: null, leadInfo: null, unsubLead: null,
    calList: [], calLoaded: false, unsubCal: null, calKey: null,
  };
  const VIEW_KEY = 'ek.apptView';
  function initialView() {
    try { const v = sessionStorage.getItem(VIEW_KEY); if (v === 'calendar' || v === 'list') return v; } catch (e) { /* private mode */ }
    return window.matchMedia('(min-width: 900px)').matches ? 'calendar' : 'list';     // phones start with the list
  }
  const ts = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : null);
  const syncOf = (a) => (a.sync && a.sync.google) || {};
  const nameOf = (a) => a.customerName || formatPhone(a.phone);
  const convOf = (phone) => S.convs.find((c) => c.id === phone) || null;
  const pad = (n) => String(n).padStart(2, '0');
  const DAY = 86400000;

  // ---------- Dublin dates and times ----------
  const dublinDate = (ms) => dayKey(new Date(ms));                                   // YYYY-MM-DD in Europe/Dublin
  const startOfToday = () => CRM.rangeFor('custom', Date.now(), { from: dublinDate(Date.now()) }).from;
  const clock = (ms) => hhmm(new Date(ms));
  function dayHeading(ms) {
    const k = dublinDate(ms), now = Date.now();
    if (k === dublinDate(now)) return 'Today';
    if (k === dublinDate(now + DAY)) return 'Tomorrow';
    const y = (t) => new Date(t).toLocaleDateString('en-IE', { year: 'numeric', timeZone: TZ });
    return new Date(ms).toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short', ...(y(ms) === y(now) ? {} : { year: 'numeric' }), timeZone: TZ });
  }
  const whenPhrase = (ms) => dayHeading(ms).replace(/^(Today|Tomorrow)$/, (m) => m.toLowerCase()) + ' at ' + clock(ms);
  const when = (a) => `${dayHeading(ts(a.start))}, ${clock(ts(a.start))}–${clock(ts(a.end))}`;
  const kindOf = (a) => TYPES[a.type] || 'Appointment';

  // ---------- Google Calendar status ----------
  const FAIL_TEXT = { forbidden: 'the calendar is not shared with Elite OS', not_found: 'the calendar was not found', token: 'Google sign-in failed', auth: 'Google sign-in failed', bad_request: 'Google rejected the event' };
  const failText = (s) => FAIL_TEXT[s.lastError] || 'Google Calendar did not respond';
  function syncBadge(a) {
    const s = syncOf(a), cancelled = a.status === 'cancelled';
    let text, kind;
    if (s.state === 'off') { text = 'Calendar sync off'; kind = 'off'; }
    else if (s.state === 'failed') { text = cancelled ? 'Not removed from Google Calendar' : 'Not in Google Calendar'; kind = 'err'; }
    else if (s.state === 'synced') { text = cancelled ? 'Removed from Google Calendar' : 'In Google Calendar'; kind = 'ok'; }
    else { text = cancelled ? 'Removing from Google Calendar…' : 'Waiting to sync'; kind = 'wait'; }
    const b = el('span', 'sync ' + kind, text);
    b.dataset.sync = s.state || 'pending';
    if (s.state === 'failed') b.title = 'Google Calendar: ' + failText(s);
    return b;
  }
  // "Retry now" when Google never caught up; "Open in Google Calendar" once the event exists.
  function syncActions(a) {
    const s = syncOf(a), out = [];
    if (s.state === 'failed') {
      const b = el('button', 'linkbtn sync-retry', 'Retry now'); b.type = 'button';
      b.onclick = (e) => { e.stopPropagation(); retry(a, b); };
      out.push(b);
    } else if (s.state === 'synced' && a.status !== 'cancelled' && s.htmlLink) {
      const l = el('a', 'sync-open', 'Open in Google Calendar'); l.href = s.htmlLink; l.target = '_blank'; l.rel = 'noopener';
      out.push(l);
    }
    return out;
  }
  function calendarSentence(c, action) {
    if (!c) return '';
    if (c.state === 'synced') return { added: 'Added to Google Calendar.', updated: 'Google Calendar updated.', removed: 'Removed from Google Calendar.' }[action];
    if (c.state === 'off') return 'Google Calendar sync is off.';
    if (c.state === 'failed') return 'Google Calendar could not be updated: use Retry now.';
    return 'Google Calendar will update shortly.';
  }

  // ---------- data ----------
  // One listener for the view on screen: the list reads upcoming appointments; the calendar reads the month it shows (a plain range
  // on `start`, so no extra index). A failed listener is dead, so it is cleared and the next show() can try again.
  function listen() {
    if ($('app').hidden) return;                   // not before sign-in has finished: reading needs the staff claim (routing calls show() again then)
    if (!A.unsubFailed) {
      A.unsubFailed = db.collection('appointments').where('sync.google.state', '==', 'failed').limit(50).onSnapshot((snap) => {
        A.failed = snap.docs.map((d) => ({ id: d.id, ...d.data() })); render();
      }, () => { if (A.unsubFailed) { A.unsubFailed(); A.unsubFailed = null; } });
    }
    if (A.view === 'list') { stopCal(); startList(); } else { stopList(); startCal(); }
  }
  function startList() {
    if (A.unsub) return;
    const from = firebase.firestore.Timestamp.fromMillis(startOfToday());
    A.unsub = db.collection('appointments').where('start', '>=', from).orderBy('start').limit(LIMIT).onSnapshot((snap) => {
      A.list = snap.docs.map((d) => ({ id: d.id, ...d.data() })); A.loaded = true; A.hitLimit = snap.size >= LIMIT;
      render();
    }, (e) => { stopList(); note('Cannot load appointments: ' + errText(e)); });
  }
  function stopList() { if (A.unsub) { A.unsub(); A.unsub = null; } A.list = []; A.loaded = false; A.hitLimit = false; }
  function startCal() {
    const r = monthRange(A.month), key = r.from + '-' + r.to;
    if (A.unsubCal && A.calKey === key) return;
    stopCal(); A.calKey = key;
    const T = firebase.firestore.Timestamp;
    A.unsubCal = db.collection('appointments').where('start', '>=', T.fromMillis(r.from)).where('start', '<', T.fromMillis(r.to)).orderBy('start').limit(500).onSnapshot((snap) => {
      if (A.calKey !== key) return;
      A.calList = snap.docs.map((d) => ({ id: d.id, ...d.data() })); A.calLoaded = true;
      A.calLimited = snap.size >= 500; A.calError = '';
      render();
    }, (e) => { if (A.calKey !== key) return; stopCal(); A.calError = 'Cannot load the calendar: ' + errText(e); render(); });
  }
  function stopCal() { if (A.unsubCal) { A.unsubCal(); A.unsubCal = null; } A.calKey = null; A.calList = []; A.calLoaded = false; A.calError = ''; A.calLimited = false; }
  function unlisten() {
    stopList(); stopCal();
    if (A.unsubFailed) { A.unsubFailed(); A.unsubFailed = null; }
    A.failed = [];
  }

  // ---------- month grid (pure date arithmetic on Dublin calendar dates) ----------
  const keyOf = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);       // overflows correctly (d = 0, 32, ...)
  const thisMonth = () => { const [y, m] = dublinDate(Date.now()).split('-').map(Number); return { y, m }; };
  const addMonths = (mo, n) => { const t = new Date(Date.UTC(mo.y, mo.m - 1 + n, 1)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1 }; };
  const monthTitle = (mo) => new Date(Date.UTC(mo.y, mo.m - 1, 15)).toLocaleDateString('en-IE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const sameMonth = (k, mo) => k.slice(0, 7) === `${mo.y}-${pad(mo.m)}`;
  function monthCells(mo) {               // whole weeks, Monday first, covering the month
    const lead = (new Date(Date.UTC(mo.y, mo.m - 1, 1)).getUTCDay() + 6) % 7;
    const days = new Date(Date.UTC(mo.y, mo.m, 0)).getUTCDate();
    const cells = [];
    for (let i = 0; i < Math.ceil((lead + days) / 7) * 7; i++) cells.push(keyOf(mo.y, mo.m, 1 - lead + i));
    return cells;
  }
  function monthRange(mo) { const c = monthCells(mo); return CRM.rangeFor('custom', Date.now(), { from: c[0], to: c[c.length - 1] }); }
  const longDay = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }); };

  // ---------- show / hide ----------
  function setNav(on) {
    const n = $('nav-appointments');
    n.classList.toggle('active', on);
    if (on) {
      n.setAttribute('aria-current', 'page');
      for (const id of ['nav-inbox', 'nav-pipeline']) { $(id).classList.remove('active'); $(id).removeAttribute('aria-current'); }
    } else {
      n.removeAttribute('aria-current');
      $('nav-inbox').classList.add('active'); $('nav-inbox').setAttribute('aria-current', 'page');
    }
  }
  function show() {
    if (!A.view) A.view = initialView();
    if (!A.month) { A.month = thisMonth(); A.selDay = dublinDate(Date.now()); }
    A.active = true; setNav(true); listen(); setView();
    document.title = 'Appointments · Elite Kitchens';
    render();
  }
  function hide() { A.active = false; watchAgendaLead(null); endDrag(); closeMenu(); closeDialog($('appt-detail-dlg')); A.detailId = null; setNav(false); unlisten(); }
  function stop() {                       // sign-out: forget everything
    hide(); A.origin = false; watchCustomer(null);
    A.showCancelled = false; $('appts-show-cancelled').checked = false;
    closeDialog($('appt-dlg')); closeDialog($('appt-cancel-dlg')); A.dlg = null; A.cancelling = null;
    closeDialog($('appt-customer-dlg')); A.pickerDate = null; A.expanded = null;
    A.month = null; A.selDay = null;
    $('appts-list').replaceChildren(); $('cal-grid').replaceChildren(); $('cal-day').replaceChildren(); note('');
  }
  function setMode(v) {
    if (v !== 'calendar' && v !== 'list') return;
    endDrag();
    A.view = v;
    if (v !== 'calendar') watchAgendaLead(null);
    try { sessionStorage.setItem(VIEW_KEY, v); } catch (e) { /* private mode */ }
    closeMenu(); listen(); render();
  }
  function goMonth(mo) {
    A.month = mo;
    const today = dublinDate(Date.now());
    A.selDay = sameMonth(today, mo) ? today : keyOf(mo.y, mo.m, 1);
    closeMenu(); listen(); render();
  }
  function selectDay(k, revealId, focusDay = false) {
    A.selDay = k; A.expanded = revealId || null;
    if (!sameMonth(k, A.month)) {
      const [y, m] = k.split('-').map(Number); A.month = { y, m }; listen();
    }
    closeMenu(); render();
    if (focusDay) document.querySelector(`.cal-cell[data-day="${k}"] .cal-select`)?.focus({ preventScroll: true });
    if (revealId) {
      const item = [...$('cal-day').querySelectorAll('.agenda-entry')].find(n => n.dataset.id === revealId);
      item?.querySelector('summary').focus({ preventScroll: true });
      item?.scrollIntoView({ block: 'nearest' });
    }
  }
  function stepDay(n) {
    const [y, m, d] = A.selDay.split('-').map(Number); selectDay(keyOf(y, m, d + n));
  }

  // ---------- the Appointments screen ----------
  function note(text) { const t = $('appts-toast'); t.textContent = text; t.hidden = !text; clearTimeout(note.h); if (text) note.h = setTimeout(() => { t.hidden = true; }, 8000); }
  function render() {
    if (!A.active) return;
    if (A.menu || A.drag) { A.stale = true; return; }               // preserve an open menu or the native drag source
    const f = $('appts-failed'), nFailed = A.failed.length;
    f.hidden = !nFailed;
    if (nFailed) {
      const b = el('button', 'linkbtn', 'Retry all'); b.type = 'button'; b.onclick = () => retryAll(b);
      f.replaceChildren(el('span', null, (nFailed === 1 ? '1 appointment is' : nFailed + ' appointments are') + ' not up to date in Google Calendar (' + failText(syncOf(A.failed[0])) + ').'), b);
    }
    for (const b of $('appts-view').querySelectorAll('button[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === A.view));
    $('appts-cal').hidden = A.view !== 'calendar';
    $('appts-list').hidden = A.view !== 'list';
    if (A.view === 'calendar') renderCalendar(); else renderList();
  }
  function renderList() {
    const list = $('appts-list');
    if (!A.loaded) { list.replaceChildren(el('p', 'appts-empty', 'Loading appointments…')); return; }
    const shown = A.list.filter((a) => A.showCancelled || a.status !== 'cancelled');
    if (!shown.length) {
      list.replaceChildren(el('p', 'appts-empty', A.list.length ? 'No upcoming appointments. Cancelled ones are hidden.' : 'No upcoming appointments. Book one from a customer\'s profile.'));
      return;
    }
    const groups = new Map();
    for (const a of shown) { const k = dublinDate(ts(a.start)); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(a); }
    const out = [];
    for (const items of groups.values()) {
      const label = dayHeading(ts(items[0].start));
      const h = el('h2', 'appts-day', label); h.append(el('span', 'n', String(items.length)));
      const body = el('div', 'appts-group'); body.setAttribute('role', 'list'); body.setAttribute('aria-label', label);
      body.append(...items.map(rowNode));
      out.push(h, body);
    }
    if (A.hitLimit) out.push(el('p', 'appts-note', 'Showing the next ' + LIMIT + ' appointments.'));
    list.replaceChildren(...out);
  }
  function rowNode(a) {
    const cancelled = a.status === 'cancelled', name = nameOf(a);
    const row = el('div', 'arow' + (cancelled ? ' cancelled' : ''));
    row.setAttribute('role', 'listitem'); row.dataset.id = a.id; row.dataset.phone = a.phone;
    const time = el('div', 'arow-time', clock(ts(a.start))); time.append(el('span', null, clock(ts(a.end))));
    const main = el('div', 'arow-main');
    const top = el('div', 'arow-top');
    const who = el('button', 'arow-name', name); who.type = 'button'; who.setAttribute('aria-label', 'Open ' + name);
    who.onclick = () => openCustomer(a);
    top.append(who);
    const c = convOf(a.phone);
    if (c) { const st = inboxStatus(c), s = el('span', 'arow-stage', INBOX_STATUSES[st]); s.dataset.status = st; top.append(s); }
    if (cancelled) top.append(el('span', 'chip-cancelled', 'Cancelled'));
    main.append(top, el('div', 'arow-sub', [kindOf(a), a.location].filter(Boolean).join(' · ')));
    const meta = el('div', 'arow-meta'); meta.append(syncBadge(a), ...syncActions(a));
    main.append(meta);
    const btn = el('button', 'arow-menu');
    btn.type = 'button'; btn.setAttribute('aria-label', 'Actions for the appointment with ' + name); btn.setAttribute('aria-haspopup', 'menu'); btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>';
    btn.onclick = (e) => { e.stopPropagation(); openMenu(a, btn); };
    row.append(time, main, btn);
    return row;
  }
  function openCustomer(a) {
    A.origin = true;                                   // so Back on a phone returns here
    if (window.PIPE) PIPE.origin = false;
    const c = convOf(a.phone); if (c) S.statusFilter = inboxStatus(c);
    location.hash = '#c/' + a.phone;
  }

  // ---------- the calendar (month view) ----------
  const MAX_CHIPS = 3;
  const stageOf = (a) => { const c = convOf(a.phone); return c ? inboxStatus(c) : null; };
  function renderCalendar() {
    const focused = document.activeElement?.dataset.focus;
    $('cal-title').textContent = monthTitle(A.month);
    const today = dublinDate(Date.now());
    $('cal-today').disabled = false;
    const byDay = new Map();
    for (const a of A.calList) {
      if (!A.showCancelled && a.status === 'cancelled') continue;          // cancelled ones stay out of the way unless asked for
      const k = dublinDate(ts(a.start));
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(a);
    }
    const nodes = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => el('div', 'cal-dow', d));
    for (const k of monthCells(A.month)) {
      const items = byDay.get(k) || [];
      const cell = el('div', 'cal-cell' + (sameMonth(k, A.month) ? '' : ' out') + (k === today ? ' today' : '') + (k === A.selDay ? ' sel' : ''));
      cell.dataset.day = k; cell.setAttribute('role', 'group');
      cell.setAttribute('aria-label', longDay(k) + (items.length ? ', ' + items.length + ' appointment' + (items.length === 1 ? '' : 's') : ''));
      if (k === today) cell.setAttribute('aria-current', 'date');
      const pick = el('button', 'cal-select', String(Number(k.slice(8)))); pick.type = 'button';
      pick.dataset.focus = 'day-' + k; pick.tabIndex = k === A.selDay ? 0 : -1;
      pick.setAttribute('aria-label', longDay(k) + ', ' + items.length + ' appointments');
      pick.setAttribute('aria-pressed', String(k === A.selDay));
      if (k === today) pick.setAttribute('aria-current', 'date');
      pick.onclick = e => { e.stopPropagation(); selectDay(k, null, true); };
      pick.onkeydown = e => {
        const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
        if (!Object.hasOwn(offsets, e.key)) return;
        e.preventDefault(); const [y, m, d] = k.split('-').map(Number); selectDay(keyOf(y, m, d + offsets[e.key]), null, true);
      };
      cell.append(pick);
      items.slice(0, MAX_CHIPS).forEach((a) => cell.append(chipNode(a)));
      if (items.length > MAX_CHIPS) {
        const more = el('button', 'cal-more', '+' + (items.length - MAX_CHIPS) + ' more'); more.type = 'button';
        more.setAttribute('aria-label', 'Show all ' + items.length + ' appointments on ' + longDay(k));
        more.onclick = (e) => { e.stopPropagation(); selectDay(k, items[0].id); };
        cell.append(more);
      }
      if (items.length) {                  // on a phone the day shows dots instead of names
        const dots = el('div', 'cal-dots'); dots.setAttribute('aria-hidden', 'true');
        items.slice(0, 4).forEach((a) => { const d = el('span', 'cal-dot'); const st = stageOf(a); if (st) d.dataset.status = st; dots.append(d); });
        cell.append(dots);
      }
      cell.onclick = () => selectDay(k, null, true);
      nodes.push(cell);
    }
    $('cal-grid').replaceChildren(...nodes);
    $('cal-status').textContent = A.calError ? 'Calendar unavailable' : A.calLoaded ? 'Irish time' : 'Loading appointments…';
    const sel = (A.selDay && byDay.get(A.selDay)) || [];
    renderDay(sel);
    if (A.detailId) {
      const a = A.calList.find(a => a.id === A.detailId);
      if (a) renderDetail(a); else if (A.calLoaded || A.calError) { closeDialog($('appt-detail-dlg')); A.detailId = null; }
    }
    const focusRoot = A.detailId ? $('appt-detail-dlg') : $('cal-day');
    if (focused) [...focusRoot.querySelectorAll('[data-focus]'), ...$('cal-grid').querySelectorAll('[data-focus]')].find(n => n.dataset.focus === focused)?.focus({ preventScroll: true });
    syncAgendaLead();
  }
  const button = (text, cls, fn) => { const b = el('button', cls, text); b.type = 'button'; b.onclick = fn; return b; };
  function renderDay(items) {
    const day = $('cal-day'), head = el('div', 'agenda-head'), nav = el('div', 'agenda-nav');
    const h = el('h2', null, longDay(A.selDay)); h.id = 'agenda-title'; h.setAttribute('aria-live', 'polite');
    const prev = button('Previous day', 'btn btn-ghost btn-sm', () => stepDay(-1)); prev.dataset.focus = 'day-prev';
    const next = button('Next day', 'btn btn-ghost btn-sm', () => stepDay(1)); next.dataset.focus = 'day-next';
    nav.append(prev, next);
    head.append(h, el('p', 'agenda-count', A.calLoaded ? items.length + (items.length === 1 ? ' appointment' : ' appointments') : ''));
    const book = button('Book appointment', 'btn btn-primary', () => openPicker(A.selDay)); book.dataset.focus = 'day-book';
    const past = A.selDay < dublinDate(Date.now()); book.disabled = past;
    const body = el('div', 'agenda-list');
    if (A.calError) {
      body.append(el('p', 'agenda-message', A.calError), button('Try again', 'btn btn-ghost', () => { listen(); render(); }));
    } else if (!A.calLoaded) body.append(el('p', 'agenda-message', 'Loading appointments…'));
    else if (!items.length) body.append(el('p', 'agenda-message', A.calLimited ? 'The calendar result limit was reached. This day may be incomplete.' : 'No appointments booked for this day.'));
    else body.append(...items.map(agendaEntry));
    if (A.calLimited && items.length) body.append(el('p', 'agenda-message', 'Showing the first 500 appointments in this calendar range. This day may be incomplete.'));
    day.replaceChildren(head, nav, book, body);
    if (past) day.append(el('p', 'hint', 'Past appointments are shown for reference. Choose today or a future date to book.'));
  }
  function appointmentDetails(a) {
    const body = el('div', 'agenda-details');
    const lead = el('dl', 'agenda-lead'); lead.dataset.phone = a.phone;
    fillLeadFacts(lead); body.append(lead);
    if (a.notes) { const notes = el('div', 'agenda-notes'); notes.append(el('strong', null, 'Internal notes'), el('p', null, a.notes)); body.append(notes); }
    const sync = el('div', 'arow-meta'); sync.append(syncBadge(a), ...syncActions(a)); body.append(sync);
    const actions = el('div', 'agenda-actions');
    const act = (label, fn, cls = '') => {
      const b = button(label, 'btn btn-ghost btn-sm ' + cls, () => { closeDialog($('appt-detail-dlg')); A.detailId = null; fn(); });
      b.dataset.focus = a.id + '-' + label; return b;
    };
    if (a.status !== 'cancelled') {
      actions.append(act('Edit appointment', () => openReschedule(a, 'a-type')), act('Reschedule', () => openReschedule(a)));
    }
    actions.append(act('Open customer', () => openCustomer(a)));
    if (a.status !== 'cancelled') actions.append(act('Cancel appointment', () => openCancel(a), 'agenda-cancel'));
    body.append(actions); return body;
  }
  function agendaEntry(a) {
    const entry = el('details', 'agenda-entry' + (a.status === 'cancelled' ? ' cancelled' : '')); entry.dataset.id = a.id;
    entry.open = A.expanded === a.id;
    const summary = el('summary'); summary.dataset.focus = 'appt-' + a.id;
    dragSource(summary, a);
    const time = el('span', 'agenda-time', clock(ts(a.start)) + '–' + clock(ts(a.end)));
    summary.append(time, el('strong', 'agenda-name', nameOf(a)), el('span', 'agenda-kind', kindOf(a) + (a.status === 'cancelled' ? ' · Cancelled' : '')), el('span', 'agenda-place', a.location || 'No location added'));
    summary.onclick = e => {
      if (window.matchMedia('(max-width: 899px)').matches) {
        e.preventDefault(); A.detailId = a.id; renderDetail(a); showDialog($('appt-detail-dlg')); $('appt-detail-close').focus();
      } else {
        A.expanded = entry.open ? null : a.id;
        for (const other of $('cal-day').querySelectorAll('details')) if (other !== entry) other.open = false;
      }
      syncAgendaLead();
    };
    entry.append(summary, appointmentDetails(a)); return entry;
  }
  function renderDetail(a) {
    const host = $('appt-detail-content');
    host.replaceChildren(el('h2', null, nameOf(a)), el('p', 'agenda-time', when(a)), el('p', 'agenda-kind', kindOf(a) + (a.status === 'cancelled' ? ' · Cancelled' : '')), appointmentDetails(a));
  }
  // Read the lead linked to the open appointment, never the last customer opened in the inbox.
  // One live listener keeps saved address/budget current without changing appointment or Google data.
  function fillLeadFacts(host) {
    const info = host.dataset.phone === A.leadPhone ? A.leadInfo : null;
    const missing = !info?.loaded ? 'Loading…' : info.error ? 'Unavailable' : 'Not provided';
    const value = key => typeof info?.data?.[key] === 'string' && info.data[key].trim() ? info.data[key] : missing;
    const address = LeadAddress.resolve(info?.data);
    const addressValue = el('dd', 'agenda-lead-address', address.value || (address.conflict ? 'Check address in customer notes' : missing));
    if (address.source === 'notes') addressValue.append(el('span', 'agenda-lead-source', 'From customer notes'));
    host.replaceChildren(el('dt', null, 'Address'), addressValue, el('dt', null, 'Budget'), el('dd', 'agenda-lead-budget', value('budget')));
    if (info?.error) {
      const retry = button('Retry customer details', 'linkbtn', () => { const phone = A.leadPhone; watchAgendaLead(null); watchAgendaLead(phone); });
      const message = el('dd', 'agenda-lead-error'); message.append(retry); host.append(message);
    }
  }
  function syncAgendaLead() {
    const id = A.detailId || (window.matchMedia('(min-width: 900px)').matches ? A.expanded : null);
    const a = A.active && A.view === 'calendar' && A.calList.find(a => a.id === id && (A.showCancelled || a.status !== 'cancelled') && (A.detailId || dublinDate(ts(a.start)) === A.selDay));
    watchAgendaLead(a ? a.phone : null);
  }
  function watchAgendaLead(phone) {
    if (A.leadPhone === phone) return;
    if (A.unsubLead) A.unsubLead();
    A.unsubLead = null; A.leadPhone = phone; A.leadInfo = null;
    const refresh = () => { for (const host of document.querySelectorAll('.agenda-lead')) fillLeadFacts(host); };
    refresh();
    if (!phone) return;
    // Identity token also rejects a late callback after switching A -> B -> A.
    const request = {}; A.leadInfo = request;
    A.unsubLead = db.collection('contacts').doc(phone).onSnapshot(doc => {
      if (A.leadPhone !== phone || A.leadInfo !== request) return;
      const data = doc.exists ? doc.data() : {};
      request.data = { address: data.address, notes: data.notes, budget: data.budget }; request.loaded = true; request.error = false; refresh();
    }, () => {
      if (A.leadPhone !== phone || A.leadInfo !== request) return;
      request.data = {}; request.loaded = true; request.error = true; refresh();
    });
  }
  function chipNode(a) {
    const st = stageOf(a), cancelled = a.status === 'cancelled', failed = syncOf(a).state === 'failed';
    const b = el('button', 'cal-ev' + (cancelled ? ' cancelled' : '') + (failed ? ' sync-failed' : ''));
    b.type = 'button'; b.dataset.id = a.id; b.dataset.phone = a.phone; if (st) b.dataset.status = st;
    b.append(el('span', 'cal-ev-time', clock(ts(a.start))), el('span', 'cal-ev-name', nameOf(a)));
    b.setAttribute('aria-label', `${clock(ts(a.start))} ${nameOf(a)}, ${kindOf(a)}${cancelled ? ', cancelled' : ''}${failed ? ', not in Google Calendar' : ''}. Show details`);
    b.setAttribute('aria-controls', 'cal-day');
    dragSource(b, a);
    b.onclick = (e) => { e.stopPropagation(); selectDay(dublinDate(ts(a.start)), a.id); };
    return b;
  }
  // Desktop drag is a shortcut into the existing, version-checked reschedule form.
  // There is no optimistic move or write until the user confirms the proposed date.
  function dragSource(node, a) {
    if (a.status === 'cancelled') return;
    node.draggable = true; node.dataset.dragId = a.id;
    node.title = 'Drag to another day to reschedule, or click for details';
  }
  function endDrag() {
    A.drag = null;
    for (const n of $('appts-cal').querySelectorAll('.cal-dragging, .cal-drop-target, .cal-drop-blocked')) n.classList.remove('cal-dragging', 'cal-drop-target', 'cal-drop-blocked');
    if (A.stale && !A.menu) { A.stale = false; render(); }
  }
  function validDrop(k) { return k >= dublinDate(Date.now()) && k <= dublinDate(Date.now() + 730 * DAY); }
  $('appts-cal').addEventListener('dragstart', e => {
    const source = e.target.closest('[data-drag-id]');
    if (!source) return;
    const a = A.calList.find(a => a.id === source.dataset.dragId);
    if (!window.matchMedia('(min-width: 900px) and (any-pointer: fine)').matches || !a || a.status === 'cancelled' || A.dlg || !e.dataTransfer) { e.preventDefault(); return; }
    A.drag = a;
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', a.id);
    source.classList.add('cal-dragging');
  });
  $('cal-grid').addEventListener('dragover', e => {
    if (!A.drag) return;
    const cell = e.target.closest('.cal-cell'); if (!cell) return;
    for (const n of $('cal-grid').querySelectorAll('.cal-drop-target, .cal-drop-blocked')) n.classList.remove('cal-drop-target', 'cal-drop-blocked');
    const allowed = validDrop(cell.dataset.day) && cell.dataset.day !== dublinDate(ts(A.drag.start));
    cell.classList.add(allowed ? 'cal-drop-target' : 'cal-drop-blocked');
    if (allowed) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
  });
  $('cal-grid').addEventListener('dragleave', e => {
    const cell = e.target.closest('.cal-cell');
    if (cell && !cell.contains(e.relatedTarget)) cell.classList.remove('cal-drop-target', 'cal-drop-blocked');
  });
  $('cal-grid').addEventListener('drop', e => {
    const a = A.drag, k = e.target.closest('.cal-cell')?.dataset.day;
    if (!a) return; // external files/text cannot reschedule an appointment
    e.preventDefault(); e.stopPropagation(); endDrag();
    if (!k || !validDrop(k) || k === dublinDate(ts(a.start))) return;
    const latest = A.calList.find(item => item.id === a.id);
    if (!latest || latest.status === 'cancelled' || latest.version !== a.version) {
      note('This appointment changed while you were dragging it. Check its details and try again.'); return;
    }
    openReschedule(a);
    $('a-date').value = k;
    $('appt-title').textContent = 'Reschedule appointment'; $('a-go').textContent = 'Confirm move';
    $('a-move-from').hidden = false; $('a-move-from').textContent = 'Currently ' + longDay(dublinDate(ts(a.start))) + ' at ' + clock(ts(a.start)) + '. Review the new date below.';
  });
  document.addEventListener('dragend', endDrag);
  // ---------- row menu ----------
  function closeMenu(focusBack) {
    const m = A.menu; if (!m) return;
    m.node.remove(); m.btn.setAttribute('aria-expanded', 'false'); A.menu = null;
    if (focusBack && m.btn.isConnected) m.btn.focus();
    if (A.stale) { A.stale = false; render(); }
  }
  function openMenu(a, btn) {
    const was = A.menu && A.menu.btn === btn; closeMenu();
    if (was) return;
    const node = el('div', 'move-menu appt-menu'); node.setAttribute('role', 'menu'); node.setAttribute('aria-label', 'Appointment');
    const item = (label, fn) => { const b = el('button', null, label); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.onclick = () => { closeMenu(true); fn(); }; node.append(b); };
    if (a.status !== 'cancelled') { item('Edit appointment…', () => openReschedule(a, 'a-type')); item('Reschedule…', () => openReschedule(a)); item('Cancel appointment…', () => openCancel(a)); }
    if (syncOf(a).state === 'failed') item('Retry Google Calendar', () => retry(a));
    item('Open customer', () => openCustomer(a));
    document.body.append(node);
    const rc = btn.getBoundingClientRect(), w = node.offsetWidth, h = node.offsetHeight;
    node.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, rc.right - w)) + 'px';
    node.style.top = (rc.bottom + h + 8 > window.innerHeight ? Math.max(8, rc.top - h - 4) : rc.bottom + 4) + 'px';
    btn.setAttribute('aria-expanded', 'true'); A.menu = { node, btn };
    node.querySelector('button').focus();
  }

  // ---------- the customer profile block ----------
  function setCustMsg(text, kind) { const m = $('d-appts-msg'); m.textContent = text || ''; m.className = 'd-msg' + (kind ? ' ' + kind : ''); }
  function watchCustomer(id) {
    if (A.unsubCust) { A.unsubCust(); A.unsubCust = null; }
    A.customer = id || null; A.custList = []; A.custLoaded = false; A.showPast = false; setCustMsg('');
    renderCustomer();
    if (!id) return;
    A.unsubCust = db.collection('appointments').where('phone', '==', id).onSnapshot((snap) => {
      if (A.customer !== id) return;
      A.custList = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((x, y) => ts(x.start) - ts(y.start));
      A.custLoaded = true; renderCustomer();
    }, (e) => { if (A.customer === id) { A.custLoaded = true; renderCustomer(); setCustMsg('Cannot load appointments: ' + errText(e), 'err'); } });
  }
  function renderCustomer() {
    const host = $('d-appts-list');
    $('d-appt-new').disabled = !A.customer;
    if (!A.customer) { host.replaceChildren(); return; }
    if (!A.custLoaded) { host.replaceChildren(el('p', 'd-appts-none', 'Loading…')); return; }
    const now = Date.now();
    const upcoming = A.custList.filter((a) => a.status !== 'cancelled' && ts(a.end) >= now);
    const others = A.custList.filter((a) => !upcoming.includes(a)).reverse();          // most recent first
    const nodes = upcoming.length ? upcoming.map(custNode) : [el('p', 'd-appts-none', 'No upcoming appointments.')];
    if (others.length) {
      const t = el('button', 'linkbtn d-appts-more', (A.showPast ? 'Hide' : 'Show') + ' past and cancelled (' + others.length + ')'); t.type = 'button';
      t.onclick = () => { A.showPast = !A.showPast; renderCustomer(); };
      nodes.push(t);
      if (A.showPast) nodes.push(...others.map(custNode));
    }
    host.replaceChildren(...nodes);
  }
  function custNode(a) {
    const cancelled = a.status === 'cancelled', past = ts(a.end) < Date.now();
    const d = el('div', 'd-appt' + (cancelled ? ' cancelled' : '')); d.dataset.id = a.id;
    d.append(el('div', 'd-appt-when', when(a)), el('div', 'd-appt-sub', [kindOf(a), a.location, cancelled ? 'Cancelled' : null].filter(Boolean).join(' · ')));
    const status = el('div', 'd-appt-actions');                 // Google Calendar status on one line, the actions on the next
    status.append(syncBadge(a), ...syncActions(a));
    d.append(status);
    if (!cancelled && !past) {
      const act = el('div', 'd-appt-actions');
      const r = el('button', 'linkbtn d-appt-reschedule', 'Reschedule'); r.type = 'button'; r.onclick = () => openReschedule(a);
      const c = el('button', 'linkbtn d-appt-cancel', 'Cancel'); c.type = 'button'; c.onclick = () => openCancel(a);
      act.append(r, c);
      d.append(act);
    }
    return d;
  }

  // Tell whoever is looking: the Appointments screen and/or that customer's profile.
  function report(text, phone, kind = 'ok') {
    if (A.active) note(text);
    if (A.customer === phone) setCustMsg(text, kind);
  }

  // ---------- book / reschedule dialog ----------
  const showDialog = (d) => { if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', ''); };
  const closeDialog = (d) => { if (typeof d.close === 'function') { if (d.open) d.close(); } else d.removeAttribute('open'); };
  const newRequestId = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12));
  function openPicker(date) {
    A.pickerDate = date || dublinDate(Date.now());
    $('appt-customer-date').textContent = longDay(A.pickerDate) + ' · Irish time';
    $('appt-customer-search').value = ''; renderCustomers(); showDialog($('appt-customer-dlg')); $('appt-customer-search').focus();
  }
  function renderCustomers() {
    const q = $('appt-customer-search').value.trim().toLowerCase();
    const matches = S.convs.filter(c => !q || matchesQuery(c, q));
    const nodes = matches.slice(0, 20).map(c => {
      const b = button('', 'appt-customer-option', () => {
        const date = A.pickerDate; closeDialog($('appt-customer-dlg')); openBook(c.id, date);
      });
      b.append(el('strong', null, c.name || formatPhone(c.id)), el('span', null, [formatPhone(c.id), c.location, INBOX_STATUSES[inboxStatus(c)]].filter(Boolean).join(' · ')));
      return b;
    });
    if (!nodes.length) nodes.push(el('p', 'hint', q ? 'No matching customers in the loaded inbox. Try their phone number, or book from their customer profile.' : 'No customers loaded yet. Open a customer in the inbox to book from their profile.'));
    if (matches.length > 20) nodes.push(el('p', 'hint', 'Showing 20 customers. Type to narrow the results.'));
    $('appt-customer-results').replaceChildren(...nodes);
  }
  const TIMES = [];
  for (let h = 6; h <= 22; h++) for (const m of [0, 15, 30, 45]) if (h < 22 || m === 0) TIMES.push(pad(h) + ':' + pad(m));
  function fillTimes(value) {
    const sel = $('a-time'), opts = TIMES.includes(value) ? TIMES : [...TIMES, value].sort();
    sel.replaceChildren(...opts.map((t) => new Option(t, t)));
    sel.value = value;
  }
  function fillDuration(min) {
    const sel = $('a-duration');
    if (![...sel.options].some((o) => +o.value === min)) sel.append(new Option(min + ' minutes', String(min)));
    sel.value = String(min);
  }
  function setDateBounds() { $('a-date').min = dublinDate(Date.now()); $('a-date').max = dublinDate(Date.now() + 730 * DAY); }
  function openForm(title, who, go) {
    $('appt-title').textContent = title; $('appt-who').textContent = who;
    $('a-move-from').hidden = true; $('a-move-from').textContent = '';
    $('a-go').textContent = go; $('a-go').disabled = false; $('a-cancel').disabled = false; $('a-err').textContent = '';
    setDateBounds(); showDialog($('appt-dlg')); $('a-date').focus();
  }
  function openBook(phone, date) {
    const c = convOf(phone) || {}, contact = (S.selected === phone && S.contact) || {};
    A.dlg = { mode: 'create', phone, requestId: newRequestId() };          // one id per booking: a double click or retry books it once
    $('a-date').value = date || dublinDate(Date.now() + DAY);
    fillTimes('10:00'); fillDuration(60); $('a-type').value = 'consultation';
    $('a-location').value = contact.location || c.location || ''; $('a-notes').value = '';
    openForm('Book appointment', (contact.name || c.name || formatPhone(phone)) + ' · ' + formatPhone(phone), 'Book appointment');
    if (!$('a-location').value && !(S.selected === phone && S.contact)) {      // the customer's details were still loading: fill the location in when they arrive
      const req = A.dlg;
      db.collection('contacts').doc(phone).get().then((d) => {
        const loc = d.exists && d.data().location;
        if (loc && A.dlg === req && !$('a-location').value) $('a-location').value = loc;
      }).catch(() => {});
    }
  }
  function openReschedule(a, focus = 'a-date') {
    A.dlg = { mode: 'update', phone: a.phone, appt: a };
    $('a-date').value = dublinDate(ts(a.start));
    fillTimes(clock(ts(a.start))); fillDuration(a.durationMin || 60); $('a-type').value = Object.hasOwn(TYPES, a.type) ? a.type : 'consultation';
    $('a-location').value = a.location || ''; $('a-notes').value = a.notes || '';
    openForm('Edit appointment', nameOf(a) + ' · ' + formatPhone(a.phone), 'Save changes');
    // Existing past appointments can have their details corrected without moving their date.
    if ($('a-date').value < $('a-date').min) $('a-date').min = $('a-date').value;
    $(focus).focus();
  }
  function bookedMessage(r, phone) {
    const c = convOf(phone), who = (c && c.name) || 'The customer';
    const stage = r.stage && r.stage.to === 'booked' ? who + ' moved to Booked.' : c ? who + ' stays in ' + INBOX_STATUSES[inboxStatus(c)] + '.' : '';
    return [(r.existing ? 'Already booked for ' : 'Booked for ') + whenPhrase(r.start) + '.', stage, calendarSentence(r.calendar, 'added')].filter(Boolean).join(' ');
  }
  $('appt-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = A.dlg; if (!d || d.saving) return;
    const fields = { date: $('a-date').value, time: $('a-time').value, durationMin: Number($('a-duration').value), type: $('a-type').value, location: $('a-location').value, notes: $('a-notes').value };
    if (!fields.date) { $('a-err').textContent = 'Choose a date.'; return; }
    $('a-err').textContent = ''; $('a-go').disabled = true; $('a-cancel').disabled = true; d.saving = true;
    try {
      if (d.mode === 'create') {
        const r = (await call('createAppointment')({ phone: d.phone, ...fields, requestId: d.requestId })).data;
        if (A.dlg !== d) return;
        closeDialog($('appt-dlg')); A.dlg = null;
        if (A.active && A.view === 'calendar') selectDay(dublinDate(r.start), r.id);
        report(bookedMessage(r, d.phone), d.phone);
      } else {
        const r = (await call('updateAppointment')({ id: d.appt.id, ...fields, expectedVersion: d.appt.version })).data;
        if (A.dlg !== d) return;
        closeDialog($('appt-dlg')); A.dlg = null;
        if (A.active && A.view === 'calendar') selectDay(dublinDate(r.start), d.appt.id);
        const changedTime = r.start !== ts(d.appt.start) || r.end !== ts(d.appt.end);
        report(r.unchanged ? 'No changes to save.' : [changedTime ? 'Rescheduled for ' + whenPhrase(r.start) + '.' : 'Appointment updated.', calendarSentence(r.calendar, 'updated')].join(' '), d.phone);
      }
    } catch (err) { if (A.dlg === d) { $('a-err').textContent = errText(err); $('a-go').disabled = false; $('a-cancel').disabled = false; d.saving = false; } }
  });
  $('a-cancel').onclick = () => { closeDialog($('appt-dlg')); A.dlg = null; };
  $('appt-dlg').addEventListener('cancel', e => { if (A.dlg?.saving) e.preventDefault(); else A.dlg = null; });

  // ---------- cancel dialog ----------
  function openCancel(a) {
    A.cancelling = a;
    $('ac-text').textContent = `Cancel the ${kindOf(a).toLowerCase()} with ${nameOf(a)} on ${whenPhrase(ts(a.start))}? It will be removed from Google Calendar. Elite OS keeps a record of the cancelled appointment, and the customer's stage does not change.`;
    $('ac-reason').value = ''; $('ac-err').textContent = ''; $('ac-go').disabled = false;
    showDialog($('appt-cancel-dlg')); $('ac-reason').focus();
  }
  $('appt-cancel-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const a = A.cancelling; if (!a) return;
    $('ac-err').textContent = ''; $('ac-go').disabled = true;
    try {
      const r = (await call('cancelAppointment')({ id: a.id, reason: $('ac-reason').value, expectedVersion: a.version })).data;
      closeDialog($('appt-cancel-dlg')); A.cancelling = null;
      report(['Appointment cancelled.', calendarSentence(r.calendar, 'removed')].join(' '), a.phone);
    } catch (err) { $('ac-err').textContent = errText(err); $('ac-go').disabled = false; }
  });
  $('ac-keep').onclick = () => { closeDialog($('appt-cancel-dlg')); A.cancelling = null; };

  // ---------- Retry now ----------
  async function retry(a, btn) {
    if (btn) btn.disabled = true;
    try {
      const r = (await call('retryCalendarSync')({ id: a.id })).data;
      const s = r.calendar.state;
      report(s === 'synced' ? 'Google Calendar is up to date.' : s === 'off' ? 'Google Calendar sync is off.' : 'Google Calendar still could not be updated. Elite OS will keep trying.', a.phone, s === 'synced' ? 'ok' : 'err');
    } catch (err) { report('Could not retry: ' + errText(err), a.phone, 'err'); }
    finally { if (btn && btn.isConnected) btn.disabled = false; }
  }
  async function retryAll(btn) {
    btn.disabled = true;
    for (const a of [...A.failed]) { try { await call('retryCalendarSync')({ id: a.id }); } catch (e) { /* the list shows what is left */ } }
    if (btn.isConnected) btn.disabled = false;
    note(A.failed.length ? 'Some appointments could not be updated yet. Elite OS will keep trying.' : 'Google Calendar is up to date.');
  }

  // ---------- wiring ----------
  document.addEventListener('click', (e) => { if (A.menu && !A.menu.node.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', (e) => {
    if (!A.menu) return;
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...A.menu.node.querySelectorAll('button')], i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    }
  });
  window.addEventListener('resize', () => { endDrag(); closeMenu(); });
  $('appts-show-cancelled').addEventListener('change', (e) => { A.showCancelled = e.target.checked; render(); });
  $('appts-view').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b && b.dataset.view !== A.view) setMode(b.dataset.view); });
  $('cal-prev').onclick = () => goMonth(addMonths(A.month, -1));
  $('cal-next').onclick = () => goMonth(addMonths(A.month, 1));
  $('cal-today').onclick = () => goMonth(thisMonth());
  $('appts-new').onclick = () => openPicker(A.view === 'calendar' && A.selDay >= dublinDate(Date.now()) ? A.selDay : dublinDate(Date.now()));
  $('appt-customer-search').addEventListener('input', renderCustomers);
  $('appt-customer-close').onclick = () => closeDialog($('appt-customer-dlg'));
  $('appt-detail-close').onclick = () => { closeDialog($('appt-detail-dlg')); A.detailId = null; };
  $('appt-detail-dlg').addEventListener('close', () => { A.detailId = null; syncAgendaLead(); });
  $('to-appointments').onclick = () => { location.hash = '#appointments'; };
  $('appts-back').onclick = () => { location.hash = ''; };
  $('nav-appointments').addEventListener('click', (e) => { if (A.active) e.preventDefault(); });   // already here
  $('d-appt-new').onclick = () => { if (A.customer) openBook(A.customer); };

  return Object.assign(A, { show, hide, stop, watchCustomer });
})();
