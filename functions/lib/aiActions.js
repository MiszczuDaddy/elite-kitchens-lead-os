// Phase 9.2a: AI actions with approval (docs/AI.md). The assistant can PREPARE a change; only a person can APPLY it.
//   propose_*   (called by the model, inside a chat question)   checks the request with the same rules as the screens, builds the exact before/after preview BY CODE, and stores
//               one record in aiProposals. It changes nothing else.
//   decide      (called by the person, from the Approve / Reject buttons)   re-checks that nothing changed since the proposal, then applies it through the existing Elite OS
//               functions (projects.js), or one small transaction for notes, as the person who approved. Applied once at most; every step is audited.
// Rules this file keeps: a proposal expires after 30 minutes; only the person who asked can decide it; if the record changed since the proposal it is refused ("stale"), never overwritten;
// nothing is applied while the AI is switched off, customer data is off, AI actions are off, or that kind of action is off; nothing is ever deleted. TWO kinds send: "followUpEmails" (3 Nov 2026, owner's
// decision), the follow-up email to leads who never replied, and "quoteFollowUps" (14 Nov 2026), one friendly follow-up about each quote nobody answered for two weeks (lib/quoteFollowUp.js); the first is (lib/followUp.js): the model supplies NO words (the email is fixed, lib/followUpText.js), the preview lists every recipient and the exact text, and
// nothing goes until the person presses Approve; the send then applies the same rules again lead by lead.
// The model supplies only ids and the wording the person asked for. It never supplies numbers, previews, or the final text: those are built here.
const crypto = require('crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const { Timestamp, FieldValue } = require('firebase-admin/firestore');
const { normalizePhone } = require('./whatsapp');
const T = require('./aiTools');
const S = require('./aiSummary');
const PR = require('./projects');
const FU = require('./followUp');
const FT = require('./followUpText');
const QF = require('./quoteFollowUp');
const Gmail = require('./gmail');

const KINDS = { customerNote: 'Customer notes', projectUpdate: 'Project updates', followUpEmails: 'Follow-up emails to leads who never replied', quoteFollowUps: 'Follow-up emails about quotes nobody answered' };
const EXPIRY_MS = 30 * 60 * 1000, MAX_PENDING = 5, NOTE_MAX = 1000, CONTACT_NOTES_MAX = 5000;
const MAX_FOLLOWUPS = 30;                                                                // leads in one proposal (ask again for the rest)
const PROPOSAL_ID = /^ap_[0-9a-f]{24}$/, PROJECT_ID = /^[pm]_[0-9a-f]{24}$/, DATE = /^\d{4}-\d{2}-\d{2}$/;
const STEP_LABEL = { designApproved: 'Final 3D design approved', carcassesOrdered: 'Carcasses ordered', doorsOrdered: 'Doors ordered', readyForInstall: 'Ready for installation', installed: 'Installation completed' };

class StaleError extends Error { constructor(message) { super(message); this.name = 'StaleError'; } }
const bad = (m) => new HttpsError('invalid-argument', m);
const refused = (m) => new HttpsError('failed-precondition', m);
const hash = (s) => crypto.createHash('sha256').update(String(s == null ? '' : s)).digest('hex').slice(0, 16);
const tail = (s, n) => { const t = String(s || ''); return t.length > n ? '…' + t.slice(-n) : t; };
const clean = (v) => String(v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();   // keeps new lines and tabs, drops other control characters
const dateLabel = (ymd) => (ymd ? S.dayLabel(ymd) : 'not set');
const realDate = (s) => DATE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

// ---- which kinds are available right now ----
function available(settings) {
  const on = !!(settings.enabled && settings.customerDataApproved && settings.actionsEnabled);
  return Object.fromEntries(Object.keys(KINDS).map((k) => [k, on && settings.actionKinds && settings.actionKinds[k] === true]));
}

// ---- the tools the model may use (they only PREPARE) ----
const TOOLS = [
  { name: 'propose_customer_note', kind: 'customerNote', description: 'Prepare adding a note to a customer\'s Notes. Use ONLY when the person asked you to add or record a note. Write just what they asked, briefly and neutrally. Nothing is saved until the person approves the preview.',
    input_schema: { type: 'object', properties: { customerId: { type: 'string', description: 'the customer id (the phone number, digits only)' }, text: { type: 'string', description: 'the note to add, at most 1000 characters' } }, required: ['customerId', 'text'], additionalProperties: false } },
  { name: 'propose_project_update', kind: 'projectUpdate', description: 'Prepare changes to a project: tick or clear checklist steps, set or clear the installation date, add to or replace the project notes. Use ONLY when the person asked for it. Nothing is saved until the person approves the preview.',
    input_schema: { type: 'object', properties: {
      projectId: { type: 'string' },
      steps: { type: 'array', maxItems: 5, items: { type: 'object', properties: { step: { type: 'string', enum: PR.STEPS }, done: { type: 'boolean' } }, required: ['step', 'done'], additionalProperties: false } },
      installDate: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null to clear the date' },
      notes: { type: 'object', properties: { mode: { type: 'string', enum: ['append', 'replace'] }, text: { type: 'string' } }, required: ['mode', 'text'], additionalProperties: false } },
    required: ['projectId'], additionalProperties: false } },
  { name: 'propose_followup_emails', kind: 'followUpEmails', description: 'Prepare the follow-up email to ALL leads who never replied (still a New lead, never wrote, have an email address, at least a day old, not emailed in the last 14 days). Use ONLY when the person asked to email or follow up the leads who did not reply. You write no words: Elite OS builds the email and the list of who gets it. Nothing is sent until the person approves the preview.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'propose_quote_followup_emails', kind: 'quoteFollowUps', description: 'Prepare the friendly follow-up email about EVERY quote that was sent at least two weeks ago and has had no reply (still Sent, nobody wrote since, not followed up for this sending, has an email address, not asked to be left alone). Use ONLY when the person asked to follow up or email the quotes nobody answered. You write no words: Elite OS builds the email and the list of who gets it. One follow-up per quote, never more. Nothing is sent until the person approves the preview.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },
];
const offKinds = (settings) => { const a = available(settings); return Object.keys(KINDS).filter((k) => !a[k]).map((k) => KINDS[k]); };       // the kinds that are not switched on, by name
const isProposeTool =(name) => TOOLS.some((t) => t.name === name);
const toolsFor = (settings) => { const a = available(settings); return TOOLS.filter((t) => a[t.kind]).map(({ kind, ...t }) => t); };

function only(input, allowed) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) throw new T.ToolError('Bad input.');
  for (const k of Object.keys(input)) if (!allowed.includes(k)) throw new T.ToolError(`Unknown field: ${k}`);
  return input;
}

