// Phase 3: Meta Lead Ads intake. Real Firestore emulator; the Meta Graph API is mocked so we can force every failure mode.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { createClient } = require('../lib/whatsapp');
const { handleLeadRequest } = require('../lib/leads');
const { normalizeLeadPhone } = require('../lib/phone');
const store = require('../lib/store');
const h = require('../lib/handlers');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT, storageBucket: 'demo-leados.firebasestorage.app' });
const db = getFirestore();

const KEY = 'test-key-1234567890-abcdefghij', KEY2 = 'rotated-key-1234567890-klmnopqr';
const cfg = { phoneId: '111', token: 'tok', template: 'elite_kitchens_new_lead', lang: 'en', version: 'v21.0', apiKeys: `${KEY}, ${KEY2}` };

// ---- mocked Meta: every send is recorded; mode controls what Meta answers
const sends = []; let mode = 'ok', delayMs = 0;
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const mockFetch = async (url, opts = {}) => {
  sends.push({ url: String(url), body: JSON.parse(opts.body), auth: opts.headers.Authorization });
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  if (mode === 'permanent') return reply({ error: { code: 131026, message: 'Message undeliverable to +353891234567' } }, 400);
  if (mode === 'retryable') return reply({ error: { code: 2, message: 'Service temporarily unavailable' } }, 503);
  if (mode === 'ratelimit') return reply({ error: { code: 130429, message: 'Rate limit hit' } }, 429);
  if (mode === 'network') throw new TypeError('fetch failed');
  return reply({ messages: [{ id: 'wamid.W' + sends.length }] });
};
const wa = () => createClient(cfg, mockFetch);

async function wipe() {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  sends.length = 0; mode = 'ok'; delayMs = 0;
}
beforeEach(wipe);

const META = (over = {}) => ({
  leadId: '1111222233334444', formId: '1670243097747430', formName: '(03/26) Free Quote + Consultation Form (Kitchens) (prices)',
  field_data: [
    { name: 'full_name', values: ['JOHN SMITH'] }, { name: 'phone_number', values: ['p:+353891234567'] }, { name: 'email', values: ['john@example.com'] },
    { name: 'city', values: ['Swords'] }, { name: 'what_is_your_budget_for_the_project?', values: ['€15,000 - €20,000'] },
    { name: 'tell_us_about_your_project', values: ['Island, pantry, new floor'] }, { name: 'when_are_you_looking_to_start?', values: ['Within 3 months'] },
  ], ...over,
});
const call = (body, o = {}) => handleLeadRequest({ method: o.method || 'POST', headers: o.headers || { authorization: `Bearer ${KEY}` },
  rawBody: o.rawBody || Buffer.from(JSON.stringify(body)), body }, { db, wa: wa(), cfg, now: o.now });
const withPhone = (phone, id = '9990001111', extra = {}) => ({ leadId: id, formName: 'Test form', field_data: [{ name: 'full_name', values: ['Aoife Byrne'] }, { name: 'phone_number', values: [phone] }], ...extra });
const doc = async (path) => (await db.doc(path).get()).data();
const count = async (col) => (await db.collection(col).get()).size;
const msgsOf = async (phone) => (await db.collection('conversations').doc(phone).collection('messages').get()).docs.map((d) => ({ id: d.id, ...d.data() }));

test('authentication: only the right key gets in; nothing is stored otherwise; keys can be rotated without downtime', async () => {
  const body = META();
  for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: KEY }, { authorization: 'Bearer ' }, { 'x-api-key': 'nope' }, { authorization: `Bearer ${KEY.slice(0, 10)}` }]) {
    const r = await call(body, { headers }); assert.equal(r.status, 401); assert.equal(r.body.error, 'unauthorized');
  }
  assert.equal((await call(body, { method: 'GET' })).status, 405);
  assert.equal(await count('leads') + await count('contacts') + await count('conversations'), 0); assert.equal(sends.length, 0);
  assert.equal((await call(META({ leadId: 'AAAAA11111' }), { headers: { 'x-api-key': KEY } })).status, 200);          // header alternative
  assert.equal((await call(META({ leadId: 'BBBBB22222', field_data: [{ name: 'full_name', values: ['A B'] }, { name: 'phone_number', values: ['0861112222'] }] }), { headers: { authorization: `Bearer ${KEY2}` } })).status, 200);   // rotated key
  const r = await handleLeadRequest({ method: 'POST', headers: { authorization: 'Bearer short' }, rawBody: Buffer.from('{}'), body: {} }, { db, wa: wa(), cfg: { ...cfg, apiKeys: 'short' } });
  assert.equal(r.status, 401);                                                                                            // a too-short configured key is never accepted
  assert.equal((await handleLeadRequest({ method: 'POST', headers: { authorization: 'Bearer anything-at-all-1234567890' }, rawBody: Buffer.from('{}'), body: {} }, { db, wa: wa(), cfg: { ...cfg, apiKeys: '' } })).status, 401);   // no key configured = closed
});

