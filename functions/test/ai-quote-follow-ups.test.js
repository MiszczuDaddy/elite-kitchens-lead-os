// Assistant: the quotes that were sent, and the friendly follow-up email about the ones nobody answered for two weeks (find_quotes in functions/lib/aiTools.js; kind quoteFollowUps in
// functions/lib/aiActions.js; the send is lib/quoteFollowUp.js; docs/FOLLOW_UP_EMAIL.md). Real Firestore emulator; Gmail is a fake that records what would be sent; the "model" is a fake.
// What matters: the Assistant knows who got which quote and when, who has not answered for two weeks, and who was already followed up; it only PREPARES the emails (the model supplies no words and no
// list); the preview names every recipient and shows the exact email; nothing is sent until the person who asked presses Approve; the send applies the server's rules again quote by quote (a customer
// who wrote in the meantime is skipped); pressing twice never emails anyone twice; a switch that is off offers nothing. Every name and number is made up.
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
const NOW = Date.UTC(2026, 10, 14, 12, 0), DAY = 24 * 3600e3, ts = (t) => Timestamp.fromMillis(t), USAGE = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 };
const rejects = (p, code, re) => assert.rejects(p, (e) => e.code === code && (!re || re.test(e.message)), `expected ${code}${re ? ' ' + re : ''}`);
const find = (input) => T.run({ db, nowMs: NOW }, 'find_quotes', input);
const fails = (input, re) => assert.rejects(find(input), (e) => e instanceof T.ToolError && (!re || re.test(e.message)), JSON.stringify(input));

function fake(script = [{ text: 'ok' }]) {
  const m = { name: 'fake', calls: [], async complete(req) { m.calls.push(JSON.parse(JSON.stringify(req))); const s = script[Math.min(m.calls.length - 1, script.length - 1)]; return { text: '', toolCalls: [], stopReason: 'end_turn', usage: USAGE, ...s }; } };
  return m;
}
const use = (name, input, id = 'tu_1') => ({ toolCalls: [{ id, name, input }], stopReason: 'tool_use' });
const ask = (input = {}) => use('propose_quote_followup_emails', input);
const checked = () => db.doc('aiSettings/modelCheck').set(Object.fromEntries(Object.entries(ai.MODELS).map(([k, m]) => [k, { id: m.id, ok: true, name: m.label, lifecycle: 'active', at: ts(NOW) }])));
const on = async (extra = {}) => { await checked(); await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, actionsEnabled: true, actionKinds: { customerNote: true, projectUpdate: true, followUpEmails: true, quoteFollowUps: true }, monthlyCapEur: 15, dailyCapEur: 2, ...extra }); };
const chat = (model, data = { message: 'follow up the quotes nobody answered' }, o = {}) => ai.chat({ db, model, owners: OWNERS }, actor, data, { uid: 'u1', nowMs: NOW, ...o });
function gmail(mode = 'ok') { const g = { sent: [], async sendRaw(raw) { g.sent.push(Buffer.from(raw, 'base64url').toString('utf8')); if (mode === 'refused') throw new Gmail.GmailError('rate_limited', 429, true); return { id: 'gm' + g.sent.length, threadId: 'th' + g.sent.length }; } }; return g; }
const mailer = (g, over = {}) => ({ enabled: true, sender: 'followups@example.com', replyTo: 'info@example.com', fromName: 'Elite Kitchens', gmail: g, ...over });
const decide = (id, decision = 'approve', m, uid = 'u1', nowMs = NOW) => ai.decideProposal({ db, mailer: m }, actor, { proposalId: id, decision }, { uid, nowMs });
const prop = async (id) => (await db.doc('aiProposals/' + id).get()).data();
const conv = async (p) => (await db.doc('conversations/' + p).get()).data();
const toOf = (raw) => /^To: (.+)$/m.exec(raw)[1].trim();
const qid = (n) => 'q_' + String(n).padStart(24, '0');

