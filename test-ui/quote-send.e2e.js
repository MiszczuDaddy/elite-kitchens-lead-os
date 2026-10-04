'use strict';
// Phase 6 M4 browser test: the customer document and sending. Preview (marked "Draft · not sent"), the document's wording
// (no counts or per-unit prices), Send with a design render (the PDF is made in the page, stored, and the downloaded file is
// byte-for-byte the stored copy), the pipeline effects, the email draft, Send again on an expired quote, a Closed customer,
// and the phone layout. Real page + real functions + emulators. Every name, number and price is made up.
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getAuth } = fnRequire('firebase-admin/auth');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const { getStorage } = fnRequire('firebase-admin/storage');
const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const graph = [];
const meta = http.createServer((req, res) => { req.resume(); req.on('end', () => { graph.push(req.url); res.setHeader('content-type', 'application/json'); res.end('{"messages":[{"id":"wamid.X"}]}'); }); }).listen(9911);
meta.keepAliveTimeout = 0;

const DAY = 86400000, ago = (d) => Timestamp.fromMillis(Date.now() - d * DAY);
const dublin = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(new Date(ms));
const longDate = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); };
const addDays = (k, x) => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + x)).toISOString().slice(0, 10); };
const ph = { anna: '353860000021', cathal: '353860000022' };
const SETTINGS = { vatRate: 13.5, validityDays: 30,
  business: { tradingName: 'Elite Kitchens', signatureName: 'Test Signer', phone: '01 000 0000', email: 'quotes@example.com', web: 'www.example.com', address: 'Test Street, Dublin', vatNumber: 'IE0000000X' },
  priceList: { options: { ess: { perDoor: 313.37, perTopBox: 171.17 }, prem: { perDoor: 323.41, perTopBox: 181.19 }, pp: { perDoor: 333.53, perTopBox: 191.29 } },
    drawerBoxes: { cemux: 19.19, blum: 29.29 }, glazing: { small: 43.43, large: 91.91 }, extras: [{ name: 'Pull-out bin', unit: 'per unit', price: 77.71 }] } };
const pagesOf = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
// html2pdf stores each A4 page as one JPEG: pull them out exactly as stored, for the owner's design review.
function savePages(buf, prefix) {
  const s = buf.toString('latin1'); let i = 0, k = 0;
  for (;;) { const at = s.indexOf('/DCTDecode', i); if (at < 0) break; const st = s.indexOf('stream', at) + 6, start = st + (s[st] === '\r' ? 2 : 1), end = s.indexOf('endstream', start);
    fs.writeFileSync(path.join(SHOTS, `${prefix}-${++k}.jpg`), buf.subarray(start, end)); i = end; }
  return k;
}

