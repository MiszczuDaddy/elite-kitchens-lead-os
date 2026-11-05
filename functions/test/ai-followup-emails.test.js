// Assistant: "email all the leads who never replied" (kind followUpEmails; functions/lib/aiActions.js, docs/FOLLOW_UP_EMAIL.md). Real Firestore emulator; Gmail is a fake that records what would be sent;
// the "model" is a fake. Every name and number is made up.
// What matters: the AI only PREPARES (the model supplies no words and no list); the preview names every recipient and shows the exact email; nothing is sent until the person who asked presses Approve;
// the send re-checks every lead (one who wrote in the meantime is skipped); pressing twice never emails anyone twice; a switch that is off sends nothing.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const ai = require('../lib/ai');
const A = require('../lib/aiActions');
const Gmail = require('../lib/gmail');
const FT = require('../lib/followUpText');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const actor = { kind: 'staff', id: 'thomas@example.com' }, OWNERS = 'thomas@example.com';
const NOW = Date.UTC(2026, 10, 5, 12, 0), DAY = 24 * 3600e3, ts = (t) => Timestamp.fromMillis(t), USAGE = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 };
const rejects = (p, code, re) => assert.rejects(p, (e) => e.code === code && (!re || re.test(e.message)), `expected ${code}${re ? ' ' + re : ''}`);

function fake(script = [{ text: 'ok' }]) {
  const m = { name: 'fake', calls: [], async complete(req) { m.calls.push(JSON.parse(JSON.stringify(req))); const s = script[Math.min(m.calls.length - 1, script.length - 1)]; return { text: '', toolCalls: [], stopReason: 'end_turn', usage: USAGE, ...s }; } };
  return m;
}
const use = (name, input, id = 'tu_1') => ({ toolCalls: [{ id, name, input }], stopReason: 'tool_use' });
const ask = (input = {}) => use('propose_followup_emails', input);
const checked = () => db.doc('aiSettings/modelCheck').set(Object.fromEntries(Object.entries(ai.MODELS).map(([k, m]) => [k, { id: m.id, ok: true, name: m.label, lifecycle: 'active', at: ts(NOW) }])));
const on = async (extra = {}) => { await checked(); await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, actionsEnabled: true, actionKinds: { customerNote: true, projectUpdate: true, followUpEmails: true }, monthlyCapEur: 15, dailyCapEur: 2, ...extra }); };
const chat = (model, data = { message: 'email all the leads who did not reply' }, o = {}) => ai.chat({ db, model, owners: OWNERS }, actor, data, { uid: 'u1', nowMs: NOW, ...o });
function gmail(mode = 'ok') { const g = { sent: [], async sendRaw(raw) { g.sent.push(Buffer.from(raw, 'base64url').toString('utf8')); if (mode === 'refused') throw new Gmail.GmailError('rate_limited', 429, true); return { id: 'gm' + g.sent.length, threadId: 't' }; } }; return g; }
const mailer = (g, over = {}) => ({ enabled: true, sender: 'followups@example.com', replyTo: 'info@example.com', fromName: 'Elite Kitchens', gmail: g, ...over });
const decide = (id, decision = 'approve', m, uid = 'u1', nowMs = NOW) => ai.decideProposal({ db, mailer: m }, actor, { proposalId: id, decision }, { uid, nowMs });
const prop = async (id) => (await db.doc('aiProposals/' + id).get()).data();
const conv = async (p) => (await db.doc('conversations/' + p).get()).data();
const audits = async () => (await db.collection('auditLog').where('action', '==', 'aiProposal').get()).docs.map((d) => d.data());
const toOf = (raw) => /^To: (.+)$/m.exec(raw)[1].trim();

