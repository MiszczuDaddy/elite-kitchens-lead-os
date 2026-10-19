// Phase 10 (docs/PHASE10_SAFETY_NET.md): the safety net. Real Firestore emulator; push (Firebase Messaging), email (Gmail), WhatsApp and the AI are FAKES: nothing is ever sent.
// What matters: faults that used to be silent become PROBLEMS that are shown, alerted ONCE (push, and email when set up), retried until delivered, and closed by themselves when the fault
// goes away; a hand-over alert that failed is retried and falls back to email; rejected Meta leads are kept with what a person needs to follow them up, and their personal details are
// erased once dealt with; and no alert, email or problem record ever carries a customer's name, number, email or words. Every name and number is made up.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const H = require('../lib/health');
const LI = require('../lib/leadIssues');
const push = require('../lib/push');
const h = require('../lib/handlers');
const ai = require('../lib/ai');
const REC = require('../lib/aiReceptionist');
const { handleLeadRequest } = require('../lib/leads');
const { createClient } = require('../lib/whatsapp');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR, NOW = Date.UTC(2026, 9, 13, 10, 0), ts = (ms) => Timestamp.fromMillis(ms);
const STAFF = 'thomas@example.com', actor = { kind: 'staff', id: STAFF };
const cfg = { allowedEmails: STAFF };
const staff = { uid: 'u1', token: { email: STAFF, email_verified: true, staff: true } };
const P = '353871110051', NAME = 'Saoirse Testperson', EMAIL = 'saoirse@example.com';
const TOKEN = 'fcm-test-token-' + 'x'.repeat(60);

// ---- fakes ----
const fcm = { sent: [], mode: 'ok', async send(msg) { fcm.sent.push(msg); if (fcm.mode === 'fail') throw Object.assign(new Error('fail'), { code: 'messaging/internal-error' }); return 'fcm-' + fcm.sent.length; } };
const notify = (ev) => push.safeNotify({ db, messaging: fcm, allowed: STAFF, capMs: 2000 }, ev);         // the REAL push code (records, dedupe) with a fake Firebase Messaging
const gmail = { sent: [], mode: 'ok', async sendRaw(raw) { if (gmail.mode === 'fail') throw Object.assign(new Error('no'), { code: 'refused' }); gmail.sent.push(Buffer.from(raw, 'base64url').toString('utf8')); return { id: 'g' + gmail.sent.length }; } };
const mail = (over = {}) => ({ enabled: true, sender: 'info@example.com', fromName: 'Elite OS', gmail, to: ['owner@example.com'], ...over });
const deps = (over = {}) => ({ db, notify, allowed: STAFF, mail: mail(), ...over });
const issue = async (k) => { const s = await db.doc('healthIssues/' + k).get(); return s.exists ? s.data() : null; };
const openKinds = async () => (await db.collection('healthIssues').where('status', '==', 'open').get()).docs.map((d) => d.id).sort();
const device = () => push.registerDevice({ db }, actor, { token: TOKEN, platform: 'android' }, { nowMs: NOW });
const events = async () => (await db.collection('pushEvents').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const qp = (raw) => String(raw).replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16)));      // the email body is quoted-printable
const hasCustomerData = (s) => [P, P.slice(3), NAME, 'Saoirse', EMAIL, '087 111'].some((x) => String(s).includes(x));

beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  fcm.sent.length = 0; fcm.mode = 'ok'; gmail.sent.length = 0; gmail.mode = 'ok';
});

// ================================================================ problems ============================================
test('a problem opens once, counts repeats, closes, and opens again as a NEW occurrence; its words come from the server; numbers never get into it', async () => {
  assert.deepEqual(await H.report(db, 'whatsapp_auth', { detail: 'code 190', nowMs: NOW }), { opened: true, occurrence: 1 });
  assert.deepEqual(await H.report(db, 'whatsapp_auth', { detail: 'customer 353871234567', nowMs: NOW + MIN }), { opened: false, occurrence: 1 });
  let i = await issue('whatsapp_auth');
  assert.equal(i.status, 'open'); assert.equal(i.count, 2); assert.equal(i.title, H.ISSUES.whatsapp_auth.title); assert.ok(i.help.length > 20);
  assert.ok(!/\d{6,}/.test(i.detail), 'a long number never reaches a problem: ' + i.detail);
  assert.deepEqual(await H.resolveMany(db, ['whatsapp_auth', 'lead_key'], { nowMs: NOW + 2 * MIN }), ['whatsapp_auth']);
  assert.equal((await issue('whatsapp_auth')).status, 'resolved');
  assert.deepEqual(await H.report(db, 'whatsapp_auth', { nowMs: NOW + 3 * MIN }), { opened: true, occurrence: 2 });
  await assert.rejects(H.report(db, 'nonsense'), /unknown/);
});

