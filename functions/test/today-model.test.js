// Phase 11: the rules behind the Today tab (public/today-model.js). Pure functions: no emulator, no browser. Every name is made up.
// What matters: a card appears only for a real reason, goes away by itself the moment that reason is gone and for no other reason, one customer is ONE card, urgency counts only working hours,
// and a lead is never lost because of how many chats there are.
const { test } = require('node:test');
const assert = require('node:assert');
const M = require('../../public/today-model.js');

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR, NOW = Date.UTC(2026, 9, 18, 11, 0);       // Sunday 18 Oct 2026, 12:00 in Ireland
const ts = (t) => ({ toMillis: () => t });
const chat = (id, over = {}) => ({ id, name: 'Customer ' + id.slice(-3), projectType: 'Kitchen', location: 'Swords', inboxStatus: 'inbox', createdAt: ts(NOW - 30 * DAY), lastMessage: 'How much is a kitchen?', lastMessageDirection: 'in', lastInboundAt: ts(NOW - HOUR), unreadCount: 1, ...over });
const P1 = '353871110001', P2 = '353871110002', P3 = '353871110003', P4 = '353871110004';
const build = (over = {}) => M.build({ convs: [], appts: [], quotes: [], reminders: [], marks: {}, leadIssues: [], contactsToday: [], ledger: {}, now: NOW, ...over });
const keys = (r) => r.cards.map((c) => c.key);

test('working time: only 08:00 to 20:00 Irish time counts, across nights and when the clocks change', () => {
  const D = (h, mi = 0, d = 18) => Date.UTC(2026, 9, d, h - 1, mi);                                  // Irish summer time is UTC+1
  assert.equal(M.workMinutes(D(10), D(10, 45)), 45);
  assert.equal(M.workMinutes(D(23), D(8, 30, 19)), 30, 'a message at 23:00 has waited 30 minutes at 08:30');
  assert.equal(M.workMinutes(D(19, 30), D(8, 15, 19)), 30 + 15, 'evening and morning only');
  assert.equal(M.workMinutes(D(7), D(8)), 0); assert.equal(M.workMinutes(D(20), D(23)), 0);
  assert.equal(M.workMinutes(D(8), D(20)), 720); assert.equal(M.workMinutes(D(8, 0, 18), D(20, 0, 19)), 1440, 'two whole working days');
  assert.equal(M.workMinutes(Date.UTC(2026, 9, 25, 7, 0), Date.UTC(2026, 9, 25, 20, 0)), 720, 'the day the clocks go back (25 Oct 2026): still 08:00 to 20:00 local');
  assert.equal(M.workMinutes(NOW, NOW - 5), 0);
  assert.deepEqual([0, 29.9, 30, 119, 120, 900].map(M.urgencyOf), [0, 0, 1, 1, 2, 2]);
});

test('a thank-you needs no reply; a question, a yes or an ok does', () => {
  for (const t of ['Thanks', 'thank you so much!', 'Thanks a million', 'Great, thanks', 'ok thanks', 'cheers', 'Thanks for that 😊', '👍', '🙏']) assert.equal(M.isPleasantry(t), true, t);
  for (const t of ['ok', 'Yes please', 'Thanks, can you send the quote?', 'Thanks but the price is too high', 'Tuesday works', 'Can I move it?', '', 'x'.repeat(80), 'no thanks I have found someone else']) assert.equal(M.isPleasantry(t), false, t);
});

test('the receptionist\'s hand-overs in plain words; a person replying or "do not contact" is not a hand-over', () => {
  assert.equal(M.handoverWhy('handover: price question').text, 'Passed on: price question');
  assert.equal(M.handoverWhy('handover: complaint: upset customer').red, true); assert.equal(M.handoverWhy('handover: complaint: upset customer').stop, undefined);
  assert.deepEqual([M.handoverWhy('customer asked us to stop messaging: do not contact').red, M.handoverWhy('customer asked us to stop messaging: do not contact').stop], [true, true]);
  assert.equal(M.handoverWhy('consultation passed to you').consult, true);
  assert.match(M.handoverWhy('ai failed 3 times').text, /AI could not answer/); assert.match(M.handoverWhy('send not confirmed').text, /could not be sent or confirmed/);
  assert.match(M.handoverWhy('needs a person').text, /not sure/); assert.match(M.handoverWhy('something new').text, /Passed on to you/);
  for (const none of ['a person replied', 'do not contact', '', null, undefined]) assert.equal(M.handoverWhy(none), null, String(none));
});

