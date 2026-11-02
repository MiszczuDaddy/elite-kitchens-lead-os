'use strict';
// "Wants the kitchen as soon as possible" (the ⭐ in Elite OS), read ONLY from the lead's Notes: the fixed answer on the Meta lead form ("1-2 months asap"), which is saved in the Notes as a line of the
// lead's block ("Meta lead · <form> · <date>" ... "Other answers:" ... "• <question>: 1-2_months_asap"). NEVER from the chat, and never from free text a person typed in the Notes: only a bulleted answer line
// inside a "Meta lead" block counts. The flag (`asap` on the conversation) is recomputed whenever the Notes are written: when a lead arrives, when someone edits the Notes, and by scripts/mark-asap-leads.js.
const ASAP = /\basap\b|\bas soon as possible\b/i;
// Meta may send a multiple-choice answer as its option key ("1-2_months_asap"): underscores are spaces.
const answerSaysAsap = (value) => ASAP.test(String(value == null ? '' : value).replace(/_+/g, ' '));
function fromNotes(notes) {
  const text = String(notes == null ? '' : notes);
  if (!text.trim()) return false;
  for (const block of text.split(/\n[ \t]*\n/)) {
    const lines = block.split('\n');
    if (!/^\s*Meta lead\b/i.test(lines[0] || '')) continue;                                  // only the lead form's own block, not what a person wrote
    for (const line of lines.slice(1)) {
      const m = /^\s*[•*-]\s*[^:\n]{1,200}:\s*(.+)$/.exec(line);
      if (m && answerSaysAsap(m[1])) return true;
    }
  }
  return false;
}
module.exports = { fromNotes, answerSaysAsap };
