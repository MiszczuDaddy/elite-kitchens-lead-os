'use strict';
// Phase 9, Step C: the AI Knowledge Centre (docs/AI.md). What the receptionist (and the "Suggest reply" button) may say about the business, kept in Firestore so the owner edits it in Elite OS without a deploy.
//   aiKnowledge/draft            what the owner is editing (never used for real customers)
//   aiKnowledge/live             the published version the receptionist reads on every message
//   aiKnowledgeVersions/vNNNN    every published version (rollback = publish an old one again as a new version)
// Rules that never move into the editable knowledge (they stay in code): the consultation flow (aiSchedule.js: offer a visit once, ask about days only after agreement), manual takeover, quiet hours,
// the WhatsApp 24-hour window, the budget, and the answer checker below. The knowledge can only widen what the receptionist may SAY; it cannot switch a safety rule off.
// Writes are owner only and go through callables; nothing here touches a customer. No customer data is stored in the knowledge.
const { Timestamp } = require('firebase-admin/firestore');
const { HttpsError } = require('firebase-functions/v2/https');

const KINDS = ['approved', 'never', 'open'];
const LIMITS = { sections: 16, entries: 150, title: 140, text: 900, instructions: 3000, total: 26000, links: 8, examples: 40, example: 300, line: 220 };
const bad = (m) => new HttpsError('invalid-argument', m);
const isOwner = (owners, actor) => { const list = String(owners || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean); return !!actor && typeof actor.id === 'string' && list.includes(actor.id.toLowerCase()); };
const one = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const multi = (s, n) => String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, n);
const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const rid = () => 'k' + require('crypto').randomBytes(5).toString('hex');

// The lines the SYSTEM sends by itself (the model never writes these). Defaults are the owner's wording where he gave it; the rest are plain first drafts he can edit.
const DEFAULT_LINES = {
  holding: 'Good question, I\'ll check with the team and get back to you.',
  partly: 'I\'ll check the rest with the team and get back to you.',
  human: 'Of course, I\'ll get one of the team to message you.',
  outside_area: 'Thanks for getting in touch. That\'s outside the areas we cover, but I\'ll pass your message to the team to have a look.',
  declined_job: 'Thanks for getting in touch. That\'s not something we usually take on, but I\'ll pass your message to the team to have a look.',
  other_language: 'Thanks for your message, I\'ll pass this to the team and they\'ll get back to you.',
  complaint: 'I\'m sorry to hear that. I\'ll pass this on to the team so they can look into it.',
  links_intro: 'You can see some of our work here:',
  // Added after the 200-conversation audit (owner's decisions of 16 Oct 2026). A knowledge published before these existed gets these defaults until the owner edits them.
  declined: 'No problem at all, thanks for letting us know. If anything changes, just send us a message here.',
  thinking: 'No problem at all, just let us know when suits.',
  price_concern: 'Of course, completely understand. Every kitchen is priced individually, so there may be different options depending on what you\'re looking for.',
  browsing: 'No problem at all, take your time. If you have any questions, just ask.',
  photo: 'Thanks for the photo, I\'ll pass it on to the team.',
  voice: 'Thanks for the voice note, I\'ll pass it on to the team.',
  file: 'Thanks, I\'ll pass that on to the team.',
  late: 'No problem at all, thanks for letting us know. I\'ll tell the team.',
  booking_confirm: 'I\'ll pass this to the team and they\'ll confirm the time with you.',
  booking_specific: 'I\'ll pass that on to the team and they\'ll come back to you about it.',
  // Added after the audit of 17 Oct 2026 (PROPOSED wording, waiting for the owner's approval; the same defaults as aiSchedule LINES).
  still_looking: 'Are you still looking at a new kitchen?',
  soon: 'Thanks, I\'ll pass that on to the team straight away and they\'ll get back to you.',
  // Audit repairs of 17 Oct 2026 (PROPOSED wording, waiting for the owner's approval; the same defaults as aiSchedule LINES). cancel_noted reuses the owner's approved "running late" words.
  cancel_noted: 'No problem at all, thanks for letting us know. I\'ll tell the team.',
  privacy: 'Sorry, we can\'t share other customers\' details.',
};
const LINE_LABELS = { holding: 'Not sure / need to check', partly: 'Part answered, the rest needs checking', human: 'Customer asks for a person', outside_area: 'Outside the areas we cover', declined_job: 'A job we politely decline', other_language: 'Message not in English', complaint: 'A complaint or an upset customer', links_intro: 'Before the portfolio links',
  declined: 'Customer says no, not now or maybe later (no hand-over)', thinking: 'Customer wants to think about it (no hand-over)', price_concern: 'Customer finds the price more than expected (no hand-over)', browsing: 'Customer is just looking at options (no hand-over)',
  photo: 'Customer sends a photo (then a person takes over)', voice: 'Customer sends a voice note (then a person takes over)', file: 'Customer sends a video or file (then a person takes over)',
  late: 'Booked customer is running late (then a person takes over)', booking_confirm: 'Booked customer asks the time or to confirm (then a person takes over)', booking_specific: 'Booked customer asks for a specific day or time (then a person takes over)',
  still_looking: 'Customer only says hello (the question after our greeting)', soon: 'Customer asks for a visit today or tomorrow (then a person takes over)',
  cancel_noted: 'Booked customer cancels and wants no other date (then a person takes over)', privacy: 'Customer asks for another customer\'s details (then a person takes over)' };
const URLISH = /@|https?:|www\.|\.(?:ie|com|net|org|co|uk)\b|€|\d/i;

const emptyData = () => ({ sections: [], links: [], contact: { email: '', website: '', whatsapp: '' }, lines: { ...DEFAULT_LINES }, instructions: '', examples: [] });

