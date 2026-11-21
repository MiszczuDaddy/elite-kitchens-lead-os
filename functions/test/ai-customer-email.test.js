// Assistant: ONE email to ONE customer, written by the Assistant (kind customerEmail; functions/lib/aiActions.js, docs/FOLLOW_UP_EMAIL.md). Real Firestore emulator; Gmail is a fake that records what would be sent; the "model" is a fake.
// What matters: the model writes the subject and the body, but CODE adds the greeting and the signature, refuses any warranty or guarantee wording, and shows the person the EXACT final text; nothing is sent until the person who
// asked presses Approve; what is sent is exactly what was shown; at Approve it is checked again (a customer who wrote since, who asked not to be contacted, an email address that went); pressing twice sends one email; a switch that
// is off offers nothing; the email is recorded in the customer's chat and in the Emails list. Every name and number is made up.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const ai = require('../lib/ai');
const A = require('../lib/aiActions');
const T = require('../lib/aiTools');
const Gmail = require('../lib/gmail');
const FT = require('../lib/followUpText');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const actor = { kind: 'staff', id: 'thomas@example.com' }, OWNERS = 'thomas@example.com';
const NOW = Date.UTC(2026, 10, 16, 12, 0), DAY = 24 * 3600e3, ts = (t) => Timestamp.fromMillis(t), USAGE = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 };
const rejects = (p, code, re) => assert.rejects(p, (e) => e.code === code && (!re || re.test(e.message)), `expected ${code}${re ? ' ' + re : ''}`);
const RAY = '353871119701', NOMAIL = '353871119702', DNC = '353871119703';

function fake(script = [{ text: 'ok' }]) {
  const m = { name: 'fake', calls: [], async complete(req) { m.calls.push(JSON.parse(JSON.stringify(req))); const s = script[Math.min(m.calls.length - 1, script.length - 1)]; return { text: '', toolCalls: [], stopReason: 'end_turn', usage: USAGE, ...s }; } };
  return m;
}
const use = (name, input, id = 'tu_1') => ({ toolCalls: [{ id, name, input }], stopReason: 'tool_use' });
const BODY = 'Thanks again for getting in touch about your kitchen. I just wanted to check that you received our quote and to see if you have any questions about it. If it is easier to talk it through, call us any time.';
const mail = (over = {}) => use('propose_customer_email', { customerId: RAY, subject: 'Checking in on your kitchen quote', body: BODY, ...over });
const checked = () => db.doc('aiSettings/modelCheck').set(Object.fromEntries(Object.entries(ai.MODELS).map(([k, m]) => [k, { id: m.id, ok: true, name: m.label, lifecycle: 'active', at: ts(NOW) }])));
const on = async (extra = {}) => { await checked(); await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, actionsEnabled: true, actionKinds: { customerNote: true, projectUpdate: true, followUpEmails: true, quoteFollowUps: true, customerEmail: true }, monthlyCapEur: 15, dailyCapEur: 2, ...extra }); };
const chat = (model, data = { message: 'write a follow up email to ray ryan please' }, o = {}) => ai.chat({ db, model, owners: OWNERS }, actor, data, { uid: 'u1', nowMs: NOW, ...o });
function gmail(mode = 'ok') { const g = { sent: [], opts: [], async sendRaw(raw, o = {}) { g.sent.push(Buffer.from(raw, 'base64url').toString('utf8')); g.opts.push(o); if (mode === 'refused') throw new Gmail.GmailError('rate_limited', 429, true); if (mode === 'unknown') throw new Gmail.GmailError('network', 0, false); return { id: 'gm' + g.sent.length, threadId: 'th' + g.sent.length }; } }; return g; }
const mailer = (g, over = {}) => ({ enabled: true, sender: 'followups@example.com', replyTo: 'info@example.com', fromName: 'Elite Kitchens', gmail: g, ...over });
const decide = (id, decision = 'approve', m, uid = 'u1', nowMs = NOW) => ai.decideProposal({ db, mailer: m }, actor, { proposalId: id, decision }, { uid, nowMs });
const prop = async (id) => (await db.doc('aiProposals/' + id).get()).data();
const conv = async (p) => (await db.doc('conversations/' + p).get()).data();
const bodyOf = (raw) => raw.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (m, x) => String.fromCharCode(parseInt(x, 16)));
async function customer(phone, name, email, convOver = {}) {
  await db.doc('contacts/' + phone).set({ phone, name, ...(email ? { email } : {}) });
  await db.doc('conversations/' + phone).set({ phone, name, inboxStatus: 'quoted', unreadCount: 0, lastMessage: 'Hi Ray, your quotation', lastMessageDirection: 'out', createdAt: ts(NOW - 20 * DAY), updatedAt: ts(NOW - 9 * DAY), ...convOver });
}
beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await customer(RAY, 'Ray Ryan', 'ray@example.com'); await customer(NOMAIL, 'Nora Noemail', null); await customer(DNC, 'Dan Dontcontact', 'dan@example.com', { doNotContact: { on: true } });
});
const prepare = async (over, uid = 'u1') => { await on(); return chat(fake([mail(over), { text: 'x' }]), undefined, { uid }); };

