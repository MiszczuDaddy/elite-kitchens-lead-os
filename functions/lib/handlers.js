// Request logic, independent of the Cloud Functions wrappers so it can be tested directly.
const { HttpsError } = require('firebase-functions/v2/https');
const store = require('./store');
const { verifySignature, parseWebhook, normalizePhone } = require('./whatsapp');

const WINDOW_MS = 24 * 3600 * 1000;
const log = (level, msg, extra) =>
  console[level === 'error' ? 'error' : 'log'](JSON.stringify({ level, msg, ...extra }));

const allowedList = (cfg) => String(cfg.allowedEmails || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function isAllowedUser(auth, cfg) {
  const t = auth && auth.token;
  return !!(t && t.email_verified === true && t.email && allowedList(cfg).includes(t.email.toLowerCase()));
}
function assertStaff(auth, cfg) {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  if (!(auth.token.staff === true && isAllowedUser(auth, cfg))) throw new HttpsError('permission-denied', 'This account is not authorised.');
}

// ---- Meta webhook -------------------------------------------------------------------------
function webhookVerify(query, cfg) {
  if (query['hub.mode'] === 'subscribe' && cfg.verifyToken && query['hub.verify_token'] === cfg.verifyToken) {
    log('info', 'webhook verified'); return { status: 200, body: String(query['hub.challenge']) };
  }
  log('warn', 'webhook verification rejected'); return { status: 403, body: 'Forbidden' };
}

async function webhookReceive({ rawBody, body, signature }, { db, cfg }) {
  if (!verifySignature(rawBody, signature, cfg.appSecret)) {
    log('warn', 'webhook signature invalid or app secret missing'); return 401;
  }
  try {
    const { messages, statuses } = parseWebhook(body, cfg.phoneId);
    for (const m of messages) {
      const stored = await store.storeInbound(db, { ...m, from: normalizePhone(m.from) });
      log('info', stored ? 'inbound stored' : 'inbound duplicate ignored', { wamid: m.wamid, type: m.type });
    }
    for (const s of statuses) {
      await store.applyStatus(db, { ...s, phone: normalizePhone(s.phone) });
      log('info', 'status update', { wamid: s.wamid, status: s.status, error: s.error });
    }
    return 200;
  } catch (e) {
    log('error', 'webhook processing failed', { err: e.message });
    return 500;   // Meta retries; dedup makes the retry safe
  }
}

// ---- Staff actions (callable) -------------------------------------------------------------
// Sets the "staff" custom claim for allowlisted, email-verified accounts. Firestore rules key off it.
async function claimAccess(auth, { adminAuth, cfg }) {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  if (!isAllowedUser(auth, cfg)) throw new HttpsError('permission-denied', 'This Google account is not authorised for Elite Kitchens.');
  await adminAuth.setCustomUserClaims(auth.uid, { staff: true });
  return { ok: true };
}

async function startConversation(auth, data, { db, wa, cfg }) {
  assertStaff(auth, cfg);
  const phone = normalizePhone(data && data.phone);
  const name = String((data && data.name) || '').trim();
  if (phone.length < 9) throw new HttpsError('invalid-argument', 'Enter a full number with country code, e.g. +353851234567');
  if (!name) throw new HttpsError('invalid-argument', 'Enter the customer first name (used in the template).');
  await store.ensureConversation(db, phone, name);
  const body = `[template: ${cfg.template}] Hi ${name}, thanks for your enquiry with Elite Kitchens...`;
  try {
    const wamid = await wa.sendTemplate(phone, name);
    await store.storeOutbound(db, phone, { wamid, type: 'template', body });
    return { phone };
  } catch (e) {
    log('error', 'template send failed', { err: e.message, details: e.details });
    await store.storeFailedOutbound(db, phone, { type: 'template', body: `[template: ${cfg.template}]`, error: e.message });
    throw new HttpsError('unavailable', e.message);
  }
}

async function sendReply(auth, data, { db, wa, cfg }) {
  assertStaff(auth, cfg);
  const phone = normalizePhone(data && data.phone);
  const body = String((data && data.body) || '').trim();
  if (!body) throw new HttpsError('invalid-argument', 'Message is empty.');
  const conv = await store.getConversation(db, phone);
  if (!conv) throw new HttpsError('not-found', 'Conversation not found.');
  const lastIn = conv.lastInboundAt && conv.lastInboundAt.toMillis();
  if (!lastIn || Date.now() - lastIn > WINDOW_MS) {
    throw new HttpsError('failed-precondition', "Outside WhatsApp's 24-hour window: the customer must message first, or start a new conversation with the template.");
  }
  try {
    const wamid = await wa.sendText(phone, body);
    await store.storeOutbound(db, phone, { wamid, type: 'text', body });
    return { ok: true };
  } catch (e) {
    log('error', 'text send failed', { err: e.message, details: e.details });
    await store.storeFailedOutbound(db, phone, { type: 'text', body, error: e.message });
    throw new HttpsError('unavailable', e.message);
  }
}

module.exports = { webhookVerify, webhookReceive, claimAccess, startConversation, sendReply, isAllowedUser };
