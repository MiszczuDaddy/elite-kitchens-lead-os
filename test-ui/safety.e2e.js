'use strict';
// Phase 10 browser test: "Needs attention" and "Do not contact", in the real page with the real functions, the emulators and a MOCKED Meta API (no real message is ever sent).
// Every name and number is made up. Run: bash test-ui/run.sh safety.e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const { getAuth } = fnRequire('firebase-admin/auth');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
const A = '353871110081', B = '353871110082';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, msg, t = 20000) { const s = Date.now(); while (Date.now() - s < t) { try { if (await fn()) return; } catch (e) { /* not yet */ } await sleep(120); } throw new Error('timed out waiting for: ' + msg); }
let n = 0; const ok = (m) => console.log(`  PASS ${++n}. ${m}`);

const cfgJs = `firebase.initializeApp({apiKey:'fake',projectId:'demo-leados',authDomain:'localhost',storageBucket:'demo-leados.firebasestorage.app'});
firebase.auth().useEmulator('http://127.0.0.1:9099',{disableWarnings:true});
firebase.firestore().useEmulator('127.0.0.1',8085);
firebase.app().functions('europe-west1').useEmulator('127.0.0.1',5001);
firebase.storage().useEmulator('127.0.0.1',9199);`;
const web = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/__/firebase/init.js') { res.setHeader('content-type', 'text/javascript'); return res.end(cfgJs); }
  const m = /^\/__\/firebase\/[\d.]+\/(.+)$/.exec(u);
  const f = m ? path.join(ROOT, 'node_modules/firebase', m[1]) : path.join(ROOT, 'public', u === '/' ? 'index.html' : u);
  fs.readFile(f, (e, d) => { if (e) { res.statusCode = 404; return res.end('nf'); } res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(f)] || 'application/octet-stream'); res.end(d); });
}).listen(5058);
const graph = [];
const meta = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && /\/111\/messages$/.test(req.url)) { graph.push(JSON.parse(Buffer.concat(chunks).toString() || '{}')); return res.end(JSON.stringify({ messages: [{ id: 'wamid.OUT' + graph.length }] })); }
    res.statusCode = 404; res.end('{}');
  });
}).listen(9911);
meta.keepAliveTimeout = 0;

