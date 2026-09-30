// Integration tests against the real Firestore emulator (started by `npm test` at the repo root).
// The Meta Graph API is mocked; everything else (transactions, rules, handlers) is real.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const admin = require('firebase-admin');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const h = require('../lib/handlers');
const { createClient } = require('../lib/whatsapp');

const PROJECT = 'demo-leados';
admin.initializeApp({ projectId: PROJECT, storageBucket: 'demo-leados.firebasestorage.app' });
const db = admin.firestore();

const cfg = { mediaTimeoutMs: 5000, phoneId: '111', token: 'tok', appSecret: 'secret', verifyToken: 'vt', template: 'elite_kitchens_new_lead',
  lang: 'en', version: 'v21.0', allowedEmails: 'Thomas@example.com, other@example.com' };
const BUCKET = 'demo-leados.firebasestorage.app';
const bucket = admin.storage().bucket(BUCKET);
const MB = 1024 * 1024;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const graphCalls = []; let graphFail = false; let onGraph = null;
const mediaLookups = [], mediaDownloads = [], uploads = [];
let mediaFail = false;
const files = {};   // media id -> { mime, bytes, file_size? }
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const mockFetch = async (url, opts = {}) => {
  url = String(url);
  if (url.startsWith('https://lookaside.test/')) {                       // the media bytes
    const id = url.split('/').pop(); mediaDownloads.push(id);
    return files[id] && !mediaFail ? new Response(files[id].bytes, { status: 200 }) : new Response('gone', { status: 404 });
  }
  if (opts.method === 'POST' && /\/media$/.test(url)) {                  // upload of a file we are sending
    const f = opts.body.get('file');
    uploads.push({ name: f.name, type: f.type, size: f.size, auth: opts.headers.Authorization, mp: opts.body.get('messaging_product') });
    return reply({ id: 'UPMEDIA' + uploads.length });
  }
  if (opts.method === 'POST') {                                          // a message
    graphCalls.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization });
    if (onGraph) await onGraph();
    if (graphFail) return reply({ error: { code: 131047, message: 'Re-engagement message' } }, 400);
    return reply({ messages: [{ id: 'wamid.OUT' + graphCalls.length }] });
  }
  const id = decodeURIComponent(url.split('/').pop());                    // media id lookup
  mediaLookups.push(id);
  if (mediaFail || !files[id]) return reply({ error: { code: 100, message: 'Media not found' } }, 404);
  return reply({ url: 'https://lookaside.test/' + id, mime_type: files[id].mime, sha256: 'x', file_size: files[id].file_size || files[id].bytes.length });
};
const deps = () => ({ db, cfg, bucket, wa: createClient(cfg, mockFetch) });

const staff = { uid: 'u1', token: { email: 'thomas@example.com', email_verified: true, staff: true } };
const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', 'secret').update(raw).digest('hex');
const post = (payload, signature) => { const raw = Buffer.from(JSON.stringify(payload));
  return h.webhookReceive({ rawBody: raw, body: payload, signature: signature || sign(raw) }, deps()); };
