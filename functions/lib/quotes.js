// Phase 6: quotes (docs/QUOTES.md). Elite OS is the source of truth and the browser only reads: every change goes through
// these functions, called by staff-only wrappers in handlers.js.
//   quotes/{id}                 one per quote, linked to the customer by phone (= contacts/{phone} = conversations/{phone})
//   quotes/{id}/versions/{n}    one per version; a sent version never changes again
//   quoteSettings/current       price list, VAT rate, validity period and business details printed on quotes
//   counters/quoteNumber        the next EK number (set once at cut-over; only goes up) and the TEST number used before that
//   Storage quotes/{phone}/{id}/v{n}-*.pdf   the exact PDF of each sent version (closed to browsers)
// Prices are calculated by quoteEngine.js (the browser's own figures are never stored). Pipeline effects are decided by
// quotePipeline.js inside the same transaction. Expiry is never stored: a Sent quote past its validity date is only shown as
// Expired, and every action stays available on it.
const crypto = require('crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const { Timestamp, FieldValue } = require('firebase-admin/firestore');
const QE = require('./quoteEngine');
const pipeline = require('./quotePipeline');
const { normalizePhone } = require('./whatsapp');

const TZ = 'Europe/Dublin';
const HISTORY_MAX = 50, PIPELINE_MAX = 20, VERSIONS_MAX = 50;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
const QUOTE_ID = /^q_[0-9a-f]{24}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TEXT = { notes: 2000, reason: 300 };
const VALUE_MAX = 1000000;                     // the pipeline value's own limit (handlers.js QUOTE_MAX)
const PDF_MAX = 25 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BUSINESS = { tradingName: 100, signatureName: 60, phone: 40, email: 200, web: 200, address: 300, vatNumber: 40 };

const bad = (msg, details) => new HttpsError('invalid-argument', msg, details);
const refused = (msg) => new HttpsError('failed-precondition', msg);
const CHANGED = 'This quote was changed by someone else. Please check it and try again.';

// ---- small helpers ----
function onlyKeys(data, allowed, what = 'details') {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad(`Missing ${what}.`);
  for (const k of Object.keys(data)) if (!allowed.includes(k)) throw bad(`Unknown field: ${k}`);
  return data;
}
function text(v, max, label) {
  if (v == null) return null;
  if (typeof v !== 'string') throw bad(`${label} must be text.`);
  const t = v.trim();
  if (t.length > max) throw bad(`${label} is too long (max ${max} characters).`);
  return t || null;
}
function flag(v, label) {
  if (v == null) return false;
  if (typeof v !== 'boolean') throw bad(`${label} must be yes or no.`);
  return v;
}
function wholeEuros(v) {                         // null = "leave the pipeline value as it is"
  if (v == null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > VALUE_MAX) throw bad('The pipeline value must be a whole number of euros (up to 1,000,000).');
  return v;
}
const isQuoteId = (id) => typeof id === 'string' && QUOTE_ID.test(id);
function quoteRef(db, id) {
  if (!isQuoteId(id)) throw bad('Missing quote.');
  return db.collection('quotes').doc(id);
}
const versionRef = (qRef, n) => qRef.collection('versions').doc(String(n));
function checkRev(q, expected) {
  if (!Number.isInteger(expected)) throw bad('Missing quote revision.');
  if (expected !== q.rev) throw refused(CHANGED);
}
const quoteId = (phone, requestId) => 'q_' + crypto.createHash('sha256').update(phone + '|' + requestId).digest('hex').slice(0, 24);
const capped = (list, entry, max) => [...(list || []), entry].slice(-max);
const at = (nowMs) => Timestamp.fromMillis(nowMs);
const pad4 = (n) => String(n).padStart(4, '0');

// Dates without a time (issue date, valid until) are Dublin calendar days, stored as "YYYY-MM-DD".
const dublinDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
function addDays(date, n) { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
const isExpired = (q, nowMs) => q.status === 'sent' && !!q.validUntil && dublinDate(nowMs) > q.validUntil;

// The calculator, with its input problems turned into a message staff can act on (all problems are in details.errors).
function priced(engineRef, answers, priceList, vatRate) {
  try {
    const engine = QE.get(engineRef);
    const v = engine.validate(answers);
    if (!v.ok) throw Object.assign(new Error(), { name: 'QuoteInputError', errors: v.errors });
    return { answers: v.answers, sheet: engine.calculate(v.answers, priceList, { vatRate }), sendProblems: engine.sendProblems(v.answers) };
  } catch (e) {
    if (e.name === 'QuoteInputError') throw bad(e.errors[0].message, { errors: e.errors });
    throw e;
  }
}
// What lists need, without opening a version: each option's price including VAT and the dearest one.
function summaryOf(sheet) {
  const options = sheet.options.map((o) => ({ key: o.key, name: o.name, incVat: o.incVat }));
  return { options, dearest: options.find((o) => o.key === sheet.dearest) || null };
}
const view = (id, q) => ({ id, ref: q.ref, status: q.status, rev: q.rev, currentVersion: q.currentVersion, sentVersion: q.sentVersion, draftVersion: q.draftVersion, validUntil: q.validUntil || null });
function withHistory(q, entry) {
  const h = q.history || [], last = h[h.length - 1];
  // Repeated saves of the same draft by the same person keep one "edited" entry (its time moves on).
  if (entry.action === 'edited' && last && last.action === 'edited' && last.version === entry.version && last.by === entry.by) return [...h.slice(0, -1), entry];
  return capped(h, entry, HISTORY_MAX);
}
const customerNameOf = (contact, conv) => (contact && contact.exists && contact.data().name) || (conv && conv.exists && conv.data().name) || null;

// ================================================== settings ==========================================================
function cleanSettings(data) {
  const priceList = QE.current().validatePriceList(data.priceList);
  if (!priceList.ok) throw bad(priceList.errors[0].message, { errors: priceList.errors.map((e) => ({ ...e, field: 'priceList.' + e.field })) });
  const vatRate = data.vatRate;
  if (typeof vatRate !== 'number' || !Number.isFinite(vatRate) || vatRate < 0 || vatRate > 100 || Math.abs(vatRate * 100 - Math.round(vatRate * 100)) > 1e-6) {
    throw bad('The VAT rate must be a percentage from 0 to 100 with at most 2 decimals.');
  }
  const validityDays = data.validityDays;
  if (!Number.isInteger(validityDays) || validityDays < 1 || validityDays > 365) throw bad('Quotes must be valid for 1 to 365 days.');
  const b = onlyKeys(data.business, Object.keys(BUSINESS), 'business details');
  const business = {};
  for (const [k, max] of Object.entries(BUSINESS)) business[k] = text(b[k], max, `Business ${k}`);
  if (!business.tradingName) throw bad('Enter the business name printed on quotes.');
  if (business.email && !EMAIL_RE.test(business.email)) throw bad('The business email address does not look right.');
  return { priceList: priceList.priceList, vatRate, validityDays, business };
}
async function saveSettings({ db }, actor, data, { nowMs = Date.now() } = {}) {
  onlyKeys(data, ['priceList', 'vatRate', 'validityDays', 'business', 'expectedRev']);
  const clean = cleanSettings(data);
  const ref = db.doc('quoteSettings/current');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? snap.data() : null;
    if (cur ? data.expectedRev !== cur.rev : (data.expectedRev != null && data.expectedRev !== 0)) {
      throw refused('Quote Settings were changed by someone else. Please check them and try again.');
    }
    const rev = (cur ? cur.rev : 0) + 1;
    tx.set(ref, { ...clean, rev, updatedAt: at(nowMs), updatedBy: actor, history: capped(cur && cur.history, { at: at(nowMs), by: actor.id, rev }, 20) });
    return { rev };
  });
}

