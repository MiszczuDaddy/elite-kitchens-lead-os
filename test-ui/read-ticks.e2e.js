'use strict';
// The "read" ticks (16 Nov 2026), in a REAL browser: when the customer has READ a message the double tick is purple and large, so it cannot be missed; delivered and sent ticks stay small and grey; the bubble keeps
// its shape; the colour is easy to see against the bubble. Every name and number is made up. Run: bash test-ui/run.sh read-ticks.e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');
const { getAuth } = fnRequire('firebase-admin/auth');
const ROOT = path.join(__dirname, '..'), URL0 = 'http://127.0.0.1:5076/';
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
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
}).listen(5076);
// WCAG contrast of two #rrggbb colours
const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

(async () => {
  initializeApp({ projectId: 'demo-leados' }); const db = getFirestore(), T = (ms) => Timestamp.fromMillis(ms), now = Date.now(), MIN = 60000;
  const token = await getAuth().createCustomToken((await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true })).uid);
  const P = '353871170001';
  await db.doc('contacts/' + P).set({ phone: P, name: 'Ray Ryan', createdAt: T(now - 3 * 86400000) });
  await db.doc('conversations/' + P).set({ phone: P, name: 'Ray Ryan', inboxStatus: 'quoted', unreadCount: 0, lastMessage: 'Thanks', lastMessageDirection: 'out', lastInboundAt: T(now - 70 * MIN), createdAt: T(now - 3 * 86400000), updatedAt: T(now - 5 * MIN) });
  const msg = (id, direction, body, status, minsAgo) => db.doc(`conversations/${P}/messages/${id}`).set({ direction, type: 'text', body, ...(status ? { status } : {}), createdAt: T(now - minsAgo * MIN), wamid: 'wamid.' + id });
  await msg('m1', 'in', 'Hi, can you send me the quote again?', null, 70); await msg('m2', 'out', 'Of course, here it is. This one was READ by Ray.', 'read', 60);
  await msg('m3', 'out', 'This one was only delivered to his phone.', 'delivered', 30); await msg('m4', 'out', 'And this one was just sent.', 'sent', 5);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' }), errors = []; global.__errors = errors;
  const open = async (viewport, phone) => {
    const ctx = await browser.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) }), page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(URL0); await page.waitForSelector('#login:not([hidden])'); await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])');
    await page.evaluate((id) => { location.hash = '#c/' + id; }, P); await page.waitForSelector('#msgs .m.out .tick'); return page;
  };
  console.log('READ TICKS E2E: real page + real functions + emulators');
  for (const [label, viewport, phone] of [['computer', { width: 1360, height: 900 }, false], ['phone', { width: 375, height: 812 }, true]]) {
    const page = await open(viewport, phone);
    const t = await page.evaluate(() => { const css = (e) => { const s = getComputedStyle(e); return { color: s.color, size: parseFloat(s.fontSize), weight: s.fontWeight }; };
      const read = document.querySelector('#msgs .m.out .tick.read'), plain = [...document.querySelectorAll('#msgs .m.out .tick:not(.read)')], time = document.querySelector('#msgs .m.out .meta span'), bubble = read.closest('.m');
      return { read: css(read), plain: plain.map(css), time: css(time), title: read.title, text: read.textContent, bubbleBg: getComputedStyle(bubble).backgroundColor, count: document.querySelectorAll('#msgs .m.out .tick.read').length, plainTitles: plain.map((e) => e.title) }; });
    assert.equal(t.count, 1, 'only the message that was read has the read tick'); assert.equal(t.text, '✓✓'); assert.equal(t.title, 'Read');
    assert.equal(t.read.color, 'rgb(122, 47, 192)', 'purple: ' + t.read.color); assert.ok(t.read.size >= 18 && t.read.size > 1.5 * t.time.size, 'large: ' + JSON.stringify([t.read.size, t.time.size])); assert.ok(Number(t.read.weight) >= 600, 'bold');
    assert.deepEqual(t.plainTitles.sort(), ['Delivered', 'Sent']); assert.ok(t.plain.every((x) => x.size <= 12 && x.color !== t.read.color), 'delivered and sent ticks stay small and are not purple: ' + JSON.stringify(t.plain));
    const bg = t.bubbleBg.match(/\d+/g).slice(0, 3).map((v) => Number(v).toString(16).padStart(2, '0')).join(''); assert.ok(contrast('#7a2fc0', '#' + bg) >= 4.5, 'easy to see against the bubble: ' + contrast('#7a2fc0', '#' + bg));
    const box = await page.locator('#msgs .m.out .tick.read').boundingBox(), bub = await page.locator('#msgs .m.out .tick.read').evaluate((e) => e.closest('.m').getBoundingClientRect().toJSON());
    assert.ok(box.x >= bub.x && box.x + box.width <= bub.x + bub.width + 1 && box.y >= bub.y && box.y + box.height <= bub.y + bub.height + 1, 'the tick stays inside its bubble: ' + JSON.stringify([box, bub]));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scrolling');
    await page.screenshot({ path: path.join(SHOTS, 'read-ticks-' + label + '.png') });
    ok(label + ': the "read" tick is purple (readable against the bubble), large and bold; delivered and sent ticks stay small and grey; the tick stays inside its bubble');
  }
  assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | ')); ok('no console or page errors');
  await browser.close(); web.close();
  console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e, '\nPAGE ERRORS:', global.__errors); web.close(); process.exit(1); });
