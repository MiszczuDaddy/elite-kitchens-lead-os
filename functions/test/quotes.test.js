// Phase 6 M2: quotes on the server (docs/QUOTES.md). Real Firestore + Storage emulators. Every price, name and business
// detail below is made up.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const h = require('../lib/handlers');
const store = require('../lib/store');
const Q = require('../lib/quotes');
const QE = require('../lib/quoteEngine');

const PROJECT = 'demo-leados';
const BUCKET = 'demo-leados.firebasestorage.app';
initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
const db = getFirestore();
const bucket = getStorage().bucket(BUCKET);
const cfg = { allowedEmails: 'thomas@example.com' };
const staff = { uid: 'u1', token: { email: 'thomas@example.com', email_verified: true, staff: true } };
const actor = { kind: 'staff', id: 'thomas@example.com' };
const deps = { db, cfg, bucket };
const rejects = (p, code, msg) => assert.rejects(p, (e) => e.code === code && (!msg || msg.test(e.message)), `expected ${code}${msg ? ' ' + msg : ''}`);

// Fixed clock: Friday 2 Oct 2026, 10:00 in Dublin (09:00 UTC, Irish summer time).
const MIN = 60 * 1000, DAY = 24 * 60 * MIN;
const NOW = Date.UTC(2026, 9, 2, 9, 0);
const P = '353851111111', R = '353852222222';
const PDF = Buffer.from('%PDF-1.4\n% Elite OS test quote\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const PRICE_LIST = {
  options: { ess: { perDoor: 110, perTopBox: 60 }, prem: { perDoor: 140, perTopBox: 65 }, pp: { perDoor: 150, perTopBox: 70 } },
  drawerBoxes: { cemux: 12, blum: 21 }, glazing: { small: 45, large: 90 },
  extras: [{ key: 'bin', name: 'Pull-out bin', unit: 'per unit', price: 30 }],
};
const SETTINGS = { priceList: PRICE_LIST, vatRate: 13.5, validityDays: 30,
  business: { tradingName: 'Elite Kitchens', signatureName: 'Test Person', phone: '01 000 0000', email: 'quotes@example.com', web: 'www.example.com', address: 'Test Street, Dublin', vatNumber: 'IE0000000X' } };

let seq = 0;
const rid = () => 'req-' + (++seq) + '-abcdefgh';
const run = (fn, data, nowMs = NOW, uid = 'u1') => fn(deps, actor, data, { nowMs, uid });
const conv = async (p = P) => (await db.doc('conversations/' + p).get()).data();
const contact = async (p = P) => (await db.doc('contacts/' + p).get()).data();
const quote = async (id) => (await db.doc('quotes/' + id).get()).data();
const version = async (id, n) => (await db.doc(`quotes/${id}/versions/${n}`).get()).data();
const settingsDoc = async () => (await db.doc('quoteSettings/current').get()).data();
const files = async (prefix) => (await bucket.getFiles({ prefix }))[0].map((f) => f.name);
const quoteCount = async () => (await db.collection('quotes').get()).size;
async function seed(p = P, convExtra = {}, name = 'Anna', contactExtra = {}) {
  await db.doc('contacts/' + p).set({ phone: p, name, email: 'anna@example.com', address: '1 Main Street, Swords', location: 'Swords', createdAt: Timestamp.now(), ...contactExtra });
  await db.doc('conversations/' + p).set({ phone: p, name, createdAt: Timestamp.now(), updatedAt: Timestamp.now(), lastMessage: 'Hi', unreadCount: 2, ...convExtra });
}
const setup = () => run(Q.saveSettings, SETTINGS);
function answers(patch = {}) {
  const a = QE.current().newAnswers(PRICE_LIST);
  a.doors = 10; a.drawers = 4; a.options.ess.drawerBox = 'cemux';
  a.options.prem = { ...a.options.prem, on: true, drawerBox: 'blum' };
  return Object.assign(a, patch);
}
async function upload(bytes = PDF, uid = 'u1') {
  const p = `uploads/${uid}/${Date.now()}-${++seq}-quote.pdf`;
  await bucket.file(p).save(bytes, { contentType: 'application/pdf' });
  return p;
}
const make = (p = P, a = answers()) => run(Q.create, { phone: p, requestId: rid(), answers: a });
async function sendData(id, over = {}, nowMs = NOW) {
  const qq = await quote(id), s = await settingsDoc();
  const ct = (await db.doc('contacts/' + qq.phone).get()).data() || {}, cv = await conv(qq.phone);
  return { id, expectedRev: qq.rev, requestId: rid(), issueDate: Q.dublinDate(nowMs), settingsRev: s.rev,
    customer: { name: ct.name || cv.name || null, email: ct.email || null, address: ct.address || null }, pdfUploadPath: await upload(), ...over };
}
const send = async (id, over = {}, nowMs = NOW) => run(Q.send, await sendData(id, over, nowMs), nowMs);
async function sent(p = P, nowMs = NOW, over = {}) { const { id } = await make(p); await send(id, over, nowMs); return id; }
const accept = async (id, over = {}, nowMs = NOW) => run(Q.accept, { id, expectedRev: (await quote(id)).rev, option: 'prem', ...over }, nowMs);

beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await bucket.deleteFiles({ force: true }).catch(() => {});
});

