// Cloud Functions entry point. Secrets come from Firebase Secret Manager; nothing is exposed to the browser.
const { onRequest, onCall } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret, defineString } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');
const { createClient } = require('./lib/whatsapp');
const h = require('./lib/handlers');

initializeApp();
// europe-west1 (Belgium) is the closest supported region to Ireland. maxInstances caps runaway cost.
setGlobalOptions({ region: 'europe-west1', maxInstances: 3 });

const ACCESS_TOKEN = defineSecret('WHATSAPP_ACCESS_TOKEN');
const APP_SECRET = defineSecret('WHATSAPP_APP_SECRET');
const VERIFY_TOKEN = defineSecret('WHATSAPP_VERIFY_TOKEN');
const PHONE_ID = defineString('WHATSAPP_PHONE_NUMBER_ID');
const ALLOWED_EMAILS = defineString('ALLOWED_EMAILS');            // comma-separated Google accounts
const TEMPLATE = defineString('WHATSAPP_TEMPLATE_NAME', { default: 'elite_kitchens_new_lead' });
const LANG = defineString('WHATSAPP_TEMPLATE_LANG', { default: 'en' });
const API_VERSION = defineString('WHATSAPP_API_VERSION', { default: 'v21.0' });

const SECRETS = [ACCESS_TOKEN, APP_SECRET, VERIFY_TOKEN];   // bound on every function so .value() is always safe
const cfg = () => ({
  phoneId: PHONE_ID.value(), allowedEmails: ALLOWED_EMAILS.value(), template: TEMPLATE.value(), lang: LANG.value(),
  version: API_VERSION.value(), apiBase: process.env.WHATSAPP_API_BASE, token: ACCESS_TOKEN.value().trim(), appSecret: APP_SECRET.value().trim(), verifyToken: VERIFY_TOKEN.value().trim(),
});
const bucketName = () => process.env.STORAGE_BUCKET || `${process.env.GCLOUD_PROJECT}.firebasestorage.app`;
const deps = () => { const c = cfg(); return { db: getFirestore(), adminAuth: getAuth(), cfg: c, wa: createClient(c), bucket: getStorage().bucket(bucketName()) }; };

// Public: Meta calls this. Reachable at https://<project>.web.app/webhook via a Hosting rewrite.
exports.webhook = onRequest({ secrets: SECRETS, timeoutSeconds: 90, memory: '512MiB' }, async (req, res) => {
  const d = deps();
  if (req.method === 'GET') { const r = h.webhookVerify(req.query, d.cfg); return res.status(r.status).send(r.body); }
  if (req.method !== 'POST') return res.sendStatus(405);
  res.sendStatus(await h.webhookReceive({ rawBody: req.rawBody, body: req.body, signature: req.get('x-hub-signature-256') }, d));
});

exports.claimAccess = onCall({ secrets: SECRETS }, (req) => h.claimAccess(req.auth, deps()));
exports.startConversation = onCall({ secrets: SECRETS }, (req) => h.startConversation(req.auth, req.data, deps()));
exports.markRead = onCall({ secrets: SECRETS }, (req) => h.markRead(req.auth, req.data, deps()));
exports.setConversationStatus = onCall({}, (req) => h.setConversationStatus(req.auth, req.data, {
  db: getFirestore(), cfg: { allowedEmails: ALLOWED_EMAILS.value() },
}));
exports.updateContact = onCall({ secrets: SECRETS }, (req) => h.updateContact(req.auth, req.data, deps()));
exports.mediaUrl = onCall({ secrets: SECRETS }, (req) => h.mediaUrl(req.auth, req.data, deps()));
exports.retryMedia = onCall({ secrets: SECRETS, timeoutSeconds: 120, memory: '512MiB' }, (req) => h.retryMedia(req.auth, req.data, deps()));
exports.sendMedia = onCall({ secrets: SECRETS, timeoutSeconds: 120, memory: '1GiB' }, (req) => h.sendMedia(req.auth, req.data, deps()));
exports.deleteCustomer = onCall({ secrets: SECRETS, timeoutSeconds: 300, memory: '512MiB' }, (req) => h.deleteCustomer(req.auth, req.data, { ...deps(), ...calendarDeps() }));
exports.sendReply = onCall({ secrets: SECRETS }, (req) => h.sendReply(req.auth, req.data, deps()));

