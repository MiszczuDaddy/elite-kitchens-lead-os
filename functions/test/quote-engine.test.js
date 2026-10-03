// Phase 6 M1: the quote price calculator (functions/lib/quoteEngine.js), tested as plain functions. No emulator needed.
// Every price below is made up: real prices live in the database (Quote Settings), never in this repository.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const QE = require('../lib/quoteEngine');
const { legacyRates, legacyPdf, legacyToAnswers, legacyPriceList } = require('./legacy-quote-app');

const ENGINE_FILE = path.join(__dirname, '../lib/quoteEngine.js');
const BROWSER_FILE = path.join(__dirname, '../../public/quote-engine.js');
const eng = QE.current();

// Made-up price list and VAT used throughout.
const PL = {
  options: { ess: { perDoor: 110, perTopBox: 60 }, prem: { perDoor: 140, perTopBox: 65 }, pp: { perDoor: 150, perTopBox: 70 } },
  drawerBoxes: { cemux: 12, blum: 21 },
  glazing: { small: 45, large: 90 },
  extras: [{ key: 'bin', name: 'Pull-out bin', unit: 'per unit', price: 30 }, { key: 'pocket', name: 'Pocket door', unit: 'per opening', manual: true }, { key: 'sink', name: 'Composite sink', unit: 'included', free: true }],
};
const VAT = { vatRate: 13.5 };
const answers = (patch = {}) => {
  const a = eng.newAnswers(PL);
  for (const [k, v] of Object.entries(patch)) a[k] = v;
  return a;
};
const fieldsOf = (r) => r.errors.map((e) => e.field);
const throwsInput = (fn, field) => assert.throws(fn, (e) => e.name === 'QuoteInputError' && (!field || e.errors.some((x) => x.field === field)));

// ---- the two copies ----------------------------------------------------------------------------------------------------
test('the browser copy public/quote-engine.js is identical to functions/lib/quoteEngine.js', () => {
  assert.ok(fs.existsSync(BROWSER_FILE), 'public/quote-engine.js is missing');
  assert.ok(fs.readFileSync(BROWSER_FILE).equals(fs.readFileSync(ENGINE_FILE)), 'the two copies differ: copy functions/lib/quoteEngine.js over public/quote-engine.js');
});

test('loaded as a plain browser script it defines window.QuoteEngine and gives exactly the same price sheet', () => {
  const sandbox = {};
  vm.runInNewContext(fs.readFileSync(BROWSER_FILE, 'utf8'), sandbox);
  assert.ok(sandbox.QuoteEngine, 'QuoteEngine global not defined');
  const a = answers({ doors: 23, drawers: 4, worktop: { on: true, price: 615.5 } });
  a.options.pp.on = true;
  const inBrowser = sandbox.QuoteEngine.current().calculate(a, PL, VAT);
  assert.strictEqual(JSON.stringify(inBrowser), JSON.stringify(eng.calculate(a, PL, VAT)));
});

// ---- parity with the original quoting app's PDF --------------------------------------------------------------------------
// The original's Settings and in-code fallbacks, made up for the tests.
const ST = { gs_price: 410, gl_price: 870, dr_cemux: 55, dr_blum: 95 };
const D = { essPpd: 290, premPpd: 345, ppPpd: 355, tppd: 190, cemux: 52, blum: 97 };