// Checks and tidies what the screen sent. Throws a friendly error for anything wrong; unknown fields are refused.
function clean(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('The knowledge is missing.');
  for (const k of Object.keys(raw)) if (!['sections', 'links', 'contact', 'lines', 'instructions', 'examples'].includes(k)) throw bad('Unknown field: ' + k);
  const out = emptyData(), seen = new Set(); let entries = 0, total = 0;
  for (const k of ['sections', 'links', 'examples']) if (k in raw && !Array.isArray(raw[k])) throw bad('The ' + k + ' are not valid.');
  const secs = Array.isArray(raw.sections) ? raw.sections : [];
  if (secs.length > LIMITS.sections) throw bad(`At most ${LIMITS.sections} sections.`);
  for (const s of secs) {
    if (!s || typeof s !== 'object') throw bad('A section is not valid.');
    let sid = typeof s.id === 'string' && ID.test(s.id) ? s.id : rid(); while (seen.has(sid)) sid = rid(); seen.add(sid);
    const title = one(s.title, 80); if (!title) throw bad('Every section needs a name.');
    const list = [];
    for (const e of Array.isArray(s.entries) ? s.entries : []) {
      if (!e || typeof e !== 'object') throw bad('An entry is not valid.');
      if (++entries > LIMITS.entries) throw bad(`At most ${LIMITS.entries} entries.`);
      let eid = typeof e.id === 'string' && ID.test(e.id) ? e.id : rid(); while (seen.has(eid)) eid = rid(); seen.add(eid);
      if (!KINDS.includes(e.kind)) throw bad('Each entry must be Approved, Never promise or Open.');
      const et = one(e.title, LIMITS.title), tx = multi(e.text, LIMITS.text);
      if (!et) throw bad(`An entry in "${title}" has no title.`);
      if (e.kind !== 'open' && !tx) throw bad(`"${et}" needs some text (or mark it Open).`);
      total += et.length + tx.length; list.push({ id: eid, kind: e.kind, title: et, text: tx });
    }
    out.sections.push({ id: sid, title, entries: list });
  }
  const links = Array.isArray(raw.links) ? raw.links : []; if (links.length > LIMITS.links) throw bad(`At most ${LIMITS.links} links.`);
  const lseen = new Set();
  for (const l of links) {
    if (!l || typeof l !== 'object') throw bad('A link is not valid.');
    let id = typeof l.id === 'string' && ID.test(l.id) ? l.id : rid(); while (lseen.has(id) || seen.has(id)) id = rid(); lseen.add(id);
    const label = one(l.label, 60), url = one(l.url, 160).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
    if (!label) throw bad('Every link needs a name.');
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/[^\s]*)?$/i.test(url)) throw bad(`"${label}": enter the address, for example elitekitchens.ie or instagram.com/yourname.`);
    out.links.push({ id, label, url }); total += label.length + url.length;
  }
  const c = raw.contact && typeof raw.contact === 'object' ? raw.contact : {};
  out.contact = { email: one(c.email, 120).toLowerCase(), website: one(c.website, 120).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, ''), whatsapp: one(c.whatsapp, 40) };
  if (out.contact.email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(out.contact.email)) throw bad('The email address is not valid.');
  const ln = raw.lines && typeof raw.lines === 'object' ? raw.lines : {};
  for (const k of Object.keys(DEFAULT_LINES)) {
    const v = k in ln ? one(ln[k], LIMITS.line) : DEFAULT_LINES[k];
    if (!v) throw bad(`The line "${LINE_LABELS[k]}" cannot be empty.`);
    if (URLISH.test(v)) throw bad(`The line "${LINE_LABELS[k]}" cannot contain numbers, prices or addresses: those belong in the knowledge entries.`);
    out.lines[k] = v;
  }
  out.instructions = multi(raw.instructions, LIMITS.instructions); total += out.instructions.length;
  const ex = Array.isArray(raw.examples) ? raw.examples : []; if (ex.length > LIMITS.examples) throw bad(`At most ${LIMITS.examples} example questions.`);
  const eseen = new Set();
  for (const e of ex) {
    if (!e || typeof e !== 'object') throw bad('An example is not valid.');
    let id = typeof e.id === 'string' && ID.test(e.id) ? e.id : rid(); while (eseen.has(id)) id = rid(); eseen.add(id);
    const text = one(e.text, LIMITS.example); if (!text) throw bad('An example question is empty.');
    const state = ['new', 'offered', 'asked_days', 'booked'].includes(e.state) ? e.state : 'new';
    const mustNot = (Array.isArray(e.mustNot) ? e.mustNot : []).map((x) => one(x, 60)).filter(Boolean).slice(0, 6);
    out.examples.push({ id, text, state, mustNot });
  }
  if (total > LIMITS.total) throw bad(`The knowledge is too long (${total} of ${LIMITS.total} characters). Shorten some entries.`);
  return out;
}

