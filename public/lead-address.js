'use strict';
// Pure, conservative extraction: labelled customer answers, never an address lookup or an AI guess.
// Keep public/lead-address.js identical; the focused test checks browser/server parity.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.LeadAddress = factory();
})(this, function () {
  // Format only, not proof that an Eircode exists. D6W is the routing-key exception.
  const CODE = '(?:[ACDEFHKNPRTVWXY][0-9]{2}|D6W)\\s?[0-9ACDEFHKNPRTVWXY]{4}';
  const codesIn = text => [...text.matchAll(new RegExp('\\b' + CODE + '\\b', 'gi'))].map(m => m[0].replace(/\s/g, '').toUpperCase());
  const formatCode = code => code.slice(0, 3) + ' ' + code.slice(3);
  const key = text => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const same = text => text.toLowerCase().replace(/[\s,]+/g, ' ').trim();
  function fieldKind(label) {
    const k = key(label).replace(/^(?:what is |what s |please enter |please provide |enter |provide )/, '').replace(/^(?:your |the )/, '');
    if (/^(?:eircode|eir code|postcode|post code|postal code|zip code|zip|eircode postcode)$/.test(k)) return 'code';
    if (/^(?:(?:full|home|customer|postal|street) )?address$/.test(k) || /^(?:address (?:and )?eircode|eircode (?:and )?address)$/.test(k)) return 'address';
    return null;
  }
  function fromNotes(notes) {
    if (typeof notes !== 'string' || !notes.trim()) return { value: null, conflict: false };
    // Do not extract from a truncated input: a conflicting answer may be outside the limit.
    if (notes.length > 10000) return { value: null, conflict: true };
    const candidates = []; let block = [], doubtful = false;
    const finish = () => {
      const addresses = [...new Set(block.filter(a => a.kind === 'address').map(a => a.value))];
      const codes = [...new Set(block.flatMap(a => codesIn(a.value)))];
      if (new Set(addresses.map(same)).size > 1 || codes.length > 1) doubtful = true;
      if (addresses.length) {
        const address = addresses[0], code = codes[0];
        candidates.push(code && !codesIn(address).length ? address + ', ' + formatCode(code) : address);
      } else if (codes.length) candidates.push(formatCode(codes[0]));
      block = [];
    };
    for (const raw of notes.split(/\r?\n/)) {
      const line = raw.trim().replace(/^[•*\-]\s*/, '');
      if (!line || /^Meta lead\s*·/.test(line)) { finish(); continue; }
      const match = /^([^:]{1,100}):\s*(.*)$/.exec(line);
      if (!match) continue;
      const kind = fieldKind(match[1]);
      if (!kind) {
        if (/\b(?:old|previous|wrong|incorrect|new|updated|work|billing|delivery)\b.*\b(?:address|eircode|postcode)\b/i.test(match[1])) doubtful = true;
        continue;
      }
      const value = match[2].replace(/\s+/g, ' ').trim();
      if (!value || /^(?:n\/?a|none|unknown|not provided|not sure|tbc)$/i.test(value)) continue;
      const codes = codesIn(value);
      if (value.length > 300 || /[<>@]|https?:|\b(?:old|previous|wrong|incorrect|ignore|instead|moved|not|maybe|unsure)\b/i.test(value)) { doubtful = true; continue; }
      if (kind === 'code' && !new RegExp('^' + CODE + '$', 'i').test(value)) { doubtful = true; continue; }
      // An explicit address must at least resemble an address, not "call me" or a reference number.
      if (kind === 'address' && !codes.length && !/\d.+\p{L}|\p{L}.+,.*\p{L}/u.test(value)) { doubtful = true; continue; }
      block.push({ kind: kind === 'code' || new RegExp('^' + CODE + '$', 'i').test(value) ? 'code' : 'address', value });
    }
    finish();
    // A second code anywhere in the notes can denote a different property: do not pick one.
    if (new Set(codesIn(notes)).size > 1) doubtful = true;
    const unique = [...new Map(candidates.map(value => [same(value), value])).values()];
    // Repeated submissions may contain just the same code, then the full address with that code.
    const full = unique.filter(value => !new RegExp('^' + CODE + '$', 'i').test(value));
    const value = full.length === 1 && unique.every(v => v === full[0] || codesIn(full[0]).includes(codesIn(v)[0])) ? full[0] : unique.length === 1 ? unique[0] : null;
    if (doubtful || (unique.length && !value) || (value && value.length > 300)) return { value: null, conflict: true };
    return { value, conflict: false };
  }
  function resolve(contact) {
    if (typeof contact?.address === 'string' && contact.address.trim()) return { value: contact.address, source: 'saved', conflict: false };
    const result = fromNotes(contact?.notes);
    return { ...result, source: result.value ? 'notes' : null };
  }
  return { fieldKind, fromNotes, resolve };
});
