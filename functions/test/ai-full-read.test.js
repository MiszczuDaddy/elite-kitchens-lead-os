// "The Assistant can see everything" (22 Nov 2026, docs/AI.md): the read-only tools that close the gaps it had: what is IN a quote (worktops, glazed doors, extras, what is left out), a customer's emails, what happened in a period,
// the price list, and find_records, a general look-up over the records of Elite OS. Real Firestore emulator; no model is called except a fake one in the last test. Every name and number is made up.
// What matters: Thomas asks "did the quote I sent John two months ago include worktops?" and gets the true answer from the quote's own record; nothing is recalculated; nothing can be written; secrets are never shown; and a long
// list says how many there are in all instead of "I cannot see them".
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const T = require('../lib/aiTools');
const ai = require('../lib/ai');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const NOW = Date.UTC(2026, 10, 22, 12, 0), DAY = 86400000, ts = (t) => Timestamp.fromMillis(t), ago = (d, h = 0) => NOW - d * DAY - h * 3600e3;
const JOHN = '353871119901', ANNA = '353871119902', BOB = '353871119903';
const run = (name, input) => T.run({ db, nowMs: NOW }, name, input);
const fails = (name, input, re) => assert.rejects(run(name, input), (e) => e.name === 'ToolError' && (!re || re.test(e.message)), `${name} ${JSON.stringify(input)} should be refused${re ? ' ' + re : ''}`);
const qid = (n) => 'q_' + String(n).padStart(24, '0');
const dump = async () => JSON.stringify(await Promise.all(['conversations', 'contacts', 'quotes', 'emailLog', 'appointments', 'auditLog', 'quoteSettings'].map(async (c) => (await db.collection(c).get()).docs.map((d) => [d.id, d.data()]))));

async function customer(phone, name, extra = {}, conv = {}) {
  await db.doc('contacts/' + phone).set({ phone, name, email: name.split(' ')[0].toLowerCase() + '@example.com', createdAt: ts(ago(90)), ...extra });
  await db.doc('conversations/' + phone).set({ phone, name, inboxStatus: 'quoted', unreadCount: 0, createdAt: ts(ago(90)), updatedAt: ts(ago(3)), ...conv });
}
// a sent quote with its version record, the way the quote engine stores it
async function quote(n, phone, name, { daysAgo = 60, worktop = true, glazing = { small: 2, large: 0 }, extras = [], status = 'sent' } = {}) {
  const sentAt = ago(daysAgo), items = ['Sink', ...(worktop ? ['Worktops'] : []), ...(glazing.small ? [glazing.small + ' small glazed door cabinets'] : []), ...extras.map((e) => e.name + (e.qty > 1 ? ' ×' + e.qty : ''))];
  await db.doc('quotes/' + qid(n)).set({ phone, ref: 'EK-02' + String(n).padStart(2, '0'), status, currentVersion: 1, sentVersion: 1, customerName: name, sentAt: ts(sentAt), updatedAt: ts(sentAt), validUntil: '2026-12-31',
    summary: { options: [{ name: 'Essential', incVat: 9000 }, { name: 'Premium', incVat: 11500 }], dearest: 11500 }, history: [{ action: 'created', at: ts(sentAt - DAY), version: 1 }, { action: 'sent', at: ts(sentAt), version: 1 }] });
  await db.doc(`quotes/${qid(n)}/versions/1`).set({ n: 1, state: 'sent', rev: 3, issueDate: '2026-09-23', validUntil: '2026-12-31', sentAt: ts(sentAt), vatRate: 13.5, createdBy: { id: 'thomas@example.com' },
    answers: { project: 'kitchen', projectName: '', doors: 22, topBoxes: 6, drawers: 9, worktop: { on: worktop, price: worktop ? 2400 : 0 }, glazing, extras: extras.map((e) => ({ name: e.name, qty: e.qty, unitPrice: e.price })), includes: { sink: true, extractor: false, removal: true, electrical: false, plumbing: false } },
    sheet: { options: [{ key: 'ess', name: 'Essential', exVat: 7929, incVat: 9000, lines: ['Standard cabinets', 'Blum soft-close hinges'], breakdown: { cabinets: 5000 } }, { key: 'prem', name: 'Premium', exVat: 10132, incVat: 11500, lines: ['Premium cabinets'] }],
      shared: { worktop: worktop ? 2400 : 0, glazing: 600, extras: extras.reduce((s, e) => s + e.qty * e.price, 0) },
      document: { project: { type: 'kitchen', name: '' }, facts: [{ label: 'Hinges & runners', value: 'Blum soft-close hinges and soft-close drawer runners' }, ...(worktop ? [{ label: 'Worktops', value: 'Supplied and fitted' }] : [])], items,
        workIncluded: ['Kitchen cabinetry — supply and installation', 'Removal of your existing kitchen'], notIncluded: ['Appliances', 'Electrical work', 'Tiling & flooring'] } } });
}
beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await customer(JOHN, 'John Murphy', { location: 'Swords' }); await customer(ANNA, 'Anna Apple'); await customer(BOB, 'Bob Byrne', {}, { inboxStatus: 'inbox', createdAt: ts(ago(0, 2)), updatedAt: ts(ago(0, 2)) });
  await quote(1, JOHN, 'John Murphy', { daysAgo: 60, worktop: true, extras: [{ name: 'Pull-out bin', qty: 2, price: 150 }] });
  await quote(2, ANNA, 'Anna Apple', { daysAgo: 9, worktop: false, glazing: { small: 0, large: 0 } });
  await db.doc(`quotes/${qid(1)}/deliveries/1-aaaaaaaaaaaa-whatsapp`).set({ channel: 'whatsapp', version: 1, state: 'sent', sentAt: ts(ago(60)), to: '353871119901' }); await db.doc(`quotes/${qid(1)}/deliveries/1-aaaaaaaaaaaa-email`).set({ channel: 'email', version: 1, state: 'unknown', updatedAt: ts(ago(60, -1)), to: 'john@example.com' });
  await db.doc(`quotes/${qid(1)}/deliveries/1-bbbbbbbbbbbb-email`).set({ channel: 'email', version: 1, state: 'cancelled', updatedAt: ts(ago(61)) });
});