// ---- building proposals ----
async function buildNote(db, input, nowMs) {
  const i = only(input, ['customerId', 'text']);
  if (typeof i.customerId !== 'string') throw new T.ToolError('customerId is needed.');
  const phone = normalizePhone(i.customerId);
  if (!/^\d{9,15}$/.test(phone)) throw new T.ToolError('That is not a valid customer id.');
  if (typeof i.text !== 'string' || !clean(i.text)) throw new T.ToolError('The note is empty.');
  const text = clean(i.text);
  if (text.length > NOTE_MAX) throw new T.ToolError(`The note is too long (max ${NOTE_MAX} characters).`);
  const [conv, contact] = await Promise.all([db.doc('conversations/' + phone).get(), db.doc('contacts/' + phone).get()]);
  if (!conv.exists && !contact.exists) throw new T.ToolError('No customer with that id.');
  const current = (contact.exists && contact.data().notes) || '', name = (contact.exists && contact.data().name) || (conv.exists && conv.data().name) || 'this customer';
  const line = `${dateLabel(S.dayOf(nowMs))}: ${text}`, after = (current ? current + '\n' : '') + line;
  if (after.length > CONTACT_NOTES_MAX) throw new T.ToolError(`The customer's notes would be longer than ${CONTACT_NOTES_MAX} characters. Ask the person to tidy the notes first.`);
  return { kind: 'customerNote', phone, targetId: phone, title: `Add a note to ${S.one(name, 60)}`,
    preview: { rows: [{ label: 'Notes', type: 'append', existing: tail(current, 240), added: line }], footer: 'Saved to this customer\'s Notes. Nothing else changes.' },
    payload: { phone, newNotes: after }, baseline: { notesHash: hash(current) } };
}

