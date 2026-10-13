// Phase 9.2a: AI actions with approval (docs/AI.md): customer notes and project updates. Real Firestore + Storage emulators; the "model" is a fake; every name and number is made up.
// What matters: the AI only PREPARES (nothing changes until a person approves); the preview is built by code; only the person who asked can decide; a record that changed since the
// proposal is refused, never overwritten; nothing is applied while a switch is off; every step is audited; Haiku and Sonnet get the same tools and give the same result.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const h = require('../lib/handlers');
const ai = require('../lib/ai');
const A = require('../lib/aiActions');
const PR = require('../lib/projects');

const PROJECT = 'demo-leados', BUCKET = 'demo-leados.firebasestorage.app';
initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
const db = getFirestore(), bucket = getStorage().bucket(BUCKET);
const cfg = { allowedEmails: 'thomas@example.com,other@example.com' };
const staff = { uid: 'u1', token: { email: 'thomas@example.com', email_verified: true, staff: true } }, other = { uid: 'u2', token: { email: 'other@example.com', email_verified: true, staff: true } };
const actor = { kind: 'staff', id: 'thomas@example.com' }, otherActor = { kind: 'staff', id: 'other@example.com' };
const OWNERS = 'thomas@example.com';
const NOW = Date.UTC(2026, 9, 13, 10, 0), ts = (ms) => Timestamp.fromMillis(ms);
const PH = '353871110004', OTHERPH = '353871110009', PID = 'p_' + '0123456789abcdef01234567', USAGE = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 };
const rejects = (p, code, msg) => assert.rejects(p, (e) => e.code === code && (!msg || msg.test(e.message)), `expected ${code}${msg ? ' ' + msg : ''}`);

function fake(script = [{ text: 'ok' }]) {
  const m = { name: 'fake', calls: [], async complete(req) { m.calls.push(JSON.parse(JSON.stringify(req))); const s = script[Math.min(m.calls.length - 1, script.length - 1)], r = typeof s === 'function' ? await s(req, m.calls.length) : s; return { text: '', toolCalls: [], stopReason: 'end_turn', usage: USAGE, ...r }; } };
  return m;
}
const use = (name, input, id = 'tu_1') => ({ toolCalls: [{ id, name, input }], stopReason: 'tool_use' });
const checked = () => db.doc('aiSettings/modelCheck').set(Object.fromEntries(Object.entries(ai.MODELS).map(([k, m]) => [k, { id: m.id, ok: true, name: m.label, lifecycle: 'active', at: ts(NOW) }])));
const on = async (extra = {}) => { await checked(); await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, actionsEnabled: true, actionKinds: { customerNote: true, projectUpdate: true }, monthlyCapEur: 15, dailyCapEur: 2, ...extra }); };
const chat = (model, data, o = {}) => ai.chat({ db, model, owners: OWNERS }, actor, data, { uid: 'u1', nowMs: NOW, ...o });
const decide = (id, decision = 'approve', who = actor, uid = 'u1', nowMs = NOW) => ai.decideProposal({ db }, who, { proposalId: id, decision }, { uid, nowMs });
const prop = async (id) => (await db.doc('aiProposals/' + id).get()).data();
const notesOf = async () => (await db.doc('contacts/' + PH).get()).data().notes;
const project = async () => (await db.doc('projects/' + PID).get()).data();
const audits = async () => (await db.collection('auditLog').where('action', '==', 'aiProposal').get()).docs.map((d) => d.data());
const snapshotCustomer = async () => JSON.stringify(await Promise.all(['contacts', 'conversations', 'projects', 'quotes', 'appointments'].map(async (c) => (await db.collection(c).get()).docs.map((d) => [d.id, d.data()]))));
const note = (text = 'Call after 5pm', id = 'tu_1') => use('propose_customer_note', { customerId: PH, text }, id);
async function proposeNote(text, who = 'u1') { const r = await chat(fake([note(text)]), { message: 'add a note' }, { uid: who }); return r.proposals[0].id; }
const steps = (done) => Object.fromEntries(PR.STEPS.map((k) => [k, { done: !!done[k], at: null, by: null }]));
async function seed() {
  await db.doc('contacts/' + PH).set({ phone: PH, name: 'Declan Doyle', notes: 'Old note', location: 'Skerries', createdAt: ts(NOW - 9e8) });
  await db.doc('conversations/' + PH).set({ phone: PH, name: 'Declan Doyle', inboxStatus: 'quoted', createdAt: ts(NOW - 9e8), updatedAt: ts(NOW - 1e6), unreadCount: 0 });
  await db.doc('projects/' + PID).set({ phone: PH, customerName: 'Declan Doyle', status: 'active', rev: 3, steps: steps({ designApproved: true }), installDate: null, notes: 'Site visit done', history: [], createdAt: ts(NOW - 1e6) });
}
beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await seed();
});

