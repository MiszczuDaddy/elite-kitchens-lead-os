// Phase 9 Step C: the AI Knowledge Centre. Real Firestore emulator; the model and WhatsApp are fakes. In customer terms: the receptionist answers what the customer asked from the owner's APPROVED knowledge,
// then the Step A flow goes on exactly as before (the visit is offered once, days are asked only after agreement); what the knowledge does not cover (or an open item, or an answer the checker rejects) gets the
// holding line and a person; the owner can draft, test, publish and roll back without a deploy; only PUBLISHED knowledge reaches customers.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const ai = require('../lib/ai');
const R = require('../lib/aiReply');
const KN = require('../lib/aiKnowledge');
const { SEED } = require('../lib/aiKnowledgeSeed');
const REC = require('../lib/aiReceptionist');
const SCH = require('../lib/aiSchedule');
const store = require('../lib/store');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const OWNERS = 'thomas@example.com', owner = { kind: 'staff', id: OWNERS }, staff = { kind: 'staff', id: 'helper@example.com' };
const NOW = Date.UTC(2026, 9, 13, 10, 0), ts = (ms) => Timestamp.fromMillis(ms), L = SCH.LINES, K = KN.DEFAULT_LINES;
const PH = '353871110071', USAGE = { input: 3000, output: 200, cacheRead: 0, cacheWrite: 0 }, TEMPLATE = 'elite_kitchens_new_lead';
const NOTES = 'Meta lead · Kitchen enquiry\nRequirements: Shaker kitchen with island\nOther answers:\n• Estimated budget: 15-20k';

const decision = (over = {}) => ({ text: '', toolCalls: [{ id: 'd1', name: 'reply_decision', input: { reply: '', intent: 'asking_info', visit: 'none', hasQuestion: true, change: 'none', answerState: 'answered', special: 'none', links: [], topics: [], schedule: { preference: null, opener: '' }, newFacts: [], handover: { needed: false, reason: null }, ...over } }], stopReason: 'tool_use', usage: USAGE });
const spy = (d) => { const m = { calls: [], async complete(args) { m.calls.push(args); return typeof d === 'function' ? d(m.calls.length) : d; } }; return m; };
const checked = () => db.doc('aiSettings/modelCheck').set(Object.fromEntries(Object.entries(ai.MODELS).map(([k, m]) => [k, { id: m.id, ok: true, name: m.label, lifecycle: 'active', at: ts(NOW) }])));
const on = async (extra = {}) => { await checked(); await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, replyAssistant: true, autoReply: true, autoReplySince: ts(NOW - 5 * 3600e3), monthlyCapEur: 15, dailyCapEur: 2, ...extra }); };
const publishSeed = async () => { await KN.importStarter({ db, owners: OWNERS }, owner, {}, { nowMs: NOW }); return KN.publish({ db, owners: OWNERS }, owner, { note: 'start' }, { nowMs: NOW }); };

async function chat(lines = [], { state = 'new', phone = PH, booked = false } = {}) {
  await db.recursiveDelete(db.doc('conversations/' + phone)); await db.collection('appointments').get().then((s) => Promise.all(s.docs.map((d) => d.ref.delete())));
  await db.doc('contacts/' + phone).set({ phone, name: 'Aoife Kavanagh', projectType: 'Kitchen', location: 'Swords', budget: '15-20k', notes: NOTES, source: 'Meta Ads', createdAt: ts(NOW - 4 * 3600e3), metaLead: { leadId: '1', receivedAt: ts(NOW - 4 * 3600e3) } });
  await db.doc('conversations/' + phone).set({ phone, name: 'Aoife Kavanagh', inboxStatus: booked ? 'booked' : 'inbox', createdAt: ts(NOW - 4 * 3600e3), updatedAt: ts(NOW - 3600e3), unreadCount: 0, ...(state === 'offered' ? { consult: { stage: 'offered_visit', asks: 0, offered: true } } : {}) });
  let t = NOW - 3 * 3600e3, n = 0;
  const put = async (dir, body, type = 'text') => { t += 60e3; n++; const id = 'wamid.T' + phone + n; if (dir === 'in') await store.storeInbound(db, { wamid: id, from: phone, type, body, name: 'Aoife Kavanagh', createdAt: new Date(t) }); else { await store.storeOutbound(db, phone, { wamid: id, type, body }); await db.doc(`conversations/${phone}/messages/${id}`).update({ createdAt: ts(t) }); } };
  await put('out', `[template: ${TEMPLATE}] Hi Aoife, thanks for your enquiry with Elite Kitchens...`, 'template');
  if (state === 'offered' || state === 'asked_days') { await put('in', 'Hi, I would like a new kitchen'); await put('out', L.visit_offer); }
  if (state === 'asked_days') { await put('in', 'Yes please'); await put('out', L.ask_next_week); }
  for (const [dir, body] of lines) await put(dir, body);
  if (booked) await db.collection('appointments').add({ phone, status: 'booked', start: ts(NOW + 5 * 24 * 3600e3), end: ts(NOW + 5 * 24 * 3600e3 + 3600e3), title: 'Consultation' });
  return phone;
}
// the receptionist's decision for the customer's last message, as the automatic mode would write it
let seq = 0;
const ask = async (d, { model = spy(d), receptionist = true, phone = PH } = {}) => ({ r: await ai.suggestReply({ db, model, owners: OWNERS }, owner, { phone }, { uid: 'u' + (++seq), nowMs: NOW, receptionist }), model });
const dec = (over, text = 'x') => decision({ reply: text, ...over });