// ================================================================ replies waiting ==================================
test('REPLY WAITING: the customer wrote last and nobody has answered; amber after 30 working minutes, red after 120; it goes the moment a reply is sent', () => {
  for (const [ago, urgency] of [[10 * MIN, 0], [45 * MIN, 1], [3 * HOUR, 2]]) {
    const r = build({ convs: [chat(P1, { lastInboundAt: ts(NOW - ago) })] });
    assert.deepEqual([r.cards.length, r.cards[0].primary, r.cards[0].urgency], [1, 'reply', urgency], String(ago));
    assert.equal(r.cards[0].reasons[0].text, 'Waiting for your reply');
  }
  assert.equal(build({ convs: [chat(P1, { lastMessageDirection: 'out' })] }).cards.length, 0, 'we answered: gone');
  assert.equal(build({ convs: [chat(P1)] }).counts.reply, 1);
});

test('REPLY WAITING: what is NOT waiting (closed or won customers, a thank-you, too old, "do not contact"), and the receptionist is given 30 working minutes', () => {
  const none = [chat(P1, { inboxStatus: 'closed' }), chat(P2, { inboxStatus: 'won' }), chat(P3, { lastMessage: 'Thanks so much' }), chat(P4, { lastInboundAt: ts(NOW - 61 * DAY) }),
    chat('353871110005', { doNotContact: { on: true } }), chat('353871110006', { lastInboundAt: null })];
  assert.equal(build({ convs: none }).cards.length, 0);
  const rec = (over) => chat(P1, { receptionist: { on: true, paused: null, ...over }, lastInboundAt: ts(NOW - 10 * MIN) });
  assert.equal(build({ convs: [rec()] }).cards.length, 0, 'it is handling a message 10 minutes old');
  const late = build({ convs: [chat(P1, { receptionist: { on: true, paused: null }, lastInboundAt: ts(NOW - 50 * MIN) })] });
  assert.equal(late.cards[0].reasons[0].text, 'The receptionist has not answered yet', 'still unanswered after 50 minutes: a person is told');
  const night = Date.UTC(2026, 9, 18, 21, 30), r = M.build({ convs: [chat(P1, { receptionist: { on: true, paused: null }, lastInboundAt: ts(night) })], now: Date.UTC(2026, 9, 19, 6, 30) });
  assert.equal(r.cards.length, 0, 'a message from the evening waits for the receptionist\'s 07:00 run: not "late" at 07:30');
  assert.equal(build({ convs: [chat(P1, { lastInboundAt: ts(NOW - 25 * HOUR) })] }).cards[0].reasons[0].windowClosed, true);
});

// ================================================================ hand-overs ============================================
const handed = (over = {}, rec = {}) => chat(P1, { lastMessageDirection: 'out', receptionist: { on: true, paused: 'handover: price question', pausedAt: ts(NOW - 3 * HOUR), ...rec }, ...over });
test('HANDOVER: shows the reason, red after 2 working hours (or at once for a complaint); resolved only when a person writes after it; comes back never by itself', () => {
  const r = build({ convs: [handed()] });
  assert.deepEqual([r.cards[0].primary, r.cards[0].reasons[0].text, r.cards[0].urgency], ['handover', 'Passed on: price question', 2]);
  assert.equal(build({ convs: [handed({}, { pausedAt: ts(NOW - 10 * MIN) })] }).cards[0].urgency, 0);
  assert.equal(build({ convs: [handed({}, { paused: 'handover: complaint: upset customer', pausedAt: ts(NOW - MIN) })] }).cards[0].urgency, 2, 'a complaint is red straight away');
  assert.equal(build({ convs: [handed({}, { humanAt: ts(NOW - HOUR) })] }).cards.length, 0, 'a person replied after the hand-over: handled');
  assert.equal(build({ convs: [handed({}, { humanAt: ts(NOW - 5 * HOUR) })] }).cards.length, 1, 'a reply from BEFORE the hand-over does not count');
  assert.equal(build({ convs: [handed({}, { pausedAt: ts(NOW - 15 * DAY) })] }).cards.length, 0, 'older than 14 days');
  for (const paused of ['a person replied', 'do not contact']) assert.equal(build({ convs: [handed({}, { paused })] }).cards.length, 0, paused);
  assert.equal(build({ convs: [handed({ doNotContact: { on: true } })] }).cards.length, 0);
  assert.equal(build({ convs: [handed({}, { notifyFailed: { at: ts(NOW) } })] }).cards[0].reasons[0].alertFailed, true);
});

