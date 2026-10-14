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
  const PID = 'p_abcdef0123456789abcdef01', stepsOf = (done) => Object.fromEntries(['designApproved', 'carcassesOrdered', 'doorsOrdered', 'readyForInstall', 'installed'].map((k) => [k, { done: !!done[k], at: null, by: null }]));
  await db.doc('projects/' + PID).set({ phone: ph.anna, customerName: 'Anna Apple', quoteId: null, quoteRef: null, status: 'active', rev: 1, steps: stepsOf({ designApproved: true }), installDate: null, notes: 'Site visit done', history: [], render: null, createdAt: ago(2) });
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
  // ------------------------------------------------------------------ 3d. AI actions (9.2a): off by default; the owner switches them on; a note is prepared, shown exactly, and saved only on Approve
  await page.evaluate((id) => { location.hash = '#c/' + id; }, ph.anna); await page.waitForSelector('#thread:not([hidden])');
  await page.click('#nav-assistant'); await page.waitForSelector('#assistant', { state: 'visible' });
  await ask('note: call after 5pm');
  assert.equal(await page.locator('.as-card').count(), 0, 'with AI actions off nothing is prepared');
  await page.click('#as-settings'); await page.waitForSelector('#as-dlg[open]'); await page.waitForFunction(() => /this month/.test(document.getElementById('as-set-spent').textContent));
  assert.equal(await page.locator('#as-set-actions').isDisabled(), false); assert.equal(await page.locator('#as-set-actions').isChecked(), false);
  await page.check('#as-set-actions'); await page.check('#as-set-kind-customerNote'); await page.check('#as-set-kind-projectUpdate'); await page.click('#as-set-save'); await page.waitForFunction(() => !document.getElementById('as-dlg').open);
  const act = (await settingsDoc().get()).data(); assert.equal(act.actionsEnabled, true); assert.deepEqual(act.actionKinds, { customerNote: true, projectUpdate: true });
  for (const d of (await db.collection('aiRate').get()).docs) await d.ref.delete();
  const notesNow = async () => ((await db.doc('contacts/' + ph.anna).get()).data() || {}).notes || null;
  await ask('note: call after 5pm');
  await page.waitForSelector('#as-tray .as-card[data-state=pending]');
  assert.match(await page.locator('#as-tray').innerText(), /Add a note to Anna Apple[\s\S]*\+ \d+ \w+ \d{4}: call after 5pm[\s\S]*Approve[\s\S]*Reject/);
  assert.equal(await notesNow(), null, 'nothing is saved before Approve');
  await page.click('#as-tray button:has-text("Approve")'); await page.waitForSelector('.as-card[data-state=applied]'); await page.waitForSelector('#as-tray', { state: 'hidden' });
  assert.match(await page.locator('.as-card[data-state=applied]').innerText(), /Done: The note was added/); assert.match(await notesNow(), /call after 5pm$/);
  assert.equal(await page.locator('.as-card[data-state=applied] button').count(), 0, 'a decided card has no buttons');
  await ask('note: not wanted');
  await page.waitForSelector('#as-tray .as-card[data-state=pending]'); await page.click('#as-tray button:has-text("Reject")'); await page.waitForSelector('.as-card[data-state=rejected]');
  assert.doesNotMatch(await notesNow(), /not wanted/);
  assert.deepEqual((await db.collection('auditLog').where('action', '==', 'aiProposal').get()).docs.map((d) => d.data().event).sort(), ['applied', 'created', 'created', 'rejected']);
  ok('AI actions: off by default; the owner switches them on; a note is shown exactly as a preview, saved only on Approve, never on Reject; audited');
  for (const d of (await db.collection('aiRate').get()).docs) await d.ref.delete();
  // the project card: opened from the project screen, shown in full, buttons visible without scrolling, applied through the real project functions
  await page.evaluate((id) => { location.hash = '#projects/' + id; }, PID); await page.waitForSelector('#pj-project-view:not([hidden]) .pjv-name');
  await page.click('#nav-assistant'); await page.waitForSelector('#assistant', { state: 'visible' });
  await ask('project: doors ordered from Nolan');
  await page.waitForSelector('#as-tray .as-card[data-state=pending]');
  const cardText = await page.locator('#as-tray .as-card[data-state=pending]').last().innerText();
  assert.match(cardText, /Update the project of Anna Apple/); assert.match(cardText, /Doors ordered[\s\S]*Before: Not done[\s\S]*After: Done/i); assert.match(cardText, /Installation date[\s\S]*Before: not set[\s\S]*After: 20 Nov 2026/i); assert.match(cardText, /Project notes[\s\S]*Site visit done[\s\S]*\+ .*doors ordered from Nolan/i);
  const approve = page.locator('#as-tray button:has-text("Approve")');
  const where = await approve.evaluate((b) => { const r = b.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: window.innerHeight }; });
  assert.ok(where.top >= 0 && where.bottom <= where.height, 'the Approve button is on screen without scrolling: ' + JSON.stringify(where));
  await page.screenshot({ path: path.join(SHOTS, 'assistant-project-card.png') });
  assert.equal((await db.doc('projects/' + PID).get()).data().installDate, null, 'nothing saved before Approve');
  await approve.click(); await page.waitForSelector('#as-msgs .as-card[data-state=applied]:has-text("The changes were saved")');
  const proj = (await db.doc('projects/' + PID).get()).data();
  assert.equal(proj.steps.doorsOrdered.done, true); assert.equal(proj.installDate, '2026-11-20'); assert.match(proj.notes, /^Site visit done\n.*doors ordered from Nolan$/); assert.equal(proj.steps.doorsOrdered.by, 'staff@test.dev');
  assert.match(await page.locator('.as-card[data-state=applied]').last().innerText(), /Done: The changes were saved/);
  ok('the project card shows every change as Before → After, its buttons are on screen, and Approve saves it through the project functions');

  // ---- a waiting proposal can never be lost: refresh, a cleared chat, leaving and coming back; a repeated request shows the same one; expired and missing ones are explained and can be asked again
  const resetRate = async () => { for (const d of (await db.collection('aiRate').get()).docs) await d.ref.delete(); };
  const pendingDocs = async () => (await db.collection('aiProposals').where('status', '==', 'pending').get()).docs;
  await resetRate(); await ask('project: second change');
  await page.waitForSelector('#as-tray .as-card[data-state=pending]');
  assert.equal((await pendingDocs()).length, 1, 'the proposal exists in Firestore'); const waitingId = (await pendingDocs())[0].id;
  await page.reload(); await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])');
  await page.waitForSelector('#as-tray .as-card[data-state=pending]'); assert.match(await page.locator('#as-tray').innerText(), /second change/); assert.equal(await page.locator('#as-tray button:has-text("Approve")').isVisible(), true, 'after a refresh');
  await page.click('#as-new'); assert.equal(await page.locator('#as-msgs .as-msg').count(), 0);
  assert.equal(await page.locator('#as-tray button:has-text("Approve")').isVisible(), true, 'after the chat was cleared');
  await page.evaluate(() => { location.hash = ''; }); await page.waitForSelector('#assistant', { state: 'hidden' }); await page.evaluate(() => { location.hash = '#assistant'; }); await page.waitForSelector('#assistant', { state: 'visible' });
  await page.waitForSelector('#as-tray .as-card[data-state=pending]'); assert.equal(await page.locator('#as-tray button:has-text("Reject")').isVisible(), true, 'after leaving the Assistant and coming back');
  await resetRate(); await ask('project: second change');
  assert.match(await answers().last().innerText(), /Already waiting for your approval/); assert.equal((await pendingDocs()).length, 1, 'the same change is not prepared twice'); assert.equal(await page.locator('#as-tray .as-card').count(), 1);
  assert.match(await page.locator('#as-msgs .as-card').last().innerText(), /Waiting for your approval/, 'the answer points at the one card below');
  await db.doc('aiProposals/' + waitingId).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
  await page.waitForSelector('#as-tray', { state: 'hidden' });
  assert.match(await page.locator('#as-msgs .as-card').last().innerText(), /Expired: nothing was changed/);
  await resetRate(); await ask('project: second change'); await page.waitForSelector('#as-tray .as-card[data-state=pending]');
  const fresh = (await pendingDocs()); assert.equal(fresh.length, 1); assert.notEqual(fresh[0].id, waitingId, 'a new proposal after the old one expired');
  await db.doc('aiProposals/' + fresh[0].id).delete();
  await page.waitForSelector('#as-tray', { state: 'hidden' });
  assert.match(await page.locator('#as-msgs .as-card').last().innerText(), /no longer exists[\s\S]*No longer available/);
  ok('a waiting proposal survives a refresh, a cleared chat and leaving the Assistant; a repeat shows the same card; expired or missing ones are explained and a new one can be made');
  await resetRate();

  // ------------------------------------------------------------------ R1: "Suggest reply" in a WhatsApp chat: off until the owner switches it on; a draft with what is known and missing; nothing is sent
  await page.evaluate((id) => { location.hash = '#c/' + id; }, ph.anna); await page.waitForSelector('#thread:not([hidden])');
  assert.equal(await page.locator('#reply-btn').isVisible(), false, 'no button while reply suggestions are off');
  await page.evaluate(() => { location.hash = '#assistant'; }); await page.waitForSelector('#assistant', { state: 'visible' });
  await page.click('#as-settings'); await page.waitForSelector('#as-dlg[open]'); await page.waitForFunction(() => /this month/.test(document.getElementById('as-set-spent').textContent));
  assert.equal(await page.locator('#as-set-reply').isDisabled(), false); await page.check('#as-set-reply'); await page.click('#as-set-save'); await page.waitForFunction(() => !document.getElementById('as-dlg').open);
  assert.equal((await settingsDoc().get()).data().replyAssistant, true);
  const say = (body, dir = 'in') => db.collection(`conversations/${ph.anna}/messages`).add({ direction: dir, type: 'text', body, createdAt: Timestamp.now() });
  await say("Hi, I'd like a consultation for a new kitchen. Tuesday afternoon would suit me."); await db.doc('conversations/' + ph.anna).update({ lastInboundAt: Timestamp.now(), lastMessageDirection: 'in' });
  await page.evaluate((id) => { REPLY.checkedAt = 0; location.hash = '#c/' + id; }, ph.anna); await page.waitForSelector('#reply-btn', { state: 'visible' });
  const msgCount = async () => (await db.collection(`conversations/${ph.anna}/messages`).get()).size, sentBefore = await msgCount();
  await page.click('#reply-btn'); await page.waitForSelector('#reply-panel:not([hidden]) .reply-draft');
  const panel = await page.locator('#reply-panel').innerText();
  assert.match(panel, /Suggested reply/); assert.match(panel, /Wants a consultation: details still needed/); assert.match(panel, /Could you send me your Eircode/); assert.match(panel, /Sonnet/, 'replies use Sonnet by default');
  assert.match(panel, /Known[\s\S]*Name: Anna Apple/); assert.match(panel, /From the chat \(not saved yet\)[\s\S]*Preferred time: Tuesday afternoon/); assert.match(panel, /Still needed[\s\S]*Project[\s\S]*Home address or Eircode/); assert.doesNotMatch(panel, /already in the records/, 'asking for the Eircode is right: it is not recorded');
  assert.equal(await page.inputValue('#text'), '', 'the draft is not put in the message box until you choose');
  await page.click('#reply-panel >> text=Use this reply'); assert.match(await page.inputValue('#text'), /^Lovely, we would be glad to call out/);
  assert.equal(await msgCount(), sentBefore, 'nothing was sent');
  await page.screenshot({ path: path.join(SHOTS, 'assistant-reply-suggestion.png') });
  await page.click('#reply-panel >> text=Try Haiku'); await page.waitForFunction(() => /Haiku/.test(document.getElementById('reply-panel').innerText));
  let drafts = []; for (let i = 0; i < 40; i++) { drafts = (await db.collection('aiDrafts').get()).docs.map((d) => d.data()); if (drafts.length === 2 && drafts.some((d) => d.outcome === 'discarded')) break; await page.waitForTimeout(150); }
  assert.equal(drafts.length, 2); assert.deepEqual(drafts.map((d) => d.model).sort(), ['haiku', 'sonnet']);
  assert.equal(drafts.find((d) => d.model === 'sonnet').outcome, 'discarded', 'the first draft was replaced without being sent'); assert.equal(JSON.stringify(drafts).includes('Eircode'), false, 'no words are stored');
  await say('This is a complaint, I am angry about the last visit.'); await db.doc('conversations/' + ph.anna).update({ lastInboundAt: Timestamp.now() });
  await page.click('#reply-panel .reply-x'); await page.click('#reply-btn'); await page.waitForSelector('#reply-panel .reply-handover');
  assert.match(await page.locator('#reply-panel').innerText(), /Hand over to you[\s\S]*Hand over to you: upset customer/); assert.equal(await page.locator('#reply-panel .reply-draft').count(), 0, 'no reply is drafted for a complaint');
  await page.click('#reply-panel .reply-x'); assert.equal(await page.locator('#reply-panel').isVisible(), false);
  assert.equal(await msgCount(), sentBefore + 1, 'only the customer\'s new message was added: the assistant sent nothing');
  ok('Reply suggestions: hidden until the owner switches them on; a draft with what is known, what is missing and readiness; nothing sent; "Try Haiku"; a complaint is handed over; outcomes recorded without words');
  await page.evaluate(() => { location.hash = '#assistant'; }); await page.waitForSelector('#assistant', { state: 'visible' });
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
  await ask('summary');
  assert.equal(chatBodies.at(-1).message, 'summary');
  const sum = await answers().last().innerText();
  assert.match(sum, /Aoife Apple|Anna Apple/); assert.match(sum, /Budget: not recorded/); assert.match(sum, /Latest quote: none yet/); assert.match(sum, /Next appointment: none scheduled/);
  assert.equal(await page.locator('#as-msgs .as-msg.assistant').last().locator('strong').count(), 1, 'the name is bold'); assert.equal(await page.locator('#as-msgs .as-msg.assistant').last().locator('li').count(), 6, 'five fields plus the Notes line, which now holds the approved note'); assert.match(sum, /Notes: .*call after 5pm/);
  assert.match(await page.locator('.as-trace').last().innerText(), /No AI used/); assert.equal(await page.locator('.as-retry').count(), 0, 'nothing to retry on an instant summary');
  await page.click('#as-context-x'); assert.equal(await page.locator('#as-context').isVisible(), false);
  await ask('who are you again');
  assert.equal(chatBodies.at(-1).context, undefined);
  assert.equal(chatBodies.at(-1).history.length, 4); assert.deepEqual(chatBodies.at(-1).history.map((t) => t.role), ['user', 'assistant', 'user', 'assistant']);
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
