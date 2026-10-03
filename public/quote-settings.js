'use strict';
// Elite Kitchens Lead OS: the Quote Settings screen (Phase 6, docs/QUOTES.md). Prices for new quotes, the extras catalogue, VAT,
// how long a quote is valid, the business details printed on quotes, and the one-time starting quote number. The prices here
// only fill in NEW quotes: a quote keeps the prices it was made with. Saving goes through saveQuoteSettings / setQuoteNumbering.
// quotes.js shows this screen and passes in the live settings and numbering documents. Loaded after app.js (shares its helpers).
window.QuoteSettings = (() => {
  const OPTIONS = [['ess', 'Essential'], ['prem', 'Premium'], ['pp', 'Premium Plus']];
  const BUSINESS = [['tradingName', 'Business name', 100, 'Elite Kitchens'], ['signatureName', 'Signed by', 60, 'First name used to sign quotes'], ['phone', 'Phone', 40, ''],
    ['email', 'Email', 200, ''], ['web', 'Website', 200, ''], ['address', 'Address', 300, ''], ['vatNumber', 'VAT number', 40, '']];
  const T = { host: null, form: null, settings: null, counter: null, dirty: false, saving: false, onLeaveOk: null };
  const pad4 = (n) => String(n).padStart(4, '0');
  const num = (input) => (input.value.trim() === '' ? null : Number(input.value));

  function moneyInput(field, label) {
    const l = el('label', 'qs-field'); l.append(el('span', 'qb-label', label));
    const box = el('span', 'qb-money'), i = el('input'); i.type = 'number'; i.min = '0'; i.step = '0.01'; i.inputMode = 'decimal'; i.dataset.field = field;
    box.append(el('span', 'qb-cur', '€'), i); l.append(box);
    return l;
  }
  function textInput(field, label, max, placeholder, type) {
    const l = el('label', 'qs-field'); l.append(el('span', 'qb-label', label));
    const i = el('input'); i.maxLength = max; i.dataset.field = field; if (placeholder) i.placeholder = placeholder; if (type) i.type = type;
    l.append(i); return l;
  }
  function catalogueRow(e = {}) {
    const row = el('div', 'qs-row');
    const name = el('input'); name.maxLength = 120; name.placeholder = 'Name'; name.value = e.name || ''; name.dataset.k = 'name'; name.setAttribute('aria-label', 'Catalogue item');
    const unit = el('input'); unit.maxLength = 40; unit.placeholder = 'Unit, e.g. per metre'; unit.value = e.unit || ''; unit.dataset.k = 'unit'; unit.setAttribute('aria-label', 'Unit');
    const price = el('input'); price.type = 'number'; price.min = '0'; price.step = '0.01'; price.inputMode = 'decimal'; price.placeholder = 'Price'; price.dataset.k = 'price'; price.setAttribute('aria-label', 'Price');
    price.value = e.manual || e.free || e.price == null ? '' : String(e.price);
    const kind = el('select'); kind.dataset.k = 'kind'; kind.setAttribute('aria-label', 'Price type');
    kind.append(new Option('Fixed price', 'fixed'), new Option('Price entered on each quote', 'manual'), new Option('Included free (Premium Plus)', 'free'));
    kind.value = e.free ? 'free' : e.manual ? 'manual' : 'fixed';
    const sync = () => { price.disabled = kind.value !== 'fixed'; if (price.disabled) price.value = ''; };
    kind.onchange = sync; sync();
    row.dataset.key = e.key || '';
    const rm = el('button', 'icon-btn qb-rm'); rm.type = 'button'; rm.setAttribute('aria-label', 'Remove ' + (e.name || 'this item'));
    rm.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    rm.onclick = () => { row.remove(); markDirty(); };
    row.append(name, unit, price, kind, rm);
    return row;
  }

  function build() {
    const f = el('form', 'qs'); f.noValidate = true; f.autocomplete = 'off';
    const sec = (title, note) => { const s = el('fieldset', 'qb-sec'); s.append(el('legend', null, title)); if (note) s.append(el('p', 'qb-note', note)); f.append(s); return s; };
    const b = sec('Business details', 'Printed on every quote. No bank details: invoices stay in the old app for now.');
    const bg = el('div', 'qs-grid'); for (const [k, label, max, ph] of BUSINESS) bg.append(textInput('business.' + k, label, max, ph, k === 'email' ? 'email' : null)); b.append(bg);
    const q = sec('Quotes');
    const qg = el('div', 'qs-grid');
    const vat = el('label', 'qs-field'); vat.append(el('span', 'qb-label', 'VAT rate (%)')); const vi = el('input'); vi.type = 'number'; vi.min = '0'; vi.max = '100'; vi.step = '0.01'; vi.inputMode = 'decimal'; vi.dataset.field = 'vatRate'; vat.append(vi);
    const val = el('label', 'qs-field'); val.append(el('span', 'qb-label', 'Valid for (days)')); const di = el('input'); di.type = 'number'; di.min = '1'; di.max = '365'; di.step = '1'; di.inputMode = 'numeric'; di.dataset.field = 'validityDays'; val.append(di);
    qg.append(vat, val); q.append(qg);
    const p = sec('Prices for new quotes', 'They fill in a new quote, where you can still change them. Changing them never changes a quote that already exists.');
    const pt = el('div', 'qs-grid qs-prices');
    for (const [k, name] of OPTIONS) pt.append(moneyInput(`priceList.options.${k}.perDoor`, `${name}: per door`), moneyInput(`priceList.options.${k}.perTopBox`, `${name}: per top box`));
    pt.append(moneyInput('priceList.drawerBoxes.cemux', 'Cemux Soft-Close drawer box'), moneyInput('priceList.drawerBoxes.blum', 'Blum Merivobox drawer box'),
      moneyInput('priceList.glazing.small', 'Small glazed door cabinet'), moneyInput('priceList.glazing.large', 'Large glazed larder door'));
    p.append(pt);
    const c = sec('Extras catalogue', 'The extras offered when building a quote. On a quote each one can still be changed.');
    const rows = el('div', 'qs-rows'); rows.id = 'qs-catalogue';
    const add = el('button', 'btn btn-ghost btn-sm', 'Add item'); add.type = 'button'; add.id = 'qs-add';
    add.onclick = () => { rows.append(catalogueRow({})); rows.lastChild.querySelector('input').focus(); markDirty(); };
    c.append(rows, add);
    const foot = el('div', 'qs-foot'); const msg = el('div', 'd-msg'); msg.id = 'qs-msg'; msg.setAttribute('role', 'status');
    const save = el('button', 'btn btn-primary', 'Save settings'); save.type = 'submit'; save.id = 'qs-save';
    foot.append(msg, save); f.append(foot);
    f.addEventListener('input', markDirty);
    f.addEventListener('submit', (e) => { e.preventDefault(); saveSettings(); });

    // numbering: separate from the form, saved on its own
    const n = el('section', 'qs-numbering'); n.setAttribute('aria-labelledby', 'qs-num-title');
    n.append(el('h3', null, 'Quote numbers'));
    n.querySelector('h3').id = 'qs-num-title';
    const state = el('p', 'qb-note'); state.id = 'qs-num-state';
    const row = el('div', 'qs-num-row');
    const ni = el('input'); ni.type = 'number'; ni.min = '1'; ni.step = '1'; ni.inputMode = 'numeric'; ni.id = 'qs-next'; ni.setAttribute('aria-label', 'Next quote number');
    const nb = el('button', 'btn btn-ghost btn-sm', 'Set next number'); nb.type = 'button'; nb.id = 'qs-next-go';
    nb.onclick = setNumbering;
    row.append(el('span', 'qs-ek', 'EK-'), ni, nb);
    const nmsg = el('div', 'd-msg'); nmsg.id = 'qs-num-msg'; nmsg.setAttribute('role', 'status');
    n.append(state, row, el('p', 'qb-note', 'At go-live, set this to one more than the highest number the old quoting app used. It can only go up, so no two quotes ever share a number.'), nmsg);
    const wrap = el('div', 'qs-wrap'); wrap.append(f, n);
    return wrap;
  }

  const field = (k) => T.form.querySelector(`[data-field="${k}"]`);
  function fill(s) {
    s = s || {};
    const pl = s.priceList || {};
    for (const [k] of BUSINESS) field('business.' + k).value = (s.business && s.business[k]) || '';
    field('vatRate').value = s.vatRate == null ? '' : String(s.vatRate);
    field('validityDays').value = s.validityDays == null ? '30' : String(s.validityDays);
    const set = (k, v) => { field(k).value = v == null ? '' : String(v); };
    for (const [k] of OPTIONS) { set(`priceList.options.${k}.perDoor`, pl.options && pl.options[k] && pl.options[k].perDoor); set(`priceList.options.${k}.perTopBox`, pl.options && pl.options[k] && pl.options[k].perTopBox); }
    set('priceList.drawerBoxes.cemux', pl.drawerBoxes && pl.drawerBoxes.cemux); set('priceList.drawerBoxes.blum', pl.drawerBoxes && pl.drawerBoxes.blum);
    set('priceList.glazing.small', pl.glazing && pl.glazing.small); set('priceList.glazing.large', pl.glazing && pl.glazing.large);
    $('qs-catalogue').replaceChildren(...(pl.extras || []).map(catalogueRow));
    T.dirty = false; renderState();
  }
  function read() {
    const g = (k) => num(field(k));
    const options = Object.fromEntries(OPTIONS.map(([k]) => [k, { perDoor: g(`priceList.options.${k}.perDoor`), perTopBox: g(`priceList.options.${k}.perTopBox`) }]));
    const extras = [...$('qs-catalogue').children].map((row) => {
      const kind = row.querySelector('[data-k="kind"]').value, price = num(row.querySelector('[data-k="price"]'));
      const out = { name: row.querySelector('[data-k="name"]').value, unit: row.querySelector('[data-k="unit"]').value, manual: kind === 'manual', free: kind === 'free' };
      if (kind === 'fixed') out.price = price;
      if (row.dataset.key) out.key = row.dataset.key;
      return out;
    }).filter((e) => e.name.trim() || e.price != null);
    return {
      business: Object.fromEntries(BUSINESS.map(([k]) => [k, field('business.' + k).value])),
      vatRate: g('vatRate'), validityDays: g('validityDays'),
      priceList: { options, drawerBoxes: { cemux: g('priceList.drawerBoxes.cemux'), blum: g('priceList.drawerBoxes.blum') }, glazing: { small: g('priceList.glazing.small'), large: g('priceList.glazing.large') }, extras },
    };
  }
  function msg(text, kind) { const m = $('qs-msg'); m.textContent = text || ''; m.className = 'd-msg' + (kind ? ' ' + kind : ''); }
  function markDirty() { T.dirty = true; msg('Unsaved changes'); $('qs-save').disabled = false; }
  function showErrors(errors) {
    T.form.querySelectorAll('[aria-invalid="true"]').forEach((n) => n.removeAttribute('aria-invalid'));
    for (const e of errors || []) {
      const m = /^priceList\.extras\.(\d+)\.(\w+)$/.exec(e.field);
      const target = m ? ($('qs-catalogue').children[+m[1]] || {}).querySelector?.(`[data-k="${m[2]}"]`) : field(e.field);
      if (target) target.setAttribute('aria-invalid', 'true');
    }
  }
  async function saveSettings() {
    if (T.saving) return;
    T.saving = true; $('qs-save').disabled = true; msg('Saving…'); showErrors([]);
    const data = read();
    try {
      await call('saveQuoteSettings')({ ...data, expectedRev: T.settings ? T.settings.rev : 0 });
      T.dirty = false; msg('Saved', 'ok');
    } catch (err) {
      msg(errText(err), 'err'); $('qs-save').disabled = false;
      showErrors(err.details && err.details.errors);
      if (!(err.details && err.details.errors)) {
        const f = /VAT rate/.test(errText(err)) ? 'vatRate' : /valid for/i.test(errText(err)) ? 'validityDays' : /business name/.test(errText(err)) ? 'business.tradingName' : /email/i.test(errText(err)) ? 'business.email' : null;
        if (f) showErrors([{ field: f }]);
      }
    } finally { T.saving = false; }
  }
  function renderState() {
    if (!T.form) return;
    const c = T.counter || {};
    $('qs-num-state').textContent = c.next != null
      ? `The next quote will be EK-${pad4(c.next)}.`
      : `Numbering is not set up yet: quotes get test numbers (next: TEST-${pad4(c.testNext || 1)}).`;
    if (!$('qs-next').value || document.activeElement !== $('qs-next')) $('qs-next').value = c.next != null ? String(c.next) : '';
    $('qs-save').disabled = T.saving || (!!T.settings && !T.dirty);
  }
  async function setNumbering() {
    const next = num($('qs-next')), m = $('qs-num-msg');
    if (!Number.isInteger(next) || next < 1) { m.textContent = 'Enter a whole number, e.g. 34 for EK-0034.'; m.className = 'd-msg err'; return; }
    if (!window.confirm(`Set the next quote number to EK-${pad4(next)}? From then on it can only go up.`)) return;
    $('qs-next-go').disabled = true; m.textContent = 'Saving…'; m.className = 'd-msg';
    try { const r = (await call('setQuoteNumbering')({ next })).data; m.textContent = `The next quote will be ${r.ref}.`; m.className = 'd-msg ok'; }
    catch (err) { m.textContent = errText(err); m.className = 'd-msg err'; }
    finally { $('qs-next-go').disabled = false; }
  }

  // ---------- the API quotes.js uses ----------
  function show(host) {
    T.host = host;
    if (!T.form || !host.contains(T.form)) { host.replaceChildren(build()); T.form = host.querySelector('form.qs'); fill(T.settings); }
    renderState();
  }
  function update(settings, counter) {
    const prevRev = T.settings ? T.settings.rev : null;
    T.settings = settings; T.counter = counter;
    if (!T.form) return;
    if (!T.dirty) fill(settings);
    else if (settings && settings.rev !== prevRev) msg('Quote Settings were changed by someone else. Saving now would be refused: reload this screen.', 'err');
    renderState();
  }
  function stop() { T.form = null; T.settings = null; T.counter = null; T.dirty = false; if (T.host) T.host.replaceChildren(); }
  // Leaving with unsaved changes asks first (quotes.js calls this when the route changes).
  function mayLeave() {
    if (!T.form || !T.dirty) return true;
    if (!window.confirm('You have unsaved changes to Quote Settings. Leave without saving?')) return false;
    T.dirty = false; fill(T.settings); return true;
  }
  const isDirty = () => !!T.form && T.dirty;
  return { show, update, stop, mayLeave, isDirty };
})();
