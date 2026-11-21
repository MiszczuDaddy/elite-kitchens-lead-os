// The Assistant's follow-up LIST with tick boxes (tool propose_follow_ups, kind "followUpList"; functions/lib/aiActions.js, docs/FOLLOW_UP_EMAIL.md): leads who never replied and customers who got a quote and never answered, in ONE
// card, each with how many days it has been and a tick box; whoever meets the rules starts ticked, a quote under two weeks old starts UNTICKED and may be ticked; only the ticked people are emailed; the send time can be chosen
// (now, the next morning, a time of your choice; the Irish night is never used) and a scheduled send can be cancelled; every person is checked again at the moment of sending. Real Firestore emulator; Gmail is a fake that
// records what would be sent; the "model" is a fake. Every name and number is made up.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const ai = require('../lib/ai');
const A = require('../lib/aiActions');
const Gmail = require('../lib/gmail');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const actor = { kind: 'staff', id: 'thomas@example.com' }, OWNERS = 'thomas@example.com';
const NOW = Date.UTC(2026, 10, 21, 22, 0), DAY = 24 * 3600e3, HOUR = 3600e3, ts = (t) => Timestamp.fromMillis(t), USAGE = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 };   // 22:00 Irish time: the owner is on the laptop at night
const rejects = (p, code, re) => assert.rejects(p, (e) => e.code === code && (!re || re.test(e.message)), `expected ${code}${re ? ' ' + re : ''}`);
const qid = (n) => 'q_' + String(n).padStart(24, '0');

function fake(script = [{ text: 'ok' }]) {
  const m = { name: 'fake', calls: [], async complete(req) { m.calls.push(JSON.parse(JSON.stringify(req))); const s = script[Math.min(m.calls.length - 1, script.length - 1)]; return { text: '', toolCalls: [], stopReason: 'end_turn', usage: USAGE, ...s }; } };
  return m;
}
const use = (name, input, id = 'tu_1') => ({ toolCalls: [{ id, name, input }], stopReason: 'tool_use' });
const checked = () => db.doc('aiSettings/modelCheck').set(Object.fromEntries(Object.entries(ai.MODELS).map(([k, m]) => [k, { id: m.id, ok: true, name: m.label, lifecycle: 'active', at: ts(NOW) }])));
const KINDS_ON = { customerNote: true, projectUpdate: true, followUpEmails: true, quoteFollowUps: true, customerEmail: true };
const on = async (kinds = KINDS_ON) => { await checked(); await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, actionsEnabled: true, actionKinds: kinds, monthlyCapEur: 15, dailyCapEur: 2 }); };
const chat = (model, uid = 'u1') => ai.chat({ db, model, owners: OWNERS }, actor, { message: 'send follow up emails to everyone who did not respond' }, { uid, nowMs: NOW });
function gmail(mode = 'ok') { const g = { sent: [], async sendRaw(raw) { g.sent.push(Buffer.from(raw, 'base64url').toString('utf8')); if (mode === 'refused') throw new Gmail.GmailError('rate_limited', 429, true); return { id: 'gm' + g.sent.length, threadId: 't' + g.sent.length }; } }; return g; }
const mailer = (g, over = {}) => ({ enabled: true, sender: 'followups@example.com', replyTo: 'info@example.com', fromName: 'Elite Kitchens', gmail: g, ...over });
const decide = (id, data, m, uid = 'u1', nowMs = NOW) => ai.decideProposal({ db, mailer: m }, actor, { proposalId: id, ...data }, { uid, nowMs });
const prop = async (id) => (await db.doc('aiProposals/' + id).get()).data();
const toOf = (raw) => /^To: (.+)$/m.exec(raw)[1].trim();
const rowOf = (p, label) => p.preview.rows.find((r) => r.type === 'pick' && r.label.startsWith(label));
const textsOf = (rows) => rows.map((r) => r.text);

