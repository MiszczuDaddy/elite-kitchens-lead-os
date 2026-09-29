// Thin wrapper over the official Meta WhatsApp Cloud API (Graph API). Server-side only.
const crypto = require('crypto');

const cfg = () => ({
  phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  token: process.env.WHATSAPP_ACCESS_TOKEN,
  version: process.env.WHATSAPP_API_VERSION || 'v21.0',
  template: process.env.WHATSAPP_TEMPLATE_NAME || 'elite_kitchens_new_lead',
  lang: process.env.WHATSAPP_TEMPLATE_LANG || 'en',
});

class WhatsAppError extends Error {
  constructor(message, details) { super(message); this.details = details; }
}

async function graphPost(payload) {
  const c = cfg();
  if (!c.phoneId || !c.token) {
    throw new WhatsAppError('WhatsApp is not configured: set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN on the server.');
  }
  const res = await fetch(`https://graph.facebook.com/${c.version}/${c.phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error || {};
    throw new WhatsAppError(`Meta API error ${res.status}${e.code ? ` (code ${e.code})` : ''}: ${e.message || 'unknown'}`, data);
  }
  return data.messages && data.messages[0] && data.messages[0].id;
}

const sendText = (to, body) =>
  graphPost({ to, type: 'text', text: { body, preview_url: false } });

const sendTemplate = (to, firstName) => {
  const c = cfg();
  return graphPost({
    to, type: 'template',
    template: {
      name: c.template, language: { code: c.lang },
      components: [{ type: 'body', parameters: [{ type: 'text', text: firstName }] }],
    },
  });
};

// Verify X-Hub-Signature-256 against the raw request body using the app secret.
function verifySignature(rawBody, header) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !header || !rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Flatten a webhook payload into { messages, statuses }. Only events for OUR phone number.
function parseWebhook(payload) {
  const out = { messages: [], statuses: [] };
  const ourId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  for (const entry of (payload && payload.entry) || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      if (ch.field !== 'messages') continue;
      if (ourId && v.metadata && v.metadata.phone_number_id !== ourId) continue;
      const names = {};
      for (const c of v.contacts || []) names[c.wa_id] = c.profile && c.profile.name;
      for (const m of v.messages || []) {
        const type = m.type || 'unknown';
        let body = null, media = null;
        if (type === 'text') body = m.text && m.text.body;
        else if (m[type] && typeof m[type] === 'object') {
          // image/document/video/audio/sticker: keep metadata for Phase 2; no download yet.
          media = m[type];
          body = m[type].caption || `[${type}]`;
        } else body = `[${type}]`;
        out.messages.push({ wamid: m.id, from: m.from, name: names[m.from] || null, type, body, media,
          createdAt: m.timestamp ? new Date(Number(m.timestamp) * 1000) : null });
      }
      for (const s of v.statuses || []) {
        const err = s.errors && s.errors[0];
        out.statuses.push({ wamid: s.id, status: s.status,
          error: err ? `${err.code}: ${err.title || err.message || ''}`.trim() : null });
      }
    }
  }
  return out;
}

module.exports = { sendText, sendTemplate, verifySignature, parseWebhook, WhatsAppError };
