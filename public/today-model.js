'use strict';
// Elite Kitchens Lead OS: the rules behind the "Today" tab (Phase 11, docs/PHASE11_TODAY.md). Pure functions only (no DOM, no Firebase), so they can be unit-tested in Node.
// THE IDEA: nothing on Today is a stored task. Every card is WORKED OUT from what Elite OS already knows (the chats, the receptionist's hand-overs, appointments, quotes, reminders), so it
//   * cannot be duplicated (one card per customer: its reasons are tags on that card),
//   * goes away by itself the moment the cause is gone (a reply was sent, the visit was booked, the quote was accepted),
//   * and cannot vanish for any other reason. The only things that hide a card on purpose are a reminder marked Done, and a quote follow-up the person snoozed.
// The only stored things are reminders (the person's own) and quote snoozes (a note: "do not show this quote until ...", tied to the quote's sent date so a re-sent quote comes back).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./consult-model.js')); else root.TodayModel = factory(root.ConsultModel);
})(this, function (CM) {
  const TZ = 'Europe/Dublin', MIN = 60000, HOUR = 3600000, DAY = 86400000;
  const AMBER_MIN = 30, RED_MIN = 120;                  // a message waiting: amber after 30, red after 120 WORKING minutes (08:00 to 20:00 Irish time)
  const WORK_FROM = 8, WORK_TO = 20;
  const REPLY_WINDOW_MS = 60 * DAY, HANDOVER_WINDOW_MS = 14 * DAY, QUOTE_WINDOW_MS = 60 * DAY;
  const QUOTE_AMBER_DAYS = 5, QUOTE_RED_DAYS = 10;
  const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : typeof t === 'number' && isFinite(t) ? t : null);
  const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };

  // ---- Irish time (Intl, no library) ----
  function parts(t) {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
  }
  const offsetAt = (t) => { const p = parts(t); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(t / MIN) * MIN; };
  function dublinMs(y, m, d, h, mi) {                    // the instant Irish clocks show y-m-d h:mi (the hour that does not exist is moved on)
    const guess = Date.UTC(y, m - 1, d, h, mi);
    return guess - offsetAt(guess - offsetAt(guess));
  }
  const pad = (n) => String(n).padStart(2, '0');
  const dateKey = (t) => { const p = parts(t); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
  const keyParts = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(k || '')); return m ? [+m[1], +m[2], +m[3]] : null; };
  const dayStart = (t) => { const p = parts(t); return dublinMs(p.y, p.m, p.d, 0, 0); };
  const daysBetween = (a, b) => { const x = keyParts(a), y = keyParts(b); return x && y ? Math.round((Date.UTC(y[0], y[1] - 1, y[2]) - Date.UTC(x[0], x[1] - 1, x[2])) / DAY) : 0; };
  const addDaysKey = (k, n) => { const x = keyParts(k), t = new Date(Date.UTC(x[0], x[1] - 1, x[2] + n)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };

  // Minutes between two instants that fall inside working time (every day, 08:00 to 20:00 Irish time). A message at 23:00 is not "late" at 07:00.
  function workMinutes(from, to) {
    if (!(to > from)) return 0;
    if (to - from > 120 * DAY) return (to - from) / MIN;                      // far too old to matter: never tidy-counted
    let [y, m, d] = keyParts(dateKey(from)), total = 0;
    for (let i = 0; i < 130; i++) {
      const ws = dublinMs(y, m, d, WORK_FROM, 0), we = dublinMs(y, m, d, WORK_TO, 0);
      if (ws > to) break;
      total += Math.max(0, Math.min(to, we) - Math.max(from, ws));
      const next = new Date(Date.UTC(y, m - 1, d + 1)); y = next.getUTCFullYear(); m = next.getUTCMonth() + 1; d = next.getUTCDate();
    }
    return total / MIN;
  }
  const urgencyOf = (wm) => (wm >= RED_MIN ? 2 : wm >= AMBER_MIN ? 1 : 0);      // 2 red, 1 amber, 0 normal

  // ---- what counts as nothing to answer ----
  // A message that is only a thank-you (with at most a few friendly words) needs no reply. Anything else, a question or "ok" or "yes", does (it may be a confirmation).
  const THANKS = new Set(['thanks', 'thank', 'thx', 'ty', 'cheers', 'appreciate', 'appreciated']);
  const FRIENDLY = new Set(['you', 'u', 'so', 'very', 'much', 'a', 'lot', 'million', 'again', 'for', 'that', 'the', 'your', 'help', 'reply', 'info', 'message', 'all', 'and', 'ok', 'okay', 'great', 'perfect', 'lovely', 'grand', 'brilliant',
    'super', 'cool', 'nice', 'noted', 'will', 'do', 'see', 'then', 'soon', 'many', 'lol', 'haha', 'good', 'amazing', 'excellent', 'fantastic', 'class', 'sound', 'x']);
  function isPleasantry(text) {
    const raw = String(text || '').trim();
    if (!raw || raw.length > 60 || /\?/.test(raw)) return false;
    const words = raw.toLowerCase().replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ').replace(/[^a-z\s']/g, ' ').split(/\s+/).filter(Boolean);
    if (!words.length) return /[\u{1F44D}\u{1F64F}\u{2764}\u{1F44F}]/u.test(raw) && raw.length <= 8;       // a thumbs-up, a prayer-hands or a heart on its own
    return words.length <= 8 && words.some((w) => THANKS.has(w)) && words.every((w) => THANKS.has(w) || FRIENDLY.has(w));
  }

  // ---- the receptionist's hand-over, in plain words ----
  // Returns null when the pause is not something for a person to do ("a person replied", "do not contact"). red: serious enough to be urgent straight away.
  function handoverWhy(paused) {
    const p = String(paused == null ? '' : paused).trim();
    if (!p || p === 'a person replied' || p === 'do not contact') return null;
    if (/stop messaging|do not contact/i.test(p)) return { text: 'The customer asked us to stop messaging them', red: true, stop: true };
    let m = /^handover:\s*(.+)$/i.exec(p);
    if (m) return { text: 'Passed on: ' + clip(m[1], 90), red: /complain|upset|angry|legal|refund/i.test(m[1]) };
    if (/consultation passed/i.test(p)) return { text: 'Gave days for a visit: over to you to book', red: false, consult: true };
    if (/^ai (failed|unavailable)/i.test(p)) return { text: 'The AI could not answer: please reply yourself', red: false };
    if (/send (failed|not confirmed)/i.test(p)) return { text: 'The automatic reply could not be sent or confirmed: check the chat', red: false };
    if (/asked if ai/i.test(p)) return { text: 'Asked if they are talking to an AI', red: false };
    if (/declined|wants to wait/i.test(p)) return { text: 'Said no or wants to wait', red: false };
    if (/draft failed|needs a person/i.test(p)) return { text: 'The receptionist was not sure how to answer', red: false };
    return { text: 'Passed on to you', red: false };
  }

  // A template message is stored as "[template: name] words": show the words, or just say it was a template (never the code name).
  const preview = (t) => { const x = String(t == null ? '' : t).replace(/^\[template:[^\]]*\]\s*/i, ''); return x ? clip(x, 110) : /^\[template/i.test(String(t || '')) ? 'A template message' : ''; };
  const stageOf = (c) => (c && c.inboxStatus) || 'inbox';
  const dnc = (c) => !!(c && c.doNotContact && c.doNotContact.on === true);
  const receptionistHandling = (c) => !!(c && c.receptionist && c.receptionist.on === true && !c.receptionist.paused);

  // ---- one chat -> its reasons ----
  // Priority when a customer has several (the card's heading): fix the lead, then book the visit, then the hand-over, then the reply.
  const PRIORITY = ['leadfix', 'booking', 'handover', 'reply'];
  function reasonsOf(c, ctx) {
    const { now, booked, today, leadFailed } = ctx, out = [];
    if (!c || dnc(c)) return out;
    const rec = c.receptionist || {}, lastIn = ms(c.lastInboundAt);
    if (leadFailed) out.push({ type: 'leadfix', text: leadFailed.text, since: leadFailed.at || null, urgency: 2 });
    const req = CM ? CM.requestOf(c, booked, today) : null;
    if (req) {
      const since = req.since, wm = since ? workMinutes(since, now) : 0;
      out.push({ type: 'booking', text: req.noPreference ? 'Waiting for you to book a visit: they gave no days, please get in touch' : 'Waiting for you to book a visit: ' + req.text, since, urgency: since && now - since >= DAY ? 2 : wm >= RED_MIN ? 1 : 0, bookOn: req.bookOn, bookAt: req.bookAt });
    }
    const why = handoverWhy(rec.paused), pausedAt = ms(rec.pausedAt);
    if (why && pausedAt && now - pausedAt <= HANDOVER_WINDOW_MS && !(ms(rec.humanAt) > pausedAt) && !(why.consult && booked && booked.has(String(c.id)))) {
      out.push({ type: 'handover', text: why.text, since: pausedAt, urgency: why.red ? 2 : urgencyOf(workMinutes(pausedAt, now)), alertFailed: !!rec.notifyFailed });
    }
    if (c.lastMessageDirection === 'in' && lastIn && now - lastIn <= REPLY_WINDOW_MS && !['closed', 'won'].includes(stageOf(c)) && !isPleasantry(c.lastMessage)) {
      const wm = workMinutes(lastIn, now);
      // the receptionist answers new messages itself: it is given the same 30 working minutes as a person before the message counts as waiting
      if (!(receptionistHandling(c) && wm < AMBER_MIN)) out.push({ type: 'reply', text: receptionistHandling(c) ? 'The receptionist has not answered yet' : 'Waiting for your reply', since: lastIn, urgency: urgencyOf(wm), windowClosed: now - lastIn >= DAY });
    }
    return out.sort((a, b) => PRIORITY.indexOf(a.type) - PRIORITY.indexOf(b.type));
  }

  // ---- quotes ----
  const quoteKey = (id) => 'quote|' + id;
  function quoteCards(quotes, marks, convById, now) {
    const today = dateKey(now), out = [];
    for (const q of quotes || []) {
      const sent = ms(q.sentAt);
      if (!q || q.status !== 'sent' || !sent || now - sent > QUOTE_WINDOW_MS) continue;
      const days = daysBetween(dateKey(sent), today);
      if (days < QUOTE_AMBER_DAYS) continue;
      const mk = (marks || {})[quoteKey(q.id)];
      if (mk && mk.basis === sent && ms(mk.snoozeUntil) > now) continue;       // snoozed: only for THIS send of the quote
      const conv = convById.get(String(q.phone)) || {};
      out.push({ key: quoteKey(q.id), kind: 'quote', quoteId: q.id, phone: String(q.phone || ''), name: q.customerName || conv.name || '', ref: q.ref || '', price: q.summary && q.summary.dearest ? q.summary.dearest.incVat : null,
        reasons: [{ type: 'quote', text: `Sent ${days} days ago, no answer${q.validUntil && q.validUntil < today ? ' (expired)' : ''}`, since: sent, urgency: days >= QUOTE_RED_DAYS ? 2 : 1 }], urgency: days >= QUOTE_RED_DAYS ? 2 : 1, since: sent, primary: 'quote' });
    }
    return out;
  }

  // ---- reminders ----
  const dueMs = (r) => (r.dueTime ? dublinMs(...keyParts(r.dueDate), ...r.dueTime.split(':').map(Number)) : null);
  function reminderState(r, now) {                       // 'overdue' | 'today' | 'later'
    const today = dateKey(now);
    if (r.dueDate > today) return 'later';
    if (r.dueDate < today) return 'overdue';
    const t = dueMs(r);
    return t != null && now >= t ? 'overdue' : 'today';
  }

  // ---- everything ----
  // input: { convs: [{id, ...conversation}], appts, quotes, reminders, marks: { 'quote|id': {basis, snoozeUntil, at} }, leadIssues, contactsToday, ledger: { leadId: ledger doc }, now }
  function build(input) {
    const now = input.now == null ? Date.now() : input.now, today = dateKey(now), t0 = dayStart(now);
    const convs = input.convs || [], convById = new Map(convs.map((c) => [String(c.id), c]));
    const booked = input.appts ? CM.bookedPhones(input.appts, now) : null;                 // null while appointments are still loading: no visit card yet
    const contacts = new Map((input.contactsToday || []).map((c) => [String(c.id), c]));
    const ledger = input.ledger || {};
    const failureOf = (phone, c) => {                    // a Meta lead whose welcome message did not go, until a person (or the customer) has been in touch since
      const ct = contacts.get(String(phone)), ml = ct && ct.metaLead, led = ml && ledger[ml.leadId], w = led && led.welcome && led.welcome.state;
      if (!w || !['failed', 'unknown'].includes(w)) return null;
      const at = ms(ml.receivedAt) || 0, rec = (c && c.receptionist) || {};
      if (ms(rec.humanAt) > at || ms(c && c.lastInboundAt) > at) return null;
      return { at, text: w === 'failed' ? 'The welcome message was refused: please message them yourself' : 'Could not confirm the welcome message went: please check the chat' };
    };
    // customers
    const cards = [];
    for (const c of convs) {
      const rs = reasonsOf(c, { now, booked, today, leadFailed: failureOf(c.id, c) });
      if (!rs.length) continue;
      const head = rs[0], urgency = Math.max(...rs.map((r) => r.urgency));
      cards.push({ key: 'c|' + c.id, kind: 'customer', phone: String(c.id), name: c.name || '', facts: [c.projectType, c.location].filter(Boolean).join(' · '), reasons: rs, urgency, since: head.since, primary: head.type,
        last: { text: preview(c.lastMessage), mine: c.lastMessageDirection === 'out' } });
    }
    cards.push(...quoteCards(input.quotes, input.marks, convById, now));
    const later = [], doneToday = [];
    for (const r of input.reminders || []) {
      if (!r || !keyParts(r.dueDate)) continue;
      if (r.status === 'done') { if (ms(r.doneAt) && dateKey(ms(r.doneAt)) === today) doneToday.push({ kind: 'reminder', id: r.id, title: r.title, at: ms(r.doneAt) }); continue; }
      if (r.status !== 'open') continue;
      const st = reminderState(r, now), card = { key: 'r|' + r.id, kind: 'reminder', reminderId: r.id, phone: r.phone ? String(r.phone) : '', name: r.customerName || '', title: r.title, dueDate: r.dueDate, dueTime: r.dueTime || null,
        reasons: [{ type: 'reminder', text: st === 'overdue' ? 'Overdue' : 'Due today', since: dueMs(r) || dublinMs(...keyParts(r.dueDate), 0, 0), urgency: st === 'overdue' ? 2 : 0 }], urgency: st === 'overdue' ? 2 : 0, primary: 'reminder' };
      card.since = card.reasons[0].since;
      (st === 'later' ? later : cards).push(card);
    }
    for (const li of input.leadIssues || []) {
      if (!li || li.status !== 'open') continue;
      cards.push({ key: 'l|' + (li.leadId || li.id), kind: 'lead', leadId: li.leadId || li.id, phone: '', name: li.name || 'A lead with no name', email: li.email || null, phoneTyped: li.phoneTyped || null, location: li.location || null,
        reasons: [{ type: 'leadfix', text: li.reasonText || 'The lead could not be added', since: ms(li.receivedAt), urgency: 2 }], urgency: 2, since: ms(li.receivedAt), primary: 'leadfix', lead: li });
    }
    for (const [id, mk] of Object.entries(input.marks || {})) {      // quotes followed up or snoozed today (so the action can be undone)
      if (id.startsWith('quote|') && ms(mk.at) && dateKey(ms(mk.at)) === today && ms(mk.snoozeUntil) > now) doneToday.push({ kind: 'quote', id: id.slice(6), title: mk.ref ? 'Quote ' + mk.ref : 'A quote', at: ms(mk.at) });
    }
    cards.sort((a, b) => (b.urgency - a.urgency) || ((a.since == null) - (b.since == null)) || ((a.since || 0) - (b.since || 0)));
    later.sort((a, b) => (a.dueDate + (a.dueTime || '')).localeCompare(b.dueDate + (b.dueTime || '')));
    doneToday.sort((a, b) => b.at - a.at);
    const counts = { reply: 0, handover: 0, booking: 0, quote: 0, reminder: 0, leadfix: 0 }, red = { reply: 0, handover: 0, booking: 0, quote: 0, reminder: 0, leadfix: 0 };
    for (const c of cards) for (const t of new Set(c.reasons.map((r) => r.type))) { counts[t]++; if (c.reasons.some((r) => r.type === t && r.urgency === 2)) red[t]++; }
    // visits today and tomorrow
    const tomorrow = addDaysKey(today, 1), visits = (input.appts || []).filter((a) => a && a.status === 'scheduled' && ms(a.start) && [today, tomorrow].includes(dateKey(ms(a.start))))
      .sort((a, b) => ms(a.start) - ms(b.start)).map((a) => ({ id: a.id, phone: String(a.phone || ''), name: a.customerName || '', start: ms(a.start), today: dateKey(ms(a.start)) === today, type: a.type || 'consultation' }));
    return { cards, counts, red, redTotal: cards.filter((c) => c.urgency === 2).length, later, doneToday, visits, newLeads: newLeads({ convs, convById, contacts, ledger, leadIssues: input.leadIssues, now, today, t0, booked }) };
  }

  // ---- New Leads Today: every lead that arrived today, with ONE status ----
  const LEAD_ORDER = ['failed', 'needs', 'ai', 'contacted'];
  function newLeads({ convs, convById, contacts, ledger, leadIssues, now, today, t0, booked }) {
    const phones = new Set();
    for (const c of convs) if (ms(c.createdAt) >= t0) phones.add(String(c.id));
    for (const [id, ct] of contacts) if (ct.metaLead && ms(ct.metaLead.receivedAt) >= t0) phones.add(id);
    const items = [];
    for (const phone of phones) {
      const c = convById.get(phone), ct = contacts.get(phone) || {}, ml = ct.metaLead || null, led = ml && ledger[ml.leadId], w = led && led.welcome && led.welcome.state;
      if (!c) continue;
      const at = (ml && ms(ml.receivedAt)) || ms(c.createdAt) || ms(ct.createdAt), rs = reasonsOf(c, { now, booked, today, leadFailed: null }), rec = c.receptionist || {};
      let status, text;
      if (w && ['failed', 'unknown'].includes(w) && !(ms(rec.humanAt) > at) && !(ms(c.lastInboundAt) > at)) { status = 'failed'; text = w === 'failed' ? 'The welcome message was refused' : 'Could not confirm the welcome message went'; }
      else if (dnc(c)) { status = 'needs'; text = 'Asked not to be contacted'; }
      else if (rs.length) { status = 'needs'; text = rs[0].text; }
      else if (!c.lastMessageDirection && !ms(c.lastInboundAt)) { status = 'needs'; text = 'No message has been sent to them yet'; }
      else if (receptionistHandling(c)) { status = 'ai'; text = 'The receptionist is handling it'; }
      else { status = 'contacted'; text = w === 'blocked' ? 'Welcome message held back' : ms(rec.humanAt) > at || c.lastMessageDirection === 'out' ? 'Contacted' : 'Welcome message sent'; }
      items.push({ phone, name: c.name || ct.name || '', facts: [c.projectType || ct.projectType, c.location || ct.location].filter(Boolean).join(' · '), source: ml ? 'Meta form' : (ct.source || 'WhatsApp'), at, status, text });
    }
    for (const li of leadIssues || []) {                  // a lead with no usable phone number: there is no customer, only the saved form
      if (!li || li.status !== 'open' || !(ms(li.receivedAt) >= t0)) continue;
      items.push({ phone: '', leadId: li.leadId || li.id, name: li.name || 'A lead with no name', facts: [li.location].filter(Boolean).join(' · '), source: 'Meta form', at: ms(li.receivedAt), status: 'needs', text: 'Could not be added: ' + (li.reasonText || 'bad phone number'), lead: li });
    }
    items.sort((a, b) => (LEAD_ORDER.indexOf(a.status) - LEAD_ORDER.indexOf(b.status)) || (b.at - a.at));
    const counts = { failed: 0, needs: 0, ai: 0, contacted: 0 }; for (const i of items) counts[i.status]++;
    return { items, counts, total: items.length };
  }

  const LABEL = { reply: 'Replies', handover: 'Handovers', booking: 'Book a visit', quote: 'Quotes', reminder: 'Reminders', leadfix: 'Leads to fix' };
  const TYPES = Object.keys(LABEL);
  const STATUS_LABEL = { failed: 'Contact failed', needs: 'Needs you', ai: 'AI handling', contacted: 'Contacted' };
  const filterCards = (cards, type) => (type ? cards.filter((c) => c.reasons.some((r) => r.type === type)) : cards);
  // How long, in words: "3 h 10 m", "45 m", "2 days".
  function since(t, now) {
    if (t == null) return '';
    const d = Math.max(0, now - t), m = Math.floor(d / MIN);
    if (m < 2) return 'just now';
    if (m < 60) return m + ' m';
    if (m < 24 * 60) return Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' m' : '');
    const days = Math.floor(d / DAY); return days + (days === 1 ? ' day' : ' days');
  }
  return { build, newLeads, preview, reasonsOf, handoverWhy, isPleasantry, workMinutes, urgencyOf, reminderState, filterCards, since, dateKey, addDaysKey, daysBetween, dayStart, dublinMs, quoteKey, LABEL, TYPES, STATUS_LABEL, PRIORITY, AMBER_MIN, RED_MIN, QUOTE_AMBER_DAYS, QUOTE_RED_DAYS };
});
