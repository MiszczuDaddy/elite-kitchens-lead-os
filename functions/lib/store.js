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
    tx.set(convRef, { updatedAt: FieldValue.serverTimestamp(), lastMessage: preview(m.body),
      lastInboundAt: prevIn && prevIn.toMillis() > at.toMillis() ? prevIn : at }, { merge: true });
    return true;
  });
}

// Record an outbound message that Meta accepted. Handles the race where the delivery status webhook
// arrives before we get to write the message: keep the (higher) status the webhook already stored.
async function storeOutbound(db, phone, { wamid, type, body }) {
  const convRef = db.collection('conversations').doc(phone);
  const msgRef = convRef.collection('messages').doc(wamid);
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(msgRef);
    const base = { wamid, direction: 'out', type, body, media: null, error: null };
    if (existing.exists) tx.set(msgRef, { ...base, createdAt: Timestamp.now() }, { merge: true });   // status untouched
    else tx.set(msgRef, { ...base, status: 'sent', createdAt: Timestamp.now() });
    tx.set(convRef, { updatedAt: FieldValue.serverTimestamp(), lastMessage: preview(body) }, { merge: true });
  });
}

async function storeFailedOutbound(db, phone, { type, body, error }) {
  const convRef = db.collection('conversations').doc(phone);
  await convRef.collection('messages').add({ wamid: null, direction: 'out', type, body, media: null,
    status: 'failed', error, createdAt: Timestamp.now() });
  await convRef.set({ updatedAt: FieldValue.serverTimestamp(), lastMessage: preview(body) }, { merge: true });
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
  const msgRef = db.collection('conversations').doc(s.phone).collection('messages').doc(s.wamid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(msgRef);
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

async function getConversation(db, phone) {
  const s = await db.collection('conversations').doc(phone).get();
  return s.exists ? s.data() : null;
}

module.exports = { storeInbound, storeOutbound, storeFailedOutbound, ensureConversation, applyStatus, getConversation };
