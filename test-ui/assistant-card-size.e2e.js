'use strict';
// The Assistant's approval card is big enough to READ (15 Nov 2026), in a REAL browser: with 20 people to email there is ONE list of the customers and ONE preview of the email (not one per person), the whole email is
// readable without scrolling inside a little box, and Approve / Reject stay on screen, on a computer and on a 375px phone. The Assistant is the built-in DEMO model (AI_FAKE_MODEL=on, emulator only). Every name is made up.
// Run: bash test-ui/run.sh assistant-card-size.e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const { getAuth } = fnRequire('firebase-admin/auth');
const ai = fnRequire('./lib/ai');
const ROOT = path.join(__dirname, '..'), URL0 = 'http://127.0.0.1:5074/';
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
}).listen(5074);

(async () => {
  initializeApp({ projectId: 'demo-leados' }); const db = getFirestore(), T = (ms) => Timestamp.fromMillis(ms), now = Date.now(), DAY = 86400000;
  const token = await getAuth().createCustomToken((await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true })).uid);
  const NAMES = ['Aoife Byrne', 'Brian Casey', 'Ciara Doyle', 'Dara Egan', 'Eoin Fahey', 'Fiona Gill', 'Gus Hearn', 'Hana Irwin', 'Ian Joyce', 'Jane Kelly', 'Kevin Lynch', 'Lena Moore', 'Mark Nolan', 'Nora Oakes', 'Owen Power', 'Paula Quinn', 'Ross Ryan', 'Sara Shaw', 'Tom Tracy', 'Una Vale'];
  for (let i = 0; i < NAMES.length; i++) {
    const phone = '35387115' + String(1000 + i), name = NAMES[i];
    await db.doc('contacts/' + phone).set({ phone, name, email: name.split(' ')[0].toLowerCase() + '@example.com', createdAt: T(now - (5 + i) * DAY) });
    await db.doc('conversations/' + phone).set({ phone, name, projectType: 'Kitchen', location: 'Swords', inboxStatus: 'inbox', unreadCount: 0, lastMessage: 'Hi, thanks for your enquiry', lastMessageDirection: 'out', createdAt: T(now - (5 + i) * DAY), updatedAt: T(now - (5 + i) * DAY) });
  }
  await db.doc('aiSettings/modelCheck').set(Object.fromEntries(Object.entries(ai.MODELS).map(([k, m]) => [k, { id: m.id, ok: true, name: m.label, lifecycle: 'active', at: T(now) }])));
  await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, actionsEnabled: true, actionKinds: { customerNote: true, projectUpdate: true, followUpEmails: true, quoteFollowUps: true }, monthlyCapEur: 15, dailyCapEur: 2 });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' }), errors = []; global.__errors = errors;
  const open = async (viewport, phone) => {
    const ctx = await browser.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) }), page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(URL0); await page.waitForSelector('#login:not([hidden])'); await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])');
    await page.evaluate(() => { if (location.hash === '#today') location.hash = ''; });
    await page.click(phone ? '#to-assistant' : '#nav-assistant'); await page.waitForSelector('#assistant', { state: 'visible' }); await page.waitForFunction(() => !document.getElementById('as-input').disabled);
    return page;
  };
  const prepare = async (page) => { await page.fill('#as-input', 'follow up emails please'); await page.press('#as-input', 'Enter'); await page.waitForSelector('#as-tray .as-card[data-state=pending]'); await sleep(400); };
  console.log('ASSISTANT APPROVAL CARD SIZE E2E: real page + real functions + emulators + the demo model');

  // ------------------------------------------------------------------ 1. a computer: one list of 20, one email, all of it readable
  const page = await open({ width: 1360, height: 900 }); await prepare(page);
  const tray = page.locator('#as-tray');
  assert.match(await tray.innerText(), /Who gets it \(20\)/i); assert.equal(await tray.locator('.as-card-list').count(), 1, 'ONE list of the customers'); assert.equal(await tray.locator('.as-card-list li').count(), 20); assert.equal(await tray.locator('.as-card-text').count(), 1, 'ONE preview of the email for all of them');
  const m = await page.evaluate(() => { const t = document.getElementById('as-tray'), l = t.querySelector('.as-card-list'), x = t.querySelector('.as-card-text'), a = [...t.querySelectorAll('button')].find((b) => /Approve/.test(b.textContent)).getBoundingClientRect();
    return { tray: t.clientHeight, trayScroll: t.scrollHeight, vh: innerHeight, list: [l.clientHeight, l.scrollHeight], text: [x.clientHeight, x.scrollHeight], approve: [a.top, a.bottom] }; });
  assert.ok(m.tray >= 0.58 * m.vh, 'the approval box is big (it was a 42%-of-the-screen strip, 378px here): ' + JSON.stringify(m)); assert.ok(m.text[1] <= m.text[0] + 1, 'the whole email is readable without scrolling inside a little box: ' + JSON.stringify(m.text));
  assert.ok(m.list[0] >= 90, 'part of the list is visible at once (the rest scrolls): ' + JSON.stringify(m.list)); assert.ok(m.trayScroll <= m.tray + 2, 'with 20 people the whole card (list, email, Approve) fits the screen without scrolling the box: ' + JSON.stringify(m)); assert.ok(m.approve[0] >= 0 && m.approve[1] <= m.vh, 'Approve and Reject stay on screen: ' + JSON.stringify(m.approve));
  await page.screenshot({ path: path.join(SHOTS, 'assistant-card-desktop.png') });
  ok('on a computer: ONE list of 20 customers and ONE preview of the email; the approval box is big, the whole email is readable without scrolling inside it, and Approve / Reject stay on screen');

  // ------------------------------------------------------------------ 2. a phone
  const ph = await open({ width: 375, height: 812 }, true); await prepare(ph);
  const p = await ph.evaluate(() => { const t = document.getElementById('as-tray'), a = [...t.querySelectorAll('button')].find((b) => /Approve/.test(b.textContent)).getBoundingClientRect(), x = t.querySelector('.as-card-text');
    return { tray: t.clientHeight, vh: innerHeight, approve: [a.top, a.bottom], text: [x.clientHeight, x.scrollHeight], side: document.documentElement.scrollWidth <= innerWidth }; });
  assert.ok(p.tray >= 0.5 * p.vh, 'the approval box is big on a phone too (it was 42%: 341px here): ' + JSON.stringify(p)); assert.ok(p.approve[0] >= 0 && p.approve[1] <= p.vh, 'Approve stays on screen: ' + JSON.stringify(p.approve)); assert.ok(p.text[0] >= 150, 'a good part of the email is visible: ' + JSON.stringify(p.text)); assert.equal(p.side, true, 'no sideways scrolling');
  await ph.screenshot({ path: path.join(SHOTS, 'assistant-card-phone.png') });
  ok('on a 375px phone: the approval box is big, Approve stays on screen and nothing scrolls sideways');

  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | ')); ok('no console or page errors');
  await browser.close(); web.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e, '\nPAGE ERRORS:', global.__errors); web.close(); process.exit(1); });