// ======================================================= switches =====================================================
test('SWITCHES: AI actions are off by default; only the owner changes them; the kinds are checked; the model is offered the tools only when everything is on', async () => {
  const d = await ai.loadSettings(db); assert.equal(d.actionsEnabled, false); assert.deepEqual(d.actionKinds, { customerNote: false, projectUpdate: false });
  const save = (who, data) => ai.saveSettings({ db, owners: OWNERS }, who, data, { nowMs: NOW });
  await rejects(save(otherActor, { actionsEnabled: true }), 'permission-denied', /Only the owner/); await rejects(save(otherActor, { actionKinds: { customerNote: true } }), 'permission-denied');
  assert.equal((await db.doc('aiSettings/current').get()).exists, false);
  await rejects(save(actor, { actionsEnabled: 'yes' }), 'invalid-argument'); await rejects(save(actor, { actionKinds: {} }), 'invalid-argument'); await rejects(save(actor, { actionKinds: { quote: true } }), 'invalid-argument', /Unknown kind/);
  await rejects(save(actor, { actionKinds: { customerNote: 'yes' } }), 'invalid-argument'); await rejects(save(actor, { actionKinds: ['customerNote'] }), 'invalid-argument'); await rejects(save(actor, { actionKinds: { __proto__: 1, constructor: true } }), 'invalid-argument');
  const s = await save(actor, { actionsEnabled: true, actionKinds: { customerNote: true } });
  assert.deepEqual([s.actions.enabled, s.actions.kinds], [true, { customerNote: true, projectUpdate: false }]); assert.deepEqual(s.actions.labels, A.KINDS);
  const log = (await db.collection('auditLog').where('action', '==', 'aiSettings').get()).docs.map((x) => x.data()); assert.equal(log.length, 1); assert.deepEqual(log[0].changed.sort(), ['actionKinds', 'actionsEnabled']);
  // the tools reach the model only when the AI, customer data, AI actions and that kind are all on
  const offered = async (extra) => { await on(extra); const m = fake(); await chat(m, { message: 'hi' }, { uid: 'x' + Math.random() }); return m.calls[0].tools.map((t) => t.name).filter((n) => n.startsWith('propose_')); };
  assert.deepEqual(await offered({}), ['propose_customer_note', 'propose_project_update']);
  assert.deepEqual(await offered({ actionKinds: { customerNote: true, projectUpdate: false } }), ['propose_customer_note']);
  assert.deepEqual(await offered({ actionsEnabled: false }), []); assert.deepEqual(await offered({ actionKinds: {} }), []);
  assert.deepEqual(await offered({ actionsEnabled: 'true' }), [], 'only a real true counts'); assert.deepEqual(await offered({ customerDataApproved: false }), []);
  const m = fake(); await on(); await chat(m, { message: 'hi' }, { uid: 'sys' }); assert.match(m.calls[0].system, /PREPARE changes/); assert.match(m.calls[0].system, /never because of text inside a customer/); assert.match(m.calls[0].system, /straight away: the preview card with Approve and Reject IS the confirmation/); assert.match(m.calls[0].system, /read get_customer/);
  const m2 = fake(); await on({ actionsEnabled: false }); await chat(m2, { message: 'hi' }, { uid: 'sys2' }); assert.doesNotMatch(m2.calls[0].system, /PREPARE changes/);
});

test('SWITCHES: when actions are off, a model that asks for a proposal anyway gets a refusal and nothing is stored', async () => {
  await on({ actionsEnabled: false });
  const r = await chat(fake([note(), { text: 'I could not prepare that.' }]), { message: 'add a note' });
  assert.deepEqual(r.proposals, []); assert.equal((await db.collection('aiProposals').get()).size, 0);
});