test('the hook given to other functions NEVER throws, gives up quickly, and pushes a NEW problem straight away (once)', async () => {
  await device();
  const hk = H.hook({ db, notify, capMs: 3000 });
  assert.equal(await hk.report('not_a_kind'), null);                                               // a bug in the caller is swallowed, never thrown into a customer's send
  await hk.report('lead_key'); await hk.report('lead_key');
  const ev = (await events()).filter((e) => e.kind === 'alert');
  assert.equal(ev.length, 1, 'one alert for the problem, not one per repeat'); assert.equal(ev[0].phone, null); assert.equal(fcm.sent.length, 1);
  assert.deepEqual(Object.keys(fcm.sent[0].data).sort(), ['c', 'd', 'k', 'n'], 'the push carries opaque ids only'); assert.equal(fcm.sent[0].data.k, 'alert');
  const slow = H.hook({ db: { runTransaction: () => new Promise(() => {}) }, capMs: 200 });           // a database that never answers
  const t0 = Date.now(); assert.equal(await slow.report('lead_key'), null); assert.ok(Date.now() - t0 < 1500);
});

// ================================================================ WhatsApp ============================================
test('WhatsApp outcomes: only faults that stop ALL sending are problems; one customer\'s refusal is not', () => {
  const c = (o) => H.classify(o);
  assert.equal(c({ ok: true }), 'ok');
  assert.equal(c({ ok: false, status: 401, definite: true }), 'whatsapp_auth'); assert.equal(c({ ok: false, status: 400, code: 190, definite: true }), 'whatsapp_auth'); assert.equal(c({ ok: false, status: 403, code: 200, definite: true }), 'whatsapp_auth');
  for (const code of [368, 131031, 131042]) assert.equal(c({ ok: false, status: 400, code, definite: true }), 'whatsapp_account', String(code));
  for (const code of [132001, 132015, 132016]) assert.equal(c({ ok: false, status: 400, code, definite: true }), 'whatsapp_template', String(code));
  for (const code of [131026, 131047, 131049, 131050, 131056]) assert.equal(c({ ok: false, status: 400, code, definite: true }), 'ignore', String(code));
  assert.equal(c({ ok: false, status: 0, definite: false }), 'unconfirmed'); assert.equal(c({ ok: false, status: 503, definite: false }), 'unconfirmed');
  assert.equal(c({ ok: false, status: 404, definite: true, media: true }), 'ignore');
  // REVIEW FIX (17 Oct 2026): the REAL client sends code: null when Meta gave no code. Number(null) is 0, which is a key error, so a network blip used to look like an expired key.
  for (const code of [null, undefined, '', ' ']) {
    assert.equal(c({ ok: false, status: 0, code, definite: false }), 'unconfirmed', 'no answer, code ' + JSON.stringify(code));
    assert.equal(c({ ok: false, status: 503, code, definite: false }), 'unconfirmed', '5xx without a code');
    assert.equal(c({ ok: false, status: 200, code, definite: false }), 'unconfirmed', 'an answer with no message id');
  }
  assert.equal(c({ ok: false, status: 400, code: null, definite: true }), 'ignore', 'a 4xx with no code is not a system fault');
  assert.equal(c({ ok: false, status: 400, code: 0, definite: true }), 'whatsapp_auth', 'an explicit code 0 from Meta is still a key error');
  assert.equal(c({ ok: false, status: 400, code: '190', definite: true }), 'whatsapp_auth', 'a code given as text');
});

