// Phase 9.2a: AI actions with approval (docs/AI.md). The assistant can PREPARE a change; only a person can APPLY it.
//   propose_*   (called by the model, inside a chat question)   checks the request with the same rules as the screens, builds the exact before/after preview BY CODE, and stores
//               one record in aiProposals. It changes nothing else.
//   decide      (called by the person, from the Approve / Reject buttons)   re-checks that nothing changed since the proposal, then applies it through the existing Elite OS
//               functions (projects.js), or one small transaction for notes, as the person who approved. Applied once at most; every step is audited.
// Rules this file keeps: a proposal expires after 30 minutes; only the person who asked can decide it; if the record changed since the proposal it is refused ("stale"), never overwritten;
// nothing is applied while the AI is switched off, customer data is off, AI actions are off, or that kind of action is off; nothing is ever deleted. THREE kinds send: "customerEmail" (15 Nov 2026: ONE email to ONE customer, written by the Assistant and sent only as the person approved it), "followUpEmails" (3 Nov 2026, owner's
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
const Reply = require('./emailReply');
const QH = require('./quietHours');
const Gmail = require('./gmail');

const KINDS = { customerNote: 'Customer notes', projectUpdate: 'Project updates', followUpEmails: 'Follow-up emails to leads who never replied', quoteFollowUps: 'Follow-up emails about quotes nobody answered', customerEmail: 'An email to one customer, written by the Assistant' };
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
  const out = Object.fromEntries(Object.keys(KINDS).map((k) => [k, on && settings.actionKinds && settings.actionKinds[k] === true]));
  out.followUpList = !!(out.followUpEmails || out.quoteFollowUps);                              // the combined follow-up list (tick boxes) is offered when either follow-up kind is on; it only ever includes the kinds that are on
  return out;
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
  { name: 'propose_follow_ups', kind: 'followUpList', description: 'Prepare ONE follow-up list for the person to tick: customers who got a quote and never answered, and leads who never replied, each with how many days it has been. Use this whenever the person asks to follow up customers or leads, for quotes, for leads, or for both ("send follow up emails to everyone who did not respond"). You write no words: Elite OS builds the list and the emails. People who meet the rules start ticked; quotes under two weeks old are listed unticked and the person may tick them. Nothing is sent until the person ticks who they want and approves.',
    input_schema: { type: 'object', properties: { include: { type: 'string', enum: ['both', 'quotes', 'leads'], description: 'both (default), only quotes, or only leads' } }, additionalProperties: false } },
  { name: 'propose_customer_email', kind: 'customerEmail', description: 'Prepare ONE email to ONE customer, written by you, when the person asks you to write or send an email to a customer ("write a follow up email to Ray Ryan", "email Aoife about the delivery"). First find the customer (search_customers) and read their record, quotes and recent messages so what you write is accurate. Write a short, warm, plain email in the first person plural ("we"). Start with a greeting by first name; do NOT add a sign-off, the signature is added for you. Say only what the record supports: never invent prices, dates or promises, and never mention warranties or guarantees. For several customers at once use the follow-up tools instead. The person reads the exact text and presses Approve; nothing is sent before that.',
    input_schema: { type: 'object', properties: { customerId: { type: 'string', description: 'the customer id (the phone number, digits only)' }, subject: { type: 'string', description: 'one line, at most 120 characters' }, body: { type: 'string', description: 'the email, 20 to 1800 characters, plain text, no sign-off' } }, required: ['customerId', 'subject', 'body'], additionalProperties: false } },
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