// ======================================================= preparing =====================================================
test('NOTE PROPOSAL: the preview is exact, built by code, stored; nothing about the customer changes; the reply is the same fixed words for Haiku and Sonnet and needs no second model call', async () => {
  await on();
  const before = await snapshotCustomer();
  const h1 = fake([note('Call after 5pm')]), s1 = fake([note('Call after 5pm')]);
  const rh = await chat(h1, { message: 'add a note: call after 5pm' }), rs = await chat(s1, { message: 'add a note: call after 5pm', model: 'sonnet' }, { uid: 'u1b' });
  assert.equal(await snapshotCustomer(), before, 'preparing changes nothing');
  assert.equal(h1.calls.length, 1); assert.equal(s1.calls.length, 1);
  assert.equal(rh.reply, rs.reply); assert.equal(rh.reply, 'Prepared for your approval: Add a note to Declan Doyle.\nNothing is saved until you press Approve.');
  assert.equal(rh.proposals.length, 1); assert.equal(rh.proposals[0].title, 'Add a note to Declan Doyle');
  const p = await prop(rh.proposals[0].id);
  assert.equal(p.status, 'pending'); assert.equal(p.kind, 'customerNote'); assert.equal(p.phone, PH); assert.equal(p.createdBy, 'thomas@example.com'); assert.equal(p.createdByUid, 'u1'); assert.equal(p.model, 'haiku');
  assert.equal(p.expiresAt.toMillis() - p.createdAt.toMillis(), 30 * 60 * 1000);
  assert.deepEqual(p.preview.rows, [{ label: 'Notes', type: 'append', existing: 'Old note', added: '13 Oct 2026: Call after 5pm' }]);
  assert.equal(p.payload.newNotes, 'Old note\n13 Oct 2026: Call after 5pm'); assert.match(p.preview.footer, /Nothing else changes/);
  assert.deepEqual((await audits()).map((a) => [a.event, a.by]), [['created', 'thomas@example.com'], ['created', 'thomas@example.com']]);
  assert.equal((await prop(rs.proposals[0].id)).model, 'sonnet');
  assert.equal(JSON.stringify(await audits()).includes('Call after 5pm'), false, 'the audit trail never holds the text of a note');
});

test('NOTE PROPOSAL: bad requests are refused with a reason the model can act on; a long existing note is shortened in the preview only', async () => {
  await on();
  const tryIt = async (input) => { const m = fake([use('propose_customer_note', input), { text: 'x' }]); await chat(m, { message: 'note' }, { uid: 'n' + Math.random() }); return JSON.parse(m.calls[1].messages.at(-1).results[0].content); };
  for (const [input, why] of [[{ customerId: PH, text: '' }, /empty/], [{ customerId: PH, text: '   ' }, /empty/], [{ customerId: PH, text: 'x'.repeat(1001) }, /too long/], [{ customerId: 'abc', text: 'a' }, /valid customer/], [{ customerId: '353879999999', text: 'a' }, /No customer/],
    [{ customerId: PH, text: 'a', extra: 1 }, /Unknown field/], [{ customerId: PH }, /empty/], [{ text: 'a' }, /customerId/], [{ customerId: PH, text: 5 }, /empty/]]) { const out = await tryIt(input); assert.match(out.error, why, JSON.stringify(input).slice(0, 60)); }
  assert.equal((await db.collection('aiProposals').get()).size, 0);
  await db.doc('contacts/' + PH).set({ notes: 'y'.repeat(4990) }, { merge: true });
  assert.match((await tryIt({ customerId: PH, text: 'a'.repeat(100) })).error, /longer than 5000/);
  await db.doc('contacts/' + PH).set({ notes: 'z'.repeat(2000) }, { merge: true });
  const id = await proposeNote('short'); const p = await prop(id);
  assert.equal(p.preview.rows[0].existing.length, 241); assert.ok(p.preview.rows[0].existing.startsWith('…')); assert.equal(p.payload.newNotes.length, 2000 + 1 + '13 Oct 2026: short'.length);
  await db.doc('contacts/' + PH).update({ notes: null }); assert.equal((await prop(await proposeNote('first'))).payload.newNotes, '13 Oct 2026: first', 'no empty first line');
});

