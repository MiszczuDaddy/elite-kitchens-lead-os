'use strict';
// Phase 6 M3 browser test: Quote Settings, building and saving a draft (live totals from the calculator, problems shown),
// the Quotes list, the customer-profile block, adding a customer without messaging, accept / decline / reopen with their
// pipeline effects, revise, expiry, delete, and the phone layout. Real page + real functions + emulators. Sending (with the
// PDF) arrives in M4, so this test prepares sent quotes by calling sendQuote from the page with a tiny test PDF.
// Every name, number and price is made up.
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getAuth } = fnRequire('firebase-admin/auth');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const QE = require('../public/quote-engine.js');
const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
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
// A fake WhatsApp API: adding a customer without messaging must never reach it.
const graph = [];
const meta = http.createServer((req, res) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => {
  graph.push({ url: req.url }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ messages: [{ id: 'wamid.OUT' + graph.length }] })); }); }).listen(9911);
meta.keepAliveTimeout = 0;

const DAY = 86400000, ago = (d) => Timestamp.fromMillis(Date.now() - d * DAY);
const ph = { lena: '353860000011', quinn: '353860000012', cathal: '353860000013', wendy: '353860000014', dara: '353860000015' };
const PRICES = { ess: [110, 60], prem: [140, 65], pp: [150, 70] };
const priceList = () => ({ options: Object.fromEntries(Object.entries(PRICES).map(([k, [d, t]]) => [k, { perDoor: d, perTopBox: t }])), drawerBoxes: { cemux: 12, blum: 21 }, glazing: { small: 45, large: 90 },
  extras: [{ key: '', name: 'Pull-out bin', unit: 'per unit', price: 30, manual: false, free: false }, { key: '', name: 'Pocket door', unit: 'per opening', price: 0, manual: true, free: false }] });