// ======================================================= who may call =====================================================
test('only signed-in, allowlisted staff can use any quote action or add a customer; nothing is written otherwise', async () => {
  await seed(); await setup();
  const people = [[null, 'unauthenticated'],
    [{ uid: 'x', token: { email: 'stranger@gmail.com', email_verified: true, staff: true } }, 'permission-denied'],
    [{ uid: 'x', token: { email: 'thomas@example.com', email_verified: true } }, 'permission-denied']];      // allowlisted, no staff claim
  const calls = ['saveQuoteSettings', 'setQuoteNumbering', 'createQuote', 'saveQuoteDraft', 'sendQuote', 'acceptQuote', 'declineQuote', 'reopenQuote',
    'reviseQuote', 'discardQuoteDraft', 'deleteQuoteDraft', 'setQuoteNotes', 'quotePdfUrl', 'createCustomer'];
  for (const [who, code] of people) for (const name of calls) await rejects(h[name](who, { phone: R, name: 'X', requestId: rid() }, deps), code);
  assert.equal(await quoteCount(), 0);
  assert.equal((await db.doc('conversations/' + R).get()).exists, false);
  assert.equal((await settingsDoc()).rev, 1);
  const r = await h.createQuote(staff, { phone: P, requestId: rid() }, deps);                 // staff can, through the real wrapper
  assert.deepEqual((await quote(r.id)).createdBy, actor);
});

// ========================================================= settings =======================================================
test('Quote Settings: every price, the VAT rate, validity and business name are checked; saves need the latest revision', async () => {
  const bad = [
    { ...SETTINGS, priceList: { ...PRICE_LIST, glazing: { small: 45 } } }, { ...SETTINGS, vatRate: 13.555 }, { ...SETTINGS, vatRate: '13.5' },
    { ...SETTINGS, vatRate: -1 }, { ...SETTINGS, validityDays: 0 }, { ...SETTINGS, validityDays: 366 }, { ...SETTINGS, validityDays: 30.5 },
    { ...SETTINGS, business: { ...SETTINGS.business, tradingName: '' } }, { ...SETTINGS, business: { ...SETTINGS.business, email: 'nope' } },
    { ...SETTINGS, business: { ...SETTINGS.business, iban: 'IE00' } }, { ...SETTINGS, colour: 'red' }, { ...SETTINGS, business: null },
  ];
  for (const b of bad) await rejects(run(Q.saveSettings, b), 'invalid-argument');
  assert.equal((await db.doc('quoteSettings/current').get()).exists, false);
  await rejects(run(Q.saveSettings, { ...SETTINGS, priceList: { ...PRICE_LIST, drawerBoxes: {} } }), 'invalid-argument', /Cemux/);
  const e = await run(Q.saveSettings, { ...SETTINGS, priceList: { ...PRICE_LIST, drawerBoxes: {} } }).catch((x) => x);
  assert.deepEqual(e.details.errors.map((x) => x.field), ['priceList.drawerBoxes.cemux', 'priceList.drawerBoxes.blum']);
  assert.deepEqual(await setup(), { rev: 1 });
  await rejects(setup(), 'failed-precondition');                                            // a second save must name revision 1
  assert.deepEqual(await run(Q.saveSettings, { ...SETTINGS, vatRate: 23, expectedRev: 1 }), { rev: 2 });
  await rejects(run(Q.saveSettings, { ...SETTINGS, expectedRev: 1 }), 'failed-precondition');   // someone else saved meanwhile
  const s = await settingsDoc();
  assert.equal(s.vatRate, 23); assert.equal(s.business.tradingName, 'Elite Kitchens'); assert.equal(s.history.length, 2);
  assert.equal(s.business.web, 'www.example.com');
});

test('a quote can be made from Quote Settings saved the way the settings screen saves them (catalogue items without keys)', async () => {
  await seed();
  await run(Q.saveSettings, { ...SETTINGS, priceList: { ...PRICE_LIST, extras: [{ name: 'Bin', unit: 'per unit', price: 30 }, { name: 'Pocket door', manual: true }] } });
  const r = await run(Q.create, { phone: P, requestId: rid() });
  assert.equal((await quote(r.id)).status, 'draft');
  assert.deepEqual((await settingsDoc()).priceList.extras.map((e) => e.key), ['', '']);
});

test('a quote needs Quote Settings and an existing customer; nothing is created otherwise', async () => {
  await seed();
  await rejects(make(), 'failed-precondition', /Quote Settings/);
  await setup();
  await rejects(make('353800000000'), 'not-found');
  for (const b of [{ phone: '123', requestId: rid() }, { phone: P, requestId: 'short' }, { phone: P, requestId: rid(), colour: 'red' }, null]) await rejects(run(Q.create, b), 'invalid-argument');
  assert.equal(await quoteCount(), 0);
  assert.equal((await db.doc('counters/quoteNumber').get()).exists, false);                // no number used up
});

// ========================================================= numbering ======================================================
test('numbering: TEST numbers until the starting number is set, then EK numbers that only go up', async () => {
  await seed(); await setup();
  const t1 = await make(), t2 = await make();
  assert.deepEqual([t1.ref, t2.ref], ['TEST-0001', 'TEST-0002']);
  for (const next of [0, -5, 1.5, '34', 1000000]) await rejects(run(Q.setNumbering, { next }), 'invalid-argument');
  assert.deepEqual(await run(Q.setNumbering, { next: 34 }), { next: 34, ref: 'EK-0034' });
  const a = await make(), b = await make();
  assert.deepEqual([a.ref, b.ref], ['EK-0034', 'EK-0035']);
  assert.equal((await quote(a.id)).number, 34);
  await rejects(run(Q.setNumbering, { next: 35 }), 'invalid-argument', /only go up/);       // EK-0035 is taken: 36 is next
  await run(Q.setNumbering, { next: 40 });
  assert.equal((await make()).ref, 'EK-0040');
  assert.equal((await quote(t1.id)).ref, 'TEST-0001');                                       // test quotes keep their test numbers
  const again = await run(Q.create, { phone: P, requestId: (await quote(a.id)).requestId, answers: answers() });
  assert.deepEqual([again.id, again.existing, again.ref], [a.id, true, 'EK-0034']);          // a repeated request takes no number
  assert.equal((await db.doc('counters/quoteNumber').get()).data().next, 41);
});