// ================================================================ visits to book ========================================
const wantsVisit = (over = {}) => chat(P2, { lastMessageDirection: 'out', consult: { needsBooking: true, at: ts(NOW - 3 * HOUR), preference: { summary: 'Tuesday 20 Oct, afternoons', text: 'Tuesday afternoon', firstDate: '2026-10-20', times: 'afternoons' } }, ...over });
test('VISIT TO BOOK: shown with their days until a visit is booked; no card while appointments are still loading; "Not needed" (needsBooking false) clears it', () => {
  const r = build({ convs: [wantsVisit()] });
  assert.deepEqual([r.cards[0].primary, r.cards[0].reasons[0].bookOn, r.cards[0].reasons[0].bookAt], ['booking', '2026-10-20', '14:00']); assert.match(r.cards[0].reasons[0].text, /Tuesday 20 Oct, afternoons/);
  assert.equal(M.build({ convs: [wantsVisit()], appts: null, now: NOW }).cards.length, 0, 'appointments not loaded yet: nothing is shown rather than something wrong');
  assert.equal(build({ convs: [wantsVisit()], appts: [{ id: 'a1', phone: P2, status: 'scheduled', start: ts(NOW + DAY), end: ts(NOW + DAY + HOUR) }] }).cards.length, 0, 'booked: gone');
  assert.equal(build({ convs: [wantsVisit()], appts: [{ id: 'a1', phone: P2, status: 'cancelled', start: ts(NOW + DAY), end: ts(NOW + DAY + HOUR) }] }).cards.length, 1, 'a cancelled visit does not count as booked');
  assert.equal(build({ convs: [wantsVisit({ consult: { needsBooking: false } })] }).cards.length, 0);
  assert.equal(build({ convs: [wantsVisit({ consult: { needsBooking: true, at: ts(NOW - 2 * DAY) } })] }).cards[0].urgency, 2, 'red after a day');
  assert.match(build({ convs: [wantsVisit({ consult: { needsBooking: true, at: ts(NOW - HOUR) } })] }).cards[0].reasons[0].text, /gave no days/);
});

test('ONE CARD PER CUSTOMER: a customer who needs a visit AND was handed over AND wrote last is one card headed by the visit, counted once under each reason', () => {
  const c = wantsVisit({ lastMessageDirection: 'in', lastInboundAt: ts(NOW - 3 * HOUR), receptionist: { on: true, paused: 'consultation passed to you', pausedAt: ts(NOW - 3 * HOUR) } });
  const r = build({ convs: [c] });
  assert.equal(r.cards.length, 1); assert.deepEqual(r.cards[0].reasons.map((x) => x.type), ['booking', 'handover', 'reply']); assert.equal(r.cards[0].primary, 'booking');
  assert.deepEqual([r.counts.booking, r.counts.handover, r.counts.reply, r.counts.quote], [1, 1, 1, 0]); assert.equal(r.cards[0].urgency, 2);
  const booked = build({ convs: [c], appts: [{ id: 'a1', phone: P2, status: 'scheduled', start: ts(NOW + DAY), end: ts(NOW + DAY + HOUR) }] });
  assert.deepEqual(booked.cards[0].reasons.map((x) => x.type), ['reply'], 'booking the visit also settles the "consultation passed to you" hand-over; the unanswered message remains');
});