function rng(seed) {   // mulberry32: the same "random" quotes on every run
  return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const DESCRIPTIONS = ['', 'Shaker doors\nBlum soft-close hinges', 'First\n\n  Second  \nThird\nFourth\nFifth', 'Handleless doors\nBlum Merivobox drawers\nInstallation',
  'Painted doors\r\nQuartz-ready carcasses\r\n', 'Cemux soft-close drawer boxes included'];
const NAMES = ['Pull-out bin', 'LED underpanel', 'Magic corner', 'Pocket door', 'Oak cutlery tray', 'Tall larder', 'Panel & plinth'];
function legacyQuote(r) {
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const chance = (p) => r() < p;
  const int = (max) => Math.floor(r() * (max + 1));
  const money = () => (chance(0.4) ? pick([0, 0.5, 19.99, 25, 99.99, 150, 199, 250.25, 301, 333.33, 412, 999.5, 1234.56]) : chance(0.5) ? int(900) : Math.round(r() * 90000) / 100);
  const qty = () => pick([1, 1, 1, 2, 3, 0.5, 1.5, 2.3, 0.1, 4.7, 0.25, 12]);
  const drawer = () => pick(['none', 'cemux', 'blum', undefined]);
  const pkg = (on, desc) => ({ on, ppd: chance(0.95) ? money() : undefined, tppd: chance(0.85) ? money() : undefined, drawer: drawer(), ...(desc ? { desc: pick(DESCRIPTIONS) } : {}) });
  const q = { id: 1, num: 1, cid: 1, doors: int(45) };
  if (chance(0.85)) q.topboxes = int(12);
  if (chance(0.9)) q.drawers = int(20);
  if (chance(0.8)) q.rates = { gs: money(), gl: money(), cemux: money(), blum: money() };
  else if (chance(0.3)) q.rates = { gs: money(), gl: money() };          // saved before drawer prices were frozen
  if (chance(0.92)) q.ess = pkg(chance(0.85), false);
  if (chance(0.7)) q.prem = pkg(chance(0.5), true);
  if (chance(0.7)) {
    q.pp = pkg(chance(0.5), true);
    q.pp.extras = Array.from({ length: int(4) }, () => (chance(0.3) ? { name: pick(NAMES), qty: 1, price: 0, unit: 'included', free: true } : { name: pick(NAMES), qty: qty(), price: money(), unit: '', free: false }));
  }
  if (chance(0.8)) { const on = chance(0.6); q.wt = { wtOn: on, wtP: on ? money() : 0 }; }
  if (chance(0.8)) q.glass = { sq: int(4), lq: int(2) };
  if (chance(0.8)) q.extras = Array.from({ length: int(5) }, () => ({ name: pick(NAMES), qty: qty(), price: money(), unit: pick(['per unit', 'per metre', '']) }));
  if (chance(0.9)) q.incl = { sink: chance(0.5), extractor: chance(0.5), removal: chance(0.5), electrical: chance(0.5), plumbing: chance(0.5) };
  q.showExVat = chance(0.3);
  return q;
}
// The three shapes the original app's own notes require every change to survive.
const SHAPES = {
  full: { id: 1, num: 88, cid: 1, doors: 24, drawers: 9, topboxes: 6, status: 'Sent', notes: 'internal',
    rates: { gs: 410, gl: 870, cemux: 55, blum: 95 },
    ess: { on: true, ppd: 290, tppd: 190, drawer: 'cemux' },
    prem: { on: true, ppd: 345, tppd: 195, drawer: 'blum', desc: 'Painted shaker doors\nBlum soft-close hinges\nProfessional installation' },
    pp: { on: true, ppd: 355, tppd: 200, drawer: 'blum', desc: '', extras: [{ name: 'Composite sink', qty: 1, price: 0, unit: 'included', free: true }, { name: 'LED underpanel', qty: 2.5, price: 280, unit: '', free: false }] },
    wt: { wtOn: true, wtP: 1450 }, glass: { sq: 2, lq: 1 },
    extras: [{ name: 'Pull-out bin', qty: 1, price: 240, unit: 'per unit' }, { name: 'Magic corner', qty: 2, price: 310, unit: 'per unit' }],
    incl: { sink: true, extractor: true, removal: true, electrical: true, plumbing: false }, showExVat: true },
  missingNewerFields: { id: 2, num: 12, cid: 1, doors: 18, drawers: 6, status: 'Sent', ess: { on: true, ppd: 280, drawer: 'cemux' }, prem: { on: true, ppd: 330, desc: '' },
    extras: [{ name: 'Pull-out bin', qty: 1, price: 240, unit: 'per unit' }] },
  bare: { id: 3, num: 3, cid: 1, doors: 14 },
};

function compare(q, label, stats) {
  const old = legacyPdf(q, ST, D);
  const pl = legacyPriceList(legacyRates(q, ST, D), D);
  const sheet = eng.calculate(legacyToAnswers(q, D), pl, VAT);
  if (!old) {          // the original refused to make a PDF without a package; Elite OS can save it but not send it
    assert.deepStrictEqual(sheet.options, [], label);
    assert.ok(eng.sendProblems(legacyToAnswers(q, D)).length, label);
    stats.noOption++; return;
  }
  assert.deepStrictEqual(sheet.options.map((o) => o.name), old.options.map((o) => o.name), `${label}: options`);
  sheet.options.forEach((o, i) => {
    const was = old.options[i];
    assert.deepStrictEqual(o.lines, was.lines, `${label}: ${o.name} card lines`);
    for (const [field, exact, oldValue] of [['incVat', was.exFloat * 1.135, was.incVat], ['exVatWhole', was.exFloat, was.exVatWhole]]) {
      if (o[field] === oldValue) continue;
      // Only allowed difference: the exact amount is exactly half a euro, the original's floating-point sum landed a hair
      // under it and it rounded down; Elite OS rounds the exact amount up, as "nearest euro" requires.
      const frac = exact - Math.floor(exact);
      assert.ok(Math.abs(frac - 0.5) < 1e-6 && o[field] === oldValue + 1, `${label}: ${o.name} ${field} ${o[field]} vs original ${oldValue}`);
      stats.halfEuro++;
    }
  });
  const dearest = sheet.options.reduce((m, o) => (o.incVat > m.incVat ? o : m));
  assert.strictEqual(sheet.dearest, dearest.key, `${label}: dearest`);
  for (const k of ['facts', 'inKitchen', 'workIncluded', 'notIncluded', 'showExVat']) assert.deepStrictEqual(sheet.document[k], old[k], `${label}: ${k}`);
  stats.compared++;
}

test('the three quote shapes from the original app\'s notes give the same figures and wording as its PDF', () => {
  const stats = { compared: 0, noOption: 0, halfEuro: 0 };
  for (const [name, q] of Object.entries(SHAPES)) compare(q, name, stats);
  assert.deepStrictEqual(stats, { compared: 3, noOption: 0, halfEuro: 0 });
  // A spot check by hand, so the reference itself is not the only witness. Full quote, Essential:
  // 24 doors x 290 + 6 top boxes x 190 + 9 Cemux x 55 = 8,595; shared = 1,450 worktop + 2 x 410 + 870 glazed + 240 + 2 x 310
  // extras = 4,000; net 12,595 -> x 1.135 = 14,295.325 -> 14,295
  const full = eng.calculate(legacyToAnswers(SHAPES.full, D), legacyPriceList(legacyRates(SHAPES.full, ST, D), D), VAT);
  assert.strictEqual(full.options[0].exVat, 12595);
  assert.strictEqual(full.options[0].incVat, 14295);
});

test('5,000 varied quotes: identical prices, option cards and wording to the original app\'s PDF', (t) => {
  const r = rng(20261003);
  const stats = { compared: 0, noOption: 0, halfEuro: 0 };
  for (let i = 0; i < 5000; i++) compare(legacyQuote(r), `quote #${i}`, stats);
  t.diagnostic(`compared ${stats.compared}, without any option ${stats.noOption}, half-euro rounding fixes ${stats.halfEuro}`);
  assert.ok(stats.compared > 4000, 'too few quotes had an option to compare');
});

// ---- rounding and exactness ----------------------------------------------------------------------------------------------
test('totals are rounded to the nearest euro and exactly half a euro rounds up', () => {
  for (const doors of [1, 3, 21, 63]) {          // 100 x an odd number: x 1.135 always ends in .50
    const a = answers({ doors });
    a.options.ess.perDoor = 100; a.options.ess.perTopBox = 0;
    const s = eng.calculate(a, PL, VAT);
    assert.strictEqual(s.options[0].incVat, 113.5 * doors + 0.5, `${doors} doors`);
  }
  const a = answers({ doors: 1 }); a.options.ess.perDoor = 1000.49; a.options.ess.perTopBox = 0;
  assert.strictEqual(eng.calculate(a, PL, VAT).options[0].exVatWhole, 1000);
  a.options.ess.perDoor = 1000.5;
  assert.strictEqual(eng.calculate(a, PL, VAT).options[0].exVatWhole, 1001);
});

test('money is exact: amounts in cents never pick up floating-point errors', () => {
  // €10.96 + €72.52 + €16.52 is exactly €100.00, so with 13.5% VAT it is €113.50, rounded to €114. Added up in floating
  // point, as the original app did, it comes to 99.99999999999999 and its PDF printed €113.
  assert.strictEqual(Math.round((0 + 1 * 10.96 + 1 * 72.52 + 1 * 16.52) * 1.135), 113, 'control: the floating-point sum misses');
  const a = answers({ doors: 0, extras: [{ name: 'A', qty: 1, unitPrice: 10.96 }, { name: 'B', qty: 1, unitPrice: 72.52 }, { name: 'C', qty: 1, unitPrice: 16.52 }] });
  const s = eng.calculate(a, PL, VAT);
  assert.strictEqual(s.shared.extras, 100);
  assert.strictEqual(s.options[0].exVat, 100);
  assert.strictEqual(s.options[0].incVat, 114);
  // Decimal quantities: 0.1 x €0.10 + 0.2 x €0.10 is exactly €0.03 (floating point: 0.030000000000000002).
  const b = answers({ doors: 0, extras: [{ name: 'A', qty: 0.1, unitPrice: 0.1 }, { name: 'B', qty: 0.2, unitPrice: 0.1 }] });
  assert.strictEqual(eng.calculate(b, PL, VAT).shared.extras, 0.03);
  // 2.5 m x €33.33 = €83.325: kept exact inside, shown to the cent as €83.33 (half a cent rounds up).
  const c = answers({ doors: 0, extras: [{ name: 'LED', qty: 2.5, unitPrice: 33.33 }] });
  assert.strictEqual(eng.calculate(c, PL, VAT).shared.extras, 83.33);
  assert.strictEqual(eng.calculate(c, PL, VAT).options[0].incVat, 95);    // 83.325 x 1.135 = 94.57...
});

test('a €0 price stays €0 (the original showed €300 / €360 per door instead in its quote list and invoices)', () => {
  const a = answers({ doors: 20, worktop: { on: true, price: 500 } });
  a.options.ess.perDoor = 0; a.options.ess.perTopBox = 0;
  a.options.prem = { ...a.options.prem, on: true, perDoor: 0, perTopBox: 0 };
  const s = eng.calculate(a, PL, VAT);
  assert.deepStrictEqual(s.options.map((o) => o.incVat), [568, 568]);    // only the worktop: 500 x 1.135 = 567.5 -> 568
  assert.strictEqual(s.options[1].breakdown.cabinets, 0);
  const z = answers({ doors: 0 }); z.options.ess.perDoor = 0; z.options.ess.perTopBox = 0;
  assert.strictEqual(eng.calculate(z, PL, VAT).options[0].incVat, 0);
});

test('VAT rate: taken from the quote, other rates work, invalid rates are refused', () => {
  const a = answers({ doors: 10 }); a.options.ess.perDoor = 100; a.options.ess.perTopBox = 0;
  assert.strictEqual(eng.calculate(a, PL, { vatRate: 23 }).options[0].incVat, 1230);
  assert.strictEqual(eng.calculate(a, PL, { vatRate: 0 }).options[0].incVat, 1000);
  assert.strictEqual(eng.calculate(a, PL, VAT).vatRate, 13.5);
  for (const vatRate of [undefined, -1, 101, 13.555, '13.5', NaN]) throwsInput(() => eng.calculate(a, PL, { vatRate }), 'vatRate');
});

// ---- the price sheet -------------------------------------------------------------------------------------------------------
test('the price sheet names its calculator and never contains counts or per-unit prices', () => {
  const a = answers({ doors: 37, topBoxes: 11, drawers: 13, glazing: { small: 2, large: 0 } });
  Object.assign(a.options.ess, { perDoor: 313.37, perTopBox: 171.17, drawerBox: 'blum' });
  Object.assign(a.options.pp, { on: true, perDoor: 323.41, perTopBox: 181.19, drawerBox: 'cemux', extras: [{ name: 'LED', qty: 3, unitPrice: 77.71 }] });
  const pl = { ...PL, drawerBoxes: { cemux: 19.19, blum: 29.29 }, glazing: { small: 43.43, large: 91.91 } };
  const s = eng.calculate(a, pl, VAT);
  assert.deepStrictEqual(s.engine, { id: 'ek-packages', version: 1 });
  assert.deepStrictEqual(s.engine, QE.CURRENT);
  const json = JSON.stringify(s);
  for (const unit of ['313.37', '171.17', '19.19', '29.29', '323.41', '181.19', '77.71', '43.43', '91.91']) assert.ok(!json.includes(unit), `per-unit price ${unit} leaked`);
  const keys = new Set(); JSON.parse(json, (k, v) => { keys.add(k); return v; });
  for (const k of ['doors', 'topBoxes', 'drawers', 'perDoor', 'perTopBox', 'qty', 'unitPrice', 'drawerBox', 'answers']) assert.ok(!keys.has(k), `sheet has "${k}"`);
  const words = JSON.stringify([s.options.map((o) => o.lines), s.document]);
  for (const n of ['37', '11', '13']) assert.ok(!new RegExp(`\\b${n}\\b`).test(words), `count ${n} appears in the wording`);
});

test('the same answers and price list always give the same sheet, and nothing passed in is changed', () => {
  const freeze = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && freeze(v)); return Object.freeze(o); };
  const a = answers({ doors: 12, drawers: 3, extras: [{ name: 'Bin', qty: 1, unitPrice: 30 }] });
  a.options.prem.on = true;
  const fa = freeze(structuredClone(a)), fpl = freeze(structuredClone(PL));
  const one = JSON.stringify(eng.calculate(fa, fpl, VAT));
  assert.strictEqual(JSON.stringify(eng.calculate(fa, fpl, VAT)), one);
  assert.deepStrictEqual(fa, a);
});

