// Phase 6.1 M4: sending a quote by EMAIL through the Gmail API as the business mailbox (docs/PHASE6_1_PLAN.md), together with the real
// WhatsApp channel, so the two are tested side by side. Real Firestore + Storage emulators; a FAKE Google (metadata server, signing,
// token endpoint, Gmail) and a FAKE Meta: no real email or WhatsApp message is ever sent. Everything below is made up.
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
const G = require('../lib/gmail');
const store = require('../lib/store');
const { createClient } = require('../lib/whatsapp');
const { whatsappChannel, emailChannel } = require('../lib/quoteChannels');

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
const NOW = Date.UTC(2026, 9, 2, 9, 0);
const P = '353851111111', R2 = '353852222222';
const SENDER = 'info@example.test';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const pdfBytes = (tag) => Buffer.from(`%PDF-1.4\n% Elite OS test quote ${tag}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`);
const PRICE_LIST = {
  options: { ess: { perDoor: 110, perTopBox: 60 }, prem: { perDoor: 140, perTopBox: 65 }, pp: { perDoor: 150, perTopBox: 70 } },
  drawerBoxes: { cemux: 12, blum: 21 }, glazing: { small: 45, large: 90 },
  extras: [{ key: 'bin', name: 'Pull-out bin', unit: 'per unit', price: 30 }],
};
const SETTINGS = { priceList: PRICE_LIST, vatRate: 13.5, validityDays: 30,
  business: { tradingName: 'Elite Kitchens', signatureName: 'Test Person', phone: '01 000 0000', email: 'quotes@example.com', web: 'www.example.com', address: 'Test Street, Dublin', vatNumber: 'IE0000000X' } };

// ---- fake Meta ----
const meta = { media: [], messages: [], mode: 'ok' };
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const metaFetch = async (url, opts = {}) => {
  url = String(url);
  if (opts.method === 'POST' && /\/media$/.test(url)) { const f = opts.body.get('file'); meta.media.push({ bytes: Buffer.from(await f.arrayBuffer()) }); return reply({ id: 'UPMEDIA' + meta.media.length }); }
  if (opts.method === 'POST' && /\/messages$/.test(url)) {
    meta.messages.push({ body: JSON.parse(opts.body) });
    if (meta.mode === 'refuse') return reply({ error: { code: 131026, message: 'undeliverable' } }, 400);
    return reply({ messages: [{ id: 'wamid.OUT' + meta.messages.length }] });
  }
  return reply({ error: { message: 'unexpected' } }, 404);
};
// ---- fake Google ----
const google = { calls: [], sent: [], mode: 'ok', signMode: 'ok', hold: null };
const googleFetch = async (url, opts = {}) => {
  url = String(url);
  google.calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
  const res = (data, st = 200) => new Response(JSON.stringify(data), { status: st });
  if (url.includes('/computeMetadata/')) return res({ access_token: 'runtime-token', expires_in: 3000 });
  if (url.includes(':signJwt')) return google.signMode === 'ok' ? res({ signedJwt: 'signed.' + Buffer.from(JSON.parse(opts.body).payload).toString('base64url') + '.sig' }) : res({ error: { message: 'denied' } }, 403);
  if (url === 'http://oauth.test/token') return res({ access_token: 'gmail-token', expires_in: 3600 });
  if (url.includes('/messages/send')) {
    google.sent.push(JSON.parse(opts.body).raw);
    if (google.hold) await google.hold();
    if (google.mode === 'network') throw new TypeError('fetch failed');
    if (google.mode === 'hang') return new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    if (['400', '401', '403', '429', '500', '503'].includes(google.mode)) return res({ error: { message: 'x' } }, Number(google.mode));
    if (google.mode === 'noid') return res({});
    return res({ id: 'gmsg-' + google.sent.length, threadId: 'thr-' + google.sent.length });
  }
  return res({ error: { message: 'unexpected ' + url } }, 404);
};
const wa = createClient({ phoneId: '111', token: 'tok', version: 'v21.0' }, metaFetch);
let clock = NOW, mailOn = true;
const makeMail = () => emailChannel({ enabled: mailOn, sender: SENDER, fromName: 'Elite Kitchens', timeoutMs: 60, now: () => new Date(NOW),
  gmail: G.createGmailClient({ apiBase: 'http://gmail.test', fetchImpl: googleFetch, tokens: G.delegatedTokenProvider({ serviceAccount: 'ek-mailer@p.iam.gserviceaccount.com', sender: SENDER, fetchImpl: googleFetch,
    metadataBase: 'http://meta.test', iamBase: 'http://iam.test', tokenUrl: 'http://oauth.test/token' }) }) });
