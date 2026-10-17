// Phase 10 (docs/PHASE10_SAFETY_NET.md): "do not contact". Real Firestore + Storage emulators; WhatsApp, email, the AI and push are FAKES, so nothing is ever sent.
// What matters: once a customer is marked "do not contact", NOTHING can leave Elite OS for them by any route (a typed reply, a file, a new conversation, Reopen, a quote by WhatsApp or
// email, a retry, "Download PDF and mark as sent", the Meta lead welcome, the automatic receptionist), the check holds inside each send's own claim (a switch set while a send is being
// prepared still stops it), "stop messaging me" switches it on by itself in every chat, and only a person switches it off. Every name and number is made up.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const h = require('../lib/handlers');
const CB = require('../lib/contactBlock');
const outbound = require('../lib/outbound');
const Q = require('../lib/quotes');
const D = require('../lib/quoteDelivery');
const QE = require('../lib/quoteEngine');
const R = require('../lib/reopen');
const ai = require('../lib/ai');
const REC = require('../lib/aiReceptionist');
const { handleLeadRequest } = require('../lib/leads');
const { createClient } = require('../lib/whatsapp');
const { whatsappChannel } = require('../lib/quoteChannels');

const PROJECT = 'demo-leados', BUCKET = 'demo-leados.firebasestorage.app';
initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
const db = getFirestore();
const bucket = getStorage().bucket(BUCKET);
const OWNERS = 'thomas@example.com';
const cfg = { allowedEmails: 'thomas@example.com', template: 'elite_kitchens_new_lead', reopenTemplate: 'elite_kitchens_reopen', reopenLang: 'en' };
const staff = { uid: 'u1', token: { email: 'thomas@example.com', email_verified: true, staff: true } };
const actor = { kind: 'staff', id: 'thomas@example.com' };
const MIN = 60e3, H = 60 * MIN, NOW = Date.UTC(2026, 9, 13, 10, 0), ts = (ms) => Timestamp.fromMillis(ms);
const P = '353871110041', P2 = '353871110042';
const isDnc = (e) => e && e.code === 'failed-precondition' && e.details && e.details.reason === 'do_not_contact' && /asked not to be contacted/.test(e.message);
const refusedDnc = (p) => assert.rejects(p, isDnc, 'expected the do-not-contact refusal');

// ---- fake Meta: every call is recorded ----
const meta = { calls: [] };
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const mockFetch = async (url, opts = {}) => {
  meta.calls.push(String(url));
  if (/\/media$/.test(String(url))) return reply({ id: 'MEDIA' + meta.calls.length });
  return reply({ messages: [{ id: 'wamid.T' + meta.calls.length }] });
};
const wa = () => createClient({ phoneId: '111', token: 'tok', version: 'v21.0', template: cfg.template, lang: 'en' }, mockFetch);
const mailLog = [];
const mail = { id: 'email', maxMessage: 5000, async check() { return null; }, async send(ctx) { mailLog.push(ctx); return { providerId: 'mail-' + mailLog.length }; } };

async function seed(p = P, extra = {}) {
  await db.doc('contacts/' + p).set({ phone: p, name: 'Niamh Test', email: 'niamh@example.com', address: '1 Main Street, Swords', location: 'Swords', createdAt: ts(NOW - 9e8) });
  await db.doc('conversations/' + p).set({ phone: p, name: 'Niamh Test', inboxStatus: 'inbox', createdAt: ts(NOW - 9e8), updatedAt: ts(NOW - 1e6), lastInboundAt: ts(NOW - 2 * H), lastMessageDirection: 'in', unreadCount: 0, ...extra });
}
const conv = async (p = P) => (await db.doc('conversations/' + p).get()).data();
const msgs = async (p = P) => (await db.collection(`conversations/${p}/messages`).get()).docs.map((d) => d.data());
const block = (p = P, note) => CB.set({ db }, actor, { phone: p, on: true, ...(note ? { note } : {}) }, { nowMs: NOW });
const allow = (p = P) => CB.set({ db }, actor, { phone: p, on: false }, { nowMs: NOW + MIN });
let seq = 0; const rid = () => 'req' + (++seq) + 'abcdefgh';

beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await bucket.deleteFiles({ force: true }).catch(() => {});
  meta.calls.length = 0; mailLog.length = 0;
  await seed(); await seed(P2);
});

// ================================================================ the switch itself ======================================
test('the switch: staff only, on with a note and who/when, off again, history kept, the same state twice changes nothing, unknown fields refused', async () => {
  await assert.rejects(h.setDoNotContact(null, { phone: P, on: true }, { db, cfg }), (e) => e.code === 'unauthenticated');
  await assert.rejects(h.setDoNotContact({ uid: 'x', token: { email: 'other@example.com', email_verified: true, staff: true } }, { phone: P, on: true }, { db, cfg }), (e) => e.code === 'permission-denied');
  for (const bad of [{ phone: P }, { phone: P, on: 'yes' }, { phone: '12', on: true }, { phone: P, on: true, note: 'x'.repeat(201) }, { phone: P, on: true, extra: 1 }]) await assert.rejects(CB.set({ db }, actor, bad), (e) => e.code === 'invalid-argument', JSON.stringify(bad));
  await assert.rejects(CB.set({ db }, actor, { phone: '353870000000', on: true }), (e) => e.code === 'not-found');
  assert.deepEqual(await h.setDoNotContact(staff, { phone: P, on: true, note: 'asked on the phone' }, { db, cfg }), { ok: true, on: true });
  let c = await conv(); assert.equal(c.doNotContact.on, true); assert.equal(c.doNotContact.by, 'thomas@example.com'); assert.equal(c.doNotContact.source, 'staff'); assert.equal(c.doNotContact.note, 'asked on the phone');
  assert.deepEqual(await block(), { ok: true, on: true, unchanged: true });
  assert.deepEqual(await allow(), { ok: true, on: false });
  c = await conv(); assert.equal(c.doNotContact.on, false); assert.equal(c.doNotContact.note, null); assert.deepEqual(c.doNotContactHistory.map((x) => x.on), [true, false]);
  assert.equal(CB.blocked(c), false); assert.equal(CB.blocked({ doNotContact: { on: true } }), true); assert.equal(CB.blocked(null), false);
});

// ================================================================ every way a message can leave ============================
test('a typed reply is refused (nothing sent, nothing claimed, the receptionist not told a person wrote); allowed again after "Allow contact again"', async () => {
  await db.doc('conversations/' + P).update({ lastInboundAt: ts(Date.now() - H) });            // sendReply checks the 24-hour window on the real clock
  await block();
  await refusedDnc(h.sendReply(staff, { phone: P, body: 'Hello', requestId: rid() }, { db, wa: wa(), cfg }));
  assert.equal(meta.calls.length, 0); assert.equal((await db.collection(`conversations/${P}/sendRequests`).get()).size, 0);
  assert.equal(((await conv()).receptionist || {}).humanAt, undefined);
  await allow();
  assert.deepEqual(await h.sendReply(staff, { phone: P, body: 'Hello again', requestId: rid() }, { db, wa: wa(), cfg }), { ok: true });
  assert.equal(meta.calls.length, 1);
});

test('a file is refused and the uploaded copy is deleted', async () => {
  await block();
  const up = 'uploads/u1/1700000000000-ab-photo.jpg';
  await bucket.file(up).save(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), { contentType: 'image/jpeg' });
  await refusedDnc(h.sendMedia(staff, { phone: P, uploadPath: up, filename: 'photo.jpg', requestId: rid() }, { db, wa: wa(), cfg, bucket }));
  assert.equal(meta.calls.length, 0); assert.equal((await bucket.file(up).exists())[0], false, 'the upload is not left behind');
});

