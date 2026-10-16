// Audit finding 9 (parts A, B, D, E): the receptionist under load. A burst of new leads (7:00 after a night of messages, a campaign day) must be answered, not refused or handed over: the receptionist has an AI
// rate pool of its own (the euro caps are unchanged), hitting it only DELAYS the answer, the 5-minute backup waits the owner's reply delay like the event path, a lock is only cleared by its owner, and the
// backup works through the chats oldest first, several at a time, with a clock per chat and a deadline. Real Firestore emulator; the model and WhatsApp are fakes.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
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
const NOW = Date.UTC(2026, 9, 13, 10, 0), ts = (ms) => Timestamp.fromMillis(ms), H = 3600e3, SEC = 1000, L = SCH.LINES;
const LEAD_AT = NOW - 4 * H, TEMPLATE = 'elite_kitchens_new_lead', USAGE = { input: 3000, output: 200, cacheRead: 0, cacheWrite: 0 };
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const phoneOf = (i) => '35387111' + String(9000 + i);

const decision = (over = {}) => ({ text: '', toolCalls: [{ id: 'd1', name: 'reply_decision', input: { reply: '', intent: 'new_enquiry', visit: 'none', hasQuestion: false, change: 'none', ack: 'thanks', special: 'none', schedule: { preference: null, opener: '' }, newFacts: [], handover: { needed: false, reason: null }, ...over } }], stopReason: 'tool_use', usage: USAGE });
// a model that notes who it was asked about (the customer's name is "Cust<i>"), how many calls ran at once, and can be slow
const model = ({ ms: wait = 0, d = decision() } = {}) => { const m = { calls: 0, starts: [], inflight: 0, max: 0, async complete(args) { m.calls++; const who = /Cust(\d+)/.exec(args.messages[0].text); m.starts.push(who ? Number(who[1]) : -1); m.inflight++; m.max = Math.max(m.max, m.inflight); if (wait) await sleep(wait); m.inflight--; return d; } }; return m; };
const waFake = () => { const w = { sent: [], async sendText(to, body) { w.sent.push({ to, body }); return 'wamid.AUTO' + w.sent.length; } }; return w; };
const pushFake = () => { const p = { events: [], async notify(ev) { p.events.push(ev); } }; return p; };
const checked = () => db.doc('aiSettings/modelCheck').set(Object.fromEntries(Object.entries(ai.MODELS).map(([k, m]) => [k, { id: m.id, ok: true, name: m.label, lifecycle: 'active', at: ts(NOW) }])));
const on = async (extra = {}) => { await checked(); await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, replyAssistant: true, autoReply: true, autoReplySince: ts(NOW - 5 * H), monthlyCapEur: 15, dailyCapEur: 2, ...extra }); };
const deps = (m, w, p) => ({ db, wa: w, model: m, owners: OWNERS, push: p, welcomeTemplate: TEMPLATE });
let seq = 0;
// a chat the receptionist is on for, with one customer message `age` ms before `now`
async function arm(i, now, age = 60 * SEC, rec = {}) {
  const phone = phoneOf(i);
  await db.recursiveDelete(db.doc('conversations/' + phone));
  await db.doc('contacts/' + phone).set({ phone, name: 'Cust' + i, projectType: 'Kitchen', location: 'Swords', source: 'Meta Ads', createdAt: ts(LEAD_AT), metaLead: { leadId: '1', receivedAt: ts(LEAD_AT) } });
  await db.doc('conversations/' + phone).set({ phone, name: 'Cust' + i, inboxStatus: 'inbox', createdAt: ts(LEAD_AT), updatedAt: ts(LEAD_AT), unreadCount: 0 });
  await store.storeOutbound(db, phone, { wamid: 'wamid.W' + i, type: 'template', body: `[template: ${TEMPLATE}] Hi...` }); await db.doc(`conversations/${phone}/messages/wamid.W${i}`).update({ createdAt: ts(LEAD_AT + 2000) });
  await store.storeInbound(db, { wamid: 'wamid.IN' + (++seq), from: phone, type: 'text', body: 'Hi, I am looking for a kitchen', name: 'Cust' + i, createdAt: new Date(now - age) });
  await db.doc('conversations/' + phone).update({ receptionist: { on: true, auto: true, at: ts(LEAD_AT), by: 'auto', paused: null, handledMs: 0, count: 0, day: null, ...rec } });
  return phone;
}
const rec = async (phone) => (await db.doc('conversations/' + phone).get()).data().receptionist;
const fillPool = (n, at, hour = false) => db.doc('aiRate/rc_receptionist').set({ times: Array.from({ length: n }, (_, k) => (hour ? at - 5 * 60 * SEC - k * 1000 : at - k * 100)) });

