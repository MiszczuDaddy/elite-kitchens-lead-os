'use strict';
// What a lead answered on the Meta lead form, read ONLY from the customer's Notes: the bulleted lines "• <question>: <answer>" inside a "Meta lead" block (never the chat, never free text a person typed;
// the same rule as functions/lib/asap.js and contactTime.js). A customer who filled the form more than once has their NEWEST answer to each question. Used by the assistant's find_leads tool, so a
// question such as "how many of the leads that never replied want to start in 3-6 months?" is counted by code, not worked out by the model.
const norm = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/_+/g, ' ').replace(/[^a-z0-9€+\-./ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const pretty = (v) => { const t = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim(); return t ? t.charAt(0).toLocaleUpperCase('en-IE') + t.slice(1) : ''; };

// [{ question, answer }] in the order first asked; the newest answer to a question replaces an older one.
function fromNotes(notes) {
  const text = String(notes == null ? '' : notes), out = new Map();
  if (!text.trim()) return [];
  for (const block of text.split(/\n[ \t]*\n/)) {
    const lines = block.split('\n');
    if (!/^\s*Meta lead\b/i.test(lines[0] || '')) continue;
    for (const line of lines.slice(1)) {
      const m = /^\s*[•*-]\s*([^:\n]{1,200}):\s*(.+)$/.exec(line);
      if (!m) continue;
      const question = m[1].trim().slice(0, 120), answer = pretty(m[2]), key = norm(question);
      if (key && answer) out.set(key, { question, answer });
    }
  }
  return [...out.values()];
}
// "3-6 months" matches the answer "3-6_months": case, underscores and spare punctuation do not matter.
const matches = (answer, wanted) => { const w = norm(wanted); return !!w && norm(answer).includes(w); };
module.exports = { fromNotes, matches, norm, pretty };