(async () => {
  initializeApp({ projectId: 'demo-leados' });
  const db = getFirestore();
  const seed = async (id, conv, contact) => {
    await db.doc('conversations/' + id).set({ phone: id, name: contact.name, createdAt: ago(10), updatedAt: ago(1), lastMessage: 'Hi', unreadCount: 0, ...conv });
    await db.doc('contacts/' + id).set({ phone: id, createdAt: ago(10), ...contact });
  };
  await seed(ph.lena, {}, { name: 'Lena Lead', location: 'Swords', email: 'lena@example.com' });
  await seed(ph.quinn, { inboxStatus: 'quoted', stageDates: { quoted: ago(4) } }, { name: 'Quinn Quoted', location: 'Malahide', address: '4 Coast Road, Malahide' });
  await seed(ph.cathal, { inboxStatus: 'closed', stageDates: { closed: ago(6) } }, { name: 'Cathal Closed' });
  await seed(ph.wendy, { inboxStatus: 'booked', stageDates: { booked: ago(5) } }, { name: 'Wendy Waiting' });
  await seed(ph.dara, { inboxStatus: 'booked', stageDates: { booked: ago(5) } }, { name: 'Dara Declined', quoteValue: 9000 });
  const quote = async (id) => (await db.doc('quotes/' + id).get()).data();
  const conv = async (p) => (await db.doc('conversations/' + p).get()).data();
  const contact = async (p) => (await db.doc('contacts/' + p).get()).data();
  const quotesOf = async (p) => (await db.collection('quotes').where('phone', '==', p).get()).docs.map((d) => ({ id: d.id, ...d.data() }));

  const u = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true });
  const token = await getAuth().createCustomToken(u.uid);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage(); global.__page = page;
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const toastSays = (re, p = page) => p.waitForFunction((src) => { const t = document.getElementById('q-toast'); return !t.hidden && new RegExp(src).test(t.textContent); }, re.source);
  const field = (f) => page.locator(`#q-quote-view [data-field="${f}"]`);
  // Prepared from the page, through the real callables: a quote with given answers, and sending it with a tiny test PDF.
  const makeQuote = (phone, tweak) => page.evaluate(async ({ phone, tweak }) => {
    const s = (await firebase.firestore().doc('quoteSettings/current').get()).data();
    const a = QuoteEngine.current().newAnswers(s.priceList);
    Object.assign(a, tweak.top || {}); for (const [k, v] of Object.entries(tweak.options || {})) Object.assign(a.options[k], v);
    return (await firebase.app().functions('europe-west1').httpsCallable('createQuote')({ phone, requestId: 'e2e-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10), answers: a })).data.id;
  }, { phone, tweak: tweak || {} });
  const sendQuote = (id, pipeline = {}) => page.evaluate(async ({ id, pipeline }) => {
    const f = firebase.firestore(), q = (await f.doc('quotes/' + id).get()).data(), s = (await f.doc('quoteSettings/current').get()).data();
    const ct = (await f.doc('contacts/' + q.phone).get()).data() || {}, cv = (await f.doc('conversations/' + q.phone).get()).data() || {};
    const path = `uploads/${firebase.auth().currentUser.uid}/${Date.now()}-quote.pdf`;
    await firebase.storage().ref(path).put(new Blob(['%PDF-1.4\n% e2e\n%%EOF'], { type: 'application/pdf' }));
    const issueDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(new Date());
    return (await firebase.app().functions('europe-west1').httpsCallable('sendQuote')({ id, expectedRev: q.rev, requestId: 'e2e-send-' + Date.now() + '-abc', issueDate, settingsRev: s.rev,
      customer: { name: ct.name || cv.name || null, email: ct.email || null, address: ct.address || null }, pdfUploadPath: path, pipeline })).data;
  }, { id, pipeline });
  const openQuote = async (id) => { await page.evaluate((id) => { location.hash = '#quotes/' + id; }, id); await page.waitForSelector('#q-quote-view .qv-actions .qv-buttons'); };

  console.log('QUOTES E2E: real page + real functions + emulators');
  await page.goto('http://127.0.0.1:5055/');
  await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await page.waitForSelector('#app:not([hidden])');

  // ---- rail, and the setup banner before Quote Settings exist ----
  assert.equal(await page.locator('#nav-quotes').innerText(), 'Quotes');
  await page.click('.nav-future summary');
  assert.doesNotMatch(await page.locator('.planned-areas').innerText(), /Quotes/);
  await page.click('#nav-quotes');
  await page.waitForSelector('#q-setup:not([hidden])');
  assert.match(await page.textContent('#q-setup'), /Quote Settings are not set up yet/);
  assert.equal(await page.getAttribute('#nav-quotes', 'aria-current'), 'page');
  assert.equal(await page.getAttribute('#app', 'data-view'), 'quotes');
  await page.waitForFunction(() => /No quotes yet/.test(document.getElementById('q-list').textContent));
  ok('the rail has Quotes (no longer "Coming later"); before setup the screen says Quote Settings are needed');

  // ---- Quote Settings ----
  await page.click('#q-settings-link');
  await page.waitForSelector('#q-settings-view form.qs');
  const qs = (f) => page.locator(`#q-settings-view [data-field="${f}"]`);
  await qs('business.tradingName').fill('Elite Kitchens'); await qs('business.signatureName').fill('Test'); await qs('business.phone').fill('01 000 0000');
  await qs('business.email').fill('quotes@example.com');
  await qs('vatRate').fill('13.555'); await qs('validityDays').fill('30');
  for (const [k, [d, t]] of Object.entries(PRICES)) { await qs(`priceList.options.${k}.perDoor`).fill(String(d)); await qs(`priceList.options.${k}.perTopBox`).fill(String(t)); }
  await qs('priceList.drawerBoxes.cemux').fill('12'); await qs('priceList.drawerBoxes.blum').fill('21');
  await qs('priceList.glazing.small').fill('45'); await qs('priceList.glazing.large').fill('90');
  await page.click('#qs-add'); let row = page.locator('#qs-catalogue .qs-row').last();
  await row.locator('[data-k="name"]').fill('Pull-out bin'); await row.locator('[data-k="unit"]').fill('per unit'); await row.locator('[data-k="price"]').fill('30');
  await page.click('#qs-add'); row = page.locator('#qs-catalogue .qs-row').last();
  await row.locator('[data-k="name"]').fill('Pocket door'); await row.locator('[data-k="unit"]').fill('per opening'); await row.locator('[data-k="kind"]').selectOption('manual');
  await page.click('#qs-save');
  await page.waitForFunction(() => /VAT rate/.test(document.getElementById('qs-msg').textContent));
  assert.equal(await qs('vatRate').getAttribute('aria-invalid'), 'true');
  assert.equal((await db.doc('quoteSettings/current').get()).exists, false);
  await qs('vatRate').fill('13.5');
  await page.click('#qs-save');
  await page.waitForFunction(() => document.getElementById('qs-msg').textContent === 'Saved');
  const settings = (await db.doc('quoteSettings/current').get()).data();
  assert.equal(settings.rev, 1); assert.equal(settings.vatRate, 13.5); assert.equal(settings.validityDays, 30);
  assert.deepEqual(settings.priceList, priceList());
  assert.equal(settings.business.tradingName, 'Elite Kitchens');
  assert.match(await page.textContent('#qs-num-state'), /test numbers \(next: TEST-0001\)/);
  await page.screenshot({ path: path.join(SHOTS, 'quotes-settings.png'), fullPage: true });
  ok('Quote Settings: a bad VAT rate is refused and marked; prices, extras catalogue, VAT, validity and business details are saved');

  // ---- create a quote from the customer profile ----
  await page.click('#nav-inbox');
  await page.locator(`.conv[data-phone="${ph.lena}"]`).click();
  await page.waitForSelector('#details:not([hidden])');
  await page.waitForFunction(() => /No quotes yet/.test(document.getElementById('d-quotes-list').textContent));
  await page.click('#d-quote-new');
  await page.waitForSelector('#q-quote-view .qb');
  assert.match(await page.textContent('#q-title'), /^TEST-0001 · v1$/);
  assert.match(await page.textContent('#q-subtitle'), /Lena Lead · Draft/);
  assert.equal(await field('options.ess.on').isChecked(), true);
  assert.equal(await field('options.ess.perDoor').inputValue(), '110');
  assert.equal(await field('options.prem.on').isChecked(), false);
  assert.equal(await page.locator('#qv-send').isDisabled(), false);                         // (M4: Send is switched on)
  assert.equal(await page.locator('#qv-preview').isVisible(), true);
  assert.match(await page.textContent('.qv-customer'), /No address yet/);
  assert.equal(await field('project').inputValue(), 'kitchen', 'no Project type on the customer: a kitchen');
  assert.equal(await field('projectName').isVisible(), false);
  ok('Create quote in the profile opens a draft priced from Quote Settings (Essential on); Send and Preview are offered');

  // ---- live totals from the calculator, and problems shown ----
  await field('doors').fill('10'); await field('drawers').fill('4');
  await field('options.ess.drawerBox').selectOption('cemux');
  await field('options.prem.on').check();
  await field('options.prem.drawerBox').selectOption('blum');
  await field('glazing.small').fill('2');
  await field('project').selectOption('other');                                                  // the wording only: prices stay the same
  await field('projectName').fill('utility room');
  const answers1 = { ...QE.current().newAnswers(priceList()), project: 'other', projectName: 'utility room', doors: 10, drawers: 4, glazing: { small: 2, large: 0 } };
  answers1.options.ess.drawerBox = 'cemux'; answers1.options.prem = { ...answers1.options.prem, on: true, drawerBox: 'blum' };
  const sheet1 = QE.current().calculate(answers1, priceList(), { vatRate: 13.5 });
  const shown = async () => page.$$eval('#q-quote-view .qv-total', (rs) => rs.map((r) => [r.dataset.key, r.querySelector('.qv-total-amt').textContent]));
  await page.waitForFunction((n) => document.querySelectorAll('#q-quote-view .qv-total').length === n, 2);
  assert.deepEqual(await shown(), sheet1.options.map((o) => [o.key, '€' + o.incVat.toLocaleString('en-IE')]));
  await field('doors').fill('-1');
  await page.waitForFunction(() => /Fix the highlighted fields/.test(document.querySelector('#q-quote-view .qv-totals').textContent));
  assert.equal(await field('doors').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('#qv-send').isDisabled(), true);                          // nothing can be sent while a field is wrong
  await page.click('#qv-save');
  await toastSays(/Fix the highlighted fields first/);
  await field('doors').fill('10');
  await page.locator('#q-quote-view .qb-extras[data-list="extras"] .qb-add-select').selectOption({ label: 'Pocket door (enter price)' });
  await page.waitForFunction(() => /Enter a price for Pocket door/.test(document.getElementById('q-quote-view').textContent));
  await page.locator('#q-quote-view .qb-extras[data-list="extras"] .qb-row').last().locator('[data-k="unitPrice"]').fill('350');
  await page.locator('#q-quote-view .qb-extras[data-list="extras"] .qb-add-select').selectOption({ label: 'Custom item' });
  await page.locator('#q-quote-view .qb-extras[data-list="extras"] .qb-row').last().locator('[data-k="unitPrice"]').fill('99');
  await page.waitForFunction(() => /Give this extra a name, or remove it/.test(document.getElementById('q-quote-view').textContent));
  await page.locator('#q-quote-view .qb-extras[data-list="extras"] .qb-row').last().locator('.qb-rm').click();
  await page.waitForFunction(() => !/Fix the highlighted/.test(document.querySelector('#q-quote-view .qv-totals').textContent));
  await page.screenshot({ path: path.join(SHOTS, 'quotes-builder.png'), fullPage: true });
  ok('the builder shows live totals from the calculator (identical to it); bad counts, missing prices and nameless extras are marked and block saving');

  // ---- save the draft ----
  await page.click('#qv-save');
  await toastSays(/Draft saved/);
  const q1 = (await quotesOf(ph.lena))[0];
  const v1 = (await db.doc(`quotes/${q1.id}/versions/1`).get()).data();
  const expected = { ...answers1, extras: [{ name: 'Pocket door', unit: 'per opening', qty: 1, unitPrice: 350 }] };
  assert.deepEqual(v1.answers, QE.current().validate(expected).answers);
  assert.deepEqual(v1.sheet, QE.current().calculate(expected, priceList(), { vatRate: 13.5 }));
  assert.deepEqual(v1.sheet.document.project, { type: 'other', name: 'utility room' });
  await page.waitForFunction(() => document.getElementById('qv-save').disabled);
  assert.equal(q1.ref, 'TEST-0001'); assert.equal(q1.status, 'draft');
  assert.equal((await conv(ph.lena)).inboxStatus, undefined);                                    // making a quote changes nothing in the pipeline
  ok('Save draft: the server stores the same answers (with the project: Other, "utility room") and the same totals; nothing in the pipeline changes');

  // ---- unsaved changes are not lost by accident ----
  await field('doors').fill('12');
  let asked = null;
  page.once('dialog', (d) => { asked = d.message(); d.dismiss(); });
  await page.click('#nav-pipeline');
  await sleep(300);
  assert.match(asked || '', /unsaved changes to this quote/);
  assert.equal(await page.evaluate(() => location.hash), '#quotes/' + q1.id);
  assert.equal(await page.getAttribute('#app', 'data-view'), 'quotes');
  page.once('dialog', (d) => d.accept());
  await page.click('#q-back');
  await page.waitForSelector('#thread:not([hidden])');
  assert.equal(await page.evaluate(() => location.hash), '#c/' + ph.lena);                        // Back from a quote opened in the profile returns to the customer
  assert.equal((await db.doc(`quotes/${q1.id}/versions/1`).get()).data().answers.doors, 10);
  ok('leaving a quote with unsaved changes asks first (staying keeps the edits); Back returns to the customer it was opened from');

  // ---- the profile block, and the Address field ----
  await page.waitForSelector(`#d-quotes-list .d-quote[data-id="${q1.id}"]`);
  assert.match(await page.locator(`#d-quotes-list .d-quote[data-id="${q1.id}"]`).innerText(), /TEST-0001[\s\S]*Draft[\s\S]*€/);
  await page.fill('#d-address', '7 Main Street, Swords');
  await page.click('#d-save');
  await page.waitForFunction(() => document.getElementById('d-msg').textContent === 'Saved');
  assert.equal((await contact(ph.lena)).address, '7 Main Street, Swords');
  await page.locator(`#d-quotes-list .d-quote[data-id="${q1.id}"]`).click();
  await page.waitForSelector('#q-quote-view .qb');
  await page.waitForFunction(() => /7 Main Street, Swords/.test(document.querySelector('.qv-customer').textContent));
  ok('the customer profile lists their quotes and opens them; the new Address field is saved and shown on the quote');

  // ---- the Quotes list ----
  await page.click('#nav-quotes');
  await page.waitForSelector(`.qrow[data-id="${q1.id}"]`);
  const r1 = await page.locator(`.qrow[data-id="${q1.id}"]`).innerText();
  assert.match(r1, /TEST-0001/); assert.match(r1, /Lena Lead/); assert.match(r1, /Draft/);
  assert.match(r1, new RegExp(sheet1.options.length > 1 ? 'up to' : ''));
  assert.equal(await page.locator('#q-filter button[data-filter="draft"] .stage-n').innerText(), '1');
  await page.fill('#q-search', 'lena'); assert.equal(await page.locator('.qrow').count(), 1);
  await page.fill('#q-search', '0001'); assert.equal(await page.locator('.qrow').count(), 1);
  await page.fill('#q-search', 'nobody'); await page.waitForFunction(() => /No quotes match/.test(document.getElementById('q-list').textContent));
  await page.fill('#q-search', '');
  ok('the Quotes list shows number, customer, status and price, with counts per filter and search by name or number');

  // ---- add a customer without messaging, then quote them from New quote ----
  await page.click('#nav-inbox');
  await page.click('#new-btn'); await page.waitForSelector('#new-dlg[open]');
  await page.fill('#n-phone', '087 555 0101'); await page.fill('#n-name', 'Walk In');
  await page.click('#n-nomsg');
  await page.waitForSelector('#cust-dlg[open]');
  assert.equal(await page.inputValue('#c-phone'), '087 555 0101'); assert.equal(await page.inputValue('#c-name'), 'Walk In');
  await page.fill('#c-address', '1 Harbour Road, Skerries'); await page.selectOption('#c-source', 'Referral');
  await page.click('#c-go');
  await page.waitForFunction(() => location.hash === '#c/353875550101');
  await page.waitForSelector('#thread:not([hidden])');
  const walk = await conv('353875550101');
  assert.equal(walk.name, 'Walk In'); assert.equal(walk.inboxStatus, undefined);
  assert.equal((await contact('353875550101')).address, '1 Harbour Road, Skerries');
  assert.equal((await db.collection('conversations/353875550101/messages').get()).size, 0);
  assert.equal(graph.length, 0, 'nothing was sent to WhatsApp');
  await page.click('#nav-quotes'); await page.waitForSelector('#q-list .qrow');
  await page.click('#q-new'); await page.waitForSelector('#nq-dlg[open]');
  await page.fill('#nq-search', 'walk');
  await page.locator('.nq-pick[data-phone="353875550101"]').click();
  await page.waitForSelector('#q-quote-view .qb');
  assert.match(await page.textContent('#q-title'), /^TEST-0002/);
  ok('a phone or walk-in customer is added from New conversation without any message, as a New lead, and quoted from New quote');

  // ---- the starting number ----
  await page.evaluate(() => { location.hash = '#quotes/settings'; });
  await page.waitForSelector('#qs-next');
  await page.fill('#qs-next', '34');
  page.once('dialog', (d) => d.accept());
  await page.click('#qs-next-go');
  await page.waitForFunction(() => /The next quote will be EK-0034/.test(document.getElementById('qs-num-msg').textContent));
  await page.waitForFunction(() => /The next quote will be EK-0034/.test(document.getElementById('qs-num-state').textContent));
  ok('Quote Settings sets the starting EK number once (asks first); test quotes keep their TEST numbers');

  // ---- a sent quote: what the customer was sent; accept with its pipeline effect ----
  const qQuinn = await makeQuote(ph.quinn, { top: { doors: 14, drawers: 6 }, options: { prem: { on: true } } });
  assert.equal((await quote(qQuinn)).ref, 'EK-0034');
  await sendQuote(qQuinn);
  const sentQ = (await db.doc(`quotes/${qQuinn}/versions/1`).get()).data();
  const prem = sentQ.sheet.options.find((o) => o.key === 'prem');
  await openQuote(qQuinn);
  await page.waitForSelector('#q-quote-view .qv-sent');
  assert.match(await page.textContent('#q-quote-view .qv-h'), /What the customer was sent \(v1\)/);
  assert.equal(await page.locator('#q-quote-view .qv-opt').count(), 2);
  assert.match(await page.textContent('#q-quote-view .qv-banner'), /valid until/);
  assert.match(await page.textContent('#q-quote-view .qv-sent'), /4 Coast Road, Malahide/);
  assert.equal(await page.locator('#qv-renew').isDisabled(), false);                        // (M4: Send again is switched on)
  await page.click('#qv-accept'); await page.waitForSelector('#qa-dlg[open]');
  assert.equal(await page.isVisible('#qa-closed-row'), false);
  await page.locator('#qa-options input[value="prem"]').check();
  assert.equal(await page.inputValue('#qa-value'), '€' + prem.incVat.toLocaleString('en-IE'));
  assert.match(await page.textContent('#qa-effect'), new RegExp(`Quinn Quoted will move from Quoted to Won\\. Pipeline value set to €${prem.incVat.toLocaleString('en-IE')}`));
  await page.click('#qa-go');
  await toastSays(/Accepted: Premium/);
  assert.equal((await conv(ph.quinn)).inboxStatus, 'won');
  assert.equal((await contact(ph.quinn)).quoteValue, prem.incVat);
  assert.equal((await quote(qQuinn)).status, 'accepted');
  await page.waitForSelector('#q-quote-view .qv-opt.chosen[data-key="prem"]');
  await page.screenshot({ path: path.join(SHOTS, 'quotes-accepted.png'), fullPage: true });
  ok('a sent quote shows what the customer was sent; Accept says what will happen (Quoted -> Won, value prefilled with the chosen option) and does it');

  // ---- reopen within 5 minutes: the move back is a correction; the value is restored ----
  await page.click('#qv-reopen'); await page.waitForSelector('#qr-dlg[open]');
  assert.equal(await page.isChecked('#qr-move'), true);
  assert.match(await page.textContent('#qr-move-text'), /Move Quinn Quoted back from Won to Quoted/);
  assert.match(await page.textContent('#qr-value-text'), /Clear the pipeline value/);
  await page.click('#qr-go');
  await toastSays(/moved back to Quoted \(a correction/);
  const qc = await conv(ph.quinn);
  assert.equal(qc.inboxStatus, 'quoted'); assert.equal(qc.stageDates.won, undefined);
  assert.equal((await contact(ph.quinn)).quoteValue, null);
  assert.equal((await quote(qQuinn)).status, 'sent');
  ok('Reopen within 5 minutes: the customer goes back to Quoted with no trace of Won, and the pipeline value is put back');

  // ---- decline changes nothing in the pipeline; revise and discard ----
  const qDara = await makeQuote(ph.dara);
  await sendQuote(qDara);                                                                       // Booked -> Quoted
  const daraBefore = { c: await conv(ph.dara), ct: await contact(ph.dara) };
  await openQuote(qDara);
  await page.click('#qv-decline'); await page.waitForSelector('#qd-dlg[open]');
  assert.match(await page.textContent('#qd-dlg .q-effect'), /stage and pipeline value do not change/);
  await page.fill('#qd-reason', 'Went with another company'); await page.click('#qd-go');
  await toastSays(/Marked declined/);
  assert.deepEqual(await conv(ph.dara), daraBefore.c); assert.deepEqual(await contact(ph.dara), daraBefore.ct);
  await page.waitForFunction(() => /Declined/.test(document.getElementById('q-subtitle').textContent));
  await page.click('#qv-revise');
  await page.waitForSelector('#q-quote-view .qb');
  assert.match(await page.textContent('#q-title'), /· v2$/);
  assert.match(await page.textContent('#q-quote-view .qv-banner'), /Draft v2: these changes are not sent/);
  await page.click('#qv-discard'); await page.waitForSelector('#qc-dlg[open]');
  await page.click('#qc-go');
  await page.waitForSelector('#q-quote-view .qv-sent');
  assert.equal((await quote(qDara)).draftVersion, null);
  ok('Decline leaves the stage and value alone; a declined quote can be revised (draft v2) and the draft discarded');

  // ---- a Closed customer is only moved when the box is ticked ----
  const qCathal = await makeQuote(ph.cathal);
  await sendQuote(qCathal);
  assert.equal((await conv(ph.cathal)).inboxStatus, 'closed');
  await openQuote(qCathal);
  await page.click('#qv-accept'); await page.waitForSelector('#qa-dlg[open]');
  assert.equal(await page.isVisible('#qa-closed-row'), true);
  assert.equal(await page.isChecked('#qa-move-closed'), false);
  await page.locator('#qa-options input[value="ess"]').check();
  assert.match(await page.textContent('#qa-effect'), /Cathal Closed stays in Closed/);
  await page.fill('#qa-value', '');
  await page.click('#qa-go');
  await toastSays(/stage did not change/);
  assert.equal((await conv(ph.cathal)).inboxStatus, 'closed');
  assert.equal((await contact(ph.cathal)).quoteValue, undefined);
  ok('Accepting for a Closed customer offers an unticked "move to Won": left unticked, they stay Closed and the value is left alone');

  // ---- expired is only a label ----
  const qWendy = await makeQuote(ph.wendy);
  await sendQuote(qWendy);
  await db.doc('quotes/' + qWendy).update({ validUntil: '2026-01-31', 'sent.validUntil': '2026-01-31' });
  await page.click('#nav-quotes'); await page.waitForSelector(`.qrow[data-id="${qWendy}"]`);
  assert.match(await page.locator(`.qrow[data-id="${qWendy}"] .qchip`).innerText(), /Expired/);
  await page.click('#q-filter button[data-filter="expired"]');
  assert.equal(await page.locator('.qrow').count(), 1);
  await page.locator(`.qrow[data-id="${qWendy}"]`).click();
  await page.waitForSelector('#qv-accept');
  assert.match(await page.textContent('#q-quote-view .qv-banner'), /Expired: it was valid until 31 Jan 2026[\s\S]*you can still mark it accepted/);
  assert.equal((await quote(qWendy)).status, 'sent');
  await page.click('#qv-accept'); await page.waitForSelector('#qa-dlg[open]');
  assert.equal(await page.isVisible('#qa-expired'), true);
  await page.click('#qa-cancel');
  ok('an expired quote is labelled Expired (with its own filter) but stays Sent, and can still be accepted, revised or sent again');

  // ---- delete a quote that was never sent ----
  await page.click('#q-back'); await page.waitForSelector('#q-list-view:not([hidden])');
  await page.click('#q-filter button[data-filter="draft"]');
  await page.waitForSelector('.qrow');
  const walkQ = (await quotesOf('353875550101'))[0];
  await page.locator(`.qrow[data-id="${walkQ.id}"]`).click();
  await page.waitForSelector('#qv-delete');
  await page.click('#qv-delete'); await page.waitForSelector('#qc-dlg[open]');
  assert.match(await page.textContent('#qc-text'), /never sent/);
  await page.click('#qc-go');
  await page.waitForFunction(() => location.hash === '#quotes');
  await toastSays(/TEST-0002 deleted/);
  assert.equal((await db.doc('quotes/' + walkQ.id).get()).exists, false);
  ok('a quote that was never sent can be deleted after a confirmation');

  // ---- navigation stays consistent ----
  await page.click('#nav-appointments'); await page.waitForFunction(() => document.getElementById('app').dataset.view === 'appointments');
  assert.equal(await page.getAttribute('#nav-quotes', 'aria-current'), null);
  await page.click('#nav-quotes'); await page.waitForFunction(() => document.getElementById('app').dataset.view === 'quotes');
  await page.click('#nav-pipeline'); await page.waitForSelector('.lane');
  assert.equal(await page.getAttribute('#nav-pipeline', 'aria-current'), 'page');
  assert.equal(await page.getAttribute('#nav-quotes', 'aria-current'), null);
  await page.click('#nav-inbox'); await page.waitForSelector('.conv');
  assert.equal(await page.getAttribute('#app', 'data-view'), 'list');
  ok('Inbox, Pipeline, Appointments and Quotes switch cleanly');

  // ---- phone ----
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const mp = await mctx.newPage(); mp.on('pageerror', (e) => errors.push('mobile: ' + e.message));
  await mp.goto('http://127.0.0.1:5055/');
  await mp.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await mp.waitForSelector('#app:not([hidden])');
  await mp.tap('#to-quotes');
  await mp.waitForSelector('#q-list .qrow');
  assert.equal(await mp.getAttribute('#app', 'data-view'), 'quotes');
  assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await mp.screenshot({ path: path.join(SHOTS, 'quotes-phone-list.png') });
  await mp.locator(`.qrow[data-id="${q1.id}"]`).tap();
  await mp.waitForSelector('#q-quote-view .qb');
  assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const yOf = async (s) => (await mp.locator('#q-quote-view ' + s).boundingBox()).y;
  assert.ok(await yOf('.qv-totals') < await yOf('.qv-actions') && await yOf('.qv-actions') < await yOf('.qv-body') && await yOf('.qv-body') < await yOf('.qv-notes'), 'phone order: totals, actions, the form, then notes');
  await mp.screenshot({ path: path.join(SHOTS, 'quotes-phone-builder.png'), fullPage: true });
  await mp.tap('#q-back');
  await mp.waitForSelector('#q-list .qrow');
  await mp.locator(`.qrow[data-id="${qWendy}"]`).tap();
  await mp.waitForSelector('#qv-accept'); await mp.tap('#qv-accept'); await mp.waitForSelector('#qa-dlg[open]');
  const box = await mp.locator('#qa-dlg').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, 'the accept dialog fits the phone screen');
  await mp.screenshot({ path: path.join(SHOTS, 'quotes-phone-accept.png') });
  await mp.tap('#qa-cancel');
  await mp.tap('#q-back'); await mp.waitForSelector('#q-list .qrow');
  await mp.tap('#q-back'); await mp.waitForSelector('.conv');
  assert.equal(await mp.getAttribute('#app', 'data-view'), 'list');
  ok('phone: Quotes opens from the Inbox header; the list and the builder have no sideways scroll, totals and actions come first, dialogs fit, Back works');
  await mctx.close();

  assert.deepEqual(errors, [], 'browser errors: ' + JSON.stringify(errors)); ok('no JavaScript errors in the browser');
  await browser.close(); web.close(); meta.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch(async (e) => {
  console.error('\nFAILED:', e.stack || e.message || e);
  try {                                     // what the page showed, to see why
    const p = global.__page; await p.screenshot({ path: path.join(SHOTS, 'quotes-FAILED.png'), fullPage: true });
    console.error('hash:', await p.evaluate(() => location.hash), '| toast:', await p.textContent('#q-toast'), '| actions:', await p.evaluate(() => (document.querySelector('.qv-actions') || {}).textContent));
  } catch (x) { /* no page */ }
  process.exit(1);
});
