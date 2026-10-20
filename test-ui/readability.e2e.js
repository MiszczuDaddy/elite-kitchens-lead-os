'use strict';
// Focused UI refinements only. Real frontend + demo emulators; synthetic customers, no provider sends.
// bash test-ui/run.sh readability.e2e.js
// Optional UI_BEFORE_REF=<commit> captures matching before screenshots without checking out or editing that revision.
// UI_SEARCH_ONLY=1 runs just the cross-stage conversation search checks.
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const fnRequire = require('module').createRequire(path.join(ROOT, 'functions/package.json'));
const { initializeApp, getApps, deleteApp } = fnRequire('firebase-admin/app');
const { getAuth } = fnRequire('firebase-admin/auth');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const QE = require('../public/quote-engine.js');
assert.ok(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST, 'Demo emulators required');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'shots/readability');
fs.mkdirSync(SHOTS, { recursive: true });
const cfg = `firebase.initializeApp({apiKey:'fake',projectId:'demo-leados',authDomain:'localhost',storageBucket:'demo-leados.firebasestorage.app'});
firebase.auth().useEmulator('http://127.0.0.1:9099',{disableWarnings:true});
firebase.firestore().useEmulator('127.0.0.1',8085);
firebase.app().functions('europe-west1').useEmulator('127.0.0.1',5001);
firebase.storage().useEmulator('127.0.0.1',9199);`;
let beforeSources = null;
const web = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/__/firebase/init.js') { res.setHeader('content-type', 'text/javascript'); return res.end(cfg); }
  const sdk = /^\/__\/firebase\/[\d.]+\/(.+)$/.exec(u);
  const f = sdk ? path.join(ROOT, 'node_modules/firebase', sdk[1]) : path.join(ROOT, 'public', u === '/' ? 'index.html' : u);
  const baseline = !sdk && beforeSources && beforeSources.get(u === '/' ? 'index.html' : u.slice(1));
  if (baseline) { res.setHeader('content-type', u === '/' ? 'text/html' : u.endsWith('.css') ? 'text/css' : 'text/javascript'); return res.end(baseline); }
  fs.readFile(f, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('content-type', { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' }[path.extname(f)] || 'application/octet-stream');
    res.end(data);
  });
}).listen(5055, '127.0.0.1');
const stages = ['inbox', 'booked', 'quoted', 'won', 'closed'];
const labels = ['New lead', 'Booked', 'Quoted', 'Won', 'Closed'];
const names = ['Anna Murphy', 'Brian O’Connell', 'Ciara Walsh', 'Daniel Byrne', 'Emma Kelly'];
const phones = stages.map((_, i) => '35386000007' + i);
const qid = 'q_1234567890abcdef12345678';
const settings = { rev: 1, vatRate: 13.5, validityDays: 30,
  business: { tradingName: 'Elite Kitchens', signatureName: 'Test staff', phone: '01 000 0000', email: 'quotes@example.com', web: 'example.com', address: 'Test Street, Dublin', vatNumber: 'IE0000000X' },
  priceList: { options: { ess: { perDoor: 310, perTopBox: 170 }, prem: { perDoor: 325, perTopBox: 180 }, pp: { perDoor: 340, perTopBox: 190 } }, drawerBoxes: { cemux: 20, blum: 30 }, glazing: { small: 45, large: 90 }, extras: [] } };
