// Phase 7: projects (docs/PROJECTS.md). Real Firestore + Storage emulators. Every name, number and file below is made up.
// What matters most: accepting a quote makes ITS project in the same transaction and never a second one; the five steps are independent; a render is only ever
// a real picture or PDF, stored privately; erasing a customer erases their projects and renders.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const h = require('../lib/handlers');
const Q = require('../lib/quotes');
const QE = require('../lib/quoteEngine');
const PR = require('../lib/projects');

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

const NOW = Date.UTC(2026, 9, 2, 9, 0);
const P = '353851111111', R = '353852222222';
const PDF = Buffer.from('%PDF-1.4\n% Elite OS test\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF test render picture')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('test png body')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([8, 0, 0, 0]), Buffer.from('WEBPVP8 test')]);
const PRICE_LIST = {
  options: { ess: { perDoor: 110, perTopBox: 60 }, prem: { perDoor: 140, perTopBox: 65 }, pp: { perDoor: 150, perTopBox: 70 } },
  drawerBoxes: { cemux: 12, blum: 21 }, glazing: { small: 45, large: 90 },
  extras: [{ key: 'bin', name: 'Pull-out bin', unit: 'per unit', price: 30 }],
};
const SETTINGS = { priceList: PRICE_LIST, vatRate: 13.5, validityDays: 30,
  business: { tradingName: 'Elite Kitchens', signatureName: 'Test Person', phone: '01 000 0000', email: 'quotes@example.com', web: 'www.example.com', address: 'Test Street, Dublin', vatNumber: 'IE0000000A' } };

let seq = 0;
const rid = () => 'req-' + (++seq) + '-abcdefgh';
const runQ = (fn, data, nowMs = NOW, uid = 'u1') => fn(deps, actor, data, { nowMs, uid });
const runP = (fn, data, nowMs = NOW, uid = 'u1') => fn(deps, actor, data, { nowMs, uid });
const quote = async (id) => (await db.doc('quotes/' + id).get()).data();
const proj = async (id) => { const s = await db.doc('projects/' + id).get(); return s.exists ? s.data() : null; };
const projectCount = async () => (await db.collection('projects').get()).size;
const files = async (prefix) => (await bucket.getFiles({ prefix }))[0].map((f) => f.name);
async function seed(p = P, name = 'Anna') {
  await db.doc('contacts/' + p).set({ phone: p, name, email: 'anna@example.com', address: '1 Main Street, Swords', location: 'Swords', createdAt: Timestamp.now() });
  await db.doc('conversations/' + p).set({ phone: p, name, createdAt: Timestamp.now(), updatedAt: Timestamp.now(), lastMessage: 'Hi', unreadCount: 0 });
}
function answers() { const a = QE.current().newAnswers(PRICE_LIST); a.doors = 10; a.drawers = 4; a.options.ess.drawerBox = 'cemux'; a.options.prem = { ...a.options.prem, on: true, drawerBox: 'blum' }; return a; }
async function upload(bytes, { uid = 'u1', type = 'application/pdf', name = 'file.bin' } = {}) {
  const p = `uploads/${uid}/${Date.now()}-${++seq}-${name}`;
  await bucket.file(p).save(bytes, { contentType: type }); return p;
}
async function sentQuote(p = P) {
  const { id } = await runQ(Q.create, { phone: p, requestId: rid(), answers: answers() });
  const qq = await quote(id), s = (await db.doc('quoteSettings/current').get()).data(), ct = (await db.doc('contacts/' + p).get()).data();
  await runQ(Q.send, { id, expectedRev: qq.rev, requestId: rid(), issueDate: Q.dublinDate(NOW), settingsRev: s.rev, customer: { name: ct.name, email: ct.email, address: ct.address }, pdfUploadPath: await upload(PDF) });
  return id;
}
const acceptQuote = async (id, option = 'prem') => runQ(Q.accept, { id, expectedRev: (await quote(id)).rev, option });
const pid = (quoteId) => PR.idForQuote(quoteId);
async function accepted(p = P) { const id = await sentQuote(p); const r = await acceptQuote(id); return { quoteId: id, projectId: r.projectId }; }
const tick = (id, step, done = true, nowMs = NOW) => runP(PR.setStep, { id, step, done }, nowMs);
const done = async (id) => { const p = await proj(id); return Object.fromEntries(PR.STEPS.map((k) => [k, p.steps[k].done])); };

beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await bucket.deleteFiles({ force: true }).catch(() => {});
  await seed(); await runQ(Q.saveSettings, SETTINGS);
});

// ======================================================= who may call =====================================================
test('only signed-in, allowlisted staff can use any project action; nothing is written otherwise', async () => {
  const { projectId } = await accepted();
  const before = await proj(projectId);
  const people = [[null, 'unauthenticated'],
    [{ uid: 'x', token: { email: 'stranger@gmail.com', email_verified: true, staff: true } }, 'permission-denied'],
    [{ uid: 'x', token: { email: 'thomas@example.com', email_verified: true } }, 'permission-denied']];
  for (const [who, code] of people) for (const name of ['createProject', 'saveProject', 'setProjectStep', 'completeProject', 'removeProject', 'attachProjectRender', 'projectRenderUrl'])
    await rejects(h[name](who, { id: projectId, phone: P, requestId: rid(), step: 'doorsOrdered', done: true, expectedRev: 1, notes: 'x' }, deps), code);
  assert.deepEqual(await proj(projectId), before);
  assert.equal(await projectCount(), 1);
  const r = await h.setProjectStep(staff, { id: projectId, step: 'designApproved', done: true }, deps);          // staff can, through the real wrapper
  assert.equal(r.unchanged, false); assert.equal((await proj(projectId)).steps.designApproved.by, 'thomas@example.com');
});

// ================================================= accepting a quote makes its project ====================================
test('accepting a quote makes exactly one project, linked to the customer and the quote, with the accepted option and nothing ticked', async () => {
  const quoteId = await sentQuote();
  assert.equal(await projectCount(), 0, 'sending a quote must not make a project');
  const r = await acceptQuote(quoteId, 'prem');
  assert.equal(r.projectId, pid(quoteId)); assert.match(r.projectId, /^p_[0-9a-f]{24}$/); assert.equal(r.projectId.slice(2), quoteId.slice(2), 'the project id carries the quote\'s own 24 hex');
  const p = await proj(r.projectId), q = await quote(quoteId);
  assert.equal(p.phone, P); assert.equal(p.customerName, 'Anna'); assert.equal(p.quoteId, quoteId); assert.equal(p.quoteRef, q.ref);
  assert.deepEqual(p.quoteOption, q.acceptedOption); assert.equal(p.quoteOption.key, 'prem'); assert.equal(p.quoteStatus, 'accepted');
  assert.equal(p.status, 'active'); assert.equal(p.installDate, null); assert.equal(p.notes, null); assert.equal(p.render, null);
  assert.equal(p.rev, 1); assert.equal(p.createdVia, 'quote'); assert.deepEqual(p.createdBy, actor); assert.equal(p.completedAt, null);
  assert.deepEqual(PR.STEPS, ['designApproved', 'carcassesOrdered', 'doorsOrdered', 'readyForInstall', 'installed']);
  for (const k of PR.STEPS) assert.deepEqual(p.steps[k], { done: false, at: null, by: null });
  assert.equal(p.history.length, 1); assert.match(p.history[0].action, /quote accepted/);
  assert.equal(await projectCount(), 1);
  await rejects(acceptQuote(quoteId), 'failed-precondition', /already accepted/);               // a second accept: refused, and still one project
  assert.equal(await projectCount(), 1);
});

test('a quote that cannot be accepted makes no project, and a failure while making the project leaves the quote NOT accepted (one transaction)', async () => {
  const { id } = await runQ(Q.create, { phone: P, requestId: rid(), answers: answers() });           // a draft: not sent
  await rejects(runQ(Q.accept, { id, expectedRev: (await quote(id)).rev, option: 'prem' }), 'failed-precondition');
  const quoteId = await sentQuote();
  await rejects(runQ(Q.accept, { id: quoteId, expectedRev: (await quote(quoteId)).rev, option: 'nonsense' }), 'invalid-argument');
  await rejects(runQ(Q.accept, { id: quoteId, expectedRev: 999, option: 'prem' }), 'failed-precondition');
  assert.equal(await projectCount(), 0);
  const real = PR.planAccept;
  PR.planAccept = () => { throw new Error('the project could not be made'); };
  try { await assert.rejects(acceptQuote(quoteId), /could not be made/); } finally { PR.planAccept = real; }
  const q = await quote(quoteId);
  assert.equal(q.status, 'sent', 'the quote must not be half accepted'); assert.equal(q.acceptedOption, null); assert.equal(await projectCount(), 0);
  assert.equal((await db.doc('conversations/' + P).get()).data().inboxStatus === 'won', false, 'the customer must not have been moved to Won either');
  await acceptQuote(quoteId); assert.equal(await projectCount(), 1);                                    // and a later accept works normally
});

