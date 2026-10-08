// Phase 6.1: the channels a quote can be delivered through (docs/PHASE6_1_PLAN.md). Each is an adapter for the delivery module
// (quoteDelivery.js): { id, maxMessage, check(ctx), send(ctx) }. check may refuse before anything is sent; send hands the exact
// stored PDF to the provider and returns { providerId }, or throws ChannelError: definite = nothing was sent (a failure, safe to
// retry), not definite = we cannot tell (recorded "not confirmed", never retried by itself).
//
// WhatsApp (M3) is built on the EXISTING WhatsApp client (whatsapp.js) and conversation records: no second WhatsApp system. The
// server re-checks the 24-hour window at send time (never trusting the browser's idea of it), uploads the stored PDF as it is, and
// sends ONE document message with the text as its caption. Delivery ticks come through the existing webhook. (M7) When the window is
// closed it sends the same stored PDF inside the approved quotation template instead, so a quote never waits for a Reopen reply.
const store = require('./store');
const WS = require('./windowState');
const { ChannelError, NOT_CONFIRMED } = require('./quoteDelivery');
const { FRIENDLY } = require('./reopen');

const SEND_TIMEOUT_MS = 20000;
const log = (level, msg, extra) => console[level === 'error' ? 'error' : 'log'](JSON.stringify({ level, msg, ...extra }));

const WINDOW_CLOSED = 'The 24-hour WhatsApp window is closed. Reopen the conversation first: WhatsApp only allows an approved template until the customer replies.';
const AWAITING = 'A Reopen template was sent but the customer has not replied yet, so WhatsApp does not allow this message. Try again after they reply.';

// A refusal from Meta, in plain words. 131047 is "more than 24 hours since the customer last replied": the window closed after
// our own check (or the customer's clock and ours differ by a moment). `what` is what we were sending.
function refusalText(e, what = 'document') {
  const code = e && e.code;
  if (code === 131047) return WINDOW_CLOSED;
  if (code && FRIENDLY[code]) return `${FRIENDLY[code]} (code ${code})`;
  return code ? `WhatsApp refused the ${what} (code ${code}).` : `WhatsApp is not set up to send ${what === 'document' ? 'documents' : 'this template'}.`;
}
function metaError(e, what) {
  if (e && e.definite === true) return new ChannelError(refusalText(e, what), { code: String((e && e.code) || 'refused'), definite: true });
  return new ChannelError(NOT_CONFIRMED, { code: 'not_confirmed', definite: false });          // 5xx, no message id, network failure, timeout
}

