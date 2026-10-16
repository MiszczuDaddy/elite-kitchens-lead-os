'use strict';
// Phase 9: arranging a home consultation, by a FIXED flow decided by code (docs/AI.md). The AI never picks slots, never promises availability and never confirms anything.
// Step A (consent first): the conversation policy is  answer -> offer a home visit ONCE -> wait for agreement -> ask about days -> record what they say -> hand over.
//   * General interest, "hello", "ok", thanks, confusion, "yes" to our welcome message and price questions are NOT agreement to a visit. The system never asks about days until the customer has asked for a
//     visit, or said yes to our offer of one (or volunteered when they are free).
//   * The offer is made once per conversation, after the customer's message has been dealt with ("Would you like us to call out and have a look at your space?"), never together with a question about days.
//   * After agreement: "Would any day next week suit you?"; if not, ONCE the following week; at most two questions. A customer who says they will let us know gets "just let us know when suits" and no booking request.
//   * What the customer says about when they are free keeps its meaning: AVAILABLE (a day, "any day", a time of day, a named week) can become a booking request; UNAVAILABLE ("I'm abroad", "I work all day")
//     and TENTATIVE ("I'll let you know on Friday") never do, and a time the customer did not offer is never invented.
//   * A booked customer who wants to CANCEL is asked once "do you want to move it to any other date?" (nothing is said as done); a customer who wants a change is handled as before; anything specific
//     (tomorrow, earlier the same day, confirm, running late) goes to a person with the request.
//   * A preference given together with a question that needs a person is still recorded (the question is noted for the person).
// The wording of every line is below, written by code (the owner's own words). The model only reads the chat: it says what the customer wants (visit, change, question, availability and its status).
const TZ = 'Europe/Dublin';
const MAX_ASKS = 2;
const LINES = {
  // The offer of a home visit: one direct question, no dates (owner's wording, 15 Oct 2026).
  visit_offer: 'Would you like us to call out and have a look at your space?',
  ask_next_week: 'Would any day next week suit you for a home consultation?',
  ask_following_week: 'No problem. Would the following week suit you? Do you have any particular days or times that work best?',
  acknowledge: 'Perfect, I\'ll pass that on to the team and we\'ll confirm a time shortly.',
  // A complaint or an upset customer (owner's wording, 15 Oct 2026): one line, then a person takes over at once. No promise about resolving it, and the automatic conversation does not continue.
  complaint: 'I\'m sorry to hear that. I\'ll pass this on to the team so they can look into it.',
  asked_ai: 'I\'m an automated assistant for Elite Kitchens, but I\'ll pass this on to the team and they\'ll be in touch.',
  // The owner's own words for a GENERAL price question (how much do kitchens cost): the only price statement the system ever makes. Nothing about a specific kitchen, a quote or a discount.
  price_general: 'All our kitchens are different, so each project is priced individually, but most of our kitchens range from €10k to €20k.',
  change_ask: 'No problem, would any day next week suit you better?',
  // A booked customer who wants to cancel (owner's wording, 15 Oct 2026): it offers to move it, says nothing is done, and never claims the cancellation happened.
  cancel_ask: 'No problem, do you want to move it to any other date?',
  // A customer who will check or let us know (owner's wording, 15 Oct 2026).
  tentative: 'No problem at all, just let us know when suits.',
  no_preference: 'No problem, I\'ll pass this on to the team and we\'ll be in touch to arrange a time.',
};
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const WEEKS = ['this', 'next', 'following', 'other'];
const STATUSES = ['available', 'unavailable', 'tentative', 'unknown'];
const SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };

// ---- Irish calendar dates (weeks run Monday to Sunday) ----
function ymdOf(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, dow: SHORT.indexOf(p.weekday) };       // dow: 0 = Monday
}
const plusDays = ({ y, m, d }, n) => { const t = new Date(Date.UTC(y, m - 1, d + n)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: (t.getUTCDay() + 6) % 7 }; };
const label = (x) => `${SHORT[x.dow]} ${x.d} ${MONTHS[x.m - 1]}`;
function weekOf(nowMs, which) {
  const t = ymdOf(nowMs), monday = plusDays(t, -t.dow + { this: 0, next: 7, following: 14 }[which]);
  const days = WEEKDAYS.map((_, i) => plusDays(monday, i));
  return { monday, sunday: days[6], days, label: `${label(monday)} to ${label(days[6])}` };
}

