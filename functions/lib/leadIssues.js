'use strict';
// Phase 10 (docs/PHASE10_SAFETY_NET.md): Meta leads that could not be added automatically. Until now such a lead (no usable phone number) was kept only in the lead ledger
// (leads/{leadId}, which deliberately holds NO personal data) and Make was told; nothing showed in Elite OS. Now the lead is also kept here, with ONLY what a person needs to follow
// it up, and it is shown in "Needs attention" until someone deals with it:
//   leadIssues/{leadId}   { leadId, reason, reasonText, name, email, phoneTyped, location, formName, adName, receivedAt, lastAt, attempts,
//                           status: 'open' | 'added' | 'dismissed', resolvedAt, resolvedBy, alert: { state, tries, pushOk, emailOk, ... } }
// The personal details (name, email, the number as typed, the area) are ERASED the moment the item is dealt with (added as a customer, dismissed, or Make sent the same lead again with a
// usable number), and a dealt-with item is removed completely after PURGE_AFTER_MS (the health check does it). Open items stay until a person deals with them.
const { HttpsError } = require('firebase-functions/v2/https');
const { Timestamp } = require('firebase-admin/firestore');

const REASONS = { invalid_phone: 'The phone number in the form is missing or is not a valid number, so the lead could not be added or sent the WhatsApp welcome.' };
const PERSONAL = ['name', 'email', 'phoneTyped', 'location'];
const PURGE_AFTER_MS = 30 * 24 * 3600e3;
const LEAD_ID = /^[A-Za-z0-9_-]{5,64}$/;
const one = (v, n) => { const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim(); return s ? s.slice(0, n) : null; };
const erased = () => Object.fromEntries(PERSONAL.map((k) => [k, null]));
const ref = (db, leadId) => db.collection('leadIssues').doc(leadId);

// From the lead intake (leads.js), for a lead that was rejected. lead: the mapped lead (leadmap.mapLead). Returns { created } (true the first time this lead is seen).
// A lead someone already dealt with (added / dismissed) is never brought back by Make retrying it.
async function record(db, lead, { reason = 'invalid_phone', nowMs = Date.now() } = {}) {
  const r = ref(db, lead.leadId), now = Timestamp.fromMillis(nowMs);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(r);
    if (s.exists) {
      if (s.data().status === 'open') tx.update(r, { lastAt: now, attempts: (s.data().attempts || 1) + 1 });
      return { created: false };
    }
    tx.create(r, {
      leadId: lead.leadId, reason, reasonText: REASONS[reason] || 'The lead could not be added.',
      name: one(lead.fullName, 100), email: one(lead.email, 200), phoneTyped: one((lead.phones || []).join(', '), 60), location: one(lead.location, 100),
      formName: one(lead.formName, 150), adName: one(lead.adName, 150), receivedAt: now, lastAt: now, attempts: 1,
      status: 'open', resolvedAt: null, resolvedBy: null,
      alert: { state: 'pending', tries: 0, pushOk: false, emailOk: false, emailTries: 0, emailClaimedAt: null, lastTryAt: null },
    });
    return { created: true };
  });
}

// From the lead intake: the same lead came again with a usable number and the customer was added. Returns true when an open item was closed now.
async function resolvedByIntake(db, leadId, nowMs = Date.now()) {
  const r = ref(db, leadId);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(r);
    if (!s.exists || s.data().status !== 'open') return false;
    tx.update(r, { status: 'added', resolvedAt: Timestamp.fromMillis(nowMs), resolvedBy: 'make', ...erased() });
    return true;
  });
}

// Staff: "Add as customer" (after the customer was added with a corrected number) or "Dismiss". The personal details go at once.
async function resolve(db, actor, data, nowMs = Date.now()) {
  if (typeof data.leadId !== 'string' || !LEAD_ID.test(data.leadId)) throw new HttpsError('invalid-argument', 'Missing lead.');
  if (!['added', 'dismissed'].includes(data.outcome)) throw new HttpsError('invalid-argument', 'Choose "Add as customer" or "Dismiss".');
  const r = ref(db, data.leadId);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(r);
    if (!s.exists) throw new HttpsError('not-found', 'That lead is no longer in the list.');
    if (s.data().status !== 'open') return { ok: true, status: s.data().status, unchanged: true };
    tx.update(r, { status: data.outcome, resolvedAt: Timestamp.fromMillis(nowMs), resolvedBy: actor.id, ...erased() });
    return { ok: true, status: data.outcome };
  });
}

// Health check: dealt-with items older than PURGE_AFTER_MS are removed completely. Returns how many.
async function purge(db, nowMs = Date.now()) {
  const old = await db.collection('leadIssues').where('resolvedAt', '<', Timestamp.fromMillis(nowMs - PURGE_AFTER_MS)).limit(200).get();
  for (const d of old.docs) await d.ref.delete();
  return old.size;
}

module.exports = { REASONS, PERSONAL, PURGE_AFTER_MS, record, resolvedByIntake, resolve, purge };