test('"New conversation" (the welcome template) is refused for an existing customer marked "do not contact"; a brand-new number is not affected', async () => {
  await block();
  await refusedDnc(h.startConversation(staff, { phone: P, name: 'Niamh', requestId: rid() }, { db, wa: wa(), cfg }));
  assert.equal(meta.calls.length, 0);
  const r = await h.startConversation(staff, { phone: '353871119999', name: 'New', requestId: rid() }, { db, wa: wa(), cfg });
  assert.equal(r.phone, '353871119999'); assert.equal(meta.calls.length, 1);
});

test('INSIDE THE CLAIM: a switch set after the screen checked still stops the send; an already-sent request still answers "done" and sends nothing', async () => {
  const id = rid();
  assert.deepEqual(await outbound.begin(db, P, id, NOW), { go: true }); await outbound.settle(db, P, id, { state: 'sent', wamid: 'wamid.X' });
  await block();
  await refusedDnc(outbound.begin(db, P, rid(), NOW));                                        // a new send: refused inside the transaction
  assert.equal((await outbound.begin(db, P, id, NOW)).done, true, 'the same request that already went out is answered as done (no second message, no error)');
});

test('"Reopen conversation" is refused inside its claim (the window is closed, so it would otherwise be allowed)', async () => {
  await seed(P, { lastInboundAt: ts(NOW - 30 * H) }); await block();
  await refusedDnc(R.reopen({ db, wa: wa(), cfg }, actor, { phone: P, requestId: rid() }, { nowMs: NOW }));
  assert.equal(meta.calls.length, 0); assert.equal((await conv()).reopen, undefined, 'nothing was claimed');
  await allow();
  assert.equal((await R.reopen({ db, wa: wa(), cfg }, actor, { phone: P, requestId: rid() }, { nowMs: NOW })).state, 'sent');
});

// ---- quotes ----
const PRICE_LIST = { options: { ess: { perDoor: 110, perTopBox: 60 }, prem: { perDoor: 140, perTopBox: 65 }, pp: { perDoor: 150, perTopBox: 70 } }, drawerBoxes: { cemux: 12, blum: 21 }, glazing: { small: 45, large: 90 }, extras: [] };
const SETTINGS = { priceList: PRICE_LIST, vatRate: 13.5, validityDays: 30, business: { tradingName: 'Elite Kitchens', signatureName: 'Test Person', phone: '01 000 0000', email: 'quotes@example.com', web: 'www.example.com', address: 'Test Street, Dublin', vatNumber: 'IE0000000X' } };
async function quoteReady(p = P) {
  await Q.saveSettings({ db, cfg, bucket }, actor, SETTINGS, { nowMs: NOW });
  const a = QE.current().newAnswers(PRICE_LIST); a.doors = 10; a.options.ess.drawerBox = 'cemux';
  return (await Q.create({ db, cfg, bucket }, actor, { phone: p, requestId: rid(), answers: a }, { nowMs: NOW })).id;
}
async function sendData(id, over = {}) {
  const q = (await db.doc('quotes/' + id).get()).data(), s = (await db.doc('quoteSettings/current').get()).data();
  const up = `uploads/u1/${Date.now()}-${++seq}-quote.pdf`; await bucket.file(up).save(Buffer.from('%PDF-1.4\n% test\n%%EOF'), { contentType: 'application/pdf' });
  return { id, expectedRev: q.rev, requestId: rid(), issueDate: Q.dublinDate(NOW), settingsRev: s.rev, customer: { name: 'Niamh Test', email: 'niamh@example.com', address: '1 Main Street, Swords' }, pdfUploadPath: up, pipeline: { value: 14500 }, ...over };
}
const channels = (extra = {}) => ({ whatsapp: whatsappChannel({ db, bucket, wa: wa(), now: () => NOW }), email: mail, ...extra });

