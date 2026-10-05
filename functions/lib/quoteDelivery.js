// Phase 6.1 M2: the delivery foundation (docs/PHASE6_1_PLAN.md). Sends a quote's exact PDF through one or more channels
// (WhatsApp, email: adapters arrive in M3 and M4) and marks the quote Sent ONLY once a channel confirms delivery. It knows
// nothing about WhatsApp or Gmail: a channel is an adapter behind one small interface. The quote itself (statuses, the pipeline
// rules, what is frozen) stays in quotes.js: this module calls its prepare / commit pieces and never duplicates a rule.
//
//   quotes/{id}/deliveries/{did}   one per channel per send request. did = {version}-{hash of requestId}-{channel}
//     state   queued -> sending -> sent | failed | unknown          (and: cancelled)
//   A send is   1. prepare   the same checks and stored PDF as Phase 6's send; the draft is locked; NOTHING is marked sent
//               2. deliver   one channel at a time, each CLAIMED before the provider is contacted
//               3. commit    in the transaction that records the FIRST channel confirmed as delivered
//
// Rules that make a double click, a retry after a timeout or two members of staff safe (Meta and Gmail offer no idempotency key):
//   * the same requestId again sends nothing new (it only finishes channels still "queued");
//   * moving a delivery to "sending" is a compare-and-set in a transaction: one winner;
//   * a send we cannot confirm (provider timeout, 5xx, a crash after the claim) is "unknown": NEVER retried by itself; staff
//     settle it ("it arrived" / "it did not arrive");
//   * a channel that fails is never recorded as sent, and one channel failing never undoes another's success;
//   * retrying a failed channel resends only that channel.
// Logs and stored errors hold codes and plain sentences only: never names, numbers, addresses or message text.
const crypto = require('crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const quotes = require('./quotes');

const { onlyKeys, text, bad, refused, checkRev, quoteRef, versionRef, capped, at, view, REQUEST_ID } = quotes.H;

const CHANNEL_ORDER = ['whatsapp', 'email'];       // the order channels are tried in
const STUCK_MS = 3 * 60 * 1000;                    // a send still "sending" after this long is treated as not confirmed
const HISTORY_MAX = 20;
const MESSAGE_MAX = 2000;                          // unless the channel says otherwise (adapter.maxMessage)
const DELIVERY_ID = /^\d{1,3}-[0-9a-f]{12}-[a-z]{3,10}$/;
const NOT_CONFIRMED = 'Not confirmed: we could not tell whether this was delivered. Check, then choose "It arrived" or "It did not arrive". Elite OS will not send it a second time by itself.';

// What an adapter throws. definite: nothing was sent (the channel refused, or the message was never handed over): recorded as
// failed, safe to retry. Not definite (or any other error): we cannot tell: recorded as unknown. text: a plain sentence for staff.
class ChannelError extends Error {
  constructor(message, { code = 'failed', definite = false } = {}) { super(message); this.channelCode = code; this.definite = definite; }
}

const log = (level, msg, extra) => console[level === 'error' ? 'error' : 'log'](JSON.stringify({ level, msg, ...extra }));
const hash12 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const deliveryId = (n, requestId, channel) => `${n}-${hash12(requestId)}-${channel}`;
const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : null);
const effectiveState = (d, nowMs) => (d.state === 'sending' && ms(d.claimedAt) != null && nowMs - ms(d.claimedAt) > STUCK_MS ? 'unknown' : d.state);
const byChannel = (a, b) => CHANNEL_ORDER.indexOf(a.channel) - CHANNEL_ORDER.indexOf(b.channel);
const entry = (a, extra) => ({ at: a.now, by: a.actor.id, ...extra });

