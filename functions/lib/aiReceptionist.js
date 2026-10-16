'use strict';
// Phase 9 R3: the automatic receptionist (docs/AI.md). A check that runs every minute. It handles NEW Meta leads on its own: the customer fills in the Meta form, Make sends our approved welcome
// template (leadIntake), the customer replies, and from then on the receptionist reads the lead details and the whole WhatsApp conversation, acknowledges what they said, guides them to a home
// consultation using the FIXED consultation lines, collects their preferred days and times, and hands the chat over to the owner (who books and confirms himself) with a push. Everything else is
// handed over WITHOUT a reply. Nothing here is new AI behaviour: it asks the same reply suggestion staff get (ai.suggestReply, same switches, budget and checks, plus a short "automatic mode" note)
// and sends its answer only when every rule below holds. Rules (each one has a test):
//   * ONE master switch (Assistant > Settings > Automatic receptionist, owner only) on top of the AI, real-customer-data and reply switches. Off = it does nothing at all.
//   * Which chats: only Meta leads whose conversation was CREATED after the master switch went on (conversations/{phone}.createdAt >= aiSettings.autoReplySince) and whose lead arrived after it too
//     (contacts.metaLead.receivedAt). Existing conversations are never activated, retroactively or otherwise. The owner can also switch any single chat on (the chat's Receptionist button).
//   * Each chat has its own control: switched off (or paused) stays off until the owner switches it on again; a chat the receptionist handed over stays the owner's.
//   * If a person sends ANYTHING in the chat (other than our own welcome template), automatic replies stop for good until the owner reactivates that chat.
//   * Only messages the customer sends AFTER the chat was activated are answered; at least 45 seconds after the last one (a burst is answered once); never between midnight and 7:00 Irish time
//     (it waits and answers after 7:00); WhatsApp's 24-hour window must be open; at most 6 automatic messages to one customer a day.
//   * Never twice for one customer message: duplicate webhooks are ignored by the inbox, a claim is made before sending (as for staff sends) and a short per-chat lock stops overlapping checks.
//   * The words: a short acknowledgement WRITTEN BY CODE (the model only picks which one) followed by the fixed consultation line, or one of the other fixed lines (ask the following week, "I'll pass
//     that on", "no preference", the honest "automated assistant" line, the booking-change question), or an answer that passed the answer checker. Just before sending, the whole message (fixed lines
//     aside) is checked once more; a draft with any warning, or with no such check, is not sent.
//   * It never invents a price, promises availability, books or changes anything. Prices, discounts, delivery and fitting questions, complaints, photos, "are you a person" and anything unsure are handed
//     over: no reply, a push to the owner.
// HOW IT RUNS (event-driven, with a backup): a Firestore trigger (functions/index.js receptionistOnMessage) calls onInbound() the moment a customer message is saved. It waits the reply delay (30 seconds by
// default; one number, aiSettings.replyDelaySeconds, 5 to 90) so that a burst of messages is answered ONCE, and only the run for the LAST message goes on. A scheduled job every 5 minutes (sweep) is the backup: it
// answers anything the event path missed, and everything that arrived during quiet hours. Both call the same processChat(), so they cannot both answer: a per-chat lock, the "already answered" record and the
// claim before sending see to that. Just before sending, the chat is read AGAIN: a message from a person, or a newer message from the customer, stops this reply (a person replying while the reply was being
// written must never be talked over, and a newer message gets its own answer with the full picture).
const { Timestamp } = require('firebase-admin/firestore');
const ai = require('./ai');
const outbound = require('./outbound');
const store = require('./store');
const { SEND_STEPS, PAUSE_STEPS } = require('./aiSchedule');

