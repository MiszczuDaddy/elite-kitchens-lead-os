// Phase 4: pipeline stage dates and quote value. Real Firestore emulator; no WhatsApp calls are involved.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing');
const { createClient } = require('../lib/whatsapp');
const { handleLeadRequest } = require('../lib/leads');
const h = require('../lib/handlers');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT, storageBucket: 'demo-leados.firebasestorage.app' });
const db = getFirestore();
const cfg = { phoneId: '111', token: 'tok', template: 'elite_kitchens_new_lead', lang: 'en', version: 'v21.0', allowedEmails: 'thomas@example.com', apiKeys: 'crm-test-key-1234567890-abcdef' };
const staff = { uid: 'u1', token: { email: 'thomas@example.com', email_verified: true, staff: true } };
const deps = () => ({ db, cfg });
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code, `expected ${code}`);
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const sends = [];
const mockFetch = async (url, opts = {}) => { sends.push(JSON.parse(opts.body)); return reply({ messages: [{ id: 'wamid.W' + sends.length }] }); };

const P = '353851111111';
const conv = async (p = P) => (await db.doc('conversations/' + p).get()).data();
const contact = async (p = P) => (await db.doc('contacts/' + p).get()).data();
async function seed(p = P, extra = {}) {
  await db.doc('contacts/' + p).set({ phone: p, name: 'Anna', createdAt: Timestamp.now() });
  await db.doc('conversations/' + p).set({ phone: p, name: 'Anna', createdAt: Timestamp.now(), updatedAt: Timestamp.now(), lastMessage: 'Hi', unreadCount: 2, ...extra });
}
beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  sends.length = 0;
});

test('stage dates: entering booked/quoted/won/closed stamps that stage once; New lead needs no date', async () => {
  await seed();
  assert.equal((await conv()).stageDates, undefined);                     // an old-shape customer is untouched
  for (const s of ['booked', 'quoted', 'won', 'closed']) {
    await h.setConversationStatus(staff, { phone: P, status: s }, deps());
    const c = await conv();
    assert.equal(c.inboxStatus, s); assert.ok(c.stageDates[s] instanceof Timestamp, s + ' date set');
  }
  assert.deepEqual(Object.keys((await conv()).stageDates).sort(), ['booked', 'closed', 'quoted', 'won']);
  await h.setConversationStatus(staff, { phone: P, status: 'inbox' }, deps());          // back to New lead: status moves, history is kept
  const c = await conv();
  assert.equal(c.inboxStatus, 'inbox'); assert.equal(Object.keys(c.stageDates).length, 4);
  assert.equal(c.unreadCount, 2); assert.equal(c.lastMessage, 'Hi');                    // nothing else about the conversation changed
});

test('stage dates: choosing the current stage again writes nothing, so a date cannot be moved by a double click', async () => {
  await seed();
  await h.setConversationStatus(staff, { phone: P, status: 'quoted' }, deps());
  const first = (await conv()).stageDates.quoted.toMillis();
  await new Promise((r) => setTimeout(r, 25));
  await h.setConversationStatus(staff, { phone: P, status: 'quoted' }, deps());
  assert.equal((await conv()).stageDates.quoted.toMillis(), first);
  await h.setConversationStatus(staff, { phone: P, status: 'inbox' }, deps());          // New lead on a customer that already shows as New lead
  await h.setConversationStatus(staff, { phone: P, status: 'inbox' }, deps());
  assert.equal((await conv()).inboxStatus, 'inbox');
});

test('stage dates: a customer who re-enters a stage gets the latest date; other stages keep theirs', async () => {
  await seed();
  await h.setConversationStatus(staff, { phone: P, status: 'booked' }, deps());
  await h.setConversationStatus(staff, { phone: P, status: 'quoted' }, deps());
  const booked1 = (await conv()).stageDates.booked.toMillis();
  await new Promise((r) => setTimeout(r, 25));
  await h.setConversationStatus(staff, { phone: P, status: 'booked' }, deps());
  const c = await conv();
  assert.ok(c.stageDates.booked.toMillis() > booked1); assert.ok(c.stageDates.quoted);
});

test('stage dates: a missing or deleted customer is never recreated', async () => {
  await rejects(h.setConversationStatus(staff, { phone: P, status: 'won' }, deps()), 'not-found');
  assert.equal((await db.doc('conversations/' + P).get()).exists, false);
});

