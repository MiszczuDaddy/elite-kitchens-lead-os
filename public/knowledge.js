'use strict';
// Elite Kitchens Lead OS: the AI Knowledge Centre (Phase 9 Step C, docs/AI.md). What the receptionist may say about the business. The owner edits a DRAFT, tries questions on it (nothing is sent), publishes it,
// and can roll back; only the published version reaches customers. Everything is drawn as text nodes. Staff can read it; the server only lets the owner account change anything.
// Loaded after assistant.js (opened from Assistant settings). Uses the helpers of app.js.
window.KNOW = (() => {
  const friendly = (e) => String((e && e.message) || e || 'Something went wrong.').replace(/^(functions\/)?[\w-]+:\s*/, '').slice(0, 300);
  const S = { loaded: false, data: null, rev: 0, live: null, versions: [], canEdit: false, dirty: false, tab: 'know', busy: false, limits: {}, lineLabels: {}, defaultLines: {}, hasDraft: false, results: [], resultsFor: '' };
  const KIND_LABEL = { approved: 'Approved', never: 'Never promise', open: 'Open (not confirmed)' };
  const STATE_LABEL = { new: 'A new enquiry (welcome message only)', offered: 'After we offered a home visit', asked_days: 'After we asked about days', booked: 'A customer with a visit booked' };
  const showDialog = (d) => { if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', ''); };
  const closeDialog = (d) => { if (typeof d.close === 'function') { if (d.open) d.close(); } else d.removeAttribute('open'); };
  const when = (ms) => (ms ? new Date(ms).toLocaleString('en-IE', { timeZone: 'Europe/Dublin', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const rid = () => 'k' + Math.random().toString(16).slice(2, 12);
  const msg = (t, bad) => { const m = $('kn-msg'); m.textContent = t || ''; m.className = 'kn-msg' + (bad ? ' bad' : ''); };
  const blank = () => ({ sections: [], links: [], contact: { email: '', website: '', whatsapp: '' }, lines: { ...S.defaultLines }, instructions: '', examples: [] });
  const clone = (x) => JSON.parse(JSON.stringify(x));

  async function load(reportErr = true) {
    try {
      const g = (await call('aiKnowledge')({ action: 'get' })).data; apply(g);
    } catch (e) { if (reportErr) msg(friendly(e), true); }
  }
  function apply(g) {
    S.loaded = true; S.canEdit = !!g.canEdit; S.limits = g.limits || {}; S.lineLabels = g.lineLabels || {}; S.defaultLines = g.defaultLines || {}; S.live = g.live; S.versions = g.versions || [];
    S.hasDraft = !!g.draft; S.rev = g.draft ? g.draft.rev : 0; S.data = g.draft ? clone(g.draft.data) : (g.live ? clone(g.live.data) : blank()); S.dirty = false; S.basedOn = g.draft ? g.draft.basedOn : null; S.updatedAt = g.draft ? g.draft.updatedAt : null;
    if (!g.draft && g.live) S.hasDraft = false;
    render();
  }
  const touch = () => { S.dirty = true; head(); };

  // ---------- pieces ----------
  function field(label, node) { const l = el('label', 'kn-f'); l.append(el('span', 'kn-l', label), node); return l; }
  function input(value, on, { ph = '', max = 0 } = {}) { const i = el('input'); i.type = 'text'; i.value = value || ''; if (ph) i.placeholder = ph; if (max) i.maxLength = max; i.disabled = !S.canEdit; i.addEventListener('input', () => { on(i.value); touch(); }); return i; }
  function area(value, on, rows = 3, max = 0) { const t = el('textarea'); t.rows = rows; t.value = value || ''; if (max) t.maxLength = max; t.disabled = !S.canEdit; t.addEventListener('input', () => { on(t.value); touch(); }); return t; }
  function btn(text, cls, on) { const b = el('button', 'btn ' + cls + ' btn-sm', text); b.type = 'button'; b.addEventListener('click', on); return b; }

  function head() {
    const l = S.live, parts = [];
    parts.push(l ? `Live: version ${l.version}, published ${when(l.publishedAt)}${l.note ? ' (' + l.note + ')' : ''}` : 'Nothing is published yet: the receptionist is using only its built-in rules.');
    $('kn-live').textContent = parts[0];
    $('kn-draft').textContent = S.dirty ? 'You have unsaved changes.' : S.hasDraft ? `Draft saved${S.updatedAt ? ' ' + when(S.updatedAt) : ''}. Customers never see a draft.` : 'No draft yet.';
    $('kn-draft').className = 'kn-draft' + (S.dirty ? ' dirty' : '');
    $('kn-save').disabled = !S.canEdit || S.busy || !S.dirty; $('kn-publish').disabled = !S.canEdit || S.busy || S.dirty || !S.hasDraft;
    $('kn-publish').title = S.dirty ? 'Save the draft first' : '';
    $('kn-ro').hidden = S.canEdit;
    for (const b of document.querySelectorAll('.kn-tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === S.tab));
  }

  // ---------- the tabs ----------
  function knowTab() {
    const root = el('div');
    if (!S.hasDraft && !(S.data.sections || []).length) {
      const box = el('div', 'kn-empty'); box.append(el('p', null, 'There is no knowledge yet. The starting knowledge comes from the approved "Elite Kitchens – AI Knowledge Brain v1". It goes into your DRAFT only; nothing reaches customers until you publish it.'));
      const b = btn('Load the starting knowledge into my draft', 'btn-primary', () => act({ action: 'import' }, 'Starting knowledge loaded into the draft.')); b.disabled = !S.canEdit; box.append(b); root.append(box); return root;
    }
    const d = S.data;
    for (const sec of d.sections) {
      const det = el('details', 'kn-sec'); det.open = false; const sum = el('summary'); sum.append(el('span', null, sec.title), el('span', 'kn-count', ` ${sec.entries.length} ${sec.entries.length === 1 ? 'entry' : 'entries'}`)); det.append(sum);
      det.append(field('Section name', input(sec.title, (v) => { sec.title = v; sum.firstChild.textContent = v; })));
      for (const e of sec.entries) {
        const row = el('div', 'kn-entry kn-' + e.kind), kind = el('select'); kind.disabled = !S.canEdit;
        for (const k of ['approved', 'never', 'open']) { const o = el('option', null, KIND_LABEL[k]); o.value = k; kind.append(o); } kind.value = e.kind; kind.addEventListener('change', () => { e.kind = kind.value; row.className = 'kn-entry kn-' + e.kind; touch(); });
        row.append(field('Type', kind), field('Title', input(e.title, (v) => { e.title = v; }, { max: 140 })), field('What the receptionist may say / the rule (open items need no text)', area(e.text, (v) => { e.text = v; }, 3, 900)));
        const rm = btn('Delete entry', 'btn-ghost', () => { sec.entries = sec.entries.filter((x) => x !== e); touch(); render(); }); rm.disabled = !S.canEdit; row.append(rm); det.append(row);
      }
      const add = btn('Add an entry', 'btn-ghost', () => { sec.entries.push({ id: rid(), kind: 'approved', title: '', text: '' }); touch(); render(); openSec = sec.id; }); add.disabled = !S.canEdit;
      const del = btn('Delete this section', 'btn-ghost', () => { if (sec.entries.length && !confirm('Delete "' + sec.title + '" and its ' + sec.entries.length + ' entries from the draft?')) return; d.sections = d.sections.filter((x) => x !== sec); touch(); render(); }); del.disabled = !S.canEdit;
      det.append(el('div', 'kn-row', null)); det.lastChild.append(add, del); if (openSec === sec.id) det.open = true; det.addEventListener('toggle', () => { if (det.open) openSec = sec.id; });
      root.append(det);
    }
    const addSec = btn('Add a section', 'btn-ghost', () => { const s = { id: rid(), title: 'New section', entries: [] }; d.sections.push(s); openSec = s.id; touch(); render(); }); addSec.disabled = !S.canEdit; root.append(addSec);
    root.append(field('How to write (tone and style for the receptionist)', area(d.instructions, (v) => { d.instructions = v; }, 5, 3000)));
    root.append(el('p', 'hint', 'Approved = it may state this. Never promise = it must never say or imply this. Open = not confirmed: it says the team will check, and a person takes over. The consultation flow (offering a home visit once, asking about days only after the customer agrees), quiet hours and manual takeover are built in and cannot be changed here.'));
    return root;
  }
  let openSec = null;
  function linesTab() {
    const root = el('div'), d = S.data;
    root.append(el('h3', null, 'Lines the system sends by itself'), el('p', 'hint', 'The receptionist\'s own wording for these cases (no prices, numbers or addresses in them).'));
    for (const k of Object.keys(S.lineLabels)) { if (d.lines[k] == null && S.defaultLines[k]) d.lines[k] = S.defaultLines[k]; const w = field(S.lineLabels[k], input(d.lines[k], (v) => { d.lines[k] = v; }, { max: 220 })); root.append(w); }      // a line added since the draft was saved starts with its default
    root.append(el('h3', null, 'Portfolio links'), el('p', 'hint', 'Shared once per chat, only when the customer asks to see previous work, photos, styles or projects. The receptionist picks them; the address is typed here only.'));
    d.links.forEach((l, i) => { const row = el('div', 'kn-row2'); row.append(field('Name', input(l.label, (v) => { l.label = v; }, { max: 60 })), field('Address', input(l.url, (v) => { l.url = v; }, { ph: 'elitekitchens.ie', max: 160 })));
      const rm = btn('Remove', 'btn-ghost', () => { d.links.splice(i, 1); touch(); render(); }); rm.disabled = !S.canEdit; row.append(rm); root.append(row); });
    const add = btn('Add a link', 'btn-ghost', () => { d.links.push({ id: rid(), label: '', url: '' }); touch(); render(); }); add.disabled = !S.canEdit || d.links.length >= (S.limits.links || 8); root.append(add);
    root.append(el('h3', null, 'Contact details'), el('p', 'hint', 'Given only when the customer asks how to get in touch. They are already on WhatsApp, so the number is never repeated.'));
    root.append(field('Email', input(d.contact.email, (v) => { d.contact.email = v; }, { max: 120 })), field('Website', input(d.contact.website, (v) => { d.contact.website = v; }, { max: 120 })), field('WhatsApp number', input(d.contact.whatsapp, (v) => { d.contact.whatsapp = v; }, { max: 40 })));
    return root;
  }
  function tryTab() {
    const root = el('div'), d = S.data;
    root.append(el('p', 'hint', 'Ask a question as a customer would. The receptionist answers it exactly as it would for a real customer, with nothing sent and no chat touched. Each question costs about 1 to 2 cents of the AI budget.'));
    const src = el('select', null); src.id = 'kn-src'; for (const [v, t] of [['draft', 'Test my DRAFT'], ['live', 'Test what customers get now (published)']]) { const o = el('option', null, t); o.value = v; src.append(o); }
    const st = el('select'); st.id = 'kn-state'; for (const k of Object.keys(STATE_LABEL)) { const o = el('option', null, STATE_LABEL[k]); o.value = k; st.append(o); }
    const q = el('textarea'); q.id = 'kn-q'; q.rows = 2; q.maxLength = 400; q.placeholder = 'For example: how long does fitting take?';
    const go = btn('Try it', 'btn-primary', () => run([{ text: q.value, state: st.value }], src.value)); go.id = 'kn-try'; go.disabled = !S.canEdit;
    const row = el('div', 'kn-row'); row.append(field('Which knowledge', src), field('The customer is', st)); root.append(row, field('The customer writes', q), go);
    const res = el('div', 'kn-results'); res.id = 'kn-results'; root.append(res);
    root.append(el('h3', null, 'Example questions'), el('p', 'hint', 'Run them all after changing the knowledge. "Must not say" lists words that would be a failure if the reply contained them.'));
    d.examples.forEach((x, i) => { const r = el('div', 'kn-ex'); r.append(input(x.text, (v) => { x.text = v; }, { max: 300 }), input((x.mustNot || []).join(', '), (v) => { x.mustNot = v.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 6); }, { ph: 'must not say (comma separated)' }));
      const b1 = btn('Try', 'btn-ghost', () => run([{ text: x.text, state: x.state || 'new', mustNot: x.mustNot || [] }], src.value)); const b2 = btn('Remove', 'btn-ghost', () => { d.examples.splice(i, 1); touch(); render(); }); b2.disabled = !S.canEdit; b1.disabled = !S.canEdit; r.append(b1, b2); root.append(r); });
    const addEx = btn('Add an example', 'btn-ghost', () => { d.examples.push({ id: rid(), text: '', state: 'new', mustNot: [] }); touch(); render(); }); addEx.disabled = !S.canEdit || d.examples.length >= (S.limits.examples || 40);
    const all = btn('Run all examples', 'btn-primary', () => runAll(src.value)); all.id = 'kn-all'; all.disabled = !S.canEdit || !d.examples.length;
    const bar = el('div', 'kn-row'); bar.append(addEx, all); root.append(bar);
    if (S.results.length) drawResults(res);
    return root;
  }
  function drawResults(box) {
    box.replaceChildren();
    const bad = S.results.filter((r) => r.failed.length || r.blocked.length || r.warnings.length).length;
    if (S.results.length > 1) box.append(el('p', 'kn-sum', `${S.results.length} answers. ${bad ? bad + ' need a look (shown in red).' : 'None blocked or flagged.'}`));
    for (const r of S.results) {
      const c = el('div', 'kn-res' + (r.failed.length || r.blocked.length || r.warnings.length ? ' flag' : ''));
      c.append(el('div', 'kn-q', 'Customer: ' + r.question + (r.state !== 'new' ? ' [' + STATE_LABEL[r.state] + ']' : '')));
      c.append(el('div', 'kn-a', r.reply ? 'Receptionist: ' + r.reply : 'Receptionist: (sends nothing: a person takes over)'));
      const meta = [r.handover && r.handover.needed ? 'Hands over: ' + (r.handover.reason || 'yes') : 'No handover', 'Step: ' + r.step, r.answerState ? 'Answer: ' + r.answerState : null, r.topics.length ? 'Used: ' + r.topics.map((t) => t.title || t.id).join(', ') : null,
        r.blocked.length ? 'Blocked: ' + r.blocked.join('; ') : null, r.warnings.length ? 'Warnings: ' + r.warnings.join('; ') : null, r.failed.length ? 'FAILED: it said "' + r.failed.join('", "') + '"' : null].filter(Boolean);
      c.append(el('div', 'kn-meta', meta.join(' · '))); box.append(c);
    }
  }
  async function run(cases, source) {
    if (S.dirty) { msg('Save the draft first: a test uses the saved draft.', true); return; }
    cases = cases.filter((c) => c.text && c.text.trim()); if (!cases.length) { msg('Type a question first.', true); return; }
    S.busy = true; head(); msg('Asking…'); const out = [];
    try {
      for (let i = 0; i < cases.length; i += 4) { const r = (await call('aiKnowledgeTest')({ source, cases: cases.slice(i, i + 4) })).data; out.push(...r.results); S.results = [...out]; const b = $('kn-results'); if (b) drawResults(b); msg(`Done ${out.length} of ${cases.length}…`); }
      const cost = out.reduce((a, r) => a + (r.costEur || 0), 0); msg(`Done. That cost about €${cost.toFixed(2)} of the AI budget.`);
    } catch (e) { msg(friendly(e), true); }
    S.busy = false; head();
  }
  function runAll(source) { return run(S.data.examples.map((x) => ({ text: x.text, state: x.state || 'new', mustNot: x.mustNot || [] })), source); }
  function versionsTab() {
    const root = el('div'); root.append(el('h3', null, 'Published versions'), el('p', 'hint', 'Rolling back publishes an old version again as a new version. Your draft is not changed.'));
    if (!S.versions.length) root.append(el('p', 'hint', 'Nothing has been published yet.'));
    for (const v of S.versions) {
      const r = el('div', 'kn-ver'); r.append(el('span', null, `Version ${v.version} · ${when(v.publishedAt)}${v.note ? ' · ' + v.note : ''}${S.live && S.live.version === v.version ? ' · LIVE' : ''}`));
      const b = btn('Roll back to this', 'btn-ghost', () => { if (confirm('Publish version ' + v.version + ' again? Customers get it on their next message.')) act({ action: 'rollback', version: v.version }, 'Rolled back: version ' + v.version + ' is live again as a new version.'); }); b.disabled = !S.canEdit || (S.live && S.live.version === v.version); r.append(b); root.append(r);
    }
    root.append(el('h3', null, 'Draft'));
    const reset = btn('Put my draft back to what is live', 'btn-ghost', () => { if (confirm('Throw away the changes in your draft and start again from the live version?')) act({ action: 'reset' }, 'The draft is back to the live version.'); }); reset.disabled = !S.canEdit || !S.live;
    const imp = btn('Replace my draft with the starting knowledge', 'btn-ghost', () => { if (confirm('Replace your draft with the starting knowledge (from the approved PDF)? Your draft is overwritten; the live version is not changed.')) act({ action: 'import', replace: true }, 'Starting knowledge loaded into the draft.'); }); imp.disabled = !S.canEdit;
    const row = el('div', 'kn-row'); row.append(reset, imp); root.append(row); return root;
  }

  function render() {
    const body = $('kn-body'); body.replaceChildren(S.tab === 'lines' ? linesTab() : S.tab === 'try' ? tryTab() : S.tab === 'versions' ? versionsTab() : knowTab()); head();
  }
  async function act(payload, done) {
    S.busy = true; head(); msg('');
    try { const g = (await call('aiKnowledge')(payload)).data; apply(g); msg(done || ''); } catch (e) { msg(friendly(e), true); }
    S.busy = false; head();
  }
  async function save() { await act({ action: 'save', data: S.data, expectedRev: S.rev }, 'Draft saved. It is not live yet.'); }
  async function publish() {
    if (S.dirty) { msg('Save the draft first.', true); return; }
    const note = $('kn-note').value.trim();
    if (!confirm('Publish this draft? Customers get the new knowledge on their next message.')) return;
    await act({ action: 'publish', expectedRev: S.rev, note }, 'Published. The receptionist uses it from the next message.'); $('kn-note').value = '';
  }

  async function open() {
    S.tab = 'know'; msg(''); showDialog($('kn-dlg')); S.results = []; await load(); render();
  }
  function wire() {
    for (const b of document.querySelectorAll('.kn-tabs button')) b.addEventListener('click', () => { S.tab = b.dataset.tab; render(); });
    $('kn-save').addEventListener('click', save); $('kn-publish').addEventListener('click', publish);
    $('kn-close').addEventListener('click', () => { if (S.dirty && !confirm('You have unsaved changes. Close anyway?')) return; closeDialog($('kn-dlg')); });
    $('kn-dlg').addEventListener('cancel', (e) => { if (S.dirty && !confirm('You have unsaved changes. Close anyway?')) e.preventDefault(); });
    const o = $('as-know-open'); if (o) o.addEventListener('click', () => { closeDialog($('as-dlg')); open(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
  return { open, state: S };
})();
