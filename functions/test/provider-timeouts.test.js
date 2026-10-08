// Audit finding 9: a provider call's time limit must cover the WHOLE answer, not just the arrival of its headers. A provider that sends
// headers promptly and then stalls on the body used to be accepted late (the timer was cleared before the body was read), so a send could
// hang until the Cloud Function deadline. Pure tests: no emulator, no network. Everything is made up.
const { test } = require('node:test');
const assert = require('node:assert');
const { createClient } = require('../lib/whatsapp');
const { createGmailClient, delegatedTokenProvider, GmailError } = require('../lib/gmail');
const { createCalendarClient, GcalError } = require('../lib/gcal');

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
// A value that arrives after `ms`, unless the caller's signal aborts first (as a real response body does when its request is aborted).
const later = (value, ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(() => resolve(value), ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); });
});
// A fetch whose HEADERS arrive at once (status as given) and whose BODY takes `bodyMs`.
const slowBody = (status, value, bodyMs = 150) => async (url, opts = {}) => ({
  ok: status >= 200 && status < 300, status,
  json: () => later(value, bodyMs, opts.signal),
  text: () => later(JSON.stringify(value), bodyMs, opts.signal),
});
const timed = async (fn) => { const t0 = Date.now(); let err = null, val; try { val = await fn(); } catch (e) { err = e; } return { err, val, ms: Date.now() - t0 }; };
const QUICK = 40;          // ms: every call below has a 10 ms limit and must be over well before its 150 ms body would arrive

const wa = (fetchImpl) => createClient({ phoneId: '111', token: 'tok', version: 'v21.0' }, fetchImpl);

test('WhatsApp: headers arrive but the body stalls: the send is not accepted late, it is NOT CONFIRMED (never "refused", never "sent")', async () => {
  const r = await timed(() => wa(slowBody(200, { messages: [{ id: 'wamid.LATE' }] })).sendTemplateByName('353851111111', { name: 't', lang: 'en' }, { timeoutMs: 10 }));
  assert.ok(r.err, 'a late body must not be accepted as a successful send');
  assert.notEqual(r.err.definite, true, 'an interrupted final send is unknown, not a definite refusal');
  assert.ok(r.ms < QUICK + 60, `the limit was ignored: it took ${r.ms} ms`);
});

test('WhatsApp: a refusal (4xx) whose body stalls is still a definite refusal, and is not held up either', async () => {
  const r = await timed(() => wa(slowBody(400, { error: { code: 131026, message: 'x' } })).sendTemplateByName('353851111111', { name: 't', lang: 'en' }, { timeoutMs: 10 }));
  assert.equal(r.err.definite, true);                        // the status already said no: nothing was sent
  assert.ok(r.ms < QUICK + 60, `took ${r.ms} ms`);
});

test('WhatsApp: the PDF upload also respects its limit while the answer body stalls', async () => {
  const r = await timed(() => wa(slowBody(200, { id: 'MEDIA1' })).uploadMedia(Buffer.from('%PDF-1.4'), 'application/pdf', 'q.pdf', { timeoutMs: 10 }));
  assert.ok(r.err, 'a late upload answer must not be accepted');
  assert.ok(r.ms < QUICK + 60, `took ${r.ms} ms`);
});

test('WhatsApp: a normal fast answer still works, and without a limit nothing changes', async () => {
  const fast = async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.OK' }] }), text: async () => '' });
  assert.equal(await wa(fast).sendTemplateByName('353851111111', { name: 't', lang: 'en' }, { timeoutMs: 1000 }), 'wamid.OK');
  assert.equal(await wa(fast).sendTemplateByName('353851111111', { name: 't', lang: 'en' }), 'wamid.OK');
});

test('Gmail: headers arrive but the body stalls: the send is NOT CONFIRMED (not definite), within the limit', async () => {
  const gmail = createGmailClient({ fetchImpl: slowBody(200, { id: 'gmsg-late' }), tokens: { get: async () => 'tok', clear() {} } });
  const r = await timed(() => gmail.sendRaw('cmF3', { timeoutMs: 10 }));
  assert.ok(r.err instanceof GmailError, 'a late body must not be accepted as a sent email');
  assert.equal(r.err.definite, false); assert.equal(r.err.code, 'timeout');
  assert.ok(r.ms < QUICK + 60, `took ${r.ms} ms`);
});

test('Gmail: a refusal (403) whose body stalls is still a definite refusal', async () => {
  const gmail = createGmailClient({ fetchImpl: slowBody(403, { error: { message: 'no' } }), tokens: { get: async () => 'tok', clear() {} } });
  const r = await timed(() => gmail.sendRaw('cmF3', { timeoutMs: 10 }));
  assert.ok(r.err instanceof GmailError); assert.equal(r.err.definite, true); assert.equal(r.err.code, 'forbidden');
});

test('Gmail sign-in: a stalled answer at any sign-in step is a DEFINITE failure (nothing was sent) and respects the limit', async () => {
  const tokens = delegatedTokenProvider({ serviceAccount: 'ek-mailer@x.iam.gserviceaccount.com', sender: 'info@example.test', fetchImpl: slowBody(200, { access_token: 'a' }), now: () => 1 });
  const r = await timed(() => tokens.get(10));
  assert.ok(r.err instanceof GmailError); assert.equal(r.err.definite, true);
  assert.ok(r.ms < QUICK + 60, `took ${r.ms} ms`);
});

test('Gmail: a fast answer still works', async () => {
  const fast = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: 'gmsg-1', threadId: 't1' }) });
  const gmail = createGmailClient({ fetchImpl: fast, tokens: { get: async () => 'tok', clear() {} } });
  assert.deepEqual(await gmail.sendRaw('cmF3', { timeoutMs: 1000 }), { id: 'gmsg-1', threadId: 't1' });
});

test('Calendar (Phase 5, same pattern): a stalled body is a timeout within the limit', async () => {
  const cal = createCalendarClient({ fetchImpl: slowBody(200, { id: 'ev1' }), tokens: { get: async () => 'tok', clear() {} } });
  const r = await timed(() => cal.getEvent('cal@example.test', 'ev1', { timeoutMs: 10 }));
  assert.ok(r.err instanceof GcalError, 'a late body must not be accepted'); assert.equal(r.err.code, 'timeout');
  assert.ok(r.ms < QUICK + 60, `took ${r.ms} ms`);
});
