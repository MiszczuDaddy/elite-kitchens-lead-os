// Phase 8: push notifications (docs/PUSH.md). Staff who switch notifications on get a push when a WhatsApp message or a Meta lead arrives, with Elite OS closed.
//   pushDevices/{deviceId}   one per device that switched notifications on: { token, email, platform, enabled, createdAt, lastSeenAt }. deviceId = hash of the token.
//   pushEvents/{id}          one per notification, with every timestamp that tells how fast it was (all milliseconds, one clock per step, never "Firebase accepted" as delivery):
//        eventAt             when Meta says the message / lead happened (seconds resolution, Meta's clock)
//        backendReceivedAt   when our function got the request (webhook or lead intake entry)
//        sendStartedAt       just before the push was handed to Firebase
//        devices.<id>.acceptedAt   when Firebase said "accepted" for that device (NOT a delivery)
//        receipts.<id>.received    { deviceAt (the device's own clock), serverAt (when its report reached us) }: the service worker on the device reports the moment it woke up
//        receipts.<id>.clicked     the same, for the click
// The push carries only opaque ids: no name, number or message text (the service worker writes the generic words). Sending can NEVER throw or hold up the caller for long:
// safeNotify catches everything and gives up after a few seconds (the webhook must answer Meta whatever happens here).
const crypto = require('crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const { Timestamp } = require('firebase-admin/firestore');

const KINDS = ['message', 'lead', 'test', 'handover'];       // handover (Phase 9 R3): the receptionist passed a chat to the owner
const PLATFORMS = ['windows', 'android', 'other'];
const TOKEN = /^[\w:.\-]{50,4096}$/;                         // an FCM registration token
const EVENT_ID = /^[mlth]_[0-9a-f]{24}$/, DEVICE_ID = /^[0-9a-f]{32}$/;
const TTL_SECONDS = 6 * 3600;                                // a "new message" alert is useless after six hours
const SEND_CAP_MS = 2500;                                    // the webhook never waits longer than this for Firebase
const DEAD_TOKEN = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'];

const bad = (msg) => new HttpsError('invalid-argument', msg);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const deviceIdOf = (token) => sha(token).slice(0, 32);
const eventIdOf = (kind, sourceId) => kind[0] + '_' + sha(kind + '|' + sourceId).slice(0, 24);
const tagOf = (phone) => sha('c|' + phone).slice(0, 8);      // lets the device replace an earlier alert of the same customer; reveals nothing
const log = (level, msg, extra) => console.log(JSON.stringify({ level, msg, ...extra }));
const alreadyExists = (e) => !!e && (e.code === 6 || e.code === 'already-exists' || /ALREADY_EXISTS|already exists/i.test(String(e.message)));

function onlyKeys(data, allowed, what = 'details') {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad(`Missing ${what}.`);
  for (const k of Object.keys(data)) if (!allowed.includes(k)) throw bad(`Unknown field: ${k}`);
  return data;
}

// ---- devices ----
async function registerDevice({ db }, actor, data, { nowMs = Date.now() } = {}) {
  onlyKeys(data, ['token', 'platform']);
  if (typeof data.token !== 'string' || !TOKEN.test(data.token)) throw bad('That does not look like a notification address for this device.');
  if (!PLATFORMS.includes(data.platform)) throw bad('Unknown device type.');
  const id = deviceIdOf(data.token), ref = db.collection('pushDevices').doc(id), snap = await ref.get();
  await ref.set({ token: data.token, email: String(actor.id).toLowerCase(), platform: data.platform, enabled: true,
    createdAt: snap.exists ? snap.data().createdAt : Timestamp.fromMillis(nowMs), lastSeenAt: Timestamp.fromMillis(nowMs) });
  return { deviceId: id };
}
async function unregisterDevice({ db }, actor, data) {
  onlyKeys(data, ['deviceId']);
  if (typeof data.deviceId !== 'string' || !DEVICE_ID.test(data.deviceId)) throw bad('Missing device.');
  const ref = db.collection('pushDevices').doc(data.deviceId), snap = await ref.get();
  if (!snap.exists) return { removed: false };
  if (snap.data().email !== String(actor.id).toLowerCase()) throw new HttpsError('permission-denied', 'That device belongs to someone else.');
  await ref.delete();
  return { removed: true };
}

// ---- sending ----
const withCap = (promise, ms) => new Promise((resolve) => { const t = setTimeout(() => resolve({ timedOut: true }), ms); promise.then((v) => { clearTimeout(t); resolve({ value: v }); }, (e) => { clearTimeout(t); resolve({ failed: e }); }); });

// ev: { kind, sourceId, phone, eventAt, backendReceivedAt, onlyDeviceId }. ctx: { db, messaging, allowed (comma list of staff e-mails), now, capMs }.
// A second call for the same message / lead (a Meta or Make retry) finds the record and sends nothing.
async function notify(ctx, ev) {
  const { db, messaging } = ctx, now = ctx.now || Date.now, capMs = ctx.capMs || SEND_CAP_MS;
  if (!KINDS.includes(ev.kind)) throw bad('Unknown notification kind.');
  const id = ev.kind === 'test' ? 't_' + crypto.randomBytes(12).toString('hex') : eventIdOf(ev.kind, String(ev.sourceId));
  const ref = db.collection('pushEvents').doc(id);
  const allowed = String(ctx.allowed || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  // the record and the list of devices are fetched at the same time: the claim must not delay the send
  const claim = ref.create({ kind: ev.kind, phone: ev.phone || null, eventAt: ev.eventAt || null, backendReceivedAt: ev.backendReceivedAt || now(), createdAt: Timestamp.fromMillis(now()), status: 'sending' })
    .then(() => true, (e) => { if (alreadyExists(e)) return false; throw e; });
  const devicesQ = db.collection('pushDevices').where('enabled', '==', true).get();
  const [claimed, snap] = await Promise.all([claim, devicesQ]);
  if (!claimed) return { id, duplicate: true };
  const targets = snap.docs.filter((d) => allowed.includes(String(d.data().email).toLowerCase()) && (!ev.onlyDeviceId || d.id === ev.onlyDeviceId));
  if (!targets.length) { await ref.update({ status: 'no-devices' }); return { id, sent: 0, failed: 0 }; }
  const data = (d) => ({ n: id, k: ev.kind, d: d.id, c: ev.phone ? tagOf(ev.phone) : 'x' });         // opaque ids only
  const sendStartedAt = now();
  const outcome = await withCap(Promise.all(targets.map(async (d) => {
    try { const fcmId = await messaging.send({ token: d.data().token, data: data(d), webpush: { headers: { TTL: String(TTL_SECONDS), Urgency: 'high' } } }); return { d, ok: true, acceptedAt: now(), fcmId }; }
    catch (e) { return { d, ok: false, acceptedAt: now(), error: String((e && (e.code || e.errorInfo && e.errorInfo.code)) || 'send-failed').slice(0, 80) }; }
  })), capMs);
  if (!outcome.value) {                                                                                  // Firebase was too slow (or the batch itself failed): record it and move on
    await ref.update({ status: outcome.timedOut ? 'timeout' : 'error', sendStartedAt, sendFinishedAt: now() }).catch(() => {});
    log('error', 'push not confirmed', { id, kind: ev.kind, reason: outcome.timedOut ? 'timeout' : 'error' });
    return { id, sent: 0, failed: targets.length, timedOut: !!outcome.timedOut };
  }
  const devices = {}; let sent = 0, failed = 0;
  for (const r of outcome.value) {
    devices[r.d.id] = { platform: r.d.data().platform, ok: r.ok, acceptedAt: r.acceptedAt, ...(r.ok ? {} : { error: r.error }) };
    if (r.ok) sent++; else failed++;
    if (!r.ok && DEAD_TOKEN.includes(r.error)) await r.d.ref.delete().catch(() => {});                  // that device unsubscribed: forget it
  }
  await ref.update({ status: failed && !sent ? 'failed' : 'sent', sendStartedAt, sendFinishedAt: now(), devices });
  return { id, sent, failed };
}
// What the webhook and the lead intake call: it can never throw, and it gives up after a few seconds.
async function safeNotify(ctx, ev) {
  try { return await notify(ctx, ev); }
  catch (e) { log('error', 'push failed', { kind: ev && ev.kind, code: String((e && e.code) || 'unknown').slice(0, 60) }); return { failed: true }; }
}

// A test notification to ONE of the caller's own devices, so the speed can be measured on demand. The clock starts when this request arrives.
async function sendTest(ctx, actor, data) {
  const t0 = (ctx.now || Date.now)();
  onlyKeys(data, ['deviceId']);
  if (typeof data.deviceId !== 'string' || !DEVICE_ID.test(data.deviceId)) throw bad('Missing device.');
  const snap = await ctx.db.collection('pushDevices').doc(data.deviceId).get();
  if (!snap.exists || snap.data().email !== String(actor.id).toLowerCase()) throw new HttpsError('failed-precondition', 'Switch notifications on for this device first.');
  const r = await safeNotify({ ...ctx, allowed: String(actor.id) }, { kind: 'test', backendReceivedAt: t0, onlyDeviceId: data.deviceId });
  return { id: r.id || null, sent: r.sent || 0, failed: r.failed || 0 };
}

// The device reports the moment it received (or you clicked) a notification. Public on purpose (a service worker has no sign-in), so it is strict: the event must exist, the
// device must be a known one (both ids are unguessable), the first report of each kind wins, and nothing is ever returned.
async function receipt({ db }, body, { nowMs = Date.now() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 400;
  const { n, d, p, t } = body;
  if (typeof n !== 'string' || !EVENT_ID.test(n) || typeof d !== 'string' || !DEVICE_ID.test(d) || !['received', 'clicked'].includes(p)) return 400;
  if (typeof t !== 'number' || !Number.isFinite(t) || Math.abs(t - nowMs) > 7 * 24 * 3600e3) return 400;
  const ref = db.collection('pushEvents').doc(n);
  return db.runTransaction(async (tx) => {
    // The device may report faster than we record the result of the send, so a device we know (it is registered) is accepted as well as one already listed on the event.
    const [snap, dev] = await Promise.all([tx.get(ref), tx.get(db.collection('pushDevices').doc(d))]);
    if (!snap.exists || !(dev.exists || (snap.data().devices && snap.data().devices[d]))) return 404;
    const have = snap.data().receipts && snap.data().receipts[d] && snap.data().receipts[d][p];
    if (have) return 204;                                                                                // first report wins
    tx.update(ref, { [`receipts.${d}.${p}`]: { deviceAt: t, serverAt: nowMs } });
    return 204;
  });
}

module.exports = { KINDS, PLATFORMS, TTL_SECONDS, SEND_CAP_MS, deviceIdOf, eventIdOf, tagOf, registerDevice, unregisterDevice, notify, safeNotify, sendTest, receipt };
