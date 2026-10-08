// Phase 6.1 M1: "Reopen conversation", a general WhatsApp capability (docs/PHASE6_1_PLAN.md). Real Firestore emulator and a fake
// Meta (no real message is ever sent). Every name and number below is made up.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const h = require('../lib/handlers');
const store = require('../lib/store');
const R = require('../lib/reopen');
const WS = require('../lib/windowState');
const { createClient } = require('../lib/whatsapp');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const staff = { uid: 'u1', token: { email: 'thomas@example.com', email_verified: true, staff: true } };
const actor = { kind: 'staff', id: 'thomas@example.com' };
const cfg = { allowedEmails: 'thomas@example.com', reopenTemplate: 'elite_kitchens_reopen', reopenLang: 'en' };
const rejects = (p, code, msg) => assert.rejects(p, (e) => e.code === code && (!msg || msg.test(e.message)), `expected ${code}${msg ? ' ' + msg : ''}`);

const MIN = 60 * 1000, H = 60 * MIN;
const NOW = Date.now();
const P = '353851111111', Q = '353852222222';
let seq = 0;
const rid = () => 'req-' + (++seq) + '-abcdefgh';

// ---- fake Meta ----
const calls = []; let mode = 'ok', beforeReply = null;
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const mockFetch = async (url, opts = {}) => {
  calls.push({ url: String(url), auth: opts.headers && opts.headers.Authorization, body: JSON.parse(opts.body) });
  if (beforeReply) await beforeReply();
  if (mode === 'refuse') return reply({ error: { code: 132001, message: 'Template name does not exist in the translation' } }, 400);
  if (mode === 'refuse-number') return reply({ error: { code: 131026, message: 'Message undeliverable to 353851111111' } }, 400);
  if (/^code-\d+$/.test(mode)) return reply({ error: { code: Number(mode.slice(5)), message: 'Refused' } }, 400);
  if (mode === 'leaky') return reply({ error: { code: 131026, message: 'Recipient Anna Murphy (anna@example.com, +353 85 111 1111, 085-111-1111) cannot receive: quick question about your kitchen' } }, 400);
  if (mode === 'server') return reply({ error: { code: 1, message: 'Unknown error' } }, 500);
  if (mode === 'noid') return reply({ messages: [] }, 200);
  if (mode === 'network') throw new TypeError('fetch failed');
  if (mode === 'hang') return new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  return reply({ messages: [{ id: 'wamid.RO' + calls.length }] });
};
const wa = createClient({ phoneId: '111', token: 'tok', version: 'v21.0' }, mockFetch);
const deps = { db, cfg, wa };
const run = (data, nowMs = NOW, d = deps) => R.reopen(d, actor, data, { nowMs });
const go = (phone = P, nowMs = NOW, d = deps) => run({ phone, requestId: rid() }, nowMs, d);

const conv = async (p = P) => (await db.doc('conversations/' + p).get()).data();
const msgs = async (p = P) => (await db.collection('conversations/' + p + '/messages').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
async function seed(p = P, { name = 'Anna Murphy', contactName = name, noContact = false, inboundAgoMs = 30 * H, conv: extra = {} } = {}) {
  if (!noContact) await db.doc('contacts/' + p).set({ phone: p, name: contactName, createdAt: Timestamp.now() });
  await db.doc('conversations/' + p).set({ phone: p, ...(name ? { name } : {}), createdAt: Timestamp.now(), updatedAt: Timestamp.now(), lastMessage: 'Hi', unreadCount: 2,
    ...(inboundAgoMs == null ? {} : { lastInboundAt: Timestamp.fromMillis(NOW - inboundAgoMs) }), ...extra });
}
const statusOf = async (p = P, nowMs = NOW) => {
  const c = await conv(p), w = c.reopen && c.reopen.wamid;
  const m = w ? (await db.doc(`conversations/${p}/messages/${w}`).get()) : null;
  return WS.windowStatus(c, nowMs, m && m.exists ? m.data() : null);
};
const param = (i = 0) => calls[i].body.template.components[0].parameters[0].text;

beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  calls.length = 0; mode = 'ok'; beforeReply = null;
});