test('card lines: up to 4 description lines, drawer boxes unless already named, Premium Plus free items then paid extras', () => {
  const a = answers({ doors: 10, drawers: 2 });
  Object.assign(a.options.prem, { on: true, drawerBox: 'blum', description: 'One\nTwo\n\n Three \nFour\nFive' });
  Object.assign(a.options.pp, { on: true, drawerBox: 'blum', description: 'Doors\nBlum Merivobox drawers',
    extras: [{ name: 'LED', qty: 2.5, unitPrice: 10 }, { name: 'Sink', free: true, qty: 4, unitPrice: 99 }, { name: 'Bin', qty: 1, unitPrice: 5 }] });
  a.options.ess.drawerBox = 'cemux';
  const [ess, prem, pp] = eng.calculate(a, PL, VAT).options;
  assert.deepStrictEqual(ess.lines, ['Vinyl wrap or melamine doors', 'Blum soft-close hinges', 'Installation', 'Cemux Soft-Close drawer boxes']);
  assert.deepStrictEqual(prem.lines, ['One', 'Two', 'Three', 'Four', 'Blum Merivobox drawer boxes']);
  assert.deepStrictEqual(pp.lines, ['Doors', 'Blum Merivobox drawers', 'Sink', 'LED ×2.5', 'Bin']);
  assert.strictEqual(pp.breakdown.ownExtras, 30);       // the free sink adds nothing
  assert.deepStrictEqual(Object.keys(pp.breakdown), ['cabinets', 'topBoxCabinets', 'drawerBoxes', 'ownExtras']);
  const noDrawers = answers({ doors: 10, drawers: 0 }); noDrawers.options.ess.drawerBox = 'blum';
  assert.ok(!eng.calculate(noDrawers, PL, VAT).options[0].lines.some((l) => /drawer boxes/.test(l)));
});

