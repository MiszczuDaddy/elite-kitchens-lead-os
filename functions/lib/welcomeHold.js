'use strict';
// The morning sweep for welcome messages held back in quiet hours (lib/leads.js: a lead that arrives between midnight and 07:00 Irish time is saved and alerted as always, its welcome waits). Every five minutes,
// outside quiet hours, each held welcome that is due is sent exactly like an immediate one (the same delivery function), AFTER checking that nothing has changed:
//   the customer is gone (deleted) ...... skipped_gone        the customer has written to us meanwhile ... skipped_replied (the receptionist and the team have the chat)
//   a person or a template has been in touch ... skipped_contacted / skipped_recent     "do not contact" ... blocked (and the chat says why)
// One sweep at a time per lead (a transaction claims it). Meta refusing for rate limiting leaves it held for the next sweep (up to 6 tries, then it is flagged failed for a person). A send that was claimed but
// never finished (the function died mid-send) is flagged "unknown" after ten minutes, never sent again by itself: Today shows it ("Could not confirm the welcome message went").
const store = require('./store');
const Leads = require('./leads');
const QH = require('./quietHours');

const MAX_PER_RUN = 50, MAX_TRIES = 6, STUCK_MS = 10 * 60e3;
const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : typeof t === 'number' ? t : 0);
const log = (level, msg, extra) => console.log(JSON.stringify({ level, msg, ...extra }));

async function one({ db, wa, cfg }, ref, id, w, nowMs) {
  const claimed = await db.runTransaction(async (tx) => {                                     // one sweep at a time per lead
    const s = await tx.get(ref);
    if (!s.exists || (s.data().welcome || {}).state !== 'held') return false;
    tx.update(ref, { welcome: { ...w, state: 'sending', at: nowMs } });
    return true;
  });
  if (!claimed) return 'claimed_elsewhere';
  const set = (state, extra) => ref.update({ welcome: { state, at: nowMs, ...(extra || {}) } });
  const phone = String(w.phone || '');
  const [contact, conv] = await Promise.all([db.collection('contacts').doc(phone).get(), db.collection('conversations').doc(phone).get()]);
  if (!/^\d{9,15}$/.test(phone) || !contact.exists || !conv.exists) { await set('skipped_gone'); return 'skipped_gone'; }
  const c = conv.data(), since = Number(w.at) || 0;                                           // only what happened AFTER the lead arrived counts (a returning customer has older messages)
  if (ms(c.lastInboundAt) > since || ms(c.emailInboundAt) > since) { await set('skipped_replied'); return 'skipped_replied'; }
  if ((c.lastMessageDirection === 'out' && ms(c.updatedAt) > since) || ms((c.receptionist || {}).humanAt) > since) { await set('skipped_contacted'); return 'skipped_contacted'; }
  const cw = await Leads.claimWelcome(db, phone, nowMs);
  if (cw === 'recent') { await set('skipped_recent'); return 'skipped_recent'; }
  if (cw === 'blocked') {
    await store.storeFailedOutbound(db, phone, { type: 'template', body: `[template: ${cfg.template}]`, error: Leads.DNC_WELCOME }).catch(() => {});
    await set('blocked'); return 'blocked';
  }
  const r = await Leads.deliverWelcome({ db, wa, cfg }, { ref, id, phone, firstName: String(w.firstName || 'there'), now: nowMs });
  if (r.retry) {                                                                              // Meta said "too many requests": it was not sent, so try again at the next sweep
    const tries = (w.tries || 0) + 1;
    if (tries >= MAX_TRIES) {
      await store.storeFailedOutbound(db, phone, { type: 'template', body: `[template: ${cfg.template}]`, error: 'Welcome message not sent: WhatsApp kept refusing. Please send it manually.' }).catch(() => {});
      await set('failed', { error: 'too many retries' }); return 'failed';
    }
    await ref.update({ welcome: { ...w, state: 'held', tries, lastError: 'rate limited', at: nowMs } }); return 'retry';
  }
  await ref.update({ welcome: r.welcome }); return r.welcome.state;
}

// A welcome claimed ("sending") that never finished: flagged for a person, never sent again by itself.
async function recoverStuck({ db, cfg }, nowMs) {
  let n = 0;
  const snap = await db.collection('leads').where('welcome.state', '==', 'sending').limit(MAX_PER_RUN).get();
  for (const d of snap.docs) {
    const w = d.data().welcome || {};
    if (!(nowMs - ms(w.at) > STUCK_MS)) continue;
    const owner = await db.collection('contacts').where('metaLead.leadId', '==', d.id).limit(1).get();
    if (!owner.empty) await store.storeFailedOutbound(db, owner.docs[0].id, { type: 'template', body: `[template: ${cfg.template}]`, error: 'Welcome message status unknown (interrupted while sending). Check WhatsApp, then send it manually if needed.' }).catch(() => {});
    await d.ref.update({ welcome: { state: 'unknown', at: nowMs } }); n++;
  }
  return n;
}

async function sweep({ db, wa, cfg, nowMs = Date.now() }) {
  const out = { due: 0, results: {}, stuck: 0 };
  out.stuck = await recoverStuck({ db, cfg }, nowMs);
  if (QH.isQuiet(nowMs)) return { ...out, quiet: true };
  const snap = await db.collection('leads').where('welcome.state', '==', 'held').limit(MAX_PER_RUN).get();
  for (const d of snap.docs) {
    const w = d.data().welcome || {};
    if (!(w.sendAfter <= nowMs)) continue;
    out.due++;
    try { const r = await one({ db, wa, cfg }, d.ref, d.id, w, nowMs); out.results[r] = (out.results[r] || 0) + 1; }
    catch (e) { out.results.error = (out.results.error || 0) + 1; log('error', 'held welcome failed', { leadId: d.id, code: String((e && e.code) || 'unknown').slice(0, 60) }); }
  }
  return out;
}

module.exports = { sweep, one, recoverStuck, MAX_TRIES, STUCK_MS };