test('SWITCH: the tool exists only when the kind is on (it is off by default); the owner can switch it on', async () => {
  assert.equal((await ai.loadSettings(db)).actionKinds.customerEmail, false); assert.match(A.KINDS.customerEmail, /An email to one customer/);
  const offered = async (extra) => { await on(extra); const m = fake(); await chat(m, { message: 'hi' }, { uid: 'x' + Math.random() }); return m.calls[0].tools.map((t) => t.name).filter((n) => n.startsWith('propose_')); };
  assert.ok((await offered({})).includes('propose_customer_email'));
  assert.ok(!(await offered({ actionKinds: { customerNote: true, projectUpdate: true, followUpEmails: true, quoteFollowUps: true } })).includes('propose_customer_email'));
  assert.deepEqual(await offered({ actionsEnabled: false }), []);
  await on(); const m = fake(); await chat(m, { message: 'hi' }, { uid: 'sys' }); assert.match(m.calls[0].system, /call propose_customer_email with a short, friendly subject and body/);
  const t = m.calls[0].tools.find((x) => x.name === 'propose_customer_email'); assert.deepEqual(t.input_schema.required, ['customerId', 'subject', 'body']); assert.equal(t.input_schema.additionalProperties, false);
  const s = await ai.saveSettings({ db, owners: OWNERS }, actor, { actionsEnabled: true, actionKinds: { customerEmail: true } }, { nowMs: NOW }); assert.equal(s.actions.kinds.customerEmail, true);
});

test('PREPARING: the model writes the words; the greeting and the signature are added by code, a sign-off it added is replaced; the person sees the EXACT text; nothing is sent or changed', async () => {
  const g = gmail(); const before = JSON.stringify((await db.collection('conversations').get()).docs.map((d) => [d.id, d.data()]));
  const r = await prepare();
  assert.equal(r.proposals.length, 1); assert.equal(r.proposals[0].title, 'Email Ray Ryan'); assert.match(r.reply, /^Prepared for your approval: Email Ray Ryan\./);
  const p = await prop(r.proposals[0].id);
  assert.deepEqual([p.status, p.kind, p.phone, p.targetId], ['pending', 'customerEmail', RAY, RAY]);
  const full = ['Hi Ray,', '', BODY, '', 'Kind regards,', 'Elite Kitchens', '089 464 1917 | info@elitekitchens.ie | www.elitekitchens.ie'].join('\n');
  assert.deepEqual(p.payload, { phone: RAY, subject: 'Checking in on your kitchen quote', body: full });
  const [who, text] = p.preview.rows; assert.deepEqual([who.type, who.items], ['list', ['Ray Ryan · ray@example.com']]); assert.deepEqual([text.type, text.text], ['text', full]); assert.match(text.label, /subject: Checking in on your kitchen quote/);
  assert.match(p.preview.footer, /sent exactly as written above[\s\S]*Nothing is sent before you press Approve/);
  assert.equal(JSON.stringify((await db.collection('conversations').get()).docs.map((d) => [d.id, d.data()])), before, 'preparing changes nothing'); assert.equal(g.sent.length, 0);
  // a greeting and a sign-off the model wrote are not doubled
  const r2 = await prepare({ body: 'Hello Ray, ' + BODY + '\n\nKind regards,\nElite Kitchens' }, 'u2'); const f2 = (await prop(r2.proposals[0].id)).payload.body;
  assert.equal((f2.match(/Hello Ray,/g) || []).length, 1); assert.ok(!/^Hi Ray/m.test(f2), 'no second greeting'); assert.equal((f2.match(/Kind regards,/g) || []).length, 1, 'one sign-off'); assert.equal((f2.match(/Elite Kitchens/g) || []).length, 1);
  assert.deepEqual((await db.collection('auditLog').where('action', '==', 'aiProposal').get()).docs.map((d) => d.data().event), ['created', 'created']);
});

