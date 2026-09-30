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
admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

const cfg = { phoneId: '111', token: 'tok', appSecret: 'secret', verifyToken: 'vt', template: 'elite_kitchens_new_lead',
  lang: 'en', version: 'v21.0', allowedEmails: 'Thomas@example.com, other@example.com' };
const graphCalls = []; let graphFail = false; let onGraph = null;
const mockFetch = async (url, opts) => {
  graphCalls.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization });
  if (onGraph) await onGraph();
  if (graphFail) return { ok: false, status: 400, json: async () => ({ error: { code: 131047, message: 'Re-engagement message' } }) };
  return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.OUT' + graphCalls.length }] }) };
};
const deps = () => ({ db, cfg, wa: createClient(cfg, mockFetch) });

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
  graphCalls.length = 0; graphFail = false; onGraph = null;
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
  assert.equal(row.type, 'image'); assert.equal(row.body, '[image]'); assert.equal(row.media.id, 'MEDIA1');
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