// One-time setup at cut-over: the next EK number. Afterwards it can only go up, so no two quotes ever share a number.
async function setNumbering({ db }, actor, data, { nowMs = Date.now() } = {}) {
  onlyKeys(data, ['next']);
  if (!Number.isInteger(data.next) || data.next < 1 || data.next > 999999) throw bad('The next quote number must be a whole number from 1 to 999999.');
  const ref = db.doc('counters/quoteNumber');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? snap.data() : {};
    if (cur.next != null && data.next < cur.next) throw bad(`The next quote number can only go up (it is EK-${pad4(cur.next)}).`);
    tx.set(ref, { next: data.next, setAt: at(nowMs), setBy: actor }, { merge: true });
    return { next: data.next, ref: 'EK-' + pad4(data.next) };
  });
}

// ================================================== quotes ============================================================
// Create: a draft v1 for an existing customer, priced with today's Quote Settings. Takes the next number. No pipeline change.
async function create({ db }, actor, data, { nowMs = Date.now() } = {}) {
  onlyKeys(data, ['phone', 'requestId', 'answers']);
  const phone = normalizePhone(data.phone);
  if (phone.length < 9) throw bad('Missing customer.');
  if (typeof data.requestId !== 'string' || !REQUEST_ID.test(data.requestId)) throw bad('Missing request id.');
  const id = quoteId(phone, data.requestId);
  const ref = db.collection('quotes').doc(id);
  const convRef = db.collection('conversations').doc(phone), contactRef = db.collection('contacts').doc(phone);
  const settingsRef = db.doc('quoteSettings/current'), counterRef = db.doc('counters/quoteNumber');
  return db.runTransaction(async (tx) => {
    const [existing, conv, contact, settings, counter] = await Promise.all([tx.get(ref), tx.get(convRef), tx.get(contactRef), tx.get(settingsRef), tx.get(counterRef)]);
    if (existing.exists) return { ...view(id, existing.data()), existing: true };      // the same request again
    if (!conv.exists) throw new HttpsError('not-found', 'Customer not found.');
    if (!settings.exists) throw refused('Set up Quote Settings (prices and business details) before making quotes.');
    const s = settings.data();
    const engineRef = { ...QE.CURRENT };
    let answers = data.answers;
    if (answers === undefined) {
      // The project (kitchen, wardrobes...) starts as the customer's Project type; staff can change it on the quote.
      const projectType = (contact.exists && contact.data().projectType) || conv.data().projectType || null;
      try { answers = QE.get(engineRef).newAnswers(s.priceList, { projectType }); }
      catch (e) { if (e.name === 'QuoteInputError') throw refused('Quote Settings are incomplete: check the prices in Quote Settings.'); throw e; }
    }
    const p = priced(engineRef, answers, s.priceList, s.vatRate);
    const c = counter.exists ? counter.data() : {};
    let number = null, ref_, testNumber = null;
    if (c.next != null) { number = c.next; ref_ = 'EK-' + pad4(number); tx.set(counterRef, { next: number + 1 }, { merge: true }); }
    else { testNumber = c.testNext || 1; ref_ = 'TEST-' + pad4(testNumber); tx.set(counterRef, { testNext: testNumber + 1 }, { merge: true }); }
    const now = at(nowMs);
    const q = {
      phone, ref: ref_, number, testNumber, customerName: customerNameOf(contact, conv),
      status: 'draft', currentVersion: 1, sentVersion: null, draftVersion: 1,
      summary: summaryOf(p.sheet), sent: null, validUntil: null,
      sentAt: null, sentBy: null, acceptedOption: null, acceptedAt: null, acceptedBy: null, declinedAt: null, declinedBy: null, declineReason: null,
      notes: null, pipelineChanges: [], history: [{ action: 'created', at: now, by: actor.id, version: 1 }],
      rev: 1, requestId: data.requestId, lastSendRequestId: null, createdAt: now, createdBy: actor, updatedAt: now, updatedBy: actor,
    };
    tx.set(ref, q);
    tx.set(versionRef(ref, 1), { n: 1, state: 'draft', engine: engineRef, answers: p.answers, priceList: s.priceList, vatRate: s.vatRate, sheet: p.sheet,
      createdAt: now, createdBy: actor, updatedAt: now, updatedBy: actor });
    return { ...view(id, q), existing: false };
  });
}