// ================================================================ quotes ================================================
const q = (id, daysAgo, over = {}) => ({ id, phone: P3, ref: 'EK-0112', status: 'sent', customerName: 'Quote Customer', sentAt: ts(NOW - daysAgo * DAY), validUntil: '2026-12-01', summary: { dearest: { incVat: 14500 } }, ...over });
test('QUOTE FOLLOW-UP: from 5 days (amber), 10 days (red); an accepted, declined or draft quote is never listed; old than 60 days is not listed', () => {
  assert.equal(build({ quotes: [q('q_a', 4)] }).cards.length, 0);
  assert.deepEqual([build({ quotes: [q('q_a', 5)] }).cards[0].urgency, build({ quotes: [q('q_a', 9)] }).cards[0].urgency, build({ quotes: [q('q_a', 10)] }).cards[0].urgency], [1, 1, 2]);
  const c = build({ quotes: [q('q_a', 6)] }).cards[0];
  assert.deepEqual([c.kind, c.quoteId, c.ref, c.price, c.name, c.reasons[0].text], ['quote', 'q_a', 'EK-0112', 14500, 'Quote Customer', 'Sent 6 days ago, no answer']);
  for (const status of ['accepted', 'declined', 'draft']) assert.equal(build({ quotes: [q('q_a', 8, { status })] }).cards.length, 0, status);
  assert.equal(build({ quotes: [q('q_a', 61)] }).cards.length, 0);
  assert.match(build({ quotes: [q('q_a', 6, { validUntil: '2026-10-01' })] }).cards[0].reasons[0].text, /\(expired\)/);
});

test('QUOTE SNOOZE: hides only THIS send of the quote, only until the date; a re-sent quote (new sent date) and an expired snooze bring it back', () => {
  const sent = NOW - 8 * DAY, mark = (over) => ({ [M.quoteKey('q_a')]: { basis: sent, snoozeUntil: ts(NOW + DAY), at: ts(NOW - HOUR), ...over } });
  assert.equal(build({ quotes: [q('q_a', 8)], marks: mark() }).cards.length, 0, 'snoozed');
  assert.equal(build({ quotes: [q('q_a', 8)], marks: mark({ snoozeUntil: ts(NOW - MIN) }) }).cards.length, 1, 'snooze ended');
  assert.equal(build({ quotes: [q('q_a', 8)], marks: mark({ basis: sent - 1000 }) }).cards.length, 1, 'the quote was sent again since: back');
  assert.equal(build({ quotes: [q('q_a', 8)], marks: { [M.quoteKey('q_b')]: { basis: sent, snoozeUntil: ts(NOW + DAY) } } }).cards.length, 1, 'another quote\'s snooze does not hide this one');
  const r = build({ quotes: [q('q_a', 8)], marks: mark() });
  assert.deepEqual(r.doneToday.map((d) => [d.kind, d.id]), [['quote', 'q_a']], 'shown under "Done today", where it can be undone');
});

// ================================================================ reminders =============================================
const rem = (id, dueDate, over = {}) => ({ id, title: 'Ring Mr Doyle', phone: P4, customerName: 'Mr Doyle', dueDate, dueTime: null, status: 'open', ...over });
test('REMINDERS: due today is normal; overdue is red when it was an earlier day', () => {
  assert.deepEqual([build({ reminders: [rem('r1', '2026-10-18')] }).cards[0].urgency, build({ reminders: [rem('r1', '2026-10-17')] }).cards[0].urgency], [0, 2]);
});
test('REMINDERS: the time of day decides overdue today', () => {
  assert.equal(build({ reminders: [rem('r1', '2026-10-18', { dueTime: '11:00' })] }).cards[0].urgency, 2, '11:00 has passed at 12:00');
  assert.equal(build({ reminders: [rem('r1', '2026-10-18', { dueTime: '16:00' })] }).cards[0].urgency, 0);
  const r = build({ reminders: [rem('r1', '2026-10-20'), rem('r2', '2026-10-19', { title: 'Sooner' })] });
  assert.equal(r.cards.length, 0); assert.deepEqual(r.later.map((x) => x.reminderId), ['r2', 'r1'], 'coming up, soonest first');
  const done = build({ reminders: [rem('r1', '2026-10-18', { status: 'done', doneAt: ts(NOW - HOUR) }), rem('r2', '2026-10-10', { status: 'done', doneAt: ts(NOW - 3 * DAY) })] });
  assert.equal(done.cards.length, 0); assert.deepEqual(done.doneToday.map((d) => d.id), ['r1'], 'only today\'s Done is listed');
  const c = build({ reminders: [rem('r1', '2026-10-18')] }).cards[0];
  assert.deepEqual([c.kind, c.title, c.name, c.phone, c.dueDate], ['reminder', 'Ring Mr Doyle', 'Mr Doyle', P4, '2026-10-18']);
});

