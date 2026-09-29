// Thin wrapper over the official Meta WhatsApp Cloud API (Graph API). Server-side only.
const crypto = require('crypto');

class WhatsAppError extends Error {
  constructor(message, details) { super(message); this.details = details; }
}

// cfg: { phoneId, token, version, template, lang }; fetchImpl is injectable for tests.
function createClient(cfg, fetchImpl = fetch) {
  async function post(payload) {
    if (!cfg.phoneId || !cfg.token) throw new WhatsAppError('WhatsApp is not configured (phone number id / access token missing).');
    const res = await fetchImpl(`https://graph.facebook.com/${cfg.version || 'v21.0'}/${cfg.phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = data.error || {};
      throw new WhatsAppError(`Meta API error ${res.status}${e.code ? ` (code ${e.code})` : ''}: ${e.message || 'unknown'}`, data);
    }
    const id = data.messages && data.messages[0] && data.messages[0].id;
    if (!id) throw new WhatsAppError('Meta API returned no message id', data);
    return id;
  }
  return {
    sendText: (to, body) => post({ to, type: 'text', text: { body, preview_url: false } }),
    sendTemplate: (to, firstName) => post({
      to, type: 'template',
      template: { name: cfg.template, language: { code: cfg.lang },
        components: [{ type: 'body', parameters: [{ type: 'text', text: firstName }] }] },
    }),
  };
}

// Verify X-Hub-Signature-256 against the raw request body using the app secret.
function verifySignature(rawBody, header, secret) {
  if (!secret || !header || !rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
        let body = null, media = null;
        if (type === 'text') body = m.text && m.text.body;
        else if (m[type] && typeof m[type] === 'object') {
          media = m[type];                         // image/document/video/audio/sticker: keep metadata for Phase 2
          body = m[type].caption || `[${type}]`;
        } else body = `[${type}]`;
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