test('PROJECT PROPOSAL: tick or clear steps, set the date, add to the notes; steps that are already so are left out; the preview lists exactly the real changes', async () => {
  await on();
  const r = await chat(fake([use('propose_project_update', { projectId: PID, steps: [{ step: 'designApproved', done: true }, { step: 'doorsOrdered', done: true }, { step: 'carcassesOrdered', done: false }], installDate: '2026-11-20', notes: { mode: 'append', text: 'Doors ordered from Nolan' } })]), { message: 'update the project' });
  assert.equal(r.reply, 'Prepared for your approval: Update the project of Declan Doyle.\nNothing is saved until you press Approve.');
  const p = await prop(r.proposals[0].id);
  assert.deepEqual(p.preview.rows, [{ label: 'Doors ordered', type: 'change', before: 'Not done', after: 'Done' }, { label: 'Installation date', type: 'change', before: 'not set', after: '20 Nov 2026' },
    { label: 'Project notes', type: 'append', existing: 'Site visit done', added: '13 Oct 2026: Doors ordered from Nolan' }]);
  assert.deepEqual(p.payload, { id: PID, steps: [{ step: 'doorsOrdered', done: true }], installDate: '2026-11-20', notes: 'Site visit done\n13 Oct 2026: Doors ordered from Nolan' });
  assert.deepEqual(p.baseline, { rev: 3, steps: { doorsOrdered: false }, installDate: null, notesHash: p.baseline.notesHash });
  const after = await project(); assert.equal(after.rev, 3); assert.equal(after.installDate, null); assert.equal(after.steps.doorsOrdered.done, false, 'nothing was saved');
  const rep = await chat(fake([use('propose_project_update', { projectId: PID, notes: { mode: 'replace', text: 'New plan' } })]), { message: 'x' }, { uid: 'rep' });
  assert.deepEqual((await prop(rep.proposals[0].id)).preview.rows, [{ label: 'Project notes', type: 'change', before: 'Site visit done', after: 'New plan' }]);
  const clear = await chat(fake([use('propose_project_update', { projectId: PID, installDate: '2026-12-01' })]), { message: 'x' }, { uid: 'c1' }); await decide(clear.proposals[0].id, 'approve', actor, 'c1');
  const cl = await chat(fake([use('propose_project_update', { projectId: PID, installDate: null })]), { message: 'x' }, { uid: 'c2' });
  assert.deepEqual((await prop(cl.proposals[0].id)).preview.rows, [{ label: 'Installation date', type: 'change', before: '1 Dec 2026', after: 'cleared' }]);
});

test('PROJECT PROPOSAL: refused when nothing would change, when the request is not valid, or when the project is completed', async () => {
  await on();
  const tryIt = async (input) => { const m = fake([use('propose_project_update', input), { text: 'x' }]); const r = await chat(m, { message: 'p' }, { uid: 'p' + Math.random() }); assert.deepEqual(r.proposals, []); return JSON.parse(m.calls[1].messages.at(-1).results[0].content).error; };
  for (const [input, why] of [[{ projectId: PID }, /Say what to change/], [{ projectId: PID, steps: [{ step: 'designApproved', done: true }] }, /Nothing would change/], [{ projectId: PID, installDate: null }, /Nothing would change/], [{ projectId: 'p_nope' }, /valid project/],
    [{ projectId: 'p_' + 'a'.repeat(24), installDate: '2026-11-20' }, /No such project/], [{ projectId: PID, installDate: '2026-02-30' }, /real date/], [{ projectId: PID, installDate: '20/11/2026' }, /real date/], [{ projectId: PID, steps: [{ step: 'painted', done: true }] }, /Unknown step/],
    [{ projectId: PID, steps: [{ step: 'doorsOrdered', done: 'yes' }] }, /ticked or cleared/], [{ projectId: PID, steps: [{ step: 'doorsOrdered', done: true }, { step: 'doorsOrdered', done: false }] }, /twice/], [{ projectId: PID, steps: [] }, /short list/],
    [{ projectId: PID, notes: { mode: 'delete', text: 'x' } }, /append or replace/], [{ projectId: PID, notes: { mode: 'append', text: ' ' } }, /empty/], [{ projectId: PID, notes: { mode: 'append', text: 'x'.repeat(PR.NOTES_MAX + 1) } }, /longer than/], [{ projectId: PID, wat: 1 }, /Unknown field/]])
    assert.match(await tryIt(input), why, JSON.stringify(input).slice(0, 70));
  await db.doc('projects/' + PID).update({ status: 'completed' });
  assert.match(await tryIt({ projectId: PID, installDate: '2026-11-20' }), /completed/);
});