// ====================================================== create and edit ===================================================
test('create: a draft v1 priced by the server with the price list, linked by phone; a repeated request creates nothing new', async () => {
  await seed(); await setup();
  const before = await conv();
  const r = await run(Q.create, { phone: '+353 85 111 1111', requestId: 'same-request-1' });
  const q = await quote(r.id), v = await version(r.id, 1);
  assert.deepEqual([q.phone, q.status, q.customerName, q.currentVersion, q.sentVersion, q.draftVersion, q.rev], [P, 'draft', 'Anna', 1, null, 1, 1]);
  assert.deepEqual(v.engine, { id: 'ek-packages', version: 1 });
  assert.deepEqual(v.answers, QE.current().newAnswers(PRICE_LIST));                            // a blank quote from the price list
  assert.deepEqual(v.priceList, (await settingsDoc()).priceList); assert.equal(v.vatRate, 13.5);
  assert.deepEqual(v.sheet, QE.current().calculate(v.answers, PRICE_LIST, { vatRate: 13.5 }));
  assert.deepEqual(q.summary.options.map((o) => o.key), ['ess']);
  assert.deepEqual(q.history.map((x) => x.action), ['created']);
  const again = await run(Q.create, { phone: P, requestId: 'same-request-1' });
  assert.equal(again.id, r.id); assert.equal(again.existing, true); assert.equal(await quoteCount(), 1);
  assert.deepEqual(await conv(), before);                                                      // creating changes nothing in the pipeline
  assert.equal(r.id, Q.quoteId(P, 'same-request-1'));
});

test('create: the quote\'s project (the wording of its PDF) starts as the customer\'s Project type', async () => {
  const P2 = '353862222222', P3 = '353873333333';
  await seed(P, {}, 'Anna', { projectType: 'Wardrobes' }); await seed(P2, { projectType: 'Kitchen & wardrobes' }, 'Brian'); await seed(P3, {}, 'Ciara'); await setup();
  const projectOf = async (p) => (await version((await run(Q.create, { phone: p, requestId: rid() })).id, 1)).answers.project;
  assert.deepEqual([await projectOf(P), await projectOf(P2), await projectOf(P3)], ['wardrobes', 'kitchen-wardrobes', 'kitchen']);
  const { id } = await run(Q.create, { phone: P, requestId: rid() });
  assert.deepEqual((await version(id, 1)).sheet.document.project, { type: 'wardrobes', name: '' });
  assert.ok(!(await version(id, 1)).sheet.document.notIncluded.includes('Appliances'));
});

test('saving a draft: the server recalculates; invalid answers are refused with every problem listed; stale saves are refused', async () => {
  await seed(); await setup();
  const { id } = await make();
  const a = answers({ doors: 14, extras: [{ name: 'Bin', qty: 2, unitPrice: 30 }] });
  const r = await run(Q.saveDraft, { id, expectedRev: 1, answers: a });
  const v = await version(id, 1);
  assert.deepEqual(v.sheet, QE.current().calculate(a, PRICE_LIST, { vatRate: 13.5 }));
  assert.deepEqual(r.sendProblems, []); assert.equal(r.rev, 2);
  assert.deepEqual((await quote(id)).summary.options.map((o) => o.incVat), v.sheet.options.map((o) => o.incVat));
  await rejects(run(Q.saveDraft, { id, expectedRev: 2, answers: a, sheet: { options: [{ incVat: 1 }] } }), 'invalid-argument', /Unknown field: sheet/);
  const e = await run(Q.saveDraft, { id, expectedRev: 2, answers: { ...a, doors: -1, extras: [{ name: '', qty: 1, unitPrice: 9 }] } }).catch((x) => x);
  assert.equal(e.code, 'invalid-argument');
  assert.deepEqual(e.details.errors.map((x) => x.field), ['doors', 'extras.0.name']);
  await rejects(run(Q.saveDraft, { id, expectedRev: 1, answers: a }), 'failed-precondition', /changed by someone else/);
  for (const x of [{ id: 'nope', expectedRev: 2 }, { id, answers: a }, { id, expectedRev: '2' }]) await rejects(run(Q.saveDraft, x), 'invalid-argument');
  await run(Q.saveDraft, { id, expectedRev: 2, answers: a }); await run(Q.saveDraft, { id, expectedRev: 3, answers: a });
  assert.deepEqual((await quote(id)).history.map((x) => x.action), ['created', 'edited']);    // repeated saves: one entry
  const none = answers(); none.options.ess.on = false; none.options.prem.on = false;
  assert.deepEqual((await run(Q.saveDraft, { id, expectedRev: 4, answers: none })).sendProblems, ['Choose at least one option (Essential, Premium or Premium Plus).']);
});

test('prices are frozen per quote: a settings change never alters a quote; "Update to current prices" applies it to a draft only', async () => {
  await seed(); await setup();
  const { id } = await make();
  const s1 = await version(id, 1);
  const dearer = { ...PRICE_LIST, drawerBoxes: { cemux: 50, blum: 80 }, glazing: { small: 100, large: 200 } };
  await run(Q.saveSettings, { ...SETTINGS, priceList: dearer, vatRate: 23, expectedRev: 1 });
  await run(Q.saveDraft, { id, expectedRev: 1, answers: answers() });
  assert.deepEqual((await version(id, 1)).priceList, s1.priceList);                          // still the price list it was made with
  assert.equal((await version(id, 1)).vatRate, 13.5);
  await run(Q.saveDraft, { id, expectedRev: 2, useCurrentPrices: true });
  const v = await version(id, 1);
  assert.deepEqual([v.priceList.drawerBoxes, v.vatRate], [dearer.drawerBoxes, 23]);
  assert.deepEqual(v.sheet, QE.current().calculate(answers(), dearer, { vatRate: 23 }));
  assert.equal((await quote(id)).history.at(-1).action, 'prices updated');
  // and once sent, nothing changes it any more
  await send(id);
  const frozen = await version(id, 1);
  await run(Q.saveSettings, { ...SETTINGS, expectedRev: 2 });
  await rejects(run(Q.saveDraft, { id, expectedRev: (await quote(id)).rev, useCurrentPrices: true }), 'failed-precondition', /no draft/);
  assert.deepEqual(await version(id, 1), frozen);
});

