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
const MIN = 60 * 1000;
// make the last move look older than the 5-minute correction window
async function old(p = P, ms = 6 * MIN) { const lm = (await db.doc('conversations/' + p).get()).data().lastMove; await db.doc('conversations/' + p).update({ 'lastMove.at': Timestamp.fromMillis(lm.at.toMillis() - ms) }); }
const move = (status, p = P, user = staff) => h.setConversationStatus(user, { phone: p, status }, deps());
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

test('stage dates: re-entering a stage later (after the correction window) gets the latest date; other stages keep theirs', async () => {
  await seed();
  await h.setConversationStatus(staff, { phone: P, status: 'booked' }, deps());
  await h.setConversationStatus(staff, { phone: P, status: 'quoted' }, deps());
  const booked1 = (await conv()).stageDates.booked.toMillis();
  await old();                                                                            // the quoted move is now older than the window
  await new Promise((r) => setTimeout(r, 25));
  await h.setConversationStatus(staff, { phone: P, status: 'booked' }, deps());           // a genuine move back
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
    const s = env.authenticatedContext('s1', { staff: true, staffUntil: Date.now() + 3600000, email: 'thomas@example.com' }).firestore();
    assert.equal((await s.doc('contacts/' + P).get()).data().quoteValue, 14500);
    assert.ok((await s.doc('conversations/' + P).get()).data().stageDates.won);
    await assertFails(s.doc('contacts/' + P).update({ quoteValue: 1 }));
    await assertFails(s.doc('conversations/' + P).update({ 'stageDates.won': new Date() }));
    await assertFails(s.doc('conversations/' + P).update({ inboxStatus: 'won' }));
    const stranger = env.authenticatedContext('x', { email: 'x@gmail.com' }).firestore();
    await assertFails(stranger.doc('contacts/' + P).get());
  } finally { await env.cleanup(); }
});

// ---------------- corrections (undo window) ----------------
const store = require('../lib/store');
const stageKeys = async (p = P) => Object.keys((await conv(p)).stageDates || {}).sort();

test('correction: New lead -> Booked, straight back within the window: the Booked date and the move leave no trace', async () => {
  await seed();
  const before = await conv();
  await move('booked');
  assert.deepEqual(await stageKeys(), ['booked']);
  const r = await move('inbox');
  assert.deepEqual([r.ok, r.corrected, r.undone], [true, true, 'booked']);
  const c = await conv();
  assert.equal(c.inboxStatus, 'inbox'); assert.deepEqual(await stageKeys(), []); assert.equal(c.lastMove, undefined);
  assert.equal(c.unreadCount, before.unreadCount); assert.equal(c.lastMessage, before.lastMessage);
  const CRM = require('../../public/crm.js');                                             // and the conversion maths sees an untouched New lead
  const [row] = CRM.buildRows([{ id: P, ...c }], []);
  assert.deepEqual(CRM.overview([row], null).leadToBooked, { num: 0, den: 1 });
  assert.equal(CRM.overview([row], null).booked, 0);
});

test('correction: works for every stage, e.g. Quoted -> Won -> Quoted removes only the Won date', async () => {
  await seed();
  await move('quoted'); const q = (await conv()).stageDates.quoted.toMillis();
  await move('won'); assert.deepEqual(await stageKeys(), ['quoted', 'won']);
  assert.equal((await move('quoted')).corrected, true);
  const c = await conv();
  assert.equal(c.inboxStatus, 'quoted'); assert.deepEqual(await stageKeys(), ['quoted']); assert.equal(c.stageDates.quoted.toMillis(), q);
  await move('won'); await move('closed'); await move('won');                            // Won -> Closed -> Won: only the Closed date is undone
  assert.deepEqual(await stageKeys(), ['quoted', 'won']);
});

test('correction: after the window the history is kept (moving back later is a genuine move)', async () => {
  await seed();
  await move('booked'); await old(P, 6 * MIN);
  const r = await move('inbox');
  assert.equal(r.corrected, undefined);
  const c = await conv();
  assert.equal(c.inboxStatus, 'inbox'); assert.deepEqual(await stageKeys(), ['booked']);
  assert.deepEqual([c.lastMove.from, c.lastMove.to], ['booked', 'inbox']);
});

test('correction: the window is 5 minutes, inclusive', async () => {
  await seed();
  const t0 = Date.now();
  await store.setConversationStatus(db, P, 'booked', t0);
  assert.equal((await store.setConversationStatus(db, P, 'inbox', t0 + 5 * MIN)).corrected, true);                 // exactly 5:00
  await store.setConversationStatus(db, P, 'booked', t0);
  assert.equal((await store.setConversationStatus(db, P, 'inbox', t0 + 5 * MIN + 1)).corrected, false);            // 5:00.001
  assert.deepEqual(await stageKeys(), ['booked']);
  assert.equal(store.CORRECTION_WINDOW_MS, 5 * MIN);
});

