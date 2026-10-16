// Phase 9: the receptionist answers when a customer message arrives (a Firestore event), after a reply delay (30 seconds by default) so that a burst of messages is answered once; a 5-minute backup job
// answers anything the event missed. Real Firestore emulator; the model and WhatsApp are fakes; time is a virtual clock (the delay is "slept" instantly and recorded). What matters, in customer terms:
// one reply per burst, never two replies for one message (event + backup, a duplicate event, two overlapping runs), a person is never talked over (not during the delay, not while the reply is written),
// a newer message gets its own answer, quiet hours and every switch are respected, and nothing is read or called for chats that are not the receptionist's.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const ai = require('../lib/ai');
const REC = require('../lib/aiReceptionist');
const SCH = require('../lib/aiSchedule');
const store = require('../lib/store');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const OWNERS = 'thomas@example.com';
const NOW = Date.UTC(2026, 9, 13, 10, 0), ts = (ms) => Timestamp.fromMillis(ms), H = 3600e3, SEC = 1000;
const SINCE = NOW - 5 * H, LEAD_AT = NOW - 4 * H, TEMPLATE = 'elite_kitchens_new_lead', L = SCH.LINES;
const PH = '353871110061', PH2 = '353871110062', USAGE = { input: 3000, output: 200, cacheRead: 0, cacheWrite: 0 };
const NOTES = 'Meta lead · Kitchen enquiry · 13 Oct 2026\nLead ID: 123456789\nRequirements: Shaker kitchen with island\nOther answers:\n• Eircode / postcode: K67 X123\n• Estimated budget: 15-20k';

const decision = (over = {}) => ({ text: '', toolCalls: [{ id: 'd1', name: 'reply_decision', input: { reply: '', intent: 'new_enquiry', visit: 'none', hasQuestion: false, change: 'none', schedule: { preference: null, opener: '' }, newFacts: [], handover: { needed: false, reason: null }, ...over } }], stopReason: 'tool_use', usage: USAGE });
// a model that answers with the given decision; `during` runs while the reply is "being written"
const model = (d = decision(), during) => { const m = { calls: 0, async complete() { m.calls++; if (during) await during(m.calls); return d; } }; return m; };
const waFake = () => { const w = { sent: [], async sendText(to, body) { w.sent.push({ to, body }); return 'wamid.AUTO' + w.sent.length; } }; return w; };
const pushFake = () => { const p = { events: [], async notify(ev) { p.events.push(ev); } }; return p; };
const checked = () => db.doc('aiSettings/modelCheck').set(Object.fromEntries(Object.entries(ai.MODELS).map(([k, m]) => [k, { id: m.id, ok: true, name: m.label, lifecycle: 'active', at: ts(NOW) }])));
const on = async (extra = {}) => { await checked(); await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, replyAssistant: true, autoReply: true, autoReplySince: ts(SINCE), monthlyCapEur: 15, dailyCapEur: 2, ...extra }); };
const conv = async (phone = PH) => (await db.doc('conversations/' + phone).get()).data();

async function newLead(phone) {
  await db.recursiveDelete(db.doc('conversations/' + phone));
  await db.doc('contacts/' + phone).set({ phone, name: 'Aoife Kavanagh', projectType: 'Kitchen', location: 'Swords', budget: '15-20k', notes: NOTES, source: 'Meta Ads', createdAt: ts(LEAD_AT), metaLead: { leadId: '123456789', receivedAt: ts(LEAD_AT) } });
  await db.doc('conversations/' + phone).set({ phone, name: 'Aoife Kavanagh', inboxStatus: 'inbox', createdAt: ts(LEAD_AT), updatedAt: ts(LEAD_AT), unreadCount: 0 });
  await store.storeOutbound(db, phone, { wamid: 'wamid.WELCOME' + phone, type: 'template', body: `[template: ${TEMPLATE}] Hi Aoife, thanks for your enquiry with Elite Kitchens...` });
  await db.collection(`conversations/${phone}/messages`).doc('wamid.WELCOME' + phone).update({ createdAt: ts(LEAD_AT + 2000) }).catch(() => {});
}
let seq = 0;
const says = async (phone, body, atMs) => { await store.storeInbound(db, { wamid: 'wamid.IN' + (++seq) + phone, from: phone, type: 'text', body, name: 'Aoife Kavanagh', createdAt: new Date(atMs) }); return atMs; };
// the clock and the recorded "sleeps"
function clock(start) { const c = { t: start, sleeps: [], hook: null, now: () => c.t, async sleep(n) { c.sleeps.push(n); c.t += n; if (c.hook) await c.hook(); } }; return c; }
const deps = (m, w, p) => ({ db, wa: w, model: m, owners: OWNERS, push: p, welcomeTemplate: TEMPLATE });
const event = (m, w, p, phone, messageMs, c) => REC.onInbound(deps(m, w, p), phone, messageMs, { sleep: c.sleep, now: c.now });

