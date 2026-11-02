// The ⭐ "wants it as soon as possible" (functions/lib/asap.js, docs/ASAP_STAR.md): read ONLY from the lead's Notes (the lead form's fixed answer "1-2 months asap"), never from the chat and never from free text
// a person typed. It is set when a lead arrives (leadIntake) and kept in step when the Notes are edited (updateContact). Real Firestore emulator; the Meta Graph API is a fake. Every name and number is made up.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { createClient } = require('../lib/whatsapp');
const { handleLeadRequest } = require('../lib/leads');
const Asap = require('../lib/asap');
const store = require('../lib/store');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT, storageBucket: 'demo-leados.firebasestorage.app' });
const db = getFirestore();
const KEY = 'test-key-1234567890-abcdefghij', cfg = { phoneId: '111', token: 'tok', template: 'elite_kitchens_new_lead', lang: 'en', version: 'v21.0', apiKeys: KEY };
const wa = () => createClient(cfg, async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.W1' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
const lead = (phone, id, answer, name = 'Aoife Byrne') => ({ leadId: id, formName: 'November 2026 form', field_data: [{ name: 'full_name', values: [name] }, { name: 'phone_number', values: [phone] }, { name: 'when_do_you_want_to_start?', values: [answer] }] });
const send = (body) => handleLeadRequest({ method: 'POST', headers: { authorization: `Bearer ${KEY}` }, rawBody: Buffer.from(JSON.stringify(body)), body }, { db, wa: wa(), cfg });
const conv = async (phone) => (await db.doc('conversations/' + phone).get()).data();
beforeEach(async () => { await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' }); });

const BLOCK = (answer) => `Meta lead · November 2026 form · 1 Nov 2026\nLead ID: 123456\nOther answers:\n• When do you want to start?: ${answer}`;

test('WHAT COUNTS: the lead form\'s answer saying asap, however Meta spells it; a different answer does not', () => {
  for (const a of ['1-2 months asap', '1-2_months_asap', '1-2 months (ASAP)', 'As soon as possible', 'ASAP']) assert.equal(Asap.fromNotes(BLOCK(a)), true, a);
  for (const a of ['3-6 months', '6+ months', 'Within 3 months', 'just looking']) assert.equal(Asap.fromNotes(BLOCK(a)), false, a);
});

test('NEVER FROM ANYTHING ELSE: not from a person\'s own typing in the Notes, not from the free-text "Requirements" line, not from a bullet outside a lead block, not from empty notes', () => {
  assert.equal(Asap.fromNotes('Customer wants it asap, ring him tomorrow'), false, 'a person typed it');
  assert.equal(Asap.fromNotes('• Timeline: asap\n• Budget: 15k'), false, 'a bulleted list a person typed, with no lead block');
  assert.equal(Asap.fromNotes('Meta lead · Form · 1 Nov 2026\nLead ID: 1\nRequirements: I need it asap please, new kitchen'), false, 'the customer\'s free text is not the fixed answer');
  for (const empty of ['', '   ', null, undefined]) assert.equal(Asap.fromNotes(empty), false);
  assert.equal(Asap.fromNotes('Thomas: will visit Friday\n\n' + BLOCK('1-2 months asap')), true, 'a lead block after a person\'s own notes still counts');
  assert.equal(Asap.fromNotes(BLOCK('3-6 months') + '\n\n' + BLOCK('1-2_months_asap')), true, 'a second form submission counts');
});

test('LEAD INTAKE: a new lead who picked "1-2 months asap" gets the star on its conversation; one who picked another answer does not; the same lead sent twice keeps it', async () => {
  assert.equal((await send(lead('p:+353871119101', 'LEADASAP001', '1-2_months_asap'))).status, 200);
  assert.equal((await send(lead('p:+353871119102', 'LEADLATER01', '3-6_months', 'Brian Casey'))).status, 200);
  assert.equal((await conv('353871119101')).asap, true); assert.ok(!(await conv('353871119102')).asap);
  assert.match((await db.doc('contacts/353871119101').get()).data().notes, /1-2_months_asap/, 'the answer is in the Notes: that is where the star comes from');
  assert.equal((await send(lead('p:+353871119101', 'LEADASAP001', '1-2_months_asap'))).status, 200); assert.equal((await conv('353871119101')).asap, true, 'a retry changes nothing');
});

test('AN EXISTING CUSTOMER WHO FILLS THE FORM AGAIN with the asap answer gets the star; nothing else of the chat changes', async () => {
  assert.equal((await send(lead('p:+353871119103', 'LEADOLD0001', '6+_months'))).status, 200);
  await db.doc('conversations/353871119103').update({ inboxStatus: 'quoted', unreadCount: 3 });
  assert.ok(!(await conv('353871119103')).asap);
  assert.equal((await send(lead('p:+353871119103', 'LEADOLD0002', '1-2_months_asap'))).status, 200);
  const c = await conv('353871119103'); assert.equal(c.asap, true); assert.equal(c.inboxStatus, 'quoted'); assert.equal(c.unreadCount, 3);
});

test('EDITING THE NOTES keeps the star in step: removing the answer takes it away, adding a lead block with it gives it; other edits leave it alone', async () => {
  assert.equal((await send(lead('p:+353871119104', 'LEADEDIT001', '1-2_months_asap'))).status, 200); assert.equal((await conv('353871119104')).asap, true);
  assert.equal(await store.updateContact(db, '353871119104', { name: 'Aoife B' }), true); assert.equal((await conv('353871119104')).asap, true, 'a name change does not touch it');
  assert.equal(await store.updateContact(db, '353871119104', { notes: 'Thomas: will ring Monday' }), true); assert.equal((await conv('353871119104')).asap, false, 'the answer is no longer in the Notes');
  assert.equal(await store.updateContact(db, '353871119104', { notes: BLOCK('1-2 months asap') }), true); assert.equal((await conv('353871119104')).asap, true);
  assert.equal(await store.updateContact(db, '353871119104', { notes: null }), true); assert.equal((await conv('353871119104')).asap, false);
});

test('A CHAT MESSAGE NEVER SETS IT: a customer who writes "I need it asap" has no star unless the lead form said so', async () => {
  assert.equal((await send(lead('p:+353871119105', 'LEADCHAT001', '3-6_months'))).status, 200);
  await store.storeInbound(db, { wamid: 'wamid.IN1', from: '353871119105', type: 'text', body: 'I need the kitchen asap please, as soon as possible', name: 'Brian Casey', createdAt: new Date() });
  assert.ok(!(await conv('353871119105')).asap);
});
