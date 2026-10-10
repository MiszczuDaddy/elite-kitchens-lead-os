'use strict';
// Audit findings 2, 6, 10, 11 and 14, and the second audit's findings 2 (listener ordering) and 3 (a resumed send for another address), on the real screen
// (docs/PHASE6_1_PLAN.md, "Audit"): recovery after a dropped connection (the controls come back,
// and the SAME request is continued), a channel left waiting can be sent now and a stalled one turns into "not confirmed" by itself, and any
// sent version can be sent again. Real page + real functions + emulators + MOCKED Meta and Gmail (nothing real is sent). Written first: it
// failed on the screen as it was. Run: bash test-ui/run.sh quote-recovery.e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getAuth } = fnRequire('firebase-admin/auth');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const { getStorage } = fnRequire('firebase-admin/storage');
const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, msg, t = 30000) { const s = Date.now(); while (Date.now() - s < t) { if (await fn()) return; await sleep(150); } throw new Error('timed out waiting for: ' + msg); }
let n = 0; const ok = (m) => console.log(`  PASS ${++n}. ${m}`);

const cfgJs = `firebase.initializeApp({apiKey:'fake',projectId:'demo-leados',authDomain:'localhost',storageBucket:'demo-leados.firebasestorage.app'});
firebase.auth().useEmulator('http://127.0.0.1:9099',{disableWarnings:true});
firebase.firestore().useEmulator('127.0.0.1',8085);
firebase.app().functions('europe-west1').useEmulator('127.0.0.1',5001);
firebase.storage().useEmulator('127.0.0.1',9199);`;
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.woff2': 'font/woff2' };
const web = http.createServer((req, res) => {
  const u = req.url.split('?')[0]; let f;
  if (u === '/__/firebase/init.js') { res.setHeader('content-type', 'text/javascript'); return res.end(cfgJs); }
  const m = /^\/__\/firebase\/[\d.]+\/(.+)$/.exec(u);
  f = m ? path.join(ROOT, 'node_modules/firebase', m[1]) : path.join(ROOT, 'public', u === '/' ? 'index.html' : u);
  fs.readFile(f, (e, d) => { if (e) { res.statusCode = 404; return res.end('nf'); } res.setHeader('content-type', TYPES[path.extname(f)] || 'application/octet-stream'); res.end(d); });
}).listen(5055);

// ---- mocked Meta (the uploaded file and the message are kept) and Gmail (a send is counted) ----
const state = { mode: 'ok', media: [], messages: [], mails: 0, mailTo: [], mailMode: 'ok' }; let gid = 0;
function filePart(buf, contentType) {
  const boundary = '--' + /boundary=(.+)$/.exec(contentType || '')[1], s = buf.toString('latin1');
  for (const part of s.split(boundary)) {
    const i = part.indexOf('\r\n\r\n'); if (i < 0 || !/filename="/.test(part.slice(0, i))) continue;
    return { name: /filename="([^"]*)"/.exec(part.slice(0, i))[1], bytes: Buffer.from(part.slice(i + 4, part.length - 2), 'latin1') };
  }
  return null;
}
const meta = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    const buf = Buffer.concat(chunks), json = (o, st = 200) => { res.statusCode = st; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.method === 'POST' && /\/111\/media$/.test(req.url)) { state.media.push(filePart(buf, req.headers['content-type'])); return json({ id: 'UPMEDIA' + state.media.length }); }
    if (req.method === 'POST' && /\/111\/messages$/.test(req.url)) {
      state.messages.push(JSON.parse(buf.toString() || '{}'));
      return state.mode === 'refuse' ? json({ error: { code: 131026, message: 'Message undeliverable' } }, 400) : json({ messages: [{ id: 'wamid.OUT' + ++gid }] });
    }
    json({ error: { message: 'unexpected' } }, 404);
  });
}).listen(9911); meta.keepAliveTimeout = 0;
const gmail = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    const json = (o, st = 200) => { res.statusCode = st; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.method === 'POST' && /\/gmail\/v1\/users\/me\/messages\/send$/.test(req.url)) {
      if (state.mailMode === 'refuse') return json({ error: { message: 'forbidden' } }, 403);
      try { const raw = Buffer.from(JSON.parse(Buffer.concat(chunks).toString()).raw, 'base64url').toString('utf8'); const m = /^To:\s*.*?([\w.+-]+@[\w.-]+)/mi.exec(raw); state.mailTo.push(m ? m[1] : null); } catch (e) { state.mailTo.push(null); }      // WHO the email went to
      state.mails++; return json({ id: 'gmsg-' + ++gid, threadId: 'thr' });
    }
    json({ error: { message: 'unexpected' } }, 404);
  });
}).listen(9913); gmail.keepAliveTimeout = 0;

