// Phase 6.1 M4: the Gmail client, the keyless sign-in and the hand-built email (docs/PHASE6_1_PLAN.md). A FAKE Google answers every
// request (the metadata server, the IAM Credentials signing call, the token endpoint and Gmail): no real email is ever sent and no
// real Google account is contacted. Every name and address below is made up.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const G = require('../lib/gmail');

const PDF = crypto.randomBytes(5000);                                          // arbitrary binary, so every byte value is exercised
PDF.write('%PDF-1.4\n', 0, 'latin1');

// ---- reading a message back, independently of the code that wrote it ----
function parse(raw) {
  const msg = Buffer.from(raw, 'base64url').toString('utf8');
  const [head, ...rest] = msg.split('\r\n\r\n');
  const headers = {}; let last = null;
  for (const line of head.split('\r\n')) {
    if (/^[ \t]/.test(line) && last) headers[last] += '\r\n' + line; else { const i = line.indexOf(':'); last = line.slice(0, i); headers[last] = line.slice(i + 1).trim(); }
  }
  const boundary = /boundary="([^"]+)"/.exec(headers['Content-Type'])[1];
  const body = rest.join('\r\n\r\n');
  const parts = body.split(`--${boundary}`).slice(1, -1).map((p) => { const t = p.replace(/^\r\n/, '').replace(/\r\n$/, ''); const i = t.indexOf('\r\n\r\n'); return { head: t.slice(0, i), body: t.slice(i + 4) }; });
  return { msg, headers, boundary, parts, tail: body.split(`--${boundary}--`)[1] };
}
const decodeQP = (s) => Buffer.from(s.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
const decodeWords = (s) => s.replace(/\r\n /g, '').replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
const base = { from: 'info@example.test', fromName: 'Elite Kitchens', to: 'anna@example.com', subject: 'Elite Kitchens - Quote EK-0104 v1', text: 'Hi Anna', attachment: { filename: 'EliteKitchens-EK-0104-v1.pdf', bytes: PDF, mime: 'application/pdf' } };

// ================================================================ the message ============================================
test('the message is a multipart email: the headers, the text, and the PDF attached byte for byte', () => {
  const raw = G.toRaw(G.buildMessage({ ...base, boundary: 'b0undary', date: new Date(Date.UTC(2026, 9, 5, 14, 32)) }));
  assert.match(raw, /^[A-Za-z0-9_-]+$/);                                         // base64url: no "+", "/" or "="
  const m = parse(raw);
  assert.deepEqual([m.headers.From, m.headers.To, m.headers['Reply-To'], m.headers.Subject, m.headers['MIME-Version']],
    ['"Elite Kitchens" <info@example.test>', 'anna@example.com', 'info@example.test', 'Elite Kitchens - Quote EK-0104 v1', '1.0']);
  assert.equal(m.headers.Date, 'Mon, 05 Oct 2026 14:32:00 GMT'); assert.equal(m.boundary, 'b0undary');
  assert.equal(m.parts.length, 2);
  assert.match(m.parts[0].head, /Content-Type: text\/plain; charset=UTF-8/); assert.match(m.parts[0].head, /Content-Transfer-Encoding: quoted-printable/);
  assert.equal(decodeQP(m.parts[0].body), 'Hi Anna');
  assert.match(m.parts[1].head, /Content-Type: application\/pdf; name="EliteKitchens-EK-0104-v1.pdf"/);
  assert.match(m.parts[1].head, /Content-Disposition: attachment; filename="EliteKitchens-EK-0104-v1.pdf"/);
  const b64 = m.parts[1].body; assert.ok(b64.split('\r\n').every((l) => l.length <= 76));
  assert.ok(Buffer.from(b64.replace(/\r\n/g, ''), 'base64').equals(PDF));      // the exact file
  assert.equal(m.tail, '\r\n');
  const again = parse(G.toRaw(G.buildMessage({ ...base })));                    // a random boundary each time
  assert.notEqual(again.boundary, 'b0undary'); assert.match(again.boundary, /^ek-[0-9a-f]{28}$/);
});

test('attachments whose size is a multiple of the line length (and empty-ish ones) survive exactly', () => {
  for (const n of [1, 57, 114, 171, 2280, 4560]) {                               // 57 bytes = exactly one 76-character base64 line
    const bytes = crypto.randomBytes(n);
    const m = parse(G.toRaw(G.buildMessage({ ...base, attachment: { ...base.attachment, bytes } })));
    assert.ok(Buffer.from(m.parts[1].body.replace(/\r\n/g, ''), 'base64').equals(bytes), 'size ' + n);
    assert.ok(!/\r\n$/.test(m.parts[1].body), 'size ' + n);                      // no stray blank line before the closing boundary
  }
});

test('the text survives quoted-printable exactly: "=", accents, euro, em dash, emoji, long lines, spaces at the end of a line', () => {
  const samples = [
    'Hi Anna,\n\nPlease find attached your quotation.\n\nKind regards,\nTest Person',
    'a = b, 1+1=2, ==, =3D, =\n',
    'Zoë Ní Bhriain — €14,500 incl. VAT ✓ 🙂 café naïve',
    'x'.repeat(200), 'word '.repeat(60), 'ünïcödé '.repeat(40) + 'end',
    'trailing space \nand tab\t\nthen text', 'ends with a space ', '\n\n\nleading blank lines', 'windows\r\nline\r\nbreaks', 'lonely\rcarriage return',
    '.', '.\n.\n', 'From someone\nFrom: not a header', '',
  ];
  for (const s of samples) {
    const qp = G.quotedPrintable(s);
    assert.ok(qp.split('\r\n').every((l) => l.length <= 76), 'line length: ' + JSON.stringify(s.slice(0, 20)));
    assert.ok(!/[ \t]\r\n/.test(qp) && !/[ \t]$/.test(qp), 'trailing whitespace: ' + JSON.stringify(s.slice(0, 20)));
    assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(qp), 'only ASCII');
    assert.equal(decodeQP(qp).replace(/\r\n/g, '\n'), s.replace(/\r\n|\r/g, '\n'), JSON.stringify(s.slice(0, 20)));
  }
});

