// Regression tests for the findings of the independent audit of 2026-10-08 (docs/PHASE6_1_PLAN.md, "Audit"). Each test reproduces what the
// audit described and fails without its fix. Real Firestore + Storage emulators and FAKE providers: nothing real is sent. Everything is made up.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const h = require('../lib/handlers');
const Q = require('../lib/quotes');
const D = require('../lib/quoteDelivery');
const QE = require('../lib/quoteEngine');
const store = require('../lib/store');
const { createClient } = require('../lib/whatsapp');
const { whatsappChannel } = require('../lib/quoteChannels');

const PROJECT = 'demo-leados';
const BUCKET = 'demo-leados.firebasestorage.app';
initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
const db = getFirestore();
const bucket = getStorage().bucket(BUCKET);
const cfg = { allowedEmails: 'thomas@example.com' };
const staff = { uid: 'u1', token: { email: 'thomas@example.com', email_verified: true, staff: true } };
const actor = { kind: 'staff', id: 'thomas@example.com' };
const rejects = (p, code, msg) => assert.rejects(p, (e) => e.code === code && (!msg || msg.test(e.message)), `expected ${code}${msg ? ' ' + msg : ''}`);

const MIN = 60 * 1000, H = 60 * MIN;
const NOW = Date.UTC(2026, 9, 2, 9, 0);                       // Friday 2 Oct 2026, 10:00 in Dublin
const P = '353851111111', R2 = '353852222222';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const pdfBytes = (tag) => Buffer.from(`%PDF-1.4\n% Elite OS test quote ${tag}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`);
const PRICE_LIST = {
  options: { ess: { perDoor: 110, perTopBox: 60 }, prem: { perDoor: 140, perTopBox: 65 }, pp: { perDoor: 150, perTopBox: 70 } },
  drawerBoxes: { cemux: 12, blum: 21 }, glazing: { small: 45, large: 90 },
  extras: [{ key: 'bin', name: 'Pull-out bin', unit: 'per unit', price: 30 }],
};
const SETTINGS = { priceList: PRICE_LIST, vatRate: 13.5, validityDays: 30,
  business: { tradingName: 'Elite Kitchens', signatureName: 'Test Person', phone: '01 000 0000', email: 'quotes@example.com', web: 'www.example.com', address: 'Test Street, Dublin', vatNumber: 'IE0000000X' } };

// ---- fake Meta (media upload + messages), with a hook that runs while a message is "in flight" ----
const meta = { media: [], messages: [], beforeReply: null, mode: 'ok' };
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const mockFetch = async (url, opts = {}) => {
  url = String(url);
  if (opts.method === 'POST' && /\/media$/.test(url)) {
    const f = opts.body.get('file'); meta.media.push({ name: f.name, bytes: Buffer.from(await f.arrayBuffer()) });
    return reply({ id: 'UPMEDIA' + meta.media.length });
  }
  if (opts.method === 'POST' && /\/messages$/.test(url)) {
    meta.messages.push({ body: JSON.parse(opts.body) });
    if (meta.beforeReply) await meta.beforeReply();
    if (meta.mode === 'refuse') return reply({ error: { code: 131026, message: 'Message undeliverable' } }, 400);
    if (meta.mode === 'server') return reply({ error: { code: 1, message: 'Unknown' } }, 500);
    if (meta.mode === 'network') throw new TypeError('fetch failed');
    return reply({ messages: [{ id: 'wamid.OUT' + meta.messages.length }] });
  }
  return reply({ error: { message: 'unexpected ' + url } }, 404);
};
const wa = createClient({ phoneId: '111', token: 'tok', version: 'v21.0' }, mockFetch);
const mailLog = [];
const mail = { id: 'email', maxMessage: 5000, async check() { return null; }, async send(ctx) { mailLog.push({ to: ctx.to && ctx.to.email, subject: ctx.subject, pdfSha: sha(ctx.pdf.bytes) }); return { providerId: 'mail-' + mailLog.length }; } };
const deps = { db, cfg, bucket };
const dd = () => ({ db, cfg, bucket, channels: { whatsapp: whatsappChannel({ db, bucket, wa, now: () => NOW, timeoutMs: 1000 }), email: mail } });
const run = (fn, data, nowMs = NOW) => fn(dd(), actor, data, { nowMs, uid: 'u1' });

