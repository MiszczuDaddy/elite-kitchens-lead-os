// Cloud Functions entry point. Secrets come from Firebase Secret Manager; nothing is exposed to the browser.
const { onRequest, onCall } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret, defineString } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');
const { getMessaging } = require('firebase-admin/messaging');
const push = require('./lib/push');
const ai = require('./lib/ai');
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
// Phase 10 (docs/PHASE10_SAFETY_NET.md): every WhatsApp send also tells the health check how it ended (success, or Meta's error code: never a number or text), so a fault that stops ALL
// sending (an expired key, a blocked account, a deleted template) raises a problem in "Needs attention". It can never fail or hold up a send (lib/whatsapp.js caps it).
const waOutcome = (o) => health.noteWhatsApp(getFirestore(), o, { health: healthHook() });
const cfg = () => ({
  phoneId: PHONE_ID.value(), allowedEmails: ALLOWED_EMAILS.value(), template: TEMPLATE.value(), lang: LANG.value(),
  version: API_VERSION.value(), apiBase: process.env.WHATSAPP_API_BASE, token: ACCESS_TOKEN.value().trim(), appSecret: APP_SECRET.value().trim(), verifyToken: VERIFY_TOKEN.value().trim(),
  onOutcome: waOutcome,
});
const bucketName = () => process.env.STORAGE_BUCKET || `${process.env.GCLOUD_PROJECT}.firebasestorage.app`;
// Phase 8: push.notify never throws and gives up after a few seconds (lib/push.js), so the webhook and the lead intake can call it freely.
const pushHook = () => ({ notify: (ev) => push.safeNotify({ db: getFirestore(), messaging: getMessaging(), allowed: ALLOWED_EMAILS.value() }, ev) });
// Phase 10: report / resolve a problem. Never throws, gives up after a few seconds; a new problem gets its first push straight away (the health check sends the rest and the email).
const health = require('./lib/health');
const healthHook = () => health.hook({ db: getFirestore(), notify: pushHook().notify });
const deps = () => { const c = cfg(); return { db: getFirestore(), adminAuth: getAuth(), cfg: c, wa: createClient(c), bucket: getStorage().bucket(bucketName()), push: pushHook() }; };

// Public: Meta calls this. Reachable at https://<project>.web.app/webhook via a Hosting rewrite.
exports.webhook = onRequest({ secrets: SECRETS, timeoutSeconds: 90, memory: '512MiB' }, async (req, res) => {
  const d = deps();
  if (req.method === 'GET') { const r = h.webhookVerify(req.query, d.cfg); return res.status(r.status).send(r.body); }
  if (req.method !== 'POST') return res.sendStatus(405);
  res.sendStatus(await h.webhookReceive({ rawBody: req.rawBody, body: req.body, signature: req.get('x-hub-signature-256') }, d));
});

exports.claimAccess = onCall({ secrets: SECRETS }, (req) => h.claimAccess(req.auth, deps(), req.data));
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
      apiBase: process.env.WHATSAPP_API_BASE, token: ACCESS_TOKEN.value().trim(), apiKeys: LEADS_API_KEY.value(), onOutcome: waOutcome };
    const r = await leads.handleLeadRequest({ method: req.method, headers: req.headers, rawBody: req.rawBody, body: req.body },
      { db: getFirestore(), wa: createClient(c), cfg: c, push: pushHook(), health: healthHook() });
    Object.entries(r.headers || {}).forEach(([k, v]) => res.set(k, v));
    res.status(r.status).json(r.body);
  } catch (e) {   // unexpected: 500 makes Make retry, which is safe because processing is idempotent. No lead data in the log.
    console.error(JSON.stringify({ level: 'error', msg: 'leadIntake crashed', err: String(e && e.message).replace(/\+?\d[\d\s().\-]{5,}\d/g, '[number]').slice(0, 300) }));
    await healthHook().report('lead_error');                                          // Phase 10: shown in "Needs attention" (no lead data in it)
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
  wa: createClient({ phoneId: PHONE_ID.value(), version: API_VERSION.value(), apiBase: process.env.WHATSAPP_API_BASE, token: ACCESS_TOKEN.value().trim(), onOutcome: waOutcome }),
});
exports.reopenConversation = onCall({ secrets: [ACCESS_TOKEN], timeoutSeconds: 60 }, (req) => h.reopenConversation(req.auth, req.data, reopenDeps()));

