'use strict';
// The Emails page, in a REAL browser (docs/EMAIL_LIST.md): "Emails" in the menu opens its own page with ONE ROW PER CUSTOMER, newest conversation first (who, when, how many emails, the newest one's kind, subject and a short preview)
// and, beside it, the chosen customer's WHOLE conversation in one window (every email, sent and received, oldest first); All / Received / Sent / Follow-ups / Not confirmed filter it and the search box finds a name, subject, address or quote number; a new email appears while it is open;
// it opens and closes like the other pages (menu, direct address, Back); customers' names are shown as text, never as code; and on a phone it is one thing at a time. The entries are written the way the server writes them
// (the server paths are tested in functions/test/email-list.test.js). Every name and address is made up. Run: bash test-ui/run.sh email-list.e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const { getAuth } = fnRequire('firebase-admin/auth');
const ROOT = path.join(__dirname, '..'), URL0 = 'http://127.0.0.1:5072/';
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, msg, t = 20000) { const s = Date.now(); while (Date.now() - s < t) { try { if (await fn()) return; } catch (e) { /* not yet */ } await sleep(120); } throw new Error('timed out waiting for: ' + msg); }
let n = 0; const ok = (m) => console.log(`  PASS ${++n}. ${m}`);
const cfgJs = `firebase.initializeApp({apiKey:'fake',projectId:'demo-leados',authDomain:'localhost',storageBucket:'demo-leados.firebasestorage.app'});
firebase.auth().useEmulator('http://127.0.0.1:9099',{disableWarnings:true});
firebase.firestore().useEmulator('127.0.0.1',8085);
firebase.app().functions('europe-west1').useEmulator('127.0.0.1',5001);
firebase.storage().useEmulator('127.0.0.1',9199);`;
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const web = http.createServer((req, res) => {
  const u = req.url.split('?')[0]; if (u === '/__/firebase/init.js') { res.setHeader('content-type', 'text/javascript'); return res.end(cfgJs); }
  const m = /^\/__\/firebase\/[\d.]+\/(.+)$/.exec(u), f = m ? path.join(ROOT, 'node_modules/firebase', m[1]) : path.join(ROOT, 'public', u === '/' ? 'index.html' : u);
  fs.readFile(f, (e, d) => { if (e) { res.statusCode = 404; return res.end('nf'); } res.setHeader('content-type', TYPES[path.extname(f)] || 'application/octet-stream'); res.setHeader('cache-control', 'no-store'); res.end(d); });
}).listen(5072);
// the fake Gmail (the functions emulator is told to use it: MAIL_API_BASE in test-ui/run.sh): it records what would be sent
const mails = [];
const gmail = http.createServer((req, res) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => { try { mails.push(Buffer.from(JSON.parse(Buffer.concat(c).toString()).raw, 'base64url').toString('utf8')); } catch (e) { /* ignore */ } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'gsent' + mails.length, threadId: 't' + mails.length })); }); }).listen(9913);

