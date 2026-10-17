// Live test of 17 Oct 2026 (the owner, on the deployed receptionist): a question answered in full still got the owner's "partly" line, "I'll check the rest with the team and get back to you."
// That line is never written by the model: plan() adds it (aiSchedule.js, the answer_holding step) whenever the model's labels say a person is needed (handover.needed) or the question was only partly answered
// (answerState "partly"). These tests replay the owner's exact message with the labels the model gives such a message (a budget question flagged for a person while everything was answered; an "exact cost"
// nobody asked for listed as the open part; the model writing the follow-up sentence itself) and assert: the answer goes alone, nothing is promised that nobody will do, you are still told when the model
// wanted a person, and every factual check is unchanged (a false claim is still blocked; a real open question or a real "how much?" still gets the line). Pure functions, no database, no AI call.
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('../lib/aiSchedule');
const R = require('../lib/aiReply');
const KN = require('../lib/aiKnowledge');
const { SEED } = require('../lib/aiKnowledgeSeed');

const NOW = Date.UTC(2026, 9, 17, 16, 0), L = S.LINES;
const K = KN.compile(KN.clean(SEED), 1);
const out = (body, type = 'text') => ({ direction: 'out', type, body }), inn = (body) => ({ direction: 'in', type: 'text', body });
const WELCOME = out('[template: welcome] Hi Tomek, thanks for your enquiry with Elite Kitchens.', 'template');
const known = [{ field: 'name', label: 'Name', value: 'Tomek Test' }, { field: 'projectType', label: 'Project', value: 'Kitchen' }];
const who = { name: 'Tomek Test', projectType: 'Kitchen' };
const base = { reply: '', intent: 'asking_info', visit: 'none', hasQuestion: true, change: 'none', special: 'none', answerState: 'answered', links: [], topics: [], unknown: '', newFacts: [], ack: 'none', schedule: { preference: null, opener: '' }, handover: { needed: false, reason: null } };
function run(over, messages) {
  const said = messages.filter((m) => m.direction === 'in').map((m) => m.body).join(' ');
  const kn = { lines: K.lines, check: (x) => KN.checkAnswer(x, K, { extra: said }), linksText: () => '' };
  const d = R.cleanDecision({ ...base, ...over, handover: { needed: false, reason: null, ...(over.handover || {}) } });
  const p = S.plan({ decision: d, consult: null, messages, booked: false, nowMs: NOW, natural: true, kn, who });
  const decision = p.step === 'none' ? (p.handover ? { ...d, handover: p.handover } : d) : { ...d, reply: p.reply, handover: p.handover || d.handover };
  const a = R.analyse({ known, messages, window: { state: 'open' }, consult: null, nextAppointment: null }, decision, p, { knowledge: true });
  const send = S.SEND_STEPS.has(p.step) && !!decision.reply && !a.warnings.length;
  // the pause rule of aiReceptionist.processChat: the owner's steps, or an answer the model wanted a person for
  return { step: p.step, sent: send ? decision.reply : '', handover: decision.handover, pause: S.PAUSE_STEPS.has(p.step) || (p.step === 'answer' && !!(decision.handover && decision.handover.needed)) };
}
const LIVE = 'I\'ve a budget of about €12,000. Does that include quartz worktops, Blum drawers and appliances? Also, is there a charge for the home consultation?';
const MSGS = [WELCOME, inn(LIVE)];
// a correct, complete answer from the knowledge (what the owner received before the extra sentence)
const ANSWER = 'A typical full kitchen is between €10,000 and €20,000, including design, supply, fitting, VAT and a laminate worktop, so €12,000 is within that range. Quartz worktops cost extra on top, and our drawers are Cemux soft-close as standard, with Blum drawers an optional upgrade. Appliances aren\'t included, and the home visit is free with no obligation.';
const REST = /check the rest|get back to you|come back to you|be in touch/i;

test('the answer itself passes the factual checks (so the extra sentence was not caused by the checker)', () => {
  const c = KN.checkAnswer(ANSWER, K, { extra: LIVE });
  assert.equal(c.ok, true, c.reasons.join('; '));
});

test('LIVE 17 Oct: everything answered but the model flags the budget question for a person: the answer goes alone, you are still told', () => {
  const r = run({ intent: 'asking_price', reply: ANSWER, answerState: 'answered', topics: ['pricing-guide', 'materials-worktops', 'materials-hardware', 'policy-appliances', 'consult-visit'], handover: { needed: true, reason: 'budget of 12k and price inclusions: team may want to follow up' } }, MSGS);
  assert.ok(r.sent, r.step); assert.ok(!REST.test(r.sent), 'no follow-up promise: ' + r.sent);
  assert.match(r.sent, /quartz/i); assert.match(r.sent, /cemux/i); assert.match(r.sent, /appliances/i); assert.match(r.sent, /free/i);
  assert.ok(r.handover && r.handover.needed && r.pause, 'the owner is still alerted and takes the chat');
});