// ---- Phase 12: the evening-before visit reminder (docs/PHASE12_BOOKINGS.md). The ONLY message Elite OS sends about a visit; it goes by itself and is OFF until the owner switches it on. Needs only the WhatsApp access token.
// The template is a plain setting (a blank name means "no template": only the 24-hour window can be used). BOOKING_REMINDERS is the kill switch (off by default).
const BOOKING_REMINDER_TEMPLATE = defineString('BOOKING_REMINDER_TEMPLATE', { default: 'elite_kitchens_consultation_reminder' });
const BOOKING_TEMPLATE_LANG = defineString('BOOKING_TEMPLATE_LANG', { default: 'en' });
const BOOKING_REMINDERS = defineString('BOOKING_REMINDERS', { default: 'off' });
const bookingDeps = () => {
  const name = BOOKING_REMINDER_TEMPLATE.value().trim(), lang = BOOKING_TEMPLATE_LANG.value().trim() || 'en';
  return { db: getFirestore(), cfg: { allowedEmails: ALLOWED_EMAILS.value(), booking: { reminder: name ? { name, lang } : null, remindersOn: BOOKING_REMINDERS.value().trim().toLowerCase() === 'on' } },
    wa: createClient({ phoneId: PHONE_ID.value(), version: API_VERSION.value(), apiBase: process.env.WHATSAPP_API_BASE, token: ACCESS_TOKEN.value().trim(), onOutcome: waOutcome }) };
};
exports.resolveBookingNotice = onCall({}, (req) => h.resolveBookingNotice(req.auth, req.data, { db: getFirestore(), cfg: { allowedEmails: ALLOWED_EMAILS.value() } }));      // sends nothing: no WhatsApp secret
exports.bookingReminderSweep = onSchedule({ schedule: 'every 15 minutes', timeZone: 'Europe/Dublin', secrets: [ACCESS_TOKEN], timeoutSeconds: 300, retryCount: 0 }, async () => {
  const r = await require('./lib/bookingNotices').reminderSweep(bookingDeps());
  console.log(JSON.stringify({ level: 'info', msg: 'booking reminder sweep', ...r }));
});

// ---- Phase 6.1: sending a quote through WhatsApp and email (docs/PHASE6_1_PLAN.md). Staff-only callables. A quote is marked Sent only
// once a channel confirms delivery (lib/quoteDelivery.js); the channels are in lib/quoteChannels.js. Only the two that send hold the
// WhatsApp access token (least privilege); email needs NO secret: Gmail sign-in is keyless (lib/gmail.js). The mail settings are plain
// settings in functions/.env.<project>, not secrets. Email is off unless MAIL_SEND=on and both MAIL_SENDER and MAIL_SERVICE_ACCOUNT
// are set (the kill switch, like GCAL_SYNC). In the emulator, MAIL_API_BASE points at a local fake Gmail. Nothing above is touched.
const quoteChannelLib = require('./lib/quoteChannels');
const gmailLib = require('./lib/gmail');
// The approved quotation template (M7): used instead of a free-form document when the customer's 24-hour window is closed. A blank name
// switches that route off (a closed window is then refused, as in M3).
const QUOTE_TEMPLATE = defineString('WHATSAPP_QUOTE_TEMPLATE_NAME', { default: 'elite_kitchens_quote_document' });
const QUOTE_TEMPLATE_LANG = defineString('WHATSAPP_QUOTE_TEMPLATE_LANG', { default: 'en' });
const quoteTemplate = () => { const name = QUOTE_TEMPLATE.value().trim(), lang = QUOTE_TEMPLATE_LANG.value().trim(); return name && lang ? { name, lang } : null; };
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
  const wa = createClient({ phoneId: PHONE_ID.value(), version: API_VERSION.value(), apiBase: process.env.WHATSAPP_API_BASE, token: ACCESS_TOKEN.value().trim(), onOutcome: waOutcome });
  return { db, bucket, cfg: { allowedEmails: ALLOWED_EMAILS.value() }, channels: { whatsapp: quoteChannelLib.whatsappChannel({ db, bucket, wa, quoteTemplate: quoteTemplate() }), email: mailChannel().channel } };
};
exports.deliverQuote = onCall({ secrets: [ACCESS_TOKEN], timeoutSeconds: 180, memory: '512MiB' }, (req) => h.deliverQuote(req.auth, req.data, deliveryDeps()));
exports.retryQuoteDelivery = onCall({ secrets: [ACCESS_TOKEN], timeoutSeconds: 180, memory: '512MiB' }, (req) => h.retryQuoteDelivery(req.auth, req.data, deliveryDeps()));
exports.resolveQuoteDelivery = onCall({}, (req) => h.resolveQuoteDelivery(req.auth, req.data, quoteDeps()));
exports.cancelQuoteSend = onCall({}, (req) => h.cancelQuoteSend(req.auth, req.data, quoteDeps()));
exports.markQuoteSent = onCall({}, (req) => h.markQuoteSent(req.auth, req.data, quoteDeps()));
exports.quoteChannels = onCall({}, (req) => { const m = mailChannel(); return h.quoteChannels(req.auth, req.data, { ...quoteDeps(), mailEnabled: m.enabled, mailSender: m.sender, quoteTemplate: !!quoteTemplate() }); });