// ============================================== the window state (one rule, server and screen) ===========================
const ts = (ms) => ({ toMillis: () => ms });
test('window state: open, awaiting and closed are worked out from the last message and the last Reopen', () => {
  const n = 1e12;
  const st = (c, msg) => WS.windowStatus(c, n, msg);
  assert.equal(st({ lastInboundAt: ts(n - 24 * H + 1) }).state, 'open');                                  // one millisecond left
  assert.equal(st({ lastInboundAt: ts(n - 24 * H) }).state, 'closed');                                    // exactly 24 hours: closed
  assert.equal(st({}).state, 'closed'); assert.equal(st(null).state, 'closed');                           // never messaged
  assert.equal(st({ lastInboundAt: ts(n - 24 * H + 1) }).canReopen, false);                               // nothing to reopen while open
  assert.equal(st({ lastInboundAt: ts(n - 24 * H + 1) }).openUntil, n + 1);
  const old = { lastInboundAt: ts(n - 30 * H) };
  assert.deepEqual([st(old).state, st(old).canReopen], ['closed', true]);
  const r = (state, at, extra = {}) => ({ ...old, reopen: { state, claimedAt: ts(at), ...(state === 'sent' ? { sentAt: ts(at), wamid: 'w' } : {}), ...extra } });
  // a template just sent: waiting for the customer, and the 24-hour allowance is used
  const sent = st(r('sent', n - 5 * MIN));
  assert.deepEqual([sent.state, sent.canReopen, sent.reopen.kind, sent.nextReopenAt], ['awaiting', false, 'sent', n - 5 * MIN + 24 * H]);
  assert.equal(st(r('sent', n - 5 * MIN), { status: 'delivered' }).reopen.kind, 'delivered');
  assert.equal(st(r('sent', n - 5 * MIN), { status: 'read' }).reopen.kind, 'read');
  assert.equal(st(r('sending', n - 1 * MIN)).state, 'awaiting');                                          // in progress
  assert.equal(st(r('sending', n - 1 * MIN)).reopen.kind, 'sending');
  assert.equal(st(r('sending', n - 10 * MIN)).reopen.kind, 'unsure');                                     // stuck: not confirmed
  assert.deepEqual([st(r('unknown', n - 10 * MIN)).state, st(r('unknown', n - 10 * MIN)).canReopen], ['awaiting', false]);
  // refused by Meta, or reported never delivered: closed, and free to try again (the customer never saw it)
  assert.deepEqual([st(r('failed', n - 5 * MIN)).state, st(r('failed', n - 5 * MIN)).canReopen], ['closed', true]);
  const und = st(r('sent', n - 5 * MIN), { status: 'failed', error: '132015: Template paused' });
  assert.deepEqual([und.state, und.canReopen, und.reopen.kind], ['closed', true, 'undelivered']);
  // ... except Meta's own "wait 24 hours" and "opted out" answers, which still count
  for (const code of ['131049', '131050']) {
    const s = st(r('sent', n - 5 * MIN), { status: 'failed', error: code + ': held back' });
    assert.deepEqual([s.state, s.canReopen], ['closed', false], code);
  }
  // after 24 hours the allowance is back, and "waiting" ends: closed again, with the old attempt as history
  const late = st(r('sent', n - 25 * H));
  assert.deepEqual([late.state, late.canReopen, late.reopen.kind], ['closed', true, 'sent']);
  // the customer replies: open, whatever the Reopen state was
  assert.equal(st({ lastInboundAt: ts(n - 1 * MIN), reopen: { state: 'sent', sentAt: ts(n - 5 * MIN), claimedAt: ts(n - 5 * MIN), wamid: 'w' } }).state, 'open');
  // a Reopen older than the customer's last message is history, not "waiting"
  const older = st({ lastInboundAt: ts(n - 30 * H), reopen: { state: 'sent', sentAt: ts(n - 40 * H), claimedAt: ts(n - 40 * H), wamid: 'w' } });
  assert.deepEqual([older.state, older.canReopen], ['closed', true]);
});

