'use strict';
// Elite Kitchens Lead OS: the logic behind the Send dialog (Phase 6.1 M5, docs/PHASE6_1_PLAN.md). Pure functions only (no DOM, no
// Firebase), so they can be unit-tested in Node: which channels can be used and why not, the default wording, and how each
// channel's delivery is described. The screens (quotes.js) only draw what this returns.
//
// Rules the words must never break: a channel's state is shown on its own (never merged into one generic status); "not confirmed"
// is never shown as sent or as failed; and a Reopen template is never described as reopening the conversation: the customer has to
// reply first.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./window-state.js')); else root.QuoteSend = factory(root.WindowState);
})(this, function (WS) {
  const TZ = 'Europe/Dublin';
  const EMAIL_RE = /^[^\s@<>",;()[\]\\]+@[^\s@<>",;()[\]\\]+\.[^\s@<>",;()[\]\\]+$/;
  const CHANNEL_NAME = { whatsapp: 'WhatsApp', email: 'Email', manual: 'Marked sent by hand' };
  const CHANNEL_ORDER = ['whatsapp', 'email'];
  const hhmm = (ms) => new Intl.DateTimeFormat('en-IE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
  const dayTime = (ms) => new Intl.DateTimeFormat('en-IE', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms)).replace(',', '');
  const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : typeof t === 'number' ? t : null);

  // ---------------------------------------------------------------- which channels can be used ----------------------------------
  // conv: the customer's conversation (or null). reopenMsg: the stored message of conv.reopen.wamid, if any (its delivery status).
  // template (Phase 6.1 M7): does the server have the approved quotation template? true: a closed window is no obstacle (the quote goes out
  // in the template, PDF attached: no Reopen needed); false or left out: a closed window cannot take a quote (the M3 rules); null: not known yet.
  // route: how the server will send it if nothing changes: 'document' (the staff's own words) or 'template' (fixed words). The server
  // decides again at the moment of sending.
  function whatsappState(conv, nowMs, reopenMsg, template) {
    if (!conv) return { state: 'none', usable: false, text: 'No WhatsApp conversation with this customer yet.' };
    const w = WS.windowStatus(conv, nowMs, reopenMsg || null);
    if (w.state === 'open') return { state: 'open', usable: true, route: 'document', text: `Available: the customer messaged recently (open until ${hhmm(w.openUntil)}).` };
    if (template === null) return { state: 'checking', usable: false, text: 'Checking…' };
    if (template) return { state: 'template', usable: true, route: 'template', text: '24-hour window closed: WhatsApp only allows an approved template now, so the quote is sent with the approved quotation template, PDF attached. The customer can reply to it.' };
    const name = conv.name ? conv.name : 'the customer';
    if (w.state === 'awaiting') {
      return { state: 'awaiting', usable: false, canReopen: false,
        text: `Template sent at ${hhmm(w.reopen.at)}. Waiting for ${name} to reply: WhatsApp does not allow this message until they do.` };
    }
    const base = ms(conv.lastInboundAt) ? '24-hour window closed: WhatsApp only allows an approved template until the customer replies.' : `${name} has not messaged yet: WhatsApp only allows an approved template until they reply.`;
    return w.canReopen ? { state: 'closed', usable: false, canReopen: true, text: base }
      : { state: 'closed', usable: false, canReopen: false, text: `${base} A Reopen template was already tried: you can try again after ${dayTime(w.nextReopenAt)}.` };
  }
  // contact: contacts/{phone}. mail: { enabled } from the server, or null while it is still loading.
  function emailState(contact, mail) {
    if (!mail) return { state: 'checking', usable: false, text: 'Checking…' };
    if (!mail.enabled) return { state: 'off', usable: false, text: 'Email sending is not switched on yet.' };
    const e = contact && contact.email;
    if (!e) return { state: 'no_email', usable: false, text: "No email address: add one in the customer's Details first." };
    if (!EMAIL_RE.test(e)) return { state: 'bad_email', usable: false, text: 'The email address does not look right: correct it in the customer\'s Details.' };
    return { state: 'ready', usable: true, text: `Available: ${e}` };
  }
  const channelStates = ({ conv, contact, mail, nowMs, reopenMsg, template }) => ({ whatsapp: whatsappState(conv, nowMs, reopenMsg, template), email: emailState(contact, mail) });
  // One channel by default: WhatsApp when it can be used, else email, else none. Both only if staff tick both.
  const defaultChannels = (states) => (states.whatsapp.usable ? ['whatsapp'] : states.email.usable ? ['email'] : []);

  // ---------------------------------------------------------------- default wording (editable before sending) ------------------
  const refLabel = (ref, n) => (n > 1 ? `${ref} v${n}` : ref);
  // The approved default: "Hi {first name}, please find attached your quotation {EK-0104} from Elite Kitchens. Any questions, just reply here."
  const whatsappText = ({ name, ref, version, trading }) => `Hi ${WS.firstName(name)}, please find attached your quotation ${refLabel(ref, version)} from ${trading || 'Elite Kitchens'}. Any questions, just reply here.`;
  // The words of the approved quotation template (fixed: WhatsApp does not let staff change them), for the closed-window route.
  const templateText = ({ name, ref, version }) => WS.quoteTemplateText(WS.firstName(name), WS.quoteLabel(ref, version));
  // Phase 6's email wording, unchanged. wording: QuoteDocument.wording(project): { quote, subject }.
  const emailSubject = ({ trading, wording, ref, version }) => `${trading} — ${wording.subject} ${ref} v${version}`;
  function emailText({ name, ref, version, trading, wording, options, validityDays, business }) {
    const b = business || {}, first = (name || '').trim().split(/\s+/)[0] || 'there';
    return [`Hi ${first},`, '', `Thank you for getting in touch with ${trading}. Please find attached your ${wording.quote} ${ref} v${version}.`, '',
      `I've put together ${options > 1 ? options + ' options' : 'a proposal'} based on our conversation — all details are outlined in the attached PDF.`, '',
      `The quote is valid for ${validityDays} days. If you have any questions or would like to make any changes, please don't hesitate to get in touch.`, '',
      'Looking forward to hearing from you.', '', 'Kind regards,', b.signatureName || '', trading, [b.phone, b.email].filter(Boolean).join(' | ')].join('\n');
  }

  // ---------------------------------------------------------------- how a delivery is described ---------------------------------
  // d: a delivery record (state, channel, error, sentAt, attempts). The state "sending" for more than 3 minutes is "unknown", as on
  // the server (quoteDelivery.js effectiveState). The result has everything the screen needs and nothing it has to work out:
  //   mark: the symbol; tone: ok / bad / warn / info; title: "WhatsApp: sent 14:32"; detail: the plain reason or advice; actions.
  const STUCK_MS = 3 * 60 * 1000;
  const QUEUED_MS = 45 * 1000;                           // a channel still "waiting" after this long is offered "Send now"
  const effective = (d, nowMs) => (d.state === 'sending' && ms(d.claimedAt) != null && nowMs - ms(d.claimedAt) > STUCK_MS ? 'unknown' : d.state);
  function describe(d, nowMs) {
    const name = CHANNEL_NAME[d.channel] || d.channel, st = effective(d, nowMs), at = ms(d.sentAt), err = d.error && d.error.text;
    if (st === 'sent') return { state: st, mark: '✓', tone: 'ok', title: d.channel === 'manual' ? 'Marked sent by hand' : `${name}: sent${at ? ' ' + dayTime(at) : ''}`,
      detail: [d.route === 'template' ? 'Sent with the approved quotation template, PDF attached (WhatsApp does not allow your own wording after 24 hours).' : '', d.resolvedBy && d.channel !== 'manual' ? 'Confirmed by staff.' : ''].filter(Boolean).join(' '), actions: [] };
    if (st === 'failed') return { state: st, mark: '✕', tone: 'bad', title: `${name}: failed`, detail: err || 'It was not sent.', actions: ['retry'] };
    if (st === 'unknown') return { state: st, mark: '?', tone: 'warn', title: `${name}: delivery not confirmed`,
      detail: (err || 'We could not tell whether it was delivered.') + ' It will not be sent again by itself.', actions: ['arrived', 'not_arrived'] };
    if (st === 'sending') return { state: st, mark: '…', tone: 'info', title: `${name}: sending…`, detail: '', actions: [] };
    // A channel that is still waiting a while after the send began was left behind (the call that was sending it stopped): it can be sent now.
    // The server claims it first, so this can never send it twice (audit finding 11).
    if (st === 'queued') {
      const born = ms(d.createdAt), left = born != null && nowMs - born > QUEUED_MS;
      return { state: st, mark: '…', tone: 'info', title: `${name}: waiting to send`, detail: left ? 'This channel was not started. You can send it now.' : '', actions: left ? ['resume'] : [] };
    }
    if (st === 'cancelled') return { state: st, mark: '–', tone: 'info', title: `${name}: cancelled`, detail: '', actions: [] };
    return { state: st, mark: '·', tone: 'info', title: name, detail: '', actions: [] };
  }
  const rank = (c) => { const i = CHANNEL_ORDER.indexOf(c); return i < 0 ? CHANNEL_ORDER.length : i; };       // WhatsApp, email, then anything else (by hand)
  const byChannel = (a, b) => rank(a.channel) - rank(b.channel);

  // What the dialog says after sending, from the per-channel results (never one merged status).
  function summarize(deliveries, nowMs) {
    const states = deliveries.map((d) => effective(d, nowMs));
    const sent = states.includes('sent');
    if (sent) return { sent: true, text: 'The quote is marked sent: at least one channel accepted it for delivery.' };
    if (states.includes('unknown')) return { sent: false, text: 'Not marked sent yet: we could not tell whether it went through. Check, then choose "It arrived" or "It did not arrive".' };
    if (states.includes('sending') || states.includes('queued')) return { sent: false, text: 'Sending…' };
    return { sent: false, text: 'Not sent: nothing reached the customer, and the quote is not marked sent. Retry, or send it yourself.' };
  }

  return { CHANNEL_NAME, whatsappState, emailState, channelStates, defaultChannels, refLabel, whatsappText, templateText, emailSubject, emailText, describe, effective, summarize, byChannel, hhmm, dayTime, STUCK_MS };
});