let seq = 0;
const rid = () => 'req-' + (++seq) + '-abcdefgh';
const conv = async (p = P) => (await db.doc('conversations/' + p).get()).data();
const contact = async (p = P) => (await db.doc('contacts/' + p).get()).data();
const quote = async (id) => (await db.doc('quotes/' + id).get()).data();
const version = async (id, n = 1) => (await db.doc(`quotes/${id}/versions/${n}`).get()).data();
const settingsDoc = async () => (await db.doc('quoteSettings/current').get()).data();
const files = async (prefix) => (await bucket.getFiles({ prefix }))[0].map((f) => f.name);
const deliveries = async (id) => (await db.collection(`quotes/${id}/deliveries`).get()).docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.version - b.version);
async function seed(p = P, convExtra = {}, name = 'Anna Murphy', contactExtra = {}) {
  await db.doc('contacts/' + p).set({ phone: p, name, email: 'anna@example.com', address: '1 Main Street, Swords', location: 'Swords', createdAt: Timestamp.now(), ...contactExtra });
  await db.doc('conversations/' + p).set({ phone: p, name, createdAt: Timestamp.now(), updatedAt: Timestamp.now(), lastMessage: 'Hi', unreadCount: 2,
    lastInboundAt: Timestamp.fromMillis(NOW - 2 * H), ...convExtra });                                    // the customer wrote two hours ago: the window is open
}
function answers() {
  const a = QE.current().newAnswers(PRICE_LIST);
  a.doors = 10; a.drawers = 4; a.options.ess.drawerBox = 'cemux';
  a.options.prem = { ...a.options.prem, on: true, drawerBox: 'blum' };
  return a;
}
async function upload(bytes) {
  const p = `uploads/u1/${Date.now()}-${++seq}-quote.pdf`;
  await bucket.file(p).save(bytes, { contentType: 'application/pdf' });
  return p;
}
const make = (p = P) => Q.create(deps, actor, { phone: p, requestId: rid(), answers: answers() }, { nowMs: NOW });
const MSG = { whatsapp: 'Hi Anna, please find attached your quotation.', email: 'Dear Anna, please find attached your quotation.' };
async function dataFor(id, over = {}, bytes = pdfBytes('q' + seq)) {
  const qq = await quote(id), s = await settingsDoc();
  const ct = (await db.doc('contacts/' + qq.phone).get()).data() || {}, cv = await conv(qq.phone);
  const channels = over.channels || ['whatsapp'];
  return { id, expectedRev: qq.rev, requestId: rid(), issueDate: Q.dublinDate(NOW), settingsRev: s.rev,
    customer: { name: ct.name || cv.name || null, email: ct.email || null, address: ct.address || null }, pdfUploadPath: await upload(bytes), pipeline: { value: 14500 },
    channels, messages: Object.fromEntries(channels.map((c) => [c, MSG[c]])), ...over };
}
const sendOld = async (id, bytes) => { const d = await dataFor(id, {}, bytes); delete d.channels; delete d.messages; return Q.send(deps, actor, d, { nowMs: NOW, uid: 'u1' }); };   // Phase 6's own "mark sent by hand"

beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await bucket.deleteFiles({ force: true }).catch(() => {});
  Object.assign(meta, { media: [], messages: [], beforeReply: null, mode: 'ok' }); mailLog.length = 0;
  await seed(); await Q.saveSettings(deps, actor, SETTINGS, { nowMs: NOW });
});

// ====================================== audit 3: a resend goes to the address staff REVIEWED, never to another or a historical one =======
const resendEmail = (id, over = {}) => ({ id, version: 1, requestId: rid(), channels: ['email'], messages: { email: MSG.email }, recipients: { email: 'anna@example.com' }, ...over });