test('a quote by WhatsApp and email is refused BEFORE anything is prepared (the draft stays a draft, no PDF stored, nothing to Meta or Gmail); "mark as sent" (Download PDF) is refused too', async () => {
  const id = await quoteReady(); await block();
  await refusedDnc(D.deliver({ db, cfg, bucket, channels: channels() }, actor, { ...(await sendData(id)), channels: ['whatsapp', 'email'], messages: { whatsapp: 'Hi', email: 'Dear Niamh' } }, { nowMs: NOW, uid: 'u1' }));
  const q = (await db.doc('quotes/' + id).get()).data();
  assert.equal(q.status, 'draft'); assert.equal(q.preparedSend || null, null); assert.equal((await db.collection(`quotes/${id}/deliveries`).get()).size, 0);
  assert.equal(meta.calls.length + mailLog.length, 0);
  await refusedDnc(Q.send({ db, bucket }, actor, await sendData(id), { nowMs: NOW, uid: 'u1' }));
  assert.equal((await db.doc('quotes/' + id).get()).data().status, 'draft');
});

test('INSIDE THE DELIVERY CLAIM: switched on while a quote is being sent, the next channel is NOT sent: it is recorded as failed with the reason; Retry is refused', async () => {
  const id = await quoteReady();
  const blocker = { id: 'whatsapp', maxMessage: 1024, async check() { await db.doc('conversations/' + P).update({ doNotContact: { on: true, by: 'someone', source: 'staff' } }); return { ok: false, code: 'test', text: 'stopped for the test' }; }, async send() { throw new Error('must not be called'); } };
  const r = await D.deliver({ db, cfg, bucket, channels: channels({ whatsapp: blocker }) }, actor, { ...(await sendData(id)), channels: ['whatsapp', 'email'], messages: { whatsapp: 'Hi', email: 'Dear Niamh' } }, { nowMs: NOW, uid: 'u1' });
  const email = r.deliveries.find((d) => d.channel === 'email');
  assert.equal(email.state, 'failed'); assert.equal(email.error.code, 'do_not_contact'); assert.equal(mailLog.length, 0, 'Gmail was never asked');
  assert.equal(r.sent, false);
  await refusedDnc(D.retry({ db, cfg, bucket, channels: channels() }, actor, { id, deliveryId: email.id }, { nowMs: NOW }));
  assert.equal(mailLog.length, 0);
});

// ---- the Meta lead welcome ----
test('a NEW Meta lead from a customer marked "do not contact" gets no welcome; the chat says why; a Make retry changes nothing', async () => {
  await block();
  const lcfg = { phoneId: '111', token: 'tok', template: 'elite_kitchens_new_lead', lang: 'en', version: 'v21.0', apiKeys: 'test-key-1234567890-abcdefghij' };
  const body = { leadId: '5555666677778888', formName: 'Test form', field_data: [{ name: 'full_name', values: ['Niamh Test'] }, { name: 'phone_number', values: ['+' + P] }] };
  const call = () => handleLeadRequest({ method: 'POST', headers: { authorization: 'Bearer ' + lcfg.apiKeys }, rawBody: Buffer.from(JSON.stringify(body)), body }, { db, wa: createClient(lcfg, mockFetch), cfg: lcfg, now: () => NOW });
  const r = await call();
  assert.equal(r.status, 200); assert.equal(r.body.welcome, 'blocked'); assert.equal(meta.calls.length, 0);
  const failed = (await msgs()).filter((m) => m.status === 'failed'); assert.equal(failed.length, 1); assert.match(failed[0].error, /asked not to be contacted/);
  assert.equal((await call()).body.status, 'duplicate'); assert.equal(meta.calls.length, 0);
});