// ---------------------------------------------------------------- the request ------------------------------------------------
function cleanChannels(deps, data) {
  if (!Array.isArray(data.channels) || !data.channels.length) throw bad('Choose how to send it.');
  const set = new Set();
  for (const c of data.channels) {
    if (typeof c !== 'string' || !CHANNEL_ORDER.includes(c)) throw bad('That way of sending is not known.');
    if (!deps.channels || !deps.channels[c]) throw bad('That way of sending is not available.');
    set.add(c);
  }
  return CHANNEL_ORDER.filter((c) => set.has(c));
}
function cleanMessages(deps, channels, data) {
  const m = data.messages;
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw bad('Write the message to send.');
  for (const k of Object.keys(m)) if (!channels.includes(k)) throw bad(`Unknown message: ${k}`);
  const out = {};
  for (const c of channels) {
    const t = text(m[c], deps.channels[c].maxMessage || MESSAGE_MAX, 'The message');
    if (!t) throw bad('Write the message to send.');
    out[c] = t;
  }
  return out;
}
function newDelivery(ctx, channel, message, actor) {
  return { quoteId: ctx.ref.id, phone: ctx.q.phone, version: ctx.n, channel, requestId: ctx.requestId, state: 'queued', attempts: 0, attemptId: null, message,
    to: channel === 'email' ? { email: ctx.customer.email || null } : null, pdf: ctx.pdf, provider: null, error: null, claimedAt: null, sentAt: null, failedAt: null,
    resolvedBy: null, history: [entry({ now: ctx.now, actor }, { event: 'queued' })], createdAt: ctx.now, createdBy: actor, updatedAt: ctx.now };
}

// ---------------------------------------------------------------- one attempt -----------------------------------------------
async function readPdf(bucket, pdf) {
  let buf;
  try { [buf] = await bucket.file(pdf.path).download(); }
  catch (e) { throw new ChannelError('The stored PDF could not be read, so nothing was sent.', { code: 'pdf_missing', definite: true }); }
  if (crypto.createHash('sha256').update(buf).digest('hex') !== pdf.sha256) throw new ChannelError('The stored PDF does not match the one that was prepared, so nothing was sent.', { code: 'pdf_changed', definite: true });
  return { bytes: buf, size: buf.length, sha256: pdf.sha256, path: pdf.path };
}
function classify(e) {
  if (e instanceof ChannelError) {
    return e.definite ? { state: 'failed', error: { code: e.channelCode, text: e.message } } : { state: 'unknown', error: { code: e.channelCode, text: e.message || NOT_CONFIRMED } };
  }
  return { state: 'unknown', error: { code: 'not_confirmed', text: NOT_CONFIRMED } };
}