test('PREPARING, REFUSED: no address, asked not to be contacted, unknown customer, a bad subject or body, any warranty or guarantee wording, extra fields: the model is told why and nothing is stored', async () => {
  await on(); const tried = async (input) => { const m = fake([use('propose_customer_email', input), { text: 'x' }]); const r = await chat(m, undefined, { uid: 'bad' + Math.random() }); assert.deepEqual(r.proposals, [], JSON.stringify(input).slice(0, 60)); return JSON.stringify(m.calls[1]); };
  assert.match(await tried({ customerId: NOMAIL, subject: 's', body: BODY }), /no email address on file/); assert.match(await tried({ customerId: DNC, subject: 's', body: BODY }), /asked not to be contacted/);
  assert.match(await tried({ customerId: '353871119999', subject: 's', body: BODY }), /No customer with that id/); assert.match(await tried({ customerId: 'abc', subject: 's', body: BODY }), /not a valid customer id/);
  assert.match(await tried({ customerId: RAY, subject: 'Two\nlines', body: BODY }), /subject must be one line/); assert.match(await tried({ customerId: RAY, subject: '', body: BODY }), /subject must be one line/); assert.match(await tried({ customerId: RAY, subject: 'x'.repeat(121), body: BODY }), /subject must be one line/);
  assert.match(await tried({ customerId: RAY, subject: 's', body: 'too short' }), /between 20 and 1800/); assert.match(await tried({ customerId: RAY, subject: 's', body: 'x'.repeat(1801) }), /between 20 and 1800/);
  for (const w of ['We offer a full warranty on all our work, so you can relax about the fitting.', 'Our quote is guaranteed for the next thirty days, as we said.', 'We guarantee the delivery date, and the fitting too, just as we promised you.']) assert.match(await tried({ customerId: RAY, subject: 'Your quote', body: w }), /Do not mention warranties or guarantees/);
  assert.match(await tried({ customerId: RAY, subject: 'Your warranty', body: BODY }), /Do not mention warranties or guarantees/, 'also in the subject');
  assert.match(await tried({ customerId: RAY, subject: 's', body: BODY, to: 'someone@else.ie' }), /Unknown field/); assert.match(await tried({ customerId: RAY, subject: 's' }), /The email must be between/);
  assert.equal((await db.collection('aiProposals').get()).size, 0);
});

test('APPROVING: exactly the previewed text is sent to the customer\'s address as a NEW email from the follow-up mailbox, kept in their chat and listed; the result says so', async () => {
  const r = await prepare(), id = r.proposals[0].id, g = gmail(); const planned = (await prop(id)).payload;
  const out = await decide(id, 'approve', mailer(g));
  assert.deepEqual([out.status, out.message, out.results], ['applied', 'The email was sent to Ray Ryan.', [{ label: 'Ray Ryan', ok: true }]]);
  assert.equal(g.sent.length, 1); const raw = g.sent[0];
  assert.match(raw, /^From: "Elite Kitchens" <followups@example\.com>/m); assert.match(raw, /^To: ray@example\.com/m); assert.match(raw, /^Reply-To: info@example\.com/m); assert.match(raw, /^Subject: Checking in on your kitchen quote/m);
  assert.doesNotMatch(raw, /^In-Reply-To:/m, 'a new email, not a reply in a thread'); assert.deepEqual(g.opts[0], {}); assert.equal(bodyOf(raw).replace(/\r\n/g, '\n').trim(), planned.body, 'exactly what the person read');
  const c = await conv(RAY); assert.deepEqual([c.lastEmailDir, c.lastEmailSubject, c.lastEmailAt.toMillis()], ['out', 'Checking in on your kitchen quote', NOW]);
  const kept = (await db.collection(`conversations/${RAY}/emails`).get()).docs.map((d) => d.data()); assert.equal(kept.length, 1); assert.deepEqual([kept[0].direction, kept[0].kind, kept[0].by, kept[0].to, kept[0].confirmed, kept[0].body], ['out', 'assistant', 'thomas@example.com', 'ray@example.com', true, planned.body]);
  const listed = (await db.collection('emailLog').where('phone', '==', RAY).get()).docs.map((d) => d.data()); assert.equal(listed.length, 1); assert.deepEqual([listed[0].kind, listed[0].direction, listed[0].gmailId, listed[0].name], ['assistant', 'out', 'gm1', 'Ray Ryan']);
  assert.equal((await prop(id)).status, 'applied');
  const log = JSON.stringify((await db.collection('auditLog').where('action', '==', 'aiProposal').get()).docs.map((d) => d.data())); assert.doesNotMatch(log, /ray@|Ray Ryan|Thanks again for getting in touch/, 'the audit log holds no names, addresses or words');
  // twice is once; the Assistant now counts them as emailed
  const again = await decide(id, 'approve', mailer(g)); assert.equal(again.status, 'applied'); assert.equal(g.sent.length, 1);
  const f = await T.run({ db, nowMs: NOW }, 'find_leads', { stage: 'quoted', emailed: true }); assert.deepEqual(f.customers.map((x) => x.name), ['Ray Ryan']);
});