const TZ = 'Europe/Dublin';
const WAIT_MS = 30000, DEBOUNCE_MS = 30000, MIN_DELAY_MS = 5000, MAX_DELAY_MS = 90000, DAILY_CAP = 6, QUIET_UNTIL_HOUR = 7, MAX_CHATS = 150, MAX_TRIES = 3, WINDOW_MS = 24 * 3600e3;
const ACTOR = { kind: 'system', id: 'receptionist' };
// The only steps whose words are sent by themselves. All of them are written by code (aiSchedule.js); the first may carry a short checked acknowledgement in front.
// After these the chat is the owner's: the receptionist stays out.
// Step A: the receptionist offers a home visit ONCE and asks about days only after the customer has agreed; cancel_ask / tentative / ack_only / offer steps do not pause the chat (the customer may answer).
// An ordinary message that needs no reply and no person (e.g. "thanks" from a customer who is already booked): not answered, not handed over.
const QUIET_INTENTS = new Set(['greeting', 'new_enquiry', 'answering_questions', 'wants_consultation', 'scheduling', 'asking_price_general']);
// A message that is ONLY a pleasantry ("Thanks", "ok great", "Thanks, see you then", a thumbs-up) needs no answer and no person, whatever intent the model gave it (the audit run of 16 Oct 2026: the model
// labelled "Thanks" as "other" and the owner was alerted for a thank-you). Read from the customer's own words; anything else in the message (a question, "not now", a photo) is not a pleasantry.
const COURTESY_ONE = String.raw`(?:lol|lols|lolz|ha(?:ha)+h?|he(?:he)+|lmao|xd|ok(?:ay)?|k|kk|grand|great|brilliant|lovely|perfect|super|cool|nice(?: one)?|sound|class|deadly|fab(?:ulous)?|excellent|fantastic|amazing|good|cheers|ta|thanks?|thank you|thx|thank u|ty|many thanks|thanks? (?:a lot|a million|very much|so much|again|for that|for (?:the|your) (?:help|reply|info|message))|thank you (?:very much|so much|again)|no worries|no problem|will do|got it|noted|understood|see you (?:then|soon|on \w+)|talk (?:soon|later)|speak soon|have a (?:good|great|nice) (?:day|one|weekend|evening))`;
const COURTESY = new RegExp(`^${COURTESY_ONE}(?:\\s+${COURTESY_ONE})*$`, 'i');          // one or more of them: "ok great", "perfect thanks"
function courtesyOnly(messages) {
  if (!messages.length || messages.some((m) => m.type && m.type !== 'text' && m.type !== 'sticker')) return false;          // a sticker is like an emoji
  return messages.every((m) => { const parts = String(m.body || '').toLowerCase().replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ').split(/[,.!]+|\s+(?:and|&)\s+/).map((x) => x.trim()).filter(Boolean); return parts.every((p) => COURTESY.test(p)); });
}
const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : typeof t === 'number' ? t : 0);
const log = (level, msg, extra) => console.log(JSON.stringify({ level, msg, ...extra }));
const hourOf = (t) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date(t)));
const quiet = (t) => hourOf(t) < QUIET_UNTIL_HOUR;
// Our own welcome template (sent by the lead intake) is not "a person took over".
const isWelcome = (x, welcomeTemplate) => x.type === 'template' && !!welcomeTemplate && typeof x.body === 'string' && x.body.startsWith('[template: ' + welcomeTemplate + ']');

// Hand the chat over: stop the receptionist for this chat and tell the owner (a push with no names and no words).
async function handOver(deps, ref, phone, why, nowMs, { notify = true } = {}) {
  await ref.update({ 'receptionist.paused': why, 'receptionist.pausedAt': Timestamp.fromMillis(nowMs) });
  if (notify) await ping(deps, phone, nowMs);
}
async function ping(deps, phone, nowMs, key = nowMs) {
  if (!deps.push) return true;
  try { await deps.push.notify({ kind: 'handover', sourceId: phone + '|' + key, phone, backendReceivedAt: nowMs }); return true; } catch (e) { log('error', 'handover push failed'); return false; }
}
// A person has written to this customer since the receptionist was switched on (recorded before every staff send: outbound.noteHuman).
const personWrote = (rec) => ms(rec && rec.humanAt) > ms(rec && rec.at);