// Save the draft (a new quote, or a revision of a sent one). "Update to current prices" swaps the frozen price list and VAT
// rate for today's Quote Settings; a sent version is never touched.
async function saveDraft({ db }, actor, data, { nowMs = Date.now() } = {}) {
  onlyKeys(data, ['id', 'expectedRev', 'answers', 'useCurrentPrices']);
  const ref = quoteRef(db, data.id);
  const useCurrent = flag(data.useCurrentPrices, 'Use current prices');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Quote not found.');
    const q = snap.data();
    checkRev(q, data.expectedRev);
    if (q.preparedSend) throw refused(IN_PROGRESS);                       // Phase 6.1: the draft is locked while a send is prepared
    if (q.draftVersion == null) throw refused('This quote has no draft. Revise it to make changes.');
    const vRef = versionRef(ref, q.draftVersion);
    const [vSnap, settings] = await Promise.all([tx.get(vRef), useCurrent ? tx.get(db.doc('quoteSettings/current')) : null]);
    const v = vSnap.data();
    let priceList = v.priceList, vatRate = v.vatRate;
    if (useCurrent) {
      if (!settings.exists) throw refused('Quote Settings are not set up.');
      ({ priceList, vatRate } = settings.data());
    }
    const p = priced(v.engine, data.answers === undefined ? v.answers : data.answers, priceList, vatRate);
    const now = at(nowMs);
    tx.update(vRef, { answers: p.answers, priceList, vatRate, sheet: p.sheet, updatedAt: now, updatedBy: actor });
    const patch = { summary: summaryOf(p.sheet), rev: q.rev + 1, updatedAt: now, updatedBy: actor,
      history: withHistory(q, { action: useCurrent ? 'prices updated' : 'edited', at: now, by: actor.id, version: q.draftVersion }) };
    tx.update(ref, patch);
    return { ...view(ref.id, { ...q, ...patch }), sendProblems: p.sendProblems };
  });
}

// ============================================== sending (shared pieces) ===============================================
// A quote becomes Sent in exactly one place, applySent. Phase 6's `send` (staff mark it sent by hand) and Phase 6.1's delivery
// (docs/PHASE6_1_PLAN.md: prepare, deliver through a channel, commit once a channel confirms) both go through the same four
// pieces, so they can never disagree about what is frozen, what the pipeline does or what is checked:
//   parseSend / storeSendPdf   the request, and the exact PDF (before the transaction)
//   checkSendable              what must still be true inside the transaction
//   applySent                  the ONLY place a version is frozen, the quote marked Sent and the pipeline rules applied
// `prepare` runs the same checks and stores the same PDF but marks NOTHING sent: it locks the draft (`prepared` on the version,
// `preparedSend` on the quote) until delivery decides. `commitPrepared` then applies applySent from what was frozen at prepare,
// in the transaction that records the first channel confirmed as delivered; `releasePrepared` unlocks the draft again.
const IN_PROGRESS = 'A send is already in progress for this quote: retry it, cancel it, or mark it sent first.';

function parseSend(db, data, nowMs, uid) {
  onlyKeys(data, ['id', 'expectedRev', 'requestId', 'issueDate', 'settingsRev', 'customer', 'pdfUploadPath', 'pipeline']);
  const ref = quoteRef(db, data.id);
  if (typeof data.requestId !== 'string' || !REQUEST_ID.test(data.requestId)) throw bad('Missing request id.');
  if (!Number.isInteger(data.expectedRev) || !Number.isInteger(data.settingsRev)) throw bad('Missing revision.');
  const pl = data.pipeline == null ? {} : onlyKeys(data.pipeline, ['reopen', 'value'], 'pipeline choices');
  const reopen = flag(pl.reopen, 'Reopen'), value = wholeEuros(pl.value);
  const cust = onlyKeys(data.customer, ['name', 'email', 'address'], 'customer details');
  const shown = { name: text(cust.name, 100, 'Name'), email: text(cust.email, 200, 'Email'), address: text(cust.address, 300, 'Address') };
  const today = dublinDate(nowMs), yesterday = addDays(today, -1);
  if (typeof data.issueDate !== 'string' || !DATE.test(data.issueDate) || (data.issueDate !== today && data.issueDate !== yesterday)) {
    throw bad('The issue date must be today.');
  }
  const upload = String(data.pdfUploadPath || '');
  if (!uid || !upload.startsWith(`uploads/${uid}/`) || upload.includes('..')) throw new HttpsError('permission-denied', 'Bad upload path.');
  return { ref, requestId: data.requestId, reopen, value, shown, upload };
}