test('LIVE 17 Oct: the model lists an "exact cost" nobody asked for as the open part: the answer goes alone, you are still told', () => {
  for (const unknown of ['exact cost of quartz worktops and the Blum drawer upgrade', 'whether €12,000 would cover quartz and Blum drawers', 'exact price for their kitchen']) {
    const r = run({ intent: 'asking_price', reply: ANSWER, answerState: 'partly', unknown, handover: { needed: true, reason: 'exact pricing of upgrades not in knowledge' } }, MSGS);
    assert.ok(r.sent && !REST.test(r.sent), `${unknown}: ${r.sent}`);
    assert.ok(r.handover && r.handover.needed && r.pause, unknown + ': the owner is still alerted');
  }
});

test('LIVE 17 Oct: a follow-up promise the model wrote itself (with nothing flagged) is taken out, and you are told, so no promise goes out that nobody knows about', () => {
  const r = run({ reply: ANSWER + ' I\'ll check the rest with the team and get back to you.', answerState: 'answered' }, MSGS);
  assert.ok(r.sent, r.step); assert.ok(!REST.test(r.sent), r.sent); assert.match(r.sent, /home visit is free/i);
  assert.ok(r.handover && r.handover.needed && r.pause, 'the owner is told'); assert.match(r.handover.reason, /get back to them/);
  // an answer with no promise and nothing flagged: sent as it is, nobody bothered
  const plain = run({ reply: ANSWER, answerState: 'answered' }, MSGS);
  assert.equal(plain.sent, ANSWER); assert.ok(!(plain.handover && plain.handover.needed) && !plain.pause);
});

test('UNCHANGED: a false claim in the same answer is still blocked; a real open question and a real "how much?" still get the line', () => {
  // factual safety: Blum drawers said to be standard -> the answer is blocked, the holding line goes and a person takes over
  const bad = run({ reply: 'Yes, €12,000 includes Blum drawers as standard, and quartz is included too.', answerState: 'answered' }, MSGS);
  assert.ok(!/blum drawers as standard|quartz is included/i.test(bad.sent), bad.sent); assert.equal(bad.step, 'holding');
  // a real open question (samples are an OPEN item): the answer, then "I'll check the rest"
  const samples = run({ reply: 'The home visit is free with no obligation.', answerState: 'partly', unknown: 'whether samples are brought to the visit', handover: { needed: true, reason: 'samples' } }, [WELCOME, inn('Is the visit free, and will you bring samples?')]);
  assert.equal(samples.step, 'answer_holding'); assert.match(samples.sent, /check the rest/i);
  // the customer really asked how much: a general answer, then "I'll check the rest", as before
  const howMuch = run({ intent: 'asking_price', reply: 'Quartz worktops cost extra on top of the guide range.', answerState: 'partly', unknown: 'exact cost of quartz worktops', handover: { needed: true, reason: 'exact price' } }, [WELCOME, inn('How much extra would quartz worktops cost?')]);
  assert.equal(howMuch.step, 'answer_holding'); assert.match(howMuch.sent, /check the rest/i);
  // an exact cost nobody asked for, next to a real open question: the line stays
  const mixed = run({ reply: ANSWER, answerState: 'partly', unknown: 'exact cost of quartz, and whether they fit on Saturdays', handover: { needed: true, reason: 'pricing and Saturday fitting' } }, [WELCOME, inn(LIVE + ' Do you fit on Saturdays?')]);
  assert.equal(mixed.step, 'answer_holding'); assert.match(mixed.sent, /check the rest/i);
  // Astra A031 "Would Blum drawers cost extra?": answered, the model named the exact cost as open; the answer goes alone, you are still told
  const a031 = run({ intent: 'asking_price', reply: 'Our drawers are Cemux soft-close as standard, and Blum drawers are an optional upgrade at extra cost.', answerState: 'partly', unknown: 'exact cost of Blum drawer upgrade', handover: { needed: true, reason: 'upgrade pricing' } }, [WELCOME, inn('Would Blum drawers cost extra?')]);
  assert.ok(a031.sent && !REST.test(a031.sent), a031.step + ': ' + a031.sent); assert.ok(a031.handover.needed && a031.pause);
  // a hand-over with no word on what was answered (older model answers) keeps the line, as before
  const unsure = run({ reply: 'Quartz worktops cost extra on top of the guide range.', answerState: null, handover: { needed: true, reason: 'price' } }, [WELCOME, inn('Is quartz included?')]);
  assert.match(unsure.sent, /check the rest/i);
});