// ---- what the model is given ----
const SECTION_NOTE = { approved: '', never: ' [NEVER SAY OR IMPLY]', open: ' [OPEN: not confirmed]' };
function compile(data, version) {
  const d = data || emptyData(), lines = [], never = [], open = [];
  for (const s of d.sections) {
    const rows = [];
    for (const e of s.entries) {
      if (e.kind === 'never') never.push(`- (${e.id}) ${e.title}: ${e.text}`);
      else if (e.kind === 'open') open.push(`- (${e.id}) ${e.title}`);
      else rows.push(`- (${e.id}) ${e.title}: ${e.text}`);
    }
    if (rows.length) lines.push(`[${s.title}]`, ...rows, '');
  }
  const parts = [`APPROVED KNOWLEDGE (version ${version || 'draft'}). Use ONLY this for facts about the business:`, ...lines];
  if (never.length) parts.push('NEVER SAY OR IMPLY:', ...never, '');
  if (open.length) parts.push('OPEN ITEMS (not confirmed: do not answer these, say the team will check, answerState "partly" or "none"):', ...open, '');
  if (d.links.length) parts.push('PORTFOLIO LINKS (never type the address: put the id in "links" when the customer asks to see previous work, photos, styles or projects):', ...d.links.map((l) => `- ${l.id}: ${l.label}`), '');
  const c = d.contact, cl = [c.email && `email ${c.email}`, c.website && `website ${c.website}`, c.whatsapp && `WhatsApp ${c.whatsapp} (they are already on WhatsApp: do not repeat it)`].filter(Boolean);
  if (cl.length) parts.push('CONTACT DETAILS (give the email or website only when the customer asks how to get in touch): ' + cl.join('; '), '');
  if (d.instructions) parts.push('OWNER\'S INSTRUCTIONS FOR HOW TO WRITE:', d.instructions, '');
  const text = parts.join('\n').trim();
  const hay = [d.sections.map((s) => s.entries.filter((e) => e.kind === 'approved').map((e) => e.title + ' ' + e.text).join(' ')).join(' '), d.links.map((l) => l.url).join(' '), c.email, c.website, c.whatsapp].join(' ').toLowerCase();
  const titles = Object.fromEntries(d.sections.flatMap((s) => s.entries.map((e) => [e.id, e.title])));
  // The names the knowledge itself uses (Blum, Cemux, Robson Oak, Dekton, Gola...): an answer that names them ("It's Robson Oak as standard") is not claiming to be a person.
  const names = new Set((d.sections.flatMap((s) => s.entries.filter((e) => e.kind === 'approved').map((e) => e.title + ' ' + e.text)).join(' ').match(/\b[A-Z][a-zA-Z'’-]+/g) || []).map((x) => x.toLowerCase()));
  return { version: version || null, text, lines: d.lines, links: d.links, contact: d.contact, examples: d.examples, haystack: hay, titles, allowed: allowedFrom(hay, d), facts: factsFrom(d), names, entryCount: Object.keys(titles).length };
}

// ================= the answer checker =================
// Runs on every sentence the model wrote for a customer, before it is sent. It reads each sentence in its context (a negation or "I'll check" makes "confirmed" or "guarantee" harmless; "your visit is confirmed" is not).
// A failed answer is never sent: the customer gets the holding line and a person gets the chat. The reasons are fixed phrases (no customer words), safe to log.
const WORDNUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50 };
const UNIT = '(?:day|days|week|weeks|month|months|year|years|hour|hours|minute|minutes|percent|per cent|%|k|thousand|euro|euros)';
// number words become digits only when they are used as a quantity ("four to six weeks", "ten thousand"), never in "one of the team"
function digitise(t) {
  const w = Object.keys(WORDNUM).join('|');
  return String(t).replace(new RegExp(`\\b(${w})\\b(?=\\s*(?:to|or|-)\\s*(?:${w}|\\d)|\\s*${UNIT}\\b)`, 'gi'), (m) => String(WORDNUM[m.toLowerCase()]))
    .replace(new RegExp(`(\\d)\\s*(?:to|or)\\s*(${w})\\b`, 'gi'), (m, a, b) => `${a} to ${WORDNUM[b.toLowerCase()]}`);
}
const numbersIn = (t) => {
  const out = new Set(), s = digitise(t);
  // "7k", "7 thousand", "seven thousand" (digitised to "7 thousand") and "7 grand" are 7000 (Astra F4 A018: the customer's "seven thousand euro" counted as 7, so the answer's "€7,000" was blocked)
  for (const m of s.matchAll(/(\d[\d,]*(?:\.\d+)?)(\s?(?:k|thousand|grand)\b)?/gi)) { const v = parseFloat(m[1].replace(/,/g, '')); if (Number.isFinite(v)) out.add(String(m[2] ? v * 1000 : v)); }
  return out;
};
const durationsIn = (t) => {
  const out = new Set();
  for (const m of digitise(t).matchAll(/(\d+)\+?(?:\s?(?:to|or|-)\s?(\d+))?\s*(day|week|month|year|hour|minute)s?\b/gi)) out.add((m[2] ? m[1] + '-' + m[2] : m[1]) + ' ' + m[3].toLowerCase());
  return out;
};
const percentsIn = (t) => { const out = new Set(); for (const m of digitise(t).matchAll(/(\d+(?:\.\d+)?)\s?(?:%|percent|per cent)/gi)) out.add(m[1]); return out; };
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const HOST = /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:ie|com|net|org|co|uk|eu|info|io)\b(?:\/[^\s,;)"]*)?/gi;
const norm = (s) => String(s).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[.,;:!?)"']+$/, '').replace(/\/+$/, '');
const hostsIn = (t) => { const s = String(t), e = [...s.matchAll(EMAIL)].map((m) => norm(m[0])), rest = s.replace(EMAIL, ' '); return { emails: e, hosts: [...rest.matchAll(HOST)].map((m) => norm(m[0])) }; };
const phonesIn = (t) => [...String(t).matchAll(/\+?\d[\d\s().-]{6,}\d/g)].map((m) => m[0].replace(/\D/g, '')).filter((d) => d.length >= 7);
function allowedFrom(hay, d) {
  const wp = hay.split(/(?<=[.!?])\s+/).some((x) => /\b(wardrobes?|utility|utilities)\b/.test(x) && /€\s?\d|\b\d[\d,.]*\s?(?:k|euro|euros)\b/.test(x));
  const freeWords = new Set(); for (const m of hay.matchAll(/\bfree\b((?:\s+[a-z-]+){1,3})/g)) m[1].trim().split(/\s+/).forEach((w) => freeWords.add(w));
  const a = { freeWords, wardrobePrice: wp, numbers: numbersIn(hay), durations: durationsIn(hay), percents: percentsIn(hay), emails: new Set(), hosts: new Set(), phones: new Set(phonesIn(hay)) };
  const h = hostsIn(hay); h.emails.forEach((x) => a.emails.add(x)); h.hosts.forEach((x) => a.hosts.add(x));
  for (const l of d.links) a.hosts.add(norm(l.url));
  if (d.contact.email) a.emails.add(norm(d.contact.email)); if (d.contact.website) a.hosts.add(norm(d.contact.website));
  for (const x of phonesIn(d.contact.whatsapp)) a.phones.add(x);
  return a;
}
const NEG = /\b(not|no|never|cannot|can't|cant|won't|isn't|aren't|don't|doesn't|didn't|unable|without|neither|nor)\b|n't\b/i;
const HEDGE = /\b(?:i'?ll|we'?ll|i will|we will|the team will|the team can|can|could|let me|need to|going to|happy to|to|will)\s+(?:\w+\s+){0,3}?(?:check|confirm|find out|come back|get back|let you know)\b|\b(?:check with|confirm with|not sure|don't know|do not know)\b/i;
const sentencesOf = (t) => String(t).split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

// ---- contradictions with the knowledge (audit 16 Oct 2026, finding 6) ----
// A fixed list of the kinds of claim a receptionist makes about the business (a showroom, what we supply or arrange, what is included, the services and jobs we take, door styles, the free visit, the areas we cover).
// The list says how to RECOGNISE a claim; whether a claim is right is read from the knowledge itself: each approved sentence that makes the claim, or denies it, sets its stance, a NEVER entry forbids it and
// an OPEN item leaves it unconfirmed. So when the owner edits the knowledge ("we now have a showroom"), the check follows without a deploy. A claim the knowledge says nothing about is not judged here (the
// number, address and wording checks still apply). A "not" counts only right next to the claim, inside its own clause: "We can't give an exact price, it comes after the free home visit" does not deny the free visit,
// and "We have no showroom, but the design is done at a free home visit" is two claims.
const FREE_LINK = new Set(['with', 'and', 'or', 'but', 'so', 'too', 'as', 'at', 'to', 'for', 'if', 'on', 'in', 'there', 'here', 'when', 'until', 'then', 'which', 'that', 'is', 'are', 'nothing',
  'though', 'anyway', 'also', 'either']);         // "The home visit is free though" (our audit, B04) names nothing that is free
const AFFIRM_NO =/\bno (?:problem|worries|bother|obligation|rush|pressure|hassle)\b|\bnot a problem\b|\bno matter\b/gi;
const NEG_CLAIM = /\b(not|no|never|cannot|can't|cant|won't|isn't|aren't|don't|doesn't|didn't|unable|neither|nor|decline|declines|outside)\b|n't\b/i;
const unNo = (t) => String(t).replace(AFFIRM_NO, (m) => ' '.repeat(m.length));                    // "no problem" is not a "no" (same length, so positions stay)
const negClause = (c) => NEG_CLAIM.test(unNo(c));
const clausesOf = (t) => sentencesOf(t).flatMap((s) => s.split(/\s*;\s*|,\s+and\s+|,?\s+\b(?:but|although|though|however|whereas|while)\b,?\s+/i)).map((x) => x.trim()).filter(Boolean);       // ", and" starts a new claim ("laminate is included, and stone costs extra")
// Every place a claim is made in a piece of text, each with whether it is denied: a negative word in the claim itself or in the few words before it. A knowledge sentence that opens with a negative list
// ("We politely decline: A; B; C", "Not included in any quote: ...") denies every item in it.
const LEAD_NEG = /^[^:]{0,60}\b(?:decline|declines|not included|never|don't|do not|no)\b[^:]{0,40}:/i;
function claimsIn(re, text, { lead = false } = {}) {
  const t = unNo(text), out = [], g = new RegExp(re.source, 'gi');
  for (const m of t.matchAll(g)) {
    const before = t.slice(Math.max(0, m.index - 35), m.index), cut = Math.max(before.lastIndexOf(','), before.lastIndexOf(';'), before.lastIndexOf(':'), before.lastIndexOf('('));
    out.push({ at: m.index, neg: lead || NEG_CLAIM.test(before.slice(cut + 1) + m[0]) });                // only the words of its own clause count
  }
  return out;
}
const AGENT = "(?:we|we'll|we'd|we're|we've|us|our (?:team|fitters)|the team|elite kitchens)";
const PASSIVE = 'included|covered|arranged|organi[sz]ed|provided|supplied|handled|done|taken care of|sorted|part of the (?:price|quote|job|package)';
const BE = "(?:is|are|isn't|aren't|'s|'re|be|being|was|were)";
// "we <verb> X", "X is <included / arranged ...>", "the price includes X", "Not included: X". `verbs` are what WE would do with it.
function doneByUs(noun, verbs) {
  return new RegExp(`\\b${AGENT}\\b[^.?!,;]{0,30}\\b(?:${verbs})\\b[^.?!,;]{0,60}\\b(?:${noun})\\b|\\b(?:${noun})\\b[^.?!]{0,40}\\b${BE}[^.?!]{0,15}\\b(?:${PASSIVE})\\b(?!\\s+(?:by\\s+(?:the\\s+)?(?:customer|you|your|their)|after|before|once|when))|\\b(?:${noun})\\b[^.?!]{0,30}:\\s*(?:never\\s+|not\\s+)?(?:${PASSIVE})\\b|\\b(?:price|quote|cost)\\s+(?:includes|covers)\\b[^.?!]{0,60}\\b(?:${noun})\\b|\\bincluded\\b[^.?!:,;]{0,25}:[^.?!]{0,120}\\b(?:${noun})\\b|\\bincluded\\b[^.?!,;]{0,40}\\b(?:${noun})\\b`, 'i');
}
const TRADE_VERBS = 'arrange\\w*|organi[sz]e\\w*|provide\\w*|supply|supplies|do|does|handle\\w*|take care of|takes care of|sort|sorts|look after|looks after|include\\w*|fit|fits|lay|lays|get|gets|bring|brings';
// claim: what makes the claim; counter: a statement of the opposite (e.g. "stone is priced separately" = stone is not included); unless: a clause that matches this is about something else.
const SUBJECTS = [
  { id: 'showroom', claim: /\bshowrooms?\b/i, why: 'says we have a showroom' },
  { id: 'samples', claim: /\bsamples?\b/i, why: 'says something about samples' },
  { id: 'appliances', claim: doneByUs('appliances?', 'supply|supplies|provide\\w*|sell\\w*|source\\w*|include\\w*|arrange\\w*|get|gets|order|orders|buy them'), why: 'says we supply appliances' },
  { id: 'skip', claim: doneByUs('skips?|waste(?: removal)?|rubbish', TRADE_VERBS), why: 'says we arrange the skip or waste removal' },
  { id: 'electrics', claim: doneByUs('electric\\w*|electrician\\w*|wiring', TRADE_VERBS), why: 'says we do the electrics' },
  { id: 'plumbing', claim: doneByUs('plumb\\w*', TRADE_VERBS), why: 'says we do the plumbing' },
  { id: 'gas', claim: doneByUs('gas', TRADE_VERBS), why: 'says we do the gas' },
  { id: 'tiling', claim: doneByUs('til(?:es|ing)|splashbacks? tiles', TRADE_VERBS), why: 'says we do the tiling' },
  { id: 'flooring', claim: doneByUs('floor(?:s|ing)', TRADE_VERBS), why: 'says we do the flooring' },
  { id: 'painting', claim: doneByUs('paint(?:ing)?|decorat\\w*', TRADE_VERBS), why: 'says we do painting or decorating' },
  { id: 'old_kitchen', claim: /\b(?:remov\w*|take away|takes away|taking away|rip(?:ping)? out|strip(?:ping)? out)\b[^.?!]{0,30}\bold kitchen\b|\bold kitchen\b[^.?!]{0,30}\b(?:remov\w*|taken away|ripped out)\b/i, why: 'says the old kitchen is not removed' },
  // "standard" right before "laminate" is about the laminate ("stone costs extra on top of the standard laminate": Astra F4 A013), not a claim that stone is standard
  { id: 'stone_included', claim: /\b(?:stone|quartz|dekton|granite|sintered)\b[^.?!]{0,40}\b(?:included|as standard|standard(?!\s+laminate)|at no extra cost|no extra cost|free)\b|\b(?:includ\w*|comes? with)\b[^.?!,;]{0,30}\b(?:stone|quartz|dekton|granite|sintered)\b/i,
    counter: /\b(?:stone|quartz|dekton|granite|sintered)\b[^.?!]{0,60}\b(?:extra|optional|priced separately|separately|on top)\b/i, why: 'says stone worktops are included' },
  { id: 'laminate_included', claim: /\blaminate\b[^.?!]{0,30}\bworktops?\b[^.?!]{0,30}\b(?:included|as standard)\b|\b(?:includ\w*|comes? with)\b[^.?!,;]{0,40}\blaminate\b|\blaminate worktops? (?:is|are) included\b/i, why: 'says the laminate worktop is not included' },
  { id: 'wardrobes', claim: new RegExp(`\\b${AGENT}\\b[^.?!]{0,30}\\b(?:do|does|make|makes|fit|fits|offer|offers|supply|supplies|design|designs|build|builds|install|installs)\\b[^.?!]{0,40}\\bwardrobes?\\b|\\bwardrobes?\\b[^.?!]{0,30}\\b(?:can be ordered|are available|available)\\b`, 'i'), why: 'says we do not do wardrobes' },
  { id: 'utility', claim: new RegExp(`\\b${AGENT}\\b[^.?!]{0,30}\\b(?:do|does|make|makes|fit|fits|offer|offers|supply|supplies|design|designs|build|builds|install|installs)\\b[^.?!]{0,60}\\butilit(?:y|ies)\\b|\\butilit(?:y|ies)\\b[^.?!]{0,30}\\b(?:can be ordered|are available|available)\\b`, 'i'), why: 'says we do not do utility rooms' },
  { id: 'part_jobs', claim: /\b(?:just|only)\s+(?:the\s+|new\s+|replace\w*\s+|change\w*\s+)?(?:doors?|worktops?|fronts?)\b|\b(?:doors?|worktops?|fit)[- ]only\b|\bunits? (?:you|they) (?:bought|got|ordered) elsewhere\b|\brepairs? (?:to|on|of) (?:kitchens?|units?) (?:supplied|fitted|made) by\b/i, why: 'says we take on a job we decline' },
  // Which drawers are standard (Astra F10: "Our standard drawers are Blum." passed). The knowledge says Cemux are standard and Blum drawers are an optional upgrade; the stance follows the knowledge.
  { id: 'blum_drawers_standard', claim: /\bblum (?:soft[- ]close )?drawers?\b[^.?!,;]{0,30}\b(?:are |come |is )?(?:as )?standard\b|\b(?:standard|our) drawers?\b[^.?!,;]{0,15}\b(?:are|is)\s+(?:\w+\s+){0,2}?blum\b|\bdrawers?\s+(?:are|come)\s+(?:all\s+)?(?:from\s+)?blum\b/i,
    counter: /\bblum drawers?\b[^.?!]{0,40}\b(?:optional|upgrade|extra)\b/i, why: 'says Blum drawers are standard' },
  { id: 'handleless', claim: /\b(?:handleless|gola)\b/i, why: 'says we do not do handleless' },
  { id: 'shaker', claim: /\bshaker\b/i, why: 'says we do not do shaker' },
  { id: 'visit_free', claim: /\b(?:home visit|visit|consultation|design)\b[^.?!]{0,40}?\b(?:free|free of charge|complimentary)\b|\bfree\b[^.?!]{0,15}\b(?:home visit|visit|consultation|design)\b/i,
    counter: /\b(?:charge|fee|cost)s?\b[^.?!]{0,20}\bfor (?:the|a) (?:home )?(?:visit|consultation|design)\b|\b(?:visit|consultation|design)\b[^.?!]{0,20}\b(?:costs?|is charged|has a fee)\b/i, why: 'says the home visit is not free' },
];
const COUNTIES = ['antrim', 'armagh', 'carlow', 'cavan', 'clare', 'cork', 'derry', 'donegal', 'down', 'dublin', 'fermanagh', 'galway', 'kerry', 'kildare', 'kilkenny', 'laois', 'leitrim', 'limerick', 'longford', 'louth', 'mayo', 'meath', 'monaghan', 'offaly', 'roscommon', 'sligo', 'tipperary', 'tyrone', 'waterford', 'westmeath', 'wexford', 'wicklow'];
const COVER = /\b(?:cover|covers|covering|serve|serves|serving|work in|working in|come to|travel to|go to|fit kitchens in|do jobs in|areas? (?:we cover|include))\b/i;
const countiesIn = (c) => COUNTIES.filter((x) => (x === 'down' ? /\bco(?:unty|\.)? down\b/i : new RegExp(`\\b${x}\\b`, 'i')).test(c));
// The figures that belong to a topic: a figure next to one of these words must appear next to the same kind of word in the knowledge ("a 30% deposit", not "a 90% deposit" because 90% is used elsewhere).
const ANCHORS = [/\bdeposit\b/i, /\bvalid\b/i, /\b(?:experience|been at it|established|in business|trading)\b/i, /€|\b(?:prices?|priced|costs?|budget|euros?)\b/i, /\b(?:fit|fits|fitting|fitted|install\w*)\b/i,
  /\b(?:manufactur\w*|made|built|produc\w*)\b/i, /\b(?:guarantee\w*|warrant\w*)\b/i, /\b(?:of (?:our|the) work|renovations)\b/i];
const AGREE = /\b(?:yes|yeah|enough|plenty|fine|grand|no problem|should (?:cover|do)|will (?:cover|do)|covers? it|that works|doable|perfect|great|ok|okay|absolutely|definitely|sure|perfectly)\b/i;
const TIGHT = /\b(?:tight|not enough|isn't enough|below|under|less than|short|stretch)\b/i;
const OPEN_STOP = new Set(['what', 'when', 'does', 'will', 'there', 'about', 'many', 'much', 'long', 'that', 'this', 'with', 'from', 'have', 'they', 'them', 'into', 'your', 'ours', 'mention', 'brought', 'given', 'confirmed']);
const wordsOf = (t) => (String(t).toLowerCase().match(/[a-z]{4,}/g) || []).map((w) => w.replace(/s$/, '')).filter((w) => !OPEN_STOP.has(w));
function factsFrom(d) {
  const stance = {}, set = (id, k) => { (stance[id] = stance[id] || {})[k] = true; }, covered = new Set(), numbers = [], open = [];
  for (const s of d.sections) for (const e of s.entries) {
    if (e.kind === 'open') { const head = wordsOf(e.title.split(':')[0]); open.push({ head, words: [...new Set(wordsOf(e.title))] }); for (const x of SUBJECTS) if (x.claim.test(e.title)) set(x.id, 'open'); continue; }
    // The title is a label ("Showroom", "Door styles"): a claim found in it only counts when it is denied ("Not included in any quote: ...", "Tiling, flooring, painting: Not included.").
    for (const [i, c] of sentencesOf(e.title + ': ' + e.text).entries()) {
      const lead = LEAD_NEG.test(c), inTitle = (m) => i === 0 && m.at < e.title.length && !m.neg;
      for (const x of SUBJECTS) {
        if (e.kind === 'never') { if (x.claim.test(c)) set(x.id, 'never'); continue; }
        for (const m of claimsIn(x.claim, c, { lead })) if (!inTitle(m)) set(x.id, m.neg ? 'no' : 'yes');
        if (x.counter) for (const m of claimsIn(x.counter, c, { lead })) if (!inTitle(m)) set(x.id, m.neg ? 'yes' : 'no');
      }
      if (e.kind === 'approved' && !lead && !negClause(c) && COVER.test(c)) countiesIn(c).forEach((x) => covered.add(x));
    }
    if (e.kind === 'approved') for (const sn of sentencesOf(e.title + '. ' + e.text)) numbers.push({ nums: numbersIn(sn), pcts: percentsIn(sn), anchors: ANCHORS.map((a) => a.test(sn)) });
  }
  return { stance, covered, numbers, open };
}
// The reasons (fixed phrases) why an answer contradicts the knowledge, or answers what it leaves open. `customer` holds the figures the customer gave.
function contradictions(t, F, customer) {
  const r = [], add = (why) => { if (!r.includes(why)) r.push(why); };
  if (!F) return r;
  for (const c of clausesOf(t)) {
    if (HEDGE.test(c)) continue;                                                                    // "I'll check whether we bring samples" claims nothing
    for (const x of SUBJECTS) {
      const s = F.stance[x.id]; if (!s) continue;
      // true = the clause says it is so. A clause that states the opposite outright ("stone is an optional extra") is read as that statement: words of the claim in the same clause ("laminate included and
      // stone as an optional extra") do not turn it into the claim (Astra F4 A079).
      const counters = x.counter ? claimsIn(x.counter, c) : [], plain = counters.some((m) => !m.neg);
      const says = [...(plain ? [] : claimsIn(x.claim, c).map((m) => !m.neg)), ...counters.map((m) => m.neg)];
      if (!says.length) continue;
      if (s.open && !s.yes && !s.no) { add('answers something the knowledge leaves open: ' + x.id); continue; }
      if (says.some(Boolean) && (s.no || s.never) && !s.yes) add('contradicts the approved knowledge: ' + x.id);
      if (says.some((v) => !v) && s.yes && !s.no && !s.never) add('contradicts the approved knowledge: ' + x.id);
    }
    if (F.covered.size && COVER.test(c) && !negClause(c)) for (const x of countiesIn(c)) if (!F.covered.has(x)) add('says we cover an area the knowledge does not list');
    for (const o of F.open) {
      const w = new Set(wordsOf(c)), head = o.head.some((h) => w.has(h)), others = o.words.filter((x) => !o.head.includes(x) && w.has(x)).length;
      if (head && others >= 2) add('answers something the knowledge leaves open');
    }
  }
  // Figures: one next to a topic word must sit next to the same kind of word in the knowledge. A figure the customer gave may be repeated ("7k would be tight"), never agreed with ("7k is plenty").
  for (const s of sentencesOf(t)) {
    const anchors = ANCHORS.map((a) => a.test(s)), topical = anchors.some(Boolean), pcts = percentsIn(s);
    for (const n of numbersIn(s)) {
      const has = (k) => (pcts.has(n) ? k.pcts.has(n) : k.nums.has(n));                                   // "5%" must be a percentage there too ("3 to 5 days" is not)
      const supported = topical ? F.numbers.some((k) => has(k) && k.anchors.some((v, i) => v && anchors[i])) : F.numbers.some(has);
      if (supported) continue;
      if (customer.has(n)) { if (AGREE.test(unNo(s)) && !TIGHT.test(s) && !negClause(s)) add('agrees with a figure the customer gave'); continue; }
      if (topical) add('a figure that does not match the approved knowledge for that topic');
    }
  }
  return r;
}

// `extra` is what the CUSTOMER wrote (and their lead details): figures they gave may be repeated back ("7k"), nothing else about them is trusted.
function checkAnswer(text, K, { extra = '' } = {}) {
  const r = [], t = String(text == null ? '' : text).trim();
  if (!t) return { ok: true, reasons: [] };
  const A = K && K.allowed ? K.allowed : allowedFrom('', emptyData()), hay = K && K.haystack ? K.haystack : '';
  const add = (why) => { if (!r.includes(why)) r.push(why); };
  if (t.length > 520) add('too long for WhatsApp');
  if (sentencesOf(t).length > 5) add('too many sentences');
  if (/\b(approved knowledge|knowledge base|system prompt|reply_decision|the document|my instructions)\b/i.test(t)) add('mentions its instructions');
  // amounts, durations, percentages and every other number must come from the knowledge
  const X = extra ? { n: numbersIn(extra), d: durationsIn(extra), p: percentsIn(extra) } : { n: new Set(), d: new Set(), p: new Set() };
  const nums = numbersIn(t); for (const n of nums) if (!A.numbers.has(n) && !X.n.has(n)) { add('a number that is not in the approved knowledge'); break; }
  for (const d of durationsIn(t)) if (!A.durations.has(d) && !X.d.has(d)) { add('a time period that is not in the approved knowledge'); break; }
  for (const p of percentsIn(t)) if (!A.percents.has(p) && !X.p.has(p)) { add('a percentage that is not in the approved knowledge'); break; }
  // addresses
  const h = hostsIn(t);
  for (const e of h.emails) if (!A.emails.has(e)) { add('an email address that is not in the approved knowledge'); break; }
  for (const x of h.hosts) if (![...A.hosts].some((a) => a === x || a.startsWith(x + '/') || x.startsWith(a + '/'))) { add('a web address that is not in the approved knowledge'); break; }
  for (const p of phonesIn(t)) if (!A.phones.has(p)) { add('a phone number that is not in the approved knowledge'); break; }
  if (/\b(i'?m|i am|this is)\s+(a\s+)?(real\s+)?(person|human|man|woman)\b/i.test(t)) add('claims to be a person');
  for (const x of contradictions(t, K && K.facts, X.n)) add(x);                                    // claims the knowledge says are wrong, or leaves open (finding 6)
  for (const s of sentencesOf(t)) {
    const neg = NEG.test(unNo(s)), hedge = HEDGE.test(s), soft = neg || hedge;                     // "No problem, your visit is confirmed" is not a negative sentence
    // "solid oak" is denied only by words right in front of it ("a wood-look finish rather than solid oak", "it isn't solid oak"), not by a "not" elsewhere in the sentence (Astra F4 A092)
    for (const m of s.matchAll(/\bsolid\s+(?:oak|wood|timber)\b/gi)) if (!/\b(?:not|never|no|rather than|instead of|than|isn'?t|aren'?t|wasn'?t)\b[^.?!,;]{0,25}$|n't\b[^.?!,;]{0,25}$/i.test(s.slice(0, m.index))) { add('calls veneer solid wood'); break; }
    if (/\bfamily[\s-]*(run|owned|business|firm)\b|\brun by\b/i.test(s) && !neg) add('says who runs the business');
    if (/\b(guarantee[sd]?|warranty|warranties|guaranteed)\b/i.test(s) && !soft) {
      const blum = /\bblum\b/i.test(s) && /\b(lifetime|mechanical)\b/i.test(s) && /\bblum\b/i.test(hay) && /\blifetime\b/i.test(hay);
      // Blum's guarantee covers Blum HARDWARE: a sentence that puts the kitchen, the units or the doors under it widens it (Astra F10: "The whole kitchen is covered by Blum's lifetime mechanical guarantee" passed)
      const widened = blum && /\b(?:whole|entire|everything|every part|kitchens?|units?|cabinets?|carcass\w*|doors?|worktops?|appliances?|fitting|workmanship)\b/i.test(s) && !/\b(?:hardware|hinges?|drawers?|runners?|mechanisms?|fittings?|soft[- ]close)\b/i.test(s);
      if (!blum) add('mentions a guarantee or warranty that is not approved'); else if (widened) add('widens the Blum guarantee beyond the Blum hardware');
    }
    // Who employs the fitters is not in the knowledge: "our own fitters", "in-house", "we never subcontract" answer an open question by implication (our audit, D14: asked "is it subcontracted?").
    if (/\bour own\s+(?:\w+\s+)?(?:fitters?|team|staff|installers?|joiners?|carpenters?|crew|people|employees)\b|\bin[- ]house\b|\bdirectly employed\b|\b(?:never|don'?t|do not|no|not)\s+(?:use\s+)?sub-?contract\w*/i.test(s) && !/\b(?:own fitters|in[- ]house|employ\w*|sub-?contract\w*)\b/i.test(hay)) add('says who employs the fitters, which the knowledge does not');
    // A visit stated as booked, confirmed, moved or cancelled, whatever polite words come with it (Astra F10: "We can confirm your visit is booked." passed because "can ... confirm" read as "I'll check").
    // Not when it is denied right there ("isn't booked yet") or only a condition ("once it's booked", "until the visit is confirmed", "whether").
    { const m = s.match(/\b(?:visit|appointment|consultation|booking|survey|measure[- ]?up|home visit)\b[^.?!]{0,25}?\b(?:is|has been|'s|are|was|have been)\s+(?:now\s+|all\s+)?(?:booked|confirmed|scheduled|cancell?ed|moved|rescheduled|arranged|locked in|pencilled in|in the diary)\b|\b(?:we|i)\s+(?:can\s+|have\s+|'ve\s+)?confirm(?:ed)?\s+(?:that\s+)?(?:your|the)\s+(?:visit|appointment|booking|consultation)\b/i);
      if (m && !/\b(?:once|until|till|when|after|before|if|whether|as soon as|whenever)\b/i.test(s.slice(0, m.index + m[0].length))) add('says a visit is booked or confirmed'); }
    if (/\b(100%|definitely will|for sure|i promise|we promise|guaranteed?)\b/i.test(s) && !soft && !/\bblum\b/i.test(s)) add('makes a promise');
    if (/\b(discount|% off|special offer|price match|knock\s+\w+\s+off|cheaper)\b/i.test(s) && !soft) add('mentions a discount');
    const visitish = /\b(visit|appointment|consultation|call(?:ing)? out|come out|measure|measuring|slot|fitting|installation|you'?re (?:all )?(?:set|sorted|down))\b/i.test(s);
    if (/\b(booked|confirmed|scheduled|cancel+ed|rescheduled|arranged|locked in|pencilled|reserved|sorted)\b/i.test(s) && visitish && !soft && !/\b(once|until|when|after|before|if|whenever)\b/i.test(s)) add('says a visit is booked or confirmed');
    if (/\byou'?re (all )?(booked|confirmed)\b/i.test(s) && !soft) add('says a visit is booked or confirmed');
    if (/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|this (?:morning|afternoon|evening|week|weekend)|next (?:week|month))\b/i.test(s) && !soft) add('mentions a day or date');
    if (/\b(we|elite kitchens|our team|the team)\b[^.?!]{0,30}\b(supply|supplies|provide|provides|sell|sells|include|includes|offer|offers|do|does|arrange|arranges|organise|organises|organize|organizes|handle|handles|take care of|takes care of)\b[^.?!]{0,40}\b(appliances?|skips?|waste|gas|electric\w*|plumb\w*|tiling|flooring|painting|decorating)\b/i.test(s) && !neg && !/\bintegrated\b/i.test(s)) add('says we arrange or supply something we do not');
    const money = /€\s?\d|\b\d[\d,.]*\s?(?:k|euro|euros)\b/i.test(s);
    if (money && /\b(wardrobes?|utility|utilities)\b/i.test(s) && !A.wardrobePrice) add('gives a price for wardrobes or utility rooms');
    if (money && /\b(your|yours|this|that|specific|island|\d+\s?m\b)/i.test(s) && !/\b(typical|most|range|between|guide|generally|usually|around|start|starts|from|extra|stone|worktops?|deposit)\b/i.test(s)) add('gives a price for a specific kitchen');
    const visitFree = !!(K && K.facts && K.facts.stance.visit_free && K.facts.stance.visit_free.yes) && /\b(?:home visit|visit|consultation|design|it)\b/i.test(s);       // "no charge for the visit" when the knowledge says the visit is free
    if (/\b(complimentary|free of charge|no charge|at no cost|no cost)\b/i.test(s) && !(/\b(complimentary|free of charge|no charge|at no cost|no cost)\b/i.test(hay)) && !visitFree) add('says something is free that the knowledge does not');
    // "free X" names what is free ("a free quote"); "free with no obligation", "free and..." do not (audit run of 16 Oct 2026: "The home visit is free with no obligation" was wrongly blocked).
    for (const m of s.matchAll(/\bfree\s+([a-z]+)/gi)) if (!A.freeWords.has(m[1].toLowerCase()) && !FREE_LINK.has(m[1].toLowerCase()) && !neg) { add('says something is free that the knowledge does not'); break; }
  }
  return { ok: r.length === 0, reasons: r };
}

// ================= storage =================
const ref = (db, id) => db.doc('aiKnowledge/' + id);
const vid = (n) => 'v' + String(n).padStart(4, '0');
const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : null);

async function loadLive(db) {
  const s = await ref(db, 'live').get();
  if (!s.exists || !s.data().data) return null;
  try { const k = compile(clean(s.data().data), s.data().version); return k.entryCount ? k : null; } catch (e) { return null; }       // a damaged or empty document is the same as no knowledge: the old behaviour
}
async function loadDraftCompiled(db) {
  const s = await ref(db, 'draft').get();
  if (!s.exists || !s.data().data) return null;
  return compile(clean(s.data().data), 'draft');
}
const meta = (d) => (d ? { rev: d.rev || 0, updatedAt: ms(d.updatedAt), updatedBy: d.updatedBy || null, basedOn: d.basedOn || null } : null);

// Everything the screen needs. Staff may read; only the owner may change.
async function get({ db, owners }, actor) {
  const [draft, live, vs] = await Promise.all([ref(db, 'draft').get(), ref(db, 'live').get(), db.collection('aiKnowledgeVersions').orderBy('version', 'desc').limit(25).get()]);
  const d = draft.exists ? draft.data() : null, l = live.exists ? live.data() : null;
  return { canEdit: isOwner(owners, actor), limits: LIMITS, lineLabels: LINE_LABELS, defaultLines: DEFAULT_LINES,
    draft: d ? { ...meta(d), data: d.data } : null, live: l ? { version: l.version, publishedAt: ms(l.publishedAt), publishedBy: l.publishedBy || null, note: l.note || '', data: l.data } : null,
    versions: vs.docs.map((x) => { const v = x.data(); return { version: v.version, publishedAt: ms(v.publishedAt), publishedBy: v.publishedBy || null, note: v.note || '' }; }) };
}
const needOwner = (owners, actor) => { if (!isOwner(owners, actor)) throw new HttpsError('permission-denied', 'Only the owner account can change the knowledge.'); };
const audit = (db, actor, op, extra, nowMs) => db.collection('auditLog').add({ action: 'aiKnowledge', op, ...extra, by: actor.id, at: Timestamp.fromMillis(nowMs) });

async function saveDraft({ db, owners }, actor, data, { nowMs = Date.now() } = {}) {
  needOwner(owners, actor);
  if (!data || typeof data !== 'object') throw bad('Missing data.');
  for (const k of Object.keys(data)) if (!['data', 'expectedRev'].includes(k)) throw bad('Unknown field: ' + k);
  const clean_ = clean(data.data), r = ref(db, 'draft');
  await db.runTransaction(async (tx) => {
    const s = await tx.get(r), cur = s.exists ? s.data().rev || 0 : 0;
    if (data.expectedRev !== undefined && data.expectedRev !== cur) throw new HttpsError('failed-precondition', 'The draft was changed somewhere else. Reload it before saving.');
    tx.set(r, { data: clean_, rev: cur + 1, updatedAt: Timestamp.fromMillis(nowMs), updatedBy: actor.id, basedOn: s.exists ? s.data().basedOn || null : null });
  });
  await audit(db, actor, 'save_draft', { entries: compile(clean_).entryCount }, nowMs);
  return get({ db, owners }, actor);
}
// Put the starting knowledge (from the approved PDF) into the DRAFT. Never published by itself, and it never overwrites a draft that has anything in it unless asked.
async function importStarter({ db, owners }, actor, data, { nowMs = Date.now(), seed } = {}) {
  needOwner(owners, actor);
  for (const k of Object.keys(data || {})) if (!['replace'].includes(k)) throw bad('Unknown field: ' + k);
  const r = ref(db, 'draft'), s = await r.get();
  if (s.exists && (s.data().data.sections || []).length && !(data && data.replace === true)) throw new HttpsError('failed-precondition', 'There is already a draft. Choose "Replace my draft" to start again from the starting knowledge.');
  const d = clean(seed || require('./aiKnowledgeSeed').SEED);
  await r.set({ data: d, rev: (s.exists ? s.data().rev || 0 : 0) + 1, updatedAt: Timestamp.fromMillis(nowMs), updatedBy: actor.id, basedOn: 'starter' });
  await audit(db, actor, 'import_starter', { entries: compile(d).entryCount }, nowMs);
  return get({ db, owners }, actor);
}
async function resetDraft({ db, owners }, actor, data, { nowMs = Date.now() } = {}) {
  needOwner(owners, actor); for (const k of Object.keys(data || {})) throw bad('Unknown field: ' + k);
  const l = await ref(db, 'live').get(); if (!l.exists) throw new HttpsError('failed-precondition', 'Nothing is published yet.');
  const r = ref(db, 'draft'), s = await r.get();
  await r.set({ data: l.data().data, rev: (s.exists ? s.data().rev || 0 : 0) + 1, updatedAt: Timestamp.fromMillis(nowMs), updatedBy: actor.id, basedOn: l.data().version });
  await audit(db, actor, 'reset_draft', { version: l.data().version }, nowMs);
  return get({ db, owners }, actor);
}
async function publish({ db, owners }, actor, data, { nowMs = Date.now() } = {}) {
  needOwner(owners, actor);
  for (const k of Object.keys(data || {})) if (!['expectedRev', 'note'].includes(k)) throw bad('Unknown field: ' + k);
  const note = one(data && data.note, 120), dr = ref(db, 'draft'), lr = ref(db, 'live');
  const version = await db.runTransaction(async (tx) => {
    const [d, l] = await Promise.all([tx.get(dr), tx.get(lr)]);
    if (!d.exists) throw new HttpsError('failed-precondition', 'There is no draft to publish.');
    if (data && data.expectedRev !== undefined && data.expectedRev !== (d.data().rev || 0)) throw new HttpsError('failed-precondition', 'The draft changed since you looked at it. Reload it and check it again before publishing.');
    const cleaned = clean(d.data().data);
    if (!compile(cleaned).entryCount) throw new HttpsError('failed-precondition', 'The knowledge is empty.');
    const v = (l.exists ? l.data().version || 0 : 0) + 1, rec = { version: v, data: cleaned, publishedAt: Timestamp.fromMillis(nowMs), publishedBy: actor.id, note };
    tx.set(db.doc('aiKnowledgeVersions/' + vid(v)), rec); tx.set(lr, rec); tx.update(dr, { basedOn: v });
    return v;
  });
  await audit(db, actor, 'publish', { version, note }, nowMs);
  return get({ db, owners }, actor);
}
// Rolling back publishes an OLD version again as a NEW version (so the history is never rewritten).
async function rollback({ db, owners }, actor, data, { nowMs = Date.now() } = {}) {
  needOwner(owners, actor);
  for (const k of Object.keys(data || {})) if (k !== 'version') throw bad('Unknown field: ' + k);
  if (!Number.isInteger(data && data.version) || data.version < 1) throw bad('Choose a version.');
  const lr = ref(db, 'live'), vr = db.doc('aiKnowledgeVersions/' + vid(data.version));
  const version = await db.runTransaction(async (tx) => {
    const [l, o] = await Promise.all([tx.get(lr), tx.get(vr)]);
    if (!o.exists) throw new HttpsError('not-found', 'That version does not exist.');
    const v = (l.exists ? l.data().version || 0 : 0) + 1, rec = { version: v, data: o.data().data, publishedAt: Timestamp.fromMillis(nowMs), publishedBy: actor.id, note: 'Rolled back to version ' + data.version };
    tx.set(db.doc('aiKnowledgeVersions/' + vid(v)), rec); tx.set(lr, rec); return v;
  });
  await audit(db, actor, 'rollback', { to: data.version, version }, nowMs);
  return get({ db, owners }, actor);
}
// One entry point for the screen.
async function admin(deps, actor, data, opts) {
  const a = data && data.action; const rest = { ...(data || {}) }; delete rest.action;
  if (a === 'get') { for (const k of Object.keys(rest)) throw bad('Unknown field: ' + k); return get(deps, actor); }
  if (a === 'save') return saveDraft(deps, actor, rest, opts);
  if (a === 'import') return importStarter(deps, actor, rest, opts);
  if (a === 'reset') return resetDraft(deps, actor, rest, opts);
  if (a === 'publish') return publish(deps, actor, rest, opts);
  if (a === 'rollback') return rollback(deps, actor, rest, opts);
  throw bad('Unknown action.');
}

module.exports = { KINDS, LIMITS, DEFAULT_LINES, LINE_LABELS, emptyData, clean, compile, checkAnswer, contradictions, factsFrom, loadLive, loadDraftCompiled, get, admin, saveDraft, importStarter, resetDraft, publish, rollback, isOwner, numbersIn, durationsIn };