// What must happen after an automatic message went out (audit 16 Oct 2026, finding 4): the consultation request for the owner, the pause, the push, and the record that this customer message is answered. The plan is stored in the
// claim BEFORE WhatsApp is contacted, and each part can be repeated safely, so a run that dies after WhatsApp accepted the message is finished by the next run (it never sends again, and the owner is never left unaware).
async function applyEffects(deps, ref, phone, eff, nowMs) {
  const { db } = deps;
  if (eff.draftId) { try { await ai.draftOutcome({ db }, ACTOR, { draftId: eff.draftId, outcome: 'used_unchanged' }, { uid: 'receptionist' }); } catch (e) { if (!(e && e.code === 'not-found')) throw e; } }     // a repeat is answered as a repeat
  if (eff.pause) await handOver(deps, ref, phone, eff.pause, nowMs, { notify: false });
  const claimRef = outbound.claimRef(db, phone, 'auto_' + eff.lastIn);
  if (eff.notify && !(await ping(deps, phone, nowMs, eff.lastIn))) {                      // the owner was not told: try again on the next run (the same push key, so never twice), three times at most
    const cs = await claimRef.get(), n = ((cs.exists && cs.data().pushTries) || 0) + 1;
    await claimRef.update({ pushTries: n }).catch(() => {});
    if (n < 3) throw new Error('push not delivered');
  }
  await db.runTransaction(async (tx) => {
    const [cs, c] = await Promise.all([tx.get(claimRef), tx.get(ref)]);
    if (cs.exists && cs.data().effectsDone === true) return;                                  // finished already
    const cur = (c.exists && c.data().receptionist) || {};
    if (c.exists) tx.update(ref, { 'receptionist.handledMs': Math.max(cur.handledMs || 0, eff.lastIn), 'receptionist.day': eff.day, 'receptionist.count': (cur.day === eff.day ? cur.count || 0 : 0) + 1, 'receptionist.last': { step: eff.step, at: Timestamp.fromMillis(nowMs), delayMs: Math.max(0, nowMs - eff.lastIn) }, 'receptionist.tries': 0 });
    if (cs.exists) tx.update(claimRef, { effectsDone: true });
  });
}

// A NEW Meta lead's chat is switched on by itself the first time the customer has written (never an existing conversation, never a customer who is not a Meta lead). Decided once and recorded,
// so an explicit "off" from the owner is never undone. Returns true if the chat was switched on now.
async function activateIfNewLead(deps, doc, since) {
  const { db } = deps, c = doc.data();
  if (c.receptionist || !since || ms(c.createdAt) < since) return false;                      // decided before, or a conversation that existed before the switch went on
  const cs = await db.doc('contacts/' + doc.id).get(), lead = cs.exists && cs.data().metaLead, receivedAt = lead && ms(lead.receivedAt);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(doc.ref);
    if (!s.exists || s.data().receptionist) return false;                                     // another check got here first
    if (!receivedAt || receivedAt < since) { tx.update(doc.ref, { receptionist: { on: false, skipped: 'not a new Meta lead' } }); return false; }
    tx.update(doc.ref, { receptionist: { on: true, auto: true, at: Timestamp.fromMillis(receivedAt), by: 'auto', paused: null, handledMs: 0, count: 0, day: null } });
    return true;
  });
}