// ---- what the customer said about when they are free ----
// status: available (a day, "any day", a time of day or a named week they CAN do), unavailable (they cannot / will not in the near term and gave no alternative), tentative (they will check or let us know),
// unknown (nothing usable). The model must say it: a missing or unknown status is 'unknown', never 'available' (audit 16 Oct 2026, finding 5). The days and times are ONLY what they offered, never inferred.
function cleanPreference(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const days = [...new Set((Array.isArray(raw.days) ? raw.days : []).map((d) => String(d).toLowerCase()).filter((d) => WEEKDAYS.includes(d)))];
  const weeks = WEEKS.includes(raw.weeks) ? raw.weeks : null, anyDay = raw.anyDay === true, times = typeof raw.times === 'string' && raw.times.trim() ? clip(raw.times, 60) : null;
  const status = STATUSES.includes(raw.status) ? raw.status : 'unknown';
  return { weeks, days, anyDay, times, text: clip(raw.text, 160), status };
}
// The days and times the model read must be in what the customer actually wrote (their latest messages), not only in the model's summary of it. A day or a time of day that is not there is dropped
// (the model once turned "I work all day though" into "evenings"). Weeks and "any day" are kept as they are.
const DAY_WORDS = { monday: 'mon', tuesday: 'tues?', wednesday: 'weds?', thursday: 'thu(?:rs?)?', friday: 'fri', saturday: 'sat', sunday: 'sun' };
const TIME_STOP = new Set(['the', 'any', 'and', 'after', 'before', 'from', 'around', 'about', 'time', 'ish', 'between', 'until', 'til', 'till', 'only', 'are', 'best', 'free', 'suit', 'work']);
function heard(pref, said) {
  if (!pref) return null;
  const s = String(said || '').toLowerCase();
  const days = pref.days.filter((d) => new RegExp(`\\b(?:${d}|${DAY_WORDS[d]})s?\\b`).test(s));
  let times = pref.times;
  if (times) {
    const words = (times.toLowerCase().match(/[a-z]{2,}|\d+/g) || []).map((w) => (/^[a-z]{4,}s$/.test(w) ? w.slice(0, -1) : w)).filter((w) => !TIME_STOP.has(w));
    const ok = words.length ? words.some((w) => (/^\d+$/.test(w) ? new RegExp(`(?:^|\\D)${w}(?:\\D|$)`) : new RegExp(`\\b${w}`)).test(s)) : /\bany ?time\b|\bwhenever\b|\bflexible\b/.test(s);
    if (!ok) times = null;
  }
  return { ...pref, days, times };
}
// "Reasonable" = something a person can book from: the customer is AVAILABLE and named a day, "any day", a time of day, or a week. "Not sure", "I'll let you know", "I'm abroad" and "another time" alone are not.
const reasonable = (p) => !!(p && p.status === 'available' && (p.days.length || p.anyDay || p.times || (p.weeks && p.weeks !== 'other')));
// A clear summary for the person who will book it, with the real dates.
function describe(pref, nowMs) {
  if (!reasonable(pref)) return null;
  const week = pref.weeks && pref.weeks !== 'other' ? weekOf(nowMs, pref.weeks) : null;
  const weekLabel = week ? `${{ this: 'This week', next: 'Next week', following: 'The week after next' }[pref.weeks]} (${week.label})` : null;
  const days = pref.days.map((d) => { const i = WEEKDAYS.indexOf(d), cap = d[0].toUpperCase() + d.slice(1); return week ? `${cap} ${week.days[i].d} ${MONTHS[week.days[i].m - 1]}` : cap; });
  const parts = [weekLabel, pref.anyDay ? 'any day' : null, days.length ? days.join(', ') : null, pref.times].filter(Boolean);
  // The date the booking form opens on: the first day they named, else the first day of the week they named (the screen never opens it in the past).
  const iso = (x) => `${x.y}-${String(x.m).padStart(2, '0')}-${String(x.d).padStart(2, '0')}`;
  const firstIdx = pref.days.length ? Math.min(...pref.days.map((d) => WEEKDAYS.indexOf(d))) : -1;
  const firstDate = week ? iso(firstIdx >= 0 ? week.days[firstIdx] : week.monday) : null;
  return { weeks: pref.weeks, days: pref.days, anyDay: pref.anyDay, times: pref.times, customerWords: pref.text, weekLabel, dayLabels: days, text: parts.join(' · '), firstDate, status: 'available' };
}
// What a customer who is not available (or will let us know) said: kept as a NOTE in their own words. It has no days or times and is never a booking request.
function noteOf(pref) {
  if (!pref || !['tentative', 'unavailable'].includes(pref.status) || !pref.text) return null;
  return { weeks: pref.weeks, days: [], anyDay: false, times: null, customerWords: pref.text, weekLabel: null, dayLabels: [], text: (pref.status === 'tentative' ? 'Will let us know' : 'Not available') + ': "' + pref.text + '"', firstDate: null, status: pref.status };
}