test('document wording: worktop only when priced, glazed doors, extras, work included and not included', () => {
  const a = answers({ doors: 5, worktop: { on: true, price: 0 }, glazing: { small: 1, large: 3 }, extras: [{ name: 'Bin', qty: 2, unitPrice: 30 }, { name: 'Tray', qty: 1, unitPrice: 15 }],
    includes: { sink: true, extractor: false, removal: true, electrical: false, plumbing: true } });
  let d = eng.calculate(a, PL, VAT).document;
  assert.ok(!d.facts.some((f) => f.label === 'Worktops'), 'a €0 worktop is not mentioned (as in the original)');
  assert.deepStrictEqual(d.inKitchen, ['Sink', '1 small glazed door cabinet', '3 large glazed larder doors', 'Bin ×2', 'Tray']);
  assert.deepStrictEqual(d.workIncluded, ['Kitchen cabinetry — supply and installation', 'Removal of your existing kitchen', 'Plumbing']);
  assert.deepStrictEqual(d.notIncluded.slice(0, 2), ['Appliances', 'Electrical work']);
  assert.ok(!d.notIncluded.includes('Plumbing'));
  a.worktop.price = 900;
  d = eng.calculate(a, PL, VAT).document;
  assert.deepStrictEqual(d.facts.at(-1), { label: 'Worktops', value: 'Supplied and fitted', note: 'Laminate worktops are not covered against water damage.' });
  assert.strictEqual(d.inKitchen[1], 'Worktops');
  assert.ok(!JSON.stringify(d).match(/warrant|guarantee/i), 'no workmanship-warranty wording');
});

