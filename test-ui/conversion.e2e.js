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
meta.keepAliveTimeout = 0;   // test harness only: never drop an idle connection mid-test (avoids an ECONNRESET race with the emulator's pooled connections)

const DAY = 86400000, ago = (d) => Timestamp.fromMillis(Date.now() - d * DAY);
const ph = { flip: '353850000016', newLead: '353850000011', quoted1: '353850000012', quoted2: '353850000013', legacyWon: '353850000014', legacyQuoted: '353850000015' };

(async () => {
  initializeApp({ projectId: 'demo-leados' });
  const db = getFirestore();
  // Test customers as they really exist: created long before today, so the stage dates come ONLY from the moves made in this test.
  const seed = async (id, conv, contact) => {
    await db.doc('conversations/' + id).set({ phone: id, name: contact.name, createdAt: ago(60), updatedAt: ago(1), lastMessage: 'Hi', unreadCount: 0, ...conv });
    await db.doc('contacts/' + id).set({ phone: id, createdAt: ago(60), ...contact });
  };
  await seed(ph.newLead, {}, { name: 'Nina New' });                                                     // New lead, no history
  await seed(ph.quoted1, { inboxStatus: 'quoted', stageDates: { quoted: ago(30) } }, { name: 'Quentin Quoted', quoteValue: 14500 });
  await seed(ph.quoted2, { inboxStatus: 'quoted', stageDates: { quoted: ago(25) } }, { name: 'Quincy Quoted', quoteValue: 9000 });
  await seed(ph.legacyWon, { inboxStatus: 'won' }, { name: 'Legacy Won', quoteValue: 20000 });          // moved long before stage dates existed: no history
  await seed(ph.legacyQuoted, { inboxStatus: 'quoted' }, { name: 'Legacy Quoted' });
  await seed(ph.flip, {}, { name: 'Flip Flop' });                                                        // used for the accidental-move tests

  const u = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true });
  const token = await getAuth().createCustomToken(u.uid);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 860 } })).newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const lane = (s) => page.locator(`.lane[data-stage="${s}"]`);
  const row = (id) => page.locator(`.prow[data-phone="${id}"]`);
  const conv = async (id) => (await db.doc('conversations/' + id).get()).data();
  const settled = async (id, status) => { for (let i = 0; i < 60; i++) { if ((await conv(id)).inboxStatus === status) return; await sleep(100); } assert.fail(id + ' never became ' + status); };
  // the overview tile for a label: { num, sub }
  const tile = async (label) => page.locator('.ov-item', { has: page.locator('dt', { hasText: new RegExp('^' + label + '$') }) }).evaluate((e) => ({ num: e.querySelector('.ov-num').textContent, sub: e.querySelector('.ov-sub').textContent }));
  const tileIs = async (label, num, sub) => { await page.waitForFunction(([l, n, sb]) => { const e = [...document.querySelectorAll('.ov-item')].find((x) => x.querySelector('dt').textContent === l); return e && e.querySelector('.ov-num').textContent === n && e.querySelector('.ov-sub').textContent === sb; }, [label, num, sub], { timeout: 8000 }).catch(async () => assert.fail(label + ': got ' + JSON.stringify(await tile(label)) + ', wanted ' + num + ' / ' + sub)); };
  async function dragTo(id, toStage) {
    const b = await row(id).boundingBox(), t = await lane(toStage).boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + 20); await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 12, b.y + 26, { steps: 3 });
    await page.mouse.move(t.x + t.width / 2, t.y + 120, { steps: 12 }); await page.mouse.up();
  }

  console.log('CONVERSION METRICS E2E: customers created 60 days ago, moved today');
  await page.goto('http://127.0.0.1:5055/');
  await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await page.waitForSelector('#app:not([hidden])');
  await page.click('#nav-pipeline');
  await page.waitForSelector('.lane .prow');
  assert.equal(await page.getAttribute('#ov-period button[data-period="month"]', 'aria-pressed'), 'true');     // the default period

  // before any move this month: nothing to measure, and the screen says so
  await tileIs('Lead → Booked', '—', 'nobody to measure yet'); await tileIs('Quote → Won', '—', 'nobody to measure yet');
  ok('before any move this month, both rates honestly show "—" (nothing to measure), not a made-up number');

  // New lead -> Booked (menu)
  await row(ph.newLead).hover(); await row(ph.newLead).locator('.prow-menu').click(); await page.click('.move-menu button:has-text("Booked")');
  await settled(ph.newLead, 'booked'); assert.ok((await conv(ph.newLead)).stageDates.booked);
  await tileIs('Lead → Booked', '100%', '1 of 1 · small sample');
  await tileIs('Booked', '1', ' ');
  ok('New lead -> Booked (menu): Lead -> Booked becomes 100% (1 of 1) even though the customer is 60 days old');
  assert.equal((await tile('Quote → Won')).num, '—');                                                           // untouched by a booking
  await page.screenshot({ path: path.join(SHOTS, 'conversion-1-booked.png') });

  // Quoted -> Won (drag)
  await dragTo(ph.quoted1, 'won'); await settled(ph.quoted1, 'won'); assert.ok((await conv(ph.quoted1)).stageDates.won);
  await tileIs('Quote → Won', '100%', '1 of 1 · small sample');
  await tileIs('Lead → Booked', '100%', '2 of 2 · small sample');                                              // a Won customer necessarily passed Booked
  await tileIs('Won', '1', '€14,500');
  ok('Quoted -> Won (drag): Quote -> Won becomes 100% (1 of 1); Won = 1, €14,500; Lead -> Booked 2 of 2');

  // Quoted -> Closed (lost): counts as a quote that did not win
  await row(ph.quoted2).hover(); await row(ph.quoted2).locator('.prow-menu').click(); await page.click('.move-menu button:has-text("Closed")');
  await settled(ph.quoted2, 'closed');
  await tileIs('Quote → Won', '50%', '1 of 2 · small sample');
  await tileIs('Lead → Booked', '100%', '3 of 3 · small sample');                                              // the lost customer joins the leads measured, and had reached Booked (it was Quoted first)
  ok('Quoted -> Closed (lost): Quote -> Won falls to 50% (1 of 2), as it should');
  await page.screenshot({ path: path.join(SHOTS, 'conversion-2-final.png') });

  // legacy customers with no history are never guessed into the rates, in any period
  for (const p of ['30d', 'all']) {
    await page.click(`#ov-period button[data-period="${p}"]`);
    await tileIs('Quote → Won', '50%', '1 of 2 · small sample');
  }
  assert.equal((await tile('Won')).num, '2');                                                                    // all time: the plain COUNT still includes the old Won customer (a fact)
  ok('customers moved before stage dates existed are not counted in either rate (not guessed), in 30 days or all time');

  // moving a Won customer back out removes the win
  await page.click('#ov-period button[data-period="month"]');
  await row(ph.quoted1).hover(); await row(ph.quoted1).locator('.prow-menu').click(); await page.click('.move-menu button:has-text("Quoted")');
  await settled(ph.quoted1, 'quoted');
  await page.waitForSelector('#pipe-toast:not([hidden])');
  assert.match(await page.textContent('#pipe-toast'), /Corrected: the move to Won was undone and will not be counted/);
  await tileIs('Quote → Won', '0%', '0 of 1 · small sample');                                                    // straight back inside 5 minutes: the Won move leaves no trace
  assert.equal((await conv(ph.quoted1)).stageDates.won, undefined);
  ok('moving a customer straight back out of Won (within 5 minutes) is a correction: the Won date is gone and the rate forgets it');

  // ---- accidental New lead -> Booked, straight back: the percentage returns to what it was ----
  await tileIs('Lead → Booked', '100%', '2 of 2 · small sample');
  await row(ph.flip).hover(); await row(ph.flip).locator('.prow-menu').click(); await page.click('.move-menu button:has-text("Booked")');
  await settled(ph.flip, 'booked');
  await tileIs('Lead → Booked', '100%', '3 of 3 · small sample');
  await row(ph.flip).hover(); await row(ph.flip).locator('.prow-menu').click(); await page.click('.move-menu button:has-text("New lead")');
  await settled(ph.flip, 'inbox');
  await tileIs('Lead → Booked', '100%', '2 of 2 · small sample');
  await tileIs('Booked', '1', ' ');                                                                              // only the genuine booking (Nina) is counted
  assert.match(await page.textContent('#pipe-toast'), /Corrected: the move to Booked was undone/);
  const fc = await conv(ph.flip); assert.equal(fc.stageDates.booked, undefined); assert.equal(fc.lastMove, undefined); assert.equal(fc.inboxStatus, 'inbox');
  await page.screenshot({ path: path.join(SHOTS, 'conversion-3-corrected.png') });
  ok('accidental New lead -> Booked, moved straight back: Lead -> Booked and Booked return to their earlier values, and a message says so');

  // ---- the same move after the 5-minute window is a genuine history: the Booked date stays ----
  await row(ph.flip).hover(); await row(ph.flip).locator('.prow-menu').click(); await page.click('.move-menu button:has-text("Booked")');
  await settled(ph.flip, 'booked');
  const lm = (await conv(ph.flip)).lastMove;
  await db.doc('conversations/' + ph.flip).update({ 'lastMove.at': Timestamp.fromMillis(lm.at.toMillis() - 6 * 60 * 1000) });   // pretend it happened 6 minutes ago
  await page.evaluate(() => { document.getElementById('pipe-toast').hidden = true; });
  await row(ph.flip).hover(); await row(ph.flip).locator('.prow-menu').click(); await page.click('.move-menu button:has-text("New lead")');
  await settled(ph.flip, 'inbox');
  const fc2 = await conv(ph.flip); assert.ok(fc2.stageDates.booked); assert.equal(fc2.lastMove.to, 'inbox');
  await tileIs('Lead → Booked', '100%', '3 of 3 · small sample');                                                // a genuine booking stays in the history
  assert.equal(await page.locator('#pipe-toast:not([hidden])').count(), 0);
  ok('the same move after more than 5 minutes keeps the Booked date and the rate (no correction, no message)');

  // the explanation is on the screen
  const help = await page.locator('.ov-item dt.has-help').evaluateAll((es) => es.map((e) => [e.textContent, e.title]));
  assert.deepEqual(help.map((h) => h[0]), ['Lead → Booked', 'Quote → Won']);
  assert.match(help[0][1], /reached Booked/); assert.match(help[1][1], /Closed count as not won/);
  ok('hovering each rate label explains how it is worked out');

  assert.deepEqual(errors, [], 'browser errors: ' + JSON.stringify(errors)); ok('no JavaScript errors in the browser');
  await browser.close(); web.close(); meta.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.stack || e.message || e); process.exit(1); });