// The follow-up LIST (21 Nov 2026): leads who never replied and customers who got a quote and never answered, in one card, each with how many days it has been and a tick box. Whoever meets the rules starts ticked
// (a lead: the lead rules; a quote: two weeks old); a quote under two weeks old (down to one day) is listed UNTICKED and may be ticked by the person. Only the people ticked when Approve is pressed are emailed, and each one is
// checked again at that moment by the same server rules. The model supplies no words and no list.
const DAYMS = 24 * 3600e3, LIST_MAX = 40;
const agoText = (ms0_, nowMs) => { const d = Math.floor((nowMs - ms0_) / DAYMS); return d <= 0 ? 'today' : d === 1 ? '1 day ago' : d + ' days ago'; };
async function buildFollowUpList(db, input, nowMs, settings) {
  const i = only(input, ['include']), want = i.include == null ? 'both' : i.include;
  if (!['both', 'quotes', 'leads'].includes(want)) throw new T.ToolError('include must be both, quotes or leads.');
  const on = available(settings), doLeads = want !== 'quotes' && on.followUpEmails, doQuotes = want !== 'leads' && on.quoteFollowUps;
  if (!doLeads && !doQuotes) throw new T.ToolError('That kind of follow-up is not switched on in Assistant > Settings.');
  const items = [], leadRows = [], quoteRows = [];
  if (doLeads) {
    const snap = await db.collection('conversations').where('lastMessageDirection', '==', 'out').limit(1000).get(), cands = snap.docs.filter((d) => !FU.refusal(d.data(), nowMs));
    for (let n = 0; n < cands.length; n += 20) await Promise.all(cands.slice(n, n + 20).map(async (d) => {
      const k = await db.doc('contacts/' + d.id).get(), email = String((k.exists && k.data().email) || '').trim();
      if (!email || !Gmail.EMAIL_RE.test(email)) return;
      if (!(await d.ref.collection('messages').where('direction', '==', 'in').limit(1).get()).empty) return;
      const born = ms0(d.data().createdAt) || ms0(d.data().updatedAt) || nowMs;
      leadRows.push({ phone: d.id, name: String(k.data().name || d.data().name || '').trim(), email, born });
    }));
  }
  if (doQuotes) {
    const snap = await db.collection('quotes').where('status', '==', 'sent').limit(1000).get();
    const old = snap.docs.filter((d) => { const t = d.data().sentAt; return t && typeof t.toMillis === 'function' && nowMs - t.toMillis() >= DAYMS; });
    for (let n = 0; n < old.length; n += 20) await Promise.all(old.slice(n, n + 20).map(async (d) => {
      const q = d.data(), phone = String(q.phone || '');
      if (!/^\d{9,15}$/.test(phone) || typeof q.ref !== 'string') return;
      const [conv, contact] = await Promise.all([db.doc('conversations/' + phone).get(), db.doc('contacts/' + phone).get()]);
      if (!conv.exists || QF.refusal(conv.data(), d.id, q.sentAt.toMillis(), nowMs, { allowEarly: true })) return;
      const email = String((contact.exists && contact.data().email) || '').trim();
      if (!email || !Gmail.EMAIL_RE.test(email)) return;
      quoteRows.push({ id: d.id, ref: q.ref, name: String((contact.exists && contact.data().name) || q.customerName || conv.data().name || '').trim(), email, sent: q.sentAt.toMillis() });
    }));
  }
  leadRows.sort((a, b) => a.born - b.born || a.phone.localeCompare(b.phone)); quoteRows.sort((a, b) => a.sent - b.sent || a.id.localeCompare(b.id));
  if (!leadRows.length && !quoteRows.length) throw new T.ToolError('There is nobody to follow up right now: everyone has been followed up lately, has answered, has no email address, or asked not to be contacted' + (doQuotes ? ' (a quote must be at least a day old)' : '') + '.');
  const rows = [], leads = leadRows.slice(0, LIST_MAX), quotes = quoteRows.slice(0, LIST_MAX), more = Math.max(0, leadRows.length - LIST_MAX) + Math.max(0, quoteRows.length - LIST_MAX);
  if (quotes.length) {
    const its = quotes.map((r) => { const ready = nowMs - r.sent >= QF.MIN_AGE_MS, id = 'q:' + r.id; items.push({ id, type: 'quote', quoteId: r.id });
      return { id, text: `${S.one(r.name || 'A customer', 60)} · ${r.ref} · sent ${agoText(r.sent, nowMs)} · ${r.email}`, checked: ready, ...(ready ? {} : { note: 'under 2 weeks' }) }; });
    rows.push({ label: `Quotes nobody answered (${quotes.length})`, type: 'pick', items: its });
  }
  if (leads.length) {
    const its = leads.map((r) => { const id = 'l:' + r.phone; items.push({ id, type: 'lead', phone: r.phone }); return { id, text: `${S.one(r.name || 'A lead', 60)} · arrived ${agoText(r.born, nowMs)} · ${r.email}`, checked: true }; });
    rows.push({ label: `Leads who never replied (${leads.length})`, type: 'pick', items: its });
  }
  if (quotes.length) rows.push({ label: 'The quote email (subject: ' + FT.quoteSubject('{quote number}') + ')', type: 'text', text: FT.quoteBodyFor({ first: '{first name}', ref: '{quote number}' }) });
  if (leads.length) rows.push({ label: 'The lead email (subject: ' + FT.SUBJECT + ')', type: 'text', text: FT.bodyFor({ first: '{first name}' }) });
  const total = quotes.length + leads.length;
  return { kind: 'followUpList', phone: null, targetId: 'followUpList', title: `Follow up ${total} customer${total === 1 ? '' : 's'}`,
    preview: { rows, footer: `Tick the people you want to email, then press Approve. Everyone who meets the rules starts ticked; a quote under two weeks old starts unticked, tick it if you want to follow up early. Each email starts with the customer's own first name and goes out as Elite Kitchens; replies come to your inbox. One follow-up per quote. Nothing is sent before you press Approve.${more ? ` ${more} more could be listed afterwards: ask again.` : ''}` },
    payload: { items }, baseline: { count: total } };
}

