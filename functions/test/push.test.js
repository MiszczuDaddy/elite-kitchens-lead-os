// Phase 8: push notifications (docs/PUSH.md). Real Firestore emulator; Firebase Cloud Messaging and Meta are pretend, so every failure can be forced.
// What matters most: a push can NEVER break or hold up WhatsApp or lead processing; a retry never sends twice; nothing about the customer is in the push; staff only.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const h = require('../lib/handlers');
const push = require('../lib/push');
const { createClient } = require('../lib/whatsapp');
const { handleLeadRequest } = require('../lib/leads');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT, storageBucket: 'demo-leados.firebasestorage.app' });
const db = getFirestore();
const cfg = { allowedEmails: 'thomas@example.com, jo@example.com', phoneId: '111', appSecret: 'secret' };
const staff = { uid: 'u1', token: { email: 'thomas@example.com', email_verified: true, staff: true } };
const actor = { kind: 'staff', id: 'thomas@example.com' };
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code, `expected ${code}`);
const tok = (n) => 'fcm-token-' + String(n).padStart(3, '0') + '-' + 'x'.repeat(120);
const CUSTOMER = { name: 'Anna Murphy', phone: '353851234567', text: 'my secret kitchen budget is 20000' };

// ---- pretend Firebase Cloud Messaging
const fcm = { sent: [], mode: 'ok', dead: new Set() };
const messaging = { send: async (m) => {
  fcm.sent.push({ ...m, at: Date.now() });
  if (fcm.mode === 'hang') return new Promise(() => {});
  if (fcm.mode === 'down') throw Object.assign(new Error('FCM is down'), { code: 'messaging/internal-error' });
  if (fcm.dead.has(m.token)) throw Object.assign(new Error('gone'), { code: 'messaging/registration-token-not-registered' });
  return 'projects/p/messages/' + fcm.sent.length;
} };
const ctx = (over = {}) => ({ db, messaging, allowed: cfg.allowedEmails, capMs: 400, ...over });
const hook = (over = {}) => ({ notify: (ev) => push.safeNotify(ctx(over), ev) });

async function device(n, email = 'thomas@example.com', platform = 'windows', enabled = true) {
  const t = tok(n), id = push.deviceIdOf(t);
  await db.doc('pushDevices/' + id).set({ token: t, email, platform, enabled, createdAt: Timestamp.now(), lastSeenAt: Timestamp.now() });
  return { id, token: t };
}
const events = async () => (await db.collection('pushEvents').get()).docs.map((d) => ({ id: d.id, ...d.data() }));

beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  fcm.sent.length = 0; fcm.mode = 'ok'; fcm.dead.clear();
});

// ---- the WhatsApp webhook, as Meta calls it
const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', 'secret').update(raw).digest('hex');
const inbound = (wamid, c = CUSTOMER) => ({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '111' }, contacts: [{ wa_id: c.phone, profile: { name: c.name } }],
  messages: [{ id: wamid, from: c.phone, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: c.text } }] } }] }] });
const webhook = (payload, deps) => { const raw = Buffer.from(JSON.stringify(payload)); return h.webhookReceive({ rawBody: raw, body: payload, signature: sign(raw) }, { db, cfg, ...deps }); };

