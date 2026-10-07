'use strict';
// Quote Details layout check (Phase 6.1 follow-up): the quote page must use the width of a desktop screen, never clip the Sent versions /
// PDF information or the delivery lines, and keep its tablet and phone layouts. Real page + real functions + emulators + MOCKED Meta and
// Gmail (nothing real is sent). Quotes are built in every state that has a different right-hand column: a draft, a quote sent through
// WhatsApp and email with two versions, and a send in progress (every channel failed). Each is measured at the common desktop widths,
// a laptop, a tablet and a phone. Run: bash test-ui/run.sh quote-layout.e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getAuth } = fnRequire('firebase-admin/auth');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
let n = 0; const ok = (m) => console.log(`  PASS ${++n}. ${m}`);

const cfgJs = `firebase.initializeApp({apiKey:'fake',projectId:'demo-leados',authDomain:'localhost',storageBucket:'demo-leados.firebasestorage.app'});
firebase.auth().useEmulator('http://127.0.0.1:9099',{disableWarnings:true});
firebase.firestore().useEmulator('127.0.0.1',8085);
firebase.app().functions('europe-west1').useEmulator('127.0.0.1',5001);
firebase.storage().useEmulator('127.0.0.1',9199);`;
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.woff2': 'font/woff2' };
const web = http.createServer((req, res) => {
  const u = req.url.split('?')[0]; let f;
  if (u === '/__/firebase/init.js') { res.setHeader('content-type', 'text/javascript'); return res.end(cfgJs); }
  const m = /^\/__\/firebase\/[\d.]+\/(.+)$/.exec(u);
  f = m ? path.join(ROOT, 'node_modules/firebase', m[1]) : path.join(ROOT, 'public', u === '/' ? 'index.html' : u);
  fs.readFile(f, (e, d) => { if (e) { res.statusCode = 404; return res.end('nf'); } res.setHeader('content-type', TYPES[path.extname(f)] || 'application/octet-stream'); res.end(d); });
}).listen(5055);

// ---- mocked Meta and Gmail: they only say yes or no ----
const state = { mode: 'ok' }; let gid = 0;
const meta = http.createServer((req, res) => {
  req.on('data', () => {}); req.on('end', () => {
    const json = (o, st = 200) => { res.statusCode = st; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.method === 'POST' && /\/111\/media$/.test(req.url)) return json({ id: 'UPMEDIA' + ++gid });
    if (req.method === 'POST' && /\/111\/messages$/.test(req.url)) return state.mode === 'refuse' ? json({ error: { code: 131026, message: 'Message undeliverable' } }, 400) : json({ messages: [{ id: 'wamid.OUT' + ++gid }] });
    json({ error: { message: 'unexpected' } }, 404);
  });
}).listen(9911); meta.keepAliveTimeout = 0;
const gmail = http.createServer((req, res) => {
  req.on('data', () => {}); req.on('end', () => {
    const json = (o, st = 200) => { res.statusCode = st; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.method === 'POST' && /\/gmail\/v1\/users\/me\/messages\/send$/.test(req.url)) return state.mode === 'refuse' ? json({ error: { message: 'forbidden' } }, 403) : json({ id: 'gmsg-' + ++gid, threadId: 'thr' });
    json({ error: { message: 'unexpected' } }, 404);
  });
}).listen(9913); gmail.keepAliveTimeout = 0;

const H = 3600e3;
const ph = { anna: '353860000041', brian: '353860000042', cara: '353860000043' };
const SETTINGS = { vatRate: 13.5, validityDays: 30,
  business: { tradingName: 'Elite Kitchens', signatureName: 'Test Signer', phone: '01 000 0000', email: 'quotes@example.com', web: 'www.example.com', address: 'Test Street, Dublin', vatNumber: 'IE0000000X' },
  priceList: { options: { ess: { perDoor: 313.37, perTopBox: 171.17 }, prem: { perDoor: 323.41, perTopBox: 181.19 }, pp: { perDoor: 333.53, perTopBox: 191.29 } },
    drawerBoxes: { cemux: 19.19, blum: 29.29 }, glazing: { small: 43.43, large: 91.91 }, extras: [] } };

// Widths people really have. The first three are the common laptop and desktop sizes, then wider screens; then a tablet and a phone.
const DESKTOP = [[1280, 800], [1366, 768], [1440, 900], [1536, 864], [1920, 1080], [2560, 1440], [1366, 600]];       // the last is a short window: the right-hand column then scrolls inside itself
const NARROW = [[1024, 768], [768, 1024], [390, 800]];
const FORM_MAX = 980;     // the draft form's reading width (px): it grows with the screen up to this
const CAP = 1680;            // the readable maximum width of the quote page (px); the page uses all the room it has up to this

