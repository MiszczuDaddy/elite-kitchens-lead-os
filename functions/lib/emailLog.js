'use strict';
// The list of every email Elite OS has sent to, or received from, a customer (14 Nov 2026, docs/EMAIL_LIST.md): the "Emails" window. Staff read it; only the server writes it.
//   emailLog/{id} = { phone, name, direction: 'in'|'out', kind, subject, snippet, email, at, confirmed, by?, quoteRef? }
//   kind: customer (they wrote to us) · reply (you replied by email from their chat) · followup (the follow-up to a lead who never replied) · quotefollowup (the follow-up about a quote nobody answered) · quote (the quote itself, by email)
// It is a COPY made for looking at: a short preview (never the whole email, never an attachment). The full text of a received email, a reply and a follow-up stays in the customer's own chat
// (conversations/{phone}/emails); a quote email's body is not kept beyond the preview. Writing it never changes whether an email was sent or recorded: a failure here is logged and ignored, because the
// email already went (or arrived) and is recorded where it matters. Deleting a customer deletes their entries (store.js deleteCustomerData).
const { Timestamp, FieldValue } = require('firebase-admin/firestore');

const KINDS = ['customer', 'reply', 'followup', 'quotefollowup', 'quote'];
const SNIPPET_MAX = 200, SUBJECT_MAX = 200, NAME_MAX = 80;
const oneLine = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

// entry: { id, phone, name, direction, kind, subject, text, email, atMs, confirmed?, by?, quoteRef? }. Never throws; returns whether it was written.
async function record(db, entry) {
  try {
    if (!entry || !/^[A-Za-z0-9_\-]{3,160}$/.test(String(entry.id || '')) || !/^\d{9,15}$/.test(String(entry.phone || '')) || !KINDS.includes(entry.kind) || !['in', 'out'].includes(entry.direction)) return false;
    await db.collection('emailLog').doc(entry.id).set({
      phone: entry.phone, name: oneLine(entry.name, NAME_MAX) || null, direction: entry.direction, kind: entry.kind,
      subject: oneLine(entry.subject, SUBJECT_MAX) || '(no subject)', snippet: oneLine(entry.text, SNIPPET_MAX), email: oneLine(entry.email, 200) || null,
      at: Timestamp.fromMillis(Number(entry.atMs) || Date.now()), confirmed: entry.confirmed !== false,
      ...(entry.by ? { by: oneLine(entry.by, 120) } : {}), ...(entry.quoteRef ? { quoteRef: oneLine(entry.quoteRef, 40) } : {}),
    });
    return true;
  } catch (e) {
    console.log(JSON.stringify({ level: 'error', msg: 'email list entry not written', kind: entry && entry.kind, code: e && e.code }));
    return false;
  }
}

// An automatic email that went out (the follow-up to a lead, the follow-up about a quote): it is kept in the customer's own chat (so the thread shows exactly what was sent) AND listed here, and the chat row
// shows it as the newest email. It does NOT move the chat up the Inbox (updatedAt is left alone: a batch of 30 follow-ups must not reshuffle the list). Never throws.
//   e: { phone, name, id (unique in the customer's email list), sender, to, subject, body, kind, atMs, confirmed, by, providerId?, quoteRef? }
async function keepSent(db, e) {
  try {
    const subject = oneLine(e.subject, SUBJECT_MAX) || '(no subject)', convRef = db.collection('conversations').doc(e.phone);
    await convRef.collection('emails').doc(e.id).set({ direction: 'out', gmailId: e.providerId || null, threadId: null, messageId: null, references: [], subject, fromEmail: e.sender || null, fromName: null, to: e.to || null,
      body: String(e.body == null ? '' : e.body).slice(0, 5000), attachments: [], createdAt: Timestamp.fromMillis(e.atMs), by: e.by || null, confirmed: e.confirmed !== false, kind: e.kind, ...(e.quoteRef ? { quoteRef: e.quoteRef } : {}) });
    await convRef.update({ lastEmailAt: FieldValue.serverTimestamp(), lastEmailSubject: subject.slice(0, 120), lastEmailDir: 'out' });
  } catch (err) { console.log(JSON.stringify({ level: 'error', msg: 'sent email not kept in the chat', kind: e && e.kind, code: err && err.code })); }
  return record(db, { id: e.phone + '_' + e.id, phone: e.phone, name: e.name, direction: 'out', kind: e.kind, subject: e.subject, text: e.body, email: e.to, atMs: e.atMs, confirmed: e.confirmed, by: e.by, quoteRef: e.quoteRef });
}

// A quote email that could not be confirmed was settled by staff ("it arrived" / "it did not arrive"): the list follows. Never throws.
async function settle(db, id, delivered) {
  try { const ref = db.collection('emailLog').doc(id); if (delivered) await ref.update({ confirmed: true }); else await ref.delete(); return true; }
  catch (e) { return false; }                                                                // no entry (older send) or a hiccup: nothing to do
}

// The one-time catch-up (scripts/backfill-email-log.js): the emails already kept in customers' chats before this list existed (what customers sent and the replies sent from a chat) are added to it. The automatic
// follow-ups and quote emails sent earlier were never kept as text, so they cannot be added. Safe to run again: an email already listed is left as it is. apply:false only counts.
async function backfill(db, { apply = false } = {}) {
  const snap = await db.collectionGroup('emails').get(), names = {}, out = { read: snap.size, missing: 0, written: 0 };
  for (const d of snap.docs) {
    const parent = d.ref.parent.parent, phone = parent && parent.id;
    if (!/^\d{9,15}$/.test(phone || '')) continue;
    const id = d.id.startsWith('g_') ? d.id : phone + '_' + d.id;
    if ((await db.collection('emailLog').doc(id).get()).exists) continue;
    out.missing++;
    if (!apply) continue;
    if (!(phone in names)) { const c = await parent.get(); names[phone] = c.exists ? c.data().name || null : null; }
    const x = d.data(), inbound = x.direction === 'in';
    const ok = await record(db, { id, phone, name: names[phone], direction: inbound ? 'in' : 'out', kind: inbound ? 'customer' : (KINDS.includes(x.kind) ? x.kind : 'reply'), subject: x.subject, text: x.body, email: inbound ? x.fromEmail : x.to,
      atMs: x.createdAt && typeof x.createdAt.toMillis === 'function' ? x.createdAt.toMillis() : Date.now(), confirmed: x.confirmed, by: x.by });
    if (ok) out.written++;
  }
  return out;
}

module.exports = { record, keepSent, settle, backfill, KINDS, SNIPPET_MAX };