const deps = { db, cfg, bucket };
const dd = () => ({ db, cfg, bucket, channels: { whatsapp: whatsappChannel({ db, bucket, wa, now: () => clock, timeoutMs: 60 }), email: makeMail() } });
const run = (fn, data, nowMs = NOW) => fn(dd(), actor, data, { nowMs, uid: 'u1' });

// ---- reading a sent message back ----
function parse(raw) {
  const msg = Buffer.from(raw, 'base64url').toString('utf8');
  const [head, ...rest] = msg.split('\r\n\r\n');
  const headers = {}; let last = null;
  for (const line of head.split('\r\n')) { if (/^[ \t]/.test(line) && last) headers[last] += '\r\n' + line; else { const i = line.indexOf(':'); last = line.slice(0, i); headers[last] = line.slice(i + 1).trim(); } }
  const boundary = /boundary="([^"]+)"/.exec(headers['Content-Type'])[1];
  const parts = rest.join('\r\n\r\n').split(`--${boundary}`).slice(1, -1).map((p) => { const t = p.replace(/^\r\n/, '').replace(/\r\n$/, ''); const i = t.indexOf('\r\n\r\n'); return { head: t.slice(0, i), body: t.slice(i + 4) }; });
  const text = Buffer.from(parts[0].body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16))), 'latin1').toString('utf8');
  const pdf = Buffer.from(parts[1].body.replace(/\r\n/g, ''), 'base64');
  const words = (s) => s.replace(/\r\n /g, '').replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
  return { headers, subject: words(headers.Subject), from: words(headers.From), text: text.replace(/\r\n/g, '\n'), pdf, partHeads: parts.map((p) => p.head) };
}

let seq = 0;
const rid = () => 'req-' + (++seq) + '-abcdefgh';
const conv = async (p = P) => (await db.doc('conversations/' + p).get()).data();
const quote = async (id) => (await db.doc('quotes/' + id).get()).data();
const version = async (id, n = 1) => (await db.doc(`quotes/${id}/versions/${n}`).get()).data();
const settingsDoc = async () => (await db.doc('quoteSettings/current').get()).data();
const deliveries = async (id) => (await db.collection(`quotes/${id}/deliveries`).get()).docs.map((d) => ({ id: d.id, ...d.data() }))
  .sort((a, b) => (a.version - b.version) || (D.CHANNEL_ORDER.indexOf(a.channel) - D.CHANNEL_ORDER.indexOf(b.channel)));