test('THE QUOTE FROM TWO MONTHS AGO: find John, find his quote (it says when it was sent), and the details say whether worktops were included, with the price, the extras and what was left out', async () => {
  const found = await run('search_customers', { query: 'john' }); assert.equal(found.customers[0].id, JOHN);
  const list = await run('list_quotes', { customerId: JOHN }); assert.equal(list.quotes.length, 1); assert.equal(list.quotes[0].ref, 'EK-0201'); assert.match(list.quotes[0].sentAt, /23 Sept 2026|Sept 2026/, 'each quote says when it was sent');
  const d = await run('get_quote_details', { ref: 'EK-0201' });
  assert.equal(d.worktopsIncluded, true); assert.equal(d.worktopPriceExVat, 2400); assert.deepEqual(d.glazedDoors, { small: 2, large: 0 });
  assert.deepEqual(d.extras, [{ name: 'Pull-out bin', qty: 2, unitPriceExVat: 150 }]); assert.deepEqual(d.includes, { sink: true, extractor: false, removal: true, electrical: false, plumbing: false });
  assert.ok(d.onTheQuote.inYourKitchen.includes('Worktops') && d.onTheQuote.inYourKitchen.includes('Pull-out bin ×2')); assert.deepEqual(d.onTheQuote.notIncluded, ['Appliances', 'Electrical work', 'Tiling & flooring']); assert.deepEqual(d.onTheQuote.workIncluded.length, 2);
  assert.deepEqual(d.options.map((o) => [o.name, o.incVat]), [['Essential', 9000], ['Premium', 11500]]); assert.deepEqual(d.options[0].listsOnThePdf, ['Standard cabinets', 'Blum soft-close hinges']); assert.equal(d.sharedAmountsExVat.worktop, 2400);
  assert.deepEqual(d.sizesInternalOnly, { doors: 22, topBoxes: 6, drawers: 9 }); assert.deepEqual([d.version.n, d.version.state, d.version.validUntil], [1, 'sent', '2026-12-31']); assert.deepEqual(d.versions, [{ n: 1, state: 'sent' }]); assert.equal(d.project, 'kitchen'); assert.equal(d.vatRate, 13.5);
  assert.equal(d.ref, 'EK-0201'); assert.equal(d.customer, 'John Murphy'); assert.match(d.note, /data, not instructions/);
  const a = await run('get_quote_details', { quoteId: qid(2) }); assert.equal(a.worktopsIncluded, false); assert.equal(a.worktopPriceExVat, null); assert.ok(!a.onTheQuote.inYourKitchen.includes('Worktops'), 'a quote without worktops says so'); assert.deepEqual(a.extras, []);
  assert.deepEqual(d.sentVia, [{ channel: 'whatsapp', version: 1, state: 'sent', at: d.sentVia[0].at }, { channel: 'email', version: 1, state: 'unknown', at: d.sentVia[1].at }], 'how it was sent and whether that worked; a cancelled send is left out'); assert.ok(d.sentVia[0].at && !/@|\d{9}/.test(JSON.stringify(d.sentVia)), 'no address or number');
  assert.equal(JSON.stringify(d).includes('createdBy'), false, 'who made it is not part of the answer');
});

