'use strict';
// The follow-up email to a lead who never replied (docs/FOLLOW_UP_EMAIL.md): plain words and ONE simple question, whether they would like a free home consultation. The same file runs on the server and in the
// browser (the dialog pre-fills it, so what you read is what is sent). functions/lib/followUpText.js is the original; public/followup-text.js must be an identical copy (a test checks).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FollowUpText = factory();
})(this, function () {
  const SUBJECT = 'Your kitchen enquiry with Elite Kitchens';
  const LIMIT = { subject: 120, body: 2000, bodyMin: 20 };
  const CONTACT = { phone: '089 464 1917', email: 'info@elitekitchens.ie', web: 'www.elitekitchens.ie' };

  // "there" unless the name gives a usable first name: letters only, at least two, never a link, an email address or a number.
  function firstNameOf(full) {
    const t = String(full == null ? '' : full).trim();
    if (!t || /@|https?:|www\.|\d/i.test(t)) return 'there';
    const raw = t.split(/\s+/)[0].replace(/[^\p{L}\p{M}'’.\-]/gu, '').replace(/^[.'’\-]+|[.'’\-]+$/g, '').slice(0, 30);
    if ((raw.match(/\p{L}/gu) || []).length < 2) return 'there';
    return raw.charAt(0).toLocaleUpperCase('en-IE') + raw.slice(1).toLocaleLowerCase('en-IE');
  }

  function bodyFor({ first, contact } = {}) {
    const c = { ...CONTACT, ...(contact || {}) };
    return [
      `Hi ${first || 'there'},`,
      '',
      'Thanks for your enquiry with Elite Kitchens. I just wanted to check in, in case my earlier message got lost.',
      '',
      'Would you like us to arrange a free home consultation to go through your ideas? If so, just reply to this email with a day and time that suit you, and we\'ll take it from there.',
      '',
      'Kind regards,',
      'Elite Kitchens',
      [c.phone, c.email, c.web].filter(Boolean).join(' | '),
    ].join('\n');
  }

  // The follow-up about a QUOTE that was never answered (7 Nov 2026): did they get it, any questions. Nothing about price, nothing promised about the work.
  const quoteSubject = (ref) => (ref ? `Your Elite Kitchens quote ${ref}` : 'Your Elite Kitchens quote');
  function quoteBodyFor({ first, ref, contact } = {}) {
    const c = { ...CONTACT, ...(contact || {}) };
    return [
      `Hi ${first || 'there'},`,
      '',
      `I just wanted to check that you received your quote${ref ? ' (' + ref + ')' : ''}, and to see if you have any questions about it.`,
      '',
      'If you would like to change anything or talk it through, just reply to this email and we\'ll be happy to help.',
      '',
      'Kind regards,',
      'Elite Kitchens',
      [c.phone, c.email, c.web].filter(Boolean).join(' | '),
    ].join('\n');
  }

  return { SUBJECT, LIMIT, CONTACT, firstNameOf, bodyFor, quoteSubject, quoteBodyFor };
});
