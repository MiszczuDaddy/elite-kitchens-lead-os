'use strict';
// Phase 11 browser test: the Today tab, in the real page with the real functions and the emulators. 450+ chats are seeded so a lead that is NOT among the Inbox's 300 newest chats must still show.
// Every name and number is made up. Run: bash test-ui/run.sh today.e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const { getAuth } = fnRequire('firebase-admin/auth');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
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
}).listen(5059);

(async () => {
  initializeApp({ projectId: 'demo-leados' });
  const db = getFirestore();
  const token = await (async () => { const u = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true }); return getAuth().createCustomToken(u.uid); })();
  const now = Date.now(), DAY = 86400000, T = (ms) => Timestamp.fromMillis(ms);
  const AOIFE = '353871110101', BRENDAN = '353871110102', CIARA = '353871110103', DARA = '353871110104', GUS = '353871110105', DAN = '353871110106', CLOSED = '353871110107', THANKS = '353871110108';
  const conv = (phone, name, over = {}) => db.doc('conversations/' + phone).set({ phone, name, createdAt: T(now - 30 * DAY), updatedAt: T(now - DAY), lastMessage: 'Hello', lastMessageDirection: 'out', unreadCount: 0, inboxStatus: 'inbox', projectType: 'Kitchen', location: 'Swords', ...over });
  const contact = (phone, name, over = {}) => db.doc('contacts/' + phone).set({ phone, name, createdAt: T(now - 30 * DAY), ...over });
  // 450 quiet chats: they fill the Inbox's 300-chat list and add nothing to Today
  for (let i = 0; i < 450; i += 400) { const b = db.batch(); for (let j = i; j < Math.min(i + 400, 450); j++) { const p = '3538700' + String(10000 + j); b.set(db.doc('conversations/' + p), { phone: p, name: 'Filler ' + j, createdAt: T(now - 100 * DAY), updatedAt: T(now - (2 + j % 60) * 3600e3), lastMessage: 'Quiet', lastMessageDirection: 'out', lastInboundAt: T(now - 90 * DAY), inboxStatus: 'inbox' }); } await b.commit(); }
  await conv(AOIFE, 'Aoife Allen', { lastMessage: 'Hi, how long does a fitting take?', lastMessageDirection: 'in', lastInboundAt: T(now - 2 * DAY), unreadCount: 1 });
  await conv(BRENDAN, 'Brendan Burke', { lastMessage: 'Good question, I will check with the team.', receptionist: { on: true, paused: 'handover: price question', pausedAt: T(now - 2 * DAY), notifyFailed: { at: T(now - 2 * DAY), why: 'x', tries: 3 } }, lastInboundAt: T(now - 2 * DAY - 3600e3) });
  await conv(CIARA, 'Ciara Walsh', { lastMessage: 'Thanks, I will be in touch.', consult: { needsBooking: true, at: T(now - 2 * DAY), preference: { summary: 'Tuesday afternoons', text: 'Tuesday afternoon', times: 'afternoons' } } });
  await conv(DARA, 'Dara Daly'); await contact(DARA, 'Dara Daly');
  await conv(CLOSED, 'Cathal Closed', { inboxStatus: 'closed', lastMessage: 'Any news?', lastMessageDirection: 'in', lastInboundAt: T(now - 3 * DAY) });
  await conv(THANKS, 'Tara Thanks', { lastMessage: 'Thanks so much!', lastMessageDirection: 'in', lastInboundAt: T(now - 3 * DAY) });
  await conv(GUS, 'Gus Grant', { createdAt: T(now - 90e3), updatedAt: T(now - 400 * DAY), lastMessage: '[template: welcome]', lastMessageType: 'template', receptionist: { on: true, auto: true, paused: null } });   // newest lead, OLDEST chat by activity
  await contact(GUS, 'Gus Grant', { createdAt: T(now - 90e3), metaLead: { leadId: 'LEADGUS001', receivedAt: T(now - 90e3) } });
  await db.doc('leads/LEADGUS001').set({ leadId: 'LEADGUS001', state: 'done', receivedAt: T(now - 90e3), welcome: { state: 'failed' } });
  await conv(DAN, 'Dan Doyle', { createdAt: T(now - 120e3), receptionist: { on: true, auto: true, paused: null }, lastMessage: '[template: welcome]' });
  await contact(DAN, 'Dan Doyle', { createdAt: T(now - 120e3), metaLead: { leadId: 'LEADDAN002', receivedAt: T(now - 120e3) } });
  await db.doc('leads/LEADDAN002').set({ leadId: 'LEADDAN002', state: 'done', receivedAt: T(now - 120e3), welcome: { state: 'sent' } });
  await db.doc('quotes/q_' + 'ab'.repeat(12)).set({ phone: DARA, ref: 'EK-0112', status: 'sent', customerName: 'Dara Daly', sentAt: T(now - 7 * DAY), validUntil: '2099-01-01', summary: { dearest: { incVat: 14500 } } });
  const yesterday = new Date(now - DAY).toISOString().slice(0, 10), later = new Date(now + 3 * DAY).toISOString().slice(0, 10);
  await db.doc('reminders/r_' + '01'.repeat(12)).set({ title: 'Ring Mr Doyle', phone: null, customerName: null, dueDate: yesterday, dueTime: null, status: 'open', createdAt: T(now - 3 * DAY), createdBy: 'staff@test.dev' });
  await db.doc('reminders/r_' + '02'.repeat(12)).set({ title: 'Order samples', phone: null, customerName: null, dueDate: later, dueTime: null, status: 'open', createdAt: T(now - DAY), createdBy: 'staff@test.dev' });
  await db.doc('leadIssues/LEADBAD001').set({ leadId: 'LEADBAD001', reason: 'invalid_phone', reasonText: 'The phone number in the form is missing or is not a valid number.', name: 'Ciaran Coyle', email: 'ciaran@example.com', phoneTyped: '087 12', location: 'Lucan', formName: 'Kitchen form', receivedAt: T(now - 90e3), attempts: 1, status: 'open', alert: { state: 'sent' } });
  await db.doc('appointments/a_' + 'aa'.repeat(12)).set({ phone: AOIFE, customerName: 'Aoife Allen', type: 'consultation', status: 'scheduled', start: T(now + DAY), end: T(now + DAY + 3600e3), createdAt: T(now) });

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  const card = (key) => page.locator(`.td-card[data-key="${key}"]`);
  const keys = () => page.$$eval('#today-list .td-card', (els) => els.map((e) => e.dataset.key));
  const count = (t) => page.$eval(`.td-count[data-type="${t}"] .td-count-n`, (e) => Number(e.textContent));
  console.log('E2E: Today tab: real page + real functions + emulators, 450+ chats');
  await page.goto('http://127.0.0.1:5059/');
  await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await page.waitForSelector('#app:not([hidden])');

  // ------------------------------------------------------------ 1. the opening screen
  await page.waitForFunction(() => location.hash === '#today'); await page.waitForSelector('#today-list .td-card');
  assert.equal(await page.$eval('#app', (e) => e.dataset.view), 'today');
  assert.equal(await page.$eval('.rail .rail-item', (e) => e.id), 'nav-today', 'Today is first in the menu'); assert.equal(await page.$eval('#nav-today', (e) => e.classList.contains('active')), true);
  assert.equal(await page.$eval('#nav-inbox', (e) => e.classList.contains('active')), false);
  ok('Elite OS opens on Today (the address becomes #today), and Today is the first item in the menu, highlighted');

  // ------------------------------------------------------------ 2. what is listed, and what is not
  await until(async () => (await keys()).length === 7, '7 cards (now ' + (await keys()).join(',') + ')');
  const ks = await keys();
  for (const want of ['c|' + AOIFE, 'c|' + BRENDAN, 'c|' + CIARA, 'c|' + GUS, 'quote|q_' + 'ab'.repeat(12), 'r|r_' + '01'.repeat(12), 'l|LEADBAD001']) assert.ok(ks.includes(want), 'missing ' + want);
  for (const not of ['c|' + CLOSED, 'c|' + THANKS, 'c|' + DAN, 'c|' + DARA]) assert.ok(!ks.includes(not), 'must not be listed: ' + not);
  assert.deepEqual(await Promise.all(['reply', 'handover', 'booking', 'quote', 'reminder', 'leadfix'].map(count)), [1, 1, 1, 1, 1, 2]);
  assert.equal((await page.$eval('#today-todo-n', (e) => e.textContent)), '(7)');
  assert.match(await card('c|' + BRENDAN).innerText(), /Passed on: price question[\s\S]*waiting 2 days[\s\S]*your phone alert did not arrive/);
  assert.match(await card('c|' + CIARA).innerText(), /Waiting for you to book a visit: Tuesday afternoons/);
  assert.match(await card('c|' + AOIFE).innerText(), /Waiting for your reply · waiting 2 days/);
  assert.match(await card('quote|q_' + 'ab'.repeat(12)).innerText(), /EK-0112[\s\S]*14,500[\s\S]*Sent 7 days ago, no answer/);
  assert.match(await card('r|r_' + '01'.repeat(12)).innerText(), /Ring Mr Doyle[\s\S]*Overdue/);
  assert.match(await card('c|' + GUS).innerText(), /welcome message was refused/);
  assert.equal(await page.$eval('#today-list .td-card', (e) => e.classList.contains('u2')), true, 'the most urgent come first');
  assert.equal(await page.$eval('#today-badge', (e) => !e.hidden && Number(e.textContent) >= 1), true);
  await page.screenshot({ path: path.join(SHOTS, 'today-desktop.png'), fullPage: false });
  ok('the list: replies, hand-over with its reason, visit to book, quote follow-up, overdue reminder and rejected leads; closed customers and thank-yous are NOT there; one card per customer; red ones first; the menu badge shows overdue');

  // ------------------------------------------------------------ 3. new leads today, not hidden by the 300 limit
  const inInbox = await page.evaluate((p) => S.convs.some((c) => c.id === p), GUS); assert.equal(inInbox, false, 'precondition: Gus is NOT among the Inbox\'s 300 newest chats');
  const leads = await page.$$eval('#today-leads .td-lead', (els) => els.map((e) => [e.dataset.status, e.querySelector('.td-name').textContent]));
  assert.deepEqual(leads, [['failed', 'Gus Grant'], ['needs', 'Ciaran Coyle'], ['ai', 'Dan Doyle']]);
  assert.match(await page.innerText('#today-lead-chips'), /Contact failed 1[\s\S]*Needs you 1[\s\S]*AI handling 1[\s\S]*Contacted 0/);
  assert.equal(await page.locator('#today-list [data-key="c|' + DAN + '"]').count(), 0, 'a lead being handled well creates no task');
  ok('New leads today lists every lead with its status, including one that is not among the Inbox\'s 300 newest chats; a lead being handled creates no task');

  // ------------------------------------------------------------ 4. counters filter
  const showing = (list, what) => until(async () => JSON.stringify((await keys()).sort()) === JSON.stringify([...list].sort()), what);
  await page.click('.td-count[data-type="quote"]');
  await showing(['quote|q_' + 'ab'.repeat(12)], 'only the quote'); assert.equal(await page.getAttribute('.td-count[data-type="quote"]', 'aria-pressed'), 'true');
  assert.equal((await page.$eval('#today-todo-n', (e) => e.textContent)), '(1 of 7)');
  await page.click('.td-count[data-type="booking"]'); await showing(['c|' + CIARA], 'only the visit to book');
  await page.click('.td-count[data-type="booking"]'); await until(async () => (await keys()).length === 7, 'everything again'); assert.equal(await page.getAttribute('.td-count[data-type="booking"]', 'aria-pressed'), 'false');
  await page.click('.td-count[data-type="leadfix"]'); await showing(['c|' + GUS, 'l|LEADBAD001'], 'only the leads to fix'); await page.click('.td-count[data-type="leadfix"]'); await until(async () => (await keys()).length === 7, 'everything again');
  ok('every counter is a button: it shows only that kind, pressing it again shows everything');

  // ------------------------------------------------------------ 5. open the customer, and come back
  await page.click(`.td-lead[data-phone="${GUS}"]`); await page.waitForFunction((p) => location.hash === '#c/' + p, GUS);
  await page.waitForSelector('#thread:not([hidden])'); assert.equal(await page.$eval('#app', (e) => e.dataset.view), 'thread');
  assert.equal(await page.$eval('#nav-today', (e) => e.classList.contains('active')), false);
  await page.evaluate(() => document.getElementById('back').click());                                    // the phone's Back button
  await page.waitForFunction(() => location.hash === '#today'); await page.waitForSelector('#today-list .td-card');
  await card('c|' + AOIFE).locator('.td-open').click(); await page.waitForFunction((p) => location.hash === '#c/' + p, AOIFE);
  await page.evaluate(() => { location.hash = '#today'; }); await page.waitForSelector('#today-list .td-card');
  await page.click('#nav-inbox'); await page.waitForSelector('#list .conv'); assert.equal(await page.$eval('#app', (e) => e.dataset.view), 'list');
  await page.click('#nav-today'); await page.waitForSelector('#today-list .td-card');
  ok('a card or a lead opens the customer\'s chat; Back returns to Today; Inbox and Today both reachable from the menu');

  // ------------------------------------------------------------ 6. resolves by itself, comes back when something changes
  await db.doc('conversations/' + AOIFE).update({ lastMessageDirection: 'out', lastMessage: 'About two days.' });
  await until(async () => !(await keys()).includes('c|' + AOIFE), 'the reply card goes once we have answered');
  await db.doc('conversations/' + AOIFE).update({ lastMessageDirection: 'in', lastMessage: 'Great, what about the worktop?', lastInboundAt: T(Date.now()) });
  await until(async () => (await keys()).includes('c|' + AOIFE), 'a NEW customer message brings the card back');
  await db.doc('conversations/' + BRENDAN).update({ 'receptionist.humanAt': T(Date.now()) });
  await until(async () => !(await keys()).includes('c|' + BRENDAN), 'the hand-over goes once a person has written after it');
  await db.doc('appointments/a_' + 'bb'.repeat(12)).set({ phone: CIARA, customerName: 'Ciara Walsh', type: 'consultation', status: 'scheduled', start: T(Date.now() + 2 * DAY), end: T(Date.now() + 2 * DAY + 3600e3), createdAt: T(Date.now()) });
  await until(async () => !(await keys()).includes('c|' + CIARA), 'the visit card goes once the visit is booked');
  await db.doc('quotes/q_' + 'ab'.repeat(12)).update({ status: 'accepted' });
  await until(async () => !(await keys()).includes('quote|q_' + 'ab'.repeat(12)), 'the quote card goes once it is accepted');
  await db.doc('quotes/q_' + 'ab'.repeat(12)).update({ status: 'sent' });
  await until(async () => (await keys()).includes('quote|q_' + 'ab'.repeat(12)), 'and returns if it is reopened');
  assert.equal(await count('booking'), 0);
  ok('cards leave by themselves ONLY when genuinely handled (replied, person wrote after the hand-over, visit booked, quote accepted) and return when the customer writes again');

  // ------------------------------------------------------------ 7. reminders: add, snooze, done, undo
  await page.click('#today-add'); await page.waitForSelector('#rem-dlg[open]');
  await page.fill('#rem-text', 'Call the fitter'); await page.fill('#rem-time', '23:59'); await page.click('#rem-go');
  await page.waitForSelector('.td-card[data-kind="reminder"]:has-text("Call the fitter")'); assert.match(await page.locator('.td-card:has-text("Call the fitter")').innerText(), /Due today at 23:59/);
  const R1 = 'r|r_' + '01'.repeat(12);
  await card(R1).locator('button:has-text("Snooze")').click(); await card(R1).locator('.td-snooze button:has-text("Tomorrow")').click();
  await until(async () => !(await keys()).includes(R1), 'the snoozed reminder leaves today\'s list');
  await page.waitForSelector('#today-later:not([hidden])'); await page.click('#today-later summary'); assert.match(await page.innerText('#today-later-list'), /Ring Mr Doyle/); assert.match(await page.innerText('#today-later-list'), /Order samples/);
  await page.locator('.td-card:has-text("Call the fitter") button:has-text("Done")').click();
  await until(async () => !(await page.locator('#today-list .td-card:has-text("Call the fitter")').count()), 'done leaves the list');
  await page.click('#today-done summary'); assert.match(await page.innerText('#today-done-list'), /Call the fitter/);
  await page.locator('#today-done-list .td-done:has-text("Call the fitter") button:has-text("Undo")').click();
  await page.waitForSelector('#today-list .td-card:has-text("Call the fitter")');
  ok('a reminder can be added (with a time), snoozed to tomorrow ("Coming up"), marked Done (listed under Done today) and Undone');

  // ------------------------------------------------------------ 8. quote follow-up: Followed up, Undo
  const QK = 'quote|q_' + 'ab'.repeat(12);
  await card(QK).locator('button:has-text("Followed up")').click();
  await until(async () => !(await keys()).includes(QK), 'the followed-up quote leaves the list');
  const mark = (await db.doc('todayMarks/quote_q_' + 'ab'.repeat(12)).get()).data(); assert.equal(mark.basis, now - 7 * DAY); assert.ok(mark.snoozeUntil.toMillis() > Date.now() + 4 * DAY);
  await page.locator('#today-toast .linkbtn').click(); await until(async () => (await keys()).includes(QK), 'Undo brings it back');
  assert.equal((await db.doc('todayMarks/quote_q_' + 'ab'.repeat(12)).get()).exists, false);
  ok('"Followed up" hides a quote for 5 days (tied to the date it was sent) and Undo brings it back');

  // ------------------------------------------------------------ 9. rejected lead: same buttons as Needs attention
  await card('l|LEADBAD001').locator('button:has-text("Add as customer")').click(); await page.waitForSelector('#cust-dlg[open]');
  assert.deepEqual(await page.evaluate(() => ['c-phone', 'c-name', 'c-email'].map((id) => document.getElementById(id).value)), ['087 12', 'Ciaran Coyle', 'ciaran@example.com']);
  await page.click('#c-cancel');
  ok('a rejected lead (Phase 10) is a red card with the same Add as customer / Dismiss buttons');

  // ------------------------------------------------------------ 9b. review fix: going to Today still asks about unsaved changes
  await db.doc('quoteSettings/current').set({ rev: 1, vatRate: 13.5, validityDays: 30, priceList: { options: { ess: { perDoor: 110, perTopBox: 60 }, prem: { perDoor: 140, perTopBox: 65 }, pp: { perDoor: 150, perTopBox: 70 } }, drawerBoxes: { cemux: 12, blum: 21 }, glazing: { small: 45, large: 90 }, extras: [] }, business: { tradingName: 'Elite Kitchens', phone: '01 000 0000', email: 'q@example.com' } });
  await page.evaluate(() => { location.hash = '#quotes/settings'; });
  await page.waitForSelector('#q-settings-view form.qs');
  await page.locator('#q-settings-view form.qs input[data-field^="business."]').first().fill('edited without saving');
  const asked = []; let answer = 'dismiss'; page.removeAllListeners('dialog'); page.on('dialog', (d) => { asked.push(d.message()); return answer === 'dismiss' ? d.dismiss() : d.accept(); });
  await page.click('#nav-today'); await sleep(600);
  assert.equal(asked.length, 1); assert.match(asked[0], /unsaved changes to Quote Settings/);
  assert.equal(await page.$eval('#app', (e) => e.dataset.view), 'quotes', 'still on the quote settings, with the edit intact'); assert.equal(await page.evaluate(() => location.hash), '#quotes/settings');
  assert.equal(await page.locator('#q-settings-view form.qs input[data-field^="business."]').first().inputValue(), 'edited without saving');
  answer = 'accept'; await page.click('#nav-today'); await page.waitForFunction(() => location.hash === '#today'); await page.waitForSelector('#today-list .td-card');
  assert.equal(asked.length, 2); assert.equal(await page.$eval('#app', (e) => e.dataset.view), 'today');
  page.removeAllListeners('dialog'); page.on('dialog', (d) => d.accept());
  ok('going to Today from a screen with unsaved edits asks "Leave without saving?" first: No keeps the edit, Yes goes to Today (it used to discard the edit without asking)');

  // ------------------------------------------------------------ 10. phone: full-width cards
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await mctx.newPage(); mp.on('pageerror', (e) => errors.push(e.message));
  await mp.goto('http://127.0.0.1:5059/'); await mp.evaluate((t) => firebase.auth().signInWithCustomToken(t), token);
  await mp.waitForSelector('#app:not([hidden])'); await mp.waitForFunction(() => location.hash === '#today'); await mp.waitForSelector('#today-list .td-card');
  const m = await mp.evaluate(() => {
    const vw = innerWidth, cards = [...document.querySelectorAll('#today-list .td-card')], rect = (e) => e.getBoundingClientRect();
    return { scrollOk: document.documentElement.scrollWidth <= vw + 1, widths: cards.map((c) => Math.round(rect(c).width)), vw,
      btnH: Math.min(...[...document.querySelectorAll('#today-list .td-actions .btn')].map((b) => Math.round(rect(b).height))), cols: getComputedStyle(document.getElementById('today-counts')).gridTemplateColumns.split(' ').length,
      countW: [...document.querySelectorAll('.td-count')].every((c) => rect(c).right <= vw && rect(c).width > 60), over: [...document.querySelectorAll('#today-scroll *')].filter((e) => rect(e).right > vw + 1).length };
  });
  assert.equal(m.scrollOk, true, 'no sideways scrolling'); assert.ok(m.widths.length >= 4 && m.widths.every((w) => w >= m.vw - 1), 'full-width cards: ' + m.widths.join(',') + ' of ' + m.vw);
  assert.ok(m.btnH >= 44, 'tap targets at least 44 px: ' + m.btnH); assert.equal(m.cols, 3); assert.equal(m.countW, true); assert.equal(m.over, 0, 'nothing runs off the screen');
  await mp.screenshot({ path: path.join(SHOTS, 'today-mobile.png') });
  await mp.evaluate(() => document.getElementById('today-scroll').scrollTo(0, 99999)); await mp.screenshot({ path: path.join(SHOTS, 'today-mobile-leads.png') });
  await mp.click('#today-back'); await mp.waitForSelector('#to-today'); assert.equal(await mp.$eval('#app', (e) => e.dataset.view), 'list');
  assert.match(await mp.innerText('#to-today'), /Today/); assert.equal(await mp.$eval('#today-link-n', (e) => !e.hidden && Number(e.textContent) >= 3), true);
  await mp.screenshot({ path: path.join(SHOTS, 'today-mobile-inbox.png') });
  await mp.click('#to-today'); await mp.waitForSelector('#today-list .td-card'); assert.equal(await mp.$eval('#app', (e) => e.dataset.view), 'today');
  ok('phone: Elite OS opens on Today; cards are full width with no sideways scrolling; buttons are at least 44 px; the counters wrap in three columns; a big "Today" button sits at the top of the Inbox');

  assert.deepEqual(errors, []); ok('no JavaScript errors in the browser');
  console.log(`ALL ${n} CHECKS PASSED`);
  await browser.close(); web.close(); process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