(async () => {
  initializeApp({ projectId: 'demo-leados', storageBucket: 'demo-leados.firebasestorage.app' });
  const db = getFirestore(), bucket = getStorage().bucket();
  const seed = async (id, conv, contact) => {
    await db.doc('conversations/' + id).set({ phone: id, name: contact.name, createdAt: ago(10), updatedAt: ago(1), lastMessage: 'Hi', unreadCount: 0, ...conv });
    await db.doc('contacts/' + id).set({ phone: id, createdAt: ago(10), ...contact });
  };
  await seed(ph.anna, {}, { name: 'Anna Murphy', email: 'anna@example.com', address: '12 Main Street, Swords, K67 AB12', location: 'Swords' });
  await seed(ph.cathal, { inboxStatus: 'closed', stageDates: { closed: ago(6) } }, { name: 'Cathal Closed', address: '3 Hill Road' });
  const quotesOf = async (p) => (await db.collection('quotes').where('phone', '==', p).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const conv = async (p) => (await db.doc('conversations/' + p).get()).data();
  const contact = async (p) => (await db.doc('contacts/' + p).get()).data();
  const version = async (id, v) => (await db.doc(`quotes/${id}/versions/${v}`).get()).data();

  const u = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true });
  const token = await getAuth().createCustomToken(u.uid);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage(); global.__page = page;
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const field = (f) => page.locator(`#q-quote-view [data-field="${f}"]`);
  const opened = [];
  await page.exposeFunction('__opened', (url) => { opened.push(url); });

  console.log('QUOTE SEND E2E: real page + real functions + emulators');
  await page.goto('http://127.0.0.1:5055/');
  await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await page.waitForSelector('#app:not([hidden])');
  await page.evaluate(() => { window.open = (u) => { window.__opened(String(u)); return null; }; });            // email drafts and PDF links are recorded, not opened
  await page.evaluate(async (s) => {
    const f = firebase.app().functions('europe-west1');
    await f.httpsCallable('saveQuoteSettings')(s); await f.httpsCallable('setQuoteNumbering')({ next: 34 });
  }, SETTINGS);

  // ---- a draft, previewed: the document's wording, marked as not sent ----
  await page.locator(`.conv[data-phone="${ph.anna}"]`).click();
  await page.waitForSelector('#details:not([hidden])');
  await page.waitForFunction(() => /No quotes yet/.test(document.getElementById('d-quotes-list').textContent));
  await page.click('#d-quote-new');
  await page.waitForSelector('#q-quote-view .qb');
  await field('doors').fill('37'); await field('topBoxes').fill('11'); await field('drawers').fill('13');
  await field('options.ess.drawerBox').selectOption('cemux');
  await field('options.prem.on').check(); await field('options.prem.drawerBox').selectOption('blum');
  await field('worktop.on').check(); await field('worktop.price').fill('1450');
  await field('glazing.small').fill('2');
  await page.locator('#q-quote-view .qb-extras[data-list="extras"] .qb-add-select').selectOption({ index: 1 });
  await page.click('#qv-save');
  await page.waitForFunction(() => /Draft saved/.test(document.getElementById('q-toast').textContent));
  const q = (await quotesOf(ph.anna))[0];
  assert.equal(q.ref, 'EK-0034');
  const v1draft = await version(q.id, 1);
  await page.click('#qv-preview');
  await page.waitForSelector('#qdoc-dlg[open] #qdoc-page iframe');
  await page.waitForFunction(() => { const f = document.querySelector('#qdoc-page iframe'); return f && f.contentDocument && /Your options/.test(f.contentDocument.body.innerText); });
  const docText = await page.evaluate(() => document.querySelector('#qdoc-page iframe').contentDocument.body.innerText);
  assert.match(docText, /Draft · not sent/i);
  assert.match(docText, /EK-0034-v1/); assert.match(docText, /Dear Anna,/); assert.match(docText, /12 Main Street, Swords, K67 AB12/);
  for (const o of v1draft.sheet.options) assert.ok(docText.includes(o.name) && docText.includes('€' + o.incVat.toLocaleString('en-IE')), `${o.name} and its price`);
  assert.match(docText, /Every option includes/); assert.match(docText, /2 small glazed door cabinets/); assert.match(docText, /Pull-out bin/);
  assert.match(docText, /Laminate worktops are not covered against water damage/);
  assert.match(docText, /30%[\s\S]*deposit[\s\S]*70%[\s\S]*on completion[\s\S]*6-month[\s\S]*snagging/);
  assert.match(docText, new RegExp(`valid until ${longDate(addDays(dublin(Date.now()), 30))}`));
  for (const secret of ['313.37', '171.17', '323.41', '181.19', '19.19', '29.29', '43.43', '77.71']) assert.ok(!docText.includes(secret), 'per-unit price ' + secret + ' printed');
  const issue = dublin(Date.now()), noDates = docText.replace(/EK-0034-v1/g, '').split(longDate(issue)).join('').split(longDate(addDays(issue, 30))).join('');
  for (const count of ['37', '11', '13']) assert.ok(!new RegExp(`(^|[^\\d,.])${count}([^\\d,.]|$)`).test(noDates), 'count ' + count + ' printed');
  assert.ok(!/warrant|guarantee/i.test(docText), 'no workmanship-warranty wording');
  await page.screenshot({ path: path.join(SHOTS, 'quote-preview.png') });
  await page.click('#qdoc-close');
  ok('Preview shows the customer document, marked "Draft · not sent": options and prices, wording, terms and validity, with no counts or per-unit prices');

  // ---- send: the PDF with a design render, stored exactly as downloaded; the pipeline moves as agreed ----
  await page.click('#qv-send');
  await page.waitForSelector('#qsend-dlg[open]');
  assert.match(await page.textContent('#qsend-title'), /Send EK-0034 v1/);
  assert.match(await page.textContent('#qsend-facts'), /12 Main Street, Swords[\s\S]*anna@example\.com/);
  const dearest = v1draft.sheet.options.find((o) => o.key === v1draft.sheet.dearest);
  assert.equal(await page.inputValue('#qsend-value'), '€' + dearest.incVat.toLocaleString('en-IE'));
  assert.match(await page.textContent('#qsend-effect'), new RegExp(`Anna Murphy will move from New lead to Quoted\\. Pipeline value set to €${dearest.incVat.toLocaleString('en-IE')}`));
  assert.equal(await page.isVisible('#qsend-reopen-row'), false);
  await page.setInputFiles('#qsend-renders', path.join(ROOT, 'public/brand/elite-kitchens-logo.png'));
  await page.waitForFunction(() => /1 render added/.test(document.getElementById('qsend-progress').textContent));
  await page.click('#qsend-go');
  await page.waitForSelector('#qsend-done:not([hidden])', { timeout: 60000 });
  assert.match(await page.textContent('#qsend-done-text'), /EK-0034 v1 is marked sent[\s\S]*Anna Murphy moved from New lead to Quoted/);
  const v1 = await version(q.id, 1);
  assert.equal(v1.state, 'sent');
  const [stored] = await bucket.file(v1.pdf.path).download();
  assert.equal(stored.subarray(0, 5).toString(), '%PDF-');
  assert.equal(crypto.createHash('sha256').update(stored).digest('hex'), v1.pdf.sha256);
  const downloaded = Buffer.from(await page.evaluate(async () => { const r = await fetch(document.getElementById('qsend-download').href); return Array.from(new Uint8Array(await r.arrayBuffer())); }));
  assert.ok(downloaded.equals(stored), 'the downloaded PDF is byte-for-byte the stored copy');
  assert.equal(await page.getAttribute('#qsend-download', 'download'), 'EliteKitchens-EK-0034-v1.pdf');
  assert.ok(pagesOf(stored) >= 2, 'the quote plus a page for the render');
  savePages(stored, 'quote-pdf-sent-page');
  assert.equal((await conv(ph.anna)).inboxStatus, 'quoted');
  assert.equal((await contact(ph.anna)).quoteValue, dearest.incVat);
  assert.deepEqual(v1.customer, { name: 'Anna Murphy', email: 'anna@example.com', address: '12 Main Street, Swords, K67 AB12', phone: ph.anna });
  assert.equal(graph.length, 0, 'nothing went to WhatsApp');
  ok(`Send makes the PDF (${pagesOf(stored)} pages, with the render), stores it, and the file offered for download is byte-for-byte the stored copy; New lead -> Quoted, value set to the dearest option`);

  // ---- the email draft ----
  await page.click('#qsend-email');
  await page.waitForFunction(() => true);
  const mail = new URL(opened.pop());
  assert.equal(mail.origin + mail.pathname, 'https://mail.google.com/mail/');
  assert.equal(mail.searchParams.get('to'), 'anna@example.com');
  assert.equal(mail.searchParams.get('su'), 'Elite Kitchens — Kitchen Quote EK-0034 v1');
  assert.match(mail.searchParams.get('body'), /^Hi Anna,[\s\S]*your kitchen quote EK-0034 v1[\s\S]*2 options[\s\S]*valid for 30 days[\s\S]*Test Signer\nElite Kitchens\n01 000 0000 \| quotes@example\.com$/);
  await page.click('#qsend-close');
  await page.waitForSelector('#q-quote-view .qv-sent');
  ok('Email draft opens Gmail with the customer\'s address, the subject and the usual wording (the PDF is attached by hand)');

  // ---- the stored PDF can be opened again from the quote ----
  await page.locator('#q-quote-view .qv-versions button:has-text("PDF")').click();
  await page.waitForFunction((k) => true, null);
  for (let i = 0; i < 50 && !opened.length; i++) await sleep(100);
  const link = opened.pop();
  assert.ok(link.startsWith('data:application/pdf;base64,'), 'the emulator answers with the file itself');
  assert.ok(Buffer.from(link.split(',')[1], 'base64').equals(stored));
  ok('a sent version\'s PDF opens from the quote (the stored file)');

  // ---- send again on an expired quote: a new version, same prices, new dates; the stage stays Quoted ----
  await db.doc('quotes/' + q.id).update({ validUntil: '2026-01-31', 'sent.validUntil': '2026-01-31' });
  await page.waitForFunction(() => /Expired/.test(document.querySelector('#q-quote-view .qv-banner').textContent));
  await page.click('#qv-renew');
  await page.waitForSelector('#qsend-dlg[open]');
  assert.match(await page.textContent('#qsend-title'), /Send EK-0034 again \(as v2\)/);
  assert.match(await page.textContent('#qsend-effect'), /Anna Murphy stays in Quoted/);
  await page.fill('#qsend-value', '');
  await page.click('#qsend-go');
  await page.waitForSelector('#qsend-done:not([hidden])', { timeout: 60000 });
  const v2 = await version(q.id, 2), q2 = (await quotesOf(ph.anna))[0];
  assert.deepEqual(v2.sheet, v1.sheet);
  assert.equal(v2.state, 'sent'); assert.equal(q2.sentVersion, 2);
  assert.equal(q2.validUntil, addDays(dublin(Date.now()), 30));
  assert.equal((await contact(ph.anna)).quoteValue, dearest.incVat);
  assert.equal((await bucket.getFiles({ prefix: `quotes/${ph.anna}/${q.id}/` }))[0].length, 2);
  await page.click('#qsend-close');
  await page.waitForFunction(() => !/Expired/.test(document.querySelector('#q-quote-view .qv-banner').textContent));
  ok('Send again on an expired quote sends v2 with the same prices and a new 30-day validity; the stage and value are left as they are');

  // ---- a Closed customer stays Closed unless "Reopen" is ticked ----
  const qc = await page.evaluate(async (phone) => (await firebase.app().functions('europe-west1').httpsCallable('createQuote')({ phone, requestId: 'e2e-' + Date.now() + '-closed' })).data.id, ph.cathal);
  await page.evaluate((id) => { location.hash = '#quotes/' + id; }, qc);
  await page.waitForSelector('#qv-send:not([disabled])');
  await page.click('#qv-send'); await page.waitForSelector('#qsend-dlg[open]');
  assert.equal(await page.isVisible('#qsend-reopen-row'), true);
  assert.equal(await page.isChecked('#qsend-reopen'), false);
  assert.match(await page.textContent('#qsend-effect'), /Cathal Closed stays in Closed/);
  assert.match(await page.textContent('#qsend-warn'), /no email address/);
  await page.fill('#qsend-value', '');
  await page.click('#qsend-go');
  await page.waitForSelector('#qsend-done:not([hidden])', { timeout: 60000 });
  assert.equal((await conv(ph.cathal)).inboxStatus, 'closed');
  await page.click('#qsend-email');
  for (let i = 0; i < 30 && !opened.length; i++) await sleep(100);
  assert.equal(new URL(opened.pop()).searchParams.get('to'), null, 'no recipient when there is no email');
  await page.click('#qsend-close');
  ok('sending to a Closed customer offers an unticked "Reopen"; left unticked they stay Closed; with no email the draft has no recipient');

  // ---- phone ----
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const mp = await mctx.newPage(); mp.on('pageerror', (e) => errors.push('mobile: ' + e.message));
  await mp.goto('http://127.0.0.1:5055/');
  await mp.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await mp.waitForSelector('#app:not([hidden])');
  const qd = await mp.evaluate(async (phone) => (await firebase.app().functions('europe-west1').httpsCallable('createQuote')({ phone, requestId: 'e2e-' + Date.now() + '-phone' })).data.id, ph.anna);
  await mp.evaluate((id) => { location.hash = '#quotes/' + id; }, qd);
  await mp.waitForSelector('#qv-preview');
  await mp.tap('#qv-preview');
  await mp.waitForSelector('#qdoc-dlg[open] #qdoc-page iframe');
  await mp.waitForFunction(() => document.getElementById('qdoc-page').style.transform.startsWith('scale('));
  assert.equal(await mp.evaluate(() => document.getElementById('qdoc-scroll').scrollWidth <= document.getElementById('qdoc-scroll').clientWidth + 1), true, 'the A4 page is scaled to the phone width');
  await mp.screenshot({ path: path.join(SHOTS, 'quote-preview-phone.png') });
  await mp.tap('#qdoc-close');
  await mp.tap('#qv-send'); await mp.waitForSelector('#qsend-dlg[open]');
  assert.equal(await mp.inputValue('#qsend-value'), '', 'a €0 quote proposes no pipeline value');
  const box = await mp.locator('#qsend-dlg').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, 'the Send dialog fits the phone screen');
  await mp.screenshot({ path: path.join(SHOTS, 'quote-send-phone.png') });
  await mp.tap('#qsend-cancel');
  ok('phone: the preview shows the whole A4 page scaled to the screen; the Send dialog fits (and a €0 quote proposes no pipeline value)');
  await mctx.close();

  assert.deepEqual(errors, [], 'browser errors: ' + JSON.stringify(errors)); ok('no JavaScript errors in the browser');
  await browser.close(); web.close(); meta.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch(async (e) => {
  console.error('\nFAILED:', e.stack || e.message || e);
  try { const p = global.__page; await p.screenshot({ path: path.join(SHOTS, 'quote-send-FAILED.png') }); console.error('send:', await p.evaluate(() => [document.getElementById('qsend-progress').textContent, document.getElementById('qsend-err').textContent, document.getElementById('q-toast').textContent].join(' | '))); } catch (x) { /* no page */ }
  process.exit(1);
});