async function buildProject(db, input, nowMs) {
  const i = only(input, ['projectId', 'steps', 'installDate', 'notes']);
  if (typeof i.projectId !== 'string' || !PROJECT_ID.test(i.projectId)) throw new T.ToolError('That is not a valid project id.');
  if (!('steps' in i) && !('installDate' in i) && !('notes' in i)) throw new T.ToolError('Say what to change: steps, the installation date or the notes.');
  const snap = await db.doc('projects/' + i.projectId).get();
  if (!snap.exists) throw new T.ToolError('No such project.');
  const p = snap.data();
  if (p.status === 'completed') throw new T.ToolError('This project is completed. It has to be reopened in Elite OS before it can be changed.');
  const rows = [], payload = { id: i.projectId }, baseline = { rev: p.rev, steps: {} };
  if ('steps' in i) {
    if (!Array.isArray(i.steps) || !i.steps.length || i.steps.length > PR.STEPS.length) throw new T.ToolError('steps must be a short list.');
    const seen = new Set(); payload.steps = [];
    for (const s of i.steps) {
      const st = only(s, ['step', 'done']);
      if (!PR.STEPS.includes(st.step)) throw new T.ToolError('Unknown step.');
      if (typeof st.done !== 'boolean') throw new T.ToolError('Each step must be ticked or cleared.');
      if (seen.has(st.step)) throw new T.ToolError('A step is listed twice.'); seen.add(st.step);
      const now = !!(p.steps && p.steps[st.step] && p.steps[st.step].done);
      if (now === st.done) continue;                                                       // already so: not part of the change
      baseline.steps[st.step] = now; payload.steps.push({ step: st.step, done: st.done });
      rows.push({ label: STEP_LABEL[st.step], type: 'change', before: now ? 'Done' : 'Not done', after: st.done ? 'Done' : 'Not done' });
    }
    if (!payload.steps.length) delete payload.steps;
  }
  if ('installDate' in i) {
    if (i.installDate !== null && (typeof i.installDate !== 'string' || !realDate(i.installDate))) throw new T.ToolError('The installation date must be a real date like 2026-11-20, or null.');
    if ((i.installDate || null) !== (p.installDate || null)) { payload.installDate = i.installDate || null; rows.push({ label: 'Installation date', type: 'change', before: dateLabel(p.installDate), after: i.installDate ? dateLabel(i.installDate) : 'cleared' }); }
  }
  if ('notes' in i) {
    const n = only(i.notes, ['mode', 'text']);
    if (!['append', 'replace'].includes(n.mode)) throw new T.ToolError('Notes mode must be append or replace.');
    if (typeof n.text !== 'string' || !clean(n.text)) throw new T.ToolError('The note is empty.');
    const text = clean(n.text), current = p.notes || '', line = n.mode === 'append' ? `${dateLabel(S.dayOf(nowMs))}: ${text}` : text;
    const after = n.mode === 'append' ? (current ? current + '\n' : '') + line : line;
    if (after.length > PR.NOTES_MAX) throw new T.ToolError(`The project notes would be longer than ${PR.NOTES_MAX} characters.`);
    payload.notes = after; baseline.notesHash = hash(current);
    rows.push(n.mode === 'append' ? { label: 'Project notes', type: 'append', existing: tail(current, 240), added: line } : { label: 'Project notes', type: 'change', before: current ? tail(current, 300) : '(empty)', after: tail(after, 300) });
  }
  if (!rows.length) throw new T.ToolError('Nothing would change: the project already looks like that.');
  baseline.installDate = p.installDate || null;
  return { kind: 'projectUpdate', phone: p.phone, targetId: i.projectId, title: `Update the project of ${S.one(p.customerName || 'a customer', 60)}`,
    preview: { rows, footer: 'Each change is saved on the project with your name in its history.' }, payload, baseline };
}

