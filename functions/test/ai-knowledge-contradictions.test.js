// Audit 16 Oct 2026, finding 6: an ANSWER must not make a factual claim that contradicts the published knowledge (or answers what it leaves open), and correct answers must still go through.
// Pure functions, no database: the answer checker (aiKnowledge.checkAnswer) with the owner's starting knowledge, and the receptionist's plan (a blocked answer becomes the holding line and a hand-over, never
// silence). The "must pass" lists include real answers written by the model in the knowledge demo of 15 Oct 2026. Every name and message is made up.
const { test } = require('node:test');
const assert = require('node:assert');
const KN = require('../lib/aiKnowledge');
const S = require('../lib/aiSchedule');
const { SEED } = require('../lib/aiKnowledgeSeed');

const K = KN.compile(KN.clean(SEED), 1);
const check = (t, said = '') => KN.checkAnswer(t, K, { extra: said });
function table(blocked, passes) {
  for (const [t, said] of blocked) { const c = check(t, said); assert.equal(c.ok, false, 'must be blocked: ' + t); }
  for (const [t, said] of passes) { const c = check(t, said); assert.deepEqual(c.reasons, [], 'must pass: ' + t); }
}

test('SHOWROOM: we have none, so no answer may say or imply one; saying we have none passes', () => table(
  [['Yes, we have a showroom in Balbriggan you can visit.'], ["You're welcome to call into our showroom."], ['Our showroom is open Monday to Friday.'], ['We have a small showroom where you can see the doors.']],
  [["We don't have a showroom, the design is done at a free home visit."], ['No, we have no showroom.'], ['There is no showroom, but the team designs everything at a free home visit.'],
    ['We cover Dublin, Meath, Kildare, Louth and Cavan, so Swords is no problem. We don\'t have a showroom, the design is done at a free home visit.']]));

test('PRICING: figures must belong to their topic in the knowledge; a customer\'s figure may be repeated but never agreed with; the visit is free', () => table(
  [['Yes, 7k is plenty.', 'My budget is about 7k, is that enough?'], ['7k should cover it.', 'My budget is about 7k'], ['Yes, a 5% deposit is fine.', 'Can I pay a 5% deposit?'], ['Your deposit is 90%.'],
    ['Kitchens start from €5,000.'], ['The quote is valid for 60 days.'], ['There is a €50 charge for the home visit.'], ["The home visit isn't free."], ['Yes, 12k will cover it no problem.', 'would 12k cover a kitchen?']],
  [['To be honest, most of our kitchens start around €10,000, so 7k would be tight. We can still do a free home visit to see what\'s possible.', 'My budget is about 7k, is that enough?'],
    ['The home visit and design are free, with no obligation. You only pay a 30% deposit once you\'ve accepted the quote, and the balance is paid on completion.'],
    ['A typical full kitchen costs between €10,000 and €20,000, including design, supply, fitting, VAT and a laminate worktop.'], ['The quote is one total price including VAT, valid for 30 days.'],
    ['Yes, there\'s a 30% deposit.', 'is there a 30% deposit?'], ['About 90% of our work is full kitchen renovations.'], ['No, the home visit is free, there\'s no charge for it.'],
    ["We can't give an exact price over chat, as it comes after the free home visit where we look at the layout and measurements."]]));

test('MATERIALS: veneer is not solid wood; laminate is included, stone is extra; the door styles we do are not denied', () => table(
  [['Our doors are solid oak.'], ['Stone worktops are included as standard.'], ['Quartz comes with every kitchen at no extra cost.'], ["The laminate worktop isn't included."], ["We don't do handleless kitchens."], ['Sorry, we don\'t do shaker doors.']],
  [['Yes, a laminate worktop is included. If you\'d like stone (quartz, Dekton or granite) that\'s priced separately on top.'], ['Yes, we do quartz, Dekton and granite. They\'re optional and priced separately, on top of the usual kitchen price.'],
    ['Yes, we do handleless (Gola). We also do shaker / painted, gloss and matt lacquer, and wood / veneer.'], ['It is a wood veneer, not solid oak.'], ['Every kitchen comes with Blum soft-close hinges and Cemux soft-close drawers as standard.']]));