// ==================================================== devices ============================================================
test('devices: only signed-in, allowlisted staff can register, remove or test; a token is validated; the same token is one device; nobody removes another person\'s', async () => {
  const people = [[null, 'unauthenticated'], [{ uid: 'x', token: { email: 'stranger@gmail.com', email_verified: true, staff: true } }, 'permission-denied'], [{ uid: 'x', token: { email: 'thomas@example.com', email_verified: true } }, 'permission-denied']];
  for (const [who, code] of people) for (const name of ['registerPushDevice', 'unregisterPushDevice', 'sendTestPush']) await rejects(h[name](who, { token: tok(1), platform: 'windows', deviceId: 'a'.repeat(32) }, { db, cfg, messaging }), code);
  assert.equal((await db.collection('pushDevices').get()).size, 0);
  const d = { db, cfg, messaging };
  for (const bad of [{ platform: 'windows' }, { token: 'short', platform: 'windows' }, { token: tok(1), platform: 'toaster' }, { token: tok(1) }, { token: tok(1), platform: 'windows', x: 1 }, { token: 'has spaces ' + 'x'.repeat(80), platform: 'windows' }, null])
    await rejects(h.registerPushDevice(staff, bad, d), 'invalid-argument');
  const a = await h.registerPushDevice(staff, { token: tok(1), platform: 'windows' }, d), b = await h.registerPushDevice(staff, { token: tok(1), platform: 'windows' }, d);
  assert.equal(a.deviceId, b.deviceId); assert.equal(a.deviceId, push.deviceIdOf(tok(1))); assert.match(a.deviceId, /^[0-9a-f]{32}$/); assert.equal((await db.collection('pushDevices').get()).size, 1);
  const doc = (await db.doc('pushDevices/' + a.deviceId).get()).data(); assert.deepEqual([doc.email, doc.platform, doc.enabled], ['thomas@example.com', 'windows', true]);
  const jo = { uid: 'u2', token: { email: 'jo@example.com', email_verified: true, staff: true } };
  await rejects(h.unregisterPushDevice(jo, { deviceId: a.deviceId }, d), 'permission-denied'); assert.ok((await db.doc('pushDevices/' + a.deviceId).get()).exists);
  assert.deepEqual(await h.unregisterPushDevice(staff, { deviceId: a.deviceId }, d), { removed: true }); assert.deepEqual(await h.unregisterPushDevice(staff, { deviceId: a.deviceId }, d), { removed: false });
  await rejects(h.unregisterPushDevice(staff, { deviceId: 'nope' }, d), 'invalid-argument');
});

// ================================================ a WhatsApp message =====================================================
test('a new WhatsApp message: one push per allowed, enabled device; the push holds only opaque ids (no name, number or text); every step is timed in order', async () => {
  const w = await device(1, 'thomas@example.com', 'windows'), a = await device(2, 'jo@example.com', 'android');
  await device(3, 'thomas@example.com', 'windows', false); await device(4, 'stranger@gmail.com', 'android');       // switched off, and not on the staff list
  const before = Date.now();
  assert.equal(await webhook(inbound('wamid.A1'), { push: hook() }), 200);
  assert.deepEqual(fcm.sent.map((m) => m.token).sort(), [w.token, a.token].sort());
  const [ev] = await events(); assert.equal(ev.kind, 'message'); assert.equal(ev.phone, CUSTOMER.phone); assert.match(ev.id, /^m_[0-9a-f]{24}$/); assert.equal(ev.status, 'sent');
  for (const m of fcm.sent) {
    assert.deepEqual(Object.keys(m.data).sort(), ['c', 'd', 'k', 'n']); assert.equal(m.data.n, ev.id); assert.equal(m.data.k, 'message'); assert.ok([w.id, a.id].includes(m.data.d));
    assert.equal(m.webpush.headers.Urgency, 'high'); assert.equal(m.webpush.headers.TTL, String(push.TTL_SECONDS)); assert.equal(m.notification, undefined, 'a data-only message: the service worker writes the words');
    const text = JSON.stringify(m); for (const secret of ['Anna', 'Murphy', 'secret', 'kitchen', 'budget', '20000', CUSTOMER.phone, '851234567']) assert.ok(!text.includes(secret), 'the push must not contain: ' + secret);
  }
  assert.ok(ev.eventAt >= Math.floor(before / 1000) * 1000 - 1000 && ev.eventAt <= Date.now(), 'Meta\'s own time of the message');
  assert.ok(ev.backendReceivedAt >= before && ev.backendReceivedAt <= ev.sendStartedAt && ev.sendStartedAt <= ev.sendFinishedAt, 'received, then send started, then finished');
  for (const id of [w.id, a.id]) { const d = ev.devices[id]; assert.equal(d.ok, true); assert.ok(d.acceptedAt >= ev.sendStartedAt && d.acceptedAt <= ev.sendFinishedAt); assert.equal(d.platform, id === w.id ? 'windows' : 'android'); }
  assert.equal((await db.collection('conversations').doc(CUSTOMER.phone).collection('messages').get()).size, 1, 'the message itself was stored as before');
});