// ONE email to ONE customer, in the Assistant's own words (15 Nov 2026). The model writes the subject and the body; code adds the greeting if it is missing and the signature, refuses a warranty or guarantee promise, shows the
// person the EXACT final text, and sends exactly that text only after Approve. At Approve it is checked again: a customer who wrote since it was prepared, one who asked not to be contacted, or an address that went are refused.
const CE = { subjectMax: FT.LIMIT.subject, bodyMin: 20, bodyMax: 1800, fullMax: 5000 };
const PROMISE = /\b(warrant(?:y|ies|ied)|guarantee[ds]?|guaranteeing)\b/i;                                       // standing rule: never any warranty language
const SIGNED = /(?:\n|^)[ \t]*(?:kind regards|best regards|regards|many thanks|thanks|best wishes|best|sincerely)[,.!]?[ \t]*(?:\n[ \t]*(?:the\s+team\s+at\s+)?elite kitchens)?[ \t]*$/i;          // only a sign-off on a line of its own ("... we will do our best" is left alone)
async function buildCustomerEmail(db, input, nowMs) {
  const i = only(input, ['customerId', 'subject', 'body']);
  if (typeof i.customerId !== 'string') throw new T.ToolError('customerId is needed.');
  const phone = normalizePhone(i.customerId);
  if (!/^\d{9,15}$/.test(phone)) throw new T.ToolError('That is not a valid customer id.');
  if (typeof i.subject !== 'string' || /[\r\n]/.test(i.subject) || !i.subject.trim() || i.subject.trim().length > CE.subjectMax) throw new T.ToolError(`The subject must be one line of up to ${CE.subjectMax} characters.`);
  if (typeof i.body !== 'string' || clean(i.body).length < CE.bodyMin || clean(i.body).length > CE.bodyMax) throw new T.ToolError(`The email must be between ${CE.bodyMin} and ${CE.bodyMax} characters.`);
  if (PROMISE.test(i.subject) || PROMISE.test(i.body)) throw new T.ToolError('Do not mention warranties or guarantees in an email. Write it again without them.');
  const [conv, contact] = await Promise.all([db.doc('conversations/' + phone).get(), db.doc('contacts/' + phone).get()]);
  if (!conv.exists) throw new T.ToolError('No customer with that id.');
  const c = conv.data(), k = contact.exists ? contact.data() : {}, email = String(k.email || '').trim(), name = String(k.name || c.name || '').trim();
  if (c.doNotContact && c.doNotContact.on === true) throw new T.ToolError('They asked not to be contacted, so no email can be prepared.');
  if (!email || !Gmail.EMAIL_RE.test(email)) throw new T.ToolError('This customer has no email address on file. Ask the person to add one in their Details first.');
  let text = clean(i.body).replace(SIGNED, '').trim();                                                          // a sign-off the model added anyway is replaced by the real signature
  if (!/^(hi|hello|dear|good (morning|afternoon|evening))\b/i.test(text)) text = `Hi ${FT.firstNameOf(name)},\n\n` + text;
  const full = [text, '', 'Kind regards,', 'Elite Kitchens', [FT.CONTACT.phone, FT.CONTACT.email, FT.CONTACT.web].filter(Boolean).join(' | ')].join('\n');
  if (full.length > CE.fullMax) throw new T.ToolError('The email is too long.');
  const subject = i.subject.trim();
  return { kind: 'customerEmail', phone, targetId: phone, title: `Email ${S.one(name || 'this customer', 60)}`,
    preview: { rows: [
      { label: 'Who gets it', type: 'list', items: [`${S.one(name || 'A customer', 60)} · ${email}`] },
      { label: 'The email (subject: ' + subject + ')', type: 'text', text: full },
    ], footer: 'Press Approve to send this one email as Elite Kitchens (replies come to your inbox). It is sent exactly as written above. Nothing is sent before you press Approve.' },
    payload: { phone, subject, body: full }, baseline: { lastInboundAt: ms0(c.lastInboundAt), emailInboundAt: ms0(c.emailInboundAt) } };
}
const ms0 = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : 0);

