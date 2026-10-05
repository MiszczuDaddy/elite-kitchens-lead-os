// Phase 6.1 M1: "Reopen conversation", a general WhatsApp capability (docs/PHASE6_1_PLAN.md). Not tied to quotes: it works for any
// customer whose 24-hour window is closed. It sends the approved Reopen template. Sending it does NOT reopen free-form messaging:
// that happens only when the CUSTOMER replies (the webhook then updates lastInboundAt, exactly as it does today, so nothing in the
// webhook changes). The window state itself is worked out by windowState.js, shared with the screen.
//   conversations/{phone}.reopen = { state: 'sending' | 'sent' | 'failed' | 'unknown', requestId, claimedAt, sentAt, wamid,
//                                    templateName, by, error }          (the latest Reopen only; the chat keeps the messages)
// Same rule as the Meta lead welcome (leads.js): the send is CLAIMED first, and a send we cannot confirm is flagged "not
// confirmed" and never retried automatically. Meta offers no idempotency key, so this claim is what stops a double click, a
// retry after a timeout or two members of staff from sending twice. At most one Reopen template per customer per 24 hours.
const { HttpsError } = require('firebase-functions/v2/https');
const { Timestamp, FieldValue } = require('firebase-admin/firestore');
const store = require('./store');
const WS = require('./windowState');
const { normalizePhone } = require('./whatsapp');

const TZ = 'Europe/Dublin';
const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
const SEND_TIMEOUT_MS = 20000;
const log = (level, msg, extra) => console[level === 'error' ? 'error' : 'log'](JSON.stringify({ level, msg, ...extra }));
const bad = (msg) => new HttpsError('invalid-argument', msg);
const refused = (msg, details) => new HttpsError('failed-precondition', msg, details);

// Plain-English reasons for the Meta errors staff are most likely to meet (codes: Meta's WhatsApp error-code list).
const FRIENDLY = {
  132001: "WhatsApp doesn't know this template. It may not be approved yet, or its name or language is wrong.",
  132015: 'WhatsApp has paused this template because of low quality.',
  132016: 'WhatsApp has disabled this template.',
  132000: "The template's settings don't match what Elite OS sends.",
  132012: "The template's settings don't match what Elite OS sends.",
  131026: "WhatsApp can't deliver to this number (it may not be on WhatsApp).",
  131049: "WhatsApp held the message back to keep customers' inboxes healthy. Try again after 24 hours.",
  131050: 'This customer has chosen not to receive these messages.',
  131056: 'Too many messages to this number just now. Try again later.',
  130429: 'WhatsApp is busy. Try again in a minute.',
};
const refusalText = (e) => (e && e.code && FRIENDLY[e.code] ? `${FRIENDLY[e.code]} (code ${e.code})`
  : e && e.code ? `WhatsApp refused the template (code ${e.code}).` : 'WhatsApp is not set up to send this template.');
const NOT_CONFIRMED = 'Not confirmed: we could not tell whether WhatsApp sent the template. Check this chat before trying again; Elite OS will not send it a second time by itself.';

// Logs and stored errors never hold customer details: only a code and a short message with long digit runs (numbers) removed.
const safe = (s) => String(s || '').replace(/\d{7,}/g, '[number]').slice(0, 200);
const when = (ms) => new Intl.DateTimeFormat('en-IE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false, day: 'numeric', month: 'short' }).format(new Date(ms)).replace(',', ' at');

// Record how the send ended, unless the conversation is gone (customer erased) or a newer Reopen has taken over.
// Returns whether it was recorded: false means there is no conversation to write to any more, and nothing must recreate it.
async function settle(db, convRef, requestId, patch) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(convRef);
    if (!snap.exists || !snap.data().reopen || snap.data().reopen.requestId !== requestId) return false;
    tx.update(convRef, patch);
    return true;
  });
}

// Meta accepted the template: record "sent" on the conversation AND the chat message in ONE transaction. Together, because the
// screen shows "waiting for the customer" the moment the Reopen is recorded, and Meta's delivery status can arrive within
// milliseconds: if the status came first (it leaves a stub message) it keeps both its status and its reason, which a separate,
// later write of the message would otherwise overwrite. Also nothing is written if the customer was erased meanwhile.
// Returns whether it was recorded.
async function recordSent(db, convRef, requestId, { wamid, body, nowMs }) {
  const msgRef = convRef.collection('messages').doc(wamid);
  return db.runTransaction(async (tx) => {
    const [conv, msg] = await Promise.all([tx.get(convRef), tx.get(msgRef)]);
    if (!conv.exists || !conv.data().reopen || conv.data().reopen.requestId !== requestId) return false;
    tx.update(convRef, { 'reopen.state': 'sent', 'reopen.sentAt': Timestamp.fromMillis(nowMs), 'reopen.wamid': wamid,
      updatedAt: FieldValue.serverTimestamp(), lastMessage: String(body).slice(0, 120), lastMessageType: 'template', lastMessageDirection: 'out' });
    const base = { wamid, direction: 'out', type: 'template', body, media: null, createdAt: Timestamp.now() };
    if (msg.exists) tx.set(msgRef, base, { merge: true });                  // a delivery status that beat us keeps its status and its error
    else tx.set(msgRef, { ...base, status: 'sent', error: null });
    return true;
  });
}

