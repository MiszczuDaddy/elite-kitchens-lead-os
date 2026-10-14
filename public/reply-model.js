'use strict';
// Elite Kitchens Lead OS: the logic behind the reply-suggestion panel (Phase 9 R1, docs/AI.md). Pure functions only (no DOM, no Firebase), so they can be unit-tested in Node.
// The server decides everything shown here (what is known, what is missing, how ready the customer is, the warnings); this only chooses how to present it and whether a sent
// message was the draft as suggested or an edit of it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.ReplyModel = factory();
})(this, function () {
  const TONE = { ready: 'good', preference: 'good', almost: 'warn', not_yet: 'muted', handover: 'bad', booked: 'info' };
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  // The person pressed Send: was it the draft exactly (ignoring spacing), or an edit of it?
  const outcomeOf = (draft, finalText) => (norm(draft) && norm(draft) === norm(finalText) ? 'used_unchanged' : 'used_edited');
  const costText = (c) => (typeof c !== 'number' ? '' : c < 0.001 ? 'under €0.001' : '€' + c.toFixed(3));
  const MODEL_LABEL = { haiku: 'Haiku', sonnet: 'Sonnet' };
  // What the panel draws, from the server's answer.
  function viewOf(r) {
    if (!r || typeof r !== 'object') return null;
    const list = (a) => (Array.isArray(a) ? a : []);
    const state = r.readiness && r.readiness.state;
    return {
      draftId: r.draftId || null, draft: typeof r.draft === 'string' ? r.draft : '', model: r.model, modelLabel: MODEL_LABEL[r.model] || '', cost: costText(r.costEur), structured: r.structured !== false,
      readiness: { state: state || 'not_yet', label: (r.readiness && r.readiness.label) || '', tone: TONE[state] || 'muted' },
      known: list(r.known).map((k) => ({ label: String(k.label || ''), value: String(k.value || '') })), fromChat: list(r.fromChat).map((k) => ({ label: String(k.label || ''), value: String(k.value || '') })),
      missing: list(r.missing).map((m) => String(m.label || '')), warnings: list(r.warnings).map(String),
      step: (r.schedule && r.schedule.step) || 'none', preference: r.schedule && r.schedule.preference ? { text: String(r.schedule.preference.text || ''), customerWords: String(r.schedule.preference.customerWords || '') } : null,
      handover: !!(r.handover && r.handover.needed), handoverReason: (r.handover && r.handover.reason) || '', otherModel: r.model === 'haiku' ? 'sonnet' : 'haiku', otherLabel: r.model === 'haiku' ? 'Sonnet' : 'Haiku',
    };
  }
  return { TONE, norm, outcomeOf, costText, viewOf };
});