test('quote value: saved as whole euros on the contact, cleared with empty, validated', async () => {
  await seed();
  await h.updateContact(staff, { phone: P, fields: { quoteValue: 14500 } }, deps());
  assert.equal((await contact()).quoteValue, 14500);
  await h.updateContact(staff, { phone: P, fields: { quoteValue: 16000, notes: 'Island + pantry' } }, deps());   // together with ordinary fields
  const c1 = await contact(); assert.deepEqual([c1.quoteValue, c1.notes], [16000, 'Island + pantry']);
  await h.updateContact(staff, { phone: P, fields: { quoteValue: null } }, deps());
  assert.equal((await contact()).quoteValue, null);
  await h.updateContact(staff, { phone: P, fields: { quoteValue: 9000 } }, deps());
  await h.updateContact(staff, { phone: P, fields: { quoteValue: '' } }, deps());
  assert.equal((await contact()).quoteValue, null);
  for (const bad of [0, -5, 14500.5, 1000001, '14500', 'lots', NaN, Infinity, {}, [], true]) {
    await rejects(h.updateContact(staff, { phone: P, fields: { quoteValue: bad } }, deps()), 'invalid-argument');
  }
  assert.equal((await conv()).quoteValue, undefined);                                     // not copied anywhere else
  await rejects(h.updateContact(null, { phone: P, fields: { quoteValue: 5 } }, deps()), 'unauthenticated');
  await rejects(h.updateContact({ uid: 'x', token: { email: 'stranger@gmail.com', email_verified: true, staff: true } }, { phone: P, fields: { quoteValue: 5 } }, deps()), 'permission-denied');
  await rejects(h.updateContact(staff, { phone: '353800000000', fields: { quoteValue: 5 } }, deps()), 'not-found');
});

test('quote value: existing contact fields behave exactly as before', async () => {
  await seed();
  await h.updateContact(staff, { phone: P, fields: { name: 'Anna M', email: 'a@example.com', location: 'Swords', projectType: 'Kitchen', budget: '15k', source: 'Meta Ads', notes: 'n' } }, deps());
  const c = await contact();
  assert.deepEqual([c.name, c.email, c.location, c.projectType, c.budget, c.source, c.notes], ['Anna M', 'a@example.com', 'Swords', 'Kitchen', '15k', 'Meta Ads', 'n']);
  assert.equal(c.quoteValue, undefined);
  await rejects(h.updateContact(staff, { phone: P, fields: { admin: 'yes' } }, deps()), 'invalid-argument');
  await rejects(h.updateContact(staff, { phone: P, fields: { stageDates: {} } }, deps()), 'invalid-argument');    // staff cannot write dates directly
  await rejects(h.updateContact(staff, { phone: P, fields: { inboxStatus: 'won' } }, deps()), 'invalid-argument');
});

test('a new Meta lead still starts as New lead with no stage dates or quote value; the Phase 3 flow is unchanged', async () => {
  const wa = createClient({ ...cfg, apiBase: undefined }, mockFetch);
  const body = { leadId: 'CRMLEAD00001', formName: 'Kitchens', fields: { full_name: 'Niamh Kelly', phone_number: '0861112222', city: 'Swords' } };
  const r = await handleLeadRequest({ method: 'POST', headers: { authorization: 'Bearer ' + cfg.apiKeys }, rawBody: Buffer.from(JSON.stringify(body)), body }, { db, wa, cfg });
  assert.equal(r.body.welcome, 'sent'); assert.equal(sends.length, 1);
  const c = await conv('353861112222');
  assert.equal(c.inboxStatus, undefined); assert.equal(c.stageDates, undefined); assert.ok(c.createdAt);
  const k = await contact('353861112222'); assert.equal(k.source, 'Meta Ads'); assert.equal(k.quoteValue, undefined);
  await h.setConversationStatus(staff, { phone: '353861112222', status: 'booked' }, deps());   // and it moves through the pipeline normally
  assert.ok((await conv('353861112222')).stageDates.booked);
});

test('security rules: staff can read the new fields; nobody can write them from a browser', async () => {
  await seed(P, { stageDates: { won: Timestamp.now() } });
  await db.doc('contacts/' + P).set({ quoteValue: 14500 }, { merge: true });
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  const env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { host, port: +port, rules: fs.readFileSync(require('path').join(__dirname, '../../firestore.rules'), 'utf8') } });
  try {
    const s = env.authenticatedContext('s1', { staff: true, email: 'thomas@example.com' }).firestore();
    assert.equal((await s.doc('contacts/' + P).get()).data().quoteValue, 14500);
    assert.ok((await s.doc('conversations/' + P).get()).data().stageDates.won);
    await assertFails(s.doc('contacts/' + P).update({ quoteValue: 1 }));
    await assertFails(s.doc('conversations/' + P).update({ 'stageDates.won': new Date() }));
    await assertFails(s.doc('conversations/' + P).update({ inboxStatus: 'won' }));
    const stranger = env.authenticatedContext('x', { email: 'x@gmail.com' }).firestore();
    await assertFails(stranger.doc('contacts/' + P).get());
  } finally { await env.cleanup(); }
});
