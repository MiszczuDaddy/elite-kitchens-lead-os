const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const wa = require('./whatsapp');

const app = express();
app.disable('x-powered-by');

// Keep the raw body: Meta's webhook signature is computed over the exact bytes.
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

const log = (level, msg, extra) =>
  console[level === 'error' ? 'error' : 'log'](JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

// ---------- Public: health + Meta webhook (Meta cannot send our password) ----------
app.get('/healthz', async (_req, res) => {
  try { await db.pool.query('SELECT 1'); res.json({ ok: true, db: true }); }
  catch (e) { log('error', 'healthz db failure', { err: e.message }); res.status(503).json({ ok: false, db: false }); }
});

// Webhook verification handshake (Meta calls this once when you save the webhook).
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (mode === 'subscribe' && expected && token === expected) {
    log('info', 'webhook verified');
    return res.status(200).send(String(challenge));
  }
  log('warn', 'webhook verification rejected');
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  if (!wa.verifySignature(req.rawBody, req.get('x-hub-signature-256'))) {
    log('warn', 'webhook signature invalid or app secret missing');
    return res.sendStatus(401);
  }
  try {
    const { messages, statuses } = wa.parseWebhook(req.body);
    for (const m of messages) {
      const { conversationId } = await db.getOrCreateConversation(db.normalizePhone(m.from), m.name);
      const row = await db.insertMessage({ conversationId, wamid: m.wamid, direction: 'in',
        type: m.type, body: m.body, media: m.media, status: 'received', createdAt: m.createdAt });
      log('info', row ? 'inbound stored' : 'inbound duplicate ignored', { wamid: m.wamid, type: m.type });
    }
    for (const s of statuses) {
      const found = await db.updateStatus(s.wamid, s.status, s.error);
      log('info', 'status update', { wamid: s.wamid, status: s.status, matched: found, error: s.error });
    }
    res.sendStatus(200);
  } catch (e) {
    // 500 makes Meta retry; dedup makes the retry safe.
    log('error', 'webhook processing failed', { err: e.message });
    res.sendStatus(500);
  }
});

// ---------- Private: everything else needs the admin password ----------
function auth(req, res, next) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return res.status(503).send('ADMIN_PASSWORD is not set on the server.');
  const h = req.get('authorization') || '';
  const given = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':') : '';
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(pw).digest();
  if (crypto.timingSafeEqual(a, b)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Elite Kitchens"').sendStatus(401);
}
app.use(auth);
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/conversations', async (_req, res, next) => {
  try { res.json(await db.listConversations()); } catch (e) { next(e); }
});
app.get('/api/conversations/:id/messages', async (req, res, next) => {
  try { res.json(await db.listMessages(Number(req.params.id))); } catch (e) { next(e); }
});

// Start (or restart) a conversation by sending the approved template.
app.post('/api/start', async (req, res, next) => {
  try {
    const phone = db.normalizePhone(req.body.phone);
    const name = String(req.body.name || '').trim();
    if (phone.length < 9) return res.status(400).json({ error: 'Enter a full number with country code, e.g. +353851234567' });
    if (!name) return res.status(400).json({ error: 'Enter the customer first name (used in the template).' });
    const { conversationId } = await db.getOrCreateConversation(phone, name);
    const tpl = process.env.WHATSAPP_TEMPLATE_NAME || 'elite_kitchens_new_lead';
    try {
      const wamid = await wa.sendTemplate(phone, name);
      await db.insertMessage({ conversationId, wamid, direction: 'out', type: 'template',
        body: `[template: ${tpl}] Hi ${name}, thanks for your enquiry with Elite Kitchens...`, status: 'sent' });
      res.json({ conversationId });
    } catch (e) {
      log('error', 'template send failed', { err: e.message, details: e.details });
      await db.insertMessage({ conversationId, direction: 'out', type: 'template', body: `[template: ${tpl}]`,
        status: 'failed', error: e.message });
      res.status(502).json({ error: e.message, conversationId });
    }
  } catch (e) { next(e); }
});

// Free-text reply. WhatsApp only allows this within 24h of the customer's last message.
app.post('/api/conversations/:id/send', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = String(req.body.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Message is empty.' });
    const c = await db.pool.query(
      `SELECT ct.phone,
              (SELECT max(created_at) FROM messages WHERE conversation_id = cv.id AND direction = 'in') AS last_in
         FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id WHERE cv.id = $1`, [id]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Conversation not found.' });
    const { phone, last_in } = c.rows[0];
    if (!last_in || Date.now() - new Date(last_in).getTime() > 24 * 3600 * 1000) {
      return res.status(409).json({ error: 'Outside WhatsApp\'s 24-hour window: the customer must message first, or start a new conversation with the template.' });
    }
    try {
      const wamid = await wa.sendText(phone, body);
      await db.insertMessage({ conversationId: id, wamid, direction: 'out', type: 'text', body, status: 'sent' });
      res.json({ ok: true });
    } catch (e) {
      log('error', 'text send failed', { err: e.message, details: e.details });
      await db.insertMessage({ conversationId: id, direction: 'out', type: 'text', body, status: 'failed', error: e.message });
      res.status(502).json({ error: e.message });
    }
  } catch (e) { next(e); }
});

app.use((err, _req, res, _next) => {
  log('error', 'unhandled', { err: err.message });
  res.status(500).json({ error: 'Server error' });
});

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  await db.migrate();
  const port = process.env.PORT || 3000;
  app.listen(port, () => log('info', 'listening', { port }));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { app };
