'use strict';
// Phase 9 R3: the automatic receptionist (docs/AI.md). A check that runs every minute and answers the customers the owner has switched it on for, ONE chat at a time, and only in the simple cases:
// the fixed consultation lines (ask about next week, ask about the following week, "I'll pass that on", "no preference", the honest "I'm an automated assistant" line, and the question for a customer
// changing a booked consultation). Everything else is handed over to a person WITHOUT a reply, and the owner gets a push. Nothing here is new AI behaviour: it asks the same reply
// suggestion (ai.suggestReply, same switches, same budget, same checks) and sends its answer only when every rule below holds. The owner books and confirms appointments himself.
// Rules (each one has a test):
//   * Off unless: the AI is on, real customer data is on, reply suggestions are on, "automatic replies" is on, AND the chat itself was switched on by the owner (conversations/{phone}.receptionist.on).
//   * Only messages the customer sends AFTER the chat was switched on are answered; the check reads only the chats that are switched on, never the others.
//   * Not between midnight and 7:00 (Irish time): the message waits and is answered after 7:00. At least 45 seconds after the customer's last message (a burst of messages is answered once).
//   * Never when a person has replied in the chat (it then stays out until the owner switches it on again), never after a hand-over, never when the WhatsApp 24-hour window is closed.
//   * At most 6 automatic messages to one customer a day. Never twice for the same customer message (a claim is made first, as for staff sends).
//   * A draft with any warning (a link, money, a promise, today/tomorrow, a repeated question, ...) is not sent: the chat is handed over instead.
const { Timestamp } = require('firebase-admin/firestore');
const ai = require('./ai');
const outbound = require('./outbound');
const store = require('./store');

const TZ = 'Europe/Dublin';
const WAIT_MS = 45000, DAILY_CAP = 6, QUIET_UNTIL_HOUR = 7, MAX_CHATS = 25, MAX_TRIES = 3, WINDOW_MS = 24 * 3600e3;
const ACTOR = { kind: 'system', id: 'receptionist' };
// The only steps whose words are sent by themselves: all written by code (aiSchedule.js), none by the model.
const SEND_STEPS = new Set(['ask_next_week', 'ask_following_week', 'acknowledge', 'no_preference', 'asked_ai', 'change_ask', 'change_given', 'change_pass_on']);
// After these the chat is the owner's: the receptionist stays out.
const PAUSE_STEPS = new Set(['acknowledge', 'no_preference', 'asked_ai', 'change_given', 'change_pass_on']);
const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : typeof t === 'number' ? t : 0);
const log = (level, msg, extra) => console.log(JSON.stringify({ level, msg, ...extra }));
const hourOf = (t) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date(t)));
const quiet = (t) => hourOf(t) < QUIET_UNTIL_HOUR;

// Hand the chat over: stop the receptionist for this chat and tell the owner (a push with no names and no words).
async function handOver(deps, ref, phone, why, nowMs, { notify = true } = {}) {
  await ref.update({ 'receptionist.paused': why, 'receptionist.pausedAt': Timestamp.fromMillis(nowMs) });
  if (notify && deps.push) { try { await deps.push.notify({ kind: 'handover', sourceId: phone + '|' + nowMs, phone, backendReceivedAt: nowMs }); } catch (e) { log('error', 'handover push failed'); } }
}