test('two accepts at the same moment: one wins, there is one project', async () => {
  const quoteId = await sentQuote(), rev = (await quote(quoteId)).rev;
  const results = await Promise.allSettled([runQ(Q.accept, { id: quoteId, expectedRev: rev, option: 'prem' }), runQ(Q.accept, { id: quoteId, expectedRev: rev, option: 'ess' })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.equal(await projectCount(), 1);
});

test('reopening the quote keeps the project and flags it; accepting again refreshes the link but never resets the steps, the date, the notes or "completed"', async () => {
  const { quoteId, projectId } = await accepted();
  await tick(projectId, 'designApproved'); await tick(projectId, 'doorsOrdered');
  await runP(PR.save, { id: projectId, expectedRev: 1, installDate: '2026-11-20', notes: 'Call before arriving' });
  await runP(PR.complete, { id: projectId });
  await runQ(Q.reopen, { id: quoteId, expectedRev: (await quote(quoteId)).rev });
  let p = await proj(projectId);
  assert.equal(p.quoteStatus, 'reopened'); assert.equal(p.status, 'completed'); assert.equal((await done(projectId)).doorsOrdered, true); assert.equal(await projectCount(), 1);
  assert.match(p.history.at(-1).action, /quote reopened/);
  await runQ(Q.accept, { id: quoteId, expectedRev: (await quote(quoteId)).rev, option: 'ess' });
  p = await proj(projectId);
  assert.equal(await projectCount(), 1, 'accepting again must not make a second project');
  assert.equal(p.quoteStatus, 'accepted'); assert.equal(p.quoteOption.key, 'ess', 'the link shows the option accepted now');
  assert.deepEqual(await done(projectId), { designApproved: true, carcassesOrdered: false, doorsOrdered: true, readyForInstall: false, installed: false });
  assert.equal(p.installDate, '2026-11-20'); assert.equal(p.notes, 'Call before arriving'); assert.equal(p.status, 'completed'); assert.equal(p.rev, 2, 'only the one save changed the revision');
  // a quote declined after being reopened does not touch the project; reopening a DECLINED quote does not either
  await runQ(Q.reopen, { id: quoteId, expectedRev: (await quote(quoteId)).rev });
  await runQ(Q.decline, { id: quoteId, expectedRev: (await quote(quoteId)).rev, reason: 'changed mind' });
  const hist = (await proj(projectId)).history.length;
  await runQ(Q.reopen, { id: quoteId, expectedRev: (await quote(quoteId)).rev });
  assert.equal((await proj(projectId)).history.length, hist, 'reopening a declined quote must not write to the project');
});

test('an old quote reopened when it has no project (accepted before projects existed) works as before', async () => {
  const quoteId = await sentQuote(); await acceptQuote(quoteId);
  await db.doc('projects/' + pid(quoteId)).delete();                                                      // as if it never had one
  await runQ(Q.reopen, { id: quoteId, expectedRev: (await quote(quoteId)).rev });
  assert.equal((await quote(quoteId)).status, 'sent'); assert.equal(await projectCount(), 0);
});

// ====================================================== made by hand ======================================================
test('a project made by hand: needs an existing customer; the same request twice is one project; a quote link must be an accepted quote of that customer', async () => {
  const a = await runP(PR.create, { phone: P, requestId: 'manual-1-abcdefgh' });
  assert.equal(a.existing, false); assert.match(a.id, /^m_[0-9a-f]{24}$/);
  const p = await proj(a.id);
  assert.equal(p.createdVia, 'manual'); assert.equal(p.quoteId, null); assert.equal(p.quoteRef, null); assert.equal(p.quoteOption, null); assert.equal(p.customerName, 'Anna'); assert.equal(p.status, 'active');
  const again = await runP(PR.create, { phone: P, requestId: 'manual-1-abcdefgh' });
  assert.deepEqual([again.id, again.existing], [a.id, true]); assert.equal(await projectCount(), 1);
  const second = await runP(PR.create, { phone: P, requestId: 'manual-2-abcdefgh' }); assert.notEqual(second.id, a.id); assert.equal(await projectCount(), 2);
  await rejects(runP(PR.create, { phone: R, requestId: rid() }), 'not-found');
  for (const bad of [{ phone: P }, { phone: '12', requestId: rid() }, { phone: P, requestId: 'x' }, { phone: P, requestId: rid(), quoteId: 'q_nope' }, { phone: P, requestId: rid(), extra: 1 }, null])
    await rejects(runP(PR.create, bad), 'invalid-argument');
  // a quote link
  await seed(R, 'Brian');
  const sentOnly = await sentQuote(P);
  await rejects(runP(PR.create, { phone: P, requestId: rid(), quoteId: sentOnly }), 'failed-precondition', /accepted/);
  const { quoteId, projectId } = await accepted(P);
  const linked = await runP(PR.create, { phone: P, requestId: rid(), quoteId });
  assert.deepEqual([linked.id, linked.existing], [projectId, true], 'the accepted quote already has its project: that one is returned, never a second');
  await rejects(runP(PR.create, { phone: R, requestId: rid(), quoteId }), 'failed-precondition');
  assert.equal(await projectCount(), 3);
  // an accepted quote whose project was removed can be given one again, by hand, linked
  await runP(PR.remove, { id: projectId });
  const back = await runP(PR.create, { phone: P, requestId: rid(), quoteId });
  assert.deepEqual([back.id, back.existing], [projectId, false]); const bp = await proj(back.id);
  assert.equal(bp.createdVia, 'manual'); assert.equal(bp.quoteId, quoteId); assert.equal(bp.quoteRef, (await quote(quoteId)).ref); assert.equal(bp.quoteOption.key, 'prem'); assert.equal(bp.quoteStatus, 'accepted');
});

// ===================================================== the checklist =====================================================
test('the five steps are independent: any can be ticked or cleared at any time, in any order, and every change says who and when', async () => {
  const { projectId } = await accepted();
  await tick(projectId, 'doorsOrdered', true, NOW + 1000);                                               // doors without carcasses, without an approved design
  assert.deepEqual(await done(projectId), { designApproved: false, carcassesOrdered: false, doorsOrdered: true, readyForInstall: false, installed: false });
  const d = (await proj(projectId)).steps.doorsOrdered; assert.equal(d.by, 'thomas@example.com'); assert.equal(d.at.toMillis(), NOW + 1000);
  await tick(projectId, 'carcassesOrdered'); await tick(projectId, 'installed'); await tick(projectId, 'readyForInstall'); await tick(projectId, 'designApproved');
  assert.deepEqual(Object.values(await done(projectId)), [true, true, true, true, true]);
  await tick(projectId, 'carcassesOrdered', false);                                                      // clearing one leaves the others alone
  assert.deepEqual(await done(projectId), { designApproved: true, carcassesOrdered: false, doorsOrdered: true, readyForInstall: true, installed: true });
  assert.deepEqual((await proj(projectId)).steps.carcassesOrdered, { done: false, at: null, by: null });
  const h1 = (await proj(projectId)).history; assert.equal(h1.at(-1).action, 'cleared'); assert.equal(h1.at(-1).step, 'carcassesOrdered');
  // ticking something already ticked writes nothing
  const before = await proj(projectId), r = await tick(projectId, 'doorsOrdered');
  assert.equal(r.unchanged, true); assert.deepEqual(await proj(projectId), before);
  for (const bad of [{ id: projectId, step: 'arrived', done: true }, { id: projectId, step: 'doorsOrdered', done: 'yes' }, { id: projectId, step: 'doorsOrdered' }, { id: projectId, step: 'doorsOrdered', done: true, x: 1 }, { id: 'p_nope', step: 'doorsOrdered', done: true }])
    await rejects(runP(PR.setStep, bad), 'invalid-argument');
  await rejects(runP(PR.setStep, { id: 'p_' + '0'.repeat(24), step: 'doorsOrdered', done: true }), 'not-found');
});

test('five people ticking five different boxes at the same moment: every tick lands, and none changes the revision the notes are saved against', async () => {
  const { projectId } = await accepted();
  await Promise.all(PR.STEPS.map((k) => tick(projectId, k)));
  assert.deepEqual(Object.values(await done(projectId)), [true, true, true, true, true]);
  assert.equal((await proj(projectId)).rev, 1);
  await runP(PR.save, { id: projectId, expectedRev: 1, notes: 'saved against the revision read before the ticks' });
});

test('installation date and notes: checked, saved with the revision, and a stale save is refused', async () => {
  const { projectId } = await accepted();
  const r = await runP(PR.save, { id: projectId, expectedRev: 1, installDate: '2026-11-20', notes: '  Gate code 1234  ' });
  assert.deepEqual([r.rev, r.status], [2, 'active']); let p = await proj(projectId);
  assert.equal(p.installDate, '2026-11-20'); assert.equal(p.notes, 'Gate code 1234'); assert.match(p.history.at(-1).action, /installation date set to 2026-11-20/);
  await rejects(runP(PR.save, { id: projectId, expectedRev: 1, notes: 'someone else saved meanwhile' }), 'failed-precondition', /changed by someone else/);
  assert.equal((await proj(projectId)).notes, 'Gate code 1234');
  await runP(PR.save, { id: projectId, expectedRev: 2, notes: 'only the notes' });                       // the date is untouched when it is not sent
  assert.equal((await proj(projectId)).installDate, '2026-11-20');
  await runP(PR.save, { id: projectId, expectedRev: 3, installDate: null, notes: '' });                  // null clears the date, empty clears the notes
  p = await proj(projectId); assert.equal(p.installDate, null); assert.equal(p.notes, null); assert.match(p.history.at(-1).action, /cleared/);
  for (const bad of ['2026-02-30', '2026-13-01', 'tomorrow', '20-11-2026', 20261120, '2023-12-31', '2101-01-01', '2026-11-20T10:00'])
    await rejects(runP(PR.save, { id: projectId, expectedRev: 4, installDate: bad }), 'invalid-argument');
  await rejects(runP(PR.save, { id: projectId, expectedRev: 4, notes: 'x'.repeat(2001) }), 'invalid-argument', /too long/);
  await runP(PR.save, { id: projectId, expectedRev: 4, notes: 'x'.repeat(2000) });
  await rejects(runP(PR.save, { id: projectId, expectedRev: 5 }), 'invalid-argument', /Nothing to save/);
  await rejects(runP(PR.save, { id: projectId, notes: 'x' }), 'invalid-argument', /revision/);
  await rejects(runP(PR.save, { id: projectId, expectedRev: 5, notes: 7 }), 'invalid-argument');
  await rejects(runP(PR.save, { id: projectId, expectedRev: 5, status: 'completed' }), 'invalid-argument', /Unknown field/);
});

test('completed: leaves the active list, can be undone, and a completed project cannot be changed until it is reopened', async () => {
  const { projectId } = await accepted();
  const c = await runP(PR.complete, { id: projectId }, NOW + 5000);
  assert.deepEqual([c.status, c.unchanged], ['completed', false]); let p = await proj(projectId);
  assert.equal(p.status, 'completed'); assert.equal(p.completedAt.toMillis(), NOW + 5000); assert.deepEqual(p.completedBy, actor);
  assert.equal((await runP(PR.complete, { id: projectId })).unchanged, true);
  await rejects(tick(projectId, 'doorsOrdered'), 'failed-precondition', /completed/);
  await rejects(runP(PR.attachRender, { id: projectId, uploadPath: await upload(JPG, { type: 'image/jpeg' }) }), 'failed-precondition', /completed/);
  const r = await runP(PR.complete, { id: projectId, reopen: true }); assert.deepEqual([r.status, r.unchanged], ['active', false]);
  p = await proj(projectId); assert.equal(p.completedAt, null); assert.equal(p.completedBy, null);
  await tick(projectId, 'doorsOrdered');
  await rejects(runP(PR.complete, { id: projectId, reopen: 'no' }), 'invalid-argument'); await rejects(runP(PR.complete, { id: projectId, x: 1 }), 'invalid-argument');
});

test('delete: always allowed, with ticked steps, a date, notes and a render, even when completed; it erases that project\'s files only; the audit entry holds no personal content; the quote and the customer are untouched', async () => {
  const { quoteId, projectId } = await accepted();
  await tick(projectId, 'designApproved'); await tick(projectId, 'doorsOrdered');
  await runP(PR.save, { id: projectId, expectedRev: 1, installDate: '2026-11-20', notes: 'Gate code 1234' });
  await runP(PR.attachRender, { id: projectId, uploadPath: await upload(JPG, { type: 'image/jpeg', name: 'one.jpg' }) });
  await runP(PR.attachRender, { id: projectId, uploadPath: await upload(PNG, { type: 'image/png', name: 'two.png' }) });         // replaces the first
  await runP(PR.complete, { id: projectId });                                                                                      // a completed project can be deleted too
  const other = (await accepted(P)).projectId;                                                                                     // the same customer's other project, with its own render
  await runP(PR.attachRender, { id: other, uploadPath: await upload(JPG, { type: 'image/jpeg', name: 'other.jpg' }) });
  const mine = (await proj(projectId)).render.path, otherPath = (await proj(other)).render.path;
  assert.deepEqual((await files(`projects/${P}/`)).sort(), [mine, otherPath].sort());
  const r = await runP(PR.remove, { id: projectId }, NOW + 9000);
  assert.deepEqual(r, { id: projectId, removed: true }); assert.equal(await proj(projectId), null);
  assert.deepEqual(await files(`projects/${P}/`), [otherPath], 'its render file is gone, and the customer\'s other project keeps its own');
  assert.ok(await proj(other), 'the other project is untouched');
  const audit = (await db.collection('auditLog').where('action', '==', 'deleteProject').get()).docs.map((d) => d.data());
  assert.equal(audit.length, 1); assert.equal(audit[0].projectId, projectId); assert.equal(audit[0].ticked, 2); assert.equal(audit[0].hadRender, true); assert.equal(audit[0].by, 'thomas@example.com');
  assert.ok(!JSON.stringify(audit[0]).includes(P), 'no phone number in the audit entry'); assert.ok(!JSON.stringify(audit[0]).includes('Gate code'), 'no notes in the audit entry');
  assert.equal((await quote(quoteId)).status, 'accepted', 'the quote is untouched'); assert.ok((await db.doc('conversations/' + P).get()).exists, 'the customer is untouched');
  assert.deepEqual(await runP(PR.remove, { id: projectId }), { id: projectId, removed: false });                                   // already gone: fine
  const plain = (await accepted(P)).projectId; const r3 = await runP(PR.remove, { id: plain });                                    // nothing in it: still works
  assert.equal(r3.removed, true); const a2 = (await db.collection('auditLog').where('projectId', '==', plain).get()).docs[0].data(); assert.deepEqual([a2.ticked, a2.hadRender], [0, false]);
  await rejects(runP(PR.remove, { id: other, x: 1 }), 'invalid-argument'); await rejects(runP(PR.remove, { id: 'p_nope' }), 'invalid-argument');
  assert.ok(await proj(other));
});

// =========================================================== the render ===================================================
test('the render: a real JPG, PNG, WebP or PDF is checked, filed privately with the project, and the upload folder is emptied', async () => {
  const { projectId } = await accepted();
  const up = await upload(JPG, { type: 'image/jpeg', name: 'kitchen render.jpg' });
  const r = await runP(PR.attachRender, { id: projectId, uploadPath: up, filename: 'Kitchen render (final).jpg' });
  assert.equal(r.render.mime, 'image/jpeg'); assert.equal(r.render.size, JPG.length); assert.equal(r.render.filename, 'Kitchen render (final).jpg');
  const p = await proj(projectId);
  assert.match(p.render.path, new RegExp(`^projects/${P}/${projectId}/render-\\d+-`)); assert.equal(p.render.mime, 'image/jpeg'); assert.equal(p.render.size, JPG.length);
  assert.equal(p.render.sha256.length, 64); assert.equal(p.render.by, 'thomas@example.com');
  assert.deepEqual(await files('uploads/'), [], 'the upload must be moved, not copied'); assert.deepEqual(await files(`projects/${P}/`), [p.render.path]);
  assert.match(p.history.at(-1).action, /render attached/);
  for (const [bytes, type] of [[PNG, 'image/png'], [WEBP, 'image/webp'], [PDF, 'application/pdf']]) {
    const x = await runP(PR.attachRender, { id: projectId, uploadPath: await upload(bytes, { type, name: 'r' }) }); assert.equal(x.render.mime, type);
  }
  const last = await proj(projectId);
  assert.deepEqual(await files(`projects/${P}/`), [last.render.path], 'every picture it replaced is deleted: only the current one is kept');
  assert.match(last.history.at(-1).action, /render replaced/); assert.match(last.render.filename, /\.pdf$/);
});

test('the render: refused (and the upload deleted) when it is not a real picture or PDF, is empty or too big, is declared as something else, or is not the caller\'s own upload', async () => {
  const { projectId } = await accepted();
  const refuse = async (bytes, type, code, msg, name = 'x') => { const up = await upload(bytes, { type, name }); await rejects(runP(PR.attachRender, { id: projectId, uploadPath: up }), code, msg); assert.deepEqual(await files('uploads/'), [], 'the refused upload must be deleted'); };
  await refuse(Buffer.from('GIF89a......'), 'image/gif', 'invalid-argument', /JPG, PNG or WebP/);
  await refuse(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml', 'invalid-argument', /JPG, PNG or WebP/);
  await refuse(Buffer.from('<html><script>alert(1)</script></html>'), 'image/png', 'invalid-argument', /JPG, PNG or WebP/);       // says PNG, is a web page
  await refuse(PNG, 'image/jpeg', 'invalid-argument', /not what its type says/);                                                   // a PNG declared as JPEG
  await refuse(JPG, 'application/pdf', 'invalid-argument', /not what its type says/);
  await refuse(Buffer.alloc(0), 'image/png', 'invalid-argument', /empty/);
  await refuse(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(PR.RENDER_MAX)]), 'image/jpeg', 'invalid-argument', /too big/);
  assert.equal((await proj(projectId)).render, null);
  // paths: somebody else's folder, a path trick, the wrong place, a file that is not there, a project that is not there
  const mine = await upload(JPG, { type: 'image/jpeg' }), theirs = await upload(JPG, { type: 'image/jpeg', uid: 'u2' });
  await rejects(runP(PR.attachRender, { id: projectId, uploadPath: theirs }), 'permission-denied');
  await rejects(runP(PR.attachRender, { id: projectId, uploadPath: `uploads/u1/../u2/x.jpg` }), 'permission-denied');
  await rejects(runP(PR.attachRender, { id: projectId, uploadPath: `media/${P}/anything.jpg` }), 'permission-denied');
  await rejects(runP(PR.attachRender, { id: projectId, uploadPath: 'uploads/u1/not-there.jpg' }), 'not-found');
  await rejects(runP(PR.attachRender, { id: 'p_' + '0'.repeat(24), uploadPath: mine }), 'not-found');
  assert.deepEqual(await files('uploads/'), [theirs], 'only the other person\'s file is left, untouched');
  await rejects(runP(PR.attachRender, { id: projectId }), 'permission-denied');                                         // no file named at all
  await rejects(runP(PR.attachRender, { id: projectId, uploadPath: mine, extra: 1 }), 'invalid-argument', /Unknown field/);
  await rejects(runP(PR.attachRender, null), 'invalid-argument');
  assert.deepEqual(await files('projects/'), []); assert.equal((await proj(projectId)).render, null);
});

test('the render link: a short-lived link to exactly the stored file; nothing when there is none, and nothing when the stored file is not what was recorded', async () => {
  const { projectId } = await accepted();
  await rejects(h.projectRenderUrl(staff, { id: projectId }, deps), 'not-found', /no render/);
  await runP(PR.attachRender, { id: projectId, uploadPath: await upload(JPG, { type: 'image/jpeg', name: 'a.jpg' }) });
  const l = await h.projectRenderUrl(staff, { id: projectId }, deps);
  assert.equal(l.mime, 'image/jpeg'); assert.equal(l.size, JPG.length); assert.match(l.url, /^data:image\/jpeg;base64,/);        // in the emulator the "link" is the file itself
  assert.equal(Buffer.from(l.url.split(',')[1], 'base64').equals(JPG), true);
  await rejects(h.projectRenderUrl(staff, { id: projectId, download: 'yes' }, deps), 'invalid-argument');
  const p = await proj(projectId);
  await bucket.file(p.render.path).save(Buffer.concat([JPG, Buffer.from('tampered')]), { contentType: 'image/jpeg' });
  await rejects(h.projectRenderUrl(staff, { id: projectId }, deps), 'failed-precondition', /does not match/);
  await db.doc('projects/' + projectId).update({ 'render.path': `projects/${R}/elsewhere/render.jpg` });
  await rejects(h.projectRenderUrl(staff, { id: projectId }, deps), 'permission-denied');
  await db.doc('projects/' + projectId).update({ 'render.path': p.render.path }); await bucket.file(p.render.path).delete();
  await rejects(h.projectRenderUrl(staff, { id: projectId }, deps), 'not-found', /missing/);
});

// ============================================================ erasure ======================================================
test('erasing a customer erases their projects and renders (and only theirs); the audit entry counts them', async () => {
  await seed(R, 'Brian');
  const a = await accepted(P), b = await accepted(R);
  await runP(PR.create, { phone: P, requestId: rid() });
  await runP(PR.attachRender, { id: a.projectId, uploadPath: await upload(JPG, { type: 'image/jpeg' }) });
  await runP(PR.attachRender, { id: b.projectId, uploadPath: await upload(PNG, { type: 'image/png' }) });
  assert.equal(await projectCount(), 3);
  const r = await h.deleteCustomer(staff, { phone: P, confirm: P.slice(-4) }, deps);
  assert.ok(r);
  assert.equal(await proj(a.projectId), null); assert.equal((await db.collection('projects').where('phone', '==', P).get()).size, 0);
  assert.deepEqual(await files(`projects/${P}/`), []);
  assert.ok(await proj(b.projectId), 'another customer\'s project is untouched'); assert.equal((await files(`projects/${R}/`)).length, 1);
  const audit = (await db.collection('auditLog').where('action', '==', 'deleteCustomer').get()).docs[0].data();
  assert.equal(audit.projects, 2); assert.equal(audit.projectFiles, 1);
});

// ======================================================== the security rules ===============================================
test('the browser can read projects while its staff claim is valid, and can never write one', async () => {
  const { projectId } = await accepted();
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  const env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { host, port: +port, rules: fs.readFileSync(path.join(__dirname, '../../firestore.rules'), 'utf8') } });
  try {
    const s = env.authenticatedContext('s1', { staff: true, staffUntil: Date.now() + 3600000, email: 'thomas@example.com' }).firestore();
    assert.equal((await s.doc('projects/' + projectId).get()).data().phone, P);
    await assertSucceeds(s.collection('projects').get());
    await assertFails(s.doc('projects/' + projectId).update({ status: 'completed' }));
    await assertFails(s.doc('projects/' + projectId).update({ 'steps.doorsOrdered': { done: true } }));
    await assertFails(s.doc('projects/p_new').set({ phone: P }));
    await assertFails(s.doc('projects/' + projectId).delete());
    const expired = env.authenticatedContext('s2', { staff: true, staffUntil: Date.now() - 1000 }).firestore();
    await assertFails(expired.doc('projects/' + projectId).get());
    const stranger = env.authenticatedContext('x', { email: 'x@gmail.com' }).firestore();
    await assertFails(stranger.doc('projects/' + projectId).get());
  } finally { await env.cleanup(); }
  const su = new URL(/:\/\//.test(process.env.STORAGE_EMULATOR_HOST) ? process.env.STORAGE_EMULATOR_HOST : 'http://' + process.env.STORAGE_EMULATOR_HOST);
  await runP(PR.attachRender, { id: projectId, uploadPath: await upload(JPG, { type: 'image/jpeg' }) });
  const senv = await initializeTestEnvironment({ projectId: PROJECT, storage: { host: su.hostname, port: Number(su.port), rules: fs.readFileSync(path.join(__dirname, '../../storage.rules'), 'utf8') } });
  try {
    const st = senv.authenticatedContext('u1', { staff: true, staffUntil: Date.now() + 3600000 }).storage('gs://' + BUCKET);
    const stored = (await proj(projectId)).render.path;
    await assertFails(st.ref(stored).getDownloadURL());
    await assertFails(st.ref(`projects/${P}/${projectId}/render-evil.jpg`).put(JPG, { contentType: 'image/jpeg' }));
  } finally { await senv.cleanup(); }
});
