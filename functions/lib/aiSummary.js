'use strict';
// Phase 9.1: the customer summary, built by the SERVER so Haiku and Sonnet always give the same answer in the same shape (docs/AI.md). Pure functions only (no database, no model):
// what the customer record says is turned into the fixed template below. Nothing is guessed: a fact that is not in the records is shown as "not recorded", and anything free-text
// (a budget typed by a customer, notes) is either cleaned by fixed rules or shown as recorded.
//
//   **Customer Name**
//   - Budget: €15,000–€20,000
//   - Location: Swords
//   - Eircode: K67 X123
//   - Latest quote: EK-0104 — Sent
//   - Next appointment: Tue 20 Oct 2026, 10:00
//   - Notes: only relevant information          (left out when there is nothing relevant)
//   ⚠ Possible test record: ...                   (only when the record looks like test data)
const TZ = 'Europe/Dublin';
const NOT_RECORDED = 'not recorded';
const one = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };

// ---- Eircode: format only (the same shape rule as lead-address.js), taken from the saved address first, then from the notes. Two different codes = a conflict = not recorded. ----
const CODE = '(?:[ACDEFHKNPRTVWXY][0-9]{2}|D6W)\\s?[0-9ACDEFHKNPRTVWXY]{4}';
function eircodeOf(...texts) {
  for (const text of texts) {
    if (typeof text !== 'string' || !text.trim()) continue;
    const found = [...new Set([...text.matchAll(new RegExp('\\b' + CODE + '\\b', 'gi'))].map((m) => m[0].replace(/\s/g, '').toUpperCase()))];
    if (found.length === 1) return found[0].slice(0, 3) + ' ' + found[0].slice(3);
    if (found.length > 1) return null;
  }
  return null;
}

// ---- Budget: customers type it freely ("15-20k", "€15,000 - €20,000", "under 10k"). Turn the clear cases into €XX,XXX–€XX,XXX; show everything else exactly as recorded. ----
const euro = (n) => '€' + Math.round(n).toLocaleString('en-IE');
function budgetOf(raw) {
  const s = one(raw, 60);
  if (!s) return { text: null, parsed: false };
  const flat = s.replace(/(\d)\s(\d{3})\b/g, '$1$2');
  const nums = [...flat.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|m)?\b/gi)].map((m) => ({ v: parseFloat(m[1].replace(/,/g, '')), suffix: (m[2] || '').toLowerCase() })).filter((x) => Number.isFinite(x.v));
  const k = nums.some((x) => x.suffix === 'k' || x.suffix === 'thousand');
  const values = nums.map((x) => (x.suffix === 'm' ? x.v * 1e6 : x.suffix ? x.v * 1e3 : k && x.v < 1000 ? x.v * 1e3 : x.v));
  if (values.length < 1 || values.length > 2 || values.some((v) => v < 500 || v > 1e7)) return { text: s + ' (as recorded)', parsed: false };
  const sorted = [...values].sort((x, y) => x - y), a = sorted[0], b = sorted[sorted.length - 1];
  let text = values.length === 2 && a !== b ? `${euro(a)}–${euro(b)}` : euro(b);
  if (values.length === 1) {
    if (/\b(under|below|less than|up to|max(?:imum)?|no more than)\b/i.test(s)) text = 'Up to ' + text;
    else if (/\b(over|above|more than|at least|min(?:imum)?)\b|\+\s*$/i.test(s)) text = 'Over ' + text;
    else if (/\b(around|about|approx\w*|circa|roughly)\b|~/i.test(s)) text = 'Around ' + text;
  }
  return { text, parsed: true };
}

// ---- Dates: Irish time, one fixed shape ----
function when(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-IE', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}`;
}
const dayOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ms));
const dayLabel = (ymd) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || ''); return m ? `${Number(m[3])} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1]} ${m[1]}` : ''; };

// ---- Quote status in plain words ("Sent" becomes "Sent (expired)" once its valid-until date has passed) ----
function quoteLabel(q, today) {
  const s = { draft: 'Draft', sent: 'Sent', accepted: 'Accepted', declined: 'Declined' }[q && q.status] || (q && q.status ? String(q.status) : 'Unknown');
  return q && q.status === 'sent' && typeof q.validUntil === 'string' && q.validUntil < today ? 'Sent (expired)' : s;
}

// ---- Suspected test records: deterministic signals, shown briefly, never a verdict ----
function testReasons({ name, email, phone, notes, quoteRefs = [] }) {
  const out = [];
  const w = /\b(test|testing|tester|demo|dummy|sample|fake|asdf|qwerty)\b/i.exec(String(name || ''));
  if (w) out.push(`name contains "${w[1].toLowerCase()}"`);
  const e = String(email || '').toLowerCase();
  if (e && (/@(?:[\w-]+\.)*(?:example\.(?:com|org|net)|test\.(?:com|dev|ie)|mailinator\.com|invalid)$/.test(e) || /^(?:test|demo|dummy|fake)[\w.+-]*@/.test(e))) out.push('test-style email address');
  const d = String(phone || '').replace(/\D/g, '');
  if (d && (/(\d)\1{4,}/.test(d) || /1234567|7654321/.test(d))) out.push('placeholder-looking phone number');
  const n = /\b(test|testing|dummy|fake)\b/i.exec(String(notes || ''));
  if (n) out.push(`notes mention "${n[1].toLowerCase()}"`);
  const t = quoteRefs.find((r) => /^TEST-/i.test(String(r || '')));
  if (t) out.push(`test-numbered quote ${String(t).toUpperCase()}`);
  return out.slice(0, 3);
}

// ---- Notes: only what is useful at a glance. Fixed rules, so every model shows the same thing. ----
const SKIP_LINE = /^(?:meta lead\b|lead id\b|other answers\b|old eircode\b|(?:full |home |customer )?(?:address|eircode(?: ?\/ ?postcode)?|postcode|post code)\b|(?:estimated )?budget\b|what is your (?:eircode|address|budget)\b)/i;
function notesOf({ notes, projectType, project }) {
  const items = [];
  if (projectType) items.push(one(projectType, 40));
  for (const raw of String(notes || '').split(/\r?\n/)) {
    const line = raw.replace(/^[\s•·*-]+/, '').trim();
    if (!line || SKIP_LINE.test(line) || /^\d+\s*$/.test(line)) continue;
    items.push(one(line, 160));
  }
  if (project) items.push(project);
  const text = [...new Set(items)].join(' · ');
  return text ? one(text, 260) : null;
}

// ---- the template ----
function formatSummary(f) {
  const lines = [`**${one(f.name, 80) || 'Unnamed customer'}**`];
  const rows = [
    ['Budget', f.budget || NOT_RECORDED], ['Location', one(f.location, 80) || NOT_RECORDED], ['Eircode', f.eircode || NOT_RECORDED],
    ['Latest quote', f.latestQuote ? `${f.latestQuote.ref} — ${f.latestQuote.label}` : 'none yet'], ['Next appointment', f.nextAppointment || 'none scheduled'],
  ];
  if (f.notes) rows.push(['Notes', f.notes]);
  for (const [k, v] of rows) lines.push(`- ${k}: ${v}`);
  const out = [lines.join('\n')];
  if (f.testReasons && f.testReasons.length) out.push(`⚠ Possible test record: ${f.testReasons.join('; ')}.`);
  return out.join('\n\n');
}

module.exports = { NOT_RECORDED, eircodeOf, budgetOf, when, dayOf, dayLabel, quoteLabel, testReasons, notesOf, formatSummary, euro, one };
