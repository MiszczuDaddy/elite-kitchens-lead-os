'use strict';
// Phase 10 (docs/PHASE10_SAFETY_NET.md): the safety net. Faults that used to be silent (written to a log at most) become PROBLEMS: shown in "Needs attention", alerted once by push
// (and by email when ALERT_EMAILS is set), retried until delivered, and closed by themselves when the fault goes away (or by a person: "Mark as fixed").
//   healthIssues/{kind}     one per kind of problem: { kind, status: open|resolved, occurrence, openedAt, lastAt, count, detail, resolvedAt, resolvedBy, alert }
//   health/whatsapp         how WhatsApp sending is going: { lastSendOkAt, failStreak, lastFailAt, sendsSinceWebhook, firstUnreportedAt, lastWebhookAt, issues }
//   health/heartbeats       the scheduled checks saying they ran: { receptionistSweepAt, receptionistResult, healthSweepAt, healthSweepSince }
//   health/backup           the last restore test (written by scripts/backup-check.js)
//   (The "no Meta leads have arrived" warning and its hours setting were REMOVED on 19 Oct 2026 at the owner's request: ads are often paused on purpose. The 10-minute check erases what they left behind, see "tidy".)
// Rules (each has a test): nothing here holds or sends a customer's name, number, address or words (alerts say only WHAT kind of problem it is); recording a problem can never throw into
// the caller, never delays a customer message for long, and never changes what is sent; a problem alerts ONCE per occurrence, however many times it repeats or however many checks run.
const { HttpsError } = require('firebase-functions/v2/https');
const { Timestamp, FieldValue } = require('firebase-admin/firestore');
const gmailLib = require('./gmail');
const LeadIssues = require('./leadIssues');

const log = (level, msg, extra) => console[level === 'error' ? 'error' : 'log'](JSON.stringify({ level, msg, ...extra }));
const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : typeof t === 'number' ? t : 0);
const ts = (n) => Timestamp.fromMillis(n);
const HOUR = 3600e3, MIN = 60e3;