test('REVIEW FIX: a network failure through the REAL client and the REAL health record never opens "WhatsApp is refusing the access key"', async () => {
  const f = async () => { throw new TypeError('fetch failed'); };
  const wa = createClient({ phoneId: '111', token: 'tok', onOutcome: (o) => H.noteWhatsApp(db, o, { nowMs: NOW }) }, f);
  for (let i = 0; i < 2; i++) await assert.rejects(wa.sendText(P, 'hi'), /fetch failed/);
  assert.deepEqual(await openKinds(), [], 'two blips are not a fault');
  await assert.rejects(wa.sendText(P, 'hi'), /fetch failed/);
  assert.deepEqual(await openKinds(), ['whatsapp_failing'], 'three in a row are "failing", never "access key"');
  const noId = createClient({ phoneId: '111', token: 'tok', onOutcome: (o) => H.noteWhatsApp(db, o, { nowMs: NOW + HOUR }) }, async () => new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(noId.sendText(P, 'hi'));
  assert.ok(!(await openKinds()).includes('whatsapp_auth'));
  const refused = createClient({ phoneId: '111', token: 'tok', onOutcome: (o) => H.noteWhatsApp(db, o, { nowMs: NOW + 2 * HOUR }) }, async () => new Response(JSON.stringify({ error: { code: 190, message: 'expired' } }), { status: 401, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(refused.sendText(P, 'hi'));
  assert.ok((await openKinds()).includes('whatsapp_auth'), 'a REAL key refusal still opens it');
});

test('3 unconfirmed sends in a row (within 30 minutes) open "failing"; an expired key opens at once; ONE success closes them all and resets the count', async () => {
  for (const t of [0, 1, 50]) await H.noteWhatsApp(db, { ok: false, status: 503, definite: false }, { nowMs: NOW + t * MIN });      // the third is more than 30 minutes after the second
  assert.deepEqual(await openKinds(), []);
  await H.noteWhatsApp(db, { ok: false, status: 0, definite: false }, { nowMs: NOW + 52 * MIN });
  assert.deepEqual(await openKinds(), []);
  await H.noteWhatsApp(db, { ok: false, status: 0, definite: false }, { nowMs: NOW + 53 * MIN });
  assert.deepEqual(await openKinds(), ['whatsapp_failing']);
  await H.noteWhatsApp(db, { ok: false, status: 401, code: 190, definite: true }, { nowMs: NOW + 54 * MIN });
  await H.noteWhatsApp(db, { ok: false, status: 400, code: 131026, definite: true }, { nowMs: NOW + 55 * MIN });                       // one customer not on WhatsApp: nothing
  assert.deepEqual(await openKinds(), ['whatsapp_auth', 'whatsapp_failing']);
  assert.equal(await H.noteWhatsApp(db, { ok: true }, { nowMs: NOW + 56 * MIN }), 'resolved');
  assert.deepEqual(await openKinds(), []);
  const w = (await db.doc('health/whatsapp').get()).data(); assert.equal(w.failStreak, 0); assert.equal(w.issues, undefined);
});

test('the WhatsApp client tells the health check how each send ended, but a slow or broken health check can never delay a send for long or change its result', async () => {
  const outcomes = [];
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  let mode = 'ok';
  const f = async () => (mode === 'ok' ? reply({ messages: [{ id: 'wamid.A' }] }) : mode === 'auth' ? reply({ error: { code: 190, message: 'Session has expired' } }, 401) : (() => { throw new TypeError('fetch failed'); })());
  const wa = (onOutcome) => createClient({ phoneId: '111', token: 'tok', onOutcome }, f);
  assert.equal(await wa((o) => outcomes.push(o)).sendText(P, 'hi'), 'wamid.A');
  mode = 'auth'; await assert.rejects(wa((o) => outcomes.push(o)).sendText(P, 'hi'), (e) => e.definite === true && e.code === 190);
  mode = 'net'; await assert.rejects(wa((o) => outcomes.push(o)).sendText(P, 'hi'), /fetch failed/);
  assert.deepEqual(outcomes.map((o) => [o.ok, o.status, o.code, o.definite]), [[true, 200, null, true], [false, 401, 190, true], [false, 0, null, false]]);
  assert.ok(outcomes.every((o) => !hasCustomerData(JSON.stringify(o))), 'no number or text in what the health check is told');
  mode = 'ok';
  const t0 = Date.now(); assert.equal(await wa(() => new Promise(() => {})).sendText(P, 'hi'), 'wamid.A'); assert.ok(Date.now() - t0 < 2500, 'a hanging health check is given up after about 1.5 s');
  assert.equal(await wa(() => { throw new Error('boom'); }).sendText(P, 'hi'), 'wamid.A', 'a broken health check changes nothing');
});

test('"WhatsApp stopped reporting back": only messages FROM Meta count (a customer message, a delivery tick), never our own writes', async () => {
  const yes = [[null, { direction: 'in', type: 'text', body: 'hi' }], [{ direction: 'out', type: 'text', status: 'sent' }, { direction: 'out', type: 'text', status: 'delivered' }],
    [{ direction: 'out', status: 'delivered' }, { direction: 'out', status: 'read' }], [null, { direction: 'out', status: 'sent', wamid: 'w' }]];
  const no = [[null, { direction: 'out', type: 'text', body: 'x', status: 'sent' }], [{ direction: 'in', type: 'image', media: { status: 'pending' } }, { direction: 'in', type: 'image', media: { status: 'stored' } }],
    [{ direction: 'out', type: 'text', status: 'delivered' }, { direction: 'out', type: 'text', status: 'delivered', body: 'x' }], [{ direction: 'in' }, null]];
  for (const [b, a] of yes) assert.equal(H.fromMeta(b, a), true, JSON.stringify([b, a]));
  for (const [b, a] of no) assert.equal(H.fromMeta(b, a), false, JSON.stringify([b, a]));
  await H.noteWhatsApp(db, { ok: true }, { nowMs: NOW }); await H.noteWhatsApp(db, { ok: true }, { nowMs: NOW + MIN });
  assert.equal((await db.doc('health/whatsapp').get()).data().sendsSinceWebhook, 2);
  assert.equal(await H.onMessageWrite(db, null, { direction: 'in', type: 'text', body: 'hi' }, NOW + 2 * MIN), true);
  const w = (await db.doc('health/whatsapp').get()).data(); assert.equal(w.sendsSinceWebhook, 0); assert.equal(w.firstUnreportedAt, null);
});

// ================================================================ the 10-minute check ====================================
test('THE "NO META LEADS" WARNING IS GONE FOR GOOD: no check ever opens it, however long the silence; what it left behind is erased; its setting is refused', async () => {
  await db.collection('leads').doc('L1').set({ leadId: 'L1', receivedAt: ts(NOW - 900 * HOUR), state: 'done' });
  for (let k = 0; k < 3; k++) await H.sweep(deps(), NOW + k * 10 * MIN);
  assert.ok(!(await openKinds()).includes('lead_silence'), 'no warning after 900 hours without a lead'); assert.equal(await issue('lead_silence'), null);
  assert.equal(H.ISSUES.lead_silence, undefined); assert.equal(H.settingsOf, undefined); assert.equal(H.LEAD_SILENCE_DEFAULT, undefined);
  // what an earlier version left in the database: an open problem with a pending alert, and the hours setting
  await db.doc('healthIssues/lead_silence').set({ kind: 'lead_silence', title: 'No Meta leads have arrived for a while', help: 'x', status: 'open', occurrence: 1, openedAt: ts(NOW), lastAt: ts(NOW), count: 3, detail: 'none for 400 hours', alert: { state: 'pending', tries: 0, pushOk: false, emailOk: false, emailTries: 0 } });
  await db.doc('healthSettings/current').set({ leadSilenceHours: 168 });
  await H.sweep(deps(), NOW + HOUR);
  assert.equal((await db.doc('healthIssues/lead_silence').get()).exists, false, 'the old problem is erased'); assert.equal((await db.doc('healthSettings/current').get()).exists, false, 'and so is the hours setting');
  assert.ok(!/lead_silence|Meta lead/i.test(JSON.stringify(await events())), 'no push alert was made for it'); assert.ok(!gmail.sent.some((m) => /Meta lead/i.test(qp(m))), 'and no email');
  assert.ok(!(await openKinds()).includes('lead_silence'));
  // the other problems still work
  await H.report(db, 'lead_key', { nowMs: NOW + 2 * HOUR }); assert.ok((await openKinds()).includes('lead_key'));
  await assert.rejects(h.attentionAction(staff, { action: 'settings', leadSilenceHours: 24 }, { db, cfg }), (e) => e.code === 'invalid-argument' && /Unknown action/.test(e.message), 'the hours setting can no longer be saved');
  await assert.rejects(h.attentionAction(staff, { action: 'fixed', kind: 'lead_silence' }, { db, cfg }), (e) => e.code === 'invalid-argument', 'and the old problem cannot be "fixed" either');
});

test('CHECK: WhatsApp silent after two sends; no device for alerts; alerts failing', async () => {
  await H.sweep(deps(), NOW);
  assert.deepEqual(await openKinds(), ['no_alert_devices']);
  await device(); await H.sweep(deps(), NOW + 3 * MIN); assert.ok(!(await openKinds()).includes('no_alert_devices'));
  // WhatsApp: two sends more than an hour ago and nothing back from Meta since
  await H.noteWhatsApp(db, { ok: true }, { nowMs: NOW - 70 * MIN }); await H.noteWhatsApp(db, { ok: true }, { nowMs: NOW - 65 * MIN });
  await H.sweep(deps(), NOW + 4 * MIN); assert.ok((await openKinds()).includes('whatsapp_no_reports'));
  await H.onMessageWrite(db, { direction: 'out', type: 'text', status: 'sent' }, { direction: 'out', type: 'text', status: 'delivered' }, NOW + 5 * MIN);
  await H.sweep(deps(), NOW + 6 * MIN); assert.ok(!(await openKinds()).includes('whatsapp_no_reports'), 'a delivery tick closes it');
  // alerts: three failed in a row open the problem, one that gets through closes it
  for (const [i, status] of [[1, 'failed'], [2, 'no-devices'], [3, 'failed']]) await db.collection('pushEvents').doc('m_' + String(i).padStart(24, '0')).set({ kind: 'message', status, createdAt: ts(Date.now() + 60e3 + i * 1000), phone: null });      // newer than the alerts the earlier checks pushed
  await H.sweep(deps(), NOW + 7 * MIN); assert.ok((await openKinds()).includes('alerts_failing'));
  await db.collection('pushEvents').doc('m_' + '9'.padStart(24, '0')).set({ kind: 'message', status: 'sent', createdAt: ts(Date.now() + 60e3 + 9000), phone: null });
  await H.sweep(deps(), NOW + 8 * MIN); assert.ok(!(await openKinds()).includes('alerts_failing'));
  assert.ok((await db.doc('health/heartbeats').get()).data().healthSweepAt, 'the check says it ran (the screen warns when it stops)');
});

test('CHECK: the receptionist\'s own 5-minute check stopped; it is switched on but cannot answer (a switch off, no key); nothing is a fault while the receptionist is switched off', async () => {
  await H.beat(db, 'healthSweep', {}, NOW - 2 * HOUR); await db.doc('health/heartbeats').set({ healthSweepSince: ts(NOW - 2 * HOUR) }, { merge: true });
  await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, replyAssistant: true, autoReply: false });
  await H.sweep(deps(), NOW); assert.deepEqual((await openKinds()).filter((k) => k.startsWith('receptionist') || k.startsWith('ai')), []);
  await db.doc('aiSettings/current').update({ autoReply: true });
  await H.sweep(deps(), NOW + MIN); assert.ok((await openKinds()).includes('receptionist_stopped'), 'switched on, and its check never ran in 2 hours');
  await H.beat(db, 'receptionistSweep', { result: 'ran' }, NOW + 2 * MIN); await H.sweep(deps(), NOW + 3 * MIN);
  assert.ok(!(await openKinds()).includes('receptionist_stopped'));
  await H.beat(db, 'receptionistSweep', { result: 'ran' }, NOW + 3 * MIN); await H.sweep(deps(), NOW + 30 * MIN);
  assert.ok((await openKinds()).includes('receptionist_stopped'), 'last ran 27 minutes ago');
  await db.doc('aiSettings/current').update({ customerDataApproved: false }); await H.beat(db, 'receptionistSweep', { result: 'off' }, NOW + 31 * MIN); await H.sweep(deps(), NOW + 32 * MIN);
  assert.ok((await openKinds()).includes('receptionist_blocked')); assert.match((await issue('receptionist_blocked')).detail, /real customer data/);
  await db.doc('aiSettings/current').update({ customerDataApproved: true }); await H.beat(db, 'receptionistSweep', { result: 'no key' }, NOW + 33 * MIN); await H.sweep(deps(), NOW + 34 * MIN);
  assert.ok(!(await openKinds()).includes('receptionist_blocked')); assert.ok((await openKinds()).includes('ai_no_key'));
  await H.beat(db, 'receptionistSweep', { result: 'ran' }, NOW + 35 * MIN); await H.sweep(deps(), NOW + 36 * MIN); assert.ok(!(await openKinds()).includes('ai_no_key'));
});

test('the receptionist reports the AI\'s faults (budget used up, failing) as problems, and closes them when it answers again', async () => {
  await db.doc('aiSettings/modelCheck').set(Object.fromEntries(Object.entries(ai.MODELS).map(([k, m]) => [k, { id: m.id, ok: true, name: m.label, lifecycle: 'active', at: ts(NOW) }])));
  await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, replyAssistant: true, autoReply: true, monthlyCapEur: 0.0000001, dailyCapEur: 0.0000001 });
  await db.doc('contacts/' + P).set({ phone: P, name: NAME, createdAt: ts(NOW - 9e8) });
  await db.doc('conversations/' + P).set({ phone: P, name: NAME, createdAt: ts(NOW - 9e8), updatedAt: ts(NOW), lastInboundAt: ts(NOW - 120e3), lastMessageDirection: 'in' });
  await ai.setReceptionist({ db, owners: STAFF }, actor, { phone: P, on: true }, { nowMs: NOW - 600e3 });
  await db.collection(`conversations/${P}/messages`).add({ direction: 'in', type: 'text', body: 'I would like a kitchen consultation', createdAt: ts(NOW - 120e3) });
  const hk = H.hook({ db, notify });
  const model = { name: 'fake', async complete() { throw new Error('must not be called: no budget'); } };
  const w = { sent: [], async sendText() { w.sent.push(1); return 'wamid.X'; } };
  assert.equal(await REC.processChat({ db, wa: w, model, owners: STAFF, push: { notify }, health: hk }, P, NOW), 'refused');
  assert.ok((await openKinds()).includes('ai_budget')); assert.equal(w.sent.length, 0);
  assert.equal(H.aiProblem('Reply suggestions are switched off.'), 'receptionist_blocked'); assert.equal(H.aiProblem('The AI assistant is not set up yet (no key).'), 'ai_no_key'); assert.equal(H.aiProblem('timeout'), 'ai_failing');
});