const audit = (db, { nowMs, ...e }) => db.collection('auditLog').add({ action: 'aiProposal', ...e, at: Timestamp.fromMillis(nowMs) }).catch(() => {});          // never holds the text of a note
async function propose({ db, actor, uid, model, nowMs = Date.now() }, name, input, settings) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new T.ToolError('Unknown tool.');
  if (!available(settings)[tool.kind]) throw new T.ToolError('This kind of change is not switched on.');
  const mine = await db.collection('aiProposals').where('createdByUid', '==', uid).get();
  const pending = mine.docs.map((d) => d.data()).filter((p) => p.status === 'pending' && p.expiresAt.toMillis() > nowMs);
  const built = name === 'propose_customer_note' ? await buildNote(db, input, nowMs) : name === 'propose_followup_emails' ? await buildFollowUps(db, input, nowMs) : name === 'propose_quote_followup_emails' ? await buildQuoteFollowUps(db, input, nowMs) : name === 'propose_customer_email' ? await buildCustomerEmail(db, input, nowMs) : name === 'propose_follow_ups' ? await buildFollowUpList(db, input, nowMs, settings) : await buildProject(db, input, nowMs);
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

// The approved email, exactly as the person read it. Sent by the same sender as every other email (one at a time per customer, the same words twice within two minutes refused, an answer we cannot confirm never retried),
// and recorded in the customer's chat and in the Emails list. Refused when the customer wrote to you since it was prepared: the text was written for a situation that has changed.
async function applyCustomerEmail(db, mailer, actor, p, nowMs) {
  if (!mailer || !mailer.enabled || !mailer.sender) throw refused('Email sending is not switched on yet, so nothing was sent.');
  const snap = await db.doc('conversations/' + p.payload.phone).get();
  if (!snap.exists) throw new StaleError('This customer no longer exists.');
  const c = snap.data(), name = S.one(c.name || 'the customer', 60);
  if (ms0(c.lastInboundAt) > p.baseline.lastInboundAt || ms0(c.emailInboundAt) > p.baseline.emailInboundAt) throw new StaleError('They wrote to you after this was prepared, so check the chat first. Ask again if you still want to send it.');
  try {
    await Reply.send({ db, mailer }, actor, { phone: p.payload.phone, subject: p.payload.subject, body: p.payload.body }, { nowMs, thread: false, kind: 'assistant' });
    return { status: 'applied', message: `The email was sent to ${name}.`, results: [{ label: name, ok: true }] };
  } catch (e) { return { status: 'failed', message: e instanceof HttpsError ? e.message : 'It could not be sent.', results: [{ label: name, ok: false, message: e instanceof HttpsError ? e.message : 'It could not be sent.' }] }; }
}