// Claim one delivery, hand the exact PDF to its channel, record the outcome (and commit, if this is the first channel to
// confirm). Never throws for a provider problem: the outcome is recorded and returned.
async function attempt(deps, actor, id, did, { nowMs, retry = false, message = null } = {}) {
  const { db, bucket } = deps;
  const ref = quoteRef(db, id), dRef = ref.collection('deliveries').doc(did);
  // 1. claim: only a queued delivery (or, on an explicit retry, a failed one) can be claimed, and only one caller wins
  const claim = await db.runTransaction(async (tx) => {
    const [dSnap, qSnap] = await Promise.all([tx.get(dRef), tx.get(ref)]);
    if (!dSnap.exists || !qSnap.exists) return { skip: 'gone' };
    const d = dSnap.data(), eff = effectiveState(d, nowMs);
    if (!(eff === 'queued' || (retry && eff === 'failed'))) return { skip: eff };
    const attemptId = `${did}#${d.attempts + 1}`, now = at(nowMs);
    tx.update(dRef, { state: 'sending', attempts: d.attempts + 1, attemptId, claimedAt: now, error: null, ...(message ? { message } : {}),
      history: capped(d.history, entry({ now, actor }, { event: 'sending', attempt: d.attempts + 1 }), HISTORY_MAX), updatedAt: now });
    return { d: { ...d, message: message || d.message }, attemptId, attempt: d.attempts + 1, quoteRef: qSnap.data().ref, phone: qSnap.data().phone };
  });
  if (claim.skip) return { did, channel: null, state: claim.skip, skipped: true };

  // 2. send
  const channel = claim.d.channel, adapter = deps.channels && deps.channels[channel];
  let outcome;
  try {
    if (!adapter) throw new ChannelError('That way of sending is not available.', { code: 'unavailable', definite: true });
    const pdf = await readPdf(bucket, claim.d.pdf);
    const ctx = { quoteId: id, quoteRef: claim.quoteRef, version: claim.d.version, channel, phone: claim.phone, to: claim.d.to, message: claim.d.message, requestId: claim.d.requestId,
      deliveryId: did, attempt: claim.attempt, pdf, filename: `EliteKitchens-${claim.quoteRef}-v${claim.d.version}.pdf` };
    const check = adapter.check ? await adapter.check(ctx) : null;
    if (check && check.ok === false) throw new ChannelError(check.text || 'This cannot be sent.', { code: check.code || 'not_possible', definite: true });
    const r = await adapter.send(ctx);
    outcome = { state: 'sent', providerId: (r && r.providerId) || null };
  } catch (e) {
    outcome = classify(e);
    // Codes only: an unexpected error's own message could hold anything (a name, a number, the text), so only its kind is logged.
    log(outcome.state === 'failed' ? 'warn' : 'error', outcome.state === 'failed' ? 'quote delivery refused' : 'quote delivery not confirmed',
      { channel, code: outcome.error.code, kind: e instanceof ChannelError ? undefined : String((e && e.name) || 'Error') });
  }

  // 3. record. If the claim is no longer ours (staff settled a stalled send meanwhile), our late answer is not written.
  let committed = null, stale = false;
  try {
    await db.runTransaction(async (tx) => {
      committed = null; stale = false;                                            // a transaction can run more than once
      const dSnap = await tx.get(dRef);
      if (!dSnap.exists) { stale = true; return; }
      const d = dSnap.data();
      if (d.state !== 'sending' || d.attemptId !== claim.attemptId) { stale = true; return; }
      const st = outcome.state === 'sent' ? await quotes.readState(tx, db, id, d.version) : null;     // all reads first
      const now = at(nowMs), ev = entry({ now, actor }, { event: outcome.state, attempt: claim.attempt, ...(outcome.error ? { code: outcome.error.code } : {}) });
      tx.update(dRef, outcome.state === 'sent'
        ? { state: 'sent', sentAt: now, provider: { id: outcome.providerId }, error: null, history: capped(d.history, ev, HISTORY_MAX), updatedAt: now }
        : { state: outcome.state, ...(outcome.state === 'failed' ? { failedAt: now } : {}), error: outcome.error, history: capped(d.history, ev, HISTORY_MAX), updatedAt: now });
      if (st) committed = quotes.commitPrepared(tx, st, actor, nowMs, d.requestId, d.channel);
    });
  } catch (e) {
    log('error', 'quote delivery record failed', { channel, kind: String((e && e.name) || 'Error') });
    return { did, channel, state: 'unknown', error: { code: 'record_failed', text: NOT_CONFIRMED } };   // the claim stays: shown as not confirmed
  }
  if (stale) return { did, channel, state: 'stale', skipped: true };
  return { did, channel, state: outcome.state, error: outcome.error || null, committed: committed && committed.committed ? { stage: committed.stage, value: committed.value } : null };
}

// What the screen needs after any action: the quote, and each channel's state (an unconfirmed send shows as "unknown").
async function summary(deps, id, requestId, nowMs, extra = {}) {
  const ref = quoteRef(deps.db, id);
  const [qSnap, dSnaps] = await Promise.all([ref.get(), ref.collection('deliveries').where('requestId', '==', requestId).get()]);
  if (!qSnap.exists) throw new HttpsError('not-found', 'Quote not found.');                 // erased while it was being sent
  const q = qSnap.data();
  const deliveries = dSnaps.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byChannel).map((d) => ({
    id: d.id, channel: d.channel, version: d.version, state: effectiveState(d, nowMs), attempts: d.attempts, error: d.error || null, sentAt: ms(d.sentAt) }));
  return { ok: true, ...view(ref.id, q), requestId, sent: q.lastSendRequestId === requestId, deliveries, ...extra };
}
// Try, in channel order, every delivery of this request that is still waiting (a repeat of the same request finishes only those).
async function runQueued(deps, actor, id, requestId, nowMs) {
  const snaps = await quoteRef(deps.db, id).collection('deliveries').where('requestId', '==', requestId).get();
  const waiting = snaps.docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => d.state === 'queued').sort(byChannel);
  const out = [];
  for (const d of waiting) out.push(await attempt(deps, actor, id, d.id, { nowMs }));
  return out;
}
const committedOf = (results) => (results.find((r) => r.committed) || {}).committed || null;