// ================================================================ rejected leads ========================================
test('REJECTED LEADS (Phase 10): an open one is a red card with its details; a closed one is gone', () => {
  const li = (status) => ({ id: 'L1', leadId: 'L1', status, name: 'Ciaran Coyle', email: 'c@example.com', phoneTyped: '087 12', reasonText: 'Bad number', receivedAt: ts(NOW - 2 * HOUR) });
  const c = build({ leadIssues: [li('open')] }).cards[0];
  assert.deepEqual([c.kind, c.primary, c.urgency, c.name, c.phoneTyped], ['lead', 'leadfix', 2, 'Ciaran Coyle', '087 12']);
  for (const s of ['added', 'dismissed']) assert.equal(build({ leadIssues: [li(s)] }).cards.length, 0, s);
});

// ================================================================ new leads today =======================================
const today = M.dayStart(NOW);
const ml = (leadId, at = NOW - 2 * HOUR) => ({ leadId, receivedAt: ts(at) });
const lead = (id, over = {}) => chat(id, { createdAt: ts(NOW - 2 * HOUR), lastMessage: 'Hi Aoife, thanks for your enquiry', lastMessageDirection: 'out', lastInboundAt: null, unreadCount: 0, receptionist: { on: true, paused: null, auto: true }, ...over });
const ct = (id, leadId, at) => ({ id, name: 'N', metaLead: ml(leadId, at) });
test('NEW LEADS TODAY: every lead that arrived today with ONE status: contact failed, needs you, AI handling, contacted', () => {
  const convs = [
    lead('353870000001'),                                                                                                              // welcome sent, receptionist on: AI handling
    lead('353870000002', { receptionist: { on: false } }),                                                                            // welcome sent, nobody on it: contacted
    lead('353870000003', { receptionist: { on: true, paused: 'handover: price question', pausedAt: ts(NOW - HOUR) } }),                // handed over
    lead('353870000004'),                                                                                                              // welcome failed
    lead('353870000005', { lastMessageDirection: 'in', lastInboundAt: ts(NOW - 2 * HOUR), receptionist: { on: false } }),              // wrote, nobody answered
    chat('353870000006', { createdAt: ts(NOW - HOUR), lastMessage: null, lastMessageDirection: null, lastInboundAt: null, receptionist: null }),   // added by hand, nothing sent
    lead('353870000007', { createdAt: ts(NOW - 20 * DAY) }),                                                                           // an OLD customer who filled the form again today
  ];
  const contacts = [ct('353870000001', 'L1'), ct('353870000002', 'L2'), ct('353870000003', 'L3'), ct('353870000004', 'L4'), ct('353870000005', 'L5'), ct('353870000007', 'L7')];
  const ledger = { L1: { welcome: { state: 'sent' } }, L2: { welcome: { state: 'sent' } }, L3: { welcome: { state: 'sent' } }, L4: { welcome: { state: 'failed' } }, L5: { welcome: { state: 'sent' } }, L7: { welcome: { state: 'skipped_recent' } } };
  const r = build({ convs, contactsToday: contacts, ledger }).newLeads, by = (p) => r.items.find((i) => i.phone === p);
  assert.deepEqual(r.items.map((i) => i.status), ['failed', 'needs', 'needs', 'needs', 'ai', 'ai', 'contacted'].sort((a, b) => ['failed', 'needs', 'ai', 'contacted'].indexOf(a) - ['failed', 'needs', 'ai', 'contacted'].indexOf(b)));
  assert.deepEqual([by('353870000001').status, by('353870000002').status, by('353870000003').status, by('353870000004').status, by('353870000005').status, by('353870000006').status, by('353870000007').status],
    ['ai', 'contacted', 'needs', 'failed', 'needs', 'needs', 'ai']);
  assert.equal(by('353870000004').text, 'The welcome message was refused'); assert.equal(by('353870000003').text, 'Passed on: price question'); assert.equal(by('353870000006').text, 'No message has been sent to them yet');
  assert.deepEqual(r.counts, { failed: 1, needs: 3, ai: 2, contacted: 1 }); assert.equal(r.total, 7);
});

