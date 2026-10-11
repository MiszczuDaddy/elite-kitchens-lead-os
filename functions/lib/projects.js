// Phase 7: projects (docs/PROJECTS.md). One project per accepted quote (or made by hand), so the owner can see where each customer's job stands and what
// still has to be ordered. Elite OS is the source of truth and the browser only reads: every change goes through these functions, called by staff-only wrappers in handlers.js.
//   projects/{id}                          p_<24 hex> = the project of one quote (the SAME 24 hex as the quote's id: a second project for a quote cannot exist);
//                                          m_<24 hex> = made by hand with no quote
//   Storage projects/{phone}/{id}/render-* the approved 3D render (closed to browsers; staff see it through a short-lived signed link)
// NOT here, on purpose: manufacturing, stock, whether anything has arrived, suppliers. Five yes/no steps, an install date, notes, one render.
// The five steps are INDEPENDENT: any of them can be ticked or cleared at any time, in any order.
const crypto = require('crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const { Timestamp } = require('firebase-admin/firestore');
const { normalizePhone } = require('./whatsapp');
const mediaLib = require('./media');

const STEPS = ['designApproved', 'carcassesOrdered', 'doorsOrdered', 'readyForInstall', 'installed'];
const HISTORY_MAX = 60, NOTES_MAX = 2000, RENDER_MAX = 25 * 1024 * 1024;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
const QUOTE_ID = /^q_[0-9a-f]{24}$/;
const PROJECT_ID = /^[pm]_[0-9a-f]{24}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const bad = (msg) => new HttpsError('invalid-argument', msg);
const refused = (msg) => new HttpsError('failed-precondition', msg);
const notFound = (msg) => new HttpsError('not-found', msg);
const CHANGED = 'This project was changed by someone else. Please check it and try again.';

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
function dateOrNull(v) {
  if (v == null || v === '') return null;
  const m = typeof v === 'string' ? DATE.exec(v) : null;
  if (!m) throw bad('The installation date must look like 2026-11-20.');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])], t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || y < 2024 || y > 2100) throw bad('That installation date does not exist.');
  return v;
}
const capped = (list, entry) => [...(list || []), entry].slice(-HISTORY_MAX);
const at = (nowMs) => Timestamp.fromMillis(nowMs);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);

const idForQuote = (quoteId) => 'p_' + quoteId.slice(2);
const idForManual = (phone, requestId) => 'm_' + sha(phone + '|' + requestId);
const projectRef = (db, id) => { if (typeof id !== 'string' || !PROJECT_ID.test(id)) throw bad('Missing project.'); return db.collection('projects').doc(id); };
const refForQuote = (db, quoteId) => db.collection('projects').doc(idForQuote(quoteId));
const view = (id, p) => ({ id, status: p.status, rev: p.rev });
const customerNameOf = (contact, conv) => (contact && contact.exists && contact.data().name) || (conv && conv.exists && conv.data().name) || null;

const blankSteps = () => Object.fromEntries(STEPS.map((k) => [k, { done: false, at: null, by: null }]));
function newProject({ phone, customerName, quote, option, via, actor, now }) {
  return {
    phone, customerName: customerName || null,
    quoteId: quote ? quote.id : null, quoteRef: quote ? quote.ref : null, quoteOption: option || null, quoteStatus: quote ? 'accepted' : null,
    status: 'active', steps: blankSteps(), installDate: null, notes: null, render: null,
    rev: 1, createdVia: via, createdAt: now, createdBy: actor, completedAt: null, completedBy: null, updatedAt: now, updatedBy: actor,
    history: [{ action: via === 'quote' ? 'created (quote accepted)' : 'created by hand', at: now, by: actor.id }],
  };
}

