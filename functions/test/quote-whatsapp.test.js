// Phase 6.1 M3: sending a quote through the EXISTING WhatsApp infrastructure (docs/PHASE6_1_PLAN.md). Real Firestore + Storage
// emulators and a FAKE Meta (no real message is ever sent): the exact PDF goes out as ONE document message with the text as its
// caption; the server re-checks the 24-hour window at send time; every Meta failure shape is covered. Everything is made up.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const h = require('../lib/handlers');
const Q = require('../lib/quotes');
const D = require('../lib/quoteDelivery');
const QE = require('../lib/quoteEngine');
const R = require('../lib/reopen');
const store = require('../lib/store');
const { createClient } = require('../lib/whatsapp');
const { whatsappChannel, WINDOW_CLOSED, AWAITING } = require('../lib/quoteChannels');

const PROJECT = 'demo-leados';
const BUCKET = 'demo-leados.firebasestorage.app';
initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
const db = getFirestore();
const bucket = getStorage().bucket(BUCKET);
const cfg = { allowedEmails: 'thomas@example.com', reopenTemplate: 'elite_kitchens_reopen', reopenLang: 'en' };
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

// ---- fake Meta (media upload + messages) ----
const meta = { media: [], messages: [], mode: 'ok', uploadMode: 'ok', beforeReply: null };
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const hang = (opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
const mockFetch = async (url, opts = {}) => {
  url = String(url);
  if (opts.method === 'POST' && /\/media$/.test(url)) {
    const f = opts.body.get('file');
    meta.media.push({ name: f.name, type: f.type, bytes: Buffer.from(await f.arrayBuffer()), auth: opts.headers.Authorization });
    if (meta.uploadMode === 'refuse') return reply({ error: { code: 131053, message: 'Media upload error' } }, 400);
    if (meta.uploadMode === 'server') return reply({ error: { code: 1, message: 'Unknown' } }, 500);
    if (meta.uploadMode === 'network') throw new TypeError('fetch failed');
    return reply({ id: 'UPMEDIA' + meta.media.length });
  }
  if (opts.method === 'POST' && /\/messages$/.test(url)) {
    meta.messages.push({ body: JSON.parse(opts.body), auth: opts.headers.Authorization });
    if (meta.beforeReply) await meta.beforeReply();
    if (meta.mode === 'window') return reply({ error: { code: 131047, message: 'Re-engagement message' } }, 400);
    if (meta.mode === 'refuse') return reply({ error: { code: 131026, message: 'Message undeliverable to 353851111111' } }, 400);
    if (meta.mode === 'server') return reply({ error: { code: 1, message: 'Unknown' } }, 500);
    if (meta.mode === 'noid') return reply({ messages: [] }, 200);
    if (meta.mode === 'network') throw new TypeError('fetch failed');
    if (meta.mode === 'hang') return hang(opts);
    return reply({ messages: [{ id: 'wamid.OUT' + meta.messages.length }] });
  }
  return reply({ error: { message: 'unexpected ' + url } }, 404);
};
const wa = createClient({ phoneId: '111', token: 'tok', version: 'v21.0' }, mockFetch);
let clock = NOW;
const docs = () => meta.messages.filter((m) => m.body.type === 'document');
const whats = () => whatsappChannel({ db, bucket, wa, now: () => clock, timeoutMs: 60 });
const mailLog = [], mail = { id: 'email', maxMessage: 5000, mode: 'ok', async check() { return null; },
  async send(ctx) { mailLog.push(ctx); if (this.mode === 'refuse') throw new D.ChannelError('The email was refused.', { code: 'refused', definite: true }); return { providerId: 'mail-' + mailLog.length }; } };
const deps = { db, cfg, bucket };
const dd = () => ({ db, cfg, bucket, channels: { whatsapp: whats(), email: mail } });
const run = (fn, data, nowMs = NOW) => fn(dd(), actor, data, { nowMs, uid: 'u1' });

let seq = 0;
const rid = () => 'req-' + (++seq) + '-abcdefgh';
const conv = async (p = P) => (await db.doc('conversations/' + p).get()).data();
const contact = async (p = P) => (await db.doc('contacts/' + p).get()).data();
const quote = async (id) => (await db.doc('quotes/' + id).get()).data();
const version = async (id, n = 1) => (await db.doc(`quotes/${id}/versions/${n}`).get()).data();
const settingsDoc = async () => (await db.doc('quoteSettings/current').get()).data();
const msgs = async (p = P) => (await db.collection(`conversations/${p}/messages`).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const deliveries = async (id) => (await db.collection(`quotes/${id}/deliveries`).get()).docs.map((d) => ({ id: d.id, ...d.data() }))
  .sort((a, b) => (a.version - b.version) || (D.CHANNEL_ORDER.indexOf(a.channel) - D.CHANNEL_ORDER.indexOf(b.channel)));
const dOf = async (id, channel) => (await deliveries(id)).find((d) => d.channel === channel);
const files = async (prefix) => (await bucket.getFiles({ prefix }))[0].map((f) => f.name);
const states = (r) => r.deliveries.map((d) => [d.channel, d.state]);
async function seed(p = P, convExtra = {}, name = 'Anna Murphy') {
  await db.doc('contacts/' + p).set({ phone: p, name, email: 'anna@example.com', address: '1 Main Street, Swords', location: 'Swords', createdAt: Timestamp.now() });
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
const MSG = 'Hi Anna, please find attached your quotation.';
async function dataFor(id, over = {}, bytes = pdfBytes('q' + seq)) {
  const qq = await quote(id), s = await settingsDoc();
  const ct = (await db.doc('contacts/' + qq.phone).get()).data() || {}, cv = await conv(qq.phone);
  const channels = over.channels || ['whatsapp'];
  return { id, expectedRev: qq.rev, requestId: rid(), issueDate: Q.dublinDate(NOW), settingsRev: s.rev,
    customer: { name: ct.name || cv.name || null, email: ct.email || null, address: ct.address || null }, pdfUploadPath: await upload(bytes), pipeline: { value: 14500 },
    channels, messages: Object.fromEntries(channels.map((c) => [c, c === 'whatsapp' ? MSG : 'Dear Anna, please find attached your quotation.'])), ...over };
}

beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await bucket.deleteFiles({ force: true }).catch(() => {});
  Object.assign(meta, { media: [], messages: [], mode: 'ok', uploadMode: 'ok', beforeReply: null });
  mailLog.length = 0; mail.mode = 'ok'; clock = NOW;
  await seed(); await Q.saveSettings(deps, actor, SETTINGS, { nowMs: NOW });
});

// ================================================================ the happy path ======================================
test('the exact stored PDF goes to Meta as ONE document with the text as its caption; the quote is marked Sent through the Phase 6 rules', async () => {
  await seed(P, { inboxStatus: 'booked' });
  const { id } = await make();
  const bytes = pdfBytes('exact');
  const r = await run(D.deliver, await dataFor(id, {}, bytes));
  assert.deepEqual([r.sent, r.status, states(r)], [true, 'sent', [['whatsapp', 'sent']]]);
  const q = await quote(id), v = await version(id), filename = `EliteKitchens-${q.ref}-v1.pdf`;
  assert.equal(meta.media.length, 1);
  assert.deepEqual([meta.media[0].name, meta.media[0].type, meta.media[0].auth], [filename, 'application/pdf', 'Bearer tok']);
  assert.ok(meta.media[0].bytes.equals(bytes));                                                       // the exact stored file, never regenerated
  assert.equal(sha(meta.media[0].bytes), v.pdf.sha256);
  assert.equal(meta.messages.length, 1);                                                              // ONE message, not a text plus a file
  assert.deepEqual(meta.messages[0].body, { messaging_product: 'whatsapp', to: P, type: 'document', document: { id: 'UPMEDIA1', caption: MSG, filename } });
  assert.deepEqual([q.status, (await conv()).inboxStatus, (await contact()).quoteValue], ['sent', 'quoted', 14500]);
  assert.deepEqual(r.committed.stage, { from: 'booked', to: 'quoted', corrected: false });
  const d = await dOf(id, 'whatsapp'); assert.deepEqual([d.state, d.provider, d.message], ['sent', { id: 'wamid.OUT1' }, MSG]);
});

test('it appears in the existing conversation as an outgoing document labelled with the quote, with its own copy of the PDF', async () => {
  const { id } = await make();
  const bytes = pdfBytes('chat copy');
  const before = await conv();
  await run(D.deliver, await dataFor(id, {}, bytes));
  const q = await quote(id), v = await version(id), filename = `EliteKitchens-${q.ref}-v1.pdf`;
  const m = await msgs();
  assert.equal(m.length, 1);
  assert.deepEqual([m[0].id, m[0].direction, m[0].type, m[0].status, m[0].body], ['wamid.OUT1', 'out', 'document', 'sent', MSG]);
  assert.deepEqual(m[0].quote, { id, ref: q.ref, version: 1, deliveryId: (await dOf(id, 'whatsapp')).id });
  assert.deepEqual(m[0].media, { mimeType: 'application/pdf', filename, size: bytes.length, caption: MSG, storagePath: `media/${P}/wamid.OUT1/${filename}`, status: 'stored', waMediaId: 'UPMEDIA1', sha256: sha(bytes) });
  assert.ok((await bucket.file(m[0].media.storagePath).download())[0].equals(bytes));                // the chat's copy
  assert.ok((await bucket.file(v.pdf.path).download())[0].equals(bytes));                            // and the quote's own, untouched
  const c = await conv();
  assert.deepEqual([c.lastMessageType, c.lastMessageDirection, c.lastMessage], ['document', 'out', MSG]);
  assert.equal(c.lastInboundAt.toMillis(), before.lastInboundAt.toMillis()); assert.equal(c.unreadCount, 2);
  const url = await h.mediaUrl(staff, { phone: P, id: 'wamid.OUT1' }, deps);                          // staff open it with the existing viewer
  assert.equal(url.filename, filename); assert.ok(Buffer.from(url.url.split(',')[1], 'base64').equals(bytes));
});

test('a delivery status from Meta (delivered, read) reaches the document through the existing webhook code', async () => {
  const { id } = await make();
  await run(D.deliver, await dataFor(id));
  await store.applyStatus(db, { wamid: 'wamid.OUT1', phone: P, status: 'delivered', error: null });
  await store.applyStatus(db, { wamid: 'wamid.OUT1', phone: P, status: 'read', error: null });
  assert.equal((await msgs())[0].status, 'read');
});

// ============================================== the 24-hour window is re-checked by the SERVER =============================
test('window closed when sending: nothing is uploaded or sent, nothing is marked sent, and the words say to reopen the conversation', async () => {
  await seed(P, { inboxStatus: 'booked', lastInboundAt: Timestamp.fromMillis(NOW - 30 * H) });
  const { id } = await make();
  const r = await run(D.deliver, await dataFor(id));
  assert.deepEqual([r.sent, r.status, states(r)], [false, 'draft', [['whatsapp', 'failed']]]);
  assert.deepEqual(r.deliveries[0].error, { code: 'window_closed', text: WINDOW_CLOSED });
  assert.match(WINDOW_CLOSED, /Reopen the conversation first.*until the customer replies/);
  assert.deepEqual([meta.media.length, meta.messages.length], [0, 0]);                                // no document, no upload, nothing
  assert.deepEqual([(await conv()).inboxStatus, (await quote(id)).sentVersion], ['booked', null]);   // CRM untouched
  assert.equal((await msgs()).length, 0);
});

test('the window closes between opening the dialog and sending: the server says no (it never relies on what the browser showed)', async () => {
  await seed(P, { lastInboundAt: Timestamp.fromMillis(NOW - 24 * H + 1 * MIN) });                     // one minute left when the dialog opened
  const { id } = await make();
  const data = await dataFor(id);
  clock = NOW + 5 * MIN;                                                                              // ...and it has closed by the time Send reaches the server
  const r = await run(D.deliver, data);
  assert.deepEqual([r.sent, states(r), r.deliveries[0].error.code], [false, [['whatsapp', 'failed']], 'window_closed']);
  assert.deepEqual([meta.media.length, meta.messages.length], [0, 0]);
  assert.equal((await quote(id)).status, 'draft');
});

test('Meta itself refusing for the window (131047, after our check passed) is a plain failure: no document, nothing marked sent', async () => {
  const { id } = await make();
  meta.mode = 'window';
  const r = await run(D.deliver, await dataFor(id));
  assert.deepEqual([r.sent, states(r), r.deliveries[0].error.code], [false, [['whatsapp', 'failed']], '131047']);
  assert.equal(r.deliveries[0].error.text, WINDOW_CLOSED);
  assert.equal((await msgs()).length, 0); assert.equal((await quote(id)).status, 'draft');
  assert.equal(meta.media.length, 1);                                                                 // the PDF was handed over, the message was refused
});

test('after a Reopen the window is NOT open until the customer replies: the send is refused while waiting, and goes once they reply', async () => {
  await seed(P, { inboxStatus: 'booked', lastInboundAt: Timestamp.fromMillis(NOW - 30 * H) });
  const { id } = await make();
  const reopenDeps = { db, wa, cfg };
  const ro = await R.reopen(reopenDeps, actor, { phone: P, requestId: rid() }, { nowMs: NOW });        // M1: the approved template, sent
  assert.equal(ro.state, 'sent'); assert.equal(meta.messages.at(-1).body.type, 'template');
  const sentBefore = meta.messages.length;
  const waiting = await run(D.deliver, await dataFor(id));
  assert.deepEqual([waiting.sent, waiting.deliveries[0].error.code, waiting.deliveries[0].error.text], [false, 'awaiting_reply', AWAITING]);
  assert.equal(meta.messages.length, sentBefore); assert.equal(meta.media.length, 0);                 // the template did not open anything
  assert.equal((await quote(id)).status, 'draft'); assert.equal((await conv()).inboxStatus, 'booked');
  // the CUSTOMER replies (the same code the webhook uses): now it can go
  await store.storeInbound(db, { wamid: 'wamid.IN1', from: P, name: 'Anna Murphy', type: 'button', body: 'Go ahead', media: null, createdAt: new Date(NOW + 2 * MIN) });
  clock = NOW + 3 * MIN;
  const retried = await run(D.retry, { id, deliveryId: waiting.deliveries[0].id });
  assert.deepEqual([retried.sent, states(retried)], [true, [['whatsapp', 'sent']]]);
  assert.equal(docs().length, 1); assert.deepEqual([(await quote(id)).status, (await conv()).inboxStatus], ['sent', 'quoted']);
});

test('a customer who has never messaged (added by phone) or has no conversation cannot be sent a WhatsApp document', async () => {
  await store.createCustomer(db, R2, { name: 'Walk In', email: 'walk@example.com' }, actor);
  const { id } = await make(R2);
  const r = await run(D.deliver, await dataFor(id));
  assert.deepEqual([r.sent, r.deliveries[0].error.code], [false, 'window_closed']);
  await db.recursiveDelete(db.doc('conversations/' + R2));
  const { id: id2 } = await make(R2).catch(() => ({ id: null }));
  assert.equal(id2, null);                                                                            // no conversation: no quote can even be made
  assert.equal(meta.messages.length, 0);
});

// ================================================== every way Meta can fail =================================================
test('Meta refuses the message (4xx): a failure in plain words; nothing in the chat; safe to retry', async () => {
  const { id } = await make();
  meta.mode = 'refuse';
  const r = await run(D.deliver, await dataFor(id));
  assert.deepEqual([r.sent, states(r), r.deliveries[0].error.code], [false, [['whatsapp', 'failed']], '131026']);
  assert.match(r.deliveries[0].error.text, /can't deliver to this number.*131026/);
  assert.ok(!r.deliveries[0].error.text.includes('353851111111'));                                    // Meta's own wording (which held the number) is not stored
  assert.equal((await msgs()).length, 0); assert.equal((await quote(id)).status, 'draft');
  meta.mode = 'ok';
  const again = await run(D.retry, { id, deliveryId: r.deliveries[0].id });
  assert.deepEqual([again.sent, states(again)], [true, [['whatsapp', 'sent']]]); assert.equal(docs().length, 2);   // the refused attempt, then the one that went
});

test('the PDF upload failing (4xx, 5xx or no connection) is a failure that is safe to retry: no message was ever attempted', async () => {
  for (const [i, mode] of ['refuse', 'server', 'network'].entries()) {
    const p = '35386100000' + i; await seed(p);
    meta.uploadMode = mode; meta.messages.length = 0;
    const { id } = await make(p);
    const r = await run(D.deliver, await dataFor(id));
    assert.deepEqual([r.sent, states(r), r.deliveries[0].error.code], [false, [['whatsapp', 'failed']], 'upload_failed'], mode);
    assert.match(r.deliveries[0].error.text, /Nothing was sent/); assert.equal(meta.messages.length, 0, mode);
  }
  meta.uploadMode = 'ok';
});

test('an answer we cannot confirm (Meta 5xx, no message id, no connection, no answer in time) is "not confirmed": never resent by itself', async () => {
  let i = 0;
  for (const mode of ['server', 'noid', 'network', 'hang']) {
    const p = '35386200000' + (++i); await seed(p);
    meta.mode = mode; meta.messages.length = 0;
    const { id } = await make(p);
    const r = await run(D.deliver, await dataFor(id));
    assert.deepEqual([r.sent, states(r), r.deliveries[0].error.code, r.deliveries[0].error.text], [false, [['whatsapp', 'unknown']], 'not_confirmed', D.NOT_CONFIRMED], mode);
    assert.equal((await quote(id)).status, 'draft', mode); assert.equal((await conv(p)).inboxStatus, undefined, mode);
    meta.mode = 'ok';
    await rejects(run(D.retry, { id, deliveryId: r.deliveries[0].id }), 'failed-precondition', /could not confirm/);
    assert.equal(meta.messages.length, 1, mode);                                                        // exactly the one attempt
    const did = r.deliveries[0].id;
    const settled = await run(D.resolve, { id, deliveryId: did, outcome: 'delivered' });              // staff checked WhatsApp: it did arrive
    assert.deepEqual([settled.sent, states(settled)], [true, [['whatsapp', 'sent']]], mode);
    assert.equal(meta.messages.length, 1, mode);                                                        // settling sends nothing
  }
});

test('Meta accepted the message but we cannot record it in the chat: the delivery is still a success', async () => {
  const { id } = await make();
  meta.beforeReply = async () => { const prep = (await version(id)).prepared; await bucket.file(prep.pdf.path).delete(); };   // the chat copy cannot be made
  const r = await run(D.deliver, await dataFor(id));
  assert.deepEqual([r.sent, states(r)], [true, [['whatsapp', 'sent']]]);
  const m = await msgs();
  assert.equal(m.length, 1); assert.deepEqual([m[0].media.status, m[0].media.storagePath], ['failed', null]); assert.match(m[0].media.error, /still on the quote|could not be made/);
  assert.equal(docs().length, 1);
});

// ================================================== one request, one WhatsApp message =====================================
test('a double click and simultaneous requests send ONE document', async () => {
  const { id } = await make();
  const data = await dataFor(id);
  const rs = await Promise.allSettled([1, 2, 3, 4, 5].map(() => run(D.deliver, data)));
  assert.ok(rs.some((x) => x.status === 'fulfilled'));
  for (const x of rs.filter((x) => x.status === 'rejected')) assert.match(x.reason.message, /PDF upload was not found/);
  assert.equal(docs().length, 1); assert.equal(meta.media.length, 1); assert.equal((await msgs()).length, 1);
  const again = await run(D.deliver, data);                                                           // a refresh: the same request once more
  assert.equal(docs().length, 1); assert.equal(again.sent, true);
});

test('two staff pressing Send, and a stale tab, cannot send a second copy', async () => {
  const { id } = await make();
  const a = await dataFor(id), b = await dataFor(id, {}, pdfBytes('second tab'));                      // two tabs, two different requests, the same revision
  const rs = await Promise.allSettled([run(D.deliver, a), run(D.deliver, b)]);
  assert.equal(rs.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(rs.find((x) => x.status === 'rejected').reason.code, 'failed-precondition');
  assert.equal(docs().length, 1);
  const stale = await dataFor(id, { expectedRev: 1 });                                                // a tab that has not seen the change
  await rejects(run(D.deliver, stale), 'failed-precondition');
  assert.equal(docs().length, 1);
});

// ======================================== independent channels, with the real WhatsApp one ================================
test('WhatsApp sent and email failed: WhatsApp stays sent, and retrying email does NOT touch WhatsApp', async () => {
  const { id } = await make();
  mail.mode = 'refuse';
  const r = await run(D.deliver, await dataFor(id, { channels: ['whatsapp', 'email'] }));
  assert.deepEqual(states(r), [['whatsapp', 'sent'], ['email', 'failed']]); assert.equal(r.sent, true);
  mail.mode = 'ok';
  const r2 = await run(D.retry, { id, deliveryId: r.deliveries[1].id });
  assert.deepEqual(states(r2), [['whatsapp', 'sent'], ['email', 'sent']]);
  assert.equal(docs().length, 1); assert.equal(meta.media.length, 1); assert.equal(mailLog.length, 2);
});

test('email sent and WhatsApp failed (window closed): the quote is Sent by email; once the customer replies WhatsApp alone is retried', async () => {
  await seed(P, { lastInboundAt: Timestamp.fromMillis(NOW - 30 * H) });
  const { id } = await make();
  const r = await run(D.deliver, await dataFor(id, { channels: ['whatsapp', 'email'] }));
  assert.deepEqual(states(r), [['whatsapp', 'failed'], ['email', 'sent']]); assert.deepEqual([r.sent, r.status], [true, 'sent']);
  assert.equal((await quote(id)).history.at(-1).via, 'email');
  await store.storeInbound(db, { wamid: 'wamid.IN2', from: P, name: 'Anna Murphy', type: 'text', body: 'Hello', media: null, createdAt: new Date(NOW + MIN) });
  clock = NOW + 2 * MIN;
  const r2 = await run(D.retry, { id, deliveryId: r.deliveries[0].id });
  assert.deepEqual(states(r2), [['whatsapp', 'sent'], ['email', 'sent']]);
  assert.equal(mailLog.length, 1);                                                                    // the email was not sent again
  assert.equal((await quote(id)).history.filter((x) => x.action === 'sent').length, 1);
});

// ===================================================== the right PDF to the right customer ================================
test('each customer gets their own quote\'s PDF; one customer\'s PDF is never sent to another', async () => {
  await seed(R2, {}, 'Brian Byrne');
  const a = (await make(P)).id, b = (await make(R2)).id;
  const pa = pdfBytes('ANNA ONLY'), pb = pdfBytes('BRIAN ONLY');
  await run(D.deliver, await dataFor(a, {}, pa));
  await run(D.deliver, await dataFor(b, {}, pb));
  assert.deepEqual(meta.messages.map((m) => m.body.to), [P, R2]);
  assert.ok(meta.media[0].bytes.equals(pa)); assert.ok(meta.media[1].bytes.equals(pb));
  assert.deepEqual((await msgs(P)).map((m) => m.media.sha256), [sha(pa)]); assert.deepEqual((await msgs(R2)).map((m) => m.media.sha256), [sha(pb)]);
  assert.ok(!(await files(`media/${R2}/`)).some((f) => f.includes('ANNA')));
});

test('a revised quote: PDF v1 stays exactly as the customer received it, and v2 is a new document in the chat', async () => {
  const { id } = await make();
  const v1 = pdfBytes('version one'), v2 = pdfBytes('version two');
  await run(D.deliver, await dataFor(id, {}, v1));
  const p1 = (await version(id, 1)).pdf.path;
  await Q.revise(deps, actor, { id, expectedRev: (await quote(id)).rev }, { nowMs: NOW });
  await run(D.deliver, await dataFor(id, {}, v2));
  assert.ok((await bucket.file(p1).download())[0].equals(v1));
  assert.deepEqual((await msgs()).map((m) => [m.quote.version, m.media.sha256]).sort(), [[1, sha(v1)], [2, sha(v2)]]);
  assert.deepEqual(meta.media.map((m) => m.name), [`EliteKitchens-${(await quote(id)).ref}-v1.pdf`, `EliteKitchens-${(await quote(id)).ref}-v2.pdf`]);
  assert.deepEqual((await deliveries(id)).map((d) => [d.version, d.state]), [[1, 'sent'], [2, 'sent']]);
});

test('a quote Phase 6 already marked sent by hand can be sent by WhatsApp later: its stored PDF goes out, the quote record is unchanged', async () => {
  const { id } = await make();
  const d0 = await dataFor(id); delete d0.channels; delete d0.messages;
  await Q.send(deps, actor, d0, { nowMs: NOW, uid: 'u1' });
  const before = await quote(id), stored = (await bucket.file((await version(id)).pdf.path).download())[0];
  const r = await run(D.deliver, { id, version: 1, requestId: rid(), channels: ['whatsapp'], messages: { whatsapp: MSG } });
  assert.deepEqual([r.sent, states(r), r.committed], [true, [['whatsapp', 'sent']], null]);
  assert.ok(meta.media[0].bytes.equals(stored)); assert.deepEqual(await quote(id), before);
  assert.deepEqual((await msgs()).map((m) => m.quote.version), [1]);
});

test('re-sending an OLDER version by WhatsApp sends that version\'s own PDF, never the newest one', async () => {
  const { id } = await make();
  const v1 = pdfBytes('version one'), v2 = pdfBytes('version two');
  const d1 = await dataFor(id, {}, v1); delete d1.channels; delete d1.messages; await Q.send(deps, actor, d1, { nowMs: NOW, uid: 'u1' });
  await Q.revise(deps, actor, { id, expectedRev: (await quote(id)).rev }, { nowMs: NOW });
  const d2 = await dataFor(id, {}, v2); delete d2.channels; delete d2.messages; await Q.send(deps, actor, d2, { nowMs: NOW, uid: 'u1' });
  const r = await run(D.deliver, { id, version: 1, requestId: rid(), channels: ['whatsapp'], messages: { whatsapp: MSG } });
  assert.equal(r.sent, true);
  assert.ok(meta.media[0].bytes.equals(v1)); assert.ok(!meta.media[0].bytes.equals(v2));
  assert.match(meta.media[0].name, /-v1\.pdf$/); assert.deepEqual((await msgs()).map((m) => m.quote.version), [1]);
});

test('an expired quote can still be sent again by WhatsApp (Phase 6: an expired quote is not dead)', async () => {
  const { id } = await make();
  const d0 = await dataFor(id); delete d0.channels; delete d0.messages;
  await Q.send(deps, actor, d0, { nowMs: NOW, uid: 'u1' });
  const later = NOW + 40 * 24 * H; clock = later;
  await seed(P, { lastInboundAt: Timestamp.fromMillis(later - H) });
  assert.equal(Q.isExpired(await quote(id), later), true);
  const r = await run(D.deliver, { id, version: 1, requestId: rid(), channels: ['whatsapp'], messages: { whatsapp: MSG } }, later);
  assert.equal(r.sent, true); assert.equal(docs().length, 1);
});

test('a Closed customer is moved to Quoted only if staff ticked "Reopen", exactly as with Phase 6\'s send', async () => {
  await seed(P, { inboxStatus: 'closed' }); await seed(R2, { inboxStatus: 'closed' }, 'Brian Byrne');
  const a = (await make(P)).id, b = (await make(R2)).id;
  await run(D.deliver, await dataFor(a, { pipeline: {} }));
  await run(D.deliver, await dataFor(b, { pipeline: { reopen: true } }));
  assert.deepEqual([(await conv(P)).inboxStatus, (await conv(R2)).inboxStatus], ['closed', 'quoted']);
});

// ================================================================== limits, privacy, erasure ===============================
test('the caption is limited to what WhatsApp allows (1,024 characters), and an empty message is refused', async () => {
  const { id } = await make();
  await rejects(run(D.deliver, await dataFor(id, { messages: { whatsapp: 'x'.repeat(1025) } })), 'invalid-argument', /too long \(max 1024/);
  await rejects(run(D.deliver, await dataFor(id, { messages: { whatsapp: '   ' } })), 'invalid-argument', /Write the message/);
  const ok = await run(D.deliver, await dataFor(id, { messages: { whatsapp: 'x'.repeat(1024) } }));
  assert.equal(ok.sent, true); assert.equal(meta.messages[0].body.document.caption.length, 1024);
});

test('logs and stored errors never hold names, numbers, addresses or the message text', async () => {
  const seen = [], orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => seen.push(a.join(' ')); console.error = (...a) => seen.push(a.join(' ')); console.warn = (...a) => seen.push(a.join(' '));
  let errors;
  try {
    let i = 0;
    for (const [up, mode] of [['refuse', 'ok'], ['ok', 'refuse'], ['ok', 'server'], ['ok', 'network'], ['ok', 'window'], ['ok', 'ok']]) {
      const p = '35386300000' + (++i); await seed(p);
      meta.uploadMode = up; meta.mode = mode;
      const { id } = await make(p);
      await run(D.deliver, await dataFor(id, {}, pdfBytes('x' + i)));
    }
    errors = JSON.stringify((await db.collectionGroup('deliveries').get()).docs.map((d) => d.data().error));
  } finally { Object.assign(console, orig); }
  const text = seen.join('\n') + errors;
  assert.ok(seen.length >= 4, 'something was logged');
  for (const secret of ['3538630', '353851111111', 'Anna', 'Murphy', 'anna@example.com', 'quotation', 'Main Street']) assert.ok(!text.includes(secret), 'leaked: ' + secret);
});

test('deleting the customer erases the document in the chat, their quote PDFs and the delivery records', async () => {
  const { id } = await make();
  await run(D.deliver, await dataFor(id));
  assert.equal((await files(`media/${P}/`)).length, 1); assert.equal((await files(`quotes/${P}/`)).length, 1);
  await h.deleteCustomer(staff, { phone: P, confirm: '1111' }, deps);
  assert.deepEqual(await files('media/'), []); assert.deepEqual(await files('quotes/'), []);
  assert.equal((await db.collectionGroup('deliveries').get()).size, 0);
  assert.equal((await db.collection(`conversations/${P}/messages`).get()).size, 0);
});