test('NEW LEADS TODAY: only today (yesterday\'s lead is not listed); a failed welcome is settled once a person or the customer has been in touch; a lead with a bad number is listed too', () => {
  const y = lead('353870000010', { createdAt: ts(today - HOUR) });
  assert.equal(build({ convs: [y] }).newLeads.total, 0, 'created before midnight Irish time');
  const failed = (over) => build({ convs: [lead('353870000011', over)], contactsToday: [ct('353870000011', 'L1')], ledger: { L1: { welcome: { state: 'unknown' } } } }).newLeads.items[0];
  assert.equal(failed({}).status, 'failed'); assert.match(failed({}).text, /Could not confirm/);
  assert.equal(failed({ receptionist: { on: true, humanAt: ts(NOW - MIN) } }).status, 'ai', 'a person wrote since: no longer a failure');
  assert.equal(failed({ lastMessageDirection: 'in', lastInboundAt: ts(NOW - MIN), receptionist: { on: false } }).status, 'needs', 'the customer wrote since: they need an answer');
  const bad = build({ leadIssues: [{ id: 'L9', leadId: 'L9', status: 'open', name: 'Ciaran', reasonText: 'Bad number', receivedAt: ts(NOW - HOUR) }, { id: 'L8', leadId: 'L8', status: 'open', name: 'Old', receivedAt: ts(NOW - 2 * DAY) }] }).newLeads;
  assert.deepEqual(bad.items.map((i) => [i.leadId, i.status]), [['L9', 'needs']]); assert.match(bad.items[0].text, /Could not be added/);
  const dnc = build({ convs: [lead('353870000012', { doNotContact: { on: true } })], contactsToday: [ct('353870000012', 'L1')], ledger: { L1: { welcome: { state: 'blocked' } } } }).newLeads.items[0];
  assert.deepEqual([dnc.status, dnc.text], ['needs', 'Asked not to be contacted']);
});

test('NOT HIDDEN BY THE NUMBER OF CHATS: 600 chats and the one new lead is the oldest of them; it is still listed, and a failed welcome is still a to-do', () => {
  const many = Array.from({ length: 600 }, (_, i) => chat('3538711' + String(10000 + i), { lastMessageDirection: 'out', createdAt: ts(NOW - 100 * DAY), lastInboundAt: ts(NOW - (10 + i) * DAY) }));
  const target = lead('353870099999', { lastInboundAt: null, updatedAt: ts(NOW - 400 * DAY) });
  const r = build({ convs: [...many, target], contactsToday: [ct('353870099999', 'LX')], ledger: { LX: { welcome: { state: 'failed' } } } });
  assert.equal(r.newLeads.items.length, 1); assert.equal(r.newLeads.items[0].status, 'failed');
  assert.deepEqual(r.cards.map((c) => [c.phone, c.primary]), [['353870099999', 'leadfix']], 'and it is the only to-do: the 600 quiet chats add nothing');
  assert.equal(r.counts.leadfix, 1);
});

// ================================================================ order, counts, filters ================================
test('ORDER: red first, then amber, then the rest; the oldest first inside each; counts and the red total; each counter filters the list', () => {
  const r = build({
    convs: [chat(P1, { lastInboundAt: ts(NOW - 45 * MIN) }), chat(P2, { lastInboundAt: ts(NOW - 5 * HOUR) }), chat(P3, { lastInboundAt: ts(NOW - 4 * HOUR) }), handed({ name: 'Handed' })],
    reminders: [rem('r1', '2026-10-18')], quotes: [q('q_a', 6, { phone: '353879999999' })] });
  assert.deepEqual(r.cards.map((c) => c.urgency), [...r.cards.map((c) => c.urgency)].sort((a, b) => b - a));
  const reds = r.cards.filter((c) => c.urgency === 2);
  assert.ok(reds.every((c, i) => i === 0 || reds[i - 1].since <= c.since), 'oldest first among the red ones');
  assert.equal(r.redTotal, reds.length);
  assert.deepEqual(r.counts, { reply: 3, handover: 1, booking: 0, notice: 0, quote: 1, reminder: 1, leadfix: 0 });
  assert.equal(r.red.reply, 2);
  assert.equal(M.filterCards(r.cards, 'quote').length, 1); assert.equal(M.filterCards(r.cards, 'reply').length, 3); assert.equal(M.filterCards(r.cards, null).length, r.cards.length);
  assert.equal(M.filterCards(r.cards, 'booking').length, 0);
});

