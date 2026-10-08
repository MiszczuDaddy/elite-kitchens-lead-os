// Phase 5: a minimal Google Calendar client (REST, no extra packages) and keyless authentication.
// Authentication: the function's own runtime identity (metadata server) asks the IAM Credentials API for a short-lived token
// for the dedicated calendar service account (GCAL_SERVICE_ACCOUNT), limited to the calendar.events scope. No key file exists.
// The calendar is shared with that service account only, so nothing else in the system can write to it.
const crypto = require('crypto');

const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const API_BASE = 'https://www.googleapis.com';
const IAM_BASE = 'https://iamcredentials.googleapis.com';
const METADATA_BASE = 'http://metadata.google.internal';

class GcalError extends Error {
  constructor(code, status, retryable, message) { super(message || code); this.code = code; this.status = status || 0; this.retryable = retryable; }
}

// The event id Elite OS chooses for an appointment: the same for every attempt, forever. Google allows a-v and 0-9 (base32hex);
// hex digits are a subset, so "ek" + 32 hex characters is always valid.
const eventIdFor = (appointmentId) => 'ek' + crypto.createHash('sha256').update(String(appointmentId)).digest('hex').slice(0, 32);

function classify(status, body) {
  const reason = JSON.stringify((body && body.error) || '').toLowerCase();
  if (status === 429 || (status === 403 && reason.includes('ratelimit'))) return new GcalError('rate_limited', status, true);
  if (status >= 500) return new GcalError('unavailable', status, true);
  if (status === 401) return new GcalError('auth', status, true);
  if (status === 403) return new GcalError('forbidden', status, true);          // usually: calendar not shared with Elite OS
  if (status === 404) return new GcalError('not_found', status, true);          // usually: wrong calendar id
  if (status === 409) return new GcalError('conflict', status, false);
  if (status === 410) return new GcalError('gone', status, false);
  return new GcalError('bad_request', status, false);
}

async function request(fetchImpl, url, { method = 'GET', headers = {}, body, timeoutMs = 8000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1, timeoutMs));
  // The limit covers the whole answer, not just its headers (audit finding 9): see gmail.js.
  let res, text = '', bodyLost = false;
  try {
    res = await fetchImpl(url, { method, headers: body ? { 'content-type': 'application/json', ...headers } : headers, body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
    try { text = await res.text(); } catch (e) { bodyLost = true; }
  } catch (e) {
    throw new GcalError(ac.signal.aborted ? 'timeout' : 'network', 0, true);
  } finally { clearTimeout(timer); }
  if (bodyLost && res.ok) throw new GcalError(ac.signal.aborted ? 'timeout' : 'network', 0, true);
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, ok: res.ok, json };
}

// Short-lived token for the calendar service account, cached until five minutes before it expires.
function serviceAccountTokenProvider({ serviceAccount, fetchImpl = fetch, metadataBase = METADATA_BASE, iamBase = IAM_BASE }) {
  let cached = null;
  async function get(timeoutMs = 8000) {
    if (cached && cached.exp - Date.now() > 5 * 60 * 1000) return cached.token;
    if (!serviceAccount) throw new GcalError('token', 0, true, 'no calendar service account configured');
    const meta = await request(fetchImpl, `${metadataBase}/computeMetadata/v1/instance/service-accounts/default/token`, { headers: { 'Metadata-Flavor': 'Google' }, timeoutMs });
    if (!meta.ok || !meta.json || !meta.json.access_token) throw new GcalError('token', meta.status, true, 'runtime token unavailable');
    const r = await request(fetchImpl, `${iamBase}/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:generateAccessToken`, {
      method: 'POST', headers: { authorization: `Bearer ${meta.json.access_token}` }, body: { scope: [CAL_SCOPE], lifetime: '3600s' }, timeoutMs });
    if (!r.ok || !r.json || !r.json.accessToken) throw new GcalError('token', r.status, true, 'calendar token refused');
    cached = { token: r.json.accessToken, exp: Date.parse(r.json.expireTime) || Date.now() + 55 * 60 * 1000 };
    return cached.token;
  }
  return { get, clear: () => { cached = null; } };
}

// Calendar operations used by the sync. Every call takes a timeout so a slow Google never holds up a booking.
function createCalendarClient({ apiBase = API_BASE, fetchImpl = fetch, tokens }) {
  const events = (calendarId) => `${apiBase}/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  async function call(url, opts = {}) {
    const token = await tokens.get(opts.timeoutMs);
    const r = await request(fetchImpl, url, { ...opts, headers: { authorization: `Bearer ${token}` } });
    if (r.status === 401 && tokens.clear) tokens.clear();          // a stale token: the next attempt fetches a new one
    return r;
  }
  return {
    // The event, or null when it does not exist. A deleted event may come back with status "cancelled".
    async getEvent(calendarId, eventId, { timeoutMs } = {}) {
      const r = await call(`${events(calendarId)}/${encodeURIComponent(eventId)}`, { timeoutMs });
      if (r.ok) return r.json;
      if (r.status === 404 || r.status === 410) return null;
      throw classify(r.status, r.json);
    },
    async insertEvent(calendarId, event, { timeoutMs } = {}) {
      const r = await call(`${events(calendarId)}?sendUpdates=none`, { method: 'POST', body: event, timeoutMs });
      if (r.ok) return r.json;
      throw classify(r.status, r.json);
    },
    async updateEvent(calendarId, eventId, event, { timeoutMs } = {}) {
      const r = await call(`${events(calendarId)}/${encodeURIComponent(eventId)}?sendUpdates=none`, { method: 'PUT', body: event, timeoutMs });
      if (r.ok) return r.json;
      throw classify(r.status, r.json);
    },
    async patchEvent(calendarId, eventId, fields, { timeoutMs } = {}) {
      const r = await call(`${events(calendarId)}/${encodeURIComponent(eventId)}?sendUpdates=none`, { method: 'PATCH', body: fields, timeoutMs });
      if (r.ok) return r.json;
      if (r.status === 404 || r.status === 410) return null;
      throw classify(r.status, r.json);
    },
    // Deleting something already deleted or never created counts as done.
    async deleteEvent(calendarId, eventId, { timeoutMs } = {}) {
      const r = await call(`${events(calendarId)}/${encodeURIComponent(eventId)}?sendUpdates=none`, { method: 'DELETE', timeoutMs });
      if (r.ok || r.status === 404 || r.status === 410) return true;
      throw classify(r.status, r.json);
    },
  };
}

module.exports = { CAL_SCOPE, GcalError, eventIdFor, serviceAccountTokenProvider, createCalendarClient };
