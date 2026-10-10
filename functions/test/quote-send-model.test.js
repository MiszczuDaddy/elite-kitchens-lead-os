// Phase 6.1 M5: the logic behind the Send dialog (public/quote-send-model.js): which channels can be used and why not, the default
// wording, and how each channel's delivery is described. Pure functions, no emulator. Everything below is made up.
const { test } = require('node:test');
const assert = require('node:assert');
const M = require('../../public/quote-send-model.js');

const H = 3600 * 1000, MIN = 60 * 1000;
const NOW = Date.UTC(2026, 9, 5, 13, 32);                      // 5 Oct 2026, 14:32 in Dublin (summer time)
const ts = (n) => ({ toMillis: () => n });
const conv = (extra = {}) => ({ name: 'Anna Murphy', lastInboundAt: ts(NOW - 2 * H), ...extra });

// ============================================================== WhatsApp availability =====================================
test('WhatsApp: open window is available and says when it closes', () => {
  const s = M.whatsappState(conv(), NOW);
  assert.deepEqual([s.state, s.usable], ['open', true]);
  assert.equal(s.text, 'Available: the customer messaged recently (open until 12:32).');
});

test('WhatsApp: a closed window is NOT usable, says why, and offers Reopen once (never "reopened")', () => {
  const s = M.whatsappState(conv({ lastInboundAt: ts(NOW - 30 * H) }), NOW);
  assert.deepEqual([s.state, s.usable, s.canReopen], ['closed', false, true]);
  assert.match(s.text, /24-hour window closed.*only allows an approved template until the customer replies/);
  const never = M.whatsappState({ name: 'Walk In' }, NOW);
  assert.deepEqual([never.state, never.usable, never.canReopen], ['closed', false, true]);
  assert.match(never.text, /Walk In has not messaged yet/);
  assert.deepEqual([M.whatsappState(null, NOW).state, M.whatsappState(null, NOW).usable], ['none', false]);
});

test('WhatsApp: after a Reopen it is "waiting for a reply", NOT open, and never described as reopened', () => {
  const reopen = { state: 'sent', sentAt: ts(NOW - 5 * MIN), claimedAt: ts(NOW - 5 * MIN), wamid: 'w' };
  for (const msg of [null, { status: 'sent' }, { status: 'delivered' }, { status: 'read' }]) {
    const s = M.whatsappState(conv({ lastInboundAt: ts(NOW - 30 * H), reopen }), NOW, msg);
    assert.deepEqual([s.state, s.usable, s.canReopen], ['awaiting', false, false]);
    assert.equal(s.text, 'Template sent at 14:27. Waiting for Anna Murphy to reply: WhatsApp does not allow this message until they do.');
    assert.ok(!/reopened|is open|window is open|available/i.test(s.text));
  }
  const unsure = M.whatsappState(conv({ lastInboundAt: ts(NOW - 30 * H), reopen: { state: 'unknown', claimedAt: ts(NOW - 5 * MIN) } }), NOW);
  assert.deepEqual([unsure.state, unsure.usable, unsure.canReopen], ['awaiting', false, false]);   // may have arrived: counts, and the chat is still not open
  // the customer replies: available again
  assert.equal(M.whatsappState(conv({ reopen, lastInboundAt: ts(NOW - 1 * MIN) }), NOW).state, 'open');
});

test('WhatsApp: a refused or never-delivered Reopen does not use the allowance; Meta\'s "wait 24 hours" does, with when to try again', () => {
  const old = ts(NOW - 30 * H), at = ts(NOW - 5 * MIN);
  const refused = M.whatsappState(conv({ lastInboundAt: old, reopen: { state: 'failed', claimedAt: at } }), NOW);
  assert.deepEqual([refused.state, refused.canReopen], ['closed', true]);
  const sent = { state: 'sent', sentAt: at, claimedAt: at, wamid: 'w' };
  assert.equal(M.whatsappState(conv({ lastInboundAt: old, reopen: sent }), NOW, { status: 'failed', error: '132015: paused' }).canReopen, true);
  const held = M.whatsappState(conv({ lastInboundAt: old, reopen: sent }), NOW, { status: 'failed', error: '131049: held back' });
  assert.deepEqual([held.state, held.canReopen], ['closed', false]);
  assert.match(held.text, /already tried: you can try again after 6 Oct 14:27\.$/);
});

// ================================================================ email availability ======================================
test('email: ready, no address, a bad address, switched off, still checking', () => {
  assert.deepEqual(M.emailState({ email: 'anna@example.com' }, { enabled: true }), { state: 'ready', usable: true, text: 'Available: anna@example.com' });
  for (const [contact, mail, state] of [[{}, { enabled: true }, 'no_email'], [null, { enabled: true }, 'no_email'], [{ email: 'not an address' }, { enabled: true }, 'bad_email'],
    [{ email: 'a@b.co' }, { enabled: false }, 'off'], [{ email: 'a@b.co' }, null, 'checking']]) {
    const s = M.emailState(contact, mail); assert.deepEqual([s.state, s.usable], [state, false], state);
  }
  assert.match(M.emailState({}, { enabled: true }).text, /No email address.*Details/);
  assert.equal(M.emailState({ email: 'a@b.co' }, { enabled: false }).text, 'Email sending is not switched on yet.');
});