(async () => {
  initializeApp({ projectId: 'demo-leados' }); const db = getFirestore(), T = (ms) => Timestamp.fromMillis(ms), NOW = Date.now(), MIN = 60000, DAY = 86400000;
  const token = await getAuth().createCustomToken((await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true })).uid);
  const P = { anna: '353871200001', bob: '353871200002', cara: '353871200003' };
  const customer = async (phone, name) => {
    await db.doc('contacts/' + phone).set({ phone, name, email: phone + '@example.com', createdAt: T(NOW - 10 * DAY) });
    await db.doc('conversations/' + phone).set({ phone, name, inboxStatus: 'quoted', unreadCount: 0, lastMessage: 'Hi, as discussed, your quotation', lastMessageDirection: 'out', createdAt: T(NOW - 10 * DAY), updatedAt: T(NOW - 3 * DAY) });
  };
  await customer(P.anna, 'Anna Apple'); await customer(P.bob, 'Bob Byrne'); await customer(P.cara, '"><script>window.__pwned=1</script>Cara <b>Cole</b>');
  const entry = (id, phone, name, direction, kind, subject, snippet, atMs, extra = {}) => db.doc('emailLog/' + id).set({ phone, name, direction, kind, subject, snippet, email: phone + '@example.com', at: T(atMs), confirmed: true, ...extra });
  const chatEmail = (phone, id, o) => db.doc(`conversations/${phone}/emails/${id}`).set({ attachments: [], references: [], ...o });
  const FULL_IN = 'Hi, the price is fine. Can you call me tomorrow after 5?\n\nI would also like to ask about the island lighting and when the delivery could be.\n\nThanks, Anna';
  async function seed() {
    await entry('g_1', P.anna, 'Anna Apple', 'in', 'customer', 'Re: Your Elite Kitchens quote EK-0112', FULL_IN.replace(/\s+/g, ' ').slice(0, 200), NOW - 20 * MIN);
    await chatEmail(P.anna, 'g_1', { direction: 'in', subject: 'Re: Your Elite Kitchens quote EK-0112', fromEmail: P.anna + '@example.com', body: FULL_IN, createdAt: T(NOW - 20 * MIN), attachments: [{ name: 'plan.pdf', size: 1234 }] });
    await entry(P.bob + '_fu_1', P.bob, 'Bob Byrne', 'out', 'followup', 'Your kitchen enquiry with Elite Kitchens', 'Hi Bob, Thanks for your enquiry with Elite Kitchens. I just wanted to check in', NOW - 3 * DAY, { by: 'staff@test.dev' });
    await chatEmail(P.bob, 'fu_1', { direction: 'out', subject: 'Your kitchen enquiry with Elite Kitchens', to: P.bob + '@example.com', body: 'Hi Bob,\n\nThanks for your enquiry with Elite Kitchens. I just wanted to check in, in case my earlier message got lost.\n\nKind regards,\nElite Kitchens', createdAt: T(NOW - 3 * DAY), by: 'staff@test.dev', kind: 'followup' });
    await entry(P.anna + '_qf_1', P.anna, 'Anna Apple', 'out', 'quotefollowup', 'Your Elite Kitchens quote EK-0112', 'Hi Anna, I just wanted to check that you received your quote (EK-0112)', NOW - 2 * DAY, { quoteRef: 'EK-0112', by: 'staff@test.dev' });
    await chatEmail(P.anna, 'qf_1', { direction: 'out', subject: 'Your Elite Kitchens quote EK-0112', to: P.anna + '@example.com', body: 'Hi Anna,\n\nI just wanted to check that you received your quote (EK-0112), and to see if you have any questions about it.\n\nKind regards,\nElite Kitchens', createdAt: T(NOW - 2 * DAY), by: 'staff@test.dev', kind: 'quotefollowup' });
    await entry('qd_1', P.bob, 'Bob Byrne', 'out', 'quote', 'Elite Kitchens — Kitchen Quote EK-0118 v1', 'Dear Bob, Please find attached your quotation', NOW - 5 * DAY, { quoteRef: 'EK-0118', confirmed: false, by: 'staff@test.dev' });
    await entry(P.anna + '_reply_1', P.anna, 'Anna Apple', 'out', 'reply', 'Re: Your Elite Kitchens quote EK-0112', 'Of course, I will ring you tomorrow at 5.', NOW - 10 * MIN, { by: 'staff@test.dev' });
    await chatEmail(P.anna, 'reply_1', { direction: 'out', subject: 'Re: Your Elite Kitchens quote EK-0112', to: P.anna + '@example.com', body: 'Of course, I will ring you tomorrow at 5.\n\nThe delivery depends on the doors: about six weeks.', createdAt: T(NOW - 10 * MIN), by: 'staff@test.dev', kind: 'reply' });
  }
  await seed();
  await entry('g_2', P.cara, '"><script>window.__pwned=1</script>Cara <b>Cole</b>', 'in', 'customer', '<img src=x onerror=window.__pwned=1>', 'Thanks <script>window.__pwned=1</script>', NOW - 40 * MIN);
  await chatEmail(P.cara, 'g_2', { direction: 'in', subject: '<img src=x onerror=window.__pwned=1>', fromEmail: P.cara + '@example.com', body: 'Thanks <script>window.__pwned=1</script> <b>bold</b>', createdAt: T(NOW - 40 * MIN) });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' }), errors = []; global.__errors = errors;
  const open = async (viewport, phone, hash) => {
    const ctx = await browser.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) }), page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(URL0 + (hash || '')); await page.waitForSelector('#login:not([hidden])'); await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])');
    if (!hash) await page.evaluate(() => { if (location.hash === '#today') location.hash = ''; }); return { ctx, page };
  };
  console.log('EMAIL LIST E2E: real page + real functions + emulators');
  const { page } = await open({ width: 1360, height: 900 });
  const rows = () => page.$$eval('#emp-list .ea-open', (els) => els.map((e) => ({ name: e.querySelector('.ea-name').textContent, kind: e.querySelector('.ea-kind').textContent, subject: e.querySelector('.ea-subject').textContent, snip: e.querySelector('.ea-snip').textContent, warn: !!e.querySelector('.ea-warn'), ref: (e.querySelector('.ea-ref') || {}).textContent || null, id: e.dataset.kind, phone: e.dataset.phone, count: e.querySelector('.ea-count').textContent })));
  const ids = async () => (await rows()).map((r) => r.id);
  const view = () => page.evaluate(() => document.getElementById('app').dataset.view);
  const cards = () => page.$$eval('#emp-thread .emp-msg', (els) => els.map((e) => ({ kind: e.dataset.kind, dir: e.classList.contains('emp-in') ? 'in' : 'out', badge: e.querySelector('.ea-kind').textContent, subject: e.querySelector('.emp-msg-subject').textContent, meta: (e.querySelector('.emp-msg-meta') || {}).textContent || '', body: e.querySelector('.emp-d-body').textContent, note: (e.querySelector('.emp-msg-note') || {}).textContent || '', warn: !!e.querySelector('.emp-d-warn') })));
  const thread = () => page.innerText('#emp-thread');

  // ------------------------------------------------------------------ 1. its own page, from the menu; ONE ROW PER CUSTOMER, newest conversation first
  assert.equal(await page.locator('.pane-head .icon-btn').count(), 1, 'the Inbox header still has only the + button');
  await page.click('#nav-emails'); await page.waitForSelector('#emails', { state: 'visible' }); await until(async () => (await rows()).length === 3, 'three customers');
  assert.equal(await view(), 'emails'); assert.equal(await page.evaluate(() => location.hash), '#emails'); assert.equal(await page.isVisible('#list'), false, 'the Inbox list is not on screen: this is its own page');
  assert.equal(await page.getAttribute('#nav-emails', 'aria-current'), 'page'); assert.equal(await page.getAttribute('#nav-inbox', 'aria-current'), null, 'the menu shows where you are');
  const all = await rows();
  assert.deepEqual(all.map((r) => r.name), ['Anna Apple', '"><script>window.__pwned=1</script>Cara <b>Cole</b>', 'Bob Byrne'], 'ONE row per customer (six emails, three customers), the customer with the newest email first: Anna (reply 10 min ago), Cara (40 min), Bob (3 days)');
  assert.deepEqual(all.map((r) => r.count), ['3 emails', '1 email', '2 emails'], 'how many emails each customer has');
  assert.deepEqual(all.map((r) => r.id), ['reply', 'customer', 'followup'], 'each row shows the customer\'s newest email'); assert.deepEqual(all.map((r) => r.kind), ['↗ Sent · your reply', '↙ Received', '↗ Sent · follow-up']);
  assert.equal(all[0].snip, 'Of course, I will ring you tomorrow at 5.'); assert.equal(all[0].ref, null, 'Anna\'s newest email (her reply) has no quote number on it');
  ok('"Emails" in the menu opens its own page (the Inbox list is replaced and the menu shows where you are) with ONE row per customer, newest conversation first: who, how many emails, and the newest one\'s kind, subject and preview');

  // ------------------------------------------------------------------ 2. filters and search (they pick customers; the row shows their newest matching email)
  assert.deepEqual(all.map((r) => r.warn), [false, false, true], 'Bob has an email Google did not confirm (the older quote email): his row says so even though it is not his newest');
  assert.match(await page.locator('#emp-list .ea-warn').getAttribute('title'), /Google did not confirm/);
  const chip = (f) => page.click(`#emails .ea-chip[data-f="${f}"]`);
  await chip('in'); assert.deepEqual(await ids(), ['customer', 'customer'], 'customers who have written to you'); assert.equal(await page.getAttribute('#emails .ea-chip[data-f="in"]', 'aria-pressed'), 'true');
  await chip('out'); assert.deepEqual(await ids(), ['reply', 'followup'], 'Anna (newest sent: her reply) and Bob (his follow-up)'); assert.deepEqual((await rows()).map((r) => r.count), ['2 emails', '2 emails']);
  await chip('followups'); assert.deepEqual(await ids(), ['quotefollowup', 'followup'], 'both kinds of follow-up'); assert.deepEqual((await rows()).map((r) => r.count), ['1 email', '1 email']);
  await chip('unconfirmed'); assert.deepEqual(await ids(), ['quote'], 'only what Google did not confirm'); await chip('all'); assert.equal((await rows()).length, 3);
  await page.fill('#emp-search', 'bob'); assert.deepEqual(await ids(), ['followup'], 'a name: one customer'); await page.fill('#emp-search', 'EK-0112'); assert.deepEqual(await ids(), ['reply'], 'a quote number (in the subject or on the email): Anna, with her three emails'); assert.equal((await rows())[0].count, '3 emails');
  await page.fill('#emp-search', 'six weeks'); assert.equal((await rows()).length, 0, 'the search looks at the preview, not the whole email: "six weeks" is only in the body of a reply'); assert.match(await page.innerText('#emp-note'), /No emails match/);
  await page.fill('#emp-search', ''); await chip('out'); await page.fill('#emp-search', 'anna'); assert.deepEqual(await ids(), ['reply'], 'filter and search together'); await page.fill('#emp-search', ''); await chip('all');
  ok('Received / Sent / Follow-ups / Not confirmed pick the customers; the search finds a name or a quote number, together with a filter; a customer with an email Google did not confirm is flagged');

  // ------------------------------------------------------------------ 3. one customer, one window: the whole conversation, oldest first
  await page.click('#emp-list .ea-open[data-phone="' + P.anna + '"]'); await page.waitForSelector('#emp-detail', { state: 'visible' });
  await until(async () => { const t = await thread(); return t.includes('island lighting') && t.includes('about six weeks') && t.includes('any questions about it'); }, 'the whole text of all three emails arrives');
  assert.equal(await page.innerText('#emp-d-name'), 'Anna Apple'); assert.equal(await page.innerText('#emp-d-sub'), `3 emails · ${P.anna}@example.com`);
  const ac = await cards(); assert.equal(ac.length, 3, 'all of Anna\'s emails are in ONE window');
  assert.deepEqual(ac.map((c) => c.kind), ['quotefollowup', 'customer', 'reply'], 'oldest first, the newest at the bottom (like the chat)'); assert.deepEqual(ac.map((c) => c.dir), ['out', 'in', 'out']); assert.deepEqual(ac.map((c) => c.badge), ['↗ Sent · quote follow-up', '↙ Received', '↗ Sent · your reply']);
  assert.match(ac[0].body, /^Hi Anna,[\s\S]*any questions about it\./); assert.match(ac[1].body, /Thanks, Anna$/); assert.match(ac[2].body, /about six weeks/); assert.equal(ac[1].subject, 'Re: Your Elite Kitchens quote EK-0112');
  assert.equal(ac[1].meta, `From ${P.anna}@example.com`); assert.equal(ac[2].meta, `To ${P.anna}@example.com · sent by staff@test.dev`); assert.match(ac[1].note, /Attachments[\s\S]*plan\.pdf/); assert.equal(ac[0].note, '');
  assert.doesNotMatch(await thread(), /Bob|Dear Bob|Please find attached your quotation/, 'no one else\'s email is in her conversation');
  assert.equal(await page.getAttribute('#emp-list .ea-open[data-phone="' + P.anna + '"]', 'aria-current'), 'true', 'the chosen customer is marked');
  const last = await page.locator('#emp-thread .emp-msg').last().boundingBox(); assert.ok(last.y + last.height <= 900 + 1, 'the newest email is on screen');
  await page.click('#emp-list .ea-open[data-phone="' + P.bob + '"]'); await until(async () => (await cards()).length === 2, 'Bob\'s conversation');
  const bc = await cards(); assert.deepEqual(bc.map((c) => c.kind), ['quote', 'followup'], 'Bob: the quote email (5 days ago), then the follow-up (3 days ago)');
  await until(async () => (await cards())[1].body.includes('in case my earlier message got lost'), 'the follow-up as it was sent'); assert.equal((await cards())[1].meta, `To ${P.bob}@example.com · sent by staff@test.dev`);
  assert.equal(bc[0].body, 'Dear Bob, Please find attached your quotation'); assert.match(bc[0].note, /wording of a quote email and its PDF are not kept/); assert.equal(bc[0].warn, true, 'the not-confirmed quote email explains itself in the conversation'); assert.equal(bc[1].warn, false);
  assert.doesNotMatch(await thread(), /island lighting|Anna/, 'a different customer: a different conversation');
  await page.click('#emp-chat'); await page.waitForSelector('#thread:not([hidden])'); await until(async () => (await page.evaluate(() => location.hash)).includes(P.bob), 'Bob\'s chat is open'); assert.match(await page.innerText('#t-name'), /Bob Byrne/); assert.equal(await view(), 'thread');
  assert.equal(await page.isVisible('#emails'), false, 'opening a chat closes the Emails page');
  ok('choosing a customer shows ALL their emails in one window, oldest first and the newest at the bottom: sent and received told apart, the full text from the chat record, who sent it, attachments named; a quote email shows its preview and says the rest is not kept; another customer is another conversation; "Open chat" opens the chat');

  // ------------------------------------------------------------------ 3b. write a reply by email from the conversation (the same window as in the chat)
  await page.click('#nav-emails'); await page.waitForSelector('#emails', { state: 'visible' }); await until(async () => (await rows()).length === 3, 'back on the page');
  await page.click('#emp-list .ea-open[data-phone="' + P.bob + '"]'); await until(async () => (await cards()).length === 2, 'Bob\'s conversation');
  assert.equal((await page.innerText('#emp-reply')).trim(), 'Write an email', 'Bob has never written: a new email, not a reply');
  await page.click('#emp-reply'); await page.waitForSelector('#em-dlg[open]'); assert.equal(await page.innerText('#em-title'), 'Email Bob Byrne'); assert.equal(await page.innerText('#em-to'), `To: ${P.bob}@example.com`); assert.equal(await page.isVisible('#em-last'), false, 'no email of theirs to show'); assert.equal(await page.inputValue('#em-subject'), '');
  await page.click('#em-cancel'); await page.waitForFunction(() => !document.getElementById('em-dlg').open); assert.equal(mails.length, 0, 'closing the window sends nothing');
  await page.click('#emp-list .ea-open[data-phone="' + P.anna + '"]'); await until(async () => { const t = await thread(); return t.includes('island lighting') && t.includes('about six weeks'); }, 'Anna\'s conversation, in full');
  assert.equal((await page.innerText('#emp-reply')).trim(), 'Reply by email', 'Anna wrote to you: a reply');
  await page.click('#emp-reply'); await page.waitForSelector('#em-dlg[open]');
  assert.equal(await page.innerText('#em-title'), 'Email Anna Apple'); assert.equal(await page.innerText('#em-to'), `To: ${P.anna}@example.com`); assert.equal(await page.inputValue('#em-subject'), 'Re: Your Elite Kitchens quote EK-0112');
  const lastBox = await page.innerText('#em-last'); assert.match(lastBox, /Their last email · Re: Your Elite Kitchens quote EK-0112/); assert.match(lastBox, /island lighting/, 'their newest email, in full, is above the box you write in');
  await page.fill('#em-body', 'Thanks Anna, the delivery is about six weeks. I will ring you at 5.'); await page.screenshot({ path: path.join(SHOTS, 'email-reply-window.png') }); await page.click('#em-send'); await page.waitForFunction(() => !document.getElementById('em-dlg').open);
  assert.equal(mails.length, 1, 'one email was sent'); assert.match(mails[0], new RegExp('^To: ' + P.anna + '@example\\.com', 'm')); assert.match(mails[0], /^Subject: Re: Your Elite Kitchens quote EK-0112/m); assert.match(mails[0], /I will ring you at 5\./);
  await until(async () => (await cards()).length === 4, 'the email you sent appears in her conversation'); const sent = (await cards())[3]; assert.deepEqual([sent.kind, sent.dir], ['reply', 'out'], 'at the bottom, as your reply'); assert.match(sent.body, /about six weeks\. I will ring you at 5\./); assert.equal(sent.meta, `To ${P.anna}@example.com · sent by staff@test.dev`);
  await until(async () => (await rows()).find((r) => r.name === 'Anna Apple').count === '4 emails', 'her row counts it'); assert.equal((await rows())[0].name, 'Anna Apple');
  ok('"Reply by email" sits at the bottom of every conversation ("Write an email" when they have never written): it opens the same reply window as in the chat, with their newest email above it; sending delivers it, and it appears at the bottom of their conversation and in the count on their row; closing the window sends nothing');

  // ------------------------------------------------------------------ 4. names and subjects are text, never code
  await page.click('#nav-emails'); await page.waitForSelector('#emails', { state: 'visible' }); await until(async () => (await rows()).length === 3, 'back on the page');
  const cara = (await rows())[1]; assert.ok(cara.name.includes('<script>') && cara.subject.startsWith('<img src=x'), 'shown literally: ' + JSON.stringify([cara.name, cara.subject]));
  await page.click('#emp-list .ea-open[data-phone="' + P.cara + '"]'); await until(async () => (await thread()).includes('<b>bold</b>'), 'the body, as text');
  assert.equal(await page.evaluate(() => window.__pwned || 0), 0, 'nothing ran'); assert.equal(await page.locator('#emails script, #emails img, #emails b').count(), 0, 'no element was created from a name, subject or body');
  ok('a name, subject or body with code in it is shown as text: nothing runs, no element is created from it');

  // ------------------------------------------------------------------ 5. live: a new email moves the customer to the top, and appears at the bottom of an open conversation
  await page.click('#emp-list .ea-open[data-phone="' + P.bob + '"]'); await until(async () => (await cards()).length === 2, 'Bob\'s conversation is open');
  await entry('g_3', P.bob, 'Bob Byrne', 'in', 'customer', 'Re: Your kitchen enquiry', 'Yes, I would love a consultation. Thursday works.', Date.now());
  await until(async () => (await cards()).length === 3, 'the new email appears in the open conversation'); const live = await cards(); assert.equal(live[2].kind, 'customer'); assert.match(live[2].body, /Thursday works/, 'at the bottom');
  await until(async () => (await rows())[0].name === 'Bob Byrne', 'Bob moves to the top of the list'); const top = (await rows())[0]; assert.equal(top.count, '3 emails'); assert.equal(top.snip, 'Yes, I would love a consultation. Thursday works.'); assert.equal((await rows()).length, 3, 'still one row per customer');
  assert.equal(await page.innerText('#emp-d-sub'), `3 emails · ${P.bob}@example.com`);
  ok('a new email moves that customer to the top while the page is open and appears at the bottom of their open conversation, without reloading');

  // ------------------------------------------------------------------ 6. it opens and closes like the other pages
  await page.click('#nav-quotes'); await page.waitForSelector('#emails', { state: 'hidden' }); assert.equal(await view(), 'quotes'); assert.equal(await page.getAttribute('#nav-emails', 'aria-current'), null); assert.equal(await page.getAttribute('#nav-quotes', 'aria-current'), 'page');
  await page.click('#nav-emails'); await page.waitForSelector('#emails', { state: 'visible' }); assert.equal(await view(), 'emails'); assert.equal(await page.getAttribute('#nav-quotes', 'aria-current'), null);
  assert.equal(await page.isVisible('#emp-detail'), false, 'coming back shows the list, not the last conversation');
  await page.click('#nav-assistant'); await page.waitForSelector('#emails', { state: 'hidden' }); assert.equal(await view(), 'assistant');
  await page.click('#nav-emails'); await page.click('#emp-back'); await page.waitForSelector('#emails', { state: 'hidden' }); assert.equal(await view(), 'list'); assert.equal(await page.getAttribute('#nav-inbox', 'aria-current'), 'page');
  await page.goto(URL0 + '#emails'); await page.waitForSelector('#emails', { state: 'visible' }); await until(async () => (await rows()).length >= 3, 'the page opens from its address');
  ok('it opens and closes like the other pages: from the menu, to Quotes and the Assistant and back, Back returns to the Inbox, and the address #emails opens it directly');

  // ------------------------------------------------------------------ 7. empty, then clean data for the screenshots
  await db.collection('emailLog').get().then((x) => Promise.all(x.docs.map((d) => d.ref.delete())));
  await until(async () => /No emails yet/.test(await page.innerText('#emp-note')), 'the empty message');
  await db.doc(`conversations/${P.cara}`).delete(); await db.doc(`conversations/${P.cara}/emails/g_2`).delete(); await customer(P.cara, 'Cara Cole');
  await seed(); await entry('g_9', P.bob, 'Bob Byrne', 'in', 'customer', 'Re: Your Elite Kitchens — Kitchen Quote EK-0118 v1, with a long subject that has to wrap properly on a small screen', 'Hi, the quote looks good, a couple of questions about the worktop and the timing of the fitting. '.repeat(3), NOW - 30 * MIN);
  await until(async () => (await rows()).length === 2, 'two customers again (Anna with three emails, Bob with three)');
  await page.click('#emp-list .ea-open[data-phone="' + P.anna + '"]'); await until(async () => (await thread()).includes('any questions about it'), 'the conversation'); await page.screenshot({ path: path.join(SHOTS, 'email-list-desktop.png') });
  ok('empty: a plain message; with emails again the page is ready for a screenshot (computer)');

  // ------------------------------------------------------------------ 8. a phone: one thing at a time
  const m = await open({ width: 375, height: 812 }, true);
  const fits = async (label) => assert.equal(await m.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scrolling: ' + label);
  const tb = await m.page.locator('#to-emails').boundingBox(); assert.ok(tb && tb.width >= 56 && tb.height >= 56 && tb.x >= 0 && tb.x + tb.width <= 375, 'the Emails button is on screen and big enough to tap');
  await m.page.click('#to-emails'); await m.page.waitForSelector('#emails', { state: 'visible' }); await m.page.waitForSelector('#emp-list .ea-open');
  assert.equal(await m.page.isVisible('#emp-read'), false, 'on a phone: the list alone'); assert.equal(await m.page.isVisible('#emp-list'), true); await fits('list');
  const row = await m.page.locator('#emp-list .ea-open').first().boundingBox(); assert.ok(row.height >= 56 && row.x >= 0 && row.x + row.width <= 376, 'rows fit and are easy to tap: ' + JSON.stringify(row));
  assert.ok((await m.page.locator('#emails .ea-chip').first().boundingBox()).height >= 44, 'the filters are easy to tap'); await m.page.screenshot({ path: path.join(SHOTS, 'email-list-phone.png') });
  await m.page.click('#emp-list .ea-open[data-phone="' + P.bob + '"]'); await m.page.waitForSelector('#emp-detail', { state: 'visible' }); await until(async () => (await m.page.locator('#emp-thread .emp-msg').count()) === 3, 'Bob\'s three emails'); assert.equal(await m.page.isVisible('#emp-list'), false, 'on a phone: the conversation alone'); await fits('conversation'); const back = await m.page.locator('#emp-tolist').boundingBox(); assert.ok(back && back.y >= 0 && back.y < 300 && back.height >= 44, 'the way back stays in view while you read: ' + JSON.stringify(back)); assert.ok(await m.page.locator('#emp-chat').isVisible() && (await m.page.locator('#emp-d-name').boundingBox()).y >= 0, 'the customer\'s name and Open chat stay in view');
  const rb = await m.page.locator('#emp-reply').boundingBox(); assert.ok(rb && rb.y >= 0 && rb.y + rb.height <= 812 && rb.width >= 300 && rb.height >= 44, 'on a phone the reply button is on screen, full width and easy to tap: ' + JSON.stringify(rb));
  await m.page.screenshot({ path: path.join(SHOTS, 'email-read-phone.png') });
  await m.page.click('#emp-tolist'); await m.page.waitForSelector('#emp-list', { state: 'visible' }); assert.equal(await m.page.isVisible('#emp-detail'), false);
  await m.page.click('#emp-back'); await m.page.waitForSelector('#emails', { state: 'hidden' });
  ok('on a 375px phone: the Emails button is easy to tap; the page shows the list of customers, choosing one shows their whole conversation alone with a way back, and Back returns to the Inbox; no sideways scrolling');

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | ')); ok('no console or page errors');
  await browser.close(); web.close(); gmail.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e, '\nPAGE ERRORS:', global.__errors); web.close(); gmail.close(); process.exit(1); });