(async () => {
  initializeApp({ projectId: 'demo-leados', storageBucket: 'demo-leados.firebasestorage.app' });
  const db = getFirestore();
  const t0 = Date.now();
  for (const [id, name, email] of [[ph.anna, 'Anna Murphy', 'anna@example.com'], [ph.brian, 'Brian Byrne', 'brian@example.com'], [ph.cara, 'Cara Walsh', 'cara@example.com']]) {
    await db.doc('conversations/' + id).set({ phone: id, name, createdAt: Timestamp.fromMillis(t0 - 10 * H), updatedAt: Timestamp.fromMillis(t0 - 1 * H), lastMessage: 'Hi', unreadCount: 0, lastInboundAt: Timestamp.fromMillis(t0 - 2 * H) });
    await db.doc('contacts/' + id).set({ phone: id, name, email, address: '1 Main Street, Swords', location: 'Swords', createdAt: Timestamp.fromMillis(t0 - 10 * H) });
  }
  const u = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true });
  const token = await getAuth().createCustomToken(u.uid);
  // Scrollbars: Playwright hides them by default, which would hide the very problem. Windows 11 Chrome draws a thin scrollbar that FLOATS over
  // the edge of a scrolling column (it takes no room of its own), so the test browser does the same.
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--enable-features=OverlayScrollbar'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage(); global.__page = page;
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());

  console.log('QUOTE LAYOUT E2E: real page + real functions + emulators + mocked Meta and Gmail');
  await page.goto('http://127.0.0.1:5055/');
  await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await page.waitForSelector('#app:not([hidden])');
  await page.evaluate(() => { window.open = () => null; });
  await page.evaluate(async (s) => { const f = firebase.app().functions('europe-west1'); await f.httpsCallable('saveQuoteSettings')(s); await f.httpsCallable('setQuoteNumbering')({ next: 34 }); }, SETTINGS);

  const makeQuote = (phone) => page.evaluate(async (p) => {
    const f = firebase.app().functions('europe-west1'), s = (await firebase.firestore().doc('quoteSettings/current').get()).data();
    const a = QuoteEngine.current().newAnswers(s.priceList); a.doors = 10; a.drawers = 4; a.options.ess.drawerBox = 'cemux'; a.options.prem = { ...a.options.prem, on: true, drawerBox: 'blum' };
    return (await f.httpsCallable('createQuote')({ phone: p, requestId: crypto.randomUUID(), answers: a })).data.id;
  }, phone);
  const openQuote = async (id) => { await page.evaluate((i) => { location.hash = '#quotes/' + i; }, id); await page.waitForFunction((i) => location.hash === '#quotes/' + i, id); await page.waitForSelector('#q-quote-view .qv'); };
  const openSend = async (id, button = '#qv-send') => {
    await openQuote(id); await page.waitForSelector(button + ':not([disabled])'); await page.click(button); await page.waitForSelector('#qsend-dlg[open]');
    await page.waitForFunction(() => !/Checking/.test(document.getElementById('qsend-em-state').textContent) && document.getElementById('qsend-wa-state').textContent.length > 0);
  };
  const results = async () => { await page.waitForSelector('#qsend-results:not([hidden])', { timeout: 90000 }); };

  // ---- the quotes, one per right-hand-column state ----
  const draft = await makeQuote(ph.cara);                                                                  // a plain draft
  const sent = await makeQuote(ph.anna);                                                                   // sent by WhatsApp and email, then revised and sent again: two versions
  await openSend(sent); await page.check('#qsend-em'); await page.click('#qsend-send'); await results();
  await page.waitForFunction(() => document.querySelectorAll('#qsend-res-list li[data-state="sent"]').length === 2); await page.click('#qsend-res-close');
  await page.click('#qv-revise'); await page.waitForSelector('#qv-send:not([disabled])');
  await page.click('#qv-send'); await page.waitForSelector('#qsend-dlg[open]');
  await page.waitForFunction(() => /Available/.test(document.getElementById('qsend-wa-state').textContent));
  await page.fill('#qsend-value', ''); await page.click('#qsend-send'); await results();
  await page.waitForFunction(() => document.querySelector('#qsend-res-list li[data-channel="whatsapp"][data-state="sent"]')); await page.click('#qsend-res-close');
  const stuck = await makeQuote(ph.brian);                                                                 // every channel fails: "a send is in progress"
  state.mode = 'refuse';
  await openSend(stuck); await page.check('#qsend-em'); await page.click('#qsend-send'); await results();
  await page.waitForFunction(() => document.querySelectorAll('#qsend-res-list li[data-state="failed"]').length === 2); await page.click('#qsend-res-close'); state.mode = 'ok';
  await openQuote(stuck); await page.waitForSelector('.qv-sendstate');
  console.log('  (quotes ready: a draft, a quote sent by WhatsApp and email with two versions, and a send in progress)');

  // ---- what is measured ----
  // Everything on the quote page that could be cut off: the page itself, the quote area, and the right-hand column. Every element must
  // sit inside the area it belongs to, no container may hide part of its content sideways, and the long lines (Sent versions, the PDF
  // link, the delivery lines, the buttons) must be whole.
  const measure = () => page.evaluate(() => {
    const vw = window.innerWidth, $ = (s) => document.querySelector(s), box = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, r: b.right, w: b.width, h: b.height }; };
    const qv = $('#q-quote-view .qv'), scroll = $('.quotes-scroll'), side = $('.qv-side'), main = $('.qv-main');
    const sc = getComputedStyle(scroll), avail = scroll.clientWidth - parseFloat(sc.paddingLeft) - parseFloat(sc.paddingRight);
    const out = { vw, page: { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }, avail,
      qv: box(qv), main: main ? box(main) : null, side: side ? { ...box(side), sw: side.scrollWidth, cw: side.clientWidth, sh: side.scrollHeight, ch: side.clientHeight, oy: getComputedStyle(side).overflowY } : null,
      scroll: { sw: scroll.scrollWidth, cw: scroll.clientWidth }, outside: [], clipped: [], wrapped: [], wide: [] };
    const qvb = qv.getBoundingClientRect();
    for (const e of qv.querySelectorAll('*')) {
      const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const b = e.getBoundingClientRect(); if (!b.width || !b.height) continue;
      if (e.closest('details:not([open]) > :not(summary)')) continue;
      if (b.right > Math.min(vw, qvb.right) + 1 || b.left < -1) out.outside.push(`${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${String(e.className).split(' ')[0]} right=${Math.round(b.right)} (area ends ${Math.round(Math.min(vw, qvb.right))})`);
      if (cs.overflowX !== 'visible' && e.scrollWidth > e.clientWidth + 1 && !/^(textarea|input|select)$/i.test(e.tagName)) out.clipped.push(`${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]} content ${e.scrollWidth} > box ${e.clientWidth}`);
    }
    // buttons: a label must not wrap onto two lines
    for (const b of qv.querySelectorAll('.qv-buttons .btn, .qv-actions .btn, .qv-sendstate .btn')) { const r = b.getBoundingClientRect(); if (r.width && r.height > 46) out.wrapped.push(`${(b.textContent || '').trim()} (${Math.round(r.width)}x${Math.round(r.height)})`); }
    const pdf = [...qv.querySelectorAll('.qv-ver a, .qv-versions a')].map((a) => { const r = a.getBoundingClientRect(), s = side ? side.getBoundingClientRect() : qvb; return { text: a.textContent.trim(), left: Math.round(r.left), right: Math.round(r.right), sideRight: Math.round(s.right), whole: r.right <= s.right + 1 && r.right <= vw + 1 }; });
    const qb = $('.qb'); out.qb = qb ? qb.getBoundingClientRect().width : null;
    out.pdf = pdf;
    // how close the content comes to the right-hand column's edge while that column scrolls: a floating scrollbar covers the last pixels
    out.scrollable = !!(side && side.scrollHeight > side.clientHeight + 1); out.sbw = side ? side.offsetWidth - side.clientWidth : 0;
    out.minGap = null;
    if (side) { const sr = side.getBoundingClientRect(); for (const e of side.querySelectorAll('*')) { const cs = getComputedStyle(e); if (cs.display === 'none' || e.children.length) continue; if (!(e.textContent || '').trim() && !/^(svg|img)$/i.test(e.tagName)) continue; const b = e.getBoundingClientRect(); if (!b.width) continue; const gap = sr.right - b.right; if (out.minGap === null || gap < out.minGap) out.minGap = gap; } }
    const rows = [...qv.querySelectorAll('.qv-ver, .qv-vdel .qsend-res-row, .qv-vnote')].map((r) => { const b = r.getBoundingClientRect(); return { cls: String(r.className).split(' ')[0], right: Math.round(b.right), text: (r.textContent || '').trim().slice(0, 28) }; });
    out.rows = rows; out.sideBox = side ? side.getBoundingClientRect().right : null;
    const btns = [...qv.querySelectorAll('.qv-actions .btn')].map((b) => Math.round(b.getBoundingClientRect().top)); out.buttonRows = new Set(btns).size;
    return out;
  });
  const view = async (id, w, h, shot) => {
    await page.setViewportSize({ width: w, height: h }); await openQuote(id); await page.waitForTimeout(150);
    if (shot) await page.screenshot({ path: path.join(SHOTS, shot) });
    return measure();
  };
  const problems = [];
  const check = (label, m, desktop) => {
    const p = [];
    if (m.page.sw > m.page.cw + 1) p.push(`the page scrolls sideways (${m.page.sw} > ${m.page.cw})`);
    if (m.scroll.sw > m.scroll.cw + 1) p.push(`the quote area scrolls sideways (${m.scroll.sw} > ${m.scroll.cw})`);
    if (m.outside.length) p.push('sticks out: ' + m.outside.slice(0, 3).join('; '));
    if (m.clipped.length) p.push('clipped: ' + m.clipped.slice(0, 3).join('; '));
    if (m.side && m.side.sw > m.side.cw + 1) p.push(`the right-hand column hides part of itself (${m.side.sw} > ${m.side.cw})`);
    const cut = m.pdf.filter((x) => !x.whole); if (cut.length) p.push('the PDF link is cut: ' + JSON.stringify(cut[0]));
    const farRows = m.rows.filter((r) => m.sideBox && r.right > m.sideBox + 1); if (farRows.length) p.push('a row passes the column edge: ' + JSON.stringify(farRows[0]));
    if (m.wrapped.length) p.push('a button label wraps: ' + m.wrapped.slice(0, 2).join(', '));
    if (m.scrollable && m.minGap !== null && m.minGap + m.sbw < 12) p.push(`while the right-hand column scrolls, its content comes within ${Math.round(m.minGap + m.sbw)}px of its edge, where the scrollbar floats over it`);
    if (desktop) {
      const want = Math.min(m.avail, CAP);
      if (m.qv.w < want - 2) p.push(`the quote page is only ${Math.round(m.qv.w)}px wide but ${Math.round(want)}px is available (up to the ${CAP}px reading limit)`);
      if (m.qv.w > CAP + 2) p.push(`wider than the ${CAP}px reading limit (${Math.round(m.qv.w)}px)`);
      if (m.side && m.side.w < 340) p.push(`the right-hand column is only ${Math.round(m.side.w)}px wide`);
      if (m.qb !== null && m.main && m.qb < Math.min(m.main.w, FORM_MAX) - 2) p.push(`the quote form is only ${Math.round(m.qb)}px wide but ${Math.round(Math.min(m.main.w, FORM_MAX))}px is available`);
    } else if (m.side && m.side.oy === 'auto' && m.vw <= 899 && m.side.sh > m.side.ch + 1) p.push('on a small screen the right-hand column scrolls inside itself');
    if (p.length) problems.push(`${label}: ${p.join(' | ')}`);
    return p;
  };

  const states = [['a draft', draft], ['a sent quote with two versions and their deliveries', sent], ['a send in progress', stuck]];
  for (const [w, h] of DESKTOP) {
    for (const [name, id] of states) {
      const shot = (w === 1440 || w === 1920 || w === 2560) ? `layout-${w}-${name.includes('sent') ? 'sent' : name.includes('progress') ? 'stuck' : 'draft'}.png` : null;
      check(`${w}px, ${name}`, await view(id, w, h, shot), true);
    }
  }
  const desktopProblems = problems.splice(0);                                                            // measure the narrow screens too before reporting, so one run shows everything
  for (const [w, h] of NARROW) for (const [name, id] of states) check(`${w}px, ${name}`, await view(id, w, h, w === 390 && name.includes('sent') ? 'layout-390-sent.png' : null), false);
  const narrowProblems = problems.splice(0);
  assert.deepEqual([...desktopProblems, ...narrowProblems], [], 'LAYOUT PROBLEMS:\n  ' + [...desktopProblems, ...narrowProblems].join('\n  '));
  ok(`desktop (${DESKTOP.map(([w]) => w).join(', ')} px): the quote page uses the screen up to the reading limit, nothing sticks out or is clipped, the PDF and delivery lines are whole, button labels do not wrap`);

  ok('tablet (1024, 768 px) and phone (390 px): no sideways scroll, nothing clipped, the PDF and delivery lines are whole');

  // the draft form must not stretch absurdly on a wide screen: its text fields stay readable
  await view(draft, 2560, 1440, null);
  const fieldW = await page.evaluate(() => Math.max(...[...document.querySelectorAll('.qv-main input[type=text], .qv-main input:not([type]), .qv-main select, .qv-main textarea')].filter((e) => e.getBoundingClientRect().width).map((e) => e.getBoundingClientRect().width)));
  assert.ok(fieldW <= FORM_MAX, `a single form field is ${Math.round(fieldW)}px wide on a 2560px screen`);
  ok('on a very wide screen single form fields stay a readable width');

  assert.deepEqual(errors, [], 'browser errors: ' + JSON.stringify(errors)); ok('no JavaScript errors in the browser');
  console.log(`ALL ${n} CHECKS PASSED`);
  await browser.close(); web.close(); meta.close(); gmail.close(); process.exit(0);
})().catch(async (e) => { console.error('FAILED:', e && e.stack || e); try { await global.__page?.screenshot({ path: path.join(SHOTS, 'layout-fail.png') }); } catch (_) {} process.exit(1); });