test('one channel is ticked by default: WhatsApp if it can be used, else email, else none', () => {
  const st = (w, e) => ({ whatsapp: { usable: w }, email: { usable: e } });
  assert.deepEqual(M.defaultChannels(st(true, true)), ['whatsapp']); assert.deepEqual(M.defaultChannels(st(false, true)), ['email']);
  assert.deepEqual(M.defaultChannels(st(true, false)), ['whatsapp']); assert.deepEqual(M.defaultChannels(st(false, false)), []);
  const all = M.channelStates({ conv: conv(), contact: { email: 'a@b.co' }, mail: { enabled: true }, nowMs: NOW });
  assert.deepEqual([all.whatsapp.state, all.email.state], ['open', 'ready']);
});

// ==================================================================== default wording ====================================
test('the approved WhatsApp wording: the first name, the quote (with the version only after v1), the business', () => {
  assert.equal(M.whatsappText({ name: 'Anna Murphy', ref: 'EK-0104', version: 1, trading: 'Elite Kitchens' }), 'Hi Anna, please find attached your quotation EK-0104 from Elite Kitchens. Any questions, just reply here.');
  assert.equal(M.whatsappText({ name: 'Anna Murphy', ref: 'EK-0104', version: 2, trading: 'Elite Kitchens' }), 'Hi Anna, please find attached your quotation EK-0104 v2 from Elite Kitchens. Any questions, just reply here.');
  assert.equal(M.whatsappText({ name: '', ref: 'EK-0104', version: 1 }), 'Hi there, please find attached your quotation EK-0104 from Elite Kitchens. Any questions, just reply here.');
  assert.ok(M.whatsappText({ name: 'Anna', ref: 'EK-0104', version: 1, trading: 'x'.repeat(10) }).length < 1024);
});

test('the email wording is Phase 6\'s, unchanged: subject, greeting, options, validity, sign-off', () => {
  const wording = { quote: 'kitchen quote', subject: 'Kitchen Quote' };
  assert.equal(M.emailSubject({ trading: 'Elite Kitchens', wording, ref: 'EK-0104', version: 1 }), 'Elite Kitchens — Kitchen Quote EK-0104 v1');
  const business = { signatureName: 'Test Person', phone: '01 000 0000', email: 'quotes@example.com' };
  const body = M.emailText({ name: 'Anna Murphy', ref: 'EK-0104', version: 1, trading: 'Elite Kitchens', wording, options: 2, validityDays: 30, business });
  assert.equal(body, [
    'Hi Anna,', '', 'Thank you for getting in touch with Elite Kitchens. Please find attached your kitchen quote EK-0104 v1.', '',
    "I've put together 2 options based on our conversation — all details are outlined in the attached PDF.", '',
    "The quote is valid for 30 days. If you have any questions or would like to make any changes, please don't hesitate to get in touch.", '',
    'Looking forward to hearing from you.', '', 'Kind regards,', 'Test Person', 'Elite Kitchens', '01 000 0000 | quotes@example.com'].join('\n'));
  assert.match(M.emailText({ name: 'Anna', ref: 'EK-1', version: 1, trading: 'E', wording, options: 1, validityDays: 14, business: {} }), /a proposal based on our conversation[\s\S]*valid for 14 days/);
  assert.match(M.emailText({ name: '', ref: 'EK-1', version: 1, trading: 'E', wording, options: 1, validityDays: 30 }), /^Hi there,/);
});

