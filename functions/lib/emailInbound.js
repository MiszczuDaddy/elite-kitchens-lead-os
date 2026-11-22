'use strict';
// The email inbox (10 Nov 2026, docs/EMAIL_INBOX.md): a customer's reply to a quote or follow-up email arrives in the business mailbox; this brings it into THEIR chat in Elite OS.
//   conversations/{phone}/emails/{g_<gmailId>}   one per email, in and out: { direction, gmailId, threadId, messageId, references[], subject, fromEmail, fromName, to, body, attachments[], createdAt, by? }
//   conversations/{phone}: emailInboundAt (when they last emailed us), lastEmailAt / lastEmailSubject / lastEmailDir (for the Inbox row), and unreadCount goes up by one (the same unread badge as WhatsApp)
//   emailSync/state                              { lastSweepAt, seen: [gmail ids], lastError }
// Both directions (15 Nov 2026): the Sent folder is watched too. An email YOU wrote to a customer from Gmail is kept in their chat and listed (kind 'gmail', "Sent from Gmail"), so a conversation is tracked whether you answer
// from Gmail or from Elite OS. Emails Elite OS sent itself also land in Sent and are NOT listed twice (Google's message id, or the same subject to the same customer a few minutes apart, is recognised).
// Privacy by construction: the mailbox is read through a READ-ONLY sign-in (gmail.readonly). Every new inbox message has only its HEADERS looked at, to see who wrote; the text is read and kept ONLY when the sender's
// address is a customer or lead Elite OS already has. Nothing else is stored, and nothing is ever sent, deleted, labelled or marked read in Gmail. Emails live in their own list, NOT in `messages`, so the automatic
// receptionist, the WhatsApp 24-hour window and "last message" never see them. An email counts as "they wrote to us" for the No reply tab and for the follow-up emails (emailInboundAt).
const { Timestamp, FieldValue } = require('firebase-admin/firestore');
const Gmail = require('./gmail');
const EmailLog = require('./emailLog');

const DAY = 24 * 3600e3, OVERLAP_MS = 15 * 60e3, FIRST_WINDOW_MS = 3 * DAY, MAX_PAGES = 3, MAX_PER_RUN = 60, SEEN_KEEP = 400, BODY_MAX = 4000, SUBJECT_MAX = 200, ATTACH_MAX = 10;
const log = (level, msg, extra) => console.log(JSON.stringify({ level, msg, ...extra }));
const alreadyExists = (e) => !!e && (e.code === 6 || e.code === 'already-exists' || /ALREADY_EXISTS|already exists/i.test(String(e.message)));