test('SERVICES: what we do not supply or arrange is never claimed; what we do is never denied; the jobs we decline are not accepted; only the areas we cover', () => table(
  [['We supply integrated appliances.'], ['Yes, appliances are included in the price.'], ['We arrange the skip for you.'], ['The old kitchen and skip are all taken care of by us.'], ['We do the electrics and plumbing too.'], ['Tiling is included.'],
    ['Our fitters lay the flooring as well.'], ["We don't do wardrobes, only kitchens."], ["We don't remove the old kitchen."], ['Yes, we can replace just the doors.'], ['Yes, we fit units you bought elsewhere.'], ['Yes, we cover Wexford.'], ['We also work in Galway.']],
  [['No, the appliances are bought by you, but we fit the integrated ones into the units for you.'], ['Yes, we remove the old kitchen as part of the job. You\'d need to arrange a skip yourself though, and we put the old kitchen straight into it.'],
    ['No, electrics and plumbing aren\'t included, but we can recommend trades if you need them.'], ['No, tiling and painting aren\'t included in our quote. Painting is best done after the new kitchen is fitted, so it\'s worth leaving that until then.'],
    ['The price covers design, supply, fitting, VAT and a laminate worktop, and we remove your old kitchen too. Appliances, electrical, plumbing, gas, tiling, flooring, painting and the skip aren\'t included.'],
    ['Yes, we do wardrobes as well as kitchens and utility rooms. Wardrobes can be ordered on their own, without a kitchen.'], ['Sorry, we don\'t take on door-only jobs.'], ['We usually decline worktop-only jobs, but the team can have a look.'],
    ['We cover Dublin, Meath, Kildare, Louth and Cavan.']]));

test('GUARANTEES: only Blum\'s lifetime mechanical guarantee; no other guarantee, warranty or length', () => table(
  [['Blum hardware has a 5 year guarantee.'], ['We give a 10 year warranty on the carcasses.'], ['All our work comes with a 12 month workmanship warranty.'], ['The units are guaranteed for life.']],
  [['The Blum soft-close hinges in every kitchen come with Blum\'s lifetime mechanical guarantee.'], ['Blum hardware carries Blum\'s lifetime mechanical guarantee.']]));

test('CONSULTATIONS: nothing is booked or confirmed by the answer, open items (samples, quote turnaround) are not answered, the visit is free', () => table(
  [['No problem, your consultation is confirmed for Monday.'], ['Great, you\'re booked in for a home visit.'], ['We bring door and worktop samples to the visit.'], ['No, we don\'t bring samples.'], ['You will get the quote a few days after the home visit.'],
    ['The quote usually arrives within 2 days of the visit.']],
  [['The home visit is free and there is no obligation. At the visit, the layout, measurements and budget are discussed.'], ['When you\'re ready to book, one of the team will arrange it with you.'],
    ['I\'ll check whether samples are brought to the visit.']]));

test('REAL ANSWERS FROM THE PAID RUN OF 16 OCT 2026 PASS (one was wrongly blocked before this test: a claim does not run across ", and" into the next one)', () => table([], [
  ['Yes, we do wardrobes as well as kitchens and utility rooms. A laminate worktop is included in the price, and stone like quartz, Dekton or granite is optional and costs extra.'],
  ['No, we don\'t have a showroom. We do the design at a free home visit instead, with no obligation.'], ['No, appliances are bought by you, but we fit the integrated ones into the units for you.'],
  ['To be honest, most of our kitchens start around €10,000, so 7k would be tight. A free home visit would let us see what\'s possible, though.', 'My budget is about 7k, is that enough?'],
  ['It\'s a 30% deposit, paid once you accept the quote. The balance is paid when the kitchen is fitted and finished.'], ['We don\'t have a showroom, the design is done at a free home visit.']]));
// That run's seventh answer ("Blum soft-close hinges and drawers as standard") is wrong since the owner's correction of 16 Oct 2026: it is in the blocked list of ai-knowledge-language.test.js.