// ================================================================ alerts: once, retried, by email, private ================
test('ALERTS: a problem is pushed and emailed ONCE; the email has no customer data; two checks running together send it once; a fixed problem is not alerted', async () => {
  await device();
  await db.doc('conversations/' + P).set({ phone: P, name: NAME });
  await H.report(db, 'whatsapp_auth', { detail: 'code 190', nowMs: NOW });
  await Promise.all([H.sweep(deps(), NOW), H.sweep(deps(), NOW)]);
  assert.equal(fcm.sent.filter((m) => m.data.k === 'alert').length, 1, 'one push'); assert.equal(gmail.sent.length, 1, 'one email');
  const raw = qp(gmail.sent[0]);
  assert.match(raw, /Subject: Elite OS: WhatsApp is refusing/); assert.match(raw, /To: owner@example\.com/); assert.match(raw, /contains no customer details/);
  assert.ok(!hasCustomerData(raw), 'no customer data in the email');
  assert.equal((await issue('whatsapp_auth')).alert.state, 'sent');
  await H.sweep(deps(), NOW + 10 * MIN); assert.equal(gmail.sent.length, 1); assert.equal(fcm.sent.length, 1, 'nothing more once delivered');
  await H.resolveMany(db, ['whatsapp_auth']); await H.report(db, 'lead_key', { nowMs: NOW }); await H.resolveMany(db, ['lead_key']);
  await H.sweep(deps(), NOW + 20 * MIN); assert.equal(fcm.sent.length, 1, 'a problem that was fixed before the check is not alerted');
});

