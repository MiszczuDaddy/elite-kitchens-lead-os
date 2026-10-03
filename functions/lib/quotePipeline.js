// Phase 6: the ONLY place quotes affect a customer's pipeline stage or pipeline value (docs/QUOTES.md, "Pipeline rules").
// Pure planning functions: they decide, the caller writes the result inside the quote's own transaction. Stage moves go
// through planStatusChange (store.js), exactly like a manual move or a Phase 5 booking, so stage dates, the lastMove note and
// the 5-minute correction window behave identically. Nothing here ever moves a Closed customer unless staff ticked the box.
const { planStatusChange } = require('./store');

const stageOf = (conv) => (conv && conv.inboxStatus) || 'inbox';

function move(conv, to, nowMs) {
  const from = stageOf(conv);
  const plan = planStatusChange(conv, to, nowMs);
  if (!plan) return null;                                   // already there: nothing written, no date moved
  return { patch: plan.patch, change: { from, to, corrected: plan.result.corrected } };
}

// Sending any version: New lead or Booked -> Quoted. Quoted and Won: unchanged. Closed: only if staff ticked "Reopen".
function planSend(conv, { reopen = false } = {}, nowMs) {
  const cur = stageOf(conv);
  if (cur === 'inbox' || cur === 'booked' || (cur === 'closed' && reopen)) return move(conv, 'quoted', nowMs);
  return null;
}

// Accepting: New lead, Booked or Quoted -> Won. Won: unchanged. Closed: only if staff ticked "Move to Won".
function planAccept(conv, { moveClosed = false } = {}, nowMs) {
  const cur = stageOf(conv);
  if (cur === 'inbox' || cur === 'booked' || cur === 'quoted' || (cur === 'closed' && moveClosed)) return move(conv, 'won', nowMs);
  return null;
}

// Reopening an accepted quote: back to the stage the accept moved the customer from, only while they are still where the
// accept put them. Within 5 minutes this is a correction (planStatusChange), so the accidental Won leaves no trace.
function canMoveBack(conv, acceptedMove) {
  return !!(acceptedMove && stageOf(conv) === acceptedMove.to);
}
function planMoveBack(conv, acceptedMove, nowMs) {
  return canMoveBack(conv, acceptedMove) ? move(conv, acceptedMove.from, nowMs) : null;
}

// Pipeline value (contacts/{phone}.quoteValue): only ever the whole-euro amount staff confirmed in the dialog.
const currentValue = (contact) => (contact && typeof contact.quoteValue === 'number' ? contact.quoteValue : null);
function planValue(contact, value) {
  if (value == null) return null;                          // "leave it as it is"
  const from = currentValue(contact);
  if (from === value) return null;
  return { patch: { quoteValue: value }, change: { from, to: value } };
}
// Undo of a value set by an accept: only while nobody has changed it since.
function canRestoreValue(contact, valueChange) {
  return !!(valueChange && currentValue(contact) === valueChange.to);
}
function planRestoreValue(contact, valueChange) {
  if (!canRestoreValue(contact, valueChange)) return null;
  return { patch: { quoteValue: valueChange.from }, change: { from: valueChange.to, to: valueChange.from } };
}

module.exports = { stageOf, planSend, planAccept, canMoveBack, planMoveBack, currentValue, planValue, canRestoreValue, planRestoreValue };
