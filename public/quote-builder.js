'use strict';
// Elite Kitchens Lead OS: the quote builder (Phase 6, docs/QUOTES.md). It only collects the "answers" for the calculator
// "ek-packages" version 1 (public/quote-engine.js) and shows the problems the calculator finds. It knows nothing about statuses,
// the pipeline or documents: quotes.js mounts it, gives it a draft and reads its answers back. A future builder for another
// calculator is a new file with the same small API (supports, mount, figures), and nothing else has to change.
window.QuoteBuilder = (() => {
  const OPTIONS = [['ess', 'Essential'], ['prem', 'Premium'], ['pp', 'Premium Plus']];
  const PROJECTS = [['kitchen', 'Kitchen'], ['wardrobes', 'Wardrobes'], ['kitchen-wardrobes', 'Kitchen & wardrobes'], ['other', 'Other']];
  const INCLUDES = [['sink', 'Sink'], ['extractor', 'Extractor'], ['removal', 'Removal of the existing units'], ['electrical', 'Electrical work'], ['plumbing', 'Plumbing']];
  const DRAWERS = { none: 'No drawer boxes', cemux: 'Cemux Soft-Close', blum: 'Blum Merivobox' };
  const supports = (ref) => !!ref && ref.id === 'ek-packages' && ref.version === 1;
  const euro = (n) => (n == null ? '' : '€' + Number(n).toLocaleString('en-IE', { minimumFractionDigits: 0, maximumFractionDigits: 2 }));
  const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  let seq = 0;
  const uid = (p) => 'qb-' + p + '-' + (++seq);

  // An <input> for a whole count or an amount of money. Empty means "not filled in" (null).
  function numberField(label, field, { money = false, qty = false, hint = '' } = {}) {
    const wrap = mk('label', 'qb-field');
    const input = mk('input'); input.type = 'number'; input.min = '0';
    input.step = money ? '0.01' : qty ? '0.01' : '1'; input.inputMode = money || qty ? 'decimal' : 'numeric';
    input.dataset.field = field; input.dataset.kind = money ? 'money' : qty ? 'qty' : 'count';
    wrap.append(mk('span', 'qb-label', label));
    if (money) { const box = mk('span', 'qb-money'); box.append(mk('span', 'qb-cur', '€'), input); wrap.append(box); } else wrap.append(input);
    if (hint) wrap.append(mk('span', 'qb-hint', hint));
    return wrap;
  }
  const valueOf = (input) => (input.value.trim() === '' ? null : Number(input.value));
  const setNum = (input, v) => { input.value = v == null ? '' : String(v); };
  function check(label, field) {
    const wrap = mk('label', 'qb-check'), input = mk('input'); input.type = 'checkbox'; input.dataset.field = field;
    wrap.append(input, mk('span', null, label));
    return wrap;
  }

  // ---------- mount ----------
  // host: an empty element. draft: { answers, priceList, vatRate }. onChange(answers) after every edit.
  function mount(host, { answers, priceList, onChange }) {
    const root = mk('div', 'qb');
    const pl = priceList || {};
    const drawerHint = (k) => (k === 'none' ? DRAWERS.none : `${DRAWERS[k]} (${euro(pl.drawerBoxes && pl.drawerBoxes[k])} each)`);

    // Project: changes the wording of the quote only (e.g. "your new fitted wardrobes"), never a price.
    const project = mk('fieldset', 'qb-sec'); project.append(mk('legend', null, 'Project'));
    const pGrid = mk('div', 'qb-grid');
    const pType = mk('label', 'qb-field'), pSel = mk('select'); pSel.dataset.field = 'project';
    for (const [k, label] of PROJECTS) pSel.append(new Option(label, k));
    pType.append(mk('span', 'qb-label', 'The quote is for'), pSel);
    const pName = mk('label', 'qb-field'), pInput = mk('input'); pInput.maxLength = 40; pInput.dataset.field = 'projectName'; pInput.placeholder = 'e.g. utility room';
    pName.append(mk('span', 'qb-label', 'What is it?'), pInput, mk('span', 'qb-hint', 'Printed as "your new …". Empty: "your new fitted furniture".'));
    pGrid.append(pType, pName);
    project.append(pGrid, mk('p', 'qb-note', 'Sets the wording of the quote (what is included and not included). Prices are not affected.'));

    // Counts
    const kitchen = mk('fieldset', 'qb-sec'); kitchen.append(mk('legend', null, 'Doors and boxes'));
    const kGrid = mk('div', 'qb-grid');
    kGrid.append(numberField('Doors', 'doors'), numberField('Top boxes', 'topBoxes'), numberField('Drawers', 'drawers'));
    kitchen.append(kGrid, mk('p', 'qb-note', 'Counts stay internal: they are never printed on the quote.'));

    // Options
    const opts = mk('fieldset', 'qb-sec'); opts.append(mk('legend', null, 'Options'));
    const optionNodes = {};
    for (const [key, name] of OPTIONS) {
      const box = mk('div', 'qb-opt'); box.dataset.option = key;
      const head = check('Offer ' + name, `options.${key}.on`); head.classList.add('qb-opt-head');
      const body = mk('div', 'qb-opt-body');
      const grid = mk('div', 'qb-grid');
      const drawer = mk('label', 'qb-field');
      const sel = mk('select'); sel.dataset.field = `options.${key}.drawerBox`;
      for (const k of ['none', 'cemux', 'blum']) sel.append(new Option(drawerHint(k), k));
      drawer.append(mk('span', 'qb-label', 'Drawer boxes'), sel);
      grid.append(numberField('Price per door', `options.${key}.perDoor`, { money: true }), numberField('Price per top box', `options.${key}.perTopBox`, { money: true }), drawer);
      body.append(grid);
      if (key !== 'ess') {
        const d = mk('label', 'qb-field qb-wide');
        const ta = mk('textarea'); ta.rows = 3; ta.maxLength = 600; ta.dataset.field = `options.${key}.description`;
        ta.placeholder = key === 'prem' ? 'Lacquered or solid wood doors\nBlum soft-close hinges\nProfessional installation' : 'Lacquered or solid wood doors\nBlum soft-close hinges\nPremium add-on systems\nProfessional installation';
        d.append(mk('span', 'qb-label', 'Description on the quote (one item per line, up to 4; empty = the standard wording)'), ta);
        body.append(d);
      } else body.append(mk('p', 'qb-note', 'Essential always uses the standard wording: vinyl wrap or melamine doors, Blum soft-close hinges, installation.'));
      if (key === 'pp') {
        const ex = mk('div', 'qb-extras'); ex.dataset.list = 'options.pp.extras';
        ex.append(mk('h4', 'qb-sub', 'Premium Plus extras'), mk('div', 'qb-rows'), addMenu(true));
        body.append(ex);
      }
      box.append(head, body);
      opts.append(box);
      optionNodes[key] = { box, body };
    }

    // Shared by every option
    const shared = mk('fieldset', 'qb-sec'); shared.append(mk('legend', null, 'In every option'));
    const wt = mk('div', 'qb-grid');
    const wtOn = check('Worktop', 'worktop.on'); wtOn.classList.add('qb-inline');
    const wtPrice = numberField('Worktop price', 'worktop.price', { money: true });
    wt.append(wtOn, wtPrice);
    const glaze = mk('div', 'qb-grid');
    const g = pl.glazing || {};
    glaze.append(numberField('Small glazed door cabinets', 'glazing.small', { hint: euro(g.small) + ' each' }), numberField('Large glazed larder doors', 'glazing.large', { hint: euro(g.large) + ' each' }));
    const extras = mk('div', 'qb-extras'); extras.dataset.list = 'extras';
    extras.append(mk('h4', 'qb-sub', 'Extras'), mk('div', 'qb-rows'), addMenu(false));
    shared.append(wt, glaze, extras);

    // Included work / document
    const inc = mk('fieldset', 'qb-sec'); inc.append(mk('legend', null, 'Included'));
    const incGrid = mk('div', 'qb-checks');
    for (const [k, label] of INCLUDES) incGrid.append(check(label, `includes.${k}`));
    inc.append(incGrid);
    const doc = mk('fieldset', 'qb-sec'); doc.append(mk('legend', null, 'On the quote'));
    doc.append(check('Also show prices excluding VAT', 'showExVat'));

    root.append(project, kitchen, opts, shared, inc, doc);
    host.replaceChildren(root);

    // ---------- extras rows ----------
    function addMenu(forPP) {
      const wrap = mk('div', 'qb-add');
      const sel = mk('select', 'qb-add-select'); sel.setAttribute('aria-label', forPP ? 'Add a Premium Plus extra' : 'Add an extra');
      sel.append(new Option(forPP ? 'Add a Premium Plus extra…' : 'Add an extra…', ''));
      (pl.extras || []).forEach((e, i) => sel.append(new Option(e.name + (e.free ? (forPP ? ' (included free)' : '') : e.manual ? ' (enter price)' : ' (' + euro(e.price) + (e.unit ? ' ' + e.unit : '') + ')'), String(i))));
      sel.append(new Option('Custom item', 'custom'));
      if (forPP) sel.append(new Option('Free item (included at no charge)', 'free'));
      sel.onchange = () => {
        const v = sel.value; sel.value = '';
        if (!v) return;
        const list = wrap.closest('.qb-extras');
        let row;
        if (v === 'custom') row = { name: '', unit: '', qty: 1, unitPrice: null };
        else if (v === 'free') row = { name: '', free: true };
        else { const e = pl.extras[Number(v)]; row = e.free && forPP ? { name: e.name, unit: e.unit, free: true } : { name: e.name, unit: e.unit || '', qty: 1, unitPrice: e.manual || e.free ? null : e.price }; }
        const node = extraRow(row, forPP);
        list.querySelector('.qb-rows').append(node);
        (node.querySelector(row.name ? (row.unitPrice == null && !row.free ? '[data-k="unitPrice"]' : '[data-k="qty"]') : '[data-k="name"]') || node.querySelector('input')).focus();
        changed();
      };
      wrap.append(sel);
      return wrap;
    }
    function extraRow(e, forPP) {
      const row = mk('div', 'qb-row' + (e.free ? ' free' : ''));
      const name = mk('input'); name.dataset.k = 'name'; name.maxLength = 120; name.placeholder = 'Description'; name.value = e.name || ''; name.setAttribute('aria-label', 'Extra');
      row.dataset.unit = e.unit || '';
      if (e.free) {
        row.dataset.free = '1';
        row.append(name, mk('span', 'qb-free', 'Included at no charge'));
      } else {
        const qty = mk('input'); qty.type = 'number'; qty.min = '0'; qty.step = '0.01'; qty.inputMode = 'decimal'; qty.dataset.k = 'qty'; qty.setAttribute('aria-label', 'Quantity'); setNum(qty, e.qty);
        const price = mk('input'); price.type = 'number'; price.min = '0'; price.step = '0.01'; price.inputMode = 'decimal'; price.dataset.k = 'unitPrice'; price.setAttribute('aria-label', 'Price each'); price.placeholder = 'Price'; setNum(price, e.unitPrice);
        const q = mk('label', 'qb-mini'); q.append(mk('span', null, 'Qty'), qty);
        const p = mk('label', 'qb-mini'); p.append(mk('span', null, '€ each' + (e.unit ? ' (' + e.unit + ')' : '')), price);
        row.append(name, q, p);
      }
      const rm = mk('button', 'icon-btn qb-rm'); rm.type = 'button'; rm.setAttribute('aria-label', 'Remove ' + (e.name || 'this extra'));
      rm.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
      rm.onclick = () => { row.remove(); changed(); };
      row.append(rm);
      return row;
    }
    function readRows(list, forPP) {
      return [...root.querySelector(`.qb-extras[data-list="${list}"] .qb-rows`).children].map((row) => {
        const name = row.querySelector('[data-k="name"]').value;
        if (row.dataset.free === '1') return { name, unit: row.dataset.unit, free: true };
        const out = { name, unit: row.dataset.unit, qty: valueOf(row.querySelector('[data-k="qty"]')), unitPrice: valueOf(row.querySelector('[data-k="unitPrice"]')) };
        return forPP ? { ...out, free: false } : out;
      });
    }

    // ---------- read / write ----------
    const field = (f) => root.querySelector(`[data-field="${f}"]`);
    function read() {
      const options = {};
      for (const [key] of OPTIONS) {
        const o = { on: field(`options.${key}.on`).checked, perDoor: valueOf(field(`options.${key}.perDoor`)), perTopBox: valueOf(field(`options.${key}.perTopBox`)), drawerBox: field(`options.${key}.drawerBox`).value };
        if (key !== 'ess') o.description = field(`options.${key}.description`).value;
        if (key === 'pp') o.extras = readRows('options.pp.extras', true);
        options[key] = o;
      }
      return {
        project: field('project').value, projectName: field('projectName').value,
        doors: valueOf(field('doors')), topBoxes: valueOf(field('topBoxes')), drawers: valueOf(field('drawers')), options,
        worktop: { on: field('worktop.on').checked, price: valueOf(field('worktop.price')) },
        glazing: { small: valueOf(field('glazing.small')), large: valueOf(field('glazing.large')) },
        extras: readRows('extras', false),
        includes: Object.fromEntries(INCLUDES.map(([k]) => [k, field(`includes.${k}`).checked])),
        showExVat: field('showExVat').checked,
      };
    }
    function set(a) {
      a = a || {};
      field('project').value = a.project || 'kitchen'; field('projectName').value = a.projectName || '';
      for (const f of ['doors', 'topBoxes', 'drawers']) setNum(field(f), a[f]);
      for (const [key] of OPTIONS) {
        const o = (a.options && a.options[key]) || {};
        field(`options.${key}.on`).checked = !!o.on;
        setNum(field(`options.${key}.perDoor`), o.perDoor); setNum(field(`options.${key}.perTopBox`), o.perTopBox);
        field(`options.${key}.drawerBox`).value = o.drawerBox || 'none';
        if (key !== 'ess') field(`options.${key}.description`).value = o.description || '';
        if (key === 'pp') root.querySelector('.qb-extras[data-list="options.pp.extras"] .qb-rows').replaceChildren(...(o.extras || []).map((e) => extraRow(e, true)));
      }
      field('worktop.on').checked = !!(a.worktop && a.worktop.on); setNum(field('worktop.price'), a.worktop ? a.worktop.price : null);
      setNum(field('glazing.small'), a.glazing ? a.glazing.small : null); setNum(field('glazing.large'), a.glazing ? a.glazing.large : null);
      root.querySelector('.qb-extras[data-list="extras"] .qb-rows').replaceChildren(...(a.extras || []).map((e) => extraRow(e, false)));
      for (const [k] of INCLUDES) field(`includes.${k}`).checked = !!(a.includes && a.includes[k]);
      field('showExVat').checked = !!a.showExVat;
      layout();
    }
    // A switched-off option or worktop folds away (what was typed is kept).
    function layout() {
      for (const [key] of OPTIONS) {
        const on = field(`options.${key}.on`).checked;
        optionNodes[key].body.hidden = !on; optionNodes[key].box.classList.toggle('on', on);
      }
      wtPrice.hidden = !field('worktop.on').checked;
      pName.hidden = field('project').value !== 'other';
    }
    // Problems found by the calculator: the field goes red, and the message is shown next to it.
    function showErrors(errors) {
      root.querySelectorAll('[aria-invalid="true"]').forEach((n) => n.removeAttribute('aria-invalid'));
      root.querySelectorAll('.qb-err').forEach((n) => n.remove());
      for (const e of errors || []) {
        let target = field(e.field);
        const m = /^(extras|options\.pp\.extras)\.(\d+)\.(\w+)$/.exec(e.field);
        if (m) { const row = root.querySelector(`.qb-extras[data-list="${m[1]}"] .qb-rows`).children[+m[2]]; target = row && (row.querySelector(`[data-k="${m[3]}"]`) || row.querySelector('input')); }
        if (!target) continue;
        target.setAttribute('aria-invalid', 'true');
        const holder = target.closest('.qb-field, .qb-row, .qb-check');
        if (holder && !holder.querySelector('.qb-err')) holder.append(mk('span', 'qb-err', e.message));
      }
    }
    function changed() { layout(); if (onChange) onChange(read()); }
    root.addEventListener('input', changed);
    root.addEventListener('change', (e) => { if (!e.target.classList.contains('qb-add-select')) changed(); });
    set(answers);
    return { read, set, showErrors, focus: () => field('doors').focus(), destroy: () => host.replaceChildren() };
  }

  // ---------- the internal figures of a sent version (read-only, never printed) ----------
  // Shown under a sent quote so the job can be re-entered in the old app for its invoice (docs/QUOTES.md, Invoices).
  function figures(answers, priceList) {
    const a = answers || {}, pl = priceList || {}, rows = [];
    const add = (k, v) => rows.push([k, v]);
    const pr = PROJECTS.find(([k]) => k === (a.project || 'kitchen'));
    add('Project', (pr ? pr[1] : a.project) + (a.project === 'other' && a.projectName ? ' (' + a.projectName + ')' : ''));
    add('Doors · top boxes · drawers', [a.doors || 0, a.topBoxes || 0, a.drawers || 0].join(' · '));
    for (const [key, name] of OPTIONS) {
      const o = (a.options && a.options[key]) || {};
      if (!o.on) continue;
      add(name, `${euro(o.perDoor)} per door · ${euro(o.perTopBox)} per top box · ${DRAWERS[o.drawerBox || 'none']}` + (o.drawerBox && o.drawerBox !== 'none' && pl.drawerBoxes ? ` (${euro(pl.drawerBoxes[o.drawerBox])} each)` : ''));
      if (key === 'pp') for (const e of o.extras || []) add('Premium Plus extra', e.free ? `${e.name} (free)` : `${e.name} × ${e.qty} at ${euro(e.unitPrice)}`);
    }
    if (a.worktop && a.worktop.on) add('Worktop', euro(a.worktop.price));
    const gl = a.glazing || {};
    if (gl.small || gl.large) add('Glazed doors', `${gl.small || 0} small at ${euro(pl.glazing && pl.glazing.small)} · ${gl.large || 0} large at ${euro(pl.glazing && pl.glazing.large)}`);
    for (const e of a.extras || []) add('Extra', `${e.name} × ${e.qty} at ${euro(e.unitPrice)}`);
    const inc = INCLUDES.filter(([k]) => a.includes && a.includes[k]).map(([, l]) => l);
    add('Included', inc.length ? inc.join(', ') : '—');
    const dl = mk('dl', 'qb-figures');
    for (const [k, v] of rows) dl.append(mk('dt', null, k), mk('dd', null, v));
    return dl;
  }

  return { supports, mount, figures, newId: uid };
})();