// ---------------------------------------------------------------- reading one message ----------------------------------------------
const hdr = (msg, name) => { const h = ((msg && msg.payload && msg.payload.headers) || []).find((x) => String(x.name).toLowerCase() === name.toLowerCase()); return h ? String(h.value || '') : ''; };
// "Aoife Byrne <aoife@example.com>" or "aoife@example.com" -> { email (lower case), name } or null
function parseAddress(v) {
  const s = String(v || ''), m = /<([^<>]+)>/.exec(s), email = String(m ? m[1] : s).trim().toLowerCase();
  if (!Gmail.EMAIL_RE.test(email)) return null;
  return { email, name: m ? s.slice(0, m.index).replace(/["\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) : '' };
}
// Every address in a header such as "Aoife <a@b.ie>, c@d.ie" (To, Cc), lower case, in order, without repeats.
function parseAddresses(v) {
  const out = [];
  for (const m of String(v || '').matchAll(/<([^<>\s]+@[^<>\s]+)>|([^\s<>,;"]+@[^\s<>,;"]+)/g)) { const e = String(m[1] || m[2]).trim().toLowerCase(); if (Gmail.EMAIL_RE.test(e) && !out.includes(e)) out.push(e); }
  return out;
}
const decode = (data, charset) => {
  const buf = Buffer.from(String(data || ''), 'base64url');
  try { return new TextDecoder(String(charset || 'utf-8').toLowerCase()).decode(buf); } catch (e) { return buf.toString('utf8'); }
};
const charsetOf = (part) => { const m = /charset="?([\w\-:.]+)"?/i.exec(hdr({ payload: part }, 'Content-Type')); return m ? m[1] : 'utf-8'; };
const htmlToText = (h) => String(h).replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, '&').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
function partsOf(p, out = []) { if (!p) return out; out.push(p); for (const c of p.parts || []) partsOf(c, out); return out; }
// The readable text of a message: the text/plain part, else the text/html part turned into text.
function textOf(payload) {
  const all = partsOf(payload).filter((p) => !p.filename && p.body && p.body.data);
  const plain = all.find((p) => /^text\/plain/i.test(p.mimeType || '')), html = all.find((p) => /^text\/html/i.test(p.mimeType || ''));
  if (plain) return decode(plain.body.data, charsetOf(plain));
  if (html) return htmlToText(decode(html.body.data, charsetOf(html)));
  return '';
}
// Only what the customer wrote this time: the quoted history ("On Monday ... wrote:", "-----Original Message-----", Outlook's From/Sent block, lines starting with ">") is cut off.
function stripQuoted(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n'), keep = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], two = l + ' ' + (lines[i + 1] || '');
    if (/^\s*On .{5,200} wrote:\s*$/.test(l) || (/^\s*On .{5,200}$/.test(l) && /^\s*On .{5,250} wrote:\s*$/.test(two))) break;
    if (/^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i.test(l) || /^\s*_{10,}\s*$/.test(l) && /^\s*From:/i.test(lines[i + 1] || '')) break;
    if (/^\s*From:\s.+/i.test(l) && /^\s*(Sent|Date):/i.test(lines[i + 1] || '') && keep.length) break;
    if (/^\s*>/.test(l)) continue;
    keep.push(l);
  }
  const out = keep.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return out || String(text || '').trim();
}
// The parts of a message that are files, in order: the list kept in the chat (attachmentsOf) and the lookup of one file (emailAttachment.js) both use THIS, so "file number 1" is the same file in both.
const attachmentParts = (payload) => partsOf(payload).filter((p) => p.filename).slice(0, ATTACH_MAX);
const attachmentsOf = (payload) => attachmentParts(payload).map((p) => ({ name: String(p.filename).slice(0, 100), size: Number(p.body && p.body.size) || 0 }));

// ---------------------------------------------------------------- who is a customer ------------------------------------------------
// Every address Elite OS knows (customers and leads), one read of the contacts per sweep, and only when there is something new to look at.
async function loadIndex(db) {
  const snap = await db.collection('contacts').select('email').limit(5000).get(), idx = new Map();
  for (const d of snap.docs) { const e = String(d.data().email || '').trim().toLowerCase(); if (e && Gmail.EMAIL_RE.test(e)) idx.set(e, [...(idx.get(e) || []), d.id]); }
  return idx;
}
// One address can be on more than one customer: the chat that was active most recently.
async function chatFor(db, phones) {
  const docs = await Promise.all(phones.map((p) => db.collection('conversations').doc(p).get()));
  const live = docs.filter((d) => d.exists).sort((a, b) => ms(b.data().updatedAt) - ms(a.data().updatedAt));
  return live.length ? live[0].id : null;
}
const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : 0);

// ---------------------------------------------------------------- storing -----------------------------------------------------------
function emailDoc(full, from, atMs) {
  const refs = hdr(full, 'References').match(/<[^<>\s]{1,200}>/g) || [];
  return { direction: 'in', gmailId: full.id, threadId: full.threadId || null, messageId: (hdr(full, 'Message-ID').match(/<[^<>\s]{1,200}>/) || [null])[0], references: refs.slice(-10),
    subject: hdr(full, 'Subject').replace(/[\r\n]+/g, ' ').trim().slice(0, SUBJECT_MAX) || '(no subject)', fromEmail: from.email, fromName: from.name || null, to: parseAddress(hdr(full, 'To')) ? parseAddress(hdr(full, 'To')).email : null,
    body: stripQuoted(textOf(full.payload)).slice(0, BODY_MAX), attachments: attachmentsOf(full.payload), createdAt: Timestamp.fromMillis(atMs), receivedAt: FieldValue.serverTimestamp() };
}
// What the chat's own record says about its newest email, by the email's OWN time (not the time it was found): an older email found late never moves "newest" or the Inbox order back.
function newestPatch(cur, doc, dir) {
  const at = ms(doc.createdAt), patch = {};
  if (at >= ms(cur.lastEmailAt)) Object.assign(patch, { lastEmailAt: doc.createdAt, lastEmailSubject: doc.subject.slice(0, 120), lastEmailDir: dir });
  if (at > ms(cur.updatedAt)) patch.updatedAt = doc.createdAt;
  return patch;
}
async function keepInbound(db, phone, doc) {
  const convRef = db.collection('conversations').doc(phone);
  try { await convRef.collection('emails').doc('g_' + doc.gmailId).create(doc); } catch (e) { if (alreadyExists(e)) return false; throw e; }
  let name = null;
  await db.runTransaction(async (tx) => {
    const c = await tx.get(convRef);
    if (!c.exists) return;
    const cur = c.data(), at = ms(doc.createdAt), prev = ms(cur.emailInboundAt);
    name = cur.name || null;
    tx.update(convRef, { emailInboundAt: Timestamp.fromMillis(Math.max(at, prev)), ...newestPatch(cur, doc, 'in'), unreadCount: FieldValue.increment(1) });
  });
  await EmailLog.record(db, { id: 'g_' + doc.gmailId, phone, name, direction: 'in', kind: 'customer', subject: doc.subject, text: doc.body, email: doc.fromEmail, atMs: ms(doc.createdAt), gmailId: doc.gmailId });          // the list of all emails
  return true;
}