test('the dearest option is the one with the highest total including VAT', () => {
  const a = answers({ doors: 10, drawers: 5 });
  Object.assign(a.options.prem, { on: true, perDoor: 200 });
  Object.assign(a.options.pp, { on: true, perDoor: 150, extras: [{ name: 'X', qty: 1, unitPrice: 600 }] });
  const s = eng.calculate(a, PL, VAT);
  assert.strictEqual(s.dearest, 'pp');
  a.options.pp.on = false;
  assert.strictEqual(eng.calculate(a, PL, VAT).dearest, 'prem');
  a.options.ess.on = false; a.options.prem.on = false;
  assert.strictEqual(eng.calculate(a, PL, VAT).dearest, null);
});

// ---- answers: what is accepted, what is refused --------------------------------------------------------------------------
test('missing sections mean "none"; a missing price for a switched-on option is an error, never guessed', () => {
  const r = eng.validate({ doors: 14, options: { ess: { on: true, perDoor: 100, perTopBox: 50 } } });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepStrictEqual(r.answers.extras, []);
  assert.deepStrictEqual(r.answers.glazing, { small: 0, large: 0 });
  assert.deepStrictEqual(r.answers.worktop, { on: false, price: 0 });
  assert.strictEqual(r.answers.options.prem.on, false);
  assert.ok(eng.validate({}).ok);
  assert.deepStrictEqual(eng.calculate({}, PL, VAT).options, []);
  assert.deepStrictEqual(fieldsOf(eng.validate({ doors: 14, options: { ess: { on: true } } })), ['options.ess.perDoor', 'options.ess.perTopBox']);
  assert.deepStrictEqual(eng.validate({ options: { ess: { on: true } } }).errors[0].message, 'Enter a price per door for Essential.');
});