// Every lead who may be emailed right now, worked out from the database by the same rules the Email button and the server use (lib/followUp.js).
async function buildFollowUps(db, input, nowMs) {
  only(input, []);
  const snap = await db.collection('conversations').where('lastMessageDirection', '==', 'out').limit(1000).get();
  const cands = snap.docs.filter((d) => !FU.refusal(d.data(), nowMs)), rows = [];
  for (let i = 0; i < cands.length; i += 20) {
    await Promise.all(cands.slice(i, i + 20).map(async (d) => {
      const k = await db.doc('contacts/' + d.id).get(), email = String((k.exists && k.data().email) || '').trim();
      if (!email || !Gmail.EMAIL_RE.test(email)) return;
      if (!(await d.ref.collection('messages').where('direction', '==', 'in').limit(1).get()).empty) return;          // an older record may not say they wrote: the chat itself is the proof (the send checks this too)
      rows.push({ phone: d.id, name: String(k.data().name || d.data().name || '').trim(), email, born: (d.data().createdAt && d.data().createdAt.toMillis && d.data().createdAt.toMillis()) || 0 });
    }));
  }
  rows.sort((a, b) => (a.born || Infinity) - (b.born || Infinity) || a.phone.localeCompare(b.phone));
  if (!rows.length) throw new T.ToolError('There is nobody to email right now: every lead who never replied has been emailed lately, has no email address, arrived less than a day ago, or has written to you.');
  const more = Math.max(0, rows.length - MAX_FOLLOWUPS), chosen = rows.slice(0, MAX_FOLLOWUPS), n = chosen.length;
  return { kind: 'followUpEmails', phone: null, targetId: 'followUpEmails', title: `Email ${n} lead${n === 1 ? '' : 's'} who never replied`,
    preview: { rows: [
      { label: n === 1 ? 'Who gets it' : `Who gets it (${n})`, type: 'list', items: chosen.map((r) => `${S.one(r.name || 'A lead', 60)} · ${r.email}`) },
      { label: 'The email (subject: ' + FT.SUBJECT + ')', type: 'text', text: FT.bodyFor({ first: '{first name}' }) },
    ], footer: `Press Approve to send ${n === 1 ? 'this email' : `these ${n} emails`}, each starting with the lead's own first name. They go out as Elite Kitchens and replies come to your inbox. Nothing is sent before you press Approve.${more ? ` ${more} more could be emailed afterwards: ask again.` : ''}` },
    payload: { phones: chosen.map((r) => r.phone) }, baseline: { count: n } };
}

// Every sent quote that may be followed up by email right now, by the same rules the Email button and the server use (lib/quoteFollowUp.js: two weeks old, still Sent, no reply since, one per sending).
async function buildQuoteFollowUps(db, input, nowMs) {
  only(input, []);
  const snap = await db.collection('quotes').where('status', '==', 'sent').limit(1000).get();
  const old = snap.docs.filter((d) => { const t = d.data().sentAt; return t && typeof t.toMillis === 'function' && nowMs - t.toMillis() >= QF.MIN_AGE_MS; }), rows = [];
  for (let i = 0; i < old.length; i += 20) {
    await Promise.all(old.slice(i, i + 20).map(async (d) => {
      const q = d.data(), phone = String(q.phone || '');
      if (!/^\d{9,15}$/.test(phone) || typeof q.ref !== 'string') return;
      const [conv, contact] = await Promise.all([db.doc('conversations/' + phone).get(), db.doc('contacts/' + phone).get()]);
      if (!conv.exists || QF.refusal(conv.data(), d.id, q.sentAt.toMillis(), nowMs)) return;
      const email = String((contact.exists && contact.data().email) || '').trim();
      if (!email || !Gmail.EMAIL_RE.test(email)) return;
      rows.push({ id: d.id, ref: q.ref, name: String((contact.exists && contact.data().name) || q.customerName || conv.data().name || '').trim(), email, sent: q.sentAt.toMillis() });
    }));
  }
  rows.sort((a, b) => a.sent - b.sent || a.id.localeCompare(b.id));
  if (!rows.length) throw new T.ToolError('There are no quotes to follow up right now: every quote that was sent more than two weeks ago has been answered, has been followed up, has no email address, or belongs to someone who asked not to be contacted.');
  const more = Math.max(0, rows.length - MAX_FOLLOWUPS), chosen = rows.slice(0, MAX_FOLLOWUPS), n = chosen.length;
  return { kind: 'quoteFollowUps', phone: null, targetId: 'quoteFollowUps', title: `Follow up ${n} quote${n === 1 ? '' : 's'} by email`,
    preview: { rows: [
      { label: n === 1 ? 'Who gets it' : `Who gets it (${n})`, type: 'list', items: chosen.map((r) => `${S.one(r.name || 'A customer', 60)} · ${r.ref} · sent ${S.dayLabel(S.dayOf(r.sent))} · ${r.email}`) },
      { label: 'The email (subject: ' + FT.quoteSubject('{quote number}') + ')', type: 'text', text: FT.quoteBodyFor({ first: '{first name}', ref: '{quote number}' }) },
    ], footer: `Press Approve to send ${n === 1 ? 'this email' : `these ${n} emails`}, each starting with the customer's own first name and naming their quote. Each quote is followed up once only. They go out as Elite Kitchens and replies come to your inbox. Nothing is sent before you press Approve.${more ? ` ${more} more could be emailed afterwards: ask again.` : ''}` },
    payload: { quoteIds: chosen.map((r) => r.id) }, baseline: { count: n } };
}