test('AT APPROVE IT IS CHECKED AGAIN: a customer who wrote since, one who asked not to be contacted, a mailer that is off, and Google refusing or not answering', async () => {
  // they wrote (WhatsApp or email) after it was prepared
  let r = await prepare(), id = r.proposals[0].id, g = gmail();
  await db.doc('conversations/' + RAY).update({ lastInboundAt: ts(NOW + 60e3) });
  let out = await decide(id, 'approve', mailer(g)); assert.equal(out.status, 'stale'); assert.match(out.message, /They wrote to you after this was prepared, so check the chat first/); assert.equal(g.sent.length, 0);
  await db.doc('conversations/' + RAY).update({ lastInboundAt: ts(NOW - 20 * DAY) });
  r = await prepare({}, 'u2'); id = r.proposals[0].id; await db.doc('conversations/' + RAY).update({ emailInboundAt: ts(NOW + 120e3) });
  out = await decide(id, 'approve', mailer(g), 'u2'); assert.equal(out.status, 'stale'); assert.equal(g.sent.length, 0);
  // asked not to be contacted after it was prepared
  await db.doc('conversations/' + RAY).update({ emailInboundAt: ts(NOW - 20 * DAY) });
  r = await prepare({ subject: 'Another check' }, 'u3'); id = r.proposals[0].id; await db.doc('conversations/' + RAY).update({ doNotContact: { on: true } });
  out = await decide(id, 'approve', mailer(g), 'u3'); assert.equal(out.status, 'failed'); assert.match(out.message, /asked not to be contacted/); assert.equal(g.sent.length, 0);
  await db.doc('conversations/' + RAY).update({ doNotContact: { on: false } });
  // email sending switched off: refused, the proposal keeps waiting
  r = await prepare({ subject: 'And again' }, 'u4'); id = r.proposals[0].id;
  await rejects(decide(id, 'approve', mailer(g, { enabled: false }), 'u4'), 'failed-precondition', /Email sending is not switched on/); assert.equal((await prop(id)).status, 'pending');
  // Google refuses: nothing sent, nothing recorded; Google does not answer: not confirmed, recorded as such, never retried by itself
  out = await decide(id, 'approve', mailer(gmail('refused')), 'u4'); assert.equal(out.status, 'failed'); assert.match(out.message, /Nothing was sent/); assert.equal((await db.collection(`conversations/${RAY}/emails`).get()).size, 0);
  r = await prepare({ subject: 'Last one' }, 'u5'); id = r.proposals[0].id; const gu = gmail('unknown');
  out = await decide(id, 'approve', mailer(gu), 'u5'); assert.equal(out.status, 'failed'); assert.match(out.message, /Not confirmed[\s\S]*Sent folder of followups@example\.com/); assert.equal(gu.sent.length, 1);
  assert.deepEqual((await db.collection('emailLog').where('phone', '==', RAY).get()).docs.map((d) => d.data().confirmed), [false], 'listed as not confirmed');
  assert.equal((await decide(id, 'approve', mailer(gu), 'u5')).status, 'failed'); assert.equal(gu.sent.length, 1, 'never sent again by itself');
});

test('WHO MAY DECIDE, AND THE SAME EMAIL TWICE: only the person who asked; a second proposal with the very same words within two minutes is not sent again', async () => {
  const r = await prepare(), id = r.proposals[0].id, g = gmail();
  await rejects(decide(id, 'approve', mailer(g), 'someone-else'), 'permission-denied', /Only the person who asked/);
  assert.equal((await decide(id, 'reject', mailer(g))).status, 'rejected'); assert.equal(g.sent.length, 0);
  const a = await prepare({}, 'u6'); assert.equal((await decide(a.proposals[0].id, 'approve', mailer(g), 'u6')).status, 'applied');
  const b = await prepare({}, 'u7'); const out = await decide(b.proposals[0].id, 'approve', mailer(g), 'u7', NOW + 30e3);
  assert.equal(out.status, 'failed'); assert.match(out.message, /That email was just sent/); assert.equal(g.sent.length, 1);
});