test('non-ASCII subjects and names are encoded in words of at most 75 characters; ASCII stays as it is', () => {
  for (const subject of ['Elite Kitchens — Kitchen Quote EK-0104 v1', 'Café ✓ ' + 'ünï'.repeat(80), '🙂'.repeat(60), 'plain ascii subject']) {
    const m = parse(G.toRaw(G.buildMessage({ ...base, subject })));
    assert.equal(decodeWords(m.headers.Subject), subject);
    for (const w of m.headers.Subject.split('\r\n ')) assert.ok(w.length <= 75, 'word too long: ' + w.length);
  }
  assert.equal(parse(G.toRaw(G.buildMessage(base))).headers.Subject, base.subject);
  const named = parse(G.toRaw(G.buildMessage({ ...base, fromName: 'Élite Kitchens' }))).headers.From;
  assert.match(named, /^=\?UTF-8\?B\?.+\?= <info@example\.test>$/); assert.equal(decodeWords(named.replace(' <info@example.test>', '')), 'Élite Kitchens');
  assert.equal(parse(G.toRaw(G.buildMessage({ ...base, fromName: 'The "Best" \\ Kitchens' }))).headers.From, '"The Best  Kitchens" <info@example.test>');   // quotes cannot break out
  assert.equal(parse(G.toRaw(G.buildMessage({ ...base, fromName: '' }))).headers.From, 'info@example.test');
});

test('nothing can break out of a header: line breaks and bad addresses are refused', () => {
  const bad = [{ subject: 'Hello\r\nBcc: evil@example.com' }, { subject: 'Hello\nBcc: evil@example.com' }, { fromName: 'A\r\nB' },
    { to: 'anna@example.com\r\nBcc: evil@example.com' }, { to: 'anna@example.com, evil@example.com' }, { to: 'anna@example.com;evil@example.com' },
    { to: 'Anna <anna@example.com>' }, { to: '"anna"@example.com' }, { to: 'anna example@example.com' }, { to: 'anna@' }, { to: '@example.com' }, { to: 'anna@example' }, { to: '' },
    { to: undefined }, { from: 'info@example.test\r\nX: y' }, { from: 'not an address' }, { replyTo: 'a@b.co\nBcc: x@y.zz' },
    { attachment: { ...base.attachment, filename: 'x.pdf\r\nContent-Type: text/html' } }];
  for (const b of bad) assert.throws(() => G.buildMessage({ ...base, ...b }), Error, JSON.stringify(b));
  const m = parse(G.toRaw(G.buildMessage({ ...base, attachment: { ...base.attachment, filename: 'a"b\\c.pdf' } })));
  assert.match(m.parts[1].head, /name="a_b_c.pdf"/);                              // quotes in a file name are replaced
  for (const ok of ['anna@example.com', 'anna.murphy+kitchen@example.co.uk', "o'brien@example.ie", 'a_b-c@sub.example.com']) assert.match(ok, G.EMAIL_RE);
  const body = parse(G.toRaw(G.buildMessage({ ...base, text: 'Subject: hijack\r\nBcc: evil@example.com\r\n\r\nbody' })));      // the BODY may contain anything: it stays in the text part
  assert.equal(body.headers.Bcc, undefined); assert.equal(body.parts.length, 2);
});