test('a Meta retry of the same message sends nothing more; a different message sends again; messages from one customer share a tag', async () => {
  await device(1);
  await webhook(inbound('wamid.R1'), { push: hook() }); await webhook(inbound('wamid.R1'), { push: hook() }); await webhook(inbound('wamid.R1'), { push: hook() });
  assert.equal(fcm.sent.length, 1); assert.equal((await events()).length, 1);
  await webhook(inbound('wamid.R2'), { push: hook() }); assert.equal(fcm.sent.length, 2); assert.equal((await events()).length, 2);
  assert.equal(fcm.sent[0].data.c, fcm.sent[1].data.c, 'the same customer: the same tag, so the device replaces the earlier alert');
  await webhook(inbound('wamid.O1', { ...CUSTOMER, phone: '353869999999' }), { push: hook() }); assert.notEqual(fcm.sent[2].data.c, fcm.sent[0].data.c);
  assert.equal(push.eventIdOf('message', 'wamid.R1'), push.eventIdOf('message', 'wamid.R1')); assert.notEqual(push.eventIdOf('message', 'x'), push.eventIdOf('lead', 'x'));
});

test('the second layer: even if the caller asks twice for the same message or lead (a crash and a retry), the notification record is create-only and nothing is sent twice', async () => {
  await device(1); fcm.sent.length = 0;
  const ev = { kind: 'message', sourceId: 'wamid.TWICE', phone: CUSTOMER.phone, backendReceivedAt: Date.now() };
  const [a, b, c] = [await push.notify(ctx(), ev), await push.notify(ctx(), ev), await push.safeNotify(ctx(), ev)];
  assert.equal(a.sent, 1); assert.equal(b.duplicate, true); assert.equal(c.duplicate, true); assert.equal(fcm.sent.length, 1);
  const [rec] = await events(); assert.equal(rec.status, 'sent', 'a duplicate must not touch the record of the first');
  const both = await Promise.all([push.notify(ctx(), { ...ev, sourceId: 'wamid.RACE' }), push.notify(ctx(), { ...ev, sourceId: 'wamid.RACE' })]);       // two copies at the same moment
  assert.equal(both.filter((r) => r.duplicate).length, 1); assert.equal(fcm.sent.length, 2);
  await push.notify(ctx(), { ...ev, kind: 'lead', sourceId: 'wamid.TWICE' }); assert.equal(fcm.sent.length, 3, 'a lead and a message with the same source text are different events');
});

test('WhatsApp processing is never broken or held up by a push: Firebase down, Firebase hanging, the hook itself throwing, nobody subscribed', async () => {
  await device(1);
  const cases = [['Firebase is down', () => { fcm.mode = 'down'; return hook(); }], ['Firebase never answers', () => { fcm.mode = 'hang'; return hook(); }],
    ['the hook throws', () => ({ notify: () => { throw new Error('boom'); } })], ['the hook rejects', () => ({ notify: async () => { throw new Error('boom'); } })]];
  let i = 0;
  for (const [what, make] of cases) {
    fcm.mode = 'ok'; const p = make(), t0 = Date.now(), wamid = 'wamid.F' + (++i);
    assert.equal(await webhook(inbound(wamid), { push: p }), 200, what);
    assert.ok(Date.now() - t0 < 2500, what + ': it must not wait for Firebase long (' + (Date.now() - t0) + ' ms)');
    assert.equal((await db.collection('conversations').doc(CUSTOMER.phone).collection('messages').doc(wamid).get()).exists, true, what + ': the message is stored');
  }
  const evs = await events(); assert.ok(evs.some((e) => e.status === 'timeout') && evs.some((e) => e.status === 'failed'), JSON.stringify(evs.map((e) => e.status)));
  assert.equal(await webhook(inbound('wamid.NOPUSH'), {}), 200);                                         // no hook at all (older callers): as before
  assert.equal(await webhook(inbound('wamid.NODEV'), { push: hook({ allowed: 'nobody@example.com' }) }), 200); assert.equal((await events()).find((e) => e.status === 'no-devices').kind, 'message');
});

test('a device that has unsubscribed is forgotten; the others still get the push', async () => {
  const good = await device(1), gone = await device(2, 'thomas@example.com', 'android'); fcm.dead.add(gone.token);
  await webhook(inbound('wamid.D1'), { push: hook() });
  assert.equal((await db.doc('pushDevices/' + gone.id).get()).exists, false); assert.equal((await db.doc('pushDevices/' + good.id).get()).exists, true);
  const [ev] = await events(); assert.equal(ev.status, 'sent'); assert.equal(ev.devices[good.id].ok, true); assert.equal(ev.devices[gone.id].ok, false); assert.equal(ev.devices[gone.id].error, 'messaging/registration-token-not-registered');
});