// What each problem is called and what to do about it. Plain words, no customer details. email: 'always' = a copy by email whenever email alerts are set up.
const ISSUES = {
  lead_key: { title: 'Leads are arriving with the wrong key', help: 'Something is sending leads to Elite OS with a key that does not match, so they are refused. Check the key in the Make scenario.' },
  lead_breaker: { title: 'Too many leads arrived in one hour', help: 'More than 60 new leads arrived within an hour, so Elite OS paused taking them as a precaution. Make will try them again. Check that nothing is sending the same leads in a loop.' },
  lead_error: { title: 'A Meta lead could not be processed', help: 'Make will try it again by itself. If this keeps happening, report it.' },
  whatsapp_auth: { title: "WhatsApp is refusing Elite OS's access key", help: 'No WhatsApp message can be sent. The access key may have expired or been changed in Meta. Report it straight away.' },
  whatsapp_account: { title: 'WhatsApp has limited the business account', help: 'Meta has blocked or limited sending (for example a policy block, a payment problem or a spam limit). Check WhatsApp Manager in Meta Business Suite.' },
  whatsapp_template: { title: "WhatsApp refused one of Elite OS's approved message templates", help: 'A template (the welcome, Reopen or the quote document) may have been paused, disabled or deleted in WhatsApp Manager. Check its status there.' },
  whatsapp_failing: { title: 'WhatsApp messages are failing to send', help: 'Several messages in a row could not be confirmed. WhatsApp may be having problems. Check the chats on your phone and try again later.' },
  whatsapp_no_reports: { title: 'WhatsApp has stopped reporting back to Elite OS', help: 'Messages were sent but no delivery ticks or customer messages have arrived since. Customer messages may not be reaching Elite OS. Check the WhatsApp app on your phone and report it.' },
  receptionist_stopped: { title: "The receptionist's regular check has stopped", help: 'The automatic receptionist is switched on but its 5-minute check has not run for a while. New messages may go unanswered. Report it.' },
  receptionist_blocked: { title: 'The receptionist is switched on but cannot answer', help: 'Automatic receptionist is on, but the AI, real customer data or reply suggestions is switched off (Assistant > Settings). Switch them on, or switch the receptionist off.' },
  ai_no_key: { title: 'The AI has no key', help: 'The receptionist is switched on but the AI key is missing, so every chat is handed to you. Report it.' },
  ai_budget: { title: 'The AI budget is used up', help: 'The receptionist hands every new chat to you until the budget starts again. The cap can be raised in Assistant > Settings.' },
  ai_failing: { title: 'The AI is not answering', help: 'The receptionist could not get an answer from the AI several times and handed chats to you. If this keeps happening, report it.' },
  alerts_failing: { title: 'Alerts are not reaching any phone or computer', help: 'The last alerts all failed. On the phone you carry, open Notifications and press "Turn off", then "Enable" again.' },
  no_alert_devices: { title: 'No phone or computer is set up for alerts', help: 'Nobody will be alerted about new leads, messages or problems. On the phone you carry, open Notifications and press "Enable notifications".' },
};
for (const k of Object.keys(ISSUES)) ISSUES[k].email = 'always';
const WHATSAPP_KINDS = ['whatsapp_auth', 'whatsapp_account', 'whatsapp_template', 'whatsapp_failing'];
const AI_KINDS = ['ai_no_key', 'ai_budget', 'ai_failing', 'receptionist_blocked'];
// Meta error codes that stop ALL sending, not just one customer's message (Meta's WhatsApp error-code list). Anything else that Meta refuses is about that one customer and raises nothing.
const AUTH_CODES = new Set([0, 10, 190]);                                         // and 200-299 (permissions), and HTTP 401
const ACCOUNT_CODES = new Set([368, 131031, 131042, 131045, 131048, 133010]);
const TEMPLATE_CODES = new Set([132000, 132001, 132005, 132007, 132012, 132015, 132016]);
const STREAK = 3, STREAK_WINDOW_MS = 30 * MIN;                                     // this many unconfirmed sends in a row (within 30 minutes) = "failing"
const NO_REPORT_MS = 60 * MIN, NO_REPORT_MAX_MS = 48 * HOUR, NO_REPORT_SENDS = 2;  // sends with nothing at all back from Meta for an hour
const BEAT_STALE_MS = 20 * MIN, START_GRACE_MS = 30 * MIN;
const ALERT_TRIES = 6, EMAIL_TRIES = 3, EMAIL_CLAIM_MS = 10 * MIN;
const RESOLVED_PURGE_MS = 90 * 24 * HOUR;
const clip = (s) => (s == null ? null : String(s).replace(/\d{6,}/g, '[number]').slice(0, 120));    // a detail is a code or a short phrase; never a number

// ---------------------------------------------------------------- problems --------------------------------------------------------------
// Open a problem (or count one more of an open one). Returns { opened, occurrence }.
async function report(db, kind, { detail = null, nowMs = Date.now() } = {}) {
  if (!ISSUES[kind]) throw new Error('unknown problem kind');
  const ref = db.collection('healthIssues').doc(kind), now = ts(nowMs);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref), d = s.exists ? s.data() : null;
    if (d && d.status === 'open') { tx.update(ref, { lastAt: now, count: (d.count || 0) + 1, ...(detail ? { detail: clip(detail) } : {}) }); return { opened: false, occurrence: d.occurrence || 1 }; }
    const occurrence = ((d && d.occurrence) || 0) + 1;
    tx.set(ref, { kind, title: ISSUES[kind].title, help: ISSUES[kind].help, status: 'open', occurrence, openedAt: now, lastAt: now, count: 1, detail: clip(detail), resolvedAt: null, resolvedBy: null,
      alert: { state: 'pending', tries: 0, pushOk: false, emailOk: false, emailTries: 0, emailClaimedAt: null, lastTryAt: null } });
    return { opened: true, occurrence };
  });
}
// Close the open problems among `kinds` (the fault went away, or a person marked it fixed). Returns the kinds closed now.
async function resolveMany(db, kinds, { by = 'auto', nowMs = Date.now() } = {}) {
  const list = [...new Set(kinds)].filter((k) => ISSUES[k]);
  if (!list.length) return [];
  const refs = list.map((k) => db.collection('healthIssues').doc(k));
  return db.runTransaction(async (tx) => {
    const snaps = await tx.getAll(...refs), done = [];
    snaps.forEach((s, i) => { if (s.exists && s.data().status === 'open') { tx.update(refs[i], { status: 'resolved', resolvedAt: ts(nowMs), resolvedBy: by }); done.push(list[i]); } });
    return done;
  });
}