// ---- called from inside the quote's own transaction (quotes.js): the quote and its project change together or not at all ----
// Accepting: no project yet -> make it. One already there (the quote was reopened and accepted again, or someone made it by hand) -> only refresh the link; the steps,
// the date, the notes, the render and "completed" are never touched, so a second accept can never reset anything and never makes a second project.
function planAccept(pSnap, ref, { phone, customerName, quote, option, actor, nowMs }) {
  const now = at(nowMs);
  if (!pSnap.exists) return { ref, create: newProject({ phone, customerName, quote, option, via: 'quote', actor, now }) };
  const p = pSnap.data();
  return { ref, update: { customerName: customerName || p.customerName || null, quoteId: quote.id, quoteRef: quote.ref, quoteOption: option, quoteStatus: 'accepted',
    history: capped(p.history, { action: 'quote accepted again', at: now, by: actor.id }), updatedAt: now, updatedBy: actor } };
}
// Reopening an accepted quote: the project stays (nothing is deleted behind anyone's back) but shows that the quote is open again.
function planReopen(pSnap, ref, { actor, nowMs }) {
  if (!pSnap.exists) return null;
  const p = pSnap.data(), now = at(nowMs);
  return { ref, update: { quoteStatus: 'reopened', history: capped(p.history, { action: 'quote reopened', at: now, by: actor.id }), updatedAt: now, updatedBy: actor } };
}

// ---- made by hand: from the customer's profile, optionally linked to one of their accepted quotes ----
async function create({ db }, actor, data, { nowMs = Date.now() } = {}) {
  onlyKeys(data, ['phone', 'requestId', 'quoteId']);
  const phone = normalizePhone(data.phone);
  if (phone.length < 9) throw bad('Missing customer.');
  if (typeof data.requestId !== 'string' || !REQUEST_ID.test(data.requestId)) throw bad('Missing request id.');
  const qid = data.quoteId == null ? null : data.quoteId;
  if (qid !== null && (typeof qid !== 'string' || !QUOTE_ID.test(qid))) throw bad('Missing quote.');
  const ref = qid ? refForQuote(db, qid) : db.collection('projects').doc(idForManual(phone, data.requestId));
  const convRef = db.collection('conversations').doc(phone), contactRef = db.collection('contacts').doc(phone);
  return db.runTransaction(async (tx) => {
    const reads = [tx.get(ref), tx.get(convRef), tx.get(contactRef), qid ? tx.get(db.collection('quotes').doc(qid)) : null];
    const [existing, conv, contact, quoteSnap] = await Promise.all(reads);
    if (existing.exists) {
      if (existing.data().phone !== phone) throw refused('That quote belongs to another customer.');
      return { ...view(ref.id, existing.data()), existing: true };           // the same request again, or the quote already has its project: never a second one
    }
    if (!conv.exists) throw notFound('Customer not found.');
    let quote = null, option = null;
    if (qid) {
      if (!quoteSnap.exists || quoteSnap.data().phone !== phone) throw refused('That quote was not found for this customer.');
      const q = quoteSnap.data();
      if (q.status !== 'accepted' || !q.acceptedOption) throw refused('Only an accepted quote can be linked to a project.');
      quote = { id: qid, ref: q.ref }; option = q.acceptedOption;
    }
    const p = newProject({ phone, customerName: customerNameOf(contact, conv), quote, option, via: 'manual', actor, now: at(nowMs) });
    tx.set(ref, p);
    return { ...view(ref.id, p), existing: false };
  });
}

// ---- the installation date and the notes (together with the revision, so two people cannot overwrite each other without a word) ----
// `rev` counts only these saves. Ticking a step does not change it: two people ticking different boxes never get in each other's way.
async function save({ db }, actor, data, { nowMs = Date.now() } = {}) {
  onlyKeys(data, ['id', 'expectedRev', 'installDate', 'notes']);
  const ref = projectRef(db, data.id);
  if (!('installDate' in data) && !('notes' in data)) throw bad('Nothing to save.');
  if (!Number.isInteger(data.expectedRev)) throw bad('Missing project revision.');
  const date = 'installDate' in data ? dateOrNull(data.installDate) : undefined;
  const notes = 'notes' in data ? text(data.notes, NOTES_MAX, 'Notes') : undefined;
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound('Project not found.');
    const p = snap.data();
    if (data.expectedRev !== p.rev) throw refused(CHANGED);
    const now = at(nowMs), patch = { rev: p.rev + 1, updatedAt: now, updatedBy: actor };
    if (date !== undefined) patch.installDate = date;
    if (notes !== undefined) patch.notes = notes;
    if (date !== undefined && date !== (p.installDate || null)) patch.history = capped(p.history, { action: date ? `installation date set to ${date}` : 'installation date cleared', at: now, by: actor.id });
    tx.update(ref, patch);
    return view(ref.id, { ...p, ...patch });
  });
}