// One chat. Returns a short reason (what was done or why not), never throws.
async function processChat(deps, phone, nowMs = Date.now()) {
  const { db, wa, model, owners } = deps, ref = db.doc('conversations/' + phone);
  let locked = false;
  try {
    const snap = await ref.get();
    if (!snap.exists) return 'gone';
    const c = snap.data(), r = c.receptionist || {}, at = ms(r.at), lastIn = ms(c.lastInboundAt);
    if (r.on !== true) return 'off';
    if (r.paused) return 'paused';
    if (!lastIn || lastIn <= at) return 'nothing_new';                           // only messages sent after it was switched on
    if (lastIn <= (r.handledMs || 0)) return 'handled';
    if (nowMs - lastIn < WAIT_MS) return 'wait';
    if (nowMs - lastIn >= WINDOW_MS) return 'window_closed';
    // a person has taken the chat over (anything sent by staff since it was switched on)
    const recent = await ref.collection('messages').orderBy('createdAt', 'desc').limit(10).get();
    if (recent.docs.some((d) => { const x = d.data(); return x.direction === 'out' && !x.auto && ms(x.createdAt) > at; })) { await handOver(deps, ref, phone, 'a person replied', nowMs, { notify: false }); return 'staff_replied'; }
    const day = ai.dayId(nowMs);
    if (r.day === day && (r.count || 0) >= DAILY_CAP) return 'daily_limit';
    // one run at a time per chat (two overlapping checks must never both answer): a short lock that expires by itself
    // The state is read AGAIN inside the lock: a check that was waiting must not act on what it read before another one finished.
    const got = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref), cur = (s.exists && s.data().receptionist) || {};
      if (cur.on !== true || cur.paused) return 'paused'; if (ms(cur.lockUntil) > nowMs) return 'busy'; if (lastIn <= (cur.handledMs || 0)) return 'handled';
      tx.update(ref, { 'receptionist.lockUntil': nowMs + 90000 }); return 'ok';
    });
    if (got !== 'ok') return got;
    locked = true;
    // the decision: the same reply suggestion staff get, asked for by the receptionist
    let res;
    try { res = await ai.suggestReply({ db, model, owners }, ACTOR, { phone }, { uid: 'receptionist', nowMs }); }
    catch (e) {
      if (e && e.code === 'failed-precondition') { await handOver(deps, ref, phone, 'ai unavailable: ' + String(e.message || '').slice(0, 80), nowMs); return 'refused'; }
      const tries = (r.triesFor === lastIn ? r.tries || 0 : 0) + 1;
      if (tries >= MAX_TRIES) { await handOver(deps, ref, phone, 'ai failed ' + tries + ' times', nowMs); return 'failed'; }
      await ref.update({ 'receptionist.tries': tries, 'receptionist.triesFor': lastIn }); return 'retry';
    }
    const step = res.schedule && res.schedule.step, warnings = res.warnings || [], needs = !!(res.handover && res.handover.needed);
    const report = (outcome) => ai.draftOutcome({ db }, ACTOR, { draftId: res.draftId, outcome }, { uid: 'receptionist' }).catch(() => {});
    if (!SEND_STEPS.has(step) || !res.draft || !res.structured || warnings.length) {          // not one of the simple cases, or the draft failed a check: nothing is sent, a person takes over
      await report('discarded');
      await handOver(deps, ref, phone, needs ? 'handover: ' + String((res.handover && res.handover.reason) || 'needs you').slice(0, 80) : (warnings.length ? 'draft failed a check' : 'needs a person'), nowMs);
      return 'handed_over';
    }
    // send: claim first (never twice for the same customer message), then WhatsApp, then record
    const requestId = 'auto_' + lastIn;
    let claim; try { claim = await outbound.begin(db, phone, requestId, nowMs); } catch (e) { await report('discarded'); if (e && e.details && e.details.reason === 'in_progress') return 'busy'; await handOver(deps, ref, phone, 'send not confirmed', nowMs); return 'send_unconfirmed'; }
    if (claim.done) { await ref.update({ 'receptionist.handledMs': lastIn }); return 'already_sent'; }
    let wamid;
    try { wamid = await wa.sendText(phone, res.draft); }
    catch (e) {
      const definite = !!e && e.definite === true;
      await outbound.settle(db, phone, requestId, { state: definite ? 'failed' : 'unknown' });
      log('error', definite ? 'receptionist text refused' : 'receptionist text not confirmed', { code: (e && e.code) || null });
      await report('discarded'); await handOver(deps, ref, phone, definite ? 'send failed' : 'send not confirmed', nowMs); return 'send_failed';
    }
    await outbound.settle(db, phone, requestId, { state: 'sent', wamid });
    await store.storeOutbound(db, phone, { wamid, type: 'text', body: res.draft, extra: { auto: true } }).catch(() => log('error', 'receptionist text sent but not recorded', { wamid }));
    await ref.update({ 'receptionist.handledMs': lastIn, 'receptionist.day': day, 'receptionist.count': (r.day === day ? r.count || 0 : 0) + 1, 'receptionist.last': { step, at: Timestamp.fromMillis(nowMs) }, 'receptionist.tries': 0 });
    await report('used_unchanged');                                              // moves the consultation flow on (and leaves the request for the owner to book)
    if (PAUSE_STEPS.has(step)) await handOver(deps, ref, phone, step === 'asked_ai' ? 'asked if AI' : 'consultation passed to you', nowMs, { notify: false });
    if (needs && deps.push) { try { await deps.push.notify({ kind: 'handover', sourceId: phone + '|' + nowMs, phone, backendReceivedAt: nowMs }); } catch (e) { log('error', 'handover push failed'); } }
    return 'sent:' + step;
  } catch (e) {
    log('error', 'receptionist chat failed', { code: String((e && e.code) || 'unknown').slice(0, 60) });
    return 'error';
  } finally { if (locked) await ref.update({ 'receptionist.lockUntil': 0 }).catch(() => {}); }
}

// The every-minute check. Returns a count of what happened, for the log (no names, no words).
async function sweep(deps, nowMs = Date.now()) {
  const s = await ai.loadSettings(deps.db);
  if (!s.enabled || !s.customerDataApproved || !s.replyAssistant || !s.autoReply) return { skipped: 'off' };
  if (!deps.model) return { skipped: 'no key' };
  if (quiet(nowMs)) return { skipped: 'quiet hours' };
  const chats = await deps.db.collection('conversations').where('receptionist.on', '==', true).limit(MAX_CHATS).get();
  const out = {};
  for (const d of chats.docs) { const why = await processChat(deps, d.id, nowMs); out[why] = (out[why] || 0) + 1; }
  return { chats: chats.size, ...out };
}

module.exports = { processChat, sweep, quiet, hourOf, SEND_STEPS, PAUSE_STEPS, WAIT_MS, DAILY_CAP, QUIET_UNTIL_HOUR };