// One chat. Returns a short reason (what was done or why not), never throws.
async function processChat(deps, phone, nowMs = Date.now(), { waitMs = WAIT_MS } = {}) {
  const { db, wa, model, owners } = deps, ref = db.doc('conversations/' + phone), t0 = Date.now(), nowAt = () => nowMs + (Date.now() - t0);       // nowAt: the time now, on the same clock as nowMs
  let locked = false;
  try {
    const snap = await ref.get();
    if (!snap.exists) return 'gone';
    const c = snap.data(), r = c.receptionist || {}, at = ms(r.at), lastIn = ms(c.lastInboundAt);
    if (r.on !== true) return 'off';
    if (r.paused) {
      // A send whose job did not finish (the claim says sent, the effects are not done) is finished even though the chat is already paused by its own effects.
      if (lastIn > at && lastIn > (r.handledMs || 0)) { const prior = await outbound.peek(db, phone, 'auto_' + lastIn); if (prior && prior.state === 'sent' && !prior.effectsDone && prior.effects) { await applyEffects(deps, ref, phone, prior.effects, nowAt()); return 'already_sent'; } }
      return 'paused';
    }
    if (personWrote(r)) { await handOver(deps, ref, phone, 'a person replied', nowMs, { notify: false }); return 'staff_replied'; }          // recorded before the person's message was sent: it cannot fall out of a window of messages
    if (!lastIn || lastIn <= at) return 'nothing_new';                           // only messages sent after it was switched on
    if (lastIn <= (r.handledMs || 0)) return 'handled';
    if (nowMs - lastIn < waitMs) return 'wait';
    if (nowMs - lastIn >= WINDOW_MS) return 'window_closed';
    // a person has taken the chat over (anything sent by staff since it was switched on, except our own welcome template)
    const recent = await ref.collection('messages').orderBy('createdAt', 'desc').limit(12).get();
    if (recent.docs.some((d) => { const x = d.data(); return x.direction === 'out' && !x.auto && !isWelcome(x, deps.welcomeTemplate) && ms(x.createdAt) > at; })) { await handOver(deps, ref, phone, 'a person replied', nowMs, { notify: false }); return 'staff_replied'; }
    const day = ai.dayId(nowMs);
    if (r.day === day && (r.count || 0) >= DAILY_CAP) return 'daily_limit';
    // one run at a time per chat (two overlapping checks must never both answer). The state is read AGAIN inside the lock: a check that was waiting must not act on what it read before another one finished.
    const got = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref), cur = (s.exists && s.data().receptionist) || {};
      if (cur.on !== true || cur.paused || personWrote(cur)) return 'paused'; if (ms(cur.lockUntil) > nowMs) return 'busy'; if (lastIn <= (cur.handledMs || 0)) return 'handled';
      tx.update(ref, { 'receptionist.lockUntil': nowMs + 90000 }); return 'ok';
    });
    if (got !== 'ok') return got;
    locked = true;
    // This customer message may already have been answered by an earlier run that died before it finished the job (the claim says so): finish it, ask the model nothing, send nothing.
    const prior = await outbound.peek(db, phone, 'auto_' + lastIn);
    if (prior && prior.state === 'sent') {
      if (!prior.effectsDone && prior.effects) await applyEffects(deps, ref, phone, prior.effects, nowAt()); else await ref.update({ 'receptionist.handledMs': lastIn });
      return 'already_sent';
    }
    // the decision: the same reply suggestion staff get, asked for by the receptionist (automatic mode)
    let res;
    try { res = await ai.suggestReply({ db, model, owners }, ACTOR, { phone }, { uid: 'receptionist', nowMs, receptionist: true }); }
    catch (e) {
      if (e && e.code === 'failed-precondition') { await handOver(deps, ref, phone, 'ai unavailable: ' + String(e.message || '').slice(0, 80), nowMs); return 'refused'; }
      const tries = (r.triesFor === lastIn ? r.tries || 0 : 0) + 1;
      if (tries >= MAX_TRIES) { await handOver(deps, ref, phone, 'ai failed ' + tries + ' times', nowMs); return 'failed'; }
      await ref.update({ 'receptionist.tries': tries, 'receptionist.triesFor': lastIn }); return 'retry';
    }
    const step = res.schedule && res.schedule.step, needs = !!(res.handover && res.handover.needed);
    // The whole message was checked once more (fixed lines aside) before it may be sent; a missing result counts as a failure (audit 16 Oct 2026, finding 1).
    const warnings = [...(res.warnings || []), ...(res.draft && !(res.sendCheck && res.sendCheck.ok === true) && !(res.warnings || []).some((w) => w.startsWith('send check:')) ? ['send check: not done'] : [])];
    const report = (outcome) => ai.draftOutcome({ db }, ACTOR, { draftId: res.draftId, outcome }, { uid: 'receptionist' }).catch(() => {});
    if (!SEND_STEPS.has(step) || !res.draft || !res.structured || warnings.length) {
      const burst = []; for (const x of recent.docs.map((d) => d.data())) { if (x.direction !== 'in') break; burst.push(x); }              // the customer's messages since our last one
      if (step === 'none' && !needs && !warnings.length && res.structured && (QUIET_INTENTS.has(res.intent) || courtesyOnly(burst) || (res.schedule && res.schedule.quiet === true))) {        // ordinary chatter that needs no answer (e.g. a thank-you after booking): nothing sent, nobody bothered
        await report('discarded'); await ref.update({ 'receptionist.handledMs': lastIn }); return 'quiet_skip';
      }
      await report('discarded');                                                           // not a simple case, or the draft failed a check: nothing is sent, a person takes over
      await handOver(deps, ref, phone, needs ? 'handover: ' + String((res.handover && res.handover.reason) || 'needs you').slice(0, 80) : (warnings.length ? 'draft failed a check' : 'needs a person'), nowMs);
      return 'handed_over';
    }
    // Just before sending: read the chat AGAIN. The reply took a few seconds to write; in that time the customer may have written again (then THAT message gets its own answer, with everything they said), a person may have
    // replied (a person is never talked over), or the owner may have paused the chat. Nothing is sent, nothing is marked answered.
    const [fresh, latest] = await Promise.all([ref.get(), ref.collection('messages').orderBy('createdAt', 'desc').limit(12).get()]), fc = fresh.exists ? fresh.data() : {}, fr = fc.receptionist || {};
    if (fr.on !== true || fr.paused) { await report('discarded'); return 'paused'; }
    if (personWrote(fr)) { await report('discarded'); await handOver(deps, ref, phone, 'a person replied', nowMs, { notify: false }); return 'staff_replied'; }
    if (latest.docs.some((d) => { const x = d.data(); return x.direction === 'out' && !x.auto && !isWelcome(x, deps.welcomeTemplate) && ms(x.createdAt) > at; })) { await report('discarded'); await handOver(deps, ref, phone, 'a person replied', nowMs, { notify: false }); return 'staff_replied'; }
    if (ms(fc.lastInboundAt) > lastIn) { await report('discarded'); return 'newer_message'; }
    // send: claim first (never twice for the same customer message), then WhatsApp, then record. The claim is made inside a transaction that LOOKS AGAIN at everything that could have changed while the
    // answer was being written (audit 16 Oct 2026, finding 3): the switches (the AI switch, real customer data, reply suggestions, the master switch for an automatic chat), quiet hours and the 24-hour window
    // on the clock as it is NOW, the chat's pause, a person writing (recorded, or a staff send still in progress), a newer customer message and the daily limit. Any of them: nothing is claimed, nothing is sent.
    const requestId = 'auto_' + lastIn, pauseWhy = (PAUSE_STEPS.has(step) || (step === 'answer' && needs)) ? (step === 'asked_ai' ? 'asked if AI' : ['acknowledge', 'no_preference', 'change_given', 'change_pass_on'].includes(step) ? 'consultation passed to you' : 'handover: ' + String((res.handover && res.handover.reason) || 'needs you').slice(0, 80)) : null;
    const eff = { step, draftId: res.draftId, pause: pauseWhy, notify: needs, lastIn, day: ai.dayId(nowAt()) };
    const guard = async (tx, convSnap) => {
      const cur = convSnap.data() || {}, fr2 = cur.receptionist || {}, t = nowAt();
      if (fr2.on !== true || fr2.paused) return 'paused';
      const [sd, sending] = await Promise.all([tx.get(db.doc('aiSettings/current')), tx.get(ref.collection('sendRequests').where('state', '==', 'sending'))]);
      const st = sd.exists ? sd.data() : {};
      if (st.enabled !== true || st.customerDataApproved !== true || st.replyAssistant !== true || (fr2.auto === true && st.autoReply !== true)) return 'switch_off';
      if (quiet(t)) return 'quiet';
      if (t - lastIn >= WINDOW_MS) return 'window';
      if (personWrote(fr2) || (cur.reopen && cur.reopen.state === 'sending') || outbound.staffSending(sending.docs, t)) return 'human';
      if (ms(cur.lastInboundAt) > lastIn) return 'newer_message';
      if (fr2.day === ai.dayId(t) && (fr2.count || 0) >= DAILY_CAP) return 'daily_limit';
      return null;
    };
    let claim;
    try { claim = await outbound.begin(db, phone, requestId, nowMs, { guard, effects: eff }); }
    catch (e) {
      await report('discarded');
      const why = e && e.details && e.details.reason === 'guard' ? e.details.why : null;
      if (why === 'human') { await handOver(deps, ref, phone, 'a person replied', nowMs, { notify: false }); return 'staff_replied'; }
      if (why) return { paused: 'paused', switch_off: 'off', quiet: 'quiet', window: 'window_closed', newer_message: 'newer_message', daily_limit: 'daily_limit' }[why] || 'blocked';
      if (e && e.details && e.details.reason === 'in_progress') return 'busy';
      await handOver(deps, ref, phone, 'send not confirmed', nowMs); return 'send_unconfirmed';
    }
    if (claim.done) {                                                                       // answered by an earlier run: finish its job, send nothing
      await report('discarded');
      if (!claim.effectsDone && claim.effects) await applyEffects(deps, ref, phone, claim.effects, nowAt()); else await ref.update({ 'receptionist.handledMs': lastIn });
      return 'already_sent';
    }
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
    await applyEffects(deps, ref, phone, eff, nowAt());                                      // the request for the owner, the pause, the push, "answered": repeated by the next run if this one dies here
    return 'sent:' + step;
  } catch (e) {
    log('error', 'receptionist chat failed', { code: String((e && e.code) || 'unknown').slice(0, 60) });
    return 'error';
  } finally { if (locked) await ref.update({ 'receptionist.lockUntil': 0 }).catch(() => {}); }
}