test('erasing a customer erases their notification records (they hold the number), and only theirs', async () => {
  const { getStorage } = require('firebase-admin/storage'); const bucket = getStorage().bucket('demo-leados.firebasestorage.app');
  await device(1); const other = { ...CUSTOMER, phone: '353869999999', name: 'Brian Byrne' };
  await webhook(inbound('wamid.E1'), { push: hook() }); await webhook(inbound('wamid.E2'), { push: hook() }); await webhook(inbound('wamid.E3', other), { push: hook() });
  assert.equal((await events()).length, 3);
  const r = await h.deleteCustomer(staff, { phone: CUSTOMER.phone, confirm: CUSTOMER.phone.slice(-4) }, { db, cfg, bucket }); assert.ok(r);
  const left = await events(); assert.equal(left.length, 1); assert.equal(left[0].phone, other.phone);
  assert.equal((await db.collection('pushDevices').get()).size, 1, 'the staff devices are not the customer\'s data');
});

// ===================================================== a Meta lead =======================================================
const KEY = 'test-key-1234567890-abcdefghij';
const leadCfg = { phoneId: '111', token: 'tok', template: 'elite_kitchens_new_lead', lang: 'en', version: 'v21.0', apiKeys: KEY };
const welcomes = [];
const leadWa = () => createClient(leadCfg, async (url, opts = {}) => { welcomes.push(Date.now()); return new Response(JSON.stringify({ messages: [{ id: 'wamid.W' + welcomes.length }] }), { status: 200, headers: { 'content-type': 'application/json' } }); });
const lead = (id = '7770001111', phone = 'p:+353861112222') => ({ leadId: id, formId: '1', formName: 'Test form', created_time: new Date(Date.now() - 4000).toISOString(),
  field_data: [{ name: 'full_name', values: ['Aoife Byrne'] }, { name: 'phone_number', values: [phone] }] });
const leadCall = (body, deps = {}) => handleLeadRequest({ method: 'POST', headers: { authorization: `Bearer ${KEY}` }, rawBody: Buffer.from(JSON.stringify(body)), body }, { db, wa: leadWa(), cfg: leadCfg, ...deps });

test('a new Meta lead: one push (sent before the welcome message), a retry sends nothing, and a push problem changes nothing about the answer', async () => {
  welcomes.length = 0; const w = await device(1);
  const r = await leadCall(lead(), { push: hook() });
  assert.equal(r.status, 200); assert.equal(r.body.status, 'processed'); assert.equal(fcm.sent.length, 1);
  const [ev] = await events(); assert.equal(ev.kind, 'lead'); assert.match(ev.id, /^l_[0-9a-f]{24}$/); assert.equal(ev.phone, '353861112222'); assert.equal(fcm.sent[0].data.k, 'lead');
  assert.ok(ev.eventAt && ev.eventAt < ev.backendReceivedAt, 'Meta\'s own time of the lead comes first'); assert.ok(ev.sendStartedAt <= welcomes[0], 'the push does not wait for the welcome message');
  const text = JSON.stringify(fcm.sent[0]); for (const s of ['Aoife', 'Byrne', '861112222', 'Test form']) assert.ok(!text.includes(s), 'the push must not contain: ' + s);
  assert.equal(fcm.sent[0].data.d, w.id);
  const again = await leadCall(lead(), { push: hook() }); assert.equal(again.body.status, 'duplicate'); assert.equal(fcm.sent.length, 1);
  for (const [what, p] of [['Firebase down', () => { fcm.mode = 'down'; return hook(); }], ['Firebase hangs', () => { fcm.mode = 'hang'; return hook(); }], ['the hook throws', () => ({ notify: async () => { throw new Error('x'); } })]]) {
    fcm.mode = 'ok'; const t0 = Date.now(), rr = await leadCall(lead('7770009' + Math.floor(Math.random() * 1e6), 'p:+3538' + String(Math.floor(1e7 + Math.random() * 8e7))), { push: p() });
    assert.equal(rr.status, 200, what); assert.equal(rr.body.status, 'processed', what); assert.ok(Date.now() - t0 < 2500, what);
  }
  assert.equal((await leadCall(lead('7770002222', 'p:+353871234567'))).body.status, 'processed');       // no hook at all: as before
});

