'use strict';
// Phase 6.1 M5 browser test: sending a quote through WhatsApp and email, from the quote itself. Real page + real functions +
// emulators, a MOCKED Meta and a MOCKED Gmail (no real message or email is ever sent). Covers: channel availability and its reasons
// (open window, closed window with Reopen inside the dialog, waiting for a reply, no email, nothing available), one and both
// channels, every result on its own (sent / failed with Retry / not confirmed with "It arrived / It did not arrive"), the quote
// marked sent only once a channel confirms, the exact PDF reaching both providers, a double click, a refresh during a send, the
// "send in progress" box, resending a version, the fallbacks, the history, and the phone. Run: bash test-ui/run.sh quote-delivery.e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getAuth } = fnRequire('firebase-admin/auth');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const { getStorage } = fnRequire('firebase-admin/storage');
const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
const FN = 'http://127.0.0.1:5001/demo-leados/europe-west1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, msg, t = 20000) { const s = Date.now(); while (Date.now() - s < t) { if (await fn()) return; await sleep(100); } throw new Error('timed out waiting for: ' + msg); }
let n = 0; const ok = (m) => console.log(`  PASS ${++n}. ${m}`);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

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

// ---- mocked Meta: media upload (multipart, the file part is kept) and messages ----
const metaState = { media: [], messages: [], mode: 'ok', holdMs: 0 }; let gid = 0;
function filePart(buf, contentType) {
  const boundary = '--' + /boundary=(.+)$/.exec(contentType || '')[1], s = buf.toString('latin1');
  for (const part of s.split(boundary)) {
    const i = part.indexOf('\r\n\r\n'); if (i < 0 || !/filename="/.test(part.slice(0, i))) continue;
    return { name: /filename="([^"]*)"/.exec(part.slice(0, i))[1], bytes: Buffer.from(part.slice(i + 4, part.length - 2), 'latin1') };
  }
  return null;
}
const meta = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', async () => {
    const buf = Buffer.concat(chunks), json = (o, st = 200) => { res.statusCode = st; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.method === 'POST' && /\/111\/media$/.test(req.url)) { const f = filePart(buf, req.headers['content-type']); metaState.media.push(f); return json({ id: 'UPMEDIA' + metaState.media.length }); }
    if (req.method === 'POST' && /\/111\/messages$/.test(req.url)) {
      metaState.messages.push(JSON.parse(buf.toString() || '{}'));
      if (metaState.holdMs) await sleep(metaState.holdMs);
      if (metaState.mode === 'refuse') return json({ error: { code: 131026, message: 'Message undeliverable' } }, 400);
      if (metaState.mode === 'server') return json({ error: { code: 1, message: 'Unknown' } }, 500);
      return json({ messages: [{ id: 'wamid.OUT' + ++gid }] });
    }
    json({ error: { message: 'unexpected ' + req.method + ' ' + req.url } }, 404);
  });
}).listen(9911);
meta.keepAliveTimeout = 0;
// ---- mocked Gmail ----
const mailState = { raws: [], mode: 'ok' };
const gmail = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    const json = (o, st = 200) => { res.statusCode = st; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.method === 'POST' && /\/gmail\/v1\/users\/me\/messages\/send$/.test(req.url)) {
      mailState.raws.push(JSON.parse(Buffer.concat(chunks).toString()).raw);
      if (mailState.mode === '403') return json({ error: { message: 'forbidden' } }, 403);
      return json({ id: 'gmsg-' + mailState.raws.length, threadId: 'thr' });
    }
    json({ error: { message: 'unexpected' } }, 404);
  });
}).listen(9913);
gmail.keepAliveTimeout = 0;
function readMail(raw) {
  const msg = Buffer.from(raw, 'base64url').toString('utf8'), [head, ...rest] = msg.split('\r\n\r\n');
  const headers = {}; let last = null;
  for (const line of head.split('\r\n')) { if (/^[ \t]/.test(line) && last) headers[last] += '\r\n' + line; else { const i = line.indexOf(':'); last = line.slice(0, i); headers[last] = line.slice(i + 1).trim(); } }
  const boundary = /boundary="([^"]+)"/.exec(headers['Content-Type'])[1];
  const parts = rest.join('\r\n\r\n').split(`--${boundary}`).slice(1, -1).map((p) => { const t = p.replace(/^\r\n/, '').replace(/\r\n$/, ''); const i = t.indexOf('\r\n\r\n'); return { head: t.slice(0, i), body: t.slice(i + 4) }; });
  const words = (s) => s.replace(/\r\n /g, '').replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
  return { to: headers.To, from: words(headers.From), subject: words(headers.Subject), pdf: Buffer.from(parts[1].body.replace(/\r\n/g, ''), 'base64'),
    text: Buffer.from(parts[0].body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16))), 'latin1').toString('utf8').replace(/\r\n/g, '\n') };
}
// ---- the customer's side: Meta -> our webhook ----
async function hook(payload) {
  const raw = JSON.stringify(payload);
  const r = await fetch(FN + '/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', 'secret').update(raw).digest('hex') }, body: raw });
  assert.equal(r.status, 200, 'webhook status ' + r.status);
}
let wm = 0;
const inbound = (from, name, extra) => hook({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '111' }, contacts: [{ wa_id: from, profile: { name } }],
  messages: [{ id: 'wamid.IN' + ++wm, from, timestamp: String(Math.floor(Date.now() / 1000)), ...extra }] } }] }] });