const dOf = async (id, channel) => (await deliveries(id)).find((d) => d.channel === channel);
const states = (r) => r.deliveries.map((d) => [d.channel, d.state]);
async function seed(p = P, convExtra = {}, name = 'Anna Murphy', email = 'anna@example.com') {
  await db.doc('contacts/' + p).set({ phone: p, name, ...(email ? { email } : {}), address: '1 Main Street, Swords', location: 'Swords', createdAt: Timestamp.now() });
  await db.doc('conversations/' + p).set({ phone: p, name, createdAt: Timestamp.now(), updatedAt: Timestamp.now(), lastMessage: 'Hi', unreadCount: 2, lastInboundAt: Timestamp.fromMillis(NOW - 2 * H), ...convExtra });
}
function answers() {
  const a = QE.current().newAnswers(PRICE_LIST);
  a.doors = 10; a.drawers = 4; a.options.ess.drawerBox = 'cemux';
  a.options.prem = { ...a.options.prem, on: true, drawerBox: 'blum' };
  return a;
}
async function upload(bytes) { const p = `uploads/u1/${Date.now()}-${++seq}-quote.pdf`; await bucket.file(p).save(bytes, { contentType: 'application/pdf' }); return p; }
const make = (p = P) => Q.create(deps, actor, { phone: p, requestId: rid(), answers: answers() }, { nowMs: NOW });
const MSG = { whatsapp: 'Hi Anna, please find attached your quotation.', email: 'Dear Anna,\n\nPlease find attached your quotation — all details are in the PDF.\n\nKind regards,\nTest Person' };
async function dataFor(id, over = {}, bytes = pdfBytes('q' + seq)) {
  const qq = await quote(id), s = await settingsDoc();
  const ct = (await db.doc('contacts/' + qq.phone).get()).data() || {}, cv = await conv(qq.phone);
  const channels = over.channels || ['email'];
  return { id, expectedRev: qq.rev, requestId: rid(), issueDate: Q.dublinDate(NOW), settingsRev: s.rev,
    customer: { name: ct.name || cv.name || null, email: ct.email || null, address: ct.address || null }, pdfUploadPath: await upload(bytes), pipeline: { value: 14500 },
    channels, messages: Object.fromEntries(channels.map((c) => [c, MSG[c]])), ...over };
}

beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await bucket.deleteFiles({ force: true }).catch(() => {});
  Object.assign(meta, { media: [], messages: [], mode: 'ok' });
  Object.assign(google, { calls: [], sent: [], mode: 'ok', signMode: 'ok', hold: null });
  clock = NOW; mailOn = true;
  await seed(); await Q.saveSettings(deps, actor, SETTINGS, { nowMs: NOW });
});

// ================================================================ the happy path ======================================
test('the email goes to the customer\'s saved address, from the business mailbox, with the exact stored PDF; the quote is marked Sent', async () => {
  await seed(P, { inboxStatus: 'booked' });
  const { id } = await make();
  const bytes = pdfBytes('exact');
  const data = await dataFor(id, { subject: 'Elite Kitchens — Kitchen Quote EK-0104 v1' }, bytes);
  const r = await run(D.deliver, data);
  assert.deepEqual([r.sent, r.status, states(r)], [true, 'sent', [['email', 'sent']]]);
  assert.equal(google.sent.length, 1);
  const q = await quote(id), v = await version(id), m = parse(google.sent[0]);
  assert.deepEqual([m.from, m.headers.To, m.headers['Reply-To'], m.subject], [`"Elite Kitchens" <${SENDER}>`, 'anna@example.com', SENDER, 'Elite Kitchens — Kitchen Quote EK-0104 v1']);
  assert.equal(m.text, MSG.email);                                                                    // the editable text, as written
  assert.ok(m.pdf.equals(bytes)); assert.equal(sha(m.pdf), v.pdf.sha256);                             // the exact stored file
  assert.match(m.partHeads[1], new RegExp(`filename="EliteKitchens-${q.ref}-v1.pdf"`));
  assert.deepEqual([q.status, (await conv()).inboxStatus], ['sent', 'quoted']); assert.deepEqual(r.committed.stage, { from: 'booked', to: 'quoted', corrected: false });
  assert.equal(q.history.at(-1).via, 'email');
  const d = await dOf(id, 'email');
  assert.deepEqual([d.state, d.provider, d.to, d.subject], ['sent', { id: 'gmsg-1' }, { email: 'anna@example.com' }, 'Elite Kitchens — Kitchen Quote EK-0104 v1']);
  assert.deepEqual(d.pdf, v.pdf); assert.equal(meta.messages.length, 0);                              // nothing went to WhatsApp
});

test('the sign-in names the business mailbox and only the send scope; no token or key is stored anywhere', async () => {
  const { id } = await make();
  await run(D.deliver, await dataFor(id));
  const sign = google.calls.find((c) => c.url.includes(':signJwt'));
  const claims = JSON.parse(JSON.parse(sign.body).payload);
  assert.deepEqual([claims.sub, claims.scope, claims.iss], [SENDER, 'https://www.googleapis.com/auth/gmail.send', 'ek-mailer@p.iam.gserviceaccount.com']);
  const everything = JSON.stringify([(await db.collectionGroup('deliveries').get()).docs.map((d) => d.data()), await quote(id), await version(id)]);
  for (const secret of ['gmail-token', 'runtime-token', 'signed.', 'Bearer']) assert.ok(!everything.includes(secret), 'stored: ' + secret);
});