// Which way a quote may go to WhatsApp RIGHT NOW (Phase 6.1 M7). The server decides at send time and never trusts the browser:
//   window open    -> 'document': one document message, the staff's own text as its caption (M3)
//   window closed  -> 'template': the approved quotation template with the exact stored PDF as its Document header, so a quote never
//                     has to wait for a Reopen reply. Only when a template is configured: without one a closed window is refused (M3).
// A Reopen template waiting for a reply changes nothing here: the window is still closed.
//
// cfg: { db, bucket, wa, quoteTemplate: { name, lang } | null } and, for tests, now() and timeoutMs.
function whatsappChannel({ db, bucket, wa, quoteTemplate = null, now = Date.now, timeoutMs = SEND_TIMEOUT_MS }) {
  const hasTemplate = !!(quoteTemplate && quoteTemplate.name && quoteTemplate.lang);
  return {
    id: 'whatsapp',
    maxMessage: 1024,                                                       // WhatsApp's limit for a document caption

    async check(ctx) {
      const conv = await store.getConversation(db, ctx.phone);
      if (!conv) return { ok: false, code: 'no_conversation', text: 'This customer has no WhatsApp conversation yet. Start one first.' };
      const w = conv.reopen && conv.reopen.wamid ? (await db.collection('conversations').doc(ctx.phone).collection('messages').doc(conv.reopen.wamid).get()) : null;
      const st = WS.windowStatus(conv, now(), w && w.exists ? w.data() : null);
      if (st.state === 'open') return { ok: true, route: 'document' };
      if (hasTemplate) return { ok: true, route: 'template' };
      return st.state === 'awaiting' ? { ok: false, code: 'awaiting_reply', text: AWAITING } : { ok: false, code: 'window_closed', text: WINDOW_CLOSED };
    },

    // check: what check() just returned (the route). Returns { providerId, route, message }: what was really sent, which can differ
    // from what staff typed (a template has fixed words).
    async send(ctx, check) {
      const first = WS.firstName(ctx.customerName), label = WS.quoteLabel(ctx.quoteRef, ctx.version);
      // 1. hand WhatsApp the exact stored PDF. Nothing reaches the customer at this step, so any failure here is definite.
      let mediaId;
      try { mediaId = await wa.uploadMedia(ctx.pdf.bytes, 'application/pdf', ctx.filename, { timeoutMs }); }
      catch (e) {
        log('warn', 'quote pdf upload to WhatsApp failed', { code: (e && e.code) || null });
        throw new ChannelError(`WhatsApp could not take the PDF${e && e.code ? ` (code ${e.code})` : ''}. Nothing was sent.`, { code: 'upload_failed', definite: true });
      }
      // The customer may have been erased while the PDF was uploading: then nothing is sent (audit finding 4).
      if (!(await db.collection('conversations').doc(ctx.phone).get()).exists) throw new ChannelError('This customer was erased, so nothing was sent.', { code: 'customer_erased', definite: true });
      // 2. the message itself
      const asTemplate = () => wa.sendTemplateWithDocument(ctx.phone, { name: quoteTemplate.name, lang: quoteTemplate.lang, mediaId, filename: ctx.filename, params: [first, label] }, { timeoutMs });
      let wamid, route = (check && check.route) || 'document', text = ctx.message;
      try {
        if (route === 'template' && hasTemplate) wamid = await asTemplate();
        else {
          route = 'document';
          try { wamid = await wa.sendMedia(ctx.phone, 'document', mediaId, { caption: ctx.message, filename: ctx.filename }, { timeoutMs }); }
          catch (e) {
            // 131047: Meta refused the free-form document because the window closed after our check. A refusal means nothing was
            // sent, so the approved template is the right way now (the same exact PDF, already uploaded): no resend, no second message.
            if (hasTemplate && e && e.definite === true && e.code === 131047) { route = 'template'; wamid = await asTemplate(); }
            else throw e;
          }
        }
      } catch (e) { throw metaError(e, route === 'template' ? 'quotation template' : 'document'); }
      if (route === 'template') text = WS.quoteTemplateText(first, label);
      // 3. show it in the chat. Meta has accepted the message, so a problem here must never turn the success into a failure.
      try { await recordInChat({ db, bucket }, ctx, wamid, mediaId, text, route); }
      catch (e) { log('error', 'quote document chat record failed', { wamid, kind: String((e && e.name) || 'Error') }); }
      return { providerId: wamid, route, message: text };
    },
  };
}

// The outgoing document in the existing conversation, labelled with the quote. The chat keeps its own copy of the PDF under
// media/ so the existing media viewing, retention and erasure code is used unchanged; the quote keeps the original. `text` is
// what the customer was actually sent (the caption, or the template's words).
// If the customer was erased while the message was in flight, NOTHING is written and nothing is left behind (audit finding 4): the erase
// cannot see work that finishes after it, so this checks before it writes, writes only if the conversation still exists, and checks again
// afterwards, removing its own file and message if the customer has gone in the meantime.
async function recordInChat({ db, bucket }, ctx, wamid, mediaId, text, route) {
  const convRef = db.collection('conversations').doc(ctx.phone);
  if (!(await convRef.get()).exists) return;
  const finalPath = `media/${ctx.phone}/${wamid}/${ctx.filename}`;
  let media = { mimeType: 'application/pdf', filename: ctx.filename, size: ctx.pdf.size, caption: text || null, storagePath: finalPath, status: 'stored', waMediaId: mediaId, sha256: ctx.pdf.sha256 };
  let copied = false;
  try { await bucket.file(ctx.pdf.path).copy(bucket.file(finalPath)); copied = true; }
  catch (e) {
    log('error', 'quote document chat copy failed', { wamid });
    media = { ...media, storagePath: null, status: 'failed', error: 'The copy for this chat could not be made. The PDF is still on the quote.' };
  }
  const dropFile = () => (copied ? bucket.file(finalPath).delete({ ignoreNotFound: true }).catch(() => {}) : null);
  const wrote = await store.storeOutbound(db, ctx.phone, { wamid, type: 'document', body: text || '[document]', media, onlyIfConversation: true,
    extra: { quote: { id: ctx.quoteId, ref: ctx.quoteRef, version: ctx.version, deliveryId: ctx.deliveryId, ...(route === 'template' ? { template: true } : {}) } } });
  if (!wrote) { await dropFile(); return; }
  if (!(await convRef.get()).exists) {                                     // erased between our write and now: take our message and file with it
    await convRef.collection('messages').doc(wamid).delete().catch(() => {}); await dropFile();
  }
}

