// Phase 6.1 M7: a quote to a customer whose 24-hour window is CLOSED goes out inside the approved quotation template, with the
// exact stored PDF as its Document header, so staff never have to Reopen and wait for a reply just to deliver a quote
// (docs/PHASE6_1_PLAN.md, M7). Real Firestore + Storage emulators and a FAKE Meta: no real message is ever sent. The route is
// decided by the SERVER at send time. Everything below (names, numbers, prices) is made up.
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
const WS = require('../lib/windowState');
const { createClient } = require('../lib/whatsapp');
const { whatsappChannel, WINDOW_CLOSED } = require('../lib/quoteChannels');

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
const TEMPLATE = { name: 'elite_kitchens_quote_document', lang: 'en' };
const CLOSED = { lastInboundAt: Timestamp.fromMillis(NOW - 30 * H) };      // the customer last wrote 30 hours ago
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const pdfBytes = (tag) => Buffer.from(`%PDF-1.4\n% Elite OS test quote ${tag}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`);
const PRICE_LIST = {
  options: { ess: { perDoor: 110, perTopBox: 60 }, prem: { perDoor: 140, perTopBox: 65 }, pp: { perDoor: 150, perTopBox: 70 } },
  drawerBoxes: { cemux: 12, blum: 21 }, glazing: { small: 45, large: 90 },
  extras: [{ key: 'bin', name: 'Pull-out bin', unit: 'per unit', price: 30 }],
};
const SETTINGS = { priceList: PRICE_LIST, vatRate: 13.5, validityDays: 30,
  business: { tradingName: 'Elite Kitchens', signatureName: 'Test Person', phone: '01 000 0000', email: 'quotes@example.com', web: 'www.example.com', address: 'Test Street, Dublin', vatNumber: 'IE0000000X' } };

