'use strict';
// Elite Kitchens Lead OS: pipeline maths. Pure functions only (no DOM, no Firebase) so they can be unit-tested in Node.
// Pipeline: New lead (stored as "inbox") -> Booked -> Quoted -> Won -> Closed.
// Closed = a lead that is no longer active and did NOT become a customer. Won stays Won, even after the job is finished.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.CRM = factory();
})(this, function () {
  const TZ = 'Europe/Dublin';
  const DAY = 86400000;
  const STAGES = ['inbox', 'booked', 'quoted', 'won', 'closed'];
  const LABELS = { inbox: 'New lead', booked: 'Booked', quoted: 'Quoted', won: 'Won', closed: 'Closed' };
  const stageOf = (c) => (c && STAGES.includes(c.inboxStatus) ? c.inboxStatus : 'inbox');

  const toMs = (t) => {
    if (t == null) return null;
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (t instanceof Date) return t.getTime();
    return typeof t === 'number' && isFinite(t) ? t : null;
  };

  // One row per customer: the conversation (stage + dates) joined with the contact (quote value, source, details).
  // Old customers simply have no stageDates / quoteValue: they come through as null, never as an error.
  function buildRows(convs, contacts) {
    const byId = new Map((contacts || []).map((c) => [c.id, c]));
    return (convs || []).map((cv) => {
      const ct = byId.get(cv.id) || {};
      const sd = cv.stageDates || {};
      const q = ct.quoteValue;
      return {
        id: cv.id,
        name: ct.name || cv.name || null,
        location: ct.location || cv.location || null,
        projectType: ct.projectType || cv.projectType || null,
        source: ct.source || null,
        email: ct.email || null,
        status: stageOf(cv),
        createdAt: toMs(cv.createdAt) ?? toMs(ct.createdAt),
        updatedAt: toMs(cv.updatedAt),
        stageDates: { booked: toMs(sd.booked), quoted: toMs(sd.quoted), won: toMs(sd.won), closed: toMs(sd.closed) },
        quoteValue: typeof q === 'number' && isFinite(q) && q > 0 ? q : null,
        unread: cv.unreadCount > 0,
      };
    });
  }

  // ---- Dublin calendar helpers (Intl, no library) ----
  function dublinParts(ms) {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
  }
  function offsetAt(ms) {
    const p = dublinParts(ms);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
  }
  function dublinMidnight(y, m, d) {       // the instant Dublin's clock reads 00:00 on that date (month may overflow: m=13 is January)
    const guess = Date.UTC(y, m - 1, d);
    const t = guess - offsetAt(guess);
    return guess - offsetAt(t);
  }
  const ymd = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); return m ? [+m[1], +m[2], +m[3]] : null; };

  // range = null (all time) | { from, to } in ms, from inclusive / to exclusive; either bound may be null.
  function rangeFor(preset, now, custom) {
    if (preset === 'month') { const p = dublinParts(now); return { from: dublinMidnight(p.y, p.m, 1), to: dublinMidnight(p.y, p.m + 1, 1) }; }
    if (preset === '30d') { const p = dublinParts(now); return { from: dublinMidnight(p.y, p.m, p.d) - 29 * DAY, to: now + 1 }; }
    if (preset === 'custom') {
      const a = ymd(custom && custom.from), b = ymd(custom && custom.to);
      if (!a && !b) return null;
      return { from: a ? dublinMidnight(a[0], a[1], a[2]) : null, to: b ? dublinMidnight(b[0], b[1], b[2] + 1) : null };
    }
    return null;
  }
  const inRange = (ms, range) => ms != null && (!range || ((range.from == null || ms >= range.from) && (range.to == null || ms < range.to)));

  // ---- overview ----
  // "Event" numbers (new leads, quoted, won, ...) are counted by the date the stage was entered, inside the chosen period.
  // Customers from before stage dates existed have no date: they are counted from their CURRENT stage in the all-time view only.
  const BOOKED_OR_LATER = ['booked', 'quoted', 'won'];
  const QUOTED_OR_LATER = ['quoted', 'won'];
  const sum = (rows) => rows.reduce((t, r) => t + (r.quoteValue || 0), 0);

  function overview(rows, range) {
    const entered = (r, stage, okStatuses) => {      // did this customer enter `stage` in the period?
      const d = r.stageDates[stage];
      return d != null ? inRange(d, range) : (!range && okStatuses.includes(r.status));
    };
    const newLeads = rows.filter((r) => !range || inRange(r.createdAt, range));
    const booked = rows.filter((r) => entered(r, 'booked', BOOKED_OR_LATER));
    const quoted = rows.filter((r) => entered(r, 'quoted', QUOTED_OR_LATER));
    const won = rows.filter((r) => r.status === 'won' && entered(r, 'won', ['won']));   // moved back out of Won by mistake: not a win
    const closed = rows.filter((r) => r.status === 'closed' && entered(r, 'closed', ['closed']));
    const wonWithValue = won.filter((r) => r.quoteValue);

    // Conversion is measured on the people who became leads in the period, so it can never exceed 100%.
    const cohort = range ? rows.filter((r) => inRange(r.createdAt, range)) : rows;
    const reachedBooked = (r) => r.stageDates.booked != null || BOOKED_OR_LATER.includes(r.status);
    const reachedQuoted = (r) => r.stageDates.quoted != null || QUOTED_OR_LATER.includes(r.status);
    const quotedCohort = cohort.filter(reachedQuoted);
    const open = rows.filter((r) => r.status === 'quoted');

    return {
      newLeads: newLeads.length,
      booked: booked.length,
      quoted: { count: quoted.length, value: sum(quoted) },
      won: { count: won.length, value: sum(won), avg: wonWithValue.length ? Math.round(sum(wonWithValue) / wonWithValue.length) : null },
      closed: closed.length,
      openQuotes: { count: open.length, value: sum(open), missingValue: open.filter((r) => !r.quoteValue).length },
      leadToBooked: { num: cohort.filter(reachedBooked).length, den: cohort.length },
      quoteToWon: { num: cohort.filter((r) => r.status === 'won').length, den: quotedCohort.length },
    };
  }

  // ---- board ----
  const digits = (s) => String(s || '').replace(/\D/g, '');
  function matches(r, q) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return true;
    if ([r.name, r.location, r.projectType, r.source].some((v) => String(v || '').toLowerCase().includes(q))) return true;
    const d = digits(q);
    return !!d && (r.id.includes(d) || (d.startsWith('0') && r.id.includes(d.slice(1))));
  }
  function filterRows(rows, { query, source, added } = {}) {
    return rows.filter((r) => matches(r, query) && (!source || r.source === source) && (!added || inRange(r.createdAt, added)));
  }
  function lanes(rows) {
    const out = Object.fromEntries(STAGES.map((s) => [s, { stage: s, label: LABELS[s], rows: [], value: 0, missingValue: 0 }]));
    for (const r of rows) {
      const l = out[r.status]; l.rows.push(r);
      if (r.quoteValue) l.value += r.quoteValue; else if (r.status === 'quoted') l.missingValue++;
    }
    for (const l of Object.values(out)) l.rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return out;
  }
  const sourcesOf = (rows) => [...new Set(rows.map((r) => r.source).filter(Boolean))].sort();

  // Whole days spent in the current stage, or null when unknown (old customers have no stage date).
  function daysInStage(r, now) {
    const d = r.status === 'inbox' ? r.createdAt : r.stageDates[r.status];
    return d == null ? null : Math.max(0, Math.floor((now - d) / DAY));
  }

  // ---- money ----
  const money = (n) => (n == null ? '' : '€' + Math.round(n).toLocaleString('en-IE'));
  // "€14,500" / "14500" / "14.5k" -> 14500; "" -> null; anything else -> NaN
  function parseMoney(text) {
    const t = String(text == null ? '' : text).replace(/[€\s,]/g, '').toLowerCase();
    if (!t) return null;
    let m = /^(\d+(?:\.\d+)?)k$/.exec(t); if (m) return Math.round(parseFloat(m[1]) * 1000);
    m = /^\d+(?:\.\d{1,2})?$/.exec(t); if (m) return Math.round(parseFloat(t));
    return NaN;
  }
  const rate = (r) => (!r.den ? '—' : `${r.num} of ${r.den}` + (r.den >= 5 ? ` · ${Math.round((r.num / r.den) * 100)}%` : ''));

  return { STAGES, LABELS, stageOf, buildRows, rangeFor, inRange, overview, filterRows, lanes, sourcesOf, daysInStage, money, parseMoney, rate, matches };
});