// ================================================ Email (M4): the Gmail API, as info@elitekitchens.ie ============================
// The customer's saved address (frozen on the quote when it was prepared), the editable text as the body, and the EXACT stored PDF
// attached. Replies come back to the business mailbox, and the message sits in its Sent folder. The sign-in is keyless (gmail.js).
const { EMAIL_RE, GmailError, buildMessage, toRaw } = require('./gmail');

const GMAIL_TEXT = {
  not_configured: 'Email sending is not set up yet.',
  token_runtime: 'Elite OS could not get permission to ask Google to sign in.',
  token_sign: 'Google would not let Elite OS sign in to send as the business mailbox. The one-time Google setup may be missing.',
  token_exchange: 'Google would not sign Elite OS in to send as the business mailbox. The one-time Google Workspace approval may be missing or incomplete.',
  forbidden: 'Google refused to send as the business mailbox. The Workspace approval may be missing or limited.',
  rate_limited: 'Google is limiting email sending right now. Try again in a little while.',
  bad_request: 'Google rejected the email: the address may be wrong.',
};
// gmail: createGmailClient(...); enabled: the MAIL_SEND switch; sender: the mailbox (info@...). now() and timeoutMs are for tests.
function emailChannel({ gmail, enabled, sender, fromName = 'Elite Kitchens', timeoutMs = SEND_TIMEOUT_MS, now = () => new Date() }) {
  const notConfirmed = `Not confirmed: we could not tell whether Google sent the email. Check the Sent folder of ${sender || 'the business mailbox'}, then choose "It arrived" or "It did not arrive". Elite OS will not send it a second time by itself.`;
  return {
    id: 'email',
    maxMessage: 5000,

    async check(ctx) {
      if (!enabled || !sender) return { ok: false, code: 'email_off', text: 'Email sending is not switched on yet.' };
      const to = ctx.to && ctx.to.email;
      if (!to) return { ok: false, code: 'no_email', text: 'This customer has no email address. Add one in their Details first.' };
      if (!EMAIL_RE.test(to)) return { ok: false, code: 'bad_email', text: 'The email address on this quote does not look right.' };
      return { ok: true };
    },

    async send(ctx) {
      let raw;
      try {
        raw = toRaw(buildMessage({ from: sender, fromName, to: ctx.to.email, subject: ctx.subject || `${fromName} — Quote ${ctx.quoteRef} v${ctx.version}`, text: ctx.message,
          attachment: { filename: ctx.filename, bytes: ctx.pdf.bytes, mime: 'application/pdf' }, date: now() }));
      } catch (e) {
        throw new ChannelError('The email could not be put together (the subject or an address is not valid). Nothing was sent.', { code: 'bad_message', definite: true });
      }
      try { const r = await gmail.sendRaw(raw, { timeoutMs }); return { providerId: r.id }; }
      catch (e) {
        if (e instanceof GmailError && e.definite) {
          log('warn', 'quote email refused', { code: e.code, status: e.status });
          throw new ChannelError(`${GMAIL_TEXT[e.code] || `Google refused the email (code ${e.status}).`} Nothing was sent.`, { code: e.code, definite: true });
        }
        log('error', 'quote email not confirmed', { code: (e instanceof GmailError && e.code) || null });
        throw new ChannelError(notConfirmed, { code: 'not_confirmed', definite: false });          // Google 5xx, no message id, no connection, timeout
      }
    },
  };
}

module.exports = { whatsappChannel, emailChannel, WINDOW_CLOSED, AWAITING, refusalText };
