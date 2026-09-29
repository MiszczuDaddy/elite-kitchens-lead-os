const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

async function migrate() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
}

// Digits only: "+353 89 966 1073" -> "353899661073" (the form WhatsApp uses).
function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '');
}

async function getOrCreateConversation(phone, name) {
  const { rows } = await pool.query(
    `INSERT INTO contacts (phone, name) VALUES ($1, $2)
     ON CONFLICT (phone) DO UPDATE SET name = COALESCE(contacts.name, EXCLUDED.name)
     RETURNING id`, [phone, name || null]);
  const contactId = rows[0].id;
  const c = await pool.query(
    `INSERT INTO conversations (contact_id) VALUES ($1)
     ON CONFLICT (contact_id) DO UPDATE SET updated_at = now()
     RETURNING id`, [contactId]);
  return { contactId, conversationId: c.rows[0].id };
}

// Returns the inserted row, or null if this WhatsApp message id was already stored.
async function insertMessage(m) {
  const { rows } = await pool.query(
    `INSERT INTO messages
       (conversation_id, whatsapp_message_id, direction, message_type, body, media, status, error, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9, now()))
     ON CONFLICT (whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [m.conversationId, m.wamid || null, m.direction, m.type || 'text', m.body || null,
     m.media ? JSON.stringify(m.media) : null, m.status || null, m.error || null, m.createdAt || null]);
  if (rows[0]) await pool.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [m.conversationId]);
  return rows[0] || null;
}

// Status webhooks can arrive out of order; never move backwards (read -> delivered).
const RANK = { failed: 0, sent: 1, delivered: 2, read: 3 };
async function updateStatus(wamid, status, error) {
  const { rows } = await pool.query('SELECT id, status FROM messages WHERE whatsapp_message_id = $1', [wamid]);
  if (!rows[0]) return false;
  const cur = rows[0].status;
  if (status !== 'failed' && cur in RANK && RANK[cur] >= RANK[status]) return true;
  await pool.query('UPDATE messages SET status = $2, error = COALESCE($3, error) WHERE id = $1',
    [rows[0].id, status, error || null]);
  return true;
}

async function listConversations() {
  const { rows } = await pool.query(
    `SELECT cv.id, ct.phone, ct.name, cv.updated_at,
            (SELECT body FROM messages m WHERE m.conversation_id = cv.id ORDER BY m.id DESC LIMIT 1) AS last_body
       FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id
      ORDER BY cv.updated_at DESC`);
  return rows;
}

async function listMessages(conversationId) {
  const { rows } = await pool.query(
    `SELECT id, direction, message_type, body, media, status, error, created_at
       FROM messages WHERE conversation_id = $1 ORDER BY created_at, id`, [conversationId]);
  return rows;
}

module.exports = { pool, migrate, normalizePhone, getOrCreateConversation, insertMessage,
  updateStatus, listConversations, listMessages };