beforeEach(async () => { await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' }); await on(); seq = 0; });

test('ONE MESSAGE: the event starts the receptionist, which waits the reply delay (30 seconds) and then answers; a new Meta lead is switched on by the event itself; the reply comes about 30 seconds after the message', async () => {
  await newLead(PH); const t = await says(PH, 'Hi, I am looking for a new kitchen', NOW); const c = clock(t + 2 * SEC), m = model(decision({ intent: 'new_enquiry', ack: 'thanks', reply: 'Lovely, thanks Aoife.' })), w = waFake(), p = pushFake();
  const r = await event(m, w, p, PH, t, c);
  assert.equal(r, 'sent:offer_visit'); assert.deepEqual(c.sleeps, [30000], 'it waited the full reply delay'); assert.equal(m.calls, 1); assert.deepEqual(w.sent.map((x) => x.body), ['Thanks, Aoife. ' + L.visit_offer]);
  const rec = (await conv()).receptionist; assert.equal(rec.auto, true, 'switched on by the event, because it is a new Meta lead');
  assert.ok(rec.last.delayMs >= 30000 && rec.last.delayMs <= 45000, 'about 30 to 45 seconds after the customer\'s message: ' + rec.last.delayMs);
});

test('A BURST IS ANSWERED ONCE: only the run for the LAST message goes on, whether the newer message was already there or arrived during the delay', async () => {
  await newLead(PH); const t = NOW, m = model(decision({ reply: 'Thanks Aoife.' })), w = waFake(), p = pushFake();
  const t1 = await says(PH, 'Hi', t), t2 = await says(PH, 'I am looking for a kitchen', t + 5 * SEC), t3 = await says(PH, 'a shaker one with an island', t + 12 * SEC);
  const c = clock(t + 14 * SEC);
  assert.equal(await event(m, w, p, PH, t1, c), 'superseded'); assert.equal(await event(m, w, p, PH, t2, c), 'superseded'); assert.equal(m.calls, 0, 'the earlier messages cost nothing: no model call, no sleeping'); assert.deepEqual(c.sleeps, []);
  assert.equal(await event(m, w, p, PH, t3, c), 'sent:offer_visit'); assert.equal(w.sent.length, 1, 'one reply for the whole burst'); assert.equal(m.calls, 1);
  // the newer message arrives DURING the delay: the older run wakes, sees it and stops; the newer run answers
  await newLead(PH2); const u = await says(PH2, 'Hello', t + 60 * SEC), c2 = clock(u + 2 * SEC), w2 = waFake(), m2 = model(decision({ reply: 'Hi Aoife.' }));
  let later = 0; c2.hook = async () => { if (!later) later = await says(PH2, 'looking for a kitchen', c2.t - 3 * SEC); };
  assert.equal(await event(m2, w2, p, PH2, u, c2), 'superseded', 'the first run stops after waiting: a newer message exists'); assert.equal(m2.calls, 0);
  const c3 = clock(later + 2 * SEC); assert.equal(await event(m2, w2, p, PH2, later, c3), 'sent:offer_visit'); assert.equal(w2.sent.length, 1);
});

test('NEVER TWICE: the backup job after the event, the backup job at the same time as the event, and the same event delivered twice, all end with exactly one reply', async () => {
  await newLead(PH); const t = await says(PH, 'Hi, I am looking for a new kitchen', NOW), w = waFake(), p = pushFake();
  const slow = { calls: 0, async complete() { slow.calls++; await new Promise((r) => setTimeout(r, 150)); return decision({ reply: 'Thanks Aoife.' }); } };
  // the same event twice and the backup, all at once
  const c1 = clock(t + 2 * SEC), c2 = clock(t + 2 * SEC);
  const runs = await Promise.all([event(slow, w, p, PH, t, c1), event(slow, w, p, PH, t, c2), REC.sweep(deps(slow, w, p), t + 90 * SEC)]);
  assert.equal(w.sent.length, 1, 'exactly one message: ' + JSON.stringify(runs.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))));
  // later runs find it answered
  assert.equal(await event(slow, w, p, PH, t, clock(t + 40 * SEC)), 'handled'); assert.deepEqual(await REC.sweep(deps(slow, w, p), t + 5 * 60 * SEC), { chats: 1, handled: 1 }); assert.equal(w.sent.length, 1);
  assert.equal((await db.collection(`conversations/${PH}/messages`).get()).docs.filter((d) => d.data().auto).length, 1, 'one automatic message recorded');
});