// ---- fake Meta. Documents and templates can behave differently (docMode / templateMode). ----
const meta = { media: [], messages: [], docMode: 'ok', templateMode: 'ok', uploadMode: 'ok', beforeReply: null };
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const hang = (opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
const REFUSALS = { 132001: 400, 131026: 400, 131049: 400, 131050: 400, 132015: 400, 100: 400, 131047: 400 };
const mockFetch = async (url, opts = {}) => {
  url = String(url);
  if (opts.method === 'POST' && /\/media$/.test(url)) {
    const f = opts.body.get('file');
    meta.media.push({ name: f.name, type: f.type, bytes: Buffer.from(await f.arrayBuffer()) });
    if (meta.uploadMode === 'refuse') return reply({ error: { code: 131053, message: 'Media upload error' } }, 400);
    return reply({ id: 'UPMEDIA' + meta.media.length });
  }
  if (opts.method === 'POST' && /\/messages$/.test(url)) {
    const body = JSON.parse(opts.body);
    meta.messages.push({ body });
    if (meta.beforeReply) await meta.beforeReply(body);
    const mode = body.type === 'template' ? meta.templateMode : meta.docMode;
    if (REFUSALS[mode]) return reply({ error: { code: Number(mode), message: 'Meta says no for 353851111111' } }, REFUSALS[mode]);
    if (mode === 'server') return reply({ error: { code: 1, message: 'Unknown' } }, 500);
    if (mode === 'noid') return reply({ messages: [] }, 200);
    if (mode === 'network') throw new TypeError('fetch failed');
    if (mode === 'hang') return hang(opts);
    return reply({ messages: [{ id: 'wamid.OUT' + meta.messages.length }] });
  }
  return reply({ error: { message: 'unexpected ' + url } }, 404);
};
const wa = createClient({ phoneId: '111', token: 'tok', version: 'v21.0' }, mockFetch);
let clock = NOW, withTemplate = true;
const tmpls = () => meta.messages.filter((m) => m.body.type === 'template' && m.body.template.name === TEMPLATE.name);
const docs = () => meta.messages.filter((m) => m.body.type === 'document');
const whats = () => whatsappChannel({ db, bucket, wa, quoteTemplate: withTemplate ? TEMPLATE : null, now: () => clock, timeoutMs: 60 });
const deps = { db, cfg, bucket };
const dd = () => ({ db, cfg, bucket, channels: { whatsapp: whats() } });
const run = (fn, data, nowMs = NOW) => fn(dd(), actor, data, { nowMs, uid: 'u1' });

let seq = 0;
const rid = () => 'req-' + (++seq) + '-abcdefgh';
const conv = async (p = P) => (await db.doc('conversations/' + p).get()).data();
const contact = async (p = P) => (await db.doc('contacts/' + p).get()).data();
const quote = async (id) => (await db.doc('quotes/' + id).get()).data();
const version = async (id, n = 1) => (await db.doc(`quotes/${id}/versions/${n}`).get()).data();
const settingsDoc = async () => (await db.doc('quoteSettings/current').get()).data();
const msgs = async (p = P) => (await db.collection(`conversations/${p}/messages`).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const deliveries = async (id) => (await db.collection(`quotes/${id}/deliveries`).get()).docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.version - b.version);
const dOf = async (id) => (await deliveries(id))[0];
const files = async (prefix) => (await bucket.getFiles({ prefix }))[0].map((f) => f.name);
const states = (r) => r.deliveries.map((d) => [d.channel, d.state]);
async function seed(p = P, convExtra = {}, name = 'Anna Murphy') {
  await db.doc('contacts/' + p).set({ phone: p, name, email: 'anna@example.com', address: '1 Main Street, Swords', location: 'Swords', createdAt: Timestamp.now() });
  await db.doc('conversations/' + p).set({ phone: p, name, createdAt: Timestamp.now(), updatedAt: Timestamp.now(), lastMessage: 'Hi', unreadCount: 2,
    lastInboundAt: Timestamp.fromMillis(NOW - 2 * H), ...convExtra });                                    // by default the customer wrote two hours ago: the window is open
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
const MSG = 'Hi Anna, please find attached your quotation (my own words).';
async function dataFor(id, over = {}, bytes = pdfBytes('q' + seq)) {
  const qq = await quote(id), s = await settingsDoc();
  const ct = (await db.doc('contacts/' + qq.phone).get()).data() || {}, cv = await conv(qq.phone);
  return { id, expectedRev: qq.rev, requestId: rid(), issueDate: Q.dublinDate(NOW), settingsRev: s.rev,
    customer: { name: ct.name || cv.name || null, email: ct.email || null, address: ct.address || null }, pdfUploadPath: await upload(bytes), pipeline: { value: 14500 },
    channels: ['whatsapp'], messages: { whatsapp: MSG }, ...over };
}
const sendOld = async (id, bytes) => { const d = await dataFor(id, {}, bytes); delete d.channels; delete d.messages; return Q.send(deps, actor, d, { nowMs: NOW, uid: 'u1' }); };   // Phase 6's own "mark sent by hand"
const headerOf = (m) => m.body.template.components.find((c) => c.type === 'header').parameters[0].document;
const bodyOf = (m) => m.body.template.components.find((c) => c.type === 'body').parameters.map((p) => p.text);

beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await bucket.deleteFiles({ force: true }).catch(() => {});
  Object.assign(meta, { media: [], messages: [], docMode: 'ok', templateMode: 'ok', uploadMode: 'ok', beforeReply: null });
  clock = NOW; withTemplate = true;
  await seed(); await Q.saveSettings(deps, actor, SETTINGS, { nowMs: NOW });
});

// ===================================================== the two routes, chosen by the window =================================
test('window OPEN: the normal document with the staff\'s own caption, exactly as before; no template is used', async () => {
  const { id } = await make();
  const r = await run(D.deliver, await dataFor(id));
  assert.deepEqual([r.sent, states(r)], [true, [['whatsapp', 'sent']]]);
  assert.equal(docs().length, 1); assert.equal(tmpls().length, 0);
  assert.equal(docs()[0].body.document.caption, MSG);
  const d = await dOf(id); assert.deepEqual([d.route, d.message], ['document', MSG]);
  assert.equal((await msgs())[0].quote.template, undefined);
});

