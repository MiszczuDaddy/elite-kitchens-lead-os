'use strict';
// A business WhatsApp account can answer our welcome message BY ITSELF ("Thank you for contacting Sonata Petrule! Please let us know how we can help you… Delivery on Saturdays…"). That is not a person
// writing, and the receptionist must not answer it as if it were (live review of 1 Nov 2026). Deliberately narrow: a real "thanks for getting in touch" from a customer must never match.
//   an explicit away / automatic message ("this is an automatic reply", "our business hours are…", "we are currently away")        -> automatic
//   "thank you for contacting / messaging …" TOGETHER WITH a second sign (it offers help, promises to reply, has a link, or is long)  -> automatic
const EXPLICIT = /\b(?:out of (?:the )?office message|auto(?:matic(?:ally)?)?[- ]?(?:reply|response|message|generated)|away message|this is an auto|our (?:business|opening|working|office) hours|we(?: are|'re) (?:currently |now )?(?:away|unavailable|closed|out of (?:the )?office))\b/i;       // "we" / "our": a business speaking, never a customer ("I work office hours", "I'm currently away")
const THANKS_FOR_CONTACTING = /\bthank(?:s| you) for (?:contacting|messaging)\b/i;
const SECOND = [/\blet us know how (?:we|i) can help\b/i, /\b(?:we|i)(?:'ll| will| shall) (?:get|be|come) back\b|\breply (?:as soon as|shortly|soon)\b|\brespond (?:as soon as|shortly|soon)\b/i, /https?:\/\/\S+/i];
const looksAutomatic = (text) => {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return false;
  return EXPLICIT.test(t) || (THANKS_FOR_CONTACTING.test(t) && (SECOND.some((re) => re.test(t)) || t.length > 160));
};
module.exports = { looksAutomatic };
