'use strict';
// Phase 6.1 M1: Reopen conversation, in the real page with the real functions, the emulators and a MOCKED Meta API (no real message
// is ever sent). Every name and number is made up. Run: bash test-ui/run.sh reopen.e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const { getAuth } = fnRequire('firebase-admin/auth');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const FN = 'http://127.0.0.1:5001/demo-leados/europe-west1';
const A = '353851111111', B = '353852222222', C = '353853333333', D = '353854444444', E = '353855555555', G = '353856666666', F = '353857777777';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, msg, t = 15000) { const s = Date.now(); while (Date.now() - s < t) { if (await fn()) return; await sleep(100); } throw new Error('timed out waiting for: ' + msg); }
let n = 0; const ok = (m) => console.log(`  PASS ${++n}. ${m}`);

// ---- static server: serves public/, plus the Firebase client SDK and init.js the way Hosting would ----
const cfgJs = `firebase.initializeApp({apiKey:'fake',projectId:'demo-leados',authDomain:'localhost',storageBucket:'demo-leados.firebasestorage.app'});
firebase.auth().useEmulator('http://127.0.0.1:9099',{disableWarnings:true});
firebase.firestore().useEmulator('127.0.0.1',8085);
firebase.app().functions('europe-west1').useEmulator('127.0.0.1',5001);
firebase.storage().useEmulator('127.0.0.1',9199);`;
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

// ---- mock Meta Graph API: only messages. metaMode 'refuse' answers like Meta does for a template it does not know ----
const graph = []; let gid = 0, metaMode = 'ok';
const meta = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    const json = (o, st = 200) => { res.statusCode = st; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.method === 'POST' && /\/111\/messages$/.test(req.url)) {
      graph.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
      if (metaMode === 'refuse') return json({ error: { code: 132001, message: 'Template name does not exist in the translation' } }, 400);
      return json({ messages: [{ id: 'wamid.OUT' + ++gid }] });
    }
    json({ error: { message: 'unexpected ' + req.method + ' ' + req.url } }, 404);
  });
}).listen(9911);
meta.keepAliveTimeout = 0;   // test harness only: never drop an idle connection mid-test

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
const status = (wamid, to, st, errors) => hook({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '111' },
  statuses: [{ id: wamid, status: st, recipient_id: to, ...(errors ? { errors } : {}) }] } }] }] });

