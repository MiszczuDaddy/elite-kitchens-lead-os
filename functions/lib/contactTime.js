'use strict';
// "Best time to contact" (the lead form's question "When is the best time to contact you?"), read ONLY from the lead's Notes, the same way as the asap star (functions/lib/asap.js): only a bulleted answer line
// inside a "Meta lead" block counts, never free text a person typed. It is kept on the conversation (`contactTime`, a short piece of text) so the Pipeline can show it on the New lead card without loading Notes.
// Set when a lead arrives (leadIntake), kept in step when the Notes are edited (updateContact), and by scripts/mark-contact-times.js for the leads that already exist.
const LABEL = /\bbest\s+time\b|\btime\s+to\s+(?:contact|call|reach|ring)\b|\bcontact\s+time\b|\bwhen\b[^:]{0,60}\bcontact(?:ed)?\b/i;
const MAX = 60;

// Meta sends a multiple-choice answer as its option key ("morning_(9am-12pm)"): underscores are spaces, the first letter is a capital.
function pretty(value) {
  const t = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX).trim();
  return t ? t.charAt(0).toLocaleUpperCase('en-IE') + t.slice(1) : '';
}

// The answer of the MOST RECENT lead form in the notes (a customer who fills the form again may pick a different time), or null.
function fromNotes(notes) {
  const text = String(notes == null ? '' : notes);
  if (!text.trim()) return null;
  let found = null;
  for (const block of text.split(/\n[ \t]*\n/)) {
    const lines = block.split('\n');
    if (!/^\s*Meta lead\b/i.test(lines[0] || '')) continue;                                  // only the lead form's own block, not what a person wrote
    for (const line of lines.slice(1)) {
      const m = /^\s*[•*-]\s*([^:\n]{1,200}):\s*(.+)$/.exec(line);
      if (m && LABEL.test(m[1])) { const v = pretty(m[2]); if (v) found = v; }
    }
  }
  return found;
}
module.exports = { fromNotes, pretty, MAX };