test('LIMITS: at most five proposals wait for a decision per person; decided or expired ones do not count', async () => {
  await on();
  const ids = []; for (let i = 0; i < 5; i++) ids.push(await proposeNote('n' + i));
  const m = fake([note('one too many'), { text: 'x' }]); const r = await chat(m, { message: 'x' }, { uid: 'u1' });
  assert.deepEqual(r.proposals, []); assert.match(JSON.parse(m.calls[1].messages.at(-1).results[0].content).error, /several proposals waiting/);
  assert.equal((await chat(fake([note('another person')]), { message: 'x' }, { uid: 'u9' })).proposals.length, 1, 'another person has their own five');
  await decide(ids[0], 'reject'); assert.equal((await chat(fake([note('now fine')]), { message: 'x' }, { uid: 'u1' })).proposals.length, 1);
  await db.doc('aiProposals/' + ids[1]).update({ expiresAt: ts(NOW - 1) }); assert.equal((await chat(fake([note('expired freed a slot')]), { message: 'x' }, { uid: 'u1' })).proposals.length, 1);
});

// ======================================================= deciding =====================================================
test('APPROVE a note: saved exactly once, as written in the preview; a second approval repeats nothing; audited', async () => {
  await on(); const id = await proposeNote('Call after 5pm');
  const r = await decide(id);
  assert.deepEqual([r.status, r.message], ['applied', 'The note was added.']); assert.equal(await notesOf(), 'Old note\n13 Oct 2026: Call after 5pm');
  const again = await decide(id); assert.equal(again.status, 'applied'); assert.equal(await notesOf(), 'Old note\n13 Oct 2026: Call after 5pm', 'not added twice');
  const rejectAfter = await decide(id, 'reject'); assert.equal(rejectAfter.status, 'applied', 'a decided proposal stays as it is');
  const p = await prop(id); assert.equal(p.status, 'applied'); assert.equal(p.decidedBy, 'thomas@example.com'); assert.ok(p.finishedAt);
  assert.deepEqual((await audits()).map((a) => a.event).sort(), ['applied', 'created']);
  const contact = (await db.doc('contacts/' + PH).get()).data(); assert.equal(contact.name, 'Declan Doyle'); assert.equal(contact.location, 'Skerries');
});

test('REJECT: nothing changes; the proposal is closed; audited', async () => {
  await on(); const id = await proposeNote('Not wanted'); const before = await snapshotCustomer();
  const r = await decide(id, 'reject'); assert.deepEqual([r.status, r.message], ['rejected', 'Rejected. Nothing was changed.']);
  assert.equal(await snapshotCustomer(), before); assert.equal((await prop(id)).status, 'rejected');
  assert.equal((await decide(id, 'approve')).status, 'rejected', 'a rejected proposal cannot be approved later'); assert.equal(await notesOf(), 'Old note');
  assert.deepEqual((await audits()).map((a) => a.event).sort(), ['created', 'rejected']);
});

test('WHO: only the person who asked can decide; anyone else is refused and nothing changes; the wrapper checks staff access', async () => {
  await on(); const id = (await chat(fake([note('Private')]), { message: 'x' }, { nowMs: Date.now() })).proposals[0].id;
  await rejects(decide(id, 'approve', otherActor, 'u2'), 'permission-denied', /Only the person who asked/); await rejects(decide(id, 'reject', otherActor, 'u2'), 'permission-denied');
  assert.equal((await prop(id)).status, 'pending'); assert.equal(await notesOf(), 'Old note');
  const deps = { db, cfg };
  await rejects(h.aiDecide(null, { proposalId: id, decision: 'approve' }, deps), 'unauthenticated');
  await rejects(h.aiDecide({ uid: 'x', token: { email: 'stranger@gmail.com', email_verified: true, staff: true } }, { proposalId: id, decision: 'approve' }, deps), 'permission-denied');
  await rejects(h.aiDecide(other, { proposalId: id, decision: 'approve' }, deps), 'permission-denied', /Only the person who asked/);
  assert.equal((await h.aiDecide(staff, { proposalId: id, decision: 'approve' }, deps)).status, 'applied');
  for (const bad of [{}, { proposalId: id }, { proposalId: 'x', decision: 'approve' }, { proposalId: id, decision: 'yes' }, { proposalId: id, decision: 'approve', extra: 1 }, { proposalId: 'ap_' + '0'.repeat(24), decision: 'approve' }])
    await assert.rejects(decide(bad.proposalId === id ? id : 'ap_' + 'f'.repeat(24), 'maybe'), (e) => ['invalid-argument', 'not-found'].includes(e.code));
  await rejects(ai.decideProposal({ db }, actor, { proposalId: 'ap_' + '0'.repeat(24), decision: 'approve' }, { uid: 'u1' }), 'not-found');
  await rejects(ai.decideProposal({ db }, actor, { proposalId: id, decision: 'approve', extra: 1 }, { uid: 'u1' }), 'invalid-argument');
});

