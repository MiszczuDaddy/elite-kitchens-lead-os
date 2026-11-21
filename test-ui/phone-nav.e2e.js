'use strict';
// Phone inbox layout, in a REAL browser: every section is one identical button under the Today card, and the whole inbox scrolls as one: the Today card and the buttons
// slide up out of view while the status filters and the search stay pinned at the top. A desktop is unchanged. Real page + real functions + emulators.
// Every name is made up. Run: bash test-ui/run.sh phone-nav.e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const { getAuth } = fnRequire('firebase-admin/auth');
const ROOT = path.join(__dirname, '..'), URL0 = 'http://127.0.0.1:5057/';
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
let n = 0; const ok = (m) => console.log(`  PASS ${++n}. ${m}`);
const cfgJs = `firebase.initializeApp({apiKey:'fake',projectId:'demo-leados',authDomain:'localhost',storageBucket:'demo-leados.firebasestorage.app'});
firebase.auth().useEmulator('http://127.0.0.1:9099',{disableWarnings:true});
firebase.firestore().useEmulator('127.0.0.1',8085);
firebase.app().functions('europe-west1').useEmulator('127.0.0.1',5001);
firebase.storage().useEmulator('127.0.0.1',9199);`;
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
http.createServer((req, res) => {
  const u = req.url.split('?')[0]; if (u === '/__/firebase/init.js') { res.setHeader('content-type', 'text/javascript'); return res.end(cfgJs); }
  const m = /^\/__\/firebase\/[\d.]+\/(.+)$/.exec(u), f = m ? path.join(ROOT, 'node_modules/firebase', m[1]) : path.join(ROOT, 'public', u === '/' ? 'index.html' : u);
  fs.readFile(f, (e, d) => { if (e) { res.statusCode = 404; return res.end('nf'); } res.setHeader('content-type', TYPES[path.extname(f)] || 'application/octet-stream'); res.setHeader('cache-control', 'no-store'); res.end(d); });
}).listen(5057);