// ---- one box of the checklist, ticked or cleared; independent of every other box ----
async function setStep({ db }, actor, data, { nowMs = Date.now() } = {}) {
  onlyKeys(data, ['id', 'step', 'done']);
  const ref = projectRef(db, data.id);
  if (!STEPS.includes(data.step)) throw bad('Unknown step.');
  if (typeof data.done !== 'boolean') throw bad('The step must be ticked or cleared.');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound('Project not found.');
    const p = snap.data();
    if (p.status === 'completed') throw refused('This project is completed. Reopen it to change it.');
    if (!!(p.steps && p.steps[data.step] && p.steps[data.step].done) === data.done) return { ...view(ref.id, p), unchanged: true };      // already so: nothing is written
    const now = at(nowMs);
    tx.update(ref, { [`steps.${data.step}`]: { done: data.done, at: data.done ? now : null, by: data.done ? actor.id : null },
      history: capped(p.history, { action: data.done ? 'ticked' : 'cleared', step: data.step, at: now, by: actor.id }), updatedAt: now, updatedBy: actor });
    return { ...view(ref.id, p), unchanged: false };
  });
}

// ---- completed (leaves the active list) and back ----
async function complete({ db }, actor, data, { nowMs = Date.now() } = {}) {
  onlyKeys(data, ['id', 'reopen']);
  const ref = projectRef(db, data.id);
  if (data.reopen != null && typeof data.reopen !== 'boolean') throw bad('Reopen must be yes or no.');
  const reopen = data.reopen === true;
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound('Project not found.');
    const p = snap.data(), want = reopen ? 'active' : 'completed';
    if (p.status === want) return { ...view(ref.id, p), unchanged: true };
    const now = at(nowMs);
    const patch = reopen ? { status: 'active', completedAt: null, completedBy: null } : { status: 'completed', completedAt: now, completedBy: actor };
    patch.history = capped(p.history, { action: reopen ? 'reopened' : 'completed', at: now, by: actor.id }); patch.updatedAt = now; patch.updatedBy = actor;
    tx.update(ref, patch);
    return { ...view(ref.id, { ...p, ...patch }), unchanged: false };
  });
}

// ---- delete a project: always allowed (made by mistake, a duplicate, a job that was cancelled), with whatever is in it: its checklist, notes, date and render file ----
// The quote and the customer are never touched. The screen asks for a confirmation that says what will be lost. The audit entry holds no personal content.
async function remove({ db, bucket }, actor, data, { nowMs = Date.now() } = {}) {
  onlyKeys(data, ['id']);
  const ref = projectRef(db, data.id);
  const gone = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const p = snap.data();
    tx.delete(ref);
    tx.set(db.collection('auditLog').doc(), { action: 'deleteProject', projectId: ref.id, ticked: STEPS.filter((k) => p.steps && p.steps[k] && p.steps[k].done).length, hadRender: !!p.render, by: actor.id, at: at(nowMs) });
    return { phone: p.phone };
  });
  if (!gone) return { id: ref.id, removed: false };
  // Every file of THIS project (the current render and any it replaced), nothing of the customer's other projects. A private file left behind by a failure here is erased with the customer.
  if (bucket) await bucket.deleteFiles({ prefix: `projects/${gone.phone}/${ref.id}/`, force: true }).catch(() => {});
  return { id: ref.id, removed: true };
}