const inbound = (wamid, text, from = '353851234567', pid = '111') => ({ entry: [{ changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: pid }, contacts: [{ wa_id: from, profile: { name: 'Tom' } }],
  messages: [{ id: wamid, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
const statusHook = (wamid, status, to = '353851234567') => ({ entry: [{ changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: '111' }, statuses: [{ id: wamid, status, recipient_id: to }] } }] }] });
const msgs = async (phone) => (await db.collection('conversations').doc(phone).collection('messages').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const rejects = async (p, code) => assert.rejects(p, (e) => e.code === code, `expected ${code}`);

async function wipe() {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await bucket.deleteFiles({ force: true }).catch(() => {});
  graphCalls.length = 0; graphFail = false; onGraph = null; mediaFail = false;
  mediaLookups.length = 0; mediaDownloads.length = 0; uploads.length = 0;
  for (const k of Object.keys(files)) delete files[k];
}
beforeEach(wipe);
after(async () => { await wipe(); });

test('webhook verification handshake', () => {
  assert.deepEqual(h.webhookVerify({ 'hub.mode': 'subscribe', 'hub.verify_token': 'vt', 'hub.challenge': '123' }, cfg), { status: 200, body: '123' });
  assert.equal(h.webhookVerify({ 'hub.mode': 'subscribe', 'hub.verify_token': 'bad', 'hub.challenge': '1' }, cfg).status, 403);
  assert.equal(h.webhookVerify({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' }, { ...cfg, verifyToken: '' }).status, 403);
});

test('bad or missing signature is rejected and nothing is stored', async () => {
  assert.equal(await post(inbound('wamid.BAD', 'x'), 'sha256=deadbeef'), 401);
  assert.equal(await h.webhookReceive({ rawBody: Buffer.from('{}'), body: {}, signature: undefined }, deps()), 401);
  assert.equal(await h.webhookReceive({ rawBody: Buffer.from('{}'), body: {}, signature: 'x' }, { db, cfg: { ...cfg, appSecret: '' } }), 401);
  assert.equal((await db.collection('conversations').get()).size, 0);
});

test('inbound text is stored once even if Meta retries (dedup)', async () => {
  for (let i = 0; i < 3; i++) assert.equal(await post(inbound('wamid.IN1', 'Hello, I am interested in a kitchen.')), 200);
  const m = await msgs('353851234567');
  assert.equal(m.length, 1); assert.equal(m[0].direction, 'in'); assert.equal(m[0].id, 'wamid.IN1');
  const c = (await db.collection('conversations').doc('353851234567').get()).data();
  assert.equal(c.name, 'Tom'); assert.equal(c.lastMessage, 'Hello, I am interested in a kitchen.'); assert.ok(c.lastInboundAt);
  assert.equal((await db.collection('contacts').doc('353851234567').get()).data().phone, '353851234567');
});

test('concurrent duplicate deliveries still produce exactly one message', async () => {
  await Promise.all([1, 2, 3, 4, 5].map(() => post(inbound('wamid.RACE', 'hi'))));
  assert.equal((await msgs('353851234567')).length, 1);
});

test('events for a different phone number id are ignored', async () => {
  assert.equal(await post(inbound('wamid.OTHER', 'nope', '353851234567', '999')), 200);
  assert.equal((await db.collection('conversations').get()).size, 0);
});

test('reply within 24h goes to Meta as text and is stored', async () => {
  await post(inbound('wamid.IN1', 'Hello'));
  await h.sendReply(staff, { phone: '353851234567', body: 'Thanks Tom!' }, deps());
  const call = graphCalls.at(-1);
  assert.match(call.url, /\/111\/messages$/); assert.equal(call.auth, 'Bearer tok');
  assert.equal(call.body.to, '353851234567'); assert.equal(call.body.type, 'text'); assert.equal(call.body.text.body, 'Thanks Tom!');
  const out = (await msgs('353851234567')).filter((m) => m.direction === 'out');
  assert.equal(out.length, 1); assert.equal(out[0].status, 'sent'); assert.equal(out[0].id, 'wamid.OUT1');
});

test('free text is refused outside the 24h window (no Meta call)', async () => {
  await h.startConversation(staff, { phone: '+353 87 111 2222', name: 'Aoife' }, deps());
  const before = graphCalls.length;
  await rejects(h.sendReply(staff, { phone: '353871112222', body: 'hi' }, deps()), 'failed-precondition');
  assert.equal(graphCalls.length, before);
  // and an inbound message older than 24h does not count
  await db.collection('conversations').doc('353871112222').set({ lastInboundAt: admin.firestore.Timestamp.fromMillis(Date.now() - 25 * 3600e3) }, { merge: true });
  await rejects(h.sendReply(staff, { phone: '353871112222', body: 'hi' }, deps()), 'failed-precondition');
});

test('start conversation sends the approved template with the first name', async () => {
  await h.startConversation(staff, { phone: '+353 87 111 2222', name: 'Aoife' }, deps());
  const b = graphCalls.at(-1).body;
  assert.equal(b.to, '353871112222'); assert.equal(b.type, 'template');
  assert.equal(b.template.name, 'elite_kitchens_new_lead'); assert.equal(b.template.language.code, 'en');
  assert.equal(b.template.components[0].parameters[0].text, 'Aoife');
  assert.equal((await msgs('353871112222'))[0].type, 'template');
});

test('status webhooks update the message and never move backwards', async () => {
  await post(inbound('wamid.IN1', 'Hello')); await h.sendReply(staff, { phone: '353851234567', body: 'r' }, deps());
  for (const s of ['delivered', 'read', 'delivered']) await post(statusHook('wamid.OUT1', s));
  assert.equal((await msgs('353851234567')).find((m) => m.id === 'wamid.OUT1').status, 'read');
});

test('a status that arrives BEFORE our own write is not lost or downgraded', async () => {
  await post(inbound('wamid.IN1', 'Hello'));
  onGraph = async () => { await post(statusHook('wamid.OUT1', 'delivered')); };   // Meta is faster than us
  await h.sendReply(staff, { phone: '353851234567', body: 'race' }, deps());
  const m = (await msgs('353851234567')).find((x) => x.id === 'wamid.OUT1');
  assert.equal(m.status, 'delivered'); assert.equal(m.body, 'race'); assert.ok(m.createdAt);
});

test('Meta send failure is surfaced and recorded, not swallowed', async () => {
  await post(inbound('wamid.IN1', 'Hello')); graphFail = true;
  await rejects(h.sendReply(staff, { phone: '353851234567', body: 'will fail' }, deps()), 'unavailable');
  const failed = (await msgs('353851234567')).find((m) => m.status === 'failed');
  assert.match(failed.error, /131047/); assert.match(failed.error, /Re-engagement/); assert.equal(failed.body, 'will fail');
});

test('non-text inbound (image) is stored with a placeholder and media metadata', async () => {
  const p = inbound('wamid.IMG', ''); const m = p.entry[0].changes[0].value.messages[0];
  m.type = 'image'; delete m.text; m.image = { id: 'MEDIA1', mime_type: 'image/jpeg' };
  await post(p);
  const [row] = await msgs('353851234567');
  assert.equal(row.type, 'image'); assert.equal(row.body, '[image]'); assert.equal(row.media.waMediaId, 'MEDIA1'); assert.equal(row.media.mimeType, 'image/jpeg');
});

test('only allowlisted, verified staff can act; claimAccess grants the claim', async () => {
  const claims = []; const adminAuth = { setCustomUserClaims: async (uid, c) => claims.push([uid, c]) };
  const asUser = (email, extra = {}) => ({ uid: 'x', token: { email, email_verified: true, ...extra } });
  await rejects(h.claimAccess(null, { adminAuth, cfg }), 'unauthenticated');
  await rejects(h.claimAccess(asUser('stranger@gmail.com'), { adminAuth, cfg }), 'permission-denied');
  await rejects(h.claimAccess({ uid: 'x', token: { email: 'thomas@example.com', email_verified: false } }, { adminAuth, cfg }), 'permission-denied');
  await h.claimAccess(asUser('THOMAS@example.com'), { adminAuth, cfg });      // case-insensitive
  assert.deepEqual(claims, [['x', { staff: true }]]);
  // actions need the claim AND the allowlist (removing someone from the list revokes them)
  await rejects(h.sendReply(null, { phone: '1', body: 'x' }, deps()), 'unauthenticated');
  await rejects(h.sendReply(asUser('thomas@example.com'), { phone: '353851234567', body: 'x' }, deps()), 'permission-denied');   // no claim
  await rejects(h.sendReply(asUser('stranger@gmail.com', { staff: true }), { phone: '353851234567', body: 'x' }, deps()), 'permission-denied');
  await rejects(h.startConversation(asUser('stranger@gmail.com', { staff: true }), { phone: '353871112222', name: 'A' }, deps()), 'permission-denied');
  assert.equal(graphCalls.length, 0);
});

test('input validation', async () => {
  await rejects(h.startConversation(staff, { phone: '123', name: 'A' }, deps()), 'invalid-argument');
  await rejects(h.startConversation(staff, { phone: '+353871112222', name: ' ' }, deps()), 'invalid-argument');
  await rejects(h.sendReply(staff, { phone: '353851234567', body: '  ' }, deps()), 'invalid-argument');
  await rejects(h.sendReply(staff, { phone: '353800000000', body: 'x' }, deps()), 'not-found');
});

test('two customers get two separate conversations; replies go to the right number', async () => {
  await post(inbound('wamid.A1', 'Hi from A', '353851111111'));
  await post(inbound('wamid.B1', 'Hi from B', '353862222222'));
  await post(inbound('wamid.A2', 'A again', '353851111111'));
  assert.equal((await db.collection('conversations').get()).size, 2);
  assert.deepEqual((await msgs('353851111111')).map((m) => m.body).sort(), ['A again', 'Hi from A']);
  assert.deepEqual((await msgs('353862222222')).map((m) => m.body), ['Hi from B']);
  await h.sendReply(staff, { phone: '353851111111', body: 'reply to A' }, deps());
  await h.sendReply(staff, { phone: '353862222222', body: 'reply to B' }, deps());
  assert.deepEqual(graphCalls.map((c) => [c.body.to, c.body.text.body]), [['353851111111', 'reply to A'], ['353862222222', 'reply to B']]);
  assert.equal((await msgs('353851111111')).filter((m) => m.direction === 'out').length, 1);
  assert.equal((await msgs('353862222222')).filter((m) => m.direction === 'out').length, 1);
});

test('markRead sets lastReadAt without reordering the inbox, and is staff-only', async () => {
  await post(inbound('wamid.M1', 'hello', '353851111111'));
  const ref = db.collection('conversations').doc('353851111111');
  const before = (await ref.get()).data();
  assert.equal(before.lastReadAt, undefined);
  await h.markRead(staff, { phone: '+353 85 111 1111' }, deps());
  const after = (await ref.get()).data();
  assert.ok(after.lastReadAt);
  assert.equal(after.updatedAt.toMillis(), before.updatedAt.toMillis());     // inbox order untouched
  await post(inbound('wamid.M2', 'again', '353851111111'));                   // new inbound is newer than lastReadAt
  const c = (await ref.get()).data();
  assert.ok(c.lastInboundAt.toMillis() >= c.lastReadAt.toMillis() - 5000);
  await rejects(h.markRead(null, { phone: '353851111111' }, deps()), 'unauthenticated');
  await rejects(h.markRead({ uid: 'x', token: { email: 'stranger@gmail.com', email_verified: true, staff: true } }, { phone: '353851111111' }, deps()), 'permission-denied');
  await rejects(h.markRead(staff, { phone: '353800000000' }, deps()), 'not-found');
  await rejects(h.markRead(staff, {}, deps()), 'invalid-argument');
});

test('updateContact saves the customer record, denormalises onto the conversation, validates input', async () => {
  await post(inbound('wamid.C1', 'Hello', '353851111111'));
  const conv = db.collection('conversations').doc('353851111111');
  const beforeUpdated = (await conv.get()).data().updatedAt.toMillis();
  await h.updateContact(staff, { phone: '+353 85 111 1111', fields: { name: ' Anna Murphy ', email: 'anna@example.com', location: 'Swords',
    projectType: 'Kitchen', budget: '€15–20k', source: 'Meta Ads', notes: 'Wants island\nand pantry' } }, deps());
  const c = (await db.collection('contacts').doc('353851111111').get()).data();
  assert.deepEqual([c.name, c.email, c.location, c.projectType, c.budget, c.source, c.notes],
    ['Anna Murphy', 'anna@example.com', 'Swords', 'Kitchen', '€15–20k', 'Meta Ads', 'Wants island\nand pantry']);
  assert.ok(c.updatedAt); assert.ok(c.createdAt); assert.equal(c.phone, '353851111111');
  const cv = (await conv.get()).data();
  assert.deepEqual([cv.name, cv.location, cv.projectType], ['Anna Murphy', 'Swords', 'Kitchen']);
  assert.equal(cv.updatedAt.toMillis(), beforeUpdated);                       // inbox order untouched
  await post(inbound('wamid.C2', 'again', '353851111111'));                    // WhatsApp profile name must not overwrite the staff-edited name
  assert.equal((await conv.get()).data().name, 'Anna Murphy');
  await h.updateContact(staff, { phone: '353851111111', fields: { location: '  ' } }, deps());   // clearing a field
  assert.equal((await db.collection('contacts').doc('353851111111').get()).data().location, null);
  assert.equal((await conv.get()).data().name, 'Anna Murphy');                 // untouched fields survive
  await rejects(h.updateContact(staff, { phone: '353851111111', fields: { email: 'nope' } }, deps()), 'invalid-argument');
  await rejects(h.updateContact(staff, { phone: '353851111111', fields: { notes: 'x'.repeat(5001) } }, deps()), 'invalid-argument');
  await rejects(h.updateContact(staff, { phone: '353851111111', fields: { admin: 'yes' } }, deps()), 'invalid-argument');
  await rejects(h.updateContact(staff, { phone: '353851111111', fields: { name: 42 } }, deps()), 'invalid-argument');
  await rejects(h.updateContact(staff, { phone: '353851111111', fields: {} }, deps()), 'invalid-argument');
  await rejects(h.updateContact(staff, { phone: '353800000000', fields: { name: 'x' } }, deps()), 'not-found');
  await rejects(h.updateContact(null, { phone: '353851111111', fields: { name: 'x' } }, deps()), 'unauthenticated');
  await rejects(h.updateContact({ uid: 'x', token: { email: 'stranger@gmail.com', email_verified: true, staff: true } }, { phone: '353851111111', fields: { name: 'x' } }, deps()), 'permission-denied');
});

test('email is optional: blank saves fine, junk is rejected, a real address is accepted', async () => {
  await post(inbound('wamid.E1', 'Hello', '353851111111'));
  const ref = db.collection('contacts').doc('353851111111');
  await h.updateContact(staff, { phone: '353851111111', fields: { name: 'Magdalena', email: '', location: 'Balbriggan', projectType: 'Kitchen', budget: '15', source: 'WhatsApp', notes: '' } }, deps());
  let c = (await ref.get()).data();
  assert.equal(c.email, null); assert.equal(c.location, 'Balbriggan'); assert.equal(c.budget, '15');      // saved without an email
  await rejects(h.updateContact(staff, { phone: '353851111111', fields: { email: 'lol' } }, deps()), 'invalid-argument');
  await h.updateContact(staff, { phone: '353851111111', fields: { email: 'mag@example.ie' } }, deps());
  assert.equal((await ref.get()).data().email, 'mag@example.ie');
  await h.updateContact(staff, { phone: '353851111111', fields: { email: '' } }, deps());               // and it can be cleared again
  assert.equal((await ref.get()).data().email, null);
});

test('claimAccess revokes a leftover staff claim from someone removed from the allowlist', async () => {
  const claims = []; const adminAuth = { setCustomUserClaims: async (uid, c) => claims.push([uid, c]) };
  await rejects(h.claimAccess({ uid: 'gone', token: { email: 'former@staff.com', email_verified: true, staff: true } }, { adminAuth, cfg }), 'permission-denied');
  assert.deepEqual(claims, [['gone', { staff: false }]]);
});

// ---------------- media ----------------
const mediaHook = (wamid, type, obj, from = '353851111111') => post({ entry: [{ changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: '111' }, contacts: [{ wa_id: from, profile: { name: 'Anna' } }],
  messages: [{ id: wamid, from, timestamp: String(Math.floor(Date.now() / 1000)), type, [type]: obj }] } }] }] });
const msgDoc = async (phone, id) => (await db.collection('conversations').doc(phone).collection('messages').doc(id).get()).data();
const conv = async (phone) => (await db.collection('conversations').doc(phone).get()).data();

test('inbound image is downloaded with the official API into private storage and recorded', async () => {
  files.IMG1 = { mime: 'image/png', bytes: PNG };
  assert.equal(await mediaHook('wamid.I1', 'image', { id: 'IMG1', mime_type: 'image/png', sha256: 'x', caption: 'my kitchen now' }), 200);
  const m = await msgDoc('353851111111', 'wamid.I1');
  assert.equal(m.type, 'image'); assert.equal(m.body, 'my kitchen now');
  assert.equal(m.media.status, 'stored'); assert.equal(m.media.mimeType, 'image/png'); assert.equal(m.media.size, PNG.length);
  assert.ok(m.media.storagePath.startsWith('media/353851111111/wamid.I1/')); assert.match(m.media.filename, /^file-[A-Za-z0-9]+\.png$/);   // no name from WhatsApp: a safe generated one
  assert.ok(m.media.sha256 && m.media.sha256.length === 64);
  const [bytes] = await bucket.file(m.media.storagePath).download();
  assert.ok(bytes.equals(PNG));
  assert.deepEqual(mediaLookups, ['IMG1']); assert.deepEqual(mediaDownloads, ['IMG1']);
  const c = await conv('353851111111');
  assert.equal(c.lastMessage, 'my kitchen now'); assert.equal(c.lastMessageType, 'image'); assert.equal(c.lastMessageDirection, 'in');
});

test('a duplicate delivery of a media message does not duplicate the message, the file, or the unread count', async () => {
  files.IMG1 = { mime: 'image/png', bytes: PNG };
  for (let i = 0; i < 3; i++) assert.equal(await mediaHook('wamid.I1', 'image', { id: 'IMG1', mime_type: 'image/png' }), 200);
  assert.equal((await msgs('353851111111')).length, 1);
  assert.equal(mediaDownloads.length, 1);                    // already stored: retries do not download again
  assert.equal((await conv('353851111111')).unreadCount, 1);
  const [list] = await bucket.getFiles({ prefix: 'media/353851111111/' }); assert.equal(list.length, 1);
});

test('document, voice note, video and sticker are all stored; odd names are made safe', async () => {
  files.DOC1 = { mime: 'application/pdf', bytes: PDF };
  files.AUD1 = { mime: 'audio/ogg; codecs=opus', bytes: Buffer.from('OggS-fake-opus') };
  files.VID1 = { mime: 'video/mp4', bytes: Buffer.from('fake-mp4-bytes') };
  files.STK1 = { mime: 'image/webp', bytes: Buffer.from('RIFFxxxxWEBP') };
  await mediaHook('wamid.D1', 'document', { id: 'DOC1', mime_type: 'application/pdf', filename: '../../etc/Plan & measurements (v2).pdf', caption: 'Floor plan' });
  await mediaHook('wamid.A1', 'audio', { id: 'AUD1', mime_type: 'audio/ogg; codecs=opus', voice: true });
  await mediaHook('wamid.V1', 'video', { id: 'VID1', mime_type: 'video/mp4' });
  await mediaHook('wamid.S1', 'sticker', { id: 'STK1', mime_type: 'image/webp' });
  const d = await msgDoc('353851111111', 'wamid.D1');
  assert.equal(d.media.status, 'stored'); assert.equal(d.media.filename, 'Plan & measurements (v2).pdf');        // staff see the customer's own name
  assert.ok(d.media.storagePath.endsWith('/Plan _ measurements (v2).pdf'));                                      // storage uses a safe one
  assert.ok(!d.media.storagePath.includes('..')); assert.ok(d.media.storagePath.startsWith('media/353851111111/wamid.D1/'));
  assert.equal(d.body, 'Floor plan');
  const a = await msgDoc('353851111111', 'wamid.A1');
  assert.equal(a.media.voice, true); assert.equal(a.media.mimeType, 'audio/ogg'); assert.match(a.media.filename, /\.ogg$/);
  for (const id of ['wamid.V1', 'wamid.S1']) assert.equal((await msgDoc('353851111111', id)).media.status, 'stored');
  assert.equal((await conv('353851111111')).unreadCount, 4);
});

test('a failed download never fails the webhook; staff can retry, and a Meta re-delivery retries too', async () => {
  files.IMG2 = { mime: 'image/png', bytes: PNG }; mediaFail = true;
  assert.equal(await mediaHook('wamid.I2', 'image', { id: 'IMG2', mime_type: 'image/png' }), 200);   // still 200
  let m = await msgDoc('353851111111', 'wamid.I2');
  assert.equal(m.media.status, 'failed'); assert.match(m.media.error, /Media lookup.*404|not found/i);
  assert.equal((await msgs('353851111111')).length, 1);                                               // the message itself is kept
  mediaFail = false;
  assert.equal(await mediaHook('wamid.I2', 'image', { id: 'IMG2', mime_type: 'image/png' }), 200);   // Meta retries the webhook
  m = await msgDoc('353851111111', 'wamid.I2'); assert.equal(m.media.status, 'stored');
  assert.equal((await conv('353851111111')).unreadCount, 1);                                          // ...without a second unread
  // explicit staff retry on a failed one
  files.IMG3 = { mime: 'image/png', bytes: PNG }; mediaFail = true;
  await mediaHook('wamid.I3', 'image', { id: 'IMG3', mime_type: 'image/png' });
  mediaFail = false;
  assert.deepEqual(await h.retryMedia(staff, { phone: '353851111111', id: 'wamid.I3' }, deps()), { status: 'stored', error: null });
  await rejects(h.retryMedia(staff, { phone: '353851111111', id: 'nope' }, deps()), 'not-found');
  await rejects(h.retryMedia(null, { phone: '353851111111', id: 'wamid.I3' }, deps()), 'unauthenticated');
});

test('files that are too large, or whose link has expired, are recorded as failed without leaving partial files', async () => {
  files.BIG = { mime: 'video/mp4', bytes: Buffer.from('x'), file_size: 200 * MB };
  await mediaHook('wamid.B1', 'video', { id: 'BIG', mime_type: 'video/mp4' });
  const b = await msgDoc('353851111111', 'wamid.B1');
  assert.equal(b.media.status, 'failed'); assert.match(b.media.error, /too large/i); assert.equal(mediaDownloads.length, 0);
  await mediaHook('wamid.G1', 'image', { id: 'EXPIRED', mime_type: 'image/jpeg' });
  assert.equal((await msgDoc('353851111111', 'wamid.G1')).media.status, 'failed');
  const [list] = await bucket.getFiles({ prefix: 'media/' }); assert.equal(list.length, 0);
});

test('unusual or malformed inbound messages are stored as readable placeholders and never crash the webhook', async () => {
  const one = (wamid, extra) => post({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '111' },
    messages: [{ id: wamid, from: '353851111111', timestamp: '1700000000', ...extra }] } }] }] });
  assert.equal(await one('wamid.L1', { type: 'location', location: { latitude: 53.6, longitude: -6.2, name: 'Our site', address: 'Balbriggan' } }), 200);
  assert.equal(await one('wamid.R1', { type: 'reaction', reaction: { emoji: '👍', message_id: 'x' } }), 200);
  assert.equal(await one('wamid.N1', { type: 'interactive', interactive: { button_reply: { title: 'Yes please' } } }), 200);
  assert.equal(await one('wamid.C1', { type: 'contacts', contacts: [{ name: { formatted_name: 'Joe Plumber' } }] }), 200);
  assert.equal(await one('wamid.X1', { type: 'image' }), 200);                   // image with no image object
  assert.equal(await one('wamid.Y1', { type: 'hologram' }), 200);                // a type that does not exist yet
  assert.equal(await one('wamid.T1', { type: 'text' }), 200);                    // text with no text object
  const by = Object.fromEntries((await msgs('353851111111')).map((m) => [m.id, m.body]));
  assert.match(by['wamid.L1'], /Our site, Balbriggan.*maps\.google\.com\/\?q=53\.6,-6\.2/); assert.equal(by['wamid.R1'], 'Reacted 👍');
  assert.equal(by['wamid.N1'], 'Yes please'); assert.match(by['wamid.C1'], /Joe Plumber/);
  assert.equal(by['wamid.X1'], '[image]'); assert.equal(by['wamid.Y1'], '[hologram]'); assert.equal(by['wamid.T1'], '');
});