// The ticked people of a follow-up list, one at a time through the same server rules as the Email buttons (a customer who wrote since, who asked not to be contacted, or who was followed up meanwhile is skipped with the reason;
// a quote the person ticked under two weeks old is allowed, never under a day). Used both for "send now" and by the timer for a scheduled send.
async function applyFollowUpList(db, mailer, actor, p, nowMs, selected) {
  if (!mailer || !mailer.enabled || !mailer.sender) throw refused('Email sending is not switched on yet, so nothing was sent.');
  const results = [];
  for (const it of p.payload.items) {
    if (!selected.has(it.id)) continue;
    let label = 'A customer';
    try {
      if (it.type === 'quote') {
        const q = await db.doc('quotes/' + it.quoteId).get(); label = q.exists ? `${S.one(q.data().customerName || 'A customer', 60)} (${q.data().ref || 'quote'})` : 'A quote';
        await QF.send({ db, mailer }, actor, { quoteId: it.quoteId }, { nowMs, allowEarly: true });
      } else {
        const c = await db.doc('conversations/' + it.phone).get(); label = S.one((c.exists && c.data().name) || 'A lead', 60);
        await FU.send({ db, mailer }, actor, { phone: it.phone }, { nowMs });
      }
      results.push({ label, ok: true });
    } catch (e) { results.push({ label, ok: false, message: e instanceof HttpsError ? e.message : 'It could not be sent.' }); }
  }
  const ok = results.filter((r) => r.ok).length, total = results.length;
  return { status: ok === total ? 'applied' : ok ? 'partial' : 'failed', message: ok === total ? `${ok} email${ok === 1 ? ' was' : 's were'} sent.` : ok ? `${ok} of ${total} emails were sent. The others were skipped (see the list).` : 'No email was sent.', results };
}
// A chosen send time: now (nothing, or within a minute), or up to three days ahead. The Irish night (midnight to 07:00) is never used: a time inside it moves to 07:00.
const SCHEDULE_MAX_MS = 3 * DAYMS, SCHEDULE_STALE_MS = 6 * 3600e3;
function sendAtOf(v, nowMs) {
  if (v == null) return null;
  if (!Number.isFinite(v) || !Number.isInteger(v)) throw bad('Choose a time to send.');
  if (v <= nowMs + 60e3) return null;
  if (v > nowMs + SCHEDULE_MAX_MS) throw bad('Choose a time within the next 3 days.');
  return QH.isQuiet(v) ? QH.openAtMs(v) : v;
}
const whenText = (t) => new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
// The timer (every five minutes): sends each follow-up list whose time has come. Never in the Irish night; one that is more than six hours late (the timer was down) is not sent: an old decision is not repeated blindly.
async function sweepScheduled({ db, mailer, nowMs = Date.now() }) {
  const out = { due: 0, sent: 0, expired: 0, quiet: false };
  if (QH.isQuiet(nowMs)) { out.quiet = true; return out; }
  const snap = await db.collection('aiProposals').where('status', '==', 'scheduled').limit(50).get();
  for (const d of snap.docs) {
    const p = d.data(), at = ms0(p.scheduledFor);
    if (at > nowMs) continue;
    const claimed = await db.runTransaction(async (tx) => { const s = await tx.get(d.ref); if (!s.exists || s.data().status !== 'scheduled') return null; tx.update(d.ref, { status: nowMs - at > SCHEDULE_STALE_MS ? 'expired' : 'applying' }); return s.data(); });
    if (!claimed) continue;
    out.due++;
    if (nowMs - at > SCHEDULE_STALE_MS) { out.expired++; await d.ref.update({ result: { message: 'The scheduled time passed more than six hours ago, so nothing was sent. Ask again.', results: [] }, finishedAt: Timestamp.fromMillis(nowMs) }); await audit(db, { event: 'expired', proposalId: p.id, kind: p.kind, targetId: p.targetId, by: p.decidedBy || null, nowMs }); continue; }
    let result;
    try { result = await applyFollowUpList(db, mailer, { kind: 'staff', id: p.decidedBy || 'scheduled' }, p, nowMs, new Set(p.selected || [])); }
    catch (e) { result = { status: 'failed', message: messageOf(e), results: [] }; }
    await d.ref.update({ status: result.status, result: { message: result.message, results: result.results }, finishedAt: Timestamp.fromMillis(nowMs) });
    await audit(db, { event: result.status, proposalId: p.id, kind: p.kind, targetId: p.targetId, by: p.decidedBy || null, nowMs });
    if (result.status === 'applied' || result.status === 'partial') out.sent++;
  }
  return out;
}

