// The 200-conversation audit of 17 Oct 2026 (tools/receptionist-audit/sim200-2026-10-17/REPORT.md), recommendations 1 to 4: every automatic reply to a new lead ends with a next step, the customer's
// latest message reaches the model in full, one greeting per message, and availability is recorded whenever it is given. Pure functions, no database: plan -> analyse -> the send decision (the same rule
// aiReceptionist.processChat uses). Each case is the model's decision as the paid audit run recorded it (out/results.jsonl), so these fail on main 69621b8 and pass with the fix. Every name is made up.
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('../lib/aiSchedule');
const R = require('../lib/aiReply');
const KN = require('../lib/aiKnowledge');
const { SEED } = require('../lib/aiKnowledgeSeed');

const NOW = Date.UTC(2026, 9, 13, 10, 0), L = S.LINES;            // Tuesday 13 Oct 2026, 11:00 in Ireland
const K = KN.compile(KN.clean(SEED), 1);
const out = (body, type = 'text') => ({ direction: 'out', type, body }), inn = (body, type = 'text') => ({ direction: 'in', type, body });
const WELCOME = out('[template: lead_welcome] Hi there, thanks for your enquiry with Elite Kitchens...', 'template');
const base = { reply: '', intent: 'new_enquiry', visit: 'none', hasQuestion: false, change: 'none', special: 'none', answerState: null, ack: 'none', links: [], topics: [], unknown: '', newFacts: [], schedule: { preference: null, opener: '' }, handover: { needed: false, reason: null } };
const knFor = (messages) => { const said = messages.filter((m) => m.direction === 'in').map((m) => m.body).join(' '); return { lines: K.lines, check: (x) => KN.checkAnswer(x, K, { extra: said }), linksText: () => '' }; };
// plan -> analyse -> send decision, exactly as the receptionist does it, with the published knowledge. Returns what the customer would receive ('' = nothing) and the plan.
function run(over, { messages, name = 'Aoife', consult = null, booked = false, nowMs = NOW } = {}) {
  const d = { ...base, ...over, wantsConsultation: ['asked', 'agreed'].includes(over.visit), schedule: { preference: null, opener: '', ...(over.schedule || {}) }, handover: { needed: false, reason: null, ...(over.handover || {}) } };
  const who = { name: name + ' Byrne', projectType: 'Kitchen' };
  const p = S.plan({ decision: d, consult, messages, booked, nowMs, natural: true, kn: knFor(messages), who });
  const decision = p.step === 'none' ? (p.handover ? { ...d, handover: p.handover } : d) : { ...d, reply: p.reply, handover: p.handover || d.handover };
  const sheet = { known: [{ field: 'name', label: 'Name', value: who.name }], messages, window: { state: 'open' }, consult, nextAppointment: booked ? 'Tue 20 Oct, 10:00' : null };
  const a = R.analyse(sheet, decision, p, { knowledge: true, fixed: Object.values(K.lines) });
  const check = decision.reply ? R.outgoingCheck(decision.reply, { knowledge: K, extra: messages.filter((m) => m.direction === 'in').map((m) => m.body).join(' ') }) : { ok: true };
  const send = S.SEND_STEPS.has(p.step) && !!decision.reply && !a.warnings.length && check.ok;
  return { step: p.step, sent: send ? decision.reply : '', plan: p, handover: decision.handover };
}
// what a message DOES, independent of its wording
const offersVisit = (t) => /call out and have a look|have a look at your space/i.test(t || '');
const asksDays = (t) => /\?/.test(t || '') && /\b(any day|which day|what day|day.{0,12}suit|week.{0,15}suit|days or times)\b/i.test(t || '');
const nextStep = (t) => /\?\s*$/.test(t || '');                                   // the message ends with a question the customer can answer
const greetings = (t) => (String(t || '').match(/thanks for getting back to us/gi) || []).length;
const pref = (p) => ({ schedule: { preference: S.cleanPreference(p), opener: '' } });