test('a default subject is used when none is given, naming the quote and version; an invalid subject is refused before anything happens', async () => {
  const { id } = await make();
  const r = await run(D.deliver, await dataFor(id));
  assert.equal(parse(google.sent[0]).subject, `Elite Kitchens — Quote ${(await quote(id)).ref} v1`); assert.equal(r.sent, true);
  const { id: id2 } = await make();
  for (const subject of ['Line one\nBcc: evil@example.com', 'x'.repeat(151), 5]) await rejects(run(D.deliver, await dataFor(id2, { subject })), 'invalid-argument');
  assert.equal(google.sent.length, 1); assert.equal((await quote(id2)).preparedSend, undefined);
});

// ===================================================== the email cannot be sent: nothing is attempted ======================
test('no email address, an invalid one, or email switched off: a failure in plain words, Google is never contacted, nothing marked sent', async () => {
  await seed(R2, {}, 'Brian Byrne', null);
  const a = (await make(R2)).id;
  const ra = await run(D.deliver, await dataFor(a));
  assert.deepEqual([ra.sent, states(ra), ra.deliveries[0].error.code], [false, [['email', 'failed']], 'no_email']);
  assert.match(ra.deliveries[0].error.text, /no email address.*Details/);
  await db.doc('contacts/' + P).update({ email: 'not an address' });
  const b = (await make(P)).id;
  const rb = await run(D.deliver, await dataFor(b));
  assert.deepEqual([rb.sent, rb.deliveries[0].error.code], [false, 'bad_email']);
  await db.doc('contacts/' + P).update({ email: 'anna@example.com' }); mailOn = false;
  const c = (await make(P)).id;
  const rc = await run(D.deliver, await dataFor(c));
  assert.deepEqual([rc.sent, rc.deliveries[0].error.code, rc.deliveries[0].error.text], [false, 'email_off', 'Email sending is not switched on yet.']);
  assert.equal(google.calls.length, 0); assert.deepEqual([(await quote(a)).status, (await quote(b)).status, (await quote(c)).status], ['draft', 'draft', 'draft']);
});

// ================================================== every way Google can fail =============================================
test('Google refuses (400, 401, 403, 429): a failure in plain words, "Nothing was sent", safe to retry; the quote stays unsent', async () => {
  const texts = { 400: /address may be wrong/, 401: /refused to send as the business mailbox/, 403: /refused to send as the business mailbox/, 429: /limiting email sending/ };
  for (const [i, code] of ['400', '401', '403', '429'].entries()) {
    const p = '35386100000' + i; await seed(p); google.mode = code;
    const { id } = await make(p);
    const r = await run(D.deliver, await dataFor(id));
    assert.deepEqual([r.sent, states(r)], [false, [['email', 'failed']]], code);
    assert.match(r.deliveries[0].error.text, texts[code]); assert.match(r.deliveries[0].error.text, /Nothing was sent\.$/);
    assert.deepEqual([(await quote(id)).status, (await conv(p)).inboxStatus], ['draft', undefined], code);
    google.mode = 'ok';
    const again = await run(D.retry, { id, deliveryId: r.deliveries[0].id });
    assert.deepEqual([again.sent, states(again)], [true, [['email', 'sent']]], code);
  }
});

test('the sign-in being refused is a failure that sends nothing (the one-time Workspace approval or the signing permission is missing)', async () => {
  const { id } = await make();
  google.signMode = 'denied';
  const r = await run(D.deliver, await dataFor(id));
  assert.deepEqual([r.sent, states(r), r.deliveries[0].error.code], [false, [['email', 'failed']], 'token_sign']);
  assert.match(r.deliveries[0].error.text, /one-time Google setup may be missing.*Nothing was sent/);
  assert.equal(google.sent.length, 0);
});