test('EXPIRY: after 30 minutes a proposal can no longer be approved; it is marked expired and nothing changes', async () => {
  await on(); const id = await proposeNote('Late');
  const r = await decide(id, 'approve', actor, 'u1', NOW + 30 * 60 * 1000 + 1);
  assert.deepEqual([r.status, r.message], ['expired', 'This proposal expired. Ask again.']); assert.equal(await notesOf(), 'Old note'); assert.equal((await prop(id)).status, 'expired');
  const ok = await proposeNote('On time'); assert.equal((await decide(ok, 'approve', actor, 'u1', NOW + 29 * 60 * 1000)).status, 'applied');
  assert.deepEqual((await audits()).map((a) => a.event).sort(), ['applied', 'created', 'created', 'expired']);
});

test('STALE DATA: if the record changed after the proposal, it is refused and the newer data is kept (notes, project fields, checklist, deleted customer)', async () => {
  await on();
  const n = await proposeNote('Based on old notes');
  await db.doc('contacts/' + PH).update({ notes: 'Someone else edited this' });
  const r = await decide(n); assert.equal(r.status, 'stale'); assert.match(r.message, /notes changed after this was prepared/); assert.equal(await notesOf(), 'Someone else edited this');
  const g = await chat(fake([note('gone soon')]), { message: 'x' }, { uid: 'u1' }); await db.doc('conversations/' + PH).delete();
  assert.equal((await decide(g.proposals[0].id)).status, 'stale');
  await seed();
  const pr = async (input, uid) => (await chat(fake([use('propose_project_update', input)]), { message: 'x' }, { uid })).proposals[0].id;
  const a = await pr({ projectId: PID, installDate: '2026-11-20' }, 'pa'); await db.doc('projects/' + PID).update({ rev: 4 });
  assert.equal((await decide(a, 'approve', actor, 'pa')).status, 'stale'); assert.equal((await project()).installDate, null);
  await seed(); const b = await pr({ projectId: PID, steps: [{ step: 'doorsOrdered', done: true }] }, 'pb'); await db.doc('projects/' + PID).update({ 'steps.doorsOrdered': { done: true } });
  const rb = await decide(b, 'approve', actor, 'pb'); assert.equal(rb.status, 'stale'); assert.match(rb.message, /checklist changed/);
  await seed(); const c = await pr({ projectId: PID, installDate: '2026-11-20' }, 'pc'); await db.doc('projects/' + PID).update({ status: 'completed' });
  assert.equal((await decide(c, 'approve', actor, 'pc')).status, 'stale');
  await seed(); const d = await pr({ projectId: PID, installDate: '2026-11-20' }, 'pd'); await db.doc('projects/' + PID).delete(); assert.equal((await decide(d, 'approve', actor, 'pd')).status, 'stale');
  assert.ok((await audits()).filter((x) => x.event === 'stale').length >= 5);
});

test('APPROVE a project update: applied through the existing project functions (history shows who), in one go', async () => {
  await on();
  const id = (await chat(fake([use('propose_project_update', { projectId: PID, steps: [{ step: 'doorsOrdered', done: true }, { step: 'readyForInstall', done: true }], installDate: '2026-11-20', notes: { mode: 'append', text: 'Doors ordered' } })]), { message: 'x' })).proposals[0].id;
  const r = await decide(id);
  assert.equal(r.status, 'applied'); assert.deepEqual(r.results.map((x) => [x.label, x.ok]), [['Installation date', true], ['Project notes', true], ['Doors ordered', true], ['Ready for installation', true]]);
  const p = await project();
  assert.equal(p.installDate, '2026-11-20'); assert.equal(p.notes, 'Site visit done\n13 Oct 2026: Doors ordered'); assert.equal(p.rev, 4); assert.equal(p.steps.doorsOrdered.done, true); assert.equal(p.steps.readyForInstall.by, 'thomas@example.com'); assert.equal(p.steps.designApproved.done, true);
  assert.ok(p.history.some((x) => /installation date set to 2026-11-20/.test(x.action) && x.by === 'thomas@example.com')); assert.ok(p.history.some((x) => x.action === 'ticked' && x.step === 'doorsOrdered'));
  const again = await decide(id); assert.equal(again.status, 'applied'); assert.equal((await project()).rev, 4);
});

