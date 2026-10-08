// Phase 6.1 M4: a minimal Gmail client (REST, no extra packages) and KEYLESS sign-in (docs/PHASE6_1_PLAN.md, "Email").
// Sends mail as the business mailbox (info@elitekitchens.ie) through the Gmail API with Google Workspace domain-wide delegation,
// limited to the "gmail.send" scope: it can send, and cannot read anything. No key file, password or token is stored anywhere:
//   1. the function's own runtime identity (metadata server) gets a short-lived token;
//   2. it asks the IAM Credentials API to SIGN a one-hour request on behalf of the dedicated mailer service account, naming the
//      mailbox to act for (the service account has no keys: Google signs with its own);
//   3. Google's token endpoint exchanges that signed request for a one-hour Gmail access token (cached until 5 minutes before expiry).
// Needs, once: the runtime account is allowed to create tokens for the mailer service account (the same arrangement as Phase 5's
// calendar), and a Workspace super admin authorises the mailer's client id for the gmail.send scope only (Admin console >
// Security > API controls > Domain-wide delegation).
const crypto = require('crypto');

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const API_BASE = 'https://gmail.googleapis.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const IAM_BASE = 'https://iamcredentials.googleapis.com';
const METADATA_BASE = 'http://metadata.google.internal';
const EMAIL_RE = /^[^\s@<>",;()[\]\\]+@[^\s@<>",;()[\]\\]+\.[^\s@<>",;()[\]\\]+$/;

// definite: nothing was sent (the sign-in failed, or Google answered with a refusal). Not definite: we cannot tell (Google 5xx,
// no message id, no connection or timeout while sending).
class GmailError extends Error {
  constructor(code, status, definite, message) { super(message || code); this.code = code; this.status = status || 0; this.definite = definite; }
}

async function request(fetchImpl, url, { method = 'GET', headers = {}, body, form, timeoutMs = 8000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1, timeoutMs));
  // The time limit covers the WHOLE answer: the timer stays on until the body has been read, so a provider that sends its headers and then
  // stalls cannot hold the send up (audit finding 9). A refusal (a non-2xx status) is classified by its status even if its body is lost;
  // a "success" whose body is lost is not a success: it is a timeout or a network failure, which the caller treats as unknown.
  let res, text = '', bodyLost = false;
  try {
    const h = { ...headers };
    let payload;
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
    else if (body) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    res = await fetchImpl(url, { method, headers: h, body: payload, signal: ac.signal });
    try { text = await res.text(); } catch (e) { bodyLost = true; }
  } catch (e) {
    throw new GmailError(ac.signal.aborted ? 'timeout' : 'network', 0, false);
  } finally { clearTimeout(timer); }
  if (bodyLost && res.ok) throw new GmailError(ac.signal.aborted ? 'timeout' : 'network', 0, false);
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, ok: res.ok, json };
}

// A short-lived Gmail token for `sender`, via the mailer service account. Every failure here is DEFINITE: nothing was sent.
function delegatedTokenProvider({ serviceAccount, sender, fetchImpl = fetch, metadataBase = METADATA_BASE, iamBase = IAM_BASE, tokenUrl = TOKEN_URL, now = Date.now }) {
  let cached = null;
  async function get(timeoutMs = 8000) {
    if (cached && cached.exp - now() > 5 * 60 * 1000) return cached.token;
    if (!serviceAccount || !sender) throw new GmailError('not_configured', 0, true);
    const step = async (code, fn) => { try { return await fn(); } catch (e) { throw new GmailError(code, e.status, true); } };
    const meta = await step('token_runtime', async () => {
      const r = await request(fetchImpl, `${metadataBase}/computeMetadata/v1/instance/service-accounts/default/token`, { headers: { 'Metadata-Flavor': 'Google' }, timeoutMs });
      if (!r.ok || !r.json || !r.json.access_token) throw new GmailError('x', r.status);
      return r.json;
    });
    const iat = Math.floor(now() / 1000);
    const claims = { iss: serviceAccount, sub: sender, scope: GMAIL_SCOPE, aud: tokenUrl, iat, exp: iat + 3600 };
    const signed = await step('token_sign', async () => {
      const r = await request(fetchImpl, `${iamBase}/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:signJwt`,
        { method: 'POST', headers: { authorization: `Bearer ${meta.access_token}` }, body: { payload: JSON.stringify(claims) }, timeoutMs });
      if (!r.ok || !r.json || !r.json.signedJwt) throw new GmailError('x', r.status);
      return r.json.signedJwt;
    });
    const tok = await step('token_exchange', async () => {
      const r = await request(fetchImpl, tokenUrl, { method: 'POST', form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signed }, timeoutMs });
      if (!r.ok || !r.json || !r.json.access_token) throw new GmailError('x', r.status);
      return r.json;
    });
    cached = { token: tok.access_token, exp: now() + (Number(tok.expires_in) || 3600) * 1000 };
    return cached.token;
  }
  return { get, clear: () => { cached = null; } };
}