// The PDF: must be a real PDF of sensible size. Stored under a path unique to this request, so two different sends racing
// for the same draft can never overwrite each other's file; the loser removes its own copy.
async function storeSendPdf(bucket, q0, ref, n, requestId, upload) {
  const upFile = bucket.file(upload);
  let buf;
  try { [buf] = await upFile.download(); } catch (e) { throw new HttpsError('not-found', 'The PDF upload was not found. Please try again.'); }
  if (buf.length < 8 || buf.length > PDF_MAX || buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw bad('The quote PDF is missing or not a PDF (max 25 MB).');
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const finalPath = `quotes/${q0.phone}/${ref.id}/v${n}-${crypto.createHash('sha256').update(requestId).digest('hex').slice(0, 12)}.pdf`;
  await bucket.file(finalPath).save(buf, { contentType: 'application/pdf', resumable: false });
  return { upFile, size: buf.length, sha256, finalPath };
}

// Inside the transaction, after the quote itself has been read: everything that must still be true. s = the snapshots read.
function checkSendable(s, data, n, shown) {
  checkRev(s.q, data.expectedRev);
  if (s.q.draftVersion !== n || !s.vSnap.exists) throw refused(CHANGED);
  if (!s.conv.exists) throw new HttpsError('not-found', 'Customer not found.');
  if (!s.settings.exists || s.settings.data().rev !== data.settingsRev) throw refused('Quote Settings changed while you were sending. Please check the quote again.');
  const ct = s.contact.exists ? s.contact.data() : {};
  const current = { name: customerNameOf(s.contact, s.conv), email: ct.email || null, address: ct.address || null };
  if (current.name !== shown.name || current.email !== shown.email || current.address !== shown.address) {
    throw refused("The customer's details changed while you were sending. Please check the quote again.");
  }
  const v = s.vSnap.data();
  const p = priced(v.engine, v.answers, v.priceList, v.vatRate);
  if (p.sendProblems.length) throw refused(p.sendProblems[0]);
  return { ct, current, v, p, settings: s.settings.data() };
}

// Freeze the version, mark the quote Sent, apply the pipeline rules. `via` (a delivery channel, or "manual") is recorded in the
// history; `delivered` also clears the lock set by prepare. Phase 6's own send passes neither, so its records are unchanged.
function applySent(tx, r, s, a) {
  const { ref, vRef, convRef, contactRef } = r;
  const { q, conv, contact, p } = s;
  const ct = contact.exists ? contact.data() : {};
  const now = at(a.nowMs);
  const stage = pipeline.planSend(conv.data(), { reopen: a.reopen }, a.nowMs);
  const val = pipeline.planValue(ct, a.value);
  tx.update(vRef, { state: 'sent', sheet: p.sheet, issueDate: a.issueDate, validUntil: a.validUntil, customer: { ...a.customer, phone: q.phone }, business: a.business,
    sentAt: now, sentBy: a.actor, pdf: a.pdf, ...(a.delivered ? { prepared: FieldValue.delete() } : {}) });
  if (stage) tx.update(convRef, stage.patch);
  if (val) tx.set(contactRef, { ...val.patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  const summary = summaryOf(p.sheet);
  const patch = {
    status: 'sent', currentVersion: a.n, sentVersion: a.n, draftVersion: null, summary, customerName: a.customer.name,
    sent: { version: a.n, issueDate: a.issueDate, validUntil: a.validUntil, summary }, validUntil: a.validUntil, sentAt: now, sentBy: a.actor,
    declinedAt: null, declinedBy: null, declineReason: null,
    pipelineChanges: capped(q.pipelineChanges, { action: 'sent', version: a.n, at: now, by: a.actor.id, stage: stage ? stage.change : null, value: val ? val.change : null }, PIPELINE_MAX),
    history: withHistory(q, { action: 'sent', at: now, by: a.actor.id, version: a.n, ...(a.via ? { via: a.via } : {}) }),
    lastSendRequestId: a.requestId, rev: q.rev + 1, updatedAt: now, updatedBy: a.actor,
    ...(a.delivered ? { preparedSend: FieldValue.delete() } : {}),
  };
  tx.update(ref, patch);
  return { ...view(ref.id, { ...q, ...patch }), existing: false, stage: stage ? stage.change : null, value: val ? val.change : null };
}

// Send the draft: freeze it (issue date, validity, customer and business details), store the exact PDF the customer gets,
// mark the quote Sent and apply the pipeline rules. The browser made the PDF from this draft, these customer details and
// these settings: if any of them changed meanwhile, the send is refused so the stored copy is always what was sent.
// This is "marked sent by hand" (Phase 6); Phase 6.1's delivery prepares first and marks Sent only after a channel confirms.
async function send({ db, bucket }, actor, data, { nowMs = Date.now(), uid } = {}) {
  const r = parseSend(db, data, nowMs, uid);
  const { ref, requestId } = r;
  const first = await ref.get();
  if (!first.exists) throw new HttpsError('not-found', 'Quote not found.');
  const q0 = first.data();
  if (q0.lastSendRequestId === requestId) return { ...view(ref.id, q0), existing: true };   // the same request again
  if (q0.preparedSend) throw refused(IN_PROGRESS);
  checkRev(q0, data.expectedRev);
  if (q0.draftVersion == null) throw refused('There is nothing to send: revise the quote first.');
  const n = q0.draftVersion;

  const stored = await storeSendPdf(bucket, q0, ref, n, requestId, r.upload);
  const convRef = db.collection('conversations').doc(q0.phone), contactRef = db.collection('contacts').doc(q0.phone);
  let result;
  try {
    result = await db.runTransaction(async (tx) => {
      const vRef = versionRef(ref, n);
      const [snap, vSnap, conv, contact, settings] = await Promise.all([tx.get(ref), tx.get(vRef), tx.get(convRef), tx.get(contactRef), tx.get(db.doc('quoteSettings/current'))]);
      if (!snap.exists) throw new HttpsError('not-found', 'Quote not found.');
      const q = snap.data();
      if (q.lastSendRequestId === requestId) return { ...view(ref.id, q), existing: true };
      if (q.preparedSend) throw refused(IN_PROGRESS);
      const c = checkSendable({ q, vSnap, conv, contact, settings }, data, n, r.shown);
      const validUntil = addDays(data.issueDate, c.settings.validityDays);
      return applySent(tx, { ref, vRef, convRef, contactRef }, { q, conv, contact, p: c.p }, { n, actor, nowMs, requestId, issueDate: data.issueDate, validUntil,
        customer: c.current, business: c.settings.business, pdf: { path: stored.finalPath, size: stored.size, sha256: stored.sha256 }, reopen: r.reopen, value: r.value });
    });
  } catch (e) {
    await bucket.file(stored.finalPath).delete({ ignoreNotFound: true }).catch(() => {});   // this request's own copy only
    throw e;
  }
  // (A repeat of the same request that raced the first one lands on the same path with the same file: nothing to remove.)
  await stored.upFile.delete({ ignoreNotFound: true }).catch(() => {});
  return result;
}

// Phase 6.1: the same request, the same checks and the same stored PDF as `send`, but NOTHING is marked sent. The draft is locked
// (editing, discarding and deleting are refused) until the delivery commits, or the send is cancelled. `inTx(tx, ctx)` lets the
// delivery module create its records in this same transaction (writes only: every read has already happened).
// The same request again returns what exists ({ existing: true }, { committed: true } once a channel has confirmed).
async function prepare({ db, bucket }, actor, data, { nowMs = Date.now(), uid, inTx } = {}) {
  const r = parseSend(db, data, nowMs, uid);
  const { ref, requestId } = r;
  const first = await ref.get();
  if (!first.exists) throw new HttpsError('not-found', 'Quote not found.');
  const q0 = first.data();
  if (q0.lastSendRequestId === requestId) return { ...view(ref.id, q0), existing: true, committed: true };
  if (q0.preparedSend && q0.preparedSend.requestId === requestId) return { ...view(ref.id, q0), existing: true, committed: false, version: q0.preparedSend.version };
  if (q0.preparedSend) throw refused(IN_PROGRESS);
  checkRev(q0, data.expectedRev);
  if (q0.draftVersion == null) throw refused('There is nothing to send: revise the quote first.');
  const n = q0.draftVersion;

  const stored = await storeSendPdf(bucket, q0, ref, n, requestId, r.upload);
  const convRef = db.collection('conversations').doc(q0.phone), contactRef = db.collection('contacts').doc(q0.phone);
  let result;
  try {
    result = await db.runTransaction(async (tx) => {
      const vRef = versionRef(ref, n);
      const [snap, vSnap, conv, contact, settings] = await Promise.all([tx.get(ref), tx.get(vRef), tx.get(convRef), tx.get(contactRef), tx.get(db.doc('quoteSettings/current'))]);
      if (!snap.exists) throw new HttpsError('not-found', 'Quote not found.');
      const q = snap.data();
      if (q.lastSendRequestId === requestId) return { ...view(ref.id, q), existing: true, committed: true };
      if (q.preparedSend && q.preparedSend.requestId === requestId) return { ...view(ref.id, q), existing: true, committed: false, version: q.preparedSend.version };
      if (q.preparedSend) throw refused(IN_PROGRESS);
      const c = checkSendable({ q, vSnap, conv, contact, settings }, data, n, r.shown);
      const validUntil = addDays(data.issueDate, c.settings.validityDays);
      const now = at(nowMs), pdf = { path: stored.finalPath, size: stored.size, sha256: stored.sha256 };
      tx.update(vRef, { prepared: { requestId, at: now, by: actor, pdf, issueDate: data.issueDate, validUntil, customer: c.current, business: c.settings.business,
        pipeline: { reopen: r.reopen, value: r.value } } });
      const patch = { preparedSend: { version: n, requestId }, history: withHistory(q, { action: 'send started', at: now, by: actor.id, version: n }), rev: q.rev + 1, updatedAt: now, updatedBy: actor };
      tx.update(ref, patch);
      if (inTx) inTx(tx, { ref, q, n, requestId, pdf, customer: c.current, business: c.settings.business, now });
      return { ...view(ref.id, { ...q, ...patch }), existing: false, committed: false, version: n, requestId, customer: c.current, pdf };
    });
  } catch (e) {
    await bucket.file(stored.finalPath).delete({ ignoreNotFound: true }).catch(() => {});   // this request's own copy only
    throw e;
  }
  await stored.upFile.delete({ ignoreNotFound: true }).catch(() => {});
  return result;
}

// Phase 6.1, for the delivery module's own transactions: read what a commit needs (all reads, before any write)...
async function readState(tx, db, id, n) {
  const ref = quoteRef(db, id);
  const snap = await tx.get(ref);
  if (!snap.exists) return null;                                                // the customer was erased meanwhile: nothing to write
  const q = snap.data();
  const vRef = versionRef(ref, n), convRef = db.collection('conversations').doc(q.phone), contactRef = db.collection('contacts').doc(q.phone);
  const [vSnap, conv, contact] = await Promise.all([tx.get(vRef), tx.get(convRef), tx.get(contactRef)]);
  return { ref, vRef, convRef, contactRef, q, n, vSnap, conv, contact };
}
// ...and commit: mark the prepared version Sent from what was frozen at prepare, exactly as `send` does (applySent). Does nothing
// when this request has already committed (a second channel confirming) or the preparation is gone.
function commitPrepared(tx, st, actor, nowMs, requestId, via) {
  const { q, n, vSnap, conv, contact } = st;
  if (q.lastSendRequestId === requestId) return { committed: false, already: true };
  const v = vSnap.exists ? vSnap.data() : null, prep = v && v.prepared;
  if (!prep || prep.requestId !== requestId || q.draftVersion !== n || !conv.exists) return { committed: false, already: false };
  const p = priced(v.engine, v.answers, v.priceList, v.vatRate);
  const r = applySent(tx, st, { q, conv, contact, p }, { n, actor, nowMs, requestId, issueDate: prep.issueDate, validUntil: prep.validUntil, customer: prep.customer,
    business: prep.business, pdf: prep.pdf, reopen: prep.pipeline.reopen, value: prep.pipeline.value, via, delivered: true });
  return { committed: true, already: false, stage: r.stage, value: r.value };
}
// Unlock the draft: only the delivery module calls this, and only when nothing was delivered.
function releasePrepared(tx, st, actor, nowMs) {
  const { ref, vRef, q } = st, now = at(nowMs);
  tx.update(vRef, { prepared: FieldValue.delete() });
  tx.update(ref, { preparedSend: FieldValue.delete(), history: withHistory(q, { action: 'send cancelled', at: now, by: actor.id, version: q.preparedSend.version }),
    rev: q.rev + 1, updatedAt: now, updatedBy: actor });
}

// Accept: the customer chose one option of the version they were sent. Allowed on an expired quote (the answer says so).
async function accept({ db }, actor, data, { nowMs = Date.now() } = {}) {
  onlyKeys(data, ['id', 'expectedRev', 'option', 'pipeline']);
  const ref = quoteRef(db, data.id);
  const pl = data.pipeline == null ? {} : onlyKeys(data.pipeline, ['moveClosed', 'value'], 'pipeline choices');
  const moveClosed = flag(pl.moveClosed, 'Move to Won'), value = wholeEuros(pl.value);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Quote not found.');
    const q = snap.data();
    checkRev(q, data.expectedRev);
    if (q.status === 'accepted') throw refused('This quote is already accepted.');
    if (q.status !== 'sent') throw refused(q.status === 'declined' ? 'This quote was declined. Reopen it first.' : 'Send the quote before marking it accepted.');
    if (q.draftVersion != null) throw refused('Send or discard the draft changes first.');
    const convRef = db.collection('conversations').doc(q.phone), contactRef = db.collection('contacts').doc(q.phone);
    const [vSnap, conv, contact] = await Promise.all([tx.get(versionRef(ref, q.sentVersion)), tx.get(convRef), tx.get(contactRef)]);
    const option = vSnap.data().sheet.options.find((o) => o.key === data.option);
    if (!option) throw bad('Choose one of the options on the quote.');
    if (!conv.exists) throw new HttpsError('not-found', 'Customer not found.');
    const now = at(nowMs);
    const stage = pipeline.planAccept(conv.data(), { moveClosed }, nowMs);
    const val = pipeline.planValue(contact.exists ? contact.data() : {}, value);
    if (stage) tx.update(convRef, stage.patch);
    if (val) tx.set(contactRef, { ...val.patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    const patch = {
      status: 'accepted', acceptedOption: { key: option.key, name: option.name, incVat: option.incVat, version: q.sentVersion }, acceptedAt: now, acceptedBy: actor,
      pipelineChanges: capped(q.pipelineChanges, { action: 'accepted', version: q.sentVersion, at: now, by: actor.id, stage: stage ? stage.change : null, value: val ? val.change : null }, PIPELINE_MAX),
      history: withHistory(q, { action: 'accepted', at: now, by: actor.id, version: q.sentVersion, option: option.key }),
      rev: q.rev + 1, updatedAt: now, updatedBy: actor,
    };
    tx.update(ref, patch);
    return { ...view(ref.id, { ...q, ...patch }), expired: isExpired(q, nowMs), stage: stage ? stage.change : null, value: val ? val.change : null };
  });
}

// Decline: the customer said no to this quote. Never changes the customer's stage or pipeline value.
async function decline({ db }, actor, data, { nowMs = Date.now() } = {}) {
  onlyKeys(data, ['id', 'expectedRev', 'reason']);
  const ref = quoteRef(db, data.id);
  const reason = text(data.reason, TEXT.reason, 'Reason');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Quote not found.');
    const q = snap.data();
    checkRev(q, data.expectedRev);
    if (q.status !== 'sent') throw refused(q.status === 'declined' ? 'This quote is already declined.' : q.status === 'accepted' ? 'This quote was accepted. Reopen it first.' : 'Send the quote before marking it declined.');
    const now = at(nowMs);
    const patch = { status: 'declined', declinedAt: now, declinedBy: actor, declineReason: reason,
      history: withHistory(q, { action: 'declined', at: now, by: actor.id, version: q.sentVersion }), rev: q.rev + 1, updatedAt: now, updatedBy: actor };
    tx.update(ref, patch);
    return view(ref.id, { ...q, ...patch });
  });
}

// Reopen an accepted or declined quote (back to Sent). For an accepted one, staff may also move the customer back to the stage
// the accept moved them from (only while they are still in Won) and restore the pipeline value (only if nobody changed it).
async function reopen({ db }, actor, data, { nowMs = Date.now() } = {}) {
  onlyKeys(data, ['id', 'expectedRev', 'pipeline']);
  const ref = quoteRef(db, data.id);
  const pl = data.pipeline == null ? {} : onlyKeys(data.pipeline, ['moveBack', 'restoreValue'], 'pipeline choices');
  const moveBack = flag(pl.moveBack, 'Move back'), restoreValue = flag(pl.restoreValue, 'Restore value');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Quote not found.');
    const q = snap.data();
    checkRev(q, data.expectedRev);
    if (q.status !== 'accepted' && q.status !== 'declined') throw refused('Only an accepted or declined quote can be reopened.');
    if (q.status === 'declined' && (moveBack || restoreValue)) throw bad('Declining did not change the pipeline, so there is nothing to undo.');
    const now = at(nowMs);
    let stage = null, val = null;
    if (moveBack || restoreValue) {
      const last = [...(q.pipelineChanges || [])].reverse().find((c) => c.action === 'accepted') || {};
      const convRef = db.collection('conversations').doc(q.phone), contactRef = db.collection('contacts').doc(q.phone);
      const [conv, contact] = await Promise.all([tx.get(convRef), tx.get(contactRef)]);
      if (moveBack) {
        if (!conv.exists || !pipeline.canMoveBack(conv.data(), last.stage)) throw refused('The customer was not moved by this quote, or is no longer in Won, so they were not moved back.');
        stage = pipeline.planMoveBack(conv.data(), last.stage, nowMs);
        if (stage) tx.update(convRef, stage.patch);
      }
      if (restoreValue) {
        const ct = contact.exists ? contact.data() : {};
        if (!pipeline.canRestoreValue(ct, last.value)) throw refused('The pipeline value was not set by this quote, or was changed since, so it was not restored.');
        val = pipeline.planRestoreValue(ct, last.value);
        tx.set(contactRef, { ...val.patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
    }
    const was = q.status;
    const patch = {
      status: 'sent', acceptedOption: null, acceptedAt: null, acceptedBy: null, declinedAt: null, declinedBy: null, declineReason: null,
      history: withHistory(q, { action: `reopened (was ${was})`, at: now, by: actor.id, version: q.sentVersion }),
      rev: q.rev + 1, updatedAt: now, updatedBy: actor,
    };
    if (stage || val) patch.pipelineChanges = capped(q.pipelineChanges, { action: 'reopened', version: q.sentVersion, at: now, by: actor.id, stage: stage ? stage.change : null, value: val ? val.change : null }, PIPELINE_MAX);
    tx.update(ref, patch);
    return { ...view(ref.id, { ...q, ...patch }), stage: stage ? stage.change : null, value: val ? val.change : null };
  });
}

// Revise: start the next version as a draft, a copy of the version the customer has, with its prices still frozen.
// Renew = revise + send with no changes (new issue date and validity).
async function revise({ db }, actor, data, { nowMs = Date.now() } = {}) {
  onlyKeys(data, ['id', 'expectedRev']);
  const ref = quoteRef(db, data.id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Quote not found.');
    const q = snap.data();
    checkRev(q, data.expectedRev);
    if (q.status !== 'sent' && q.status !== 'declined') throw refused(q.status === 'accepted' ? 'This quote was accepted. Reopen it first.' : 'This quote is still a draft: edit it directly.');
    if (q.draftVersion != null) throw refused('A draft revision already exists.');
    if (q.currentVersion >= VERSIONS_MAX) throw refused(`A quote can have at most ${VERSIONS_MAX} versions. Start a new quote instead.`);
    const sent = (await tx.get(versionRef(ref, q.sentVersion))).data();
    const n = q.currentVersion + 1, now = at(nowMs);
    tx.set(versionRef(ref, n), { n, state: 'draft', engine: sent.engine, answers: sent.answers, priceList: sent.priceList, vatRate: sent.vatRate, sheet: sent.sheet,
      createdAt: now, createdBy: actor, updatedAt: now, updatedBy: actor });
    const patch = { currentVersion: n, draftVersion: n, summary: summaryOf(sent.sheet), history: withHistory(q, { action: 'revised', at: now, by: actor.id, version: n }),
      rev: q.rev + 1, updatedAt: now, updatedBy: actor };
    tx.update(ref, patch);
    return view(ref.id, { ...q, ...patch });
  });
}

// Discard a revision that was never sent: back to the version the customer has.
async function discardDraft({ db }, actor, data, { nowMs = Date.now() } = {}) {
  onlyKeys(data, ['id', 'expectedRev']);
  const ref = quoteRef(db, data.id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Quote not found.');
    const q = snap.data();
    checkRev(q, data.expectedRev);
    if (q.preparedSend) throw refused(IN_PROGRESS);                       // Phase 6.1: cancel the prepared send first
    if (q.draftVersion == null || q.sentVersion == null) throw refused(q.sentVersion == null ? 'This quote was never sent: delete it instead.' : 'There is no draft revision to discard.');
    const now = at(nowMs);
    tx.delete(versionRef(ref, q.draftVersion));
    const patch = { currentVersion: q.sentVersion, draftVersion: null, summary: q.sent.summary,
      history: withHistory(q, { action: 'draft discarded', at: now, by: actor.id, version: q.draftVersion }), rev: q.rev + 1, updatedAt: now, updatedBy: actor };
    tx.update(ref, patch);
    return view(ref.id, { ...q, ...patch });
  });
}