const audit = (db, { nowMs, ...e }) => db.collection('auditLog').add({ action: 'aiProposal', ...e, at: Timestamp.fromMillis(nowMs) }).catch(() => {});          // never holds the text of a note
async function propose({ db, actor, uid, model, nowMs = Date.now() }, name, input, settings) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new T.ToolError('Unknown tool.');
  if (!available(settings)[tool.kind]) throw new T.ToolError('This kind of change is not switched on.');
  const mine = await db.collection('aiProposals').where('createdByUid', '==', uid).get();
  const pending = mine.docs.map((d) => d.data()).filter((p) => p.status === 'pending' && p.expiresAt.toMillis() > nowMs);
  const built = name === 'propose_customer_note' ? await buildNote(db, input, nowMs) : name === 'propose_followup_emails' ? await buildFollowUps(db, input, nowMs) : name === 'propose_quote_followup_emails' ? await buildQuoteFollowUps(db, input, nowMs) : await buildProject(db, input, nowMs);
  const same = pending.find((p) => p.kind === built.kind && p.targetId === built.targetId && JSON.stringify(p.payload) === JSON.stringify(built.payload));
  if (same) return { proposalId: same.id, title: same.title, reused: true };                       // the same change is already waiting: show that one, do not make a second
  if (pending.length >= MAX_PENDING) throw new T.ToolError('There are already several proposals waiting for a decision. Approve or reject them first.');
  const id = 'ap_' + crypto.randomBytes(12).toString('hex');
  await db.doc('aiProposals/' + id).set({ id, kind: built.kind, status: 'pending', phone: built.phone, targetId: built.targetId, title: built.title, preview: built.preview, payload: built.payload, baseline: built.baseline,
    createdBy: actor.id, createdByUid: uid, model: model || null, createdAt: Timestamp.fromMillis(nowMs), expiresAt: Timestamp.fromMillis(nowMs + EXPIRY_MS) });
  await audit(db, { event: 'created', proposalId: id, kind: built.kind, targetId: built.targetId, by: actor.id, model: model || null, nowMs });
  return { proposalId: id, title: built.title };
}

// What is really waiting for this person right now (the truth, from the database; the model is told this each turn instead of trusting what it said earlier).
async function waiting(db, uid, nowMs = Date.now()) {
  const snap = await db.collection('aiProposals').where('createdByUid', '==', uid).get();
  for (const d of snap.docs) if (d.data().status === 'pending' && d.data().expiresAt.toMillis() <= nowMs) await d.ref.update({ status: 'expired' });          // tidy: an unanswered proposal past its time is closed, so it never lingers as "waiting"
  return snap.docs.map((d) => d.data()).filter((p) => p.status === 'pending' && p.expiresAt.toMillis() > nowMs).sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis()).map((p) => ({ id: p.id, title: p.title, kind: p.kind }));
}

