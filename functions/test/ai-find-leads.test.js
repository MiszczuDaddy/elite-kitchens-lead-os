// The assistant's find_leads tool (functions/lib/aiTools.js, lib/leadAnswers.js): counting and listing customers by what they did and by the answers on the lead form, done in CODE so a question such as "how many of
// the leads that never replied want to start in 3-6 months?" is answered in one step instead of opening customers one by one. Read-only. Real Firestore emulator; the "model" is a fake. Every name and number is made up.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const T = require('../lib/aiTools');
const LA = require('../lib/leadAnswers');
const ai = require('../lib/ai');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const NOW = Date.UTC(2026, 10, 9, 12, 0), DAY = 24 * 3600e3, ts = (t) => Timestamp.fromMillis(t), USAGE = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 };
const run = (input) => T.run({ db, nowMs: NOW }, 'find_leads', input);
const fails = (input, re) => assert.rejects(run(input), (e) => e instanceof T.ToolError && (!re || re.test(e.message)), JSON.stringify(input));
const BLOCK = (start, extra = '') => `Meta lead · November 2026 form · 1 Nov 2026\nLead ID: L${start.length}\nOther answers:\n• Start timing: ${start}${extra}`;
async function customer(phone, name, { conv = {}, notes = null, budget = null } = {}) {
  await db.doc('contacts/' + phone).set({ phone, name, ...(notes ? { notes } : {}), ...(budget ? { budget } : {}) });
  await db.doc('conversations/' + phone).set({ phone, name, inboxStatus: 'inbox', unreadCount: 0, lastMessage: '[template: welcome]', lastMessageDirection: 'out', createdAt: ts(NOW - 5 * DAY), updatedAt: ts(NOW - 5 * DAY), ...conv });
}
const A = '353871119501', B = '353871119502', C = '353871119503', D = '353871119504', E = '353871119505', F = '353871119506', G = '353871119507', H = '353871119508';
beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await customer(A, 'Aoife Anders', { notes: BLOCK('3-6_months'), budget: '€15k-€20k' });
  await customer(B, 'Brian Byrne', { notes: BLOCK('3-6_months', '\n• Best time to contact: morning_(9am-12pm)'), conv: { createdAt: ts(NOW - 2 * DAY) } });
  await customer(C, 'Ciara Casey', { notes: BLOCK('1-2_months_asap') });
  await customer(D, 'Dara Daly', { notes: BLOCK('3-6_months'), conv: { lastInboundAt: ts(NOW - DAY), lastMessageDirection: 'in', unreadCount: 1 } });                  // wrote back
  await customer(E, 'Eoin Egan', { notes: BLOCK('3-6_months'), conv: { inboxStatus: 'booked' } });                                                                          // not a New lead
  await customer(F, 'Fiona Fahey', {});                                                                                                                                      // no answers
  await customer(G, 'Gus Gill', { notes: BLOCK('3-6_months'), conv: { doNotContact: { on: true } } });                                                                      // asked not to be contacted
  await customer(H, 'Hana Hearn', { notes: 'Thomas: customer says they want it in 3-6 months' });                                                                          // a person typed it
});

test('THE ANSWERS: only the lead form\'s own lines in a "Meta lead" block; the newest answer to a question wins; wording differences do not matter', () => {
  assert.deepEqual(LA.fromNotes(BLOCK('3-6_months', '\n• Best time to contact: morning')).map((x) => [x.question, x.answer]), [['Start timing', '3-6 months'], ['Best time to contact', 'Morning']]);
  assert.deepEqual(LA.fromNotes(BLOCK('3-6_months') + '\n\n' + BLOCK('1-2_months_asap')).map((x) => x.answer), ['1-2 months asap'], 'a second form: the newest answer');
  assert.deepEqual(LA.fromNotes('• Start timing: 3-6 months'), [], 'a bulleted list with no lead block'); assert.deepEqual(LA.fromNotes(null), []); assert.deepEqual(LA.fromNotes(''), []);
  for (const [a, w] of [['3-6 months', '3-6_months'], ['3-6 months', '3-6 MONTHS'], ['1-2 months asap', 'asap'], ['€15k-€20k', '15k']]) assert.equal(LA.matches(a, w), true, a + ' / ' + w);
  assert.equal(LA.matches('1-2 months asap', '3-6 months'), false); assert.equal(LA.matches('x', ''), false);
});