test('a switched-off option or worktop keeps valid values and ignores invalid ones in it', () => {
  let r = eng.validate({ options: { prem: { on: false, perDoor: 'abc', perTopBox: 120.5, drawerBox: 'blum', description: 'Kept' } }, worktop: { on: false, price: -5 } });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepStrictEqual(r.answers.options.prem, { on: false, perDoor: null, perTopBox: 120.5, drawerBox: 'blum', description: 'Kept' });
  assert.deepStrictEqual(r.answers.worktop, { on: false, price: 0 });
  r = eng.validate({ options: { pp: { on: false, drawerBox: 'oak' } } });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.strictEqual(r.answers.options.pp.drawerBox, 'none');
});

test('counts must be whole numbers from 0 to 999', () => {
  for (const bad of [-1, 1.5, 1000, '3', NaN, Infinity]) {
    assert.deepStrictEqual(fieldsOf(eng.validate({ doors: bad })), ['doors'], `doors ${bad}`);
    assert.deepStrictEqual(fieldsOf(eng.validate({ glazing: { small: bad } })), ['glazing.small'], `glazing ${bad}`);
  }
  assert.ok(eng.validate({ doors: 999, topBoxes: 0, drawers: '' }).ok);
});

test('prices must be €0 to €1,000,000 with at most 2 decimals; quantities 0 to 10,000 with at most 2 decimals', () => {
  const ess = (perDoor) => eng.validate({ options: { ess: { on: true, perDoor, perTopBox: 0 } } });
  for (const bad of [-0.01, 1000000.01, 10.005, '300', NaN, Infinity, true]) assert.deepStrictEqual(fieldsOf(ess(bad)), ['options.ess.perDoor'], `price ${bad}`);
  for (const good of [0, 0.01, 333.33, 1000000]) assert.ok(ess(good).ok, `price ${good}`);
  for (const bad of [-1, 10000.5, 0.005, '2']) assert.deepStrictEqual(fieldsOf(eng.validate({ extras: [{ name: 'X', qty: bad, unitPrice: 1 }] })), ['extras.0.qty'], `qty ${bad}`);
  assert.deepStrictEqual(fieldsOf(eng.validate({ options: { ess: { on: true, perDoor: 1, perTopBox: 1, drawerBox: 'oak' } } })), ['options.ess.drawerBox']);
});

