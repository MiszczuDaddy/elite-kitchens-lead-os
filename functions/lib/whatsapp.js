// Thin wrapper over the official Meta WhatsApp Cloud API (Graph API). Server-side only.
const crypto = require('crypto');

class WhatsAppError extends Error {
  constructor(message, details) { super(message); this.details = details; }
}

// A failed send says whether it is DEFINITE (error.definite === true: nothing was sent, because the client is not configured or
// Meta answered with a 4xx refusal) or AMBIGUOUS (anything else: a 5xx, an answer without a message id, or, for errors that are
// not a WhatsAppError at all, a network failure or timeout: the message may or may not have gone out).
const refusal = (message, details, definite, code) => Object.assign(new WhatsAppError(message, details), { definite, ...(code ? { code } : {}) });

// cfg: { phoneId, token, version, template, lang }; fetchImpl is injectable for tests.
function createClient(cfg, fetchImpl = fetch) {
  // timeoutMs (optional) gives up on a Meta call that hangs, so the caller can report "not confirmed" instead of being cut off.
  async function post(payload, { timeoutMs } = {}) {
    if (!cfg.phoneId || !cfg.token) throw refusal('WhatsApp is not configured (phone number id / access token missing).', undefined, true);
    const ac = timeoutMs ? new AbortController() : null;
    const timer = ac && setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${cfg.apiBase || 'https://graph.facebook.com'}/${cfg.version || 'v21.0'}/${cfg.phoneId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
        ...(ac ? { signal: ac.signal } : {}),
      });
    } finally { if (timer) clearTimeout(timer); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = data.error || {};
      throw refusal(`Meta API error ${res.status}${e.code ? ` (code ${e.code})` : ''}: ${e.message || 'unknown'}`, data, res.status >= 400 && res.status < 500, e.code);
    }
    const id = data.messages && data.messages[0] && data.messages[0].id;
    if (!id) throw refusal('Meta API returned no message id', data, false);
    return id;
  }
  const base = () => `${cfg.apiBase || 'https://graph.facebook.com'}/${cfg.version || 'v21.0'}`;
  const auth = () => ({ Authorization: `Bearer ${cfg.token}` });
  async function ok(res, what) {
    if (res.ok) return res;
    const data = await res.json().catch(() => ({}));
    const e = data.error || {};
    throw Object.assign(new WhatsAppError(`${what}: Meta API error ${res.status}${e.code ? ` (code ${e.code})` : ''}: ${e.message || 'unknown'}`, data), e.code ? { code: e.code } : {});
  }
  return {
    // --- media (official Cloud API): look up a media id, then fetch the bytes with the same bearer token ---
    getMediaInfo: async (id, signal) => (await ok(await fetchImpl(`${base()}/${encodeURIComponent(id)}`, { headers: auth(), signal }), 'Media lookup')).json(),
    fetchMedia: async (url, signal) => ok(await fetchImpl(url, { headers: auth(), signal }), 'Media download'),
    // timeoutMs (optional, Phase 6.1): give up on an upload that hangs, so a quote send can report a clear failure.
    uploadMedia: async (buffer, mime, filename, { timeoutMs } = {}) => {
      if (!cfg.phoneId || !cfg.token) throw new WhatsAppError('WhatsApp is not configured (phone number id / access token missing).');
      const form = new FormData();
      form.append('messaging_product', 'whatsapp'); form.append('type', mime);
      form.append('file', new Blob([buffer], { type: mime }), filename);
      const ac = timeoutMs ? new AbortController() : null;
      const timer = ac && setTimeout(() => ac.abort(), timeoutMs);
      let res;
      try { res = await fetchImpl(`${base()}/${cfg.phoneId}/media`, { method: 'POST', headers: auth(), body: form, ...(ac ? { signal: ac.signal } : {}) }); }
      finally { if (timer) clearTimeout(timer); }
      const data = await (await ok(res, 'Media upload')).json();
      if (!data.id) throw new WhatsAppError('Meta returned no media id', data);
      return data.id;
    },
    sendMedia: (to, kind, mediaId, { caption, filename } = {}, opts) => post({ to, type: kind, [kind]: {
      id: mediaId, ...(caption && kind !== 'audio' ? { caption } : {}), ...(kind === 'document' && filename ? { filename } : {}) } }, opts),
    sendText: (to, body) => post({ to, type: 'text', text: { body, preview_url: false } }),
    sendTemplate: (to, firstName) => post({
      to, type: 'template',
      template: { name: cfg.template, language: { code: cfg.lang },
        components: [{ type: 'body', parameters: [{ type: 'text', text: firstName }] }] },
    }),
    // Any approved template by name (Phase 6.1: Reopen conversation). params fill {{1}}, {{2}}... of the body, in order.
    sendTemplateByName: (to, { name, lang, params = [] }, opts) => post({
      to, type: 'template',
      template: { name, language: { code: lang },
        ...(params.length ? { components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] } : {}) },
    }, opts),
  };
}

