// "Best time to contact" (functions/lib/contactTime.js): read ONLY from the lead's Notes (the lead form's answer to "When is the best time to contact you?"), never from the chat and never from free text a person
// typed. It is set when a lead arrives (leadIntake), kept in step when the Notes are edited (updateContact), and shown on the Pipeline's New lead card. Real Firestore emulator; WhatsApp is a fake. Every name and number is made up.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { createClient } = require('../lib/whatsapp');
const { handleLeadRequest } = require('../lib/leads');
const CT = require('../lib/contactTime');
const store = require('../lib/store');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT, storageBucket: 'demo-leados.firebasestorage.app' });
const db = getFirestore();
const KEY = 'test-key-1234567890-abcdefghij', cfg = { phoneId: '111', token: 'tok', template: 'elite_kitchens_new_lead', lang: 'en', version: 'v21.0', apiKeys: KEY };
const wa = () => createClient(cfg, async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.W1' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
const lead = (phone, id, time, name = 'Aoife Byrne') => ({ leadId: id, formName: 'November 2026 form', field_data: [{ name: 'full_name', values: [name] }, { name: 'phone_number', values: [phone] }, ...(time ? [{ name: 'Best time to contact', values: [time] }] : []), { name: 'Start timing', values: ['3-6_months'] }] });
const send = (body) => handleLeadRequest({ method: 'POST', headers: { authorization: `Bearer ${KEY}` }, rawBody: Buffer.from(JSON.stringify(body)), body }, { db, wa: wa(), cfg });
const conv = async (phone) => (await db.doc('conversations/' + phone).get()).data();
beforeEach(async () => { await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' }); });

const BLOCK = (label, answer, date = '1 Nov 2026') => `Meta lead · November 2026 form · ${date}\nLead ID: 123456\nOther answers:\n• ${label}: ${answer}`;

test('WHAT COUNTS: the lead form\'s answer to the best-time question, tidied; another question does not; what a person typed does not', () => {
  assert.equal(CT.fromNotes(BLOCK('Best time to contact', 'morning_(9am-12pm)')), 'Morning (9am-12pm)');
  assert.equal(CT.fromNotes(BLOCK('Best time to contact', 'afternoon')), 'Afternoon');
  assert.equal(CT.fromNotes(BLOCK('Best time to contact', 'evening_after_5pm')), 'Evening after 5pm');
  assert.equal(CT.fromNotes(BLOCK('When is the best time to contact you?', 'Any time')), 'Any time', 'the question as Meta words it');
  assert.equal(CT.fromNotes(BLOCK('Preferred contact time', 'weekends')), 'Weekends');
  assert.equal(CT.fromNotes(BLOCK('Start timing', '1-2_months_asap')), null, 'a different question');
  assert.equal(CT.fromNotes(BLOCK('Budget', '€15k-€20k')), null);
  assert.equal(CT.fromNotes('Best time to contact: evenings, ring after 6'), null, 'a person typed it');
  assert.equal(CT.fromNotes('• Best time to contact: evenings'), null, 'a bulleted list with no lead block');
  assert.equal(CT.fromNotes('Meta lead · Form · 1 Nov 2026\nLead ID: 1\nRequirements: please ring me in the evening, best time is after six'), null, 'the customer\'s free text is not the answer');
  assert.equal(CT.fromNotes(''), null); assert.equal(CT.fromNotes(null), null); assert.equal(CT.fromNotes(undefined), null);
  assert.equal(CT.fromNotes('Thomas: will visit Friday\n\n' + BLOCK('Best time to contact', 'evening')), 'Evening', 'a lead block after a person\'s own notes still counts');
  assert.equal(CT.fromNotes(BLOCK('Best time to contact', 'morning') + '\n\n' + BLOCK('Best time to contact', 'evening', '5 Nov 2026')), 'Evening', 'a second form submission: the newest answer');
  assert.equal(CT.fromNotes(BLOCK('Best time to contact', '   ')), null, 'an empty answer');
  assert.equal(CT.fromNotes(BLOCK('Best time to contact', 'x'.repeat(200))).length, CT.MAX, 'never longer than it can show');
});

test('LEAD INTAKE: a new lead who picked a time gets it on its conversation; one who did not has none; the same lead sent twice keeps it', async () => {
  assert.equal((await send(lead('p:+353871119201', 'LEADTIME001', 'morning_(9am-12pm)'))).status, 200);
  assert.equal((await send(lead('p:+353871119202', 'LEADNOTIME1', null, 'Brian Casey'))).status, 200);
  assert.equal((await conv('353871119201')).contactTime, 'Morning (9am-12pm)'); assert.ok(!(await conv('353871119202')).contactTime);
  assert.match((await db.doc('contacts/353871119201').get()).data().notes, /Best time to contact: morning_\(9am-12pm\)/, 'the answer is in the Notes: that is where it comes from');
  assert.equal((await send(lead('p:+353871119201', 'LEADTIME001', 'morning_(9am-12pm)'))).status, 200); assert.equal((await conv('353871119201')).contactTime, 'Morning (9am-12pm)', 'a retry changes nothing');
});

test('AN EXISTING CUSTOMER WHO FILLS THE FORM AGAIN gets the newest time; nothing else of the chat changes', async () => {
  assert.equal((await send(lead('p:+353871119203', 'LEADOLD0001', 'morning'))).status, 200);
  await db.doc('conversations/353871119203').update({ inboxStatus: 'quoted', unreadCount: 3 });
  assert.equal((await send(lead('p:+353871119203', 'LEADOLD0002', 'evening'))).status, 200);
  const c = await conv('353871119203'); assert.equal(c.contactTime, 'Evening'); assert.equal(c.inboxStatus, 'quoted'); assert.equal(c.unreadCount, 3);
});

test('EDITING THE NOTES keeps it in step: removing the answer takes it away, a new lead block gives it back; other edits leave it alone', async () => {
  assert.equal((await send(lead('p:+353871119204', 'LEADEDIT001', 'afternoon'))).status, 200); assert.equal((await conv('353871119204')).contactTime, 'Afternoon');
  assert.equal(await store.updateContact(db, '353871119204', { name: 'Aoife B' }), true); assert.equal((await conv('353871119204')).contactTime, 'Afternoon', 'a name change does not touch it');
  assert.equal(await store.updateContact(db, '353871119204', { notes: 'Thomas: will ring Monday' }), true); assert.equal((await conv('353871119204')).contactTime, null, 'the answer is no longer in the Notes');
  assert.equal(await store.updateContact(db, '353871119204', { notes: BLOCK('Best time to contact', 'weekends') }), true); assert.equal((await conv('353871119204')).contactTime, 'Weekends');
  assert.equal(await store.updateContact(db, '353871119204', { notes: null }), true); assert.equal((await conv('353871119204')).contactTime, null);
});

test('A CHAT MESSAGE NEVER SETS IT: a customer who writes "ring me after 6" has no best time unless the lead form said so', async () => {
  assert.equal((await send(lead('p:+353871119205', 'LEADCHAT001', null))).status, 200);
  await store.storeInbound(db, { wamid: 'wamid.IN1', from: '353871119205', type: 'text', body: 'Best time to contact me is after 6pm please', name: 'Brian Casey', createdAt: new Date() });
  assert.ok(!(await conv('353871119205')).contactTime);
});