// ---- the automatic receptionist ----
const USAGE = { input: 3000, output: 200, cacheRead: 0, cacheWrite: 0 };
const fake = (steps) => { const m = { name: 'fake', calls: [], async complete(req) { m.calls.push(1); const s = steps[Math.min(m.calls.length - 1, steps.length - 1)]; const r = typeof s === 'function' ? await s(req) : s; return { text: '', toolCalls: [], stopReason: 'end_turn', usage: USAGE, ...r }; } }; return m; };
const decision = () => ({ toolCalls: [{ id: 'd1', name: 'reply_decision', input: { reply: '', intent: 'wants_consultation', wantsConsultation: true, schedule: { preference: null, opener: '' }, newFacts: [], handover: { needed: false, reason: null } } }], stopReason: 'tool_use' });
const fakeWa = () => { const w = { sent: [], async sendText(to, body) { w.sent.push({ to, body }); return 'wamid.AUTO' + w.sent.length; } }; return w; };
const fakePush = () => { const p = { events: [], async notify(ev) { p.events.push(ev); return { sent: 1 }; } }; return p; };
const aiOn = async () => {
  await db.doc('aiSettings/modelCheck').set(Object.fromEntries(Object.entries(ai.MODELS).map(([k, m]) => [k, { id: m.id, ok: true, name: m.label, lifecycle: 'active', at: ts(NOW) }])));
  await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, replyAssistant: true, autoReply: true, monthlyCapEur: 15, dailyCapEur: 2 });
};
async function arm(p = P, body = 'I would like a kitchen consultation') {
  await ai.setReceptionist({ db, owners: OWNERS }, actor, { phone: p, on: true }, { nowMs: NOW - 600e3 });
  await db.collection(`conversations/${p}/messages`).add({ direction: 'in', type: 'text', body, createdAt: ts(NOW - 120e3) });
  await db.doc('conversations/' + p).update({ lastInboundAt: ts(NOW - 120e3), lastMessageDirection: 'in' });
}
const rdeps = (m, w, p) => ({ db, wa: w, model: m, owners: OWNERS, push: p });

test('the receptionist does not answer a "do not contact" chat and does not even ask the AI (no cost)', async () => {
  await aiOn(); await arm(); await block();
  const m = fake([decision()]), w = fakeWa();
  assert.equal(await REC.processChat(rdeps(m, w, fakePush()), P, NOW), 'do_not_contact');
  assert.equal(m.calls.length + w.sent.length, 0);
});

test('INSIDE THE RECEPTIONIST CLAIM: switched on while the AI was writing the reply, nothing is sent and the chat is passed to a person', async () => {
  await aiOn(); await arm();
  const m = fake([async () => { await db.doc('conversations/' + P).update({ doNotContact: { on: true, by: 'thomas@example.com', source: 'staff' } }); return decision(); }]), w = fakeWa();
  assert.equal(await REC.processChat(rdeps(m, w, fakePush()), P, NOW), 'do_not_contact');
  assert.equal(w.sent.length, 0); assert.equal((await conv()).receptionist.paused, 'do not contact');
});

test('"stop messaging me" switches it on by itself in EVERY chat (AI on or off); the receptionist hands its chat over with an alert; ordinary uses of "stop" do not', async () => {
  const say = (p, body) => REC.onMessage(rdeps(fake([decision()]), fakeWa(), push), p, { direction: 'in', type: 'text', body, createdAt: ts(NOW) }, { now: () => NOW, sleep: async () => {} });
  let push = fakePush();
  await say(P2, 'Please stop messaging me');                                                    // no AI settings at all, no receptionist
  let c = await conv(P2); assert.equal(c.doNotContact.on, true); assert.equal(c.doNotContact.source, 'customer'); assert.equal(c.doNotContact.by, 'customer');
  await aiOn(); await arm(P); push = fakePush();
  await say(P, 'unsubscribe');
  c = await conv(P); assert.equal(c.doNotContact.on, true); assert.match(c.receptionist.paused, /stop messaging/);
  assert.deepEqual(push.events.map((e) => e.kind), ['handover'], 'the owner is alerted once');
  for (const ok of ['Can you stop by on Tuesday?', "Don't text me after 9pm please", 'I want to stop sending you photos, here is the last one', 'Stop! That price is great']) {
    assert.equal(REC.asksToStop(ok), false, ok);
  }
  for (const stop of ['STOP messaging me', "don't contact me again", 'Please remove my number', 'leave me alone', 'Do not text me']) assert.equal(REC.asksToStop(stop), true, stop);
  await allow(P2);
  assert.equal((await conv(P2)).doNotContact.on, false, 'only a person switches it off; an old message does not switch it back on');
});