// ================================================== how each channel's result is described =================================
test('each result is described on its own, with the plain reason and only the actions that make sense', () => {
  const d = (over) => ({ channel: 'whatsapp', state: 'sent', sentAt: ts(NOW), error: null, ...over });
  assert.deepEqual(M.describe(d(), NOW), { state: 'sent', mark: '✓', tone: 'ok', title: 'WhatsApp: sent 5 Oct 14:32', detail: '', actions: [] });
  assert.equal(M.describe(d({ channel: 'email' }), NOW).title, 'Email: sent 5 Oct 14:32');
  const failed = M.describe(d({ state: 'failed', error: { code: 'refused', text: 'Google rejected the email: the address may be wrong. Nothing was sent.' } }), NOW);
  assert.deepEqual([failed.mark, failed.tone, failed.title, failed.actions], ['✕', 'bad', 'WhatsApp: failed', ['retry']]);
  assert.match(failed.detail, /Nothing was sent/);
  const unknown = M.describe(d({ state: 'unknown', error: { text: 'Not confirmed: ...' } }), NOW);
  assert.deepEqual([unknown.mark, unknown.tone, unknown.title, unknown.actions], ['?', 'warn', 'WhatsApp: delivery not confirmed', ['arrived', 'not_arrived']]);
  assert.match(unknown.detail, /will not be sent again by itself/);
  for (const [state, mark] of [['sending', '…'], ['queued', '…'], ['cancelled', '–']]) { const r = M.describe(d({ state }), NOW); assert.deepEqual([r.mark, r.actions], [mark, []]); }
  const manual = M.describe(d({ channel: 'manual' }), NOW); assert.equal(manual.title, 'Marked sent by hand');
  assert.equal(M.describe(d({ resolvedBy: 'thomas@example.com' }), NOW).detail, 'Confirmed by staff.');
  assert.ok(!M.describe(d({ state: 'unknown' }), NOW).title.includes('sent'));                  // "not confirmed" never reads as sent
  assert.ok(!/failed/.test(M.describe(d({ state: 'unknown' }), NOW).title));                    // ... or as failed
});

test('a send still "sending" after 3 minutes is shown as not confirmed, exactly as on the server', () => {
  const d = { channel: 'email', state: 'sending', claimedAt: ts(NOW - 10 * MIN) };
  assert.equal(M.describe(d, NOW).state, 'unknown'); assert.equal(M.effective(d, NOW), 'unknown');
  const fresh = { ...d, claimedAt: ts(NOW - 1 * MIN) };
  assert.equal(M.describe(fresh, NOW).state, 'sending'); assert.equal(M.effective(fresh, NOW), 'sending');
});

test('the summary after sending: sent as soon as ONE channel confirmed; unconfirmed and failed are never called sent', () => {
  const s = (...states) => M.summarize(states.map((state) => ({ channel: 'whatsapp', state, claimedAt: ts(NOW) })), NOW);
  assert.equal(s('sent', 'failed').sent, true); assert.equal(s('failed', 'sent').sent, true); assert.equal(s('sent').sent, true);
  for (const x of [s('failed'), s('failed', 'failed'), s('unknown'), s('unknown', 'failed'), s('sending'), s('queued', 'failed')]) assert.equal(x.sent, false);
  assert.match(s('failed', 'failed').text, /Not sent: nothing reached the customer, and the quote is not marked sent/);
  assert.match(s('unknown', 'failed').text, /could not tell whether it went through/);
  assert.equal(s('unknown', 'sent').sent, true);                                                // the other channel confirmed: the quote is sent, the unsure one stays unsure
  assert.deepEqual([{ channel: 'email' }, { channel: 'whatsapp' }, { channel: 'manual' }].sort(M.byChannel).map((x) => x.channel), ['whatsapp', 'email', 'manual']);
});

// ============================================================== M7: a closed window takes the quote in the approved template ==========
test('WhatsApp with the quotation template: a closed window (or one waiting for a Reopen reply) IS usable, by template, with no Reopen needed', () => {
  const closed = conv({ lastInboundAt: ts(NOW - 30 * H) });
  const s = M.whatsappState(closed, NOW, null, true);
  assert.deepEqual([s.state, s.usable, s.route, s.canReopen], ['template', true, 'template', undefined]);
  assert.match(s.text, /24-hour window closed.*approved quotation template, PDF attached.*customer can reply/);
  assert.ok(!/reopen/i.test(s.text));
  const reopen = { state: 'sent', sentAt: ts(NOW - 5 * MIN), claimedAt: ts(NOW - 5 * MIN), wamid: 'w' };
  const waiting = M.whatsappState(conv({ lastInboundAt: ts(NOW - 30 * H), reopen }), NOW, { status: 'sent' }, true);
  assert.deepEqual([waiting.state, waiting.usable, waiting.route], ['template', true, 'template']);
  const never = M.whatsappState({ name: 'Walk In' }, NOW, null, true);                                  // never messaged: a template can still start the conversation
  assert.deepEqual([never.state, never.usable, never.route], ['template', true, 'template']);
  assert.deepEqual([M.whatsappState(null, NOW, null, true).state, M.whatsappState(null, NOW, null, true).usable], ['none', false]);   // but no conversation at all: still no
});

test('WhatsApp: an OPEN window always sends the staff\'s own words as a normal document; the template flag changes nothing there', () => {
  for (const t of [true, false, null, undefined]) {
    const s = M.whatsappState(conv(), NOW, null, t);
    assert.deepEqual([s.state, s.usable, s.route], ['open', true, 'document']);
  }
});