test('audit 3: a resend by email goes to the address on screen; if it changed meanwhile it is refused, and nothing is queued or sent', async () => {
  const { id } = await make(); await sendOld(id, pdfBytes('v1'));
  await db.doc('contacts/' + P).update({ email: 'someone.else@example.com' });                          // another member of staff changed it after the dialog was opened
  await rejects(run(D.deliver, resendEmail(id)), 'failed-precondition', /email address changed|check it/i);
  assert.equal((await deliveries(id)).length, 0); assert.equal(mailLog.length, 0);
  const ok = await run(D.deliver, resendEmail(id, { recipients: { email: 'someone.else@example.com' } }));        // the new address, reviewed: fine
  assert.equal(ok.sent, true); assert.deepEqual(mailLog.map((m) => m.to), ['someone.else@example.com']);
});

test('audit 3: if the address was removed meanwhile, the resend is refused: it never falls back to the old address frozen on the version', async () => {
  const { id } = await make(); await sendOld(id, pdfBytes('v1'));
  assert.equal((await version(id)).customer.email, 'anna@example.com');                                 // the old address is still on the version
  await db.doc('contacts/' + P).update({ email: FieldValue.delete() });
  await rejects(run(D.deliver, resendEmail(id)), 'failed-precondition', /no email address|add one/i);
  assert.equal((await deliveries(id)).length, 0); assert.equal(mailLog.length, 0);
});

test('audit 3: a resend by email must say which address it is for; the same address again is accepted and recorded', async () => {
  const { id } = await make(); await sendOld(id, pdfBytes('v1'));
  for (const recipients of [undefined, {}, { email: '' }, { email: null }, { email: 5 }, { email: 'anna@example.com', extra: 1 }]) {
    const d = resendEmail(id); if (recipients === undefined) delete d.recipients; else d.recipients = recipients;
    await rejects(run(D.deliver, d), 'invalid-argument');
  }
  assert.equal((await deliveries(id)).length, 0);
  const r = await run(D.deliver, resendEmail(id));
  assert.deepEqual([r.sent, (await deliveries(id))[0].to], [true, { email: 'anna@example.com' }]);
});

test('audit 3: a resend by WhatsApp alone needs no address (it goes to the quote\'s own number), and cannot be given one', async () => {
  const { id } = await make(); await sendOld(id, pdfBytes('v1'));
  const r = await run(D.deliver, { id, version: 1, requestId: rid(), channels: ['whatsapp'], messages: { whatsapp: MSG.whatsapp } });
  assert.equal(r.sent, true); assert.equal(meta.messages.length, 1);
  await rejects(run(D.deliver, { id, version: 1, requestId: rid(), channels: ['whatsapp'], messages: { whatsapp: MSG.whatsapp }, recipients: { email: 'x@example.com' } }), 'invalid-argument');
});

test('audit 3: sending a draft is unchanged: the customer details on screen must still match (and no recipients field is accepted there)', async () => {
  const { id } = await make();
  const reviewed = await dataFor(id, { channels: ['email'] });                                           // built while the dialog showed anna@example.com
  await db.doc('contacts/' + P).update({ email: 'changed@example.com' });
  await rejects(run(D.deliver, reviewed), 'failed-precondition', /details changed/i);
  await rejects(run(D.deliver, { ...(await dataFor(id, { channels: ['email'] })), recipients: { email: 'x@example.com' } }), 'invalid-argument', /Unknown field/);
});

// ============================== audit 1: the stored PDF is immutable, and a request id is bound to ONE document ============================
// A storage whose writes can be held back on purpose, so that two calls with the same request id interleave exactly as in the audit's race.
function gatedBucket(shouldHold) {
  let release; const gate = new Promise((res) => { release = res; });
  const wrapped = Object.create(bucket);
  wrapped.file = (p) => {
    const f = bucket.file(p);
    return new Proxy(f, { get(t, k) {
      if (k === 'save') return async (buf, o) => { if (shouldHold(p, buf)) await gate; return t.save(buf, o); };
      const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
    } });
  };
  return { bucket: wrapped, release };
}
const depsWith = (b) => ({ db, cfg, bucket: b, channels: { whatsapp: whatsappChannel({ db, bucket: b, wa, now: () => NOW, timeoutMs: 1000 }), email: mail } });
const storedBytes = async (id, n = 1) => (await bucket.file((await version(id, n)).pdf.path).download())[0];