// ---- recommendation 1: no dead ends ----
test('A06, E07, F11: "hi yes interested", "Interested yes", "Hi, yes", "Yes please" get the greeting AND the offer of a visit (once), never a bare "thanks for getting back to us."', () => {
  const said = [['hi yes interested', 'Orla'], ['Interested yes', 'Frank'], ['Hi, yes', 'Úna'], ['Yes please', 'Leo'], ['yeah still looking', 'Aoife'], ['Yes', 'Aoife'], ['Yep 👍', 'Aoife']];
  for (const [words, name] of said) {
    const r = run({ intent: 'greeting', ack: 'hello' }, { messages: [WELCOME, inn(words)], name });
    assert.equal(r.step, 'offer_visit', words); assert.equal(r.sent, `Hi ${name}, thanks for getting back to us. ${L.visit_offer}`, words);
    assert.equal(asksDays(r.sent), false, 'interest is still not agreement: no question about days'); assert.equal(r.handover.needed, false);
    assert.deepEqual(S.advance(null, r.step, null, NOW), { stage: 'offered_visit', offered: true }, 'the offer is remembered, so it is made only once');
  }
  // F11 goes on: "Ok yeah, lets do it" is now a yes to our offer, and the days question follows
  const after = [WELCOME, inn('Hi, yes'), out('Hi Úna, thanks for getting back to us. ' + L.visit_offer), inn('Ok yeah, lets do it')];
  assert.equal(run({ intent: 'wants_consultation', visit: 'agreed' }, { messages: after, name: 'Úna', consult: { stage: 'offered_visit', offered: true } }).step, 'ask_next_week');
  // and the offer is never made twice: another "yes"-like greeting after the offer needs nothing
  assert.equal(run({ intent: 'greeting', ack: 'thanks' }, { messages: [...after.slice(0, 3), inn('yes great')], consult: { stage: 'offered_visit', offered: true } }).step, 'none');
});

test('a plain "Hi" or "Hello" gets the greeting and one question (the owner\'s line), not the offer; their answer then gets the offer; a "no" gets the decline line', () => {
  for (const words of ['Hi', 'Hello', 'Hiya', 'hi there', 'Good morning', 'ok', '👍']) {
    const r = run({ intent: 'greeting', ack: 'hello' }, { messages: [WELCOME, inn(words)], name: 'Leo' });
    assert.equal(r.step, 'ack_only', words); assert.equal(r.sent, 'Hi Leo, thanks for getting back to us. ' + K.lines.still_looking, words);
    assert.equal(nextStep(r.sent), true, words + ': it ends with a question'); assert.equal(offersVisit(r.sent) || asksDays(r.sent), false, words + ': no pitch to a hello');
  }
  const asked = [WELCOME, inn('Hi'), out('Hi Leo, thanks for getting back to us. ' + K.lines.still_looking)];
  for (const [words, d] of [['yes', { intent: 'greeting', ack: 'thanks' }], ['Yes still looking', { intent: 'answering_questions', ack: 'thanks' }], ['ok', { intent: 'greeting', ack: 'none' }]]) {
    const r = run(d, { messages: [...asked, inn(words)], name: 'Leo' });
    assert.equal(r.step, 'offer_visit', words); assert.equal(offersVisit(r.sent), true, words); assert.equal(asksDays(r.sent), false, words);
  }
  const no = run({ intent: 'other', visit: 'declined' }, { messages: [...asked, inn('No, we went with someone else')], name: 'Leo' });
  assert.deepEqual([no.step, no.sent], ['declined', K.lines.declined]);
  // "Who is this?" (no visit offered yet): who we are, then the same question
  const who = run({ intent: 'other', ack: 'confused' }, { messages: [WELCOME, inn('who is this??')], name: 'Leo' });
  assert.deepEqual([who.step, who.sent], ['ack_only', 'Hi Leo, this is Elite Kitchens following up on your kitchen enquiry. ' + K.lines.still_looking]);
});