// ---------------------------------------------------------------- deliver -----------------------------------------------------
// Two ways in. A DRAFT (no `version`): the same fields as Phase 6's sendQuote (revision, issue date, Quote Settings revision, the
// customer's details, the uploaded PDF, the pipeline choices) plus `channels` and `messages`: prepare, then deliver. An already
// SENT version (`version`, no PDF fields): deliver its stored PDF through more channels, with no new version and no pipeline change.
const SEND_KEYS = ['id', 'expectedRev', 'requestId', 'issueDate', 'settingsRev', 'customer', 'pdfUploadPath', 'pipeline'];
async function deliver(deps, actor, data, { nowMs = Date.now(), uid } = {}) {
  const { db } = deps;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('Missing details.');
  onlyKeys(data, [...SEND_KEYS, 'version', 'channels', 'messages']);
  const channels = cleanChannels(deps, data), messages = cleanMessages(deps, channels, data);
  let id = data.id, requestId = data.requestId;
  if (data.version == null) {
    const sendData = {};
    for (const k of SEND_KEYS) if (k in data) sendData[k] = data[k];
    await quotes.prepare(deps, actor, sendData, { nowMs, uid, inTx: (tx, ctx) => {          // the delivery records are created with the preparation
      for (const c of channels) tx.create(ctx.ref.collection('deliveries').doc(deliveryId(ctx.n, ctx.requestId, c)), newDelivery(ctx, c, messages[c], actor));
    } });
  } else {
    for (const k of SEND_KEYS) if (!['id', 'requestId'].includes(k) && k in data) throw bad(`Unknown field: ${k}`);
    await createForSent(deps, actor, data, channels, messages, nowMs);
  }
  const results = await runQueued(deps, actor, id, requestId, nowMs);
  return summary(deps, id, requestId, nowMs, { committed: committedOf(results) });
}
// Another channel for a version the customer already has: no prepare, no commit. The same request again creates nothing twice.
async function createForSent(deps, actor, data, channels, messages, nowMs) {
  const { db } = deps;
  const ref = quoteRef(db, data.id);
  if (typeof data.requestId !== 'string' || !REQUEST_ID.test(data.requestId)) throw bad('Missing request id.');
  if (!Number.isInteger(data.version) || data.version < 1) throw bad('Missing version.');
  await db.runTransaction(async (tx) => {
    const [qSnap, vSnap] = await Promise.all([tx.get(ref), tx.get(versionRef(ref, data.version))]);
    if (!qSnap.exists || !vSnap.exists) throw new HttpsError('not-found', 'Quote not found.');
    const v = vSnap.data();
    if (v.state !== 'sent' || !v.pdf) throw refused('Only a version that was sent can be sent again this way. Send the draft instead.');
    const dRefs = channels.map((c) => ref.collection('deliveries').doc(deliveryId(data.version, data.requestId, c)));
    const existing = await Promise.all(dRefs.map((r) => tx.get(r)));
    const ctx = { ref, q: qSnap.data(), n: data.version, requestId: data.requestId, pdf: v.pdf, customer: v.customer, now: at(nowMs) };
    channels.forEach((c, i) => { if (!existing[i].exists) tx.create(dRefs[i], newDelivery(ctx, c, messages[c], actor)); });
  });
}

// ---------------------------------------------------------------- retry, settle, cancel, mark sent ------------------------------
function deliveryRef(db, data) {
  const ref = quoteRef(db, data.id);
  if (typeof data.deliveryId !== 'string' || !DELIVERY_ID.test(data.deliveryId)) throw bad('Missing delivery.');
  return { ref, dRef: ref.collection('deliveries').doc(data.deliveryId) };
}
const todayOrYesterday = (date, nowMs) => date === quotes.dublinDate(nowMs) || date === quotes.addDays(quotes.dublinDate(nowMs), -1);

