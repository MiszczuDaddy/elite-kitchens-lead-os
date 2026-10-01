'use strict';
// Elite Kitchens Lead OS: pipeline screen (Phase 4).
// Read-only view over conversations + contacts, grouped by stage. Every change still goes through the existing
// setConversationStatus callable. Maths lives in crm.js; this file only draws it. Loaded after app.js (shares its helpers).
window.PIPE = (() => {
  const LIMIT = 1000;      // the Inbox list keeps its own 300 limit; the pipeline needs the whole picture for its totals
  const P = {
    active: false, origin: false,
    convs: [], contacts: [], loadedC: false, loadedK: false, unsubC: null, unsubK: null, hitLimit: false,
    query: '', source: '', added: 'all', from: '', to: '', period: 'month', stage: 'inbox',
    moving: new Set(), menu: null, stale: false,
    opt: new Map(),          // phone -> { to }: the stage a card is shown in while its move is being saved (rolled back if the save fails)
    drag: null,              // { id, from } while a card is being dragged
  };
  const desktop = () => window.matchMedia('(min-width: 900px)').matches;   // drag only where there is room and a mouse; phones use tap + menu
  const STAGES = CRM.STAGES;

  // ---------- data ----------
  function listen() {
    if (P.unsubC) return;
    P.unsubC = db.collection('conversations').orderBy('updatedAt', 'desc').limit(LIMIT).onSnapshot((snap) => {
      P.convs = snap.docs.map((d) => ({ id: d.id, ...d.data() })); P.loadedC = true; P.hitLimit = snap.size >= LIMIT;
      for (const [id, o] of P.opt) { const c = P.convs.find((x) => x.id === id); if (!c || CRM.stageOf(c) === o.to) P.opt.delete(id); }
      render();
    }, (e) => note('Cannot load the pipeline: ' + errText(e)));
    P.unsubK = db.collection('contacts').limit(LIMIT).onSnapshot((snap) => {
      P.contacts = snap.docs.map((d) => ({ id: d.id, ...d.data() })); P.loadedK = true; render();
    }, (e) => note('Cannot load customer details: ' + errText(e)));
  }
  function unlisten() {
    if (P.unsubC) { P.unsubC(); P.unsubC = null; }
    if (P.unsubK) { P.unsubK(); P.unsubK = null; }
    P.convs = []; P.contacts = []; P.loadedC = P.loadedK = false; P.hitLimit = false; P.opt.clear();
  }

  // ---------- show / hide ----------
  function setNav(on) {
    $('nav-pipeline').classList.toggle('active', on); $('nav-inbox').classList.toggle('active', !on);
    if (on) { $('nav-pipeline').setAttribute('aria-current', 'page'); $('nav-inbox').removeAttribute('aria-current'); }
    else { $('nav-inbox').setAttribute('aria-current', 'page'); $('nav-pipeline').removeAttribute('aria-current'); }
  }
  function show() {
    P.active = true; setNav(true); listen(); setView();
    document.title = 'Pipeline · Elite Kitchens';
    render();
  }
  function hide() {
    P.active = false; closeMenu(); setNav(false); unlisten();
  }
  function stop() {          // sign-out: forget everything
    hide(); P.origin = false; P.moving.clear(); endDrag();
    P.query = ''; P.source = ''; P.added = 'all'; P.from = P.to = ''; P.period = 'month'; P.stage = 'inbox';
    $('pipe-search').value = ''; $('pipe-source').replaceChildren(new Option('All sources', '')); $('pipe-added').value = 'all';
    $('pipe-from').value = $('pipe-to').value = ''; $('pipe-custom').hidden = true; $('pipe-board').replaceChildren(); $('ov-grid').replaceChildren();
  }

  // ---------- helpers ----------
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const age = (d) => (d === null ? '' : d === 0 ? 'today' : plural(d, 'day'));
  function note(text) { const t = $('pipe-toast'); t.textContent = text; t.hidden = !text; clearTimeout(note.h); if (text) note.h = setTimeout(() => { t.hidden = true; }, 8000); }
  const addedRange = () => CRM.rangeFor(P.added, Date.now(), { from: P.from, to: P.to });

  // ---------- overview ----------
  function stat(label, value, sub, help) {
    const d = el('div', 'ov-item');
    const dt = el('dt', null, label); if (help) { dt.title = help; dt.classList.add('has-help'); }
    d.append(dt, el('dd', 'ov-num', value), el('dd', 'ov-sub', sub || ' '));
    return d;
  }
  // A percentage as soon as there is one customer to measure; the fraction underneath shows how much it rests on.
  function rateStat(label, r, help) {
    if (!r.den) return stat(label, '—', 'nobody to measure yet', help);
    return stat(label, Math.round((r.num / r.den) * 100) + '%', r.num + ' of ' + r.den + (r.den < 5 ? ' · small sample' : ''), help);
  }
  const L2B_HELP = 'Of the customers who became a lead, or moved to any stage, in this period: the share that have reached Booked. Customers with no recorded history are left out, not guessed.';
  const Q2W_HELP = 'Of the customers who reached Quoted, and who became a lead or moved stage in this period: the share that are Won now. Quotes still open and quotes that ended in Closed count as not won (yet).';
  function renderOverview(rows) {
    const o = CRM.overview(rows, CRM.rangeFor(P.period, Date.now()));
    const open = o.openQuotes;
    $('ov-grid').replaceChildren(
      stat('New leads', String(o.newLeads)),
      stat('Booked', String(o.booked)),
      stat('Quoted', String(o.quoted.count), o.quoted.value ? CRM.money(o.quoted.value) : o.quoted.count ? 'no values yet' : ''),
      stat('Won', String(o.won.count), o.won.value ? CRM.money(o.won.value) : o.won.count ? 'no values yet' : ''),
      stat('Open quotes', CRM.money(open.value) || '€0', plural(open.count, 'quote') + (open.missingValue ? ' · ' + open.missingValue + ' without a value' : '')),
      stat('Average job', o.won.avg ? CRM.money(o.won.avg) : '—', 'won jobs with a value'),
      rateStat('Lead → Booked', o.leadToBooked, L2B_HELP),
      rateStat('Quote → Won', o.quoteToWon, Q2W_HELP),
    );
    $('ov-title').textContent = 'Overview' + (P.source ? ' · ' + P.source : '');
    for (const b of $('ov-period').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.period === P.period));
  }

  // ---------- board ----------
  function rowNode(r) {
    const item = el('div', 'prow' + (P.moving.has(r.id) ? ' pending' : ''));
    item.setAttribute('role', 'listitem'); item.tabIndex = 0; item.dataset.phone = r.id;
    if (desktop()) item.draggable = true;
    const name = r.name || formatPhone(r.id);
    item.setAttribute('aria-label', name + (r.unread ? ', unread messages' : '') + '. Open conversation');
    const main = el('div', 'prow-main');
    const top = el('div', 'prow-top'); top.append(el('span', 'prow-name', name));
    if (r.unread) { const d = el('span', 'dot'); d.title = 'Unread'; top.append(d); }
    main.append(top);
    const sub = [r.location, r.projectType].filter(Boolean).join(' · ');
    if (sub) main.append(el('div', 'prow-sub', sub));
    const meta = el('div', 'prow-meta');
    if (r.quoteValue) meta.append(el('span', 'pv', CRM.money(r.quoteValue)));
    else if (r.status === 'quoted') meta.append(el('span', 'pv none', 'No value yet'));
    if (r.source) meta.append(el('span', null, r.source));
    const d = CRM.daysInStage(r, Date.now());
    if (d !== null) { const a = el('span', null, age(d)); a.title = 'In ' + CRM.LABELS[r.status] + ' for ' + plural(d, 'day'); meta.append(a); }
    if (meta.childNodes.length) main.append(meta);
    const btn = el('button', 'prow-menu');
    btn.type = 'button'; btn.setAttribute('aria-label', 'Move ' + name + ' to another stage'); btn.setAttribute('aria-haspopup', 'menu'); btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>';
    btn.onclick = (e) => { e.stopPropagation(); openMenu(r, btn); };
    item.append(main, btn);
    item.onclick = () => openCustomer(r);
    item.onkeydown = (e) => { if (e.target === item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openCustomer(r); } };
    return item;
  }

  function laneNode(l) {
    const lane = el('section', 'lane' + (l.stage === P.stage ? ' lane-on' : '')); lane.dataset.stage = l.stage;
    const head = el('header', 'lane-head');
    const title = el('h3', 'lane-title', l.label); title.append(el('span', 'lane-count', String(l.rows.length)));
    head.append(title);
    if (l.stage === 'quoted' || l.stage === 'won') head.append(el('span', 'lane-sum', l.value ? CRM.money(l.value) : ''));
    const body = el('div', 'lane-body'); body.setAttribute('role', 'list'); body.setAttribute('aria-label', l.label);
    if (l.rows.length) body.append(...l.rows.map(rowNode)); else body.append(el('p', 'lane-empty', 'Nothing here'));
    lane.append(head, body);
    return lane;
  }

  function render() {
    if (!P.active) return;
    if (P.menu || P.drag) { P.stale = true; return; }             // never redraw under an open menu or a card being dragged
    const board = $('pipe-board');
    if (!P.loadedC || !P.loadedK) { board.replaceChildren(el('p', 'pipe-empty', 'Loading customers…')); $('ov-grid').replaceChildren(); return; }
    const all = CRM.buildRows(P.convs, P.contacts).map((r) => (P.opt.has(r.id) ? { ...r, status: P.opt.get(r.id).to } : r));
    const sources = CRM.sourcesOf(all);
    const sel = $('pipe-source');
    if (P.source && !sources.includes(P.source)) sources.push(P.source);
    sel.replaceChildren(new Option('All sources', ''), ...sources.map((s) => new Option(s, s)));
    sel.value = P.source;
    const scoped = P.source ? all.filter((r) => r.source === P.source) : all;     // source narrows the overview too
    renderOverview(scoped);
    const shown = CRM.filterRows(all, { query: P.query, source: P.source, added: addedRange() });
    const lanes = CRM.lanes(shown);
    if (!all.length) board.replaceChildren(el('p', 'pipe-empty', 'No customers yet. New leads and WhatsApp customers will appear here.'));
    else board.replaceChildren(...STAGES.map((s) => laneNode(lanes[s])));
    // phone: one stage at a time, picked from these chips
    $('pipe-stages').replaceChildren(...STAGES.map((s) => {
      const b = el('button', null, CRM.LABELS[s]); b.type = 'button'; b.dataset.stage = s; b.setAttribute('aria-pressed', String(s === P.stage));
      b.append(el('span', 'stage-n', String(lanes[s].rows.length)));
      return b;
    }));
    const n = $('pipe-note'); n.hidden = !P.hitLimit; n.textContent = P.hitLimit ? 'Showing the ' + LIMIT.toLocaleString('en-IE') + ' most recently active customers.' : '';
  }

  // ---------- open a customer ----------
  function openCustomer(r) {
    P.origin = true;                       // so Back on a phone returns here
    S.statusFilter = r.status;             // the Inbox list behind the conversation shows that customer's stage
    location.hash = '#c/' + r.id;
  }

  // ---------- move between stages ----------
  function closeMenu(focusBack) {
    const m = P.menu; if (!m) return;
    m.node.remove(); m.btn.setAttribute('aria-expanded', 'false'); P.menu = null;
    if (focusBack && m.btn.isConnected) m.btn.focus();
    if (P.stale) { P.stale = false; render(); }
  }
  function openMenu(r, btn) {
    const was = P.menu && P.menu.btn === btn; closeMenu();
    if (was) return;
    const node = el('div', 'move-menu'); node.setAttribute('role', 'menu'); node.setAttribute('aria-label', 'Move to');
    for (const s of STAGES) {
      const b = el('button', null, CRM.LABELS[s]); b.type = 'button'; b.dataset.stage = s; b.setAttribute('role', 'menuitemradio'); b.setAttribute('aria-checked', String(s === r.status));
      if (s === r.status) { b.disabled = true; b.append(el('span', 'tick-mark', '✓')); }
      b.onclick = () => { closeMenu(true); move(r.id, s); };
      node.append(b);
    }
    document.body.append(node);
    const rc = btn.getBoundingClientRect(), w = node.offsetWidth, h = node.offsetHeight;
    node.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, rc.right - w)) + 'px';
    node.style.top = (rc.bottom + h + 8 > window.innerHeight ? Math.max(8, rc.top - h - 4) : rc.bottom + 4) + 'px';
    btn.setAttribute('aria-expanded', 'true'); P.menu = { node, btn };
    (node.querySelector('button:not(:disabled)') || node).focus();
  }
  // The single place a stage change happens. The menu and drag-and-drop both call this, which calls the existing
  // setConversationStatus callable (that is what stamps the stage date). The card is shown in its new stage straight away
  // and put back, with a message, if the save fails. One move per customer at a time.
  const currentStage = (phone) => CRM.stageOf(P.convs.find((c) => c.id === phone));
  async function move(phone, status) {
    if (P.moving.has(phone)) return;
    const from = currentStage(phone);
    if (!CRM.STAGES.includes(status) || from === status) return;
    const row = CRM.buildRows(P.convs, P.contacts).find((r) => r.id === phone);
    const name = (row && row.name) || formatPhone(phone);
    P.moving.add(phone); P.opt.set(phone, { to: status }); note(''); render();
    try {
      await call('setConversationStatus')({ phone, status });
      const o = P.opt.get(phone);                        // the live data normally catches up within a moment; do not wait forever
      if (o) setTimeout(() => { if (P.opt.get(phone) === o) { P.opt.delete(phone); render(); } }, 4000);
    } catch (e) {
      P.opt.delete(phone);
      note('Could not move ' + name + ' to ' + CRM.LABELS[status] + '. They are back in ' + CRM.LABELS[from] + ' - please try again.');
    } finally { P.moving.delete(phone); render(); }
  }

  // ---------- drag and drop (desktop) ----------
  function endDrag() {
    P.drag = null;
    const board = $('pipe-board');
    board.classList.remove('is-dragging');
    for (const n of board.querySelectorAll('.dragging, .drop-target')) n.classList.remove('dragging', 'drop-target');
    if (P.stale && !P.menu) { P.stale = false; render(); }
  }
  const laneOf = (e) => (e.target.closest ? e.target.closest('.lane') : null);
  const board = $('pipe-board');
  board.addEventListener('dragstart', (e) => {
    const row = e.target.closest && e.target.closest('.prow');
    if (!row || !desktop() || P.moving.has(row.dataset.phone)) { e.preventDefault(); return; }
    closeMenu();
    P.drag = { id: row.dataset.phone, from: row.closest('.lane').dataset.stage };
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', P.drag.id);
    board.classList.add('is-dragging');
    setTimeout(() => row.classList.add('dragging'), 0);       // after the browser has taken its drag picture
  });
  board.addEventListener('dragover', (e) => {
    const lane = laneOf(e);
    if (!P.drag || !lane || lane.dataset.stage === P.drag.from) return;      // the card's own column is not a destination
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    for (const n of board.querySelectorAll('.drop-target')) if (n !== lane) n.classList.remove('drop-target');
    lane.classList.add('drop-target');
  });
  board.addEventListener('dragleave', (e) => { const lane = laneOf(e); if (lane && !lane.contains(e.relatedTarget)) lane.classList.remove('drop-target'); });
  board.addEventListener('drop', (e) => {
    const lane = laneOf(e), d = P.drag;
    if (!d || !lane) { endDrag(); return; }
    e.preventDefault();
    const to = lane.dataset.stage;
    endDrag();
    if (to !== d.from) move(d.id, to);
  });
  board.addEventListener('dragend', endDrag);
  window.matchMedia('(min-width: 900px)').addEventListener('change', () => render());

  // ---------- wiring ----------
  document.addEventListener('click', (e) => { if (P.menu && !P.menu.node.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', (e) => {
    if (!P.menu) return;
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...P.menu.node.querySelectorAll('button:not(:disabled)')], i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    }
  });
  window.addEventListener('resize', () => closeMenu());
  $('pipe-search').addEventListener('input', (e) => { P.query = e.target.value; render(); });
  $('pipe-source').addEventListener('change', (e) => { P.source = e.target.value; render(); });
  $('pipe-added').addEventListener('change', (e) => { P.added = e.target.value; $('pipe-custom').hidden = P.added !== 'custom'; render(); });
  $('pipe-from').addEventListener('change', (e) => { P.from = e.target.value; render(); });
  $('pipe-to').addEventListener('change', (e) => { P.to = e.target.value; render(); });
  $('ov-period').addEventListener('click', (e) => { const b = e.target.closest('button[data-period]'); if (b) { P.period = b.dataset.period; render(); } });
  $('pipe-stages').addEventListener('click', (e) => { const b = e.target.closest('button[data-stage]'); if (b) { P.stage = b.dataset.stage; render(); } });
  $('to-pipeline').onclick = () => { location.hash = '#pipeline'; };
  $('pipe-back').onclick = () => { location.hash = ''; };
  $('nav-pipeline').addEventListener('click', (e) => { if (P.active) e.preventDefault(); });   // already here

  return Object.assign(P, { show, hide, stop });
})();