let browser, page, n = 0;
const ok = (s) => console.log(`  PASS ${++n}. ${s}`);
const css = (p, sel, prop) => p.locator(sel).first().evaluate((e, key) => getComputedStyle(e)[key], prop);
const route = async (p, hash, visible) => { await p.evaluate(h => { location.hash = h; }, hash); await p.waitForSelector(visible); };
const shot = (p, name) => p.screenshot({ path: path.join(SHOTS, name + '.png') });
async function noOverflow(p, selectors) {
  for (const sel of selectors) {
    assert.equal(await p.locator(sel).first().evaluate(e => e.scrollWidth <= e.clientWidth + 1), true, `${sel} overflows`);
  }
}
(async () => {
  initializeApp({ projectId: 'demo-leados' });
  const db = getFirestore(), now = Date.now(), at = ms => Timestamp.fromMillis(ms);
  for (let i = 0; i < stages.length; i++) {
    const contact = { phone: phones[i], name: names[i], location: 'Swords', address: '12 Main Street, Swords', email: `customer${i}@example.com`, projectType: 'Kitchen', source: 'Referral', quoteValue: i > 1 ? 14500 : null, createdAt: at(now - 5 * 86400000) };
    await db.doc('contacts/' + phones[i]).set(contact);
    await db.doc('conversations/' + phones[i]).set({ ...contact, inboxStatus: stages[i], updatedAt: at(now - 3600000), lastInboundAt: at(now - 3600000), lastMessage: 'Could we arrange a visit to discuss the kitchen?', unreadCount: 0 });
  }
  await db.doc(`conversations/${phones[0]}/messages/demo`).set({ direction: 'in', type: 'text', body: 'Hi, we would like to discuss a new kitchen for our home in Swords. Could we arrange a visit?', createdAt: at(now - 3600000) });
  await db.doc('quoteSettings/current').set(settings);
  const answers = QE.current().newAnswers(settings.priceList); answers.doors = 10; answers.options.prem.on = true;
  const sheet = QE.current().calculate(answers, settings.priceList, { vatRate: 13.5 });
  const summary = { options: sheet.options.map(({ key, name, incVat }) => ({ key, name, incVat })), dearest: sheet.options.find(o => o.key === sheet.dearest) };
  const issueDate = new Date(now).toISOString().slice(0, 10), validUntil = new Date(now + 30 * 86400000).toISOString().slice(0, 10);
  await db.doc('quotes/' + qid).set({ phone: phones[2], customerName: names[2], ref: 'EK-0042', status: 'sent', currentVersion: 1, sentVersion: 1, draftVersion: null, rev: 1, summary, sent: { summary }, sentAt: at(now), validUntil, createdAt: at(now), updatedAt: at(now), history: [], pipelineChanges: [] });
  await db.doc(`quotes/${qid}/versions/1`).set({ n: 1, rev: 1, state: 'sent', engine: QE.CURRENT, answers, priceList: settings.priceList, vatRate: 13.5, sheet, issueDate, validUntil, customer: { name: names[2], phone: phones[2], email: 'customer2@example.com', address: '12 Main Street, Swords' }, business: settings.business, pdf: { path: 'test-only/not-downloaded.pdf' }, sentAt: at(now) });
  await db.doc('appointments/readability').set({ phone: phones[1], customerName: names[1], start: at(now + 86400000), end: at(now + 90000000), durationMin: 60, type: 'consultation', location: 'Swords', status: 'booked', sync: { google: { state: 'synced' } } });
  const user = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true });
  const token = await getAuth().createCustomToken(user.uid);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const errors = [];
  for (const before of process.env.UI_BEFORE_REF ? [true, false] : [false]) {
    const prefix = before ? 'before' : 'after';
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    // Serve the baseline over real loopback HTTP too, retaining Chromium's local address-space classification.
    // All data and callables still use demo emulators; no checkout or source-file rewrites are needed.
    beforeSources = before ? new Map(['index.html', 'app.css', 'app.js', 'quotes.js'].map(f =>
      [f, execFileSync('git', ['show', `${process.env.UI_BEFORE_REF}:public/${f}`], { cwd: ROOT })])) : null;
    page = await ctx.newPage(); page.on('pageerror', e => errors.push(e.message));
    page.on('requestfailed', r => console.error('Request failed:', r.url(), r.failure().errorText));
    await page.goto('http://127.0.0.1:5055/');
    await page.evaluate(t => firebase.auth().signInWithCustomToken(t), token);
    await page.waitForSelector('#app:not([hidden])'); await page.evaluate(() => { if (location.hash === '#today') location.hash = ''; }); await page.waitForSelector('.conv');
    if (!before) {
      for (let i = 0; i < stages.length; i++) {
        await page.click(`#status-filters [data-status="${stages[i]}"]`);
        assert.equal(await page.getAttribute('#search', 'placeholder'), 'Search name, phone, email, town…');
        assert.equal(await page.getAttribute('#search', 'aria-label'), 'Search every customer by name, phone number, email or town');
        for (let j = 0; j < stages.length; j++) {
          await page.fill('#search', names[j]);
          assert.equal(await page.locator('.conv').count(), 1);
          assert.equal(await page.locator('.conv').getAttribute('data-phone'), phones[j]);
          assert.ok((await page.locator('.conv-sub').textContent()).startsWith(labels[j]));
        }
        await page.fill('#search', '   ');
        assert.equal(await page.locator('.conv').count(), 1);
        assert.equal(await page.locator('.conv').getAttribute('data-phone'), phones[i]);
      }
      await page.click('#status-filters [data-status=inbox]');
      await page.fill('#search', 'missing customer'); await page.waitForFunction(() => /across the stages/.test(document.getElementById('list-empty').textContent));      // the first search also loads every customer: "Searching…" until then
      assert.equal(await page.locator('.conv').count(), 0);
      assert.match(await page.textContent('#list-empty'), /across the stages/);
      await page.fill('#search', phones[4]);
      assert.equal(await page.locator('.conv').getAttribute('data-phone'), phones[4]);
      await page.fill('#search', 'swords');
      assert.equal(await page.locator('.conv').count(), 5);
      await page.fill('#search', names[1]);
      await page.click('#status-filters [data-status=booked]');
      assert.equal(await page.locator('.conv').count(), 1);
      assert.equal(await page.inputValue('#search'), names[1]);
      await page.fill('#search', ''); await page.click('#status-filters [data-status=inbox]');
      ok('names match across all five stages from every tab; phone/location search, empty results and clearing the query work');
      if (process.env.UI_SEARCH_ONLY) { await ctx.close(); continue; }
      assert.equal(await css(page, '.conv-time', 'fontSize'), '13px');
      assert.equal(await css(page, '.conv-prev .t', 'fontSize'), '14px');
      ok('operational list text uses the readable primary/secondary scale');
    }
    await page.click('.conv');
    if (!(await page.locator('#details').isVisible())) await page.click('#details-btn');
    await page.waitForFunction(() => document.querySelector('#d-name').value === 'Anna Murphy');
    await page.waitForFunction(() => /No upcoming/.test(document.querySelector('#d-appts-list').textContent) && /No quotes yet/.test(document.querySelector('#d-quotes-list').textContent));
    await shot(page, `${prefix}-profile-desktop`);
    if (!before) {
      assert.equal(await page.evaluate(() => !!(document.querySelector('#details-form').compareDocumentPosition(document.querySelector('#d-appts')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
      assert.equal(await page.locator('#d-appts').evaluate(e => e.offsetHeight < 60), true);
      await page.fill('#d-location', 'Malahide'); await page.click('#d-save');
      await page.waitForFunction(() => document.querySelector('#d-save').disabled && /Saved/.test(document.querySelector('#d-msg').textContent));
      assert.equal((await db.doc('contacts/' + phones[0]).get()).data().location, 'Malahide');
      await page.fill('#d-location', 'Swords'); await page.click('#d-save');
      await page.waitForFunction(() => document.querySelector('#d-save').disabled);
      await page.click('#d-appt-new'); await page.waitForSelector('#appt-dlg[open]');
      assert.match(await page.textContent('#appt-dlg'), /Anna Murphy/);
      await page.click('#a-cancel');
      ok('reordered profile still saves the correct customer; compact empty sections and appointment shortcut work');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, `${prefix}-profile-phone`);
    if (!before) await noOverflow(page, ['#details', '.profile-shortcuts']);
    await page.click('#details-close');
    await route(page, '#pipeline', '.prow');
    for (const width of [1280, 1366, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      if (!before) {
        await noOverflow(page, ['.pipe-board', '.pipeline-pane']);
        assert.equal(await page.locator('.lane').count(), 5);
        const last = await page.locator('.lane').last().boundingBox(); assert.ok(last.x + last.width <= width, 'Closed is visible');
      }
      if (width === 1366) await shot(page, `${prefix}-pipeline-desktop`);
    }
    if (!before) ok('all five pipeline columns fit at 1280, 1366, 1440 and 1920px without horizontal scrolling');
    await page.setViewportSize({ width: 390, height: 844 }); await shot(page, `${prefix}-pipeline-phone`);
    if (!before) {
      await page.locator('.lane-on .prow-menu').first().click();
      for (const height of await page.locator('.move-menu button').evaluateAll(es => es.map(e => e.getBoundingClientRect().height))) assert.ok(height >= 44);
      await page.keyboard.press('Escape');
      ok('pipeline menus remain usable and have 44px mobile targets');
    }
    await route(page, '#appointments', '#appts-view'); await page.click('#appts-view [data-view=list]'); await page.waitForSelector('.arow');
    await shot(page, `${prefix}-appointments-phone`);
    if (!before) {
      for (const height of await page.locator('#appts-view button').evaluateAll(es => es.map(e => e.getBoundingClientRect().height))) assert.ok(height >= 44);
      await page.setViewportSize({ width: 1366, height: 900 });
      assert.equal(await css(page, '.arow-menu', 'opacity'), '1');
      ok('appointment view controls meet 44px targets and desktop row menus remain visible');
    }
    await route(page, '#quotes', '.qrow');
    await page.setViewportSize({ width: 390, height: 844 }); await shot(page, `${prefix}-quotes-phone`);
    if (!before) {
      assert.equal(await css(page, '#q-settings-link', 'color'), await css(page, 'body', 'color'));
      assert.equal(await css(page, '#q-new', 'color'), 'rgb(255, 255, 255)');
      for (const height of await page.locator('#q-filter button').evaluateAll(es => es.map(e => e.getBoundingClientRect().height))) assert.ok(height >= 44);
      ok('secondary link-buttons inherit the palette, primary buttons retain white text, quote filters meet 44px');
    }
    await route(page, '#quotes/' + qid, '#qv-renew');
    for (const width of [390, 1024, 1366]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      if (!before) await noOverflow(page, ['.quotes-pane', '.qv-actions']);
      if (width !== 1024) await shot(page, `${prefix}-quote-${width === 390 ? 'phone' : 'desktop'}`);
    }
    if (!before) {
      assert.equal(await page.textContent('#qv-renew'), 'Renew dates and send…');
      assert.equal(await page.textContent('#qv-resend'), 'Resend saved PDF…');
      assert.equal(await page.textContent('#qv-revise'), 'Create revision');
      await page.click('#qv-renew'); await page.waitForSelector('#qsend-dlg[open]');
      assert.match(await page.textContent('#qsend-who'), /new date and validity/);
      assert.match(await page.textContent('#qsend-title'), /v2/);
      await page.click('#qsend-cancel');
      await page.click('#qv-resend'); await page.waitForSelector('#qsend-dlg[open]');
      assert.match(await page.textContent('#qsend-who'), /stored PDF of v1/);
      await page.click('#qsend-cancel');
      assert.equal((await db.doc('quotes/' + qid).get()).data().rev, 1);
      ok('renamed send actions open their original renew/resend flows without sending or changing the quote');
      await page.click('#qv-revise'); await page.waitForSelector('.qb');
      assert.equal((await db.doc('quotes/' + qid).get()).data().draftVersion, 2);
      ok('Create revision still creates the next editable version');
      await route(page, '#c/' + phones[0], '#details-btn');
      if (!(await page.locator('#details').isVisible())) await page.click('#details-btn');
      await page.click('#d-quote-new'); await page.waitForSelector('.qb');
      assert.match(await page.textContent('#q-subtitle'), /Anna Murphy/);
      ok('the relocated Create quote shortcut opens a draft for the correct customer');
    }
    await ctx.close();
  }
  assert.deepEqual(errors, []); ok('no browser JavaScript errors');
  console.log(`${n} focused checks passed. Screenshots: ${SHOTS}`);
})().catch(async err => { console.error(err); if (page && !page.isClosed()) await shot(page, 'FAILED').catch(() => {}); process.exitCode = 1; })
  .finally(async () => { if (browser) await browser.close(); web.close(); await Promise.all(getApps().map(deleteApp)); });