test('correction: moving forward through stages keeps every date, even quickly (New lead -> Booked -> Quoted)', async () => {
  await seed();
  await move('booked'); const r = await move('quoted');
  assert.equal(r.corrected, undefined);
  assert.deepEqual(await stageKeys(), ['booked', 'quoted']);
  await move('won'); assert.deepEqual(await stageKeys(), ['booked', 'quoted', 'won']);
});

test('correction: only the last move can be undone; a second step back is a genuine move', async () => {
  await seed();
  await move('booked'); await move('quoted');
  assert.equal((await move('booked')).corrected, true);                                   // undoes Quoted
  assert.deepEqual(await stageKeys(), ['booked']);
  const r = await move('inbox');                                                          // lastMove was cleared by the correction
  assert.equal(r.corrected, undefined); assert.deepEqual(await stageKeys(), ['booked']);
});

test('correction: a genuine earlier date is restored, not lost or re-stamped', async () => {
  await seed(P, { inboxStatus: 'booked', stageDates: { booked: Timestamp.fromMillis(Date.now() - 3 * 86400000) } });
  const d3 = (await conv()).stageDates.booked.toMillis();
  await move('inbox');                                                                    // accidental: Booked -> New lead (a real move, nothing dated)
  assert.equal((await move('booked')).corrected, true);                                   // straight back: a correction, so Booked is NOT re-stamped
  assert.equal((await conv()).stageDates.booked.toMillis(), d3);
  await move('quoted'); await move('booked');                                             // Booked -> Quoted -> Booked: undoes Quoted, keeps the 3-day-old Booked date
  const c = await conv(); assert.equal(c.stageDates.booked.toMillis(), d3); assert.equal(c.stageDates.quoted, undefined);
  await move('quoted'); await old(); await move('booked'); await move('quoted');         // a genuine re-entry (after the window) is stamped with the new time
  assert.ok((await conv()).stageDates.quoted.toMillis() > Date.now() - 60000);
});

test('correction: re-entering a stage saves its previous date so the correction can restore it', async () => {
  await seed();
  await move('quoted'); await move('won'); const w1 = (await conv()).stageDates.won.toMillis();
  await old(); await move('quoted');                                                     // Won -> Quoted a while later: genuine, the Won date is kept
  const q1 = (await conv()).stageDates.quoted.toMillis();
  await old(); await new Promise((r) => setTimeout(r, 30));
  await move('won');                                                                     // genuine re-entry: stamps a new Won date, remembers the old one
  const w2 = (await conv()).stageDates.won.toMillis(); assert.ok(w2 > w1);
  assert.equal((await move('quoted')).corrected, true);                                  // straight back: the earlier Won date comes back
  const c = await conv(); assert.equal(c.stageDates.won.toMillis(), w1); assert.equal(c.stageDates.quoted.toMillis(), q1); assert.equal(c.inboxStatus, 'quoted');
});

test('correction: another staff member moving it back counts too; a different move in between does not', async () => {
  await seed();
  const other = { uid: 'u2', token: { email: 'other@example.com', email_verified: true, staff: true } };
  await h.setConversationStatus(staff, { phone: P, status: 'booked' }, { db, cfg: { ...cfg, allowedEmails: 'thomas@example.com, other@example.com' } });
  const r = await h.setConversationStatus(other, { phone: P, status: 'inbox' }, { db, cfg: { ...cfg, allowedEmails: 'thomas@example.com, other@example.com' } });
  assert.equal(r.corrected, true); assert.deepEqual(await stageKeys(), []);
});

test('correction: a stale note or manual edit cannot cause a wrong undo; missing customers still error', async () => {
  await seed(P, { inboxStatus: 'won', lastMove: { from: 'quoted', to: 'booked', at: Timestamp.now(), prev: null }, stageDates: { booked: Timestamp.now(), won: Timestamp.now() } });
  const r = await move('quoted');                                                         // note says booked, customer is Won: not a correction
  assert.equal(r.corrected, undefined); assert.deepEqual(await stageKeys(), ['booked', 'quoted', 'won']);
  await rejects(move('booked', '353800000000'), 'not-found');
});

