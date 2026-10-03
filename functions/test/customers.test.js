// Phase 6 M2: customers added without a message, the Address field, and deleting a customer also erasing their quotes.
// Real Firestore + Storage emulators. Every name, number and price is made up.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const h = require('../lib/handlers');
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
const conv = async (p) => (await db.doc('conversations/' + p).get());
const contact = async (p) => (await db.doc('contacts/' + p).get());
const PDF = Buffer.from('%PDF-1.4\n% test\n%%EOF');
const PRICE_LIST = { options: { ess: { perDoor: 110, perTopBox: 60 }, prem: { perDoor: 140, perTopBox: 65 }, pp: { perDoor: 150, perTopBox: 70 } },
  drawerBoxes: { cemux: 12, blum: 21 }, glazing: { small: 45, large: 90 }, extras: [] };
const SETTINGS = { priceList: PRICE_LIST, vatRate: 13.5, validityDays: 30, business: { tradingName: 'Elite Kitchens' } };
let seq = 0;
const rid = () => 'req-' + (++seq) + '-abcdefgh';
const A = '353851111111', B = '353852222222';

beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await bucket.deleteFiles({ force: true }).catch(() => {});
});

async function sendQuote(phone) {
  const { id } = await Q.create(deps, actor, { phone, requestId: rid() });
  const q = (await db.doc('quotes/' + id).get()).data(), s = (await db.doc('quoteSettings/current').get()).data();
  const ct = (await contact(phone)).data();
  const up = `uploads/u1/${++seq}-q.pdf`;
  await bucket.file(up).save(PDF, { contentType: 'application/pdf' });
  return Q.send(deps, actor, { id, expectedRev: q.rev, requestId: rid(), issueDate: Q.dublinDate(Date.now()), settingsRev: s.rev,
    customer: { name: ct.name || null, email: ct.email || null, address: ct.address || null }, pdfUploadPath: up }, { uid: 'u1' });
}

// ===================================================== add without messaging ==============================================
test('add customer: a New lead with no message sent, details saved and copied to the Inbox entry', async () => {
  const r = await h.createCustomer(staff, { phone: '085 111 1111', name: '  Ciara Byrne ', email: 'ciara@example.com', address: '5 Harbour Road, Skerries',
    location: 'Skerries', projectType: 'Kitchen', source: 'Referral' }, deps);
  assert.deepEqual(r, { phone: A, existing: false });
  const c = (await conv(A)).data(), ct = (await contact(A)).data();
  assert.deepEqual([c.phone, c.name, c.location, c.projectType], [A, 'Ciara Byrne', 'Skerries', 'Kitchen']);
  assert.ok(c.createdAt instanceof Timestamp && c.updatedAt instanceof Timestamp);
  for (const k of ['inboxStatus', 'lastMessage', 'unreadCount', 'lastInboundAt', 'stageDates']) assert.equal(c[k], undefined, `${k} set`);
  assert.equal((await db.collection(`conversations/${A}/messages`).get()).size, 0);            // nothing was sent
  assert.deepEqual([ct.name, ct.email, ct.address, ct.source, ct.createdBy], ['Ciara Byrne', 'ciara@example.com', '5 Harbour Road, Skerries', 'Referral', 'thomas@example.com']);
  assert.equal(ct.quoteValue, undefined);
});

test('add customer: numbers are checked strictly, never guessed; an existing customer is left exactly as they are', async () => {
  assert.equal((await h.createCustomer(staff, { phone: '+44 7911 123456', name: 'Dev' }, deps)).phone, '447911123456');
  assert.equal((await h.createCustomer(staff, { phone: '00353 86 123 4567', name: 'Eve' }, deps)).phone, '353861234567');
  for (const phone of ['12345', 'call me', '', null, '+353 85 111', '0851111111111111']) await rejects(h.createCustomer(staff, { phone, name: 'X' }, deps), 'invalid-argument', /phone number/);
  await db.doc('conversations/' + B).set({ phone: B, name: 'Brian', inboxStatus: 'booked', lastMessage: 'Hi', unreadCount: 1 });
  await db.doc('contacts/' + B).set({ phone: B, name: 'Brian', email: 'brian@example.com' });
  const before = [(await conv(B)).data(), (await contact(B)).data()];
  assert.deepEqual(await h.createCustomer(staff, { phone: '+353 85 222 2222', name: 'Someone Else', email: 'new@example.com' }, deps), { phone: B, existing: true });
  assert.deepEqual([(await conv(B)).data(), (await contact(B)).data()], before);
});