// ============================================================ send ========================================================
test('send: freezes the version, stores the exact PDF privately, removes the upload and marks the quote Sent', async () => {
  await seed(); await setup();
  const { id } = await make();
  const data = await sendData(id);
  const r = await run(Q.send, data);
  assert.deepEqual([r.status, r.sentVersion, r.draftVersion, r.validUntil, r.existing], ['sent', 1, null, '2026-11-01', false]);
  const v = await version(id, 1), q = await quote(id);
  assert.equal(v.state, 'sent'); assert.equal(v.issueDate, '2026-10-02'); assert.equal(v.validUntil, '2026-11-01');   // 30 days
  assert.deepEqual(v.customer, { name: 'Anna', email: 'anna@example.com', address: '1 Main Street, Swords', phone: P });
  assert.deepEqual(v.business, SETTINGS.business);
  assert.deepEqual(v.sentBy, actor);
  assert.equal(v.pdf.size, PDF.length);
  assert.equal(v.pdf.sha256, crypto.createHash('sha256').update(PDF).digest('hex'));
  assert.ok(v.pdf.path.startsWith(`quotes/${P}/${id}/v1-`));
  const [stored] = await bucket.file(v.pdf.path).download();
  assert.ok(stored.equals(PDF), 'the stored file is byte-for-byte the uploaded PDF');
  assert.equal((await bucket.file(data.pdfUploadPath).exists())[0], false);                  // the temporary upload is gone
  assert.deepEqual(q.sent, { version: 1, issueDate: '2026-10-02', validUntil: '2026-11-01', summary: q.summary });
  assert.deepEqual(q.history.map((x) => x.action), ['created', 'sent']);
  assert.equal(q.lastSendRequestId, data.requestId);
});

test('send is refused, and nothing is stored or changed, when anything is not right', async () => {
  await seed(); await setup();
  const { id } = await make();
  const before = { q: await quote(id), c: await conv() };
  const none = answers(); none.options.ess.on = false; none.options.prem.on = false;
  const cases = [
    [{ issueDate: '2026-10-03' }, 'invalid-argument', /today/], [{ issueDate: '2026-09-30' }, 'invalid-argument'], [{ issueDate: '2/10/2026' }, 'invalid-argument'],
    [{ pdfUploadPath: 'uploads/u2/x.pdf' }, 'permission-denied'], [{ pdfUploadPath: 'uploads/u1/../u2/x.pdf' }, 'permission-denied'],
    [{ pdfUploadPath: 'uploads/u1/missing.pdf' }, 'not-found'],
    [{ pdfUploadPath: await upload(Buffer.from('GIF89a not a pdf')) }, 'invalid-argument', /not a PDF/],
    [{ settingsRev: 7 }, 'failed-precondition', /Settings changed/],
    [{ customer: { name: 'Anna', email: 'old@example.com', address: '1 Main Street, Swords' } }, 'failed-precondition', /customer's details changed/],
    [{ expectedRev: 9 }, 'failed-precondition', /changed by someone else/],
    [{ pipeline: { value: 14500.5 } }, 'invalid-argument'], [{ pipeline: { value: 0 } }, 'invalid-argument'], [{ pipeline: { value: 1000001 } }, 'invalid-argument'],
    [{ pipeline: { reopen: 'yes' } }, 'invalid-argument'], [{ pipeline: { colour: 1 } }, 'invalid-argument'], [{ requestId: 'x' }, 'invalid-argument'], [{ extra: 1 }, 'invalid-argument'],
  ];
  for (const [over, code, msg] of cases) await rejects(run(Q.send, await sendData(id, over)), code, msg);
  await run(Q.saveDraft, { id, expectedRev: 1, answers: none });
  await rejects(send(id), 'failed-precondition', /at least one option/);
  assert.deepEqual(await files('quotes/'), []);                                               // no copy left behind by any refusal
  const after = await quote(id);
  assert.deepEqual([after.status, after.sentVersion, after.lastSendRequestId], ['draft', null, null]);
  assert.deepEqual(await conv(), before.c);
  await rejects(run(Q.send, { ...(await sendData(id)), id: 'q_' + '0'.repeat(24) }), 'not-found');   // no such quote
});

test('a big PDF is refused (over 25 MB), and yesterday\'s date is accepted for a quote made just before midnight', async () => {
  await seed(); await setup();
  const { id } = await make();
  const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(Q.PDF_MAX)]);
  await rejects(run(Q.send, await sendData(id, { pdfUploadPath: await upload(big) })), 'invalid-argument', /25 MB/);
  const r = await run(Q.send, await sendData(id, { issueDate: '2026-10-01' }));
  assert.equal(r.validUntil, '2026-10-31');
});

test('send is safe to repeat: the same request again changes nothing and keeps one PDF', async () => {
  await seed(); await setup();
  const { id } = await make();
  const data = await sendData(id, { pipeline: { value: 14500 } });
  const first = await run(Q.send, data);
  const again = await run(Q.send, data);
  assert.equal(again.existing, true); assert.equal(again.rev, first.rev);
  assert.equal((await files(`quotes/${P}/`)).length, 1);
  assert.equal((await quote(id)).pipelineChanges.length, 1);
});