// Try a failed channel again, and only that channel. Never for one already delivered, in progress or not confirmed.
async function retry(deps, actor, data, { nowMs = Date.now() } = {}) {
  onlyKeys(data, ['id', 'deliveryId', 'message']);
  const { db } = deps;
  const { ref, dRef } = deliveryRef(db, data);
  const [dSnap, qSnap] = await Promise.all([dRef.get(), ref.get()]);
  if (!dSnap.exists || !qSnap.exists) throw new HttpsError('not-found', 'Delivery not found.');
  const d = dSnap.data(), q = qSnap.data(), eff = effectiveState(d, nowMs);
  if (eff === 'sent') throw refused('This was already delivered.');
  if (eff === 'sending') throw refused('This is being sent right now.');
  if (eff === 'unknown') throw refused('We could not confirm whether this arrived. Check, then choose "It arrived" or "It did not arrive".');
  if (eff === 'cancelled') throw refused('This send was cancelled.');
  let message = null;
  if (data.message != null) {
    const adapter = deps.channels && deps.channels[d.channel];
    message = text(data.message, (adapter && adapter.maxMessage) || MESSAGE_MAX, 'The message');
    if (!message) throw bad('Write the message to send.');
  }
  if (q.preparedSend && q.preparedSend.requestId === d.requestId) {                      // not yet marked sent: it must still carry today's date
    const prep = (await versionRef(ref, d.version).get()).data().prepared;
    if (!prep || !todayOrYesterday(prep.issueDate, nowMs)) throw refused('The date on this quote is out of date. Cancel the send and send it again.');
  }
  const r = await attempt(deps, actor, data.id, data.deliveryId, { nowMs, retry: true, message });
  if (r.skipped) throw refused(r.state === 'sent' ? 'This was already delivered.' : 'This is already being sent.');
  return summary(deps, data.id, d.requestId, nowMs, { committed: r.committed });
}

// Staff settle a send we could not confirm: "delivered" counts it as sent (and commits, like any confirmed delivery);
// "not_delivered" makes it a failure that can be retried.
async function resolve(deps, actor, data, { nowMs = Date.now() } = {}) {
  onlyKeys(data, ['id', 'deliveryId', 'outcome']);
  const { db } = deps;
  const { ref, dRef } = deliveryRef(db, data);
  if (!['delivered', 'not_delivered'].includes(data.outcome)) throw bad('Choose "It arrived" or "It did not arrive".');
  let requestId, committed = null;
  await db.runTransaction(async (tx) => {
    committed = null;
    const dSnap = await tx.get(dRef);
    if (!dSnap.exists) throw new HttpsError('not-found', 'Delivery not found.');
    const d = dSnap.data();
    if (effectiveState(d, nowMs) !== 'unknown') throw refused('Only a send that could not be confirmed can be settled this way.');
    requestId = d.requestId;
    const st = data.outcome === 'delivered' ? await quotes.readState(tx, db, data.id, d.version) : null;
    const now = at(nowMs), ev = entry({ now, actor }, { event: data.outcome === 'delivered' ? 'confirmed delivered' : 'confirmed not delivered' });
    tx.update(dRef, data.outcome === 'delivered'
      ? { state: 'sent', sentAt: now, provider: { id: null }, error: null, resolvedBy: actor.id, history: capped(d.history, ev, HISTORY_MAX), updatedAt: now }
      : { state: 'failed', failedAt: now, error: { code: 'confirmed_not_delivered', text: 'You confirmed that it did not arrive.' }, resolvedBy: actor.id, history: capped(d.history, ev, HISTORY_MAX), updatedAt: now });
    if (st) committed = quotes.commitPrepared(tx, st, actor, nowMs, d.requestId, d.channel);
  });
  return summary(deps, data.id, requestId, nowMs, { committed: committed && committed.committed ? { stage: committed.stage, value: committed.value } : null });
}

