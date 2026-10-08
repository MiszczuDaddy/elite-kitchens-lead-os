// Phase 6.1 M2: the delivery foundation (docs/PHASE6_1_PLAN.md). Real Firestore + Storage emulators and FAKE channels (no real
// message or email is ever sent): a channel can succeed, refuse, fail ambiguously, crash or hang. Every name, number and price below
// is made up.
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

const PROJECT = 'demo-leados';
const BUCKET = 'demo-leados.firebasestorage.app';
initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
const db = getFirestore();
const bucket = getStorage().bucket(BUCKET);
const cfg = { allowedEmails: 'thomas@example.com' };
const staff = { uid: 'u1', token: { email: 'thomas@example.com', email_verified: true, staff: true } };
const actor = { kind: 'staff', id: 'thomas@example.com' };
const rejects = (p, code, msg) => assert.rejects(p, (e) => e.code === code && (!msg || msg.test(e.message)), `expected ${code}${msg ? ' ' + msg : ''}`);

const MIN = 60 * 1000, DAY = 24 * 60 * MIN;
const NOW = Date.UTC(2026, 9, 2, 9, 0);                       // Friday 2 Oct 2026, 10:00 in Dublin
const P = '353851111111', R = '353852222222';
const ph = (i) => '35386' + String(1000000 + i);
const pdfBytes = (tag = 'one') => Buffer.from(`%PDF-1.4\n% Elite OS test quote ${tag}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const PRICE_LIST = {
  options: { ess: { perDoor: 110, perTopBox: 60 }, prem: { perDoor: 140, perTopBox: 65 }, pp: { perDoor: 150, perTopBox: 70 } },
  drawerBoxes: { cemux: 12, blum: 21 }, glazing: { small: 45, large: 90 },
  extras: [{ key: 'bin', name: 'Pull-out bin', unit: 'per unit', price: 30 }],
};
const SETTINGS = { priceList: PRICE_LIST, vatRate: 13.5, validityDays: 30,
  business: { tradingName: 'Elite Kitchens', signatureName: 'Test Person', phone: '01 000 0000', email: 'quotes@example.com', web: 'www.example.com', address: 'Test Street, Dublin', vatNumber: 'IE0000000X' } };

// ---- fake channels ----
const sendOrder = [];
function fakeChannel(id, maxMessage) {
  const c = { id, maxMessage, calls: [], mode: 'ok', hold: null, checkResult: null,
    reset() { this.calls = []; this.mode = 'ok'; this.hold = null; this.checkResult = null; },
    async check() { return this.checkResult; },
    async send(ctx) {
      this.calls.push(ctx); sendOrder.push(id);
      if (this.hold) await this.hold();
      if (this.mode === 'refuse') throw new D.ChannelError('The channel refused it.', { code: 'refused', definite: true });
      if (this.mode === 'unsure') throw new D.ChannelError('The provider answered with an error.', { code: 'provider_5xx', definite: false });
      if (this.mode === 'crash') throw new Error('socket hang up while sending to 353851111111 for Anna Murphy: Hi Anna, your quote is attached.');
      return { providerId: `${id}-msg-${this.calls.length}` };
    } };
  return c;
}
const wa = fakeChannel('whatsapp', 1024), mail = fakeChannel('email', 5000);
const deps = { db, cfg, bucket };                                      // for the Phase 6 quote functions
const dd = { db, cfg, bucket, channels: { whatsapp: wa, email: mail } };
const MSG = { whatsapp: 'Hi Anna, please find attached your quotation.', email: 'Dear Anna, please find attached your quotation.' };

let seq = 0;
const rid = () => 'req-' + (++seq) + '-abcdefgh';
const run = (fn, data, nowMs = NOW) => fn(dd, actor, data, { nowMs, uid: 'u1' });
const conv = async (p = P) => (await db.doc('conversations/' + p).get()).data();
const contact = async (p = P) => (await db.doc('contacts/' + p).get()).data();
const quote = async (id) => (await db.doc('quotes/' + id).get()).data();
const version = async (id, n = 1) => (await db.doc(`quotes/${id}/versions/${n}`).get()).data();
const settingsDoc = async () => (await db.doc('quoteSettings/current').get()).data();
const files = async (prefix) => (await bucket.getFiles({ prefix }))[0].map((f) => f.name);
const deliveries = async (id) => (await db.collection(`quotes/${id}/deliveries`).get()).docs.map((d) => ({ id: d.id, ...d.data() }))
  .sort((a, b) => (a.version - b.version) || (D.CHANNEL_ORDER.indexOf(a.channel) - D.CHANNEL_ORDER.indexOf(b.channel)));
const dOf = async (id, channel) => (await deliveries(id)).find((d) => d.channel === channel);
const states = (r) => r.deliveries.map((d) => [d.channel, d.state]);
async function seed(p = P, convExtra = {}, name = 'Anna Murphy', contactExtra = {}) {
  await db.doc('contacts/' + p).set({ phone: p, name, email: 'anna@example.com', address: '1 Main Street, Swords', location: 'Swords', createdAt: Timestamp.now(), ...contactExtra });
  await db.doc('conversations/' + p).set({ phone: p, name, createdAt: Timestamp.now(), updatedAt: Timestamp.now(), lastMessage: 'Hi', unreadCount: 2, ...convExtra });
}
const setup = () => Q.saveSettings(deps, actor, SETTINGS, { nowMs: NOW });
function answers(patch = {}) {
  const a = QE.current().newAnswers(PRICE_LIST);
  a.doors = 10; a.drawers = 4; a.options.ess.drawerBox = 'cemux';
  a.options.prem = { ...a.options.prem, on: true, drawerBox: 'blum' };
  return Object.assign(a, patch);
}
async function upload(bytes) {
  const p = `uploads/u1/${Date.now()}-${++seq}-quote.pdf`;
  await bucket.file(p).save(bytes, { contentType: 'application/pdf' });
  return p;
}
const make = (p = P) => Q.create(deps, actor, { phone: p, requestId: rid(), answers: answers() }, { nowMs: NOW });
// What the browser sends to deliverQuote for a draft: Phase 6's sendQuote fields plus channels and messages.
async function dataFor(id, over = {}, nowMs = NOW, bytes = pdfBytes(String(seq))) {
  const qq = await quote(id), s = await settingsDoc();
  const ct = (await db.doc('contacts/' + qq.phone).get()).data() || {}, cv = await conv(qq.phone);
  const channels = over.channels || ['whatsapp'];
  return { id, expectedRev: qq.rev, requestId: rid(), issueDate: Q.dublinDate(nowMs), settingsRev: s.rev,
    customer: { name: ct.name || cv.name || null, email: ct.email || null, address: ct.address || null }, pdfUploadPath: await upload(bytes), pipeline: { value: 14500 },
    channels, messages: Object.fromEntries(channels.map((c) => [c, MSG[c]])), ...over };
}
const manualOf = async (id, over = {}) => { const d = await dataFor(id, over); delete d.channels; delete d.messages; return d; };
// Prepare a send that every channel refuses: the draft is then locked, with a failed WhatsApp delivery.
async function failed(p = P, over = {}) {
  wa.mode = 'refuse';
  const { id } = await make(p);
  const data = await dataFor(id, over);
  const r = await run(D.deliver, data);
  wa.mode = 'ok';
  return { id, data, r };
}

beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await bucket.deleteFiles({ force: true }).catch(() => {});
  wa.reset(); mail.reset(); sendOrder.length = 0;
  await seed(); await setup();
});

// ================================================= nothing is "sent" until a channel confirms =============================
test('a send where every channel fails marks NOTHING sent: status, stage and value stay as they were; the draft is locked; the PDF is stored', async () => {
  await seed(P, { inboxStatus: 'booked' }, 'Anna Murphy', { quoteValue: 9000 });
  const beforeConv = await conv(), beforeContact = await contact();
  const { id, r } = await failed();
  assert.deepEqual([r.sent, r.status, r.committed], [false, 'draft', null]);
  assert.deepEqual(states(r), [['whatsapp', 'failed']]);
  const q = await quote(id);
  assert.deepEqual([q.status, q.sentVersion, q.draftVersion, q.lastSendRequestId, q.sent, q.sentAt], ['draft', null, 1, null, null, null]);
  assert.deepEqual(q.preparedSend, { version: 1, requestId: r.requestId });
  assert.deepEqual(q.history.map((x) => x.action), ['created', 'send started']);
  assert.deepEqual(q.pipelineChanges, []);
  const v = await version(id);
  assert.equal(v.state, 'draft'); assert.equal(v.pdf, undefined); assert.equal(v.sentAt, undefined);
  assert.equal(v.prepared.requestId, r.requestId); assert.ok((await bucket.file(v.prepared.pdf.path).exists())[0]);
  assert.deepEqual(await conv(), beforeConv); assert.deepEqual(await contact(), beforeContact);       // no stage move, no value change
  const d = await dOf(id, 'whatsapp');
  assert.deepEqual([d.state, d.attempts, d.error.code, d.error.text], ['failed', 1, 'refused', 'The channel refused it.']);
  assert.equal(d.provider, null); assert.equal(d.sentAt, null); assert.ok(d.failedAt);
});

test('the first channel to confirm marks the quote Sent through the SAME rules as Phase 6: the exact PDF, the frozen details, the pipeline', async () => {
  await seed(P, { inboxStatus: 'booked' }, 'Anna Murphy', { quoteValue: 9000 });
  const { id } = await make();
  const bytes = pdfBytes('exact');
  const data = await dataFor(id, {}, NOW, bytes);
  const r = await run(D.deliver, data);
  assert.deepEqual([r.sent, r.status, r.sentVersion, r.draftVersion], [true, 'sent', 1, null]);
  assert.deepEqual(r.committed, { stage: { from: 'booked', to: 'quoted', corrected: false }, value: { from: 9000, to: 14500 } });
  const q = await quote(id), v = await version(id);
  assert.deepEqual([q.status, q.sentVersion, q.draftVersion, q.lastSendRequestId, q.preparedSend], ['sent', 1, null, data.requestId, undefined]);
  assert.deepEqual(q.history.map((x) => x.action), ['created', 'send started', 'sent']);
  assert.equal(q.history[2].via, 'whatsapp');
  assert.equal(q.validUntil, Q.addDays(Q.dublinDate(NOW), 30));
  assert.deepEqual(q.pipelineChanges.map((c) => [c.action, c.stage, c.value]), [['sent', { from: 'booked', to: 'quoted', corrected: false }, { from: 9000, to: 14500 }]]);
  assert.equal(v.state, 'sent'); assert.equal(v.prepared, undefined);
  assert.deepEqual(v.customer, { name: 'Anna Murphy', email: 'anna@example.com', address: '1 Main Street, Swords', phone: P });
  assert.deepEqual(v.business, SETTINGS.business);
  assert.deepEqual(v.pdf, { path: v.pdf.path, size: bytes.length, sha256: sha(bytes) });
  const [stored] = await bucket.file(v.pdf.path).download(); assert.ok(stored.equals(bytes));        // the exact file, kept
  assert.equal((await bucket.file(data.pdfUploadPath).exists())[0], false);                              // the temporary upload is gone
  assert.deepEqual([(await conv()).inboxStatus, (await contact()).quoteValue], ['quoted', 14500]);
  const d = await dOf(id, 'whatsapp');
  assert.deepEqual([d.state, d.attempts, d.provider, d.message], ['sent', 1, { id: 'whatsapp-msg-1' }, MSG.whatsapp]);
  assert.deepEqual(d.pdf, v.pdf); assert.deepEqual(d.history.map((x) => x.event), ['queued', 'sending', 'sent']);
  assert.equal(wa.calls.length, 1);
  const c = wa.calls[0];                                                                                  // what the channel was given
  assert.ok(c.pdf.bytes.equals(bytes)); assert.equal(c.pdf.sha256, sha(bytes));
  assert.deepEqual([c.message, c.phone, c.version, c.channel, c.to, c.filename], [MSG.whatsapp, P, 1, 'whatsapp', null, `EliteKitchens-${q.ref}-v1.pdf`]);
});

test('marking Sent through a channel gives exactly the same result as marking it sent by hand, for every stage and every value choice', async () => {
  const norm = async (id) => {
    const q = await quote(id), v = await version(id), c = await conv(q.phone), ct = await contact(q.phone);
    const { phone, ...customer } = v.customer;
    return { status: q.status, cur: q.currentVersion, sentV: q.sentVersion, draftV: q.draftVersion, validUntil: q.validUntil, sent: q.sent, summary: q.summary, name: q.customerName,
      pipe: q.pipelineChanges.map((x) => [x.action, x.version, x.stage, x.value]), hist: q.history.map((x) => x.action).filter((a) => a !== 'send started'),
      v: { state: v.state, issueDate: v.issueDate, validUntil: v.validUntil, customer, business: v.business, sheet: v.sheet },
      conv: { st: c.inboxStatus, move: c.lastMove ? [c.lastMove.from, c.lastMove.to] : null, quotedAt: !!(c.stageDates && c.stageDates.quoted) }, value: ct.quoteValue };
  };
  let i = 0;
  for (const stage of ['inbox', 'booked', 'quoted', 'won', 'closed']) {
    for (const pipe of [{ value: 14500 }, {}, { value: 9000 }, ...(stage === 'closed' ? [{ reopen: true, value: 14500 }, { reopen: true }] : [])]) {
      const a = ph(++i), b = ph(++i), extra = stage === 'inbox' ? {} : { inboxStatus: stage }, ct = { quoteValue: 9000 };
      await seed(a, extra, 'Anna Murphy', ct); await seed(b, extra, 'Anna Murphy', ct);
      const qa = (await make(a)).id, qb = (await make(b)).id;
      const m = await Q.send(deps, actor, await manualOf(qa, { pipeline: pipe }), { nowMs: NOW, uid: 'u1' });
      const r = await run(D.deliver, await dataFor(qb, { pipeline: pipe }));
      assert.equal(r.sent, true);
      assert.deepEqual(await norm(qb), await norm(qa), `${stage} ${JSON.stringify(pipe)}`);
      assert.deepEqual(r.committed, { stage: m.stage, value: m.value }, `${stage} ${JSON.stringify(pipe)} (answer)`);
    }
  }
});

test('two channels that both confirm: both are recorded, the quote is committed ONCE, in the order WhatsApp then email', async () => {
  const { id } = await make();
  const r = await run(D.deliver, await dataFor(id, { channels: ['email', 'whatsapp'] }));         // the order asked for does not matter
  assert.deepEqual(states(r), [['whatsapp', 'sent'], ['email', 'sent']]); assert.equal(r.sent, true);
  assert.deepEqual(sendOrder, ['whatsapp', 'email']);
  const q = await quote(id);
  assert.deepEqual(q.history.map((x) => x.action), ['created', 'send started', 'sent']); assert.equal(q.pipelineChanges.length, 1);
  assert.equal(q.history[2].via, 'whatsapp');                                                      // the first to confirm
  assert.deepEqual(mail.calls[0].to, { email: 'anna@example.com' });
  assert.ok(mail.calls[0].pdf.bytes.equals(wa.calls[0].pdf.bytes));                                // the same PDF to both
});

// ============================================= channels are independent; retry only what failed ===========================
test('WhatsApp succeeds and email fails: the quote is Sent; retrying sends ONLY the email, and nothing is committed twice', async () => {
  const { id } = await make();
  mail.mode = 'refuse';
  const r = await run(D.deliver, await dataFor(id, { channels: ['whatsapp', 'email'] }));
  assert.deepEqual(states(r), [['whatsapp', 'sent'], ['email', 'failed']]); assert.deepEqual([r.sent, r.status], [true, 'sent']);
  assert.deepEqual([wa.calls.length, mail.calls.length], [1, 1]);
  const em = r.deliveries[1];
  mail.mode = 'ok';
  const r2 = await run(D.retry, { id, deliveryId: em.id });
  assert.deepEqual(states(r2), [['whatsapp', 'sent'], ['email', 'sent']]);
  assert.deepEqual([wa.calls.length, mail.calls.length], [1, 2]);                                  // WhatsApp was NOT sent again
  const q = await quote(id);
  assert.equal(q.history.filter((x) => x.action === 'sent').length, 1); assert.equal(q.pipelineChanges.length, 1);
  assert.equal(r2.committed, null);
  const d = await dOf(id, 'email'); assert.deepEqual([d.attempts, d.history.map((x) => x.event)], [2, ['queued', 'sending', 'failed', 'sending', 'sent']]);
  await rejects(run(D.retry, { id, deliveryId: em.id }), 'failed-precondition', /already delivered/);       // a delivered channel cannot be retried
  assert.deepEqual([wa.calls.length, mail.calls.length], [1, 2]);
});

test('every channel fails: nothing is committed and the draft stays locked; one retry that succeeds then commits', async () => {
  const { id } = await make();
  wa.mode = 'refuse'; mail.mode = 'refuse';
  const r = await run(D.deliver, await dataFor(id, { channels: ['whatsapp', 'email'] }));
  assert.deepEqual(states(r), [['whatsapp', 'failed'], ['email', 'failed']]); assert.deepEqual([r.sent, r.status], [false, 'draft']);
  wa.mode = 'ok';
  const r2 = await run(D.retry, { id, deliveryId: r.deliveries[0].id });
  assert.deepEqual(states(r2), [['whatsapp', 'sent'], ['email', 'failed']]); assert.deepEqual([r2.sent, r2.status], [true, 'sent']);
  assert.deepEqual(r2.committed.stage, { from: 'inbox', to: 'quoted', corrected: false });
  assert.equal(mail.calls.length, 1);                                                                // the failed email was not retried by the other retry
  assert.equal((await quote(id)).preparedSend, undefined);
});

test('a retry can carry an edited message', async () => {
  const { id, r } = await failed();
  await run(D.retry, { id, deliveryId: r.deliveries[0].id, message: 'A different text for Anna.' });
  assert.equal(wa.calls.at(-1).message, 'A different text for Anna.'); assert.equal((await dOf(id, 'whatsapp')).message, 'A different text for Anna.');
  await seed(R, {}, 'Brian Byrne');
  const f2 = await failed(R);
  for (const bad of ['', '   ', 'x'.repeat(1025)]) await rejects(run(D.retry, { id: f2.id, deliveryId: f2.r.deliveries[0].id, message: bad }), 'invalid-argument');
});

// ============================================================= one request, one send =====================================
test('the same request again sends nothing: a double click, or a retry after a timeout (sequentially, and all at once)', async () => {
  const { id } = await make();
  mail.mode = 'refuse';
  const data = await dataFor(id, { channels: ['whatsapp', 'email'] });
  const first = await run(D.deliver, data), again = await run(D.deliver, data);
  assert.deepEqual(states(again), [['whatsapp', 'sent'], ['email', 'failed']]);                      // a failed channel is NOT retried by a repeat
  assert.deepEqual([wa.calls.length, mail.calls.length], [1, 1]);
  assert.equal(again.rev, first.rev);                                                                  // and nothing was written
  assert.equal((await quote(id)).history.filter((x) => x.action === 'sent').length, 1);
  // all at once (each call has its own copy of the upload, as a real double click would not: the later ones may find it already used)
  mail.reset(); wa.reset();
  const { id: id2 } = await make(); const data2 = await dataFor(id2, { channels: ['whatsapp', 'email'] });
  const rs = await Promise.allSettled([1, 2, 3, 4, 5].map(() => run(D.deliver, data2)));
  assert.ok(rs.some((x) => x.status === 'fulfilled'));
  for (const x of rs.filter((x) => x.status === 'rejected')) assert.match(x.reason.message, /PDF upload was not found/);   // same as Phase 6's send
  assert.deepEqual([wa.calls.length, mail.calls.length], [1, 1]);
  assert.equal((await deliveries(id2)).length, 2);
  assert.equal((await quote(id2)).history.filter((x) => x.action === 'sent').length, 1);
});

test('a channel still "queued" (a crash before it was claimed) is finished by the same request again, and only it', async () => {
  const { id, data, r } = await failed();
  const dRef = db.doc(`quotes/${id}/deliveries/${r.deliveries[0].id}`);
  await dRef.update({ state: 'queued', attempts: 0, error: null, failedAt: null });                  // as if the claim never happened
  wa.reset();
  const again = await run(D.deliver, data);
  assert.deepEqual(states(again), [['whatsapp', 'sent']]); assert.equal(wa.calls.length, 1); assert.equal(again.status, 'sent');
  const third = await run(D.deliver, data); assert.equal(wa.calls.length, 1); assert.equal(third.sent, true);
});

test('two retries at once, and two staff pressing together: one message goes', async () => {
  const { id, r } = await failed();
  wa.hold = () => new Promise((res) => setTimeout(res, 150));                                         // so the attempts really overlap
  const rs = await Promise.allSettled([1, 2, 3, 4].map(() => run(D.retry, { id, deliveryId: r.deliveries[0].id })));
  assert.equal(rs.filter((x) => x.status === 'fulfilled').length, 1);
  for (const x of rs.filter((x) => x.status === 'rejected')) assert.equal(x.reason.code, 'failed-precondition');
  assert.equal(wa.calls.length, 2);                                                                    // the first refused attempt, then exactly one retry
  assert.equal((await dOf(id, 'whatsapp')).attempts, 2);
});

// ============================================= when we cannot tell: never sent twice by itself ============================
test('an answer we cannot confirm is "not confirmed": not committed, never retried by itself, plain words, no private details stored', async () => {
  for (const mode of ['unsure', 'crash']) {
    wa.reset(); wa.mode = mode;
    const p = ph(mode === 'unsure' ? 901 : 902); await seed(p, {}, 'Anna Murphy');
    const { id } = await make(p);
    const r = await run(D.deliver, await dataFor(id));
    assert.deepEqual(states(r), [['whatsapp', 'unknown']], mode); assert.deepEqual([r.sent, r.status], [false, 'draft'], mode);
    const d = await dOf(id, 'whatsapp');
    assert.equal(d.state, 'unknown');
    assert.deepEqual(d.error, mode === 'unsure' ? { code: 'provider_5xx', text: 'The provider answered with an error.' } : { code: 'not_confirmed', text: D.NOT_CONFIRMED });
    for (const secret of ['353851111111', 'Anna', 'Murphy', 'quote is attached']) assert.ok(!JSON.stringify(d.error).includes(secret), 'leaked ' + secret);
    await rejects(run(D.retry, { id, deliveryId: d.id }), 'failed-precondition', /could not confirm/);
    wa.mode = 'ok'; await rejects(run(D.retry, { id, deliveryId: d.id }), 'failed-precondition', /could not confirm/);
    assert.equal(wa.calls.length, 1, mode);                                                             // never sent again by itself
    await rejects(run(D.cancelSend, { id, expectedRev: (await quote(id)).rev }), 'failed-precondition', /could not be confirmed/);
  }
});

test('settling a send we could not confirm: "it arrived" counts it and commits; "it did not arrive" makes it retryable', async () => {
  wa.mode = 'crash';
  const { id } = await make();
  const r = await run(D.deliver, await dataFor(id, { pipeline: { value: 14500 } }));
  const did = r.deliveries[0].id; wa.mode = 'ok';
  await rejects(run(D.resolve, { id, deliveryId: did, outcome: 'maybe' }), 'invalid-argument');
  const ok = await run(D.resolve, { id, deliveryId: did, outcome: 'delivered' });
  assert.deepEqual([ok.sent, ok.status, states(ok)], [true, 'sent', [['whatsapp', 'sent']]]);
  assert.deepEqual(ok.committed.stage, { from: 'inbox', to: 'quoted', corrected: false });
  const d = await dOf(id, 'whatsapp'); assert.deepEqual([d.resolvedBy, d.provider, d.history.at(-1).event], ['thomas@example.com', { id: null }, 'confirmed delivered']);
  assert.equal(wa.calls.length, 1);                                                                    // settling sends nothing
  await rejects(run(D.resolve, { id, deliveryId: did, outcome: 'delivered' }), 'failed-precondition', /could not be confirmed/);
  // the other answer
  wa.reset(); wa.mode = 'crash';
  const p2 = ph(903); await seed(p2); const { id: id2 } = await make(p2);
  const r2 = await run(D.deliver, await dataFor(id2));
  wa.mode = 'ok';
  const no = await run(D.resolve, { id: id2, deliveryId: r2.deliveries[0].id, outcome: 'not_delivered' });
  assert.deepEqual([no.sent, no.status, states(no)], [false, 'draft', [['whatsapp', 'failed']]]);
  assert.equal(no.deliveries[0].error.code, 'confirmed_not_delivered');
  const back = await run(D.retry, { id: id2, deliveryId: r2.deliveries[0].id });
  assert.deepEqual([back.sent, back.status], [true, 'sent']); assert.equal(wa.calls.length, 2);
});

test('a send still "sending" after 3 minutes is treated as not confirmed; a fresh one is simply in progress', async () => {
  const { id, r } = await failed();
  const dRef = db.doc(`quotes/${id}/deliveries/${r.deliveries[0].id}`), calls0 = wa.calls.length;
  await dRef.update({ state: 'sending', attemptId: 'x#1', claimedAt: Timestamp.fromMillis(NOW - 10 * MIN), error: null });
  await rejects(run(D.retry, { id, deliveryId: r.deliveries[0].id }), 'failed-precondition', /could not confirm/);
  await rejects(run(D.cancelSend, { id, expectedRev: (await quote(id)).rev }), 'failed-precondition', /could not be confirmed/);
  const ok = await run(D.resolve, { id, deliveryId: r.deliveries[0].id, outcome: 'not_delivered' });         // settle it
  assert.deepEqual(states(ok), [['whatsapp', 'failed']]);
  await dRef.update({ state: 'sending', attemptId: 'x#2', claimedAt: Timestamp.fromMillis(NOW - 1 * MIN) });
  await rejects(run(D.retry, { id, deliveryId: r.deliveries[0].id }), 'failed-precondition', /being sent right now/);
  await rejects(run(D.resolve, { id, deliveryId: r.deliveries[0].id, outcome: 'delivered' }), 'failed-precondition', /could not be confirmed/);
  await rejects(run(D.cancelSend, { id, expectedRev: (await quote(id)).rev }), 'failed-precondition', /sending right now/);
  await rejects(run(D.markSent, { id, expectedRev: (await quote(id)).rev }), 'failed-precondition', /sending right now/);
  assert.equal(wa.calls.length, calls0);
});

test('a late answer from a send that was settled meanwhile is not written over the staff member\'s decision', async () => {
  const { id } = await make();
  let did = null;
  wa.hold = async () => {                                                                               // while the channel is "working", staff settle it
    did = (await deliveries(id))[0].id;
    await db.doc(`quotes/${id}/deliveries/${did}`).update({ claimedAt: Timestamp.fromMillis(NOW - 10 * MIN) });
    await run(D.resolve, { id, deliveryId: did, outcome: 'not_delivered' });
  };
  const r = await run(D.deliver, await dataFor(id));
  assert.deepEqual(states(r), [['whatsapp', 'failed']]); assert.equal(r.sent, false);                  // staff's "did not arrive" stands; the late success is not recorded
  assert.equal((await quote(id)).status, 'draft');
});

// ================================================ how a channel can fail =================================================
test('a channel that refuses before sending (window closed, no email address) is a failure and is never asked to send', async () => {
  wa.checkResult = { ok: false, code: 'window_closed', text: 'The 24-hour window has closed.' };
  const { id } = await make();
  const r = await run(D.deliver, await dataFor(id));
  assert.deepEqual(states(r), [['whatsapp', 'failed']]); assert.equal(wa.calls.length, 0);
  assert.deepEqual((await dOf(id, 'whatsapp')).error, { code: 'window_closed', text: 'The 24-hour window has closed.' });
  assert.equal((await quote(id)).status, 'draft');
});

test('the stored PDF is checked before every send: a changed or missing file is never sent', async () => {
  const { id, r } = await failed();
  const path = (await version(id)).prepared.pdf.path;
  await bucket.file(path).save(pdfBytes('tampered'), { contentType: 'application/pdf' });
  const calls0 = wa.calls.length;
  const t = await run(D.retry, { id, deliveryId: r.deliveries[0].id });
  assert.deepEqual(states(t), [['whatsapp', 'failed']]); assert.equal(t.deliveries[0].error.code, 'pdf_changed'); assert.equal(wa.calls.length, calls0);
  await bucket.file(path).delete();
  const m = await run(D.retry, { id, deliveryId: r.deliveries[0].id });
  assert.equal(m.deliveries[0].error.code, 'pdf_missing'); assert.equal(wa.calls.length, calls0);
});

test('a retry after the date has passed is refused: cancel and send again (today and yesterday are fine)', async () => {
  const { id, r } = await failed();
  const did = r.deliveries[0].id;
  await rejects(run(D.retry, { id, deliveryId: did }, NOW + 2 * DAY), 'failed-precondition', /out of date/);
  await run(D.retry, { id, deliveryId: did }, NOW + 1 * DAY);                                          // yesterday's date still goes, as in Phase 6's send
  assert.equal((await quote(id)).status, 'sent');
});

// ===================================================== the draft is locked while a send is prepared ========================
test('while a send is prepared the draft cannot be edited, discarded, deleted or marked sent the old way; cancelling unlocks it', async () => {
  const { id, r } = await failed();
  const rev = async () => (await quote(id)).rev;
  await rejects(Q.saveDraft(deps, actor, { id, expectedRev: await rev(), answers: answers({ doors: 11 }) }, { nowMs: NOW }), 'failed-precondition', /send is already in progress/);
  await rejects(Q.discardDraft(deps, actor, { id, expectedRev: await rev() }, { nowMs: NOW }), 'failed-precondition', /send is already in progress/);
  await rejects(Q.deleteDraft(deps, actor, { id, expectedRev: await rev() }, { nowMs: NOW }), 'failed-precondition', /send is already in progress/);
  await rejects(Q.send(deps, actor, await manualOf(id), { nowMs: NOW, uid: 'u1' }), 'failed-precondition', /send is already in progress/);
  await rejects(run(D.deliver, await dataFor(id)), 'failed-precondition', /send is already in progress/);               // a NEW request while one is prepared
  await rejects(Q.accept(deps, actor, { id, expectedRev: await rev(), option: 'prem' }, { nowMs: NOW }), 'failed-precondition');
  await rejects(Q.revise(deps, actor, { id, expectedRev: await rev() }, { nowMs: NOW }), 'failed-precondition');
  await Q.setNotes(deps, actor, { id, expectedRev: await rev(), notes: 'Phoned the customer.' }, { nowMs: NOW });          // notes are fine
  assert.equal((await version(id)).answers.doors, 10);
  const c = await run(D.cancelSend, { id, expectedRev: await rev() });
  assert.deepEqual([c.ok, c.status, c.draftVersion], [true, 'draft', 1]);
  const q = await quote(id), v = await version(id);
  assert.deepEqual([q.preparedSend, v.prepared], [undefined, undefined]);
  assert.deepEqual(q.history.map((x) => x.action), ['created', 'send started', 'send cancelled']);
  await Q.saveDraft(deps, actor, { id, expectedRev: q.rev, answers: answers({ doors: 11 }) }, { nowMs: NOW });          // editable again
  assert.equal((await version(id)).answers.doors, 11);
  await rejects(run(D.retry, { id, deliveryId: r.deliveries[0].id }), 'failed-precondition', /cancelled/);
});

test('cancelling removes the prepared PDF and keeps a record; a new send afterwards makes a fresh PDF and commits normally', async () => {
  const { id } = await failed();
  const old = (await version(id)).prepared.pdf.path;
  await run(D.cancelSend, { id, expectedRev: (await quote(id)).rev });
  assert.equal((await bucket.file(old).exists())[0], false);
  assert.equal((await dOf(id, 'whatsapp')).state, 'cancelled');
  await rejects(run(D.cancelSend, { id, expectedRev: (await quote(id)).rev }), 'failed-precondition', /no send in progress/);
  const r = await run(D.deliver, await dataFor(id));
  assert.equal(r.sent, true);
  const v = await version(id); assert.notEqual(v.pdf.path, old); assert.equal((await deliveries(id)).length, 2);
  await rejects(run(D.cancelSend, { id, expectedRev: (await quote(id)).rev }), 'failed-precondition', /no send in progress/);   // not after it went
});

test('"I sent it myself": commits the prepared version by hand with its stored PDF, through the same rules', async () => {
  await seed(P, { inboxStatus: 'booked' }, 'Anna Murphy', { quoteValue: 9000 });
  const { id } = await failed();
  const prepared = (await version(id)).prepared;
  const rev = (await quote(id)).rev;
  await rejects(run(D.markSent, { id, expectedRev: rev - 1 }), 'failed-precondition', /changed by someone else/);
  const r = await run(D.markSent, { id, expectedRev: rev });
  assert.deepEqual([r.sent, r.status], [true, 'sent']);
  assert.deepEqual(r.committed, { stage: { from: 'booked', to: 'quoted', corrected: false }, value: { from: 9000, to: 14500 } });
  const q = await quote(id), v = await version(id);
  assert.equal(q.history.at(-1).via, 'manual'); assert.deepEqual(v.pdf, prepared.pdf); assert.equal(q.preparedSend, undefined);
  const m = await dOf(id, 'manual'); assert.deepEqual([m.state, m.resolvedBy, m.channel], ['sent', 'thomas@example.com', 'manual']);
  assert.equal((await dOf(id, 'whatsapp')).state, 'failed');                                           // the failed channel's record stays as it was
  await rejects(run(D.markSent, { id, expectedRev: q.rev }), 'failed-precondition', /no send in progress/);
});

// ==================================================== another channel for a version the customer has =====================
test('another channel for a sent version: its stored PDF goes out, with no new version, no commit and no pipeline change', async () => {
  const { id } = await make();
  await Q.send(deps, actor, await manualOf(id, {}), { nowMs: NOW, uid: 'u1' });                       // sent by hand (Phase 6): no delivery records
  assert.equal((await deliveries(id)).length, 0);
  const before = await quote(id), stored = (await bucket.file((await version(id)).pdf.path).download())[0];
  const req = rid();
  const r = await run(D.deliver, { id, version: 1, requestId: req, channels: ['email'], messages: { email: MSG.email }, recipients: { email: 'anna@example.com' } });
  assert.deepEqual(states(r), [['email', 'sent']]); assert.equal(r.committed, null);
  assert.ok(mail.calls[0].pdf.bytes.equals(stored)); assert.deepEqual(mail.calls[0].to, { email: 'anna@example.com' });
  assert.deepEqual(await quote(id), before);                                                           // the quote record is untouched
  const again = await run(D.deliver, { id, version: 1, requestId: req, channels: ['email'], messages: { email: MSG.email }, recipients: { email: 'anna@example.com' } });
  assert.equal(mail.calls.length, 1); assert.deepEqual(states(again), [['email', 'sent']]);
  // not for a draft, not with PDF fields
  await seed(R, {}, 'Brian Byrne');
  const { id: id2 } = await make(R);
  await rejects(run(D.deliver, { id: id2, version: 1, requestId: rid(), channels: ['email'], messages: { email: MSG.email }, recipients: { email: 'anna@example.com' } }), 'failed-precondition', /Only a version that was sent/);
  await rejects(run(D.deliver, { id, version: 1, requestId: rid(), channels: ['email'], messages: { email: MSG.email }, pdfUploadPath: 'uploads/u1/x.pdf' }), 'invalid-argument', /Unknown field/);
});

test('history is never overwritten: an earlier version\'s PDF and deliveries stay when the quote is revised and sent again', async () => {
  const { id } = await make();
  const v1 = pdfBytes('version one');
  await run(D.deliver, await dataFor(id, {}, NOW, v1));
  const p1 = (await version(id, 1)).pdf.path;
  await Q.revise(deps, actor, { id, expectedRev: (await quote(id)).rev }, { nowMs: NOW });
  const v2 = pdfBytes('version two');
  const r = await run(D.deliver, await dataFor(id, { channels: ['whatsapp', 'email'] }, NOW, v2));
  assert.equal(r.sent, true);
  const p2 = (await version(id, 2)).pdf.path;
  assert.notEqual(p1, p2);
  assert.ok((await bucket.file(p1).download())[0].equals(v1)); assert.ok((await bucket.file(p2).download())[0].equals(v2));
  const all = await deliveries(id);
  assert.deepEqual(all.map((d) => [d.version, d.channel, d.state]), [[1, 'whatsapp', 'sent'], [2, 'whatsapp', 'sent'], [2, 'email', 'sent']]);
  assert.equal(all[0].pdf.path, p1);
  assert.deepEqual((await quote(id)).history.map((x) => x.action), ['created', 'send started', 'sent', 'revised', 'send started', 'sent']);
});

// ======================================================= prepare checks everything a send checks ===========================
test('a send the old rules would refuse is refused before anything is stored, written or sent', async () => {
  const { id } = await make();
  const before = await quote(id), filesBefore = await files('quotes/');
  const cases = [
    [{ settingsRev: 99 }, /Quote Settings changed/], [{ expectedRev: 99 }, /changed by someone else/], [{ issueDate: '2026-09-20' }, /issue date/],
    [{ customer: { name: 'Anna Murphy', email: 'other@example.com', address: '1 Main Street, Swords' } }, /customer's details changed/],
    [{ pdfUploadPath: 'uploads/u2/x.pdf' }, /Bad upload path/], [{ pdfUploadPath: 'uploads/u1/does-not-exist.pdf' }, /PDF upload was not found/],
    [{ requestId: 'short' }, /request id/],
  ];
  for (const [over, msg] of cases) await assert.rejects(run(D.deliver, await dataFor(id, over)), (e) => msg.test(e.message), JSON.stringify(over));
  const notPdf = await upload(Buffer.from('this is not a pdf at all'));
  await rejects(run(D.deliver, await dataFor(id, { pdfUploadPath: notPdf })), 'invalid-argument', /not a PDF/);
  assert.deepEqual(await quote(id), before); assert.deepEqual(await files('quotes/'), filesBefore);
  assert.equal((await deliveries(id)).length, 0); assert.equal(wa.calls.length + mail.calls.length, 0);
  assert.equal((await version(id)).prepared, undefined);
});

// ============================================================== who may call, and strict input ===========================
test('only signed-in, allowlisted staff can use any delivery action; nothing is written or sent otherwise', async () => {
  const { id, r } = await failed();
  const before = await quote(id), nDeliveries = (await deliveries(id)).length, callsBefore = wa.calls.length;
  const people = [[null, 'unauthenticated'], [{ uid: 'x', token: { email: 'stranger@gmail.com', email_verified: true, staff: true } }, 'permission-denied'],
    [{ uid: 'x', token: { email: 'thomas@example.com', email_verified: true } }, 'permission-denied']];
  const calls = { deliverQuote: await dataFor(id), retryQuoteDelivery: { id, deliveryId: r.deliveries[0].id }, resolveQuoteDelivery: { id, deliveryId: r.deliveries[0].id, outcome: 'delivered' },
    cancelQuoteSend: { id, expectedRev: before.rev }, markQuoteSent: { id, expectedRev: before.rev } };
  for (const [who, code] of people) for (const [name, data] of Object.entries(calls)) await rejects(h[name](who, data, dd), code);
  assert.deepEqual(await quote(id), before); assert.equal((await deliveries(id)).length, nDeliveries); assert.equal(wa.calls.length, callsBefore);
  await seed(R, {}, 'Brian Byrne');                                                                         // staff can, through the real wrapper (today's real date)
  const id2 = (await make(R)).id, real = await h.deliverQuote(staff, await dataFor(id2, {}, Date.now()), dd);
  assert.equal(real.sent, true); assert.equal((await quote(id2)).history.at(-1).by, 'thomas@example.com'); assert.equal(wa.calls.length, callsBefore + 1);
});

test('the request is checked strictly: channels, messages, ids and unknown fields', async () => {
  const { id } = await make();
  const ok = await dataFor(id, { channels: ['whatsapp', 'email'] });
  const bad = [
    [{ channels: [] }, /Choose how to send/], [{ channels: 'whatsapp' }, /Choose how to send/], [{ channels: undefined }, /Choose how to send/], [{ channels: ['sms'] }, /not known/],
    [{ channels: [5] }, /not known/], [{ messages: undefined }, /Write the message/], [{ messages: {} }, /Write the message/], [{ messages: { whatsapp: '  ', email: 'x' } }, /Write the message/],
    [{ messages: { whatsapp: 'x', email: 'x', sms: 'x' } }, /Unknown message: sms/], [{ messages: { whatsapp: 'x'.repeat(1025), email: 'x' } }, /too long \(max 1024/],
    [{ messages: { whatsapp: 'x', email: 'x'.repeat(5001) } }, /too long \(max 5000/], [{ messages: { whatsapp: 5, email: 'x' } }, /must be text/],
    [{ extra: 1 }, /Unknown field: extra/], [{ version: 1.5 }, /Unknown field/],
  ];
  for (const [over, msg] of bad) await assert.rejects(run(D.deliver, { ...ok, ...over }), (e) => e.code === 'invalid-argument' && msg.test(e.message), JSON.stringify(over));
  await rejects(run(D.deliver, null), 'invalid-argument'); await rejects(run(D.deliver, []), 'invalid-argument');
  const only = { ...ok, channels: ['whatsapp'] };                                                       // a channel that is not available
  await rejects(D.deliver({ ...dd, channels: { email: mail } }, actor, only, { nowMs: NOW, uid: 'u1' }), 'invalid-argument', /not available/);
  assert.equal((await deliveries(id)).length, 0); assert.equal((await quote(id)).preparedSend, undefined);
  for (const [fn, data] of [[D.retry, { id }], [D.retry, { id, deliveryId: 'nope' }], [D.retry, { id, deliveryId: '1-aaaaaaaaaaaa-whatsapp', extra: 1 }], [D.resolve, { id, deliveryId: '1-aaaaaaaaaaaa-whatsapp', outcome: 'x' }],
    [D.cancelSend, { id }], [D.cancelSend, { id, expectedRev: 1, extra: 1 }], [D.markSent, { id }]]) await rejects(run(fn, data), 'invalid-argument');
  await rejects(run(D.retry, { id, deliveryId: '1-aaaaaaaaaaaa-whatsapp' }), 'not-found');
});

// ============================================================ privacy, erasure, erased mid-send ===========================
test('logs and stored errors never hold names, numbers, addresses or message text', async () => {
  const seen = [], orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => seen.push(a.join(' ')); console.error = (...a) => seen.push(a.join(' ')); console.warn = (...a) => seen.push(a.join(' '));
  let docs;
  try {
    for (const [i, mode] of ['refuse', 'unsure', 'crash', 'ok'].entries()) {
      wa.reset(); wa.mode = mode; mail.mode = mode === 'ok' ? 'ok' : 'crash';
      const p = ph(950 + i); await seed(p, {}, 'Anna Murphy');
      const { id } = await make(p);
      await run(D.deliver, await dataFor(id, { channels: ['whatsapp', 'email'] }));
    }
    docs = JSON.stringify((await db.collectionGroup('deliveries').get()).docs.map((d) => d.data().error));
  } finally { Object.assign(console, orig); }
  const text = seen.join('\n') + docs;
  assert.ok(seen.length >= 4, 'something was logged');
  for (const secret of ['353861', '353851111111', 'Anna', 'Murphy', 'anna@example.com', 'quote is attached', 'quotation', 'Main Street']) assert.ok(!text.includes(secret), 'leaked: ' + secret);
});

test('deleting the customer erases their deliveries (and quotes, versions and PDFs), prepared or delivered', async () => {
  const a = (await make()).id;
  await run(D.deliver, await dataFor(a, { channels: ['whatsapp', 'email'] }));
  const { id: b } = await failed();                                                                       // a second quote, prepared and undelivered
  assert.ok((await deliveries(a)).length === 2 && (await deliveries(b)).length === 1);
  await h.deleteCustomer(staff, { phone: P, confirm: '1111' }, deps);
  assert.equal((await db.collectionGroup('deliveries').get()).size, 0); assert.equal((await db.collection('quotes').get()).size, 0);
  assert.deepEqual(await files('quotes/'), []);
});

test('a never-sent quote that was cancelled can be deleted, and its delivery records go with it', async () => {
  const { id } = await failed();
  await run(D.cancelSend, { id, expectedRev: (await quote(id)).rev });
  assert.equal((await deliveries(id)).length, 1);
  await Q.deleteDraft(deps, actor, { id, expectedRev: (await quote(id)).rev }, { nowMs: NOW });
  assert.equal((await db.collectionGroup('deliveries').get()).size, 0); assert.equal((await db.doc('quotes/' + id).get()).exists, false);
});

test('if the customer is erased while a channel is sending, nothing is recreated', async () => {
  const { id } = await make();
  wa.hold = async () => { await db.recursiveDelete(db.doc('quotes/' + id)); };
  await rejects(run(D.deliver, await dataFor(id)), 'not-found', /Quote not found/);
  assert.equal((await db.doc('quotes/' + id).get()).exists, false); assert.equal((await db.collectionGroup('deliveries').get()).size, 0);
});

test('the Phase 6 send still works as before for a quote with no prepared send, and its records are unchanged', async () => {
  const { id } = await make();
  const r = await Q.send(deps, actor, await manualOf(id), { nowMs: NOW, uid: 'u1' });
  assert.deepEqual([r.existing, r.status, r.stage], [false, 'sent', { from: 'inbox', to: 'quoted', corrected: false }]);
  const q = await quote(id);
  assert.deepEqual(q.history.map((x) => x.action), ['created', 'sent']); assert.equal(q.history[1].via, undefined); assert.equal(q.preparedSend, undefined);
  assert.equal((await version(id)).prepared, undefined); assert.equal((await deliveries(id)).length, 0);
});