test('window CLOSED: the approved quotation template goes out with the exact stored PDF as its Document header and the right variables', async () => {
  await seed(P, { ...CLOSED, inboxStatus: 'booked' });
  const { id } = await make();
  const bytes = pdfBytes('closed window');
  const r = await run(D.deliver, await dataFor(id, {}, bytes));
  assert.deepEqual([r.sent, r.status, states(r)], [true, 'sent', [['whatsapp', 'sent']]]);
  const q = await quote(id), v = await version(id), filename = `EliteKitchens-${q.ref}-v1.pdf`;
  assert.equal(docs().length, 0);                                                                     // no free-form message: it would be refused
  assert.equal(tmpls().length, 1); assert.equal(meta.messages.length, 1);                             // exactly one message, the template
  assert.deepEqual(meta.messages[0].body, { messaging_product: 'whatsapp', to: P, type: 'template', template: { name: TEMPLATE.name, language: { code: 'en' }, components: [
    { type: 'header', parameters: [{ type: 'document', document: { id: 'UPMEDIA1', filename } }] },
    { type: 'body', parameters: [{ type: 'text', text: 'Anna' }, { type: 'text', text: q.ref }] }] } });
  assert.equal(meta.media.length, 1); assert.ok(meta.media[0].bytes.equals(bytes));                  // the exact stored file is the header
  assert.equal(sha(meta.media[0].bytes), v.pdf.sha256);
  assert.equal(meta.media[0].type, 'application/pdf'); assert.equal(meta.media[0].name, filename);
  // the existing Phase 6 central rules, unchanged: Sent, Booked -> Quoted, the pipeline value
  assert.deepEqual([q.status, (await conv()).inboxStatus, (await contact()).quoteValue], ['sent', 'quoted', 14500]);
  assert.deepEqual(r.committed.stage, { from: 'booked', to: 'quoted', corrected: false });
});

test('the delivery record says it went as the template and keeps what the customer was REALLY sent, not the caption staff typed', async () => {
  await seed(P, CLOSED);
  const { id } = await make();
  await run(D.deliver, await dataFor(id));
  const q = await quote(id), d = await dOf(id);
  const sentText = WS.quoteTemplateText('Anna', q.ref);
  assert.deepEqual([d.state, d.route, d.message, d.provider], ['sent', 'template', sentText, { id: 'wamid.OUT1' }]);
  assert.ok(!JSON.stringify(d).includes('my own words'));
  assert.match(sentText, /^Hi Anna, as discussed, please find attached your Elite Kitchens quotation [A-Z]+-\d+\./);
  assert.deepEqual([d.to, d.customerName], [null, 'Anna Murphy']);                                  // the recipient is unchanged; the name is kept for the template (and a retry)
});

test('it appears in the existing conversation as the outgoing document with the template\'s words, labelled with the quote, with its own PDF copy', async () => {
  await seed(P, CLOSED);
  const { id } = await make();
  const bytes = pdfBytes('chat copy');
  const before = await conv();
  await run(D.deliver, await dataFor(id, {}, bytes));
  const q = await quote(id), filename = `EliteKitchens-${q.ref}-v1.pdf`, text = WS.quoteTemplateText('Anna', q.ref);
  const m = await msgs();
  assert.equal(m.length, 1);
  assert.deepEqual([m[0].id, m[0].direction, m[0].type, m[0].status, m[0].body], ['wamid.OUT1', 'out', 'document', 'sent', text]);
  assert.deepEqual(m[0].quote, { id, ref: q.ref, version: 1, deliveryId: (await dOf(id)).id, template: true });
  assert.deepEqual(m[0].media, { mimeType: 'application/pdf', filename, size: bytes.length, caption: text, storagePath: `media/${P}/wamid.OUT1/${filename}`, status: 'stored', waMediaId: 'UPMEDIA1', sha256: sha(bytes) });
  assert.ok((await bucket.file(m[0].media.storagePath).download())[0].equals(bytes));
  const c = await conv();
  assert.deepEqual([c.lastMessageType, c.lastMessageDirection, c.lastMessage], ['document', 'out', text.slice(0, 120)]);      // the list preview is the first 120 characters
  assert.equal(c.lastInboundAt.toMillis(), before.lastInboundAt.toMillis());                          // a template does NOT open the window: only the customer's reply does
  assert.equal(WS.windowStatus(c, NOW, null).state, 'closed');
});

// ===================================================== the right name, number and PDF =======================================
test('the first name comes from the customer on the quote; a name that is not a usable first name becomes "there"', async () => {
  for (const [name, first] of [['Anna Murphy', 'Anna'], ['brian o\'Neill', 'brian'], ['+353 85 111 1111', 'there'], ['', 'there'], ['Ünal Çelik', 'Ünal']]) {
    meta.messages.length = 0; meta.media.length = 0;
    const p = '35386' + String(2000000 + seq++); await seed(p, CLOSED, name);
    const { id } = await make(p);
    const r = await run(D.deliver, await dataFor(id));
    assert.equal(r.sent, true, name);
    assert.equal(bodyOf(tmpls()[0])[0], first, name);
    assert.equal((await msgs(p))[0].body, WS.quoteTemplateText(first, (await quote(id)).ref));
  }
});

