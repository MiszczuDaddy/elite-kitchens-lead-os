// Firestore data layer. Layout:
//   contacts/{phone}
//   conversations/{phone}                 (one per contact; doc id = phone digits)
//   conversations/{phone}/messages/{id}   (id = WhatsApp message id when known -> free, atomic dedup)
const { Timestamp, FieldValue } = require('firebase-admin/firestore');

const RANK = { failed: 0, sent: 1, delivered: 2, read: 3 };
const preview = (s) => String(s || '').slice(0, 120);

// Store an inbound message. Returns false if this WhatsApp message id was already stored (Meta retry).
async function storeInbound(db, m) {
  const convRef = db.collection('conversations').doc(m.from);
  const contactRef = db.collection('contacts').doc(m.from);
  const msgRef = convRef.collection('messages').doc(m.wamid);
  const at = Timestamp.fromDate(m.createdAt);
  return db.runTransaction(async (tx) => {
    const [msg, conv] = await Promise.all([tx.get(msgRef), tx.get(convRef)]);
    if (msg.exists && msg.data().direction === 'in') return false;
    if (!conv.exists) {
      tx.set(contactRef, { phone: m.from, name: m.name || null, createdAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.set(convRef, { phone: m.from, name: m.name || null, createdAt: FieldValue.serverTimestamp() });
    } else if (m.name && !conv.data().name) {
      tx.update(convRef, { name: m.name }); tx.set(contactRef, { name: m.name }, { merge: true });
    }
    tx.set(msgRef, { wamid: m.wamid, direction: 'in', type: m.type, body: m.body, media: m.media || null,
      status: 'received', error: null, createdAt: at });
    const prevIn = conv.exists && conv.data().lastInboundAt;
    tx.set(convRef, { updatedAt: FieldValue.serverTimestamp(), lastMessage: preview(m.body), lastMessageType: m.type, lastMessageDirection: 'in',
      unreadCount: FieldValue.increment(1),       // a duplicate delivery returned earlier, so retries never double-count
      lastInboundAt: prevIn && prevIn.toMillis() > at.toMillis() ? prevIn : at }, { merge: true });
    return true;
  });
}

// Record an outbound message that Meta accepted. Handles the race where the delivery status webhook
// arrives before we get to write the message: keep the (higher) status the webhook already stored.
async function storeOutbound(db, phone, { wamid, type, body, media, extra }) {      // extra (Phase 6.1): more fields on the message, e.g. the quote label
  const convRef = db.collection('conversations').doc(phone);
  const msgRef = convRef.collection('messages').doc(wamid);
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(msgRef);
    const base = { wamid, direction: 'out', type, body, media: media || null, error: null, ...(extra || {}) };
    if (existing.exists) tx.set(msgRef, { ...base, createdAt: Timestamp.now() }, { merge: true });   // status untouched
    else tx.set(msgRef, { ...base, status: 'sent', createdAt: Timestamp.now() });
    tx.set(convRef, { updatedAt: FieldValue.serverTimestamp(), lastMessage: preview(body), lastMessageType: type, lastMessageDirection: 'out' }, { merge: true });
  });
}

async function storeFailedOutbound(db, phone, { type, body, error }) {
  const convRef = db.collection('conversations').doc(phone);
  await convRef.collection('messages').add({ wamid: null, direction: 'out', type, body, media: null,
    status: 'failed', error, createdAt: Timestamp.now() });
  await convRef.set({ updatedAt: FieldValue.serverTimestamp(), lastMessage: preview(body), lastMessageType: type, lastMessageDirection: 'out' }, { merge: true });
}

