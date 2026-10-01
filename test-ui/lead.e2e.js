'use strict';
// Phase 3 browser test: a Meta lead posted to the real leadIntake function shows up in the real Inbox.
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const crypto = require('crypto');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getAuth } = fnRequire('firebase-admin/auth');
const ROOT = path.join(__dirname, '..');
const FN = 'http://127.0.0.1:5001/demo-leados/europe-west1', KEY = 'emulator-leads-key-0123456789abcdef', P = '353891234567';
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
const post = (body, key = KEY) => fetch(FN + '/leadIntake', { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) }, body: JSON.stringify(body) });

(async () => {
  initializeApp({ projectId: 'demo-leados' });
  const u = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true });
  const token = await getAuth().createCustomToken(u.uid);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 820 } })).newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  console.log('LEAD E2E: Make-style POST -> leadIntake -> Inbox');
  await page.goto('http://127.0.0.1:5055/');
  await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await page.waitForSelector('#app:not([hidden])');

  assert.equal((await post({ leadId: 'LEAD0000001' }, null)).status, 401);
  assert.equal((await post({ leadId: 'LEAD0000001' }, 'wrong-key-wrong-key-wrong-key')).status, 401);
  assert.equal(graph.length, 0); ok('requests without the right key are refused and nothing is sent');

  const lead = { leadId: '1111222233334444', formId: '1670243097747430', formName: '(03/26) Free Quote + Consultation Form (Kitchens) (prices)',
    fields: { full_name: 'john smith', phone_number: '0891234567', email: 'John@Example.com', city: 'Balbriggan', 'what_is_your_budget?': '€20,000 - €30,000', project_requirements: 'Full kitchen renovation' } };
  const r = await post(lead); const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.welcome, 'sent'); ok('a lead is accepted and the welcome is sent');
  assert.equal(graph.length, 1); assert.equal(graph[0].body.to, P); assert.equal(graph[0].body.template.name, 'elite_kitchens_new_lead');
  assert.equal(graph[0].body.template.components[0].parameters[0].text, 'John'); ok('Irish number normalised; template sent once with first name "John"');

  const conv = page.locator(`.conv[data-phone="${P}"]`);
  await conv.waitFor();
  assert.equal(await page.locator('.conv').count(), 1); ok('the customer appears in the Inbox list automatically');
  await conv.click();
  await page.waitForSelector('.m.out');
  assert.match(await page.locator('#msgs').innerText(), /Hi John, thanks for your enquiry/); ok('the welcome message shows in the conversation');
  assert.equal(await page.inputValue('#d-name'), 'John Smith'); assert.equal(await page.inputValue('#d-email'), 'John@Example.com');
  assert.equal(await page.inputValue('#d-location'), 'Balbriggan'); assert.equal(await page.inputValue('#d-budget'), '€20,000 - €30,000');
  assert.equal(await page.inputValue('#d-source'), 'Meta Ads');
  assert.match(await page.inputValue('#d-notes'), /Full kitchen renovation/); assert.match(await page.inputValue('#d-notes'), /1111222233334444/);
  ok('details are pre-filled: name, email, location, budget, source "Meta Ads", notes with Lead ID');

  const again = await (await post(lead)).json();
  assert.equal(again.status, 'duplicate'); assert.equal(graph.length, 1); ok('a Make retry of the same lead sends nothing and creates nothing');
  assert.equal(await page.locator('.conv').count(), 1);

  // the customer replies on WhatsApp (real webhook, signed like Meta signs it): the 24h window opens and chat continues as normal
  const raw = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '111' }, contacts: [{ wa_id: P, profile: { name: 'John' } }],
    messages: [{ id: 'wamid.IN1', from: P, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Yes, can we book a visit?' } }] } }] }] });
  const wh = await fetch(FN + '/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', 'secret').update(raw).digest('hex') }, body: raw });
  assert.equal(wh.status, 200);
  await page.waitForFunction(() => /book a visit/.test(document.getElementById('msgs').innerText)); ok("the customer's reply lands in the same conversation");
  assert.equal(await page.locator('.conv').count(), 1);
  await page.fill('#text', 'Hi John, yes - when suits for a visit?'); await page.press('#text', 'Enter');
  await page.waitForFunction(() => /when suits for a visit/.test(document.getElementById('msgs').innerText));
  for (let i = 0; i < 50 && graph.length < 2; i++) await sleep(100);
  assert.equal(graph.length, 2); assert.equal(graph[1].body.type, 'text'); ok('staff can reply normally from the Inbox');

  const bad = await (await post({ leadId: 'LEAD0000002', fields: { full_name: 'No Phone', phone_number: '12' } })).json();
  assert.equal(bad.status, 'rejected'); assert.equal(bad.reason, 'invalid_phone'); assert.equal(graph.length, 2); ok('a lead with an unusable phone is reported as rejected (Make emails you), nothing sent');

  assert.deepEqual(errors, [], 'browser errors: ' + JSON.stringify(errors)); ok('no JavaScript errors in the browser');
  await browser.close(); web.close(); meta.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.message || e); process.exit(1); });