test('an answer we cannot confirm (Google 5xx, no message id, no connection, no answer in time) is "not confirmed": never resent by itself', async () => {
  let i = 0;
  for (const mode of ['500', '503', 'noid', 'network', 'hang']) {
    const p = '35386200000' + (++i); await seed(p); google.mode = mode; google.sent.length = 0;
    const { id } = await make(p);
    const r = await run(D.deliver, await dataFor(id));
    assert.deepEqual([r.sent, states(r), r.deliveries[0].error.code], [false, [['email', 'unknown']], 'not_confirmed'], mode);
    assert.match(r.deliveries[0].error.text, /Check the Sent folder of info@example\.test/);
    assert.deepEqual([(await quote(id)).status, (await conv(p)).inboxStatus], ['draft', undefined], mode);
    google.mode = 'ok';
    await rejects(run(D.retry, { id, deliveryId: r.deliveries[0].id }), 'failed-precondition', /could not confirm/);
    assert.equal(google.sent.length, 1, mode);                                                         // exactly one attempt
    const ok = await run(D.resolve, { id, deliveryId: r.deliveries[0].id, outcome: 'delivered' });    // staff saw it in the Sent folder
    assert.deepEqual([ok.sent, states(ok)], [true, [['email', 'sent']]], mode); assert.equal(google.sent.length, 1, mode);
  }
});

// ============================================ both channels: independent, retry only what failed =========================
test('WhatsApp sent and email failed: WhatsApp stays sent, and retrying the email does NOT resend WhatsApp', async () => {
  const { id } = await make();
  google.mode = '403';
  const r = await run(D.deliver, await dataFor(id, { channels: ['whatsapp', 'email'] }));
  assert.deepEqual(states(r), [['whatsapp', 'sent'], ['email', 'failed']]); assert.deepEqual([r.sent, r.status], [true, 'sent']);
  google.mode = 'ok';
  const r2 = await run(D.retry, { id, deliveryId: r.deliveries[1].id });
  assert.deepEqual(states(r2), [['whatsapp', 'sent'], ['email', 'sent']]);
  assert.deepEqual([meta.messages.length, meta.media.length, google.sent.length], [1, 1, 2]);
  const q = await quote(id); assert.equal(q.history.filter((x) => x.action === 'sent').length, 1); assert.equal(q.pipelineChanges.length, 1);
});

test('email sent and WhatsApp failed: the quote is Sent by email; WhatsApp alone is retried later and the email is not resent', async () => {
  const { id } = await make();
  meta.mode = 'refuse';
  const r = await run(D.deliver, await dataFor(id, { channels: ['whatsapp', 'email'] }));
  assert.deepEqual(states(r), [['whatsapp', 'failed'], ['email', 'sent']]); assert.deepEqual([r.sent, (await quote(id)).history.at(-1).via], [true, 'email']);
  meta.mode = 'ok';
  const r2 = await run(D.retry, { id, deliveryId: r.deliveries[0].id });
  assert.deepEqual(states(r2), [['whatsapp', 'sent'], ['email', 'sent']]); assert.equal(google.sent.length, 1);
});

test('a WhatsApp send that is not confirmed does not stop the email, and neither result hides the other', async () => {
  const { id } = await make();
  const slowMeta = async (url, opts) => { if (/\/messages$/.test(String(url)) && opts.method === 'POST') throw new TypeError('fetch failed'); return metaFetch(url, opts); };
  const d = { ...dd(), channels: { whatsapp: whatsappChannel({ db, bucket, wa: createClient({ phoneId: '111', token: 'tok' }, slowMeta), now: () => clock, timeoutMs: 60 }), email: makeMail() } };
  const r = await D.deliver(d, actor, await dataFor(id, { channels: ['whatsapp', 'email'] }), { nowMs: NOW, uid: 'u1' });
  assert.deepEqual(states(r), [['whatsapp', 'unknown'], ['email', 'sent']]); assert.deepEqual([r.sent, r.status], [true, 'sent']);
  await rejects(run(D.retry, { id, deliveryId: r.deliveries[0].id }), 'failed-precondition', /could not confirm/);
  assert.equal(google.sent.length, 1);
});