// Delete a quote that was never sent. A sent quote is the record of what the customer received: it is erased only with the
// customer. The number is not reused. The audit entry holds no customer details.
async function deleteDraft({ db }, actor, data, { nowMs = Date.now() } = {}) {
  onlyKeys(data, ['id', 'expectedRev']);
  const ref = quoteRef(db, data.id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Quote not found.');
    const q = snap.data();
    checkRev(q, data.expectedRev);
    if (q.preparedSend) throw refused(IN_PROGRESS);                       // Phase 6.1: cancel the prepared send first
    if (q.sentVersion != null) throw refused('A quote that was sent cannot be deleted: it is the record of what the customer received.');
    const [versions, deliveries] = await Promise.all([tx.get(ref.collection('versions')), tx.get(ref.collection('deliveries'))]);   // Phase 6.1: cancelled sends leave delivery records
    versions.docs.forEach((d) => tx.delete(d.ref));
    deliveries.docs.forEach((d) => tx.delete(d.ref));
    tx.delete(ref);
    tx.set(db.collection('auditLog').doc(), { action: 'deleteQuote', quoteRef: q.ref, by: actor.id, at: at(nowMs) });
    return { id: ref.id, deleted: true };
  });
}

// Internal notes on the quote (never printed). Allowed in every status.
async function setNotes({ db }, actor, data, { nowMs = Date.now() } = {}) {
  onlyKeys(data, ['id', 'expectedRev', 'notes']);
  const ref = quoteRef(db, data.id);
  const notes = text(data.notes, TEXT.notes, 'Notes');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Quote not found.');
    const q = snap.data();
    checkRev(q, data.expectedRev);
    const patch = { notes, rev: q.rev + 1, updatedAt: at(nowMs), updatedBy: actor };
    tx.update(ref, patch);
    return view(ref.id, { ...q, ...patch });
  });
}