test('extras: empty rows and quantity 0 are dropped; a priced row without a name or a named row without a price is an error', () => {
  let r = eng.validate({ extras: [{ name: '', unitPrice: null }, { name: 'Bin', qty: 0, unitPrice: 30 }, { name: '  Tray ', qty: 2, unitPrice: 15, unit: 'per drawer' }] });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepStrictEqual(r.answers.extras, [{ name: 'Tray', unit: 'per drawer', qty: 2, unitPrice: 15 }]);
  r = eng.validate({ extras: [{ name: '', qty: 1, unitPrice: 250 }] });
  assert.deepStrictEqual(r.errors, [{ field: 'extras.0.name', message: 'Give this extra a name, or remove it.' }]);
  // Stricter than the original, which priced a forgotten price at €0 without saying so.
  r = eng.validate({ extras: [{ name: 'Pocket door', qty: 1, unitPrice: null }] });
  assert.deepStrictEqual(r.errors, [{ field: 'extras.0.unitPrice', message: 'Enter a price for Pocket door.' }]);
  r = eng.validate({ options: { pp: { on: true, perDoor: 1, perTopBox: 1, extras: [{ name: 'Sink', free: true, qty: 3, unitPrice: 50 }, { free: true }, { name: 'LED', qty: 1 }] } } });
  assert.deepStrictEqual(r.errors, [{ field: 'options.pp.extras.2.unitPrice', message: 'Enter a price for LED.' }]);
  r = eng.validate({ options: { pp: { on: true, perDoor: 1, perTopBox: 1, extras: [{ name: 'Sink', free: true, qty: 3, unitPrice: 50 }, { free: true }] } } });
  assert.deepStrictEqual(r.answers.options.pp.extras, [{ name: 'Sink', unit: '', qty: 1, unitPrice: 0, free: true }]);
});