test('A PERSON IS NEVER TALKED OVER: a reply from a person during the delay, or while the answer is being written, stops the receptionist for good: nothing sent, no alert, the draft is not used', async () => {
  // during the delay
  await newLead(PH); const t = await says(PH, 'Hi, interested in a kitchen', NOW), c = clock(t + 2 * SEC), m = model(), w = waFake(), p = pushFake();
  c.hook = async () => { await store.storeOutbound(db, PH, { wamid: 'wamid.HUMAN1', type: 'text', body: 'Hi Aoife, it is Thomas, I will call you shortly.' }); await db.doc(`conversations/${PH}/messages/wamid.HUMAN1`).update({ createdAt: ts(c.t - 5 * SEC) }); };
  assert.equal(await event(m, w, p, PH, t, c), 'staff_replied'); assert.equal(m.calls, 0, 'not even a model call'); assert.equal(w.sent.length, 0); assert.equal(p.events.length, 0); assert.equal((await conv()).receptionist.paused, 'a person replied');
  // while the answer is being written (the new check just before sending)
  await newLead(PH2); const u = await says(PH2, 'Hi, interested in a kitchen', NOW + 600 * SEC), c2 = clock(u + 2 * SEC), w2 = waFake(), p2 = pushFake();
  const m2 = model(decision({ reply: 'Thanks.' }), async () => { await store.storeOutbound(db, PH2, { wamid: 'wamid.HUMAN2', type: 'text', body: 'Hi Aoife, Thomas here.' }); await db.doc(`conversations/${PH2}/messages/wamid.HUMAN2`).update({ createdAt: ts(c2.t) }); });
  assert.equal(await event(m2, w2, p2, PH2, u, c2), 'staff_replied'); assert.equal(m2.calls, 1, 'the answer was written, then thrown away'); assert.equal(w2.sent.length, 0, 'never sent'); assert.equal(p2.events.length, 0);
  const rec = (await conv(PH2)).receptionist; assert.deepEqual([rec.paused, rec.count], ['a person replied', 0]); assert.equal((await conv(PH2)).consult, undefined, 'the unused draft did not move the conversation on');
  const drafts = (await db.collection('aiDrafts').where('phone', '==', PH2).get()).docs.map((d) => d.data()); assert.ok(drafts.length >= 1 && drafts.every((d) => d.outcome === 'discarded'));
});

test('A NEWER MESSAGE WHILE THE ANSWER IS WRITTEN: the stale answer is not sent; the newer message gets one answer that covers everything', async () => {
  await newLead(PH); const t = await says(PH, 'Hi, interested in a kitchen', NOW), c = clock(t + 2 * SEC), w = waFake(), p = pushFake(); let newer = 0;
  const m = model(decision({ reply: 'Thanks.' }), async (n) => { if (n === 1) newer = await says(PH, 'also, we want an island', c.t); });
  assert.equal(await event(m, w, p, PH, t, c), 'newer_message'); assert.equal(w.sent.length, 0, 'the answer to the old message is not sent'); assert.equal((await conv()).receptionist.handledMs, 0, 'and it is not marked answered');
  const c2 = clock(newer + 2 * SEC); assert.equal(await event(m, w, p, PH, newer, c2), 'sent:offer_visit'); assert.equal(w.sent.length, 1, 'one answer in the end'); assert.equal(m.calls, 2);
});

test('QUIET HOURS: an event at night does nothing (no model call); the backup answers after 7:00', async () => {
  const night = Date.UTC(2026, 9, 14, 0, 30);                                                         // 01:30 in Ireland
  await newLead(PH); const t = await says(PH, 'Hi, interested in a kitchen', night), m = model(decision({ reply: 'Thanks Aoife.' })), w = waFake(), p = pushFake();
  assert.equal(await event(m, w, p, PH, t, clock(t + 2 * SEC)), 'quiet'); assert.equal(m.calls, 0); assert.equal(w.sent.length, 0);
  assert.deepEqual(await REC.sweep(deps(m, w, p), t + 60 * SEC), { skipped: 'quiet hours' });
  const morning = Date.UTC(2026, 9, 14, 6, 10), r = await REC.sweep(deps(m, w, p), morning); assert.equal(r['sent:offer_visit'], 1); assert.equal(w.sent.length, 1, 'answered once after 7:00');
  // a delay that runs past 7:00 would be fine, one that runs INTO quiet hours is not: the run stops
  await newLead(PH2); const late = Date.UTC(2026, 9, 13, 22, 59, 50), u = await says(PH2, 'Hi, interested', late), c = clock(u + 2 * SEC), w2 = waFake();
  assert.equal(await event(model(), w2, p, PH2, u, c), 'quiet', 'the delay ended after midnight (Irish time): left for the backup'); assert.equal(w2.sent.length, 0);
});