// ---- Phase 3: Meta Lead Ads intake. Make posts each lead here; Elite OS dedupes by Meta lead id, creates/updates the customer
// and sends the approved WhatsApp template itself. Added at the end of the file: no existing function above is touched.
// Needs only the WhatsApp token and its own key (least privilege), and its own secret LEADS_API_KEY (comma-separated keys allow rotation).
const LEADS_API_KEY = defineSecret('LEADS_API_KEY');
const leads = require('./lib/leads');
exports.leadIntake = onRequest({ secrets: [ACCESS_TOKEN, LEADS_API_KEY], timeoutSeconds: 60 }, async (req, res) => {
  try {
    const c = { phoneId: PHONE_ID.value(), template: TEMPLATE.value(), lang: LANG.value(), version: API_VERSION.value(),
      apiBase: process.env.WHATSAPP_API_BASE, token: ACCESS_TOKEN.value().trim(), apiKeys: LEADS_API_KEY.value() };
    const r = await leads.handleLeadRequest({ method: req.method, headers: req.headers, rawBody: req.rawBody, body: req.body },
      { db: getFirestore(), wa: createClient(c), cfg: c });
    Object.entries(r.headers || {}).forEach(([k, v]) => res.set(k, v));
    res.status(r.status).json(r.body);
  } catch (e) {   // unexpected: 500 makes Make retry, which is safe because processing is idempotent. No lead data in the log.
    console.error(JSON.stringify({ level: 'error', msg: 'leadIntake crashed', err: String(e && e.message).replace(/\+?\d[\d\s().\-]{5,}\d/g, '[number]').slice(0, 300) }));
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});

// ---- Phase 5: appointments + one-way Google Calendar sync. Staff-only callables with no WhatsApp secrets (least privilege).
// Elite OS is the source of truth for appointments and the browser only reads them. Apart from deleteCustomer (which now also
// removes the customer's calendar events), no existing function above is touched.
// Google Calendar is off unless GCAL_SYNC=on and both ids are set (functions/.env.<project>). Authentication is keyless: the
// runtime identity gets a short-lived token for GCAL_SERVICE_ACCOUNT, the only account the calendar is shared with for editing.
const { onSchedule } = require('firebase-functions/v2/scheduler');
const gcalLib = require('./lib/gcal');
const calendarSync = require('./lib/calendarSync');
const GCAL_SYNC = defineString('GCAL_SYNC', { default: 'off' });
const GCAL_CALENDAR_ID = defineString('GCAL_CALENDAR_ID', { default: '' });
const GCAL_SERVICE_ACCOUNT = defineString('GCAL_SERVICE_ACCOUNT', { default: '' });
let gcalClient = null, gcalKey = null;
function calendarDeps() {
  const calendarId = GCAL_CALENDAR_ID.value().trim(), serviceAccount = GCAL_SERVICE_ACCOUNT.value().trim();
  const testBase = process.env.FUNCTIONS_EMULATOR === 'true' ? process.env.GCAL_API_BASE : undefined;   // emulator tests: a local fake Calendar
  const key = [calendarId, serviceAccount, testBase].join('|');
  if (key !== gcalKey) {           // one client per instance, so the short-lived token is reused between calls
    const tokens = testBase ? { get: async () => 'emulator-token' } : gcalLib.serviceAccountTokenProvider({ serviceAccount });
    gcalClient = gcalLib.createCalendarClient({ apiBase: testBase || undefined, tokens }); gcalKey = key;
  }
  const enabled = GCAL_SYNC.value().trim().toLowerCase() === 'on' && !!calendarId && (!!serviceAccount || !!testBase);
  return { calendar: { enabled, calendarId, appUrl: `https://${process.env.GCLOUD_PROJECT}.web.app` }, gcal: gcalClient };
}
const staffDeps = () => ({ db: getFirestore(), cfg: { allowedEmails: ALLOWED_EMAILS.value() }, ...calendarDeps() });
exports.createAppointment = onCall({}, (req) => h.createAppointment(req.auth, req.data, staffDeps()));
exports.updateAppointment = onCall({}, (req) => h.updateAppointment(req.auth, req.data, staffDeps()));
exports.cancelAppointment = onCall({}, (req) => h.cancelAppointment(req.auth, req.data, staffDeps()));
exports.retryCalendarSync = onCall({}, (req) => h.retryCalendarSync(req.auth, req.data, staffDeps()));
// Retries anything Google has not caught up with yet, and finishes calendar clean-up after an erasure. Not callable from outside.
exports.calendarSweep = onSchedule({ schedule: 'every 5 minutes', timeZone: 'Europe/Dublin', timeoutSeconds: 300, retryCount: 0 }, async () => {
  const r = await calendarSync.sweep({ db: getFirestore(), ...calendarDeps() });
  console.log(JSON.stringify({ level: 'info', msg: 'calendar sweep', ...r }));
});

// ---- Phase 6: quotes, and customers added without a message (docs/QUOTES.md). Staff-only callables holding no WhatsApp or
// Google secrets (least privilege). Apart from deleteCustomer (which now also erases the customer's quotes and stored quote
// PDFs) and updateContact (which now also accepts an optional address), no existing function above is touched.
const quoteDeps = () => ({ db: getFirestore(), cfg: { allowedEmails: ALLOWED_EMAILS.value() }, bucket: getStorage().bucket(bucketName()) });
exports.createCustomer = onCall({}, (req) => h.createCustomer(req.auth, req.data, quoteDeps()));
exports.saveQuoteSettings = onCall({}, (req) => h.saveQuoteSettings(req.auth, req.data, quoteDeps()));
exports.setQuoteNumbering = onCall({}, (req) => h.setQuoteNumbering(req.auth, req.data, quoteDeps()));
exports.createQuote = onCall({}, (req) => h.createQuote(req.auth, req.data, quoteDeps()));
exports.saveQuoteDraft = onCall({}, (req) => h.saveQuoteDraft(req.auth, req.data, quoteDeps()));
exports.sendQuote = onCall({ timeoutSeconds: 120, memory: '512MiB' }, (req) => h.sendQuote(req.auth, req.data, quoteDeps()));
exports.acceptQuote = onCall({}, (req) => h.acceptQuote(req.auth, req.data, quoteDeps()));
exports.declineQuote = onCall({}, (req) => h.declineQuote(req.auth, req.data, quoteDeps()));
exports.reopenQuote = onCall({}, (req) => h.reopenQuote(req.auth, req.data, quoteDeps()));
exports.reviseQuote = onCall({}, (req) => h.reviseQuote(req.auth, req.data, quoteDeps()));
exports.discardQuoteDraft = onCall({}, (req) => h.discardQuoteDraft(req.auth, req.data, quoteDeps()));
exports.deleteQuoteDraft = onCall({}, (req) => h.deleteQuoteDraft(req.auth, req.data, quoteDeps()));
exports.setQuoteNotes = onCall({}, (req) => h.setQuoteNotes(req.auth, req.data, quoteDeps()));
exports.quotePdfUrl = onCall({}, (req) => h.quotePdfUrl(req.auth, req.data, quoteDeps()));

// ---- Phase 6.1: Reopen conversation (docs/PHASE6_1_PLAN.md). A general WhatsApp capability for any customer chat: it sends the
// approved Reopen template when the 24-hour window is closed. Staff-only. Needs only the WhatsApp access token (least
// privilege: not the app secret or verify token). The template's name and language are plain settings, not secrets. Nothing
// above is touched.
const REOPEN_TEMPLATE = defineString('WHATSAPP_REOPEN_TEMPLATE_NAME', { default: 'elite_kitchens_reopen' });
const REOPEN_LANG = defineString('WHATSAPP_REOPEN_TEMPLATE_LANG', { default: 'en' });
const reopenDeps = () => ({
  db: getFirestore(),
  cfg: { allowedEmails: ALLOWED_EMAILS.value(), reopenTemplate: REOPEN_TEMPLATE.value().trim(), reopenLang: REOPEN_LANG.value().trim() },
  wa: createClient({ phoneId: PHONE_ID.value(), version: API_VERSION.value(), apiBase: process.env.WHATSAPP_API_BASE, token: ACCESS_TOKEN.value().trim() }),
});
exports.reopenConversation = onCall({ secrets: [ACCESS_TOKEN], timeoutSeconds: 60 }, (req) => h.reopenConversation(req.auth, req.data, reopenDeps()));

// ---- Phase 6.1: sending a quote through WhatsApp and email (docs/PHASE6_1_PLAN.md). Staff-only callables. A quote is marked Sent only
// once a channel confirms delivery (lib/quoteDelivery.js); the channels are in lib/quoteChannels.js. Only the two that send hold the
// WhatsApp access token (least privilege); email needs NO secret: Gmail sign-in is keyless (lib/gmail.js). The mail settings are plain
// settings in functions/.env.<project>, not secrets. Email is off unless MAIL_SEND=on and both MAIL_SENDER and MAIL_SERVICE_ACCOUNT
// are set (the kill switch, like GCAL_SYNC). In the emulator, MAIL_API_BASE points at a local fake Gmail. Nothing above is touched.
const quoteChannelLib = require('./lib/quoteChannels');
const gmailLib = require('./lib/gmail');
const MAIL_SEND = defineString('MAIL_SEND', { default: 'off' });
const MAIL_SENDER = defineString('MAIL_SENDER', { default: '' });
const MAIL_SERVICE_ACCOUNT = defineString('MAIL_SERVICE_ACCOUNT', { default: '' });
const MAIL_FROM_NAME = defineString('MAIL_FROM_NAME', { default: 'Elite Kitchens' });
let gmailClient = null, gmailKey = null;
function mailChannel() {
  const sender = MAIL_SENDER.value().trim(), serviceAccount = MAIL_SERVICE_ACCOUNT.value().trim();
  const testBase = process.env.FUNCTIONS_EMULATOR === 'true' ? process.env.MAIL_API_BASE : undefined;     // emulator tests only: a local fake Gmail
  const enabled = MAIL_SEND.value().trim().toLowerCase() === 'on' && !!sender && (!!serviceAccount || !!testBase);
  const key = [sender, serviceAccount, testBase].join('|');
  if (key !== gmailKey) {                                           // one client per instance, so the short-lived token is reused between calls
    const tokens = testBase ? { get: async () => 'emulator-token', clear: () => {} } : gmailLib.delegatedTokenProvider({ serviceAccount, sender });
    gmailClient = gmailLib.createGmailClient({ apiBase: testBase || undefined, tokens }); gmailKey = key;
  }
  return { enabled, sender, channel: quoteChannelLib.emailChannel({ gmail: gmailClient, enabled, sender, fromName: MAIL_FROM_NAME.value().trim() || 'Elite Kitchens' }) };
}
const deliveryDeps = () => {
  const db = getFirestore(), bucket = getStorage().bucket(bucketName());
  const wa = createClient({ phoneId: PHONE_ID.value(), version: API_VERSION.value(), apiBase: process.env.WHATSAPP_API_BASE, token: ACCESS_TOKEN.value().trim() });
  return { db, bucket, cfg: { allowedEmails: ALLOWED_EMAILS.value() }, channels: { whatsapp: quoteChannelLib.whatsappChannel({ db, bucket, wa }), email: mailChannel().channel } };
};
exports.deliverQuote = onCall({ secrets: [ACCESS_TOKEN], timeoutSeconds: 180, memory: '512MiB' }, (req) => h.deliverQuote(req.auth, req.data, deliveryDeps()));
exports.retryQuoteDelivery = onCall({ secrets: [ACCESS_TOKEN], timeoutSeconds: 180, memory: '512MiB' }, (req) => h.retryQuoteDelivery(req.auth, req.data, deliveryDeps()));
exports.resolveQuoteDelivery = onCall({}, (req) => h.resolveQuoteDelivery(req.auth, req.data, quoteDeps()));
exports.cancelQuoteSend = onCall({}, (req) => h.cancelQuoteSend(req.auth, req.data, quoteDeps()));
exports.markQuoteSent = onCall({}, (req) => h.markQuoteSent(req.auth, req.data, quoteDeps()));
exports.quoteChannels = onCall({}, (req) => { const m = mailChannel(); return h.quoteChannels(req.auth, req.data, { ...quoteDeps(), mailEnabled: m.enabled, mailSender: m.sender }); });