// Verify X-Hub-Signature-256 against the raw request body using the app secret.
function verifySignature(rawBody, header, secret) {
  if (!secret || !header || !rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const MEDIA_TYPES = ['image', 'document', 'video', 'audio', 'sticker'];
// Turn any inbound message into { body, media }. Unknown/odd shapes degrade to a "[type]" placeholder, never an exception.
function describeMessage(m, type) {
  try {
    if (type === 'text') return { body: (m.text && m.text.body) || '', media: null };
    if (MEDIA_TYPES.includes(type) && m[type] && typeof m[type] === 'object') {
      const o = m[type];
      return { body: o.caption || `[${type}]`, media: { waMediaId: o.id || null, mimeType: o.mime_type || null, sha256: o.sha256 || null,
        filename: o.filename || null, caption: o.caption || null, voice: !!o.voice, status: 'pending' } };
    }
    if (type === 'location' && m.location) {
      const l = m.location;
      return { body: `📍 ${[l.name, l.address].filter(Boolean).join(', ') || 'Location'} https://maps.google.com/?q=${l.latitude},${l.longitude}`, media: null };
    }
    if (type === 'contacts' && Array.isArray(m.contacts)) return { body: '👤 Contact: ' + m.contacts.map((c) => (c.name && c.name.formatted_name) || 'unnamed').join(', '), media: null };
    if (type === 'reaction' && m.reaction) return { body: m.reaction.emoji ? `Reacted ${m.reaction.emoji}` : 'Removed a reaction', media: null };
    if (type === 'button' && m.button) return { body: m.button.text || '[button]', media: null };
    if (type === 'interactive' && m.interactive) {
      const i = m.interactive; const r = i.button_reply || i.list_reply || {};
      return { body: r.title || '[reply]', media: null };
    }
  } catch (e) { /* fall through to placeholder */ }
  return { body: `[${type}]`, media: null };
}

// Flatten a webhook payload into { messages, statuses }. Only events for OUR phone number id.
function parseWebhook(payload, ourPhoneId) {
  const out = { messages: [], statuses: [] };
  for (const entry of (payload && payload.entry) || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      if (ch.field !== 'messages') continue;
      if (ourPhoneId && (!v.metadata || v.metadata.phone_number_id !== ourPhoneId)) continue;
      const names = {};
      for (const c of v.contacts || []) names[c.wa_id] = c.profile && c.profile.name;
      for (const m of v.messages || []) {
        const type = m.type || 'unknown';
        const { body, media } = describeMessage(m, type);
        out.messages.push({ wamid: m.id, from: m.from, name: names[m.from] || null, type, body, media,
          createdAt: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date() });
      }
      for (const s of v.statuses || []) {
        const err = s.errors && s.errors[0];
        out.statuses.push({ wamid: s.id, phone: s.recipient_id, status: s.status,
          error: err ? `${err.code}: ${err.title || err.message || ''}`.trim() : null });
      }
    }
  }
  return out;
}

const normalizePhone = (p) => String(p || '').replace(/\D/g, '');   // "+353 89 966 1073" -> "353899661073"

module.exports = { createClient, verifySignature, parseWebhook, normalizePhone, WhatsAppError };
