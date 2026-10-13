'use strict';
// Elite Kitchens Lead OS: the Assistant (Phase 9.1, docs/AI.md). A read-only chat: it looks up customers, quotes, appointments and projects through the aiChat function and explains
// what it finds. It cannot change or send anything. The conversation lives only in this browser tab (sessionStorage), never on the server. Everything the assistant writes is drawn
// as plain text nodes (assistant-model.js turns the little markdown into a structure), so nothing it or a customer wrote can run as a page.
// The spending limit, the on/off switch and the customer-data gate are enforced on the server; this screen only shows them. Loaded after app.js (shares its helpers).
window.ASSIST = (() => {
  const M = window.AssistantModel;
  const KEY = 'ek-assistant';
  const A = { modelKey: null, active: false, status: null, statusLoaded: false, turns: [], busy: false, context: {}, pending: null, started: false, settingsOpen: false };
  const showDialog = (d) => { if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', ''); };
  const closeDialog = (d) => { if (typeof d.close === 'function') { if (d.open) d.close(); } else d.removeAttribute('open'); };

  // ---------- this tab's memory of the conversation ----------
  const uid = () => (auth.currentUser ? auth.currentUser.uid : null);
  function keep() { try { sessionStorage.setItem(KEY, JSON.stringify({ uid: uid(), turns: A.turns.filter((t) => !t.pending).slice(-40), context: A.context, model: A.modelKey })); } catch (e) { /* private window: the conversation just is not remembered */ } }
  function restore() {
    try {
      const v = JSON.parse(sessionStorage.getItem(KEY) || 'null');
      if (v && v.uid && v.uid === uid() && Array.isArray(v.turns)) A.turns = v.turns.filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string').slice(-40);
      if (v && v.uid && v.uid === uid() && v.context) A.context = M.contextOf(v.context);
      if (v && v.uid && v.uid === uid() && M.MODEL_KEYS.includes(v.model)) A.modelKey = v.model;
    } catch (e) { A.turns = []; A.context = {}; }
  }

  // ---------- routing ----------
  const handles = (hash) => hash === '#assistant';
  function setNav(on) {
    const n = $('nav-assistant');
    n.classList.toggle('active', on);
    if (on) { n.setAttribute('aria-current', 'page'); for (const id of ['nav-inbox', 'nav-pipeline', 'nav-appointments', 'nav-quotes', 'nav-projects']) { $(id).classList.remove('active'); $(id).removeAttribute('aria-current'); } }
    else { n.removeAttribute('aria-current'); $('nav-inbox').classList.add('active'); $('nav-inbox').setAttribute('aria-current', 'page'); }
  }
  // What is open in Elite OS at the moment the Assistant is opened: ids only. The server looks the names up itself.
  function openContext() {
    const c = {};
    if (S.selected) c.customerId = S.selected;
    if (window.QUOTES && QUOTES.active && QUOTES.id) { c.quoteId = QUOTES.id; if (QUOTES.quote && QUOTES.quote.phone) c.customerId = QUOTES.quote.phone; }
    if (window.PROJ && PROJ.active && PROJ.id) { c.projectId = PROJ.id; if (PROJ.project && PROJ.project.phone) c.customerId = PROJ.project.phone; }
    return M.contextOf(c);
  }
  function contextLabel() {
    const c = A.context, bits = [];
    if (c.customerId) { const k = S.convs.find((x) => x.id === c.customerId); bits.push((k && k.name) || formatPhone(c.customerId)); }
    if (c.quoteId) bits.push(window.QUOTES && QUOTES.quote && QUOTES.quote.id === c.quoteId ? QUOTES.quote.ref : 'this quote');
    if (c.projectId) bits.push('this project');
    return bits.join(' · ');
  }
  function show() {
    A.active = true; setNav(true);
    if (!A.started) { A.started = true; restore(); }
    if (A.pending) { A.context = A.pending; A.pending = null; }
    setView(); render(); loadStatus();
    setTimeout(() => { if (A.active) { toBottom(); if (!$('as-input').disabled && window.matchMedia && !matchMedia('(max-width: 899px)').matches) $('as-input').focus(); } }, 0);
  }
  function hide() { A.active = false; setNav(false); closeDialog($('as-dlg')); setView(); }
  function stop() { hide(); A.turns = []; A.context = {}; A.pending = null; A.status = null; A.statusLoaded = false; A.busy = false; A.started = false; $('as-input').value = ''; render(); }
  // Signing out forgets the conversation; a reload (which also passes through stop()) keeps it.
  function forget() { try { sessionStorage.removeItem(KEY); } catch (e) { /* nothing kept */ } }

  // ---------- status (switch, spending, data gate) ----------
  async function loadStatus() {
    try { A.status = (await call('aiStatus')()).data; } catch (e) { A.status = null; }
    A.statusLoaded = true; if (A.active) render();
  }

  // ---------- drawing ----------
  function draw(parts) { return parts.map((p) => (p.t === 'b' ? el('strong', '', p.s) : document.createTextNode(p.s))); }
  function bubble(t) {
    const d = el('div', 'as-msg ' + (t.error ? 'error' : t.role) + (t.pending ? ' pending' : ''));
    if (t.pending) { d.textContent = 'Looking…'; d.setAttribute('aria-busy', 'true'); return d; }
    if (t.role === 'user' || t.error) { d.textContent = t.text; return d; }
    for (const b of M.blocks(t.text)) {
      if (b.type === 'ul') { const ul = el('ul'); for (const it of b.items) { const li = el('li'); li.append(...draw(it)); ul.append(li); } d.append(ul); }
      else { const p = el('p'); p.append(...draw(b.parts)); d.append(p); }
    }
    return d;
  }
  function toBottom() { const s = $('as-scroll'); s.scrollTop = s.scrollHeight; }
  function render() {
    const mk = M.chosenModel(A.status, A.modelKey), n = M.notice(A.status, mk), b = M.budget(A.status || {});
    const box = $('as-notice'); box.hidden = !n.text; box.textContent = n.text; box.dataset.level = n.level;
    $('as-meter-fill').style.width = (A.status ? b.pct : 0) + '%'; $('as-meter').dataset.level = A.status ? b.level : 'ok'; $('as-meter').setAttribute('aria-valuenow', String(A.status ? b.pct : 0));
    $('as-meter-label').textContent = A.status ? b.label : (A.statusLoaded ? 'Spending unavailable' : '');
    const canAsk = (A.status ? n.ask : false) && !A.busy;
    $('as-input').disabled = !A.status || !n.ask; $('as-send').disabled = !canAsk; $('as-send').textContent = A.busy ? '…' : 'Ask';
    $('as-new').disabled = A.busy || !A.turns.length;
    $('as-empty').hidden = A.turns.length > 0;
    $('as-suggest').replaceChildren(...M.SUGGESTIONS.map((s) => { const x = el('button', '', s); x.type = 'button'; x.disabled = !canAsk; x.onclick = () => ask(s); return x; }));
    for (const btn of $('as-model').querySelectorAll('button')) { const m = M.modelOf(A.status, btn.dataset.model); btn.setAttribute('aria-pressed', String(btn.dataset.model === mk)); btn.disabled = A.busy; btn.title = btn.title.split(' (')[0] + (m && !m.ready && A.status ? ' (not checked yet)' : ''); }
    const ctx = contextLabel(); $('as-context').hidden = !ctx; $('as-context-text').textContent = ctx ? 'About: ' + ctx : '';
    const host = $('as-msgs'); host.replaceChildren();
    A.turns.forEach((t, i) => {
      host.append(bubble(t));
      if (t.role === 'assistant' && !t.pending && !t.error && ((t.tools && t.tools.length) || t.cost != null || t.model || t.model === null)) {
        const tr = el('div', 'as-trace', ''); for (const x of t.tools || []) tr.append(el('span', '', x));
        if (t.model) tr.append(el('span', '', (M.modelOf(A.status, t.model) || { label: t.model }).label));
        if (t.model === null) tr.append(el('span', '', 'No AI used'));
        if (t.cost != null && t.model !== null) tr.append(el('span', '', t.cost < 0.001 ? 'under €0.001' : M.eur(t.cost, 3)));
        if (M.canRetry(A.turns, i, A.status) && !A.busy) { const b = el('button', 'as-retry', 'Retry with Sonnet'); b.type = 'button'; b.onclick = () => retry(i); tr.append(b); }
        host.append(tr);
      }
    });
    toBottom();
  }

  // ---------- asking ----------
  async function ask(text) {
    text = String(text || '').trim();
    const mk = M.chosenModel(A.status, A.modelKey);
    if (!text || A.busy || !A.status || !M.notice(A.status, mk).ask) return;
    const history = M.historyOf(A.turns);
    A.turns.push({ role: 'user', text }); const p = { role: 'assistant', text: '', pending: true }; A.turns.push(p);
    $('as-input').value = ''; sizeInput();
    await send(text, history, mk, p, null);
    if (A.active && !matchMedia('(max-width: 899px)').matches) $('as-input').focus();
  }
  // "Retry with Sonnet": the same question and the same earlier conversation, once, with the other model. The old answer is replaced (put back if the retry fails). No automatic retries anywhere.
  async function retry(i) {
    if (A.busy || !M.canRetry(A.turns, i, A.status)) return;
    const q = A.turns[i - 1], old = A.turns[i], history = M.historyOf(A.turns.slice(0, i - 1)), p = { role: 'assistant', text: '', pending: true };
    A.turns[i] = p; await send(q.text, history, 'sonnet', p, old);
  }
  // One request to the server with ONE model. `slot` is the waiting bubble; `old` is the answer it replaces (a retry).
  async function send(text, history, modelKey, slot, old) {
    const context = M.contextOf(A.context);
    A.busy = true; render();
    try {
      const r = (await call('aiChat')({ message: text, history, model: modelKey, ...(Object.keys(context).length ? { context } : {}) })).data;
      A.turns[A.turns.indexOf(slot)] = { role: 'assistant', text: String(r.reply || ''), model: r.model === null ? null : (M.MODEL_KEYS.includes(r.model) ? r.model : modelKey), tools: (r.tools || []).map((x) => x.note).filter(Boolean).slice(0, 8), cost: typeof r.costEur === 'number' ? r.costEur : null };
      if (A.status && typeof r.monthSpentEur === 'number') A.status.monthSpentEur = r.monthSpentEur;
    } catch (e) {
      const i = A.turns.indexOf(slot), bad = { role: 'assistant', text: M.friendlyError(e), error: true };
      if (old) A.turns.splice(i, 1, old, bad); else A.turns[i] = bad;
      loadStatus();                                                               // a refusal usually means the switch, the budget or a model check changed: show it
    }
    A.busy = false; keep(); render();
  }
  function sizeInput() { const t = $('as-input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px'; }

  // ---------- settings ----------
  async function openSettings() {
    $('as-set-err').textContent = ''; $('as-set-spent').textContent = '…'; showDialog($('as-dlg'));
    try { A.status = (await call('aiStatus')()).data; } catch (e) { $('as-set-err').textContent = M.friendlyError(e); }
    const s = A.status || {};
    $('as-set-enabled').checked = !!s.enabled; $('as-set-month').value = s.monthlyCapEur != null ? s.monthlyCapEur : 15; $('as-set-day').value = s.dailyCapEur != null ? s.dailyCapEur : 2;
    $('as-set-data').checked = !!s.customerDataApproved; $('as-set-terms').checked = false; $('as-set-terms').closest('label').hidden = !!s.customerDataApproved || !$('as-set-data').checked;
    $('as-set-spent').textContent = M.eur(s.monthSpentEur || 0) + ' this month, ' + M.eur(s.daySpentEur || 0) + ' today';
    drawModels(s); const g = M.dataGate(s); $('as-set-data').disabled = g.disabled; $('as-set-data-hint').hidden = !g.hint; $('as-set-data-hint').textContent = g.hint;
    $('as-set-key').textContent = s.keyConfigured ? 'The connection to the AI provider is set up.' : 'The connection to the AI provider is not set up yet (the owner adds the key on the server).';
    render();
  }
  function drawModels(s) {
    const list = (s && s.models) || [];
    $('as-set-models').replaceChildren(...list.map((m) => { const li = el('li', m.ready ? 'good' : m.reason ? 'bad' : '', M.modelLine(m)); return li; }));
    $('as-set-check').disabled = !s || !s.keyConfigured;
  }
  $('as-set-check').onclick = async () => {
    const b = $('as-set-check'); b.disabled = true; b.textContent = 'Checking…'; $('as-set-err').textContent = '';
    try { A.status = (await call('aiCheckModels')()).data; drawModels(A.status); render(); } catch (err) { $('as-set-err').textContent = M.friendlyError(err); }
    b.textContent = 'Check models'; b.disabled = !A.status || !A.status.keyConfigured;
  };
  $('as-set-data').addEventListener('change', () => { const was = !!(A.status && A.status.customerDataApproved); $('as-set-terms').closest('label').hidden = was || !$('as-set-data').checked; });
  $('as-set-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const s = A.status || {}, patch = {}, month = Number($('as-set-month').value), day = Number($('as-set-day').value), data = $('as-set-data').checked;
    if ($('as-set-enabled').checked !== !!s.enabled) patch.enabled = $('as-set-enabled').checked;
    if (month !== s.monthlyCapEur) patch.monthlyCapEur = month;
    if (day !== s.dailyCapEur) patch.dailyCapEur = day;
    if (data !== !!s.customerDataApproved) {
      if (data && !$('as-set-terms').checked) { $('as-set-err').textContent = 'Tick the box that says the provider\'s data terms were checked, or leave real customer data switched off.'; return; }
      patch.customerDataApproved = data; if (data) patch.confirmDataTerms = true;
    }
    if (!Object.keys(patch).length) { closeDialog($('as-dlg')); return; }
    const b = $('as-set-save'); b.disabled = true; $('as-set-err').textContent = '';
    try { A.status = (await call('setAiSettings')(patch)).data; closeDialog($('as-dlg')); render(); }
    catch (err) { $('as-set-err').textContent = M.friendlyError(err); }
    b.disabled = false;
  });
  $('as-set-cancel').onclick = () => closeDialog($('as-dlg'));

  // ---------- wiring ----------
  $('as-form').addEventListener('submit', (e) => { e.preventDefault(); ask($('as-input').value); });
  $('as-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask($('as-input').value); } });
  $('as-input').addEventListener('input', sizeInput);
  $('as-new').onclick = () => { if (A.busy) return; A.turns = []; keep(); render(); $('as-input').focus(); };
  $('as-model').addEventListener('click', (e) => { const b = e.target.closest('button[data-model]'); if (!b || A.busy) return; A.modelKey = b.dataset.model; keep(); render(); });
  $('as-context-x').onclick = () => { A.context = {}; keep(); render(); };
  $('as-settings').onclick = openSettings;
  $('as-back').onclick = () => { location.hash = ''; };
  // The click that opens the Assistant first notes what is open (a customer, a quote, a project); the screen then changes.
  for (const id of ['nav-assistant', 'to-assistant']) $(id).addEventListener('click', (e) => { if (A.active) { e.preventDefault(); return; } A.pending = openContext(); }, true);

  return Object.assign(A, { handles, show, hide, stop, forget });
})();