// ---- Phase 7: projects (docs/PROJECTS.md). Staff-only callables with no WhatsApp, Google or email secrets (least privilege). A project is made by acceptQuote itself
// (same transaction); these are for working on it. attachProjectRender reads and moves the uploaded picture, so it gets more time and memory.
exports.createProject = onCall({}, (req) => h.createProject(req.auth, req.data, quoteDeps()));
exports.saveProject = onCall({}, (req) => h.saveProject(req.auth, req.data, quoteDeps()));
exports.setProjectStep = onCall({}, (req) => h.setProjectStep(req.auth, req.data, quoteDeps()));
exports.completeProject = onCall({}, (req) => h.completeProject(req.auth, req.data, quoteDeps()));
exports.removeProject = onCall({}, (req) => h.removeProject(req.auth, req.data, quoteDeps()));
exports.attachProjectRender = onCall({ timeoutSeconds: 120, memory: '512MiB' }, (req) => h.attachProjectRender(req.auth, req.data, quoteDeps()));
exports.projectRenderUrl = onCall({}, (req) => h.projectRenderUrl(req.auth, req.data, quoteDeps()));

// ---- Phase 8: push notifications (docs/PUSH.md). Staff-only callables, no WhatsApp or Google secrets. pushReceipt is public on purpose: the service worker on a device reports the moment a
// notification arrived (it has no sign-in); it is reached through the Hosting rewrite /pushReceipt, validates everything, and returns nothing.
const pushDeps = () => ({ ...quoteDeps(), messaging: getMessaging() });
exports.registerPushDevice = onCall({}, (req) => h.registerPushDevice(req.auth, req.data, pushDeps()));
exports.unregisterPushDevice = onCall({}, (req) => h.unregisterPushDevice(req.auth, req.data, pushDeps()));
exports.sendTestPush = onCall({ timeoutSeconds: 30 }, (req) => h.sendTestPush(req.auth, req.data, pushDeps()));
// ---- Phase 9: the AI assistant (docs/AI.md). Read-only. ANTHROPIC_API_KEY is a Secret Manager secret the owner sets himself (never in the code). The fake model exists ONLY in the emulator.
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const aiModel = () => {
  if (process.env.FUNCTIONS_EMULATOR === 'true' && process.env.AI_FAKE_MODEL === 'on') return ai.createDemoModel();
  let key = ''; try { key = String(ANTHROPIC_API_KEY.value() || '').trim(); } catch (e) { key = ''; }
  return key ? ai.anthropicModel({ apiKey: key }) : null;
};
// Who may switch real customer data on: the AI_OWNER_EMAILS setting (comma-separated). Empty = nobody. It is written to the settings file by the deploy script's ai stage.
const AI_OWNER_EMAILS = defineString('AI_OWNER_EMAILS', { default: '' });
const aiDeps = () => ({ ...quoteDeps(), model: aiModel(), aiOwners: AI_OWNER_EMAILS.value() });
exports.aiChat = onCall({ secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 240 }, (req) => h.aiChat(req.auth, req.data, aiDeps()));
exports.aiStatus = onCall({ secrets: [ANTHROPIC_API_KEY] }, (req) => h.aiStatus(req.auth, req.data, aiDeps()));
exports.setAiSettings = onCall({ secrets: [ANTHROPIC_API_KEY] }, (req) => h.setAiSettings(req.auth, req.data, aiDeps()));
exports.aiDecide = onCall({}, (req) => h.aiDecide(req.auth, req.data, quoteDeps()));
exports.aiSuggestReply = onCall({ secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120 }, (req) => h.aiSuggestReply(req.auth, req.data, aiDeps()));
exports.aiDraftOutcome = onCall({}, (req) => h.aiDraftOutcome(req.auth, req.data, quoteDeps()));
exports.aiDismissConsult = onCall({}, (req) => h.aiDismissConsult(req.auth, req.data, quoteDeps()));
exports.aiKnowledge = onCall({}, (req) => h.aiKnowledge(req.auth, req.data, aiDeps()));
exports.aiKnowledgeTest = onCall({ secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 180 }, (req) => h.aiKnowledgeTest(req.auth, req.data, aiDeps()));
exports.setReceptionist = onCall({}, (req) => h.setReceptionist(req.auth, req.data, { ...quoteDeps(), aiOwners: AI_OWNER_EMAILS.value() }));
// R3: the receptionist's BACKUP check, every 5 minutes (docs/AI.md). Not callable from outside. The main path is receptionistOnMessage below (a Firestore event when a customer message is saved); this one answers
// whatever the event path missed and everything that arrived during quiet hours. It answers only the chats the owner switched on or new Meta leads, and only while every AI switch is on.
const receptionist = require('./lib/aiReceptionist');
exports.receptionistSweep = onSchedule({ schedule: 'every 5 minutes', timeZone: 'Europe/Dublin', secrets: [...SECRETS, ANTHROPIC_API_KEY], timeoutSeconds: 180, retryCount: 0 }, async () => {
  const r = await receptionist.sweep({ db: getFirestore(), wa: createClient(cfg()), model: aiModel(), owners: AI_OWNER_EMAILS.value(), push: pushHook(), welcomeTemplate: TEMPLATE.value(), health: healthHook() });
  await health.beat(getFirestore(), 'receptionistSweep', { result: r.skipped || 'ran' }).catch(() => {});          // Phase 10: "it ran" (a check that stops is a problem in "Needs attention")
  console.log(JSON.stringify({ level: 'info', msg: 'receptionist sweep', ...r }));
});
// R3 (event-driven): the moment a message is saved in a chat, the receptionist is asked. Only a message FROM THE CUSTOMER does anything (everything else returns at once). It waits the reply delay (30 seconds by
// default, aiSettings.replyDelaySeconds) so a burst of messages is answered once, then runs the same checks as the backup. No retry (a failed run is picked up by the backup within 5 minutes); no always-on instance.
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
exports.receptionistOnMessage = onDocumentCreated({ document: 'conversations/{phone}/messages/{messageId}', region: 'europe-west1', secrets: [...SECRETS, ANTHROPIC_API_KEY], timeoutSeconds: 180, memory: '256MiB', maxInstances: 10, retry: false }, async (event) => {
  const m = event.data && event.data.data();
  if (!m || m.direction !== 'in') return;                                                  // our own messages, a person's and the welcome template: nothing to do
  const r = await receptionist.onMessage({ db: getFirestore(), wa: createClient(cfg()), model: aiModel(), owners: AI_OWNER_EMAILS.value(), push: pushHook(), welcomeTemplate: TEMPLATE.value(), health: healthHook() }, event.params.phone, m);
  console.log(JSON.stringify({ level: 'info', msg: 'receptionist event', result: r }));
});
exports.aiCheckModels = onCall({ secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 60 }, (req) => h.aiCheckModels(req.auth, req.data, aiDeps()));