test('ALERTS: a push that does not get through is tried again at each check (a new id each time), then marked "not delivered" on screen; with email set up the problem still gets its email', async () => {
  await device(); fcm.mode = 'fail';
  await H.report(db, 'lead_breaker', { nowMs: NOW });
  for (let i = 0; i < H.ALERT_TRIES + 2; i++) await H.sweep(deps({ mail: null }), NOW + i * 10 * MIN);
  const a = (await issue('lead_breaker')).alert;
  assert.equal(a.state, 'failed'); assert.equal(a.tries, H.ALERT_TRIES);
  const ids = new Set((await events()).map((e) => e.id)), mine = (i) => push.eventIdOf('alert', 'issue|lead_breaker|1|' + i);
  for (let i = 0; i < H.ALERT_TRIES; i++) assert.ok(ids.has(mine(i)), 'try ' + i + ' is its own notification record');
  assert.ok(!ids.has(mine(H.ALERT_TRIES)), 'tried once per check, never more than ' + H.ALERT_TRIES + ' times');
  await H.report(db, 'lead_error', { nowMs: NOW }); await H.sweep(deps(), NOW + 100 * MIN);
  assert.equal(gmail.sent.filter((r) => /Subject: Elite OS: A Meta lead could not be processed/.test(r)).length, 1); assert.equal((await issue('lead_error')).alert.emailOk, true);
});