function classify(status) {
  if (status === 429) return new GmailError('rate_limited', status, true);
  if (status === 401 || status === 403) return new GmailError('forbidden', status, true);       // not signed in, or not allowed to send as that mailbox
  if (status === 400) return new GmailError('bad_request', status, true);                        // for example an invalid address
  if (status >= 500) return new GmailError('unavailable', status, false);                        // Google may or may not have sent it
  return new GmailError('refused', status, true);
}

// cfg.tokens: a token provider. Sends one prepared message (base64url "raw") as the signed-in mailbox.
function createGmailClient({ apiBase = API_BASE, fetchImpl = fetch, tokens }) {
  return {
    async sendRaw(raw, { timeoutMs = 20000 } = {}) {
      const token = await tokens.get(timeoutMs);
      const r = await request(fetchImpl, `${apiBase}/gmail/v1/users/me/messages/send`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: { raw }, timeoutMs });
      if (r.status === 401 && tokens.clear) tokens.clear();                                        // a stale token: the next attempt signs in again
      if (r.ok && r.json && r.json.id) return { id: r.json.id, threadId: r.json.threadId || null };
      if (r.ok) throw new GmailError('no_message_id', r.status, false);
      throw classify(r.status);
    },
  };
}

// ---------------------------------------------------------------- the message ---------------------------------------------
const CRLF = '\r\n';
const hasBreak = (s) => /[\r\n]/.test(s);
const clean = (s, what) => { s = String(s == null ? '' : s); if (hasBreak(s)) throw new Error(`${what} must be one line`); return s; };

// RFC 2047: non-ASCII header text as encoded words of at most 75 characters (cut on whole characters), folded onto new lines.
function headerText(s) {
  s = clean(s, 'a header');
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words = []; let cur = '';
  for (const ch of s) {
    if (cur && Buffer.byteLength(cur + ch, 'utf8') > 45) { words.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => '=?UTF-8?B?' + Buffer.from(w, 'utf8').toString('base64') + '?=').join(CRLF + ' ');
}
const addr = (email) => { email = clean(email, 'an address'); if (!EMAIL_RE.test(email)) throw new Error('an address does not look right'); return email; };
function mailbox(name, email) {
  const n = name ? clean(name, 'a name').replace(/["\\]/g, '') : '';
  if (!n) return addr(email);
  return /^[\x20-\x7e]*$/.test(n) ? `"${n}" <${addr(email)}>` : `${headerText(n)} <${addr(email)}>`;
}

// RFC 2045 quoted-printable: lines of at most 76 characters, line breaks as CRLF, "=" and every non-ASCII byte encoded, and a space
// or tab at the end of a line encoded too (it would otherwise be stripped in transit).
function quotedPrintable(text) {
  const bytes = Buffer.from(String(text).replace(/\r\n|\r/g, '\n'), 'utf8');
  const hex = (b) => '=' + b.toString(16).toUpperCase().padStart(2, '0');
  let out = '', line = '';
  const push = (s) => { if (line.length + s.length > 75) { out += line + '=' + CRLF; line = ''; } line += s; };
  const endLine = () => {
    const last = line.slice(-1);
    if (last === ' ' || last === '\t') { line = line.slice(0, -1); push(hex(last.charCodeAt(0))); }
  };
  for (const b of bytes) {
    if (b === 0x0a) { endLine(); out += line + CRLF; line = ''; continue; }
    if ((b >= 33 && b <= 126 && b !== 61) || b === 32 || b === 9) push(String.fromCharCode(b)); else push(hex(b));
  }
  endLine();
  return out + line;
}
const wrap64 = (buf) => buf.toString('base64').replace(/(.{76})/g, '$1' + CRLF);

// One plain-text message with the exact PDF attached. Refuses anything that could break out of a header (a line break in the
// subject or an address).
function buildMessage({ from, fromName, to, replyTo, subject, text, attachment, boundary, date = new Date() }) {
  const b = boundary || 'ek-' + crypto.randomBytes(14).toString('hex');
  const head = [
    `From: ${mailbox(fromName, from)}`, `To: ${addr(to)}`, `Reply-To: ${addr(replyTo || from)}`, `Subject: ${headerText(subject)}`,
    `Date: ${date.toUTCString()}`, 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${b}"`,
  ].join(CRLF);
  const fname = clean(attachment.filename, 'a file name').replace(/["\\]/g, '_');
  const body = [
    `--${b}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: quoted-printable', '', quotedPrintable(text),
    `--${b}`, `Content-Type: ${attachment.mime || 'application/pdf'}; name="${fname}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${fname}"`, '',
    wrap64(attachment.bytes).replace(new RegExp(CRLF + '$'), ''),
    `--${b}--`, '',
  ].join(CRLF);
  return head + CRLF + CRLF + body;
}
const toRaw = (message) => Buffer.from(message, 'utf8').toString('base64url');

module.exports = { GMAIL_SCOPE, EMAIL_RE, GmailError, delegatedTokenProvider, createGmailClient, buildMessage, toRaw, quotedPrintable, headerText };
