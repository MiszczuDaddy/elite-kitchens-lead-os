'use strict';
// Phase 7 browser test: Projects. Accepting a quote in the real screen makes its project; the dashboard (waiting for carcasses / doors), the independent checklist,
// installation date and notes (and a conflict), the approved 3D render (a real picture is accepted, a fake one is refused), completing and reopening, removing a project
// made by mistake, a project made by hand from the customer profile, the reopened-quote warning, and the phone layout. Real page + real functions + emulators.
// Every name, number and price is made up. Run: bash test-ui/run.sh projects.e2e.js
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
}).listen(5055);

const DAY = 86400000, ago = (d) => Timestamp.fromMillis(Date.now() - d * DAY);
const ph = { anna: '353860000021', brian: '353860000022', cara: '353860000023', dan: '353860000024' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SETTINGS = { vatRate: 13.5, validityDays: 30,
  priceList: { options: { ess: { perDoor: 110, perTopBox: 60 }, prem: { perDoor: 140, perTopBox: 65 }, pp: { perDoor: 150, perTopBox: 70 } }, drawerBoxes: { cemux: 12, blum: 21 }, glazing: { small: 45, large: 90 }, extras: [{ key: 'bin', name: 'Pull-out bin', unit: 'per unit', price: 30 }] },
  business: { tradingName: 'Elite Kitchens', signatureName: 'Test Person', phone: '01 000 0000', email: 'quotes@example.com', web: 'www.example.com', address: 'Test Street, Dublin', vatNumber: 'IE0000000A' } };

(async () => {
  initializeApp({ projectId: 'demo-leados', storageBucket: 'demo-leados.firebasestorage.app' });
  const db = getFirestore(), bucket = getStorage().bucket('demo-leados.firebasestorage.app');
  const seed = async (id, contact) => {
    await db.doc('conversations/' + id).set({ phone: id, name: contact.name, createdAt: ago(10), updatedAt: ago(1), lastMessage: 'Hi', unreadCount: 0, inboxStatus: 'quoted', stageDates: { quoted: ago(3) } });
    await db.doc('contacts/' + id).set({ phone: id, createdAt: ago(10), ...contact });
  };
  await seed(ph.anna, { name: 'Anna Apple', email: 'anna@example.com', address: '1 Main Street, Swords', location: 'Swords' });
  await seed(ph.brian, { name: 'Brian Byrne', location: 'Malahide' });
  await seed(ph.cara, { name: 'Cara Cullen', location: 'Howth' });
  await seed(ph.dan, { name: 'Dan Doyle', location: 'Skerries' });
  const projectsOf = async (p) => (await db.collection('projects').where('phone', '==', p).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const proj = async (id) => { const s = await db.doc('projects/' + id).get(); return s.exists ? s.data() : null; };
  const quote = async (id) => (await db.doc('quotes/' + id).get()).data();
  const until = async (fn, what, ms = 15000) => { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch (e) { /* not yet */ } if (Date.now() - t > ms) throw new Error('timed out waiting for: ' + what); await sleep(120); } };

  const u = await getAuth().createUser({ email: 'staff@test.dev', emailVerified: true });
  const token = await getAuth().createCustomToken(u.uid);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const errors = [];
  const open = async (options = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, ...options }), page = await ctx.newPage(); global.__page = page;
    page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto('http://127.0.0.1:5055/'); await page.evaluate((t) => firebase.auth().signInWithCustomToken(t), token); await page.waitForSelector('#app:not([hidden])'); await page.evaluate(() => { if (location.hash === '#today') location.hash = ''; });
    return { ctx, page };
  };
  let { ctx, page } = await open();
  const go = async (hash, sel) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForSelector(sel); };
  const call = (name, data) => page.evaluate(async ({ name, data }) => (await firebase.app().functions('europe-west1').httpsCallable(name)(data)).data, { name, data });
  const makeSentQuote = (phone) => page.evaluate(async ({ phone }) => {
    const f = firebase.firestore(), fn = (x) => firebase.app().functions('europe-west1').httpsCallable(x);
    const s = (await f.doc('quoteSettings/current').get()).data(), a = QuoteEngine.current().newAnswers(s.priceList); a.doors = 10; a.drawers = 4; a.options.ess.drawerBox = 'cemux'; a.options.prem = { ...a.options.prem, on: true, drawerBox: 'blum' };
    const id = (await fn('createQuote')({ phone, requestId: 'e2e-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10), answers: a })).data.id;
    const q = (await f.doc('quotes/' + id).get()).data(), ct = (await f.doc('contacts/' + phone).get()).data() || {};
    const p = `uploads/${firebase.auth().currentUser.uid}/${Date.now()}-quote.pdf`;
    await firebase.storage().ref(p).put(new Blob(['%PDF-1.4\n% e2e\n%%EOF'], { type: 'application/pdf' }));
    await fn('sendQuote')({ id, expectedRev: q.rev, requestId: 'e2e-send-' + Date.now() + '-abc', issueDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(new Date()), settingsRev: s.rev,
      customer: { name: ct.name, email: ct.email || null, address: ct.address || null }, pdfUploadPath: p });
    return id;
  }, { phone });
  const acceptByCall = async (id) => call('acceptQuote', { id, expectedRev: (await quote(id)).rev, option: 'prem' });
  const row = (name) => page.locator(`#pj-list .projrow:has-text("${name}")`);
  const tile = (k) => page.locator(`#pj-tile-${k} .pj-tile-n`);
  console.log('PROJECTS E2E: real page + real functions + emulators');

  await call('saveQuoteSettings', SETTINGS);

  // ------------------------------------------------------------------ 1. the rail and the empty dashboard
  assert.equal(await page.locator('#nav-projects').innerText(), 'Projects');
  await page.click('.nav-future summary'); assert.doesNotMatch(await page.locator('.planned-areas').innerText(), /Projects/);
  await page.click('#nav-projects'); await page.waitForSelector('#pj-list-view:not([hidden])');
  assert.equal(await page.getAttribute('#app', 'data-view'), 'projects'); assert.equal(await page.getAttribute('#nav-projects', 'aria-current'), 'page'); assert.equal(await page.getAttribute('#nav-inbox', 'aria-current'), null);
  await page.waitForFunction(() => /No active projects yet/.test(document.getElementById('pj-empty').textContent));
  assert.equal(await tile('carcasses').innerText(), '0'); assert.equal(await tile('doors').innerText(), '0');
  ok('Projects is in the rail (not under "Coming later"); the dashboard is empty until a quote is accepted');

  // ------------------------------------------------------------------ 2. accepting a quote in the real screen makes its project
  const qAnna = await makeSentQuote(ph.anna), qBrian = await makeSentQuote(ph.brian);
  assert.equal((await projectsOf(ph.anna)).length, 0, 'sending a quote makes no project');
  await go('#quotes/' + qAnna, '#qv-accept'); await page.click('#qv-accept'); await page.waitForSelector('#qa-dlg[open]');
  await page.locator('#qa-options input[value="prem"]').check(); await page.click('#qa-go');
  const pa = await until(async () => (await projectsOf(ph.anna))[0], 'the project of Anna\'s accepted quote');
  assert.equal(pa.id.slice(2), qAnna.slice(2)); assert.equal(pa.quoteId, qAnna); assert.equal(pa.quoteRef, (await quote(qAnna)).ref); assert.equal(pa.quoteOption.key, 'prem'); assert.equal(pa.createdVia, 'quote');
  assert.equal((await projectsOf(ph.anna)).length, 1);
  await acceptByCall(qBrian); const pb = await until(async () => (await projectsOf(ph.brian))[0], 'the project of Brian\'s quote');
  await go('#projects', '#pj-list .projrow');
  await page.waitForFunction(() => document.querySelectorAll('#pj-list .projrow').length === 2);
  const anna = row('Anna Apple');
  assert.match(await anna.innerText(), /Waiting for design approval/); assert.match(await anna.innerText(), /Carcasses to order/); assert.match(await anna.innerText(), /Doors to order/);
  assert.match(await anna.innerText(), /Design not approved yet/); assert.match(await anna.innerText(), new RegExp(pa.quoteRef)); assert.match(await anna.innerText(), /No installation date/); assert.match(await anna.innerText(), /0\/5/);
  assert.equal(await tile('carcasses').innerText(), '2'); assert.equal(await tile('doors').innerText(), '2');
  ok('accepting a quote in the screen made exactly one project, linked to the customer and the quote; the dashboard shows both waiting for carcasses and doors');

  // ------------------------------------------------------------------ 3. one project, and the independent checklist
  await anna.click(); await page.waitForSelector('#pj-step-doorsOrdered');
  assert.equal(await page.getAttribute('#app', 'data-view'), 'projects'); assert.equal(await page.inputValue('#pj-notes'), '');
  await page.waitForFunction(() => /anna@example.com/.test(document.getElementById('pj-customer').textContent));        // the customer's details arrive a moment after the page
  assert.match(await page.textContent('#pj-customer'), /Anna Apple/); assert.match(await page.textContent('#pj-customer'), /\+353 86 000 0021/); assert.match(await page.textContent('#pj-customer'), /anna@example\.com/); assert.match(await page.textContent('#pj-customer'), /1 Main Street, Swords/);
  assert.equal((await page.textContent('#pj-quote-link')).trim(), pa.quoteRef); assert.match(await page.textContent('#pj-quote'), /Premium/);
  const labels = await page.locator('.pj-step-text').allInnerTexts(); assert.deepEqual(labels, ['Final 3D design approved', 'Carcasses ordered', 'Doors ordered', 'Ready for installation', 'Installation completed']);
  for (const s of ['designApproved', 'carcassesOrdered', 'doorsOrdered', 'readyForInstall', 'installed']) assert.equal(await page.isChecked('#pj-step-' + s), false);
  await page.click('#pj-step-doorsOrdered');                                                              // doors first: no design approval, no carcasses
  await until(async () => (await proj(pa.id)).steps.doorsOrdered.done, 'doors ticked');
  const st1 = (await proj(pa.id)).steps; assert.deepEqual([st1.designApproved.done, st1.carcassesOrdered.done, st1.doorsOrdered.done], [false, false, true]); assert.equal(st1.doorsOrdered.by, 'staff@test.dev');
  assert.equal(await page.isChecked('#pj-step-doorsOrdered'), true); assert.equal(await page.isDisabled('#pj-step-carcassesOrdered'), false, 'the other boxes are free');
  await page.waitForFunction(() => /staff@test\.dev/.test(document.querySelector('li[data-step="doorsOrdered"] .pj-by').textContent));
  ok('"Doors ordered" can be ticked first, on its own: no other step is needed, and it says who ticked it and when');

  // ------------------------------------------------------------------ 4. the dashboard says what is still waiting
  await go('#projects', '#pj-list .projrow'); await page.waitForFunction(() => document.querySelector('#pj-tile-doors .pj-tile-n').textContent === '1');
  assert.equal(await tile('carcasses').innerText(), '2'); assert.equal(await tile('doors').innerText(), '1');
  assert.doesNotMatch(await row('Anna Apple').innerText(), /Doors to order/); assert.match(await row('Anna Apple').innerText(), /Carcasses to order/);
  await page.click('#pj-tile-doors'); await page.waitForFunction(() => document.querySelectorAll('#pj-list .projrow').length === 1);
  assert.match(await page.locator('#pj-list').innerText(), /Brian Byrne/); assert.equal(await page.getAttribute('#pj-tile-doors', 'aria-pressed'), 'true');
  await page.click('#pj-tile-doors'); await page.waitForFunction(() => document.querySelectorAll('#pj-list .projrow').length === 2);       // press again: back to Active
  await page.click('#pj-tile-carcasses'); await page.waitForFunction(() => document.querySelectorAll('#pj-list .projrow').length === 2);
  await page.click('#pj-tile-carcasses');
  await row('Anna Apple').click(); await page.waitForSelector('#pj-step-carcassesOrdered'); await page.click('#pj-step-carcassesOrdered');
  await until(async () => (await proj(pa.id)).steps.carcassesOrdered.done, 'carcasses ticked');
  await go('#projects', '#pj-list .projrow'); await page.waitForFunction(() => document.querySelector('#pj-tile-carcasses').textContent.startsWith('1'));
  assert.equal(await tile('carcasses').innerText(), '1'); assert.equal(await tile('doors').innerText(), '1');
  const aText = await row('Anna Apple').innerText(); assert.doesNotMatch(aText, /to order/); assert.match(aText, /Everything ordered/); assert.match(aText, /2\/5/);
  ok('the dashboard shows which projects still wait for carcasses or doors; the two numbers are separate, they are filters, and ticking one removes only that flag');

  // ------------------------------------------------------------------ 5. date and notes, saved against a revision; a conflict is explained
  await row('Anna Apple').click(); await page.waitForSelector('#pj-date');
  assert.equal(await page.isDisabled('#pj-save'), true);
  await page.fill('#pj-date', '2026-11-20'); await page.fill('#pj-notes', 'Gate code 1234');
  assert.equal(await page.isDisabled('#pj-save'), false); assert.match(await page.textContent('#pj-save-msg'), /Unsaved/);
  await page.click('#pj-save'); await page.waitForFunction(() => /Saved/.test(document.getElementById('pj-save-msg').textContent));
  let saved = await proj(pa.id); assert.equal(saved.installDate, '2026-11-20'); assert.equal(saved.notes, 'Gate code 1234'); assert.equal(saved.rev, 2);
  assert.equal(await page.inputValue('#pj-date'), '2026-11-20'); assert.equal(await page.inputValue('#pj-notes'), 'Gate code 1234');
  await page.fill('#pj-notes', 'My edit, typed while somebody else saved');
  await db.doc('projects/' + pa.id).update({ notes: 'Their edit', rev: 3 });
  await page.waitForFunction(() => document.getElementById('pj-notes').value === 'My edit, typed while somebody else saved');         // my typing is never overwritten by a live update
  await page.click('#pj-save'); await page.waitForSelector('#pj-reload:not([hidden])');
  assert.match(await page.textContent('#pj-save-msg'), /changed by someone else/); assert.equal((await proj(pa.id)).notes, 'Their edit');
  await page.click('#pj-reload'); await page.waitForFunction(() => document.getElementById('pj-notes').value === 'Their edit');
  await go('#projects', '#pj-list .projrow');
  assert.match(await row('Anna Apple').innerText(), /Install 20 Nov 2026/);
  const order = await page.locator('#pj-list .qrow-name').allInnerTexts(); assert.deepEqual(order, ['Anna Apple', 'Brian Byrne'], 'the project with the soonest installation comes first');
  ok('installation date and notes are saved, shown on the dashboard, never overwritten by a live update, and a clash with someone else\'s save is explained (and can be resolved)');

  // ------------------------------------------------------------------ 6. the approved 3D render
  await row('Anna Apple').click(); await page.waitForSelector('#pj-attach');
  assert.match(await page.textContent('#pj-render'), /No render attached yet/); assert.equal(await page.textContent('#pj-attach'), 'Attach render');
  await page.setInputFiles('#pj-file', { name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('<html><script>alert(1)</script></html>') });
  await page.waitForFunction(() => /JPG, PNG or WebP|not what its type says/.test(document.getElementById('pj-render-msg').textContent));
  assert.equal((await proj(pa.id)).render, null); assert.equal((await bucket.getFiles({ prefix: 'uploads/' }))[0].length, 0, 'the refused upload was deleted');
  await page.setInputFiles('#pj-file', { name: 'gif.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
  await page.waitForFunction(() => /JPG, PNG or WebP/.test(document.getElementById('pj-render-msg').textContent));
  await page.setInputFiles('#pj-file', { name: 'Kitchen render.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForSelector('#pj-render-img'); await until(async () => (await proj(pa.id)).render, 'render recorded');
  const r1 = (await proj(pa.id)).render; assert.equal(r1.mime, 'image/png'); assert.equal(r1.filename, 'Kitchen render.png'); assert.match(r1.path, new RegExp(`^projects/${ph.anna}/${pa.id}/render-`));
  assert.equal(await page.textContent('#pj-attach'), 'Replace render'); assert.equal(await page.isVisible('#pj-render-open'), true);
  assert.match(await page.textContent('#pj-render'), /Kitchen render\.png/);
  assert.equal(await page.locator('#pj-render-img').evaluate((i) => i.naturalWidth), 1, 'the picture really loaded');
  assert.deepEqual((await bucket.getFiles({ prefix: 'projects/' }))[0].map((f) => f.name), [r1.path]);
  await page.setInputFiles('#pj-file', { name: 'plan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% plan\n%%EOF') });
  await page.waitForFunction(() => /PDF: /.test(document.getElementById('pj-render').textContent));
  assert.deepEqual((await bucket.getFiles({ prefix: 'projects/' }))[0].map((f) => f.name), [(await proj(pa.id)).render.path], 'the picture it replaced is gone');
  await page.screenshot({ path: path.join(SHOTS, 'projects-detail.png') });
  ok('the approved render: a fake picture and an unsupported type are refused (nothing is stored), a real PNG is shown, and a replacement removes the old file');

  // ------------------------------------------------------------------ 7. completing, and undoing it
  await go('#projects/' + pa.id, '#pj-complete'); await page.click('#pj-complete');
  await page.waitForSelector('#pj-complete-yes'); assert.match(await page.textContent('#pj-actions'), /3 steps are not ticked/); assert.equal(await page.textContent('#pj-complete-yes'), 'Complete anyway');
  await page.click('#pj-complete-no'); assert.equal(await page.locator('#pj-complete-yes').count(), 0); assert.equal((await proj(pa.id)).status, 'active');
  await page.click('#pj-complete'); await page.click('#pj-complete-yes');
  await until(async () => (await proj(pa.id)).status === 'completed', 'completed');
  await page.waitForSelector('#pj-reopen'); assert.match(await page.textContent('#pj-banner'), /Completed on/);
  assert.equal(await page.isDisabled('#pj-step-installed'), true, 'a completed project cannot be changed until it is reopened');
  await go('#projects', '#pj-list .projrow'); await page.waitForFunction(() => document.querySelectorAll('#pj-list .projrow').length === 1);
  assert.match(await page.locator('#pj-list').innerText(), /Brian Byrne/); assert.equal(await tile('carcasses').innerText(), '1', 'a completed project waits for nothing');
  await page.click('#pj-filter button[data-filter="completed"]'); await page.waitForFunction(() => /Anna Apple/.test(document.getElementById('pj-list').textContent));
  assert.match(await page.locator('#pj-list').innerText(), /Completed/);
  await row('Anna Apple').click(); await page.waitForSelector('#pj-reopen'); await page.click('#pj-reopen');
  await until(async () => (await proj(pa.id)).status === 'active', 'reopened'); await page.waitForSelector('#pj-complete'); assert.equal(await page.isDisabled('#pj-step-installed'), false);
  ok('a project can be marked completed (with a warning when steps are missing), leaves the active list and the "to order" numbers, and can be reopened');

  // ------------------------------------------------------------------ 8. deleting a project: always possible, and the confirmation says what will be lost
  await go('#projects/' + pa.id, '#pj-remove'); await page.click('#pj-remove'); await page.waitForSelector('#pj-remove-yes');            // Anna's has ticks, a date, notes and a render
  const warn = await page.textContent('#pj-remove-text');
  assert.match(warn, /its checklist \(2 steps ticked\)/); assert.match(warn, /the installation date/); assert.match(warn, /the notes/); assert.match(warn, /the attached render/);
  assert.match(warn, /quote and the customer are not touched/); assert.match(warn, /cannot be undone/);
  await page.click('#pj-remove-no'); assert.ok(await proj(pa.id), 'Cancel deletes nothing');
  await go('#projects/' + pb.id, '#pj-remove'); await page.click('#pj-remove'); await page.waitForSelector('#pj-remove-yes');            // Brian's has nothing in it
  assert.doesNotMatch(await page.textContent('#pj-remove-text'), /erases/); await page.click('#pj-remove-no'); assert.ok(await proj(pb.id));
  await page.click('#pj-remove'); await page.click('#pj-remove-yes'); await page.waitForSelector('#pj-list-view:not([hidden])');
  await until(async () => !(await proj(pb.id)), 'deleted'); assert.equal((await quote(qBrian)).status, 'accepted', 'the quote itself is untouched');
  ok('a project can always be deleted: the confirmation says what is lost (checklist, date, notes, render), Cancel changes nothing, and the quote is untouched');

  // ------------------------------------------------------------------ 9. by hand, from the customer profile; and linking an accepted quote that has no project
  await page.evaluate(() => { location.hash = '#c/353860000023'; }); await page.waitForSelector('#d-project-new');
  await page.waitForFunction(() => /No projects yet/.test(document.getElementById('d-projects-list').textContent));
  await page.click('#d-project-new'); await page.waitForSelector('#np-dlg[open]'); assert.match(await page.textContent('#np-who'), /Cara Cullen/);
  assert.equal(await page.locator('#np-quotes input').count(), 1); assert.equal(await page.isChecked('#np-quotes input[value=""]'), true);
  await page.click('#np-go'); await page.waitForSelector('#pj-step-doorsOrdered');
  const pc = (await projectsOf(ph.cara))[0]; assert.equal(pc.createdVia, 'manual'); assert.equal(pc.quoteId, null); assert.match(pc.id, /^m_/);
  assert.match(await page.textContent('#pj-quote'), /No quote is linked/);
  await page.click('#pj-back'); await page.waitForSelector('#d-project-new');                           // back to the customer's chat (where it came from)
  await page.waitForFunction(() => /No quote/.test(document.getElementById('d-projects-list').textContent));
  assert.match(await page.textContent('#d-projects-list'), /To order: carcasses, doors/);
  const qDan = await makeSentQuote(ph.dan); await acceptByCall(qDan); const pd = (await projectsOf(ph.dan))[0]; await db.doc('projects/' + pd.id).delete();      // an accepted quote whose project was removed
  await page.evaluate(() => { location.hash = '#c/353860000024'; }); await page.waitForSelector('#d-project-new');
  await page.waitForFunction(() => /No projects yet/.test(document.getElementById('d-projects-list').textContent));
  await page.click('#d-project-new'); await page.waitForSelector('#np-dlg[open]');
  assert.equal(await page.locator('#np-quotes input').count(), 2); assert.equal(await page.isChecked(`#np-quotes input[value="${qDan}"]`), true, 'the accepted quote is offered and chosen');
  assert.match(await page.textContent('#np-quotes'), new RegExp((await quote(qDan)).ref));
  await page.click('#np-go'); await page.waitForSelector('#pj-quote-link');
  const pd2 = (await projectsOf(ph.dan))[0]; assert.equal(pd2.id, pd.id); assert.equal(pd2.quoteId, qDan); assert.equal(pd2.createdVia, 'manual'); assert.equal((await projectsOf(ph.dan)).length, 1);
  ok('a project can be made by hand from the customer profile (with or without an accepted quote), and an accepted quote can never end up with two projects');

  // ------------------------------------------------------------------ 10. a reopened quote is flagged, and the profile block works
  await call('reopenQuote', { id: qAnna, expectedRev: (await quote(qAnna)).rev });
  await go('#projects/' + pa.id, '#pj-banner:not([hidden])'); assert.match(await page.textContent('#pj-banner'), /quote was reopened after it was accepted/);
  assert.equal((await proj(pa.id)).status, 'active'); assert.equal(await page.isChecked('#pj-step-doorsOrdered'), true, 'nothing was lost');
  await acceptByCall(qAnna); await page.waitForFunction(() => document.getElementById('pj-banner').hidden); assert.equal((await projectsOf(ph.anna)).length, 1, 'accepting again made no second project');
  assert.equal(await page.isChecked('#pj-step-doorsOrdered'), true);
  await page.evaluate(() => { location.hash = '#c/353860000021'; }); await page.waitForSelector('#d-projects-list .d-quote');
  const blk = await page.textContent('#d-projects-list'); assert.match(blk, new RegExp(pa.quoteRef)); assert.match(blk, /Install 20 Nov 2026/); assert.match(blk, /Everything ordered/);
  await page.click('#d-projects-list .d-quote'); await page.waitForSelector('#pj-step-doorsOrdered'); await page.click('#pj-back'); await page.waitForSelector('#d-projects-list .d-quote');
  ok('reopening the quote flags the project (nothing lost) and accepting again clears the flag without a second project; the customer profile lists the project and opens it');

  // ------------------------------------------------------------------ 10b. deleting a project that has work and a render in it (and a completed one)
  await go('#projects/' + pc.id, '#pj-step-designApproved'); await page.click('#pj-step-designApproved'); await until(async () => (await proj(pc.id)).steps.designApproved.done, 'design ticked');
  await page.setInputFiles('#pj-file', { name: 'cara.png', mimeType: 'image/png', buffer: PNG }); await page.waitForSelector('#pj-render-img');
  assert.equal((await bucket.getFiles({ prefix: 'projects/' + ph.cara + '/' }))[0].length, 1);
  await page.click('#pj-complete'); await page.click('#pj-complete-yes'); await until(async () => (await proj(pc.id)).status === 'completed', 'completed');           // delete it while completed
  await page.waitForSelector('#pj-remove'); await page.click('#pj-remove'); assert.match(await page.textContent('#pj-remove-text'), /1 step ticked\)/);
  await page.click('#pj-remove-yes'); await page.waitForSelector('#pj-list-view:not([hidden])'); await until(async () => !(await proj(pc.id)), 'deleted with its render');
  assert.equal((await bucket.getFiles({ prefix: 'projects/' + ph.cara + '/' }))[0].length, 0, 'its render file is gone from storage');
  assert.ok((await db.doc('conversations/' + ph.cara).get()).exists, 'the customer is untouched'); assert.ok(await proj(pd.id), 'another customer\'s project is untouched');
  ok('a completed project with ticked steps and an attached render can be deleted: the record and its render file are erased, the customer and other projects are not');

  // ------------------------------------------------------------------ 11. a phone
  await ctx.close();
  ({ ctx, page } = await open({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true }));
  assert.equal(await page.isVisible('#to-projects'), true); assert.equal(await page.locator('.pane-head h1').evaluate((h) => h.getBoundingClientRect().height < 40), true, 'the header is unchanged');
  await page.tap('#to-projects'); await page.waitForSelector('#pj-list .projrow');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scrolling on the dashboard');
  await page.screenshot({ path: path.join(SHOTS, 'projects-phone-list.png') });
  await page.tap('#pj-list .projrow'); await page.waitForSelector('#pj-step-doorsOrdered');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scrolling on a project');
  const colX = await page.evaluate(() => [document.querySelector('.pjv-main').getBoundingClientRect().left, document.querySelector('.pjv-side').getBoundingClientRect().left]); assert.equal(colX[0], colX[1], 'one column on a phone');
  await page.tap('#pj-step-carcassesOrdered'); await until(async () => (await proj(pa.id)).steps.carcassesOrdered.done === false, 'a tap on a phone clears the box');
  await page.screenshot({ path: path.join(SHOTS, 'projects-phone-detail.png') });
  await page.tap('#pj-back'); await page.waitForSelector('#pj-list .projrow'); await page.tap('#pj-back'); await page.waitForSelector('.pane-head');
  ok('on a phone: Projects is one tap away, the dashboard and a project fit the screen in one column, and Back returns step by step');
  await ctx.close();

  assert.deepEqual(errors.filter((e) => !/permission|insufficient|PERMISSION/i.test(e)), [], 'browser errors: ' + JSON.stringify(errors)); ok('no unexpected JavaScript errors');
  console.log(`ALL ${n} CHECKS PASSED`);
  await browser.close(); web.close(); process.exit(0);
})().catch(async (e) => { console.error('FAILED:', e && e.stack || e); try { await global.__page?.screenshot({ path: path.join(SHOTS, 'projects-fail.png') }); } catch (_) { /* no page */ } process.exit(1); });