async function ensureConversation(db, phone, name) {
  const convRef = db.collection('conversations').doc(phone);
  await db.runTransaction(async (tx) => {
    const c = await tx.get(convRef);
    if (!c.exists) {
      tx.set(db.collection('contacts').doc(phone), { phone, name, createdAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.set(convRef, { phone, name, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    }
  });
}

// Apply a delivery status. Never moves backwards (webhooks can arrive out of order).
async function applyStatus(db, s) {
  if (!s.phone) return false;
  const convRef = db.collection('conversations').doc(s.phone);
  const msgRef = convRef.collection('messages').doc(s.wamid);
  return db.runTransaction(async (tx) => {
    const [snap, conv] = await Promise.all([tx.get(msgRef), tx.get(convRef)]);
    if (!conv.exists) return false;       // unknown/deleted customer: a late status must not recreate anything
    if (!snap.exists) {   // status beat our own write: leave a stub that storeOutbound completes
      tx.set(msgRef, { wamid: s.wamid, direction: 'out', status: s.status, error: s.error || null });
      return true;
    }
    const cur = snap.data().status;
    if (s.status !== 'failed' && cur in RANK && RANK[cur] >= RANK[s.status]) return true;
    tx.update(msgRef, { status: s.status, error: s.error || snap.data().error || null });
    return true;
  });
}

// Mark a conversation read by staff. Deliberately does NOT touch updatedAt (that would reorder the inbox).
async function markRead(db, phone) {
  const convRef = db.collection('conversations').doc(phone);
  const snap = await convRef.get();
  if (!snap.exists) return false;
  await convRef.update({ lastReadAt: FieldValue.serverTimestamp(), unreadCount: 0 });
  return true;
}

// Pipeline stage. Never creates a document or touches activity/unread fields. Entering booked/quoted/won/closed stamps
// stageDates.<stage> (the latest time it was entered); "inbox" (New lead) needs no date because createdAt is the lead date.
// Choosing the stage a customer is already in writes nothing, so a double click cannot move a date.
//
// Corrections: every real move leaves a small note, lastMove { from, to, at, prev } (prev = the date the destination stage
// had before). If the very next move goes straight back to `from` within CORRECTION_WINDOW_MS, it is treated as fixing an
// accident: the customer returns to `from`, the destination's date is restored (or removed if it had none), and nothing is
// re-stamped, so the accidental move leaves no trace in the history or the conversion numbers. Anything else (moving on to
// another stage, or moving back later) is a genuine move and its dates stay.
const DATED_STAGES = new Set(['booked', 'quoted', 'won', 'closed']);
const CORRECTION_WINDOW_MS = 5 * 60 * 1000;
async function setConversationStatus(db, phone, status, nowMs = Date.now()) {
  const ref = db.collection('conversations').doc(phone);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const plan = planStatusChange(snap.data(), status, nowMs);
    if (!plan) return { corrected: false };
    tx.update(ref, plan.patch);
    return plan.result;
  });
}
// The decision itself, without writing it, so booking an appointment (Phase 5) can move a New lead to Booked by exactly the
// same rules inside its own transaction. Returns null when the customer is already in that stage, else { patch, result }.
function planStatusChange(c, status, nowMs) {
  const cur = c.inboxStatus || 'inbox';
  if (cur === status) return null;
  const lm = c.lastMove;
  if (lm && lm.to === cur && lm.from === status && lm.at && typeof lm.at.toMillis === 'function' && nowMs - lm.at.toMillis() <= CORRECTION_WINDOW_MS) {
    const patch = { inboxStatus: status, lastMove: FieldValue.delete() };
    if (DATED_STAGES.has(lm.to)) patch[`stageDates.${lm.to}`] = lm.prev || FieldValue.delete();
    return { patch, result: { corrected: true, undone: lm.to } };
  }
  const patch = { inboxStatus: status, lastMove: { from: cur, to: status, at: Timestamp.fromMillis(nowMs), prev: (DATED_STAGES.has(status) && c.stageDates && c.stageDates[status]) || null } };
  if (DATED_STAGES.has(status)) patch[`stageDates.${status}`] = FieldValue.serverTimestamp();
  return { patch, result: { corrected: false } };
}

// Staff-editable customer record. contacts/{phone} is the source of truth; name/location/projectType are
// denormalised onto the conversation so the inbox list and search need no joins.
async function updateContact(db, phone, fields) {
  const convRef = db.collection('conversations').doc(phone);
  const contactRef = db.collection('contacts').doc(phone);
  return db.runTransaction(async (tx) => {
    const conv = await tx.get(convRef);
    if (!conv.exists) return false;
    const now = FieldValue.serverTimestamp();
    tx.set(contactRef, { phone, ...fields, updatedAt: now }, { merge: true });
    const denorm = {};
    for (const k of ['name', 'location', 'projectType']) if (k in fields) denorm[k] = fields[k];
    if (Object.keys(denorm).length) tx.set(convRef, denorm, { merge: true });   // does not touch updatedAt: no inbox reorder
    return true;
  });
}

// Record the outcome of a media download on the message. Dotted paths so sibling fields (caption, filename, ...) survive.
async function setMediaState(db, phone, msgId, r) {
  const ref = db.collection('conversations').doc(phone).collection('messages').doc(msgId);
  const patch = { 'media.status': r.status, 'media.error': r.error || null };
  if (r.status === 'stored') Object.assign(patch, { 'media.storagePath': r.storagePath, 'media.size': r.size, 'media.mimeType': r.mimeType, 'media.sha256': r.sha256, 'media.filename': r.filename });
  await ref.update(patch);
}
async function getMessage(db, phone, msgId) {
  const s = await db.collection('conversations').doc(phone).collection('messages').doc(msgId).get();
  return s.exists ? s.data() : null;
}

// Permanently erase one customer: conversation + every message + stored files + the customer record + their appointments
// + (Phase 6) their quotes, every version and every stored quote PDF.
// Files go first and are swept again at the end so a media download (or a quote being sent) that was in flight cannot
// leave anything behind.
async function deleteCustomerData(db, bucket, phone) {
  const convRef = db.collection('conversations').doc(phone);
  const contactRef = db.collection('contacts').doc(phone);
  const [conv, contact] = await Promise.all([convRef.get(), contactRef.get()]);
  if (!conv.exists && !contact.exists) return null;
  const messages = (await convRef.collection('messages').count().get()).data().count;
  const prefix = `media/${phone}/`, quotePrefix = `quotes/${phone}/`;
  let files = (await bucket.getFiles({ prefix }))[0].length;
  let quoteFiles = (await bucket.getFiles({ prefix: quotePrefix }))[0].length;
  await bucket.deleteFiles({ prefix, force: true });
  await bucket.deleteFiles({ prefix: quotePrefix, force: true });
  const appts = await db.collection('appointments').where('phone', '==', phone).get();
  for (let i = 0; i < appts.size; i += 400) { const b = db.batch(); appts.docs.slice(i, i + 400).forEach((d) => b.delete(d.ref)); await b.commit(); }
  const quoteDocs = async () => (await db.collection('quotes').where('phone', '==', phone).get()).docs;
  let quotes = 0;
  for (const d of await quoteDocs()) { await db.recursiveDelete(d.ref); quotes++; }      // each quote and its versions
  await db.recursiveDelete(convRef);                 // the conversation document and all its subcollections
  await contactRef.delete();
  for (const d of await quoteDocs()) { await db.recursiveDelete(d.ref); quotes++; }      // one created while this ran
  const late = (await bucket.getFiles({ prefix }))[0].length;
  if (late) { files += late; await bucket.deleteFiles({ prefix, force: true }); }
  const lateQuoteFiles = (await bucket.getFiles({ prefix: quotePrefix }))[0].length;
  if (lateQuoteFiles) { quoteFiles += lateQuoteFiles; await bucket.deleteFiles({ prefix: quotePrefix, force: true }); }
  return { messages, files, appointments: appts.size, quotes, quoteFiles };
}

// Phase 6: a customer added by staff WITHOUT any message (a phone, email or walk-in enquiry): a New lead with no stage, like a
// Meta lead before its welcome. If the number is already a customer nothing is changed and { existing: true } is returned.
// name / location / projectType are copied onto the conversation, as updateContact does, so the Inbox needs no joins.
async function createCustomer(db, phone, fields, actor) {
  const convRef = db.collection('conversations').doc(phone);
  const contactRef = db.collection('contacts').doc(phone);
  return db.runTransaction(async (tx) => {
    const [conv, contact] = await Promise.all([tx.get(convRef), tx.get(contactRef)]);
    if (conv.exists) return { phone, existing: true };
    const now = FieldValue.serverTimestamp();
    tx.set(contactRef, { phone, ...fields, ...(contact.exists ? {} : { createdAt: now }), createdBy: actor.id, updatedAt: now }, { merge: true });
    const denorm = {};
    for (const k of ['name', 'location', 'projectType']) if (fields[k] != null) denorm[k] = fields[k];
    tx.set(convRef, { phone, ...denorm, createdAt: now, updatedAt: now });
    return { phone, existing: false };
  });
}

async function getConversation(db, phone) {
  const s = await db.collection('conversations').doc(phone).get();
  return s.exists ? s.data() : null;
}

module.exports = { CORRECTION_WINDOW_MS, setConversationStatus, planStatusChange, deleteCustomerData, createCustomer, setMediaState, getMessage, updateContact, markRead, storeInbound, storeOutbound, storeFailedOutbound, ensureConversation, applyStatus, getConversation };