test('FAILED HAND-OVER ALERT: retried by push (it opens the chat), the email goes when the push fails, and it clears itself when a push finally gets through; "Seen" clears it too', async () => {
  await device();
  await db.doc('conversations/' + P).set({ phone: P, name: NAME, receptionist: { on: true, paused: 'handover: price question', notifyFailed: { at: ts(NOW - MIN), why: 'handover: price question', tries: 3 } } });
  fcm.mode = 'fail';
  await H.sweep(deps(), NOW);
  let c = (await db.doc('conversations/' + P).get()).data();
  assert.ok(c.receptionist.notifyFailed, 'still shown'); assert.equal(c.receptionist.notifyFailed.alert.emailOk, true, 'the email fallback went');
  assert.equal(gmail.sent.length, 1); assert.ok(!hasCustomerData(gmail.sent[0]));
  const ho = (await events()).filter((e) => e.kind === 'handover'); assert.equal(ho.length, 1); assert.equal(ho[0].phone, P, 'the push record knows the chat (erased with the customer), the push itself does not');
  fcm.mode = 'ok';
  await H.sweep(deps(), NOW + 10 * MIN); assert.equal(gmail.sent.length, 1, 'the email is sent once');
  c = (await db.doc('conversations/' + P).get()).data();
  assert.ok(c.receptionist.notifyFailed, 'delivered by email, it stays on screen until someone has seen it');
  await h.attentionAction(staff, { action: 'seen', phone: P }, { db, cfg });
  c = (await db.doc('conversations/' + P).get()).data(); assert.equal(c.receptionist.notifyFailed, undefined); assert.equal(c.receptionist.notifySeen.by, STAFF);
  // the push route: no email set up, the push gets through on the next check -> cleared by itself
  await db.doc('conversations/' + P).update({ 'receptionist.notifyFailed': { at: ts(NOW + 20 * MIN), why: 'x', tries: 3 } });
  await H.sweep(deps({ mail: null }), NOW + 21 * MIN);
  c = (await db.doc('conversations/' + P).get()).data(); assert.equal(c.receptionist.notifyFailed, undefined); assert.ok(c.receptionist.notifyLate);
});