test('NOT THE RECEPTIONIST\'S CHAT: nothing is read, called or waited for; switches, existing conversations, handed-over chats and our own messages all stop at once', async () => {
  const m = model(), w = waFake(), p = pushFake();
  // an existing conversation (created before the master switch went on) that is not switched on
  await newLead(PH); await db.doc('conversations/' + PH).update({ createdAt: ts(SINCE - H) }); const t = await says(PH, 'Hi', NOW), c = clock(t + 2 * SEC);
  assert.equal(await event(m, w, p, PH, t, c), 'not_ours'); assert.deepEqual(c.sleeps, []); assert.equal(m.calls, 0);
  // the master switch off and the chat not switched on by the owner
  await on({ autoReply: false }); await newLead(PH2); const u = await says(PH2, 'Hi', NOW); assert.equal(await event(m, w, p, PH2, u, clock(u + 2 * SEC)), 'not_ours');
  // a chat the owner switched on himself still works with the master switch off; a handed-over chat does not
  await ai.setReceptionist({ db, owners: OWNERS }, { kind: 'staff', id: OWNERS }, { phone: PH2, on: true }, { nowMs: NOW - 10 * 60 * SEC }); const u2 = await says(PH2, 'Hello again', NOW + 60 * SEC);
  assert.equal(await event(model(decision({ reply: 'Thanks.' })), w, p, PH2, u2, clock(u2 + 2 * SEC)), 'sent:offer_visit');
  await db.doc('conversations/' + PH2).update({ 'receptionist.paused': 'consultation passed to you' }); const u3 = await says(PH2, 'Thanks', NOW + 600 * SEC); assert.equal(await event(m, w, p, PH2, u3, clock(u3 + 2 * SEC)), 'not_ours');
  // the AI switches
  for (const extra of [{ enabled: false }, { customerDataApproved: false }, { replyAssistant: false }]) { await on(extra); assert.equal(await event(m, w, p, PH2, u3, clock(u3 + 2 * SEC)), 'off', JSON.stringify(extra)); }
  assert.equal(m.calls, 0);
  // the event handler: only a message FROM THE CUSTOMER goes on (our own, a person's, the welcome template and nothing at all return at once)
  for (const msg of [{ direction: 'out', auto: true, createdAt: ts(NOW) }, { direction: 'out', type: 'text', createdAt: ts(NOW) }, { direction: 'out', type: 'template', createdAt: ts(NOW) }, null, undefined, {}]) assert.equal(await REC.onMessage(deps(m, w, p), PH2, msg), 'ignored');
  assert.equal(m.calls, 0); assert.equal(w.sent.length, 1, 'only the one reply to the chat the owner switched on');
});

test('THE REPLY DELAY: 30 seconds by default; one number in the settings document (5 to 90 seconds) changes it without redeploying; nonsense falls back or is clamped', async () => {
  assert.deepEqual([{}, { replyDelaySeconds: 12 }, { replyDelaySeconds: 1 }, { replyDelaySeconds: 500 }, { replyDelaySeconds: 'x' }, { replyDelaySeconds: -4 }, { replyDelaySeconds: 45.4 }].map(REC.delayMs), [30000, 12000, 5000, 90000, 30000, 30000, 45400]);
  assert.equal(REC.WAIT_MS, 30000); assert.equal(REC.DEBOUNCE_MS, 30000);
  await on({ replyDelaySeconds: 12 }); assert.equal((await ai.loadSettings(db)).replyDelaySeconds, 12); await on({ replyDelaySeconds: 9999 }); assert.equal((await ai.loadSettings(db)).replyDelaySeconds, 30, 'out of range in the document: the default');
  await on({ replyDelaySeconds: 12 }); await newLead(PH); const t = await says(PH, 'Hi, interested in a kitchen', NOW), c = clock(t + 2 * SEC);
  assert.equal(await event(model(decision({ reply: 'Thanks.' })), waFake(), pushFake(), PH, t, c), 'sent:offer_visit'); assert.deepEqual(c.sleeps, [12000]);
  // the backup uses the SAME reply delay (12 seconds here, as set above): it does not answer a message younger than that, and answers one that is older
  await newLead(PH2); const u = await says(PH2, 'Hi, interested in a kitchen', NOW + 600 * SEC); const wb = waFake();
  assert.equal((await REC.sweep(deps(model(), wb, pushFake()), u + 8 * SEC)).wait, 1); assert.equal(wb.sent.length, 0);
  assert.equal((await REC.sweep(deps(model(decision({ reply: 'Thanks.' })), wb, pushFake()), u + 20 * SEC))['sent:offer_visit'], 1); assert.equal(wb.sent.length, 1);
});