beforeEach(async () => { await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' }); await on(); });

// ====================== the answer checker: context, not keywords ======================
const SAFE = [
  'The home visit is free and there is no obligation.',
  'A typical full kitchen is between €10,000 and €20,000, including design, supply, fitting, VAT and a laminate worktop.',
  'Most of our kitchens range from €10k to €20k.',
  'Blum hardware carries Blum\'s lifetime mechanical guarantee.',
  'I can\'t confirm the carcass warranty yet, I\'ll check with the team.',
  'We don\'t arrange the skip, that\'s up to you, but we remove the old kitchen and it goes into your skip.',
  'We fit the integrated appliances, you buy them.',
  'Fitting typically happens 4 to 6 weeks after the deposit, and a full fit takes 3 to 5 days.',
  'It\'s a wood veneer, not solid oak.',
  'We pay a 30% deposit when you accept the quote, which is valid for 30 days.',
  'Once the team has confirmed a time we\'ll let you know.',
  'You can email us at info@elitekitchens.ie or see elitekitchens.ie.',
  'We cover Dublin, Meath, Kildare, Louth and Cavan.',
  'Four to six weeks for the kitchen to be made, then three to five days to fit it.',
  'The exact price comes after the free home visit, so I\'ll check with the team.',
  'Instagram: instagram.com/elite_kitchens_ie',
  'One of the team will be in touch.',
];
const UNSAFE = [
  ['Your visit is booked for Tuesday at 10.', /booked|day/],
  ['We\'ll be there tomorrow.', /day or date/],
  ['Your appointment is confirmed.', /booked or confirmed/],
  ['A kitchen like that will cost €14,500.', /number/],
  ['We can do 10% off if you sign this week.', /number|discount|percentage/],
  ['It comes with a 10 year carcass warranty.', /guarantee|warranty|number|period/],
  ['We give a 12 month workmanship guarantee.', /guarantee|warranty|number|period/],
  ['That\'s solid oak.', /solid wood/],
  ['We\'re a family-run business.', /who runs/],
  ['We arrange the skip for you.', /arrange or supply/],
  ['We supply the appliances too.', /arrange or supply/],
  ['We handle the plumbing and electrics.', /arrange or supply/],
  ['You\'ll get the quote within 3 days.', /number|period/],
  ['Call us on 01 234 5678.', /phone|number/],
  ['See www.otherkitchens.com for ideas.', /web address/],
  ['Email sales@elite-kitchens.com.', /email/],
  ['It\'s completely free of charge, including the design.', /free/],
  ['I\'m a real person, not a bot.', /claims to be a person/],
  ['We guarantee the finish will last.', /guarantee|promise/],
  ['The price is €10,000 for wardrobes.', /./],
];
test('THE CHECKER: safe statements that contain "free", "confirmed", "guarantee" or "skip" pass; the same words used to promise something are blocked, by context not by keyword', async () => {
  await publishSeed(); const K1 = await KN.loadLive(db);
  for (const s of SAFE) { const c = KN.checkAnswer(s, K1); assert.deepEqual(c.reasons, [], 'should be allowed: ' + s); }
  for (const [s, why] of UNSAFE) { const c = KN.checkAnswer(s, K1); assert.equal(c.ok, false, 'should be blocked: ' + s); assert.match(c.reasons.join(' | '), why, s); }
  assert.deepEqual(KN.checkAnswer('', K1), { ok: true, reasons: [] });
  assert.equal(KN.checkAnswer('word '.repeat(120), K1).ok, false, 'too long for WhatsApp');
  // what is allowed comes from the PUBLISHED knowledge: without the guarantee entry the guarantee sentence is no longer allowed, and a number the owner adds becomes allowed
  const d = KN.clean(SEED); d.sections = d.sections.map((s) => ({ ...s, entries: s.entries.filter((e) => e.id !== 'materials-guarantee') }));
  assert.equal(KN.checkAnswer('Blum hardware carries Blum\'s lifetime mechanical guarantee.', KN.compile(d, 9)).ok, false);
  const d2 = KN.clean(SEED); d2.sections[0].entries.push({ id: 'new1', kind: 'approved', title: 'Wardrobes', text: 'Fitted wardrobes start from €2,500.' });
  assert.equal(KN.checkAnswer('Fitted wardrobes start from €2,500.', KN.compile(d2, 9)).ok, true); assert.equal(KN.checkAnswer('Fitted wardrobes start from €2,500.', K1).ok, false);
  // never and open entries never widen what may be said
  assert.equal(KN.checkAnswer('It has a 10 year carcass warranty.', K1).ok, false);
});

// ====================== the data: clean, compile, seed ======================
test('THE DATA: the starting knowledge is valid and complete; wrong shapes, unknown fields, empty entries and numbers inside the owner\'s lines are refused; open and never entries are labelled for the model', () => {
  const d = KN.clean(SEED); const K1 = KN.compile(d, 3);
  assert.ok(K1.entryCount >= 40); assert.match(K1.text, /APPROVED KNOWLEDGE \(version 3\)/); assert.match(K1.text, /NEVER SAY OR IMPLY:[\s\S]*solid oak/); assert.match(K1.text, /OPEN ITEMS[\s\S]*Carcass warranty[\s\S]*Quote turnaround[\s\S]*Samples/);
  assert.equal(K1.haystack.includes('10 year'), false, 'an open item is only a question: it never becomes something the receptionist may state');
  assert.doesNotMatch(K1.text, /Tomasz|Thomas/, 'the team, not a name'); assert.match(K1.text, /PORTFOLIO LINKS[\s\S]*website[\s\S]*instagram/); assert.doesNotMatch(K1.text.split('PORTFOLIO LINKS')[1].split('CONTACT')[0], /elitekitchens\.ie|instagram\.com/, 'the model is never given the addresses to type');
  assert.equal(d.links.length, 2); assert.equal(d.examples.length, SEED.examples.length); assert.deepEqual(Object.keys(d.lines).sort(), Object.keys(K).sort());
  const bad = (x, m) => assert.throws(() => KN.clean(x), (e) => e.code === 'invalid-argument' && (!m || m.test(e.message)));
  bad(null); bad({ sections: [], extra: 1 }, /Unknown field/); bad({ sections: [{ title: '', entries: [] }] }, /name/); bad({ sections: [{ title: 'A', entries: [{ kind: 'maybe', title: 'x', text: 'y' }] }] }, /Approved/);
  bad({ sections: [{ title: 'A', entries: [{ kind: 'approved', title: 'x', text: '' }] }] }, /needs some text/); bad({ sections: [{ title: 'A', entries: [{ kind: 'approved', title: '', text: 'y' }] }] }, /no title/);
  bad({ lines: { holding: 'Call 01 234 5678' } }, /cannot contain numbers/); bad({ lines: { holding: '' } }, /cannot be empty/); bad({ links: [{ label: 'x', url: 'not a link' }] }, /address/); bad({ contact: { email: 'nope' } }, /email/);
  bad({ sections: [{ title: 'A', entries: Array.from({ length: 40 }, (_, i) => ({ kind: 'approved', title: 't' + i, text: 'y'.repeat(800) })) }] }, /too long|shorten/);
  assert.equal(KN.clean({ sections: [{ title: 'A', entries: [{ kind: 'open', title: 'Is it 10 years?' }] }] }).sections[0].entries[0].text, '', 'an open item needs no text');
  const idd = KN.clean({ sections: [{ title: 'A', entries: [{ id: 'same', kind: 'approved', title: 'x', text: 'y' }, { id: 'same', kind: 'approved', title: 'z', text: 'w' }] }] }); assert.notEqual(idd.sections[0].entries[0].id, idd.sections[0].entries[1].id, 'ids stay unique');
});

// ====================== draft, test, publish, rollback ======================
test('DRAFT, PUBLISH, ROLLBACK: the starting knowledge goes to the draft only; only the owner changes anything; a stale draft is refused; every publish is a version; a rollback publishes an old one again as a new version; the audit log has no content', async () => {
  const deps = { db, owners: OWNERS }, rej = (p, code) => assert.rejects(p, (e) => e.code === code, code);
  assert.equal((await KN.get(deps, owner)).live, null); assert.equal(await KN.loadLive(db), null, 'nothing published: the receptionist behaves as before Step C');
  const g = await KN.admin(deps, owner, { action: 'import' }, { nowMs: NOW }); assert.equal(g.canEdit, true); assert.ok(g.draft.data.sections.length >= 8); assert.equal(g.live, null, 'importing never publishes'); assert.equal(await KN.loadLive(db), null);
  await rej(KN.admin(deps, owner, { action: 'import' }), 'failed-precondition');                                   // never overwrites a draft by accident
  assert.equal((await KN.admin(deps, owner, { action: 'import', replace: true }, { nowMs: NOW })).draft.rev, 2);
  for (const a of ['save', 'import', 'publish', 'rollback', 'reset']) await rej(KN.admin(deps, staff, { action: a, data: g.draft.data, version: 1 }), 'permission-denied');
  assert.equal((await KN.admin(deps, staff, { action: 'get' })).canEdit, false, 'staff may read');
  await rej(KN.admin(deps, owner, { action: 'explode' }), 'invalid-argument'); await rej(KN.admin(deps, owner, { action: 'publish', extra: 1 }), 'invalid-argument');
  // save: a stale revision is refused
  const d1 = (await KN.get(deps, owner)).draft; d1.data.sections[0].entries[0].text = 'Elite Kitchens designs, supplies and fits bespoke kitchens made in Ireland.';
  await rej(KN.admin(deps, owner, { action: 'save', data: d1.data, expectedRev: d1.rev - 1 }), 'failed-precondition');
  const s1 = await KN.admin(deps, owner, { action: 'save', data: d1.data, expectedRev: d1.rev }, { nowMs: NOW + 1 }); assert.equal(s1.draft.rev, d1.rev + 1); assert.equal(s1.live, null, 'saving never publishes');
  await rej(KN.admin(deps, owner, { action: 'publish', expectedRev: d1.rev }), 'failed-precondition');            // the draft moved on since it was looked at
  const p1 = await KN.admin(deps, owner, { action: 'publish', expectedRev: s1.draft.rev, note: 'first' }, { nowMs: NOW + 2 }); assert.equal(p1.live.version, 1); assert.equal(p1.versions.length, 1);
  assert.equal((await KN.loadLive(db)).version, 1);
  // a second version, then a rollback to the first
  const d2 = JSON.parse(JSON.stringify(p1.draft.data)); d2.sections[0].entries[0].text = 'Version two text.'; await KN.admin(deps, owner, { action: 'save', data: d2 }, { nowMs: NOW + 3 });
  const p2 = await KN.admin(deps, owner, { action: 'publish', note: 'second' }, { nowMs: NOW + 4 }); assert.equal(p2.live.version, 2); assert.match((await KN.loadLive(db)).text, /Version two text/);
  const rb = await KN.admin(deps, owner, { action: 'rollback', version: 1 }, { nowMs: NOW + 5 }); assert.equal(rb.live.version, 3, 'a rollback is a new version'); assert.equal(rb.live.note, 'Rolled back to version 1'); assert.doesNotMatch((await KN.loadLive(db)).text, /Version two text/); assert.match((await KN.loadLive(db)).text, /made in Ireland/);
  assert.deepEqual(rb.versions.map((v) => v.version), [3, 2, 1]); await rej(KN.admin(deps, owner, { action: 'rollback', version: 9 }), 'not-found'); await rej(KN.admin(deps, owner, { action: 'rollback', version: 0 }), 'invalid-argument');
  // the draft can be put back to what is live
  assert.equal((await KN.admin(deps, owner, { action: 'reset' }, { nowMs: NOW + 6 })).draft.basedOn, 3);
  const log = (await db.collection('auditLog').where('action', '==', 'aiKnowledge').get()).docs.map((d) => d.data()); assert.ok(log.length >= 8); assert.ok(log.every((l) => l.by === OWNERS));
  assert.equal(JSON.stringify(log).includes('bespoke'), false, 'no knowledge text in the audit log');
  // an empty knowledge cannot be published; a damaged live document is the same as none
  await db.doc('aiKnowledge/draft').set({ data: KN.emptyData(), rev: 99 }); await rej(KN.admin(deps, owner, { action: 'publish' }), 'failed-precondition');
  await db.doc('aiKnowledge/live').update({ data: { sections: 'nonsense' } }); assert.equal(await KN.loadLive(db), null);
});

// ====================== the receptionist uses the knowledge, Step A stays in charge ======================
test('ANSWER FIRST, THEN STEP A: a question is answered from the knowledge and the visit is offered once after it; once offered, a further answer is just the answer; after agreement the days question follows the answer; a general price question still gets the owner\'s own line', async () => {
  await publishSeed(); await chat([['in', 'What deposit do you take?']]);
  const dep = 'We take a 30% deposit once you accept the quote.';
  let { r } = await ask(dec({ topics: ['process-steps'] }, dep));
  assert.equal(r.schedule.step, 'offer_visit'); assert.equal(r.draft, dep + ' ' + L.visit_offer, 'the answer first, then the one offer of a visit'); assert.equal(r.handover.needed, false);
  // already offered: only the answer, never the offer again, and nothing about days
  await chat([['in', 'What deposit do you take?']], { state: 'offered' });
  ({ r } = await ask(dec({}, dep))); assert.equal(r.schedule.step, 'answer'); assert.equal(r.draft, dep); assert.equal(r.handover.needed, false);
  // they agreed (said yes to the offer) and ALSO asked: the answer, then the first days question
  await chat([['in', 'Yes please. And do you charge for the visit?']], { state: 'offered' });
  ({ r } = await ask(dec({ visit: 'agreed' }, 'No, the home visit is free and there is no obligation.'))); assert.equal(r.schedule.step, 'ask_next_week'); assert.equal(r.draft, 'No, the home visit is free and there is no obligation. ' + L.ask_next_week);
  // interest or a question alone is NOT agreement: no days question
  await chat([['in', 'Do you do wardrobes too?']]);
  ({ r } = await ask(dec({}, 'Yes, we do kitchens, wardrobes and utility rooms.'))); assert.doesNotMatch(r.draft, /next week|which day|what day/i); assert.equal(r.schedule.step, 'offer_visit');
  // a plain general price question: the owner's own line, then the offer (the system, not the model)
  await chat([['in', 'how much is a kitchen?']]);
  ({ r } = await ask(decision({ intent: 'asking_price_general', hasQuestion: false, reply: '' }))); assert.equal(r.schedule.step, 'price_offer'); assert.equal(r.draft, L.price_general + ' ' + L.visit_offer);
  // what is included in the price is the model's answer from the knowledge (the amounts are the owner's)
  await chat([['in', 'is the worktop included in the price?']], { state: 'offered' });
  ({ r } = await ask(dec({ topics: ['pricing-guide'] }, 'Yes, a laminate worktop is included. Stone is extra.'))); assert.equal(r.draft, 'Yes, a laminate worktop is included. Stone is extra.'); assert.equal(r.schedule.step, 'answer');
  // a customer who already has a visit booked: the answer only, nothing offered or asked
  await chat([['in', 'do you supply appliances?']], { booked: true });
  ({ r } = await ask(dec({}, 'No, you buy the appliances and we fit the integrated ones.'))); assert.equal(r.draft, 'No, you buy the appliances and we fit the integrated ones.'); assert.equal(r.schedule.step, 'answer');
  // an answer and a preference in one message: the preference is recorded, the answer comes first
  await chat([['in', 'Tuesday works. Is the deposit 30%?']], { state: 'asked_days' });
  ({ r } = await ask(dec({ visit: 'agreed', schedule: { preference: { status: 'available', weeks: 'next', days: ['tuesday'], text: 'Tuesday works' }, opener: '' } }, 'Yes, 30% when you accept the quote.')));
  assert.equal(r.schedule.step, 'acknowledge'); assert.equal(r.draft, 'Yes, 30% when you accept the quote. ' + L.acknowledge); assert.equal(r.schedule.preference.days[0], 'tuesday');
});

test('NEVER A GUESS: a question the knowledge does not answer, an open item, an answer the checker rejects, or a half answer gets the owner\'s holding line and a person; nothing invented is sent', async () => {
  await publishSeed(); const H = K.holding;
  await chat([['in', 'Is there a 10 year warranty on the carcasses?']]);
  let { r } = await ask(dec({ answerState: 'none', unknown: 'carcass warranty', handover: { needed: true, reason: 'open item' } }, ''));
  assert.equal(r.schedule.step, 'holding'); assert.equal(r.draft, H); assert.equal(r.handover.needed, true); assert.match(r.handover.reason, /open item[\s\S]*carcass warranty/);
  // a model that answers an OPEN item anyway is stopped by the checker: the holding line goes, the made-up answer does not
  ({ r } = await ask(dec({ answerState: 'answered' }, 'Yes, the carcass has a 10 year warranty.'))); assert.equal(r.schedule.step, 'holding'); assert.equal(r.draft, H); assert.doesNotMatch(r.draft, /10/);
  const rec = (await db.collection('aiDrafts').get()).docs.map((d) => d.data()).filter((d) => d.blocked && d.blocked.length)[0]; assert.ok(rec, 'the reason was recorded'); assert.match(rec.blocked.join(' '), /guarantee|number/); assert.equal(JSON.stringify(rec).includes('carcass has'), false, 'no words in the record');
  // part answered, part not
  await chat([['in', 'Is the kitchen delivered in a week and do you do wardrobes?']]);
  ({ r } = await ask(dec({ answerState: 'partly', unknown: 'delivery', handover: { needed: true, reason: 'part not covered' } }, 'We do wardrobes too.')));
  assert.equal(r.schedule.step, 'answer_holding'); assert.equal(r.draft, 'We do wardrobes too. ' + K.partly); assert.equal(r.handover.needed, true);
  // a promise of a visit, a made-up price and a discount are all blocked
  for (const bad of ['Your visit is booked for Tuesday morning.', 'That would be about €13,500.', 'I can take 10% off if you sign this week.', 'It\'s solid oak.']) { ({ r } = await ask(dec({}, bad))); assert.equal(r.draft, H, bad); assert.equal(r.schedule.step, 'holding'); }
  // an answer with no structure (the model did not call the tool) is shown as it is, as before
  ({ r } = await ask({ text: 'Plain words', toolCalls: [], stopReason: 'end_turn', usage: USAGE })); assert.equal(r.structured, false);
  // an upset customer is not answered by the knowledge: a person takes it, silently, as before
  await chat([['in', 'My kitchen door fell off, this is terrible']]);
  ({ r } = await ask(dec({ intent: 'complaint', answerState: 'answered' }, 'Sorry to hear that.'))); assert.equal(r.schedule.step, 'complaint'); assert.equal(r.draft, K.complaint); assert.equal(r.handover.needed, true);
});

test('THE OWNER\'S DECISIONS: a request for a person, outside our area, a job we decline and another language each get the owner\'s own line and a person; the model writes none of those lines', async () => {
  await publishSeed();
  const cases = [['Can I speak to someone please?', 'wants_person', 'human', K.human, /asked for a person/], ['Do you do kitchens in Wexford?', 'outside_area', 'outside_area', K.outside_area, /outside/], ['I only need a new worktop fitted', 'declined_job', 'declined_job', K.declined_job, /decline/], ['Hola, quiero una cocina nueva', 'other_language', 'other_language', K.other_language, /English/]];
  for (const [q, special, step, line, why] of cases) {
    await chat([['in', q]]); const { r } = await ask(dec({ special, reply: 'MODEL TEXT THAT MUST NOT BE SENT' }, 'MODEL TEXT THAT MUST NOT BE SENT'));
    assert.equal(r.schedule.step, step, q); assert.equal(r.draft, line, q); assert.doesNotMatch(r.draft, /MODEL TEXT/); assert.equal(r.handover.needed, true); assert.match(r.handover.reason, why);
  }
  assert.equal(R.cleanDecision({ special: 'rm -rf' }).special, 'none');
});

test('LINKS: the model only picks ids; the addresses come from the owner\'s settings, once per chat, and only when the customer asked; a made-up address is blocked', async () => {
  await publishSeed(); await chat([['in', 'Can I see photos of your work?']]);
  let { r } = await ask(dec({ links: ['website', 'instagram', 'nope'], intent: 'asking_info' }, 'Of course.'));
  assert.equal(r.draft, 'Of course.\n' + K.links_intro + ' elitekitchens.ie and instagram.com/elite_kitchens_ie\n' + L.visit_offer); assert.equal(r.schedule.step, 'offer_visit');
  // sent already: not sent again
  await chat([['in', 'Can I see photos of your work?']], { state: 'offered' }); const sent = await store.storeOutbound(db, PH, { wamid: 'wamid.LINKS', type: 'text', body: 'See elitekitchens.ie and instagram.com/elite_kitchens_ie' });
  await db.doc(`conversations/${PH}/messages/wamid.LINKS`).update({ createdAt: ts(NOW - 60e3) }); await store.storeInbound(db, { wamid: 'wamid.IN2', from: PH, type: 'text', body: 'any more photos?', name: 'A', createdAt: new Date(NOW - 30e3) });
  ({ r } = await ask(dec({ links: ['website', 'instagram'] }, 'Those are the best places.'))); assert.equal(r.draft, 'Those are the best places.');
  // the model typing an address of its own is stopped
  await chat([['in', 'photos?']]); ({ r } = await ask(dec({}, 'Have a look at www.example-kitchens.com'))); assert.equal(r.schedule.step, 'holding');
  // the email address is allowed when it is the owner's
  await chat([['in', 'what is your email?']]); ({ r } = await ask(dec({}, 'It\'s info@elitekitchens.ie.'))); assert.match(r.draft, /^It's info@elitekitchens\.ie\./);
});

test('ONLY PUBLISHED KNOWLEDGE REACHES CUSTOMERS: the draft is never used; publishing changes the very next reply without a restart; with nothing published the receptionist behaves exactly as before Step C', async () => {
  await chat([['in', 'What deposit do you take?']]);
  // nothing published: the old prompt (no knowledge) and the old behaviour (a question that needs a person is a silent handover)
  let m = spy(dec({ answerState: null, special: 'none' }, 'We take 30%.')); let { r } = await ask(null, { model: m });
  assert.doesNotMatch(m.calls[0].system, /APPROVED KNOWLEDGE/); assert.equal(r.schedule.step, 'none'); assert.equal(r.handover.needed, true);
  await KN.importStarter({ db, owners: OWNERS }, owner, {}, { nowMs: NOW });                                 // a draft exists, nothing is published
  m = spy(dec({}, 'We take a 30% deposit once you accept the quote.')); ({ r } = await ask(null, { model: m })); assert.doesNotMatch(m.calls[0].system, /APPROVED KNOWLEDGE/, 'a draft never reaches the model');
  await KN.publish({ db, owners: OWNERS }, owner, { note: 'one' }, { nowMs: NOW });
  m = spy(dec({}, 'We take a 30% deposit once you accept the quote.')); ({ r } = await ask(null, { model: m }));
  assert.match(m.calls[0].system, /APPROVED KNOWLEDGE \(version 1\)[\s\S]*30% deposit/); assert.match(m.calls[0].system, /AUTOMATIC MODE[\s\S]*Do NOT push a consultation/); assert.match(m.calls[0].system, /APPROVED KNOWLEDGE MODE/);
  assert.equal(r.schedule.step, 'offer_visit');
  // the owner edits the draft and publishes: the next message uses it at once
  const g = await KN.get({ db, owners: OWNERS }, owner), d = g.draft.data; d.sections[0].entries.push({ id: 'newfact', kind: 'approved', title: 'Opening hours', text: 'We reply to messages between 9 and 5 on weekdays.' });
  await KN.saveDraft({ db, owners: OWNERS }, owner, { data: d, expectedRev: g.draft.rev }, { nowMs: NOW }); m = spy(dec({})); await ask(null, { model: m }); assert.doesNotMatch(m.calls[0].system, /Opening hours/, 'saved but not published');
  await KN.publish({ db, owners: OWNERS }, owner, {}, { nowMs: NOW }); m = spy(dec({})); await ask(null, { model: m }); assert.match(m.calls[0].system, /version 2[\s\S]*Opening hours/);
  const rec = (await db.collection('aiDrafts').get()).docs.map((x) => x.data()).filter((x) => x.knowledgeVersion === 2); assert.ok(rec.length >= 1, 'each draft record says which version was used'); assert.equal(JSON.stringify(rec).includes('Opening hours'), false);
  // staff "Suggest reply" gets the knowledge but not the automatic-mode note, and keeps the model's own wording as the draft with the checker as warnings
  m = spy(dec({ links: ['website'] }, 'Yes, the visit is free.')); ({ r } = await ask(null, { model: m, receptionist: false })); assert.doesNotMatch(m.calls[0].system, /AUTOMATIC MODE: this reply is sent/); assert.match(m.calls[0].system, /APPROVED KNOWLEDGE/);
  assert.equal(r.draft, 'Yes, the visit is free. ' + K.links_intro + ' elitekitchens.ie'); assert.deepEqual(r.warnings, []);
  ({ r } = await ask(dec({}, 'Your visit is booked for Tuesday.'), { receptionist: false })); assert.ok(r.warnings.some((w) => /^check: says a visit is booked/.test(w)), 'unsafe wording is a warning for the person who reads it');
});

test('IN THE REAL FLOW: the receptionist sends the answer, hands over after a holding line, stays silent after an answer that needs nobody, and never answers while a person has taken over', async () => {
  await publishSeed(); const w = { sent: [], async sendText(to, body) { w.sent.push(body); return 'wamid.A' + w.sent.length; } }, push = { events: [], async notify(e) { push.events.push(e); } };
  const run = async (d) => { const m = spy(d), c = await db.doc('conversations/' + PH).get(); await db.doc('conversations/' + PH).update({ receptionist: { on: true, auto: true, at: ts(NOW - 5 * 3600e3), by: 'auto', paused: null, handledMs: 0, count: 0, day: null } });
    return REC.processChat({ db, wa: w, model: m, owners: OWNERS, push, welcomeTemplate: TEMPLATE }, PH, (c.data().lastInboundAt.toMillis()) + 40e3); };
  await chat([['in', 'What deposit do you take?']]); assert.equal(await run(dec({}, 'We take a 30% deposit once you accept the quote.')), 'sent:offer_visit'); assert.equal(w.sent.pop(), 'We take a 30% deposit once you accept the quote. ' + L.visit_offer);
  assert.equal((await db.doc('conversations/' + PH).get()).data().receptionist.paused, null, 'an answer plus an offer does not end the conversation'); assert.equal(push.events.length, 0);
  await chat([['in', 'Is the carcass warranty 10 years?']]); assert.equal(await run(dec({ answerState: 'none', handover: { needed: true, reason: 'open item' } }, '')), 'sent:holding'); assert.equal(w.sent.pop(), K.holding);
  const c = (await db.doc('conversations/' + PH).get()).data(); assert.match(c.receptionist.paused, /^handover: open item/, 'handed over after the holding line'); assert.equal(push.events.length, 1, 'the owner is told');
  // a person has taken over: nothing is answered
  await chat([['in', 'What deposit do you take?'], ['out', 'Hi Aoife, Thomas here, I will ring you.']]); const before = w.sent.length; const r2 = await run(dec({}, 'We take 30%.')); assert.equal(r2, 'staff_replied'); assert.equal(w.sent.length, before);
  // an unsafe answer is never sent: the holding line is (the checker is part of the sending path)
  await chat([['in', 'When will you come?']]); assert.equal(await run(dec({}, 'We will be there tomorrow at 10.')), 'sent:holding'); assert.equal(w.sent.pop(), K.holding);
});

// ====================== the test screen ======================
test('TRY IT: the owner tests questions on the DRAFT (or the live knowledge) with a pretend customer: the real decision is shown, nothing is sent, no chat or draft record is written, the cost counts against the budget; only the owner, one to six at a time', async () => {
  await KN.importStarter({ db, owners: OWNERS }, owner, {}, { nowMs: NOW });
  const m = spy((n) => (n === 1 ? decision({ reply: 'We take a 30% deposit once you accept the quote.', topics: ['process-steps', 'bogus'] }) : decision({ reply: 'Your visit is booked.' })));
  const T = (d, who = owner) => ai.testKnowledge({ db, model: m, owners: OWNERS }, who, d, { uid: 'u1', nowMs: NOW });
  const out = await T({ source: 'draft', cases: [{ text: 'What deposit do you take?' }, { text: 'When are you coming?', mustNot: ['booked'] }] });
  assert.equal(out.source, 'draft'); assert.equal(out.results.length, 2); const [a, b] = out.results;
  assert.equal(a.reply, 'We take a 30% deposit once you accept the quote. ' + L.visit_offer); assert.equal(a.wouldSend, true); assert.equal(a.step, 'offer_visit'); assert.deepEqual(a.topics, [{ id: 'process-steps', title: 'The steps' }, { id: 'bogus', title: null }]); assert.ok(a.costEur > 0);
  assert.equal(b.wouldSend, true); assert.equal(b.step, 'holding'); assert.equal(b.reply, K.holding); assert.ok(b.blocked.length >= 1, 'the checker\'s reasons are shown'); assert.deepEqual(b.failed, [], 'the unsafe words did not reach the reply');
  assert.match(m.calls[0].system, /APPROVED KNOWLEDGE \(version draft\)/);
  // nothing was written about a customer
  assert.equal((await db.collection('aiDrafts').get()).size, 0); assert.equal((await db.collection('conversations').get()).size, 0); assert.equal((await db.collection('appointments').get()).size, 0);
  const usage = (await db.collection('aiUsage').get()).docs.map((d) => d.data()); assert.ok(usage.some((u) => u.costEur > 0), 'the cost is counted');
  // states of the pretend customer
  const m2 = spy(decision({ reply: 'Yes, the home visit is free.', visit: 'agreed' })); const o2 = await ai.testKnowledge({ db, model: m2, owners: OWNERS }, owner, { cases: [{ text: 'yes, and is it free?', state: 'offered' }, { text: 'is it free?', state: 'booked' }] }, { uid: 'u1', nowMs: NOW });
  assert.equal(o2.results[0].step, 'ask_next_week'); assert.equal(o2.results[1].step, 'answer'); assert.equal(o2.results[1].reply, 'Yes, the home visit is free.');
  // rules
  const rej = (p, code) => assert.rejects(p, (e) => e.code === code, code);
  await rej(T({ cases: [{ text: 'x' }] }, staff), 'permission-denied'); await rej(T({ cases: [] }), 'invalid-argument'); await rej(T({ cases: Array(7).fill({ text: 'x' }) }), 'invalid-argument'); await rej(T({ cases: [{ text: '' }] }), 'invalid-argument');
  await rej(T({ source: 'live', cases: [{ text: 'x' }] }), 'failed-precondition');                                // nothing is published
  await db.doc('aiSettings/current').update({ enabled: false }); await rej(T({ cases: [{ text: 'x' }] }), 'failed-precondition');
  await db.doc('aiSettings/current').update({ enabled: true, monthlyCapEur: 0, dailyCapEur: 0 }); await rej(T({ cases: [{ text: 'x' }] }), 'failed-precondition');
});

test('A COMPLAINT: one polite line, then a person takes over at once; no promise to fix anything, no offer, no days, no answer, and the automatic conversation does not continue', async () => {
  const LINE = 'I\'m sorry to hear that. I\'ll pass this on to the team so they can look into it.';
  assert.equal(L.complaint, LINE); assert.equal(K.complaint, LINE);
  assert.doesNotMatch(LINE, /\d|refund|compensat|fix|sort|resolve|today|tomorrow|week|apolog|fault|will be/i, 'it promises nothing');
  // the plan: also with a day in the same message, with a visit already offered, with a booked customer, and with knowledge published
  const base = { reply: 'x', intent: 'complaint', visit: 'none', hasQuestion: true, change: 'none', schedule: { preference: SCH.cleanPreference({ status: 'available', days: ['tuesday'], text: 'come Tuesday' }), opener: '' }, handover: { needed: true, reason: 'upset' } };
  for (const ctx of [{}, { consult: { stage: 'offered_visit', asks: 0, offered: true } }, { booked: true }]) {
    const p = SCH.plan({ decision: base, consult: null, messages: [], booked: false, nowMs: NOW, natural: true, ...ctx });
    assert.deepEqual([p.step, p.reply, p.handover.needed, p.handover.reason, p.preference], ['complaint', LINE, true, 'complaint: upset customer', null]);
  }
  assert.equal(SCH.plan({ decision: base, consult: null, messages: [], booked: false, nowMs: NOW, natural: false }).step, 'none', 'a person reading the draft (Suggest reply) is not sent the line');
  // in the real flow, with nothing published (the behaviour before Step C) and then with knowledge published and the line edited by the owner
  const w = { sent: [], async sendText(to, body) { w.sent.push(body); return 'wamid.C' + w.sent.length; } }, push = { events: [], async notify(e) { push.events.push(e); } };
  const run = async (m) => { const c = await db.doc('conversations/' + PH).get(); await db.doc('conversations/' + PH).update({ receptionist: { on: true, auto: true, at: ts(NOW - 5 * 3600e3), by: 'auto', paused: null, handledMs: 0, count: 0, day: null } });
    return REC.processChat({ db, wa: w, model: m, owners: OWNERS, push, welcomeTemplate: TEMPLATE }, PH, c.data().lastInboundAt.toMillis() + 40e3); };
  await chat([['in', 'The fitter wrecked my floor and nobody will answer me']]);
  assert.equal(await run(spy(dec({ intent: 'complaint', handover: { needed: true, reason: 'upset customer' } }, 'We will fix it tomorrow and refund you'))), 'sent:complaint');
  assert.deepEqual(w.sent, [LINE], 'exactly the owner\'s line: the model\'s own words are never used'); assert.equal(push.events.length, 1, 'the owner is told at once');
  const c1 = (await db.doc('conversations/' + PH).get()).data(); assert.match(c1.receptionist.paused, /^handover: complaint/); assert.equal(c1.consult, undefined, 'no consultation was started');
  // the customer writes again: the receptionist stays out (a person has the chat)
  await store.storeInbound(db, { wamid: 'wamid.C2', from: PH, type: 'text', body: 'hello??', name: 'A', createdAt: new Date(NOW - 20e3) });
  const m2 = spy(dec({})); assert.equal(await REC.processChat({ db, wa: w, model: m2, owners: OWNERS, push, welcomeTemplate: TEMPLATE }, PH, NOW + 60e3), 'paused'); assert.equal(m2.calls.length, 0); assert.equal(w.sent.length, 1);
  // with knowledge published, the owner's edited line is used
  await publishSeed(); const g = await KN.get({ db, owners: OWNERS }, owner), d = g.draft.data; d.lines.complaint = 'Sorry about that. I\'ll pass this to the team now.'; await KN.saveDraft({ db, owners: OWNERS }, owner, { data: d }, { nowMs: NOW }); await KN.publish({ db, owners: OWNERS }, owner, {}, { nowMs: NOW });
  await chat([['in', 'This is a disgrace']]); w.sent.length = 0; assert.equal(await run(spy(dec({ intent: 'complaint', handover: { needed: true, reason: 'upset' } }, ''))), 'sent:complaint'); assert.deepEqual(w.sent, ['Sorry about that. I\'ll pass this to the team now.']);
  // the same rules apply in the Knowledge Centre's test: the line is shown and the answer state is "special"
  const t = await ai.testKnowledge({ db, model: spy(decision({ intent: 'complaint', reply: '', handover: { needed: true, reason: 'upset' } })), owners: OWNERS }, owner, { source: 'live', cases: [{ text: 'My drawer is broken and I am furious' }] }, { uid: 'u9', nowMs: NOW });
  assert.deepEqual([t.results[0].step, t.results[0].reply, t.results[0].handover.needed], ['complaint', 'Sorry about that. I\'ll pass this to the team now.', true]);
  // and the draft is editable but never empty or full of numbers
  assert.throws(() => KN.clean({ lines: { complaint: '' } }), /cannot be empty/); assert.throws(() => KN.clean({ lines: { complaint: 'Refund of 500 euro' } }), /cannot contain numbers/);
});

test('WIRING: two new callables, owner and staff gates in the code; nothing in the knowledge code sends, books or reads a customer', () => {
  const idx = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8'), sh = fs.readFileSync(path.join(__dirname, '../../scripts/deploy-quote-sending.sh'), 'utf8');
  assert.match(idx, /^exports\.aiKnowledge = onCall\(\{\}/m); assert.match(idx, /^exports\.aiKnowledgeTest = onCall\(\{ secrets: \[ANTHROPIC_API_KEY\]/m); assert.match(sh, /^AI_NEW="[^"]*\baiKnowledge aiKnowledgeTest"/m);
  const src = fs.readFileSync(path.join(__dirname, '../lib/aiKnowledge.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/sendText|sendTemplate|storeOutbound|collection\('conversations'\)|collection\('contacts'\)|appointments|messages/.test(src), false);
});

test('A CUSTOMER\'S OWN FIGURE MAY BE REPEATED BACK, nothing else about it is trusted: "7k" is fine in the answer, a price built on it is not', async () => {
  await publishSeed(); await chat([['in', 'My budget is about 7k, is that enough?']]);
  let { r } = await ask(dec({ intent: 'asking_info' }, 'Most of our kitchens start around €10,000, so 7k is a bit under, but we can still have a look at what\'s possible.'));
  assert.equal(r.schedule.step, 'offer_visit'); assert.match(r.draft, /^Most of our kitchens start around €10,000, so 7k is a bit under/);
  ({ r } = await ask(dec({ intent: 'asking_info' }, 'Yes, we can do your kitchen for 7k.'))); assert.equal(r.schedule.step, 'holding', 'a price promise is still blocked');
  assert.equal(KN.checkAnswer('That works out at 8k.', await KN.loadLive(db), { extra: 'about 7k' }).ok, false, 'a figure the customer did not give');
});

test('NO DOUBLE TALK: a "the team will come back" or "here are some photos" the model adds on its own is taken out (the system adds those lines), nothing else is changed; "free visit" is fine when the knowledge says "free home visit"', async () => {
  await publishSeed(); await chat([['in', 'Do you do wardrobes, what do they cost, and can I see photos?']]);
  let { r } = await ask(dec({ answerState: 'partly', links: ['website'], handover: { needed: true, reason: 'wardrobe price' } }, 'Yes, we do fitted wardrobes. The team will come back to you on prices. Here are some of our work.'));
  assert.equal(r.draft, 'Yes, we do fitted wardrobes.\n' + K.links_intro + ' elitekitchens.ie\n' + K.partly);
  await chat([['in', 'photos please']]); ({ r } = await ask(dec({ links: ['website', 'instagram'] }, 'Of course, here\'s a look at some of our work.')));
  assert.equal(r.draft, 'Of course.\n' + K.links_intro + ' elitekitchens.ie and instagram.com/elite_kitchens_ie\n' + L.visit_offer);
  await chat([['in', 'is the visit free?']]); ({ r } = await ask(dec({}, 'Yes, the free visit has no obligation.'))); assert.equal(r.schedule.step, 'offer_visit', 'free visit = free home visit');
  assert.equal(KN.checkAnswer('You get a free design and free delivery.', await KN.loadLive(db)).ok, false);
  await chat([['in', 'what is the price of wardrobes?']]); ({ r } = await ask(dec({ answerState: 'partly' }, 'The team will come back to you on that.'))); assert.equal(r.schedule.step, 'holding', 'nothing left to say but the follow-up: just the holding line');
});