// ===================================================== pipeline: sending ==================================================
test('sending moves a New lead to Quoted exactly like a manual move, and nothing else on the customer changes', async () => {
  await seed(P); await seed(R, {}, 'Brian'); await setup();
  const before = await conv(P);
  const { id } = await make();
  const r = await send(id);
  assert.deepEqual(r.stage, { from: 'inbox', to: 'quoted', corrected: false });
  await store.setConversationStatus(db, R, 'quoted', NOW);                                      // the same move made by hand
  const [p, q] = [await conv(P), await conv(R)];
  assert.equal(p.inboxStatus, 'quoted');
  assert.ok(p.stageDates.quoted instanceof Timestamp);
  assert.deepEqual(Object.keys(p.stageDates), Object.keys(q.stageDates));
  assert.deepEqual(p.lastMove, q.lastMove);
  const { inboxStatus, stageDates, lastMove, ...rest } = p;
  assert.deepEqual(rest, before);                                                               // activity, unread, preview, name: untouched
  assert.deepEqual((await quote(id)).pipelineChanges.map((c) => [c.action, c.stage]), [['sent', { from: 'inbox', to: 'quoted', corrected: false }]]);
});

test('sending: Booked -> Quoted; Quoted and Won are left alone; Closed only moves when staff tick "Reopen"', async () => {
  await setup();
  const stamp = Timestamp.fromMillis(NOW - 3 * DAY);
  const cases = [['booked', {}, 'quoted'], ['quoted', {}, 'quoted'], ['won', {}, 'won'], ['closed', {}, 'closed'], ['closed', { reopen: true }, 'quoted'], ['won', { reopen: true }, 'won']];
  for (const [i, [stage, pipeline, expected]] of cases.entries()) {
    const p = '35385900000' + i;
    await seed(p, { inboxStatus: stage, stageDates: { [stage]: stamp } });
    const before = await conv(p);
    const { id } = await make(p);
    const r = await send(id, { pipeline });
    const after = await conv(p);
    assert.equal(after.inboxStatus, expected, `${stage} ${JSON.stringify(pipeline)}`);
    if (expected === stage) { assert.deepEqual(after, before, `${stage}: nothing written`); assert.equal(r.stage, null); }
    else assert.deepEqual(r.stage, { from: stage, to: 'quoted', corrected: false });
  }
});

test('a move made by sending can be corrected within 5 minutes, exactly like a manual move', async () => {
  await seed(P, { inboxStatus: 'booked', stageDates: { booked: Timestamp.fromMillis(NOW - DAY) } }); await setup();
  await sent(P);
  const r = await store.setConversationStatus(db, P, 'booked', NOW + 2 * MIN);
  assert.deepEqual(r, { corrected: true, undone: 'quoted' });
  const c = await conv();
  assert.equal(c.inboxStatus, 'booked'); assert.equal(c.stageDates.quoted, undefined); assert.equal(c.lastMove, undefined);
  assert.equal(c.stageDates.booked.toMillis(), NOW - DAY);
});

test('pipeline value on send: only the amount staff confirm, recorded on the quote; "leave it" changes nothing', async () => {
  await seed(P, {}, 'Anna', { quoteValue: 9000 }); await setup();
  const { id } = await make();
  const r = await send(id, { pipeline: { value: 14500 } });
  assert.deepEqual(r.value, { from: 9000, to: 14500 });
  assert.equal((await contact()).quoteValue, 14500);
  assert.equal((await contact()).name, 'Anna');
  await run(Q.revise, { id, expectedRev: (await quote(id)).rev });
  const r2 = await send(id);                                                                    // no value given: left as it is
  assert.equal(r2.value, null); assert.equal((await contact()).quoteValue, 14500);
  await run(Q.revise, { id, expectedRev: (await quote(id)).rev });
  assert.equal((await send(id, { pipeline: { value: 14500 } })).value, null);                 // the same value: nothing to record
  assert.deepEqual((await quote(id)).pipelineChanges.map((c) => c.value), [{ from: 9000, to: 14500 }, null, null]);
});

// ================================================== revise, renew, discard ================================================
test('revise: a draft copy of the sent version with its prices frozen; the sent version and its PDF stay; discard goes back', async () => {
  await seed(); await setup();
  const id = await sent();
  const v1 = await version(id, 1);
  await run(Q.saveSettings, { ...SETTINGS, priceList: { ...PRICE_LIST, glazing: { small: 999, large: 999 } }, expectedRev: 1 });
  const r = await run(Q.revise, { id, expectedRev: (await quote(id)).rev });
  assert.deepEqual([r.status, r.currentVersion, r.sentVersion, r.draftVersion], ['sent', 2, 1, 2]);
  const v2 = await version(id, 2);
  assert.deepEqual([v2.state, v2.answers, v2.priceList, v2.vatRate, v2.engine], ['draft', v1.answers, v1.priceList, v1.vatRate, v1.engine]);
  await rejects(run(Q.revise, { id, expectedRev: r.rev }), 'failed-precondition', /already exists/);
  await run(Q.saveDraft, { id, expectedRev: r.rev, answers: answers({ doors: 30 }) });
  assert.deepEqual(await version(id, 1), v1);                                                   // what the customer has never changes
  assert.equal((await quote(id)).sent.summary.options[0].incVat, v1.sheet.options[0].incVat);
  const d = await run(Q.discardDraft, { id, expectedRev: (await quote(id)).rev });
  assert.deepEqual([d.currentVersion, d.draftVersion], [1, null]);
  assert.equal((await db.doc(`quotes/${id}/versions/2`).get()).exists, false);
  assert.deepEqual((await quote(id)).summary, (await quote(id)).sent.summary);
  assert.equal((await files(`quotes/${P}/${id}/`)).length, 1);
  await rejects(run(Q.discardDraft, { id, expectedRev: d.rev }), 'failed-precondition');
});

