'use strict';
// Light theme everywhere + stage colours shared by Inbox and Pipeline, on desktop and phone.
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
const web = http.createServer((req, res) => {
  const u = req.url.split('?')[0]; let f;
  if (u === '/__/firebase/init.js') { res.setHeader('content-type', 'text/javascript'); return res.end(cfgJs); }
  const m = /^\/__\/firebase\/[\d.]+\/(.+)$/.exec(u);
  f = m ? path.join(ROOT, 'node_modules/firebase', m[1]) : path.join(ROOT, 'public', u === '/' ? 'index.html' : u);
  fs.readFile(f, (e, d) => { if (e) { res.statusCode = 404; return res.end('nf'); }
    res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(f)] || 'application/octet-stream'); res.end(d); });
}).listen(5055);

const DAY = 86400000, ago = (d) => Timestamp.fromMillis(Date.now() - d * DAY);
const STAGES = ['inbox', 'booked', 'quoted', 'won', 'closed'];
const ph = Object.fromEntries(STAGES.map((s, i) => [s, '35385000002' + i]));
const rgb = (c) => c.match(/\d+(\.\d+)?/g).slice(0, 3).join(',');

(async () => {
  initializeApp({ projectId: 'demo-leados' });
  const db = getFirestore();
  for (const s of STAGES) {
    await db.doc('conversations/' + ph[s]).set({ phone: ph[s], name: 'Cust ' + s, createdAt: ago(5), updatedAt: ago(1), lastMessage: 'Hi', unreadCount: 0, ...(s === 'inbox' ? {} : { inboxStatus: s }) });
    await db.doc('contacts/' + ph[s]).set({ phone: ph[s], name: 'Cust ' + s, createdAt: ago(5) });
  }
  const u = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true });
  const token = await getAuth().createCustomToken(u.uid);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const errors = [];
  console.log('THEME + SHARED STAGE COLOURS E2E');

  async function open(opts) {
    const ctx = await browser.newContext(opts); const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto('http://127.0.0.1:5055/');
    await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
    await page.waitForSelector('#app:not([hidden])');
    return { ctx, page };
  }
  // what the page looks like: key colours of the main surfaces
  const look = (page) => page.evaluate(() => {
    const c = (sel, prop = 'backgroundColor') => { const e = document.querySelector(sel); return e ? getComputedStyle(e)[prop] : null; };
    return { body: c('body'), rail: c('.rail'), list: c('.list-pane'), ink: c('body', 'color'), chip: c('#status-filters button[aria-pressed=true]'), scheme: getComputedStyle(document.documentElement).colorScheme };
  });

  // ---- 1. light theme, whatever the phone/system prefers ----
  const light = await open({ viewport: { width: 1360, height: 860 }, colorScheme: 'light' });
  const dark = await open({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', isMobile: true, hasTouch: true });          // a phone whose system theme is DARK
  const lookLight = await look(light.page), lookDark = await look(dark.page);
  assert.equal(lookLight.body, lookDark.body); assert.equal(lookLight.ink, lookDark.ink); assert.equal(lookLight.list, lookDark.list);
  assert.equal(lookDark.body, 'rgb(247, 247, 244)'); assert.match(lookDark.scheme, /light/); assert.match(lookDark.scheme, /only/);
  for (const pg of [light.page, dark.page]) {
    assert.equal(await pg.getAttribute('meta[name="color-scheme"]', 'content'), 'only light');
    assert.equal(await pg.getAttribute('meta[name="theme-color"]', 'content'), '#f7f7f4');
    assert.equal(await pg.evaluate(() => document.querySelectorAll('style, link[rel=stylesheet]').length > 0 && ![...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => r.media && /prefers-color-scheme:\s*dark/.test(r.media.mediaText)); } catch (e) { return false; } })), true);
  }
  await dark.page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await dark.page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), true);        // the phone really is in dark mode...
  assert.equal((await look(dark.page)).body, 'rgb(247, 247, 244)');                                                // ...and the page does not follow it
  // the other screens too: login, pipeline, dialogs
  await dark.page.tap('#to-pipeline'); await dark.page.waitForSelector('.lane .prow, .pipe-empty');
  assert.equal(await dark.page.evaluate(() => getComputedStyle(document.querySelector('.pipeline-pane')).backgroundColor), 'rgb(247, 247, 244)');
  await dark.page.screenshot({ path: path.join(SHOTS, 'theme-phone-darkpref-pipeline.png') });
  ok('a phone set to DARK still gets the light theme: same colours as light, the page declares "only light", no dark rules exist');
  const login = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' }); const lp = await login.newPage();
  await lp.goto('http://127.0.0.1:5055/'); await lp.waitForSelector('#login:not([hidden])');
  assert.equal(await lp.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(247, 247, 244)');
  assert.equal(await lp.evaluate(() => getComputedStyle(document.querySelector('.login-card')).color.startsWith('rgb(37')), true);
  await login.close();
  ok('the sign-in screen is light on a dark-mode phone too');
  await dark.page.tap('#pipe-back'); await dark.page.waitForSelector('.conv');

  // ---- 1b. the real cause: a phone browser's own FORCE-DARK. Chromium has the same switch, so test against it ----
  const fd = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', args: ['--enable-features=WebContentsForceDark:inversion_method/cielab_based/image_behavior/none', '--force-dark-mode'] });
  const pixel = async (page) => {                                                         // the colour actually painted at the top-left of the sign-in screen
    const png = (await page.screenshot()).toString('base64');
    return page.evaluate(async (b64) => { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return [...g.getImageData(5, 5, 1, 1).data].slice(0, 3); }, png);
  };
  async function signinPixel({ asBefore }) {
    const ctx = await fd.newContext({ viewport: { width: 390, height: 600 }, colorScheme: 'dark' }); const pg = await ctx.newPage();
    if (asBefore) {                                                                       // how the page was before this fix: no opt-out meta, plain "color-scheme: light"
      await pg.route('**/', async (r) => { const res = await r.fetch(); await r.fulfill({ response: res, body: (await res.text()).replace(/<meta name="(color-scheme|supported-color-schemes|theme-color|darkreader-lock)"[^>]*>/g, '') }); });
      await pg.route('**/app.css', async (r) => { const res = await r.fetch(); await r.fulfill({ response: res, body: (await res.text()).replace('color-scheme: only light', 'color-scheme: light') }); });
    }
    await pg.goto('http://127.0.0.1:5055/'); await pg.waitForSelector('#login:not([hidden])');
    const px = await pixel(pg); await ctx.close(); return px;
  }
  const before = await signinPixel({ asBefore: true }), after = await signinPixel({ asBefore: false });
  assert.ok(Math.max(...before) < 80, 'control: the old page IS darkened by force-dark: ' + before);          // proves the test can see the problem
  assert.deepEqual(after, [247, 247, 244]);                                                                    // the fixed page stays light
  await fd.close();
  ok('with the browser\'s force-dark switched on (what a phone does), the old page turns dark (control) and the fixed page stays light');

  // ---- 2. the Inbox uses the same stage colours as the Pipeline ----
  const stageColour = async (page, sel) => (await page.locator(sel).evaluate((e) => { const cs = getComputedStyle(e, '::before'); return cs.backgroundColor; }));
  async function inboxColours(page) {
    const out = {};
    for (const s of STAGES) out[s] = await stageColour(page, `#status-filters button[data-status="${s}"]`);
    return out;
  }
  const inboxLight = await inboxColours(light.page), inboxPhone = await inboxColours(dark.page);
  assert.equal(new Set(Object.values(inboxLight)).size, 5);
  assert.deepEqual(inboxPhone, inboxLight);
  await light.page.click('#nav-pipeline'); await light.page.waitForSelector('.lane .prow');
  for (const s of STAGES) assert.equal(await stageColour(light.page, `.lane[data-stage="${s}"] .lane-title`), inboxLight[s], 'Inbox and Pipeline dot colour for ' + s);
  ok('each stage has the identical dot colour in the Inbox chips and the Pipeline headings (and on a phone)');
  await light.page.click('#nav-inbox');
  assert.deepEqual((await light.page.locator('#status-filters button').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()), ['New lead', 'Booked', 'Quoted', 'Won', 'Closed']);
  assert.equal((await light.page.textContent('h1')).replace(/\s+/g, ' ').trim().replace(/\d+$/, '').trim(), 'Inbox');
  assert.equal(await light.page.locator('#status-filters button[data-status="inbox"]').getAttribute('data-status'), 'inbox');            // stored value unchanged
  assert.equal(await light.page.locator('#conversation-status option[value="inbox"]').innerText(), 'New lead');
  ok('the page is still called "Inbox"; the first status reads "New lead" (stored value stays "inbox")');

  // selected state: a faint tint of that stage's colour, stronger than the resting chip, in each stage
  const selBg = {};
  for (const s of STAGES) {
    await light.page.click(`#status-filters button[data-status="${s}"]`);
    selBg[s] = await light.page.locator(`#status-filters button[data-status="${s}"]`).evaluate((e) => getComputedStyle(e).backgroundColor);
    const restOther = await light.page.locator(`#status-filters button:not([data-status="${s}"])`).first().evaluate((e) => getComputedStyle(e).backgroundColor);
    assert.notEqual(selBg[s], restOther);
    assert.equal(selBg[s].startsWith('rgba') || selBg[s].startsWith('color') || selBg[s].startsWith('rgb'), true);
  }
  assert.equal(new Set(Object.values(selBg)).size, 5, 'five different selected tints');
  const alphaOf = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return 1; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(parseFloat); return p.length > 3 ? p[3] : 1; };
  for (const s of STAGES) assert.ok(alphaOf(selBg[s]) <= 0.2, 'selected tint stays pale: ' + selBg[s]);
  ok('each stage chip has its own pale tint when selected (five different, none strong)');

  // the conversation header selector carries the stage dot/tint and follows the status
  await light.page.click('#status-filters button[data-status="quoted"]');
  await light.page.locator(`.conv[data-phone="${ph.quoted}"]`).click();
  await light.page.waitForSelector('#thread:not([hidden])');
  const dotOf = () => light.page.locator('.conversation-state').evaluate((e) => getComputedStyle(e, '::before').backgroundColor);
  assert.equal(await dotOf(), inboxLight.quoted);
  assert.equal(await light.page.inputValue('#conversation-status'), 'quoted');
  await light.page.selectOption('#conversation-status', 'won');
  await light.page.waitForFunction(() => !document.getElementById('conversation-status').disabled && document.querySelector('.conversation-state').dataset.status === 'won');
  assert.equal(await dotOf(), inboxLight.won);
  await light.page.screenshot({ path: path.join(SHOTS, 'inbox-stage-colours-desktop.png') });
  ok('the status selector in the conversation header shows the stage dot and updates with the status');

  // ---- desktop and tablet widths: the five chips sit side by side without overlapping or clipping ----
  async function chipsFit(page, label) {
    const boxes = await page.locator('#status-filters button').evaluateAll((bs) => bs.map((b) => { const r = b.getBoundingClientRect(); return { l: r.left, r: r.right, clip: b.scrollWidth > b.clientWidth + 1, t: b.textContent }; }));
    assert.equal(boxes.length, 5);
    for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i].l >= boxes[i - 1].r - 0.5, label + ': chips overlap: ' + JSON.stringify(boxes));
    assert.deepEqual(boxes.filter((b) => b.clip).map((b) => b.t), [], label + ': a chip is clipped');
    const pane = await page.locator('.list-pane').boundingBox(); assert.ok(boxes[4].r <= pane.x + pane.width + 0.5, label + ': chips overflow the pane');
  }
  await chipsFit(light.page, 'desktop 1360');
  const tab = await open({ viewport: { width: 1024, height: 768 } });
  await chipsFit(tab.page, 'tablet 1024');
  await tab.page.screenshot({ path: path.join(SHOTS, 'inbox-stage-colours-tablet.png') });
  await tab.ctx.close();
  ok('desktop and tablet widths: the five coloured chips sit side by side with no overlap or clipping');

  // ---- phone: Inbox chips fit, are coloured and readable ----
  const mp = dark.page;
  await mp.evaluate(() => { location.hash = ''; });
  await mp.waitForSelector('#status-filters');
  await mp.tap('#status-filters button[data-status="booked"]');
  assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const clipped = await mp.locator('#status-filters button').evaluateAll((bs) => bs.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent));
  assert.deepEqual(clipped, []);
  const sel = await mp.locator('#status-filters button[data-status="booked"]').evaluate((e) => getComputedStyle(e).backgroundColor);
  assert.notEqual(sel, 'rgba(0, 0, 0, 0)');
  await mp.screenshot({ path: path.join(SHOTS, 'inbox-stage-colours-phone.png') });
  ok('phone (system theme dark): the five Inbox chips fit without clipping, with stage dots and a tinted selected chip, in the light theme');

  assert.deepEqual(errors, [], 'browser errors: ' + JSON.stringify(errors)); ok('no JavaScript errors in the browser');
  await browser.close(); web.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.stack || e.message || e); process.exit(1); });