test('unknown fields, wrong types and over-long text are refused', () => {
  assert.deepStrictEqual(fieldsOf(eng.validate({ doors: 1, price: 5 })), ['price']);
  assert.deepStrictEqual(fieldsOf(eng.validate({ options: { ess: { on: true, perDoor: 1, perTopBox: 1, description: 'x' } } })), ['options.ess.description']);
  assert.deepStrictEqual(fieldsOf(eng.validate({ options: { deluxe: {} } })), ['options.deluxe']);
  assert.deepStrictEqual(fieldsOf(eng.validate({ extras: [{ name: 'X', qty: 1, unitPrice: 1, discount: 5 }] })), ['extras.0.discount']);
  assert.deepStrictEqual(fieldsOf(eng.validate({ includes: { sink: 'yes' } })), ['includes.sink']);
  assert.deepStrictEqual(fieldsOf(eng.validate({ extras: 'Bin' })), ['extras']);
  assert.deepStrictEqual(fieldsOf(eng.validate({ extras: Array.from({ length: 51 }, () => ({ name: 'X', qty: 1, unitPrice: 1 })) })), ['extras']);
  assert.deepStrictEqual(fieldsOf(eng.validate({ extras: [{ name: 'x'.repeat(121), qty: 1, unitPrice: 1 }] })), ['extras.0.name']);
  assert.deepStrictEqual(fieldsOf(eng.validate({ options: { prem: { on: true, perDoor: 1, perTopBox: 1, description: 'x'.repeat(601) } } })), ['options.prem.description']);
  for (const bad of [null, [], 'quote', 5]) assert.ok(Array.isArray(eng.validate(bad).errors));
  assert.ok(!eng.validate([]).ok && !eng.validate('quote').ok);
  throwsInput(() => eng.calculate({ doors: -1 }, PL, VAT), 'doors');
});

test('sendProblems: a quote needs at least one option and valid details before it can be sent', () => {
  assert.deepStrictEqual(eng.sendProblems(answers({ doors: 3 })), []);
  const none = answers(); none.options.ess.on = false;
  assert.deepStrictEqual(eng.sendProblems(none), ['Choose at least one option (Essential, Premium or Premium Plus).']);
  assert.deepStrictEqual(eng.sendProblems({ doors: -2 }), ['Doors must be a whole number from 0 to 999.']);
});

// ---- price list and new quotes ------------------------------------------------------------------------------------------
test('the price list: every price is required; catalogue items need a name; manual and free items carry no price', () => {
  const r = eng.validatePriceList(PL);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepStrictEqual(r.priceList.extras[1], { key: 'pocket', name: 'Pocket door', unit: 'per opening', price: 0, manual: true, free: false });
  const missing = eng.validatePriceList({});
  assert.deepStrictEqual(fieldsOf(missing), ['options.ess.perDoor', 'options.ess.perTopBox', 'options.prem.perDoor', 'options.prem.perTopBox', 'options.pp.perDoor', 'options.pp.perTopBox',
    'drawerBoxes.cemux', 'drawerBoxes.blum', 'glazing.small', 'glazing.large']);
  assert.deepStrictEqual(fieldsOf(eng.validatePriceList({ ...PL, extras: [{ name: '', price: 5 }, { key: 'Bad Key!', name: 'X', price: 1 }, { name: 'Y' }] })), ['extras.0.name', 'extras.1.key', 'extras.2.price']);
  assert.deepStrictEqual(fieldsOf(eng.validatePriceList({ ...PL, vat: 13.5 })), ['vat']);
  throwsInput(() => eng.calculate(answers(), { ...PL, glazing: {} }, VAT), 'glazing.small');
});

test('a new quote starts with Essential on, the others off, and the price list\'s defaults', () => {
  const a = eng.newAnswers(PL);
  assert.deepStrictEqual(a.options.ess, { on: true, perDoor: 110, perTopBox: 60, drawerBox: 'none' });
  assert.deepStrictEqual(a.options.prem, { on: false, perDoor: 140, perTopBox: 65, drawerBox: 'none', description: '' });
  assert.deepStrictEqual(a.options.pp.extras, []);
  assert.ok(eng.validate(a).ok);
  assert.deepStrictEqual(eng.validate(a).answers, a);
  throwsInput(() => eng.newAnswers({}), 'drawerBoxes.cemux');
});

test('calculators are looked up by id and version; an unknown one is refused', () => {
  assert.strictEqual(QE.get({ id: 'ek-packages', version: 1 }), eng);
  assert.ok(Object.isFrozen(QE.CURRENT) && Object.isFrozen(eng));
  for (const ref of [null, {}, { id: 'ek-packages', version: 2 }, { id: 'other', version: 1 }]) throwsInput(() => QE.get(ref), 'engine');
});