test('renew = revise + send unchanged: same prices even after a price change, a new issue date and validity, two PDFs kept', async () => {
  await seed(); await setup();
  const id = await sent();
  await run(Q.saveSettings, { ...SETTINGS, priceList: { ...PRICE_LIST, drawerBoxes: { cemux: 500, blum: 500 } }, expectedRev: 1 });
  const later = NOW + 40 * DAY;
  await run(Q.revise, { id, expectedRev: (await quote(id)).rev }, later);
  const r = await send(id, {}, later);
  assert.deepEqual([r.sentVersion, r.validUntil], [2, '2026-12-11']);
  const [v1, v2] = [await version(id, 1), await version(id, 2)];
  assert.deepEqual(v2.sheet, v1.sheet);                                                         // prices stayed frozen
  assert.deepEqual([v2.issueDate, v1.issueDate], ['2026-11-11', '2026-10-02']);
  assert.equal(r.stage, null);                                                                  // already Quoted: no change
  assert.equal((await files(`quotes/${P}/${id}/`)).length, 2);
});

test('a quote has at most 50 versions', async () => {
  await seed(); await setup();
  const id = await sent();
  await db.doc('quotes/' + id).update({ currentVersion: 50 });
  await rejects(run(Q.revise, { id, expectedRev: (await quote(id)).rev }), 'failed-precondition', /50 versions/);
});

// ========================================================== expiry ========================================================
test('expired is only a label: the quote stays Sent and every action still works on it', async () => {
  await seed(P); await seed(R, {}, 'Brian'); await setup();
  const a = await sent(P), b = await sent(R);
  const lastValidDay = Date.UTC(2026, 10, 1, 23, 59), dayAfter = Date.UTC(2026, 10, 2, 0, 30);   // Dublin is on UTC in November
  assert.equal(Q.isExpired(await quote(a), lastValidDay), false);
  assert.equal(Q.isExpired(await quote(a), dayAfter), true);
  assert.equal((await quote(a)).status, 'sent');                                                // nothing stored about expiry
  const acc = await accept(a, {}, dayAfter);
  assert.equal(acc.expired, true); assert.equal(acc.status, 'accepted');
  await run(Q.decline, { id: b, expectedRev: (await quote(b)).rev }, dayAfter);
  await run(Q.reopen, { id: b, expectedRev: (await quote(b)).rev }, dayAfter);
  await run(Q.revise, { id: b, expectedRev: (await quote(b)).rev }, dayAfter);
  const renewed = await send(b, {}, dayAfter);
  assert.equal(renewed.validUntil, '2026-12-02');
  assert.equal(Q.isExpired(await quote(b), dayAfter), false);
  assert.equal(Q.isExpired({ status: 'accepted', validUntil: '2026-01-01' }, dayAfter), false);  // only Sent quotes show Expired
});

// ========================================================== accept ========================================================
test('accept: chooses an option of the sent version; New lead / Booked / Quoted -> Won; Won left alone; Closed only when ticked', async () => {
  await setup();
  const stamp = Timestamp.fromMillis(NOW - 3 * DAY);
  const cases = [['booked', {}, 'won'], ['quoted', {}, 'won'], ['won', {}, 'won'], ['closed', {}, 'closed'], ['closed', { moveClosed: true }, 'won']];
  for (const [i, [stage, pipeline, expected]] of cases.entries()) {
    const p = '35385800000' + i;
    await seed(p, { inboxStatus: stage, stageDates: { [stage]: stamp } });
    const id = await sent(p, NOW, { pipeline: { reopen: false } });
    const before = await conv(p);
    const r = await accept(id, { pipeline });
    assert.equal((await conv(p)).inboxStatus, expected, `${stage} ${JSON.stringify(pipeline)}`);
    if (before.inboxStatus === expected) assert.deepEqual(await conv(p), before, `${stage}: nothing written`);
    else assert.deepEqual(r.stage, { from: before.inboxStatus, to: 'won', corrected: false });
    const q = await quote(id);
    assert.deepEqual(q.acceptedOption, { key: 'prem', name: 'Premium', incVat: (await version(id, 1)).sheet.options[1].incVat, version: 1 });
  }
  // a New lead (accepted straight away, e.g. a quote sent while Closed and not reopened is covered above)
  await seed(R);
  const id = await sent(R);
  await db.doc('conversations/' + R).update({ inboxStatus: 'inbox' });
  assert.deepEqual((await accept(id)).stage.to, 'won');
});

test('accept is refused for an option not on the quote, a draft, a declined or already-accepted quote, or pending changes', async () => {
  await seed(); await setup();
  const { id } = await make();
  await rejects(accept(id), 'failed-precondition', /Send the quote/);
  await send(id);
  await rejects(accept(id, { option: 'pp' }), 'invalid-argument', /options on the quote/);
  await rejects(accept(id, { pipeline: { value: 1.5 } }), 'invalid-argument');
  await run(Q.revise, { id, expectedRev: (await quote(id)).rev });
  await rejects(accept(id), 'failed-precondition', /draft changes/);
  await run(Q.discardDraft, { id, expectedRev: (await quote(id)).rev });
  await accept(id, { pipeline: { value: 21000 } });
  assert.equal((await contact()).quoteValue, 21000);
  await rejects(accept(id), 'failed-precondition', /already accepted/);
  const other = await sent(P);
  await run(Q.decline, { id: other, expectedRev: (await quote(other)).rev });
  await rejects(accept(other), 'failed-precondition', /Reopen it first/);
});

