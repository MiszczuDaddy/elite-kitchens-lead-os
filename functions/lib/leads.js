// Meta Lead Ads -> Elite OS intake. Make delivers a lead to the leadIntake function; this module validates it, deduplicates by the
// Meta lead id (leads/{leadId}, a ledger that holds NO personal data), creates/updates the customer through the same
// contacts/conversations structure the inbox already uses, and sends the approved WhatsApp template exactly once.
// Design rule for the customer-facing message: never send twice. When in doubt (crash or timeout mid-send) it is flagged for a
// human instead of retried. Existing modules (store.js, whatsapp.js) are reused unchanged.
const crypto = require('crypto');
const { Timestamp, FieldValue } = require('firebase-admin/firestore');
const store = require('./store');
const { normalizeLeadPhone } = require('./phone');
const { mapLead, buildNote } = require('./leadmap');
const LeadAddress = require('./leadAddress');
const CB = require('./contactBlock');          // Phase 10: "do not contact"
const LeadIssues = require('./leadIssues');    // Phase 10: rejected leads shown in "Needs attention"
const health = require('./health');
const W = require('./welcome');                // which welcome wording goes out (the owner's choice)

const MAX_BODY = 32 * 1024;
const STALE_CLAIM_MS = 90 * 1000;          // an in-flight claim older than this is considered abandoned
const COOLDOWN_MS = 60 * 60 * 1000;        // no second welcome template to the same number within an hour
const BREAKER_PER_HOUR = 60;               // circuit breaker: more new leads than this per hour is treated as a runaway
const MAX_ATTEMPTS = 3;

const log = (level, msg, extra) => console[level === 'error' ? 'error' : 'log'](JSON.stringify({ level, msg, ...extra }));
const redact = (s) => String(s || '').replace(/\+?\d[\d\s().\-]{5,}\d/g, '[number]').slice(0, 300);   // never store/log phone numbers from error text
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

// ---- authentication: shared secret in Authorization: Bearer <key> (or X-Api-Key). The secret may hold several comma-separated keys
// so a key can be rotated with no downtime. Compared in constant time against every key (no early exit).
function authorized(headers, secretValue) {
  const keys = String(secretValue || '').split(',').map((k) => k.trim()).filter((k) => k.length >= 24);
  const h = String(headers['authorization'] || '');
  const given = h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : String(headers['x-api-key'] || '').trim();
  if (!given || !keys.length) return false;
  const g = sha(given); let ok = false;
  for (const k of keys) ok = crypto.timingSafeEqual(g, sha(k)) || ok;
  return ok;
}

const respond = (status, body, headers) => ({ status, body: { ...body }, headers: headers || {} });