test('THE CHECK FOLLOWS THE KNOWLEDGE: when the owner changes an entry, the same answer is judged by the new entry (no deploy)', () => {
  const edit = (id, text) => { const d = JSON.parse(JSON.stringify(SEED)); for (const s of d.sections) for (const e of s.entries) if (e.id === id) e.text = text; return KN.compile(KN.clean(d), 2); };
  const withShowroom = edit('company-showroom', 'We have a showroom in Balbriggan, open by appointment.');
  assert.equal(KN.checkAnswer('Yes, we have a showroom in Balbriggan you can visit.', withShowroom).ok, true, 'now true: allowed');
  assert.equal(KN.checkAnswer("We don't have a showroom.", withShowroom).ok, false, 'now false: blocked');
  const noWardrobes = edit('services-what', 'We do kitchens only.');
  assert.equal(KN.checkAnswer("We don't do wardrobes, only kitchens.", noWardrobes).ok, true, 'nothing approved says we do wardrobes any more');
  // a knowledge with nothing about a topic does not block the topic (the other checks still apply)
  assert.equal(KN.checkAnswer('We have a showroom.', KN.compile(KN.clean({ sections: [{ title: 'Company', entries: [{ kind: 'approved', title: 'Areas', text: 'We cover Dublin.' }] }] }), 1)).ok, true);
});

test('A CONTRADICTING ANSWER IS NEVER SENT: the receptionist sends the holding line and a person takes over (never silence, never the false claim)', () => {
  const said = 'Do you have a showroom I could visit?', messages = [{ direction: 'out', type: 'template', body: '[template: welcome] Hi' }, { direction: 'in', type: 'text', body: said }];
  const kn = { lines: K.lines, check: (x) => KN.checkAnswer(x, K, { extra: said }), linksText: () => '' };
  for (const reply of ['Yes, we have a showroom in Balbriggan you can visit.', 'Yes, our showroom is open on Saturdays.']) {
    const p = S.plan({ decision: { reply, intent: 'asking_info', visit: 'none', hasQuestion: true, answerState: 'answered', change: 'none', special: 'none', topics: ['company-showroom'], links: [], schedule: { preference: null, opener: '' }, handover: { needed: false, reason: null } }, consult: null, messages, booked: false, nowMs: Date.UTC(2026, 9, 13, 10), natural: true, kn });
    assert.equal(p.step, 'holding'); assert.equal(p.reply, K.lines.holding); assert.equal(p.handover.needed, true); assert.doesNotMatch(p.reply, /showroom/i);
  }
});

test('THE STARTING KNOWLEDGE MATCHES THE OWNER\'S CORRECTION (16 Oct 2026): Blum soft-close hinges and Cemux soft-close drawers as standard, Blum drawers an upgrade, the carcasses and their colour', () => {
  const approved = SEED.sections.flatMap((s) => s.entries).filter((e) => e.kind === 'approved'), all = approved.map((e) => e.text).join('\n');
  assert.match(all, /Blum soft-close hinges and Cemux soft-close drawers as standard/); assert.match(all, /Blum drawer systems are an optional upgrade, not standard/);
  assert.match(all, /carcasses are made from melamine-faced furniture board with solid hard backs/); assert.match(all, /standard carcass colour is Robson Oak/);
  for (const e of approved) assert.doesNotMatch(e.text, /Blum soft-close hinges and drawers|premium Blum hardware as standard/i, e.id);
});

test('A NAME THE KNOWLEDGE USES IS NOT A PERSON: "It\'s Robson Oak as standard" is sent; "I\'m Sean" and "Sean here" are still blocked', () => {
  const R = require('../lib/aiReply');
  for (const t of ['It\'s Robson Oak as standard.', 'It\'s Blum soft-close hinges as standard.', 'This is Cemux soft-close as standard.']) assert.deepEqual(R.outgoingCheck(t, { knowledge: K }).reasons, [], t);
  for (const t of ['I\'m Sean from the office.', 'Hi Aoife, Sean here.', 'My name is Mary.']) assert.equal(R.outgoingCheck(t, { knowledge: K }).ok, false, t);
  assert.equal(R.outgoingCheck('It\'s Robson Oak as standard.', { knowledge: null }).ok, false, 'without knowledge there are no known names: still blocked (fails safe)');
});
