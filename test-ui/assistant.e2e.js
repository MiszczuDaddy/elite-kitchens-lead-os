'use strict';
// Phase 9.1 browser test: the Assistant. The real page + the real functions + emulators, with the built-in DEMO model (AI_FAKE_MODEL=on, emulator only): no real model, key or customer.
// It checks what the owner will see and rely on: the screen and its states (off, no data yet, ready, budget used up), the settings dialog (switch, limits, the data gate with its
// confirmation), a lookup answered from the data, the open customer passed as an id, answers drawn as text (never as a page), the conversation kept in the tab only, that nothing
// in the customer data changes, and the phone layout. Every name and number is made up. Run: bash test-ui/run.sh assistant.e2e.js
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
}).listen(5057);

const DAY = 86400000, ago = (d) => Timestamp.fromMillis(Date.now() - d * DAY);
const ph = { anna: '353860000031', brian: '353860000032', zed: '353860000033' };
const XSS_NAME = '<img src=x onerror="window.__xss=1"> Zed';

(async () => {
  initializeApp({ projectId: 'demo-leados' });
  const db = getFirestore();
  const seed = async (id, contact, stage = 'quoted') => {
    await db.doc('conversations/' + id).set({ phone: id, name: contact.name, createdAt: ago(10), updatedAt: ago(1), lastMessage: 'Hi', unreadCount: 0, inboxStatus: stage, stageDates: { [stage]: ago(3) } });
    await db.doc('contacts/' + id).set({ phone: id, createdAt: ago(10), ...contact });
  };
  await seed(ph.anna, { name: 'Anna Apple', email: 'anna@example.com', location: 'Swords' });
  await seed(ph.brian, { name: 'Brian Byrne', location: 'Malahide' }, 'inbox');
  await seed(ph.zed, { name: XSS_NAME, location: 'Howth' });
  const snapshotData = async () => JSON.stringify(await Promise.all(['conversations', 'contacts', 'quotes', 'projects', 'appointments'].map(async (c) => (await db.collection(c).get()).docs.map((d) => [d.id, d.data()]))));
  const settingsDoc = () => db.doc('aiSettings/current');

  const u = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true });
  const token = await getAuth().createCustomToken(u.uid);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const errors = [], chatBodies = []; global.__errors = errors;
  const open = async (options = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, ...options }), page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on('request', (r) => { if (/\/aiChat$/.test(r.url()) && r.method() === 'POST') chatBodies.push(JSON.parse(r.postData()).data); });
    await page.goto('http://127.0.0.1:5057/'); await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])');
    return { ctx, page };
  };
  let { ctx, page } = await open();
  const answers = () => page.locator('#as-msgs .as-msg.assistant:not(.pending)');
  const ask = async (text) => { const before = await answers().count(); await page.fill('#as-input', text); await page.press('#as-input', 'Enter'); await page.waitForFunction((c) => document.querySelectorAll('#as-msgs .as-msg.assistant:not(.pending)').length > c, before); };
  const saveSettings = async (fn) => { await page.click('#as-settings'); await page.waitForSelector('#as-dlg[open]'); await page.waitForFunction(() => /this month/.test(document.getElementById('as-set-spent').textContent)); await fn(); await page.click('#as-set-save'); };
  console.log('ASSISTANT E2E: real page + real functions + emulators + the demo model');

  // ------------------------------------------------------------------ 1. the rail, the empty screen, and "off by default"
  assert.equal(await page.locator('#nav-assistant').innerText(), 'Assistant');
  await page.click('#nav-assistant'); await page.waitForSelector('#assistant', { state: 'visible' });
  assert.equal(await page.getAttribute('#app', 'data-view'), 'assistant'); assert.equal(await page.getAttribute('#nav-assistant', 'aria-current'), 'page'); assert.equal(await page.getAttribute('#nav-inbox', 'aria-current'), null);
  await page.waitForFunction(() => document.getElementById('as-notice').textContent.length > 0);
  assert.match(await page.locator('#as-notice').innerText(), /switched off/);
  assert.equal(await page.locator('#as-input').isDisabled(), true); assert.equal(await page.locator('#as-send').isDisabled(), true);
  assert.equal(await page.locator('#as-suggest button').count(), 4);
  assert.match(await page.locator('#as-meter-label').innerText(), /€0\.00 of €15 used this month/);
  assert.match(await page.locator('.as-foot').innerText(), /Read-only/);
  ok('the Assistant opens from the rail; a fresh install is OFF, says so, and cannot be asked');
  await page.screenshot({ path: path.join(SHOTS, 'assistant-off.png') });

  // ------------------------------------------------------------------ 2. settings: switch on; real customer data stays off until it is confirmed
  await saveSettings(async () => { await page.check('#as-set-enabled'); });
  await page.waitForFunction(() => !document.getElementById('as-dlg').open);
  await page.waitForFunction(() => /Haiku model has not been checked/.test(document.getElementById('as-notice').textContent));
  assert.equal(await page.locator('#as-input').isDisabled(), true, 'a model cannot be used before it was checked with the provider');
  await page.click('#as-settings'); await page.waitForSelector('#as-dlg[open]');
  await page.waitForFunction(() => /not checked yet/.test(document.getElementById('as-set-models').textContent));
  assert.match(await page.locator('#as-set-models').innerText(), /Haiku: not checked yet[\s\S]*Sonnet: not checked yet/);
  await page.click('#as-set-check');
  await page.waitForFunction(() => /Haiku: ready/.test(document.getElementById('as-set-models').textContent) && /Sonnet: ready/.test(document.getElementById('as-set-models').textContent));
  assert.equal((await db.doc('aiSettings/modelCheck').get()).data().haiku.ok, true);
  await page.click('#as-set-cancel');
  await page.waitForFunction(() => /not switched on/.test(document.getElementById('as-notice').textContent));
  assert.equal(await page.locator('#as-input').isDisabled(), false);
  const s1 = (await settingsDoc().get()).data(); assert.equal(s1.enabled, true); assert.equal(s1.customerDataApproved, undefined); assert.equal(s1.updatedBy, 'staff@test.dev');
  ok('switching it on works; models must pass "Check models" first; customer data is still OFF and the screen says so');

  await ask('find anna');
  assert.match(await answers().last().innerText(), /not been switched on|cannot|could not/i);
  assert.doesNotMatch(await page.locator('#as-msgs').innerText(), /Anna Apple/);
  ok('with the data gate closed, a lookup is refused: no customer name reaches the answer');

  await page.click('#as-settings'); await page.waitForSelector('#as-dlg[open]');
  await page.waitForFunction(() => /this month/.test(document.getElementById('as-set-spent').textContent));
  assert.equal(await page.locator('#as-set-terms').isVisible(), false);
  await page.check('#as-set-data'); assert.equal(await page.locator('#as-set-terms').isVisible(), true);
  await page.click('#as-set-save');
  await page.waitForFunction(() => /data terms/.test(document.getElementById('as-set-err').textContent));
  assert.equal((await settingsDoc().get()).data().customerDataApproved, undefined, 'nothing saved without the confirmation');
  await page.check('#as-set-terms'); await page.click('#as-set-save');
  await page.waitForFunction(() => !document.getElementById('as-dlg').open);
  const s2 = (await settingsDoc().get()).data(); assert.equal(s2.customerDataApproved, true);
  const audit = (await db.collection('auditLog').where('action', '==', 'aiSettings').get()).docs.map((d) => d.data());
  assert.equal(audit.length, 2); assert.ok(audit.some((a) => a.changed.includes('customerDataApproved')));
  assert.equal(await page.locator('#as-notice').isVisible(), false);
  ok('real customer data needs the explicit confirmation box; saved and audited');

  // ------------------------------------------------------------------ 3. a real lookup, answered from the data
  const before = await snapshotData();
  await ask('find anna');
  assert.match(await answers().last().innerText(), /Anna Apple \(Quoted\)/);
  assert.match(await page.locator('.as-trace').last().innerText(), /Searched customers: anna/);
  assert.match(await page.locator('.as-trace').last().innerText(), /€0\.\d{3}|under €0\.001/);
  assert.equal(await snapshotData(), before, 'asking questions changes no customer data');
  ok('"find anna" is answered from the data, shows which lookup was made and what it cost; nothing in the customer data changed');
  await page.screenshot({ path: path.join(SHOTS, 'assistant-chat.png') });

  // ------------------------------------------------------------------ 3b. Haiku by default, Sonnet by choice, "Retry with Sonnet" once
  assert.equal(await page.getAttribute('#as-model button[data-model=haiku]', 'aria-pressed'), 'true'); assert.equal(await page.getAttribute('#as-model button[data-model=sonnet]', 'aria-pressed'), 'false');
  assert.equal(chatBodies.at(-1).model, 'haiku', 'Haiku is the default');
  assert.match(await page.locator('.as-trace').last().innerText(), /Haiku/);
  assert.equal(await page.locator('.as-retry').count(), 1, 'the last Haiku answer offers a retry');
  const nBefore = await answers().count(), askedBefore = chatBodies.length;
  await page.click('.as-retry');
  await page.waitForFunction(() => /Sonnet/.test(document.querySelector('#as-msgs').lastElementChild.innerText));
  assert.equal(chatBodies.length, askedBefore + 1, 'one request, one model: no automatic second call'); assert.equal(chatBodies.at(-1).model, 'sonnet');
  assert.equal(chatBodies.at(-1).message, chatBodies.at(-2).message, 'the same question'); assert.deepEqual(chatBodies.at(-1).history, chatBodies.at(-2).history, 'the same earlier conversation');
  assert.equal(await answers().count(), nBefore, 'the retry replaces the answer'); assert.equal(await page.locator('.as-retry').count(), 0, 'no retry offered after a Sonnet answer');
  assert.match(await answers().last().innerText(), /Anna Apple \(Quoted\)/);
  await page.click('#as-model button[data-model=sonnet]'); assert.equal(await page.getAttribute('#as-model button[data-model=sonnet]', 'aria-pressed'), 'true');
  await ask('who are you'); assert.equal(chatBodies.at(-1).model, 'sonnet'); assert.equal(await page.locator('.as-retry').count(), 0);
  await page.click('#as-model button[data-model=haiku]'); await ask('who are you again'); assert.equal(chatBodies.at(-1).model, 'haiku');
  assert.equal(await page.locator('.as-retry').count(), 1);
  assert.equal(await page.locator('#as-model button').count(), 2);
  ok('Haiku is the default; Sonnet can be chosen; "Retry with Sonnet" re-asks the same question once with the other model; nothing escalates by itself');

  // ------------------------------------------------------------------ 3c. only the owner account sees the customer-data switch as usable
  await page.route(/\/aiStatus$/, async (route) => { const resp = await route.fetch(), j = await resp.json(); j.result.canApproveData = false; await route.fulfill({ response: resp, json: j }); });
  await page.click('#as-settings'); await page.waitForSelector('#as-dlg[open]'); await page.waitForFunction(() => /Only the owner account/.test(document.getElementById('as-set-data-hint').textContent));
  assert.equal(await page.locator('#as-set-data').isDisabled(), true); assert.equal(await page.locator('#as-set-enabled').isDisabled(), false);
  await page.click('#as-set-cancel'); await page.unroute(/\/aiStatus$/);
  await page.click('#as-settings'); await page.waitForSelector('#as-dlg[open]'); await page.waitForFunction(() => /this month/.test(document.getElementById('as-set-spent').textContent));
  assert.equal(await page.locator('#as-set-data').isDisabled(), false, 'the owner account can use it'); await page.click('#as-set-cancel');
  ok('the customer-data box is disabled for any account that is not the owner (the server enforces it too), and usable for the owner');

  for (const d of (await db.collection('aiRate').get()).docs) await d.ref.delete();
  // ------------------------------------------------------------------ 4. answers are text, never a page
  await ask('find zed');
  const reply = await answers().last().innerText();
  assert.ok(reply.includes('<img src=x'), reply);
  assert.equal(await page.locator('#as-msgs img').count(), 0);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await ask('show <b onclick="window.__xss=2">bold</b>');
  assert.equal(await page.locator('#as-msgs b').count(), 0);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  ok('HTML in a customer name or in a question stays plain text: no element is created, nothing runs');

  // ------------------------------------------------------------------ 5. the conversation lives in this tab only
  const turns = await page.locator('#as-msgs .as-msg').count();
  await page.reload(); await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])');
  await page.waitForSelector('#as-msgs .as-msg');
  assert.equal(await page.locator('#as-msgs .as-msg').count(), turns); assert.equal(await page.getAttribute('#app', 'data-view'), 'assistant');
  await page.click('#as-new'); assert.equal(await page.locator('#as-msgs .as-msg').count(), 0); assert.equal(await page.locator('#as-empty').isVisible(), true);
  await page.reload(); await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])');
  await page.waitForSelector('#as-empty', { state: 'visible' }); assert.equal(await page.locator('#as-msgs .as-msg').count(), 0);
  ok('the conversation survives a reload of the tab, "New chat" clears it, and the server keeps none of it');

  for (const d of (await db.collection('aiRate').get()).docs) await d.ref.delete();            // the 8-a-minute speed limit is tested elsewhere; this run asks more often than that
  // ------------------------------------------------------------------ 6. the open customer is passed as an id; it can be removed
  await page.evaluate((id) => { location.hash = '#c/' + id; }, ph.anna); await page.waitForSelector('#thread:not([hidden])');
  await page.click('#nav-assistant'); await page.waitForSelector('#assistant', { state: 'visible' });
  assert.equal(await page.locator('#as-context-text').innerText(), 'About: Anna Apple');
  await ask('who are you');
  assert.deepEqual(chatBodies.at(-1).context, { customerId: ph.anna });
  assert.deepEqual(Object.keys(chatBodies.at(-1)).sort(), ['context', 'history', 'message', 'model']);
  await page.click('#as-context-x'); assert.equal(await page.locator('#as-context').isVisible(), false);
  await ask('who are you again');
  assert.equal(chatBodies.at(-1).context, undefined);
  assert.equal(chatBodies.at(-1).history.length, 2); assert.deepEqual(chatBodies.at(-1).history.map((t) => t.role), ['user', 'assistant']);
  ok('the open customer goes to the server as an id only; removing the chip stops it; only plain text turns go back as history');

  // ------------------------------------------------------------------ 7. keyboard: Enter sends, Shift+Enter is a new line
  await page.fill('#as-input', 'line one'); await page.press('#as-input', 'Shift+Enter'); await page.type('#as-input', 'line two');
  assert.equal(await page.inputValue('#as-input'), 'line one\nline two');
  await page.fill('#as-input', '');
  ok('Shift+Enter makes a new line');

  // ------------------------------------------------------------------ 8. the kill switch and the budget
  await saveSettings(async () => { await page.uncheck('#as-set-enabled'); });
  await page.waitForFunction(() => /switched off/.test(document.getElementById('as-notice').textContent));
  assert.equal(await page.locator('#as-input').isDisabled(), true);
  await assert.rejects(page.evaluate(async () => (await firebase.app().functions('europe-west1').httpsCallable('aiChat')({ message: 'hi' })).data), /switched off/);
  await saveSettings(async () => { await page.check('#as-set-enabled'); });
  await page.waitForFunction(() => !document.getElementById('as-dlg').open && document.getElementById('as-notice').hidden);
  await settingsDoc().set({ monthlyCapEur: 0, dailyCapEur: 0 }, { merge: true });
  await page.click('#as-settings'); await page.waitForSelector('#as-dlg[open]'); await page.click('#as-set-cancel');
  await page.waitForFunction(() => /budget is used up/.test(document.getElementById('as-notice').textContent));
  assert.equal(await page.locator('#as-input').isDisabled(), true); assert.equal(await page.getAttribute('#as-meter', 'data-level'), 'full');
  await assert.rejects(page.evaluate(async () => (await firebase.app().functions('europe-west1').httpsCallable('aiChat')({ message: 'hi' })).data), /budget/);
  await settingsDoc().set({ monthlyCapEur: 15, dailyCapEur: 2 }, { merge: true });
  ok('the switch stops it at once, in the screen and on the server; a used-up budget does the same');

  // ------------------------------------------------------------------ 9. the phone
  await ctx.close();
  ({ ctx, page } = await open({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true }));
  await page.waitForSelector('#to-assistant', { state: 'visible' });
  await page.click('#to-assistant'); await page.waitForSelector('#assistant', { state: 'visible' });
  await page.waitForFunction(() => !document.getElementById('as-input').disabled);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'no sideways scrolling on the phone');
  assert.ok(Number.parseFloat(await page.evaluate(() => getComputedStyle(document.getElementById('as-input')).fontSize)) >= 16, 'the box is 16px or more, so the phone does not zoom in');
  await ask('find brian');
  assert.match(await answers().last().innerText(), /Brian Byrne \(New lead\)/);
  const box = await page.locator('#as-form').boundingBox(); assert.ok(box.y + box.height <= 812 + 1, 'the question box stays on screen');
  await page.screenshot({ path: path.join(SHOTS, 'assistant-phone.png') });
  ok('on a 375px phone: reachable from the Inbox, no sideways scrolling, the box is on screen and big enough');

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | '));
  ok('no console or page errors');
  await browser.close(); web.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e, '\nPAGE ERRORS:', global.__errors); web.close(); process.exit(1); });