// ===================================================== test push =========================================================
test('a test notification goes to ONE of the caller\'s own devices, carries no customer, and its clock starts when the request arrives', async () => {
  const mine = await device(1), other = await device(2, 'jo@example.com', 'android'), second = await device(6, 'thomas@example.com', 'android'), d = { db, cfg, messaging };
  await rejects(h.sendTestPush(staff, { deviceId: other.id }, d), 'failed-precondition'); await rejects(h.sendTestPush(staff, { deviceId: 'f'.repeat(32) }, d), 'failed-precondition'); await rejects(h.sendTestPush(staff, {}, d), 'invalid-argument');
  assert.equal(fcm.sent.length, 0);
  const t0 = Date.now(), r = await h.sendTestPush(staff, { deviceId: mine.id }, d);
  assert.equal(r.sent, 1); assert.match(r.id, /^t_[0-9a-f]{24}$/); assert.equal(fcm.sent.length, 1, 'only the device asked for, not the caller\'s other device (' + second.id.slice(0, 6) + ') or anyone else\'s'); assert.equal(fcm.sent[0].token, mine.token); assert.deepEqual([fcm.sent[0].data.k, fcm.sent[0].data.d, fcm.sent[0].data.n], ['test', mine.id, r.id]);
  const ev = (await db.doc('pushEvents/' + r.id).get()).data(); assert.equal(ev.kind, 'test'); assert.equal(ev.phone, null); assert.ok(ev.backendReceivedAt >= t0 && ev.backendReceivedAt <= ev.sendStartedAt);
  const r2 = await h.sendTestPush(staff, { deviceId: mine.id }, d); assert.notEqual(r2.id, r.id, 'every test is its own measurement');
});

// ====================================================== receipts =========================================================
test('receipts: the device reports when it received and when it was clicked; the first report wins; strangers, bad ids and stale clocks are refused; nothing is returned', async () => {
  const mine = await device(1); fcm.sent.length = 0;
  const r = await h.sendTestPush(staff, { deviceId: mine.id }, { db, cfg, messaging });
  const post = (body, nowMs) => push.receipt({ db }, body, { nowMs });
  const t = Date.now();
  assert.equal(await post({ n: r.id, d: mine.id, p: 'received', t: t - 50 }, t + 100), 204);
  let ev = (await db.doc('pushEvents/' + r.id).get()).data(); assert.deepEqual(ev.receipts[mine.id].received, { deviceAt: t - 50, serverAt: t + 100 });
  assert.equal(await post({ n: r.id, d: mine.id, p: 'received', t: t + 5000 }, t + 6000), 204);
  ev = (await db.doc('pushEvents/' + r.id).get()).data(); assert.equal(ev.receipts[mine.id].received.deviceAt, t - 50, 'the first report is kept');
  assert.equal(await post({ n: r.id, d: mine.id, p: 'clicked', t: t + 3000 }, t + 3100), 204); assert.equal((await db.doc('pushEvents/' + r.id).get()).data().receipts[mine.id].clicked.serverAt, t + 3100);
  for (const bad of [null, [], {}, { n: r.id, d: mine.id, p: 'sent', t }, { n: 'x', d: mine.id, p: 'received', t }, { n: r.id, d: 'x', p: 'received', t }, { n: r.id, d: mine.id, p: 'received', t: 'now' }, { n: r.id, d: mine.id, p: 'received', t: t - 8 * 24 * 3600e3 }, { n: r.id, d: mine.id, p: 'received', t: NaN }])
    assert.equal(await post(bad, t), 400, JSON.stringify(bad));
  assert.equal(await post({ n: 't_' + '0'.repeat(24), d: mine.id, p: 'received', t }, t), 404, 'an event that does not exist');
  assert.equal(await post({ n: r.id, d: 'a'.repeat(32), p: 'received', t }, t), 404, 'a device nobody registered');
  // a very fast device reports before the result of the send has been recorded on the event: the registered device is still accepted
  await db.doc('pushEvents/m_' + 'a'.repeat(24)).set({ kind: 'message', phone: CUSTOMER.phone, status: 'sending', backendReceivedAt: t });
  assert.equal(await post({ n: 'm_' + 'a'.repeat(24), d: mine.id, p: 'received', t }, t), 204);
  // the public endpoint itself
  assert.equal(await h.pushReceipt({ method: 'GET' }, { db }), 405); assert.equal(await h.pushReceipt({ method: 'POST', rawBody: Buffer.alloc(2000), body: {} }, { db }), 413);
  assert.equal(await h.pushReceipt({ method: 'POST', rawBody: Buffer.from('{}'), body: { n: r.id, d: mine.id, p: 'received', t: Date.now() } }, { db }), 204);
});