(async () => {
  initializeApp({ projectId: 'demo-leados' }); const db = getFirestore(), T = (ms) => Timestamp.fromMillis(ms), now = Date.now();
  const token = await getAuth().createCustomToken((await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true })).uid);
  const names = ['Vivienne Vale', 'Yvonne Yates', 'Gail Grant', 'Sarah Shaw', 'Oxana Owens', 'Nike Nolan', 'Andrea Ahern', 'Patrick Price', 'Ciara Cox', 'Brendan Burke', 'Dara Daly', 'Aoife Allen', 'Maura Moore', 'Tara Tobin'];
  for (const [i, nm] of names.entries()) { const p = '3538711' + String(10100 + i); await db.doc('conversations/' + p).set({ phone: p, name: nm, createdAt: T(now - 86400e3 - i * 3600e3), updatedAt: T(now - 86400e3 - i * 3600e3), lastMessage: 'Hi ' + nm.split(' ')[0] + ', thanks for your enquiry', lastMessageDirection: 'out', unreadCount: 0, inboxStatus: 'inbox', projectType: 'Kitchen' }); }
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' }), errors = [];
  const open = async (viewport, phone) => {
    const ctx = await browser.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) }), page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(URL0); await page.waitForSelector('#login:not([hidden])'); await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])');
    await page.evaluate(() => { location.hash = ''; }); await page.waitForSelector('.conv'); await page.waitForTimeout(300); return { ctx, page };
  };
  const box = (page, sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) }; });
  console.log('PHONE NAV E2E: real page + real functions + emulators, in Chromium');

  // ------------------------------------------------------------------ 1. the section buttons: all visible, identical size, no sideways scrolling, at a normal and a small phone
  for (const w of [390, 360]) {
    const { ctx, page } = await open({ width: w, height: 780 }, true);
    await page.evaluate(() => { document.getElementById('notif-open-m').hidden = false; });          // the browser offers Notifications
    const ids = ['to-pipeline', 'to-appointments', 'to-quotes', 'to-projects', 'to-assistant', 'notif-open-m', 'signout-m'];
    for (const id of ids) assert.equal(await page.isVisible('#' + id), true, id + ' is visible at ' + w);
    const boxes = await Promise.all(ids.map((id) => box(page, '#' + id)));
    assert.equal(new Set(boxes.map((b) => b.w + 'x' + b.h)).size, 1, 'every button is the same size: ' + JSON.stringify(boxes));
    assert.ok(boxes.every((b) => b.left >= 0 && b.right <= w && b.h >= 56), 'inside the screen and easy to tap');
    assert.equal(await page.$$eval('.pn-btn span', (els) => els.filter((e) => e.offsetParent && e.scrollWidth > e.clientWidth).length), 0, 'no label is cut short at ' + w);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scrolling at ' + w);
    assert.equal(await page.isVisible('#install-app-m'), false, 'Install app stays hidden until the browser offers it');
    assert.equal(await page.locator('.pane-head .icon-btn').count(), 1, 'the header keeps only the + button');
    if (w === 390) await page.screenshot({ path: path.join(SHOTS, 'phone-nav-top.png') });
    await ctx.close();
  }
  ok('phone: Pipeline, Calendar, Quotes, Projects, Assistant, Notifications and Sign out are all visible, identical buttons, inside the screen at 390 and 360 wide, no label cut short, no sideways scrolling');

  // ------------------------------------------------------------------ 2. scrolling: the Today card and buttons slide away, the filters and search stay
  const { ctx, page } = await open({ width: 390, height: 780 }, true);
  const top = { today: await box(page, '#to-today'), nav: await box(page, '#phone-nav'), filters: await box(page, '#status-filters') };
  assert.ok(top.today.top > 0 && top.nav.top > top.today.bottom - 1 && top.filters.top > top.nav.bottom - 1, 'at the top: Today card, then the buttons, then the filters: ' + JSON.stringify(top));
  await page.evaluate(() => { document.querySelector('.list-pane').scrollTop = 500; }); await page.waitForTimeout(250);
  const down = { today: await box(page, '#to-today'), nav: await box(page, '#phone-nav'), filters: await box(page, '#status-filters'), search: await box(page, '.search') };
  assert.ok(down.today.bottom < 0 && down.nav.bottom < 0, 'scrolled: the Today card and the buttons are out of view');
  assert.ok(down.filters.top >= 0 && down.filters.top <= 2 && down.search.bottom < 200, 'scrolled: the filters and the search stay pinned at the top: ' + JSON.stringify(down));
  assert.equal(await page.evaluate(() => { const l = document.getElementById('list'); return l.scrollHeight > l.clientHeight + 1; }), false, 'the list does not scroll separately inside the page');
  await page.screenshot({ path: path.join(SHOTS, 'phone-nav-scrolled.png') });
  ok('phone: scrolling the conversations slides the Today card and the buttons up out of view while the status filters and the search stay pinned at the top');

  // ------------------------------------------------------------------ 3. the list still behaves: a filter goes back to the top, a tap opens the chat, scrolling back shows the buttons again
  await page.tap('#status-filters button[data-status="all"]'); await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => document.querySelector('.list-pane').scrollTop), 0, 'pressing a filter goes back to the top');
  assert.ok((await box(page, '#phone-nav')).top > 0, 'and the buttons are back in view');
  await page.tap('.conv >> nth=0'); await page.waitForSelector('#app[data-view=thread]');
  ok('phone: pressing a filter goes back to the top (the buttons are visible again) and tapping a conversation still opens it');
  await ctx.close();

  // ------------------------------------------------------------------ 4. a desktop is unchanged
  const d = await open({ width: 1360, height: 900 }, false);
  const st = await d.page.evaluate(() => ({ list: getComputedStyle(document.getElementById('list')).overflowY, pane: getComputedStyle(document.querySelector('.list-pane')).overflowY, wrap: getComputedStyle(document.querySelector('.list-sticky')).display, nav: getComputedStyle(document.getElementById('phone-nav')).display }));
  assert.deepEqual(st, { list: 'auto', pane: 'visible', wrap: 'contents', nav: 'none' }, 'desktop: the list scrolls by itself as before, and the phone buttons are not shown: ' + JSON.stringify(st));
  await d.ctx.close();
  ok('desktop: the conversation list scrolls by itself as before, the phone buttons are not shown');

  assert.deepEqual(errors, [], 'no JavaScript errors: ' + JSON.stringify(errors)); ok('no JavaScript errors in the browser');
  console.log(`ALL ${n} CHECKS PASSED`); await browser.close(); process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