test('the quote number is the quote\'s own, with the version after v1; each version carries its OWN stored PDF', async () => {
  await seed(P, CLOSED);
  const { id } = await make();
  const v1 = pdfBytes('version one'), v2 = pdfBytes('version two');
  await run(D.deliver, await dataFor(id, {}, v1));
  await Q.revise(deps, actor, { id, expectedRev: (await quote(id)).rev }, { nowMs: NOW });
  await run(D.deliver, await dataFor(id, {}, v2));
  const ref = (await quote(id)).ref;
  assert.deepEqual(tmpls().map(bodyOf), [['Anna', ref], ['Anna', `${ref} v2`]]);
  assert.deepEqual(tmpls().map((m) => headerOf(m).filename), [`EliteKitchens-${ref}-v1.pdf`, `EliteKitchens-${ref}-v2.pdf`]);
  assert.ok(meta.media[0].bytes.equals(v1)); assert.ok(meta.media[1].bytes.equals(v2));
  assert.deepEqual((await msgs()).map((m) => [m.quote.version, m.media.sha256]).sort(), [[1, sha(v1)], [2, sha(v2)]]);
});

test('re-sending an OLDER version through the template sends that version\'s own PDF and number, never the newest', async () => {
  await seed(P, CLOSED);
  const { id } = await make();
  const v1 = pdfBytes('version one'), v2 = pdfBytes('version two');
  await sendOld(id, v1);
  await Q.revise(deps, actor, { id, expectedRev: (await quote(id)).rev }, { nowMs: NOW });
  await sendOld(id, v2);
  const before = await quote(id);
  const r = await run(D.deliver, { id, version: 1, requestId: rid(), channels: ['whatsapp'], messages: { whatsapp: MSG } });
  assert.deepEqual([r.sent, r.committed], [true, null]);                                              // no new version, no new CRM change
  assert.ok(meta.media[0].bytes.equals(v1)); assert.ok(!meta.media[0].bytes.equals(v2));
  assert.deepEqual(bodyOf(tmpls()[0]), ['Anna', before.ref]);                                         // v1: no suffix
  assert.deepEqual(await quote(id), before);
});

test('customer A can never receive customer B\'s PDF or details, even when both are sent at the same moment', async () => {
  await seed(P, CLOSED, 'Anna Murphy'); await seed(R2, CLOSED, 'Brian Byrne');
  const a = (await make(P)).id, b = (await make(R2)).id;
  const pa = pdfBytes('ANNA ONLY'), pb = pdfBytes('BRIAN ONLY');
  const da = await dataFor(a, {}, pa), db2 = await dataFor(b, {}, pb);
  const rs = await Promise.all([run(D.deliver, da), run(D.deliver, db2)]);
  assert.deepEqual(rs.map((x) => x.sent), [true, true]);
  assert.equal(tmpls().length, 2);
  const mediaById = Object.fromEntries(meta.media.map((m, i) => ['UPMEDIA' + (i + 1), m.bytes]));
  const byTo = Object.fromEntries(tmpls().map((m) => [m.body.to, m]));
  assert.ok(mediaById[headerOf(byTo[P]).id].equals(pa)); assert.deepEqual(bodyOf(byTo[P]), ['Anna', (await quote(a)).ref]);
  assert.ok(mediaById[headerOf(byTo[R2]).id].equals(pb)); assert.deepEqual(bodyOf(byTo[R2]), ['Brian', (await quote(b)).ref]);
  assert.deepEqual([(await msgs(P)).length, (await msgs(R2)).length], [1, 1]);
  assert.equal((await msgs(P))[0].media.sha256, sha(pa)); assert.equal((await msgs(R2))[0].media.sha256, sha(pb));
  assert.ok(!(await msgs(P))[0].body.includes('Brian') && !(await msgs(R2))[0].body.includes('Anna'));
});

// ===================================================== the window changes while staff are sending ===========================
test('the dialog saw an OPEN window but it has closed by the time Send reaches the server: the template is used instead of a failure', async () => {
  await seed(P, { lastInboundAt: Timestamp.fromMillis(NOW - 24 * H + 1 * MIN) });                     // one minute left when the dialog opened
  const { id } = await make();
  const data = await dataFor(id, { messages: { whatsapp: 'My own words that the template cannot carry.' } });
  clock = NOW + 5 * MIN;                                                                              // ...and it has closed
  const r = await run(D.deliver, data);
  assert.deepEqual([r.sent, states(r)], [true, [['whatsapp', 'sent']]]);
  assert.equal(docs().length, 0); assert.equal(tmpls().length, 1);
  assert.equal((await dOf(id)).route, 'template'); assert.equal((await quote(id)).status, 'sent');
});

