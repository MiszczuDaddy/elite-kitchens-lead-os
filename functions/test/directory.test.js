// The Inbox "All" tab and search across every customer: the compact customer list (functions/lib/directory.js). Real Firestore emulator. Every name and number is made up.
// What matters: every customer is in it (2,500 pretend ones), newest first, only the few fields the search needs (never message text, notes, addresses or budgets), the email comes from the contact,
// staff only, strict input, it is cut at the maximum and says so, and the answer is kept for 2 minutes so repeated searches do not read the database again.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const h = require('../lib/handlers');
const D = require('../lib/directory');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const staff = { uid: 'u1', token: { email: 'thomas@example.com', email_verified: true, staff: true } };
const cfg = { allowedEmails: 'thomas@example.com' };
const ask = (data = {}, who = staff) => h.customerDirectory(who, data, { db, cfg });
const NOW = Date.UTC(2026, 9, 20, 12, 0);

beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  for (let i = 0; i < 100; i++) { const left = await Promise.all(['conversations', 'contacts'].map((c) => db.collection(c).limit(1).get())); if (left.every((x) => x.empty)) break; await new Promise((r) => setTimeout(r, 30)); }
  D.resetCache();
});

async function seed(n, { start = 353850000000 } = {}) {
  const STAGES = ['inbox', 'booked', 'quoted', 'won', 'closed'];
  for (let i = 0; i < n; i += 400) {
    const b = db.batch();
    for (let j = i; j < Math.min(n, i + 400); j++) {
      const id = String(start + j);
      b.set(db.doc('conversations/' + id), { phone: id, name: 'Customer ' + j, location: j % 2 ? 'Swords' : 'Naas', projectType: 'Kitchen', inboxStatus: STAGES[j % 5], updatedAt: Timestamp.fromMillis(NOW - j * 60000),
        lastMessage: 'PRIVATE MESSAGE TEXT ' + j, receptionist: { on: true, paused: 'handover: price' }, doNotContact: { on: false }, unreadCount: 2 });
      b.set(db.doc('contacts/' + id), { phone: id, name: 'Customer ' + j, email: j % 3 ? 'C' + j + '@Example.com' : null, address: '12 PRIVATE STREET', budget: '€20,000', notes: 'PRIVATE NOTE', createdAt: Timestamp.now() });
    }
    await b.commit();
  }
}

test('EVERY CUSTOMER is in the list (2,500 pretend customers), newest first, with the email from the contact in lower case', async () => {
  await seed(2500);
  const r = await ask(); assert.equal(r.rows.length, 2500); assert.equal(r.total, 2500); assert.equal(r.truncated, false); assert.equal(r.cached, false);
  for (let i = 1; i < r.rows.length; i++) assert.ok(r.rows[i - 1][6] >= r.rows[i][6], 'newest first');
  const first = r.rows[0], last = r.rows[2499];
  assert.deepEqual(first, ['353850000000', 'Customer 0', 'Naas', 'Kitchen', '', 'inbox', NOW]);
  assert.deepEqual(last, ['353850002499', 'Customer 2499', 'Swords', 'Kitchen', '', 'closed', NOW - 2499 * 60000], 'no email on the contact: blank');
  assert.deepEqual(r.rows[2498], ['353850002498', 'Customer 2498', 'Naas', 'Kitchen', 'c2498@example.com', 'won', NOW - 2498 * 60000], 'the email comes from the contact, in lower case');
  assert.equal(new Set(r.rows.map((x) => x[0])).size, 2500);
  assert.deepEqual([...new Set(r.rows.map((x) => x[5]))].sort(), ['booked', 'closed', 'inbox', 'quoted', 'won']);
});

test('ONLY WHAT THE SEARCH NEEDS leaves the server: never message text, notes, address, budget, receptionist data or unread counts', async () => {
  await seed(30);
  const text = JSON.stringify(await ask());
  for (const secret of ['PRIVATE MESSAGE', 'PRIVATE NOTE', 'PRIVATE STREET', '20,000', 'handover', 'receptionist', 'unreadCount', 'doNotContact', 'createdAt']) assert.ok(!text.includes(secret), secret + ' must not be in the list');
  const r = await ask(); for (const row of r.rows) assert.equal(row.length, 7);
});