// ---- the customer record: new customers get everything; existing customers only get blanks filled (staff edits are never overwritten),
// keep their Inbox/Booked/... status, and get this lead appended to Notes. Idempotent: safe to run again for the same lead.
async function upsertLeadCustomer(db, phone, lead, now) {
  const cRef = db.collection('contacts').doc(phone), convRef = db.collection('conversations').doc(phone);
  const when = new Date(now).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Dublin' });
  return db.runTransaction(async (tx) => {
    const [c, conv] = await Promise.all([tx.get(cRef), tx.get(convRef)]);
    const cd = c.exists ? c.data() : {}, vd = conv.exists ? conv.data() : {};
    const upd = { phone, updatedAt: FieldValue.serverTimestamp() };
    const fill = (k, v) => { if (v && !cd[k]) upd[k] = v; };
    fill('name', lead.fullName); fill('email', lead.email); fill('location', lead.location);
    fill('budget', lead.budget); fill('projectType', lead.projectType); fill('source', 'Meta Ads');
    if (!c.exists) upd.createdAt = FieldValue.serverTimestamp();
    const old = cd.notes || '';
    // Only fill a blank; old/conflicting notes cannot silently select a different property.
    if (lead.address) fill('address', LeadAddress.fromNotes([old, 'Address: ' + lead.address].filter(Boolean).join('\n\n')).value);
    if (!old.includes(`Lead ID: ${lead.leadId}`)) {                       // already recorded? then this is a retry: add nothing
      const block = buildNote(lead, when);
      const room = 5000 - (old ? old.length + 2 : 0);
      if (room >= 200) upd.notes = [old, block.slice(0, room)].filter(Boolean).join('\n\n');
    }
    upd.metaLead = { leadId: lead.leadId, formId: lead.formId, formName: lead.formName, adName: lead.adName, receivedAt: Timestamp.fromMillis(now) };
    tx.set(cRef, upd, { merge: true });
    const cv = {};
    for (const k of ['name', 'location', 'projectType']) { const v = upd[k] || cd[k]; if (v && !vd[k]) cv[k] = v; }
    if (!conv.exists) tx.set(convRef, { phone, ...cv, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    else if (Object.keys(cv).length) tx.set(convRef, cv, { merge: true });    // never touches updatedAt / unread / inboxStatus
    return { contactCreated: !c.exists, conversationCreated: !conv.exists };
  });
}

// One welcome per number per hour, even across different leads: claimed inside a transaction on the contact document. Returns 'ok' (claimed), 'recent' (one went out lately) or
// 'blocked' (Phase 10: the customer asked not to be contacted; checked inside the same transaction).
async function claimWelcome(db, phone, now) {
  const cRef = db.collection('contacts').doc(phone), convRef = db.collection('conversations').doc(phone);
  return db.runTransaction(async (tx) => {
    const [c, conv] = await Promise.all([tx.get(cRef), tx.get(convRef)]);
    const m = (c.exists && c.data().metaLead) || {}, cv = conv.exists ? conv.data() : {};
    if (CB.blocked(cv)) return 'blocked';
    const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : 0);
    const recentTemplate = cv.lastMessageType === 'template' && cv.lastMessageDirection === 'out' && ms(cv.updatedAt) && now - ms(cv.updatedAt) < COOLDOWN_MS;
    if ((ms(m.welcomeSentAt) && now - ms(m.welcomeSentAt) < COOLDOWN_MS) || (ms(m.welcomeClaimedAt) && now - ms(m.welcomeClaimedAt) < 2 * 60 * 1000) || recentTemplate) return 'recent';
    tx.set(cRef, { metaLead: { welcomeClaimedAt: Timestamp.fromMillis(now) } }, { merge: true });
    return 'ok';
  });
}
const DNC_WELCOME = 'Welcome message not sent: this customer asked not to be contacted. They have sent a new Meta form, so check before contacting them (press "Allow contact again" if they want to hear from you).';
const releaseWelcome = (db, phone, sentAt) => db.collection('contacts').doc(phone).set(
  { metaLead: { welcomeClaimedAt: FieldValue.delete(), ...(sentAt ? { welcomeSentAt: Timestamp.fromMillis(sentAt) } : {}) } }, { merge: true });

// A refusal from Meta (4xx) = the message was definitely NOT sent; only a rate limit (429) is worth trying again. A 5xx, or no answer at all
// (timeout, network), means we cannot know whether it went, so it is never retried automatically (audit finding 6; the same rule as every
// other send in Elite OS): the inbox flags it for a human.
function classify(e) {
  const m = /^Meta API error (\d{3})/.exec(String(e && e.message));
  if (m) { const code = Number(m[1]); return code === 429 ? 'retryable' : code >= 500 ? 'unknown' : 'permanent'; }
  if (e && /not configured/.test(String(e.message))) return 'permanent';
  return 'unknown';
}

// Phase 10: a key was offered (an Authorization or X-Api-Key header with something in it). A wrong OFFERED key means the Make scenario has the wrong one: that is a problem worth an
// alert. A request with no key at all is someone else knocking (scanners): it is refused as before and alerts nobody.
const offeredKey = (headers) => { const h = String(headers['authorization'] || '').trim(); return (h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : h).length > 0 || String(headers['x-api-key'] || '').trim().length > 0; };

async function handleLeadRequest(req, { db, wa, cfg, now: clock, push, health: hh }) {
  const now = clock ? clock() : Date.now();
  if (req.method !== 'POST') return respond(405, { ok: false, error: 'POST only' });
  if (!authorized(req.headers || {}, cfg.apiKeys)) {
    log('warn', 'lead rejected: bad or missing key');
    if (hh && offeredKey(req.headers || {})) await hh.report('lead_key');
    return respond(401, { ok: false, error: 'unauthorized' });
  }
  if ((req.rawBody ? req.rawBody.length : 0) > MAX_BODY) return respond(413, { ok: false, error: 'payload too large' });
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return respond(400, { ok: false, error: 'JSON object expected' });
  const lead = mapLead(req.body);
  if (lead.error) return respond(400, { ok: false, error: lead.error });
  const id = lead.leadId, ref = db.collection('leads').doc(id);
  const base = { formId: lead.formId, formName: lead.formName };
  const phone = lead.phones.map(normalizeLeadPhone).find(Boolean);

  const prior = await ref.get();
  if (prior.exists && prior.data().state === 'done') {
    log('info', 'lead duplicate ignored', { leadId: id, formId: lead.formId });
    return respond(200, { ok: true, status: 'duplicate', leadId: id, welcome: (prior.data().welcome || {}).state || null });
  }

  if (!phone) {   // not a valid number: no customer is created and nothing is sent; the ledger remembers it and Make is told
    await ref.set({ leadId: id, ...base, state: 'rejected', reason: 'invalid_phone', receivedAt: prior.exists ? prior.data().receivedAt : Timestamp.fromMillis(now), attempts: FieldValue.increment(1) }, { merge: true });
    log('warn', 'lead rejected: no valid phone', { leadId: id, formId: lead.formId, phonesGiven: lead.phones.length });
    // Phase 10: shown in "Needs attention" with what a person needs to follow it up (name, email, the number as typed), and one alert (push now; the email, if set up, by the health check)
    try {
      const li = await LeadIssues.record(db, lead, { reason: 'invalid_phone', nowMs: now });
      if (li.created && push) await health.deliverLeadAlert({ db, notify: push.notify }, id, now, { pushOnly: true });
    } catch (e) { log('error', 'rejected lead not recorded', { leadId: id, code: String((e && e.code) || 'unknown').slice(0, 60) }); }
    return respond(200, { ok: true, status: 'rejected', reason: 'invalid_phone', leadId: id });
  }
  const wasRejected = prior.exists && prior.data().state === 'rejected';

  if (!prior.exists) {   // circuit breaker, only for genuinely new leads
    const n = (await db.collection('leads').where('receivedAt', '>', Timestamp.fromMillis(now - 3600e3)).count().get()).data().count;
    if (n >= BREAKER_PER_HOUR) { log('error', 'lead intake circuit breaker tripped', { perHour: n }); if (hh) await hh.report('lead_breaker'); return respond(503, { ok: false, status: 'rate_limited' }, { 'Retry-After': '300' }); }
  }

  const claim = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) { tx.create(ref, { leadId: id, ...base, createdTime: lead.createdTime, receivedAt: Timestamp.fromMillis(now), state: 'processing', claimedAt: now, attempts: 1, welcome: { state: 'pending' } }); return { r: 'claimed', attempts: 1 }; }
    const d = s.data();
    if (d.state === 'done') return { r: 'duplicate', welcome: (d.welcome || {}).state || null };
    if (d.state === 'processing' && d.claimedAt && now - d.claimedAt < STALE_CLAIM_MS) return { r: 'in_progress' };
    const attempts = (d.attempts || 0) + 1;
    tx.update(ref, { state: 'processing', claimedAt: now, attempts, reason: FieldValue.delete() });
    return { r: 'claimed', attempts, welcome: d.welcome };
  });
  if (claim.r === 'duplicate') return respond(200, { ok: true, status: 'duplicate', leadId: id, welcome: claim.welcome });
  if (claim.r === 'in_progress') return respond(503, { ok: false, status: 'in_progress', leadId: id }, { 'Retry-After': '5' });

  const info = await upsertLeadCustomer(db, phone, lead, now);
  if (wasRejected) { try { await LeadIssues.resolvedByIntake(db, id, now); } catch (e) { log('error', 'rejected lead not closed', { leadId: id }); } }   // Phase 10: sent again with a usable number
  // Phase 8: a push for a NEW lead, right after the customer is saved and before the welcome message is sent. It can never throw and gives up after a few seconds.
  if (push && claim.r === 'claimed') { try { await push.notify({ kind: 'lead', sourceId: id, phone, eventAt: Date.parse(lead.createdTime) || null, backendReceivedAt: now }); } catch (e) { log('error', 'push hook failed'); } }
  const finish = async (welcome, extra) => {
    await ref.update({ state: 'done', completedAt: Timestamp.fromMillis(clock ? clock() : Date.now()), welcome, contactCreated: info.contactCreated, ...extra });
    log('info', 'lead processed', { leadId: id, formId: lead.formId, welcome: welcome.state, newCustomer: info.contactCreated });
    return respond(200, { ok: true, status: 'processed', leadId: id, welcome: welcome.state, newCustomer: info.contactCreated });
  };
  const w = claim.welcome || { state: 'pending' };

  if (w.state === 'sent' || w.state === 'skipped_recent' || w.state === 'blocked') return finish(w);
  if (w.state === 'sending') {      // an earlier attempt died mid-send: the template may or may not have gone out. Flag it, never resend.
    await store.storeFailedOutbound(db, phone, { type: 'template', body: `[template: ${cfg.template}]`, error: 'Welcome message status unknown (interrupted while sending). Check WhatsApp, then send it manually if needed.' });
    await releaseWelcome(db, phone);
    log('error', 'welcome status unknown after interrupted send', { leadId: id });
    return finish({ state: 'unknown', at: now });
  }
  if (claim.attempts > MAX_ATTEMPTS) {
    await store.storeFailedOutbound(db, phone, { type: 'template', body: `[template: ${cfg.template}]`, error: 'Welcome message not sent: WhatsApp kept failing. Please send it manually.' });
    return finish({ state: 'failed', error: 'too many retries', at: now });
  }
  const cw = await claimWelcome(db, phone, now);
  if (cw === 'recent') return finish({ state: 'skipped_recent', at: now });
  if (cw === 'blocked') {          // Phase 10: "do not contact": no welcome, and the chat says why (a person decides whether the new form means they want to hear from us)
    await store.storeFailedOutbound(db, phone, { type: 'template', body: `[template: ${cfg.template}]`, error: DNC_WELCOME }).catch(() => {});
    return finish({ state: 'blocked', at: now });
  }

  await ref.update({ welcome: { state: 'sending', at: now } });
  // The owner's choice of wording (lib/welcome.js). A personal welcome that WhatsApp refuses outright was definitely not sent, so the standard one goes instead, once.
  let key = await W.chosen(db), fellBack = false;
  const send = (k) => wa.sendTemplate(phone, lead.firstName, { name: W.nameOf(k, cfg.template) });
  try {
    let wamid;
    try { wamid = await send(key); }
    catch (e) {
      if (key === 'standard' || classify(e) !== 'permanent') throw e;
      log('error', 'personal welcome refused: the standard welcome is sent instead', { leadId: id, err: redact(e && e.message) });
      key = 'standard'; fellBack = true;
      wamid = await send(key);
    }
    await store.storeOutbound(db, phone, { wamid, type: 'template', body: W.bodyOf(key, cfg.template, lead.firstName) });
    await releaseWelcome(db, phone, now);
    return finish({ state: 'sent', wamid, at: now, template: key, ...(fellBack ? { fellBack: true } : {}) });
  } catch (e) {
    const kind = classify(e), err = redact(e && e.message);
    log('error', 'welcome template failed', { leadId: id, kind, err });
    if (kind === 'retryable') {   // Meta refused it for rate limiting: definitely not sent, so Make may safely retry
      await ref.update({ welcome: { state: 'pending', lastError: err }, claimedAt: 0 });
      await releaseWelcome(db, phone);
      return respond(503, { ok: false, status: 'retry', leadId: id }, { 'Retry-After': '30' });
    }
    await store.storeFailedOutbound(db, phone, { type: 'template', body: `[template: ${W.nameOf(key, cfg.template)}]`,
      error: kind === 'unknown' ? 'Welcome message status unknown (no answer from WhatsApp). Check WhatsApp, then send it manually if needed.' : err });
    await releaseWelcome(db, phone);
    return finish({ state: kind === 'unknown' ? 'unknown' : 'failed', error: err, at: now });
  }
}

module.exports = { handleLeadRequest, authorized, upsertLeadCustomer, MAX_BODY, BREAKER_PER_HOUR, COOLDOWN_MS };