// a lead who never replied: a New lead, our message last, five days old, with an email address
async function lead(phone, name, email, over = {}) {
  await db.doc('contacts/' + phone).set({ phone, name, ...(email ? { email } : {}) });
  await db.doc('conversations/' + phone).set({ phone, name, inboxStatus: 'inbox', createdAt: ts(NOW - 5 * DAY), updatedAt: ts(NOW - 5 * DAY), lastMessage: 'Hi, thanks for your enquiry', lastMessageDirection: 'out', unreadCount: 0, ...over });
}
const OONA = '353871119301', PAT = '353871119302', NIALL = '353871119303';
async function seed() {
  await lead(OONA, 'Oona Oldwait', 'oona@example.com');
  await lead(PAT, 'Pat Pending', 'pat@example.com', { createdAt: ts(NOW - 9 * DAY) });
  await lead('353871119310', 'No Email', null);                                                                     // no address
  await lead('353871119311', 'Wrote Back', 'wrote@example.com', { lastInboundAt: ts(NOW - DAY), lastMessageDirection: 'in' });
  await lead('353871119312', 'Emailed Lately', 'lately@example.com', { followUp: { emailCount: 1, emailAt: ts(NOW - 3 * DAY) } });
  await lead('353871119313', 'Brand New', 'new@example.com', { createdAt: ts(NOW - 3600e3), updatedAt: ts(NOW - 3600e3) });
  await lead('353871119314', 'Booked Already', 'booked@example.com', { inboxStatus: 'booked' });
  await lead('353871119315', 'Do Not Contact', 'dnc@example.com', { doNotContact: { on: true } });
  await lead('353871119316', 'Silent Wrote', 'silent@example.com');                                                  // our record says they never wrote, but the chat holds a message from them
  await db.doc('conversations/353871119316/messages/m1').set({ direction: 'in', type: 'text', body: 'Hello', createdAt: ts(NOW - 3 * DAY) });
}
beforeEach(async () => { await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' }); await seed(); });

async function prepare(who = 'u1') { await on(); const r = await chat(fake([ask(), { text: 'x' }]), undefined, { uid: who }); return r; }

test('SWITCH: the tool exists only when the kind is on (it is off by default); the model is told to supply nothing', async () => {
  assert.equal((await ai.loadSettings(db)).actionKinds.followUpEmails, false);
  assert.match(A.KINDS.followUpEmails, /Follow-up emails/);
  const offered = async (extra) => { await on(extra); const m = fake(); await chat(m, { message: 'hi' }, { uid: 'x' + Math.random() }); return m.calls[0].tools.map((t) => t.name).filter((n) => n.startsWith('propose_')); };
  assert.ok((await offered({})).includes('propose_followup_emails'));
  assert.ok(!(await offered({ actionKinds: { customerNote: true, projectUpdate: true } })).includes('propose_followup_emails'));
  assert.deepEqual(await offered({ actionsEnabled: false }), []);
  const m = fake(); await on(); await chat(m, { message: 'hi' }, { uid: 'sys' }); assert.match(m.calls[0].system, /propose_followup_emails with no input/);
  assert.deepEqual(m.calls[0].tools.find((t) => t.name === 'propose_followup_emails').input_schema.properties, {});
  // the owner can switch it on from Settings
  const s = await ai.saveSettings({ db, owners: OWNERS }, actor, { actionsEnabled: true, actionKinds: { followUpEmails: true } }, { nowMs: NOW }); assert.equal(s.actions.kinds.followUpEmails, true);
});

test('PREPARING: lists exactly the leads who may be emailed, shows the fixed email, sends nothing and changes nothing; the reply is fixed words', async () => {
  const g = gmail(); const before = JSON.stringify((await db.collection('conversations').get()).docs.map((d) => [d.id, d.data()]));
  const r = await prepare();
  assert.equal(r.proposals.length, 1); assert.equal(r.proposals[0].title, 'Email 2 leads who never replied'); assert.match(r.reply, /^Prepared for your approval: Email 2 leads who never replied\./);
  const p = await prop(r.proposals[0].id);
  assert.equal(p.status, 'pending'); assert.equal(p.kind, 'followUpEmails'); assert.equal(p.phone, null); assert.deepEqual(p.payload, { phones: [PAT, OONA] }, 'oldest first');
  const [list, text] = p.preview.rows;
  assert.deepEqual([list.type, list.label], ['list', 'Who gets it (2)']); assert.deepEqual(list.items, ['Pat Pending · pat@example.com', 'Oona Oldwait · oona@example.com']);
  assert.equal(text.type, 'text'); assert.match(text.label, /Your kitchen enquiry with Elite Kitchens/); assert.equal(text.text, FT.bodyFor({ first: '{first name}' })); assert.doesNotMatch(text.text, /rather not hear/);
  assert.match(p.preview.footer, /Nothing is sent before you press Approve/); assert.match(p.preview.footer, /these 2 emails/);
  assert.equal(JSON.stringify((await db.collection('conversations').get()).docs.map((d) => [d.id, d.data()])), before, 'preparing changes nothing'); assert.equal(g.sent.length, 0);
  assert.deepEqual((await audits()).map((a) => a.event), ['created']);
});

test('PREPARING: the model cannot add words, names or addresses; and nobody to email gives a plain answer and stores nothing', async () => {
  await on();
  for (const input of [{ phone: OONA }, { body: 'Buy now' }, { to: 'x@y.ie' }, []]) {
    const r = await chat(fake([ask(input), { text: 'I could not prepare that.' }]), undefined, { uid: 'bad' + Math.random() }); assert.deepEqual(r.proposals, []);
  }
  assert.equal((await db.collection('aiProposals').get()).size, 0);
  for (const d of (await db.collection('conversations').get()).docs) await d.ref.update({ unreadCount: 1 });                // everybody wrote
  const m = fake([ask(), { text: 'Nobody.' }]); const r = await chat(m, undefined, { uid: 'none' });
  assert.deepEqual(r.proposals, []); assert.match(JSON.stringify(m.calls[1]), /nobody to email right now/); assert.equal((await db.collection('aiProposals').get()).size, 0);
});

test('PREPARING: asking twice shows the same waiting proposal; at most 30 leads in one go, and it says there are more', async () => {
  const a = await prepare(); const b = await chat(fake([ask(), { text: 'x' }])); assert.deepEqual(b.proposals.map((x) => x.id), [a.proposals[0].id]); assert.match(b.reply, /^Already waiting for your approval/);
  assert.equal((await db.collection('aiProposals').where('status', '==', 'pending').get()).size, 1);
  for (let i = 0; i < 31; i++) await lead('35387111' + String(4000 + i), 'Lead ' + i, `lead${i}@example.com`);
  const r = await chat(fake([ask(), { text: 'x' }]), { message: 'again' }, { uid: 'u9' }); const p = await prop(r.proposals[0].id);
  assert.equal(p.payload.phones.length, 30); assert.equal(p.preview.rows[0].items.length, 30); assert.match(p.title, /^Email 30 leads/); assert.match(p.preview.footer, /3 more could be emailed afterwards: ask again/);
});

test('APPROVING: each lead gets the fixed email with their own first name, from the follow-up mailbox, replies to the business mailbox; the result lists everyone; the record says they were emailed', async () => {
  const r = await prepare(); const id = r.proposals[0].id, g = gmail();
  const out = await decide(id, 'approve', mailer(g));
  assert.equal(out.status, 'applied'); assert.equal(out.message, '2 emails were sent.'); assert.deepEqual(out.results.map((x) => [x.label, x.ok]), [['Pat Pending', true], ['Oona Oldwait', true]]);
  assert.equal(g.sent.length, 2); assert.deepEqual(g.sent.map(toOf), ['pat@example.com', 'oona@example.com']);
  for (const [raw, first] of [[g.sent[0], 'Pat'], [g.sent[1], 'Oona']]) { assert.match(raw, /^From: "Elite Kitchens" <followups@example\.com>/m); assert.match(raw, /^Reply-To: info@example\.com/m); assert.match(raw, /^Subject: Your kitchen enquiry with Elite Kitchens/m); assert.ok(raw.includes('Hi ' + first + ',')); }
  for (const ph of [OONA, PAT]) { const f = (await conv(ph)).followUp; assert.deepEqual([f.emailCount, f.confirmed, f.emailBy, f.emailAt.toMillis()], [1, true, 'thomas@example.com', NOW]); }
  for (const ph of ['353871119310', '353871119311', '353871119312', '353871119313', '353871119314', '353871119315', '353871119316']) assert.ok(!(await conv(ph)).followUp || (await conv(ph)).followUp.emailCount === 1, 'nobody else was emailed');
  assert.equal((await prop(id)).status, 'applied');
  const log = JSON.stringify(await audits()); assert.doesNotMatch(log, /oona@|pat@|Oona|Pat Pending/, 'the audit log holds no names or addresses'); assert.deepEqual((await audits()).map((a) => a.event).sort(), ['applied', 'created']);
});

test('APPROVING TWICE: the same answer comes back and nobody is emailed again', async () => {
  const r = await prepare(); const id = r.proposals[0].id, g = gmail();
  await decide(id, 'approve', mailer(g)); const again = await decide(id, 'approve', mailer(g));
  assert.equal(again.status, 'applied'); assert.equal(g.sent.length, 2);
  const [x, y] = await Promise.all([prepare('u2').then((p) => decide(p.proposals[0].id, 'approve', mailer(g), 'u2')).catch((e) => e), decide(id, 'approve', mailer(g))]);   // a second proposal after the first was sent has nobody left
  assert.equal(g.sent.length, 2); assert.ok(x instanceof Error || x.status !== 'applied');
});

test('A LEAD WHO WROTE IN THE MEANTIME is skipped with a reason; the others are still emailed', async () => {
  const r = await prepare(); const id = r.proposals[0].id, g = gmail();
  await db.doc('conversations/' + PAT).update({ lastInboundAt: ts(NOW + 1000), lastMessageDirection: 'in', unreadCount: 1 });
  const out = await decide(id, 'approve', mailer(g));
  assert.equal(out.status, 'partial'); assert.equal(out.message, '1 of 2 emails were sent. The others were skipped (see the list).');
  assert.deepEqual(out.results.map((x) => [x.label, x.ok]), [['Pat Pending', false], ['Oona Oldwait', true]]); assert.match(out.results[0].message, /already written/);
  assert.deepEqual(g.sent.map(toOf), ['oona@example.com']);
});

test('GOOGLE REFUSES: nothing is recorded as sent and the result says so; an unclear answer from Google counts as sent and is never retried', async () => {
  const r = await prepare(); const id = r.proposals[0].id, g = gmail('refused');
  const out = await decide(id, 'approve', mailer(g));
  assert.equal(out.status, 'failed'); assert.equal(out.message, 'No email was sent.'); assert.ok(out.results.every((x) => !x.ok && /Nothing was sent/.test(x.message)));
  assert.ok(!(await conv(OONA)).followUp || !(await conv(OONA)).followUp.emailCount);
});

test('SWITCHES AT DECISION TIME: with email sending off, or the kind, AI actions or customer data off, nothing is sent and the proposal stays waiting; rejecting always works', async () => {
  const r = await prepare(); const id = r.proposals[0].id, g = gmail();
  await rejects(decide(id, 'approve', undefined), 'failed-precondition', /Email sending is not switched on/);
  await rejects(decide(id, 'approve', mailer(g, { enabled: false })), 'failed-precondition', /not switched on/);
  for (const off of [{ actionKinds: { customerNote: true, projectUpdate: true, followUpEmails: false } }, { actionsEnabled: false }, { customerDataApproved: false }, { enabled: false }]) {
    await on(off); await rejects(decide(id, 'approve', mailer(g)), 'failed-precondition', /switched off/);
  }
  assert.equal(g.sent.length, 0); assert.equal((await prop(id)).status, 'pending');
  const rej = await decide(id, 'reject', mailer(g)); assert.equal(rej.status, 'rejected'); assert.equal(g.sent.length, 0);
  assert.deepEqual(await Promise.all([OONA, PAT].map(async (p) => (await conv(p)).followUp)), [undefined, undefined]);
});

test('WHO MAY DECIDE, AND WHEN: only the person who asked; not after it expired', async () => {
  const r = await prepare(); const id = r.proposals[0].id, g = gmail();
  await rejects(decide(id, 'approve', mailer(g), 'u2'), 'permission-denied', /Only the person who asked/);
  const late = await decide(id, 'approve', mailer(g), 'u1', NOW + 31 * 60 * 1000); assert.equal(late.status, 'expired'); assert.equal(g.sent.length, 0);
});