test('mediaUrl: staff get a link to stored files only; strangers, pending files and foreign paths are refused', async () => {
  files.IMG1 = { mime: 'image/png', bytes: PNG };
  await mediaHook('wamid.I1', 'image', { id: 'IMG1', mime_type: 'image/png' });
  const r = await h.mediaUrl(staff, { phone: '+353 85 111 1111', id: 'wamid.I1' }, deps());
  assert.equal(r.mimeType, 'image/png'); assert.match(r.url, /^data:image\/png;base64,/); assert.equal(Buffer.from(r.url.split(',')[1], 'base64').equals(PNG), true);
  await rejects(h.mediaUrl(null, { phone: '353851111111', id: 'wamid.I1' }, deps()), 'unauthenticated');
  await rejects(h.mediaUrl({ uid: 'x', token: { email: 'stranger@gmail.com', email_verified: true, staff: true } }, { phone: '353851111111', id: 'wamid.I1' }, deps()), 'permission-denied');
  await rejects(h.mediaUrl(staff, { phone: '353851111111', id: 'missing' }, deps()), 'not-found');
  await rejects(h.mediaUrl(staff, { phone: '353851111111' }, deps()), 'invalid-argument');
  mediaFail = true; await mediaHook('wamid.P1', 'image', { id: 'IMG1', mime_type: 'image/png' });        // failed => not available
  await rejects(h.mediaUrl(staff, { phone: '353851111111', id: 'wamid.P1' }, deps()), 'not-found');
  await db.collection('conversations').doc('353851111111').collection('messages').doc('wamid.EVIL').set({ direction: 'in',
    media: { status: 'stored', storagePath: 'media/353862222222/secret/file.pdf' } });                      // a path belonging to someone else
  await rejects(h.mediaUrl(staff, { phone: '353851111111', id: 'wamid.EVIL' }, deps()), 'permission-denied');
});

