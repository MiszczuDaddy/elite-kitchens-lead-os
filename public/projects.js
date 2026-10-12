'use strict';
// Elite Kitchens Lead OS: Projects (Phase 7, docs/PROJECTS.md). The Projects dashboard (all active projects and what is still waiting to be ordered), one project
// (customer, linked quote, checklist, installation date, notes, the approved 3D render), the Projects block in the customer profile and the "New project" dialog.
// Reads Firestore directly (staff-only rules); every change goes through the project callables. What a project "is" (status, waiting-to-order, filters, order)
// lives in project-model.js. Loaded after app.js (shares its helpers).
window.PROJ = (() => {
  const M = window.ProjectModel;
  const LIMIT = 300;
  const RENDER_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], RENDER_MAX = 25 * 1024 * 1024;
  const ID = /^[pm]_[0-9a-f]{24}$/;
  const P = {
    active: false, view: 'list', id: null, hash: '#projects', cameFrom: null, backTo: null,
    list: [], listLoaded: false, hitLimit: false, unsubList: null, filter: 'active', query: '',
    project: null, projectLoaded: false, unsubProject: null, contact: null, unsubContact: null,
    busy: new Set(), opt: new Map(), saved: null, baseRev: null, saveMsg: '', dirty: false, edit: null, renderKey: null, renderUrl: null, confirm: null,
    customer: null, custList: [], custLoaded: false, unsubCust: null, dlg: null,
  };
  const newRequestId = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12));
  const showDialog = (d) => { if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', ''); };
  const closeDialog = (d) => { if (typeof d.close === 'function') { if (d.open) d.close(); } else d.removeAttribute('open'); };
  const eur = (n) => '€' + Number(n).toLocaleString('en-IE', { maximumFractionDigits: 2 });
  const whenOf = (t) => (t && typeof t.toMillis === 'function' ? new Intl.DateTimeFormat('en-IE', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(t.toMillis())) : '');
  const nameOf = (p) => { const c = S.convs.find((x) => x.id === p.phone); return (c && c.name) || p.customerName || formatPhone(p.phone) || 'Customer'; };

  function note(text, kind) {
    const t = $('pj-toast'); t.textContent = text || ''; t.hidden = !text; t.className = 'toast q-toast' + (kind === 'err' ? ' err' : '');
    clearTimeout(note.h); if (text && kind !== 'err') note.h = setTimeout(() => { t.hidden = true; }, 6000);
  }
  async function run(name, data) { try { return (await call(name)(data)).data; } catch (e) { throw new Error(e && e.message ? e.message : 'Something went wrong. Please try again.'); } }

  // ---------- routing ----------
  const parse = (hash) => { const m = /^#projects\/([pm]_[0-9a-f]{24})$/.exec(hash || ''); return m ? { view: 'project', id: m[1] } : { view: 'list', id: null }; };
  const handles = (hash) => hash === '#projects' || (typeof hash === 'string' && hash.startsWith('#projects/') && ID.test(hash.slice(10)));
  function setNav(on) {
    const n = $('nav-projects');
    n.classList.toggle('active', on);
    if (on) { n.setAttribute('aria-current', 'page'); for (const id of ['nav-inbox', 'nav-pipeline', 'nav-appointments', 'nav-quotes']) { $(id).classList.remove('active'); $(id).removeAttribute('aria-current'); } }
    else { n.removeAttribute('aria-current'); $('nav-inbox').classList.add('active'); $('nav-inbox').setAttribute('aria-current', 'page'); }
  }
  // Leaving a project with unsaved notes or date asks first. Returns false to stay (the address bar is put back).
  function mayLeave(nextHash) {
    if (!P.active || !P.dirty) return true;
    const r = parse(nextHash);
    if (handles(nextHash) && r.view === P.view && r.id === P.id) return true;
    const okay = window.confirm('You have unsaved changes to this project. Leave without saving?');
    if (okay) P.dirty = false; else history.replaceState(null, '', P.hash);
    return okay;
  }
  function show(hash) {
    const r = parse(hash);
    if (r.view !== 'project') closeProject();
    P.active = true; P.view = r.view; P.hash = r.id ? '#projects/' + r.id : '#projects';
    setNav(true); listenList();
    $('pj-list-view').hidden = r.view !== 'list'; $('pj-project-view').hidden = r.view !== 'project';
    if (r.view === 'project') { if (!P.cameFrom) P.cameFrom = '#projects'; openProject(r.id); } else P.cameFrom = null;
    setView(); render();
    $('pj-scroll').scrollTop = 0;
  }
  function hide() {
    P.active = false; closeProject(); unlistenList(); setNav(false); P.cameFrom = null; note('');
    closeDialog($('np-dlg')); P.dlg = null; setView();
  }
  function stop() { hide(); P.backTo = null; P.filter = 'active'; P.query = ''; $('pj-search').value = ''; watchCustomer(null); }

  // ---------- data ----------
  function listenList() {
    if (P.unsubList) return;
    P.unsubList = db.collection('projects').limit(LIMIT).onSnapshot((snap) => {
      P.list = snap.docs.map((d) => ({ id: d.id, ...d.data() })); P.listLoaded = true; P.hitLimit = snap.size >= LIMIT; if (P.active) renderList();
    }, (e) => { P.listLoaded = true; note('Cannot load projects: ' + errText(e), 'err'); });
  }
  function unlistenList() { if (P.unsubList) { P.unsubList(); P.unsubList = null; } P.list = []; P.listLoaded = false; P.hitLimit = false; }
  function openProject(id) {
    if (P.id === id && P.unsubProject) { renderProject(); return; }
    closeProject(); P.id = id; P.confirm = null;
    P.unsubProject = db.doc('projects/' + id).onSnapshot((snap) => {
      if (P.id !== id) return;
      P.projectLoaded = true; P.project = snap.exists ? { id: snap.id, ...snap.data() } : null;
      if (P.project && !P.contactPhone) watchProjectContact(P.project.phone);
      renderProject();
    }, (e) => { P.projectLoaded = true; P.project = null; renderProject(); note('Cannot load the project: ' + errText(e), 'err'); });
    buildProject();
  }
  function watchProjectContact(phone) {
    if (P.unsubContact) { P.unsubContact(); P.unsubContact = null; }
    P.contactPhone = phone; P.contact = null;
    P.unsubContact = db.doc('contacts/' + phone).onSnapshot((s) => { P.contact = s.exists ? s.data() : null; if (P.active && P.project) renderProject(); }, () => {});
  }
  function closeProject() {
    if (P.unsubProject) { P.unsubProject(); P.unsubProject = null; }
    if (P.unsubContact) { P.unsubContact(); P.unsubContact = null; }
    P.id = null; P.project = null; P.projectLoaded = false; P.contact = null; P.contactPhone = null; P.dirty = false; P.edit = null; P.renderKey = null; P.renderUrl = null; P.confirm = null;
    P.busy.clear(); P.opt.clear(); P.saved = null; P.saveMsg = ''; $('pj-project-view').replaceChildren();
  }

  // ---------- the dashboard ----------
  function render() {
    const r = P.view === 'project';
    $('pj-title').textContent = r ? (P.project ? nameOf(P.project) : 'Project') : 'Projects';
    if (r) renderProject(); else renderList();
  }
  function renderList() {
    if (!P.active || P.view !== 'list') return;
    const c = M.counts(P.list);
    $('pj-subtitle').textContent = P.listLoaded ? `${c.active} active · ${c.completed} completed` : '';
    for (const key of ['carcasses', 'doors']) {
      const t = $('pj-tile-' + key); t.querySelector('.pj-tile-n').textContent = c[key]; t.setAttribute('aria-pressed', String(P.filter === key)); t.classList.toggle('has', c[key] > 0);
    }
    for (const b of $('pj-filter').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.filter === P.filter));
    const rows = M.search(M.sorted(P.list.filter((p) => M.matches(p, P.filter)), P.filter), P.query, nameOf);
    const host = $('pj-list'), empty = $('pj-empty');
    host.replaceChildren(...rows.map(row));
    empty.hidden = !!rows.length || !P.listLoaded;
    empty.textContent = rows.length || !P.listLoaded ? '' : P.query.trim() ? 'No project matches your search.'
      : P.filter === 'carcasses' ? 'Every active project has its carcasses ordered.' : P.filter === 'doors' ? 'Every active project has its doors ordered.'
      : P.filter === 'ready' ? 'No project is ready for installation.' : P.filter === 'completed' ? 'No completed projects yet.'
      : 'No active projects yet. A project appears here when a quote is marked accepted.';
    const note2 = $('pj-list-note'); note2.hidden = !P.hitLimit; note2.textContent = P.hitLimit ? `Showing the ${LIMIT} most recent projects.` : '';
  }
  function row(p) {
    const r = el('div', 'qrow projrow'); r.setAttribute('role', 'listitem'); r.tabIndex = 0; r.dataset.id = p.id;
    const st = M.statusOf(p), wait = M.waitingFor(p), prog = M.progress(p);
    const top = el('div', 'qrow-top'); const chip = el('span', 'qchip', st.label); chip.dataset.pstatus = st.key;
    top.append(el('span', 'qrow-name', nameOf(p)), chip);
    const sub = [p.quoteRef ? p.quoteRef + (p.quoteOption && p.quoteOption.name ? ' · ' + p.quoteOption.name : '') : 'No quote', p.installDate ? 'Install ' + M.dateLabel(p.installDate) : 'No installation date'].join(' · ');
    const flags = el('div', 'pj-flags');
    if (wait.includes('carcasses')) flags.append(el('span', 'pj-flag', 'Carcasses to order'));
    if (wait.includes('doors')) flags.append(el('span', 'pj-flag', 'Doors to order'));
    if (wait.length && !M.done(p, 'designApproved')) flags.append(el('span', 'pj-quiet', 'Design not approved yet'));
    const main = el('div', 'qrow-main'); main.append(top, el('div', 'qrow-sub', sub)); if (flags.childNodes.length) main.append(flags);
    const bar = el('span', 'pj-prog'); bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', `${prog.done} of ${prog.total} steps done`);
    for (let i = 0; i < prog.total; i++) bar.append(el('i', i < prog.done ? 'on' : ''));
    const right = el('div', 'pj-right'); right.append(bar, el('span', 'pj-count', `${prog.done}/${prog.total}`));
    r.append(main, right);
    const open = () => { P.cameFrom = '#projects'; location.hash = '#projects/' + p.id; };
    r.onclick = open; r.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
    return r;
  }

  // ---------- one project ----------
  // The page is built once when a project is opened and then updated in place by every live snapshot, so a box being ticked, a date being typed or the keyboard focus
  // are never lost to a redraw.
  function field(label, node) { const l = el('label', 'pjv-field'); l.append(el('span', 'pjv-label', label), node); return l; }
  function section(title, ...kids) { const s = el('section', 'pjv-sec'); if (title) s.append(el('h2', 'pjv-h', title)); s.append(...kids); return s; }
  function buildProject() {
    const v = $('pj-project-view'), steps = el('ul', 'pj-steps');
    for (const s of M.STEPS) {
      const li = el('li', 'pj-step'), lab = el('label', 'pj-step-label'), box = el('input'); box.type = 'checkbox'; box.id = 'pj-step-' + s.key; box.dataset.step = s.key; box.disabled = true;      // until the project has loaded (a click before that would be ignored)
      box.onchange = () => setStep(s.key, box.checked);
      lab.append(box, el('span', 'pj-step-text', s.label)); li.append(lab, el('span', 'pj-by')); li.dataset.step = s.key; steps.append(li);
    }
    const date = el('input'); date.type = 'date'; date.id = 'pj-date'; date.min = '2024-01-01'; date.max = '2100-12-31';
    const notes = el('textarea'); notes.id = 'pj-notes'; notes.rows = 5; notes.maxLength = 2000; notes.placeholder = 'Anything the team should know about this job';
    const onEdit = () => { if (!P.project) return; P.saveMsg = ''; P.dirty = (date.value || '') !== (P.project.installDate || '') || (notes.value || '').trim() !== (P.project.notes || ''); renderSave(); };
    date.oninput = onEdit; notes.oninput = onEdit;
    const save = el('button', 'btn btn-primary btn-sm', 'Save'); save.type = 'button'; save.id = 'pj-save'; save.disabled = true; save.onclick = saveDetails;
    const saveMsg = el('span', 'pjv-msg'); saveMsg.id = 'pj-save-msg'; saveMsg.setAttribute('role', 'status');
    const reload = el('button', 'btn btn-ghost btn-sm', 'Load the latest'); reload.type = 'button'; reload.id = 'pj-reload'; reload.hidden = true;
    reload.onclick = () => { P.dirty = false; P.edit = null; P.saved = null; P.saveMsg = ''; reload.hidden = true; renderProject(); };
    const saveRow = el('div', 'pjv-row'); saveRow.append(save, reload, saveMsg);

    const file = el('input'); file.type = 'file'; file.id = 'pj-file'; file.accept = '.jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf'; file.hidden = true;
    file.onchange = () => { const f = file.files && file.files[0]; file.value = ''; if (f) attachRender(f); };
    const pick = el('button', 'btn btn-ghost btn-sm', 'Attach render'); pick.type = 'button'; pick.id = 'pj-attach'; pick.onclick = () => file.click();
    const open = el('button', 'btn btn-ghost btn-sm', 'Open'); open.type = 'button'; open.id = 'pj-render-open'; open.hidden = true; open.onclick = openRender;
    const renderBox = el('div', 'pj-render'); renderBox.id = 'pj-render';
    const renderMsg = el('div', 'pjv-msg'); renderMsg.id = 'pj-render-msg'; renderMsg.setAttribute('role', 'status');
    const renderRow = el('div', 'pjv-row'); renderRow.append(pick, open, file);

    const side = el('div', 'pjv-side');
    const cust = el('div', 'pjv-cust'); cust.id = 'pj-customer';
    const quoteBox = el('div', 'pjv-quote'); quoteBox.id = 'pj-quote';
    const actions = el('div', 'pjv-actions'); actions.id = 'pj-actions';
    side.append(section('Customer', cust), section('Quote', quoteBox), section('', actions));

    const main = el('div', 'pjv-main');
    const msg = el('div', 'pjv-banner'); msg.id = 'pj-banner'; msg.hidden = true; msg.setAttribute('role', 'status');
    main.append(msg, section('Checklist', steps), section('Installation', field('Expected installation date', date), field('Notes', notes), saveRow),
      section('Approved 3D render', renderBox, renderRow, renderMsg));
    const wrap = el('div', 'pjv'); wrap.append(main, side); v.replaceChildren(wrap);
  }
  const edit = () => { const d = $('pj-date'), n = $('pj-notes'); return { date: d.value || '', notes: (n.value || '').trim() }; };
  function renderSave() {
    const s = $('pj-save'); if (!s) return;
    s.disabled = !P.dirty || !P.project || P.busy.has('save');
    $('pj-save-msg').textContent = P.saveMsg || (P.dirty ? 'Unsaved changes' : '');                 // what the last save said stays until the next edit
  }
  function renderProject() {
    if (!P.active || P.view !== 'project' || !$('pj-save')) return;
    const p = P.project, banner = $('pj-banner');
    $('pj-title').textContent = p ? nameOf(p) : 'Project';
    if (!P.projectLoaded) { $('pj-subtitle').textContent = ''; return; }
    if (!p) {
      $('pj-subtitle').textContent = ''; banner.hidden = false; banner.className = 'pjv-banner'; banner.textContent = 'This project was not found. It may have been removed.';
      for (const id of ['pj-save', 'pj-attach']) $(id).disabled = true; return;
    }
    const done = p.status === 'completed', st = M.statusOf(p);
    $('pj-subtitle').textContent = [st.label, p.quoteRef].filter(Boolean).join(' · ');
    const warn = M.quoteNote(p);
    banner.hidden = !warn && !done; banner.className = 'pjv-banner' + (warn ? ' warn' : '');
    banner.textContent = warn || (done ? `Completed on ${whenOf(p.completedAt)}${p.completedBy && p.completedBy.id ? ' by ' + p.completedBy.id : ''}. Reopen the project to change it.` : '');
    for (const s of M.STEPS) {
      const box = $('pj-step-' + s.key), meta = box.closest('li').querySelector('.pj-by'), d = p.steps && p.steps[s.key];
      if (P.opt.has(s.key) && P.opt.get(s.key) === M.done(p, s.key)) P.opt.delete(s.key);      // the live update has caught up
      box.checked = P.opt.has(s.key) ? P.opt.get(s.key) : M.done(p, s.key);
      box.disabled = done || P.busy.has(s.key);
      meta.textContent = d && d.done ? [whenOf(d.at), d.by].filter(Boolean).join(' · ') : '';
    }
    if (P.saved && p.rev >= P.saved.rev) P.saved = null;                         // the live update has caught up with the save
    if (!P.dirty) {                                                                   // the form shows the project as it is now: remember WHICH revision that was
      const v = P.saved || { date: p.installDate || '', notes: p.notes || '' }; $('pj-date').value = v.date; $('pj-notes').value = v.notes; P.baseRev = P.saved ? P.saved.rev : p.rev;
    }
    $('pj-date').disabled = false; $('pj-notes').disabled = false; renderSave();
    renderCustomerCard(p); renderQuoteCard(p); renderActions(p, done); renderRenderBox(p, done);
  }
  function renderCustomerCard(p) {
    const c = P.contact || {}, host = $('pj-customer'), phone = p.phone;
    const lines = [];
    const name = el('div', 'pjv-name', c.name || nameOf(p));
    const tel = el('a', 'pjv-link', formatPhone(phone)); tel.href = 'tel:+' + phone;
    lines.push(name, tel);
    if (c.email) { const a = el('a', 'pjv-link', c.email); a.href = 'mailto:' + c.email; lines.push(a); }
    const where = c.address || c.location; if (where) lines.push(el('div', 'pjv-sub', where));
    const chat = el('a', 'btn btn-ghost btn-sm pjv-chat', 'Open chat'); chat.id = 'pj-chat'; chat.href = '#c/' + phone; chat.onclick = () => { P.backTo = '#projects/' + p.id; };
    host.replaceChildren(...lines, chat);
  }
  function renderQuoteCard(p) {
    const host = $('pj-quote');
    if (!p.quoteId) { host.replaceChildren(el('p', 'pjv-sub', 'No quote is linked to this project.')); return; }
    const a = el('a', 'pjv-link pjv-quoteref', p.quoteRef || 'Quote'); a.href = '#quotes/' + p.quoteId; a.id = 'pj-quote-link';
    const o = p.quoteOption;
    host.replaceChildren(a, el('div', 'pjv-sub', o ? `${o.name || 'Accepted option'}${o.incVat != null ? ' · ' + eur(o.incVat) + ' inc VAT' : ''}` : 'Accepted'));
  }
  // What deleting this project would lose, in plain words (the quote and the customer are never touched).
  function deleteWarning(p) {
    const ticked = M.progress(p).done, lost = [];
    if (ticked) lost.push(`its checklist (${ticked} ${ticked === 1 ? 'step' : 'steps'} ticked)`);
    if (p.installDate) lost.push('the installation date');
    if (p.notes) lost.push('the notes');
    if (p.render) lost.push('the attached render');
    const list = lost.length > 1 ? lost.slice(0, -1).join(', ') + ' and ' + lost[lost.length - 1] : lost[0];
    return `Delete this project?${list ? ' This erases ' + list + '.' : ''} The quote and the customer are not touched. It cannot be undone.`;
  }
  function renderActions(p, done) {
    const host = $('pj-actions'), missing = M.STEPS.filter((s) => !M.done(p, s.key)).length;
    const kids = [];
    if (done) {
      const b = el('button', 'btn btn-ghost btn-sm', 'Reopen project'); b.type = 'button'; b.id = 'pj-reopen'; b.disabled = P.busy.has('complete'); b.onclick = () => completeProject(true); kids.push(b);
    } else if (P.confirm === 'complete') {
      const q = el('p', 'pjv-confirm', missing ? `${missing} ${missing === 1 ? 'step is' : 'steps are'} not ticked. Mark the project completed anyway?` : 'Mark this project completed?');
      const yes = el('button', 'btn btn-primary btn-sm', missing ? 'Complete anyway' : 'Mark completed'); yes.type = 'button'; yes.id = 'pj-complete-yes'; yes.onclick = () => completeProject(false);
      const no = el('button', 'btn btn-ghost btn-sm', 'Cancel'); no.type = 'button'; no.id = 'pj-complete-no'; no.onclick = () => { P.confirm = null; renderProject(); };
      const row = el('div', 'pjv-row'); row.append(yes, no); kids.push(q, row);
    } else {
      const b = el('button', 'btn btn-primary btn-sm', 'Mark project completed'); b.type = 'button'; b.id = 'pj-complete'; b.disabled = P.busy.has('complete');
      b.onclick = () => { P.confirm = 'complete'; renderProject(); }; kids.push(b);
    }
    if (P.confirm !== 'complete') {                                                         // a project can always be deleted, with whatever is in it
      if (P.confirm === 'remove') {
        const q = el('p', 'pjv-confirm', deleteWarning(p)); q.id = 'pj-remove-text';
        const yes = el('button', 'btn btn-ghost btn-sm qv-danger', 'Delete project'); yes.type = 'button'; yes.id = 'pj-remove-yes'; yes.onclick = removeProject;
        const no = el('button', 'btn btn-ghost btn-sm', 'Cancel'); no.type = 'button'; no.id = 'pj-remove-no'; no.onclick = () => { P.confirm = null; renderProject(); };
        const row = el('div', 'pjv-row'); row.append(yes, no); kids.push(q, row);
      } else {
        const b = el('button', 'linkbtn pjv-remove', 'Delete project…'); b.type = 'button'; b.id = 'pj-remove'; b.onclick = () => { P.confirm = 'remove'; renderProject(); }; kids.push(b);
      }
    }
    host.replaceChildren(...kids);
  }

  // ---------- the checklist, the details, completing, removing ----------
  async function setStep(key, done) {
    if (!P.project || P.busy.has(key)) return;
    P.busy.add(key); P.opt.set(key, done); renderProject();
    try { await run('setProjectStep', { id: P.project.id, step: key, done }); note(''); }
    catch (e) { P.opt.delete(key); note(e.message, 'err'); }
    P.busy.delete(key); if (P.project) renderProject();
  }
  async function saveDetails() {
    const p = P.project; if (!p || P.busy.has('save')) return;
    const e = edit(); P.busy.add('save'); P.saveMsg = 'Saving…'; renderSave(); $('pj-reload').hidden = true;
    try {
      await run('saveProject', { id: p.id, expectedRev: P.baseRev, installDate: e.date || null, notes: e.notes || null });
      P.dirty = false; P.saved = { rev: P.baseRev + 1, date: e.date, notes: e.notes }; P.saveMsg = 'Saved';
    } catch (err) {
      P.saveMsg = err.message; if (/changed by someone else/i.test(err.message)) $('pj-reload').hidden = false;
    }
    P.busy.delete('save'); renderProject();
  }
  async function completeProject(reopen) {
    const p = P.project; if (!p || P.busy.has('complete')) return;
    P.busy.add('complete'); renderProject();
    try { await run('completeProject', { id: p.id, reopen: !!reopen }); P.confirm = null; note(reopen ? 'The project is open again.' : 'The project is completed.'); }
    catch (e) { note(e.message, 'err'); }
    P.busy.delete('complete'); if (P.project) renderProject();
  }
  async function removeProject() {
    const p = P.project; if (!p) return;
    try { await run('removeProject', { id: p.id }); P.dirty = false; P.confirm = null; note('The project was deleted.'); location.hash = '#projects'; }
    catch (e) { note(e.message, 'err'); P.confirm = null; renderProject(); }
  }

  // ---------- the approved 3D render ----------
  function renderMessage(t, kind) { const m = $('pj-render-msg'); if (m) { m.textContent = t || ''; m.className = 'pjv-msg' + (kind === 'err' ? ' err' : ''); } }
  async function linkFor(id) { return run('projectRenderUrl', { id }); }
  function renderRenderBox(p, done) {
    const box = $('pj-render'), r = p.render;
    $('pj-attach').textContent = r ? 'Replace render' : 'Attach render'; $('pj-attach').disabled = done || P.busy.has('render');
    $('pj-render-open').hidden = !r; $('pj-render-open').textContent = r && r.mime === 'application/pdf' ? 'Open PDF' : 'Open full size';
    if (!r) { P.renderKey = null; P.renderUrl = null; box.replaceChildren(el('p', 'pjv-sub', 'No render attached yet. Attach the approved 3D render (a picture or a PDF).')); return; }
    const key = r.path;
    if (P.renderKey === key) return;                                           // already shown: do not fetch again for every live update
    P.renderKey = key; P.renderUrl = null;
    const info = el('div', 'pj-render-info', `${r.filename || 'Render'}${r.by ? ' · attached by ' + r.by : ''}`);
    box.replaceChildren(el('p', 'pjv-sub', 'Loading the render…'), info);
    linkFor(p.id).then((l) => {
      if (P.renderKey !== key) return; P.renderUrl = l.url;
      if (l.mime === 'application/pdf') box.replaceChildren(el('p', 'pj-pdf', 'PDF: ' + (l.filename || 'render.pdf')), info);
      else { const img = el('img', 'pj-render-img'); img.alt = 'Approved 3D render'; img.id = 'pj-render-img'; img.src = l.url; box.replaceChildren(img, info); }
    }).catch((e) => { if (P.renderKey === key) { box.replaceChildren(el('p', 'pjv-sub', 'The render could not be shown: ' + e.message), info); P.renderKey = null; } });
  }
  async function openRender() {
    const p = P.project; if (!p || !p.render) return;
    const w = window.open('', '_blank'); renderMessage('Opening…');
    try { const l = await linkFor(p.id); renderMessage(''); if (w) { w.opener = null; w.location = l.url; } else window.open(l.url, '_blank'); }
    catch (e) { if (w) w.close(); renderMessage(e.message, 'err'); }
  }
  async function attachRender(f) {
    const p = P.project; if (!p || P.busy.has('render')) return;
    if (!RENDER_TYPES.includes(f.type)) { renderMessage('Attach the render as a JPG, PNG or WebP picture, or a PDF.', 'err'); return; }
    if (f.size > RENDER_MAX) { renderMessage('That file is too big (max 25 MB).', 'err'); return; }
    if (!f.size) { renderMessage('That file is empty.', 'err'); return; }
    P.busy.add('render'); renderProject(); renderMessage('Uploading…');
    try {
      const path = `uploads/${auth.currentUser.uid}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${f.name.replace(/[^\w.\-]/g, '_')}`;
      await firebase.storage().ref(path).put(f, { contentType: f.type });
      renderMessage('Checking the file…');
      await run('attachProjectRender', { id: p.id, uploadPath: path, filename: f.name });
      renderMessage('The render is attached.'); P.renderKey = null;
    } catch (e) { renderMessage(e.message, 'err'); }
    P.busy.delete('render'); if (P.project) renderProject();
  }

  // ---------- the customer profile block, and "New project" ----------
  function setCustMsg(text, kind) { const m = $('d-projects-msg'); m.textContent = text || ''; m.className = 'd-msg' + (kind ? ' ' + kind : ''); }
  function watchCustomer(id) {
    if (P.unsubCust) { P.unsubCust(); P.unsubCust = null; }
    P.customer = id || null; P.custList = []; P.custLoaded = false; setCustMsg('');
    renderCustomer();
    if (!id) return;
    P.unsubCust = db.collection('projects').where('phone', '==', id).onSnapshot((snap) => {
      if (P.customer !== id) return;
      P.custList = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt ? b.createdAt.toMillis() : 0) - (a.createdAt ? a.createdAt.toMillis() : 0));
      P.custLoaded = true; renderCustomer();
    }, (e) => { if (P.customer === id) { P.custLoaded = true; renderCustomer(); setCustMsg('Cannot load projects: ' + errText(e), 'err'); } });
  }
  function renderCustomer() {
    const host = $('d-projects-list');
    $('d-project-new').disabled = !P.customer;
    if (!P.customer) { host.replaceChildren(); return; }
    if (!P.custLoaded) { host.replaceChildren(el('p', 'd-appts-none', 'Loading…')); return; }
    if (!P.custList.length) { host.replaceChildren(el('p', 'd-appts-none', 'No projects yet.')); return; }
    host.replaceChildren(...P.custList.map((p) => {
      const b = el('button', 'd-quote'); b.type = 'button'; b.dataset.id = p.id;
      const st = M.statusOf(p), top = el('span', 'd-quote-top'), chip = el('span', 'qchip', st.label); chip.dataset.pstatus = st.key;
      top.append(el('span', 'd-quote-ref', p.quoteRef || 'No quote'), chip);
      const wait = M.waitingFor(p).map((w) => (w === 'carcasses' ? 'carcasses' : 'doors'));
      b.append(top, el('span', 'd-appt-sub', [p.installDate ? 'Install ' + M.dateLabel(p.installDate) : 'No installation date', wait.length ? 'To order: ' + wait.join(', ') : ''].filter(Boolean).join(' · ')));
      b.onclick = () => { P.cameFrom = '#c/' + p.phone; location.hash = '#projects/' + p.id; };
      return b;
    }));
  }
  // Accepted quotes of this customer that have no project yet: the ones a new project can be linked to.
  function linkable() {
    const have = new Set(P.custList.map((p) => p.quoteId).filter(Boolean));
    return ((window.QUOTES && QUOTES.custList) || []).filter((q) => q.status === 'accepted' && q.acceptedOption && !have.has(q.id));
  }
  function openNew() {
    const phone = P.customer; if (!phone) return;
    const c = S.convs.find((x) => x.id === phone), list = linkable(), host = $('np-quotes');
    $('np-who').textContent = (c && c.name) || formatPhone(phone);
    $('np-err').textContent = '';
    const rows = [{ id: '', label: 'No quote (a project with nothing linked)' }, ...list.map((q) => ({ id: q.id, label: `${q.ref} · ${q.acceptedOption.name || 'accepted'}${q.acceptedOption.incVat != null ? ' · ' + eur(q.acceptedOption.incVat) : ''}` }))];
    host.replaceChildren(...rows.map((r, i) => {
      const l = el('label', 'q-radio'), inp = el('input'); inp.type = 'radio'; inp.name = 'np-quote'; inp.value = r.id; inp.checked = list.length ? i === 1 : i === 0;
      l.append(inp, el('span', '', r.label)); return l;
    }));
    $('np-hint').textContent = list.length ? 'This customer has an accepted quote without a project. Choose it to link the project to it.' : 'This customer has no accepted quote without a project.';
    P.dlg = { phone, requestId: newRequestId() };
    showDialog($('np-dlg'));
  }
  $('d-project-new').onclick = openNew;
  $('np-cancel').onclick = () => { closeDialog($('np-dlg')); P.dlg = null; };
  $('np-form').addEventListener('submit', async (e) => {
    e.preventDefault(); const d = P.dlg; if (!d) return;
    const chosen = $('np-form').querySelector('input[name="np-quote"]:checked'), b = $('np-go');
    b.disabled = true; $('np-err').textContent = '';
    try {
      const r = await run('createProject', { phone: d.phone, requestId: d.requestId, ...(chosen && chosen.value ? { quoteId: chosen.value } : {}) });
      closeDialog($('np-dlg')); P.dlg = null;
      if (r.existing) note('That quote already has a project. Here it is.');
      P.cameFrom = '#c/' + d.phone; location.hash = '#projects/' + r.id;
    } catch (err) { $('np-err').textContent = err.message; }
    b.disabled = false;
  });

  // ---------- wiring ----------
  $('pj-filter').addEventListener('click', (e) => { const b = e.target.closest('button[data-filter]'); if (b) { P.filter = b.dataset.filter; renderList(); } });
  for (const key of ['carcasses', 'doors']) $('pj-tile-' + key).addEventListener('click', () => { P.filter = P.filter === key ? 'active' : key; renderList(); });   // a tile is a filter; press it again to go back
  $('pj-search').addEventListener('input', (e) => { P.query = e.target.value; renderList(); });
  $('pj-back').onclick = () => {
    if (P.view === 'list') { location.hash = ''; return; }
    const back = P.cameFrom && P.cameFrom !== P.hash ? P.cameFrom : '#projects';
    location.hash = back;
  };
  $('to-projects').onclick = () => { location.hash = '#projects'; };
  $('nav-projects').addEventListener('click', (e) => { if (P.active && P.view === 'list') e.preventDefault(); });   // already here

  return Object.assign(P, { handles, show, hide, stop, mayLeave, watchCustomer });
})();