test('E07 and A06, the follow-up test: a chat left at the old bare "thanks for getting back to us." recovers: "hello?" gets the question, "yes" or "what happens next?" gets the offer', () => {
  const stalled = [WELCOME, inn('Interested yes'), out('Hi Frank, thanks for getting back to us.')];
  const hello = run({ intent: 'greeting', ack: 'hello' }, { messages: [...stalled, inn('hello?')], name: 'Frank' }); assert.equal(hello.sent, K.lines.still_looking);
  const yes = run({ intent: 'greeting', ack: 'thanks' }, { messages: [...stalled, inn('yes')], name: 'Frank' }); assert.equal(yes.step, 'offer_visit'); assert.equal(offersVisit(yes.sent), true);
  const ans = 'First we call out for a free home visit to look at the space and talk layout and budget. Then you get a quote with one total price including VAT.';
  const next = run({ intent: 'asking_info', hasQuestion: true, answerState: 'answered', topics: ['process-steps', 'consult-visit'], reply: ans }, { messages: [...stalled, inn('Great, so what happens next?')], name: 'Frank' });
  assert.equal(next.step, 'offer_visit'); assert.equal(next.sent, ans + ' ' + L.visit_offer);
});

test('A02: "what happens next?", "how does it work?", "what\'s the process?" are answered AND the visit is offered (once); narrow fact questions (VAT, email, hinges) are still just answered', () => {
  const ans = 'Next is a free home visit, no obligation, where we go through the layout, measurements and budget. Then we send one total price including VAT, valid for 30 days.';
  for (const q of ['Hiya, just wondering what happens next?', 'How does it work?', "What's the process?", 'whats the next step', 'How do we get started?', 'Great, so what happens next?']) {
    const r = run({ intent: 'asking_info', hasQuestion: true, answerState: 'answered', topics: ['process-steps', 'consult-visit'], reply: ans }, { messages: [WELCOME, inn(q)], name: 'Ciara' });
    assert.equal(r.step, 'offer_visit', q); assert.equal(r.sent, ans + ' ' + L.visit_offer, q); assert.equal(asksDays(r.sent), false, q);
  }
  const facts = [['Is VAT included?', 'Yes, the quote is one total price including VAT.'], ['What is your email?', 'You can email us at info@elitekitchens.ie.'], ['What hinges do you use?', 'Every kitchen comes with Blum soft-close hinges as standard.']];
  for (const [q, a] of facts) {
    const r = run({ intent: 'asking_info', hasQuestion: true, answerState: 'answered', reply: a }, { messages: [WELCOME, inn(q)] });
    assert.deepEqual([r.step, r.sent], ['answer', a], q);
  }
  // already offered: the process question is just answered
  const offered = [WELCOME, inn('I want a new kitchen'), out(L.visit_offer)];
  assert.deepEqual(run({ intent: 'asking_info', hasQuestion: true, answerState: 'answered', reply: ans }, { messages: [...offered, inn('what happens next?')], consult: { stage: 'offered_visit', offered: true } }).sent, ans);
});

// ---- recommendation 2: the whole message ----
const H11 = "Hi there, so we moved into this house about 6 years ago and the kitchen was old then, now the doors are hanging off and the worktop has a burn mark from my son, we have 3 kids and a dog and we're all in the kitchen all the time so we need something that will last, my sister got her kitchen done last year by some crowd in Meath and she's not happy, anyway would you do something with a bit more storage and how long would the whole thing take?";
test('H11: a long message reaches the model in full, with the question at its end; older messages stay short; a huge message keeps its beginning and its end', () => {
  const t = R.transcript([WELCOME, inn(H11)]);
  assert.ok(H11.length > 400); assert.match(t, /a bit more storage and how long would the whole thing take\?/, 'the question at the end is not cut off');
  // a burst of two: both in full
  const two = R.transcript([WELCOME, inn(H11), inn('Also, ' + H11)]); assert.equal((two.match(/how long would the whole thing take\?/g) || []).length, 2);
  // an older long message (already answered) is still shortened, so the prompt stays small
  const old = R.transcript([WELCOME, inn(H11), out('Thanks for the details.'), inn('ok')]); assert.doesNotMatch(old, /how long would the whole thing take/);
  // a very long message: capped, but the end (where the question usually is) is kept
  const huge = 'blah '.repeat(2000) + 'so can you fit it before Easter?';
  const th = R.transcript([WELCOME, inn(huge)]); assert.match(th, /can you fit it before Easter\?/); assert.ok(th.length < 2600, 'capped: ' + th.length);
});