const seedUpload = async (name, bytes, contentType, uid = 'u1') => { const p = `uploads/${uid}/1700-abc-${name}`; await bucket.file(p).save(bytes, { contentType }); return p; };
const openConversation = async () => { await post(inbound('wamid.IN1', 'Hello', '353851111111')); };

test('sendMedia: image with caption, document, audio - validated, sent through WhatsApp, kept in private storage', async () => {
  await openConversation();
  const img = await seedUpload('kitchen.png', PNG, 'image/png');
  await h.sendMedia(staff, { phone: '353851111111', uploadPath: img, caption: 'Here is the layout', filename: 'kitchen.png' }, deps());
  assert.deepEqual([uploads[0].name, uploads[0].type, uploads[0].mp, uploads[0].auth], ['kitchen.png', 'image/png', 'whatsapp', 'Bearer tok']);
  let call = graphCalls.at(-1).body;
  assert.deepEqual([call.to, call.type, call.image.id, call.image.caption], ['353851111111', 'image', 'UPMEDIA1', 'Here is the layout']);
  const out = (await msgs('353851111111')).find((m) => m.direction === 'out');
  assert.equal(out.type, 'image'); assert.equal(out.body, 'Here is the layout'); assert.equal(out.media.status, 'stored');
  assert.ok(out.media.storagePath.startsWith('media/353851111111/' + out.id + '/'));
  assert.equal((await bucket.file(img).exists())[0], false);                                   // temp upload is gone
  assert.equal((await bucket.file(out.media.storagePath).exists())[0], true);
  assert.match((await h.mediaUrl(staff, { phone: '353851111111', id: out.id }, deps())).url, /^data:image\/png/);
  const c = await conv('353851111111'); assert.deepEqual([c.lastMessageType, c.lastMessageDirection], ['image', 'out']);

  const doc = await seedUpload('Quote v1.pdf', PDF, 'application/pdf');
  await h.sendMedia(staff, { phone: '353851111111', uploadPath: doc, caption: 'Your quote', filename: 'Quote v1.pdf' }, deps());
  call = graphCalls.at(-1).body; assert.deepEqual([call.type, call.document.filename, call.document.caption], ['document', 'Quote v1.pdf', 'Your quote']);

  const aud = await seedUpload('note.mp3', Buffer.from('ID3fake'), 'audio/mpeg');
  await h.sendMedia(staff, { phone: '353851111111', uploadPath: aud, caption: 'ignored for audio', filename: 'note.mp3' }, deps());
  call = graphCalls.at(-1).body; assert.equal(call.type, 'audio'); assert.equal(call.audio.caption, undefined);
});