// ---- how many scheduling questions have already been asked ----
// From what was recorded when a suggested question was sent, and (in case a person typed it themselves) from our own earlier messages in the chat.
function asksSoFar(consult, messages) {
  let n = Math.min(MAX_ASKS, Math.max(0, (consult && Number.isInteger(consult.asks) ? consult.asks : 0)));
  for (const m of messages || []) {
    if (m.direction !== 'out') continue;
    if (/\bfollowing week\b/i.test(m.body || '')) n = Math.max(n, 2);
    else if (/\bany day next week suit you for\b|\bnext week suits?\b(?!\s+you better)/i.test(m.body || '')) n = Math.max(n, 1);
  }
  return n;
}
// R3 (before the audit of 16 Oct 2026): a word filter for a model-written acknowledgement. The receptionist no longer sends model-written acknowledgements at all (see ackLine below); kept as a filter only.
const RISKY = /\b(book|booked|booking|confirm|confirmed|available|availability|slot|date|time|times|day|days|week|weeks|today|tomorrow|tonight|tuesday|monday|wednesday|thursday|friday|saturday|sunday|promise|guarantee|guaranteed|price|prices|cost|costs|quote|quoted|discount|free|cheap|cheaper|€|euro|euros|deposit|ai|bot|robot|assistant|automated)\b/i;
function acknowledgement(text) {
  const t = clip(text, 120);
  if (!t || t.length > 110 || /[?]/.test(t) || /\d/.test(t) || RISKY.test(t) || /€|https?:|www\.|@/i.test(t)) return '';
  return t;
}
// The model's opener: only for the first message we send in a chat, short, a greeting or thanks, no question, nothing about times or promises.
function opener(text, hasOutbound) {
  const t = clip(text, 90);
  if (!t || hasOutbound || t.length > 80 || /[?]/.test(t) || /\d/.test(t) || /\b(book|booked|confirm|confirmed|available|availability|slot|date|time|day|days|week|weeks|tuesday|monday|wednesday|thursday|friday|saturday|sunday|promise|guarantee|price|cost|€)\b/i.test(t)) return '';
  if (!/\b(hi|hello|hey|thanks|thank you|good (?:morning|afternoon|evening))\b/i.test(t)) return '';
  return t;
}
// The automatic receptionist (audit 16 Oct 2026, finding 1): the words in front of a fixed line are WRITTEN BY CODE. The model only picks one of these by id (decision.ack); the customer's first name and project come
// from the records, cleaned. A sentence the model wrote itself never reaches a customer on this path (the staff flow, where a person reads the draft, still uses the model's opener).
const ACKS = ['hello', 'thanks', 'details', 'project', 'confused'];
function firstName(name) {
  const t = String(name || '').trim().split(/\s+/)[0] || '';
  if (!/^[A-Za-zÀ-ÖØ-öø-ÿ'’-]{2,20}$/.test(t)) return '';
  return t === t.toLowerCase() || t === t.toUpperCase() ? t[0].toUpperCase() + t.slice(1).toLowerCase() : t;
}
function projectOf(type) {
  const t = String(type || '').toLowerCase(), k = /kitchen/.test(t), w = /wardrobe/.test(t);
  return k && w ? ['a new kitchen and wardrobes', 'sound'] : k ? ['a new kitchen', 'sounds'] : w ? ['new wardrobes', 'sound'] : /utility/.test(t) ? ['a new utility room', 'sounds'] : null;
}
function ackLine(id, who, first) {
  const n = firstName(who && who.name), p = projectOf(who && who.projectType);
  if (id === 'hello') return first ? (n ? `Hi ${n}, thanks for getting back to us.` : 'Hi, thanks for getting back to us.') : ackLine('thanks', who, false);
  if (id === 'thanks') return n ? `Thanks, ${n}.` : 'Thanks.';
  if (id === 'details') return n ? `Thanks for the details, ${n}.` : 'Thanks for the details.';
  if (id === 'project') return p ? `Lovely, ${p[0]} ${p[1]} great.` : 'Lovely, that sounds great.';
  if (id === 'confused') return first && n ? `Hi ${n}, this is Elite Kitchens following up on your kitchen enquiry.` : 'This is Elite Kitchens following up on your kitchen enquiry.';
  return '';
}

// ---- what the customer's latest messages say, read by code (consent and disclosure never rest on the model's labels alone: audit 16 Oct 2026, finding 5) ----
// The customer's messages since our last one (the burst being answered). The automatic receptionist only runs for a new customer message, so when none sorts after ours (customer times come from WhatsApp,
// ours from the server clock, and the two can disagree by a little) it is their most recent message.
function latestMessages(messages, { natural = false } = {}) {
  const list = messages || [];
  let i = list.length; while (i > 0 && list[i - 1].direction !== 'out') i--;
  const got = list.slice(i).filter((m) => m.direction === 'in').map((m) => String(m.body || ''));
  if (got.length || !natural) return got;
  const last = list.filter((m) => m.direction === 'in').pop();
  return last ? [String(last.body || '')] : [];
}
// They ask for someone to come out (a visit, a measure, a consultation) in their own words.
const ASKS_VISIT = /\b(visit|call (?:out|over|round|around|to the house)|calling out|come (?:out|over|round|around|to the house|and (?:see|look|measure|have a look))|pop (?:out|over|round)|have a look|take a look|measure|measuring|survey|consultation|appointment|someone (?:to )?(?:come|call|look))\b/i;
// They ask whether they are talking to a person, a bot or an AI. Any such question gets the honest line, whatever the model labelled it.
const ASKS_AI = /\b(bot|robot|chat ?bot|ai|a\.i|automated|automatic|artificial|real person|real human|human|computer|machine)\b/i;
const QUESTIONISH = /\?|\b(are you|is this|is it|am i (?:talking|speaking|chatting|texting|messaging)|who am i)\b/i;
const asksIfAi = (text) => ASKS_AI.test(text) && QUESTIONISH.test(text);

// The plan for this message. Returns { step, reply, handover, preference }:
//   step 'none'     nothing is said by the system (a person takes over if handover.needed; otherwise the model's own reply is only a draft for staff)
//   offer_visit / price_offer / price_general / ack_only / ask_next_week / ask_following_week / acknowledge / no_preference / tentative / cancel_ask / change_ask / change_given / change_pass_on / asked_ai   a fixed line
// The model is told to write only the answer, but it sometimes adds a "the team will come back to you" (the system adds that line itself) or "here are some photos" (the system adds the links). Those sentences are
// taken out, so the customer is not told the same thing twice. Nothing is added or reworded; a reply that is only such sentences is not used.
const FOLLOWUP = /\b(?:the team|a member of the team|one of the team|someone|we(?:'ll| will)|i(?:'ll| will))\b[^.?!]*\b(?:come back|get back|be in touch|follow up|check|confirm|go through|call you|ring you)\b/i;
const SHOWING = /\bhere(?:'s| is| are)\b[^.?!]*\b(?:work|photos?|pictures?|kitchens?|projects?|links?|look)\b/i;
function tidy(text, { partly = false, links = false } = {}) {
  const parts = String(text || '').split(/(?<=[.!?])\s+/).filter(Boolean), keep = parts.filter((s) => !(partly && FOLLOWUP.test(s)) && !(links && SHOWING.test(s)));
  return keep.join(' ').trim();
}
function plan({ decision, consult, messages, booked, nowMs, natural = false, kn = null, who = null }) {
  const none = { step: 'none', reply: null, handover: null, preference: null };
  const d = decision, hand = !!(d.handover && d.handover.needed), reason = (d.handover && d.handover.reason) || '';
  const visit = d.visit || (d.wantsConsultation ? 'asked' : 'none');
  const change = d.change && d.change !== 'none' ? d.change : (hand && /change booking/i.test(reason) ? 'move' : 'none');
  const out = (messages || []).filter((m) => m.direction === 'out'), said = (line) => out.some((m) => String(m.body || '').includes(line));
  const latest = latestMessages(messages, { natural }), words = latest.join('\n');
  // Automatic mode (nobody reads it first): the days and times must be in the customer's own latest words, and agreement to a visit counts only if we really offered one or their own words ask for one
  // (a "yes" to our welcome message labelled as agreement is not). In the staff flow a person reads the draft and the preference summary before anything is sent, so the model's reading stands there.
  const hasOutbound = out.length > 0, prefRaw = d.schedule && d.schedule.preference, given = describe(natural ? heard(prefRaw, words) : prefRaw, nowMs);
  const person = (why) => ({ step: 'none', reply: null, handover: { needed: true, reason: why }, preference: null });
  const offered = !!(consult && consult.offered) || said(LINES.visit_offer), agreed = (visit === 'asked' || visit === 'agreed') && (!natural || offered || ASKS_VISIT.test(words));
  const question = hand || !!d.hasQuestion || ['asking_info', 'asking_price', 'complaint'].includes(d.intent);          // something a person has to answer (nothing is offered or asked meanwhile)
  // R3: the code-built acknowledgement (see ackLine). With no id from the model, an opener the model offered on the first message only means "say hello".
  const first = !out.some((m) => m.type !== 'template');
  const ackOf = () => ackLine(ACKS.includes(d.ack) ? d.ack : (opener(d.schedule && d.schedule.opener, hasOutbound) ? 'hello' : ''), who, first);

  // 1. A customer who asks whether they are talking to a person or an AI is told the truth, in one short line, and handed over (the system never lets the model answer that itself). Decided by the model's
  //    label, its hand-over reason, OR the customer's own words: a truthful answer never depends on how the model worded a reason.
  if (d.special === 'asked_if_ai' || (hand && /asked if ai|\b(bot|robot|ai|automated|artificial)\b|\b(?:is|are)\b.*\b(?:real person|human)\b/i.test(reason)) || latest.some(asksIfAi)) return { step: 'asked_ai', reply: LINES.asked_ai, handover: { needed: true, reason: 'asked if AI' }, preference: null };

  // 2. A customer who already has a consultation booked. The booking is only ever changed by a person; nothing is said as done.
  if (booked && change !== 'none') {
    if (change === 'cancel') {
      if (!said(LINES.cancel_ask)) return { step: 'cancel_ask', reply: LINES.cancel_ask, handover: { needed: true, reason: 'wants to cancel booking' }, preference: null };
      return person('wants to cancel booking');                                          // they answered our one question (no / just cancel): a person takes it from here, silently
    }
    if (change === 'move') {
      const asked = said(LINES.change_ask);
      if (given) return { step: 'change_given', reply: LINES.acknowledge, handover: { needed: true, reason: 'wants to move booking: preference received' }, preference: given };
      return asked ? { step: 'change_pass_on', reply: LINES.no_preference, handover: { needed: true, reason: 'wants to move booking' }, preference: null } : { step: 'change_ask', reply: LINES.change_ask, handover: { needed: true, reason: 'wants to move booking' }, preference: null };
    }
    if (change === 'move_specific') return person('wants the booking moved to a specific time (tomorrow, earlier, a date): needs you');
    if (change === 'confirm') return person('asks you to confirm the booking');
    if (change === 'late') return person('running late for the booking');
  }

  // 2a. A complaint (the automatic receptionist only): the owner's one line, then a person takes over at once and the receptionist stops (PAUSE_STEPS). Nothing is answered, offered, asked or promised.
  if (natural && d.intent === 'complaint') return { step: 'complaint', reply: (kn && kn.lines.complaint) || LINES.complaint, handover: { needed: true, reason: 'complaint: upset customer' }, preference: null, ...(kn ? { kn: { state: 'special', special: 'complaint', blocked: [], topics: [] } } : {}) };

  // 2b. Step C: the owner has published knowledge, and this is the automatic receptionist. A customer who asks for a person, or whose job is outside our areas, a job we decline, or not in English, gets the
  //     owner's line and a person takes over. A question is ANSWERED from the knowledge first (the answer was checked in code), and only then does the Step A flow go on exactly as before: the visit is offered once,
  //     days are asked only after agreement, a preference is recorded. A question the knowledge does not answer (or an answer that failed the check) gets the holding line and a person takes over: never a guess.
  if (kn && natural) {
    const special = { wants_person: ['human', kn.lines.human, 'asked for a person'], outside_area: ['outside_area', kn.lines.outside_area, 'outside the areas we cover: please review'], declined_job: ['declined_job', kn.lines.declined_job, 'a job we usually decline: please review'], other_language: ['other_language', kn.lines.other_language, 'message not in English'] }[d.special];
    if (special) return { step: special[0], reply: special[1], handover: { needed: true, reason: special[2] }, preference: null, kn: { state: 'special', special: d.special, blocked: [], topics: [] } };
    const raw = String(d.reply || '').trim(), asking = d.hasQuestion || ['asking_info', 'asking_price'].includes(d.intent) || (d.intent === 'asking_price_general' && !!raw);
    if (asking && d.intent !== 'complaint') {
      const linkLine = kn.linksText(d.links), text = tidy(raw, { partly: hand || d.answerState === 'partly', links: !!linkLine }) || (linkLine ? 'Of course.' : '');
      const has = !!text && d.answerState !== 'none', chk = has ? kn.check(text) : { ok: true, reasons: [] }, ok = has && chk.ok;
      const state = ok ? (hand || d.answerState === 'partly' ? 'partly' : 'answered') : 'none', unknown = d.unknown ? ': ' + d.unknown : '';
      const links = ok ? linkLine : '', op = ok && first && (d.ack === 'hello' || opener(d.schedule && d.schedule.opener, hasOutbound)) ? ackLine('hello', who, true) : '';      // a greeting before the first answer: written by code
      const sep = links ? '\n' : ' ', answer = ok ? (op ? op + ' ' : '') + text + (links ? '\n' + links : '') : '', info = { state, blocked: chk.reasons, topics: d.topics || [] };
      if (!ok) return { step: 'holding', reply: kn.lines.holding, handover: { needed: true, reason: (reason || 'a question that needs the team') + unknown }, preference: null, kn: info };
      if (state === 'partly') {
        const why = (reason || 'part of the question needs the team') + unknown;
        if (given && !booked) return { step: 'acknowledge', reply: answer + sep + LINES.acknowledge, handover: { needed: true, reason: 'consultation preference received; they also asked something that needs you: ' + why }, preference: given, kn: info };
        return { step: 'answer_holding', reply: answer + sep + (kn.lines.partly || kn.lines.holding), handover: { needed: true, reason: why }, preference: null, kn: info };
      }
      // fully answered: the answer goes first, then whatever the consultation flow would have said, with the question taken out of the picture
      const neutral = { ...d, hasQuestion: false, reply: '', answerState: null, special: 'none', links: [], handover: { needed: false, reason: null }, schedule: { preference: d.schedule && d.schedule.preference, opener: '' },
        intent: ['asking_info', 'asking_price'].includes(d.intent) ? 'answering_questions' : d.intent };
      const core = plan({ decision: neutral, consult, messages, booked, nowMs, natural, kn: null });
      // A plain question of fact (does it include, do you supply, how long, what do you cover) is just answered: the visit is not attached to it. The offer waits for a message where they talk about their own project
      // or ask what kitchens cost, and is still made only once. (Owner's decision, 15 Oct 2026.)
      if (core.step === 'offer_visit' && d.intent === 'asking_info') return { step: 'answer', reply: answer, handover: null, preference: null, kn: info };
      if (core.step === 'none') return { step: 'answer', reply: answer, handover: core.handover, preference: core.preference, kn: info };
      return { ...core, reply: answer + sep + core.reply, kn: info };
    }
  }

  // 3. A general question about what kitchens cost is answered with the owner's fixed line; then, once, the offer of a visit (never a question about days before they agree).
  if (d.intent === 'asking_price_general' && !hand) {
    if (booked || visit === 'declined' || (consult && consult.stage === 'preference_given')) return { step: 'price_general', reply: LINES.price_general, handover: null, preference: null };
    if (given) return { step: 'acknowledge', reply: LINES.price_general + ' ' + LINES.acknowledge, handover: { needed: true, reason: 'consultation preference received: over to you to book' }, preference: given };
    if (agreed) { const next = askNext(consult, messages, null); return { ...next, reply: LINES.price_general + ' ' + next.reply }; }
    return offered ? { step: 'price_general', reply: LINES.price_general, handover: null, preference: null } : { step: 'price_offer', reply: LINES.price_general + ' ' + LINES.visit_offer, handover: null, preference: null };
  }
  if (booked) return none;                                                                 // booked and nothing about the booking: no consultation questions at all
  if (visit === 'declined') return person('customer declined or wants to wait');

  // 4. They said when they are free: that is agreement. Record it (also when they ALSO asked something that needs a person: the question goes to the person together with the preference).
  if (given && d.intent !== 'complaint') {
    const extra = hand || !!d.hasQuestion || ['asking_info', 'asking_price'].includes(d.intent);
    return { step: 'acknowledge', reply: LINES.acknowledge, handover: { needed: true, reason: extra ? 'consultation preference received; they also asked something that needs you' + (reason ? ': ' + reason : '') : 'consultation preference received: over to you to book' }, preference: given };
  }
  // A customer unsure who is writing ("Who is this?") gets the code's one line saying who we are, whatever intent the model gave it (a real-model run on 16 Oct 2026 labelled it "other" and the chat was handed over in silence).
  if (natural && d.ack === 'confused' && !hand && ['other', 'greeting'].includes(d.intent)) return { step: 'ack_only', reply: ackLine('confused', who, first), handover: null, preference: null };
  if (consult && consult.stage === 'preference_given') return none;                       // already handed over; nothing new to ask or offer (a corrected preference was handled above)
  if (question) return none;                                                               // a question we cannot answer: a person answers it; nothing is offered or asked meanwhile

  // 5. They will check / are not available: no booking request, no pushing.
  const asks = asksSoFar(consult, messages);
  if (prefRaw && prefRaw.status === 'tentative') return { step: 'tentative', reply: LINES.tentative, handover: { needed: true, reason: 'customer will let us know' }, preference: noteOf(prefRaw) };
  if (prefRaw && prefRaw.status === 'unavailable') {
    if (asks === 1) return { step: 'ask_following_week', reply: LINES.ask_following_week, handover: null, preference: null };
    if (asks >= MAX_ASKS) return { step: 'no_preference', reply: LINES.no_preference, handover: { needed: true, reason: 'no preference given after two questions' }, preference: noteOf(prefRaw) };
    return { step: 'tentative', reply: LINES.tentative, handover: { needed: true, reason: 'customer not available: ' + (prefRaw.text || 'no detail') }, preference: noteOf(prefRaw) };
  }

  // 6. Agreement: ask about days (the first question may carry a short acknowledgement: written by code in automatic mode).
  if (agreed) {
    const o = natural ? ackOf() : opener(d.schedule && d.schedule.opener, hasOutbound), next = askNext(consult, messages, null);
    return next.step === 'ask_next_week' ? { ...next, reply: (o ? o + ' ' : '') + next.reply } : next;
  }

  // 7. No agreement. A greeting, "ok", an emoji or confusion gets a friendly acknowledgement only; an enquiry or interest gets the offer of a visit, once.
  //    In the STAFF flow (a person reads the draft) a reply the model wrote itself is kept as the draft: the person adds the offer if they want it.
  if (!natural && String(d.reply || '').trim()) return none;
  const ack = natural ? ackOf() : '', op = natural ? ack : opener(d.schedule && d.schedule.opener, hasOutbound);
  if (d.intent === 'greeting') {                                                          // only the FIRST reply: after that, "ok" and "thanks" need no answer
    return first ? (ack ? { step: 'ack_only', reply: ack, handover: null, preference: null } : person('could not write a safe reply to the greeting')) : none;
  }
  if (offered) return none;                                                                // the offer was made: never repeated, never turned into a question about days
  if (!['new_enquiry', 'answering_questions', 'wants_consultation', 'scheduling'].includes(d.intent)) return none;     // unclear or off-topic: nothing is offered
  return { step: 'offer_visit', reply: (op ? op + ' ' : '') + LINES.visit_offer, handover: null, preference: null };
}
// The next scheduling question, counting what was already asked (at most two).
function askNext(consult, messages) {
  const asks = asksSoFar(consult, messages);
  if (asks >= MAX_ASKS) return { step: 'no_preference', reply: LINES.no_preference, handover: { needed: true, reason: 'no preference given after two questions' }, preference: null };
  const step = asks === 0 ? 'ask_next_week' : 'ask_following_week';
  return { step, reply: LINES[step], handover: null, preference: null };
}

// What to remember on the conversation once a person (or the receptionist) has sent the message.
function advance(consult, step, preference, nowMs) {
  const cur = consult && typeof consult === 'object' ? consult : {};
  if (cur.stage === 'preference_given' && step !== 'acknowledge') return null;            // never move back
  if (step === 'offer_visit' || step === 'price_offer') return cur.asks > 0 ? null : { stage: cur.stage || 'offered_visit', offered: true };
  if (step === 'ask_next_week') return { stage: 'asked_next_week', asks: Math.max(1, cur.asks || 0), offered: true };
  if (step === 'ask_following_week') return { stage: 'asked_following_week', asks: 2, offered: true };
  // R2b: from here the consultation is waiting for a person to book it (needsBooking), until an appointment exists or the person says it is not needed.
  if (step === 'acknowledge') return { stage: 'preference_given', asks: cur.asks || 0, preference: preference || null, at: nowMs, needsBooking: true };
  if (step === 'no_preference') return { stage: 'no_preference', asks: 2, at: nowMs, needsBooking: true, ...(preference ? { note: preference } : {}) };
  // They will let us know / are not available: the customer's words are kept as a NOTE; no booking request is created.
  if (step === 'tentative') return { stage: 'tentative', note: preference || null, at: nowMs };
  return null;
}

// The only steps whose words are sent by themselves by the automatic receptionist. All are written by code (the fixed lines above and the owner's knowledge lines) or are an answer that passed the answer checker.
const SEND_STEPS = new Set(['offer_visit', 'price_offer', 'ack_only', 'cancel_ask', 'tentative', 'price_general', 'ask_next_week', 'ask_following_week', 'acknowledge', 'no_preference', 'asked_ai', 'change_ask', 'change_given', 'change_pass_on',
  'answer', 'answer_holding', 'holding', 'human', 'outside_area', 'declined_job', 'other_language', 'complaint']);
// After these the chat is the owner's: the receptionist stays out. ('answer' does too when a person has to follow up.)
const PAUSE_STEPS = new Set(['acknowledge', 'no_preference', 'asked_ai', 'change_given', 'change_pass_on', 'answer_holding', 'holding', 'human', 'outside_area', 'declined_job', 'other_language', 'complaint']);
module.exports = { SEND_STEPS, PAUSE_STEPS, LINES, MAX_ASKS, WEEKDAYS, WEEKS, STATUSES, ACKS, cleanPreference, heard, reasonable, describe, noteOf, weekOf, asksSoFar, opener, acknowledgement, ackLine, firstName, latestMessages, asksIfAi, ASKS_VISIT, plan, advance };