// ---- recommendation 3: one greeting ----
test('C10, A20: an answer with the visit offer carries ONE greeting (the code\'s, in front); a model answer that already greets gets none from the code', () => {
  const c10 = run({ intent: 'new_enquiry', hasQuestion: true, answerState: 'answered', ack: 'hello', topics: ['materials-upgrades'], reply: 'Yes, we do. Corner and larder pull-outs are available as upgrades on our kitchens.' }, { messages: [WELCOME, inn('Do you do larder pull outs or corner storage?')], name: 'Megan' });
  assert.equal(c10.sent, 'Hi Megan, thanks for getting back to us. Yes, we do. Corner and larder pull-outs are available as upgrades on our kitchens. ' + L.visit_offer); assert.equal(greetings(c10.sent), 1);
  const ans = 'Next step is a free home visit, no obligation, where we go through the layout, measurements and budget.';
  const a20 = run({ intent: 'new_enquiry', hasQuestion: true, answerState: 'answered', ack: 'hello', reply: ans }, { messages: [WELCOME, inn('Yeah looking for a kitchen. Whats next')], name: 'Tadhg' });
  assert.equal(a20.sent, 'Hi Tadhg, thanks for getting back to us. ' + ans + ' ' + L.visit_offer); assert.equal(greetings(a20.sent), 1);
  for (const ack of ['project', 'details', 'thanks']) assert.equal(run({ intent: 'new_enquiry', hasQuestion: true, answerState: 'answered', ack, reply: ans }, { messages: [WELCOME, inn('Want a kitchen, whats next')] }).sent, ans + ' ' + L.visit_offer, ack + ': no acknowledgement squeezed in between the answer and the offer');
  const greeted = run({ intent: 'new_enquiry', hasQuestion: true, answerState: 'answered', ack: 'hello', reply: 'Hi Megan, yes, corner and larder pull-outs are available as upgrades.' }, { messages: [WELCOME, inn('Do you do larder pull outs?')], name: 'Megan' });
  assert.equal(greeted.sent, 'Hi Megan, yes, corner and larder pull-outs are available as upgrades. ' + L.visit_offer); assert.equal((greeted.sent.match(/\bHi\b/g) || []).length, 1);
  // a greeting with a question: answered, offered, greeted once, no hand-over
  const g = run({ intent: 'greeting', hasQuestion: true, answerState: 'answered', ack: 'hello', reply: ans }, { messages: [WELCOME, inn('Hi! whats next?')], name: 'Megan' });
  assert.equal(g.sent, 'Hi Megan, thanks for getting back to us. ' + ans + ' ' + L.visit_offer); assert.equal(g.handover.needed, false);
});