// The reply delay: one number in the settings document (seconds, 5 to 90), 30 by default. Read on every run, so it can be changed without redeploying.
const delayMs = (s) => { const v = Number(s && s.replyDelaySeconds); return Number.isFinite(v) && v > 0 ? Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Math.round(v * 1000))) : DEBOUNCE_MS; };
// The switches, the same for the event path and the backup. The master switch (autoReply) controls the AUTOMATIC handling of new Meta leads. A chat the owner switched on himself with its Receptionist button (for
// testing one chat) works without it; the AI kill switch, real customer data and reply suggestions must all be on for either. Returns why not, or null.
const closed = (s, deps, nowMs) => (!s.enabled || !s.customerDataApproved || !s.replyAssistant ? 'off' : !deps.model ? 'no key' : quiet(nowMs) ? 'quiet hours' : null);

// The event path: called when a customer message has just been saved. Cheap for every chat that is not the receptionist's (one settings read and one chat read), and it never throws.
// `messageMs` is the time of the message that fired the event. Returns a short reason (what was done or why not).
async function onInbound(deps, phone, messageMs, { sleep = (n) => new Promise((r) => setTimeout(r, n)), now = Date.now } = {}) {
  try {
    const t0 = now(), s = await ai.loadSettings(deps.db), why = closed(s, deps, t0);
    if (why) return why === 'quiet hours' ? 'quiet' : why;                                // during quiet hours the backup answers it after 7:00
    const ref = deps.db.doc('conversations/' + phone), first = await ref.get();
    if (!first.exists) return 'gone';
    const c = first.data(), rec = c.receptionist;
    const ours = rec ? rec.on === true && !rec.paused && !personWrote(rec) && (s.autoReply || !rec.auto) : !!(s.autoReply && s.autoReplySince && ms(c.createdAt) >= s.autoReplySince);          // switched on, or a new Meta lead that may be
    if (!ours) return 'not_ours';
    if (ms(c.lastInboundAt) > messageMs) return 'superseded';                              // a newer message is already here: its own run answers
    await sleep(Math.max(0, delayMs(s) - (now() - t0)));                                   // the reply delay: a burst of messages is answered once
    const again = await ref.get();
    if (!again.exists) return 'gone';
    if (ms(again.data().lastInboundAt) > messageMs) return 'superseded';                    // the customer wrote again while we waited: only the run for the LAST message goes on
    const t1 = now(); if (quiet(t1)) return 'quiet';
    if (!again.data().receptionist && !(await activateIfNewLead(deps, again, s.autoReplySince))) return 'not_ours';
    return await processChat(deps, phone, t1, { waitMs: 0 });                              // the delay has been waited: no second wait
  } catch (e) { log('error', 'receptionist event failed', { code: String((e && e.code) || 'unknown').slice(0, 60) }); return 'error'; }
}