test('sendMedia refuses bad input: wrong folder, unsupported type, too large, outside 24h, non-staff - and cleans up', async () => {
  await openConversation();
  const ok = await seedUpload('a.png', PNG, 'image/png');
  await rejects(h.sendMedia(staff, { phone: '353851111111', uploadPath: ok.replace('u1', 'someone-else') }, deps()), 'permission-denied');
  await rejects(h.sendMedia(staff, { phone: '353851111111', uploadPath: 'uploads/u1/../../media/x' }, deps()), 'permission-denied');
  await rejects(h.sendMedia(staff, { phone: '353851111111', uploadPath: 'media/353851111111/x/y.png' }, deps()), 'permission-denied');
  await rejects(h.sendMedia(staff, { phone: '353851111111', uploadPath: 'uploads/u1/missing.png' }, deps()), 'not-found');
  await rejects(h.sendMedia(null, { phone: '353851111111', uploadPath: ok }, deps()), 'unauthenticated');
  await rejects(h.sendMedia({ uid: 'u1', token: { email: 'stranger@gmail.com', email_verified: true, staff: true } }, { phone: '353851111111', uploadPath: ok }, deps()), 'permission-denied');
  await rejects(h.sendMedia(staff, { phone: '353800000000', uploadPath: ok }, deps()), 'not-found');
  await rejects(h.sendMedia(staff, { phone: '353851111111', uploadPath: ok, caption: 'x'.repeat(1025) }, deps()), 'invalid-argument');
  const exe = await seedUpload('virus.exe', Buffer.from('MZ'), 'application/x-msdownload');
  await rejects(h.sendMedia(staff, { phone: '353851111111', uploadPath: exe }, deps()), 'invalid-argument');
  assert.equal((await bucket.file(exe).exists())[0], false);
  const big = await seedUpload('huge.png', Buffer.alloc(5 * MB + 10), 'image/png');
  await rejects(h.sendMedia(staff, { phone: '353851111111', uploadPath: big }, deps()), 'invalid-argument');
  assert.equal((await bucket.file(big).exists())[0], false);
  assert.equal(uploads.length, 0); assert.equal(graphCalls.length, 0);                           // nothing ever reached Meta
  await h.startConversation(staff, { phone: '353870000000', name: 'Old' }, deps());
  graphCalls.length = 0;
  const late = await seedUpload('late.png', PNG, 'image/png');
  await rejects(h.sendMedia(staff, { phone: '353870000000', uploadPath: late }, deps()), 'failed-precondition');
  assert.equal((await bucket.file(late).exists())[0], false); assert.equal(graphCalls.length, 0);
});