test('WIRING: the event function fires on a new message in any chat and goes on only for a customer message; no retry, no always-on instance, a long enough timeout; the backup runs every 5 minutes; the deploy stage includes it', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8'), fn = idx.slice(idx.indexOf('exports.receptionistOnMessage')), head = fn.slice(0, fn.indexOf('async (event)'));
  assert.match(head, /onDocumentCreated\(\{ document: 'conversations\/\{phone\}\/messages\/\{messageId\}'/); assert.match(head, /region: 'europe-west1'/); assert.match(head, /retry: false/); assert.match(head, /timeoutSeconds: 180/);
  assert.doesNotMatch(head, /minInstances/, 'no always-on instance'); assert.match(head, /secrets: \[\.\.\.SECRETS, ANTHROPIC_API_KEY\]/);
  assert.match(fn, /m\.direction !== 'in'\) return;/); assert.match(fn, /receptionist\.onMessage\(/);
  assert.match(idx, /exports\.receptionistSweep = onSchedule\(\{ schedule: 'every 5 minutes'/);
  const sh = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'deploy-quote-sending.sh'), 'utf8'); assert.match(sh, /^REC_FUNCS="receptionistSweep receptionistOnMessage pushReceipt"/m);
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'aiReceptionist.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/createAppointment|updateAppointment|cancelAppointment|collection\('appointments'\)|sendTemplate|sendMedia/.test(src), false); assert.equal((src.match(/wa\.sendText\(/g) || []).length, 1, 'still exactly one place that sends, after the claim');
  assert.ok(src.indexOf("limit(12).get()]), fc =") < src.indexOf('outbound.begin('), 'the chat is read again before anything is claimed or sent');
});

test('THE DELAY SETTING: only the owner can change it; whole seconds from 5 to 90; it is saved, shown in the status, written to the audit log and used by the next run without a redeploy', async () => {
  const owner = { kind: 'staff', id: OWNERS }, staff = { kind: 'staff', id: 'helper@example.com' }, d = { db, owners: OWNERS };
  const rejects = async (p, code) => assert.rejects(p, (e) => e.code === code, code);
  assert.equal((await ai.status(d, owner, {}, { nowMs: NOW })).replyDelaySeconds, 30, 'default 30');
  await rejects(ai.saveSettings(d, staff, { replyDelaySeconds: 20 }, { nowMs: NOW }), 'permission-denied');
  for (const bad of [4, 91, 0, -5, 20.5, '20', NaN, null, true]) await rejects(ai.saveSettings(d, owner, { replyDelaySeconds: bad }, { nowMs: NOW }), 'invalid-argument');
  assert.equal((await db.doc('aiSettings/current').get()).data().replyDelaySeconds, undefined, 'nothing saved by the refused ones');
  for (const ok of [5, 90]) assert.equal((await ai.saveSettings(d, owner, { replyDelaySeconds: ok }, { nowMs: NOW })).replyDelaySeconds, ok);
  const r = await ai.saveSettings(d, owner, { replyDelaySeconds: 12 }, { nowMs: NOW }); assert.equal(r.replyDelaySeconds, 12); assert.equal((await ai.status(d, owner, {}, { nowMs: NOW })).replyDelaySeconds, 12);
  const log = (await db.collection('auditLog').where('action', '==', 'aiSettings').get()).docs.map((x) => x.data()).filter((x) => x.changed.includes('replyDelaySeconds')); assert.equal(log.length, 3); assert.equal(log[0].by, OWNERS);
  // the next event waits the new time
  await newLead(PH); const t = await says(PH, 'Hi, interested in a kitchen', NOW), c = clock(t + 2 * SEC);
  assert.equal(await event(model(decision({ reply: 'Thanks.' })), waFake(), pushFake(), PH, t, c), 'sent:offer_visit'); assert.deepEqual(c.sleeps, [12000]);
  // the other settings are untouched by it
  assert.equal((await ai.loadSettings(db)).enabled, true); assert.equal((await ai.loadSettings(db)).autoReply, true);
});
