'use strict';
// Phase 4 browser test: pipeline screen, stage moves, quote value, filters, overview, phone layout, and the Phase 3 lead flow.
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getAuth } = fnRequire('firebase-admin/auth');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
const FN = 'http://127.0.0.1:5001/demo-leados/europe-west1', KEY = 'emulator-leads-key-0123456789abcdef';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const graph = [];
const meta = http.createServer((req, res) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => {
  graph.push({ url: req.url, body: JSON.parse(Buffer.concat(c).toString() || '{}') });
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ messages: [{ id: 'wamid.OUT' + graph.length }] })); }); }).listen(9911);

const DAY = 86400000, ago = (d) => Timestamp.fromMillis(Date.now() - d * DAY);
const ph = { legacy: '353850000001', booked: '353850000002', quoted: '353850000003', noval: '353850000004', won: '353850000005', closed: '353850000006', legacyWon: '353850000007' };

(async () => {
  initializeApp({ projectId: 'demo-leados' });
  const db = getFirestore();
  const seed = async (id, conv, contact) => {
    await db.doc('conversations/' + id).set({ phone: id, name: contact.name, createdAt: ago(20), updatedAt: ago(1), lastMessage: 'Hi', unreadCount: 0, ...conv });
    await db.doc('contacts/' + id).set({ phone: id, createdAt: ago(20), ...contact });
  };
  await seed(ph.legacy, {}, { name: 'Legacy Larry' });
  await seed(ph.booked, { inboxStatus: 'booked', stageDates: { booked: ago(3) } }, { name: 'Brian Booked', location: 'Skerries', source: 'Meta Ads' });
  await seed(ph.quoted, { inboxStatus: 'quoted', stageDates: { booked: ago(12), quoted: ago(8) }, unreadCount: 1 }, { name: 'Quinn Quoted', location: 'Balbriggan', source: 'Referral', quoteValue: 14500 });
  await seed(ph.noval, { inboxStatus: 'quoted', stageDates: { quoted: ago(2) } }, { name: 'Nora Novalue', source: 'Meta Ads' });
  await seed(ph.won, { inboxStatus: 'won', stageDates: { booked: ago(9), quoted: ago(6), won: ago(1) } }, { name: 'Wendy Won', source: 'Meta Ads', quoteValue: 16000 });
  await seed(ph.closed, { inboxStatus: 'closed', stageDates: { quoted: ago(15), closed: ago(5) } }, { name: 'Cathal Closed', source: 'Referral', quoteValue: 9000 });
  await seed(ph.legacyWon, { inboxStatus: 'won' }, { name: 'Old Oisin', quoteValue: 20000 });

  const u = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true });
  const token = await getAuth().createCustomToken(u.uid);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource|status of 500/.test(m.text())) errors.push(m.text()); });
  const requests = [];                                                  // every stage-change request the page makes
  page.on('request', (r) => { if (/setConversationStatus/.test(r.url()) && r.method() === 'POST') requests.push(JSON.parse(r.postData() || '{}').data); });
  const lane = (s) => page.locator(`.lane[data-stage="${s}"]`);
  const row = (id) => page.locator(`.prow[data-phone="${id}"]`);
  const inLane = (s, id) => lane(s).locator(`.prow[data-phone="${id}"]`);
  const conv = async (id) => (await db.doc('conversations/' + id).get()).data();
  const settled = async (id, status) => { for (let i = 0; i < 60; i++) { if ((await conv(id)).inboxStatus === status) return; await sleep(100); } assert.fail(id + ' never became ' + status); };
  const center = async (loc) => { const b = await loc.boundingBox(); return { x: b.x + b.width / 2, y: b.y + Math.min(b.height / 2, 60) }; };
  // A real mouse drag: press on the card, move across to the target column, optionally release.
  async function drag(id, toStage, { drop = true, hold } = {}) {
    const from = await center(row(id)), to = await center(lane(toStage));
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(from.x + 12, from.y + 6, { steps: 3 });
    await page.mouse.move(to.x, to.y + 80, { steps: 12 });
    if (hold) await hold();
    if (drop) await page.mouse.up();
  }

  console.log('PIPELINE DRAG-AND-DROP + STAGE COLOURS E2E');
  await page.goto('http://127.0.0.1:5055/');
  await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await page.waitForSelector('#app:not([hidden])');
  await page.click('#nav-pipeline');
  await page.waitForSelector('.lane[data-stage="inbox"] .prow');
  await page.click('#ov-period button[data-period="all"]');

  // ---- colours: small dots only; columns and cards stay uncoloured until a card is dragged over a column ----
  const dot = (s) => lane(s).locator('.lane-title').evaluate((e) => getComputedStyle(e, '::before').backgroundColor);
  const dots = await Promise.all(['inbox', 'booked', 'quoted', 'won', 'closed'].map(dot));
  assert.equal(new Set(dots).size, 5, 'five different dot colours: ' + dots);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.lane')].map((l) => getComputedStyle(l, '::before').backgroundColor)), Array(5).fill('rgba(0, 0, 0, 0)'));
  assert.equal(await row(ph.quoted).evaluate((e) => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('pipe-board')).backgroundColor), 'rgba(0, 0, 0, 0)');
  await page.screenshot({ path: path.join(SHOTS, 'pipeline-colours.png') });
  ok('each stage has a small coloured dot beside its heading; columns, cards and the board have no colour fill');
  assert.equal(await page.locator('.prow[draggable=true]').count(), 7);
  assert.ok(await page.locator('.prow-menu').count() >= 7);
  ok('every card is draggable on desktop and keeps its three-dot menu');

  // ---- drag feedback: dragged card fades, only the destination column is tinted ----
  const tint = (s) => lane(s).evaluate((e) => getComputedStyle(e, '::before').backgroundColor);
  await drag(ph.quoted, 'won', { hold: async () => {
    assert.ok(await row(ph.quoted).evaluate((e) => e.classList.contains('dragging')));
    await lane('won').evaluate((e) => e.classList.contains('drop-target')) || await page.waitForSelector('.lane[data-stage="won"].drop-target');
    assert.notEqual(await tint('won'), 'rgba(0, 0, 0, 0)');
    assert.equal(await tint('quoted'), 'rgba(0, 0, 0, 0)');                       // its own column is not a destination
    assert.equal(await page.locator('.lane.drop-target').count(), 1);
    await page.screenshot({ path: path.join(SHOTS, 'pipeline-drag.png') });
  } });
  await inLane('won', ph.quoted).waitFor();
  ok('while dragging, the card fades and only the destination column gets a faint tint of its stage colour');
  assert.equal(await page.locator('.dragging, .drop-target, .is-dragging').count(), 0);
  ok('the highlight and drag styling are fully cleared after the drop');

  // ---- the drop used the existing status function, exactly once, and stamped the date ----
  assert.deepEqual(requests, [{ phone: ph.quoted, status: 'won' }]);
  await settled(ph.quoted, 'won');
  const c = await conv(ph.quoted);
  assert.equal(c.inboxStatus, 'won'); assert.ok(c.stageDates.won); assert.ok(c.stageDates.quoted); assert.equal(c.unreadCount, 1);
  const ov = await page.locator('#ov-grid').innerText();
  assert.match(ov, /Won\s*\n?\s*3[\s\S]*€50,500/);                                // 36,000 + 14,500: metrics follow immediately
  assert.match(ov, /Open quotes[\s\S]*1 quote · 1 without a value/);
  ok('dropping calls the same setConversationStatus (one request), stamps the Won date, and the overview updates (Won 3, €50,500)');

  // ---- the menu still works and sends the identical request ----
  requests.length = 0;
  await row(ph.booked).hover(); await row(ph.booked).locator('.prow-menu').click();
  await page.click('.move-menu button:has-text("Quoted")');
  await inLane('quoted', ph.booked).waitFor();
  assert.deepEqual(requests, [{ phone: ph.booked, status: 'quoted' }]);
  await settled(ph.booked, 'quoted'); assert.ok((await conv(ph.booked)).stageDates.quoted);
  ok('the three-dot menu still works and sends the identical request');

  // ---- dropping on the card\'s own column does nothing ----
  requests.length = 0;
  const before = (await conv(ph.won)).stageDates.won.toMillis();
  await drag(ph.won, 'won');
  await page.waitForTimeout(400);
  assert.equal(requests.length, 0); assert.equal((await conv(ph.won)).stageDates.won.toMillis(), before);
  await inLane('won', ph.won).waitFor();
  ok('dropping a card back on its own column sends nothing and changes nothing');

  // ---- a failed save puts the card back with a clear message ----
  await page.route('**/setConversationStatus', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { status: 'INTERNAL', message: 'boom' } }) }));
  requests.length = 0;
  const closedBefore = await conv(ph.closed);
  await drag(ph.closed, 'booked');
  await page.waitForSelector('#pipe-toast:not([hidden])');
  assert.match(await page.textContent('#pipe-toast'), /Could not move Cathal Closed to Booked\. They are back in Closed/);
  await inLane('closed', ph.closed).waitFor();
  assert.equal(await page.locator(`.lane[data-stage="booked"] .prow[data-phone="${ph.closed}"]`).count(), 0);
  assert.equal((await conv(ph.closed)).inboxStatus, 'closed'); assert.deepEqual((await conv(ph.closed)).stageDates, closedBefore.stageDates);
  assert.equal(await row(ph.closed).evaluate((e) => e.classList.contains('pending')), false);
  ok('if the save fails the card returns to its original column, an error explains it, and nothing was changed in the database');
  await page.unroute('**/setConversationStatus');

  // ---- a second drag while the first is still saving cannot cause a duplicate or inconsistent update ----
  await page.route('**/setConversationStatus', async (r) => { await sleep(900); await r.continue(); });
  requests.length = 0;
  await drag(ph.won, 'closed');
  await inLane('closed', ph.won).waitFor();                                        // shown in its new column straight away, dimmed
  assert.ok(await row(ph.won).evaluate((e) => e.classList.contains('pending')));
  await drag(ph.won, 'booked');                                                    // try to move it again mid-save
  await page.waitForFunction(() => !document.querySelector('.prow.pending'));
  assert.equal(requests.length, 1);
  await settled(ph.won, 'closed');
  await inLane('closed', ph.won).waitFor();
  assert.equal(await page.locator(`.prow[data-phone="${ph.won}"]`).count(), 1);
  ok('while a card is saving it is dimmed and cannot be moved again: one request, one card, consistent final state');
  await page.unroute('**/setConversationStatus');

  // ---- phone: no drag-and-drop dependency, tap + menu is the way ----
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const mp = await mctx.newPage(); mp.on('pageerror', (e) => errors.push('mobile: ' + e.message));
  await mp.goto('http://127.0.0.1:5055/');
  await mp.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await mp.waitForSelector('#app:not([hidden])');
  await mp.tap('#to-pipeline');
  await mp.waitForSelector('.lane.lane-on .prow');
  assert.equal(await mp.locator('.prow[draggable=true]').count(), 0);
  assert.equal(await mp.locator('#pipe-stages button').count(), 5);
  const chipDots = await mp.locator('#pipe-stages button').evaluateAll((bs) => bs.map((b) => getComputedStyle(b, '::before').backgroundColor));
  assert.equal(new Set(chipDots).size, 5);
  assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await mp.screenshot({ path: path.join(SHOTS, 'pipeline-phone-colours.png') });
  await mp.tap('#pipe-stages button[data-stage="quoted"]');
  await mp.locator(`.prow[data-phone="${ph.noval}"] .prow-menu`).tap();
  await mp.tap('.move-menu button:has-text("Booked")');
  await mp.waitForFunction((p) => !document.querySelector(`.lane[data-stage="quoted"] .prow[data-phone="${p}"]`), ph.noval);
  await settled(ph.noval, 'booked');
  ok('phone: cards are not draggable, the stage chips carry the colour dots, and tap + menu moves a customer');
  await mctx.close();

  assert.deepEqual(errors, [], 'browser errors: ' + JSON.stringify(errors)); ok('no JavaScript errors in the browser');
  await browser.close(); web.close(); meta.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.stack || e.message || e); process.exit(1); });
