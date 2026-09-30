'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert');
const { chromium } = require('playwright');
const admin = require('../functions/node_modules/firebase-admin');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const FN = 'http://127.0.0.1:5001/demo-leados/europe-west1';
const A = '353851111111', B = '353862222222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, msg, t = 15000) { const s = Date.now(); while (Date.now() - s < t) { if (await fn()) return; await sleep(100); } throw new Error('timed out waiting for: ' + msg); }
let n = 0; const ok = (m) => console.log(`  PASS ${++n}. ${m}`);

// ---- static server: serves public/, plus the Firebase client SDK and init.js the way Hosting would ----
const cfgJs = `firebase.initializeApp({apiKey:'fake',projectId:'demo-leados',authDomain:'localhost'});
firebase.auth().useEmulator('http://127.0.0.1:9099',{disableWarnings:true});
firebase.firestore().useEmulator('127.0.0.1',8085);
firebase.app().functions('europe-west1').useEmulator('127.0.0.1',5001);`;
const web = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  let f;
  if (u === '/__/firebase/init.js') { res.setHeader('content-type', 'text/javascript'); return res.end(cfgJs); }
  const m = /^\/__\/firebase\/[\d.]+\/(.+)$/.exec(u);
  if (m) f = path.join(ROOT, 'node_modules/firebase', m[1]);
  else f = path.join(ROOT, 'public', u === '/' ? 'index.html' : u);
  fs.readFile(f, (e, d) => {
    if (e) { res.statusCode = 404; return res.end('nf'); }
    res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(f)] || 'application/octet-stream');
    res.end(d);
  });
}).listen(5055);

// ---- mock Meta Graph API ----
const graph = []; let gid = 0;
const meta = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    graph.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b || '{}') });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ messages: [{ id: 'wamid.OUT' + ++gid }] }));
  });
}).listen(9911);

// ---- fake Meta -> our webhook ----
async function hook(payload) {
  const raw = JSON.stringify(payload);
  const r = await fetch(FN + '/webhook', { method: 'POST', headers: { 'content-type': 'application/json',
    'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', 'secret').update(raw).digest('hex') }, body: raw });
  assert.equal(r.status, 200, 'webhook status ' + r.status);
}
let wm = 0;
const inbound = (from, name, extra) => hook({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '111' },
  contacts: [{ wa_id: from, profile: { name } }],
  messages: [{ id: 'wamid.IN' + ++wm, from, timestamp: String(Math.floor(Date.now() / 1000)), ...extra }] } }] }] });
const text = (from, name, body) => inbound(from, name, { type: 'text', text: { body } });
const status = (wamid, to, st) => hook({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '111' }, statuses: [{ id: wamid, status: st, recipient_id: to }] } }] }] });