test('correction: nothing but status, stage dates and the note changes; a note-less (pre-correction) customer behaves as before', async () => {
  await seed(P, { inboxStatus: 'booked', stageDates: { booked: Timestamp.now() } });      // booked before corrections existed: no lastMove
  const before = await conv(); await db.doc('contacts/' + P).update({ quoteValue: 5000, notes: 'n' });
  assert.equal((await move('inbox')).corrected, undefined);                                // cannot be auto-corrected: kept as a real move
  assert.deepEqual(Object.keys((await conv()).stageDates), ['booked']);
  const { stageDates, lastMove, inboxStatus, ...rest } = await conv(); const { stageDates: s0, inboxStatus: i0, ...rest0 } = before;
  assert.deepEqual(rest, rest0); const k = await contact(); assert.deepEqual([k.quoteValue, k.notes], [5000, 'n']);
});

// ---------------- clean-up script for test customers ----------------
const { spawnSync } = require('child_process');
const SCRIPT = require('path').join(__dirname, '../../scripts/clear-stage-history.js');
const run = (args, input = '') => spawnSync('node', [SCRIPT, ...args], { input, encoding: 'utf8', env: { ...process.env, GCLOUD_PROJECT: PROJECT } });
async function seedHistory(p = P) {
  await seed(p, { inboxStatus: 'booked', unreadCount: 3, stageDates: { booked: Timestamp.fromMillis(Date.now() - 86400000), quoted: Timestamp.fromMillis(Date.now() - 3600000) }, lastMove: { from: 'inbox', to: 'booked', at: Timestamp.now(), prev: null } });
  await db.doc('contacts/' + p).update({ quoteValue: 12000, notes: 'keep me' });
  await db.doc(`conversations/${p}/messages/m1`).set({ direction: 'in', body: 'hello', createdAt: Timestamp.now() });
}

test('clean-up script: --list is read-only and shows who has stage dates', async () => {
  await seedHistory(); await seed('353852222222');                                          // the second customer has no history
  const before = await conv(); const r = run(['--list']);
  assert.equal(r.status, 0); assert.match(r.stdout, /…1111/); assert.doesNotMatch(r.stdout, /…2222/);
  assert.deepEqual(await conv(), before);
});

test('clean-up script: asks first; a wrong or empty answer changes nothing', async () => {
  await seedHistory(); const before = await conv();
  for (const answer of ['', 'yes\n', '0000\n', 'n\n']) {
    const r = run([P], answer); assert.equal(r.status, 0); assert.match(r.stdout, /REMOVED: booked/); assert.match(r.stdout, /Cancelled\. Nothing was changed/);
    assert.deepEqual(await conv(), before);
  }
  assert.match(run([P], '').stdout, /quoted/);                                              // it shows exactly what it would remove
});

test('clean-up script: with the right confirmation it removes only the stage history, nothing else', async () => {
  await seedHistory(); const before = await conv();
  const r = run([P], '1111\n'); assert.equal(r.status, 0); assert.match(r.stdout, /Done\./);
  const c = await conv(); assert.deepEqual(Object.keys(c.stageDates || {}), []); assert.equal(c.lastMove, undefined);
  assert.equal(c.inboxStatus, 'booked'); assert.equal(c.unreadCount, 3); assert.equal(c.lastMessage, before.lastMessage);   // status and activity untouched
  const k = await contact(); assert.deepEqual([k.quoteValue, k.notes, k.name], [12000, 'keep me', 'Anna']);
  assert.equal((await db.doc(`conversations/${P}/messages/m1`).get()).data().body, 'hello');
  const CRM = require('../../public/crm.js'); const [row] = CRM.buildRows([{ id: P, ...c }], []);
  assert.deepEqual(row.stageDates, { booked: null, quoted: null, won: null, closed: null });
  assert.match(run([P], '1111\n').stdout, /Nothing to change/);                              // running it again is harmless
});

test('clean-up script: --stages limits what is removed and --status puts the customer back', async () => {
  await seedHistory();
  assert.equal(run([P, '--stages', 'booked'], '1111\n').status, 0);
  const c = await conv(); assert.deepEqual(Object.keys(c.stageDates), ['quoted']); assert.ok(c.lastMove);               // partial: the note is kept
  assert.equal(run([P, '--status', 'inbox'], '1111\n').status, 0);
  assert.equal((await conv()).inboxStatus, 'inbox');
});

test('clean-up script: bad input and unknown customers are refused without touching anything', async () => {
  await seedHistory(); const before = await conv();
  assert.notEqual(run([]).status, 0);
  assert.notEqual(run([P, '--stages', 'inbox'], '1111\n').status, 0);
  assert.notEqual(run([P, '--status', 'archived'], '1111\n').status, 0);
  const r = run(['353809999999'], '9999\n'); assert.notEqual(r.status, 0); assert.match(r.stderr, /No customer/);
  assert.deepEqual(await conv(), before);
});