test('audit 1: two calls with the SAME request id but DIFFERENT PDFs: the later writer cannot overwrite the first PDF, and is refused', async () => {
  const { id } = await make();
  const A = pdfBytes('PDF A'), B = pdfBytes('PDF B');
  const dataA = await dataFor(id, {}, A);
  const dataB = { ...(await dataFor(id, {}, B)), requestId: dataA.requestId, expectedRev: dataA.expectedRev };      // the same request, a different document
  const gate = gatedBucket((p, buf) => buf.equals(B));
  const late = D.deliver(depsWith(gate.bucket), actor, dataB, { nowMs: NOW, uid: 'u1' });                           // B reaches the storage write and is held there
  await new Promise((r) => setTimeout(r, 300));
  const first = await run(D.deliver, dataA);                                                                        // A completes meanwhile
  assert.equal(first.sent, true);
  gate.release();                                                                                                    // now B writes
  const second = await Promise.allSettled([late]);
  assert.ok((await storedBytes(id)).equals(A), 'the stored PDF was overwritten by the later call');
  assert.equal(sha(await storedBytes(id)), (await version(id)).pdf.sha256);                                         // what is stored is what the record says
  assert.equal(second[0].status, 'rejected', 'the second document under the same request id must be refused, not reported as "existing"');
  assert.equal(second[0].reason.code, 'failed-precondition'); assert.match(second[0].reason.message, /different PDF|already/i);
  assert.equal((await files(`quotes/${P}/`)).length, 1, 'the refused call must leave nothing behind, and must not delete the first PDF');
  assert.equal(meta.messages.length, 1);                                                                             // and A's message went once
});

test('audit 1: the same holds for Phase 6\'s own "mark as sent" send', async () => {
  const { id } = await make();
  const A = pdfBytes('PDF A'), B = pdfBytes('PDF B');
  const dA = await dataFor(id, {}, A); delete dA.channels; delete dA.messages;
  const dB = { ...(await dataFor(id, {}, B)), requestId: dA.requestId, expectedRev: dA.expectedRev }; delete dB.channels; delete dB.messages;
  const gate = gatedBucket((p, buf) => buf.equals(B));
  const late = Q.send({ db, bucket: gate.bucket }, actor, dB, { nowMs: NOW, uid: 'u1' });
  await new Promise((r) => setTimeout(r, 300));
  await Q.send(deps, actor, dA, { nowMs: NOW, uid: 'u1' });
  gate.release();
  const second = await Promise.allSettled([late]);
  assert.ok((await storedBytes(id)).equals(A)); assert.equal(second[0].status, 'rejected');
  assert.equal((await files(`quotes/${P}/`)).length, 1);
});

test('audit 1: a true duplicate (the same request, the same PDF) still sends once and keeps its file', async () => {
  const { id } = await make();
  const data = await dataFor(id, {}, pdfBytes('same'));
  const rs = await Promise.allSettled([1, 2, 3, 4].map(() => run(D.deliver, data)));
  assert.ok(rs.some((x) => x.status === 'fulfilled'));
  assert.equal((await files(`quotes/${P}/`)).length, 1); assert.equal(meta.messages.length, 1);
  assert.ok((await storedBytes(id)).equals(pdfBytes('same')));
});

test('audit 1: two DIFFERENT requests that store the same PDF never share (and never delete) each other\'s file', async () => {
  const { id } = await make();
  const d1 = await dataFor(id, {}, pdfBytes('same')), d2 = { ...(await dataFor(id, {}, pdfBytes('same'))), expectedRev: d1Rev(await quote(id)) };
  function d1Rev(q) { return q.rev; }
  const r1 = await run(D.deliver, d1);
  assert.equal(r1.sent, true);
  await rejects(run(D.deliver, d2), 'failed-precondition');                                                          // the quote has moved on (sent): refused as before
  assert.ok((await storedBytes(id)).equals(pdfBytes('same')));                                                     // a refused request's cleanup did not touch the first one's file
});