test('VISITS TODAY AND TOMORROW: a small line, soonest first; cancelled visits and later days are left out', () => {
  const a = (id, start, over = {}) => ({ id, phone: P1, customerName: 'N' + id, status: 'scheduled', start: ts(start), end: ts(start + HOUR), ...over });
  const r = build({ appts: [a('3', NOW + DAY + 2 * HOUR), a('1', NOW + 2 * HOUR), a('4', NOW + 2 * DAY + HOUR), a('5', NOW + HOUR, { status: 'cancelled' })] });
  assert.deepEqual(r.visits.map((v) => [v.id, v.today]), [['1', true], ['3', false]]);
});

test('words: how long ago', () => {
  assert.deepEqual([30e3, 45 * MIN, 3 * HOUR + 10 * MIN, 5 * HOUR, DAY, 2 * DAY].map((d) => M.since(NOW - d, NOW)), ['just now', '45 m', '3 h 10 m', '5 h', '1 day', '2 days']);
  assert.equal(M.since(null, NOW), '');
});

test('a template message shows its words (or "A template message"), never its code name', () => {
  assert.equal(M.preview('[template: elite_kitchens_new_lead] Hi Sean, thanks for your enquiry'), 'Hi Sean, thanks for your enquiry');
  assert.equal(M.preview('[template: elite_kitchens_reopen]'), 'A template message');
  assert.equal(M.preview('Hello there'), 'Hello there'); assert.equal(M.preview(null), '');
});

// ================================================================ review fixes (18 Oct 2026) ==========================
// A plain, slow reference for the working-hours clock (a new formatter for every question, no shortcuts): the fast version must give exactly the same answers.
function slowWorkMinutes(from, to) {
  if (!(to > from)) return 0;
  const f = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const at = (y, m, d, h) => { let t = Date.UTC(y, m - 1, d, h, 0); for (let i = 0; i < 3; i++) { const p = Object.fromEntries(f().formatToParts(new Date(t)).map((x) => [x.type, x.value])); const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute); t -= shown - Date.UTC(y, m - 1, d, h, 0); } return t; };
  let total = 0, day = new Date(Date.UTC(...new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(new Date(from)).split('-').map((x, i) => (i === 1 ? +x - 1 : +x))));
  for (let i = 0; i < 130; i++) { const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate(), ws = at(y, m, d, 8), we = at(y, m, d, 20); if (ws > to) break; total += Math.max(0, Math.min(to, we) - Math.max(from, ws)); day = new Date(Date.UTC(y, m - 1, d + 1)); }
  return total / MIN;
}
test('REVIEW FIX: the fast working-hours clock gives exactly the same answers as a plain slow one, across nights, weeks and both clock changes', () => {
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const base = [Date.UTC(2026, 2, 20), Date.UTC(2026, 9, 18), Date.UTC(2026, 2, 28), Date.UTC(2026, 9, 24)];                       // around 29 Mar 2026 (clocks forward) and 25 Oct 2026 (back)
  for (let i = 0; i < 300; i++) {
    const from = base[i % 4] + Math.floor(rnd() * 12 * DAY), to = from + Math.floor(rnd() * 20 * DAY);
    assert.ok(Math.abs(M.workMinutes(from, to) - slowWorkMinutes(from, to)) < 1e-9, `from ${new Date(from).toISOString()} to ${new Date(to).toISOString()}: ${M.workMinutes(from, to)} vs ${slowWorkMinutes(from, to)}`);
  }
});

test('REVIEW FIX: a big backlog is quick: 500 old waiting chats are worked out in well under a quarter of a second (it took about 3 seconds for 300 before)', () => {
  const convs = Array.from({ length: 500 }, (_, i) => chat('35387' + String(2000000 + i), { lastInboundAt: ts(NOW - 55 * DAY - i * MIN), lastMessage: 'How much is a kitchen?' }));
  const t0 = process.hrtime.bigint(), r = build({ convs }), took = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(r.cards.length, 500); assert.ok(took < 250, `took ${took.toFixed(0)} ms`);
});

