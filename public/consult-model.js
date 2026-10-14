'use strict';
// Elite Kitchens Lead OS: the logic behind the consultation request card (Phase 9 R2b, docs/AI.md). Pure functions only (no DOM, no Firebase), so they can be unit-tested in Node.
// A customer is "waiting for you to book" when the consultation flow has handed them over (conversations/{phone}.consult.needsBooking, set when a person sends the suggested
// hand-over message) AND they have no appointment still to come AND nobody pressed "Not needed". The card only ever shows what was recorded; nothing here books or sends anything.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.ConsultModel = factory();
})(this, function () {
  const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : typeof t === 'number' && isFinite(t) ? t : null);
  const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
  // Phone numbers of customers who have a scheduled appointment that has not ended yet.
  function bookedPhones(appts, nowMs) {
    const out = new Set();
    for (const a of appts || []) if (a && a.status === 'scheduled' && a.phone && (ms(a.end) == null || ms(a.end) >= nowMs)) out.add(String(a.phone));
    return out;
  }
  // The date the booking form should open on: the first day they named, but never in the past (then the form uses its own default).
  const openDate = (firstDate, todayKey) => (typeof firstDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(firstDate) && firstDate >= todayKey ? firstDate : null);
  // The time the booking form opens on, from what they said about the time of day: "after 3pm" -> 15:00, "4-6pm" -> 16:00, "mornings" -> 10:00, "afternoons" -> 14:00, "evenings" -> 18:00. null = the form's normal default.
  const pad2 = (n) => String(n).padStart(2, '0');
  function openTime(times) {
    const t = String(times == null ? '' : times).toLowerCase();
    if (!t.trim()) return null;
    const m = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/.exec(t);
    if (m) {
      let h = Number(m[1]); const min = Math.floor((m[2] ? Number(m[2]) : 0) / 15) * 15, ap = m[3] ? m[3][0] : '';
      if (h <= 12) { if (ap === 'p' && h < 12) h += 12; else if (ap === 'a' && h === 12) h = 0; else if (!ap && h >= 1 && h <= 6) h += 12; }          // "after 3" means 3 pm
      if (h >= 6 && h <= 21) return pad2(h) + ':' + pad2(min);
    }
    if (/morning/.test(t)) return '10:00'; if (/lunch/.test(t)) return '13:00'; if (/afternoon/.test(t)) return '14:00'; if (/evening|after work/.test(t)) return '18:00';
    return null;
  }
  // The request for one conversation, or null when nothing is waiting. `booked` is a Set of phones (null while appointments are still loading: then nothing is shown yet).
  function requestOf(conv, booked, todayKey) {
    const c = conv && conv.consult;
    if (!c || c.needsBooking !== true || !booked || booked.has(String(conv.id))) return null;
    const p = c.preference && typeof c.preference === 'object' ? c.preference : null;
    // As recorded when the hand-over was sent (ai.js aiDrafts/consult.preference): `summary` is the line with the real dates, `text` is what the customer said.
    const noPreference = !p || !p.summary;
    return {
      phone: String(conv.id), name: conv.name || '', noPreference, since: ms(c.at),
      text: noPreference ? '' : String(p.summary), customerWords: noPreference ? '' : clip(p.text, 160), bookOn: noPreference ? null : openDate(p.firstDate, todayKey), bookAt: noPreference ? null : openTime(p.times),
    };
  }
  const countOf = (convs, booked, todayKey) => (booked ? (convs || []).filter((c) => requestOf(c, booked, todayKey)).length : 0);
  // The last few messages of the chat as short plain lines, so the card shows what was actually said. Each is { mine, text }.
  function excerpt(msgs, n) {
    const rows = [];
    for (const m of msgs || []) {
      const body = clip(m && m.body, 220), kind = m && m.type && m.type !== 'text' ? '[' + m.type + ']' : '';
      const text = body || kind; if (!text) continue;
      rows.push({ mine: m.direction === 'out', text });
    }
    return rows.slice(-n);
  }
  // The clash line in the booking form: what is already booked on the chosen day, and whether the chosen time overlaps any of it. Only ever a warning.
  const hm = (t, tz) => new Date(t).toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz || 'Europe/Dublin' });
  function dayNote(appts, startMs, endMs, ignoreId) {
    const list = (appts || []).filter((a) => a && a.status !== 'cancelled' && a.id !== ignoreId && ms(a.start) != null && ms(a.end) != null).sort((a, b) => ms(a.start) - ms(b.start));
    if (!list.length) return { text: 'Nothing else booked that day.', clash: false };
    const clash = list.filter((a) => ms(a.start) < endMs && ms(a.end) > startMs);
    const line = (a) => `${hm(ms(a.start))}–${hm(ms(a.end))}${a.customerName ? ' ' + a.customerName : ''}`;
    return clash.length ? { text: 'Clashes with: ' + clash.map(line).join(', ') + '.', clash: true } : { text: 'Already booked that day: ' + list.map(line).join(', ') + '.', clash: false };
  }
  return { ms, bookedPhones, openDate, openTime, requestOf, countOf, excerpt, dayNote };
});