test('audit 1: downloading a stored PDF refuses a file that no longer matches its record (changed, replaced or truncated)', async () => {
  const { id } = await make();
  await run(D.deliver, await dataFor(id, {}, pdfBytes('genuine')));
  const ok = await h.quotePdfUrl(staff, { id, version: 1 }, deps);
  assert.ok(ok.url, 'a genuine file is offered');
  await bucket.file((await version(id)).pdf.path).save(pdfBytes('SOMETHING ELSE'), { contentType: 'application/pdf', resumable: false });   // the object is replaced behind our back
  await rejects(h.quotePdfUrl(staff, { id, version: 1 }, deps), 'failed-precondition', /does not match/i);
});

// ============================== audit 4: a send in flight must not bring back a customer who was erased meanwhile ======================
const everything = async (phone) => ({
  conv: (await db.doc('conversations/' + phone).get()).exists,
  messages: (await db.collection(`conversations/${phone}/messages`).get()).size,
  contact: (await db.doc('contacts/' + phone).get()).exists,
  quotes: (await db.collection('quotes').where('phone', '==', phone).get()).size,
  media: (await files(`media/${phone}/`)).length, quoteFiles: (await files(`quotes/${phone}/`)).length,
});
const NOTHING = { conv: false, messages: 0, contact: false, quotes: 0, media: 0, quoteFiles: 0 };

test('audit 4: the customer is erased WHILE the WhatsApp document is in flight: nothing is recreated (no conversation, message, file or quote)', async () => {
  const { id } = await make();
  meta.beforeReply = async () => { meta.beforeReply = null; await h.deleteCustomer(staff, { phone: P, confirm: '1111' }, deps); };       // the erase runs while Meta is "answering"
  const r = await run(D.deliver, await dataFor(id)).catch((e) => ({ error: e }));
  assert.equal(meta.messages.length, 1, 'the message really went out (it was already with Meta)');
  assert.deepEqual(await everything(P), NOTHING, 'something of the erased customer came back: ' + JSON.stringify(await everything(P)) + ' result=' + JSON.stringify(r.error ? String(r.error.message) : r.state || r.status));
});

test('audit 4: the same when the erase happens while the PDF is being uploaded to WhatsApp', async () => {
  const { id } = await make();
  const g = gatedBucket(() => false); void g;
  const realUpload = wa.uploadMedia;
  const slow = { ...wa, uploadMedia: async (...a) => { await h.deleteCustomer(staff, { phone: P, confirm: '1111' }, deps); return realUpload(...a); } };
  const channels = { whatsapp: whatsappChannel({ db, bucket, wa: slow, now: () => NOW, timeoutMs: 1000 }), email: mail };
  await D.deliver({ db, cfg, bucket, channels }, actor, await dataFor(id), { nowMs: NOW, uid: 'u1' }).catch(() => {});
  assert.equal(meta.messages.length, 0, 'a message was sent to a customer who had already been erased');
  assert.deepEqual(await everything(P), NOTHING);
});

test('audit 4: the same when the erase happens while the chat copy of the PDF is being made (after the "still there?" check, before the write)', async () => {
  const { id } = await make();
  let erased = false;
  const wrapped = Object.create(bucket);
  wrapped.file = (p) => new Proxy(bucket.file(p), { get(t, k) {
    if (k === 'copy') return async (dest) => { if (!erased) { erased = true; await h.deleteCustomer(staff, { phone: P, confirm: '1111' }, deps); } return t.copy(bucket.file(dest.name)); };
    const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
  } });
  const r = await D.deliver(depsWith(wrapped), actor, await dataFor(id), { nowMs: NOW, uid: 'u1' }).catch((e) => ({ error: e }));
  assert.equal(erased, true, 'the erase never ran: this test would prove nothing');
  assert.equal(meta.messages.length, 1, 'the message really went out (it was already with Meta)');
  assert.deepEqual(await everything(P), NOTHING, 'something of the erased customer came back: ' + JSON.stringify(await everything(P)) + ' result=' + JSON.stringify(r.error ? String(r.error.message) : r.state || r.status));
});

