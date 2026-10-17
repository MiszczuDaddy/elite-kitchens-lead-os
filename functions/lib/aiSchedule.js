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
  // Audit repairs of 17 Oct 2026, PROPOSED wording waiting for the owner's approval (owner-editable in the Knowledge Centre; the same defaults are in aiKnowledge.DEFAULT_LINES):
  // a booked customer who cancels and wants no other date (the owner's already-approved "running late" wording: nothing is said as done), and a request for another customer's details.
  cancel_noted: 'No problem at all, thanks for letting us know. I\'ll tell the team.',
  privacy: 'Sorry, we can\'t share other customers\' details.',
  no_preference: 'No problem, I\'ll pass this on to the team and we\'ll be in touch to arrange a time.',
  // Audit of 17 Oct 2026 (PROPOSED wording, waiting for the owner's approval). With published knowledge both are the owner's lines in the Knowledge Centre (aiKnowledge DEFAULT_LINES, the same defaults).
  // The question after our greeting when a new lead only says hello, so the reply never ends in a dead end.
  still_looking: 'Are you still looking at a new kitchen?',
  // A visit asked for today or tomorrow: passed on at once (a push), never "Good question" and never a promise of a time.
  soon: 'Thanks, I\'ll pass that on to the team straight away and they\'ll get back to you.',
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
// "today" and "tomorrow" name a day too (audit 17 Oct 2026, problem 5: "can someone come out today?" was not recorded). The day is worked out from the Irish date, never taken from the model's guess, and only when the
// customer wrote the word AND the model read it as a day they can do (it gave that day, or its own summary of their words has the word without a "not" in front: "not today, Friday" gives Friday only).
const REL_DAYS = [[/\b(?:today|tonight)\b/, 0], [/\b(?:tomorrow|tmrw|tmr|2moro|2morrow)\b/, 1]];
const NOT_BEFORE = /\b(?:not|no|never|can'?t|cannot|won'?t|couldn'?t|isn'?t|doesn'?t|don'?t)\b[\s\w']{0,12}$/;
// Days the customer EXCLUDED ("any morning apart from Monday", "except Friday", "not Wednesday", "can't do Mondays", "Monday is no good"). Audit 17 Oct 2026 (Astra F2, B027 and B035): the model
// correctly read "apart from Monday" as Tuesday to Friday, the code dropped those days because they were not written, and the booking form then opened on the excluded Monday.
function exceptDays(said) {
  const s = String(said || '').toLowerCase(), out = [];
  for (const d of WEEKDAYS) {
    const D = `(?:${d}|${DAY_WORDS[d]})s?`;
    if (new RegExp(`\\b(?:except|apart from|other than|but not|not on|not|bar|excluding|besides|anything but)\\s+(?:a\\s+|on\\s+|the\\s+|for\\s+)?${D}\\b`).test(s)
      || new RegExp(`\\b(?:any|every)\\s+(?:day|morning|afternoon|evening|time|weekday|week ?day)s?\\b[^.?!]{0,25}\\b(?:but|except)\\s+(?:on\\s+)?${D}\\b`).test(s)
      || new RegExp(`\\b(?:can'?t|cannot|can not|couldn'?t)\\s+(?:do|make)\\s+(?:a\\s+|on\\s+)?${D}\\b`).test(s)
      || new RegExp(`\\b${D}\\s+(?:is|are|'s)?\\s*(?:no good|out|not good|bad|not possible|a no|not an option)\\b`).test(s)) out.push(d);
  }
  return out;
}
const RANGE = /\b(?:any|every|all|whatever|whichever|weekdays?|week ?days|most)\b/;
function heard(pref, said, nowMs = null) {
  if (!pref) return null;
  const s = String(said || '').toLowerCase(), t = String(pref.text || '').toLowerCase();
  const except = exceptDays(s);
  let named = pref.days.filter((d) => !except.includes(d) && new RegExp(`\\b(?:${d}|${DAY_WORDS[d]})s?\\b`).test(s));
  // a RANGE with an exception ("any morning apart from Monday"): the days the model read are the range, kept when they are not excluded
  if (except.length && RANGE.test(s)) named = [...new Set([...named, ...pref.days.filter((d) => !except.includes(d))])];
  const rel = [];
  if (nowMs && pref.status === 'available') for (const [re, n] of REL_DAYS) {
    if (!re.test(s)) continue;
    const x = plusDays(ymdOf(nowMs), n), day = WEEKDAYS[x.dow], m = t.match(re);
    if (!named.includes(day) && (pref.days.includes(day) || (m && !NOT_BEFORE.test(t.slice(0, m.index))))) rel.push(x);
  }
  const days = [...named, ...rel.map((x) => WEEKDAYS[x.dow]).filter((d) => !named.includes(d))];
  // the week of a day named only as "today" or "tomorrow" is the week that date is in (tomorrow on a Sunday is next week)
  const ymd = (x) => x.y * 1e4 + x.m * 100 + x.d;
  const weeks = rel.length && !named.length ? (ymd(rel[0]) > ymd(weekOf(nowMs, 'this').sunday) ? 'next' : 'this') : pref.weeks;
  let times = pref.times;
  if (times) {
    const words = (times.toLowerCase().match(/[a-z]{2,}|\d+/g) || []).map((w) => (/^[a-z]{4,}s$/.test(w) ? w.slice(0, -1) : w)).filter((w) => !TIME_STOP.has(w));
    const ok = words.length ? words.some((w) => (/^\d+$/.test(w) ? new RegExp(`(?:^|\\D)${w}(?:\\D|$)`) : new RegExp(`\\b${w}`)).test(s)) : /\bany ?time\b|\bwhenever\b|\bflexible\b/.test(s);
    if (!ok) times = null;
  }
  return { ...pref, weeks, days: days.filter((d) => !except.includes(d)), times, soon: rel.length > 0, ...(except.length ? { except } : {}) };
}
// "Reasonable" = something a person can book from: the customer is AVAILABLE and named a day, "any day", a time of day, or a week. "Not sure", "I'll let you know", "I'm abroad" and "another time" alone are not.
const reasonable = (p) => !!(p && p.status === 'available' && (p.days.length || p.anyDay || p.times || (p.weeks && p.weeks !== 'other')));
// A clear summary for the person who will book it, with the real dates.
function describe(pref, nowMs) {
  if (!reasonable(pref)) return null;
  const week = pref.weeks && pref.weeks !== 'other' ? weekOf(nowMs, pref.weeks) : null;
  const weekLabel = week ? `${{ this: 'This week', next: 'Next week', following: 'The week after next' }[pref.weeks]} (${week.label})` : null;
  const cap = (d) => d[0].toUpperCase() + d.slice(1), except = Array.isArray(pref.except) ? pref.except : [];
  const days = pref.days.map((d) => { const i = WEEKDAYS.indexOf(d); return week ? `${cap(d)} ${week.days[i].d} ${MONTHS[week.days[i].m - 1]}` : cap(d); });
  const parts = [weekLabel, pref.anyDay ? 'any day' : null, days.length ? days.join(', ') : null, pref.times, except.length ? 'not ' + except.map(cap).join(' or ') : null].filter(Boolean);
  // The date the booking form opens on: the first day they named, else the first day of the week they named that they did not exclude (the screen never opens it in the past).
  const iso = (x) => `${x.y}-${String(x.m).padStart(2, '0')}-${String(x.d).padStart(2, '0')}`;
  const firstIdx = pref.days.length ? Math.min(...pref.days.map((d) => WEEKDAYS.indexOf(d))) : WEEKDAYS.findIndex((d) => !except.includes(d));
  const firstDate = week && firstIdx >= 0 ? iso(week.days[firstIdx]) : null;
  return { weeks: pref.weeks, days: pref.days, anyDay: pref.anyDay, times: pref.times, customerWords: pref.text, weekLabel, dayLabels: days, text: parts.join(' · '), firstDate, status: 'available', ...(except.length ? { except } : {}) };
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
function latestBurst(messages, { natural = false } = {}) {
  const list = messages || [];
  let i = list.length; while (i > 0 && list[i - 1].direction !== 'out') i--;
  const got = list.slice(i).filter((m) => m.direction === 'in');
  if (got.length || !natural) return got;
  const last = list.filter((m) => m.direction === 'in').pop();
  return last ? [last] : [];
}
const latestMessages = (messages, opts) => latestBurst(messages, opts).map((m) => String(m.body || ''));
// They want to think about it or will come back to us (rather than a plain no).
const THINKING = /\b(?:think(?:ing)? (?:about )?it|have a think|think it over|come back to (?:you|u)|get back to (?:you|u)|let (?:you|u) know|check with|talk (?:to|with|it over with) (?:my|the)|discuss|sleep on it|mull)\b/i;
// They ask for someone to come out (a visit, a measure, a consultation) in their own words.
const ASKS_VISIT = /\b(visit|call (?:out|over|round|around|to the house)|calling out|come (?:out|over|round|around|to the house|and (?:see|look|measure|have a look))|pop (?:out|over|round)|have a look|take a look|measure|measuring|survey|consultation|appointment|someone (?:to )?(?:come|call|look))\b/i;
// They ask whether THEY are talking to a person, a bot or an AI. Only a question put to us counts ("are you a bot", "is this automated", "am I talking to a real person", "u a bot"); the words alone do not
// ("do you have an automatic opening bin", "is a machine used to cut the doors", "can I see the computer design" are questions about kitchens; audit review of 16 Oct 2026). Any such question gets the honest line.
const ASKS_AI = /\b(?:are|r|were|is)\s+(?:you|u|ya)\s+(?:(?:a|an|actually|really|just)\s+)*(?:bot|robot|chat ?bot|chatgpt|a\.?i\.?|artificial intelligence|human|real person|real human|actual person|person|automated|machine|computer|virtual assistant)\b|\b(?:is|was)\s+this\s+(?:(?:a|an|actually|really)\s+)*(?:bot|robot|chat ?bot|chatgpt|ai|automated|human|real person|real human|a person)\b|\b(?:am\s+i|are\s+we)\s+(?:talking|speaking|chatting|texting|messaging|writing|typing)\s+(?:to|with)\s+(?:(?:a|an|some)\s+)*(?:real\s+|actual\s+)?(?:person|human|bot|robot|chat ?bot|ai|machine|computer|someone real|somebody real)\b|\b(?:u|you)\s+a\s+(?:bot|robot|ai|real person|human)\b/i;
const asksIfAi = (text) => ASKS_AI.test(String(text || ''));
// Audit 17 Oct 2026, problems 1 and 2 (a lead who replied "Hi", "Yes interested" or "what happens next?" was left with nothing to answer). Read from the customer's own words, not the model's labels:
// they say yes or that they are interested (not a visit agreement: the visit is OFFERED, once) ...
const INTEREST = /\b(?:yes+|yeah|yea|yeh|yep|yup|aye|interested|still looking|definitely|absolutely|sure|go on|go ahead|let'?s do it|sounds good|count me in)\b/i;
const NEGATIVE = /\b(?:no|nope|nah|not|never|don'?t|dont|cancel|stop)\b/i;
const keen = (words) => INTEREST.test(words) && !NEGATIVE.test(words);
// ... or they ask about the next step or how it all works (the visit IS the next step, so it is offered with the answer; a plain question of fact still is not).
const NEXT_STEP = /\b(?:what(?:'s|s| is)?\s+(?:the\s+)?(?:next|process|procedure)\b|what\s+(?:happens|do\s+(?:i|we)\s+do)\s+(?:next|now|after|from here)|how\s+(?:does|do|would)\s+(?:it|this|that|the process|the whole thing|it all)\s+work|how\s+(?:do|would|can)\s+(?:i|we)\s+(?:go about it|proceed|start|get started|go ahead|move forward)|where\s+do\s+(?:i|we)\s+go\s+from\s+here|next\s+steps?|what\s+are\s+the\s+steps)\b/i;
// Audit repairs of 17 Oct 2026 (both audits), read from the customer's own words:
// days given but not settled ("Tuesday or Thursday, but I need to check with my partner": Astra F3 B036) are a note, not a booking request;
const TENTATIVE = /\b(?:check with|need to check|have to check|got to check|let (?:you|u) know|get back to (?:you|u)|come back to (?:you|u)|not sure|confirm with|ask (?:my|the) (?:husband|wife|partner|other half|boss)|before anything is (?:arranged|booked|set)|i'?ll see|we'?ll see|subject to)\b/i;
// away for a long time, or they will contact us ("away for the next six weeks", "I'll contact you when the building work finishes": Astra F3 B034, B040): no more questions about weeks, no booking request;
const LONG_AWAY = /\b(?:weeks|months?|a while|for a bit|until|till|til|after (?:christmas|xmas|the new year|easter|the summer|the holidays)|in the new year|next year|when (?:the|our|we|i|it)\b[^.?!]{0,40}\b(?:finish\w*|done|back|over|ready|sorted|complete\w*)|(?:i'?ll|we'?ll|i will|we will)\s+(?:contact|ring|call|message|text|get in touch|be in touch|let (?:you|u) know|get back|come back))\b/i;
// a booked customer who cancels and refuses another date, or has gone elsewhere (Astra F3 A082; our audit G12): the "do you want to move it?" question is not asked;
const REFUSE_MOVE = /\b(?:(?:do ?n[o']?t|do not|no|not)\s+(?:want|need|looking for)\s+(?:a(?:nother|ny)?\s+(?:other\s+|new\s+|different\s+)?(?:date|day|time|visit|appointment)|to (?:re-?book|re-?schedule|move it|rearrange))|no (?:other|new|alternative|different) (?:date|day|time)|(?:another|other|a different) (?:company|crowd|firm|supplier|kitchen (?:company|supplier|fitter))|someone else|(?:gone|went|going|decided to go) with|no longer (?:need|want|interested|going ahead)|not (?:going ahead|interested any ?more)|changed (?:my|our) minds?)\b/i;
// "stop messaging me": a person decides (and records it); nothing more is sent by the receptionist
const STOP = /\b(?:stop (?:messaging|texting|contacting|sending)|unsubscribe|don'?t (?:message|text|contact) me|do not (?:message|text|contact) me|leave me alone|remove (?:me|my number))\b/i;
// a request for ANOTHER customer's details (Astra F7 A096): a clear refusal, never "Good question, I'll check with the team"
const PRIVACY = /\b(?:another|other|previous|last|a different|someone else'?s?)\s+(?:customer|client|person|household)s?'?\b[^.?!]{0,40}\b(?:address|number|phone|details|name|email|eircode|contact)\b|\b(?:address|number|phone|details|eircode|contact details)\b[^.?!]{0,30}\b(?:of|for)\s+(?:another|other|previous|the last|a)\s+(?:customer|client)s?\b/i;
// the project in the acknowledgement follows what the customer says NOW ("a utility room, not a full kitchen": Astra F8 A005, B049), never overwriting the records
function projectSaid(words) {
  const w = String(words || ''), kitchenNo = /\b(?:not|no|rather than|instead of|n't need)\b[^.?!]{0,15}\bkitchen\b/i.test(w), kitchen = /\bkitchen\b/i.test(w) && !kitchenNo;
  if (kitchen) return null;
  if (/\butilit(?:y|ies)\b/i.test(w)) return 'Utility room';
  if (/\bwardrobes?\b/i.test(w)) return 'Wardrobes';
  return null;
}
// An answer that already opens with a greeting gets no second one from the code (problem 4).
const GREETED = /^(?:hi|hello|hey|hiya|good (?:morning|afternoon|evening)|thanks|thank you)\b/i;
// Our old bare acknowledgement (the dead end itself): a chat left at it is treated as if the customer had only said hello.
const DEAD_END = /^(?:Hi\b[^.?!]{0,30}, )?thanks for getting back to us\.$/i;

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
// `ownLines`: the owner's lines when the knowledge path asks this plan for the consultation step after an answer (it passes no `kn`, so the knowledge branch is not entered twice).
function plan({ decision, consult, messages, booked, nowMs, natural = false, kn = null, who = null, ownLines = null }) {
  const none = { step: 'none', reply: null, handover: null, preference: null };
  const d = decision, hand = !!(d.handover && d.handover.needed), reason = (d.handover && d.handover.reason) || '';
  const visit = d.visit || (d.wantsConsultation ? 'asked' : 'none');
  const change = d.change && d.change !== 'none' ? d.change : (hand && /change booking/i.test(reason) ? 'move' : 'none');
  const out = (messages || []).filter((m) => m.direction === 'out'), said = (line) => out.some((m) => String(m.body || '').includes(line));
  const latest = latestMessages(messages, { natural }), words = latest.join('\n');
  // Automatic mode (nobody reads it first): the days and times must be in the customer's own latest words, and agreement to a visit counts only if we really offered one or their own words ask for one
  // (a "yes" to our welcome message labelled as agreement is not). In the staff flow a person reads the draft and the preference summary before anything is sent, so the model's reading stands there.
  const hasOutbound = out.length > 0, prefRaw = d.schedule && d.schedule.preference, prefHeard = natural ? heard(prefRaw, words, nowMs) : prefRaw;
  // Days given but not settled ("but I need to check with my partner") are kept as a note, never a booking request, whatever status the model gave them (Astra F3 B036).
  const tentativeNow = natural && !!prefHeard && prefHeard.status === 'available' && TENTATIVE.test(words), given = tentativeNow ? null : describe(prefHeard, nowMs);
  const prefStatus = tentativeNow ? 'tentative' : prefRaw && prefRaw.status;
  const whoNow = natural && projectSaid(words) ? { ...(who || {}), projectType: projectSaid(words) } : who;       // the acknowledgement names the project they ask about now
  const line = (k) => ((kn && kn.lines) || ownLines || {})[k] || LINES[k];                // the owner's line (Knowledge Centre) when there is one, else the default
  // The line that acknowledges a preference: for a visit asked for today or tomorrow, the "straight away" line (audit 17 Oct 2026, problem 5), never a promise of a time.
  const passOn = given && prefHeard && prefHeard.soon ? line('soon') : LINES.acknowledge;
  const person = (why) => ({ step: 'none', reply: null, handover: { needed: true, reason: why }, preference: null });
  const offered = !!(consult && consult.offered) || said(LINES.visit_offer), agreed = (visit === 'asked' || visit === 'agreed') && (!natural || offered || ASKS_VISIT.test(words));
  const question = hand || !!d.hasQuestion || ['asking_info', 'asking_price', 'complaint'].includes(d.intent);          // something a person has to answer (nothing is offered or asked meanwhile)
  // R3: the code-built acknowledgement (see ackLine). With no id from the model, an opener the model offered on the first message only means "say hello".
  const first = !out.some((m) => m.type !== 'template');
  const ackOf = () => ackLine(ACKS.includes(d.ack) ? d.ack : (opener(d.schedule && d.schedule.opener, hasOutbound) ? 'hello' : ''), whoNow, first);

  // 1. A customer who asks whether they are talking to a person or an AI is told the truth, in one short line, and handed over (the system never lets the model answer that itself). Decided by the model's
  //    label, its hand-over reason, OR the customer's own words: a truthful answer never depends on how the model worded a reason.
  if (d.special === 'asked_if_ai' || (hand && /asked if ai|\b(?:asks?|asked|asking|wants to know|wondering)\b[^.]{0,30}\b(?:whether|if)\b[^.]{0,40}\b(?:bot|robot|ai|a\.i|automated|real person|human)\b/i.test(reason)) || latest.some(asksIfAi)) return { step: 'asked_ai', reply: LINES.asked_ai, handover: { needed: true, reason: 'asked if AI' }, preference: null };

  // ORDER (audit 16 Oct 2026, finding 7): what the customer IS (upset, someone who wants a person, writing in another language, outside our area) comes before what they ask about a booking. A booked customer
  // who is upset and says "cancel" gets the complaint line and a person, not the sales question "do you want to move it?"; one who asks for a person is not asked about days. Order: asked-if-AI, complaint, the
  // special cases (person, language, area, declined job), a booking change, then everything else.
  // A complaint (the automatic receptionist only): the owner's one line, then a person takes over at once and the receptionist stops (PAUSE_STEPS). Nothing is answered, offered, asked or promised.
  if (natural && d.intent === 'complaint') return { step: 'complaint', reply: (kn && kn.lines.complaint) || LINES.complaint, handover: { needed: true, reason: 'complaint: upset customer' }, preference: null, ...(kn ? { kn: { state: 'special', special: 'complaint', blocked: [], topics: [] } } : {}) };
  if (kn && natural) {
    const special = { wants_person: ['human', kn.lines.human, 'asked for a person'], outside_area: ['outside_area', kn.lines.outside_area, 'outside the areas we cover: please review'], declined_job: ['declined_job', kn.lines.declined_job, 'a job we usually decline: please review'], other_language: ['other_language', kn.lines.other_language, 'message not in English'] }[d.special];
    // A customer who asks for a person and says when they are free: the days are recorded for the booking card too (audit 17 Oct 2026, problem 5).
    if (special) return { step: special[0], reply: special[1], handover: { needed: true, reason: special[2] }, preference: special[0] === 'human' && given && !booked ? given : null, kn: { state: 'special', special: d.special, blocked: [], topics: [] } };
  }

  // 2. A customer who already has a consultation booked. The booking is only ever changed by a person; nothing is said as done.
  if (booked && change !== 'none') {
    if (change === 'cancel') {
      // A cancellation that already says "no other date" or "we went with another company" is not asked "do you want to move it?" (Astra F3 A082; our audit G12). With published knowledge the customer gets
      // the owner's short line (nothing said as done); otherwise, and after our one question, a person takes it from here.
      const refused = natural && REFUSE_MOVE.test(words);
      if (!said(LINES.cancel_ask) && !refused) return { step: 'cancel_ask', reply: LINES.cancel_ask, handover: { needed: true, reason: 'wants to cancel booking' }, preference: null };
      if (natural && kn && refused) return { step: 'cancel_noted', reply: kn.lines.cancel_noted || LINES.cancel_noted, handover: { needed: true, reason: 'wants to cancel booking (no other date)' }, preference: null };
      return person('wants to cancel booking');                                          // they answered our one question (no / just cancel): a person takes it from here, silently
    }
    if (change === 'move') {
      const asked = said(LINES.change_ask);
      if (given) return { step: 'change_given', reply: LINES.acknowledge, handover: { needed: true, reason: 'wants to move booking: preference received' }, preference: given };
      return asked ? { step: 'change_pass_on', reply: LINES.no_preference, handover: { needed: true, reason: 'wants to move booking' }, preference: null } : { step: 'change_ask', reply: LINES.change_ask, handover: { needed: true, reason: 'wants to move booking' }, preference: null };
    }
    // The automatic receptionist with published knowledge sends the owner's short line first (owner's decision, 16 Oct 2026), then a person takes over; staff drafts and older setups stay silent as before.
    const line = (k, why) => (natural && kn && kn.lines[k] ? { step: k, reply: kn.lines[k], handover: { needed: true, reason: why }, preference: null } : person(why));
    if (change === 'move_specific') return line('booking_specific', 'wants the booking moved to a specific time (tomorrow, earlier, a date): needs you');
    if (change === 'confirm') return line('booking_confirm', 'asks you to confirm the booking');
    if (change === 'late') return line('late', 'running late for the booking');
  }


  // 2a'. A photo, voice note, video or file (the receptionist cannot see or hear them): the owner's short thank-you line, then a person takes over (owner's decision, 16 Oct 2026). Read from the message
  //      types, not from the model. A sticker is not an attachment (it is treated like an emoji). A day in the caption ("Thursday suits") is recorded for the booking card (audit 17 Oct 2026, problem 5).
  if (natural && kn) {
    const types = latestBurst(messages, { natural }).map((m) => m.type), kind = types.includes('image') ? 'photo' : types.includes('audio') ? 'voice' : types.some((x) => x === 'video' || x === 'document') ? 'file' : null;
    if (kind && kn.lines[kind]) return { step: 'attachment', reply: kn.lines[kind], handover: { needed: true, reason: { photo: 'customer sent a photo', voice: 'customer sent a voice note', file: 'customer sent a video or file' }[kind] + ': please have a look' }, preference: given && !booked ? given : null };
  }

  // 2b. Step C: the owner has published knowledge, and this is the automatic receptionist. A customer who asks for a person, or whose job is outside our areas, a job we decline, or not in English, gets the
  //     owner's line and a person takes over. A question is ANSWERED from the knowledge first (the answer was checked in code), and only then does the Step A flow go on exactly as before: the visit is offered once,
  //     days are asked only after agreement, a preference is recorded. A question the knowledge does not answer (or an answer that failed the check) gets the holding line and a person takes over: never a guess.
  if (kn && natural) {
    // A reaction to a price ("that's a bit more than I thought") or "just looking at options", with nothing asked: the owner's line, no hand-over, no visit pushed (owner's decision, 16 Oct 2026).
    if ((d.special === 'price_concern' || d.special === 'browsing') && !hand && !d.hasQuestion && kn.lines[d.special]) return { step: d.special, reply: kn.lines[d.special], handover: null, preference: null, kn: { state: 'special', special: d.special, blocked: [], topics: [] } };
    const raw = String(d.reply || '').trim(), asking = d.hasQuestion || ['asking_info', 'asking_price'].includes(d.intent) || (d.intent === 'asking_price_general' && !!raw);
    if (asking && d.intent !== 'complaint') {
      const linkLine = kn.linksText(d.links), text = tidy(raw, { partly: hand || d.answerState === 'partly', links: !!linkLine }) || (linkLine ? 'Of course.' : '');
      const has = !!text && d.answerState !== 'none', chk = has ? kn.check(text) : { ok: true, reasons: [] }, ok = has && chk.ok;
      const state = ok ? (hand || d.answerState === 'partly' ? 'partly' : 'answered') : 'none', unknown = d.unknown ? ': ' + d.unknown : '';
      // A greeting before the first answer: written by code, and only when the answer does not already open with one (audit 17 Oct 2026, problem 4: "Hi Megan, thanks… Hi, thanks…").
      const links = ok ? linkLine : '', op = ok && first && (d.ack === 'hello' || opener(d.schedule && d.schedule.opener, hasOutbound)) && !GREETED.test(text) ? ackLine('hello', who, true) : '';
      const sep = links ? '\n' : ' ', answer = ok ? (op ? op + ' ' : '') + text + (links ? '\n' + links : '') : '', info = { state, blocked: chk.reasons, topics: d.topics || [] };
      if (!ok) {
        // A request for ANOTHER customer's details gets a clear refusal, never "Good question, I'll check" (Astra F7 A096); a person is still told.
        if (PRIVACY.test([words, reason, d.unknown].join(' '))) return { step: 'privacy', reply: line('privacy'), handover: { needed: true, reason: 'asked for another customer\'s details (privacy)' }, preference: null, kn: info };
        // They also said when they are free ("can someone come out today?", "I can only do Saturdays"): recorded for the booking card while a person answers (audit 17 Oct 2026, problem 5). A visit asked
        // for today or tomorrow gets the "straight away" line; otherwise the customer is told their day was passed on and that the question will be checked (Astra F6 B076: "Wednesday suits. Will you bring
        // samples?" used to get only "Good question, I'll check with the team").
        if (given && !booked) return { step: 'acknowledge', reply: prefHeard.soon ? line('soon') : passOn + ' ' + (kn.lines.partly || kn.lines.holding), handover: { needed: true, reason: 'consultation preference received; they also asked something that needs you: ' + (reason || 'a question that needs the team') + unknown }, preference: given, kn: info };
        return { step: 'holding', reply: kn.lines.holding, handover: { needed: true, reason: (reason || 'a question that needs the team') + unknown }, preference: null, kn: info };
      }
      if (state === 'partly') {
        const why = (reason || 'part of the question needs the team') + unknown;
        if (given && !booked) return { step: 'acknowledge', reply: answer + sep + passOn, handover: { needed: true, reason: 'consultation preference received; they also asked something that needs you: ' + why }, preference: given, kn: info };
        return { step: 'answer_holding', reply: answer + sep + (kn.lines.partly || kn.lines.holding), handover: { needed: true, reason: why }, preference: null, kn: info };
      }
      // fully answered: the answer goes first, then whatever the consultation flow would have said, with the question taken out of the picture. No acknowledgement goes between the two: the answer
      // is the acknowledgement, and the only greeting is the one in front of it (problem 4). A greeting that came with a question is a message about their project like any other.
      const neutral = { ...d, hasQuestion: false, reply: '', answerState: null, special: 'none', links: [], ack: 'none', handover: { needed: false, reason: null }, schedule: { preference: d.schedule && d.schedule.preference, opener: '' },
        intent: ['asking_info', 'asking_price', 'greeting'].includes(d.intent) ? 'answering_questions' : d.intent };
      const core = plan({ decision: neutral, consult, messages, booked, nowMs, natural, kn: null, who, ownLines: kn.lines });
      // A plain question of fact (does it include, do you supply, how long, what do you cover) is just answered: the visit is not attached to it. The offer waits for a message where they talk about their own project
      // or ask what kitchens cost, and is still made only once. (Owner's decision, 15 Oct 2026.) A question about the next step or how it works ("what happens next?") is not a plain fact: the visit IS the next
      // step, so it is offered with the answer (audit 17 Oct 2026, problem 2: 0 of 27 customers who asked it were offered the visit).
      // A customer who is just looking at options gets the answer and no offer either.
      if (core.step === 'offer_visit' && ((d.intent === 'asking_info' && !NEXT_STEP.test(words)) || d.special === 'browsing')) return { step: 'answer', reply: answer, handover: null, preference: null, kn: info };
      // "Send me your portfolio but don't arrange a visit yet": the answer is all they need, nothing for a person to do (Astra F5 A059 was handed over in silence after the links).
      if (core.step === 'declined' || core.step === 'thinking' || (core.step === 'none' && core.quiet)) return { step: 'answer', reply: answer, handover: null, preference: null, kn: info };
      if (core.step === 'none') return { step: 'answer', reply: answer, handover: core.handover, preference: core.preference, kn: info };
      return { ...core, reply: answer + sep + core.reply, kn: info };
    }
  }

  // 3. A general question about what kitchens cost is answered with the owner's fixed line; then, once, the offer of a visit (never a question about days before they agree).
  if (d.intent === 'asking_price_general' && !hand) {
    if (booked || visit === 'declined' || (consult && consult.stage === 'preference_given')) return { step: 'price_general', reply: LINES.price_general, handover: null, preference: null };
    if (given) return { step: 'acknowledge', reply: LINES.price_general + ' ' + passOn, handover: { needed: true, reason: 'consultation preference received: over to you to book' }, preference: given };
    if (agreed) { const next = askNext(consult, messages, null); return { ...next, reply: LINES.price_general + ' ' + next.reply }; }
    return offered ? { step: 'price_general', reply: LINES.price_general, handover: null, preference: null } : { step: 'price_offer', reply: LINES.price_general + ' ' + LINES.visit_offer, handover: null, preference: null };
  }
  if (booked) return none;                                                                 // booked and nothing about the booking: no consultation questions at all
  // No, not now, maybe later, or "can I think about it?": one friendly line, no hand-over and no booking request (owner's decision, 16 Oct 2026). Said once: after that, a repeat needs nothing.
  if (visit === 'declined') {
    // "Stop messaging me": no reply from the receptionist; a person decides (and records it).
    if (natural && STOP.test(words)) return person('customer asked us to stop messaging: please do not contact');
    // A decline with nothing asked gets the owner's line and no pause, also when the model wanted the owner told ("we've gone with someone else", "filled the form by accident": our audit F12, F14 were
    // handed over in silence). The owner still gets the push in that case; the chat stays open for the customer.
    const plain = !d.hasQuestion && !['asking_info', 'asking_price', 'complaint'].includes(d.intent);
    if (!(natural && (kn || ownLines) && plain)) return person('customer declined or wants to wait');
    const k = THINKING.test(words) ? 'thinking' : 'declined';
    if (said(line('declined')) || said(line('thinking'))) return { ...none, quiet: true };
    return { step: k, reply: line(k), handover: hand ? { needed: true, reason: reason || 'customer declined' } : null, preference: null };
  }

  // 4. They said when they are free: that is agreement. Record it (also when they ALSO asked something that needs a person: the question goes to the person together with the preference).
  if (given && d.intent !== 'complaint') {
    const extra = hand || !!d.hasQuestion || ['asking_info', 'asking_price'].includes(d.intent);
    return { step: 'acknowledge', reply: passOn, handover: { needed: true, reason: extra ? 'consultation preference received; they also asked something that needs you' + (reason ? ': ' + reason : '') : 'consultation preference received: over to you to book' }, preference: given };
  }
  // A customer unsure who is writing ("Who is this?") gets the code's one line saying who we are, whatever intent the model gave it (a real-model run on 16 Oct 2026 labelled it "other" and the chat was handed over in silence).
  // With no visit offered yet it goes on with the owner's question, so the reply does not end in a dead end (audit 17 Oct 2026, problem 1).
  if (natural && d.ack === 'confused' && !hand && ['other', 'greeting'].includes(d.intent)) return { step: 'ack_only', reply: ackLine('confused', who, first) + (offered ? '' : ' ' + line('still_looking')), handover: null, preference: null };
  if (consult && consult.stage === 'preference_given') return none;                       // already handed over; nothing new to ask or offer (a corrected preference was handled above)
  if (question) return none;                                                               // a question we cannot answer: a person answers it; nothing is offered or asked meanwhile

  // 5. They will check / are not available: no booking request, no pushing.
  const asks = asksSoFar(consult, messages);
  if (prefRaw && prefStatus === 'tentative') return { step: 'tentative', reply: LINES.tentative, handover: { needed: true, reason: 'customer will let us know' }, preference: noteOf({ ...prefRaw, status: 'tentative' }) };
  if (prefRaw && prefStatus === 'unavailable') {
    // One question about the following week only for a plain "not next week". Someone away for weeks, or who says they will contact us, gets "just let us know when suits" and a note: never a second
    // week question and never a booking request (Astra F3 B034, B040: "we'll be in touch to arrange a time" and a booking request for someone who said they would contact us).
    if (asks === 1 && !(natural && LONG_AWAY.test(words))) return { step: 'ask_following_week', reply: LINES.ask_following_week, handover: null, preference: null };
    if (asks >= MAX_ASKS && !natural) return { step: 'no_preference', reply: LINES.no_preference, handover: { needed: true, reason: 'no preference given after two questions' }, preference: noteOf(prefRaw) };
    return { step: 'tentative', reply: LINES.tentative, handover: { needed: true, reason: 'customer not available: ' + (prefRaw.text || 'no detail') }, preference: noteOf(prefRaw) };
  }

  // 6. Agreement: ask about days (the first question may carry a short acknowledgement: written by code in automatic mode).
  if (agreed) {
    const o = natural ? ackOf() : opener(d.schedule && d.schedule.opener, hasOutbound), next = askNext(consult, messages, null);
    return next.step === 'ask_next_week' ? { ...next, reply: (o ? o + ' ' : '') + next.reply } : next;
  }

  // 7. No agreement. An enquiry or interest gets the offer of a visit, once.
  //    In the STAFF flow (a person reads the draft) a reply the model wrote itself is kept as the draft: the person adds the offer if they want it.
  if (!natural && String(d.reply || '').trim()) return none;
  const ack = natural ? ackOf() : '', op = natural ? ack : opener(d.schedule && d.schedule.opener, hasOutbound);
  if (d.intent === 'greeting') {
    // Automatic mode, no visit offered yet (audit 17 Oct 2026, problem 1: "Hi", "Yes", "Yes interested" got only "Hi Leo, thanks for getting back to us." and 24 of 200 leads went cold). The reply always ends
    // with a next step: "yes", "interested" (or any answer to our "still looking?" question that is not a no) get the offer of a visit; anything else on the first reply ("Hi", "Hello", "ok", an emoji) gets
    // the greeting and the owner's question. A chat left at the old bare acknowledgement is picked up the same way when the customer writes again.
    if (natural && !offered) {
      const last = String((out[out.length - 1] || {}).body || '').trim(), askedStill = last.includes(line('still_looking')), deadEnd = DEAD_END.test(last);
      if (keen(words) || (askedStill && !NEGATIVE.test(words))) return first && !ack ? person('could not write a safe reply to the greeting') : { step: 'offer_visit', reply: (ack ? ack + ' ' : '') + LINES.visit_offer, handover: null, preference: null };
      if (first) return ack ? { step: 'ack_only', reply: ack + ' ' + line('still_looking'), handover: null, preference: null } : person('could not write a safe reply to the greeting');
      if (deadEnd) return { step: 'ack_only', reply: line('still_looking'), handover: null, preference: null };
      return none;
    }
    // Otherwise (staff drafts, or after the offer) a greeting gets a friendly acknowledgement on the FIRST reply only: after that, "ok" and "thanks" need no answer.
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
// A day given with a photo or with a request for a person is recorded like any other (audit 17 Oct 2026, problem 5): the booking card shows it, and the chat is already the owner's.
const WITH_PREFERENCE = new Set(['attachment', 'human']);
function advance(consult, step, preference, nowMs) {
  const cur = consult && typeof consult === 'object' ? consult : {};
  if (WITH_PREFERENCE.has(step)) step = preference && preference.status === 'available' ? 'acknowledge' : step;
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
  'answer', 'answer_holding', 'holding', 'human', 'outside_area', 'declined_job', 'other_language', 'complaint',
  'declined', 'thinking', 'price_concern', 'browsing', 'attachment', 'late', 'booking_confirm', 'booking_specific',      // the owner's lines added on 16 Oct 2026
  'cancel_noted', 'privacy']);                                                                                              // audit repairs of 17 Oct 2026 (proposed wording)
// After these the chat is the owner's: the receptionist stays out. ('answer' does too when a person has to follow up.)
const PAUSE_STEPS = new Set(['acknowledge', 'no_preference', 'asked_ai', 'change_given', 'change_pass_on', 'answer_holding', 'holding', 'human', 'outside_area', 'declined_job', 'other_language', 'complaint',
  'attachment', 'late', 'booking_confirm', 'booking_specific', 'cancel_noted', 'privacy']);      // declined, thinking, price_concern and browsing do NOT pause: the customer may write again
module.exports = { SEND_STEPS, PAUSE_STEPS, LINES, MAX_ASKS, WEEKDAYS, WEEKS, STATUSES, ACKS, THINKING, INTEREST, NEXT_STEP, cleanPreference, heard, reasonable, describe, noteOf, weekOf, asksSoFar, opener, acknowledgement, ackLine, firstName, latestMessages, latestBurst, asksIfAi, ASKS_VISIT, plan, advance };