test('the window closes AFTER our own check (Meta answers 131047 to the document): that refusal sent nothing, so the template follows: one message reaches the customer', async () => {
  const { id } = await make();                                                                        // open when checked
  meta.docMode = '131047';
  const r = await run(D.deliver, await dataFor(id));
  assert.deepEqual([r.sent, states(r)], [true, [['whatsapp', 'sent']]]);
  assert.deepEqual(meta.messages.map((m) => m.body.type), ['document', 'template']);                  // the refused document, then the template
  assert.equal(meta.media.length, 1);                                                                 // the PDF was uploaded once and re-used
  assert.equal(headerOf(tmpls()[0]).id, 'UPMEDIA1');
  const d = await dOf(id); assert.deepEqual([d.state, d.route, d.attempts], ['sent', 'template', 1]);
  assert.deepEqual((await msgs()).map((m) => m.id), ['wamid.OUT2']);                                 // ONE message in the chat
});

test('...and if that fallback template is then refused, it is a plain failure; if its answer is unclear, it is NOT CONFIRMED (and never retried by itself)', async () => {
  const a = (await make()).id;
  meta.docMode = '131047'; meta.templateMode = '132001';
  const r1 = await run(D.deliver, await dataFor(a));
  assert.deepEqual([r1.sent, states(r1), r1.deliveries[0].error.code], [false, [['whatsapp', 'failed']], '132001']);
  assert.equal((await quote(a)).status, 'draft');
  await seed(R2, {}, 'Brian Byrne'); const b = (await make(R2)).id;
  meta.templateMode = 'server';
  const r2 = await run(D.deliver, await dataFor(b));
  assert.deepEqual([r2.sent, states(r2), r2.deliveries[0].error.code], [false, [['whatsapp', 'unknown']], 'not_confirmed']);
  await rejects(run(D.retry, { id: b, deliveryId: r2.deliveries[0].id }), 'failed-precondition', /could not confirm/);
  assert.equal(tmpls().length, 2);                                                                    // one attempt each, no automatic second try
});

test('the template is a fallback ONLY for "the window closed" (131047): any other answer to the free-form document, unclear or refused, is never followed by a second message', async () => {
  for (const mode of ['server', 'noid', 'network', 'hang', '131026', '131050']) {
    meta.docMode = mode;
    const p = '35386' + String(6000000 + seq++); await seed(p, {}, 'Anna Murphy');                     // the window is OPEN: the document route
    const { id } = await make(p);
    const r = await run(D.deliver, await dataFor(id));
    const unclear = ['server', 'noid', 'network', 'hang'].includes(mode);
    assert.deepEqual([r.sent, r.deliveries[0].state], [false, unclear ? 'unknown' : 'failed'], mode);
    assert.equal(tmpls().length, 0, mode);                                                            // a refused or unclear document is NOT answered with a template
    assert.equal(docs().filter((m) => m.body.to === p).length, 1, mode);
    assert.equal((await quote(id)).status, 'draft', mode);
  }
});