// ---- deciding ----
const messageOf = (e) => (e instanceof HttpsError || e instanceof StaleError ? e.message : 'It could not be saved.');
async function applyNote(db, p, nowMs) {
  await db.runTransaction(async (tx) => {
    const cRef = db.doc('contacts/' + p.payload.phone), [conv, contact] = await Promise.all([tx.get(db.doc('conversations/' + p.payload.phone)), tx.get(cRef)]);
    if (!conv.exists) throw new StaleError('This customer no longer exists.');
    if (hash((contact.exists && contact.data().notes) || '') !== p.baseline.notesHash) throw new StaleError('The customer\'s notes changed after this was prepared. Ask again.');
    tx.set(cRef, { phone: p.payload.phone, notes: p.payload.newNotes, updatedAt: FieldValue.serverTimestamp() }, { merge: true });          // the same write the Contact panel makes
  });
  return { status: 'applied', message: 'The note was added.', results: [{ label: 'Notes', ok: true }] };
}
async function applyProject(db, actor, p, nowMs) {
  const snap = await db.doc('projects/' + p.payload.id).get();
  if (!snap.exists) throw new StaleError('This project no longer exists.');
  const cur = snap.data();
  if (cur.status === 'completed') throw new StaleError('This project was completed after this was prepared.');
  if (cur.rev !== p.baseline.rev) throw new StaleError('The project changed after this was prepared. Ask again.');
  for (const [k, was] of Object.entries(p.baseline.steps || {})) if (!!(cur.steps && cur.steps[k] && cur.steps[k].done) !== was) throw new StaleError('The checklist changed after this was prepared. Ask again.');
  const results = [];
  if ('installDate' in p.payload || 'notes' in p.payload) {
    try {
      await PR.save({ db }, actor, { id: p.payload.id, expectedRev: p.baseline.rev, ...('installDate' in p.payload ? { installDate: p.payload.installDate } : {}), ...('notes' in p.payload ? { notes: p.payload.notes } : {}) }, { nowMs });
      if ('installDate' in p.payload) results.push({ label: 'Installation date', ok: true });
      if ('notes' in p.payload) results.push({ label: 'Project notes', ok: true });
    } catch (e) { if (e instanceof HttpsError && e.code === 'failed-precondition') throw new StaleError('The project changed after this was prepared. Ask again.'); throw e; }
  }
  for (const s of p.payload.steps || []) {
    try { await PR.setStep({ db }, actor, { id: p.payload.id, step: s.step, done: s.done }, { nowMs }); results.push({ label: STEP_LABEL[s.step], ok: true }); }
    catch (e) { results.push({ label: STEP_LABEL[s.step], ok: false, message: messageOf(e) }); }
  }
  const okCount = results.filter((r) => r.ok).length;
  return { status: okCount === results.length ? 'applied' : okCount ? 'partial' : 'failed', message: okCount === results.length ? 'The changes were saved.' : 'Some changes could not be saved.', results };
}

// The approved emails, one lead at a time through the same server rules as the Email button (who may be emailed is decided again for each one: a lead who wrote in the meantime is skipped, and a second
// approval can never email anyone twice, because each send is recorded on the conversation).
async function applyFollowUps(db, mailer, actor, p, nowMs) {
  if (!mailer || !mailer.enabled || !mailer.sender) throw refused('Email sending is not switched on yet, so nothing was sent.');
  const results = [];
  for (const phone of p.payload.phones) {
    const conv = await db.doc('conversations/' + phone).get(), name = S.one(((conv.exists && conv.data().name) || 'A lead'), 60);
    try {
      await FU.send({ db, mailer }, actor, { phone }, { nowMs });                                      // no words passed in: the send builds the same fixed email the preview showed
      results.push({ label: name, ok: true });
    } catch (e) { results.push({ label: name, ok: false, message: e instanceof HttpsError ? e.message : 'It could not be sent.' }); }
  }
  const ok = results.filter((r) => r.ok).length, total = results.length;
  return { status: ok === total ? 'applied' : ok ? 'partial' : 'failed', message: ok === total ? `${ok} email${ok === 1 ? ' was' : 's were'} sent.` : ok ? `${ok} of ${total} emails were sent. The others were skipped (see the list).` : 'No email was sent.', results };
}

// The approved quote follow-ups, one quote at a time through the same server rules as the Email button on Today (a customer who wrote in the meantime is skipped; each send is recorded on the conversation, so a second
// approval can never email anyone twice about the same sending of a quote).
async function applyQuoteFollowUps(db, mailer, actor, p, nowMs) {
  if (!mailer || !mailer.enabled || !mailer.sender) throw refused('Email sending is not switched on yet, so nothing was sent.');
  const results = [];
  for (const quoteId of p.payload.quoteIds) {
    const q = await db.doc('quotes/' + quoteId).get(), label = q.exists ? `${S.one(q.data().customerName || 'A customer', 60)} (${q.data().ref || 'quote'})` : 'A quote';
    try {
      await QF.send({ db, mailer }, actor, { quoteId }, { nowMs });                                  // no words passed in: the send builds the same fixed email the preview showed
      results.push({ label, ok: true });
    } catch (e) { results.push({ label, ok: false, message: e instanceof HttpsError ? e.message : 'It could not be sent.' }); }
  }
  const ok = results.filter((r) => r.ok).length, total = results.length;
  return { status: ok === total ? 'applied' : ok ? 'partial' : 'failed', message: ok === total ? `${ok} email${ok === 1 ? ' was' : 's were'} sent.` : ok ? `${ok} of ${total} emails were sent. The others were skipped (see the list).` : 'No email was sent.', results };
}