// ---- recommendation 4: availability is recorded whenever it is given ----
test('E04, E05: "Can someone come out today?" and "tomorrow at 10?" are recorded with the real date and get the owner\'s "straight away" line, not "Good question"', () => {
  const e04 = run({ intent: 'scheduling', visit: 'asked', hasQuestion: true, answerState: 'none', unknown: 'same-day visit availability', handover: { needed: true, reason: 'asks for a same-day visit, needs a person to check availability' }, ...pref({ status: 'available', days: ['tuesday'], text: 'today', weeks: 'this' }) }, { messages: [WELCOME, inn('Can someone come out today?')], name: 'Dermot' });
  assert.deepEqual([e04.step, e04.sent, e04.handover.needed], ['acknowledge', K.lines.soon, true]); assert.doesNotMatch(e04.sent, /good question/i);
  assert.deepEqual([e04.plan.preference.days, e04.plan.preference.firstDate], [['tuesday'], '2026-10-13'], 'today is Tuesday 13 Oct');
  // the model named the wrong weekday for "today": the day comes from the date, not from the model
  const wrong = run({ intent: 'scheduling', visit: 'asked', hasQuestion: true, answerState: 'none', handover: { needed: true, reason: 'same-day' }, ...pref({ status: 'available', days: ['wednesday'], text: 'today', weeks: 'this' }) }, { messages: [WELCOME, inn('Can someone come out today?')] });
  assert.deepEqual([wrong.step, wrong.plan.preference.days, wrong.plan.preference.firstDate], ['acknowledge', ['tuesday'], '2026-10-13']);
  const e05 = run({ intent: 'wants_consultation', visit: 'asked', hasQuestion: true, answerState: 'none', unknown: 'availability for a visit tomorrow at 10', handover: { needed: true, reason: 'asked for specific visit time tomorrow at 10' }, ...pref({ status: 'available', text: 'tomorrow at 10', times: '10am', weeks: 'this' }) }, { messages: [WELCOME, inn('Could someone call out tomorrow at 10?')], name: 'Sharon' });
  assert.deepEqual([e05.step, e05.sent], ['acknowledge', K.lines.soon]); assert.deepEqual([e05.plan.preference.days, e05.plan.preference.times, e05.plan.preference.firstDate, e05.plan.preference.customerWords], [['wednesday'], '10am', '2026-10-14', 'tomorrow at 10']);
  assert.match(e05.handover.reason, /preference/); assert.equal(S.PAUSE_STEPS.has(e05.step), true, 'then the owner takes over, with a push');
  // tomorrow on a Sunday is Monday of next week
  const sun = run({ intent: 'scheduling', visit: 'asked', ...pref({ status: 'available', text: 'tomorrow', weeks: 'this' }) }, { messages: [WELCOME, inn('can you come tomorrow?')], nowMs: Date.UTC(2026, 9, 18, 12, 0) });
  assert.deepEqual([sun.plan.preference.days, sun.plan.preference.firstDate], [['monday'], '2026-10-19']);
  // "not today": no day is made up from it
  const notToday = run({ intent: 'scheduling', visit: 'asked', ...pref({ status: 'available', days: ['friday'], text: 'not today, Friday would suit', weeks: 'this' }) }, { messages: [WELCOME, inn('Not today, Friday would suit')] });
  assert.deepEqual([notToday.step, notToday.sent, notToday.plan.preference.days], ['acknowledge', L.acknowledge, ['friday']]);
});

test('E08: "Do you work weekends? I can only do Saturdays" is recorded (Saturday on the booking card) while a person answers the question', () => {
  const e08 = run({ intent: 'asking_info', hasQuestion: true, answerState: 'none', unknown: 'whether we work weekends or can do Saturdays', handover: { needed: true, reason: 'asks if we work weekends / Saturday availability, not in knowledge' }, ...pref({ status: 'available', days: ['saturday'], text: 'I can only do Saturdays' }) }, { messages: [WELCOME, inn('Do you work weekends? I can only do Saturdays')], name: 'Hazel' });
  assert.deepEqual([e08.step, e08.sent, e08.handover.needed], ['acknowledge', K.lines.holding, true], 'a real question: the holding line, and the preference is kept');
  assert.deepEqual(e08.plan.preference.days, ['saturday']); assert.match(e08.handover.reason, /weekends/);
  assert.equal(S.advance(null, e08.step, e08.plan.preference, NOW).needsBooking, true);
  // without a usable day (or for a booked customer) the question is simply held, as before
  assert.deepEqual(run({ intent: 'asking_info', hasQuestion: true, answerState: 'none', handover: { needed: true, reason: 'q' } }, { messages: [WELCOME, inn('Do you work weekends?')] }).step, 'holding');
  assert.equal(run({ intent: 'asking_info', hasQuestion: true, answerState: 'none', handover: { needed: true, reason: 'q' }, ...pref({ status: 'available', days: ['saturday'], text: 'Saturdays' }) }, { messages: [WELCOME, inn('Do you work Saturdays?')], booked: true }).plan.preference, null);
});