// ================================================================ Phase 12: a visit the customer was not told about ================================
test('NOTICE: a visit nobody told shows "Confirmation not sent"; not for the first 2 hours unless the visit is within 48 hours; red within 24 hours', () => {
  const visit = (id, startIn, over = {}) => ({ id, phone: P1, customerName: 'Aine Visitor', type: 'consultation', status: 'scheduled', start: ts(NOW + startIn), updatedAt: ts(NOW - 3 * HOUR), ...over });
  const near = build({ convs: [chat(P1)], appts: [visit('a_n', 20 * HOUR)] });
  assert.equal(near.counts.notice, 1); const c = near.cards.find((x) => x.kind === 'notice');
  assert.deepEqual([c.next, c.urgency, c.phone, c.apptId], ['confirmation', 2, P1, 'a_n']);
  assert.match(c.reasons[0].text, /^Confirmation not sent: consultation (today|tomorrow) at \d\d:\d\d$/);
  assert.equal(build({ convs: [chat(P1)], appts: [visit('a_f', 5 * DAY, { updatedAt: ts(NOW - HOUR) })] }).counts.notice, 0, 'booked an hour ago for next week: you are still on it');
  assert.equal(build({ convs: [chat(P1)], appts: [visit('a_f', 5 * DAY)] }).counts.notice, 1, 'still not told 3 hours later');
  assert.equal(build({ convs: [chat(P1)], appts: [visit('a_s', 30 * HOUR, { updatedAt: ts(NOW - 10 * 60e3) })] }).counts.notice, 1, 'within 48 hours: at once');
  assert.deepEqual([20 * HOUR, 40 * HOUR, 5 * DAY].map((d) => build({ appts: [visit('a_u', d)] }).cards[0].urgency), [2, 1, 0]);
});
test('NOTICE: nothing when told, for other kinds of visit, past visits, a customer who said stop; a moved visit and a cancelled one are listed', () => {
  const base = { id: 'a_x', phone: P1, customerName: 'Aine Visitor', type: 'consultation', status: 'scheduled', start: ts(NOW + 20 * HOUR), updatedAt: ts(NOW - 5 * HOUR) };
  const told = (extra = {}) => ({ kind: 'confirmation', toldStart: NOW + 20 * HOUR, at: NOW - 5 * HOUR, reminderFor: null, ...extra });
  const n = (a, convs = [chat(P1)]) => build({ convs, appts: [a] }).counts.notice;
  assert.equal(n({ ...base, customerNotice: told() }), 0, 'told');
  assert.equal(n({ ...base, type: 'other' }), 0); assert.equal(n({ ...base, type: 'installation' }), 0);
  assert.equal(n({ ...base, start: ts(NOW - HOUR) }), 0, 'in the past');
  assert.equal(n(base, [chat(P1, { doNotContact: { on: true } })]), 0, 'do not contact');
  const moved = build({ convs: [chat(P1)], appts: [{ ...base, customerNotice: told({ toldStart: NOW + 10 * HOUR }) }] }).cards.find((x) => x.kind === 'notice');
  assert.deepEqual([moved.next, moved.reasons[0].text.startsWith('The customer was told a different time')], ['change', true]);
  const cancelled = build({ convs: [chat(P1)], appts: [{ ...base, status: 'cancelled', customerNotice: told() }] }).cards.find((x) => x.kind === 'notice');
  assert.equal(cancelled.next, 'cancellation');
  assert.equal(n({ ...base, status: 'cancelled', customerNotice: told(), updatedAt: ts(NOW - 30 * 60e3) }), 0, 'cancelled just now: give it 2 hours');
  assert.equal(n({ ...base, status: 'cancelled' }), 0, 'cancelled and the customer never knew');
  const r = build({ convs: [chat(P1)], appts: [base] }); assert.equal(M.filterCards(r.cards, 'notice').length, 1);
  assert.equal(build({ appts: [base] }).cards.length, 1, 'a visit is listed even when the chat of the customer is not among the recent ones');
});