// ================================================================ rejected Meta leads ===================================
const KEY = 'test-key-1234567890-abcdefghij';
const lcfg = { phoneId: '111', token: 'tok', template: 'elite_kitchens_new_lead', lang: 'en', version: 'v21.0', apiKeys: KEY };
const okFetch = async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.W' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
const lead = (phone, id = '7777888899990000') => ({ leadId: id, formName: 'Kitchen form', field_data: [{ name: 'full_name', values: [NAME] }, { name: 'email', values: [EMAIL] }, { name: 'phone_number', values: [phone] }, { name: 'city', values: ['Swords'] }] });
const intake = (body, headers = { authorization: 'Bearer ' + KEY }, now = NOW) => handleLeadRequest({ method: 'POST', headers, rawBody: Buffer.from(JSON.stringify(body)), body },
  { db, wa: createClient(lcfg, okFetch), cfg: lcfg, now: () => now, push: { notify }, health: H.hook({ db, notify }) });

test('REJECTED LEAD: kept with what a person needs (name, email, the number as typed), one alert; a Make retry adds nothing; sent again with a good number it is added and the details here are erased', async () => {
  await device();
  const r = await intake(lead('087 111'));
  assert.deepEqual([r.status, r.body.status, r.body.reason], [200, 'rejected', 'invalid_phone']);
  let li = (await db.doc('leadIssues/7777888899990000').get()).data();
  assert.deepEqual([li.status, li.name, li.email, li.phoneTyped, li.location, li.formName], ['open', NAME, EMAIL, '087 111', 'Swords', 'Kitchen form']);
  assert.match(li.reasonText, /phone number/); assert.equal(li.alert.pushOk, true);
  const alerts = (await events()).filter((e) => e.kind === 'alert'); assert.equal(alerts.length, 1); assert.equal(alerts[0].phone, null);
  await intake(lead('087 111')); li = (await db.doc('leadIssues/7777888899990000').get()).data();
  assert.equal(li.attempts, 2); assert.equal((await events()).filter((e) => e.kind === 'alert').length, 1, 'no second alert for a Make retry');
  const ok = await intake(lead('+353 87 111 2233'));
  assert.equal(ok.body.status, 'processed');
  li = (await db.doc('leadIssues/7777888899990000').get()).data();
  assert.deepEqual([li.status, li.name, li.email, li.phoneTyped, li.location], ['added', null, null, null, null], 'closed, and the personal details are gone');
});