// The Firestore event for a new message: only a message FROM THE CUSTOMER goes on (our own messages, a person's and the welcome template all return at once, without reading anything).
async function onMessage(deps, phone, message, opts) {
  if (!message || message.direction !== 'in') return 'ignored';
  return onInbound(deps, phone, ms(message.createdAt), opts);
}

// The backup check (every 5 minutes): anything the event path missed, and everything that arrived during quiet hours. Returns a count of what happened, for the log (no names, no words).
async function sweep(deps, nowMs = Date.now()) {
  const s = await ai.loadSettings(deps.db), why = closed(s, deps, nowMs);
  if (why === 'off') return { skipped: 'off' };
  if (why === 'no key') return { skipped: 'no key' };
  if (why === 'quiet hours') return { skipped: 'quiet hours' };
  // The chats the customer has written in during the last 24 hours (the only ones that can be answered): one query, newest first.
  const chats = await deps.db.collection('conversations').where('lastInboundAt', '>=', Timestamp.fromMillis(nowMs - WINDOW_MS)).orderBy('lastInboundAt', 'desc').limit(MAX_CHATS).get();
  const out = { chats: chats.size };
  for (const d of chats.docs) {
    let activated = false;
    try { activated = s.autoReply && await activateIfNewLead(deps, d, s.autoReplySince); if (activated) out.activated = (out.activated || 0) + 1; } catch (e) { log('error', 'receptionist activation failed', { code: String((e && e.code) || 'unknown').slice(0, 60) }); continue; }
    const rec = d.data().receptionist;
    if (!activated && !(rec && rec.on === true && (s.autoReply || !rec.auto))) continue;     // not switched on (or not a Meta lead): never looked at any further; automatic chats need the master switch
    const why = await processChat(deps, d.id, nowMs); out[why] = (out[why] || 0) + 1;
  }
  return out;
}

module.exports = { processChat, onInbound, onMessage, sweep, delayMs, activateIfNewLead, quiet, hourOf, courtesyOnly, SEND_STEPS, PAUSE_STEPS, WAIT_MS, DEBOUNCE_MS, MIN_DELAY_MS, MAX_DELAY_MS, DAILY_CAP, QUIET_UNTIL_HOUR };
