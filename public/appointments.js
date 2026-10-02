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
  };
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
  function listen() {
    if (A.unsub) return;
    const from = firebase.firestore.Timestamp.fromMillis(startOfToday());
    A.unsub = db.collection('appointments').where('start', '>=', from).orderBy('start').limit(LIMIT).onSnapshot((snap) => {
      A.list = snap.docs.map((d) => ({ id: d.id, ...d.data() })); A.loaded = true; A.hitLimit = snap.size >= LIMIT;
      render();
    }, (e) => note('Cannot load appointments: ' + errText(e)));
    A.unsubFailed = db.collection('appointments').where('sync.google.state', '==', 'failed').limit(50).onSnapshot((snap) => {
      A.failed = snap.docs.map((d) => ({ id: d.id, ...d.data() })); render();
    }, () => {});
  }
  function unlisten() {
    if (A.unsub) { A.unsub(); A.unsub = null; }
    if (A.unsubFailed) { A.unsubFailed(); A.unsubFailed = null; }
    A.list = []; A.failed = []; A.loaded = false; A.hitLimit = false;
  }

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
    A.active = true; setNav(true); listen(); setView();
    document.title = 'Appointments · Elite Kitchens';
    render();
  }
  function hide() { A.active = false; closeMenu(); setNav(false); unlisten(); }
  function stop() {                       // sign-out: forget everything
    hide(); A.origin = false; watchCustomer(null);
    A.showCancelled = false; $('appts-show-cancelled').checked = false;
    closeDialog($('appt-dlg')); closeDialog($('appt-cancel-dlg')); A.dlg = null; A.cancelling = null;
    $('appts-list').replaceChildren(); note('');
  }

  // ---------- the Appointments screen ----------
  function note(text) { const t = $('appts-toast'); t.textContent = text; t.hidden = !text; clearTimeout(note.h); if (text) note.h = setTimeout(() => { t.hidden = true; }, 8000); }
  function render() {
    if (!A.active) return;
    if (A.menu) { A.stale = true; return; }                        // never redraw under an open menu
    const f = $('appts-failed'), nFailed = A.failed.length;
    f.hidden = !nFailed;
    if (nFailed) {
      const b = el('button', 'linkbtn', 'Retry all'); b.type = 'button'; b.onclick = () => retryAll(b);
      f.replaceChildren(el('span', null, (nFailed === 1 ? '1 appointment is' : nFailed + ' appointments are') + ' not up to date in Google Calendar (' + failText(syncOf(A.failed[0])) + ').'), b);
    }
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
    if (a.status !== 'cancelled') { item('Reschedule…', () => openReschedule(a)); item('Cancel appointment…', () => openCancel(a)); }
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
    $('a-go').textContent = go; $('a-go').disabled = false; $('a-err').textContent = '';
    setDateBounds(); showDialog($('appt-dlg')); $('a-date').focus();
  }
  function openBook(phone) {
    const c = convOf(phone) || {}, contact = (S.selected === phone && S.contact) || {};
    A.dlg = { mode: 'create', phone, requestId: newRequestId() };          // one id per booking: a double click or retry books it once
    $('a-date').value = dublinDate(Date.now() + DAY);
    fillTimes('10:00'); fillDuration(60); $('a-type').value = 'consultation';
    $('a-location').value = contact.location || c.location || ''; $('a-notes').value = '';
    openForm('Book appointment', (contact.name || c.name || formatPhone(phone)) + ' · ' + formatPhone(phone), 'Book appointment');
  }
  function openReschedule(a) {
    A.dlg = { mode: 'update', phone: a.phone, appt: a };
    $('a-date').value = dublinDate(ts(a.start));
    fillTimes(clock(ts(a.start))); fillDuration(a.durationMin || 60); $('a-type').value = Object.hasOwn(TYPES, a.type) ? a.type : 'consultation';
    $('a-location').value = a.location || ''; $('a-notes').value = a.notes || '';
    openForm('Reschedule appointment', nameOf(a) + ' · ' + formatPhone(a.phone), 'Save changes');
  }
  function bookedMessage(r, phone) {
    const c = convOf(phone), who = (c && c.name) || 'The customer';
    const stage = r.stage && r.stage.to === 'booked' ? who + ' moved to Booked.' : c ? who + ' stays in ' + INBOX_STATUSES[inboxStatus(c)] + '.' : '';
    return [(r.existing ? 'Already booked for ' : 'Booked for ') + whenPhrase(r.start) + '.', stage, calendarSentence(r.calendar, 'added')].filter(Boolean).join(' ');
  }
  $('appt-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = A.dlg; if (!d) return;
    const fields = { date: $('a-date').value, time: $('a-time').value, durationMin: Number($('a-duration').value), type: $('a-type').value, location: $('a-location').value, notes: $('a-notes').value };
    if (!fields.date) { $('a-err').textContent = 'Choose a date.'; return; }
    $('a-err').textContent = ''; $('a-go').disabled = true;
    try {
      if (d.mode === 'create') {
        const r = (await call('createAppointment')({ phone: d.phone, ...fields, requestId: d.requestId })).data;
        closeDialog($('appt-dlg')); A.dlg = null;
        report(bookedMessage(r, d.phone), d.phone);
      } else {
        const r = (await call('updateAppointment')({ id: d.appt.id, ...fields, expectedVersion: d.appt.version })).data;
        closeDialog($('appt-dlg')); A.dlg = null;
        report(r.unchanged ? 'No changes to save.' : ['Moved to ' + whenPhrase(r.start) + '.', calendarSentence(r.calendar, 'updated')].join(' '), d.phone);
      }
    } catch (err) { $('a-err').textContent = errText(err); $('a-go').disabled = false; }
  });
  $('a-cancel').onclick = () => { closeDialog($('appt-dlg')); A.dlg = null; };

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
  window.addEventListener('resize', () => closeMenu());
  $('appts-show-cancelled').addEventListener('change', (e) => { A.showCancelled = e.target.checked; render(); });
  $('to-appointments').onclick = () => { location.hash = '#appointments'; };
  $('appts-back').onclick = () => { location.hash = ''; };
  $('nav-appointments').addEventListener('click', (e) => { if (A.active) e.preventDefault(); });   // already here
  $('d-appt-new').onclick = () => { if (A.customer) openBook(A.customer); };

  return Object.assign(A, { show, hide, stop, watchCustomer });
})();