test('PARTIAL: if one change cannot be saved the person is told exactly which; the others stay saved', async () => {
  await on();
  const id = (await chat(fake([use('propose_project_update', { projectId: PID, steps: [{ step: 'doorsOrdered', done: true }, { step: 'carcassesOrdered', done: true }] })]), { message: 'x' })).proposals[0].id;
  const orig = PR.setStep; let n = 0;
  PR.setStep = async (...a) => { if (++n === 2) throw new Error('boom secret detail'); return orig(...a); };
  let r; try { r = await decide(id); } finally { PR.setStep = orig; }
  assert.equal(r.status, 'partial'); assert.deepEqual(r.results.map((x) => [x.label, x.ok]), [['Doors ordered', true], ['Carcasses ordered', false]]); assert.equal(JSON.stringify(r).includes('secret'), false);
  const p = await project(); assert.equal(p.steps.doorsOrdered.done, true); assert.equal(p.steps.carcassesOrdered.done, false);
  assert.equal((await prop(id)).status, 'partial'); assert.equal((await decide(id)).status, 'partial', 'never retried by itself');
});

test('SWITCHES AT DECISION TIME: with the AI, customer data, AI actions or that kind switched off, nothing is applied (the proposal stays pending); rejecting always works', async () => {
  for (const off of [{ enabled: false }, { customerDataApproved: false }, { actionsEnabled: false }, { actionKinds: { customerNote: false, projectUpdate: true } }, { actionKinds: {} }]) {
    await on(); const id = await proposeNote('Switch test');
    await on(off);
    await rejects(decide(id), 'failed-precondition', /switched off/); assert.equal(await notesOf(), 'Old note'); assert.equal((await prop(id)).status, 'pending');
    await on(); assert.equal((await decide(id)).status, 'applied'); await db.doc('contacts/' + PH).update({ notes: 'Old note' });
  }
  await on(); const id = await proposeNote('Reject while off'); await on({ enabled: false });
  assert.equal((await decide(id, 'reject')).status, 'rejected');
});