test('sendMedia: a Meta rejection is shown to staff and recorded as a failed message; the temp upload is removed', async () => {
  await openConversation();
  const p = await seedUpload('a.png', PNG, 'image/png');
  graphFail = true;
  await rejects(h.sendMedia(staff, { phone: '353851111111', uploadPath: p, caption: 'cap' }, deps()), 'unavailable');
  const f = (await msgs('353851111111')).find((m) => m.status === 'failed');
  assert.equal(f.type, 'image'); assert.match(f.error, /131047/); assert.equal((await bucket.file(p).exists())[0], false);
});

test('unread counts: every new customer message adds one; opening the conversation clears them', async () => {
  await post(inbound('wamid.U1', 'one', '353851111111')); await post(inbound('wamid.U2', 'two', '353851111111'));
  await post(inbound('wamid.U2', 'two', '353851111111'));                                   // duplicate
  assert.equal((await conv('353851111111')).unreadCount, 2);
  await h.markRead(staff, { phone: '353851111111' }, deps());
  const c = await conv('353851111111'); assert.equal(c.unreadCount, 0); assert.ok(c.lastReadAt);
  await post(inbound('wamid.U3', 'three', '353851111111'));
  assert.equal((await conv('353851111111')).unreadCount, 1);
});

test('storage rules: staff can only CREATE in their own uploads folder; nobody can read or touch media from a browser', async () => {
  const su = new URL(/:\/\//.test(process.env.STORAGE_EMULATOR_HOST) ? process.env.STORAGE_EMULATOR_HOST : 'http://' + process.env.STORAGE_EMULATOR_HOST);
  const env = await initializeTestEnvironment({ projectId: PROJECT, storage: { host: su.hostname, port: Number(su.port), rules: fs.readFileSync('../storage.rules', 'utf8') } });
  await env.withSecurityRulesDisabled(async (ctx) => { await ctx.storage('gs://' + BUCKET).ref('media/353851111111/m/secret.pdf').put(PDF, { contentType: 'application/pdf' }); });
  const st = env.authenticatedContext('u1', { staff: true }).storage('gs://' + BUCKET);
  const other = env.authenticatedContext('u2', { staff: false }).storage('gs://' + BUCKET);
  const anon = env.unauthenticatedContext().storage('gs://' + BUCKET);
  await assertSucceeds(st.ref('uploads/u1/a.png').put(PNG, { contentType: 'image/png' }));
  await assertFails(st.ref('uploads/u2/a.png').put(PNG, { contentType: 'image/png' }));          // someone else's folder
  await assertFails(other.ref('uploads/u2/a.png').put(PNG, { contentType: 'image/png' }));        // no staff claim
  await assertFails(anon.ref('uploads/u1/b.png').put(PNG, { contentType: 'image/png' }));
  await assertFails(st.ref('uploads/u1/a.png').getDownloadURL());                                   // cannot read back
  await assertFails(st.ref('media/353851111111/m/secret.pdf').getDownloadURL());
  await assertFails(st.ref('media/353851111111/m/evil.pdf').put(PDF, { contentType: 'application/pdf' }));
  await assertFails(anon.ref('media/353851111111/m/secret.pdf').getDownloadURL());
  await env.cleanup();
});

test('Firestore rules: staff can read, nobody can write from a browser', async () => {
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  const env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { host, port: Number(port), rules: fs.readFileSync('../firestore.rules', 'utf8') } });
  await env.withSecurityRulesDisabled(async (ctx) => { await ctx.firestore().doc('conversations/1').set({ phone: '1' }); });
  const s = env.authenticatedContext('u1', { staff: true, email: 't@x.com', email_verified: true }).firestore();
  const plain = env.authenticatedContext('u2', { email: 't@x.com', email_verified: true }).firestore();
  const anon = env.unauthenticatedContext().firestore();
  await assertSucceeds(s.doc('conversations/1').get());
  await assertFails(plain.doc('conversations/1').get());
  await assertFails(anon.doc('conversations/1').get());
  await assertFails(s.doc('conversations/1').set({ phone: 'hacked' }));
  await assertFails(s.doc('conversations/1/messages/m').set({ body: 'forged' }));
  await assertFails(s.doc('contacts/1').set({ phone: '1' }));
  await env.cleanup();
});
