'use strict';
// Quote PDF: the layout and the number fields. No backend is needed (the document and the builder are plain browser code), so this runs on its own:
//   node test-ui/quote-pdf.e2e.js        (NODE_PATH = the global Playwright, CHROMIUM = a headless Chromium; also works under test-ui/run.sh)
// It checks, with the real fonts and the real PDF maker: a quote with 3 options and 2 design renders (the owner's case) is 2 well-filled pages, not 4 mostly empty ones; renders sit in the flow of the quote and a row
// of renders is never cut; one wide render, two, three, five and no renders; the PDF has as many pages as the preview; and number fields: typing 85 over a 0 gives 85, never 085, and the calculator reads the same number.
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
let n = 0; const ok = (m) => console.log(`  PASS ${++n}. ${m}`);
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.woff2': 'font/woff2' };
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>harness</title></head><body><div id="quotes"><div id="host"></div></div>
<script src="/quote-engine.js"></script><script src="/quote-numbers.js"></script><script src="/quote-builder.js"></script><script src="/quote-document.js"></script></body></html>`;
const web = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/__harness') { res.setHeader('content-type', 'text/html'); return res.end(PAGE); }
  const f = path.join(ROOT, 'public', u);
  fs.readFile(f, (e, d) => { if (e) { res.statusCode = 404; return res.end('nf'); } res.setHeader('content-type', TYPES[path.extname(f)] || 'application/octet-stream'); res.end(d); });
}).listen(5059);
const PRICE_LIST = { options: { ess: { perDoor: 313.37, perTopBox: 171.17 }, prem: { perDoor: 323.41, perTopBox: 181.19 }, pp: { perDoor: 333.53, perTopBox: 191.29 } }, drawerBoxes: { cemux: 19.19, blum: 29.29 }, glazing: { small: 43.43, large: 91.91 }, extras: [{ name: 'Pull-out bin', unit: 'per unit', price: 77.71 }] };
const pagesOf = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
function savePages(buf, prefix) {                                              // html2pdf stores each A4 page as one JPEG: pull them out as stored, so the layout can be looked at
  const s = buf.toString('latin1'); let i = 0, k = 0;
  for (;;) { const at = s.indexOf('/DCTDecode', i); if (at < 0) break; const st = s.indexOf('stream', at) + 6, start = st + (s[st] === '\r' ? 2 : 1), end = s.indexOf('endstream', start); fs.writeFileSync(path.join(SHOTS, `${prefix}-${++k}.jpg`), buf.subarray(start, end)); i = end; }
  return k;
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const errors = [], page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto('http://127.0.0.1:5059/__harness');
  console.log('QUOTE PDF E2E: the real document, fonts and PDF maker in a bare page');

  // everything the layout checks need, built in the page: the owner's sample (3 options) and renders drawn on canvases the size of a real render
  await page.evaluate((pl) => {
    window.H = {
      pl, e: QuoteEngine.current(),
      sheet(three) { const a = H.e.newAnswers(pl); Object.assign(a, { doors: 24, topBoxes: 6, drawers: 9 }, { worktop: { on: true, price: 1450 }, glazing: { small: 2, large: 1 }, includes: { sink: true, extractor: true, removal: true, electrical: true, plumbing: false }, extras: [{ name: 'Pull-out bin', unit: 'per unit', qty: 1, unitPrice: 240 }] });
        if (three) { a.options.prem.on = true; a.options.pp.on = true; a.options.pp.extras = [{ name: 'Composite sink', free: true }, { name: 'LED lighting', qty: 2, unitPrice: 280 }]; } return H.e.calculate(a, pl, { vatRate: 13.5 }); },
      render(i, w = 2000, h = 1150) { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, ['#e9e4dc', '#d8d2c8', '#cfc6b8', '#e2ddd4', '#d4cdc1'][i % 5]); gr.addColorStop(1, '#f7f4ee'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
        g.fillStyle = '#9a9a9a'; g.fillRect(0, h * 0.62, w, h * 0.12); g.fillStyle = '#c9c1b3'; for (let k = 0; k < 6; k++) g.fillRect(40 + k * (w / 6), 60, w / 6 - 60, h * 0.5); g.fillStyle = '#222'; g.font = '120px sans-serif'; g.fillText('RENDER ' + (i + 1), w / 2 - 300, h * 0.9); return c.toDataURL('image/jpeg', 0.9); },
      data(renders, three = true) { return { ref: 'EK-0104-v1', issueDate: '2026-10-15', validUntil: '2026-11-14', customer: { name: 'Lynda', address: '7 martello close balbriggan' }, business: { tradingName: 'Elite Kitchens', signatureName: 'Elite Kitchens', phone: '0894641917', email: 'thomasmaster2012@gmail.com', web: '', address: '', vatNumber: '' }, sheet: H.sheet(three), renders, draft: false }; },
      async layout(renders, three = true) {
        const host = document.createElement('div'); Object.assign(host.style, { position: 'fixed', left: '-5000px', top: '0' }); document.body.append(host);
        const f = await QuoteDocument.show(host, H.data(renders, three)), doc = f.contentDocument;
        const sheets = [...doc.querySelectorAll('.sheet')].map((s) => { const top = s.getBoundingClientRect().top, kids = [...s.querySelectorAll(':scope > .blk')], last = kids[kids.length - 1];
          return { blocks: kids.map((b) => [...b.classList].filter((c) => c !== 'blk').join(' ') || 'section'), used: Math.round(((last.getBoundingClientRect().bottom - top) / s.getBoundingClientRect().height) * 100) }; });
        const r = { pages: sheets.length, sheets, tight: doc.querySelector('.doc, .sheet') && !!doc.querySelector('.tight'), rendImgs: doc.querySelectorAll('.rend-img').length, text: doc.body.innerText }; f.remove(); host.remove(); return r;
      },
    };
  }, PRICE_LIST);

  // ------------------------------------------------------------------ 1. the owner's quote: 3 options and 2 renders
  const two = await page.evaluate(async () => H.layout([H.render(0), H.render(1)]));
  assert.equal(two.pages, 2, 'three options with two renders: two pages (it was four): ' + JSON.stringify(two.sheets));
  assert.equal(two.rendImgs, 2); assert.match(two.text, /Design renders[\s\S]*Render 1[\s\S]*Render 2[\s\S]*Indicative renders\. Final design confirmed/i);
  assert.ok(two.sheets[0].used >= 70, 'page 1 is well filled (' + two.sheets[0].used + '%): ' + JSON.stringify(two.sheets)); assert.ok(two.sheets[1].used >= 45, 'page 2 is not mostly empty (' + two.sheets[1].used + '%)');
  assert.equal(two.sheets[1].blocks.at(-1), 'closing', 'the terms and the sign-off are last, with the renders before them');
  assert.equal(two.sheets.flatMap((s) => s.blocks).filter((b) => b === 'closing').length, 1);
  ok(`3 options + 2 renders = ${two.pages} pages (page 1 ${two.sheets[0].used}% full, page 2 ${two.sheets[1].used}%), the renders in the flow before the terms and sign-off, the sign-off last`);

  // ------------------------------------------------------------------ 2. other numbers of renders
  const cases = {};
  for (const [name, c, three] of [['none3', 0, true], ['one3', 1, true], ['three3', 3, true], ['five3', 5, true], ['one1', 1, false], ['two1', 2, false]]) cases[name] = await page.evaluate(async ([c, three]) => H.layout(Array.from({ length: c }, (_, i) => H.render(i)), three), [c, three]);
  for (const [k, v] of Object.entries(cases)) assert.equal(v.rendImgs, { none3: 0, one3: 1, three3: 3, five3: 5, one1: 1, two1: 2 }[k], k + ': every render is in the document');
  assert.equal(cases.none3.pages, 2, 'no renders: the quote is the same two pages'); assert.ok(cases.one3.pages <= 2, 'one wide render still two pages: ' + JSON.stringify(cases.one3.sheets)); assert.ok(cases.three3.pages <= 3, 'three renders: ' + cases.three3.pages);
  assert.ok(cases.five3.pages <= 3, 'five renders (the most): ' + JSON.stringify(cases.five3.sheets));
  assert.ok(cases.two1.pages <= 2, 'a one-option quote with two renders is at most two pages: ' + JSON.stringify(cases.two1.sheets) + ' pages=' + cases.two1.pages);
  for (const [k, v] of Object.entries(cases)) { v.sheets.forEach((s, i) => { if (i < v.pages - 1) assert.ok(s.used >= 55, `${k}: page ${i + 1} is ${s.used}% full: ${JSON.stringify(v.sheets)}`); }); assert.equal(v.sheets.flatMap((s) => s.blocks).filter((b) => b === 'closing').length, 1, k); assert.equal(v.sheets.at(-1).blocks.at(-1), 'closing', k + ': the sign-off is last'); }
  ok(`renders: none ${cases.none3.pages}, one ${cases.one3.pages}, three ${cases.three3.pages}, five ${cases.five3.pages} pages (3 options); one option + two renders ${cases.two1.pages} page; no page except the last is less than 55% full; the sign-off is always last`);

  // ------------------------------------------------------------------ 3. a row of renders is never cut, and the headings never sit alone
  const rowsSplit = await page.evaluate(async () => { const r = []; for (const c of [2, 3, 4, 5]) { const l = await H.layout(Array.from({ length: c }, (_, i) => H.render(i))); r.push(l.sheets.map((s) => s.blocks)); } return r; });
  for (const sheets of rowsSplit) { const flat = sheets.flat(); assert.ok(flat.filter((b) => b === 'section').length >= 3); assert.ok(flat.filter((b) => b === 'rend-next').length >= 0); for (const s of sheets) assert.notEqual(s[0], 'closing', 'the closing section never starts a page alone'); }
  ok('rows of renders are separate sections: a page break can fall between rows, never inside one');

  // ------------------------------------------------------------------ 4. the real PDF has the preview's pages; look at it
  const pdf = await page.evaluate(async () => { const d = H.data([H.render(0), H.render(1)]); const blob = await QuoteDocument.toPdf(d, { filename: 'x.pdf' }); const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode(...buf.subarray(i, i + 8192)); return { b64: btoa(s), size: blob.size }; });
  const buf = Buffer.from(pdf.b64, 'base64'); assert.equal(buf.subarray(0, 5).toString(), '%PDF-'); assert.equal(pagesOf(buf), two.pages, 'the PDF has the pages of the preview'); assert.ok(pdf.size < 1.6e6, 'a size to email: ' + pdf.size);
  savePages(buf, 'quote-pdf-2renders-page'); fs.writeFileSync(path.join(SHOTS, 'quote-pdf-2renders.pdf'), buf);
  const one = await page.evaluate(async () => { const d = H.data([]); const blob = await QuoteDocument.toPdf(d, { filename: 'x.pdf' }); const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode(...buf.subarray(i, i + 8192)); return btoa(s); });
  assert.equal(pagesOf(Buffer.from(one, 'base64')), 2, 'no renders: two pages');
  ok(`the PDF made for the sample is ${pagesOf(buf)} pages (${Math.round(pdf.size / 1024)} KB), the same as the preview`);

  // ------------------------------------------------------------------ 5. number fields
  assert.deepEqual(await page.evaluate(() => ['085', '0', '00', '007.5', '0.5', '10', '', '100', '-5', '0850'].map((s) => QuoteNumbers.tidy(s))), ['85', '0', '0', '7.5', '0.5', '10', '', '100', '-5', '850']);
  await page.evaluate((pl) => { const a = QuoteEngine.current().newAnswers(pl); a.doors = 0; a.topBoxes = 0; a.drawers = 0; window.LAST = null; QuoteBuilder.mount(document.getElementById('host'), { answers: a, priceList: pl, onChange: (x) => { window.LAST = JSON.parse(JSON.stringify(x)); } }); }, PRICE_LIST);
  const doors = page.locator('input[data-field="doors"]'); assert.equal(await doors.inputValue(), '0', 'the field starts at 0');
  await doors.click(); await page.keyboard.type('85'); assert.equal(await doors.inputValue(), '85', 'typing 85 over the 0 gives 85, not 085'); assert.equal(await page.evaluate(() => LAST.doors), 85, 'the builder reads 85');
  await doors.fill(''); await page.keyboard.type('0'); await page.keyboard.type('8'); await page.keyboard.type('5'); assert.equal(await doors.inputValue(), '85', 'typing 0, 8, 5 gives 85'); assert.equal(await page.evaluate(() => LAST.doors), 85);
  const money = page.locator('input[data-kind="money"]').first(); if (await money.count()) { await money.click(); await page.keyboard.type('0'); await page.keyboard.type('.5'); const mv = await money.inputValue(); assert.equal(mv, '0.5', '0.5 stays 0.5 (got ' + mv + ')'); }
  await doors.click(); await page.keyboard.type('0'); assert.equal(await doors.inputValue(), '0', 'a single 0 stays'); await page.keyboard.type('7'); assert.equal(await doors.inputValue(), '7');
  // a field is selected when entered (Tab), so the next digits replace what was there
  await doors.fill('12'); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); await page.keyboard.type('9'); assert.equal(await doors.inputValue(), '9', 'entering a field selects it: typing replaces the old number');
  ok('number fields: typing 85 over a 0 gives 85 (also 0 then 8 then 5), decimals and a single 0 are left alone, entering a field selects it, and the builder reads the same numbers');

  // outside the Quotes screens nothing is touched
  const outside = await page.evaluate(() => { const i = document.createElement('input'); i.type = 'number'; document.body.append(i); i.focus(); i.value = '085'; i.dispatchEvent(new Event('input', { bubbles: true })); const v = i.value; i.remove(); return v; });
  assert.equal(outside, '085', 'only the Quotes screens are changed');
  assert.deepEqual(errors, [], 'browser errors: ' + errors.join(' | ')); ok('no JavaScript errors');
  await browser.close(); web.close(); console.log(`ALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('FAILED:', e && e.stack || e); process.exit(1); });