test('reopen an accepted quote within 5 minutes with "move back": a correction that leaves no trace; the value is restored', async () => {
  await seed(P, { inboxStatus: 'booked', stageDates: { booked: Timestamp.fromMillis(NOW - DAY) } }, 'Anna', { quoteValue: 9000 }); await setup();
  const id = await sent(P, NOW, { pipeline: { value: 15000 } });                             // Booked -> Quoted, value 15,000
  const quotedDate = (await conv()).stageDates.quoted;
  await accept(id, { pipeline: { value: 21000 } }, NOW + MIN);                                 // Quoted -> Won, value 21,000
  assert.equal((await conv()).inboxStatus, 'won');
  const r = await run(Q.reopen, { id, expectedRev: (await quote(id)).rev, pipeline: { moveBack: true, restoreValue: true } }, NOW + 3 * MIN);
  assert.deepEqual(r.stage, { from: 'won', to: 'quoted', corrected: true });
  assert.deepEqual(r.value, { from: 21000, to: 15000 });
  const c = await conv();
  assert.equal(c.inboxStatus, 'quoted'); assert.equal(c.stageDates.won, undefined); assert.equal(c.lastMove, undefined);
  assert.deepEqual(c.stageDates.quoted, quotedDate);                                            // the genuine Quoted date is kept
  assert.equal((await contact()).quoteValue, 15000);
  const q = await quote(id);
  assert.deepEqual([q.status, q.acceptedOption, q.acceptedAt], ['sent', null, null]);
  assert.deepEqual(q.pipelineChanges.map((x) => x.action), ['sent', 'accepted', 'reopened']);
  assert.match(q.history.at(-1).action, /reopened \(was accepted\)/);
});

test('reopen later than 5 minutes is a genuine move back; it is refused if the customer moved on or the value was changed', async () => {
  await seed(P); await seed(R, {}, 'Brian'); await setup();
  const a = await sent(P);
  await accept(a, {}, NOW + MIN);
  await run(Q.reopen, { id: a, expectedRev: (await quote(a)).rev, pipeline: { moveBack: true } }, NOW + 10 * MIN);
  const c = await conv(P);
  assert.equal(c.inboxStatus, 'quoted'); assert.ok(c.stageDates.won, 'a genuine move keeps the Won date'); assert.equal(c.lastMove.from, 'won');
  // the customer was moved on by hand after the accept: no move back, nothing changed
  const b = await sent(R);
  await accept(b, { pipeline: { value: 30000 } }, NOW + MIN);
  await store.setConversationStatus(db, R, 'closed', NOW + 20 * MIN);
  const before = { c: await conv(R), q: await quote(b) };
  await rejects(run(Q.reopen, { id: b, expectedRev: before.q.rev, pipeline: { moveBack: true } }, NOW + 30 * MIN), 'failed-precondition', /no longer in Won/);
  await db.doc('contacts/' + R).update({ quoteValue: 31000 });
  await rejects(run(Q.reopen, { id: b, expectedRev: before.q.rev, pipeline: { restoreValue: true } }, NOW + 30 * MIN), 'failed-precondition', /changed since/);
  assert.deepEqual(await conv(R), before.c); assert.equal((await quote(b)).status, 'accepted'); assert.equal((await contact(R)).quoteValue, 31000);
  // without the ticks, reopening changes only the quote
  await run(Q.reopen, { id: b, expectedRev: before.q.rev }, NOW + 30 * MIN);
  assert.deepEqual(await conv(R), before.c); assert.equal((await quote(b)).status, 'sent');
});

test('"move back" is refused when the accept did not move the customer (they were already Won)', async () => {
  await seed(P, { inboxStatus: 'won', stageDates: { won: Timestamp.fromMillis(NOW - DAY) } }); await setup();
  const id = await sent(P);
  await accept(id);
  await rejects(run(Q.reopen, { id, expectedRev: (await quote(id)).rev, pipeline: { moveBack: true } }), 'failed-precondition', /not moved by this quote/);
});

// ========================================================== decline =======================================================
test('decline never changes the stage or the pipeline value; a declined quote can be reopened or revised and sent again', async () => {
  await seed(P, { inboxStatus: 'quoted', stageDates: { quoted: Timestamp.fromMillis(NOW - DAY) } }, 'Anna', { quoteValue: 14000 }); await setup();
  const id = await sent(P);
  const before = { c: await conv(), ct: await contact() };
  await rejects(run(Q.decline, { id, expectedRev: (await quote(id)).rev, reason: 'x'.repeat(301) }), 'invalid-argument');
  const r = await run(Q.decline, { id, expectedRev: (await quote(id)).rev, reason: '  Went with another company  ' });
  assert.equal(r.status, 'declined');
  assert.deepEqual(await conv(), before.c); assert.deepEqual(await contact(), before.ct);
  const q = await quote(id);
  assert.equal(q.declineReason, 'Went with another company'); assert.deepEqual(q.declinedBy, actor);
  await rejects(run(Q.decline, { id, expectedRev: q.rev }), 'failed-precondition', /already declined/);
  await rejects(run(Q.reopen, { id, expectedRev: q.rev, pipeline: { moveBack: true } }), 'invalid-argument', /nothing to undo/);
  await run(Q.revise, { id, expectedRev: q.rev });                                              // the customer came back
  const again = await send(id);
  assert.deepEqual([again.status, again.sentVersion], ['sent', 2]);
  assert.equal((await quote(id)).declineReason, null);
  const { id: draft } = await make();
  await rejects(run(Q.decline, { id: draft, expectedRev: 1 }), 'failed-precondition', /Send the quote/);
});

// ================================================ delete, notes, PDF links ================================================
test('only a never-sent quote can be deleted; the audit entry holds no customer details; the number is not reused', async () => {
  await seed(); await setup(); await run(Q.setNumbering, { next: 34 });
  const { id } = await make();                                                                  // EK-0034
  const { id: other } = await make();                                                           // EK-0035
  await rejects(run(Q.revise, { id: other, expectedRev: 1 }), 'failed-precondition', /still a draft/);
  await rejects(run(Q.discardDraft, { id: other, expectedRev: 1 }), 'failed-precondition', /delete it instead/);
  await run(Q.deleteDraft, { id, expectedRev: 1 });
  assert.equal((await db.doc('quotes/' + id).get()).exists, false);
  assert.equal((await db.collection(`quotes/${id}/versions`).get()).size, 0);
  const audit = (await db.collection('auditLog').get()).docs.map((d) => d.data());
  assert.deepEqual(audit.map((a) => [a.action, a.quoteRef, a.by]), [['deleteQuote', 'EK-0034', 'thomas@example.com']]);
  assert.ok(!JSON.stringify(audit).includes(P) && !JSON.stringify(audit).includes('Anna'));
  assert.equal((await make()).ref, 'EK-0036');
  const s = await sent();
  await rejects(run(Q.deleteDraft, { id: s, expectedRev: (await quote(s)).rev }), 'failed-precondition', /record of what the customer received/);
  await rejects(run(Q.discardDraft, { id: s, expectedRev: (await quote(s)).rev }), 'failed-precondition');
  assert.ok((await db.doc('quotes/' + s).get()).exists);
});