// ===================================================== one request, one email; the right PDF to the right customer =========
test('a double click and simultaneous requests send ONE email', async () => {
  const { id } = await make();
  const data = await dataFor(id);
  google.hold = () => new Promise((res) => setTimeout(res, 60));
  const rs = await Promise.allSettled([1, 2, 3, 4, 5].map(() => run(D.deliver, data)));
  assert.ok(rs.some((x) => x.status === 'fulfilled'));
  for (const x of rs.filter((x) => x.status === 'rejected')) assert.match(x.reason.message, /PDF upload was not found/);
  assert.equal(google.sent.length, 1);
  assert.equal((await run(D.deliver, data)).sent, true); assert.equal(google.sent.length, 1);         // a refresh: the same request once more
});

test('each customer\'s email goes to their own address with their own PDF, never another customer\'s', async () => {
  await seed(R2, {}, 'Brian Byrne', 'brian@example.com');
  const a = (await make(P)).id, b = (await make(R2)).id;
  const pa = pdfBytes('ANNA ONLY'), pb = pdfBytes('BRIAN ONLY');
  await run(D.deliver, await dataFor(a, {}, pa)); await run(D.deliver, await dataFor(b, {}, pb));
  const [ma, mb] = google.sent.map(parse);
  assert.deepEqual([ma.headers.To, mb.headers.To], ['anna@example.com', 'brian@example.com']);
  assert.ok(ma.pdf.equals(pa)); assert.ok(mb.pdf.equals(pb)); assert.ok(!ma.pdf.includes('BRIAN') && !mb.pdf.includes('ANNA'));
});

test('a revised quote keeps PDF v1 exactly as the customer received it; v2 is a new attachment', async () => {
  const { id } = await make();
  const v1 = pdfBytes('version one'), v2 = pdfBytes('version two');
  await run(D.deliver, await dataFor(id, {}, v1));
  const p1 = (await version(id, 1)).pdf.path;
  await Q.revise(deps, actor, { id, expectedRev: (await quote(id)).rev }, { nowMs: NOW });
  await run(D.deliver, await dataFor(id, {}, v2));
  assert.ok((await bucket.file(p1).download())[0].equals(v1));
  assert.deepEqual(google.sent.map((r) => sha(parse(r).pdf)), [sha(v1), sha(v2)]);
  assert.deepEqual((await deliveries(id)).map((d) => [d.version, d.state]), [[1, 'sent'], [2, 'sent']]);
});

test('a quote Phase 6 marked sent by hand can be emailed later: the stored PDF goes to the customer\'s CURRENT address; the quote record is unchanged', async () => {
  const { id } = await make();
  const d0 = await dataFor(id); delete d0.channels; delete d0.messages;
  await Q.send(deps, actor, d0, { nowMs: NOW, uid: 'u1' });
  const before = await quote(id), stored = (await bucket.file((await version(id)).pdf.path).download())[0];
  await db.doc('contacts/' + P).update({ email: 'anna.new@example.com' });                           // they corrected their address since
  const r = await run(D.deliver, { id, version: 1, requestId: rid(), channels: ['email'], messages: { email: MSG.email } });
  assert.deepEqual([r.sent, states(r), r.committed], [true, [['email', 'sent']], null]);
  const m = parse(google.sent[0]); assert.equal(m.headers.To, 'anna.new@example.com'); assert.ok(m.pdf.equals(stored));
  assert.deepEqual(await quote(id), before);
});

test('re-sending an OLDER version emails that version\'s own PDF, never the newest one', async () => {
  const { id } = await make();
  const v1 = pdfBytes('version one'), v2 = pdfBytes('version two');
  const d1 = await dataFor(id, {}, v1); delete d1.channels; delete d1.messages; await Q.send(deps, actor, d1, { nowMs: NOW, uid: 'u1' });
  await Q.revise(deps, actor, { id, expectedRev: (await quote(id)).rev }, { nowMs: NOW });
  const d2 = await dataFor(id, {}, v2); delete d2.channels; delete d2.messages; await Q.send(deps, actor, d2, { nowMs: NOW, uid: 'u1' });
  const r = await run(D.deliver, { id, version: 1, requestId: rid(), channels: ['email'], messages: { email: MSG.email } });
  assert.equal(r.sent, true);
  const m = parse(google.sent[0]);
  assert.ok(m.pdf.equals(v1)); assert.ok(!m.pdf.equals(v2)); assert.match(m.partHeads[1], /-v1\.pdf/);
  assert.match(m.subject, /v1$/);
  assert.deepEqual((await deliveries(id)).map((d) => [d.version, d.state]), [[1, 'sent']]);
});

