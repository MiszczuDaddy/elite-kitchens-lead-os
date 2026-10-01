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
exports.deleteCustomer = onCall({ secrets: SECRETS, timeoutSeconds: 300, memory: '512MiB' }, (req) => h.deleteCustomer(req.auth, req.data, deps()));
exports.sendReply = onCall({ secrets: SECRETS }, (req) => h.sendReply(req.auth, req.data, deps()));