test('payload validation: malformed, oversized or id-less requests are refused and leave nothing behind', async () => {
  assert.equal((await call(null, { rawBody: Buffer.from('null') })).status, 400);
  assert.equal((await call([1], { rawBody: Buffer.from('[1]') })).status, 400);
  for (const bad of [{}, { leadId: '' }, { leadId: 'a/b/c/d/e' }, { leadId: 'x' }, { leadId: 'x'.repeat(70) }, { leadId: '../../etc' }]) assert.equal((await call(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await call(META(), { rawBody: Buffer.alloc(33 * 1024) })).status, 413);
  assert.equal(await count('leads') + await count('contacts') + await count('conversations'), 0); assert.equal(sends.length, 0);
});

test('a new Meta lead creates the customer, a conversation in Inbox, and sends the approved template once', async () => {
  const r = await call(META());
  assert.deepEqual([r.status, r.body.ok, r.body.status, r.body.welcome, r.body.newCustomer], [200, true, 'processed', 'sent', true]);
  // WhatsApp: right number, right template, first name only
  assert.equal(sends.length, 1); const s = sends[0];
  assert.match(s.url, /\/111\/messages$/); assert.equal(s.auth, 'Bearer tok');
  assert.deepEqual([s.body.to, s.body.type, s.body.template.name, s.body.template.language.code, s.body.template.components[0].parameters[0].text], ['353891234567', 'template', 'elite_kitchens_new_lead', 'en', 'John']);
  // customer record (existing structure) populated
  const c = await doc('contacts/353891234567');
  assert.deepEqual([c.name, c.email, c.location, c.budget, c.projectType, c.source, c.phone], ['John Smith', 'john@example.com', 'Swords', '€15,000 - €20,000', 'Kitchen', 'Meta Ads', '353891234567']);
  assert.match(c.notes, /Meta lead · \(03\/26\) Free Quote/); assert.match(c.notes, /Lead ID: 1111222233334444/);
  assert.match(c.notes, /Requirements: Island, pantry, new floor/); assert.match(c.notes, /When are you looking to start\?: Within 3 months/);
  assert.deepEqual([c.metaLead.leadId, c.metaLead.formId], ['1111222233334444', '1670243097747430']); assert.ok(c.metaLead.welcomeSentAt); assert.equal(c.metaLead.welcomeClaimedAt, undefined);
  // conversation: appears normally, defaults to Inbox (no status written), template shown as an outgoing message
  const v = await doc('conversations/353891234567');
  assert.deepEqual([v.name, v.location, v.projectType, v.lastMessageType, v.lastMessageDirection], ['John Smith', 'Swords', 'Kitchen', 'template', 'out']);
  assert.equal(v.inboxStatus, undefined); assert.equal(v.unreadCount, undefined);
  const m = await msgsOf('353891234567'); assert.equal(m.length, 1);
  assert.deepEqual([m[0].direction, m[0].type, m[0].status, m[0].id], ['out', 'template', 'sent', 'wamid.W1']); assert.match(m[0].body, /Hi John, thanks for your enquiry/);
  // ledger
  const l = await doc('leads/1111222233334444');
  assert.deepEqual([l.state, l.welcome.state, l.welcome.wamid, l.formId, l.attempts, l.contactCreated], ['done', 'sent', 'wamid.W1', '1670243097747430', 1, true]);
});

test('the customer then replies and the conversation continues normally', async () => {
  await call(META());
  const wh = (await require('../lib/whatsapp').parseWebhook({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '111' }, contacts: [{ wa_id: '353891234567', profile: { name: 'John' } }],
    messages: [{ id: 'wamid.IN1', from: '353891234567', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Yes, can you call me tomorrow?' } }] } }] }] }, '111'));
  await store.storeInbound(db, { ...wh.messages[0], from: '353891234567' });
  const v = await doc('conversations/353891234567'); assert.equal(v.unreadCount, 1); assert.equal(v.lastMessage, 'Yes, can you call me tomorrow?'); assert.equal(v.name, 'John Smith');
  await h.sendReply({ uid: 'u', token: { email: 'thomas@example.com', email_verified: true, staff: true } }, { phone: '353891234567', body: 'Of course!' }, { db, wa: wa(), cfg: { ...cfg, allowedEmails: 'thomas@example.com' } });
  assert.equal(sends.at(-1).body.type, 'text'); assert.equal((await msgsOf('353891234567')).length, 3);
});

test('phone numbers: every Irish format and international numbers normalise correctly; anything doubtful is rejected, never guessed', async () => {
  const ok = { '0891234567': '353891234567', '089 123 4567': '353891234567', '(089) 123-4567': '353891234567', '891234567': '353891234567', '+353891234567': '353891234567', '+353 89 123 4567': '353891234567',
    '00353891234567': '353891234567', '353891234567': '353891234567', 'p:+353891234567': '353891234567', '+3530891234567': '353891234567', '+353 (0) 89 123 4567': '353891234567',
    '0851234567': '353851234567', '0871234567': '353871234567', '+447912345678': '447912345678', '00447912345678': '447912345678', '+4407912345678': '447912345678', '+14155552671': '14155552671', '+34 612 345 678': '34612345678' };
  for (const [input, want] of Object.entries(ok)) assert.equal(normalizeLeadPhone(input), want, input);
  for (const bad of ['', null, undefined, 'abc', '123', '+353', '0891234', '+353891234567890123', '++353891234567', '353+891234567', '0000000000', '+3538912345', '089 123 4567 / 086 111 2222', '07912 345678', 'p:', '  ']) assert.equal(normalizeLeadPhone(bad), null, String(bad));
  for (const [input, want] of [['0891234567', '353891234567'], ['+3530891234567', '353891234567'], ['p:+447912345678', '447912345678'], ['00353861112222', '353861112222']]) {   // end to end
    await wipe(); const r = await call(withPhone(input, 'E2E' + want)); assert.equal(r.body.status, 'processed', input); assert.equal(sends[0].body.to, want);
  }
  await wipe(); const two = await call({ leadId: 'TWOPH12345', field_data: [{ name: 'full_name', values: ['Sean'] }, { name: 'phone', values: ['not a number'] }, { name: 'whatsapp_number', values: ['0861112222'] }] });
  assert.equal(two.body.status, 'processed'); assert.equal(sends[0].body.to, '353861112222');                                  // second phone field is used when the first is junk
});

test('invalid phone: nothing is created or sent, Make is told (so you are notified), a corrected resend of the same lead then works', async () => {
  const r = await call(withPhone('hello', 'BADPHONE001'));
  assert.deepEqual([r.status, r.body.ok, r.body.status, r.body.reason], [200, true, 'rejected', 'invalid_phone']);
  assert.equal(sends.length, 0); assert.equal(await count('contacts') + await count('conversations'), 0);
  const l = await doc('leads/BADPHONE001'); assert.deepEqual([l.state, l.reason], ['rejected', 'invalid_phone']);
  const again = await call(withPhone('hello', 'BADPHONE001')); assert.equal(again.body.status, 'rejected');             // rejected is not "done": it is re-evaluated
  const fixed = await call(withPhone('0861112222', 'BADPHONE001')); assert.equal(fixed.body.status, 'processed'); assert.equal(sends.length, 1);
  assert.equal((await doc('leads/BADPHONE001')).state, 'done');
  const none = await call({ leadId: 'NOPHONE0001', field_data: [{ name: 'full_name', values: ['No Phone'] }, { name: 'email', values: ['x@example.com'] }] });
  assert.equal(none.body.reason, 'invalid_phone'); assert.equal(sends.length, 1);
});

test('duplicate protection: the same Meta lead id never creates a second customer, a second record or a second template', async () => {
  const first = await call(META()); assert.equal(first.body.status, 'processed');
  for (let i = 0; i < 4; i++) { const d = await call(META()); assert.deepEqual([d.status, d.body.status, d.body.welcome], [200, 'duplicate', 'sent']); }
  assert.equal(sends.length, 1); assert.equal(await count('contacts'), 1); assert.equal(await count('conversations'), 1); assert.equal(await count('leads'), 1);
  assert.equal((await msgsOf('353891234567')).length, 1);
  assert.equal(((await doc('contacts/353891234567')).notes.match(/Lead ID:/g) || []).length, 1);
});

test('duplicate protection under concurrency: 8 simultaneous deliveries of one lead produce exactly one template', async () => {
  delayMs = 60;
  const rs = await Promise.all(Array.from({ length: 8 }, () => call(META())));
  const tally = rs.reduce((a, r) => { a[r.body.status] = (a[r.body.status] || 0) + 1; return a; }, {});
  assert.equal(tally.processed, 1, JSON.stringify(tally)); assert.equal(sends.length, 1);
  for (const r of rs) assert.ok(['processed', 'duplicate', 'in_progress'].includes(r.body.status));
  for (const r of rs.filter((x) => x.body.status === 'in_progress')) assert.equal(r.status, 503);                         // told to retry shortly
  const late = await call(META()); assert.equal(late.body.status, 'duplicate');
  assert.equal(await count('contacts'), 1); assert.equal((await msgsOf('353891234567')).length, 1);
});

test('the same person submitting twice (different lead ids) within an hour is welcomed once; both enquiries are kept in Notes', async () => {
  const a = await call(META()); assert.equal(a.body.welcome, 'sent');
  const b = await call(META({ leadId: 'SECONDLEAD01', field_data: [{ name: 'full_name', values: ['John Smith'] }, { name: 'phone_number', values: ['0891234567'] }, { name: 'tell_us_about_your_project', values: ['Also a utility room'] }] }));
  assert.deepEqual([b.body.status, b.body.welcome, b.body.newCustomer], ['processed', 'skipped_recent', false]);
  assert.equal(sends.length, 1); const n = (await doc('contacts/353891234567')).notes;
  assert.match(n, /Lead ID: 1111222233334444/); assert.match(n, /Lead ID: SECONDLEAD01/); assert.match(n, /Also a utility room/);
  // two DIFFERENT leads for one number arriving at the same instant: still one template
  await wipe(); delayMs = 60;
  const rs = await Promise.all(['RACEA00001', 'RACEB00002', 'RACEC00003'].map((id) => call(withPhone('0861112222', id))));
  assert.equal(sends.length, 1, 'welcomes: ' + sends.length); assert.equal(rs.filter((r) => r.body.welcome === 'sent').length, 1);
  assert.equal(rs.filter((r) => r.body.welcome === 'skipped_recent').length, 2);
});

test('after the hour a new enquiry from a known customer is welcomed again; a template a staff member just sent also counts', async () => {
  await call(withPhone('0861112222', 'FIRST000001')); assert.equal(sends.length, 1);
  const old = Timestamp.fromMillis(Date.now() - 2 * 3600e3);
  await db.doc('contacts/353861112222').set({ metaLead: { welcomeSentAt: old } }, { merge: true });
  await db.doc('conversations/353861112222').set({ updatedAt: old }, { merge: true });
  const later = await call(withPhone('0861112222', 'LATER000002')); assert.equal(later.body.welcome, 'sent'); assert.equal(sends.length, 2);
  await wipe();
  await store.ensureConversation(db, '353871113333', 'Brian'); await store.storeOutbound(db, '353871113333', { wamid: 'wamid.MANUAL', type: 'template', body: '[template: elite_kitchens_new_lead] Hi Brian' });
  const r = await call(withPhone('0871113333', 'AFTERMANUAL')); assert.equal(r.body.welcome, 'skipped_recent'); assert.equal(sends.length, 0);
});

test('an existing customer keeps their edits and status; blanks are filled; the new enquiry is appended; a fresh welcome is sent', async () => {
  const P = '353891234567';
  await db.doc(`contacts/${P}`).set({ phone: P, name: 'Johnny', location: 'Malahide', notes: 'VIP - referred by Pat', createdAt: Timestamp.now() });
  await db.doc(`conversations/${P}`).set({ phone: P, name: 'Johnny', location: 'Malahide', inboxStatus: 'booked', unreadCount: 0, lastMessage: 'old', updatedAt: Timestamp.fromMillis(Date.now() - 5 * 86400e3), createdAt: Timestamp.now() });
  const r = await call(META());
  assert.deepEqual([r.body.status, r.body.welcome, r.body.newCustomer], ['processed', 'sent', false]);
  const c = await doc(`contacts/${P}`);
  assert.deepEqual([c.name, c.location, c.email, c.budget, c.projectType, c.source], ['Johnny', 'Malahide', 'john@example.com', '€15,000 - €20,000', 'Kitchen', 'Meta Ads']);   // edits kept, blanks filled
  assert.match(c.notes, /^VIP - referred by Pat\n\nMeta lead/);
  const v = await doc(`conversations/${P}`); assert.deepEqual([v.inboxStatus, v.name, v.location, v.projectType, v.unreadCount], ['booked', 'Johnny', 'Malahide', 'Kitchen', 0]);
  assert.equal(sends.length, 1);
});

test('welcome failures: permanent errors are shown in the inbox and never retried; temporary ones are retried safely and capped', async () => {
  mode = 'permanent'; const p = await call(META());
  assert.deepEqual([p.status, p.body.status, p.body.welcome], [200, 'processed', 'failed']);
  const failed = (await msgsOf('353891234567')).find((m) => m.status === 'failed'); assert.ok(failed); assert.equal(failed.type, 'template');
  assert.ok(!/\d{7,}/.test(failed.error), 'error text must not contain a phone number: ' + failed.error); assert.match(failed.error, /undeliverable/);
  assert.equal((await doc('leads/1111222233334444')).welcome.state, 'failed');
  mode = 'ok'; assert.equal((await call(META())).body.status, 'duplicate'); assert.equal(sends.length, 1);               // a finished lead is not re-sent
  await wipe();

  // A Meta 5xx is NOT "definitely not sent" (audit finding 6; before it was retried automatically, which could send the welcome twice): it is
  // "unknown", flagged for a human, and never resent by itself, exactly like no answer at all. Only a 429 rate limit (below) is retried.
  mode = 'retryable'; const t1 = await call(META());
  assert.deepEqual([t1.status, t1.body.status, t1.body.welcome], [200, 'processed', 'unknown']);
  let l = await doc('leads/1111222233334444'); assert.deepEqual([l.state, l.welcome.state], ['done', 'unknown']);
  assert.ok((await msgsOf('353891234567')).some((m) => m.status === 'failed' && /unknown/i.test(m.error)));
  mode = 'ok'; const t2 = await call(META());                                                                                // Make asks again: it is a duplicate, nothing is sent
  assert.equal(t2.body.status, 'duplicate'); assert.equal(sends.filter((s) => s.body.to === '353891234567').length, 1);
  await wipe();

  mode = 'ratelimit'; const out = []; for (let i = 0; i < 4; i++) out.push(await call(META()));
  assert.deepEqual(out.map((r) => r.status), [503, 503, 503, 200]); assert.equal(out[3].body.welcome, 'failed');          // 3 attempts, then stop and flag
  assert.equal((await doc('leads/1111222233334444')).welcome.error, 'too many retries');
  assert.ok((await msgsOf('353891234567')).some((m) => m.status === 'failed' && /manually/.test(m.error)));
});

test('no answer from WhatsApp (timeout): never resent automatically - flagged in the inbox for a human', async () => {
  mode = 'network'; const r = await call(META());
  assert.deepEqual([r.status, r.body.welcome], [200, 'unknown']);
  const f = (await msgsOf('353891234567')).find((m) => m.status === 'failed'); assert.match(f.error, /unknown/i);
  mode = 'ok'; const again = await call(META()); assert.equal(again.body.status, 'duplicate'); assert.equal(sends.length, 1);
});

test('crash recovery: a stuck in-flight claim is not stolen early; an interrupted send is flagged, never repeated', async () => {
  const ref = db.doc('leads/CRASHED0001');
  await ref.set({ leadId: 'CRASHED0001', state: 'processing', claimedAt: 1000, attempts: 1, receivedAt: Timestamp.fromMillis(1000), welcome: { state: 'pending' } });
  const live = await call(withPhone('0861112222', 'CRASHED0001'), { now: () => 1000 + 30 * 1000 });
  assert.deepEqual([live.status, live.body.status], [503, 'in_progress']); assert.equal(sends.length, 0);                    // another request is working on it
  await ref.set({ leadId: 'CRASHED0001', state: 'processing', claimedAt: 1000, attempts: 1, receivedAt: Timestamp.fromMillis(1000), welcome: { state: 'sending', at: 1000 } });
  const stale = await call(withPhone('0861112222', 'CRASHED0001'), { now: () => 1000 + 120 * 1000 });
  assert.deepEqual([stale.status, stale.body.welcome], [200, 'unknown']); assert.equal(sends.length, 0);                    // died mid-send: do NOT send again
  assert.ok((await msgsOf('353861112222')).some((m) => m.status === 'failed' && /unknown/i.test(m.error)));
  await db.doc('leads/CRASHED0002').set({ leadId: 'CRASHED0002', state: 'processing', claimedAt: 1000, attempts: 1, receivedAt: Timestamp.fromMillis(1000), welcome: { state: 'pending' } });
  const resumed = await call(withPhone('0871113333', 'CRASHED0002'), { now: () => 1000 + 120 * 1000 });                    // died before sending: safe to continue
  assert.deepEqual([resumed.body.status, resumed.body.welcome], ['processed', 'sent']); assert.equal(sends.length, 1);
  await db.doc('leads/CRASHED0003').set({ leadId: 'CRASHED0003', state: 'processing', claimedAt: 1000, attempts: 1, receivedAt: Timestamp.fromMillis(1000), welcome: { state: 'sent', wamid: 'wamid.X' } });
  const sentAlready = await call(withPhone('0851114444', 'CRASHED0003'), { now: () => 1000 + 120 * 1000 });
  assert.equal(sentAlready.body.welcome, 'sent'); assert.equal(sends.length, 1);                                              // was already sent: finish, don't repeat
});

test('privacy: the ledger and the logs never contain names, numbers or emails; a deleted customer is not recreated by a late retry', async () => {
  const logs = []; const orig = { log: console.log, error: console.error };
  console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' '));
  try { mode = 'permanent'; await call(META()); await call(META({ leadId: 'BADBAD00001', field_data: [{ name: 'full_name', values: ['Zed Zebra'] }, { name: 'phone_number', values: ['0'] }, { name: 'email', values: ['zed@example.com'] }] })); }
  finally { console.log = orig.log; console.error = orig.error; }
  const blob = logs.join('\n') + JSON.stringify((await db.collection('leads').get()).docs.map((d) => d.data()));
  for (const secret of ['353891234567', '0891234567', '891234567', 'John', 'Smith', 'john@example.com', 'Swords', 'Zed', 'zed@example.com', 'Island']) assert.ok(!blob.includes(secret), 'leaked: ' + secret);
  assert.ok(logs.length >= 2, 'expected log lines');
  mode = 'ok'; await wipe(); await call(META());
  await h.deleteCustomer({ uid: 'u', token: { email: 'thomas@example.com', email_verified: true, staff: true } }, { phone: '353891234567', confirm: '4567' },
    { db, cfg: { allowedEmails: 'thomas@example.com' }, bucket: require('firebase-admin/storage').getStorage().bucket('demo-leados.firebasestorage.app') });
  assert.equal(await count('contacts') + await count('conversations'), 0); sends.length = 0;
  const retry = await call(META()); assert.equal(retry.body.status, 'duplicate');                                           // the ledger outlives the customer on purpose
  assert.equal(await count('contacts') + await count('conversations'), 0); assert.equal(sends.length, 0);
});

test('names: no usable first name becomes "there"; the template parameter is always a safe plain word', async () => {
  const run = async (n, ph) => { await wipe(); await call({ leadId: 'NAME' + Math.random().toString(36).slice(2, 9), field_data: [...(n == null ? [] : [{ name: 'full_name', values: [n] }]), { name: 'phone_number', values: [ph] }] }); return sends[0].body.template.components[0].parameters[0].text; };
  assert.equal(await run(null, '0861112222'), 'there'); assert.equal(await run('😀😀', '0861112222'), 'there'); assert.equal(await run('12345', '0861112222'), 'there');
  assert.equal(await run('visit www.spam.com', '0861112222'), 'there'); assert.equal(await run('a@b.com', '0861112222'), 'there');
  assert.equal(await run('  aoife\nbyrne  ', '0861112222'), 'Aoife'); assert.equal(await run('SEÁN Ó BRIAIN', '0861112222'), 'Seán'); assert.equal(await run('McDonald', '0861112222'), 'McDonald');
  assert.equal(await run('mary-ann o\'neil', '0861112222'), 'Mary-Ann');
  await wipe(); await call({ leadId: 'NONAME00001', field_data: [{ name: 'phone_number', values: ['0861112222'] }] });
  assert.equal((await doc('contacts/353861112222')).name, undefined); assert.match((await msgsOf('353861112222'))[0].body, /Hi there, thanks/);
});

test('any form works: different field names and custom questions are understood; everything else is kept in Notes', async () => {
  const flat = await call({ leadId: 'FORMTWO0001', formId: '999', formName: 'Wardrobes lead form', 'Your Name': 'Niamh Kelly', 'Mobile Number': '086 111 2222', 'E-mail': 'niamh@example.com', County: 'Dublin',
    'Which service are you interested in?': 'Fitted wardrobes', 'Estimated budget': '€5k', 'Preferred contact time': 'Evenings', Eircode: 'D02 X285' });
  assert.equal(flat.body.status, 'processed');
  const c = await doc('contacts/353861112222'); assert.deepEqual([c.name, c.email, c.location, c.projectType, c.budget], ['Niamh Kelly', 'niamh@example.com', 'Dublin', 'Wardrobes', '€5k']);
  assert.match(c.notes, /Preferred contact time: Evenings/); assert.match(c.notes, /Eircode/);
  await wipe();
  const kitchens = await call({ leadId: 'FORMTHREE01', formName: 'Kitchen showroom enquiry', fields: { full_name: 'Tom Ryan', phone_number: '+353861234567', email: 'bad email', town: 'Skerries', 'Do you have plans?': 'Yes' } });
  assert.equal(kitchens.body.status, 'processed');
  const k = await doc('contacts/353861234567'); assert.deepEqual([k.projectType, k.location, k.email], ['Kitchen', 'Skerries', undefined]);   // type inferred from the form name
  assert.match(k.notes, /Email: bad email/); assert.match(k.notes, /Do you have plans\?: Yes/);                           // invalid email kept in Notes, not lost
  await wipe();
  const unknown = await call({ leadId: 'FORMFOUR001', formName: 'Totally new form', 'Phone number': '0861112222', 'Colour of your cat': 'Some answer' });
  assert.equal(unknown.body.status, 'processed'); assert.match((await doc('contacts/353861112222')).notes, /Colour of your cat: Some answer/);
});

test('circuit breaker: a runaway flood is stopped before it can message anyone; known leads are unaffected', async () => {
  await call(META());
  for (let i = 0; i < 60; i++) await db.doc(`leads/FLOOD${String(i).padStart(5, '0')}`).set({ leadId: 'FLOOD' + i, state: 'done', receivedAt: Timestamp.now() });
  const flood = await call(withPhone('0861112222', 'ONEMORE00001'));
  assert.deepEqual([flood.status, flood.body.status], [503, 'rate_limited']); assert.equal(sends.length, 1);
  assert.equal((await doc('leads/ONEMORE00001')), undefined);
  assert.equal((await call(META())).body.status, 'duplicate');
});

test('security rules unchanged: staff can read the lead ledger, nobody can write it from a browser, strangers cannot read it', async () => {
  await call(META());
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  const env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { host, port: Number(port), rules: fs.readFileSync('../firestore.rules', 'utf8') } });
  const staff = env.authenticatedContext('s1', { staff: true, staffUntil: Date.now() + 3600000, email: 't@x.com', email_verified: true }).firestore();
  const plain = env.authenticatedContext('s2', { email: 'x@x.com', email_verified: true }).firestore(); const anon = env.unauthenticatedContext().firestore();
  await assertSucceeds(staff.doc('leads/1111222233334444').get()); await assertFails(staff.doc('leads/1111222233334444').set({ state: 'x' })); await assertFails(staff.doc('leads/NEW000001').set({ state: 'x' }));
  await assertFails(plain.doc('leads/1111222233334444').get()); await assertFails(anon.doc('leads/1111222233334444').get());
  await env.cleanup();
});