// A 10-minute link to the stored PDF of a sent version. The bucket itself is closed to browsers.
async function pdfLink({ db, bucket }, actor, data, { signedUrl }) {
  onlyKeys(data, ['id', 'version', 'download']);
  const ref = quoteRef(db, data.id);
  if (!Number.isInteger(data.version) || data.version < 1) throw bad('Missing version.');
  const [snap, vSnap] = await Promise.all([ref.get(), versionRef(ref, data.version).get()]);
  if (!snap.exists || !vSnap.exists) throw new HttpsError('not-found', 'Quote not found.');
  const q = snap.data(), vd = vSnap.data(), pdf = vd.pdf || (vd.prepared && vd.prepared.pdf);     // Phase 6.1: a prepared (not yet delivered) PDF can be downloaded too
  if (!pdf || !pdf.path) throw new HttpsError('not-found', 'This version has no stored PDF (it was not sent).');
  if (!pdf.path.startsWith(`quotes/${q.phone}/${ref.id}/`)) throw new HttpsError('permission-denied', 'Bad file path.');     // defence in depth
  if (!(await bucket.file(pdf.path).exists())[0]) throw new HttpsError('not-found', 'The stored PDF is missing.');
  const url = await signedUrl(bucket, pdf.path, { filename: `EliteKitchens-${q.ref}-v${data.version}.pdf`, mime: 'application/pdf', download: flag(data.download, 'Download') });
  return { url, filename: `EliteKitchens-${q.ref}-v${data.version}.pdf`, size: pdf.size };
}

// Small helpers for the delivery module (quoteDelivery.js), which keeps its own records but must validate, order and word things
// exactly as this module does.
const H = { onlyKeys, text, bad, refused, checkRev, quoteRef, versionRef, capped, at, view, REQUEST_ID };

module.exports = {
  TZ, HISTORY_MAX, VERSIONS_MAX, PDF_MAX, dublinDate, addDays, isExpired, isQuoteId, quoteId,
  saveSettings, setNumbering, create, saveDraft, send, accept, decline, reopen, revise, discardDraft, deleteDraft, setNotes, pdfLink,
  IN_PROGRESS, prepare, readState, commitPrepared, releasePrepared, H,
};