// a customer with a sent quote
async function sentQuote(n, phone, name, email, daysAgo, { quote = {}, conv = {} } = {}) {
  const sentAt = NOW - daysAgo * DAY;
  await db.doc('contacts/' + phone).set({ phone, name, ...(email ? { email } : {}) });
  await db.doc('conversations/' + phone).set({ phone, name, inboxStatus: 'quoted', unreadCount: 0, lastMessage: 'Hi, your quotation', lastMessageDirection: 'out', createdAt: ts(NOW - 40 * DAY), updatedAt: ts(sentAt), ...conv });
  await db.doc('quotes/' + qid(n)).set({ phone, ref: 'EK-01' + String(n).padStart(2, '0'), status: 'sent', sentAt: ts(sentAt), customerName: name, summary: { dearest: { incVat: 18000 } }, ...quote });
  return sentAt;
}
async function lead(phone, name, email, daysAgo, over = {}) {
  await db.doc('contacts/' + phone).set({ phone, name, ...(email ? { email } : {}) });
  await db.doc('conversations/' + phone).set({ phone, name, inboxStatus: 'inbox', createdAt: ts(NOW - daysAgo * DAY), updatedAt: ts(NOW - daysAgo * DAY), lastMessage: 'Hi, thanks for your enquiry', lastMessageDirection: 'out', unreadCount: 0, ...over });
}
const ANNE = '353871119801', JOHN = '353871119802', JAY = '353871119803', OONA = '353871119811', PAT = '353871119812';
async function seed() {
  await sentQuote(1, ANNE, 'Anne Apple', 'anne@example.com', 5);                                                       // 5 days: listed, UNTICKED
  await sentQuote(2, JOHN, 'John Byrne', 'john@example.com', 15);                                                      // 15 days: ticked
  await sentQuote(3, JAY, 'Jay Casey', 'jay@example.com', 23);                                                         // 23 days: ticked
  await sentQuote(4, '353871119804', 'Under Aday', 'u@example.com', 0.5);                                              // under a day: not listed
  await sentQuote(5, '353871119805', 'Wrote Back', 'w@example.com', 20, { conv: { lastInboundAt: ts(NOW - 2 * DAY) } });  // answered: not listed
  await sentQuote(6, '353871119806', 'Already Chased', 'a@example.com', 20, { conv: { quoteMail: { [qid(6)]: { at: ts(NOW - 3 * DAY), basis: NOW - 20 * DAY, confirmed: true } } } });
  await sentQuote(7, '353871119807', 'No Email', null, 20); await sentQuote(8, '353871119808', 'Do Not Contact', 'd@example.com', 20, { conv: { doNotContact: { on: true } } });
  await sentQuote(9, '353871119809', 'Accepted Already', 'x@example.com', 20, { quote: { status: 'accepted' } });
  await lead(OONA, 'Oona Oldwait', 'oona@example.com', 6); await lead(PAT, 'Pat Pending', 'pat@example.com', 9);
  await lead('353871119813', 'Lead Wrote', 'lw@example.com', 8, { lastInboundAt: ts(NOW - DAY), lastMessageDirection: 'in', unreadCount: 1 });
  await lead('353871119814', 'Lead Emailed Lately', 'le@example.com', 8, { followUp: { emailCount: 1, emailAt: ts(NOW - 3 * DAY) } });
}
beforeEach(async () => { await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' }); await seed(); });
const prepare = async (uid = 'u1', kinds) => { await on(kinds); const m = fake([use('propose_follow_ups', {}), { text: 'x' }]); return chat(m, uid); };

test('SWITCH: the list tool is offered when either follow-up kind is on, not when neither is; it only includes the kinds that are on', async () => {
  const offered = async (kinds) => { await on(kinds); const m = fake(); await chat(m, 'x' + Math.random()); return m.calls[0].tools.map((t) => t.name).filter((n) => n.startsWith('propose_')); };
  assert.ok((await offered(KINDS_ON)).includes('propose_follow_ups'));
  assert.ok((await offered({ customerNote: true, followUpEmails: true })).includes('propose_follow_ups')); assert.ok((await offered({ customerNote: true, quoteFollowUps: true })).includes('propose_follow_ups'));
  assert.ok(!(await offered({ customerNote: true, projectUpdate: true, customerEmail: true })).includes('propose_follow_ups'));
  await on(); const m = fake(); await chat(m, 'sys'); assert.match(m.calls[0].system, /call propose_follow_ups: it shows ONE list with how many days it has been and a tick box/);
  assert.deepEqual(m.calls[0].tools.find((t) => t.name === 'propose_follow_ups').input_schema.properties.include.enum, ['both', 'quotes', 'leads']);
  await rejects(ai.saveSettings({ db, owners: OWNERS }, actor, { actionKinds: { followUpList: true } }, { nowMs: NOW }), 'invalid-argument', /Unknown kind of action/);       // not a switch of its own
  // only the quote kind on: no leads group; only the lead kind on: no quotes group
  let r = await prepare('q1', { quoteFollowUps: true }); let p = await prop(r.proposals[0].id); assert.deepEqual(p.preview.rows.filter((x) => x.type === 'pick').map((x) => x.label.split(' (')[0]), ['Quotes nobody answered']);
  r = await prepare('l1', { followUpEmails: true }); p = await prop(r.proposals[0].id); assert.deepEqual(p.preview.rows.filter((x) => x.type === 'pick').map((x) => x.label.split(' (')[0]), ['Leads who never replied']);
});

test('PREPARING: both groups, oldest first, with how long it has been; whoever meets the rules starts ticked, a quote under two weeks starts unticked; the model supplies no words; nothing is sent or changed', async () => {
  const g = gmail(); const before = JSON.stringify((await db.collection('conversations').get()).docs.map((d) => [d.id, d.data()]));
  const r = await prepare();
  assert.equal(r.proposals.length, 1); assert.equal(r.proposals[0].title, 'Follow up 5 customers'); assert.match(r.reply, /^Prepared for your approval: Follow up 5 customers\./);
  const p = await prop(r.proposals[0].id); assert.deepEqual([p.status, p.kind, p.phone], ['pending', 'followUpList', null]);
  const quotes = rowOf(p, 'Quotes nobody answered'), leads = rowOf(p, 'Leads who never replied');
  assert.equal(quotes.label, 'Quotes nobody answered (3)'); assert.equal(leads.label, 'Leads who never replied (2)');
  assert.deepEqual(quotes.items.map((x) => x.text), ['Jay Casey · EK-0103 · sent 23 days ago · jay@example.com', 'John Byrne · EK-0102 · sent 15 days ago · john@example.com', 'Anne Apple · EK-0101 · sent 5 days ago · anne@example.com'], 'oldest first, with the days');
  assert.deepEqual(quotes.items.map((x) => [x.id, x.checked, x.note]), [[`q:${qid(3)}`, true, undefined], [`q:${qid(2)}`, true, undefined], [`q:${qid(1)}`, false, 'under 2 weeks']], 'Anne (5 days) starts unticked and says why; the others are ticked');
  assert.deepEqual(leads.items.map((x) => [x.text, x.checked]), [['Pat Pending · arrived 9 days ago · pat@example.com', true], ['Oona Oldwait · arrived 6 days ago · oona@example.com', true]]);
  assert.deepEqual(p.payload.items.map((x) => [x.id, x.type]), [[`q:${qid(3)}`, 'quote'], [`q:${qid(2)}`, 'quote'], [`q:${qid(1)}`, 'quote'], ['l:' + PAT, 'lead'], ['l:' + OONA, 'lead']]);
  assert.equal(p.preview.rows.filter((x) => x.type === 'text').length, 2, 'ONE preview of each email, not one per person'); assert.match(textsOf(p.preview.rows.filter((x) => x.type === 'text')).join('\n'), /check that you received your quote \(\{quote number\}\)[\s\S]*free home consultation/);
  assert.match(p.preview.footer, /Tick the people you want to email[\s\S]*under two weeks old starts unticked[\s\S]*Nothing is sent before you press Approve/);
  assert.equal(JSON.stringify((await db.collection('conversations').get()).docs.map((d) => [d.id, d.data()])), before, 'preparing changes nothing'); assert.equal(g.sent.length, 0);
  // include
  await on(); const only = async (include) => { const m = fake([use('propose_follow_ups', { include }), { text: 'x' }]); const x = await chat(m, 'inc' + include); return x.proposals.length ? prop(x.proposals[0].id) : JSON.stringify(m.calls[1]); };
  assert.deepEqual((await only('quotes')).preview.rows.filter((x) => x.type === 'pick').map((x) => x.label.split(' (')[0]), ['Quotes nobody answered']); assert.deepEqual((await only('leads')).preview.rows.filter((x) => x.type === 'pick').map((x) => x.label.split(' (')[0]), ['Leads who never replied']);
  assert.match(await only('everyone'), /include must be both, quotes or leads/);
});

test('NOBODY TO FOLLOW UP, AND THE KINDS THAT ARE OFF: a plain answer and nothing stored', async () => {
  await on(); for (const d of (await db.collection('quotes').get()).docs) await d.ref.update({ status: 'accepted' }); for (const d of (await db.collection('conversations').get()).docs) await d.ref.update({ unreadCount: 1 });
  const m = fake([use('propose_follow_ups', {}), { text: 'Nobody.' }]); const r = await chat(m, 'none'); assert.deepEqual(r.proposals, []); assert.match(JSON.stringify(m.calls[1]), /nobody to follow up right now/); assert.equal((await db.collection('aiProposals').get()).size, 0);
});

test('APPROVING THE TICKED: only the ticked people are emailed, a quote under two weeks old can be ticked, and the result lists them', async () => {
  const r = await prepare(), id = r.proposals[0].id, g = gmail();
  const out = await decide(id, { decision: 'approve', selected: [`q:${qid(3)}`, `q:${qid(1)}`, 'l:' + OONA] }, mailer(g));          // Jay (23 days), Anne (5 days: ticked by hand), Oona; NOT John, NOT Pat
  assert.deepEqual([out.status, out.message], ['applied', '3 emails were sent.']); assert.deepEqual(out.results.map((x) => [x.label, x.ok]), [['Jay Casey (EK-0103)', true], ['Anne Apple (EK-0101)', true], ['Oona Oldwait', true]]);
  assert.deepEqual(g.sent.map(toOf).sort(), ['anne@example.com', 'jay@example.com', 'oona@example.com']);
  for (const raw of g.sent) assert.match(raw, /^From: "Elite Kitchens" <followups@example\.com>/m);
  const anne = g.sent.find((x) => toOf(x) === 'anne@example.com'); assert.match(anne, /^Subject: Your Elite Kitchens quote EK-0101/m); assert.ok(anne.includes('Hi Anne,'));
  assert.ok((await db.doc('conversations/' + JOHN).get()).data().quoteMail === undefined, 'John was not ticked: not emailed'); assert.equal((await db.doc('conversations/' + PAT).get()).data().followUp, undefined);
  assert.ok((await db.doc('conversations/' + ANNE).get()).data().quoteMail[qid(1)].at, 'Anne is recorded as followed up for this sending'); assert.equal((await prop(id)).status, 'applied');
  assert.deepEqual((await prop(id)).selected.sort(), [`l:${OONA}`, `q:${qid(1)}`, `q:${qid(3)}`].sort());
  const log = JSON.stringify((await db.collection('auditLog').where('action', '==', 'aiProposal').get()).docs.map((d) => d.data())); assert.doesNotMatch(log, /anne@|jay@|oona@|john@|pat@|Anne|Jay|Oona|Apple|Casey/, 'the audit log holds no customer names or addresses');
  const again = await decide(id, { decision: 'approve', selected: [`q:${qid(2)}`] }, mailer(g)); assert.equal(again.status, 'applied'); assert.equal(g.sent.length, 3, 'a second Approve repeats nothing and cannot add people');
});

test('WHAT MAY BE TICKED: only people on the list; at least one; selected and sendAt belong to this list only', async () => {
  const r = await prepare(), id = r.proposals[0].id, g = gmail();
  await rejects(decide(id, { decision: 'approve' }, mailer(g)), 'invalid-argument', /Tick the people to email/); await rejects(decide(id, { decision: 'approve', selected: [] }, mailer(g)), 'invalid-argument', /Tick at least one person/);
  await rejects(decide(id, { decision: 'approve', selected: ['q:' + qid(99)] }, mailer(g)), 'invalid-argument', /Tick the people to email/); await rejects(decide(id, { decision: 'approve', selected: ['l:353871119999'] }, mailer(g)), 'invalid-argument');
  await rejects(decide(id, { decision: 'approve', selected: [5] }, mailer(g)), 'invalid-argument'); await rejects(decide(id, { decision: 'approve', selected: 'q:x' }, mailer(g)), 'invalid-argument'); await rejects(decide(id, { decision: 'approve', selected: Array(201).fill('x') }, mailer(g)), 'invalid-argument');
  await rejects(decide(id, { decision: 'approve', selected: ['l:' + OONA], sendAt: 'tomorrow' }, mailer(g)), 'invalid-argument', /Choose a time to send/); await rejects(decide(id, { decision: 'approve', selected: ['l:' + OONA], sendAt: NOW + 4 * DAY }, mailer(g)), 'invalid-argument', /within the next 3 days/);
  await rejects(decide(id, { decision: 'approve', selected: ['l:' + OONA], extra: 1 }, mailer(g)), 'invalid-argument', /Unknown field: extra/); assert.equal(g.sent.length, 0); assert.equal((await prop(id)).status, 'pending');
  await on(); const n = await chat(fake([use('propose_customer_note', { customerId: OONA, text: 'A note for the file.' }), { text: 'x' }]), 'note'); await rejects(decide(n.proposals[0].id, { decision: 'approve', selected: ['x'] }, mailer(g), 'note'), 'invalid-argument', /Unknown field: selected/);
  await rejects(decide(id, { decision: 'approve', selected: ['l:' + OONA] }, mailer(g), 'someone-else'), 'permission-denied', /Only the person who asked/);
  await rejects(decide(id, { decision: 'approve', selected: ['l:' + OONA] }, mailer(g, { enabled: false })), 'failed-precondition', /Email sending is not switched on/); assert.equal((await prop(id)).status, 'pending');
});

test('AT APPROVE EVERYONE IS CHECKED AGAIN: a customer who wrote meanwhile, or who asked not to be contacted, is skipped with the reason; the others are sent', async () => {
  const r = await prepare(), id = r.proposals[0].id, g = gmail();
  await db.doc('conversations/' + JOHN).update({ lastInboundAt: ts(NOW + 60e3) }); await db.doc('conversations/' + OONA).update({ doNotContact: { on: true } });
  const out = await decide(id, { decision: 'approve', selected: [`q:${qid(3)}`, `q:${qid(2)}`, 'l:' + OONA, 'l:' + PAT] }, mailer(g));
  assert.equal(out.status, 'partial'); assert.equal(out.message, '2 of 4 emails were sent. The others were skipped (see the list).');
  assert.deepEqual(out.results.map((x) => x.ok), [true, false, true, false], 'results follow the list: quotes first (oldest first), then leads'); assert.match(out.results[1].message, /written to you since the quote was sent/); assert.match(out.results[3].message, /not to be contacted/);
  assert.deepEqual(g.sent.map(toOf).sort(), ['jay@example.com', 'pat@example.com']);
  // a quote ticked that turns out to be under a day old at send time is refused (the one-day floor), never sent
  const r2 = await prepare('u2'); await db.doc('quotes/' + qid(1)).update({ sentAt: ts(NOW - 2 * HOUR) });
  const o2 = await decide(r2.proposals[0].id, { decision: 'approve', selected: [`q:${qid(1)}`] }, mailer(g), 'u2'); assert.equal(o2.status, 'failed'); assert.match(o2.results[0].message, /less than a day ago/); assert.equal(g.sent.length, 2);
});

test('WHEN TO SEND: a chosen time is kept and nothing goes out until then; the timer sends exactly the ticked people at that time, once; the Irish night is never used', async () => {
  const r = await prepare(), id = r.proposals[0].id, g = gmail(), morning = NOW + 11 * HOUR;                         // 09:00 Irish time the next morning
  const out = await decide(id, { decision: 'approve', selected: [`q:${qid(3)}`, 'l:' + PAT], sendAt: morning }, mailer(g));
  assert.equal(out.status, 'scheduled'); assert.match(out.message, /^Scheduled for Sun, 22 Nov, 09:00\. Elite OS will send the emails then\. You can cancel until then\.$/); assert.equal(g.sent.length, 0);
  const p = await prop(id); assert.deepEqual([p.status, p.decidedBy, p.scheduledFor.toMillis(), p.selected.sort()], ['scheduled', 'thomas@example.com', morning, [`l:${PAT}`, `q:${qid(3)}`].sort()]);
  assert.deepEqual(await A.sweepScheduled({ db, mailer: mailer(g), nowMs: NOW + 2 * HOUR }), { due: 0, sent: 0, expired: 0, quiet: true }, 'at midnight the timer never sends');
  assert.deepEqual(await A.sweepScheduled({ db, mailer: mailer(g), nowMs: morning - 60e3 }), { due: 0, sent: 0, expired: 0, quiet: false }, 'not yet'); assert.equal(g.sent.length, 0);
  const done = await A.sweepScheduled({ db, mailer: mailer(g), nowMs: morning + 120e3 }); assert.deepEqual([done.due, done.sent], [1, 1]);
  assert.deepEqual(g.sent.map(toOf).sort(), ['jay@example.com', 'pat@example.com'], 'only the ticked people'); const f = await prop(id); assert.equal(f.status, 'applied'); assert.equal(f.result.message, '2 emails were sent.');
  assert.ok((await db.doc('conversations/' + JAY).get()).data().quoteMail[qid(3)].by === 'thomas@example.com', 'sent as the person who approved it');
  assert.equal((await A.sweepScheduled({ db, mailer: mailer(g), nowMs: morning + 600e3 })).due, 0); assert.equal(g.sent.length, 2, 'once');
  // a time inside the night moves to 07:00; "now" or a minute ahead sends at once
  const r2 = await prepare('u2'); const o2 = await decide(r2.proposals[0].id, { decision: 'approve', selected: ['l:' + OONA], sendAt: NOW + 4 * HOUR }, mailer(g), 'u2');       // 02:00
  assert.match(o2.message, /Scheduled for Sun, 22 Nov, 07:00/); const r3 = await prepare('u3'); const o3 = await decide(r3.proposals[0].id, { decision: 'approve', selected: ['l:' + OONA], sendAt: NOW + 30e3 }, mailer(g), 'u3'); assert.equal(o3.status, 'applied'); assert.equal(g.sent.length, 3);
});

test('A SCHEDULED SEND CAN BE CANCELLED, IS CHECKED AGAIN WHEN ITS TIME COMES, AND IS NOT SENT IF IT IS HOURS LATE', async () => {
  const g = gmail(), morning = NOW + 11 * HOUR;
  let r = await prepare('c1'), id = r.proposals[0].id; await decide(id, { decision: 'approve', selected: ['l:' + OONA], sendAt: morning }, mailer(g), 'c1');
  const c = await decide(id, { decision: 'reject' }, mailer(g), 'c1'); assert.deepEqual([c.status, c.message], ['cancelled', 'Cancelled. Nothing was sent.']); assert.equal((await A.sweepScheduled({ db, mailer: mailer(g), nowMs: morning + 60e3 })).due, 0); assert.equal(g.sent.length, 0);
  await rejects(decide(id, { decision: 'reject' }, mailer(g), 'someone-else'), 'permission-denied');
  // checked again at the moment: a customer who wrote overnight is skipped, the rest go
  r = await prepare('c2'); id = r.proposals[0].id; await decide(id, { decision: 'approve', selected: ['l:' + OONA, 'l:' + PAT], sendAt: morning }, mailer(g), 'c2');
  await db.doc('conversations/' + OONA).update({ lastInboundAt: ts(morning - HOUR), lastMessageDirection: 'in' });
  await A.sweepScheduled({ db, mailer: mailer(g), nowMs: morning + 60e3 }); const p = await prop(id); assert.equal(p.status, 'partial'); assert.deepEqual(p.result.results.map((x) => x.ok), [true, false]); assert.deepEqual(g.sent.map(toOf), ['pat@example.com']);
  // hours late (the timer was down): not sent, said so
  r = await prepare('c3'); id = r.proposals[0].id; await decide(id, { decision: 'approve', selected: [`q:${qid(2)}`], sendAt: morning }, mailer(g), 'c3');
  const late = await A.sweepScheduled({ db, mailer: mailer(g), nowMs: morning + 7 * HOUR }); assert.deepEqual([late.due, late.expired, late.sent], [1, 1, 0]); const e = await prop(id); assert.equal(e.status, 'expired'); assert.match(e.result.message, /more than six hours ago, so nothing was sent/); assert.equal(g.sent.length, 1);
  // email sending switched off at the time: failed with the reason, nothing sent
  r = await prepare('c4'); id = r.proposals[0].id; await decide(id, { decision: 'approve', selected: [`q:${qid(3)}`], sendAt: morning }, mailer(g), 'c4');
  await A.sweepScheduled({ db, mailer: mailer(g, { enabled: false }), nowMs: morning + 60e3 }); const f = await prop(id); assert.equal(f.status, 'failed'); assert.match(f.result.message, /Email sending is not switched on/); assert.equal(g.sent.length, 1);
});