// ======================================================= safety by construction =====================================================
test('READ-ONLY CHAT: the chat code never writes customer data itself; only decide() does, through the existing functions; the audit and proposal records hold no secrets', () => {
  const clean = (f) => fs.readFileSync(path.join(__dirname, '../lib', f), 'utf8').replace(/\/\/.*$/gm, '');
  const aiSrc = clean('ai.js'), actions = clean('aiActions.js'), tools = clean('aiTools.js');
  assert.equal(/PR\.|projects'\)|store\.|updateContact|setStep|contacts\//.test(aiSrc), false, 'ai.js must not touch customer records');
  assert.equal(/\.(set|update|delete|add|create|batch|runTransaction|commit)\s*\(/.test(tools), false, 'the lookup tools still cannot write');
  const touched = new Set([...actions.matchAll(/(?:doc|collection)\(\s*['"`]([A-Za-z]+)/g)].map((m) => m[1]));
  assert.deepEqual([...touched].sort(), ['aiProposals', 'auditLog', 'contacts', 'conversations', 'projects']);
  const proposeSrc = actions.slice(actions.indexOf('async function propose('), actions.indexOf('const messageOf'));
  assert.equal(/tx\.|runTransaction|PR\.(save|setStep)|doc\('(?:contacts|projects|conversations)[^)]*\)\.(?:set|update)/.test(proposeSrc), false, 'proposing never writes customer data');
  assert.equal(/wa\.|sendText|fetch\(|bucket/.test(actions), false, 'nothing is ever sent');
  assert.equal(/\.delete\s*\(/.test(actions), false, 'nothing is ever deleted');
  const idx = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  assert.match(idx, /exports\.aiDecide = onCall\(\{\}, \(req\) => h\.aiDecide\(req\.auth, req\.data, quoteDeps\(\)\)\)/, 'approving needs no model key');
});

test('ERASURE: deleting a customer also deletes their proposals; other customers\' proposals stay', async () => {
  await on(); const mine = await proposeNote('erase me');
  await db.doc('contacts/' + OTHERPH).set({ phone: OTHERPH, name: 'Other' }); await db.doc('conversations/' + OTHERPH).set({ phone: OTHERPH, name: 'Other', createdAt: ts(NOW) });
  await db.doc('aiProposals/ap_' + 'a'.repeat(24)).set({ id: 'ap_' + 'a'.repeat(24), phone: OTHERPH, status: 'pending', kind: 'customerNote' });
  const r = await h.deleteCustomer(staff, { phone: PH, confirm: PH.slice(-4) }, { db, cfg, bucket });
  assert.ok(r); assert.equal((await db.doc('aiProposals/' + mine).get()).exists, false); assert.equal((await db.doc('aiProposals/ap_' + 'a'.repeat(24)).get()).exists, true);
});

test('HONESTY: a kind that is switched off is named to the model; a model that claims something is waiting for approval when no proposal was made is corrected', async () => {
  await on({ actionKinds: { customerNote: true, projectUpdate: false } });
  const m = fake([{ text: 'Prepared for your approval: tick doors ordered. Nothing is saved until you press Approve.' }]);
  const r = await chat(m, { message: 'tick doors ordered' });
  assert.match(m.calls[0].system, /NOT switched on, so you cannot prepare them: Project updates/); assert.deepEqual(m.calls[0].tools.map((t) => t.name).filter((n) => n.startsWith('propose_')), ['propose_customer_note']);
  assert.deepEqual(r.proposals, []); assert.match(r.reply, /I could not prepare that change, so nothing is waiting for your approval/); assert.doesNotMatch(r.reply, /Prepared for your approval/);
  const ok = await chat(fake([note('fine')]), { message: 'note' }, { uid: 'h2' });
  assert.match(ok.reply, /^Prepared for your approval: Add a note to/); assert.equal(ok.proposals.length, 1);
  await on(); const m2 = fake(); await chat(m2, { message: 'hi' }, { uid: 'h3' }); assert.doesNotMatch(m2.calls[0].system, /NOT switched on/);
});

test('TRUTH: the model is told what is really waiting; an earlier claim in the chat is not believed when nothing waits; the same change twice shows the same proposal', async () => {
  await on();
  const claim = [{ role: 'user', text: 'tick doors' }, { role: 'assistant', text: 'Prepared for your approval: tick doors ordered. Nothing is saved until you press Approve.' }];
  const none = fake(); await chat(none, { message: 'tick doors ordered please', history: claim }, { uid: 't1' });
  assert.match(none.calls[0].system, /Nothing is waiting for approval right now/); assert.match(none.calls[0].system, /it is NOT waiting/);
  assert.equal(none.calls[0].messages[1].text, '[An earlier answer said a change was prepared, but nothing is waiting for approval.]', 'the false claim is not passed on as if true');
  assert.equal(none.calls[0].messages[0].text, 'tick doors');
  const id = await proposeNote('Waiting one', 't2');
  const some = fake(); await chat(some, { message: 'hi', history: claim }, { uid: 't2' });
  assert.match(some.calls[0].system, /Waiting for this person's approval right now[^\n]*Add a note to Declan Doyle/); assert.doesNotMatch(some.calls[0].system, /Nothing is waiting/);
  assert.equal(some.calls[0].messages[1].text, claim[1].text, 'a real waiting proposal keeps the conversation as it was');
  const other = fake(); await chat(other, { message: 'hi' }, { uid: 't3' }); assert.match(other.calls[0].system, /Nothing is waiting/, 'someone else\'s proposals are not mine');
  const again = await chat(fake([note('Waiting one')]), { message: 'again' }, { uid: 't2' });
  assert.deepEqual(again.proposals.map((p) => p.id), [id]); assert.match(again.reply, /^Already waiting for your approval/); assert.equal((await db.collection('aiProposals').where('status', '==', 'pending').get()).size, 1);
  const different = await chat(fake([note('A different note')]), { message: 'again' }, { uid: 't2' }); assert.notEqual(different.proposals[0].id, id); assert.match(different.reply, /^Prepared for your approval/);
});

test('TIDY: a waiting proposal past its time is closed as expired the next time the person asks, so it never lingers; a new one can then be made', async () => {
  await on(); const id = await proposeNote('Old one', 'e1');
  await db.doc('aiProposals/' + id).update({ expiresAt: ts(NOW - 1000) });
  const m = fake(); await chat(m, { message: 'hi' }, { uid: 'e1' });
  assert.match(m.calls[0].system, /Nothing is waiting/); assert.equal((await prop(id)).status, 'expired');
  const fresh = await chat(fake([note('Old one')]), { message: 'again' }, { uid: 'e1' }); assert.notEqual(fresh.proposals[0].id, id); assert.equal((await prop(fresh.proposals[0].id)).status, 'pending');
});