// What the other functions are handed (functions/index.js): report and resolve that can NEVER throw, and give up after a few seconds. A new problem gets its first push straight away
// (best effort); the health check (sweep) delivers whatever is still owed, and the email.
function hook({ db, notify = null, capMs = 3000 }) {
  const capped = (p) => { let t; return Promise.race([p, new Promise((r) => { t = setTimeout(() => r(null), capMs); })]).finally(() => clearTimeout(t)); };
  return {
    report: (kind, detail) => capped((async () => {
      try {
        const r = await report(db, kind, { detail });
        if (r.opened && notify) await deliverIssueAlert({ db, notify }, kind, Date.now(), { pushOnly: true });
        return r;
      } catch (e) { log('error', 'health report failed', { kind, code: String((e && e.code) || 'unknown').slice(0, 60) }); return null; }
    })()),
    resolve: (kinds) => capped(resolveMany(db, kinds).catch((e) => { log('error', 'health resolve failed', { code: String((e && e.code) || 'unknown').slice(0, 60) }); return []; })),
  };
}

// ---------------------------------------------------------------- WhatsApp ---------------------------------------------------------------
// Called by the WhatsApp client after every send (whatsapp.js, cfg.onOutcome): { ok, status, code, definite }. One read and one write; the problems are opened or closed here.
function classify(o) {
  if (o.ok) return 'ok';
  // No error code at all (a network failure, a timeout, an answer with no message id) is NO code: Number(null) is 0, and 0 is one of Meta's key errors, so a blip used to look like an expired key.
  const given = o.code !== null && o.code !== undefined && String(o.code).trim() !== '';
  const code = given ? Number(o.code) : NaN;
  if (o.status === 401 || AUTH_CODES.has(code) || (code >= 200 && code <= 299)) return 'whatsapp_auth';
  if (ACCOUNT_CODES.has(code)) return 'whatsapp_account';
  if (TEMPLATE_CODES.has(code)) return 'whatsapp_template';
  if (o.media) return 'ignore';
  if (o.definite === false || code === 130429 || code === 4 || code === 80007) return 'unconfirmed';
  return 'ignore';                                                                // a refusal about one customer (not on WhatsApp, window closed...): not a fault of the system
}
async function noteWhatsApp(db, o, { health = null, nowMs = Date.now() } = {}) {
  const c = classify(o || {});
  if (c === 'ignore') return c;
  const ref = db.doc('health/whatsapp');
  const out = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref), d = s.exists ? s.data() : {}, issues = d.issues || {};
    if (c === 'ok') {
      const unreported = d.sendsSinceWebhook || 0;
      tx.set(ref, { lastSendOkAt: ts(nowMs), failStreak: 0, sendsSinceWebhook: unreported + 1, firstUnreportedAt: unreported ? d.firstUnreportedAt || ts(nowMs) : ts(nowMs), issues: FieldValue.delete() }, { merge: true });
      return { resolve: Object.keys(issues) };
    }
    if (c === 'unconfirmed') {
      const streak = (d.lastFailAt && nowMs - ms(d.lastFailAt) <= STREAK_WINDOW_MS ? d.failStreak || 0 : 0) + 1;
      const failing = streak >= STREAK;
      tx.set(ref, { failStreak: streak, lastFailAt: ts(nowMs), ...(failing ? { issues: { ...issues, whatsapp_failing: true } } : {}) }, { merge: true });
      return { report: failing ? 'whatsapp_failing' : null };
    }
    tx.set(ref, { lastFailAt: ts(nowMs), issues: { ...issues, [c]: true } }, { merge: true });
    return { report: c };
  });
  if (out.report) await (health ? health.report(out.report, o.code != null ? 'code ' + o.code : o.status ? 'HTTP ' + o.status : 'no answer') : report(db, out.report, { detail: o.code != null ? 'code ' + o.code : null, nowMs }));
  if (out.resolve && out.resolve.length) await (health ? health.resolve(out.resolve) : resolveMany(db, out.resolve, { nowMs }));
  return out.report || (out.resolve && out.resolve.length ? 'resolved' : c);
}