const H = 3600e3;
const ph = { anna: '353860000031', brian: '353860000032', cara: '353860000033', dan: '353860000034', eva: '353860000035', finn: '353860000036', gus: '353860000037', hal: '353860000038' };
const SETTINGS = { vatRate: 13.5, validityDays: 30,
  business: { tradingName: 'Elite Kitchens', signatureName: 'Test Signer', phone: '01 000 0000', email: 'quotes@example.com', web: 'www.example.com', address: 'Test Street, Dublin', vatNumber: 'IE0000000X' },
  priceList: { options: { ess: { perDoor: 313.37, perTopBox: 171.17 }, prem: { perDoor: 323.41, perTopBox: 181.19 }, pp: { perDoor: 333.53, perTopBox: 191.29 } },
    drawerBoxes: { cemux: 19.19, blum: 29.29 }, glazing: { small: 43.43, large: 91.91 }, extras: [] } };

(async () => {
  initializeApp({ projectId: 'demo-leados', storageBucket: 'demo-leados.firebasestorage.app' });
  const db = getFirestore(), bucket = getStorage().bucket();
  const t0 = Date.now();
  const seed = async (id, name, email, inboundAgoH, extra = {}) => {
    await db.doc('conversations/' + id).set({ phone: id, name, createdAt: Timestamp.fromMillis(t0 - 10 * H), updatedAt: Timestamp.fromMillis(t0 - 1 * H), lastMessage: 'Hi', unreadCount: 0,
      ...(inboundAgoH == null ? {} : { lastInboundAt: Timestamp.fromMillis(t0 - inboundAgoH * H) }), ...extra });
    await db.doc('contacts/' + id).set({ phone: id, name, ...(email ? { email } : {}), address: '1 Main Street, Swords', location: 'Swords', createdAt: Timestamp.fromMillis(t0 - 10 * H) });
  };
  await seed(ph.anna, 'Anna Murphy', 'anna@example.com', 2); await seed(ph.brian, 'Brian Byrne', 'brian@example.com', 30);
  await seed(ph.cara, 'Cara Walsh', null, 2); await seed(ph.dan, 'Dan Doyle', null, 30);
  await seed(ph.eva, 'Eva Egan', 'eva@example.com', 2); await seed(ph.finn, 'Finn Flynn', 'finn@example.com', 2); await seed(ph.gus, 'Gus Grant', 'gus@example.com', 2); await seed(ph.hal, 'Hal Hogan', 'hal@example.com', 30);
  const quote = async (id) => (await db.doc('quotes/' + id).get()).data();
  const version = async (id, v = 1) => (await db.doc(`quotes/${id}/versions/${v}`).get()).data();
  const conv = async (p) => (await db.doc('conversations/' + p).get()).data();
  const deliveries = async (id) => (await db.collection(`quotes/${id}/deliveries`).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const storedPdf = async (id, v = 1) => (await bucket.file((await version(id, v)).pdf.path).download())[0];
  const docMsgs = () => metaState.messages.filter((m) => m.type === 'document');
  const tmplMsgs = () => metaState.messages.filter((m) => m.type === 'template' && m.template.name === 'elite_kitchens_quote_document');

  const u = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true });
  const token = await getAuth().createCustomToken(u.uid);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 960 } });
  const page = await ctx.newPage(); global.__page = page;
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const dialogs = []; page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  const opened = []; await page.exposeFunction('__opened', (url) => { opened.push(url); });

  console.log('QUOTE DELIVERY E2E: real page + real functions + emulators + mocked Meta and Gmail');
  await page.goto('http://127.0.0.1:5055/');
  await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await page.waitForSelector('#app:not([hidden])');
  await page.evaluate(() => { window.open = (u) => { window.__opened(String(u)); return null; }; });
  await page.evaluate(async (s) => { const f = firebase.app().functions('europe-west1'); await f.httpsCallable('saveQuoteSettings')(s); await f.httpsCallable('setQuoteNumbering')({ next: 34 }); }, SETTINGS);

  const makeQuote = (phone) => page.evaluate(async (p) => {
    const f = firebase.app().functions('europe-west1'), s = (await firebase.firestore().doc('quoteSettings/current').get()).data();
    const a = QuoteEngine.current().newAnswers(s.priceList); a.doors = 10; a.drawers = 4; a.options.ess.drawerBox = 'cemux'; a.options.prem = { ...a.options.prem, on: true, drawerBox: 'blum' };
    return (await f.httpsCallable('createQuote')({ phone: p, requestId: crypto.randomUUID(), answers: a })).data.id;
  }, phone);
  const openQuote = async (id) => { await page.evaluate((i) => { location.hash = '#quotes/' + i; }, id); await page.waitForFunction((i) => location.hash === '#quotes/' + i, id); await page.waitForSelector('#q-quote-view .qv'); };
  const openDialog = async (id, buttonId = '#qv-send') => {
    await openQuote(id); await page.waitForSelector(buttonId + ':not([disabled])'); await page.click(buttonId); await page.waitForSelector('#qsend-dlg[open]');
    await page.waitForFunction(() => !/Checking/.test(document.getElementById('qsend-em-state').textContent) && document.getElementById('qsend-wa-state').textContent.length > 0);
  };
  const state = (c) => page.locator(`#qsend-res-list li[data-channel="${c}"]`).getAttribute('data-state');
  const waitResults = async () => { await page.waitForSelector('#qsend-results:not([hidden])', { timeout: 90000 }); };
  const rowText = (c) => page.locator(`#qsend-res-list li[data-channel="${c}"]`).innerText();
  const reset = () => { Object.assign(metaState, { mode: 'ok', holdMs: 0 }); mailState.mode = 'ok'; };

  // ======================================== availability, and sending by WhatsApp and email ========================================
  const anna = await makeQuote(ph.anna);
  await openDialog(anna);
  assert.match(await page.textContent('#qsend-title'), /Send EK-0034 v1/);
  assert.match(await page.textContent('#qsend-wa-state'), /^Available: the customer messaged recently \(open until \d\d:\d\d\)\.$/);
  assert.equal((await page.textContent('#qsend-em-state')).trim(), 'Available: anna@example.com');
  assert.equal(await page.isChecked('#qsend-wa'), true); assert.equal(await page.isChecked('#qsend-em'), false);            // one channel by default
  assert.equal(await page.inputValue('#qsend-wa-text'), 'Hi Anna, please find attached your quotation EK-0034 from Elite Kitchens. Any questions, just reply here.');
  assert.equal(await page.isVisible('#qsend-em-box'), false);
  assert.equal(await page.isVisible('#qsend-wa-reopen'), false);
  assert.equal(await page.locator('#qsend-send').isEnabled(), true); assert.equal(await page.isVisible('#qsend-go'), true);   // the by-hand fallback stays
  await page.screenshot({ path: path.join(SHOTS, 'delivery-dialog.png') });
  await page.check('#qsend-em');
  assert.equal(await page.isVisible('#qsend-em-box'), true);
  assert.equal(await page.inputValue('#qsend-em-subject'), 'Elite Kitchens — Kitchen Quote EK-0034 v1');
  assert.match(await page.inputValue('#qsend-em-text'), /^Hi Anna,\n\nThank you for getting in touch with Elite Kitchens\. Please find attached your kitchen quote EK-0034 v1\./);
  ok('the Send dialog shows each channel with its state: WhatsApp open, email available; one is ticked by default; the wording is the approved default and editable; the by-hand fallback is still there');

  await page.fill('#qsend-wa-text', 'Hi Anna, your kitchen quotation is attached. Any questions, just reply here.');
  await page.click('#qsend-send'); await waitResults();
  await page.waitForFunction(() => document.querySelectorAll('#qsend-res-list li[data-state="sent"]').length === 2);
  assert.equal(await state('whatsapp'), 'sent'); assert.equal(await state('email'), 'sent');
  assert.match(await page.textContent('#qsend-res-title'), /^EK-0034 v1: sent$/);
  assert.match(await rowText('whatsapp'), /^✓\s*WhatsApp: sent \d+ \w+ \d\d:\d\d/); assert.match(await rowText('email'), /Email: sent/);
  assert.match(await page.textContent('#qsend-res-effect'), /Anna Murphy moved from New lead to Quoted/);
  const qa = await quote(anna), pdfA = await storedPdf(anna);
  assert.deepEqual([qa.status, qa.sentVersion, (await conv(ph.anna)).inboxStatus], ['sent', 1, 'quoted']);
  assert.equal(docMsgs().length, 1); assert.equal(docMsgs()[0].to, ph.anna);
  assert.equal(docMsgs()[0].document.caption, 'Hi Anna, your kitchen quotation is attached. Any questions, just reply here.');
  assert.ok(metaState.media[0].bytes.equals(pdfA), 'the PDF Meta received is the stored PDF');
  const mail = readMail(mailState.raws[0]);
  assert.deepEqual([mail.to, mail.from, mail.subject], ['anna@example.com', '"Elite Kitchens" <info@test.dev>', 'Elite Kitchens — Kitchen Quote EK-0034 v1']);
  assert.ok(mail.pdf.equals(pdfA), 'the PDF Gmail received is the stored PDF'); assert.match(mail.text, /^Hi Anna,/);
  assert.equal(sha(pdfA), (await version(anna)).pdf.sha256);
  await page.screenshot({ path: path.join(SHOTS, 'delivery-results.png') });
  ok('both channels sent: each result on its own, the quote marked sent, the customer moved to Quoted, and the SAME stored PDF reached WhatsApp and Gmail');

  await page.click('#qsend-res-close');
  await page.waitForFunction(() => document.querySelectorAll('.qv-vdel .qsend-res-row').length === 2);
  assert.match(await page.textContent('.qv-versions'), /WhatsApp: sent[\s\S]*Email: sent/);
  assert.match(await page.textContent('.qv-activity'), /sent v1 via WhatsApp/);
  assert.match(await page.textContent('.qv-banner'), /Sent /);
  await page.evaluate((p) => { location.hash = '#c/' + p; }, ph.anna);
  await page.waitForFunction(() => /via WhatsApp/.test(document.getElementById('d-quotes-list').textContent));
  await page.waitForSelector('#msgs .m.out .quote-chip');
  assert.equal((await page.textContent('#msgs .m.out .quote-chip')).trim(), 'Quote EK-0034 v1');
  assert.match(await page.textContent('#msgs'), /Hi Anna, your kitchen quotation is attached/);
  ok('the history shows the sending on the quote (versions, activity) and the customer profile; the chat shows the document labelled with the quote number');

  // ============================================ a closed window: the quote goes in the approved quotation template (M7) =================
  const brian = await makeQuote(ph.brian);
  await openDialog(brian);
  const bref = (await quote(brian)).ref;
  assert.match(await page.textContent('#qsend-wa-state'), /^24-hour window closed: WhatsApp only allows an approved template now, so the quote is sent with the approved quotation template, PDF attached\. The customer can reply to it\.$/);
  assert.equal(await page.isDisabled('#qsend-wa'), false); assert.equal(await page.isChecked('#qsend-wa'), true);               // usable, and ticked by default
  assert.equal(await page.isVisible('#qsend-wa-reopen'), false);                                                              // no Reopen step for a quote
  assert.equal(await page.isChecked('#qsend-em'), false);
  assert.equal(await page.inputValue('#qsend-wa-text'), `Hi Brian, as discussed, please find attached your Elite Kitchens quotation ${bref}. If you have any questions or would like to make any changes, just reply here.`);
  assert.equal(await page.locator('#qsend-wa-text').isEditable(), false);                                                     // fixed words: WhatsApp does not allow changing them
  assert.match(await page.textContent('#qsend-wa-note'), /fixed words of the approved quotation template/);
  await page.screenshot({ path: path.join(SHOTS, 'delivery-template-dialog.png') });
  ok('a closed window no longer blocks a quote: WhatsApp is usable and ticked, there is no Reopen step, and the box shows the approved template\'s fixed words (read-only) with the right name and quote number');

  const mediaBefore = metaState.media.length, docsBefore = docMsgs().length;
  await page.click('#qsend-send'); await waitResults();
  await page.waitForFunction(() => document.querySelector('#qsend-res-list li[data-channel="whatsapp"][data-state="sent"]'));
  assert.match(await rowText('whatsapp'), /approved quotation template, PDF attached/);
  assert.equal(docMsgs().length, docsBefore);                                                                                 // no free-form document: Meta would refuse it
  const tm = tmplMsgs(); assert.equal(tm.length, 1);
  assert.deepEqual([tm[0].to, tm[0].template.name, tm[0].template.language.code], [ph.brian, 'elite_kitchens_quote_document', 'en']);
  const hdr = tm[0].template.components.find((c) => c.type === 'header').parameters[0].document, stored = await storedPdf(brian);
  assert.equal(metaState.media.length, mediaBefore + 1); assert.ok(metaState.media.at(-1).bytes.equals(stored), 'the PDF in the template header is the stored PDF');
  assert.equal(hdr.id, 'UPMEDIA' + metaState.media.length); assert.equal(hdr.filename, `EliteKitchens-${bref}-v1.pdf`);
  assert.deepEqual(tm[0].template.components.find((c) => c.type === 'body').parameters.map((p) => p.text), ['Brian', bref]);
  const bd = (await deliveries(brian))[0]; assert.deepEqual([bd.state, bd.route, (await quote(brian)).status], ['sent', 'template', 'sent']);
  assert.equal(mailState.raws.length, 1);                                                                                     // email was not used for Brian
  await page.click('#qsend-res-close');
  await page.evaluate((p) => { location.hash = '#c/' + p; }, ph.brian);
  await page.waitForFunction(() => document.querySelectorAll('#msgs .m.out .quote-chip').length === 1);
  assert.match(await page.textContent('#msgs'), /as discussed, please find attached your Elite Kitchens quotation/);
  assert.equal(await page.isVisible('#window-note'), true); assert.equal(await page.isVisible('#tpl-btn'), true);              // the chat still says the window is closed: a template does not open it, and Reopen is still there for ordinary chats
  assert.match(await page.textContent('#tpl-btn'), /Reopen conversation/);
  ok('the template goes to Meta with the stored PDF as its header and the right first name and quote number, one message, no free-form document; the quote is Sent, the chat shows it labelled, and the closed-window band with Reopen conversation is unchanged');

  await inbound(ph.brian, 'Brian Byrne', { type: 'button', button: { text: 'I have a question', payload: 'x' } });             // the CUSTOMER taps the template's button
  await page.waitForFunction(() => document.getElementById('window-note').hidden);
  ok('the customer tapping the template\'s "I have a question" button is their reply: it opens the 24-hour window, as for any reply');

  // ======================================== one channel fails, the other succeeds: retry only the failed one =======================
  reset(); metaState.mode = 'refuse';
  const eva = await makeQuote(ph.eva);
  await openDialog(eva); await page.check('#qsend-em');
  await page.click('#qsend-send'); await waitResults();
  await page.waitForFunction(() => document.querySelector('#qsend-res-list li[data-channel="email"][data-state="sent"]') && document.querySelector('#qsend-res-list li[data-channel="whatsapp"][data-state="failed"]'));
  assert.match(await rowText('whatsapp'), /^✕\s*WhatsApp: failed[\s\S]*can't deliver to this number[\s\S]*131026[\s\S]*Retry WhatsApp/);
  assert.match(await rowText('email'), /Email: sent/); assert.match(await page.textContent('#qsend-res-title'), /EK-0036 v1: sent$/);
  assert.equal((await quote(eva)).status, 'sent'); assert.equal((await quote(eva)).history.at(-1).via, 'email');
  assert.equal(docMsgs().filter((m) => m.to === ph.eva).length, 1); assert.equal(mailState.raws.length, 2);
  metaState.mode = 'ok';
  await page.click('#qsend-res-list li[data-channel="whatsapp"] button[data-action="retry"]');
  await page.waitForFunction(() => document.querySelector('#qsend-res-list li[data-channel="whatsapp"][data-state="sent"]'));
  assert.equal(mailState.raws.length, 2, 'the email was not sent again'); assert.equal(docMsgs().filter((m) => m.to === ph.eva).length, 2);
  assert.equal((await quote(eva)).history.filter((h) => h.action === 'sent').length, 1);
  await page.screenshot({ path: path.join(SHOTS, 'delivery-retry.png') });
  ok('WhatsApp failed and email sent: both shown, the quote marked sent (by email); Retry sends ONLY WhatsApp and the email is not sent again');
  await page.click('#qsend-res-close');

  // ======================================== nothing is confirmed: the quote is not sent; the "send in progress" box =================
  reset(); metaState.mode = 'refuse'; mailState.mode = '403';
  const finn = await makeQuote(ph.finn);
  await openDialog(finn); await page.check('#qsend-em');
  await page.click('#qsend-send'); await waitResults();
  await page.waitForFunction(() => document.querySelectorAll('#qsend-res-list li[data-state="failed"]').length === 2);
  assert.match(await page.textContent('#qsend-res-title'), /^EK-0037 v1: not sent yet$/);
  assert.match(await page.textContent('#qsend-res-summary'), /Not sent: nothing reached the customer, and the quote is not marked sent/);
  assert.match(await rowText('email'), /refused to send as the business mailbox[\s\S]*Nothing was sent/);
  assert.equal(await page.isVisible('#qsend-res-manual'), true); assert.equal(await page.isVisible('#qsend-res-cancel'), true);
  const qf = await quote(finn);
  assert.deepEqual([qf.status, qf.sentVersion, qf.draftVersion, (await conv(ph.finn)).inboxStatus], ['draft', null, 1, undefined]);   // the CRM is untouched (a New lead has no stage field)
  await page.click('#qsend-res-close');
  await page.waitForSelector('#qv-sendstate');
  assert.match(await page.textContent('#qv-sendstate'), /A send is in progress: v1 is not marked sent[\s\S]*WhatsApp: failed[\s\S]*Email: failed/);
  assert.equal(await page.locator('#qv-save').count(), 0); assert.equal(await page.locator('#qv-send').count(), 0);
  assert.match(await page.textContent('.qv-actions'), /cannot be edited, discarded or deleted until it is finished or cancelled/);
  await page.screenshot({ path: path.join(SHOTS, 'delivery-in-progress.png') });
  reset();
  await page.click('#qv-sendstate li[data-channel="email"] button[data-action="retry"]');
  await page.waitForFunction(() => !document.getElementById('qv-sendstate'));
  assert.equal((await quote(finn)).status, 'sent'); assert.equal((await conv(ph.finn)).inboxStatus, 'quoted');
  ok('every channel failed: the quote is NOT marked sent and the stage is unchanged; the draft is locked with a "send in progress" box; one successful retry then marks it sent');

  // ======================================== not confirmed: never retried by itself; the staff decide ================================
  reset(); metaState.mode = 'server';
  const gus = await makeQuote(ph.gus);
  await openDialog(gus);
  await page.click('#qsend-send'); await waitResults();
  await page.waitForFunction(() => document.querySelector('#qsend-res-list li[data-channel="whatsapp"][data-state="unknown"]'));
  assert.match(await rowText('whatsapp'), /^\?\s*WhatsApp: delivery not confirmed[\s\S]*will not be sent again by itself[\s\S]*It arrived[\s\S]*It did not arrive/);
  assert.equal(await page.locator('#qsend-res-list button[data-action="retry"]').count(), 0);                                  // no Retry for an unsure send
  assert.match(await page.textContent('#qsend-res-title'), /not sent yet$/); assert.equal((await quote(gus)).status, 'draft');
  const calls = docMsgs().length; metaState.mode = 'ok'; await sleep(1500); assert.equal(docMsgs().length, calls, 'nothing is resent by itself');
  await page.click('#qsend-res-list button[data-action="not_arrived"]');
  await page.waitForFunction(() => document.querySelector('#qsend-res-list li[data-channel="whatsapp"][data-state="failed"]'));
  assert.match(await rowText('whatsapp'), /You confirmed that it did not arrive[\s\S]*Retry WhatsApp/);
  // The row turns to "failed" from the live update a moment BEFORE the call's own answer arrives, and the screen ignores a second press while one is still running:
  // wait for the confirmation that the call is over, or a Retry pressed straight away is (rarely, under load) ignored.
  await page.waitForFunction(() => /Recorded as not delivered/.test(document.body.innerText));
  await page.click('#qsend-res-list button[data-action="retry"]');
  await page.waitForFunction(() => document.querySelector('#qsend-res-list li[data-channel="whatsapp"][data-state="sent"]'));
  assert.equal((await quote(gus)).status, 'sent');
  ok('an answer we cannot confirm: shown as "delivery not confirmed" with "It arrived / It did not arrive" and no Retry; nothing is resent by itself; the staff\'s choice then drives it');
  await page.click('#qsend-res-close');

  // ======================================== a double click, and a refresh during a send ============================================
  reset();
  const dblQuote = await makeQuote(ph.cara);
  await openDialog(dblQuote); const before = docMsgs().length;
  await page.click('#qsend-send', { clickCount: 2 }); await waitResults();
  await page.waitForFunction(() => document.querySelector('#qsend-res-list li[data-state="sent"]')); await sleep(1200);
  assert.equal(docMsgs().length, before + 1, 'a double click sends once');
  await page.click('#qsend-res-close');
  ok('a double click on Send quote sends one message');

  metaState.holdMs = 2500;
  const refreshQuote = await makeQuote(ph.cara);
  await openDialog(refreshQuote); assert.match(await page.textContent('#qsend-em-state'), /No email address/); assert.equal(await page.isDisabled('#qsend-em'), true);
  const sentBefore = docMsgs().length;
  await page.click('#qsend-send');
  await until(() => metaState.messages.length > 0 && docMsgs().length === sentBefore + 1, 'the document reaches Meta');
  await page.reload();                                                                                                   // refresh while Meta is still answering
  await page.waitForSelector('#app:not([hidden])'); await openQuote(refreshQuote);
  await page.waitForFunction(() => { const s = document.getElementById('qv-sendstate'); return !!s || /Sent /.test(document.querySelector('.qv-banner').textContent); }, null, { timeout: 30000 });
  await until(async () => (await quote(refreshQuote)).status === 'sent', 'the send finishes on the server after the refresh');
  await page.waitForFunction(() => !document.getElementById('qv-sendstate') && /Sent /.test(document.querySelector('.qv-banner').textContent));
  assert.equal(docMsgs().length, sentBefore + 1, 'the refresh did not send a second copy');
  assert.equal((await deliveries(refreshQuote)).filter((d) => d.state === 'sent').length, 1);
  ok('a customer with no email address: email is disabled with the reason; a page refresh in the middle of a send neither loses nor repeats it: the quote shows what happened');
  reset();

  // ======================================== nothing available (template route switched off), and the fallbacks ======================
  // With no quotation template configured (the setting is left blank) a closed window is refused exactly as in M3: the browser is told so
  // by the "which channels?" answer, which is changed here to say template: false. A reload makes the page ask again.
  const reapply = async () => { await page.waitForSelector('#app:not([hidden])'); await page.evaluate(() => { window.open = (u) => { window.__opened(String(u)); return null; }; }); };
  await ctx.route('**/quoteChannels', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const r = await route.fetch(), body = await r.json(); body.result.whatsapp.template = false; await route.fulfill({ response: r, json: body });
  });
  await page.reload(); await reapply();
  const dan = await makeQuote(ph.dan);
  await openDialog(dan);
  assert.equal(await page.isDisabled('#qsend-wa'), true); assert.equal(await page.isDisabled('#qsend-em'), true);
  assert.match(await page.textContent('#qsend-via-note'), /Neither channel can be used right now/); assert.equal(await page.isDisabled('#qsend-send'), true);
  assert.match(await page.textContent('#qsend-em-state'), /No email address/); assert.equal(await page.isVisible('#qsend-wa-reopen'), true);
  assert.match(await page.textContent('#qsend-wa-state'), /^24-hour window closed: WhatsApp only allows an approved template until the customer replies\.$/);
  const msgsBefore = docMsgs().length, mailBefore = mailState.raws.length;
  await page.click('#qsend-go'); await page.waitForSelector('#qsend-done:not([hidden])', { timeout: 90000 });
  assert.match(await page.textContent('#qsend-done-text'), /EK-\d+ v1 is marked sent/);
  assert.equal(await page.isVisible('#qsend-download'), true); assert.equal(await page.isVisible('#qsend-email'), true);
  const qd = await quote(dan); assert.equal(qd.status, 'sent'); assert.equal(qd.history.at(-1).via, undefined);
  assert.deepEqual([docMsgs().length, mailState.raws.length], [msgsBefore, mailBefore]);                                    // nothing went out through a channel
  await page.click('#qsend-close');
  await page.waitForFunction(() => /Marked sent: no channel recorded/.test(document.querySelector('.qv-versions').textContent));
  await ctx.unroute('**/quoteChannels'); await page.reload(); await reapply();
  ok('with no channel available the dialog says so and explains how to fix it; "send it yourself" (Phase 6\'s way) still makes the PDF and marks it sent, and the history says no channel was recorded');

  // ======================================== re-sending a version; a revision keeps the old PDF ======================================
  await openDialog(anna, '#qv-resend');
  assert.match(await page.textContent('#qsend-title'), /^Send EK-0034 v1 to the customer$/);
  assert.equal(await page.isVisible('#qsend-renders'), false); assert.equal(await page.isVisible('#qsend-go'), false); assert.equal(await page.isVisible('#qsend-preview'), false);
  await page.uncheck('#qsend-wa'); await page.check('#qsend-em');
  const revBefore = (await quote(anna)).rev, mails = mailState.raws.length;
  await page.click('#qsend-send'); await waitResults();
  await page.waitForFunction(() => document.querySelector('#qsend-res-list li[data-channel="email"][data-state="sent"]'));
  assert.equal(mailState.raws.length, mails + 1); assert.ok(readMail(mailState.raws.at(-1)).pdf.equals(pdfA));
  assert.deepEqual([(await quote(anna)).rev, (await quote(anna)).status], [revBefore, 'sent']);                              // the quote record is untouched
  assert.match(await page.textContent('#qsend-res-title'), /^EK-0034 v1: sent$/);
  await page.click('#qsend-res-close');
  await page.waitForFunction(() => document.querySelectorAll('.qv-vdel .qsend-res-row').length === 3);
  ok('"Send this version" delivers the stored PDF of a version already sent, by email, with no new version and no change to the quote');

  await page.click('#qv-revise'); await page.waitForSelector('#qv-send:not([disabled])');
  await page.click('#qv-send'); await page.waitForSelector('#qsend-dlg[open]');
  await page.waitForFunction(() => /Available/.test(document.getElementById('qsend-wa-state').textContent));
  assert.match(await page.textContent('#qsend-title'), /Send EK-0034 v2/);
  assert.equal(await page.inputValue('#qsend-wa-text'), 'Hi Anna, please find attached your quotation EK-0034 v2 from Elite Kitchens. Any questions, just reply here.');
  await page.fill('#qsend-value', ''); await page.click('#qsend-send'); await waitResults();
  await page.waitForFunction(() => document.querySelector('#qsend-res-list li[data-channel="whatsapp"][data-state="sent"]'));
  const pdfA2 = await storedPdf(anna, 2);
  assert.ok(!pdfA2.equals(pdfA)); assert.ok((await storedPdf(anna, 1)).equals(pdfA));                                         // v1 is exactly what the customer received
  assert.ok(metaState.media.at(-1).bytes.equals(pdfA2));
  await page.click('#qsend-res-close');
  await page.evaluate((p) => { location.hash = '#c/' + p; }, ph.anna);
  await page.waitForFunction(() => document.querySelectorAll('#msgs .m.out .quote-chip').length === 2);
  assert.deepEqual(await page.locator('#msgs .m.out .quote-chip').allTextContents(), ['Quote EK-0034 v1', 'Quote EK-0034 v2']);
  ok('a revised quote sent again: PDF v1 is still exactly what the customer received, v2 is a new document, and the chat shows both labelled');

  // ======================================== the window closes while the dialog is open ===============================================
  reset();
  const closing = await makeQuote(ph.eva);
  await openDialog(closing);
  assert.equal(await page.isChecked('#qsend-wa'), true);
  await db.doc('conversations/' + ph.eva).update({ lastInboundAt: Timestamp.fromMillis(Date.now() - 30 * H) });
  await page.waitForFunction(() => /approved quotation template/.test(document.getElementById('qsend-wa-state').textContent));
  assert.equal(await page.isChecked('#qsend-wa'), true); assert.equal(await page.isVisible('#qsend-wa-reopen'), false);
  assert.equal(await page.locator('#qsend-wa-text').isEditable(), false); assert.match(await page.inputValue('#qsend-wa-text'), /^Hi Eva, as discussed, please find attached your Elite Kitchens quotation /);
  const g = tmplMsgs().length, gd = docMsgs().length; await page.click('#qsend-send'); await waitResults();
  await page.waitForFunction(() => document.querySelector('#qsend-res-list li[data-channel="whatsapp"][data-state="sent"]'));
  assert.deepEqual([tmplMsgs().length, docMsgs().length], [g + 1, gd]); assert.equal((await deliveries(closing))[0].route, 'template');
  await page.click('#qsend-res-close');
  ok('if the 24-hour window closes while the dialog is open the box switches to the approved template\'s words at once (WhatsApp stays ticked, no Reopen), and Send then goes out as the template (the server also re-decides at send time)');

  // ======================================== the customer replies while the dialog is open ===========================================
  const hal = await makeQuote(ph.hal);
  await openDialog(hal);
  assert.equal(await page.locator('#qsend-wa-text').isEditable(), false);
  await inbound(ph.hal, 'Hal Hogan', { type: 'text', text: { body: 'Hello?' } });
  await page.waitForFunction(() => /^Available/.test(document.getElementById('qsend-wa-state').textContent));
  assert.equal(await page.locator('#qsend-wa-text').isEditable(), true); assert.match(await page.inputValue('#qsend-wa-text'), /^Hi Hal, please find attached your quotation /);
  assert.match(await page.textContent('#qsend-wa-note'), /sent with the PDF/);
  await page.click('#qsend-cancel');
  ok('if the customer replies while the dialog is open the box becomes the editable caption again, with the usual wording');

  // ======================================== phone ====================================================================================
  const mctx = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
  const mp = await mctx.newPage(); mp.on('pageerror', (e) => errors.push('mobile: ' + e.message));
  await mp.goto('http://127.0.0.1:5055/');
  await mp.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await mp.waitForSelector('#app:not([hidden])');
  const mq = await (async () => { const id = await page.evaluate(async (p) => { const f = firebase.app().functions('europe-west1'), s = (await firebase.firestore().doc('quoteSettings/current').get()).data();
    const a = QuoteEngine.current().newAnswers(s.priceList); a.doors = 6; a.drawers = 2; a.options.ess.drawerBox = 'cemux'; return (await f.httpsCallable('createQuote')({ phone: p, requestId: crypto.randomUUID(), answers: a })).data.id; }, ph.brian); return id; })();
  await mp.evaluate((i) => { location.hash = '#quotes/' + i; }, mq);
  await mp.waitForSelector('#qv-send:not([disabled])'); await mp.tap('#qv-send'); await mp.waitForSelector('#qsend-dlg[open]');
  await mp.waitForFunction(() => /Available/.test(document.getElementById('qsend-wa-state').textContent));
  const box = await mp.locator('#qsend-dlg').boundingBox();
  assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 + 1 && box.y + box.height <= 800 + 1, 'the dialog fits the phone: ' + JSON.stringify(box));
  assert.ok(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll');
  await mp.check('#qsend-em'); await mp.locator('#qsend-send').scrollIntoViewIfNeeded();
  const sb = await mp.locator('#qsend-send').boundingBox(); assert.ok(sb && sb.x >= 0 && sb.x + sb.width <= 391, 'the Send button is reachable');
  await mp.screenshot({ path: path.join(SHOTS, 'delivery-mobile-dialog.png') });
  await mp.tap('#qsend-send'); await mp.waitForSelector('#qsend-results:not([hidden])', { timeout: 90000 });
  await mp.waitForFunction(() => document.querySelectorAll('#qsend-res-list li[data-state="sent"]').length === 2);
  const rb = await mp.locator('#qsend-res-close').boundingBox(); assert.ok(rb && rb.x >= 0 && rb.x + rb.width <= 391);
  await mp.screenshot({ path: path.join(SHOTS, 'delivery-mobile-results.png') });
  ok('phone: the Send dialog with both channels fits the screen and scrolls, and the per-channel results are readable and reachable');

  assert.deepEqual(errors, [], 'browser errors: ' + JSON.stringify(errors)); ok('no JavaScript errors in the browser');
  console.log(`ALL ${n} CHECKS PASSED`);
  await browser.close(); web.close(); meta.close(); gmail.close(); process.exit(0);
})().catch(async (e) => {
  console.error('FAILED:', e);
  try { const p = global.__page; await p.screenshot({ path: path.join(SHOTS, 'quote-delivery-FAILED.png') }); } catch (x) { /* ignore */ }
  process.exit(1);
});