test('audit 4: a customer who is NOT erased is recorded exactly as before (the chat gets the document and its own copy of the PDF)', async () => {
  const { id } = await make();
  const r = await run(D.deliver, await dataFor(id));
  assert.equal(r.sent, true);
  const e = await everything(P);
  assert.deepEqual([e.conv, e.messages, e.media, e.quoteFiles], [true, 1, 1, 1]);
});

// ============== audit 11: a channel left queued by an interrupted call can be resumed, exactly once, and the stalled one becomes "unsure" ======
function interrupted() {                                                                              // a WhatsApp channel whose send never comes back until we say so
  let finish; const gate = new Promise((res) => { finish = res; });
  let started; const began = new Promise((res) => { started = res; });
  return { began, finish: () => finish({ providerId: 'wamid.LATE' }), channel: { id: 'whatsapp', maxMessage: 1024, async check() { return null; }, async send() { started(); return gate; } } };
}
const emailD = async (id) => (await deliveries(id)).find((d) => d.channel === 'email');
const waD = async (id) => (await deliveries(id)).find((d) => d.channel === 'whatsapp');

test('audit 11: the call that was sending stops after WhatsApp: the email channel stays queued, and "retry" resumes it (once), committing the quote', async () => {
  const { id } = await make();
  const w = interrupted();
  const stuck = D.deliver({ db, cfg, bucket, channels: { whatsapp: w.channel, email: mail } }, actor, await dataFor(id, { channels: ['whatsapp', 'email'] }), { nowMs: NOW, uid: 'u1' });
  await w.began;                                                                                      // WhatsApp is "sending"; the email channel is waiting its turn
  assert.deepEqual([(await waD(id)).state, (await emailD(id)).state], ['sending', 'queued']);
  assert.equal(mailLog.length, 0);
  // (this call is now considered dead: nothing awaits it) staff press "Send Email now"
  const resumed = await run(D.retry, { id, deliveryId: (await emailD(id)).id });
  assert.deepEqual([resumed.sent, mailLog.length, (await quote(id)).status], [true, 1, 'sent']);
  assert.equal((await emailD(id)).state, 'sent');
  // the dead call wakes up after all: it must NOT send the email a second time
  w.finish(); await stuck.catch(() => {});
  assert.equal(mailLog.length, 1, 'the email was sent twice');
  assert.equal((await emailD(id)).attempts, 1);
});

test('audit 11: two "Send now" presses at once send the waiting channel once', async () => {
  const { id } = await make();
  const w = interrupted();
  void D.deliver({ db, cfg, bucket, channels: { whatsapp: w.channel, email: mail } }, actor, await dataFor(id, { channels: ['whatsapp', 'email'] }), { nowMs: NOW, uid: 'u1' }).catch(() => {});
  await w.began;
  const did = (await emailD(id)).id;
  const rs = await Promise.allSettled([1, 2, 3].map(() => run(D.retry, { id, deliveryId: did })));
  assert.equal(rs.filter((x) => x.status === 'fulfilled').length, 1);
  for (const x of rs.filter((x) => x.status === 'rejected')) assert.equal(x.reason.code, 'failed-precondition');
  assert.equal(mailLog.length, 1);
});

test('audit 11: a delivery that has been "sending" for over 3 minutes counts as NOT CONFIRMED (and is never resent by itself)', async () => {
  const { id } = await make();
  const w = interrupted();
  void D.deliver({ db, cfg, bucket, channels: { whatsapp: w.channel, email: mail } }, actor, await dataFor(id, { channels: ['whatsapp'] }), { nowMs: NOW, uid: 'u1' }).catch(() => {});
  await w.began;
  const d = await waD(id);
  assert.equal(D.effectiveState(d, NOW + 2 * MIN), 'sending'); assert.equal(D.effectiveState(d, NOW + 4 * MIN), 'unknown');
  await rejects(run(D.retry, { id, deliveryId: d.id }, NOW + 4 * MIN), 'failed-precondition', /could not confirm/i);
  assert.equal(meta.messages.length, 0);
});