(async () => {
  initializeApp({ projectId: 'demo-leados' });
  const db = getFirestore();
  const staffToken = await (async () => { const u = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true }); return getAuth().createCustomToken(u.uid); })();
  const H = 3600e3, t0 = Date.now();
  let order = 0;
  const seed = (p, name, inboundAgoH) => db.doc('conversations/' + p).set({ phone: p, ...(name ? { name } : {}), createdAt: Timestamp.now(), updatedAt: Timestamp.fromMillis(t0 - ++order * 1000),
    lastMessage: 'Hi', ...(inboundAgoH == null ? {} : { lastInboundAt: Timestamp.fromMillis(t0 - inboundAgoH * H) }) });
  await seed(A, 'Anna Murphy', 30); await seed(B, 'Brian Byrne', 30); await seed(C, 'Cara Walsh', null); await seed(D, 'Dan Open', 1);
  await seed(E, 'Eva Egan', 30); await seed(G, 'Gus Grant', 30); await seed(F, 'Fiona Flynn', 30);

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 820 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const conv = (p) => page.locator(`.conv[data-phone="${p}"]`);
  const note = () => page.locator('#window-note');
  const noteText = async () => (await page.locator('#window-text').innerText()).replace(/\s+/g, ' ');
  const callFn = (name, data) => page.evaluate(async ([nm, d]) => {
    try { return { ok: true, data: (await firebase.app().functions('europe-west1').httpsCallable(nm)(d)).data }; }
    catch (e) { return { ok: false, code: e.code, message: e.message }; }
  }, [name, data]);
  const open = async (p) => { await conv(p).click(); await page.waitForFunction((ph) => location.hash === '#c/' + ph, p); };

  console.log('E2E: Reopen conversation: real page + real functions + emulators + mocked Meta');
  await page.goto('http://127.0.0.1:5055/');
  await page.evaluate((tok) => firebase.auth().signInWithCustomToken(tok), staffToken);
  await page.waitForSelector('#app:not([hidden])');
  await conv(A).waitFor(); await conv(F).waitFor();

  // --- open window: nothing changes for staff ---
  await open(D);
  assert(await page.locator('#text').isEnabled()); assert(await page.locator('#send').isEnabled()); assert(await note().isHidden());
  assert.equal(await page.locator('#text').getAttribute('placeholder'), 'Type a message…');
  ok('window open (customer wrote an hour ago): normal composer, no band, no Reopen button');

  // --- closed window ---
  await open(A);
  await page.waitForSelector('#window-note:not([hidden])');
  assert(await page.locator('#text').isDisabled()); assert(await page.locator('#send').isDisabled()); assert(await page.locator('#attach-btn').isDisabled());
  assert.match(await noteText(), /^More than 24 hours since Anna Murphy last messaged\. WhatsApp only allows an approved template until they reply\.$/);
  assert(await page.locator('#tpl-btn').isVisible()); assert.equal((await page.locator('#tpl-btn').innerText()).trim(), 'Reopen conversation');
  ok('window closed: composer off, the band says why, and offers "Reopen conversation"');

  // --- the confirmation shows exactly what will be sent; Cancel sends nothing ---
  await page.click('#tpl-btn'); await page.waitForSelector('#reopen-dlg[open]');
  assert.equal((await page.locator('#reopen-text').innerText()).trim(), "Hi Anna, it's Elite Kitchens. We have a quick question regarding your project. When you have a moment, please reply here and we'll continue the conversation.");
  assert.match(await page.locator('#reopen-who').innerText(), /approved template to Anna Murphy/);
  assert.match(await page.locator('#reopen-note').innerText(), /does not reopen normal messaging.*only after they reply/);
  await page.screenshot({ path: path.join(SHOTS, 'reopen-confirm.png') });
  await page.click('#reopen-cancel'); await page.waitForFunction(() => !document.getElementById('reopen-dlg').open);
  await sleep(300); assert.equal(graph.length, 0);
  assert.match(await noteText(), /^More than 24 hours/);
  ok('the confirmation shows the exact wording and that nothing reopens until the customer replies; Cancel sends nothing');

  // --- send: one message, then "waiting for the customer", never "reopened" ---
  await page.click('#tpl-btn'); await page.waitForSelector('#reopen-dlg[open]');
  await page.click('#reopen-go', { clickCount: 2 });                                   // a double click
  await page.waitForFunction(() => !document.getElementById('reopen-dlg').open);
  await until(() => graph.length >= 1, 'the template reaches Meta'); await sleep(1200);
  assert.equal(graph.length, 1, 'a double click sends once');
  const t = graph[0].body;
  assert.equal(t.to, A); assert.equal(t.type, 'template'); assert.equal(t.template.name, 'elite_kitchens_reopen'); assert.equal(t.template.language.code, 'en');
  assert.deepEqual(t.template.components, [{ type: 'body', parameters: [{ type: 'text', text: 'Anna' }] }]); assert.equal(graph[0].auth, 'Bearer tok');
  await page.waitForFunction(() => /Waiting for/.test(document.getElementById('window-text').textContent));
  assert.match(await noteText(), /^Template sent \d\d:\d\d \(sent\)\. Waiting for Anna Murphy to reply\. You can't send normal messages until they do\.$/);
  assert(await page.locator('#tpl-btn').isHidden()); assert(await page.locator('#text').isDisabled()); assert(await page.locator('#send').isDisabled());
  assert.equal(await page.locator('#text').getAttribute('placeholder'), 'Waiting for Anna Murphy to reply…');
  assert.match(await page.locator('#msgs').innerText(), /We have a quick question regarding your project/);
  await page.screenshot({ path: path.join(SHOTS, 'reopen-awaiting.png') });
  ok('Reopen sends one template (double click: once) to Meta with the first name only; the chat says "Waiting for Anna Murphy to reply" and stays locked');

  // --- Meta's delivery statuses reach the band ---
  await status('wamid.OUT1', A, 'delivered');
  await page.waitForFunction(() => /\(delivered\)/.test(document.getElementById('window-text').textContent));
  await status('wamid.OUT1', A, 'read');
  await page.waitForFunction(() => /\(read\)/.test(document.getElementById('window-text').textContent));
  ok('delivery ticks (delivered, read) show in the "waiting" band');

  // --- still no free-form messaging, enforced by the server too ---
  const blocked = await callFn('sendReply', { phone: A, body: 'hello' });
  assert.equal(blocked.ok, false); assert.equal(blocked.code, 'functions/failed-precondition'); assert.equal(graph.length, 1);
  ok('the server still refuses a normal message while waiting: sending the template did not reopen anything');

  // --- the customer replies by tapping a button: the chat unlocks by itself ---
  await inbound(A, 'Anna Murphy', { type: 'button', button: { text: 'Go ahead', payload: 'x' } });
  await page.waitForFunction(() => document.getElementById('window-note').hidden);
  assert(await page.locator('#text').isEnabled()); assert(await page.locator('#send').isEnabled());
  assert.equal(await page.locator('#text').getAttribute('placeholder'), 'Type a message…');
  assert.match(await page.locator('#msgs').innerText(), /Go ahead/);
  await page.fill('#text', 'Great, thanks Anna'); await page.click('#send');
  await until(() => graph.length >= 2, 'the normal message goes out'); assert.equal(graph[1].body.type, 'text');
  ok('after the customer replies the band disappears, the composer unlocks and a normal message goes out');

  // --- Meta refuses the template: plain words, nothing claimed as sent, try again later ---
  await open(B); await page.waitForSelector('#tpl-btn:not([hidden])');
  metaMode = 'refuse';
  await page.click('#tpl-btn'); await page.waitForSelector('#reopen-dlg[open]'); await page.click('#reopen-go');
  await page.waitForFunction(() => /doesn't know this template/.test(document.getElementById('reopen-err').textContent));
  assert(await page.locator('#reopen-go').isDisabled()); assert.equal((await page.locator('#reopen-cancel').innerText()).trim(), 'Close');
  await page.click('#reopen-cancel'); await page.waitForFunction(() => !document.getElementById('reopen-dlg').open);
  await page.waitForFunction(() => /did not go through/.test(document.getElementById('window-text').textContent));
  assert.match(await noteText(), /The last attempt did not go through: WhatsApp doesn't know this template/);
  assert(await page.locator('#tpl-btn').isVisible()); assert(await page.locator('#text').isDisabled());
  assert(!/Waiting for/.test(await noteText()));
  ok('Meta refuses the template: the error is in plain words, the chat does not say "waiting", and Reopen is offered again');
  const before = graph.length; metaMode = 'ok';
  await page.click('#tpl-btn'); await page.waitForSelector('#reopen-dlg[open]'); await page.click('#reopen-go');
  await page.waitForFunction(() => /Waiting for Brian Byrne/.test(document.getElementById('window-text').textContent));
  assert.equal(graph.length, before + 1);
  ok('trying again once the template works sends it and shows "waiting"');

  // --- Meta says it was never delivered with its "wait 24 hours" answer: counts, and no button ---
  await open(E); await page.waitForSelector('#tpl-btn:not([hidden])');
  await page.click('#tpl-btn'); await page.waitForSelector('#reopen-dlg[open]'); await page.click('#reopen-go');
  await page.waitForFunction(() => /Waiting for Eva Egan/.test(document.getElementById('window-text').textContent));
  const evaWamid = 'wamid.OUT' + gid;
  await status(evaWamid, E, 'failed', [{ code: 131049, title: 'This message was not delivered to maintain healthy ecosystem engagement' }]);
  await page.waitForFunction(() => /could not deliver the template/.test(document.getElementById('window-text').textContent));
  assert.match(await noteText(), /131049.*You can try again after/);
  assert(await page.locator('#tpl-btn').isHidden()); assert(await page.locator('#text').isDisabled());
  ok('a template Meta holds back (131049) is not "waiting": the band says so, the chat stays locked, and Reopen waits for the next day');

  // --- a customer who has never messaged (for example added by phone) ---
  await open(C); await page.waitForSelector('#window-note:not([hidden])');
  assert.match(await noteText(), /^Cara Walsh hasn't messaged yet\. WhatsApp only allows an approved template until they reply\.$/);
  assert(await page.locator('#tpl-btn').isVisible());
  ok('a customer who has never messaged: the band says so and offers Reopen');

  // --- the same request twice, through the real function, sends once ---
  const rq = 'req-e2e-' + Date.now(), g0 = graph.length;
  const both = await Promise.all([callFn('reopenConversation', { phone: G, requestId: rq }), callFn('reopenConversation', { phone: G, requestId: rq })]);
  assert(both.every((r) => r.ok), JSON.stringify(both)); assert.equal(graph.length, g0 + 1);
  const two = await callFn('reopenConversation', { phone: G, requestId: 'req-e2e-other-' + Date.now() });
  assert.equal(two.ok, false); assert.equal(two.code, 'functions/failed-precondition'); assert.equal(graph.length, g0 + 1);
  ok('the same request twice sends once; another request inside 24 hours is refused');

  // --- a phone ---
  const mctx = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true });
  const mp = await mctx.newPage(); mp.on('pageerror', (e) => errors.push('mobile: ' + e.message));
  await mp.goto('http://127.0.0.1:5055/');
  await mp.evaluate((tok) => firebase.auth().signInWithCustomToken(tok), staffToken);
  await mp.waitForSelector('.conv');
  await mp.locator(`.conv[data-phone="${F}"]`).click();
  await mp.waitForSelector('#window-note:not([hidden])');
  const fits = async (sel) => mp.locator(sel).evaluate((e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; });
  assert(await fits('#tpl-btn')); assert(await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await mp.screenshot({ path: path.join(SHOTS, 'reopen-mobile-closed.png') });
  await mp.click('#tpl-btn'); await mp.waitForSelector('#reopen-dlg[open]');
  assert(await fits('#reopen-dlg')); assert(await fits('#reopen-go')); assert(await fits('#reopen-cancel'));
  await mp.screenshot({ path: path.join(SHOTS, 'reopen-mobile-confirm.png') });
  const g1 = graph.length; await mp.click('#reopen-go');
  await mp.waitForFunction(() => /Waiting for Fiona Flynn/.test(document.getElementById('window-text').textContent));
  assert.equal(graph.length, g1 + 1); assert(await fits('#window-note'));
  await mp.screenshot({ path: path.join(SHOTS, 'reopen-mobile-awaiting.png') });
  ok('phone: the band, the confirmation and the "waiting" state fit the screen and work');

  assert.deepEqual(errors, []); ok('no JavaScript errors in the browser');
  console.log(`ALL ${n} CHECKS PASSED`);
  await browser.close(); web.close(); meta.close(); process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