async function decide({ db, mailer }, actor, uid, data, { nowMs = Date.now() } = {}, settings) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('Missing details.');
  for (const k of Object.keys(data)) if (!['proposalId', 'decision', 'selected', 'sendAt'].includes(k)) throw bad(`Unknown field: ${k}`);
  if (typeof data.proposalId !== 'string' || !PROPOSAL_ID.test(data.proposalId)) throw bad('Missing proposal.');
  if (!['approve', 'reject'].includes(data.decision)) throw bad('Approve or reject.');
  const ref = db.doc('aiProposals/' + data.proposalId);
  const pre = await ref.get();
  if (!pre.exists) throw new HttpsError('not-found', 'This proposal no longer exists.');
  const listApprove = data.decision === 'approve' && pre.data().kind === 'followUpList' && pre.data().status === 'pending';
  if (('selected' in data || 'sendAt' in data) && !listApprove && pre.data().status === 'pending') throw bad('Unknown field: ' + ('selected' in data ? 'selected' : 'sendAt'));
  let selected = null, sendAt = null;
  if (listApprove) {                                                                          // which people are ticked, and when to send
    const known = new Set((pre.data().payload.items || []).map((x) => x.id));
    if (!Array.isArray(data.selected) || data.selected.length > 200 || data.selected.some((x) => typeof x !== 'string' || !known.has(x))) throw bad('Tick the people to email.');
    selected = [...new Set(data.selected)];
    if (!selected.length) throw bad('Tick at least one person to email.');
    sendAt = sendAtOf(data.sendAt, nowMs);
  }
  if (data.decision === 'approve' && pre.data().status === 'pending' && !available(settings)[pre.data().kind]) throw refused('AI actions are switched off, so nothing can be applied.');
  if (data.decision === 'approve' && pre.data().status === 'pending' && ['followUpEmails', 'quoteFollowUps', 'customerEmail', 'followUpList'].includes(pre.data().kind) && (!mailer || !mailer.enabled || !mailer.sender)) throw refused('Email sending is not switched on yet, so nothing was sent. The proposal is still waiting.');
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'This proposal no longer exists.');
    const p = snap.data();
    if (p.createdByUid !== uid) throw new HttpsError('permission-denied', 'Only the person who asked can decide this.');
    if (p.status === 'scheduled' && data.decision === 'reject') { tx.update(ref, { status: 'cancelled', decidedAt: Timestamp.fromMillis(nowMs), decidedBy: actor.id }); return { done: true, p: { ...p, status: 'cancelled' }, event: 'cancelled' }; }          // a scheduled send can be cancelled until its time comes
    if (p.status !== 'pending') return { done: true, p };                                       // already decided: the same answer again, nothing repeated
    if (nowMs > p.expiresAt.toMillis()) { tx.update(ref, { status: 'expired', decidedAt: Timestamp.fromMillis(nowMs) }); return { done: true, p: { ...p, status: 'expired' }, event: 'expired' }; }
    if (data.decision === 'reject') { tx.update(ref, { status: 'rejected', decidedAt: Timestamp.fromMillis(nowMs), decidedBy: actor.id }); return { done: true, p: { ...p, status: 'rejected' }, event: 'rejected' }; }
    if (sendAt) { tx.update(ref, { status: 'scheduled', decidedAt: Timestamp.fromMillis(nowMs), decidedBy: actor.id, selected, scheduledFor: Timestamp.fromMillis(sendAt) }); return { done: true, p: { ...p, status: 'scheduled', scheduledFor: Timestamp.fromMillis(sendAt) }, event: 'scheduled' }; }
    tx.update(ref, { status: 'applying', decidedAt: Timestamp.fromMillis(nowMs), decidedBy: actor.id, ...(selected ? { selected } : {}) });
    return { done: false, p };
  });
  if (claimed.done) {
    if (claimed.event) await audit(db, { event: claimed.event, proposalId: claimed.p.id, kind: claimed.p.kind, targetId: claimed.p.targetId, by: actor.id, nowMs });
    return { status: claimed.p.status, message: { expired: 'This proposal expired. Ask again.', rejected: 'Rejected. Nothing was changed.', applying: 'It is being applied. Check again in a moment.', scheduled: claimed.p.scheduledFor ? `Scheduled for ${whenText(ms0(claimed.p.scheduledFor))}. Elite OS will send the emails then. You can cancel until then.` : '', cancelled: 'Cancelled. Nothing was sent.' }[claimed.p.status] || (claimed.p.result && claimed.p.result.message) || '', results: (claimed.p.result && claimed.p.result.results) || [] };
  }
  let result;
  try { result = claimed.p.kind === 'customerNote' ? await applyNote(db, claimed.p, nowMs) : claimed.p.kind === 'followUpEmails' ? await applyFollowUps(db, mailer, actor, claimed.p, nowMs) : claimed.p.kind === 'quoteFollowUps' ? await applyQuoteFollowUps(db, mailer, actor, claimed.p, nowMs) : claimed.p.kind === 'customerEmail' ? await applyCustomerEmail(db, mailer, actor, claimed.p, nowMs) : claimed.p.kind === 'followUpList' ? await applyFollowUpList(db, mailer, actor, claimed.p, nowMs, new Set(selected)) : await applyProject(db, actor, claimed.p, nowMs); }
  catch (e) { result = e instanceof StaleError ? { status: 'stale', message: e.message, results: [] } : { status: 'failed', message: messageOf(e), results: [] }; }
  await ref.update({ status: result.status, result: { message: result.message, results: result.results }, finishedAt: Timestamp.fromMillis(nowMs) });
  await audit(db, { event: result.status, proposalId: claimed.p.id, kind: claimed.p.kind, targetId: claimed.p.targetId, by: actor.id, nowMs });
  return result;
}

module.exports = { waiting, offKinds, KINDS, EXPIRY_MS, MAX_PENDING, NOTE_MAX, TOOLS, available, toolsFor, isProposeTool, propose, decide, sweepScheduled, STEP_LABEL };