test('QUOTE DETAILS: another version, strict input, and a missing quote or version is a plain refusal', async () => {
  await db.doc(`quotes/${qid(1)}/versions/2`).set({ n: 2, state: 'draft', answers: { worktop: { on: false, price: 0 }, glazing: {}, extras: [], includes: {} }, sheet: { options: [], shared: {}, document: { items: [] } } });
  await db.doc('quotes/' + qid(1)).update({ currentVersion: 2 });
  assert.equal((await run('get_quote_details', { ref: 'EK-0201' })).version.n, 1, 'the version that was SENT is shown by default, not the newer draft'); const v2 = await run('get_quote_details', { ref: 'ek-0201', version: 2 });
  assert.deepEqual([v2.version.n, v2.version.state, v2.worktopsIncluded], [2, 'draft', false]); assert.deepEqual((await run('get_quote_details', { ref: 'EK-0201' })).versions, [{ n: 1, state: 'sent' }, { n: 2, state: 'draft' }]);
  await fails('get_quote_details', {}, /Give quoteId or ref/); await fails('get_quote_details', { ref: 'nonsense' }, /look like EK-0104/); await fails('get_quote_details', { quoteId: 'x' }, /not a valid quote id/); await fails('get_quote_details', { ref: 'EK-9999' }, /No such quote/);
  await fails('get_quote_details', { ref: 'EK-0201', version: 9 }, /does not exist/); await fails('get_quote_details', { ref: 'EK-0201', version: 0 }, /whole number/); await fails('get_quote_details', { ref: 'EK-0201', version: 1.5 }, /whole number/); await fails('get_quote_details', { ref: 'EK-0201', extra: 1 }, /Unknown field/);
  await db.doc('quotes/' + qid(3)).set({ phone: ANNA, ref: 'EK-0203', status: 'draft', customerName: 'Anna Apple', currentVersion: 1, summary: {} });                                // an old or odd quote with no version record: no crash
  await fails('get_quote_details', { ref: 'EK-0203' }, /does not exist/);
});