(async () => {
  admin.initializeApp({ projectId: 'demo-leados' });
  const mk = async (email) => { const u = await admin.auth().createUser({ email, emailVerified: true }); return admin.auth().createCustomToken(u.uid); };
  const staffToken = await mk('staff@test.dev'), strangerToken = await mk('stranger@test.dev');

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 820 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const conv = (p) => page.locator(`.conv[data-phone="${p}"]`);
  const signIn = (t) => page.evaluate((tok) => firebase.auth().signInWithCustomToken(tok), t);

  console.log('E2E: real page + real functions + emulators + mocked Meta');
  await page.goto('http://127.0.0.1:5055/');
  assert(await page.locator('#login').isVisible()); ok('signed-out visitors see only the login screen');
  assert(!(await page.locator('#app').isVisible()));

  // --- unauthorised user (TEST I) ---
  await signIn(strangerToken);
  await page.waitForSelector('#loginmsg:not(:empty)');
  assert(!(await page.locator('#app').isVisible()));
  assert.match(await page.locator('#loginmsg').innerText(), /not authorised/i);
  ok('TEST I: a non-allowlisted Google account is refused and never sees the inbox');
  await page.evaluate(() => firebase.auth().signOut());

  // --- staff sign-in ---
  await signIn(staffToken);
  await page.waitForSelector('#app:not([hidden])');
  await page.waitForSelector('#list-empty:not([hidden])');
  assert.match(await page.locator('#list-empty').innerText(), /No conversations yet/);
  ok('staff sign in; empty inbox shows a friendly empty state');

  // --- TEST B / C: two customers, two conversations ---
  await text(A, 'Anna Murphy', "Hi, I'm interested in getting a kitchen.");
  await conv(A).waitFor();
  assert.equal(await page.locator('.conv').count(), 1);
  assert(await conv(A).evaluate((e) => e.classList.contains('unread'))); ok('TEST B: first customer appears, marked unread');
  await sleep(1100);
  await text(B, 'Brian Byrne', 'Do you also do wardrobes?');
  await conv(B).waitFor();
  assert.equal(await page.locator('.conv').count(), 2);
  assert.equal(await page.locator('.conv').first().getAttribute('data-phone'), B); ok('TEST C: second customer gets their own conversation; newest first');
  assert.equal((await page.locator('#total-unread').innerText()).trim(), '2'); ok('unread total = 2 (header count)');
  assert.match(await page.title(), /^\(2\)/); ok('browser tab title shows (2)');

  // --- open A: only A's messages, marked read ---
  await conv(A).click();
  await page.waitForSelector('.m.in');
  assert.match(await page.locator('#msgs').innerText(), /interested in getting a kitchen/);
  assert(!/wardrobes/.test(await page.locator('#msgs').innerText())); ok("opening A shows only A's messages (no mixing)");
  await page.waitForFunction((p) => !document.querySelector(`.conv[data-phone="${p}"]`).classList.contains('unread'), A);
  assert(await conv(B).evaluate((e) => e.classList.contains('unread')));
  assert.equal((await page.locator('#total-unread').innerText()).trim(), '1'); ok('TEST G: opening A marks only A read; B stays unread; count = 1');

  // --- TEST D: replies go to the right person ---
  await page.fill('#text', 'Hi Anna, thanks for getting in touch!'); await page.press('#text', 'Enter');
  await until(() => graph.length === 1, 'reply to A reaches the Meta API');
  await page.waitForFunction(() => document.querySelectorAll('.m.out').length === 1 && !/Sending/.test(document.getElementById('msgs').innerText));
  assert.equal(graph.length, 1); assert.equal(graph[0].body.to, A); assert.equal(graph[0].body.text.body, 'Hi Anna, thanks for getting in touch!');
  assert.equal(graph[0].auth, 'Bearer tok'); assert.match(graph[0].url, /\/111\/messages$/);
  assert.equal(await page.locator('.m.out').count(), 1);
  ok('TEST D (1/2): reply typed in A reaches Meta addressed to A, exactly once');
  await status('wamid.OUT1', A, 'delivered'); await status('wamid.OUT1', A, 'read');
  await page.waitForSelector('.m.out .tick.read'); ok('TEST A/status: delivered/read ticks come back through the webhook');

  // new inbound while A is open and focused stays read
  await text(A, 'Anna Murphy', 'Could someone come next week?');
  await page.waitForFunction(() => /next week/.test(document.getElementById('msgs').innerText));
  await sleep(1800);
  assert(!(await conv(A).evaluate((e) => e.classList.contains('unread')))); ok('a message arriving in the open conversation is marked read automatically');

  // image from B shows as a photo
  await inbound(B, 'Brian Byrne', { type: 'image', image: { id: 'MEDIA9', mime_type: 'image/jpeg', caption: 'my kitchen now' } });
  await page.waitForFunction((p) => /Photo|my kitchen now/.test(document.querySelector(`.conv[data-phone="${p}"]`).innerText), B);
  ok('image message shows in the list as a photo/caption');

  await conv(B).click();
  await page.waitForFunction(() => /my kitchen now/.test(document.getElementById('msgs').innerText));
  assert.equal(await page.locator('.media-chip').count(), 1);
  assert(!/Anna|next week/.test(await page.locator('#msgs').innerText())); ok("opening B shows only B's messages, image as a chip");
  await page.fill('#text', 'Yes we do wardrobes, Brian.'); await page.press('#text', 'Enter');
  await until(() => graph.length === 2, 'reply to B reaches the Meta API');
  await page.waitForFunction(() => document.querySelectorAll('.m.out').length === 1 && !/Sending/.test(document.getElementById('msgs').innerText));
  assert.equal(graph.length, 2); assert.equal(graph[1].body.to, B); assert.equal(graph[1].body.text.body, 'Yes we do wardrobes, Brian.');
  ok('TEST D (2/2): reply typed in B reaches Meta addressed to B; A untouched');
  await conv(A).click();
  await page.waitForFunction(() => /Hi Anna/.test(document.getElementById('msgs').innerText));
  assert(!/wardrobes, Brian/.test(await page.locator('#msgs').innerText())); ok("A's thread does not contain B's reply");

  // --- customer details ---
  assert(await page.locator('#details').isVisible()); ok('customer details panel is open on wide screens');
  await page.fill('#d-email', 'not-an-email'); await page.fill('#d-location', 'Swords'); await page.selectOption('#d-projectType', 'Kitchen');
  await page.fill('#d-budget', '€15–20k'); await page.selectOption('#d-source', 'Meta Ads'); await page.fill('#d-notes', 'Wants island');
  await page.click('#d-save');
  await page.waitForFunction(() => /does not look right/.test(document.getElementById('d-msg').innerText));
  ok('an invalid email is rejected with a clear message (nothing saved)');
  await page.fill('#d-email', 'anna@example.com'); await page.fill('#d-name', 'Anna M. Murphy'); await page.click('#d-save');
  await page.waitForFunction(() => document.getElementById('d-msg').innerText === 'Saved');
  await page.waitForFunction((p) => /Kitchen · Swords/.test(document.querySelector(`.conv[data-phone="${p}"]`).innerText), A);
  await page.waitForFunction(() => /Anna M\. Murphy/.test(document.getElementById('t-name').innerText));
  const saved = (await admin.firestore().doc('contacts/' + A).get()).data();
  assert.deepEqual([saved.name, saved.email, saved.location, saved.projectType, saved.budget, saved.source, saved.notes],
    ['Anna M. Murphy', 'anna@example.com', 'Swords', 'Kitchen', '€15–20k', 'Meta Ads', 'Wants island']);
  ok('details save to the customer record; list shows "Kitchen · Swords"; header shows the edited name');
  await page.fill('#d-notes', 'Wants island and pantry, typing…');
  await admin.firestore().doc('contacts/' + A).update({ budget: '€99k' });     // someone else edits while I am typing
  await sleep(700);
  assert.equal(await page.inputValue('#d-notes'), 'Wants island and pantry, typing…'); ok("a remote change never overwrites text that is being typed");
  await page.click('#d-save'); await page.waitForFunction(() => document.getElementById('d-msg').innerText === 'Saved');

  // --- TEST H: search ---
  await page.fill('#search', 'anna');
  assert.equal(await page.locator('.conv').count(), 1); assert.equal(await page.locator('.conv').getAttribute('data-phone'), A);
  await page.fill('#search', '0862222222');
  assert.equal(await page.locator('.conv').count(), 1); assert.equal(await page.locator('.conv').getAttribute('data-phone'), B);
  await page.fill('#search', '+353 85 111');
  assert.equal(await page.locator('.conv').getAttribute('data-phone'), A);
  await page.fill('#search', 'swords');
  assert.equal(await page.locator('.conv').count(), 1); assert.equal(await page.locator('.conv').getAttribute('data-phone'), A);
  await page.fill('#search', 'nobody');
  assert.equal(await page.locator('.conv').count(), 0); assert.match(await page.locator('#list-empty').innerText(), /No conversations match/);
  await page.fill('#search', ''); assert.equal(await page.locator('.conv').count(), 2);
  ok('TEST H: search finds the right customer by name, phone (08x or +353) and location');

  // --- 24-hour window ---
  await admin.firestore().doc('conversations/353870000000').set({ phone: '353870000000', name: 'Old Lead', updatedAt: admin.firestore.Timestamp.now(),
    lastMessage: 'ancient', lastInboundAt: admin.firestore.Timestamp.fromMillis(Date.now() - 30 * 3600e3) });
  await conv('353870000000').waitFor(); await conv('353870000000').click();
  await page.waitForSelector('#window-note:not([hidden])');
  assert(await page.locator('#text').isDisabled()); ok('after 24h of silence the composer is disabled and a "Send template" prompt is shown');

  // --- new conversation via template ---
  await page.click('#new-btn');
  await page.fill('#n-phone', '089 464 1917'); await page.fill('#n-name', 'Tomasz'); await page.click('#n-go');
  await page.waitForFunction(() => location.hash === '#c/353894641917');
  await until(() => graph.length === 3, 'template reaches the Meta API');
  const t = graph.at(-1).body;
  assert.equal(t.to, '353894641917'); assert.equal(t.type, 'template'); assert.equal(t.template.components[0].parameters[0].text, 'Tomasz');
  ok('TEST A: new conversation sends the approved template to the normalised Irish number');

  // --- deep link survives reload ---
  await page.goto('http://127.0.0.1:5055/#c/' + A);
  await signIn(staffToken);
  await page.waitForFunction(() => /Hi Anna/.test(document.getElementById('msgs').innerText)); ok('deep link (#c/phone) reopens the right conversation after a reload');

  await page.screenshot({ path: path.join(SHOTS, 'desktop.png') });

  // --- mobile ---
  const mctx = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true });
  const mp = await mctx.newPage(); mp.on('pageerror', (e) => errors.push('mobile: ' + e.message));
  await mp.goto('http://127.0.0.1:5055/');
  await mp.evaluate((tok) => firebase.auth().signInWithCustomToken(tok), staffToken);
  await mp.waitForSelector('.conv');
  assert(await mp.locator('.list-pane').isVisible()); assert(!(await mp.locator('.thread-pane').isVisible()));
  await mp.screenshot({ path: path.join(SHOTS, 'mobile-list.png') });
  await mp.locator(`.conv[data-phone="${A}"]`).click();
  await mp.waitForSelector('.m');
  assert(await mp.locator('.thread-pane').isVisible()); assert(!(await mp.locator('.list-pane').isVisible()));
  await mp.screenshot({ path: path.join(SHOTS, 'mobile-thread.png') });
  assert(!(await mp.locator('#details').isVisible()));
  await mp.click('#details-btn'); await mp.waitForSelector('#details:not([hidden])');
  assert.equal(await mp.inputValue('#d-location'), 'Swords');
  await mp.screenshot({ path: path.join(SHOTS, 'mobile-details.png') });
  await mp.click('#details-close'); assert(!(await mp.locator('#details').isVisible()));
  await mp.click('#back'); assert(await mp.locator('.list-pane').isVisible());
  ok('mobile: one pane at a time; details open as a full-screen drawer; Back returns to the inbox');

  // --- TEST I (data layer): rules ---
  const idOf = async (tok) => (await (await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: tok, returnSecureToken: true }) })).json()).idToken;
  const rest = (idt) => fetch(`http://127.0.0.1:8085/v1/projects/demo-leados/databases/(default)/documents/conversations`, { headers: { authorization: 'Bearer ' + idt } });
  const strangerId = await idOf(strangerToken);
  assert.equal((await rest(strangerId)).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:8085/v1/projects/demo-leados/databases/(default)/documents/conversations`)).status, 403);
  ok('TEST I (data): the database itself refuses reads from a stranger and from signed-out requests');

  assert.deepEqual(errors, [], 'browser errors: ' + JSON.stringify(errors)); ok('no JavaScript errors in the browser');
  await browser.close(); web.close(); meta.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch(async (e) => { console.error('\nFAILED:', e.message || e); process.exit(1); });