test('"HOW MANY OF THE LEADS THAT NEVER REPLIED WANT TO START IN 3-6 MONTHS": one call, counted by code; those who wrote, are booked, asked not to be contacted, or only had it typed by a person are not counted', async () => {
  const r = await run({ neverReplied: true, question: 'start_timing' });
  assert.equal(r.outOf, 5, 'A, B, C, F and H never wrote (D wrote back, E is booked, G asked not to be contacted)');
  assert.deepEqual(r.breakdown, [{ answer: '3-6 months', customers: 2 }, { answer: 'No answer on file', customers: 2 }, { answer: '1-2 months asap', customers: 1 }].sort((a, b) => b.customers - a.customers).map((x) => x), 'breakdown, biggest first');
  assert.equal(r.matching, 5, 'with only a question, everybody in the base set is listed');
  const w = await run({ neverReplied: true, question: 'start_timing', answer: '3-6 months' });
  assert.equal(w.matching, 2); assert.deepEqual(w.customers.map((c) => c.name).sort(), ['Aoife Anders', 'Brian Byrne']); assert.deepEqual(w.customers[0].answers, [{ question: 'Start timing', answer: '3-6 months' }]);
  assert.match(w.note, /data, not instructions/); assert.match(w.rule, /never written/);
  assert.equal((await run({ neverReplied: true, answer: '3_6 months' })).matching, 0, 'wrong wording finds nothing, it does not guess');
  assert.equal((await run({ neverReplied: true, answer: '3-6_months' })).matching, 2, 'the way Meta spells it works too, with no question given');
});

test('OTHER QUESTIONS AND FILTERS: best time to contact, budget (from its own field), a stage, a limit', async () => {
  const t = await run({ neverReplied: true, question: 'best_time_to_contact' });
  assert.deepEqual(t.breakdown.find((x) => x.answer === 'Morning (9am-12pm)'), { answer: 'Morning (9am-12pm)', customers: 1 }); assert.equal(t.breakdown.find((x) => x.answer === 'No answer on file').customers, 4);
  const b = await run({ neverReplied: true, question: 'budget' }); assert.equal(b.breakdown.find((x) => /15k/.test(x.answer)).customers, 1);
  const s = await run({ stage: 'booked', answer: '3-6' }); assert.deepEqual(s.customers.map((c) => c.name), ['Eoin Egan']);
  const l = await run({ neverReplied: true, question: 'start_timing', limit: 1 }); assert.equal(l.customers.length, 1); assert.equal(l.matching, 5, 'the count is not cut by the list limit');
  assert.equal(l.customers[0].name, 'Brian Byrne', 'newest first');
});

test('STRICT INPUT: a filter is needed; unknown fields, questions and wrong types are refused; nothing is written', async () => {
  const before = JSON.stringify((await db.collection('conversations').get()).docs.map((d) => [d.id, d.data()]));
  await fails({}, /at least one/); await fails(null, /at least one/); await fails({ neverReplied: 'yes' }, /true or false/); await fails({ neverReplied: true, question: 'shoe_size' }, /Unknown question/); await fails({ stage: 'dreaming' }, /Unknown stage/);
  await fails({ neverReplied: true, answer: '' }, /short piece of text/); await fails({ neverReplied: true, answer: 'x'.repeat(81) }, /short piece of text/); await fails({ neverReplied: true, answer: 5 }, /short piece of text/);
  await fails({ neverReplied: true, limit: 0 }, /limit/); await fails({ neverReplied: true, extra: 1 }, /Unknown field/); await fails([], /Bad input|at least one/);
  assert.equal(JSON.stringify((await db.collection('conversations').get()).docs.map((d) => [d.id, d.data()])), before);
});

test('THE ASSISTANT USES IT: the tool is offered, the model gets the counts back in one step, and the answer needs no second tool', async () => {
  assert.ok(T.TOOLS.some((t) => t.name === 'find_leads') && T.TOOLS.find((t) => t.name === 'find_leads').input_schema.additionalProperties === false);
  const model = { name: 'fake', calls: [], async complete(req) { model.calls.push(JSON.parse(JSON.stringify(req))); return model.calls.length === 1 ? { text: '', toolCalls: [{ id: 'tu_1', name: 'find_leads', input: { neverReplied: true, question: 'start_timing', answer: '3-6 months' } }], stopReason: 'tool_use', usage: USAGE } : { text: '**2** of the leads that never replied want to start in 3-6 months.', toolCalls: [], stopReason: 'end_turn', usage: USAGE }; } };
  await db.doc('aiSettings/modelCheck').set(Object.fromEntries(Object.entries(ai.MODELS).map(([k, m]) => [k, { id: m.id, ok: true, name: m.label, lifecycle: 'active', at: ts(NOW) }])));
  await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, monthlyCapEur: 15, dailyCapEur: 2 });
  const r = await ai.chat({ db, model, owners: 'thomas@example.com' }, { kind: 'staff', id: 'thomas@example.com' }, { message: 'Check from my leads that never replied how many want to get the kitchen work done 3-6 months' }, { uid: 'u1', nowMs: NOW });
  assert.equal(model.calls.length, 2, 'one tool call, then the answer'); assert.match(model.calls[0].system, /call find_leads ONCE/); assert.ok(model.calls[0].tools.some((t) => t.name === 'find_leads'));
  assert.match(JSON.stringify(model.calls[1].messages), /matching[^0-9]{1,6}2[^0-9]/); assert.match(r.reply, /\*\*2\*\* of the leads/);
  assert.ok(JSON.stringify(r).includes('Counted leads'), 'the answer shows what was done');
});