// cfg: { reopenTemplate, reopenLang, reopenTimeoutMs } (plain settings, not secrets). wa: the WhatsApp client.
async function reopen({ db, wa, cfg }, actor, data, { nowMs = Date.now() } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('Missing details.');
  for (const k of Object.keys(data)) if (!['phone', 'requestId'].includes(k)) throw bad(`Unknown field: ${k}`);
  const phone = normalizePhone(data.phone);
  if (phone.length < 9) throw bad('Missing customer.');
  if (typeof data.requestId !== 'string' || !REQUEST_ID.test(data.requestId)) throw bad('Missing request id.');
  const requestId = data.requestId;
  const name = (cfg && cfg.reopenTemplate) || 'elite_kitchens_reopen', lang = (cfg && cfg.reopenLang) || 'en';
  const convRef = db.collection('conversations').doc(phone), contactRef = db.collection('contacts').doc(phone);

  // 1. Claim, in one transaction: the same request again returns what happened; otherwise the window must be closed and the
  //    24-hour allowance unused. Only one caller can win.
  const claim = await db.runTransaction(async (tx) => {
    const [conv, contact] = await Promise.all([tx.get(convRef), tx.get(contactRef)]);
    if (!conv.exists) throw new HttpsError('not-found', 'Customer not found.');
    const c = conv.data();
    if (c.reopen && c.reopen.requestId === requestId) return { existing: true, state: c.reopen.state, error: c.reopen.error || null };
    const msg = c.reopen && c.reopen.wamid ? await tx.get(convRef.collection('messages').doc(c.reopen.wamid)) : null;
    const st = WS.windowStatus(c, nowMs, msg && msg.exists ? msg.data() : null);
    if (st.state === 'open') throw refused('The 24-hour window is open: just send a normal message.');
    if (!st.canReopen) {
      const r = st.reopen;
      throw refused(r.kind === 'undelivered'
        ? `WhatsApp could not deliver the last template${r.error ? ` (${r.error})` : ''}. Try again after ${when(st.nextReopenAt)}.`
        : `A Reopen template was already sent to this customer (${when(r.at)}). Only one can be sent every 24 hours: wait for their reply, or try again after ${when(st.nextReopenAt)}.`,
      { nextReopenAt: st.nextReopenAt });
    }
    tx.update(convRef, { reopen: { state: 'sending', requestId, claimedAt: Timestamp.fromMillis(nowMs), by: actor.id, templateName: name } });
    return { existing: false, first: WS.firstName((contact.exists && contact.data().name) || c.name) };
  });
  if (claim.existing) {
    if (claim.state === 'failed' || claim.state === 'unknown') throw new HttpsError('unavailable', claim.error || 'The template was not sent.');
    return { ok: true, existing: true, state: claim.state };
  }

  // 2. Send. Meta refused (definite: nothing was sent) -> failed, safe to try again. Anything else -> not confirmed.
  const body = `[template: ${name}] ${WS.reopenText(claim.first)}`;
  let wamid;
  try {
    wamid = await wa.sendTemplateByName(phone, { name, lang, params: [claim.first] }, { timeoutMs: (cfg && cfg.reopenTimeoutMs) || SEND_TIMEOUT_MS });
  } catch (e) {
    const definite = !!e && e.definite === true;
    const text = definite ? refusalText(e) : NOT_CONFIRMED;
    log('error', definite ? 'reopen template refused' : 'reopen template not confirmed', { code: (e && e.code) || null, err: safe(e && e.message) });
    let recorded = false;
    try { recorded = await settle(db, convRef, requestId, { 'reopen.state': definite ? 'failed' : 'unknown', 'reopen.error': text }); } catch (e2) { log('error', 'reopen record failed', { err: safe(e2.message) }); }
    if (recorded) await store.storeFailedOutbound(db, phone, { type: 'template', body: `[template: ${name}]`, error: text }).catch(() => {});
    throw new HttpsError('unavailable', text);
  }

  // 3. Meta accepted it. Record it (the staff member is told it worked even if this write fails, because the message really was
  //    sent: the claim then stays "sending" and is shown as not confirmed). If the customer was erased meanwhile, nothing is recreated.
  try { await recordSent(db, convRef, requestId, { wamid, body, nowMs }); }
  catch (e) { log('error', 'reopen record failed', { wamid, err: safe(e.message) }); }
  log('info', 'reopen template sent', { wamid });
  return { ok: true, existing: false, state: 'sent' };
}

module.exports = { reopen, FRIENDLY, NOT_CONFIRMED };
