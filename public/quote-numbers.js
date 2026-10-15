'use strict';
// Elite Kitchens Lead OS: number fields in the quote screens behave naturally. A field that shows 0 and gets "85" typed into it used to read 085. Now a field is selected when it is entered (so typing
// replaces what is there), and any leading zeros are removed as you type ("085" becomes "85", "0.5" and "0" are left alone). Only what is SHOWN changes: the quote's calculations read the number, which is
// the same, and nothing saved is touched. Applies to every <input type="number"> inside the Quotes screens (the builder and Quote Settings). The pure function is also used by the tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.QuoteNumbers = api;
  if (typeof document !== 'undefined') api.attach(document);
})(typeof self !== 'undefined' ? self : this, function () {
  // "085" -> "85", "007.5" -> "7.5", "00" -> "0"; "0", "0.5", "10", "" and anything not starting 0 + digit are returned as they are.
  const tidy = (s) => { const v = String(s == null ? '' : s); return /^0\d/.test(v) ? v.replace(/^0+(?=\d)/, '') : v; };
  const mine = (t) => !!t && typeof t.matches === 'function' && t.matches('input[type="number"]') && !!t.closest('#quotes');
  function attach(doc) {
    doc.addEventListener('focusin', (e) => { const t = e.target; if (!mine(t)) return; t.__selectOnFocus = true; const sel = () => { try { t.select(); } catch (x) { /* not selectable here */ } }; sel(); setTimeout(() => { if (doc.activeElement === t) sel(); }, 0); }, true);
    doc.addEventListener('mouseup', (e) => { const t = e.target; if (mine(t) && t.__selectOnFocus) { e.preventDefault(); t.__selectOnFocus = false; } }, true);       // the click that focused it must not undo the selection
    doc.addEventListener('input', (e) => { const t = e.target; if (!mine(t)) return; const v = t.value, n = tidy(v); if (n !== v) t.value = n; }, true);                    // before the builder reads it
  }
  return { tidy, attach };
});