// ================================================================ the keyless sign-in =====================================
function fakeGoogle(over = {}) {
  const g = { calls: [], now: 1_700_000_000_000, expiresIn: 3600, status: {}, hold: null, sends: 0, ...over };
  g.fetch = async (url, opts = {}) => {
    url = String(url); const call = { url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body };
    g.calls.push(call);
    if (g.hold) await g.hold(url);
    const res = (data, st = 200) => new Response(JSON.stringify(data), { status: st });
    const fail = (key) => g.status[key] && res({ error: { message: 'nope for ' + key } }, g.status[key]);
    if (url.includes('/computeMetadata/')) { if (g.status.metadata === 'network') throw new TypeError('fetch failed'); return fail('metadata') || res({ access_token: 'runtime-token', expires_in: 3000 }); }
    if (url.includes(':signJwt')) { if (g.status.sign === 'network') throw new TypeError('fetch failed'); return fail('sign') || res({ keyId: 'k1', signedJwt: 'signed.' + Buffer.from(JSON.parse(opts.body).payload).toString('base64url') + '.sig' }); }
    if (url === 'http://oauth.test/token') { return fail('token') || res({ access_token: 'gmail-token-' + g.calls.filter((c) => c.url === 'http://oauth.test/token').length, expires_in: g.expiresIn, token_type: 'Bearer' }); }
    if (url.includes('/messages/send')) {
      g.sends++; if (g.status.send === 'network') throw new TypeError('fetch failed');
      if (g.status.send === 'hang') return new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      if (g.status.send === 'noid') return res({});
      return fail('send') || res({ id: 'gmsg-' + g.sends, threadId: 'thr-' + g.sends, labelIds: ['SENT'] });
    }
    return res({ error: { message: 'unexpected ' + url } }, 404);
  };
  return g;
}
const provider = (g, over = {}) => G.delegatedTokenProvider({ serviceAccount: 'ek-mailer@project.iam.gserviceaccount.com', sender: 'info@example.test', fetchImpl: g.fetch,
  metadataBase: 'http://meta.test', iamBase: 'http://iam.test', tokenUrl: 'http://oauth.test/token', now: () => g.now, ...over });