// ============== audit 6: the older staff text and file sends: one request = one message; "accepted" is never reported as "failed" ================
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const live = () => seed(P, { lastInboundAt: Timestamp.now() });                                        // sendReply / sendMedia use the real clock for the 24-hour window
const sentTo = () => meta.messages.filter((m) => m.body.type === 'text' || m.body.type === 'image');
const chat = async () => (await db.collection(`conversations/${P}/messages`).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const flaky = (failures, skip = 0) => {                                                                // a database that fails `failures` transactions after letting `skip` through (skip 1 = let the request claim in, fail the chat record)
  let left = failures, pass = skip;
  return new Proxy(db, { get(t, k) { if (k === 'runTransaction') return async (fn, o) => { if (pass > 0) { pass--; return t.runTransaction(fn, o); } if (left > 0) { left--; throw new Error('firestore is down'); } return t.runTransaction(fn, o); }; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } });
};
const reqId = () => 'out-' + (++seq) + '-abcdefgh';
async function pngUpload() { const p = `uploads/u1/${Date.now()}-${++seq}-photo.png`; await bucket.file(p).save(PNG, { contentType: 'image/png' }); return p; }

test('audit 6: WhatsApp ACCEPTED the text but our chat record failed: that is a success (the message is out), never a "failed" send that invites a duplicate', async () => {
  await live();
  const r = await h.sendReply(staff, { phone: P, body: 'Hello Anna', requestId: reqId() }, { db: flaky(1, 1), wa, cfg });
  assert.equal(r.ok, true);                                                                           // it really went
  assert.equal(sentTo().length, 1);
  assert.ok(!(await chat()).some((m) => m.status === 'failed'), 'a message that WENT OUT was recorded as failed');
});

test('audit 6: the same for a file: accepted by WhatsApp, the chat copy or record failed afterwards: still a success', async () => {
  await live();
  const r = await h.sendMedia(staff, { phone: P, uploadPath: await pngUpload(), caption: 'photo', requestId: reqId() }, { db: flaky(1, 1), wa, cfg, bucket });
  assert.equal(r.ok, true); assert.equal(sentTo().length, 1);
  assert.ok(!(await chat()).some((m) => m.status === 'failed'));
});

test('audit 6: an answer we cannot confirm (Meta 5xx, no connection) is "not confirmed": the same request again sends NOTHING, and the words say to check the chat', async () => {
  for (const mode of ['server', 'network']) {
    await live(); meta.messages.length = 0;
    meta.mode = mode; const id = reqId();
    await assert.rejects(h.sendReply(staff, { phone: P, body: 'Hello Anna', requestId: id }, { db, wa, cfg }), (e) => e.code === 'unavailable' && /not confirmed|could not tell/i.test(e.message), mode);
    meta.mode = 'ok';
    await rejects(h.sendReply(staff, { phone: P, body: 'Hello Anna', requestId: id }, { db, wa, cfg }), 'failed-precondition', /not confirmed|could not tell|check/i);
    assert.equal(sentTo().length, 1, mode + ': the message was sent a second time');
    assert.ok((await chat()).some((m) => m.status === 'failed' && /not confirmed|could not tell|check/i.test(m.error || '')), 'the chat should say it is unconfirmed');
    await db.recursiveDelete(db.collection(`conversations/${P}/messages`)); await db.recursiveDelete(db.collection(`conversations/${P}/sendRequests`));
  }
});

test('audit 6: one request is one message: a double click, or the same request again after success, sends once (and all at once, too)', async () => {
  await live();
  const id = reqId();
  const rs = await Promise.allSettled([1, 2, 3].map(() => h.sendReply(staff, { phone: P, body: 'Hello Anna', requestId: id }, { db, wa, cfg })));
  assert.ok(rs.some((x) => x.status === 'fulfilled'));
  for (const x of rs.filter((x) => x.status === 'rejected')) assert.equal(x.reason.code, 'failed-precondition');
  assert.equal(sentTo().length, 1);
  const again = await h.sendReply(staff, { phone: P, body: 'Hello Anna', requestId: id }, { db, wa, cfg });          // after success: the same answer, nothing sent
  assert.deepEqual([again.ok, sentTo().length], [true, 1]);
  const next = await h.sendReply(staff, { phone: P, body: 'Hello Anna', requestId: reqId() }, { db, wa, cfg });      // a NEW request is a new message, on purpose
  assert.deepEqual([next.ok, sentTo().length], [true, 2]);
});

test('audit 6: a message Meta REFUSED (4xx) is a plain failure: nothing was sent, and the same request may be tried again', async () => {
  await live();
  const id = reqId(); meta.mode = 'refuse';
  await rejects(h.sendReply(staff, { phone: P, body: 'Hello Anna', requestId: id }, { db, wa, cfg }), 'unavailable');
  assert.ok((await chat()).some((m) => m.status === 'failed'));
  meta.mode = 'ok';
  assert.equal((await h.sendReply(staff, { phone: P, body: 'Hello Anna', requestId: id }, { db, wa, cfg })).ok, true);
  assert.equal(sentTo().length, 2);                                                                    // the refused attempt and the one that went
});

test('audit 6: the same rules for files: not confirmed -> not repeated; one request -> one file', async () => {
  await live();
  const id = reqId(); meta.mode = 'server';
  await assert.rejects(h.sendMedia(staff, { phone: P, uploadPath: await pngUpload(), caption: 'x', requestId: id }, { db, wa, cfg, bucket }), (e) => e.code === 'unavailable' && /not confirmed|could not tell/i.test(e.message));
  meta.mode = 'ok';
  await rejects(h.sendMedia(staff, { phone: P, uploadPath: await pngUpload(), caption: 'x', requestId: id }, { db, wa, cfg, bucket }), 'failed-precondition');
  assert.equal(sentTo().length, 1);
  const ok = await h.sendMedia(staff, { phone: P, uploadPath: await pngUpload(), caption: 'x', requestId: reqId() }, { db, wa, cfg, bucket });
  assert.deepEqual([ok.ok, sentTo().length], [true, 2]);
});

test('audit 6: a request id is optional (older screens) and checked when given; and erasing the customer erases the claims', async () => {
  await live();
  assert.equal((await h.sendReply(staff, { phone: P, body: 'No id' }, { db, wa, cfg })).ok, true);       // as before
  await rejects(h.sendReply(staff, { phone: P, body: 'Bad id', requestId: 'x' }, { db, wa, cfg }), 'invalid-argument');
  await h.sendReply(staff, { phone: P, body: 'With id', requestId: reqId() }, { db, wa, cfg });
  assert.equal((await db.collection(`conversations/${P}/sendRequests`).get()).size, 1);
  await h.deleteCustomer(staff, { phone: P, confirm: '1111' }, deps);
  assert.equal((await db.collection(`conversations/${P}/sendRequests`).get()).size, 0);
});

test('audit 6: logs carry codes only: no message text, number or name from the provider or the database', async () => {
  await live();
  const seen = [], orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => seen.push(a.join(' ')); console.error = (...a) => seen.push(a.join(' ')); console.warn = (...a) => seen.push(a.join(' '));
  try {
    meta.mode = 'refuse'; await h.sendReply(staff, { phone: P, body: 'secret words for Anna', requestId: reqId() }, { db, wa, cfg }).catch(() => {});
    meta.mode = 'ok'; await h.sendReply(staff, { phone: P, body: 'more secret words', requestId: reqId() }, { db: flaky(1, 1), wa, cfg }).catch(() => {});
  } finally { Object.assign(console, orig); }
  const text = seen.join('\n');
  assert.ok(seen.length >= 1);
  for (const secret of ['secret words', 'Anna', 'Murphy', '353851111111', 'undeliverable', 'firestore is down']) assert.ok(!text.includes(secret), 'leaked: ' + secret);
});