// a customer with a sent quote
async function sentQuote(n, phone, name, email, daysAgo, { quote = {}, conv: c = {}, price = 18000 + n } = {}) {
  const sentAt = NOW - daysAgo * DAY;
  await db.doc('contacts/' + phone).set({ phone, name, ...(email ? { email } : {}) });
  await db.doc('conversations/' + phone).set({ phone, name, inboxStatus: 'quoted', createdAt: ts(NOW - 40 * DAY), updatedAt: ts(sentAt), lastMessageDirection: 'out', unreadCount: 0, ...c });
  await db.doc('quotes/' + qid(n)).set({ phone, ref: 'EK-01' + String(n).padStart(2, '0'), status: 'sent', sentAt: ts(sentAt), customerName: name, summary: { dearest: { incVat: price }, options: [{ key: 'prem', incVat: price }] }, ...quote });
  return sentAt;
}
const OONA = '353871119601', RUAIRI = '353871119602', SADHBH = '353871119603', TADHG = '353871119604', UNA = '353871119605', VINCE = '353871119606', WILL = '353871119607', XENA = '353871119608';
async function seed() {
  await sentQuote(1, OONA, 'Oona Oldwait', 'oona@example.com', 20);                                                                  // 20 days, no answer: ready
  const s2 = NOW - 16 * DAY; await sentQuote(2, RUAIRI, 'Ruairi Replied', 'ruairi@example.com', 16, { conv: { lastInboundAt: ts(s2 + 3600e3) } });          // wrote back after the quote
  const s3 = NOW - 15 * DAY; await sentQuote(3, SADHBH, 'Sadhbh Sent', 'sadhbh@example.com', 15, { conv: { quoteMail: { [qid(3)]: { at: ts(NOW - 2 * DAY), basis: s3, confirmed: true } } } });   // already followed up
  await sentQuote(4, TADHG, 'Tadhg Noemail', null, 20);                                                                              // no address
  await sentQuote(5, UNA, 'Una Underweek', 'una@example.com', 5);                                                                    // only 5 days
  await sentQuote(6, VINCE, 'Vince Accepted', 'vince@example.com', 25, { quote: { status: 'accepted' } });                          // answered: accepted
  await sentQuote(7, WILL, 'Will Wontcontact', 'will@example.com', 30, { conv: { doNotContact: { on: true } } });                   // asked to be left alone
  await sentQuote(8, XENA, 'Xena Resent', 'xena@example.com', 18, { conv: { quoteMail: { [qid(8)]: { at: ts(NOW - 10 * DAY), basis: NOW - 30 * DAY, confirmed: true } } } });   // emailed about an EARLIER sending
  await db.doc('quotes/' + qid(9)).set({ phone: OONA, ref: 'EK-0109', status: 'draft', customerName: 'Oona Oldwait' });          // a draft: never sent
}
beforeEach(async () => { await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' }); await seed(); });

test('FIND_QUOTES: who got which quote and when, how long ago and what happened since, oldest first; the counts say who is ready for the follow-up email', async () => {
  const r = await find({});
  assert.equal(r.status, 'sent'); assert.equal(r.matching, 7, 'every SENT quote that has a sending date (not the accepted one, not the draft)');
  assert.deepEqual(r.quotes.map((x) => x.ref), ['EK-0107', 'EK-0101', 'EK-0104', 'EK-0108', 'EK-0102', 'EK-0103', 'EK-0105'], 'oldest first');
  const by = (ref) => r.quotes.find((x) => x.ref === ref);
  assert.deepEqual([by('EK-0101').customer, by('EK-0101').customerId, by('EK-0101').daysAgo, by('EK-0101').value, by('EK-0101').readyForFollowUp, by('EK-0101').state], ['Oona Oldwait', OONA, 20, 18001, true, 'Not followed up']);
  assert.equal(by('EK-0102').answeredSinceSent, true); assert.equal(by('EK-0102').state, 'They have written back since'); assert.equal(by('EK-0102').readyForFollowUp, false);
  assert.match(by('EK-0103').state, /^Follow-up emailed 12 Nov 2026$/); assert.equal(by('EK-0103').readyForFollowUp, false);
  assert.equal(by('EK-0104').state, 'No email address'); assert.equal(by('EK-0104').hasEmailAddress, false); assert.equal(by('EK-0104').readyForFollowUp, false);
  assert.equal(by('EK-0105').readyForFollowUp, false, 'five days is not two weeks'); assert.equal(by('EK-0107').state, 'Asked not to be contacted'); assert.equal(by('EK-0107').readyForFollowUp, false);
  assert.equal(by('EK-0108').state, 'Not followed up', 'an email about an EARLIER sending of the quote does not count for this one'); assert.equal(by('EK-0108').readyForFollowUp, true);
  assert.deepEqual({ ...r.counts, rule: undefined }, { readyForFollowUp: 2, noAnswerSinceSent: 6, followedUpAlready: 1, noEmailAddress: 1, rule: undefined });
  assert.equal(r.totalValue, 18001 + 18002 + 18003 + 18004 + 18005 + 18007 + 18008);
  assert.ok(r.lines.includes('**Oona Oldwait** · +353 87 111 9601 · EK-0101 · €18,001 · sent 25 Oct 2026 (20 days ago) · Not followed up'), JSON.stringify(r.lines));
  assert.equal(r.lines.length, 7); assert.ok(r.lines.every((l) => /^\*\*.+\*\* · \+353 \d\d \d{3} \d{4} · EK-\d{4} · €[\d,]+ · sent \d+ \w+ \d{4} \(\d+ days? ago\) · /.test(l)));
});

test('FIND_QUOTES: "who has not responded for two weeks", followed up or not, a period, another status, the limit', async () => {
  const two = await find({ olderThanDays: 14, unanswered: true });
  assert.deepEqual(two.quotes.map((x) => x.ref).sort(), ['EK-0101', 'EK-0103', 'EK-0104', 'EK-0107', 'EK-0108'], 'two weeks old and no reply since (Ruairi wrote back; Una is too recent)');
  assert.deepEqual((await find({ olderThanDays: 14, unanswered: true, followedUp: false })).quotes.map((x) => x.ref).sort(), ['EK-0101', 'EK-0104', 'EK-0107', 'EK-0108']);
  assert.deepEqual((await find({ followedUp: true })).quotes.map((x) => x.ref), ['EK-0103']);
  assert.deepEqual((await find({ unanswered: false })).quotes.map((x) => x.ref), ['EK-0102']);
  assert.deepEqual((await find({ sentFrom: '2026-10-28', sentTo: '2026-11-01' })).quotes.map((x) => x.ref), ['EK-0102', 'EK-0103'], 'sent between 28 Oct and 1 Nov');
  assert.deepEqual((await find({ status: 'accepted' })).quotes.map((x) => x.ref), ['EK-0106']);
  assert.equal((await find({ limit: 2 })).quotes.length, 2); assert.equal((await find({ limit: 2 })).matching, 7);
  const exact = await find({ olderThanDays: 15 }); assert.ok(exact.quotes.some((x) => x.ref === 'EK-0103'), 'exactly 15 days counts as at least 15'); assert.ok(!(await find({ olderThanDays: 16 })).quotes.some((x) => x.ref === 'EK-0103'));
});

test('FIND_QUOTES: strict input, read-only, and the assistant is told about it', async () => {
  await fails({ olderThanDays: -1 }, /whole number of days/); await fails({ olderThanDays: 1.5 }, /whole number/); await fails({ olderThanDays: 400 }, /0 to 365/);
  await fails({ unanswered: 'yes' }, /unanswered must be true or false/); await fails({ followedUp: 1 }, /followedUp must be true or false/); await fails({ status: 'nope' }, /Unknown quote status/);
  await fails({ sentFrom: 'last week' }, /sentFrom must be a date/); await fails({ customerId: OONA }, /Unknown field/); await fails({ limit: 0 }, /limit/);
  const before = JSON.stringify((await db.collection('quotes').get()).docs.map((d) => [d.id, d.data()])); await find({}); await find({ olderThanDays: 14 });
  assert.equal(JSON.stringify((await db.collection('quotes').get()).docs.map((d) => [d.id, d.data()])), before, 'looking changes nothing');
  const tool = T.TOOLS.find((t) => t.name === 'find_quotes'); assert.equal(tool.input_schema.additionalProperties, false); assert.match(tool.description, /who has not responded to their quote for 2 weeks/);
  await on(); const m = fake(); await chat(m, { message: 'hi' });
  assert.ok(m.calls[0].tools.some((t) => t.name === 'find_quotes')); assert.match(m.calls[0].system, /call find_quotes once and reply with its lines/);
  // end to end: the model asks, gets the finished lines back in one step
  const m2 = fake([use('find_quotes', { olderThanDays: 14, unanswered: true }), { text: 'Here they are.' }]); const r = await chat(m2, { message: 'who has not responded to their quote for 2 weeks?' }, { uid: 'q1' });
  assert.equal(r.reply, 'Here they are.'); assert.match(JSON.stringify(m2.calls[1]), /Oona Oldwait/);
});

test('SWITCH: the tool exists only when the kind is on (off by default); the model is told to supply nothing; the owner can switch it on', async () => {
  assert.equal((await ai.loadSettings(db)).actionKinds.quoteFollowUps, false); assert.match(A.KINDS.quoteFollowUps, /Follow-up emails about quotes/);
  const offered = async (extra) => { await on(extra); const m = fake(); await chat(m, { message: 'hi' }, { uid: 'x' + Math.random() }); return m.calls[0].tools.map((t) => t.name).filter((n) => n.startsWith('propose_')); };
  assert.ok((await offered({})).includes('propose_quote_followup_emails'));
  assert.ok(!(await offered({ actionKinds: { customerNote: true, projectUpdate: true, followUpEmails: true } })).includes('propose_quote_followup_emails'));
  assert.deepEqual(await offered({ actionsEnabled: false }), []);
  await on(); const m = fake(); await chat(m, { message: 'hi' }, { uid: 'sys' }); assert.deepEqual(m.calls[0].tools.find((t) => t.name === 'propose_quote_followup_emails').input_schema.properties, {});
  const s = await ai.saveSettings({ db, owners: OWNERS }, actor, { actionsEnabled: true, actionKinds: { quoteFollowUps: true } }, { nowMs: NOW }); assert.equal(s.actions.kinds.quoteFollowUps, true);
});

test('PREPARING: lists exactly the quotes that may be followed up, shows the fixed email, sends nothing and changes nothing', async () => {
  await on(); const g = gmail(); const before = JSON.stringify((await db.collection('conversations').get()).docs.map((d) => [d.id, d.data()]));
  const r = await chat(fake([ask(), { text: 'x' }]));
  assert.equal(r.proposals.length, 1); assert.equal(r.proposals[0].title, 'Follow up 2 quotes by email'); assert.match(r.reply, /^Prepared for your approval: Follow up 2 quotes by email\./);
  const p = await prop(r.proposals[0].id);
  assert.equal(p.status, 'pending'); assert.equal(p.kind, 'quoteFollowUps'); assert.equal(p.phone, null); assert.deepEqual(p.payload, { quoteIds: [qid(1), qid(8)] }, 'oldest first: Oona (20 days) and Xena (18 days)');
  const [list, text] = p.preview.rows;
  assert.deepEqual([list.type, list.label], ['list', 'Who gets it (2)']); assert.deepEqual(list.items, ['Oona Oldwait · EK-0101 · sent 25 Oct 2026 · oona@example.com', 'Xena Resent · EK-0108 · sent 27 Oct 2026 · xena@example.com']);
  assert.equal(text.type, 'text'); assert.match(text.label, /Your Elite Kitchens quote \{quote number\}/); assert.equal(text.text, FT.quoteBodyFor({ first: '{first name}', ref: '{quote number}' }));
  assert.match(p.preview.footer, /Nothing is sent before you press Approve/); assert.match(p.preview.footer, /followed up once only/);
  assert.equal(JSON.stringify((await db.collection('conversations').get()).docs.map((d) => [d.id, d.data()])), before, 'preparing changes nothing'); assert.equal(g.sent.length, 0);
});

test('PREPARING: the model cannot add words, names or addresses; and nothing to follow up gives a plain answer and stores nothing', async () => {
  await on();
  for (const input of [{ quoteId: qid(1) }, { body: 'Buy now' }, { to: 'x@y.ie' }, []]) { const r = await chat(fake([ask(input), { text: 'I could not prepare that.' }]), undefined, { uid: 'bad' + Math.random() }); assert.deepEqual(r.proposals, []); }
  assert.equal((await db.collection('aiProposals').get()).size, 0);
  for (const d of (await db.collection('quotes').get()).docs) await d.ref.update({ status: 'accepted' });                         // everybody answered
  const m = fake([ask(), { text: 'Nobody.' }]); const r = await chat(m, undefined, { uid: 'none' });
  assert.deepEqual(r.proposals, []); assert.match(JSON.stringify(m.calls[1]), /no quotes to follow up right now/); assert.equal((await db.collection('aiProposals').get()).size, 0);
});

test('APPROVING: each customer gets the fixed email with their first name and quote number, from the follow-up mailbox; the result lists everyone; the record says they were emailed', async () => {
  await on(); const r = await chat(fake([ask(), { text: 'x' }])), id = r.proposals[0].id, g = gmail();
  const out = await decide(id, 'approve', mailer(g));
  assert.equal(out.status, 'applied'); assert.equal(out.message, '2 emails were sent.'); assert.deepEqual(out.results.map((x) => [x.label, x.ok]), [['Oona Oldwait (EK-0101)', true], ['Xena Resent (EK-0108)', true]]);
  assert.deepEqual(g.sent.map(toOf), ['oona@example.com', 'xena@example.com']);
  for (const [raw, first, ref] of [[g.sent[0], 'Oona', 'EK-0101'], [g.sent[1], 'Xena', 'EK-0108']]) {
    assert.match(raw, /^From: "Elite Kitchens" <followups@example\.com>/m); assert.match(raw, /^Reply-To: info@example\.com/m); assert.match(raw, new RegExp('^Subject: Your Elite Kitchens quote ' + ref, 'm')); assert.ok(raw.includes('Hi ' + first + ',')); assert.ok(raw.includes('(' + ref + ')'));
  }
  const oona = (await conv(OONA)).quoteMail[qid(1)]; assert.deepEqual([oona.confirmed, oona.by, oona.at.toMillis(), oona.basis], [true, 'thomas@example.com', NOW, NOW - 20 * DAY]);
  for (const ph of [RUAIRI, SADHBH, TADHG, UNA, VINCE, WILL]) assert.ok(!(await conv(ph)).quoteMail || ph === SADHBH, 'nobody else was emailed');
  assert.equal((await prop(id)).status, 'applied');
  const log = JSON.stringify((await db.collection('auditLog').where('action', '==', 'aiProposal').get()).docs.map((d) => d.data())); assert.doesNotMatch(log, /oona@|xena@|Oona|Xena/, 'the audit log holds no names or addresses');
  // the quote is now followed up: asking again finds nobody, and the lookup says so
  const again = await find({ olderThanDays: 14, unanswered: true, followedUp: false }); assert.deepEqual(again.quotes.map((x) => x.ref).sort(), ['EK-0104', 'EK-0107']);
});

test('APPROVING TWICE, AND A CUSTOMER WHO WROTE MEANWHILE: nobody is emailed twice; a customer who wrote after the proposal is skipped and the result says why', async () => {
  await on(); const r = await chat(fake([ask(), { text: 'x' }])), id = r.proposals[0].id, g = gmail();
  await db.doc('conversations/' + XENA).update({ lastInboundAt: ts(NOW - 3600e3) });                                              // Xena wrote after the proposal was prepared
  const out = await decide(id, 'approve', mailer(g));
  assert.equal(out.status, 'partial'); assert.equal(out.message, '1 of 2 emails were sent. The others were skipped (see the list).'); assert.deepEqual(out.results.map((x) => x.ok), [true, false]); assert.match(out.results[1].message, /written to you since the quote was sent/);
  assert.deepEqual(g.sent.map(toOf), ['oona@example.com']);
  const again = await decide(id, 'approve', mailer(g)); assert.equal(again.status, 'partial'); assert.equal(g.sent.length, 1, 'a second Approve repeats nothing');
  const [a, b] = await Promise.all([decide(id, 'approve', mailer(g)), decide(id, 'approve', mailer(g))]); assert.equal(g.sent.length, 1); assert.equal(a.status, b.status);
});

test('APPROVING: only the person who asked can decide; switched off or no mailer sends nothing and the proposal waits; Google refusing is reported', async () => {
  await on(); const r = await chat(fake([ask(), { text: 'x' }])), id = r.proposals[0].id, g = gmail();
  await rejects(decide(id, 'approve', mailer(g), 'someone-else'), 'permission-denied', /Only the person who asked/);
  await rejects(decide(id, 'approve', mailer(g, { enabled: false })), 'failed-precondition', /Email sending is not switched on/); assert.equal((await prop(id)).status, 'pending');
  await on({ actionKinds: { customerNote: true, projectUpdate: true, followUpEmails: true, quoteFollowUps: false } }); await rejects(decide(id, 'approve', mailer(g)), 'failed-precondition', /switched off/); assert.equal(g.sent.length, 0);
  await on(); const refused = gmail('refused'); const out = await decide(id, 'approve', mailer(refused)); assert.equal(out.status, 'failed'); assert.equal(out.message, 'No email was sent.'); assert.equal(out.results.every((x) => !x.ok), true);
  const rejected = await chat(fake([ask(), { text: 'x' }]), { message: 'again' }, { uid: 'u2' }); assert.equal((await decide(rejected.proposals[0].id, 'reject', mailer(g), 'u2')).status, 'rejected'); assert.equal(g.sent.length, 0);
});