test('add customer: the name is required and every field is checked like the Details panel', async () => {
  const bad = [{ name: '' }, { name: '   ' }, {}, { name: 'X', email: 'not-an-email' }, { name: 'X', address: 'x'.repeat(301) }, { name: 'x'.repeat(101) },
    { name: 'X', quoteValue: 5000 }, { name: 'X', inboxStatus: 'won' }, { name: 'X', budget: '20k' }, { name: 5 }];
  for (const b of bad) await rejects(h.createCustomer(staff, { phone: '085 111 1111', ...b }, deps), 'invalid-argument');
  await rejects(h.createCustomer(staff, null, deps), 'invalid-argument');
  assert.equal((await conv(A)).exists, false); assert.equal((await contact(A)).exists, false);
});

test('a customer added without messaging can be quoted; sending moves them New lead -> Quoted', async () => {
  await Q.saveSettings(deps, actor, SETTINGS);
  await h.createCustomer(staff, { phone: '085 111 1111', name: 'Ciara', address: '5 Harbour Road' }, deps);
  const r = await sendQuote(A);
  assert.deepEqual(r.stage, { from: 'inbox', to: 'quoted', corrected: false });
  const v = (await db.doc(`quotes/${r.id}/versions/1`).get()).data();
  assert.deepEqual(v.customer, { name: 'Ciara', email: null, address: '5 Harbour Road', phone: A });
});

// =========================================================== address ======================================================
test('Details: the optional Address is saved (trimmed, up to 300 characters), cleared with an empty value, and kept on the contact only', async () => {
  await db.doc('conversations/' + A).set({ phone: A, name: 'Anna', updatedAt: Timestamp.now() });
  await db.doc('contacts/' + A).set({ phone: A, name: 'Anna', notes: 'keep me' });
  const convBefore = (await conv(A)).data();
  await h.updateContact(staff, { phone: A, fields: { address: '  12 Main Street, Swords, K67 AB12  ' } }, deps);
  assert.equal((await contact(A)).data().address, '12 Main Street, Swords, K67 AB12');
  assert.equal((await contact(A)).data().notes, 'keep me');
  assert.deepEqual((await conv(A)).data(), convBefore);                                         // not copied to the Inbox entry
  await rejects(h.updateContact(staff, { phone: A, fields: { address: 'x'.repeat(301) } }, deps), 'invalid-argument', /too long/);
  await h.updateContact(staff, { phone: A, fields: { address: '' } }, deps);
  assert.equal((await contact(A)).data().address, null);
});

// ======================================================= erasure ==========================================================
test('deleting a customer also erases their quotes, every version and every stored quote PDF, and nothing of anyone else', async () => {
  await Q.saveSettings(deps, actor, SETTINGS);
  for (const [p, n] of [[A, 'Anna'], [B, 'Brian']]) {
    await db.doc('conversations/' + p).set({ phone: p, name: n, updatedAt: Timestamp.now() });
    await db.doc('contacts/' + p).set({ phone: p, name: n, email: n.toLowerCase() + '@example.com', address: '1 Main Street' });
  }
  const a1 = await sendQuote(A);
  await Q.revise(deps, actor, { id: a1.id, expectedRev: a1.rev });                            // a sent quote with a draft revision
  await Q.create(deps, actor, { phone: A, requestId: rid() });                                  // and a draft quote
  const b1 = await sendQuote(B);
  assert.equal((await bucket.getFiles({ prefix: `quotes/${A}/` }))[0].length, 1);
  const r = await h.deleteCustomer(staff, { phone: A, confirm: '1111' }, deps);
  assert.deepEqual(r, { messages: 0, files: 0 });                                              // the answer to the screen is unchanged
  assert.deepEqual((await db.collection('quotes').get()).docs.map((d) => d.id), [b1.id]);
  assert.equal((await db.collection(`quotes/${a1.id}/versions`).get()).size, 0);
  assert.equal((await bucket.getFiles({ prefix: `quotes/${A}/` }))[0].length, 0);
  assert.equal((await bucket.getFiles({ prefix: `quotes/${B}/` }))[0].length, 1);
  assert.equal((await db.collection(`quotes/${b1.id}/versions`).get()).size, 1);
  const audit = (await db.collection('auditLog').get()).docs.map((d) => d.data());
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].quotes, audit[0].quoteFiles, audit[0].appointments, audit[0].messages], [2, 1, 0, 0]);
  const dump = JSON.stringify(audit[0]);
  for (const secret of [A, 'Anna', 'anna@example.com', 'Main Street']) assert.ok(!dump.includes(secret), 'audit log leaks ' + secret);
  // a send that arrives after the erasure creates nothing
  const up = `uploads/u1/${++seq}-late.pdf`; await bucket.file(up).save(PDF);
  await rejects(Q.send(deps, actor, { id: a1.id, expectedRev: 9, requestId: rid(), issueDate: Q.dublinDate(Date.now()), settingsRev: 1,
    customer: { name: 'Anna' }, pdfUploadPath: up }, { uid: 'u1' }), 'not-found');
  assert.equal((await bucket.getFiles({ prefix: `quotes/${A}/` }))[0].length, 0);
  assert.equal(QE.current().id, 'ek-packages');
});