// An email YOU sent to this customer from Gmail: kept in their chat (direction out, kind 'gmail') and listed. It does not touch the unread count or "they wrote to us"; the chat shows it as the newest email and
// moves up the Inbox only if it is newer than what the chat already shows (an older email found late never moves anything back).
async function keepOutbound(db, phone, doc) {
  const convRef = db.collection('conversations').doc(phone);
  try { await convRef.collection('emails').doc('g_' + doc.gmailId).create(doc); } catch (e) { if (alreadyExists(e)) return false; throw e; }
  let name = null;
  await db.runTransaction(async (tx) => {
    const c = await tx.get(convRef);
    if (!c.exists) return;
    const cur = c.data(), patch = newestPatch(cur, doc, 'out');
    name = cur.name || null;
    if (Object.keys(patch).length) tx.update(convRef, patch);
  });
  await EmailLog.record(db, { id: 'g_' + doc.gmailId, phone, name, direction: 'out', kind: 'gmail', subject: doc.subject, text: doc.body, email: doc.to, atMs: ms(doc.createdAt), confirmed: true, by: 'Gmail', gmailId: doc.gmailId });
  return true;
}
// Did Elite OS send this email itself? Its own emails (a reply from a chat, a follow-up, the quote) are listed when they go out and ALSO land in the Sent folder: they are recognised by Google's message id, or (older ones)
// by the same subject to the same customer within ten minutes, and are not listed a second time.
const SAME_MAIL_MS = 10 * 60e3;
async function sentByElite(db, phone, gmailId, subject, atMs) {
  const want = EmailLog.oneLine(subject, 200), snap = await db.collection('emailLog').where('phone', '==', phone).get();
  return snap.docs.some((d) => { const x = d.data(); return x.direction === 'out' && (x.gmailId === gmailId || (x.kind !== 'gmail' && x.subject === want && Math.abs(ms(x.at) - atMs) <= SAME_MAIL_MS)); });
}

