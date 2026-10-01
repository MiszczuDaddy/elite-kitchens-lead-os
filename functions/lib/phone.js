// Strict phone normalisation for inbound leads. Returns the digits-only international form used everywhere in Elite OS
// (e.g. "353891234567"), or null if the number is not clearly valid. It NEVER guesses: sending a template to a wrong number
// messages the wrong person, so ambiguous input is rejected and reported instead.
const { parsePhoneNumberFromString } = require('libphonenumber-js');

const DEFAULT_COUNTRY = 'IE';

function normalizeLeadPhone(input) {
  if (input == null) return null;
  let s = String(input).trim();
  s = s.replace(/^p:\s*/i, '');                         // Meta lead forms prefix phone answers with "p:"
  s = s.replace(/[\u200e\u200f\u202a-\u202e]/g, '');     // invisible direction marks from copy/paste
  s = s.replace(/\(0\)/g, '');                          // "+353 (0) 89 123 4567"
  s = s.replace(/[^\d+]/g, '');                         // spaces, dashes, dots, brackets
  if (!s || (s.match(/\+/g) || []).length > 1 || (s.includes('+') && !s.startsWith('+'))) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;

  const tries = [];
  if (s.startsWith('+')) {
    tries.push(s);
    // Common slip: country code followed by the national trunk 0 (+353 0 89...). Only for +353, where we know the rule.
    if (/^\+3530\d{8,9}$/.test(s)) tries.push('+353' + s.slice(5));
  } else if (s.startsWith('00')) {
    tries.push('+' + s.slice(2));
    if (/^003530\d{8,9}$/.test(s)) tries.push('+353' + s.slice(6));
  } else {
    const ie = parsePhoneNumberFromString(s, DEFAULT_COUNTRY);     // 0891234567 / 891234567 as an Irish national number
    if (ie && ie.isValid() && ie.country === DEFAULT_COUNTRY) return ie.number.slice(1);
    if (digits.length >= 11) tries.push('+' + digits);              // 353891234567 / 447700900123 written without the plus
    if (/^3530\d{8,9}$/.test(digits)) tries.push('+353' + digits.slice(4));
  }
  for (const t of tries) {
    const p = parsePhoneNumberFromString(t);
    if (p && p.isValid()) return p.number.slice(1);                 // E.164 without the plus
  }
  return null;
}

module.exports = { normalizeLeadPhone };