test('an expired quote can still be emailed again, and a Closed customer moves to Quoted only if staff ticked "Reopen"', async () => {
  const { id } = await make();
  const d0 = await dataFor(id); delete d0.channels; delete d0.messages;
  await Q.send(deps, actor, d0, { nowMs: NOW, uid: 'u1' });
  const later = NOW + 40 * 24 * H;
  assert.equal(Q.isExpired(await quote(id), later), true);
  assert.equal((await run(D.deliver, { id, version: 1, requestId: rid(), channels: ['email'], messages: { email: MSG.email } }, later)).sent, true);
  await seed(P, { inboxStatus: 'closed' }); await seed(R2, { inboxStatus: 'closed' }, 'Brian Byrne', 'brian@example.com');
  const a = (await make(P)).id, b = (await make(R2)).id;
  await run(D.deliver, await dataFor(a, { pipeline: {} })); await run(D.deliver, await dataFor(b, { pipeline: { reopen: true } }));
  assert.deepEqual([(await conv(P)).inboxStatus, (await conv(R2)).inboxStatus], ['closed', 'quoted']);
});

// ================================================================== privacy ===============================================
test('logs and stored errors never hold names, addresses, the message text or any token', async () => {
  const seen = [], orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => seen.push(a.join(' ')); console.error = (...a) => seen.push(a.join(' ')); console.warn = (...a) => seen.push(a.join(' '));
  let errors;
  try {
    let i = 0;
    for (const mode of ['400', '403', '500', 'network', 'noid', 'ok']) {
      const p = '35386300000' + (++i); await seed(p); google.mode = mode;
      const { id } = await make(p);
      await run(D.deliver, await dataFor(id, {}, pdfBytes('x' + i)));
    }
    errors = JSON.stringify((await db.collectionGroup('deliveries').get()).docs.map((d) => d.data().error));
  } finally { Object.assign(console, orig); }
  const text = seen.join('\n') + errors;
  assert.ok(seen.length >= 4, 'something was logged');
  for (const secret of ['3538630', 'Anna', 'Murphy', 'anna@example.com', 'quotation', 'Main Street', 'gmail-token', 'runtime-token', 'signed.']) assert.ok(!text.includes(secret), 'leaked: ' + secret);
});

test('deleting the customer erases the delivery records (which hold the address and the message) and the quote PDFs', async () => {
  const { id } = await make();
  await run(D.deliver, await dataFor(id));
  assert.equal((await db.collectionGroup('deliveries').get()).size, 1);
  await h.deleteCustomer(staff, { phone: P, confirm: '1111' }, deps);
  assert.equal((await db.collectionGroup('deliveries').get()).size, 0); assert.deepEqual((await bucket.getFiles({ prefix: 'quotes/' }))[0], []);
});

test('quoteChannels (what the Send dialog asks before staff press Send) is staff-only and says whether email is switched on', async () => {
  for (const who of [null, { uid: 'x', token: { email: 'stranger@gmail.com', email_verified: true, staff: true } }, { uid: 'x', token: { email: 'thomas@example.com', email_verified: true } }]) {
    await assert.rejects(h.quoteChannels(who, {}, { ...deps, mailEnabled: true, mailSender: SENDER }), (e) => e.code === 'unauthenticated' || e.code === 'permission-denied');
  }
  assert.deepEqual(await h.quoteChannels(staff, {}, { ...deps, mailEnabled: true, mailSender: SENDER }), { whatsapp: { enabled: true }, email: { enabled: true, sender: SENDER } });
  assert.deepEqual(await h.quoteChannels(staff, {}, { ...deps, mailEnabled: false, mailSender: SENDER }), { whatsapp: { enabled: true }, email: { enabled: false, sender: null } });
});