test('REJECTED LEAD: "Dismiss" and "Add as customer" erase the details at once; a dismissed lead is never brought back by Make; old handled items are removed after 30 days', async () => {
  await intake(lead('12', 'AAAABBBBCCCC1'));
  await intake(lead('34', 'AAAABBBBCCCC2'));
  await assert.rejects(h.attentionAction(staff, { action: 'lead', leadId: 'AAAABBBBCCCC1', outcome: 'maybe' }, { db, cfg }), (e) => e.code === 'invalid-argument');
  assert.deepEqual(await h.attentionAction(staff, { action: 'lead', leadId: 'AAAABBBBCCCC1', outcome: 'dismissed' }, { db, cfg }), { ok: true, status: 'dismissed' });
  assert.deepEqual(await h.attentionAction(staff, { action: 'lead', leadId: 'AAAABBBBCCCC2', outcome: 'added' }, { db, cfg }), { ok: true, status: 'added' });
  for (const id of ['AAAABBBBCCCC1', 'AAAABBBBCCCC2']) { const d = (await db.doc('leadIssues/' + id).get()).data(); assert.deepEqual([d.name, d.email, d.phoneTyped, d.resolvedBy], [null, null, null, STAFF]); }
  await intake(lead('12', 'AAAABBBBCCCC1')); assert.equal((await db.doc('leadIssues/AAAABBBBCCCC1').get()).data().status, 'dismissed');
  assert.equal(await LI.purge(db, Date.now() + 29 * DAY), 0, 'not before 30 days'); assert.equal(await LI.purge(db, Date.now() + 31 * DAY), 2);
  assert.equal((await db.collection('leadIssues').get()).size, 0);
});

test('LEAD INTAKE PROBLEMS: a WRONG key (offered) is a problem; NO key at all (a scanner) is not; the safety brake is a problem', async () => {
  await intake(lead('+353871112233'), {});
  await intake(lead('+353871112233'), { 'x-api-key': '' });
  assert.deepEqual(await openKinds(), []);
  await intake(lead('+353871112233'), { authorization: 'Bearer wrong-key-1234567890-zzzzzzzz' });
  assert.deepEqual(await openKinds(), ['lead_key']);
  for (let i = 0; i < 60; i++) await db.collection('leads').doc('B' + String(i).padStart(10, '0')).set({ receivedAt: ts(NOW - MIN), state: 'done' });
  const r = await intake(lead('+353871112233', 'NEWLEAD00001'));
  assert.equal(r.status, 503); assert.ok((await openKinds()).includes('lead_breaker'));
});

// ================================================================ the screen's buttons ===================================
test('"Needs attention" buttons: staff only, strict input; "Mark as fixed" closes a problem; the lead warning takes 0 to 720 hours', async () => {
  await assert.rejects(h.attentionAction(null, { action: 'fixed', kind: 'lead_key' }, { db, cfg }), (e) => e.code === 'unauthenticated');
  await H.report(db, 'lead_key', { nowMs: NOW });
  assert.deepEqual(await h.attentionAction(staff, { action: 'fixed', kind: 'lead_key' }, { db, cfg }), { ok: true, resolved: true });
  const i = await issue('lead_key'); assert.equal(i.status, 'resolved'); assert.equal(i.resolvedBy, STAFF);
  for (const bad of [{ action: 'fixed', kind: 'nope' }, { action: 'explode' }, { action: 'settings', leadSilenceHours: 24 }, { action: 'seen', phone: '1' }]) await assert.rejects(h.attentionAction(staff, bad, { db, cfg }), (e) => e.code === 'invalid-argument', JSON.stringify(bad));
});

test('TIDY: problems fixed more than 90 days ago are removed; open ones stay', async () => {
  await H.report(db, 'lead_key', { nowMs: NOW - 100 * DAY }); await H.resolveMany(db, ['lead_key'], { nowMs: NOW - 95 * DAY });
  await H.report(db, 'lead_error', { nowMs: NOW - 100 * DAY });
  await H.sweep(deps(), NOW);
  assert.equal(await issue('lead_key'), null); assert.equal((await issue('lead_error')).status, 'open');
});