// The Firestore trigger on every message write (functions/index.js healthOnMessageWrite): anything that came FROM Meta (a customer message, a delivery tick, a refusal) proves that
// WhatsApp still reaches Elite OS. Our own writes (a message we sent, a media download) prove nothing and are ignored. One write, no read.
function fromMeta(before, after) {
  if (!after) return false;
  if (after.direction === 'in') return !before;                                                  // a customer message, as the webhook stored it
  if (after.direction !== 'out' || !after.status) return false;
  if (!before) return after.type === undefined;                                                  // a delivery status that arrived before our own record of the message
  return before.status !== after.status && ['delivered', 'read', 'failed'].includes(after.status);
}
async function onMessageWrite(db, before, after, nowMs = Date.now()) {
  if (!fromMeta(before, after)) return false;
  await db.doc('health/whatsapp').set({ lastWebhookAt: ts(nowMs), sendsSinceWebhook: 0, firstUnreportedAt: null }, { merge: true });
  return true;
}

// A scheduled check says it ran (functions/index.js). extra: a short result (never customer data).
async function beat(db, name, extra = {}, nowMs = Date.now()) {
  await db.doc('health/heartbeats').set({ [name + 'At']: ts(nowMs), ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [name + k[0].toUpperCase() + k.slice(1), String(v).slice(0, 40)])) }, { merge: true });
}

// ---------------------------------------------------------------- alerts -----------------------------------------------------------------
const pick = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const delivered = (r) => !!r && typeof r === 'object' && !r.duplicate && !r.failed && !r.timedOut && typeof r.sent === 'number' && r.sent > 0;
const mailOn = (mail) => !!(mail && mail.enabled && mail.sender && mail.gmail && Array.isArray(mail.to) && mail.to.length);