(async () => {
  initializeApp({ projectId: 'demo-leados' });
  const db = getFirestore();
  const token = await (async () => { const u = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true }); return getAuth().createCustomToken(u.uid); })();
  const now = Date.now(), T = (ms) => Timestamp.fromMillis(ms);
  await db.doc('conversations/' + A).set({ phone: A, name: 'Aisling Allen', createdAt: T(now - 9e8), updatedAt: T(now - 1000), lastMessage: 'Hi', lastInboundAt: T(now - 3600e3), lastMessageDirection: 'in' });
  await db.doc('contacts/' + A).set({ phone: A, name: 'Aisling Allen', createdAt: T(now - 9e8) });
  await db.doc('conversations/' + B).set({ phone: B, name: 'Brendan Burke', createdAt: T(now - 9e8), updatedAt: T(now - 2000), lastMessage: 'How much?', lastInboundAt: T(now - 3600e3),
    receptionist: { on: true, paused: 'handover: price question', notifyFailed: { at: T(now - 300e3), why: 'handover: price question', tries: 3 } } });
  await db.doc('contacts/' + B).set({ phone: B, name: 'Brendan Burke', createdAt: T(now - 9e8) });
  await db.doc('healthIssues/whatsapp_auth').set({ kind: 'whatsapp_auth', title: "WhatsApp is refusing Elite OS's access key", help: 'No WhatsApp message can be sent. Report it straight away.', status: 'open', occurrence: 1, openedAt: T(now - 600e3), lastAt: T(now - 60e3), count: 4, detail: 'code 190', alert: { state: 'sent' } });
  await db.doc('leadIssues/LEAD12345').set({ leadId: 'LEAD12345', reason: 'invalid_phone', reasonText: 'The phone number in the form is missing or is not a valid number.', name: 'Ciaran Coyle', email: 'ciaran@example.com', phoneTyped: '087 12', location: 'Lucan', formName: 'Kitchen form', receivedAt: T(now - 7200e3), attempts: 1, status: 'open', alert: { state: 'sent' } });
  await db.doc('health/heartbeats').set({ healthSweepAt: T(now - 180e3) });
  await db.doc('health/backup').set({ lastDrillAt: T(now - 86400e3), ok: true, backupTime: '2026-10-17T02:00:00Z', totals: { live: 10, restored: 9 } });

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());                                                     // the browser's own "Dismiss this lead?" confirmation
  console.log('E2E: Needs attention and Do not contact: real page + real functions + emulators + mocked Meta');
  await page.goto('http://127.0.0.1:5058/');
  await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await page.waitForSelector('#app:not([hidden])'); await page.evaluate(() => { if (location.hash === '#today') location.hash = ''; });

  // ------------------------------------------------------------ 1. the bar
  await page.waitForSelector('#attn-bar:not([hidden])');
  assert.equal((await page.innerText('#attn-open')).replace(/\s+/g, ' ').trim(), '3 things need attention');
  await page.waitForSelector(`.conv[data-phone="${B}"] .conv-alert`);
  ok('the Inbox shows "3 things need attention", and the chat whose alert failed is marked in the list');

  // ------------------------------------------------------------ 2. the list
  await page.click('#attn-open'); await page.waitForSelector('#attn-dlg[open]');
  const txt = (await page.innerText('#attn-dlg')).replace(/\s+/g, ' ');
  assert.match(txt, /Problems WhatsApp is refusing Elite OS's access key No WhatsApp message can be sent/); assert.match(txt, /seen 4 times · code 190/);
  assert.match(txt, /Alerts that did not reach your phone Brendan Burke/); assert.match(txt, /Why: handover: price question/);
  assert.match(txt, /Meta leads that could not be added Ciaran Coyle/); assert.match(txt, /Number as typed: 087 12 · Email: ciaran@example\.com · Area: Lucan/);
  assert.match(txt, /Elite OS checked itself 3 minutes ago/); assert.match(txt, /last restore test .* OK/);
  assert.equal(await page.inputValue('#attn-hours'), '168');
  await page.screenshot({ path: path.join(SHOTS, 'safety-attention.png') });
  ok('the list shows the problem with what to do, the failed alert with the reason, the rejected lead with its details, the last check and the last restore test');

  // ------------------------------------------------------------ 3. the buttons
  await page.locator('#attn-problems-list button', { hasText: 'Mark as fixed' }).click();
  await until(async () => (await db.doc('healthIssues/whatsapp_auth').get()).data().status === 'resolved', 'the problem closed');
  await page.waitForSelector('#attn-problems', { state: 'hidden' });
  await page.locator('#attn-alerts-list button', { hasText: 'Seen' }).click();
  await until(async () => !(await db.doc('conversations/' + B).get()).data().receptionist.notifyFailed, 'the alert cleared');
  await page.waitForSelector('#attn-alerts', { state: 'hidden' });
  ok('"Mark as fixed" closes the problem and "Seen" clears the failed alert, through the server; the list updates by itself');

  await page.fill('#attn-hours', '24'); await page.click('#attn-save');
  await until(async () => ((await db.doc('healthSettings/current').get()).data() || {}).leadSilenceHours === 24, 'the setting saved');
  const setMsg = async () => (await page.innerText('#attn-set-msg')) + ' | err: ' + (await page.innerText('#attn-err'));
  await until(async () => /after 24 hours/.test(await setMsg()), 'the saved message (now: ' + (await setMsg()) + ')');
  await page.fill('#attn-hours', '9999'); await page.click('#attn-save'); await sleep(800);
  assert.equal(await page.evaluate(() => document.getElementById('attn-hours').validity.rangeOverflow), true, 'the browser itself refuses more than 720');
  assert.equal((await db.doc('healthSettings/current').get()).data().leadSilenceHours, 24, 'nothing was saved');
  ok('the lead warning can be changed (24 hours saved, with a plain confirmation); a value above 720 is refused and nothing is saved');

  // ------------------------------------------------------------ 4. a rejected lead becomes a customer
  await page.locator('#attn-leads-list button', { hasText: 'Add as customer' }).click();
  await page.waitForSelector('#cust-dlg[open]');
  assert.deepEqual(await page.evaluate(() => ['c-phone', 'c-name', 'c-email', 'c-location', 'c-source'].map((id) => document.getElementById(id).value)), ['087 12', 'Ciaran Coyle', 'ciaran@example.com', 'Lucan', 'Meta Ads']);
  await page.fill('#c-phone', '087 123 4567'); await page.click('#c-go');
  await page.waitForFunction(() => location.hash === '#c/353871234567');
  await until(async () => (await db.doc('leadIssues/LEAD12345').get()).data().status === 'added', 'the lead closed');
  const li = (await db.doc('leadIssues/LEAD12345').get()).data(); assert.deepEqual([li.name, li.email, li.phoneTyped], [null, null, null]);
  await page.waitForSelector('#attn-bar', { state: 'hidden' });
  ok('"Add as customer" opens the usual form already filled in; with the number corrected the customer is added, the chat opens, the lead closes and its details are erased; the bar goes away');

  // ------------------------------------------------------------ 5. do not contact
  await page.click(`.conv[data-phone="${A}"]`); await page.waitForFunction((p) => location.hash === '#c/' + p, A);
  if (await page.locator('#details').isHidden()) await page.click('#details-btn');
  assert.equal(await page.innerText('#dnc-state'), 'Messages to this customer are allowed.');
  assert(await page.locator('#text').isEnabled());
  await page.click('#dnc-btn'); await page.waitForSelector('#dnc-dlg[open]');
  assert.match(await page.innerText('#dnc-hint'), /will get no more messages, files, templates or quotes/);
  await page.fill('#dnc-note-in', 'asked on the phone'); await page.click('#dnc-go');
  await page.waitForSelector('#dnc-note:not([hidden])');
  assert.match(await page.innerText('#dnc-text'), /Marked "do not contact" by staff@test\.dev .*: asked on the phone\. Messages, files, templates and quotes to them are blocked\./);
  assert(await page.locator('#text').isDisabled()); assert(await page.locator('#send').isDisabled()); assert(await page.locator('#attach-btn').isDisabled());
  assert.equal(await page.getAttribute('#text', 'placeholder'), 'This customer asked not to be contacted');
  await page.waitForSelector(`.conv[data-phone="${A}"] .conv-dnc`);
  assert.equal((await db.doc('conversations/' + A).get()).data().doNotContact.note, 'asked on the phone');
  await page.screenshot({ path: path.join(SHOTS, 'safety-dnc.png') });
  ok('"Do not contact…" with a note: the chat says who set it and why, the message box and attachments are switched off, the list shows the tag');

  const sent = await page.evaluate(async (p) => { try { await firebase.app().functions('europe-west1').httpsCallable('sendReply')({ phone: p, body: 'test', requestId: 'e2e-dnc-123456' }); return 'sent'; } catch (e) { return e.message; } }, A);
  assert.match(sent, /asked not to be contacted/); assert.equal(graph.length, 0);
  ok('a send that gets round the screen is refused by the server, and nothing reaches WhatsApp');

  await page.click('#dnc-allow'); await page.waitForSelector('#dnc-dlg[open]');
  assert.match(await page.innerText('#dnc-hint'), /Only do this if/); assert(await page.locator('#dnc-note-label').isHidden());
  await page.click('#dnc-go');
  await page.waitForSelector('#dnc-note', { state: 'hidden' });
  assert(await page.locator('#text').isEnabled());
  await page.fill('#text', 'Hi Aisling'); await page.click('#send');
  await until(() => graph.length === 1, 'the message went'); assert.equal(graph[0].to, A);
  ok('"Allow contact again" (after a clear warning) switches the message box back on, and a message goes out again');

  // ------------------------------------------------------------ 6. always reachable, and on a phone
  await page.evaluate(() => document.getElementById('notif-health').click()); await page.waitForSelector('#attn-dlg[open]');
  assert.match(await page.innerText('#attn-summary'), /All clear/); await page.click('#attn-close');
  ok('Notifications > System health and backups opens the same list, which says "All clear"');
  await db.doc('healthIssues/lead_silence').set({ kind: 'lead_silence', title: 'No Meta leads have arrived for a while', help: 'Check Make.', status: 'open', occurrence: 1, openedAt: T(now), lastAt: T(now), count: 1 });
  await db.doc('conversations/' + A).update({ doNotContact: { on: true, by: 'customer', source: 'customer', at: T(now), note: 'The customer asked us to stop messaging them.' } });
  const mp = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  mp.on('pageerror', (e) => errors.push(e.message));
  await mp.goto('http://127.0.0.1:5058/'); await mp.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await mp.waitForSelector('#app:not([hidden])'); await mp.evaluate(() => { if (location.hash === '#today') location.hash = ''; });
  await mp.waitForSelector('#attn-bar:not([hidden])');
  assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await mp.screenshot({ path: path.join(SHOTS, 'safety-mobile-bar.png') });
  await mp.click(`.conv[data-phone="${A}"]`); await mp.waitForSelector('#dnc-note:not([hidden])');
  assert.match(await mp.innerText('#dnc-text'), /^The customer asked us to stop messaging them/);
  assert.equal(await mp.evaluate(() => { const r = document.getElementById('dnc-allow').getBoundingClientRect(); return r.right <= innerWidth && r.width > 0; }), true);
  await mp.screenshot({ path: path.join(SHOTS, 'safety-mobile-dnc.png') });
  ok('on a phone: the bar fits, and the do-not-contact note (set by the customer\'s own words) and its button fit the screen');

  assert.deepEqual(errors, []); ok('no JavaScript errors in the browser');
  console.log(`ALL ${n} CHECKS PASSED`);
  await browser.close(); web.close(); meta.close(); process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