exports.pushReceipt = onRequest({ timeoutSeconds: 15 }, async (req, res) => { res.sendStatus(await h.pushReceipt(req, { db: getFirestore() })); });

// ---- Phase 10: the safety net (docs/PHASE10_SAFETY_NET.md). Staff-only callables with no WhatsApp, Google or AI secret (least privilege): "do not contact" and the buttons of
// "Needs attention". Neither sends anything to a customer. Nothing above is changed except where noted (the WhatsApp outcome, the lead intake's problems, the receptionist's heartbeat).
exports.setDoNotContact = onCall({}, (req) => h.setDoNotContact(req.auth, req.data, { db: getFirestore(), cfg: { allowedEmails: ALLOWED_EMAILS.value() } }));
// ---- Phase 11: the Today tab (docs/PHASE11_TODAY.md). Staff-only callables, no secrets: a reminder (add, done, undo, snooze, delete) and a quote follow-up snooze. They send nothing to anyone.
// The Inbox "All" tab and search across every customer: one compact, staff-only list (docs/INBOX_ALL_AND_SEARCH.md). Reads only.
exports.customerDirectory = onCall({ memory: '512MiB', timeoutSeconds: 60 }, (req) => h.customerDirectory(req.auth, req.data, { db: getFirestore(), cfg: { allowedEmails: ALLOWED_EMAILS.value() } }));
exports.saveReminder = onCall({}, (req) => h.saveReminder(req.auth, req.data, { db: getFirestore(), cfg: { allowedEmails: ALLOWED_EMAILS.value() } }));
exports.snoozeQuote = onCall({}, (req) => h.snoozeQuote(req.auth, req.data, { db: getFirestore(), cfg: { allowedEmails: ALLOWED_EMAILS.value() } }));
exports.attentionAction = onCall({}, (req) => h.attentionAction(req.auth, req.data, { db: getFirestore(), cfg: { allowedEmails: ALLOWED_EMAILS.value() } }));
// Who gets the alert emails (comma-separated; empty = no alert emails, the phone alerts and the screen still work). They are sent through the quote mailer (MAIL_* settings), so
// only while email sending is on. A plain setting, not a secret.
const ALERT_EMAILS = defineString('ALERT_EMAILS', { default: '' });
const alertMail = () => {
  const m = mailChannel(), to = ALERT_EMAILS.value().split(',').map((s) => s.trim()).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
  return { enabled: m.enabled, sender: m.sender, fromName: 'Elite OS', gmail: gmailClient, to };
};
// The health check, every 10 minutes: leads arriving, WhatsApp reporting back, the receptionist's own check running, alerts reaching a device; and the alerts still owed (push, email).
// Not callable from outside. Holds no WhatsApp, Google or AI secret.
exports.healthSweep = onSchedule({ schedule: 'every 10 minutes', timeZone: 'Europe/Dublin', timeoutSeconds: 120, retryCount: 0 }, async () => {
  const r = await health.sweep({ db: getFirestore(), notify: pushHook().notify, allowed: ALLOWED_EMAILS.value(), mail: alertMail() });
  console.log(JSON.stringify({ level: 'info', msg: 'health sweep', opened: r.opened, resolved: r.resolved, leadAlerts: r.leadAlerts || 0, handoverAlerts: r.handoverAlerts || 0 }));
});
// Every write to a chat message: one that came FROM Meta (a customer message, a delivery tick) proves WhatsApp still reaches Elite OS; our own writes are ignored. One write, no read,
// no secret, no retry. It never touches the message.
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
exports.healthOnMessageWrite = onDocumentWritten({ document: 'conversations/{phone}/messages/{messageId}', region: 'europe-west1', timeoutSeconds: 30, memory: '256MiB', maxInstances: 5, retry: false }, async (event) => {
  const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
  const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
  await health.onMessageWrite(getFirestore(), before, after).catch(() => {});
});