// The alert email: generic words only (the subject and text come from this file, never from a customer). One message per address.
async function sendAlertEmail(mail, subject, text) {
  for (const to of mail.to) {
    const raw = gmailLib.toRaw(gmailLib.buildTextMessage({ from: mail.sender, fromName: mail.fromName || 'Elite OS', to, subject, text }));
    await mail.gmail.sendRaw(raw, { timeoutMs: 20000 });
  }
}
async function claimEmail(db, ref, path, nowMs) {
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) return false;
    const a = pick(s.data(), path) || {};
    if (a.emailOk === true || (a.emailTries || 0) >= EMAIL_TRIES || (a.emailClaimedAt && nowMs - ms(a.emailClaimedAt) < EMAIL_CLAIM_MS)) return false;
    tx.update(ref, { [path + '.emailClaimedAt']: ts(nowMs), [path + '.emailTries']: (a.emailTries || 0) + 1 });
    return true;
  });
}
// Deliver one owed alert (a problem, a rejected lead, a hand-over whose push failed). The push is tried once per call with its own id (so two checks running together send it once);
// the email (if set up) is sent once: always for a problem, only when the push failed for the others. After ALERT_TRIES calls without any delivery the alert is marked failed (it stays
// on screen). Returns the alert's state.
async function deliverOwed(deps, ref, path, o) {
  const { db } = deps, nowMs = o.nowMs;
  const snap = await ref.get();
  if (!snap.exists || !o.owed(snap.data())) return 'not_owed';
  const a = pick(snap.data(), path) || {};
  if (a.state === 'sent' || a.state === 'failed') return a.state;
  if (o.pushOnly && a.pushOk) return a.state || 'pending';
  const tries = a.tries || 0;
  let pushOk = a.pushOk === true, emailOk = a.emailOk === true;
  if (!pushOk && deps.notify) {
    let r = null;
    try { r = await deps.notify({ kind: o.pushKind, sourceId: (typeof o.source === 'function' ? o.source(snap.data()) : o.source) + '|' + tries, phone: o.phone || null, backendReceivedAt: nowMs }); } catch (e) { r = null; }
    pushOk = delivered(r);
  }
  const email = !o.pushOnly && mailOn(deps.mail) && !emailOk && (o.email === 'always' || !pushOk);
  if (email && await claimEmail(db, ref, path, nowMs)) {
    try { await sendAlertEmail(deps.mail, o.subject, o.text); emailOk = true; }
    catch (e) { log('error', 'alert email failed', { code: String((e && (e.code || e.name)) || 'unknown').slice(0, 60) }); }
    // "sent" is recorded in the SAME write that releases the claim: a check running alongside can never see the claim gone without the email marked sent (it would send it again)
    await ref.update({ [path + '.emailClaimedAt']: null, ...(emailOk ? { [path + '.emailOk']: true } : {}) }).catch(() => {});
  }
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) return 'gone';
    const cur = pick(s.data(), path) || {};
    const p = pushOk || cur.pushOk === true, m = emailOk || cur.emailOk === true, n = Math.max(cur.tries || 0, tries + 1);
    const emailDone = m || !mailOn(deps.mail) || (cur.emailTries || 0) >= EMAIL_TRIES;
    let state = o.email === 'always' ? (p && emailDone ? 'sent' : 'pending') : (p || m ? 'sent' : 'pending');
    if (o.pushOnly && state === 'sent' && o.email === 'always') state = 'pending';                 // the immediate push alone never finishes a problem's alert: the check still owes the email
    if (state === 'pending' && n >= ALERT_TRIES) state = p || m ? 'sent' : 'failed';
    tx.update(ref, { [path + '.pushOk']: p, [path + '.emailOk']: m, [path + '.tries']: n, [path + '.state']: state, [path + '.lastTryAt']: ts(nowMs) });
    return state;
  });
}
const ISSUE_TEXT = (i) => `${i.title}.\n\n${i.help}\n\nOpen Elite OS and press "Needs attention" at the top of the Inbox for details.\n\nThis message was sent by Elite OS automatically. It contains no customer details.`;
function deliverIssueAlert(deps, kind, nowMs, { pushOnly = false } = {}) {
  const i = ISSUES[kind];
  return deliverOwed(deps, deps.db.collection('healthIssues').doc(kind), 'alert', { nowMs, pushOnly, owed: (d) => d.status === 'open', pushKind: 'alert',
    source: (d) => 'issue|' + kind + '|' + (d.occurrence || 1), email: i.email, subject: 'Elite OS: ' + i.title, text: ISSUE_TEXT(i) }).catch((e) => { log('error', 'problem alert failed', { kind, code: String((e && e.code) || 'unknown').slice(0, 60) }); return 'error'; });
}
// A rejected lead: push, and the email only when the push did not get through.
function deliverLeadAlert(deps, leadId, nowMs, { pushOnly = false } = {}) {
  return deliverOwed(deps, deps.db.collection('leadIssues').doc(leadId), 'alert', { nowMs, pushOnly, owed: (d) => d.status === 'open', pushKind: 'alert', source: 'lead|' + leadId, email: 'fallback',
    subject: 'Elite OS: a Meta lead needs attention', text: 'A new Meta lead could not be added automatically (no usable phone number), so they did not get the WhatsApp welcome.\n\nOpen Elite OS and press "Needs attention" at the top of the Inbox to see the lead and add them.\n\nThis message was sent by Elite OS automatically. It contains no customer details.' })
    .catch((e) => { log('error', 'lead alert failed', { code: String((e && e.code) || 'unknown').slice(0, 60) }); return 'error'; });
}
// A hand-over whose push failed three times (aiReceptionist marks receptionist.notifyFailed): try the push again (it opens the chat), then the email; when a push gets through the item
// is cleared by itself. "Seen" (a person) clears it too.
async function deliverHandoverAlert(deps, doc, nowMs) {
  const ref = doc.ref, phone = doc.id;
  const nf = (doc.data().receptionist || {}).notifyFailed || {};
  if (!nf.alert) await ref.update({ 'receptionist.notifyFailed.alert': { state: 'pending', tries: 0, pushOk: false, emailOk: false, emailTries: 0, emailClaimedAt: null, lastTryAt: null } }).catch(() => {});
  const state = await deliverOwed(deps, ref, 'receptionist.notifyFailed.alert', { nowMs, owed: (d) => !!(d.receptionist && d.receptionist.notifyFailed), pushKind: 'handover', phone,
    source: phone + '|nf' + ms(nf.at), email: 'fallback',
    subject: 'Elite OS: a chat is waiting for you', text: 'The receptionist passed a chat to you, but the alert did not reach your phone.\n\nOpen Elite OS and press "Needs attention" at the top of the Inbox to open the chat.\n\nThis message was sent by Elite OS automatically. It contains no customer details.' });
  if (state === 'sent') {
    const s = await ref.get(), a = pick(s.data() || {}, 'receptionist.notifyFailed.alert') || {};
    if (a.pushOk === true) await ref.update({ 'receptionist.notifyFailed': FieldValue.delete(), 'receptionist.notifyLate': { at: ts(nowMs) } });       // the phone got it in the end: nothing left to show
  }
  return state;
}