test('the sign-in asks Google to sign a one-hour request naming the mailbox and ONLY the send scope; no key or secret is involved', async () => {
  const g = fakeGoogle(), tokens = provider(g);
  assert.equal(await tokens.get(), 'gmail-token-1');
  assert.deepEqual(g.calls.map((c) => [c.method, c.url]), [['GET', 'http://meta.test/computeMetadata/v1/instance/service-accounts/default/token'],
    ['POST', 'http://iam.test/v1/projects/-/serviceAccounts/ek-mailer%40project.iam.gserviceaccount.com:signJwt'], ['POST', 'http://oauth.test/token']]);
  assert.equal(g.calls[0].headers['Metadata-Flavor'], 'Google');
  assert.equal(g.calls[1].headers.authorization, 'Bearer runtime-token');         // the function's own identity, nothing stored
  const claims = JSON.parse(JSON.parse(g.calls[1].body).payload), iat = Math.floor(g.now / 1000);
  assert.deepEqual(claims, { iss: 'ek-mailer@project.iam.gserviceaccount.com', sub: 'info@example.test', scope: 'https://www.googleapis.com/auth/gmail.send', aud: 'http://oauth.test/token', iat, exp: iat + 3600 });
  const form = new URLSearchParams(g.calls[2].body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer'); assert.match(form.get('assertion'), /^signed\./);
  assert.equal(G.GMAIL_SCOPE, 'https://www.googleapis.com/auth/gmail.send');
});

test('the token is reused until 5 minutes before it expires, then renewed; clearing forces a new sign-in', async () => {
  const g = fakeGoogle(), tokens = provider(g);
  assert.equal(await tokens.get(), 'gmail-token-1'); assert.equal(await tokens.get(), 'gmail-token-1'); assert.equal(g.calls.length, 3);
  g.now += 54 * 60 * 1000; assert.equal(await tokens.get(), 'gmail-token-1');                          // 6 minutes left: still fine
  g.now += 2 * 60 * 1000; assert.equal(await tokens.get(), 'gmail-token-2');                          // 4 minutes left: renewed
  tokens.clear(); assert.equal(await tokens.get(), 'gmail-token-3');
});

test('every sign-in failure is DEFINITE (nothing was sent) and says which step', async () => {
  for (const [key, code] of [['metadata', 'token_runtime'], ['sign', 'token_sign'], ['token', 'token_exchange']]) {
    for (const st of [400, 401, 403, 500, 'network']) {
      const g = fakeGoogle({ status: { [key]: st } });
      await assert.rejects(provider(g).get(), (e) => e instanceof G.GmailError && e.code === code && e.definite === true, `${key} ${st}`);
    }
  }
  await assert.rejects(provider(fakeGoogle(), { serviceAccount: '' }).get(), (e) => e.code === 'not_configured' && e.definite === true);
  await assert.rejects(provider(fakeGoogle(), { sender: '' }).get(), (e) => e.code === 'not_configured' && e.definite === true);
});

// ================================================================ sending =================================================
test('sending: the raw message goes to the Gmail API with the bearer token; the id Google gives is returned', async () => {
  const g = fakeGoogle(), gmail = G.createGmailClient({ apiBase: 'http://gmail.test', fetchImpl: g.fetch, tokens: provider(g) });
  const raw = G.toRaw(G.buildMessage(base));
  assert.deepEqual(await gmail.sendRaw(raw), { id: 'gmsg-1', threadId: 'thr-1' });
  const call = g.calls.at(-1);
  assert.deepEqual([call.method, call.url, call.headers.authorization], ['POST', 'http://gmail.test/gmail/v1/users/me/messages/send', 'Bearer gmail-token-1']);
  assert.deepEqual(JSON.parse(call.body), { raw });
});

test('Gmail errors: refusals are definite (nothing sent); a 5xx, an answer without an id, no connection or no answer are NOT (we cannot tell)', async () => {
  const cases = [[400, 'bad_request', true], [401, 'forbidden', true], [403, 'forbidden', true], [404, 'refused', true], [429, 'rate_limited', true], [500, 'unavailable', false], [503, 'unavailable', false],
    ['noid', 'no_message_id', false], ['network', 'network', false], ['hang', 'timeout', false]];
  for (const [st, code, definite] of cases) {
    const g = fakeGoogle({ status: { send: st } }), gmail = G.createGmailClient({ apiBase: 'http://gmail.test', fetchImpl: g.fetch, tokens: provider(g) });
    await assert.rejects(gmail.sendRaw('x', { timeoutMs: 50 }), (e) => e instanceof G.GmailError && e.code === code && e.definite === definite, String(st));
  }
});

test('a 401 forgets the token, so the next attempt signs in again; a failed sign-in never reaches Gmail', async () => {
  const g = fakeGoogle({ status: { send: 401 } }), tokens = provider(g), gmail = G.createGmailClient({ apiBase: 'http://gmail.test', fetchImpl: g.fetch, tokens });
  await assert.rejects(gmail.sendRaw('x'), (e) => e.code === 'forbidden');
  g.status.send = undefined;
  assert.equal((await gmail.sendRaw('x')).id, 'gmsg-2'); assert.equal(g.calls.filter((c) => c.url === 'http://oauth.test/token').length, 2);
  const g2 = fakeGoogle({ status: { sign: 403 } }), gm2 = G.createGmailClient({ apiBase: 'http://gmail.test', fetchImpl: g2.fetch, tokens: provider(g2) });
  await assert.rejects(gm2.sendRaw('x'), (e) => e.code === 'token_sign' && e.definite === true); assert.equal(g2.sends, 0);
});