test('EMAILS: a customer\'s emails in time order with their text and attachment names, and the quote email with the start of its wording; nobody else\'s; capped', async () => {
  const chat = (id, o) => db.doc(`conversations/${ANNA}/emails/${id}`).set({ attachments: [], ...o });
  await chat('g_1', { direction: 'in', subject: 'Re: your quote', fromEmail: 'anna@example.com', body: 'Hi, the price is fine. Can you call me after 5? Thanks, Anna', createdAt: ts(ago(5)), attachments: [{ name: 'plan.pdf', size: 1234 }, { name: 'photo.png', size: 99 }] });
  await chat('g_2', { direction: 'out', kind: 'reply', subject: 'Re: your quote', to: 'anna@example.com', body: 'Of course, I will ring you at 5.', createdAt: ts(ago(4)), by: 'thomas@example.com' });
  await chat('g_3', { direction: 'out', kind: 'gmail', subject: 'Rough estimate for the worktops', to: 'anna@example.com', body: 'Please find attached a rough estimate for the stone worktops.', createdAt: ts(ago(2)), attachments: [{ name: 'Quote QU54797.pdf', size: 80000 }] });
  await db.doc('emailLog/' + ANNA + '_qd_1').set({ phone: ANNA, name: 'Anna Apple', direction: 'out', kind: 'quote', subject: 'Elite Kitchens — Kitchen Quote EK-0202 v1', snippet: 'Dear Anna, Please find attached your quotation', email: 'anna@example.com', at: ts(ago(9)), confirmed: false, quoteRef: 'EK-0202' });
  await db.doc('emailLog/' + BOB + '_x').set({ phone: BOB, name: 'Bob Byrne', direction: 'in', kind: 'customer', subject: 'Bob only', snippet: 'secret of Bob', email: 'bob@example.com', at: ts(ago(1)), confirmed: true });
  const r = await run('get_emails', { customerId: ANNA });
  assert.deepEqual(r.emails.map((e) => e.kind), ['quote', 'received', 'reply', 'gmail'], 'oldest first, the newest last: the quote email (9 days ago), her email, your reply, your Gmail email');
  assert.deepEqual(r.emails.map((e) => e.from), ['Elite Kitchens', 'customer', 'Elite Kitchens', 'Elite Kitchens']); assert.match(r.emails[1].text, /Can you call me after 5/); assert.deepEqual(r.emails[1].attachments, ['plan.pdf', 'photo.png']); assert.deepEqual(r.emails[3].attachments, ['Quote QU54797.pdf']);
  assert.match(r.emails[0].text, /Dear Anna, Please find attached your quotation \(only the start is kept/); assert.equal(r.emails[0].quote, 'EK-0202'); assert.equal(r.emails[0].delivery, 'Google did not confirm it was sent'); assert.equal(r.totalEmailsListed, 1, 'how many emails the Emails page lists for her (here only the quote email has an entry)');
  assert.doesNotMatch(JSON.stringify(r), /Bob only|secret of Bob/); assert.equal(JSON.stringify(r).includes('thomas@example.com'), false, 'who sent it is not part of the answer');
  assert.equal((await run('get_emails', { customerId: ANNA, limit: 2 })).emails.length, 2); assert.deepEqual((await run('get_emails', { customerId: ANNA, limit: 2 })).emails.map((e) => e.kind), ['reply', 'gmail'], 'the newest two');
  assert.equal((await run('get_emails', { customerId: JOHN })).emails.length, 0, 'a customer with no emails: an empty list, not an error');
  await fails('get_emails', {}, /customerId is needed/); await fails('get_emails', { customerId: 'abc' }, /not a valid customer id/); await fails('get_emails', { customerId: ANNA, limit: 0 }, /whole number/); await fails('get_emails', { customerId: ANNA, x: 1 }, /Unknown field/);
  for (let n = 0; n < 20; n++) await chat('g_x' + n, { direction: 'in', subject: 'many ' + n, body: 'b' + n, fromEmail: 'anna@example.com', createdAt: ts(ago(1, n)) }); assert.equal((await run('get_emails', { customerId: ANNA, limit: 99 })).emails.length, 15, 'at most 15 at a time');
});

test('WHAT HAPPENED: leads that arrived, quotes sent, accepted and declined, emails in and out and appointments, for today by default and for any day or range; lists are capped but the counts are whole', async () => {
  await db.doc('quotes/' + qid(2)).update({ sentAt: ts(ago(0, 3)) }); await db.doc('quotes/' + qid(1)).update({ status: 'accepted', acceptedAt: ts(ago(0, 1)) });
  await db.doc('quotes/' + qid(3)).set({ phone: BOB, ref: 'EK-0203', status: 'declined', customerName: 'Bob Byrne', declinedAt: ts(ago(1)), sentAt: ts(ago(20)), currentVersion: 1, summary: {} });
  const em = (id, phone, name, direction, kind, at, subject) => db.doc('emailLog/' + id).set({ phone, name, direction, kind, subject, snippet: subject, email: 'x@example.com', at: ts(at), confirmed: true });
  await em('e1', ANNA, 'Anna Apple', 'in', 'customer', ago(0, 2), 'Re: your quote'); await em('e2', ANNA, 'Anna Apple', 'out', 'reply', ago(0, 1), 'Re: your quote'); await em('e3', JOHN, 'John Murphy', 'out', 'followup', ago(1), 'Your enquiry'); await em('e4', BOB, 'Bob Byrne', 'in', 'customer', ago(40), 'old');
  await db.doc('appointments/a1').set({ phone: ANNA, customerName: 'Anna Apple', type: 'consultation', status: 'confirmed', start: ts(NOW + 2 * 3600e3), end: ts(NOW + 3 * 3600e3), durationMin: 60 }); await db.doc('appointments/a2').set({ phone: JOHN, customerName: 'John Murphy', type: 'install', status: 'confirmed', start: ts(ago(0, -30)), end: ts(ago(0, -31)) });
  const t = await run('get_activity', {});
  assert.deepEqual([t.from, t.to], ['2026-11-22', '2026-11-22'], 'today by default'); assert.equal(t.newLeads.total, 1); assert.equal(t.newLeads.customers[0].id, BOB, 'Bob arrived two hours ago (the others are older)');
  assert.deepEqual([t.quotesSent.total, t.quotesSent.quotes[0].ref], [1, 'EK-0202']); assert.deepEqual([t.quotesAccepted.total, t.quotesAccepted.quotes[0].ref], [1, 'EK-0201']); assert.equal(t.quotesDeclined.total, 0);
  assert.deepEqual([t.emails.total, t.emails.received, t.emails.sent, t.emails.byKind], [2, 1, 1, { customer: 1, reply: 1 }]); assert.equal(t.appointments.total, 1, 'only the visit today'); assert.match(t.note, /find_messages/);
  const y = await run('get_activity', { from: '2026-11-21' }); assert.deepEqual([y.from, y.to], ['2026-11-21', '2026-11-22'], 'from a day to today'); assert.equal(y.emails.total, 3); assert.equal(y.quotesDeclined.total, 1); assert.equal(y.emails.list[0].customer, 'Anna Apple', 'newest first');
  const one = await run('get_activity', { from: '2026-11-21', to: '2026-11-21' }); assert.deepEqual([one.emails.total, one.newLeads.total, one.quotesDeclined.total], [1, 0, 1], 'one day'); const only = await run('get_activity', { to: '2026-11-21' }); assert.deepEqual([only.from, only.to], ['2026-11-21', '2026-11-21'], 'only an end date: that day');
  for (let n = 0; n < 40; n++) await em('m' + n, ANNA, 'Anna Apple', 'in', 'customer', ago(0, 2) + n * 1000, 'many ' + n); const many = await run('get_activity', { limit: 5 }); assert.equal(many.emails.total, 42); assert.equal(many.emails.list.length, 5, 'the list is capped, the count is whole');
  await fails('get_activity', { from: '2026-11-30', to: '2026-11-01' }, /must not be after/); await fails('get_activity', { from: 'yesterday' }, /must be a date/); await fails('get_activity', { from: '2026-01-01', to: '2026-11-22' }, /at most 92 days/); await fails('get_activity', { x: 1 }, /Unknown field/);
});

test('THE PRICE LIST: what new quotes use (and says a sent quote keeps its own); a missing list is a plain refusal', async () => {
  await fails('get_price_list', {}, /No price list/);
  await db.doc('quoteSettings/current').set({ priceList: { glazing: { small: 120, large: 180 }, drawerBoxes: { none: 0, cemux: 60, blum: 100 } }, vatRate: 13.5, validityDays: 30, business: { tradingName: 'Elite Kitchens', phone: '0894641917' }, apiToken: 'must-not-show' });
  const r = await run('get_price_list', {}); assert.equal(r.vatRate, 13.5); assert.equal(r.quoteValidForDays, 30); assert.equal(r.priceList.glazing.small, 120); assert.match(r.note, /keeps the prices it was sent with/);
  assert.doesNotMatch(JSON.stringify(r), /must-not-show|0894641917/, 'only the prices, the VAT rate and the validity'); await fails('get_price_list', { x: 1 }, /Unknown field/);
});

test('FIND ANYTHING: conditions, dates, search, fields, order, counts; the answer says how many matched and how many were looked through', async () => {
  const c = await run('find_records', { collection: 'conversations', where: [{ field: 'inboxStatus', op: '==', value: 'quoted' }] }); assert.equal(c.matched, 2); assert.equal(c.scanned, 3); assert.deepEqual(c.rows.map((r) => r.id).sort(), [ANNA, JOHN].sort());
  assert.equal((await run('find_records', { collection: 'conversations', where: [{ field: 'inboxStatus', op: '!=', value: 'quoted' }] })).rows[0].id, BOB);
  assert.equal((await run('find_records', { collection: 'conversations', where: [{ field: 'createdAt', op: '>=', value: '2026-11-22' }], countOnly: true })).matched, 1, 'a date field takes a day (Irish time)'); assert.equal((await run('find_records', { collection: 'conversations', where: [{ field: 'createdAt', op: '<', value: '2026-11-22' }], countOnly: true })).matched, 2);
  const co = await run('find_records', { collection: 'conversations', countOnly: true }); assert.deepEqual([co.matched, co.rows], [3, undefined], 'countOnly: just the number');
  assert.deepEqual((await run('find_records', { collection: 'contacts', search: 'swords' })).rows.map((r) => r.name), ['John Murphy'], 'a word in any text field, any case'); assert.equal((await run('find_records', { collection: 'contacts', where: [{ field: 'location', op: 'contains', value: 'SWORD' }] })).matched, 1);
  assert.equal((await run('find_records', { collection: 'contacts', where: [{ field: 'location', op: 'exists', value: true }] })).matched, 1); assert.equal((await run('find_records', { collection: 'contacts', where: [{ field: 'location', op: 'exists', value: false }] })).matched, 2);
  const q = await run('find_records', { collection: 'quotes', where: [{ field: 'status', op: '==', value: 'sent' }, { field: 'summary.dearest', op: '>=', value: 11000 }, { field: 'sentAt', op: '<', value: '2026-11-01' }], fields: ['ref', 'customerName', 'summary.dearest', 'sentAt'] });
  assert.equal(q.matched, 1); assert.deepEqual(Object.keys(q.rows[0]), ['id', 'ref', 'customerName', 'summary.dearest', 'sentAt'], 'only the fields asked for, dotted paths too'); assert.equal(q.rows[0].ref, 'EK-0201'); assert.equal(q.rows[0]['summary.dearest'], 11500); assert.match(q.rows[0].sentAt, /2026/);
  const ordered = await run('find_records', { collection: 'quotes', orderBy: 'ref', direction: 'asc', fields: ['ref'] }); assert.deepEqual(ordered.rows.map((r) => r.ref), ['EK-0201', 'EK-0202']); assert.deepEqual((await run('find_records', { collection: 'quotes', fields: ['ref'] })).rows.map((r) => r.ref), ['EK-0202', 'EK-0201'], 'quotes: newest first by default');
  assert.equal((await run('find_records', { collection: 'quotes', limit: 1, fields: ['ref'] })).rows.length, 1); assert.equal((await run('find_records', { collection: 'quotes', limit: 1, fields: ['ref'] })).matched, 2, 'matched counts all, shown is the limit'); assert.equal((await run('find_records', { collection: 'quotes', limit: 1 })).shown, 1);
  for (let n = 0; n < 40; n++) await db.doc('reminders/r' + n).set({ title: 'r' + n, status: 'open', dueDate: '2026-11-2' + (n % 10) }); const many = await run('find_records', { collection: 'reminders', limit: 99 }); assert.equal(many.matched, 40); assert.equal(many.rows.length, 30, 'at most 30 rows, the count is whole');
  assert.equal((await run('find_records', { collection: 'reminders', where: [{ field: 'dueDate', op: '>=', value: '2026-11-25' }], countOnly: true })).matched, 20, 'a text date compares as text');
  await db.doc('contacts/' + JOHN).update({ tags: ['vip', 'swords'] }); assert.equal((await run('find_records', { collection: 'contacts', where: [{ field: 'tags', op: '==', value: 'VIP' }], countOnly: true })).matched, 1, 'a list matches when any item does');
});

test('FIND ANYTHING IS BOUNDED AND SAFE: only the allowed collections, secrets never shown or filterable, long records trimmed, "more than looked through" said out loud; nothing is written', async () => {
  await db.doc('contacts/' + JOHN).update({ fcmToken: 'tok-123', apiKey: 'key-abc', nested: { password: 'pw', ok: 'fine', deeper: { a: { b: 'c' } } }, notes: 'x'.repeat(5000) });
  await db.doc('contacts/' + ANNA).update({ a1: 'y'.repeat(190), a2: 'y'.repeat(190), a3: 'y'.repeat(190), a4: 'y'.repeat(190), a5: 'y'.repeat(190), a6: 'y'.repeat(190), a7: 'y'.repeat(190), a8: 'y'.repeat(190), a9: 'y'.repeat(190), a10: 'y'.repeat(190) });
  const before = await dump();
  const r = await run('find_records', { collection: 'contacts', where: [{ field: 'name', op: '==', value: 'john murphy' }] }), row = r.rows[0], text = JSON.stringify(r);
  assert.doesNotMatch(text, /tok-123|key-abc|"pw"|fcmToken|apiKey|password/, 'secrets are dropped, even inside a nested object'); assert.equal(row.nested.ok, 'fine'); assert.equal(row.nested.deeper.a, '(more detail)', 'deep structures are cut');
  assert.ok(row.notes.length <= 200, 'a long text is shortened'); assert.ok(JSON.stringify(row).length <= 1800 + 50);
  const big = (await run('find_records', { collection: 'contacts', where: [{ field: 'name', op: '==', value: 'Anna Apple' }] })).rows[0]; assert.ok(JSON.stringify(big).length <= 1800 + 50 && big._trimmed, 'a record that is too long for one row says it was trimmed');
  assert.equal(JSON.stringify((await run('find_records', { collection: 'contacts', where: [{ field: 'name', op: '==', value: 'Anna Apple' }], fields: ['a1', 'fcmToken'] })).rows[0]).includes('fcmToken'), false, 'a secret field cannot even be asked for');
  await fails('find_records', { collection: 'contacts', where: [{ field: 'fcmToken', op: 'exists' }] }, /field name/); await fails('find_records', { collection: 'contacts', where: [{ field: 'apiKey', op: '==', value: 'key-abc' }] }, /field name/);
  for (const col of ['pushDevices', 'sendRequests', 'aiSettings', 'aiLog', 'aiUsage', 'aiRate', 'aiProposals', '../x', 'contacts/x/emails', 5, undefined]) await fails('find_records', { collection: col }, /cannot be looked up/);
  await fails('find_records', { collection: 'contacts', where: 'x' }, /list of up to 6/); await fails('find_records', { collection: 'contacts', where: Array(7).fill({ field: 'name', op: 'exists' }) }, /up to 6/); await fails('find_records', { collection: 'contacts', where: [{ field: 'name', op: 'like', value: 'x' }] }, /op must be one of/);
  await fails('find_records', { collection: 'contacts', where: [{ field: 'name', op: '==', value: { a: 1 } }] }, /text, a number or true\/false/); await fails('find_records', { collection: 'contacts', where: [{ field: 'name', op: '==' }] }, /text, a number or true\/false/); await fails('find_records', { collection: 'contacts', where: [{ field: 'name', op: '==', value: 'x'.repeat(101) }] }, /too long/);
  await fails('find_records', { collection: 'contacts', where: [{ field: '../x', op: 'exists' }] }, /field name/); await fails('find_records', { collection: 'contacts', where: [{ field: 'a.b.c.d.e', op: 'exists' }] }, /field name/); await fails('find_records', { collection: 'contacts', where: [{ field: 'name', op: 'exists', extra: 1 }] }, /Unknown field in a condition/);
  await fails('find_records', { collection: 'contacts', search: '' }, /short piece of text/); await fails('find_records', { collection: 'contacts', search: 'x'.repeat(61) }, /short piece/); await fails('find_records', { collection: 'contacts', fields: Array(13).fill('name') }, /up to 12/); await fails('find_records', { collection: 'contacts', fields: ['a b'] }, /up to 12/);
  await fails('find_records', { collection: 'contacts', orderBy: 'x y' }, /field name/); await fails('find_records', { collection: 'contacts', direction: 'up' }, /asc or desc/); await fails('find_records', { collection: 'contacts', countOnly: 'yes' }, /true or false/); await fails('find_records', { collection: 'contacts', limit: 0 }, /whole number/); await fails('find_records', { collection: 'contacts', extra: 1 }, /Unknown field/); await fails('find_records', {}, /cannot be looked up/);
  const keep = T.CAP.scan; T.CAP.scan = 2;
  try { const p = await run('find_records', { collection: 'conversations', countOnly: true }); assert.equal(p.scanned, 2); assert.match(p.partial, /Only the 2 records were looked through, so there may be more/); const q2 = await run('find_records', { collection: 'quotes', countOnly: true }); assert.match(q2.partial, /newest 2 records/, 'an ordered collection looks through the newest first'); } finally { T.CAP.scan = keep; }
  assert.equal((await run('find_records', { collection: 'conversations', countOnly: true })).partial, undefined, 'not partial when everything was looked through');
  assert.equal(await dump(), before, 'looking things up wrote nothing');
});

test('WIRING: the model is offered every new tool and told what they are for and never to say it cannot see; a tool call through the whole chat loop returns the true answer from the quote\'s own record', async () => {
  const names = T.TOOLS.map((t) => t.name); for (const n of ['get_quote_details', 'get_emails', 'get_activity', 'get_price_list', 'find_records']) assert.ok(names.includes(n), n);
  for (const t of T.TOOLS) { assert.equal(t.input_schema.additionalProperties, false, t.name); assert.equal(t.input_schema.type, 'object'); }
  const src = fs.readFileSync(path.join(__dirname, '../lib/ai.js'), 'utf8');
  assert.match(src, /never tell the person you cannot see, find or check something/); for (const n of ['get_quote_details', 'get_emails', 'get_activity', 'get_price_list', 'find_records', 'propose_customer_email']) assert.ok(src.includes(n), 'the instructions name ' + n);
  const checked = Object.fromEntries(Object.entries(ai.MODELS).map(([k, m]) => [k, { id: m.id, ok: true, name: m.label, lifecycle: 'active', at: ts(NOW) }])); await db.doc('aiSettings/modelCheck').set(checked);
  await db.doc('aiSettings/current').set({ enabled: true, customerDataApproved: true, actionsEnabled: false, monthlyCapEur: 15, dailyCapEur: 2 });
  const calls = []; const model = { name: 'fake', calls, async complete(req) { calls.push(JSON.parse(JSON.stringify(req)));
    if (calls.length === 1) return { text: '', toolCalls: [{ id: 'tu1', name: 'get_quote_details', input: { ref: 'EK-0201' } }], stopReason: 'tool_use', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } };
    return { text: 'Yes: worktops were included.', toolCalls: [], stopReason: 'end_turn', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }; } };
  const r = await ai.chat({ db, model, owners: 'thomas@example.com' }, { kind: 'staff', id: 'thomas@example.com' }, { message: 'Did the quote I sent John two months ago include worktops?' }, { uid: 'u1', nowMs: NOW });
  assert.equal(r.reply, 'Yes: worktops were included.'); const back = JSON.stringify(calls[1].messages); assert.match(back, /worktopsIncluded\\?":true/); assert.match(back, /Pull-out bin/); assert.ok(calls[0].tools.some((t) => t.name === 'find_records'));
});

test('OLDER WHATSAPP MESSAGES: the chat says how many messages it has and `before` pages back in time, 15 at a time', async () => {
  for (let n = 0; n < 40; n++) await db.doc(`conversations/${ANNA}/messages/m${n}`).set({ direction: n % 2 ? 'out' : 'in', type: 'text', body: 'message ' + n, createdAt: ts(ago(40 - n)) });                // one a day, the newest today
  const newest = await run('get_conversation', { customerId: ANNA, limit: 99 }); assert.equal(newest.totalMessagesInChat, 40); assert.equal(newest.messages.length, 15); assert.equal(newest.messages.at(-1).text, 'message 39'); assert.equal(newest.onlyBefore, undefined);
  const older = await run('get_conversation', { customerId: ANNA, limit: 99, before: '2026-11-08' }); assert.equal(older.onlyBefore, '2026-11-08'); assert.equal(older.messages.length, 15); assert.equal(older.messages.at(-1).text, 'message 25', 'the newest of those before 8 Nov (a message on 7 Nov is message 25)'); assert.equal(older.totalMessagesInChat, 40);
  const oldest = await run('get_conversation', { customerId: ANNA, before: '2026-10-20' }); assert.ok(oldest.messages.length < 15 && oldest.messages.length > 0); assert.equal(oldest.messages[0].text, 'message 0');
  await fails('get_conversation', { customerId: ANNA, before: 'last week' }, /must be a date/); await fails('get_conversation', { customerId: ANNA, before: '2026-13-40' }, /must be a date/);
});