beforeEach(async () => { await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' }); await on(); seq = 0; });

// ====================== A: a pool of its own, and a limit only delays ======================
test('A. A BURST OF LEADS: twelve chats in a row are all answered (the staff limit would have stopped it at eight); none is handed over; staff keep their own limit; the euro caps are unchanged', async () => {
  const m = model(), w = waFake(), p = pushFake();
  for (let i = 0; i < 12; i++) await arm(i, NOW);
  for (let i = 0; i < 12; i++) assert.equal(await REC.processChat(deps(m, w, p), phoneOf(i), NOW), 'sent:offer_visit', 'chat ' + i);
  assert.equal(w.sent.length, 12); assert.equal(p.events.length, 0, 'nobody was handed over');
  assert.equal((await db.doc('aiRate/rc_receptionist').get()).data().times.length, 12, 'counted in the receptionist\'s own pool');
  assert.equal((await db.doc('aiRate/receptionist').get()).exists, false, 'not in the staff pool');
  assert.deepEqual(ai.RECEPTIONIST_RATE, { perMinute: 30, perHour: 400, pool: 'rc_' });
  for (let i = 0; i < 8; i++) await ai.checkRate(db, 'staff-user', NOW);                                                    // a person at a keyboard still has 8 a minute
  await assert.rejects(ai.checkRate(db, 'staff-user', NOW), (e) => e.code === 'resource-exhausted');
  const dflt = ai.DEFAULTS; assert.deepEqual([dflt.monthlyCapEur, dflt.dailyCapEur], [15, 2], 'the euro spending caps are unchanged');
});

test('A. THE LIMIT ONLY DELAYS: with the pool full the customer is not answered, not handed over, not counted as a failure and nobody is alerted; the next run after the minute answers', async () => {
  const phone = await arm(1, NOW); await fillPool(30, NOW); const m = model(), w = waFake(), p = pushFake();
  assert.equal(await REC.processChat(deps(m, w, p), phone, NOW), 'rate_limited'); assert.equal(m.calls, 0); assert.equal(w.sent.length, 0); assert.equal(p.events.length, 0);
  let r = await rec(phone); assert.deepEqual([r.paused, r.handledMs, r.tries, r.count], [null, 0, undefined, 0], 'not paused, not answered, no failed tries'); assert.equal(r.lockUntil, 0, 'the lock is released');
  assert.equal((await db.collection(`conversations/${phone}/sendRequests`).get()).size, 0, 'nothing claimed'); assert.equal((await db.collection('aiDrafts').get()).size, 0);
  // three more times in the same minute: still just waiting (it never turns into "ai failed 3 times")
  for (let i = 0; i < 4; i++) assert.equal(await REC.processChat(deps(m, w, p), phone, NOW + 5 * SEC), 'rate_limited'); r = await rec(phone); assert.equal(r.paused, null, 'never handed over');
  assert.equal(await REC.processChat(deps(m, w, p), phone, NOW + 62 * SEC), 'sent:offer_visit'); assert.equal(w.sent.length, 1);
  // the hourly limit works the same way
  const p2 = await arm(2, NOW); await fillPool(400, NOW, true); assert.equal(await REC.processChat(deps(m, w, p), p2, NOW), 'rate_limited'); assert.equal((await rec(p2)).paused, null);
});

test('A. THE BACKUP COUNTS IT, AND ANSWERS LATER; THE EVENT PATH WAITS IT OUT A FEW TIMES BEFORE LEAVING IT TO THE BACKUP', async () => {
  const phone = await arm(1, NOW); await fillPool(30, NOW); const m = model(), w = waFake(), p = pushFake();
  assert.deepEqual(await REC.sweep(deps(m, w, p), NOW), { chats: 1, rate_limited: 1 }); assert.equal(w.sent.length, 0);
  assert.deepEqual(await REC.sweep(deps(m, w, p), NOW + 65 * SEC), { chats: 1, 'sent:offer_visit': 1 }); assert.equal(w.sent.length, 1);
  // the event path: the pool frees up during the second wait
  const p2 = await arm(2, NOW); await fillPool(30, NOW); const sleeps = []; let t = NOW + 2 * SEC;
  const res = await REC.onInbound(deps(model(), waFake(), p), p2, NOW - 60 * SEC, { sleep: async (n) => { sleeps.push(n); t += n; if (sleeps.length === 2) await db.doc('aiRate/rc_receptionist').delete(); }, now: () => t });
  assert.equal(res, 'sent:offer_visit'); assert.deepEqual(sleeps, [30000, 20000], 'the reply delay, then one short wait: the pool was free again');
  // a pool that stays full: three short waits, then it is left to the backup: unanswered, not paused
  const p3 = await arm(3, NOW); await fillPool(30, NOW + 600 * SEC); const sl = []; let t3 = NOW + 2 * SEC; const w3 = waFake();
  assert.equal(await REC.onInbound(deps(model(), w3, p), p3, NOW - 60 * SEC, { sleep: async (n) => { sl.push(n); t3 += n; await fillPool(30, t3); }, now: () => t3 }), 'rate_limited');
  assert.deepEqual(sl, [30000, 20000, 20000, 20000]); assert.equal(w3.sent.length, 0); assert.equal((await rec(p3)).paused, null); assert.equal((await rec(p3)).handledMs, 0);
});

test('A. THE EURO CAPS STILL STOP IT: a used-up budget is a hand-over with its own reason (unchanged), and is not mistaken for the rate limit', async () => {
  await on({ dailyCapEur: 0, monthlyCapEur: 0 }); const phone = await arm(1, NOW); const m = model(), p = pushFake();
  assert.equal(await REC.processChat(deps(m, waFake(), p), phone, NOW), 'refused'); const r = await rec(phone); assert.match(r.paused, /^ai unavailable/); assert.equal(p.events.length, 1); assert.equal(m.calls, 0);
});

// ====================== B: the backup respects the reply delay ======================
test('B. THE BACKUP WAITS THE OWNER\'S REPLY DELAY: 60 seconds is 60 for the backup too; the default is 30; 5 is 5', async () => {
  const phone = await arm(1, NOW, 45 * SEC); const w = waFake(), p = pushFake(), m = model();
  await on({ replyDelaySeconds: 60 });
  assert.deepEqual(await REC.sweep(deps(m, w, p), NOW), { chats: 1, wait: 1 }, '45 seconds old with a 60 second delay: not yet'); assert.equal(w.sent.length, 0);
  assert.deepEqual(await REC.sweep(deps(m, w, p), NOW + 16 * SEC), { chats: 1, 'sent:offer_visit': 1 }, '61 seconds old: answered');
  await on(); const p2 = await arm(2, NOW, 20 * SEC); assert.equal((await REC.sweep(deps(m, w, p), NOW)).wait, 1, 'default 30 seconds'); assert.equal((await REC.sweep(deps(m, w, p), NOW + 11 * SEC))['sent:offer_visit'], 1);
  await on({ replyDelaySeconds: 5 }); await arm(3, NOW, 8 * SEC); assert.equal((await REC.sweep(deps(m, w, p), NOW))['sent:offer_visit'], 1, '5 seconds: 8 seconds old is answered'); assert.ok(p2);
});

// ====================== D: a lock is only cleared by its owner ======================
test('D. A LOCK IS ONLY CLEARED BY ITS OWNER: a run that finishes after another run took over does not release the other run\'s lock', async () => {
  const phone = await arm(1, NOW); const w = waFake(), p = pushFake(); let mine = null;
  // while this run works, its lock "runs out" and a second run takes the chat over (its own lock id, still valid)
  const m = { calls: 0, async complete() { m.calls++; mine = (await rec(phone)).lockId; await db.doc('conversations/' + phone).update({ 'receptionist.lockId': 'other-run', 'receptionist.lockUntil': NOW + 60 * SEC }); return decision(); } };
  await REC.processChat(deps(m, w, p), phone, NOW);
  assert.ok(mine && mine !== 'other-run', 'this run had its own lock id');
  const r = await rec(phone); assert.equal(r.lockId, 'other-run', 'the other run\'s lock is still there'); assert.equal(r.lockUntil, NOW + 60 * SEC);
  // a run that finishes normally clears its own lock
  const p2 = await arm(2, NOW); await REC.processChat(deps(model(), waFake(), p), p2, NOW); const r2 = await rec(p2); assert.equal(r2.lockUntil, 0); assert.equal(r2.lockId, undefined);
  // a chat locked by a live run is "busy", and the lock does not stop being valid because of an unrelated finish
  const p3 = await arm(3, NOW, 60 * SEC, { lockUntil: ts(NOW + 60 * SEC), lockId: 'someone' }); assert.equal(await REC.processChat(deps(model(), waFake(), p), p3, NOW), 'busy');
});

// ====================== E: the backup works through a queue ======================
test('E. THE BACKUP WORKS THROUGH THE CHATS OLDEST FIRST, FOUR AT A TIME: ten chats are all answered once, the longest-waiting first, with a limited number at once', async () => {
  for (let i = 0; i < 10; i++) await arm(i, NOW, (10 + i) * 60 * SEC);                              // chat 9 has waited longest, chat 0 the least
  const m = model({ ms: 60 }), w = waFake(), p = pushFake();
  const out = await REC.sweep(deps(m, w, p), NOW);
  assert.deepEqual(out, { chats: 10, 'sent:offer_visit': 10 }); assert.equal(w.sent.length, 10); assert.equal(new Set(w.sent.map((x) => x.to)).size, 10, 'each customer once');
  assert.ok(m.max >= 2 && m.max <= 4, 'several at once, never more than four: ' + m.max);
  // one at a time the order is exact: the chat that has waited longest first
  for (let i = 0; i < 10; i++) await arm(i, NOW + 600 * SEC, (10 + i) * 60 * SEC);
  const m1 = model(), w1 = waFake(); assert.deepEqual(await REC.sweep(deps(m1, w1, p), NOW + 600 * SEC, { concurrency: 1 }), { chats: 10, 'sent:offer_visit': 10 }); assert.deepEqual(m1.starts, [9, 8, 7, 6, 5, 4, 3, 2, 1, 0], 'oldest first: ' + m1.starts.join(','));
});

test('E. A DEADLINE: when time runs short the check stops starting new chats and the rest wait for the next check, which answers them (nobody twice)', async () => {
  for (let i = 0; i < 6; i++) await arm(i, NOW, (10 + i) * 60 * SEC);
  const m = model({ ms: 120 }), w = waFake(), p = pushFake();
  const first = await REC.sweep(deps(m, w, p), NOW, { deadlineMs: 150, concurrency: 1 });
  assert.ok(first.deferred >= 1 && first.deferred <= 5, 'some were left for the next check: ' + JSON.stringify(first)); const done = w.sent.length; assert.ok(done >= 1 && done < 6);
  const second = await REC.sweep(deps(m, w, p), NOW + 10 * SEC, { deadlineMs: 60000 }); assert.equal(second.deferred, undefined);
  assert.equal(w.sent.length, 6, 'every chat answered in the end'); assert.equal(new Set(w.sent.map((x) => x.to)).size, 6, 'nobody twice');
});

test('E. A CLOCK PER CHAT: midnight arriving while the check works means no further chat is started and nothing is sent after midnight; the 07:00 check answers the rest', async () => {
  const before = Date.UTC(2026, 9, 15, 22, 59, 59, 300);                                              // 23:59:59.3 in Ireland (summer time)
  for (let i = 0; i < 4; i++) await arm(i, before, (5 + i) * 60 * SEC, { at: ts(before - 6 * H) });
  const m = model({ ms: 500 }), w = waFake(), p = pushFake();
  const out = await REC.sweep(deps(m, w, p), before, { concurrency: 1 });
  assert.equal(w.sent.length, 0, 'nothing sent after midnight'); assert.ok(out.deferred >= 1 || out.quiet >= 1, 'the rest was left: ' + JSON.stringify(out)); assert.ok(m.calls <= 2, 'few or no wasted model calls: ' + m.calls);
  const morning = Date.UTC(2026, 9, 16, 6, 30); const out2 = await REC.sweep(deps(model(), w, p), morning); assert.equal(out2['sent:offer_visit'], 4); assert.equal(w.sent.length, 4);
});

test('NOTHING ELSE MOVED: a chat the receptionist is not on for is never touched by the backup; a new Meta lead is still switched on by it; a paused chat stays paused', async () => {
  const phone = await arm(1, NOW); await db.doc('conversations/' + phone).update({ receptionist: { on: false } });
  const lead = phoneOf(2); await db.doc('contacts/' + lead).set({ phone: lead, name: 'Cust2', projectType: 'Kitchen', source: 'Meta Ads', createdAt: ts(NOW - 2 * H), metaLead: { leadId: '2', receivedAt: ts(NOW - 2 * H) } });
  await db.doc('conversations/' + lead).set({ phone: lead, name: 'Cust2', inboxStatus: 'inbox', createdAt: ts(NOW - 2 * H), updatedAt: ts(NOW - 2 * H), unreadCount: 0 });
  await store.storeInbound(db, { wamid: 'wamid.NEWLEAD', from: lead, type: 'text', body: 'Hi', name: 'Cust2', createdAt: new Date(NOW - 90 * SEC) });
  const paused = await arm(3, NOW, 60 * SEC, { paused: 'a person replied' });
  const m = model(), w = waFake(), out = await REC.sweep(deps(m, w, pushFake()), NOW);
  assert.equal(out.activated, 1); assert.equal(w.sent.length, 1); assert.equal(w.sent[0].to, lead); assert.equal(out.paused, 1); assert.equal((await rec(phone)).on, false); assert.equal((await rec(paused)).paused, 'a person replied');
});