async function decide({ db, mailer }, actor, uid, data, { nowMs = Date.now() } = {}, settings) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('Missing details.');
  for (const k of Object.keys(data)) if (!['proposalId', 'decision'].includes(k)) throw bad(`Unknown field: ${k}`);
  if (typeof data.proposalId !== 'string' || !PROPOSAL_ID.test(data.proposalId)) throw bad('Missing proposal.');
  if (!['approve', 'reject'].includes(data.decision)) throw bad('Approve or reject.');
  const ref = db.doc('aiProposals/' + data.proposalId);
  const pre = await ref.get();
  if (!pre.exists) throw new HttpsError('not-found', 'This proposal no longer exists.');
  if (data.decision === 'approve' && pre.data().status === 'pending' && !available(settings)[pre.data().kind]) throw refused('AI actions are switched off, so nothing can be applied.');
  if (data.decision === 'approve' && pre.data().status === 'pending' && ['followUpEmails', 'quoteFollowUps'].includes(pre.data().kind) && (!mailer || !mailer.enabled || !mailer.sender)) throw refused('Email sending is not switched on yet, so nothing was sent. The proposal is still waiting.');
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'This proposal no longer exists.');
    const p = snap.data();
    if (p.createdByUid !== uid) throw new HttpsError('permission-denied', 'Only the person who asked can decide this.');
    if (p.status !== 'pending') return { done: true, p };                                       // already decided: the same answer again, nothing repeated
    if (nowMs > p.expiresAt.toMillis()) { tx.update(ref, { status: 'expired', decidedAt: Timestamp.fromMillis(nowMs) }); return { done: true, p: { ...p, status: 'expired' }, event: 'expired' }; }
    if (data.decision === 'reject') { tx.update(ref, { status: 'rejected', decidedAt: Timestamp.fromMillis(nowMs), decidedBy: actor.id }); return { done: true, p: { ...p, status: 'rejected' }, event: 'rejected' }; }
    tx.update(ref, { status: 'applying', decidedAt: Timestamp.fromMillis(nowMs), decidedBy: actor.id });
    return { done: false, p };
  });
  if (claimed.done) {
    if (claimed.event) await audit(db, { event: claimed.event, proposalId: claimed.p.id, kind: claimed.p.kind, targetId: claimed.p.targetId, by: actor.id, nowMs });
    return { status: claimed.p.status, message: { expired: 'This proposal expired. Ask again.', rejected: 'Rejected. Nothing was changed.', applying: 'It is being applied. Check again in a moment.' }[claimed.p.status] || (claimed.p.result && claimed.p.result.message) || '', results: (claimed.p.result && claimed.p.result.results) || [] };
  }
  let result;
  try { result = claimed.p.kind === 'customerNote' ? await applyNote(db, claimed.p, nowMs) : claimed.p.kind === 'followUpEmails' ? await applyFollowUps(db, mailer, actor, claimed.p, nowMs) : claimed.p.kind === 'quoteFollowUps' ? await applyQuoteFollowUps(db, mailer, actor, claimed.p, nowMs) : await applyProject(db, actor, claimed.p, nowMs); }
  catch (e) { result = e instanceof StaleError ? { status: 'stale', message: e.message, results: [] } : { status: 'failed', message: messageOf(e), results: [] }; }
  await ref.update({ status: result.status, result: { message: result.message, results: result.results }, finishedAt: Timestamp.fromMillis(nowMs) });
  await audit(db, { event: result.status, proposalId: claimed.p.id, kind: claimed.p.kind, targetId: claimed.p.targetId, by: actor.id, nowMs });
  return result;
}

module.exports = { waiting, offKinds, KINDS, EXPIRY_MS, MAX_PENDING, NOTE_MAX, TOOLS, available, toolsFor, isProposeTool, propose, decide, STEP_LABEL };