test('internal notes can be set in any status; they are checked for length', async () => {
  await seed(); await setup();
  const id = await sent();
  await accept(id);
  await run(Q.setNotes, { id, expectedRev: (await quote(id)).rev, notes: '  Wants the island moved  ' });
  assert.equal((await quote(id)).notes, 'Wants the island moved');
  await rejects(run(Q.setNotes, { id, expectedRev: (await quote(id)).rev, notes: 'x'.repeat(2001) }), 'invalid-argument');
});

test('PDF link: the stored file of a sent version only; a draft has none; a tampered path is refused', async () => {
  await seed(); await setup();
  const id = await sent();
  const link = await h.quotePdfUrl(staff, { id, version: 1, download: true }, deps);
  assert.equal(link.filename, `EliteKitchens-${(await quote(id)).ref}-v1.pdf`);
  assert.ok(Buffer.from(link.url.split(',')[1], 'base64').equals(PDF), 'the link serves the stored PDF');    // emulator: a data URL
  await run(Q.revise, { id, expectedRev: (await quote(id)).rev });
  await rejects(h.quotePdfUrl(staff, { id, version: 2 }, deps), 'not-found', /not sent/);
  await rejects(h.quotePdfUrl(staff, { id, version: 0 }, deps), 'invalid-argument');
  await db.doc(`quotes/${id}/versions/1`).update({ 'pdf.path': `media/${R}/secret.pdf` });
  await rejects(h.quotePdfUrl(staff, { id, version: 1 }, deps), 'permission-denied');
});

// ================================================ several quotes, one customer ============================================
test('a customer can have several quotes: the rules apply per customer, whichever quote is sent or accepted', async () => {
  await seed(); await setup();
  const kitchen = await sent();
  const wardrobes = await sent();
  const c = await conv();
  assert.equal(c.inboxStatus, 'quoted');
  assert.deepEqual((await quote(wardrobes)).pipelineChanges[0].stage, null);                    // the second send changed nothing
  await accept(wardrobes);
  assert.equal((await conv()).inboxStatus, 'won');
  assert.equal((await quote(kitchen)).status, 'sent');
});

// ===================================================== privacy and rules ==================================================
test('nothing about customers is written to the logs by quote actions', async () => {
  await seed(); await setup();
  const lines = []; const keep = [console.log, console.error];
  console.log = (...a) => lines.push(a.join(' ')); console.error = (...a) => lines.push(a.join(' '));
  try {
    const id = await sent(P, NOW, { pipeline: { value: 14500 } });
    await accept(id); await run(Q.reopen, { id, expectedRev: (await quote(id)).rev });
  } finally { [console.log, console.error] = keep; }
  const dump = lines.join('\n');
  for (const secret of [P, 'Anna', 'anna@example.com', 'Main Street']) assert.ok(!dump.includes(secret), 'log leaks ' + secret);
});

test('security rules: staff can read quotes, versions and settings; nobody can write them from a browser; PDFs are closed', async () => {
  await seed(); await setup();
  const id = await sent();
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  const env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { host, port: +port, rules: fs.readFileSync(path.join(__dirname, '../../firestore.rules'), 'utf8') } });
  try {
    const s = env.authenticatedContext('s1', { staff: true, email: 'thomas@example.com' }).firestore();
    assert.equal((await s.doc('quotes/' + id).get()).data().phone, P);
    await assertSucceeds(s.doc(`quotes/${id}/versions/1`).get());
    await assertSucceeds(s.doc('quoteSettings/current').get());
    await assertSucceeds(s.doc('counters/quoteNumber').get());
    await assertFails(s.doc('quotes/' + id).update({ status: 'accepted' }));
    await assertFails(s.doc(`quotes/${id}/versions/1`).update({ 'sheet.options': [] }));
    await assertFails(s.doc('quotes/q_new').set({ phone: P }));
    await assertFails(s.doc('quoteSettings/current').update({ vatRate: 0 }));
    await assertFails(s.doc('counters/quoteNumber').set({ next: 1 }));
    const stranger = env.authenticatedContext('x', { email: 'x@gmail.com' }).firestore();
    await assertFails(stranger.doc('quotes/' + id).get());
  } finally { await env.cleanup(); }
  const pdfPath = (await version(id, 1)).pdf.path;
  const su = new URL(/:\/\//.test(process.env.STORAGE_EMULATOR_HOST) ? process.env.STORAGE_EMULATOR_HOST : 'http://' + process.env.STORAGE_EMULATOR_HOST);
  const senv = await initializeTestEnvironment({ projectId: PROJECT, storage: { host: su.hostname, port: Number(su.port), rules: fs.readFileSync(path.join(__dirname, '../../storage.rules'), 'utf8') } });
  try {
    const st = senv.authenticatedContext('u1', { staff: true }).storage('gs://' + BUCKET);
    await assertFails(st.ref(pdfPath).getDownloadURL());
    await assertFails(st.ref(`quotes/${P}/${id}/v9-evil.pdf`).put(PDF, { contentType: 'application/pdf' }));
  } finally { await senv.cleanup(); }
});