test('A CONVERSATION WITHOUT A CONTACT, a contact with a different name, odd stages and long text are handled', async () => {
  await db.doc('conversations/353850000001').set({ phone: '353850000001', name: 'No Contact', inboxStatus: 'nonsense', updatedAt: Timestamp.fromMillis(NOW) });
  await db.doc('conversations/353850000002').set({ phone: '353850000002', updatedAt: Timestamp.fromMillis(NOW - 1) });
  await db.doc('contacts/353850000002').set({ phone: '353850000002', name: '  Only   In Contact ', email: '  MIXED@Case.IE ', location: 'Lucan' });
  await db.doc('conversations/353850000003').set({ phone: '353850000003', name: 'x'.repeat(500), updatedAt: Timestamp.fromMillis(NOW - 2) });
  await db.doc('contacts/353850000009').set({ phone: '353850000009', name: 'A contact with no conversation' });
  const r = await ask();
  assert.deepEqual(r.rows.map((x) => x[0]), ['353850000001', '353850000002', '353850000003'], 'a contact with no conversation is not a conversation');
  assert.deepEqual(r.rows[0], ['353850000001', 'No Contact', '', '', '', 'inbox', NOW], 'an unknown stage counts as a new lead');
  assert.deepEqual(r.rows[1], ['353850000002', 'Only In Contact', 'Lucan', '', 'mixed@case.ie', 'inbox', NOW - 1], 'name, town and email from the contact when the chat has none; spaces tidied');
  assert.equal(r.rows[2][1].length, 100, 'a very long name is cut');
});

test('STAFF ONLY and strict input: nobody else, no sign-in, and nothing may be sent with the request', async () => {
  await seed(5);
  await assert.rejects(ask({}, { uid: 'x', token: { email: 'other@example.com', email_verified: true, staff: true } }), (e) => e.code === 'permission-denied');
  await assert.rejects(ask({}, null), (e) => e.code === 'unauthenticated');
  for (const bad of [{ q: 'anna' }, [], 'text', 5]) await assert.rejects(ask(bad), (e) => e.code === 'invalid-argument', JSON.stringify(bad));
  assert.equal((await ask(null)).rows.length, 5); assert.equal((await ask(undefined)).rows.length, 5);
});

test('MORE THAN THE MAXIMUM: cut at the newest, and it says so (so the screen can tell you)', async () => {
  await seed(60);
  const r = await D.build({ db }, {}, { nowMs: NOW, max: 50 });
  assert.equal(r.rows.length, 50); assert.equal(r.truncated, true); assert.equal(r.rows[0][1], 'Customer 0'); assert.equal(r.rows[49][1], 'Customer 49');
  D.resetCache(); const exact = await D.build({ db }, {}, { nowMs: NOW, max: 60 }); assert.equal(exact.truncated, false); assert.equal(exact.rows.length, 60);
  assert.equal(D.MAX, 20000);
});

test('KEPT FOR 2 MINUTES: asking again does not read the database again; after 2 minutes it does', async () => {
  await seed(10);
  const a = await D.build({ db }, {}, { nowMs: NOW }); assert.equal(a.cached, false);
  await db.doc('conversations/353859999999').set({ phone: '353859999999', name: 'New Person', updatedAt: Timestamp.fromMillis(NOW + 1000) });
  const b = await D.build({ db }, {}, { nowMs: NOW + 119000 }); assert.equal(b.cached, true); assert.equal(b.rows.length, 10, 'the new customer is not there yet');
  const c = await D.build({ db }, {}, { nowMs: NOW + 121000 }); assert.equal(c.cached, false); assert.equal(c.rows.length, 11); assert.equal(c.rows[0][1], 'New Person');
  assert.equal(D.CACHE_MS, 120000);
});

test('NO CUSTOMERS: an empty list, not an error', async () => {
  const r = await ask(); assert.deepEqual([r.rows, r.total, r.truncated], [[], 0, false]);
});
