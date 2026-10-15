'use strict';
// Phase 9 Step C browser test: the AI Knowledge Centre. The real page + the real functions + emulators, with the built-in DEMO model (AI_FAKE_MODEL=on, emulator only): no real model, key or customer.
// It checks what the owner sees and relies on: the starting knowledge goes into the DRAFT only, editing and saving a draft, "Try it" on a pretend customer (nothing sent, nothing written about a customer),
// Publish, the version list, Roll back, text typed by the owner is shown as text (never as a page), and the phone layout. Run: bash test-ui/run.sh knowledge.e2e.js
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
    res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }[path.extname(f)] || 'application/octet-stream'); res.end(d); });
}).listen(5058);

(async () => {
  initializeApp({ projectId: 'demo-leados' });
  const db = getFirestore(), NOW = Date.now();
  const models = { haiku: { id: 'claude-haiku-5-5' }, sonnet: { id: 'claude-sonnet-5-5' } };
  const MODELS = require(path.join(ROOT, 'functions', 'lib', 'ai')).MODELS;
  await db.doc('aiSettings/modelCheck').set(Object.fromEntries(Object.entries(MODELS).map(([k, m]) => [k, { id: m.id, ok: true, name: m.label, lifecycle: 'active', at: Timestamp.fromMillis(NOW) }])));
  await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: false, replyAssistant: true, monthlyCapEur: 15, dailyCapEur: 2 });
  const u = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true });
  const token = await getAuth().createCustomToken(u.uid);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const errors = [];
  const open = async (options = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, ...options }), page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on('dialog', (d) => d.accept());
    await page.goto('http://127.0.0.1:5058/'); await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])');
    return { ctx, page };
  };
  let { ctx, page } = await open();
  console.log('KNOWLEDGE E2E: real page + real functions + emulators + the demo model');
  const openCentre = async () => { await page.click(await page.locator('#nav-assistant').isVisible() ? '#nav-assistant' : '#to-assistant'); await page.waitForSelector('#assistant', { state: 'visible' }); await page.click('#as-settings'); await page.waitForSelector('#as-dlg[open]'); await page.waitForFunction(() => /this month/.test(document.getElementById('as-set-spent').textContent)); await page.click('#as-know-open'); await page.waitForSelector('#kn-dlg[open]'); await page.waitForFunction(() => document.getElementById('kn-live').textContent.length > 0); };
  const tab = (t) => page.click(`.kn-tabs button[data-tab="${t}"]`);
  const toast = (re) => page.waitForFunction((s) => new RegExp(s, 'i').test(document.getElementById('kn-msg').textContent), re);

  // ------------------------------------------------------------ 1. nothing published, nothing in the draft
  await openCentre();
  assert.match(await page.locator('#kn-live').innerText(), /Nothing is published yet/); assert.equal(await page.locator('#kn-publish').isDisabled(), true, 'nothing to publish');
  assert.match(await page.locator('#kn-body').innerText(), /There is no knowledge yet/);
  ok('the Knowledge Centre opens from Assistant settings; with nothing in it, it says nothing is published and offers the starting knowledge');

  // ------------------------------------------------------------ 2. the starting knowledge goes into the DRAFT only
  await page.click('#kn-body .btn-primary'); await toast('loaded into the draft');
  assert.ok(await page.locator('.kn-sec').count() >= 8, 'sections shown'); assert.match(await page.locator('#kn-draft').innerText(), /Draft saved/); assert.match(await page.locator('#kn-live').innerText(), /Nothing is published yet/);
  assert.equal((await db.doc('aiKnowledge/draft').get()).exists, true); assert.equal((await db.doc('aiKnowledge/live').get()).exists, false, 'importing never publishes');
  assert.equal(await page.locator('#kn-publish').isDisabled(), false);
  await page.screenshot({ path: path.join(SHOTS, 'knowledge-draft.png') });
  ok('the starting knowledge is loaded into the DRAFT: sections are listed, nothing is live, and nothing was published by itself');

  // ------------------------------------------------------------ 3. edit, unsaved changes, save
  const sec = page.locator('.kn-sec').first(); await sec.locator('summary').click();
  const entry = sec.locator('.kn-entry').first(); await entry.locator('textarea').fill('Elite Kitchens designs, supplies and fits bespoke kitchens made in Ireland. <img src=x onerror="window.__xss=1">');
  assert.match(await page.locator('#kn-draft').innerText(), /unsaved changes/); assert.equal(await page.locator('#kn-publish').isDisabled(), true, 'a draft with unsaved changes cannot be published');
  await entry.locator('input').first().fill('What we do <b>bold</b>');
  await page.click('#kn-save'); await toast('Draft saved'); assert.match(await page.locator('#kn-draft').innerText(), /Draft saved/);
  const dd = (await db.doc('aiKnowledge/draft').get()).data(); assert.equal(dd.data.sections[0].entries[0].title, 'What we do <b>bold</b>'); assert.equal(dd.rev, 2);
  assert.equal(await page.evaluate(() => window.__xss || 0), 0, 'nothing typed by the owner runs as a page'); assert.equal(await page.locator('.kn-entry img, .kn-entry b').count(), 0);
  ok('editing marks the draft as unsaved (and blocks Publish), Save keeps it, HTML typed into an entry stays plain text');

  // ------------------------------------------------------------ 4. add an entry, change its type
  await sec.locator('button:has-text("Add an entry")').click(); const fresh = page.locator('.kn-sec').first().locator('.kn-entry').last();
  await fresh.locator('select').selectOption('open'); await fresh.locator('input').first().fill('Is there a showroom visit?'); await page.click('#kn-save'); await toast('Draft saved');
  const saved = (await db.doc('aiKnowledge/draft').get()).data().data.sections[0].entries.slice(-1)[0]; assert.deepEqual([saved.kind, saved.title, saved.text], ['open', 'Is there a showroom visit?', '']);
  ok('an entry can be added and marked Open (not confirmed); it needs no text');

  // ------------------------------------------------------------ 5. Try it: the draft, a pretend customer, nothing written
  await tab('try'); await page.fill('#kn-q', 'How long does fitting take?'); await page.click('#kn-try'); await page.waitForSelector('.kn-res');
  assert.match(await page.locator('.kn-res').first().innerText(), /Customer: How long does fitting take\?[\s\S]*Receptionist:[\s\S]*Step:/);
  assert.equal((await db.collection('aiDrafts').get()).size, 0); assert.equal((await db.collection('conversations').get()).size, 0); assert.equal((await db.collection('messages').get()).size, 0);
  await page.selectOption('#kn-src', 'live'); await page.fill('#kn-q', 'hello'); await page.click('#kn-try'); await toast('Nothing is published');
  ok('"Try it" answers on the draft as the receptionist would, with nothing sent and nothing written about a customer; "published" says so when nothing is published');
  await page.selectOption('#kn-src', 'draft'); await page.click('#kn-all'); await page.waitForFunction(() => document.querySelectorAll('.kn-res').length >= 20, null, { timeout: 90000 });
  assert.match(await page.locator('.kn-sum').innerText(), /\d+ answers\./); await toast('Done\\. That cost');
  ok('"Run all examples" runs the saved example questions and summarises them');

  // ------------------------------------------------------------ 6. publish
  await page.click('#kn-note'); await page.fill('#kn-note', 'first version'); await page.click('#kn-publish'); await toast('Published');
  assert.match(await page.locator('#kn-live').innerText(), /Live: version 1[\s\S]*first version/);
  const live = (await db.doc('aiKnowledge/live').get()).data(); assert.equal(live.version, 1); assert.equal(live.publishedBy, 'staff@test.dev'); assert.equal((await db.doc('aiKnowledgeVersions/v0001').get()).exists, true);
  await tab('try'); await page.selectOption('#kn-src', 'live'); await page.fill('#kn-q', 'what is your email?'); await page.click('#kn-try'); await page.waitForFunction(() => /version/i.test(document.getElementById('kn-msg').textContent) || document.querySelectorAll('.kn-res').length === 1, null, { timeout: 30000 });
  ok('Publish makes it live as version 1 with the note, and the published knowledge can be tried too');

  // ------------------------------------------------------------ 7. a second version and a rollback
  await tab('know'); if (!(await page.locator('.kn-sec').first().evaluate((d) => d.open))) await page.locator('.kn-sec').first().locator('summary').click(); await page.locator('.kn-sec').first().locator('.kn-entry').first().locator('textarea').fill('Version two wording.');
  await page.click('#kn-save'); await toast('Draft saved'); await page.fill('#kn-note', 'second'); await page.click('#kn-publish'); await toast('Published');
  assert.match(await page.locator('#kn-live').innerText(), /version 2/); await tab('versions');
  assert.equal(await page.locator('.kn-ver').count(), 2); assert.match(await page.locator('.kn-ver').first().innerText(), /Version 2[\s\S]*LIVE/);
  assert.equal(await page.locator('.kn-ver').first().locator('button').isDisabled(), true, 'the live version cannot be rolled back to');
  await page.locator('.kn-ver').nth(1).locator('button').click(); await toast('Rolled back');
  assert.match(await page.locator('#kn-live').innerText(), /version 3/); const l3 = (await db.doc('aiKnowledge/live').get()).data(); assert.equal(l3.version, 3); assert.equal(l3.note, 'Rolled back to version 1');
  assert.equal(l3.data.sections[0].entries[0].text.includes('Version two'), false);
  const log = (await db.collection('auditLog').where('action', '==', 'aiKnowledge').get()).docs.map((d) => d.data().op); for (const op of ['import_starter', 'save_draft', 'publish', 'rollback']) assert.ok(log.includes(op), op);
  ok('a second version is published; Roll back publishes version 1 again as version 3; every change is in the audit log');

  // ------------------------------------------------------------ 8. lines and links
  await tab('lines'); assert.equal(await page.locator('#kn-body input').count() >= 12, true); const holding = page.locator('#kn-body .kn-f').filter({ hasText: 'Not sure' }).locator('input'); assert.match(await holding.inputValue(), /check with the team/);
  await holding.fill('Call me on 0871234567'); await page.click('#kn-save'); await toast('cannot contain numbers');
  await holding.fill('Good question, I\'ll check with the team and get back to you.'); await page.click('#kn-save'); await toast('Draft saved');
  ok('the lines the system sends are editable; numbers or addresses in them are refused with a clear message');

  // ------------------------------------------------------------ 9. phone
  await page.click('#kn-close'); await ctx.close(); ({ ctx, page } = await open({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true }));
  await openCentre(); await tab('know'); await page.waitForSelector('.kn-sec');
  const over = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth, document.getElementById('kn-dlg').getBoundingClientRect().width]); assert.ok(over[0] <= over[1] + 1, 'no sideways scrolling: ' + over); assert.ok(over[2] <= 375, 'the dialog fits the phone');
  const bar = await page.locator('#kn-save').boundingBox(); assert.ok(bar && bar.y + bar.height <= 800, 'the save and publish buttons are on screen'); await page.screenshot({ path: path.join(SHOTS, 'knowledge-phone.png') });
  ok('on a 375px phone the Knowledge Centre fits the screen, with Save and Publish reachable');

  assert.deepEqual(errors, [], 'no console or page errors: ' + errors.join(' | ')); ok('no console or page errors');
  await ctx.close(); await browser.close(); web.close();
  console.log(`ALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('FAILED:', e && e.stack || e); process.exit(1); });