test('I02: a photo captioned "Thursday suits for someone to come out" gets the photo line, a person, AND Thursday on the booking card; so does a request for a person with a day', () => {
  const msgs = [WELCOME, inn('This is the space. Thursday suits for someone to come out', 'image')];
  const i02 = run({ intent: 'wants_consultation', visit: 'asked', handover: { needed: true, reason: 'possible photos/files sent that cannot be seen; visit requested for Thursday' }, ...pref({ status: 'available', days: ['thursday'], text: 'Thursday suits for someone to come out', weeks: 'this' }) }, { messages: msgs, name: 'Andrea' });
  assert.deepEqual([i02.step, i02.sent, i02.handover.needed], ['attachment', K.lines.photo, true]); assert.deepEqual(i02.plan.preference.days, ['thursday']);
  const c = S.advance(null, 'attachment', i02.plan.preference, NOW); assert.deepEqual([c.stage, c.needsBooking, c.preference.days], ['preference_given', true, ['thursday']]);
  assert.equal(S.advance(null, 'attachment', null, NOW), null, 'a photo with no day: nothing to book');
  const person = run({ intent: 'other', special: 'wants_person', ...pref({ status: 'available', days: ['friday'], text: 'Friday morning', times: 'mornings' }) }, { messages: [WELCOME, inn('Can I talk to someone? Friday morning suits')] });
  assert.deepEqual([person.step, person.sent, person.plan.preference.days], ['human', K.lines.human, ['friday']]); assert.equal(S.advance(null, 'human', person.plan.preference, NOW).needsBooking, true);
});

test('the two new lines are the owner\'s to edit (Knowledge Centre), pass every check, and have a default in knowledge published before they existed', () => {
  for (const k of ['still_looking', 'soon']) {
    assert.ok(KN.DEFAULT_LINES[k], k); assert.ok(KN.LINE_LABELS[k], k); assert.equal(KN.DEFAULT_LINES[k], L[k], k + ': the same default without published knowledge');
    assert.deepEqual(R.outgoingCheck(KN.DEFAULT_LINES[k], { knowledge: K }).reasons, [], k); assert.deepEqual(R.lint(L[k], [], new Set()), [], k); assert.doesNotMatch(L[k], /\d|book|confirm/i, k);
  }
  const old = JSON.parse(JSON.stringify(SEED)); old.lines = { holding: KN.DEFAULT_LINES.holding };
  assert.equal(KN.clean(old).lines.still_looking, KN.DEFAULT_LINES.still_looking);
  const d = JSON.parse(JSON.stringify(SEED)); d.lines = { ...KN.DEFAULT_LINES, still_looking: 'Are you still thinking about a new kitchen?', soon: 'Thanks, I\'ll let the team know right away.' };
  const K2 = KN.compile(KN.clean(d), 2), kn2 = { lines: K2.lines, check: (x) => KN.checkAnswer(x, K2), linksText: () => '' }, who = { name: 'Leo Byrne', projectType: 'Kitchen' };
  const p = (o, messages) => S.plan({ decision: { ...base, ...o, schedule: { opener: '', ...(o.schedule || {}) }, handover: { needed: false, reason: null, ...(o.handover || {}) } }, consult: null, messages, booked: false, nowMs: NOW, natural: true, kn: kn2, who });
  assert.equal(p({ intent: 'greeting', ack: 'hello' }, [WELCOME, inn('Hi')]).reply, 'Hi Leo, thanks for getting back to us. Are you still thinking about a new kitchen?');
  assert.equal(p({ intent: 'greeting', ack: 'thanks' }, [WELCOME, inn('Hi'), out('Hi Leo, thanks for getting back to us. Are you still thinking about a new kitchen?'), inn('yes')]).step, 'offer_visit', 'the edited question is recognised');
  assert.equal(p({ intent: 'scheduling', visit: 'asked', schedule: { preference: S.cleanPreference({ status: 'available', text: 'tomorrow', weeks: 'this' }) } }, [WELCOME, inn('Can you come tomorrow?')]).reply, 'Thanks, I\'ll let the team know right away.');
});
