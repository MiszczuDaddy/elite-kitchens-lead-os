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
const ph = { legacy: '353850000001', booked: '353850000002', quoted: '353850000003', noval: '353850000004', won: '353850000005', closed: '353850000006', legacyWon: '353850000007', meta: '353850000008' };

(async () => {
  initializeApp({ projectId: 'demo-leados' });
  const db = getFirestore();
  const seed = async (id, conv, contact) => {
    await db.doc('conversations/' + id).set({ phone: id, name: contact.name, createdAt: ago(20), updatedAt: ago(1), lastMessage: 'Hi', unreadCount: 0, ...conv });
    await db.doc('contacts/' + id).set({ phone: id, createdAt: ago(20), ...contact });
  };
  await seed(ph.legacy, {}, { name: 'Legacy Larry' });                                                                  // bare old shape
  await seed(ph.booked, { inboxStatus: 'booked', stageDates: { booked: ago(3) } }, { name: 'Brian Booked', location: 'Skerries', projectType: 'Kitchen', source: 'Meta Ads' });
  await seed(ph.quoted, { inboxStatus: 'quoted', stageDates: { booked: ago(12), quoted: ago(8) }, unreadCount: 1 }, { name: 'Quinn Quoted', location: 'Balbriggan', projectType: 'Kitchen', source: 'Referral', quoteValue: 14500 });
  await seed(ph.noval, { inboxStatus: 'quoted', stageDates: { quoted: ago(2) } }, { name: 'Nora Novalue', source: 'Meta Ads' });
  await seed(ph.won, { inboxStatus: 'won', stageDates: { booked: ago(9), quoted: ago(6), won: ago(1) } }, { name: 'Wendy Won', location: 'Swords', projectType: 'Kitchen', source: 'Meta Ads', quoteValue: 16000 });
  await seed(ph.closed, { inboxStatus: 'closed', stageDates: { quoted: ago(15), closed: ago(5) } }, { name: 'Cathal Closed', source: 'Referral', quoteValue: 9000 });
  await seed(ph.legacyWon, { inboxStatus: 'won' }, { name: 'Old Oisin', quoteValue: 20000 });                          // won before stage dates existed

  const u = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true });
  const token = await getAuth().createCustomToken(u.uid);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const lane = (s) => page.locator(`.lane[data-stage="${s}"]`);
  const row = (id) => page.locator(`.prow[data-phone="${id}"]`);
  const count = async (s) => (await lane(s).locator('.prow').count());
  console.log('PIPELINE E2E: real page + real functions + emulators');
  await page.goto('http://127.0.0.1:5055/');
  await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await page.waitForSelector('#app:not([hidden])');

  // ---- Inbox wording: stored value stays "inbox", the label is New lead ----
  assert.equal((await page.locator('#status-filters button[data-status="inbox"]').innerText()).trim(), 'New lead');
  assert.equal(await page.locator('#conversation-status option[value="inbox"]').innerText(), 'New lead');
  await page.waitForSelector(`.conv[data-phone="${ph.legacy}"]`);
  ok('the Inbox chip and status selector say "New lead"; old customers with no status still appear there');

  // ---- open the pipeline ----
  await page.click('#nav-pipeline');
  await page.waitForSelector('.lane[data-stage="inbox"] .prow');
  assert.equal(await page.getAttribute('#app', 'data-view'), 'pipeline');
  assert.equal(await page.locator('#nav-pipeline').getAttribute('aria-current'), 'page');
  assert.deepEqual([await count('inbox'), await count('booked'), await count('quoted'), await count('won'), await count('closed')], [1, 1, 2, 2, 1]);   // legacy + meta not yet arrived
  assert.match(await lane('inbox').innerText(), /New lead/);
  ok('the Pipeline screen groups customers into New lead / Booked / Quoted / Won / Closed (the old no-status customer is in New lead)');
  assert.match(await lane('quoted').locator('.lane-sum').innerText(), /€14,500/);
  assert.match(await lane('won').locator('.lane-sum').innerText(), /€36,000/);
  assert.match(await row(ph.noval).innerText(), /No value yet/);
  assert.match(await row(ph.quoted).innerText(), /€14,500/); assert.match(await row(ph.quoted).innerText(), /8 days/);
  assert.doesNotMatch(await row(ph.legacyWon).innerText(), /day|today/);                  // a Won customer from before stage dates existed: no made-up age
  ok('lane totals, quote values, "No value yet" nudge and days-in-stage are shown; old customers show no made-up dates');

  // ---- overview ----
  assert.equal(await page.getAttribute('#ov-period button[data-period="month"]', 'aria-pressed'), 'true');      // default period
  await page.click('#ov-period button[data-period="all"]');
  let ov = await page.locator('#ov-grid').innerText();
  assert.match(ov, /Open quotes[\s\S]*€14,500/); assert.match(ov, /2 quotes · 1 without a value/);
  assert.match(ov, /Won\s*\n?\s*2[\s\S]*€36,000/); assert.match(ov, /Average job[\s\S]*€18,000/);
  assert.equal(await page.getAttribute('#ov-period button[data-period="all"]', 'aria-pressed'), 'true');
  await page.click('#ov-period button[data-period="30d"]');                                                    // the old undated Won customer drops out of a dated period
  ov = await page.locator('#ov-grid').innerText();
  assert.match(ov, /Won\s*\n?\s*1[\s\S]*€16,000/); assert.match(ov, /Average job[\s\S]*€16,000/);
  await page.click('#ov-period button[data-period="all"]');
  ok('overview shows new leads, booked, quoted, won, open quotes, average job and conversion for the chosen period');
  await page.screenshot({ path: path.join(SHOTS, 'pipeline-desktop.png') });

  // ---- search / source / date filters ----
  await page.fill('#pipe-search', 'quinn');
  assert.deepEqual([await count('inbox'), await count('quoted')], [0, 1]);
  await page.fill('#pipe-search', '085 000 0003'); assert.equal(await count('quoted'), 1);                 // Irish-format number finds 353850000003
  await page.fill('#pipe-search', '');
  await page.selectOption('#pipe-source', 'Referral');
  assert.deepEqual([await count('quoted'), await count('won'), await count('closed')], [1, 0, 1]);
  assert.match(await page.textContent('#ov-title'), /Referral/);
  await page.selectOption('#pipe-source', '');
  await page.selectOption('#pipe-added', 'custom');
  const day = (d) => new Date(Date.now() - d * DAY).toISOString().slice(0, 10);
  await page.fill('#pipe-from', day(30)); await page.fill('#pipe-to', day(25));
  assert.equal(await page.locator('.prow').count(), 0);
  await page.fill('#pipe-from', day(30)); await page.fill('#pipe-to', day(0));
  assert.equal(await page.locator('.prow').count(), 7);
  await page.selectOption('#pipe-added', 'all');
  ok('search (name, Irish phone), lead source and date-range filters narrow the board; the overview follows the source');

  // ---- move a customer with the menu ----
  await row(ph.legacy).hover(); await row(ph.legacy).locator('.prow-menu').click();
  assert.equal(await page.locator('.move-menu button:disabled').innerText().then((t) => t.replace('✓', '').trim()), 'New lead');
  await page.click('.move-menu button:has-text("Booked")');
  await lane('booked').locator(`.prow[data-phone="${ph.legacy}"]`).waitFor();
  assert.equal(await count('inbox'), 0);
  for (let i = 0; i < 60 && (await db.doc('conversations/' + ph.legacy).get()).data().inboxStatus !== 'booked'; i++) await sleep(100);   // the card moves instantly; wait for the save
  const moved = (await db.doc('conversations/' + ph.legacy).get()).data();
  assert.equal(moved.inboxStatus, 'booked'); assert.ok(moved.stageDates.booked); assert.equal(moved.unreadCount, 0);
  ok('"Move to…" changes the stage in one click, the customer jumps column, and the booked date is stamped automatically');
  await row(ph.legacy).locator('.prow-menu').click(); await page.keyboard.press('Escape');
  assert.equal(await page.locator('.move-menu').count(), 0);
  ok('the menu closes with Escape');

  // ---- open a customer: existing conversation + details, quote value editing ----
  await row(ph.noval).click();
  await page.waitForSelector('#thread:not([hidden])');
  assert.equal(await page.getAttribute('#app', 'data-view'), 'thread');
  assert.equal(await page.inputValue('#conversation-status'), 'quoted');
  await page.waitForSelector('#details:not([hidden])');
  assert.equal(await page.inputValue('#d-quoteValue'), '');
  await page.fill('#d-quoteValue', 'twelve grand'); await page.click('#d-save');
  assert.match(await page.textContent('#d-msg'), /number of euros/);
  assert.equal((await db.doc('contacts/' + ph.noval).get()).data().quoteValue, undefined);
  await page.fill('#d-quoteValue', '€12,000'); await page.click('#d-save');
  await page.waitForFunction(() => document.getElementById('d-msg').textContent === 'Saved');
  assert.equal((await db.doc('contacts/' + ph.noval).get()).data().quoteValue, 12000);
  await page.waitForFunction(() => document.getElementById('d-quoteValue').value === '€12,000');
  assert.match(await page.textContent('#d-meta'), /Quoted/);
  await page.screenshot({ path: path.join(SHOTS, 'details-quote-value.png') });
  ok('clicking a customer opens their conversation and Details; quote value is validated, saved as whole euros, shown as €12,000, with stage dates in the footer');
  await page.fill('#d-name', 'Nora N.'); await page.click('#d-save');
  await page.waitForFunction(() => document.getElementById('d-msg').textContent === 'Saved');
  assert.equal((await db.doc('contacts/' + ph.noval).get()).data().quoteValue, 12000);     // ordinary saves leave it alone
  await page.click('#nav-pipeline');
  await page.waitForSelector('.lane[data-stage="quoted"] .prow');
  await page.waitForFunction(() => /€26,500/.test((document.querySelector('.lane[data-stage="quoted"] .lane-sum') || {}).textContent || ''));
  assert.match(await lane('quoted').locator('.lane-sum').innerText(), /€26,500/);
  assert.doesNotMatch(await row(ph.noval).innerText(), /No value yet/);
  ok('back on the Pipeline the Quoted total is now €26,500');

  // ---- Phase 3: a Meta lead arriving through leadIntake lands in New lead on the board ----
  const lead = { leadId: '5551112223334', formName: '(03/26) Kitchens', Name: 'Meta Maeve', Phone: '0871234567', Email: 'maeve@example.com', Eircode: 'K32 AB12' };
  const r = await fetch(FN + '/leadIntake', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Bearer ' + KEY },
    body: new URLSearchParams(lead).toString() });
  const j = await r.json(); assert.equal(r.status, 200); assert.equal(j.welcome, 'sent');
  await lane('inbox').locator('.prow[data-phone="353871234567"]').waitFor();
  assert.match(await lane('inbox').locator('.prow[data-phone="353871234567"]').innerText(), /Meta Ads/);
  const mc = (await db.doc('conversations/353871234567').get()).data();
  assert.equal(mc.inboxStatus, undefined); assert.equal(mc.stageDates, undefined); assert.equal(graph.length, 1);
  ok('a new Meta lead (form-style post, as Make sends it) appears automatically under New lead, source "Meta Ads", with one welcome sent and no stage fields written');
  assert.deepEqual((await (await fetch(FN + '/leadIntake', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Bearer ' + KEY }, body: new URLSearchParams(lead).toString() })).json()).status, 'duplicate');
  assert.equal(graph.length, 1);
  ok('a Make retry of the same lead sends nothing and adds nothing');

  // ---- phone layout ----
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const mp = await mctx.newPage(); mp.on('pageerror', (e) => errors.push('mobile: ' + e.message));
  await mp.goto('http://127.0.0.1:5055/');
  await mp.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await mp.waitForSelector('#app:not([hidden])');
  await mp.tap('#to-pipeline');
  await mp.waitForSelector('.lane.lane-on .prow');
  assert.equal(await mp.getAttribute('#app', 'data-view'), 'pipeline');
  assert.equal(await mp.locator('.lane.lane-on').count(), 1); assert.equal(await mp.locator('.lane:visible').count(), 1);
  assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await mp.tap('#pipe-stages button[data-stage="quoted"]');
  assert.equal(await mp.locator('.lane:visible .prow').count(), 2);
  await mp.screenshot({ path: path.join(SHOTS, 'pipeline-phone.png') });
  await mp.locator(`.prow[data-phone="${ph.quoted}"] .prow-menu`).tap();
  await mp.tap('.move-menu button:has-text("Won")');
  await mp.waitForFunction((p) => !document.querySelector(`.lane[data-stage="quoted"] .prow[data-phone="${p}"]`), ph.quoted);
  for (let i = 0; i < 60 && (await db.doc('conversations/' + ph.quoted).get()).data().inboxStatus !== 'won'; i++) await sleep(100);
  assert.equal((await db.doc('conversations/' + ph.quoted).get()).data().inboxStatus, 'won');
  await mp.tap('#pipe-stages button[data-stage="won"]');
  await mp.locator(`.prow[data-phone="${ph.quoted}"]`).tap();
  await mp.waitForSelector('#thread:not([hidden])');
  await mp.tap('#back');
  await mp.waitForSelector('.lane.lane-on');
  assert.equal(await mp.getAttribute('#app', 'data-view'), 'pipeline');
  ok('phone: the Pipeline opens from the Inbox, shows one stage at a time with no sideways scroll, moves a customer, and Back returns to the Pipeline');
  await mp.tap('#pipe-back');
  await mp.waitForSelector('.conv');
  assert.equal(await mp.getAttribute('#app', 'data-view'), 'list');
  ok('phone: Back from the Pipeline returns to the Inbox');
  await mctx.close();

  assert.deepEqual(errors, [], 'browser errors: ' + JSON.stringify(errors)); ok('no JavaScript errors in the browser');
  await browser.close(); web.close(); meta.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.stack || e.message || e); process.exit(1); });
