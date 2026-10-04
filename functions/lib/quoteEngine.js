'use strict';
// Elite Kitchens Lead OS: the quote price calculator (Phase 6, docs/QUOTES.md). Pure functions only: no DOM, no Firebase and
// no prices in the code (prices come from the price list stored in the database). The same file runs in the browser, for
// live totals while typing, and on the server, which recalculates every save and stores only its own result.
// functions/lib/quoteEngine.js is the original. public/quote-engine.js must be an identical copy (a test checks it).
//
// Each calculator has an id and a version, and every quote records which one priced it, so a later calculator never
// re-prices an old quote. The rest of Elite OS reads only the "price sheet" a calculator returns, never its answers.
// Money is worked out exactly (whole numbers of 1/10,000 euro, then rounded half up), never with floating-point sums.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.QuoteEngine = factory();
})(this, function () {
  const LIMIT = { count: 999, money: 1000000, qty: 10000, lines: 50, name: 120, unit: 40, description: 600, catalogue: 100, projectName: 40 };
  const DRAWER_BOXES = ['none', 'cemux', 'blum'];
  const INCLUDES = ['sink', 'extractor', 'removal', 'electrical', 'plumbing'];
  // What the quote is for. It changes only the wording of the document, never a price.
  const PROJECTS = ['kitchen', 'wardrobes', 'kitchen-wardrobes', 'other'];

  // ---- exact money ----
  // Amounts are BigInt "units" of 1/10,000 euro: a price in cents times a quantity in hundredths is always a whole number.
  const U_PER_EURO = 10000n;
  const decimalsOk = (x, n) => { const s = x * 10 ** n; return Math.abs(s - Math.round(s)) < 1e-6; };
  const cents = (x) => BigInt(Math.round(x * 100));
  const hundredths = (x) => BigInt(Math.round(x * 100));
  const roundDiv = (n, d) => (2n * n + d) / (2n * d);                 // n >= 0: n / d rounded half up
  const euros2 = (u) => Number(roundDiv(u, 100n)) / 100;               // to the cent, for display and breakdowns
  const wholeEuros = (u) => Number(roundDiv(u, U_PER_EURO));

  // ---- input checks (every message is shown to staff as it is) ----
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const isMoney = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= LIMIT.money && decimalsOk(v, 2);
  const keepIfMoney = (v) => (isMoney(v) ? v : null);      // a hidden field (switched-off section): kept if valid, else ignored
  function checker() {
    const errors = [];
    const fail = (field, message) => { errors.push({ field, message }); return null; };
    function onlyKeys(v, allowed, field) {
      if (v == null) return {};
      if (!isObj(v)) return fail(field, 'Unexpected data.') || {};
      for (const k of Object.keys(v)) if (!allowed.includes(k)) fail(field ? `${field}.${k}` : k, `Unknown field: ${k}`);
      return v;
    }
    function count(v, field, label) {
      if (v == null || v === '') return 0;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > LIMIT.count) return fail(field, `${label} must be a whole number from 0 to ${LIMIT.count}.`) ?? 0;
      return v;
    }
    function money(v, field, label, required) {
      if (v == null || v === '') return required ? fail(field, `Enter ${label}.`) : null;
      if (!isMoney(v)) {
        return fail(field, `${label[0].toUpperCase() + label.slice(1)} must be an amount from €0 to €1,000,000 with at most 2 decimals.`);
      }
      return v;
    }
    function qty(v, field) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > LIMIT.qty || !decimalsOk(v, 2)) return fail(field, `Quantity must be a number from 0 to ${LIMIT.qty} with at most 2 decimals.`);
      return v;
    }
    function text(v, max, field, label) {          // null = refused (already reported)
      if (v == null) return '';
      if (typeof v !== 'string') return fail(field, `${label} must be text.`);
      const t = v.trim();
      if (t.length > max) return fail(field, `${label} is too long (max ${max} characters).`);
      return t;
    }
    function bool(v, field) {
      if (v == null) return false;
      if (typeof v !== 'boolean') return fail(field, 'Expected yes or no.') ?? false;
      return v;
    }
    function list(v, field, label) {
      if (v == null) return [];
      if (!Array.isArray(v)) return fail(field, `${label} must be a list.`) ?? [];
      if (v.length > LIMIT.lines) return fail(field, `At most ${LIMIT.lines} ${label.toLowerCase()} per quote.`) ?? [];
      return v;
    }
    return { errors, fail, onlyKeys, count, money, qty, text, bool, list };
  }

  // ======================================================================================================================
  // Calculator "ek-packages", version 1: the method of the original Elite Kitchens quoting app. Up to three options
  // (Essential, Premium, Premium Plus), each priced per door, per top box and per drawer box, plus items shared by every
  // option (worktop, glazed doors, extras) and Premium Plus's own extras. Totals including VAT are rounded to the nearest
  // euro, exactly as on that app's PDF (docs/QUOTES.md decision 11): a €0 price stays €0.
  // ======================================================================================================================
  const OPTION_KEYS = ['ess', 'prem', 'pp'];
  const OPTION_NAMES = { ess: 'Essential', prem: 'Premium', pp: 'Premium Plus' };
  const DRAWER_LABELS = { none: '', cemux: 'Cemux Soft-Close', blum: 'Blum Merivobox' };
  // Wording carried over unchanged from the original quote PDF. Essential's description is fixed; Premium and Premium Plus
  // use the description typed on the quote, or these when it is left empty.
  const STANDARD_DESCRIPTIONS = {
    ess: 'Vinyl wrap or melamine doors\nBlum soft-close hinges\nInstallation',
    prem: 'Lacquered or solid wood doors\nBlum soft-close hinges\nProfessional installation',
    pp: 'Lacquered or solid wood doors\nBlum soft-close hinges\nPremium add-on systems\nProfessional installation',
  };
  const WORKTOP_NOTE = 'Laminate worktops are not covered against water damage.';

  // Answers: what the builder collects. Normalised here, so the server stores a clean copy and the browser sees the same
  // messages. Missing sections mean "none"; a missing price for an option that is switched on is an error, never guessed.
  function validate(input) {
    const c = checker();
    const a = c.onlyKeys(input, ['project', 'projectName', 'doors', 'topBoxes', 'drawers', 'options', 'worktop', 'glazing', 'extras', 'includes', 'showExVat'], '');
    const out = {
      // No project means a kitchen (the original app's only wording). The name is used only for "Other" (e.g. "utility room").
      project: a.project == null ? 'kitchen' : PROJECTS.includes(a.project) ? a.project
        : c.fail('project', 'Choose Kitchen, Wardrobes, Kitchen & wardrobes or Other.') ?? 'kitchen',
      projectName: (c.text(a.projectName, LIMIT.projectName, 'projectName', 'The project name') ?? '').replace(/\s+/g, ' '),
      doors: c.count(a.doors, 'doors', 'Doors'),
      topBoxes: c.count(a.topBoxes, 'topBoxes', 'Top boxes'),
      drawers: c.count(a.drawers, 'drawers', 'Drawers'),
      options: {},
    };
    const opts = c.onlyKeys(a.options, OPTION_KEYS, 'options');
    for (const key of OPTION_KEYS) {
      const f = `options.${key}`, name = OPTION_NAMES[key];
      const allowed = ['on', 'perDoor', 'perTopBox', 'drawerBox'].concat(key === 'ess' ? [] : ['description']).concat(key === 'pp' ? ['extras'] : []);
      const o = c.onlyKeys(opts[key], allowed, f);
      const on = c.bool(o.on, `${f}.on`);
      // A switched-off option keeps what was typed (so switching it back on restores it), but nothing in it is required.
      const price = (v, field, label) => (on ? c.money(v, field, label, true) : keepIfMoney(v));
      const opt = {
        on,
        perDoor: price(o.perDoor, `${f}.perDoor`, `a price per door for ${name}`),
        perTopBox: price(o.perTopBox, `${f}.perTopBox`, `a price per top box for ${name}`),
        drawerBox: DRAWER_BOXES.includes(o.drawerBox) ? o.drawerBox
          : (o.drawerBox == null || !on ? 'none' : c.fail(`${f}.drawerBox`, 'Choose No drawers, Cemux or Blum.') ?? 'none'),
      };
      if (key !== 'ess') opt.description = c.text(o.description, LIMIT.description, `${f}.description`, `${name} description`) ?? '';
      if (key === 'pp') opt.extras = optionExtras(c, o.extras, `${f}.extras`);
      out.options[key] = opt;
    }
    const wt = c.onlyKeys(a.worktop, ['on', 'price'], 'worktop');
    const wtOn = c.bool(wt.on, 'worktop.on');
    out.worktop = { on: wtOn, price: wtOn ? c.money(wt.price, 'worktop.price', 'the worktop price', true) : (keepIfMoney(wt.price) ?? 0) };
    const gl = c.onlyKeys(a.glazing, ['small', 'large'], 'glazing');
    out.glazing = { small: c.count(gl.small, 'glazing.small', 'Small glazed doors'), large: c.count(gl.large, 'glazing.large', 'Large glazed larder doors') };
    out.extras = sharedExtras(c, a.extras, 'extras');
    const inc = c.onlyKeys(a.includes, INCLUDES, 'includes');
    out.includes = Object.fromEntries(INCLUDES.map((k) => [k, c.bool(inc[k], `includes.${k}`)]));
    out.showExVat = c.bool(a.showExVat, 'showExVat');
    return { ok: c.errors.length === 0, answers: out, errors: c.errors };
  }
  // Extras shared by every option. A completely empty row is dropped, and so is a row with a quantity of 0 (as in the
  // original app). A row with a price but no name is an error: dropping it would silently change the total.
  function sharedExtras(c, v, field) {
    const out = [];
    c.list(v, field, 'Extras').forEach((e, i) => {
      const f = `${field}.${i}`;
      const x = c.onlyKeys(e, ['name', 'unit', 'qty', 'unitPrice'], f);
      const name = c.text(x.name, LIMIT.name, `${f}.name`, 'Name');
      const unit = c.text(x.unit, LIMIT.unit, `${f}.unit`, 'Unit') ?? '';
      if (name === null) return;
      if (!name &&(x.unitPrice == null || x.unitPrice === 0 || x.unitPrice === '')) return;
      if (!name) { c.fail(`${f}.name`, 'Give this extra a name, or remove it.'); return; }
      const q = x.qty == null || x.qty === '' ? 0 : c.qty(x.qty, `${f}.qty`);
      const p = c.money(x.unitPrice, `${f}.unitPrice`, `a price for ${name}`, true);
      if (q === null || p === null || q === 0) return;
      out.push({ name, unit, qty: q, unitPrice: p });
    });
    return out;
  }
  // Premium Plus's own extras: the same, plus "free" items (included at no charge, always a quantity of 1).
  function optionExtras(c, v, field) {
    const out = [];
    c.list(v, field, 'Premium Plus extras').forEach((e, i) => {
      const f = `${field}.${i}`;
      const x = c.onlyKeys(e, ['name', 'unit', 'qty', 'unitPrice', 'free'], f);
      const name = c.text(x.name, LIMIT.name, `${f}.name`, 'Name');
      const unit = c.text(x.unit, LIMIT.unit, `${f}.unit`, 'Unit') ?? '';
      const free = c.bool(x.free, `${f}.free`);
      if (name === null) return;
      if (free) { if (name) out.push({ name, unit, qty: 1, unitPrice: 0, free: true }); return; }
      if (!name && (x.unitPrice == null || x.unitPrice === 0 || x.unitPrice === '')) return;
      if (!name) { c.fail(`${f}.name`, 'Give this extra a name, or remove it.'); return; }
      const q = x.qty == null || x.qty === '' ? 0 : c.qty(x.qty, `${f}.qty`);
      const p = c.money(x.unitPrice, `${f}.unitPrice`, `a price for ${name}`, true);
      if (q === null || p === null || q === 0) return;
      out.push({ name, unit, qty: q, unitPrice: p, free: false });
    });
    return out;
  }

  // The price list (Quote Settings). The calculation itself uses only the drawer box and glazed door prices; the option
  // defaults and the extras catalogue fill in a new quote.
  function validatePriceList(input) {
    const c = checker();
    const p = c.onlyKeys(input, ['options', 'drawerBoxes', 'glazing', 'extras'], '');
    const opts = c.onlyKeys(p.options, OPTION_KEYS, 'options');
    const out = { options: {} };
    for (const key of OPTION_KEYS) {
      const o = c.onlyKeys(opts[key], ['perDoor', 'perTopBox'], `options.${key}`);
      out.options[key] = { perDoor: c.money(o.perDoor, `options.${key}.perDoor`, `the default price per door for ${OPTION_NAMES[key]}`, true),
        perTopBox: c.money(o.perTopBox, `options.${key}.perTopBox`, `the default price per top box for ${OPTION_NAMES[key]}`, true) };
    }
    const d = c.onlyKeys(p.drawerBoxes, ['cemux', 'blum'], 'drawerBoxes');
    out.drawerBoxes = { cemux: c.money(d.cemux, 'drawerBoxes.cemux', 'the Cemux drawer box price', true), blum: c.money(d.blum, 'drawerBoxes.blum', 'the Blum drawer box price', true) };
    const g = c.onlyKeys(p.glazing, ['small', 'large'], 'glazing');
    out.glazing = { small: c.money(g.small, 'glazing.small', 'the small glazed door price', true), large: c.money(g.large, 'glazing.large', 'the large glazed larder door price', true) };
    out.extras = [];
    if (p.extras != null && !Array.isArray(p.extras)) c.fail('extras', 'The extras catalogue must be a list.');
    else if ((p.extras || []).length > LIMIT.catalogue) c.fail('extras', `At most ${LIMIT.catalogue} catalogue items.`);
    else (p.extras || []).forEach((e, i) => {
      const f = `extras.${i}`;
      const x = c.onlyKeys(e, ['key', 'name', 'unit', 'price', 'manual', 'free'], f);
      const key = x.key == null || x.key === '' ? '' : (typeof x.key === 'string' && /^[a-z0-9_-]{1,40}$/.test(x.key) ? x.key : c.fail(`${f}.key`, 'Bad catalogue key.') ?? '');
      const name = c.text(x.name, LIMIT.name, `${f}.name`, 'Name');
      if (name === '') c.fail(`${f}.name`, 'Every catalogue item needs a name.');
      const manual = c.bool(x.manual, `${f}.manual`), free = c.bool(x.free, `${f}.free`);
      const price = manual || free ? 0 : c.money(x.price, `${f}.price`, `a price for ${name || 'this item'}`, true);
      out.extras.push({ key, name: name ?? '', unit: c.text(x.unit, LIMIT.unit, `${f}.unit`, 'Unit') ?? '', price: price ?? 0, manual, free });
    });
    return { ok: c.errors.length === 0, priceList: out, errors: c.errors };
  }

  // The project of a new quote, from the customer's "Project type" (a dropdown in Elite OS, or the text of a Meta lead form).
  // Nothing recognisable means a kitchen; anything else is "Other" with no name, for staff to describe on the quote.
  function projectOf(projectType) {
    const t = String(projectType || '').trim().toLowerCase();
    const k = /kitchen/.test(t), w = /wardrobe|bedroom/.test(t);
    return k && w ? 'kitchen-wardrobes' : k ? 'kitchen' : w ? 'wardrobes' : t ? 'other' : 'kitchen';
  }
  // A new quote's answers: Essential on, the other options off, prices from the price list.
  function newAnswers(priceList, { projectType } = {}) {
    const pl = validatePriceList(priceList);
    if (!pl.ok) throw inputError('The price list is incomplete.', pl.errors);
    const opt = (key, on) => ({ on, perDoor: pl.priceList.options[key].perDoor, perTopBox: pl.priceList.options[key].perTopBox, drawerBox: 'none' });
    return {
      project: projectOf(projectType), projectName: '',
      doors: 0, topBoxes: 0, drawers: 0,
      options: { ess: opt('ess', true), prem: { ...opt('prem', false), description: '' }, pp: { ...opt('pp', false), description: '', extras: [] } },
      worktop: { on: false, price: 0 }, glazing: { small: 0, large: 0 }, extras: [],
      includes: Object.fromEntries(INCLUDES.map((k) => [k, false])), showExVat: false,
    };
  }

  // Reasons a quote cannot be sent yet (it can still be saved as a draft).
  function sendProblems(answers) {
    const v = validate(answers);
    if (!v.ok) return v.errors.map((e) => e.message);
    return OPTION_KEYS.some((k) => v.answers.options[k].on) ? [] : ['Choose at least one option (Essential, Premium or Premium Plus).'];
  }

  function vatBasisPoints(vatRate) {
    if (typeof vatRate !== 'number' || !Number.isFinite(vatRate) || vatRate < 0 || vatRate > 100 || !decimalsOk(vatRate, 2)) {
      throw inputError('The VAT rate must be a percentage from 0 to 100 with at most 2 decimals.', [{ field: 'vatRate', message: 'Bad VAT rate.' }]);
    }
    return BigInt(Math.round(vatRate * 100));
  }

  // The price sheet. Contains no door, top box or drawer counts and no per-unit prices, so none can reach a document.
  function calculate(answers, priceList, { vatRate } = {}) {
    const v = validate(answers);
    if (!v.ok) throw inputError('Some quote details need attention.', v.errors);
    const a = v.answers;
    const pl = validatePriceList(priceList);
    if (!pl.ok) throw inputError('The price list is incomplete.', pl.errors);
    const rates = pl.priceList;
    const bp = vatBasisPoints(vatRate);

    const lineU = (q, price) => hundredths(q) * cents(price);              // quantity x price, exact
    const eachU = (n, price) => BigInt(n) * cents(price) * 100n;          // whole count x price, exact
    const worktopU = a.worktop.on ? cents(a.worktop.price) * 100n : 0n;
    const glazingU = eachU(a.glazing.small, rates.glazing.small) + eachU(a.glazing.large, rates.glazing.large);
    const extrasU = a.extras.reduce((s, e) => s + lineU(e.qty, e.unitPrice), 0n);
    const sharedU = worktopU + glazingU + extrasU;
    const incVat = (netU) => Number(roundDiv(netU * (10000n + bp), 10000n * U_PER_EURO));

    const options = [];
    for (const key of OPTION_KEYS) {
      const o = a.options[key];
      if (!o.on) continue;
      const cabinetsU = eachU(a.doors, o.perDoor);
      const topBoxesU = eachU(a.topBoxes, o.perTopBox);
      const drawerBoxesU = o.drawerBox === 'none' ? 0n : eachU(a.drawers, rates.drawerBoxes[o.drawerBox]);
      const ownExtras = key === 'pp' ? o.extras : [];
      const ownExtrasU = ownExtras.reduce((s, e) => s + (e.free ? 0n : lineU(e.qty, e.unitPrice)), 0n);
      const netU = cabinetsU + topBoxesU + drawerBoxesU + ownExtrasU + sharedU;
      options.push({
        key, name: OPTION_NAMES[key],
        exVat: euros2(netU), exVatWhole: wholeEuros(netU), incVat: incVat(netU),
        lines: specLines(key, o, a, ownExtras),
        breakdown: { cabinets: euros2(cabinetsU), topBoxCabinets: euros2(topBoxesU), drawerBoxes: euros2(drawerBoxesU), ownExtras: euros2(ownExtrasU) },   // amounts only, for staff
      });
    }
    let dearest = null;
    for (const o of options) if (!dearest || o.incVat > dearest.incVat) dearest = o;
    const hasWorktop = worktopU > 0n;
    return {
      engine: { id: ID, version: VERSION }, currency: 'EUR', vatRate,
      options, dearest: dearest ? dearest.key : null,
      shared: { worktop: euros2(worktopU), glazing: euros2(glazingU), extras: euros2(extrasU) },
      document: documentWording(a, hasWorktop),
    };
  }

  // What each option card lists on the PDF: up to 4 description lines, the drawer boxes (unless the description already
  // names them), then Premium Plus's free items and its paid extras.
  function specLines(key, o, a, ownExtras) {
    const desc = key === 'ess' ? STANDARD_DESCRIPTIONS.ess : (o.description || STANDARD_DESCRIPTIONS[key]);
    const lines = desc.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 4);
    const drawer = DRAWER_LABELS[o.drawerBox];
    if (drawer && a.drawers > 0 && !lines.some((l) => l.toLowerCase().includes(drawer.toLowerCase()))) lines.push(drawer + ' drawer boxes');
    ownExtras.filter((e) => e.free).forEach((e) => lines.push(e.name));
    ownExtras.filter((e) => !e.free && e.qty > 0).forEach((e) => lines.push(e.name + (e.qty > 1 ? ' ×' + e.qty : '')));
    return lines;
  }

  // The lists of the PDF that depend on the answers. Paid items (sink, worktops, extras...) are kept apart from the work
  // included. A kitchen reads exactly as the original app's PDF; wardrobes and other projects leave out what cannot apply
  // (appliances, gas, plumbing for wardrobes) and name the right thing.
  const PROJECT_LISTS = {
    kitchen: { work: 'Kitchen cabinetry — supply and installation', removal: 'Removal of your existing kitchen',
      appliances: true, plumbing: true, gas: true, tiling: true, painting: 'Painting and decorating — best done once the kitchen is fitted' },
    wardrobes: { work: 'Fitted wardrobes — supply and installation', removal: 'Removal of your existing wardrobes',
      appliances: false, plumbing: false, gas: false, tiling: false, painting: 'Painting and decorating — best done once the wardrobes are fitted' },
    'kitchen-wardrobes': { work: 'Kitchen cabinetry and fitted wardrobes — supply and installation', removal: 'Removal of your existing kitchen and wardrobes',
      appliances: true, plumbing: true, gas: true, tiling: true, painting: 'Painting and decorating — best done once everything is fitted' },
    other: { work: 'Cabinetry — supply and installation', removal: 'Removal of your existing units',
      appliances: true, plumbing: true, gas: false, tiling: true, painting: 'Painting and decorating — best done once everything is fitted' },
  };
  function documentWording(a, hasWorktop) {
    const p = PROJECT_LISTS[a.project];
    const facts = [
      { label: 'Hinges & runners', value: 'Blum soft-close throughout' },
      { label: 'Panels & gables', value: 'Finished to match your door colour' },
      { label: 'Handles', value: 'From our standard range' },
    ];
    if (hasWorktop) facts.push({ label: 'Worktops', value: 'Supplied and fitted', note: WORKTOP_NOTE });
    const items = [];
    if (a.includes.sink) items.push('Sink');
    if (a.includes.extractor) items.push('Extractor');
    if (hasWorktop) items.push('Worktops');
    const s = a.glazing.small, l = a.glazing.large;
    if (s > 0) items.push(s + ' small glazed door cabinet' + (s > 1 ? 's' : ''));
    if (l > 0) items.push(l + ' large glazed larder door' + (l > 1 ? 's' : ''));
    a.extras.forEach((e) => items.push(e.name + (e.qty > 1 ? ' ×' + e.qty : '')));
    const workIncluded = [p.work];
    if (a.includes.removal) workIncluded.push(p.removal);
    if (a.includes.electrical) workIncluded.push('Electrical work');
    if (a.includes.plumbing) workIncluded.push('Plumbing');
    const notIncluded = [];
    if (p.appliances) notIncluded.push('Appliances');
    if (!a.includes.electrical) notIncluded.push('Electrical work');
    if (!a.includes.plumbing && p.plumbing) notIncluded.push('Plumbing');
    if (p.gas) notIncluded.push('Gas disconnection and reconnection — arranged by you with a registered RGI installer');
    if (p.tiling) notIncluded.push('Tiling & flooring');
    notIncluded.push(p.painting, 'Skip and waste removal — arranged by you');
    return { project: { type: a.project, name: a.project === 'other' ? a.projectName : '' }, facts, items, workIncluded, notIncluded, showExVat: a.showExVat };
  }

  const ID = 'ek-packages', VERSION = 1;
  const EK_PACKAGES_V1 = Object.freeze({ id: ID, version: VERSION, OPTION_KEYS, OPTION_NAMES, PROJECTS, validate, validatePriceList, newAnswers, sendProblems, calculate });

  // ---- registry ----
  function inputError(message, errors) { const e = new Error(message); e.name = 'QuoteInputError'; e.errors = errors; return e; }
  const ENGINES = { 'ek-packages@1': EK_PACKAGES_V1 };
  const CURRENT = Object.freeze({ id: ID, version: VERSION });
  function get(ref) {
    const e = ref && ENGINES[`${ref.id}@${ref.version}`];
    if (!e) throw inputError('Unknown quote calculator.', [{ field: 'engine', message: 'Unknown quote calculator.' }]);
    return e;
  }
  return { CURRENT, LIMIT, get, current: () => get(CURRENT) };
});