// ---- the approved 3D render: the browser drops the file in its own uploads/ folder, this validates it and files it with the project ----
function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}
async function attachRender({ db, bucket }, actor, data, { nowMs = Date.now(), uid } = {}) {
  onlyKeys(data, ['id', 'uploadPath', 'filename']);
  const ref = projectRef(db, data.id);
  const uploadPath = typeof data.uploadPath === 'string' ? data.uploadPath : '';
  if (!uid || !uploadPath.startsWith(`uploads/${uid}/`) || uploadPath.includes('..')) throw new HttpsError('permission-denied', 'Bad upload path.');
  const file = bucket.file(uploadPath), cleanup = () => file.delete({ ignoreNotFound: true }).catch(() => {});
  const first = await ref.get();
  if (!first.exists) { await cleanup(); throw notFound('Project not found.'); }
  if (first.data().status === 'completed') { await cleanup(); throw refused('This project is completed. Reopen it to change it.'); }
  let meta, buf;
  try { [meta] = await file.getMetadata(); } catch (e) { throw notFound('The uploaded file was not found. Please try again.'); }
  const size = Number(meta.size), declared = mediaLib.baseMime(meta.contentType);
  if (!(size > 0)) { await cleanup(); throw bad('The file is empty.'); }
  if (size > RENDER_MAX) { await cleanup(); throw bad('The file is too big (max 25 MB).'); }
  try { [buf] = await file.download(); } catch (e) { await cleanup(); throw notFound('The uploaded file could not be read. Please try again.'); }
  const real = sniff(buf);
  if (!real) { await cleanup(); throw bad('Attach the render as a JPG, PNG or WebP picture, or a PDF.'); }
  if (declared !== real) { await cleanup(); throw bad('The file is not what its type says. Attach the render as a JPG, PNG or WebP picture, or a PDF.'); }
  const filename = mediaLib.safeName(data.filename || uploadPath.split('/').pop(), real, 'render');
  const finalPath = `projects/${first.data().phone}/${ref.id}/render-${nowMs}-${filename}`;
  try { await file.move(finalPath); } catch (e) { await cleanup(); throw new HttpsError('unavailable', 'The render could not be stored. Please try again.'); }
  let old = null;
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound('Project not found.');
      const p = snap.data();
      if (p.status === 'completed') throw refused('This project is completed. Reopen it to change it.');
      old = p.render && p.render.path;
      const now = at(nowMs);
      tx.update(ref, { render: { path: finalPath, filename: mediaLib.displayName(data.filename) || filename, mime: real, size: buf.length,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'), at: now, by: actor.id },
      history: capped(p.history, { action: old ? 'render replaced' : 'render attached', at: now, by: actor.id }), updatedAt: now, updatedBy: actor });
    });
  } catch (e) { await bucket.file(finalPath).delete({ ignoreNotFound: true }).catch(() => {}); throw e; }
  if (old && old !== finalPath) await bucket.file(old).delete({ ignoreNotFound: true }).catch(() => {});           // the picture it replaced
  return { id: ref.id, render: { filename: mediaLib.displayName(data.filename) || filename, mime: real, size: buf.length } };
}

// A 10-minute link to the stored render. The bucket itself is closed to browsers.
async function renderLink({ db, bucket }, actor, data, { signedUrl }) {
  onlyKeys(data, ['id', 'download']);
  const ref = projectRef(db, data.id);
  if (data.download != null && typeof data.download !== 'boolean') throw bad('Download must be yes or no.');
  const snap = await ref.get();
  if (!snap.exists) throw notFound('Project not found.');
  const p = snap.data(), r = p.render;
  if (!r || !r.path) throw notFound('This project has no render yet.');
  if (!r.path.startsWith(`projects/${p.phone}/${ref.id}/`)) throw new HttpsError('permission-denied', 'Bad file path.');       // defence in depth
  let meta;
  try { [meta] = await bucket.file(r.path).getMetadata(); } catch (e) { throw notFound('The stored render is missing.'); }
  if (r.size != null && Number(meta.size) !== r.size) throw refused('The stored render does not match its record, so it is not offered. Please tell support.');
  const url = await signedUrl(bucket, r.path, { filename: r.filename, mime: r.mime, download: data.download === true });
  return { url, filename: r.filename, mime: r.mime, size: r.size };
}

module.exports = { STEPS, HISTORY_MAX, NOTES_MAX, RENDER_MAX, idForQuote, idForManual, refForQuote, planAccept, planReopen, create, save, setStep, complete, remove, attachRender, renderLink, sniff };