test('WhatsApp without the template (switched off, or the answer unknown): exactly the M3 rules, or "Checking…" while it is not known', () => {
  const closed = conv({ lastInboundAt: ts(NOW - 30 * H) });
  for (const t of [false, undefined]) {
    const s = M.whatsappState(closed, NOW, null, t);
    assert.deepEqual([s.state, s.usable, s.canReopen, s.route], ['closed', false, true, undefined]);
  }
  const unknown = M.whatsappState(closed, NOW, null, null);
  assert.deepEqual([unknown.state, unknown.usable, unknown.text], ['checking', false, 'Checking…']);
  assert.equal(M.channelStates({ conv: closed, contact: {}, mail: { enabled: false }, nowMs: NOW, template: true }).whatsapp.state, 'template');
  assert.equal(M.channelStates({ conv: closed, contact: {}, mail: { enabled: false }, nowMs: NOW }).whatsapp.state, 'closed');
  assert.deepEqual(M.defaultChannels(M.channelStates({ conv: closed, contact: { email: 'a@example.com' }, mail: { enabled: true }, nowMs: NOW, template: true })), ['whatsapp']);   // WhatsApp is the default again
});

test('the approved template\'s words: the first name, the quote number (version after v1), and the same text as the server records', () => {
  assert.equal(M.templateText({ name: 'Anna Murphy', ref: 'EK-0104', version: 1 }), 'Hi Anna, as discussed, please find attached your Elite Kitchens quotation EK-0104. If you have any questions or would like to make any changes, just reply here.');
  assert.match(M.templateText({ name: 'Anna Murphy', ref: 'EK-0104', version: 2 }), /quotation EK-0104 v2\./);
  assert.match(M.templateText({ name: '+353 85 111 1111', ref: 'EK-0104', version: 1 }), /^Hi there,/);
  assert.equal(M.templateText({ name: 'Anna', ref: 'EK-1', version: 1 }), require('../lib/windowState').quoteTemplateText('Anna', 'EK-1'));
});

test('a delivery that went by template says so in plain words, and a normal one does not', () => {
  const sent = { channel: 'whatsapp', state: 'sent', sentAt: ts(NOW) };
  const t = M.describe({ ...sent, route: 'template' }, NOW);
  assert.deepEqual([t.state, t.mark, t.tone], ['sent', '✓', 'ok']);
  assert.match(t.detail, /approved quotation template, PDF attached.*does not allow your own wording after 24 hours/);
  assert.equal(M.describe({ ...sent, route: 'document' }, NOW).detail, ''); assert.equal(M.describe(sent, NOW).detail, '');
  assert.match(M.describe({ ...sent, route: 'template', resolvedBy: 'staff' }, NOW).detail, /template.*Confirmed by staff\./);
});

// ============================================================== audit 11: a channel left waiting can be sent now ==============================
test('a channel that is "waiting to send" is only offered "send now" once it has been left behind for a while (never while the call is plainly still working)', () => {
  const born = (n) => ts(n);
  const fresh = M.describe({ channel: 'email', state: 'queued', createdAt: born(NOW - 10 * 1000) }, NOW);
  assert.deepEqual([fresh.state, fresh.actions, fresh.detail], ['queued', [], '']);
  const left = M.describe({ channel: 'email', state: 'queued', createdAt: born(NOW - 5 * MIN) }, NOW);
  assert.deepEqual([left.state, left.actions], ['queued', ['resume']]); assert.match(left.detail, /not started.*send it now/i);
  assert.deepEqual(M.describe({ channel: 'email', state: 'queued' }, NOW).actions, []);                       // no time recorded: never guess
  assert.deepEqual(M.describe({ channel: 'whatsapp', state: 'sending', claimedAt: ts(NOW - 10 * 1000) }, NOW).actions, []);    // sending is not "waiting"
  const stalled = M.describe({ channel: 'whatsapp', state: 'sending', claimedAt: ts(NOW - 4 * MIN) }, NOW);
  assert.deepEqual([stalled.state, stalled.actions], ['unknown', ['arrived', 'not_arrived']]);                  // a stalled send is "not confirmed": no retry, no resume
});

// ============================================================== second audit 3: a changed address is cancelled, not retried ==============================
test('a send that failed because the email address changed after it was queued is offered Cancel, not Retry (a retry would only fail again); every other failure keeps Retry', () => {
  const failed = (code) => M.describe({ channel: 'email', state: 'failed', error: { code, text: 'The email address changed after this was queued.' } }, NOW);
  assert.deepEqual([failed('recipient_changed').state, failed('recipient_changed').actions], ['failed', ['cancel']]);
  assert.match(failed('recipient_changed').detail, /address changed/i);
  for (const code of ['failed', 'not_possible', 'pdf_missing', undefined]) assert.deepEqual(failed(code).actions, ['retry'], String(code));
  assert.deepEqual(M.describe({ channel: 'email', state: 'failed' }, NOW).actions, ['retry']);                      // no error recorded: as before
});