// ---------------------------------------------------------------- the sweep ---------------------------------------------------------
// reader: createGmailReader; mailbox: the business address. Two passes: what arrived in the inbox (customers' emails), then what was sent (emails you wrote to customers from Gmail).
const SENT_SETTLE_MS = 2 * 60e3;                                                              // a sent email is looked at once it is two minutes old, so Elite OS has finished recording its own sends first
async function sweep({ db, reader, mailbox, nowMs = Date.now() }) {
  const stateRef = db.doc('emailSync/state'), st = (await stateRef.get()).data() || {};
  const afterSec = Math.floor(((ms(st.lastSweepAt) || (nowMs - FIRST_WINDOW_MS)) - OVERLAP_MS) / 1000), seen = new Set(st.seen || []), own = String(mailbox || '').toLowerCase();
  const out = { listed: 0, looked: 0, matched: 0, stored: 0, sentMatched: 0, sentStored: 0, truncated: false };
  let fresh = [], freshSent = [];
  try {
    for (const [label, into] of [['INBOX', fresh], ['SENT', freshSent]]) {
      let page = null;
      for (let i = 0; i < MAX_PAGES; i++) { const r = await reader.list({ afterSec, pageToken: page, label }); out.listed += r.ids.length; into.push(...r.ids.filter((id) => !seen.has(id))); page = r.next; if (!page) break; }
    }
  } catch (e) {
    await stateRef.set({ lastError: { code: e.code || 'error', status: e.status || 0, at: Timestamp.fromMillis(nowMs) } }, { merge: true });
    log('error', 'email sweep could not list', { code: e.code, status: e.status });
    return { ...out, ok: false, error: e.code || 'error' };
  }
  const order = (ids) => [...new Set(ids)].reverse();                                         // oldest first
  fresh = order(fresh); freshSent = order(freshSent).filter((id) => !fresh.includes(id));
  if (fresh.length + freshSent.length > MAX_PER_RUN) { fresh = fresh.slice(0, MAX_PER_RUN); freshSent = freshSent.slice(0, Math.max(0, MAX_PER_RUN - fresh.length)); out.truncated = true; }
  let index = null, failed = false;
  const fail = (e) => { log('error', 'email not stored', { code: e.code, status: e.status }); if (e instanceof Gmail.GmailError && (e.status === 401 || e.status === 403 || e.status === 429)) { out.error = e.code; failed = true; } };
  for (const id of fresh) {                                                                    // ---- received: a customer wrote to the business mailbox
    try {
      out.looked++;
      const meta = await reader.get(id), from = parseAddress(hdr(meta, 'From'));
      if (!from || from.email === own || (meta.labelIds || []).includes('SENT')) { seen.add(id); continue; }       // our own mail is handled in the Sent pass
      index = index || await loadIndex(db);
      const phones = index.get(from.email);
      if (!phones) { seen.add(id); continue; }                                                 // not a customer: only the sender's address was looked at, nothing is kept
      out.matched++;
      const phone = await chatFor(db, phones);
      if (!phone) { seen.add(id); continue; }
      const full = await reader.get(id, { full: true }), at = Number(full.internalDate) || nowMs;
      if (await keepInbound(db, phone, emailDoc(full, from, at))) out.stored++;
      seen.add(id);
    } catch (e) { fail(e); if (failed) break; }
  }
  if (!failed) for (const id of freshSent) {                                                  // ---- sent: you wrote to a customer from Gmail
    if (seen.has(id)) continue;
    try {
      out.looked++;
      const meta = await reader.get(id, { headers: ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References'] }), at = Number(meta.internalDate) || nowMs;
      if (!(meta.labelIds || []).includes('SENT')) { seen.add(id); continue; }
      if (nowMs - at < SENT_SETTLE_MS) continue;                                               // too new: Elite OS may still be recording its own send; looked at next time (not marked seen)
      const to = parseAddresses(hdr(meta, 'To') + ',' + hdr(meta, 'Cc')).filter((a) => a !== own);
      if (!to.length) { seen.add(id); continue; }
      index = index || await loadIndex(db);
      const hit = to.find((a) => index.has(a));
      if (!hit) { seen.add(id); continue; }                                                    // not to a customer: only the recipients were looked at, nothing is kept
      out.sentMatched++;
      const phone = await chatFor(db, index.get(hit));
      if (!phone) { seen.add(id); continue; }
      const subject = hdr(meta, 'Subject').replace(/[\r\n]+/g, ' ').trim().slice(0, SUBJECT_MAX);
      if (await sentByElite(db, phone, id, subject, at)) { seen.add(id); continue; }           // Elite OS sent this one itself and has listed it already
      const full = await reader.get(id, { full: true }), from = parseAddress(hdr(full, 'From')) || { email: own, name: '' };
      const doc = { ...emailDoc(full, from, at), direction: 'out', kind: 'gmail', to: hit, by: 'Gmail', confirmed: true };
      if (await keepOutbound(db, phone, doc)) out.sentStored++;
      seen.add(id);
    } catch (e) { fail(e); if (failed) break; }
  }
  await stateRef.set({ lastSweepAt: Timestamp.fromMillis(out.truncated || out.error ? ms(st.lastSweepAt) || nowMs - FIRST_WINDOW_MS : nowMs), seen: [...seen].slice(-SEEN_KEEP), lastError: out.error ? { code: out.error, at: Timestamp.fromMillis(nowMs) } : FieldValue.delete(),
    lastRunAt: Timestamp.fromMillis(nowMs), lastStored: out.stored + out.sentStored }, { merge: true });
  return { ...out, ok: !out.error };
}

module.exports = { sweep, parseAddress, parseAddresses, keepOutbound, sentByElite, textOf, stripQuoted, attachmentsOf, attachmentParts, emailDoc, keepInbound, loadIndex, htmlToText, MAX_PER_RUN, BODY_MAX };