// ===================================================== Meta refuses or does not answer ======================================
test('Meta refuses the template: a plain failure; the quote is NOT marked Sent; nothing in the chat; the CRM is untouched; a retry works once fixed', async () => {
  await seed(P, { ...CLOSED, inboxStatus: 'booked' });
  const { id } = await make();
  meta.templateMode = '132001';
  const r = await run(D.deliver, await dataFor(id));
  assert.deepEqual([r.sent, r.status, states(r)], [false, 'draft', [['whatsapp', 'failed']]]);
  assert.equal(r.deliveries[0].error.code, '132001');
  assert.match(r.deliveries[0].error.text, /doesn't know this template.*\(code 132001\)/);
  assert.ok(!r.deliveries[0].error.text.includes('353851111111'));                                    // Meta's own message (which had a number in it) is not stored
  const q = await quote(id);
  assert.deepEqual([q.status, q.sentVersion, (await conv()).inboxStatus, (await contact()).quoteValue], ['draft', null, 'booked', undefined]);
  assert.equal((await msgs()).length, 0);
  assert.equal((await version(id)).state, 'draft'); assert.ok(q.preparedSend);                        // locked draft: "a send is in progress"
  meta.templateMode = 'ok';                                                                           // the template is fixed
  const again = await run(D.retry, { id, deliveryId: r.deliveries[0].id });
  assert.deepEqual([again.sent, states(again)], [true, [['whatsapp', 'sent']]]);
  assert.equal(tmpls().length, 2); assert.equal((await dOf(id)).route, 'template'); assert.equal((await dOf(id)).attempts, 2);
});

test('every Meta refusal of the template has plain words, and the stored error holds a code but no customer detail', async () => {
  for (const [code, re] of [['131026', /can't deliver to this number/], ['131049', /held the message back/], ['131050', /chosen not to receive/], ['132015', /paused this template/], ['100', /refused the quotation template \(code 100\)/]]) {
    meta.templateMode = code;
    const p = '35386' + String(3000000 + seq++); await seed(p, CLOSED, 'Anna Murphy');
    const { id } = await make(p);
    const r = await run(D.deliver, await dataFor(id));
    assert.deepEqual([r.sent, r.deliveries[0].state, r.deliveries[0].error.code], [false, 'failed', code]);
    assert.match(r.deliveries[0].error.text, re); assert.equal((await quote(id)).status, 'draft');
    const stored = (await dOf(id)).error;                                                             // Meta's own words (which carried a number) are never stored
    assert.ok(!JSON.stringify(stored).includes('Meta says no') && !/\d{7,}/.test(stored.text));
  }
});

test('a PDF upload that fails (the header cannot be made): nothing is sent, a plain failure', async () => {
  await seed(P, CLOSED);
  const { id } = await make();
  meta.uploadMode = 'refuse';
  const r = await run(D.deliver, await dataFor(id));
  assert.deepEqual([r.sent, r.deliveries[0].error.code, meta.messages.length], [false, 'upload_failed', 0]);
});

test('no answer, a server error or an answer without a message id is NOT CONFIRMED: not marked Sent, not retried by itself, and staff can settle it', async () => {
  for (const mode of ['hang', 'server', 'noid', 'network']) {
    meta.templateMode = mode;
    const p = '35386' + String(4000000 + seq++); await seed(p, { ...CLOSED, inboxStatus: 'booked' }, 'Anna Murphy');
    const { id } = await make(p);
    const r = await run(D.deliver, await dataFor(id));
    assert.deepEqual([r.sent, r.status, states(r), r.deliveries[0].error.code], [false, 'draft', [['whatsapp', 'unknown']], 'not_confirmed'], mode);
    assert.equal((await conv(p)).inboxStatus, 'booked'); assert.equal((await msgs(p)).length, 0);
    const n = tmpls().length;
    await rejects(run(D.retry, { id, deliveryId: r.deliveries[0].id }), 'failed-precondition', /could not confirm/);
    assert.equal(tmpls().length, n, mode);                                                            // no second template
    if (mode === 'hang') {                                                                            // staff checked WhatsApp: it did arrive
      const settled = await run(D.resolve, { id, deliveryId: r.deliveries[0].id, outcome: 'delivered' });
      assert.equal(settled.sent, true); assert.equal((await quote(id)).status, 'sent'); assert.equal((await conv(p)).inboxStatus, 'quoted');
    }
  }
});

// ===================================================== once only: double click, two staff ===================================
test('a double click, a refresh and simultaneous identical requests send ONE template', async () => {
  await seed(P, CLOSED);
  const { id } = await make();
  const data = await dataFor(id);
  const rs = await Promise.allSettled([1, 2, 3, 4, 5].map(() => run(D.deliver, data)));
  assert.ok(rs.some((x) => x.status === 'fulfilled'));
  for (const x of rs.filter((x) => x.status === 'rejected')) assert.match(x.reason.message, /PDF upload was not found/);
  assert.equal(tmpls().length, 1); assert.equal(meta.media.length, 1); assert.equal((await msgs()).length, 1);
  const again = await run(D.deliver, data);                                                           // a refresh: the same request once more
  assert.equal(tmpls().length, 1); assert.equal(again.sent, true);
});

test('two staff pressing Send together, and a stale tab, cannot send a second template', async () => {
  await seed(P, CLOSED);
  const { id } = await make();
  const a = await dataFor(id), b = await dataFor(id, {}, pdfBytes('second tab'));
  const rs = await Promise.allSettled([run(D.deliver, a), run(D.deliver, b)]);
  assert.equal(rs.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(rs.find((x) => x.status === 'rejected').reason.code, 'failed-precondition');
  assert.equal(tmpls().length, 1);
  await rejects(run(D.deliver, await dataFor(id, { expectedRev: 1 })), 'failed-precondition');
  assert.equal(tmpls().length, 1);
});

test('a retry whose window has since OPENED goes as the normal document with the stored message (the route is decided again at send time)', async () => {
  await seed(P, CLOSED);
  const { id } = await make();
  meta.templateMode = '132001';
  const r = await run(D.deliver, await dataFor(id));
  assert.equal(r.sent, false);
  await seed(P, { lastInboundAt: Timestamp.fromMillis(NOW - 1 * H) });                                // the customer wrote back
  const again = await run(D.retry, { id, deliveryId: r.deliveries[0].id });
  assert.deepEqual([again.sent, docs().length, (await dOf(id)).route, (await dOf(id)).message], [true, 1, 'document', MSG]);
  assert.equal(docs()[0].body.document.caption, MSG);
});

// ===================================================== the template is only a way to deliver ================================
test('both routes mark the quote Sent through the SAME central rules: the same stage, value, status and history', async () => {
  await seed(P, { inboxStatus: 'booked' }); await seed(R2, { ...CLOSED, inboxStatus: 'booked' }, 'Brian Byrne');
  const a = (await make(P)).id, b = (await make(R2)).id;
  const ra = await run(D.deliver, await dataFor(a)), rb = await run(D.deliver, await dataFor(b));
  assert.deepEqual([(await dOf(a)).route, (await dOf(b)).route], ['document', 'template']);
  assert.deepEqual(ra.committed, rb.committed);
  const [qa, qb] = [await quote(a), await quote(b)];
  assert.deepEqual([qa.status, qa.sentVersion, qa.draftVersion], [qb.status, qb.sentVersion, qb.draftVersion]);
  assert.deepEqual(qa.history.map((x) => x.action), qb.history.map((x) => x.action));
  assert.deepEqual([(await conv(P)).inboxStatus, (await contact(P)).quoteValue], [(await conv(R2)).inboxStatus, (await contact(R2)).quoteValue]);
});

test('a template can go out alongside the email channel: they are independent, as for any WhatsApp delivery', async () => {
  await seed(P, CLOSED);
  const mail = { id: 'email', maxMessage: 5000, async check() { return null; }, async send() { throw new D.ChannelError('The email was refused.', { code: 'refused', definite: true }); } };
  const { id } = await make();
  const data = await dataFor(id, { channels: ['whatsapp', 'email'], messages: { whatsapp: MSG, email: 'Dear Anna' } });
  const r = await D.deliver({ ...dd(), channels: { whatsapp: whats(), email: mail } }, actor, data, { nowMs: NOW, uid: 'u1' });
  assert.deepEqual(states(r), [['whatsapp', 'sent'], ['email', 'failed']]); assert.equal(r.sent, true); assert.equal(tmpls().length, 1);
});

// ===================================================== Reopen conversation is untouched =====================================
test('Reopen conversation still works normally; a quote template neither uses its allowance nor opens the window; a pending Reopen does not stop a quote', async () => {
  await seed(P, CLOSED);
  const { id } = await make();
  await run(D.deliver, await dataFor(id));                                                            // a quote goes out as the template
  assert.equal((await conv()).reopen, undefined);                                                     // it is not a Reopen
  assert.equal(WS.windowStatus(await conv(), NOW, null).canReopen, true);                             // so the allowance is still there
  const ro = await R.reopen({ db, wa, cfg }, actor, { phone: P, requestId: rid() }, { nowMs: NOW });  // M1's Reopen: its own template, as before
  assert.equal(ro.state, 'sent');
  const reopenMsg = meta.messages.at(-1).body;
  assert.deepEqual([reopenMsg.type, reopenMsg.template.name], ['template', 'elite_kitchens_reopen']);
  assert.equal(reopenMsg.template.components[0].type, 'body');                                        // body only: no document header
  const c = await conv();
  assert.equal(WS.windowStatus(c, NOW, null).state, 'awaiting');                                      // still NOT open until the customer replies
  // a second quote while the Reopen is waiting: the window is still closed, so it goes as the quote template and is not blocked
  await Q.revise(deps, actor, { id, expectedRev: (await quote(id)).rev }, { nowMs: NOW });
  const r = await run(D.deliver, await dataFor(id));
  assert.deepEqual([r.sent, tmpls().length], [true, 2]);
});

test('with NO quotation template configured a closed window is refused exactly as before (the route can be switched off)', async () => {
  withTemplate = false;
  await seed(P, { ...CLOSED, inboxStatus: 'booked' });
  const { id } = await make();
  const r = await run(D.deliver, await dataFor(id));
  assert.deepEqual([r.sent, states(r), r.deliveries[0].error.code, r.deliveries[0].error.text], [false, [['whatsapp', 'failed']], 'window_closed', WINDOW_CLOSED]);
  assert.deepEqual([meta.media.length, meta.messages.length, (await conv()).inboxStatus], [0, 0, 'booked']);
});

// ===================================================== privacy and erasure ==================================================
test('logs never hold names, numbers, addresses or the template words, for every failure shape', async () => {
  const seen = [], orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => seen.push(a.map(String).join(' '));
  let stored = '';
  try {
    let i = 0;
    for (const mode of ['132001', '131026', 'server', 'noid', 'network', 'hang']) {
      meta.templateMode = mode;
      const p = '35386500000' + (++i); await seed(p, CLOSED, 'Anna Murphy');
      const { id } = await make(p);
      await run(D.deliver, await dataFor(id));
    }
    meta.templateMode = 'ok'; meta.docMode = '131047';
    const p = '353865099999'; await seed(p, {}, 'Anna Murphy'); const { id } = await make(p);
    await run(D.deliver, await dataFor(id));
    stored = JSON.stringify((await db.collectionGroup('deliveries').get()).docs.map((d) => d.data().error));
  } finally { Object.assign(console, orig); }
  const text = seen.join('\n') + stored;
  for (const secret of ['3538650', '353851111111', 'Anna', 'Murphy', 'anna@example.com', 'quotation', 'as discussed', 'Main Street', 'Meta says no']) assert.ok(!text.includes(secret), 'leaked: ' + secret);
});

test('deleting the customer erases the template message in the chat, its PDF copy, the quote PDF and the delivery record', async () => {
  await seed(P, CLOSED);
  const { id } = await make();
  await run(D.deliver, await dataFor(id));
  assert.equal((await files(`media/${P}/`)).length, 1); assert.equal((await files(`quotes/${P}/`)).length, 1);
  await h.deleteCustomer(staff, { phone: P, confirm: '1111' }, deps);
  assert.deepEqual(await files('media/'), []); assert.deepEqual(await files('quotes/'), []);
  assert.equal((await db.collectionGroup('deliveries').get()).size, 0); assert.equal((await db.collection(`conversations/${P}/messages`).get()).size, 0);
});

test('only staff can use it: a stranger cannot make Elite OS send a template to anyone', async () => {
  await seed(P, CLOSED);
  const { id } = await make();
  const data = await dataFor(id);
  for (const who of [null, { uid: 'x', token: { email: 'stranger@gmail.com', email_verified: true, staff: true } }, { uid: 'x', token: { email: 'thomas@example.com', email_verified: true } }]) {
    await assert.rejects(h.deliverQuote(who, data, dd()), (e) => e.code === 'unauthenticated' || e.code === 'permission-denied');
  }
  assert.equal(meta.messages.length, 0); assert.equal((await quote(id)).status, 'draft');
  assert.equal((await h.deliverQuote(staff, { ...data, issueDate: Q.dublinDate(Date.now()) }, dd())).sent, true); assert.equal(tmpls().length, 1);   // staff can, through the real wrapper (today's real date)
});

test('the browser copy of the wording (public/window-state.js) matches the server\'s, template text included', () => {
  const fs = require('fs'), path = require('path');
  assert.ok(fs.readFileSync(path.join(__dirname, '../../public/window-state.js')).equals(fs.readFileSync(path.join(__dirname, '../lib/windowState.js'))));
  assert.equal(WS.quoteLabel('EK-0104', 1), 'EK-0104'); assert.equal(WS.quoteLabel('EK-0104', 3), 'EK-0104 v3');
  assert.equal(WS.quoteTemplateText('Anna', 'EK-0104'), 'Hi Anna, as discussed, please find attached your Elite Kitchens quotation EK-0104. If you have any questions or would like to make any changes, just reply here.');
});
