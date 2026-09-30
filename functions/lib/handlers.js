// Request logic, independent of the Cloud Functions wrappers so it can be tested directly.
const { HttpsError } = require('firebase-functions/v2/https');
const store = require('./store');
const mediaLib = require('./media');
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

async function webhookReceive({ rawBody, body, signature }, deps) {
  const { db, cfg } = deps;
  if (!verifySignature(rawBody, signature, cfg.appSecret)) {
    log('warn', 'webhook signature invalid or app secret missing'); return 401;
  }
  try {
    const { messages, statuses } = parseWebhook(body, cfg.phoneId);
    for (const m of messages) {
      const phone = normalizePhone(m.from);
      const stored = await store.storeInbound(db, { ...m, from: phone });
      log('info', stored ? 'inbound stored' : 'inbound duplicate ignored', { wamid: m.wamid, type: m.type });
      // Media: download now (a Meta retry of a still-missing file tries again). A media failure is recorded on the
      // message for staff to retry; it must never turn the webhook into a 500 (that would make Meta retry and risk disabling it).
      if (m.media && deps.bucket) {
        try { await processMedia(deps, phone, m.wamid, cfg.mediaTimeoutMs || 20000); }
        catch (e) { log('error', 'media processing failed', { wamid: m.wamid, err: e.message }); }
      }
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

// Download (or retry) the media of one stored message into Storage and record the result on it.
async function processMedia({ db, wa, bucket }, phone, msgId, timeoutMs) {
  const msg = await store.getMessage(db, phone, msgId);
  if (!msg || !msg.media) return { status: 'none' };
  if (msg.media.status === 'stored' && msg.media.storagePath) return { status: 'stored' };
  const r = await mediaLib.downloadInbound({ wa, bucket, phone, msgId, media: msg.media, timeoutMs });
  await store.setMediaState(db, phone, msgId, r);
  log(r.status === 'stored' ? 'info' : 'warn', 'media ' + r.status, { wamid: msgId, size: r.size, err: r.error });
  return r;
}

// ---- Staff actions (callable) -------------------------------------------------------------
// Sets the "staff" custom claim for allowlisted, email-verified accounts. Firestore rules key off it.
async function claimAccess(auth, { adminAuth, cfg }) {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  if (!isAllowedUser(auth, cfg)) {
    // Removed from the allowlist? Revoke any claim they still carry so Firestore rules stop serving them.
    if (auth.token && auth.token.staff === true) await adminAuth.setCustomUserClaims(auth.uid, { staff: false });
    throw new HttpsError('permission-denied', 'This Google account is not authorised for Elite Kitchens.');
  }
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

const CONTACT_FIELDS = { name: 100, email: 200, location: 100, projectType: 60, budget: 60, source: 60, notes: 5000 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Whitelist + trim + length-limit. Empty string clears a field (stored as null). Unknown keys are rejected.
function cleanContactFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpsError('invalid-argument', 'Missing fields.');
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (!(k in CONTACT_FIELDS)) throw new HttpsError('invalid-argument', `Unknown field: ${k}`);
    if (v != null && typeof v !== 'string') throw new HttpsError('invalid-argument', `${k} must be text.`);
    const t = String(v || '').trim();
    if (t.length > CONTACT_FIELDS[k]) throw new HttpsError('invalid-argument', `${k} is too long (max ${CONTACT_FIELDS[k]} characters).`);
    if (k === 'email' && t && !EMAIL_RE.test(t)) throw new HttpsError('invalid-argument', 'That email address does not look right.');
    out[k] = t || null;
  }
  if (!Object.keys(out).length) throw new HttpsError('invalid-argument', 'Nothing to save.');
  return out;
}

async function updateContact(auth, data, { db, cfg }) {
  assertStaff(auth, cfg);
  const phone = normalizePhone(data && data.phone);
  if (!phone) throw new HttpsError('invalid-argument', 'Missing phone.');
  const fields = cleanContactFields(data.fields);
  if (!(await store.updateContact(db, phone, fields))) throw new HttpsError('not-found', 'Conversation not found.');
  return { ok: true };
}

async function markRead(auth, data, { db, cfg }) {
  assertStaff(auth, cfg);
  const phone = normalizePhone(data && data.phone);
  if (!phone) throw new HttpsError('invalid-argument', 'Missing phone.');
  if (!(await store.markRead(db, phone))) throw new HttpsError('not-found', 'Conversation not found.');
  return { ok: true };
}

const ASK = (data) => ({ phone: normalizePhone(data && data.phone), id: String((data && data.id) || '') });

// Short-lived signed link so staff can view/download a stored file. The bucket itself is closed to browsers.
async function mediaUrl(auth, data, { db, cfg, bucket }) {
  assertStaff(auth, cfg);
  const { phone, id } = ASK(data);
  if (!phone || !id) throw new HttpsError('invalid-argument', 'Missing phone or message id.');
  const msg = await store.getMessage(db, phone, id);
  const m = msg && msg.media;
  if (!m || m.status !== 'stored' || !m.storagePath) throw new HttpsError('not-found', 'That file is not available yet.');
  const path = m.storagePath;
  if (!path.startsWith(`media/${phone}/`)) throw new HttpsError('permission-denied', 'Bad file path.');     // defence in depth
  const url = await mediaLib.signedUrl(bucket, path, { filename: m.filename, mime: m.mimeType, download: !!(data && data.download) });
  return { url, mimeType: m.mimeType || null, filename: m.filename || null, size: m.size || null };
}

async function retryMedia(auth, data, deps) {
  assertStaff(auth, deps.cfg);
  const { phone, id } = ASK(data);
  if (!phone || !id) throw new HttpsError('invalid-argument', 'Missing phone or message id.');
  const msg = await store.getMessage(deps.db, phone, id);
  if (!msg || !msg.media) throw new HttpsError('not-found', 'Message not found.');
  const r = await processMedia(deps, phone, id, 90000);
  return { status: r.status, error: r.error || null };
}

// Send a file the browser already uploaded to uploads/{uid}/... : validate it, hand it to WhatsApp, keep our own copy.
async function sendMedia(auth, data, { db, wa, cfg, bucket }) {
  assertStaff(auth, cfg);
  const phone = normalizePhone(data && data.phone);
  const uploadPath = String((data && data.uploadPath) || '');
  const caption = String((data && data.caption) || '').trim();
  if (!phone || !uploadPath) throw new HttpsError('invalid-argument', 'Missing phone or file.');
  if (caption.length > 1024) throw new HttpsError('invalid-argument', 'Caption is too long (max 1024 characters).');
  if (!uploadPath.startsWith(`uploads/${auth.uid}/`) || uploadPath.includes('..')) throw new HttpsError('permission-denied', 'Bad upload path.');
  const conv = await store.getConversation(db, phone);
  if (!conv) throw new HttpsError('not-found', 'Conversation not found.');
  const file = bucket.file(uploadPath);
  const cleanup = () => file.delete({ ignoreNotFound: true }).catch(() => {});
  const lastIn = conv.lastInboundAt && conv.lastInboundAt.toMillis();
  if (!lastIn || Date.now() - lastIn > WINDOW_MS) {
    await cleanup();
    throw new HttpsError('failed-precondition', "Outside WhatsApp's 24-hour window: the customer must message first, or start a new conversation with the template.");
  }
  let meta;
  try { [meta] = await file.getMetadata(); } catch (e) { throw new HttpsError('not-found', 'The uploaded file was not found. Please try again.'); }
  const mime = mediaLib.baseMime(meta.contentType);
  const size = Number(meta.size);
  let kind;
  try { kind = mediaLib.classifyForSend(mime, size); } catch (e) { await cleanup(); throw e; }
  const filename = mediaLib.safeName(data.filename || uploadPath.split('/').pop().replace(/^\d+-\w+-/, ''), mime, 'file');
  const shown = kind === 'audio' ? '' : caption;
  try {
    const [buf] = await file.download();
    const mediaId = await wa.uploadMedia(buf, mime, filename);
    const wamid = await wa.sendMedia(phone, kind, mediaId, { caption: shown, filename });
    const finalPath = mediaLib.objectPath(phone, wamid, filename);
    await file.move(finalPath);
    await store.storeOutbound(db, phone, { wamid, type: kind, body: shown || `[${kind}]`,
      media: { mimeType: mime, filename: mediaLib.displayName(data.filename) || filename, size, caption: shown || null, storagePath: finalPath, status: 'stored', waMediaId: mediaId } });
    return { ok: true };
  } catch (e) {
    log('error', 'media send failed', { err: e.message, details: e.details });
    await cleanup();
    await store.storeFailedOutbound(db, phone, { type: kind, body: shown || `[${kind}]`, error: e.message });
    throw new HttpsError('unavailable', e.message);
  }
}

module.exports = { mediaUrl, retryMedia, sendMedia, processMedia, updateContact, markRead, webhookVerify, webhookReceive, claimAccess, startConversation, sendReply, isAllowedUser };