test('first names and the Reopen wording', () => {
  assert.equal(WS.firstName('Anna Murphy'), 'Anna');
  assert.equal(WS.firstName('  Zoë   Ní  Bhriain '), 'Zoë');
  assert.equal(WS.firstName('Brian\nByrne\t'), 'Brian');
  for (const none of [null, undefined, '', '   ', '085 123 4567', '+353 85 123 4567', 'x'.repeat(41)]) assert.equal(WS.firstName(none), 'there', String(none));
  assert.equal(WS.reopenText('Anna'), "Hi Anna, it's Elite Kitchens. We have a quick question regarding your project. When you have a moment, please reply here and we'll continue the conversation.");
});

test('the browser copy public/window-state.js is identical to functions/lib/windowState.js, and loads as WindowState', () => {
  const orig = path.join(__dirname, '../lib/windowState.js'), copy = path.join(__dirname, '../../public/window-state.js');
  assert.ok(fs.existsSync(copy), 'public/window-state.js is missing');
  assert.ok(fs.readFileSync(copy).equals(fs.readFileSync(orig)), 'the two copies differ: copy functions/lib/windowState.js over public/window-state.js');
  const sandbox = {}; vm.runInNewContext(fs.readFileSync(copy, 'utf8'), sandbox);
  assert.equal(typeof sandbox.WindowState.windowStatus, 'function');
  assert.equal(sandbox.WindowState.windowStatus({}, 1e12).state, 'closed');
  assert.equal(sandbox.WindowState.WINDOW_MS, 24 * H);
});

// =========================================================== who may call =================================================
test('only signed-in, allowlisted staff can reopen a conversation; nothing is sent or written otherwise', async () => {
  await seed();
  for (const [who, code] of [[null, 'unauthenticated'],
    [{ uid: 'x', token: { email: 'stranger@gmail.com', email_verified: true, staff: true } }, 'permission-denied'],
    [{ uid: 'x', token: { email: 'thomas@example.com', email_verified: true } }, 'permission-denied']]) {
    await rejects(h.reopenConversation(who, { phone: P, requestId: rid() }, deps), code);
  }
  assert.equal(calls.length, 0); assert.equal((await conv()).reopen, undefined);
  const r = await h.reopenConversation(staff, { phone: P, requestId: rid() }, deps);           // staff can, through the real wrapper
  assert.deepEqual([r.ok, r.state], [true, 'sent']);
  assert.equal((await conv()).reopen.by, 'thomas@example.com');
});

test('bad input is refused before anything happens', async () => {
  await seed();
  for (const [d, code] of [[null, 'invalid-argument'], [[], 'invalid-argument'], [{ phone: P }, 'invalid-argument'], [{ phone: P, requestId: 'short' }, 'invalid-argument'],
    [{ phone: P, requestId: 'has spaces in it' }, 'invalid-argument'], [{ phone: '123', requestId: rid() }, 'invalid-argument'], [{ requestId: rid() }, 'invalid-argument'],
    [{ phone: P, requestId: rid(), template: 'other' }, 'invalid-argument'], [{ phone: Q, requestId: rid() }, 'not-found']]) {
    await rejects(run(d), code, undefined);
  }
  assert.equal(calls.length, 0); assert.equal((await conv()).reopen, undefined);
});