// Give up on a prepared send that has delivered nothing: the draft is unlocked and the stored PDF removed. Refused while any
// channel has delivered, is sending or could not be confirmed.
async function cancelSend(deps, actor, data, { nowMs = Date.now() } = {}) {
  onlyKeys(data, ['id', 'expectedRev']);
  const { db, bucket } = deps;
  const ref = quoteRef(db, data.id);
  let pdfPath = null;
  await db.runTransaction(async (tx) => {
    const qSnap = await tx.get(ref);
    if (!qSnap.exists) throw new HttpsError('not-found', 'Quote not found.');
    const q = qSnap.data();
    checkRev(q, data.expectedRev);
    if (!q.preparedSend) throw refused('There is no send in progress to cancel.');
    const n = q.preparedSend.version, vRef = versionRef(ref, n);
    const [vSnap, dSnaps] = await Promise.all([tx.get(vRef), tx.get(ref.collection('deliveries').where('requestId', '==', q.preparedSend.requestId))]);
    const states = dSnaps.docs.map((d) => effectiveState(d.data(), nowMs));
    if (states.includes('sent')) throw refused('A channel has already delivered this, so it cannot be cancelled.');
    if (states.includes('sending')) throw refused('A channel is sending right now. Wait a moment, then try again.');
    if (states.includes('unknown')) throw refused('A send could not be confirmed. Settle it first ("It arrived" / "It did not arrive"), then cancel.');
    pdfPath = vSnap.exists && vSnap.data().prepared ? vSnap.data().prepared.pdf.path : null;
    const now = at(nowMs);
    dSnaps.docs.forEach((d) => tx.update(d.ref, { state: 'cancelled', error: null, history: capped(d.data().history, entry({ now, actor }, { event: 'cancelled' }), HISTORY_MAX), updatedAt: now }));
    quotes.releasePrepared(tx, { ref, vRef, q }, actor, nowMs);
  });
  if (pdfPath) await bucket.file(pdfPath).delete({ ignoreNotFound: true }).catch(() => {});
  return { ok: true, ...view(ref.id, (await ref.get()).data()) };
}

// "I sent it myself": commit the prepared version as marked sent by hand, using the stored PDF, exactly like Phase 6's send.
// Records a "manual" delivery so the history shows how it was sent. Refused while a channel is sending right now.
async function markSent(deps, actor, data, { nowMs = Date.now() } = {}) {
  onlyKeys(data, ['id', 'expectedRev']);
  const { db } = deps;
  const ref = quoteRef(db, data.id);
  let requestId, committed = null;
  await db.runTransaction(async (tx) => {
    committed = null;
    const qSnap = await tx.get(ref);
    if (!qSnap.exists) throw new HttpsError('not-found', 'Quote not found.');
    const q = qSnap.data();
    checkRev(q, data.expectedRev);
    if (!q.preparedSend) throw refused('There is no send in progress to mark as sent.');
    const n = q.preparedSend.version;
    requestId = q.preparedSend.requestId;
    const st = await quotes.readState(tx, db, data.id, n);
    const dSnaps = await tx.get(ref.collection('deliveries').where('requestId', '==', requestId));
    if (dSnaps.docs.some((d) => effectiveState(d.data(), nowMs) === 'sending')) throw refused('A channel is sending right now. Wait a moment, then try again.');
    const prep = st.vSnap.exists ? st.vSnap.data().prepared : null;
    if (!prep) throw refused('This quote was changed by someone else. Please check it and try again.');
    const now = at(nowMs), manualId = deliveryId(n, requestId, 'manual');
    if (!dSnaps.docs.some((d) => d.id === manualId)) {
      tx.create(ref.collection('deliveries').doc(manualId), { quoteId: ref.id, phone: q.phone, version: n, channel: 'manual', requestId, state: 'sent', attempts: 0, attemptId: null, message: null,
        to: null, pdf: prep.pdf, provider: null, error: null, claimedAt: null, sentAt: now, failedAt: null, resolvedBy: actor.id,
        history: [entry({ now, actor }, { event: 'marked sent by hand' })], createdAt: now, createdBy: actor, updatedAt: now });
    }
    committed = quotes.commitPrepared(tx, st, actor, nowMs, requestId, 'manual');
  });
  return summary(deps, data.id, requestId, nowMs, { committed: committed && committed.committed ? { stage: committed.stage, value: committed.value } : null });
}

module.exports = { deliver, retry, resolve, cancelSend, markSent, ChannelError, effectiveState, deliveryId, STUCK_MS, CHANNEL_ORDER, NOT_CONFIRMED };