// ---------------------------------------------------------------- the check (every 10 minutes) -------------------------------------------
// deps: { db, notify, allowed (comma list of staff e-mails), mail: { enabled, sender, fromName, gmail, to: [] } }. Never throws: every part is tried, the result says what happened.
async function sweep(deps, nowMs = Date.now()) {
  const { db } = deps, out = { opened: [], resolved: [] };
  const step = async (name, fn) => { try { await fn(); } catch (e) { out[name] = 'error'; log('error', 'health check part failed', { part: name, code: String((e && e.code) || 'unknown').slice(0, 60) }); } };
  const open = async (kind, detail) => { const r = await report(db, kind, { detail, nowMs }); if (r.opened) out.opened.push(kind); };
  const close = async (kinds) => { out.resolved.push(...(await resolveMany(db, kinds, { nowMs }))); };
  const hb = await db.doc('health/heartbeats').get().then((s) => (s.exists ? s.data() : {}), () => ({}));
  const since = ms(hb.healthSweepSince) || nowMs;
  await db.doc('health/heartbeats').set({ healthSweepAt: ts(nowMs), ...(hb.healthSweepSince ? {} : { healthSweepSince: ts(nowMs) }) }, { merge: true }).catch(() => {});
  const ai = await db.doc('aiSettings/current').get().then((s) => (s.exists ? s.data() : {}), () => ({}));

  await step('receptionist', async () => {
    // Only the master switch (automatic handling of new Meta leads) makes these a fault. A problem the receptionist reported for a chat switched on by hand is closed only when its cause is gone.
    const auto = ai.autoReply === true, switchesOk = ai.enabled === true && ai.customerDataApproved === true && ai.replyAssistant === true;
    const last = ms(hb.receptionistSweepAt), result = hb.receptionistSweepResult || null;
    if (auto && ((last && nowMs - last > BEAT_STALE_MS) || (!last && nowMs - since > START_GRACE_MS))) await open('receptionist_stopped', last ? 'last ran ' + Math.round((nowMs - last) / MIN) + ' minutes ago' : 'never ran');
    else await close(['receptionist_stopped']);
    if (auto && !switchesOk) await open('receptionist_blocked', ai.enabled !== true ? 'AI switched off' : ai.customerDataApproved !== true ? 'real customer data off' : 'reply suggestions off');
    else if (switchesOk) await close(['receptionist_blocked']);
    if (result === 'no key') { if (auto) await open('ai_no_key'); }
    else if (result && result !== 'off') await close(['ai_no_key']);
  });
  await step('whatsapp', async () => {
    const w = await db.doc('health/whatsapp').get().then((s) => (s.exists ? s.data() : {}));
    const first = ms(w.firstUnreportedAt), unreported = w.sendsSinceWebhook || 0;
    if (unreported >= NO_REPORT_SENDS && first && nowMs - first >= NO_REPORT_MS && nowMs - first <= NO_REPORT_MAX_MS) await open('whatsapp_no_reports', unreported + ' messages sent with nothing back');
    else if (!unreported || (w.lastWebhookAt && ms(w.lastWebhookAt) >= first)) await close(['whatsapp_no_reports']);
  });
  await step('devices', async () => {
    const allowed = String(deps.allowed || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const devs = await db.collection('pushDevices').where('enabled', '==', true).get();
    if (!devs.docs.some((d) => allowed.includes(String(d.data().email).toLowerCase()))) await open('no_alert_devices'); else await close(['no_alert_devices']);
    const ev = (await db.collection('pushEvents').orderBy('createdAt', 'desc').limit(10).get()).docs.map((d) => d.data()).filter((e) => e.kind !== 'test' && nowMs - ms(e.createdAt) <= 24 * HOUR && e.status !== 'sending');
    // the newest alerts, one after another, all failed (an older one that got through does not hide a run of failures since)
    let run = 0; for (const e of ev) { if (['failed', 'no-devices', 'timeout', 'error'].includes(e.status)) run++; else break; }
    if (ev.length && ev[0].status === 'sent') await close(['alerts_failing']);
    else if (run >= 3) await open('alerts_failing', run + ' alerts in a row');
  });
  // what is owed: problem alerts, rejected-lead alerts, hand-over alerts whose push failed
  await step('alerts', async () => {
    const issues = await db.collection('healthIssues').where('status', '==', 'open').get();
    for (const d of issues.docs) if (ISSUES[d.id] && !['sent', 'failed'].includes((d.data().alert || {}).state)) out['alert:' + d.id] = await deliverIssueAlert(deps, d.id, nowMs);
    const leads = await db.collection('leadIssues').where('status', '==', 'open').limit(50).get();
    for (const d of leads.docs) if (!['sent', 'failed'].includes((d.data().alert || {}).state)) { out.leadAlerts = (out.leadAlerts || 0) + 1; await deliverLeadAlert(deps, d.id, nowMs); }
    const failed = await db.collection('conversations').orderBy('receptionist.notifyFailed.at', 'desc').limit(50).get();
    for (const d of failed.docs) {
      const a = ((d.data().receptionist || {}).notifyFailed || {}).alert || {};
      if (!['sent', 'failed'].includes(a.state)) { out.handoverAlerts = (out.handoverAlerts || 0) + 1; await deliverHandoverAlert(deps, d, nowMs); }
    }
  });
  await step('tidy', async () => {
    // The "no Meta leads" warning was removed (19 Oct 2026): erase what it left behind (an open problem with its alert state, and the hours setting) so nothing of it can show or notify. Two reads every 10 minutes, a delete only the first time.
    for (const p of ['healthIssues/lead_silence', 'healthSettings/current']) { const s = await db.doc(p).get(); if (s.exists) await s.ref.delete(); }
    out.purgedLeads = await LeadIssues.purge(db, nowMs);
    const old = await db.collection('healthIssues').where('resolvedAt', '<', ts(nowMs - RESOLVED_PURGE_MS)).limit(50).get();
    for (const d of old.docs) await d.ref.delete();
  });
  return out;
}

// ---------------------------------------------------------------- "Needs attention" (staff) ----------------------------------------------
// One callable for the screen's buttons: { action: 'fixed', kind } | { action: 'lead', leadId, outcome } | { action: 'seen', phone }.
async function attention({ db }, actor, data, { nowMs = Date.now() } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpsError('invalid-argument', 'Missing details.');
  const only = (keys) => { for (const k of Object.keys(data)) if (!keys.includes(k)) throw new HttpsError('invalid-argument', `Unknown field: ${k}`); };
  switch (data.action) {
    case 'fixed': {
      only(['action', 'kind']);
      if (!ISSUES[data.kind]) throw new HttpsError('invalid-argument', 'Unknown problem.');
      const done = await resolveMany(db, [data.kind], { by: actor.id, nowMs });
      return { ok: true, resolved: done.length === 1 };
    }
    case 'lead':
      only(['action', 'leadId', 'outcome']);
      return LeadIssues.resolve(db, actor, data, nowMs);
    case 'seen': {
      only(['action', 'phone']);
      const phone = String(data.phone || '').replace(/\D/g, '');
      if (phone.length < 9) throw new HttpsError('invalid-argument', 'Missing customer.');
      const ref = db.collection('conversations').doc(phone);
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (!s.exists) throw new HttpsError('not-found', 'Customer not found.');
        if (!(s.data().receptionist || {}).notifyFailed) return { ok: true, unchanged: true };
        tx.update(ref, { 'receptionist.notifyFailed': FieldValue.delete(), 'receptionist.notifySeen': { at: ts(nowMs), by: actor.id } });
        return { ok: true };
      });
    }
    default: throw new HttpsError('invalid-argument', 'Unknown action.');
  }
}

// The receptionist's AI refusals, as problems (aiReceptionist.js): the words of ai.js's own refusals, never a customer's.
function aiProblem(message) {
  const m = String(message || '');
  if (/budget is used up/i.test(m)) return 'ai_budget';
  if (/no key/i.test(m)) return 'ai_no_key';
  if (/switched off|not switched on/i.test(m)) return 'receptionist_blocked';
  return 'ai_failing';
}

module.exports = { ISSUES, WHATSAPP_KINDS, AI_KINDS, AUTH_CODES, ACCOUNT_CODES, TEMPLATE_CODES, STREAK, NO_REPORT_MS, NO_REPORT_SENDS, BEAT_STALE_MS, START_GRACE_MS,
  ALERT_TRIES, EMAIL_TRIES, report, resolveMany, hook, classify, noteWhatsApp, fromMeta, onMessageWrite, beat, deliverOwed, deliverIssueAlert, deliverLeadAlert, deliverHandoverAlert,
  sendAlertEmail, sweep, attention, aiProblem };