// ============================================================ the send ====================================================
test('Reopen sends the approved template with the first name only, records it in the chat, and does NOT open free-form messaging', async () => {
  await seed();
  const before = await conv();
  const r = await go();
  assert.deepEqual([r.ok, r.existing, r.state], [true, false, 'sent']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auth, 'Bearer tok'); assert.match(calls[0].url, /\/111\/messages$/);
  assert.deepEqual(calls[0].body, { messaging_product: 'whatsapp', to: P, type: 'template',
    template: { name: 'elite_kitchens_reopen', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Anna' }] }] } });
  const m = await msgs();
  assert.equal(m.length, 1);
  assert.deepEqual([m[0].id, m[0].direction, m[0].type, m[0].status], ['wamid.RO1', 'out', 'template', 'sent']);
  assert.equal(m[0].body, '[template: elite_kitchens_reopen] ' + WS.reopenText('Anna'));
  const c = await conv();
  assert.deepEqual([c.reopen.state, c.reopen.wamid, c.reopen.by, c.reopen.templateName], ['sent', 'wamid.RO1', 'thomas@example.com', 'elite_kitchens_reopen']);
  assert.equal(c.lastMessageType, 'template'); assert.equal(c.lastMessageDirection, 'out');
  // the customer's own record of last message is untouched: the template did not reopen anything
  assert.equal(c.lastInboundAt.toMillis(), before.lastInboundAt.toMillis()); assert.equal(c.unreadCount, 2);
  const st = await statusOf();
  assert.deepEqual([st.state, st.reopen.kind, st.canReopen], ['awaiting', 'sent', false]);
  await rejects(h.sendReply(staff, { phone: P, body: 'hello' }, deps), 'failed-precondition', /24-hour window/);   // still no free-form messaging
  assert.equal(calls.length, 1);
  // the CUSTOMER replies (through the same code the webhook uses): the window opens by itself, with no change to the webhook
  await store.storeInbound(db, { wamid: 'wamid.IN1', from: P, name: 'Anna Murphy', type: 'button', body: 'Go ahead', media: null, createdAt: new Date() });
  assert.equal((await statusOf(P, Date.now())).state, 'open');
  await h.sendReply(staff, { phone: P, body: 'Thanks Anna' }, deps);
  assert.equal(calls.length, 2); assert.equal(calls[1].body.type, 'text');
});

test('Reopen refuses while the window is open (no Meta call) and works from exactly 24 hours', async () => {
  await seed(P, { inboundAgoMs: 24 * H - 1000 });
  await rejects(go(), 'failed-precondition', /window is open/);
  assert.equal(calls.length, 0); assert.equal((await conv()).reopen, undefined);
  await seed(Q, { inboundAgoMs: 24 * H });
  assert.equal((await go(Q)).state, 'sent'); assert.equal(calls.length, 1);
});

test('a customer who has never messaged (added by phone, with no quote) can be reopened: it is not a quote feature', async () => {
  await store.createCustomer(db, Q, { name: 'Walk In', email: 'walk@example.com' }, actor);
  assert.equal((await conv(Q)).lastInboundAt, undefined);
  assert.equal((await statusOf(Q)).state, 'closed');
  assert.equal((await go(Q)).state, 'sent');
  assert.equal(param(0), 'Walk');
  assert.equal((await db.collection('quotes').get()).size, 0);
  const c = await conv(Q);
  assert.equal(c.inboxStatus, undefined); assert.equal((await db.doc('contacts/' + Q).get()).data().quoteValue, undefined);   // no stage or value change
});

test('the first name comes from the customer record: first word, "there" when there is no usable name', async () => {
  const cases = [['353850000001', { name: 'Anna Murphy' }, 'Anna'], ['353850000002', { name: '  Zoë   Ní Bhriain ', contactName: '  Zoë   Ní Bhriain ' }, 'Zoë'],
    ['353850000003', { name: 'Brian', noContact: true }, 'Brian'], ['353850000004', { name: null, noContact: true }, 'there'],
    ['353850000005', { name: '085 123 4567' }, 'there'], ['353850000006', { name: 'Old Conv Name', contactName: 'Newer Contact' }, 'Newer']];
  for (const [p, o] of cases) await seed(p, o);
  for (const [p] of cases) await go(p);
  cases.forEach(([, , want], i) => assert.equal(param(i), want));
});

// ======================================================== one Reopen per 24 hours =========================================
test('only one Reopen template per customer per 24 hours; the next can go once the day is up', async () => {
  await seed();
  await go();
  await rejects(go(), 'failed-precondition', /Only one can be sent every 24 hours/);
  await rejects(go(P, NOW + 23 * H + 59 * MIN), 'failed-precondition', /Only one can be sent/);
  assert.equal(calls.length, 1);
  try { await go(P, NOW + 1 * H); assert.fail('refused expected'); } catch (e) { assert.equal(e.details.nextReopenAt, NOW + 24 * H); }
  assert.equal((await go(P, NOW + 25 * H)).state, 'sent');
  assert.equal(calls.length, 2);
  assert.equal((await conv()).reopen.wamid, 'wamid.RO2');
});

test('what counts toward the cap: in progress, not confirmed and delivered do; refused and never-delivered do not (except Meta\'s "wait 24 hours")', async () => {
  const claimed = (agoMs, state = 'sending', extra = {}) => ({ reopen: { state, requestId: 'old-request-1', claimedAt: Timestamp.fromMillis(NOW - agoMs), by: 'x', ...extra } });
  await seed('353850000011', { conv: claimed(1 * MIN) });                                       // in progress
  await seed('353850000012', { conv: claimed(10 * MIN) });                                      // stuck: not confirmed
  await seed('353850000013', { conv: claimed(10 * MIN, 'unknown') });                           // recorded as not confirmed
  await seed('353850000014', { conv: claimed(26 * H) });                                        // a day ago: free again
  for (const p of ['353850000011', '353850000012', '353850000013']) await rejects(go(p), 'failed-precondition', /Only one can be sent/);
  assert.equal(calls.length, 0);
  assert.equal((await go('353850000014')).state, 'sent');
  // refused by Meta earlier: free to try again
  await seed('353850000015', { conv: claimed(5 * MIN, 'failed', { error: 'x (code 132001)' }) });
  assert.equal((await go('353850000015')).state, 'sent');
  // sent, then Meta reports it never delivered
  for (const [p, error, free] of [['353850000016', '132015: Template paused', true], ['353850000017', '131049: held back', false], ['353850000018', '131050: opted out', false]]) {
    await seed(p, { conv: claimed(5 * MIN, 'sent', { sentAt: Timestamp.fromMillis(NOW - 5 * MIN), wamid: 'wamid.OLD' + p }) });
    await db.doc(`conversations/${p}/messages/wamid.OLD${p}`).set({ wamid: 'wamid.OLD' + p, direction: 'out', status: 'failed', error });
    if (free) assert.equal((await go(p)).state, 'sent', p); else await rejects(go(p), 'failed-precondition', /could not deliver/);
  }
});

// ====================================================== one request, one message =========================================
test('the same request again sends nothing (a double click, or a retry after a timeout), even all at once', async () => {
  await seed();
  const id = rid();
  const first = await run({ phone: P, requestId: id });
  const again = await run({ phone: P, requestId: id });
  assert.deepEqual([first.existing, again.existing, again.state], [false, true, 'sent']);
  await seed(Q);
  const same = rid();
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => run({ phone: Q, requestId: same })));
  assert.equal(rs.filter((x) => !x.existing).length, 1);
  assert.equal(calls.filter((c) => c.body.to === Q).length, 1); assert.equal(calls.length, 2);
  assert.equal((await msgs(Q)).length, 1);
});

test('two members of staff pressing Reopen at once: one message goes, the other is told it was already sent', async () => {
  await seed();
  const rs = await Promise.allSettled([1, 2, 3, 4, 5].map(() => go()));
  assert.equal(rs.filter((x) => x.status === 'fulfilled').length, 1);
  for (const x of rs.filter((x) => x.status === 'rejected')) assert.equal(x.reason.code, 'failed-precondition');
  assert.equal(calls.length, 1); assert.equal((await msgs()).length, 1);
});

// ================================================ when WhatsApp says no, or we cannot tell ===============================
test('Meta refuses the template: failed, in plain English, nothing claimed as sent, safe to try again, the same request is not re-sent', async () => {
  await seed();
  mode = 'refuse';
  const id = rid();
  await rejects(run({ phone: P, requestId: id }), 'unavailable', /doesn't know this template.*132001/);
  let c = await conv();
  assert.equal(c.reopen.state, 'failed'); assert.match(c.reopen.error, /132001/); assert.equal(c.reopen.wamid, undefined);
  const m = await msgs();
  assert.deepEqual([m.length, m[0].status, m[0].type, m[0].direction], [1, 'failed', 'template', 'out']); assert.match(m[0].error, /doesn't know this template/);
  const st = await statusOf();
  assert.deepEqual([st.state, st.canReopen, st.reopen.kind], ['closed', true, 'refused']);          // closed again, can try again
  await rejects(run({ phone: P, requestId: id }), 'unavailable', /doesn't know this template/);      // the same request: same answer, no new call
  assert.equal(calls.length, 1);
  mode = 'ok';
  assert.equal((await go()).state, 'sent');                                                          // a new request after the template is approved
  assert.equal(calls.length, 2); assert.equal((await conv()).reopen.state, 'sent');
});

test('a reply we cannot confirm (Meta 5xx, no message id, network failure, a hang) is "not confirmed": never resent by itself', async () => {
  const slow = { allowedEmails: cfg.allowedEmails, reopenTemplate: cfg.reopenTemplate, reopenLang: cfg.reopenLang, reopenTimeoutMs: 40 };
  let i = 0;
  for (const m of ['server', 'noid', 'network', 'hang']) {
    const p = '35385000002' + (++i);
    await seed(p); mode = m;
    await rejects(go(p, NOW, { ...deps, cfg: slow }), 'unavailable', /Not confirmed/);
    const c = await conv(p);
    assert.equal(c.reopen.state, 'unknown', m); assert.match(c.reopen.error, /Not confirmed/);
    const ms = await msgs(p);
    assert.deepEqual([ms.length, ms[0].status], [1, 'failed'], m); assert.match(ms[0].error, /Not confirmed/);
    const st = await statusOf(p);
    assert.deepEqual([st.state, st.canReopen, st.reopen.kind], ['awaiting', false, 'unsure'], m);   // may have arrived: counts, and nothing implies the chat is open
    mode = 'ok';
    await rejects(go(p), 'failed-precondition', /Only one can be sent/);                              // never sent again by itself
  }
  assert.equal(calls.length, 4);
});

test('WhatsApp not set up: failed, nothing sent, plain words', async () => {
  await seed();
  const none = createClient({ phoneId: '111' }, mockFetch);
  await rejects(go(P, NOW, { ...deps, wa: none }), 'unavailable', /not set up/);
  assert.equal(calls.length, 0); assert.equal((await conv()).reopen.state, 'failed');
});

test('delivery follows Meta\'s status messages through the existing webhook code: delivered, read, or never delivered', async () => {
  await seed();
  await go();
  await store.applyStatus(db, { wamid: 'wamid.RO1', phone: P, status: 'delivered', error: null });
  assert.equal((await statusOf()).reopen.kind, 'delivered'); assert.equal((await statusOf()).state, 'awaiting');
  await store.applyStatus(db, { wamid: 'wamid.RO1', phone: P, status: 'read', error: null });
  assert.equal((await statusOf()).reopen.kind, 'read');
  await seed(Q);
  await go(Q);
  await store.applyStatus(db, { wamid: 'wamid.RO2', phone: Q, status: 'failed', error: '131049: held back' });
  const st = await statusOf(Q);
  assert.deepEqual([st.state, st.canReopen, st.reopen.kind], ['closed', false, 'undelivered']);       // never implies the chat is open
  await rejects(go(Q), 'failed-precondition', /could not deliver the last template/);
});

test('a delivery status that arrives BEFORE our own record keeps its status and its reason, and the Reopen is still recorded', async () => {
  await seed();
  beforeReply = async () => { await store.applyStatus(db, { wamid: 'wamid.RO1', phone: P, status: 'failed', error: '131049: held back' }); };
  assert.equal((await go()).state, 'sent');
  const m = await msgs();
  assert.equal(m.length, 1);
  assert.deepEqual([m[0].id, m[0].status, m[0].error, m[0].type, m[0].direction], ['wamid.RO1', 'failed', '131049: held back', 'template', 'out']);
  assert.equal(m[0].body, '[template: elite_kitchens_reopen] ' + WS.reopenText('Anna'));
  const st = await statusOf();
  assert.deepEqual([st.state, st.canReopen, st.reopen.kind, st.reopen.error], ['closed', false, 'undelivered', '131049: held back']);
  await seed(Q);
  beforeReply = async () => { await store.applyStatus(db, { wamid: 'wamid.RO2', phone: Q, status: 'delivered', error: null }); };
  await go(Q);
  assert.equal((await msgs(Q))[0].status, 'delivered');                    // the higher status is kept, not reset to "sent"
  assert.equal((await statusOf(Q)).reopen.kind, 'delivered');
});

test('if the customer is erased while the template is in flight, nothing is recreated', async () => {
  await seed();
  beforeReply = async () => { await db.recursiveDelete(db.doc('conversations/' + P)); await db.doc('contacts/' + P).delete(); };
  const r = await go();
  assert.equal(r.ok, true); assert.equal(calls.length, 1);
  assert.equal((await db.doc('conversations/' + P).get()).exists, false); assert.equal((await db.doc('contacts/' + P).get()).exists, false);
  assert.equal((await db.collection('conversations/' + P + '/messages').get()).size, 0);
});

test('logs and stored errors hold codes only: no names, numbers or message text', async () => {
  await seed(P, { name: 'Anna Murphy' });
  const seen = [];
  const orig = { log: console.log, error: console.error };
  console.log = (...a) => seen.push(a.join(' ')); console.error = (...a) => seen.push(a.join(' '));
  let c;
  try {
    mode = 'refuse-number'; await go().catch(() => {});
    await seed(Q); mode = 'server'; await go(Q).catch(() => {});
    await seed('353850000031'); mode = 'ok'; await go('353850000031');
    c = await conv(P);
  } finally { console.log = orig.log; console.error = orig.error; }
  const text = seen.join('\n') + JSON.stringify(c.reopen);
  assert.ok(seen.length >= 3, 'something was logged');
  for (const secret of [P, Q, '353850000031', 'Anna', 'Murphy', 'quick question']) assert.ok(!text.includes(secret), 'leaked: ' + secret);
  assert.match(text, /131026/);
});

// ============================================ audit findings 12 and 13 (2026-10-08) =======================================
test('audit 12: Meta\'s IMMEDIATE refusals 131049 and 131050 block the next Reopen for 24 hours, exactly like the same codes arriving later; other refusals do not', async () => {
  for (const [i, [code, blocks]] of [['131049', true], ['131050', true], ['131026', false], ['132001', false], ['132015', false]].entries()) {
    const p = '35385000009' + i; await seed(p); mode = 'code-' + code; calls.length = 0;
    await rejects(go(p), 'unavailable');                                                                // Meta refused it at once: nothing was sent
    const st = await statusOf(p);
    assert.equal(st.canReopen, !blocks, `code ${code}: canReopen should be ${!blocks}`);
    assert.equal((await conv(p)).reopen.errorCode, code);                                               // the structured code is kept, not just words
    mode = 'ok'; calls.length = 0;
    if (blocks) {
      await rejects(go(p), 'failed-precondition', /try again after/i); assert.equal(calls.length, 0, 'a blocked code must not reach Meta again');
      assert.ok(st.nextReopenAt > NOW + 23 * H && st.nextReopenAt <= NOW + 24 * H + 1000);
      assert.equal((await go(p, NOW + 25 * H)).state, 'sent');                                          // free again after the day
    } else assert.equal((await go(p)).state, 'sent');                                                   // other refusals: try again straight away, as before
  }
});

test('audit 12: the same decision is made for a stored refusal that has no structured code (records from before this fix keep working)', () => {
  const r = (extra) => WS.windowStatus({ reopen: { state: 'failed', claimedAt: ts(NOW - 5 * MIN), ...extra } }, NOW, null);
  assert.equal(r({ error: 'x (code 132001)' }).canReopen, true);                                        // an old record: refused, free to retry
  assert.equal(r({ errorCode: '131049' }).canReopen, false); assert.equal(r({ errorCode: '131050' }).canReopen, false);
  assert.equal(r({ errorCode: '131026' }).canReopen, true);
  assert.equal(r({ errorCode: 131049 }).canReopen, false);                                               // a number as well as a string
});

test('audit 13: logs and stored errors never carry what Meta says about the customer: not a name, an email, a formatted number or message text', async () => {
  await seed(P, { name: 'Anna Murphy' });
  const seen = [], orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => seen.push(a.join(' ')); console.error = (...a) => seen.push(a.join(' ')); console.warn = (...a) => seen.push(a.join(' '));
  let c;
  try { mode = 'leaky'; await go().catch(() => {}); c = await conv(P); } finally { Object.assign(console, orig); }
  const text = seen.join('\n') + JSON.stringify(c.reopen);
  assert.ok(seen.length >= 1, 'something was logged');
  for (const secret of ['Anna', 'Murphy', 'anna@example.com', '85 111 1111', '085-111-1111', '111 1111', 'quick question', 'about your kitchen', 'Recipient']) assert.ok(!text.includes(secret), 'leaked: ' + secret);
  assert.match(text, /131026/);                                                                          // the code is what is kept
});