const H = 3600e3;
const ph = { anna: '353860000051', brian: '353860000052', cara: '353860000053', dan: '353860000054', eve: '353860000055' };
const SETTINGS = { vatRate: 13.5, validityDays: 30,
  business: { tradingName: 'Elite Kitchens', signatureName: 'Test Signer', phone: '01 000 0000', email: 'quotes@example.com', web: 'www.example.com', address: 'Test Street, Dublin', vatNumber: 'IE0000000X' },
  priceList: { options: { ess: { perDoor: 313.37, perTopBox: 171.17 }, prem: { perDoor: 323.41, perTopBox: 181.19 }, pp: { perDoor: 333.53, perTopBox: 191.29 } },
    drawerBoxes: { cemux: 19.19, blum: 29.29 }, glazing: { small: 43.43, large: 91.91 }, extras: [] } };

(async () => {
  initializeApp({ projectId: 'demo-leados', storageBucket: 'demo-leados.firebasestorage.app' });
  const db = getFirestore(), bucket = getStorage().bucket();
  const t0 = Date.now();
  for (const [id, name, email] of [[ph.anna, 'Anna Murphy', 'anna@example.com'], [ph.brian, 'Brian Byrne', 'brian@example.com'], [ph.cara, 'Cara Walsh', 'cara@example.com'], [ph.dan, 'Dan Doyle', 'dan@example.com'], [ph.eve, 'Eve Egan', 'eve@example.com']]) {
    await db.doc('conversations/' + id).set({ phone: id, name, createdAt: Timestamp.fromMillis(t0 - 10 * H), updatedAt: Timestamp.fromMillis(t0 - 1 * H), lastMessage: 'Hi', unreadCount: 0, lastInboundAt: Timestamp.fromMillis(t0 - 2 * H) });
    await db.doc('contacts/' + id).set({ phone: id, name, email, address: '1 Main Street, Swords', location: 'Swords', createdAt: Timestamp.fromMillis(t0 - 10 * H) });
  }
  const quote = async (id) => (await db.doc('quotes/' + id).get()).data();
  const deliveries = async (id) => (await db.collection(`quotes/${id}/deliveries`).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const storedPdf = async (id, v) => (await bucket.file((await db.doc(`quotes/${id}/versions/${v}`).get()).data().pdf.path).download())[0];

  const u = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true });
  const token = await getAuth().createCustomToken(u.uid);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage(); global.__page = page;
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource|net::ERR|FetchError|functions\/(internal|unavailable)/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  const sentRequests = [];                                                  // every deliverQuote call the screen makes: its request id
  page.on('request', (r) => { if (r.method() === 'POST' && /\/deliverQuote$/.test(r.url())) { try { sentRequests.push(JSON.parse(r.postData()).data); } catch (e) { /* not json */ } } });

  console.log('QUOTE RECOVERY E2E: real page + real functions + emulators + mocked Meta and Gmail');
  await page.goto('http://127.0.0.1:5055/');
  await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await page.waitForSelector('#app:not([hidden])');
  await page.evaluate(() => { window.open = () => null; });
  await page.evaluate(async (s) => { const f = firebase.app().functions('europe-west1'); await f.httpsCallable('saveQuoteSettings')(s); await f.httpsCallable('setQuoteNumbering')({ next: 34 }); }, SETTINGS);

  const makeQuote = (phone) => page.evaluate(async (p) => {
    const f = firebase.app().functions('europe-west1'), s = (await firebase.firestore().doc('quoteSettings/current').get()).data();
    const a = QuoteEngine.current().newAnswers(s.priceList); a.doors = 10; a.drawers = 4; a.options.ess.drawerBox = 'cemux'; a.options.prem = { ...a.options.prem, on: true, drawerBox: 'blum' };
    return (await f.httpsCallable('createQuote')({ phone: p, requestId: crypto.randomUUID(), answers: a })).data.id;
  }, phone);
  const openQuote = async (id) => { await page.evaluate((i) => { location.hash = '#quotes/' + i; }, id); await page.waitForFunction((i) => location.hash === '#quotes/' + i, id); await page.waitForSelector('#q-quote-view .qv'); };
  const readyDialog = async () => { await page.waitForSelector('#qsend-dlg[open]'); await page.waitForFunction(() => !/Checking/.test(document.getElementById('qsend-em-state').textContent) && document.getElementById('qsend-wa-state').textContent.length > 0); };
  const openSend = async (id, button = '#qv-send') => { await openQuote(id); await page.waitForSelector(button + ':not([disabled])'); await page.click(button); await readyDialog(); };
  const results = async () => { await page.waitForSelector('#qsend-results:not([hidden])', { timeout: 90000 }); };
  const closeResults = async () => { await page.click('#qsend-res-close'); await page.waitForFunction(() => !document.getElementById('qsend-dlg').open); };

  // ---- a sent quote with two versions (v1 by WhatsApp, v2 by WhatsApp), used by the first two checks ----
  const anna = await makeQuote(ph.anna);
  await openSend(anna); await page.click('#qsend-send'); await results();
  await page.waitForFunction(() => document.querySelector('#qsend-res-list li[data-channel="whatsapp"][data-state="sent"]')); await closeResults();
  await page.click('#qv-revise'); await page.waitForSelector('#qv-send:not([disabled])');
  await page.click('#qv-send'); await readyDialog(); await page.fill('#qsend-value', ''); await page.click('#qsend-send'); await results();
  await page.waitForFunction(() => document.querySelector('#qsend-res-list li[data-channel="whatsapp"][data-state="sent"]')); await closeResults();
  assert.equal((await quote(anna)).sentVersion, 2);

  // ================================================== audit 10: a dropped connection leaves the screen usable ===========================
  await openSend(anna, '#qv-resend');                                        // "Send this version…" (v2) by email
  await page.uncheck('#qsend-wa'); await page.check('#qsend-em');
  const before = sentRequests.length, mails0 = state.mails;
  await page.route('**/deliverQuote', (route) => route.abort('failed'));     // the connection drops: the call never gets an answer
  await page.click('#qsend-send');
  await page.waitForFunction(() => /connection dropped/i.test(document.getElementById('qsend-err').textContent));
  assert.equal(await page.isDisabled('#qsend-send'), false, 'after a dropped connection "Send quote" is still disabled, although the message says to press it again');
  assert.equal(await page.isDisabled('#qsend-em'), false); assert.equal(await page.isDisabled('#qsend-wa'), false);
  const firstId = sentRequests[before].requestId;
  await page.unroute('**/deliverQuote');
  await page.click('#qsend-send'); await results();                          // press it again, as the message says
  assert.equal(sentRequests[before + 1].requestId, firstId, 'pressing Send again must continue the SAME request');
  await page.waitForFunction(() => document.querySelector('#qsend-res-list li[data-channel="email"][data-state="sent"]'));
  assert.equal(state.mails, mails0 + 1); await closeResults();
  ok('after a dropped connection the dialog is usable again (Send and the channel boxes are enabled), and pressing Send again continues the same request: one email, no duplicates');

  // the dialog closed and reopened after a dropped connection: still the same request
  await openSend(anna, '#qv-resend'); await page.uncheck('#qsend-wa'); await page.check('#qsend-em');
  const b2 = sentRequests.length;
  await page.route('**/deliverQuote', (route) => route.abort('failed'));
  await page.click('#qsend-send'); await page.waitForFunction(() => /connection dropped/i.test(document.getElementById('qsend-err').textContent));
  const id2 = sentRequests[b2].requestId; await page.unroute('**/deliverQuote');
  await page.click('#qsend-cancel'); await page.waitForFunction(() => !document.getElementById('qsend-dlg').open);
  await page.click('#qv-resend'); await readyDialog(); await page.uncheck('#qsend-wa'); await page.check('#qsend-em');
  await page.click('#qsend-send'); await results();
  assert.equal(sentRequests[b2 + 1].requestId, id2, 'a reopened resend dialog started a NEW request instead of continuing the interrupted one');
  await closeResults();
  ok('closing and reopening the resend dialog after a dropped connection continues the interrupted request instead of starting a new one');

  // ================================================== audit 14: any sent version can be sent again ======================================
  await openQuote(anna);
  const buttons = await page.locator('.qv-versions button[data-version]').evaluateAll((els) => els.map((e) => [e.dataset.version, e.textContent]));
  assert.deepEqual(buttons.map((b) => b[0]).sort(), ['1', '2']); assert.ok(buttons.every((b) => /Send/.test(b[1])));
  const m0 = state.media.length;
  await page.click('.qv-versions button[data-version="1"]'); await readyDialog();
  assert.match(await page.textContent('#qsend-title'), /v1 to the customer$/);
  await page.click('#qsend-send'); await results();                                     // WhatsApp is ticked by default
  await page.waitForFunction(() => document.querySelector('#qsend-res-list li[data-channel="whatsapp"][data-state="sent"]'));
  assert.equal(state.media.length, m0 + 1);
  assert.ok(state.media.at(-1).bytes.equals(await storedPdf(anna, 1)), 'v1 was sent, so the PDF Meta received must be v1\'s');
  assert.ok(!state.media.at(-1).bytes.equals(await storedPdf(anna, 2)));
  assert.match(state.media.at(-1).name, /-v1\.pdf$/);
  assert.equal((await quote(anna)).sentVersion, 2);                                       // sending v1 again changes nothing about the quote
  await closeResults();
  ok('every row under Sent versions has its own "Send…": v1 can be sent after v2, with its own PDF, and the quote itself is untouched');

  // ================================================== audit 11: a channel left waiting, and a stalled one ================================
  const brian = await makeQuote(ph.brian);
  state.mode = 'refuse'; state.mailMode = 'refuse';
  await openSend(brian); await page.check('#qsend-em'); await page.click('#qsend-send'); await results();
  await page.waitForFunction(() => document.querySelectorAll('#qsend-res-list li[data-state="failed"]').length === 2); await closeResults();
  state.mode = 'ok'; state.mailMode = 'ok';
  await page.waitForSelector('.qv-sendstate');
  // the call that was sending stopped after WhatsApp: the email channel is still "queued" (written by hand: this is what an interrupted call leaves)
  const del = await deliveries(brian), emailD = del.find((d) => d.channel === 'email'), waD = del.find((d) => d.channel === 'whatsapp');
  await db.doc(`quotes/${brian}/deliveries/${emailD.id}`).update({ state: 'queued', attempts: 0, attemptId: null, claimedAt: null, error: null, failedAt: null, createdAt: Timestamp.fromMillis(Date.now() - 5 * 60 * 1000) });
  await page.waitForSelector('.qv-sendstate li[data-channel="email"][data-state="queued"]');
  const resume = page.locator('.qv-sendstate li[data-channel="email"] button[data-action="resume"]');
  await resume.waitFor({ state: 'visible', timeout: 10000 });
  assert.match(await resume.textContent(), /Send Email now/);
  assert.equal(await page.locator('.qv-sendstate li[data-channel="whatsapp"] button[data-action="resume"]').count(), 0);        // only the one that was left behind
  const mails1 = state.mails;
  await resume.click();
  await page.waitForFunction(() => document.querySelector('.qv-sendstate li[data-channel="email"][data-state="sent"]') || !document.querySelector('.qv-sendstate'));
  await until(async () => (await quote(brian)).status === 'sent', 'the quote is marked sent once the channel delivers');
  assert.equal(state.mails, mails1 + 1);
  assert.equal((await deliveries(brian)).filter((d) => d.state === 'sent').map((d) => d.channel).join(), 'email');
  ok('a channel that was left waiting offers "Send Email now"; pressing it delivers it once, and the quote is marked sent (WhatsApp stays failed, untouched)');

  // a channel that is "sending" turns into "not confirmed" by itself after 3 minutes, with no other change in the data
  const cara = await makeQuote(ph.cara);
  state.mode = 'refuse'; await openSend(cara); await page.click('#qsend-send'); await results();
  await page.waitForFunction(() => document.querySelector('#qsend-res-list li[data-state="failed"]')); await closeResults(); state.mode = 'ok';
  await page.waitForSelector('.qv-sendstate');
  const cd = (await deliveries(cara))[0];
  await db.doc(`quotes/${cara}/deliveries/${cd.id}`).update({ state: 'sending', attempts: 1, attemptId: cd.id + '#1', claimedAt: Timestamp.fromMillis(Date.now() - 172 * 1000), error: null, failedAt: null });
  await page.waitForSelector('.qv-sendstate li[data-state="sending"]');
  await page.waitForSelector('.qv-sendstate li[data-state="unknown"]', { timeout: 60000 });                  // 8 seconds later it crosses 3 minutes: no data changed, the screen must notice
  ok('a send that has been "sending" for over 3 minutes turns into "not confirmed" on the screen by itself, without waiting for unrelated data to change');

  // ================================================== audit 2: two people editing: the later save must not silently overwrite the earlier ============
  // Staff A types in a quote (not saved yet); staff B (a second window, the same office) saves a different change. A's screen used to take over B's
  // new revision as its own and then save A's old inputs on top of B's work. Now A is told, keeps what A typed, and must DECIDE.
  const dan = await makeQuote(ph.dan);
  const page2 = await ctx.newPage(); await page2.goto('http://127.0.0.1:5055/'); await page2.waitForSelector('#app:not([hidden])');
  const doorsOf = async () => (await db.doc(`quotes/${dan}/versions/1`).get()).data().answers.doors;
  const asB = {
    doors: (v) => page2.evaluate(async ([id, doors]) => { const f = firebase.app().functions('europe-west1'), d = firebase.firestore();
      const q = (await d.doc('quotes/' + id).get()).data(), vv = (await d.doc(`quotes/${id}/versions/1`).get()).data(), a = JSON.parse(JSON.stringify(vv.answers)); a.doors = doors;
      await f.httpsCallable('saveQuoteDraft')({ id, expectedRev: q.rev, answers: a }); }, [dan, v]),
    notes: (t) => page2.evaluate(async ([id, notes]) => { const f = firebase.app().functions('europe-west1'); const q = (await firebase.firestore().doc('quotes/' + id).get()).data();
      await f.httpsCallable('setQuoteNotes')({ id, expectedRev: q.rev, notes }); }, [dan, t]),
  };
  await openQuote(dan); await page.waitForSelector('[data-field="doors"]');
  const a0 = await doorsOf();
  await page.fill('[data-field="doors"]', '12');                                                  // A types, and does not save
  await page.waitForFunction(() => !document.getElementById('qv-save').disabled);
  await asB.doors(7);                                                                              // B saves a different number of doors
  await until(async () => (await doorsOf()) === 7, 'B\'s save');
  await page.waitForSelector('#qv-conflict', { timeout: 15000 });                                  // A is told
  assert.equal(await page.isDisabled('#qv-save'), true, 'A can still press Save draft and replace B\'s change');
  assert.equal(await page.inputValue('[data-field="doors"]'), '12', 'A\'s typing must be kept while A decides');
  assert.equal(await doorsOf(), 7);                                                                // nothing of A's reached the server
  ok('B saved a change while A had unsaved edits: A is told, Save draft is disabled, A\'s typing is kept, and nothing overwrote B\'s change');

  await page.click('#qv-conflict-reload');                                                         // A chooses "load their version"
  await page.waitForFunction(() => document.querySelector('[data-field="doors"]').value === '7');
  assert.equal(await page.locator('#qv-conflict').count(), 0);
  await page.fill('[data-field="doors"]', '15'); await page.waitForFunction(() => !document.getElementById('qv-save').disabled);
  await asB.doors(9); await page.waitForSelector('#qv-conflict', { timeout: 15000 });
  await page.click('#qv-conflict-keep');                                                           // A deliberately keeps their version
  await page.waitForFunction(() => !document.getElementById('qv-save').disabled && !document.getElementById('qv-conflict'));
  await page.click('#qv-save'); await until(async () => (await doorsOf()) === 15, 'A\'s deliberate save');
  ok('A can choose "load their version" (A\'s unsaved changes are replaced) or "keep my changes and replace theirs" (an explicit decision, and only then is B\'s change replaced)');

  await page.fill('[data-field="doors"]', '16'); await page.click('#qv-save'); await until(async () => (await doorsOf()) === 16, 'A\'s own save');
  await page.fill('[data-field="doors"]', '17');                                                   // typing again straight after one's own save
  await sleep(2500);
  assert.equal(await page.locator('#qv-conflict').count(), 0, 'A\'s own save must not look like someone else\'s change');
  await page.click('#qv-save'); await until(async () => (await doorsOf()) === 17, 'A\'s second save');
  ok('one\'s own saves never look like a conflict: edit, save, edit, save again');

  // the internal notes: the same rule
  await page.fill('#qv-notes', 'notes typed by A');
  await asB.notes('notes saved by B'); await until(async () => (await quote(dan)).notes === 'notes saved by B', 'B\'s notes');
  await page.click('#qv-notes-save');
  await page.waitForFunction(() => /someone else changed the notes/i.test(document.body.innerText));
  assert.equal((await quote(dan)).notes, 'notes saved by B', 'A\'s notes replaced B\'s without a word');
  await page.click('#qv-notes-save');                                                              // pressing again is the explicit decision
  await until(async () => (await quote(dan)).notes === 'notes typed by A', 'A\'s deliberate notes save');
  ok('notes: saving over someone else\'s change is refused once with an explanation, and only an explicit second press replaces it');

  // Quote Settings: the same rule, and the message that used to say "saving would be refused" was not true
  const setBVat = (vat) => page2.evaluate(async (v) => { const f = firebase.app().functions('europe-west1'); const s = (await firebase.firestore().doc('quoteSettings/current').get()).data();
    await f.httpsCallable('saveQuoteSettings')({ priceList: s.priceList, vatRate: v, validityDays: s.validityDays, business: s.business, expectedRev: s.rev }); }, vat);
  const vatNow = async () => (await db.doc('quoteSettings/current').get()).data().vatRate;
  await page.evaluate(() => { location.hash = '#quotes/settings'; }); await page.waitForSelector('[data-field="vatRate"]');
  await page.fill('[data-field="vatRate"]', '20');
  await setBVat(21); await until(async () => (await vatNow()) === 21, 'B\'s settings save');
  await page.waitForSelector('#qs-conflict', { timeout: 15000 });
  assert.equal(await page.isDisabled('#qs-save'), true, 'Quote Settings can still be saved over B\'s change');
  assert.equal(await page.inputValue('[data-field="vatRate"]'), '20'); assert.equal(await vatNow(), 21);
  await page.click('#qs-conflict-keep'); await page.waitForFunction(() => !document.getElementById('qs-save').disabled);
  await page.click('#qs-save'); await until(async () => (await vatNow()) === 20, 'A\'s deliberate settings save');
  await page.fill('[data-field="vatRate"]', '13.5'); await setBVat(23); await page.waitForSelector('#qs-conflict', { timeout: 15000 });
  await page.click('#qs-conflict-reload'); await page.waitForFunction(() => document.querySelector('[data-field="vatRate"]').value === '23');
  ok('Quote Settings: someone else\'s change while you are editing disables Save and offers "load their version" or "keep mine and replace theirs"');
  // ================================================== second audit 2: the quote and its draft arrive through two listeners, in either order ============
  // If the QUOTE's new revision reaches A while the DRAFT's new answers are still on their way, A's form used to be paired with the newer revision although
  // it held the older answers: A's next save then replaced B's work without a word. Here the draft's snapshots are held back on purpose.
  const bq = await makeQuote(ph.brian);
  const bDoors = async () => (await db.doc(`quotes/${bq}/versions/1`).get()).data().answers.doors;
  const saveAsB = (id, doors) => page2.evaluate(async ([i, d]) => { const f = firebase.app().functions('europe-west1'), fs = firebase.firestore();
    const q = (await fs.doc('quotes/' + i).get()).data(), vv = (await fs.doc(`quotes/${i}/versions/1`).get()).data(), a = JSON.parse(JSON.stringify(vv.answers)); a.doors = d;
    await f.httpsCallable('saveQuoteDraft')({ id: i, expectedRev: q.rev, answers: a }); }, [id, doors]);
  assert.equal(await page.evaluate(() => typeof firebase.firestore.Query), 'function', 'cannot hold the draft listener back: this SDK has no Query class');
  await page.evaluate(() => {
    const proto = firebase.firestore.Query.prototype, orig = proto.onSnapshot;
    window.__hold = { on: false, queue: [] };
    proto.onSnapshot = function (...args) {
      if (typeof this.path === 'string' && /\/versions$/.test(this.path) && typeof args[0] === 'function') { const next = args[0]; args[0] = (snap) => { if (window.__hold.on) window.__hold.queue.push(() => next(snap)); else next(snap); }; }
      return orig.apply(this, args);
    };
    window.__releaseDraft = () => { window.__hold.on = false; for (const f of window.__hold.queue.splice(0)) f(); };
  });
  await openQuote(bq); await page.waitForSelector('[data-field="doors"]');
  const rev0 = (await quote(bq)).rev;
  await page.evaluate(() => { window.__hold.on = true; });                                       // from now on the DRAFT's snapshots are held back
  await saveAsB(bq, 7);                                                                          // B saves new answers
  await until(async () => (await quote(bq)).rev > rev0, 'B\'s save');
  await sleep(1500);                                                                             // the QUOTE's new revision has reached A; the draft's new answers have not
  await page.fill('[data-field="doors"]', '12');                                                 // A, not yet told, types...
  await page.waitForFunction(() => !document.getElementById('qv-save').disabled);
  await page.click('#qv-save');                                                                  // ...and saves
  await sleep(1500);
  assert.equal(await bDoors(), 7, 'A saved its OLD answers over B\'s newer ones, paired with the newest quote revision');
  await page.evaluate(() => window.__releaseDraft());                                            // now the draft's snapshot arrives
  await page.waitForSelector('#qv-conflict', { timeout: 15000 });                                // and A is told, with A's typing kept
  assert.equal(await page.inputValue('[data-field="doors"]'), '12'); assert.equal(await bDoors(), 7);
  ok('the quote\'s newer revision arrived before the draft\'s newer answers: A\'s save is refused (B\'s work stays), and when the draft arrives A is told and keeps the typing');

  await page2.close();

  // ================================================== second audit 3: a resumed send whose queued email is for ANOTHER address ===========================
  // The dialog is reopened (the same request is remembered) after the customer's address was corrected. The queued email was made for the OLD address: it must
  // not be sent to it, nor silently to the new one. Staff decide (cancel the earlier attempt), and the next send is a new request for the address shown.
  const eveQ = await makeQuote(ph.eve);
  await openSend(eveQ); await page.click('#qsend-send'); await results();
  await page.waitForFunction(() => document.querySelector('#qsend-res-list li[data-channel="whatsapp"][data-state="sent"]')); await closeResults();
  const R = 'resume-' + Date.now() + '-xyzxyzxy', sentV = (await db.doc(`quotes/${eveQ}/versions/1`).get()).data();
  const did = `1-${require('crypto').createHash('sha256').update(R).digest('hex').slice(0, 12)}-email`;
  await db.doc(`quotes/${eveQ}/deliveries/${did}`).set({ quoteId: eveQ, phone: ph.eve, version: 1, channel: 'email', requestId: R, state: 'queued', attempts: 0, attemptId: null,
    message: 'Dear Eve, please find attached your quotation.', to: { email: 'eve@example.com' }, subject: 'Quote', pdf: sentV.pdf, provider: null, error: null, claimedAt: null, sentAt: null, failedAt: null,
    resolvedBy: null, history: [], createdAt: Timestamp.fromMillis(Date.now() - 300000), createdBy: { kind: 'staff', id: 'staff@test.dev' }, updatedAt: Timestamp.now() });          // what an interrupted resend leaves behind
  await db.doc('contacts/' + ph.eve).update({ email: 'eve.corrected@example.com' });
  await page.evaluate(([key, requestId]) => sessionStorage.setItem('ek-resend-request', JSON.stringify({ key, requestId, at: Date.now() })), [`${eveQ}|1`, R]);       // the interrupted request is remembered
  const mailsBefore = state.mails;
  await openSend(eveQ, '#qv-resend'); await page.uncheck('#qsend-wa'); await page.check('#qsend-em');
  await page.click('#qsend-send');
  await page.waitForFunction(() => /earlier attempt/i.test(document.getElementById('qsend-err').textContent));
  assert.equal(state.mails, mailsBefore, 'the queued email was sent although the dialog showed another address');
  assert.ok(!state.mailTo.includes('eve@example.com'), 'something went to the OLD address');
  assert.equal(await page.isDisabled('#qsend-send'), false);
  await page.waitForSelector('#qsend-cancel-earlier');                                          // the explicit decision is offered right here
  await page.click('#qsend-cancel-earlier');
  await page.waitForFunction(() => /earlier attempt was cancelled/i.test(document.getElementById('qsend-err').textContent));
  assert.equal((await db.doc(`quotes/${eveQ}/deliveries/${did}`).get()).data().state, 'cancelled');
  await page.click('#qsend-send'); await results();                                              // now a NEW request, for the address shown
  await page.waitForFunction(() => document.querySelector('#qsend-res-list li[data-channel="email"][data-state="sent"]'));
  assert.deepEqual(state.mailTo.slice(mailsBefore), ['eve.corrected@example.com']);
  ok('a resumed send for another address is refused with a clear choice: the earlier attempt can be cancelled in one click, and the next send goes to the address shown, never to the old one');

  // ================================================== audit 6 on the screen: the inbox sends a request id, and keeps it when an answer never arrived ===
  const sendReqs = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /\/sendReply$/.test(r.url())) { try { sendReqs.push(JSON.parse(r.postData()).data); } catch (e) { /* not json */ } } });
  await page.evaluate((p) => { location.hash = '#c/' + p; }, ph.cara);
  await page.waitForSelector('#text'); await page.waitForFunction(() => !document.getElementById('text').disabled);
  const texts0 = state.messages.filter((m) => m.type === 'text').length;
  await page.fill('#text', 'Hello from the audit test');
  await page.route('**/sendReply', (route) => route.abort('failed'));                       // the connection drops: no answer reaches the screen
  await page.click('#send');
  await page.waitForFunction(() => /^message not sent/i.test(document.getElementById('banner').textContent));          // the send error itself, not any "not sent" elsewhere on the page
  await page.unroute('**/sendReply');
  assert.equal(await page.inputValue('#text'), 'Hello from the audit test', 'the text must be kept so it can be sent again');
  await page.click('#send');                                                                  // sent again, as a person would
  await until(() => state.messages.filter((m) => m.type === 'text').length === texts0 + 1, 'the message reaches WhatsApp once');
  assert.equal(sendReqs.length, 2); assert.equal(typeof sendReqs[0].requestId, 'string', 'no request id was sent'); assert.ok(/^[A-Za-z0-9_-]{8,64}$/.test(sendReqs[0].requestId));
  assert.equal(sendReqs[1].requestId, sendReqs[0].requestId, 'the second try must be the same request');
  await page.fill('#text', 'Hello from the audit test'); await page.click('#send');          // a message that WAS answered: sending it again is a NEW message, on purpose
  await until(() => state.messages.filter((m) => m.type === 'text').length === texts0 + 2, 'a second, deliberate message');
  assert.notEqual(sendReqs[2].requestId, sendReqs[0].requestId);
  ok('inbox: a message gets a request id; if its answer never arrived, sending the same text again is the SAME request (one message), while a message that was answered is a new one next time');

  // ---- second audit 6 on the screen: starting a conversation sends a request id too, and keeps it when the answer never arrived ----
  const startReqs = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /\/startConversation$/.test(r.url())) { try { startReqs.push(JSON.parse(r.postData()).data); } catch (e) { /* not json */ } } });
  const NEWNUM = '353860000099';
  await page.click('#new-btn'); await page.waitForSelector('#n-phone', { state: 'visible' });
  await page.fill('#n-phone', '+353 86 000 0099'); await page.fill('#n-name', 'Frank');
  await page.route('**/startConversation', (route) => route.abort('failed'));                    // the connection drops: no answer reaches the screen
  await page.click('#n-go');
  await page.waitForFunction(() => document.getElementById('n-err').textContent.length > 0);
  await page.unroute('**/startConversation');
  await page.waitForFunction(() => !document.getElementById('n-go').disabled);
  await page.click('#n-go');                                                                     // pressed again, as a person would
  await until(async () => (await db.doc('conversations/' + NEWNUM).get()).exists, 'the conversation to start');
  await until(async () => state.messages.filter((m) => m.to === NEWNUM).length >= 1, 'the template to reach WhatsApp');
  assert.equal(startReqs.length, 2); assert.equal(typeof startReqs[0].requestId, 'string', 'no request id was sent'); assert.ok(/^[A-Za-z0-9_-]{8,64}$/.test(startReqs[0].requestId));
  assert.equal(startReqs[1].requestId, startReqs[0].requestId, 'the second try must be the same request');
  assert.equal(state.messages.filter((m) => m.to === NEWNUM).length, 1, 'the template went out more than once');
  ok('starting a conversation: the request has an id, and pressing again after an answer that never arrived is the SAME request (one template)');
  assert.deepEqual(errors, [], 'browser errors: ' + JSON.stringify(errors)); ok('no JavaScript errors in the browser');
  console.log(`ALL ${n} CHECKS PASSED`);
  await browser.close(); web.close(); meta.close(); gmail.close(); process.exit(0);
})().catch(async (e) => { console.error('FAILED:', e && e.stack || e); try { await global.__page?.screenshot({ path: path.join(SHOTS, 'recovery-fail.png') }); } catch (_) { /* no page */ } process.exit(1); });
