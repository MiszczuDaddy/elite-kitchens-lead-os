'use strict';
// Shared, pure calendar geometry. Elapsed minutes preserve duration even on 23/25-hour Dublin days.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./crm'));
  else root.CalendarLayout = factory(root.CRM);
})(this, function (CRM) {
  const MIN = 60000;
  function addDays(key, n) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
  function days(key, view) {
    if (view !== 'week') return [key];
    const weekday = new Date(key + 'T12:00:00Z').getUTCDay();
    const monday = addDays(key, -((weekday + 6) % 7));
    return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  }
  const range = key => CRM.rangeFor('custom', 0, { from: key, to: key });
  const ms = value => typeof value?.toMillis === 'function' ? value.toMillis() : value;
  function layout(appointments, key) {
    const { from, to } = range(key);
    const events = appointments.filter(a => ms(a.start) < to && ms(a.end) > from).map(a => ({
      appointment: a, start: Math.max(from, ms(a.start)), end: Math.min(to, ms(a.end)),
      top: (Math.max(from, ms(a.start)) - from) / MIN,
      duration: (Math.min(to, ms(a.end)) - Math.max(from, ms(a.start))) / MIN,
      continuesBefore: ms(a.start) < from, continuesAfter: ms(a.end) > to
    })).sort((a, b) => a.start - b.start || b.end - a.end || a.appointment.id.localeCompare(b.appointment.id));
    let group = [], ends = [], groupEnd = -Infinity;
    const finish = () => { for (const event of group) event.columns = ends.length; group = []; ends = []; };
    for (const event of events) {
      if (event.start >= groupEnd) { finish(); groupEnd = -Infinity; }
      let column = ends.findIndex(end => end <= event.start);
      if (column < 0) column = ends.length;
      ends[column] = event.end; event.column = column;
      group.push(event); groupEnd = Math.max(groupEnd, event.end);
    }
    finish();
    return { from, to, minutes: (to - from) / MIN, events };
  }
  function slots(key) {
    const { from, to } = range(key);
    const format = ms => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
    const out = [];
    for (let at = from; at < to; at += 30 * MIN) out.push({ at, minute: (at - from) / MIN, time: format(at) });
    // The existing backend chooses the later instance of an ambiguous autumn time.
    // Do not offer the earlier occurrence for new bookings.
    for (const slot of out) slot.bookable = !out.some(other => other.at > slot.at && other.time === slot.time);
    return out;
  }
  return { addDays, days, range, layout, slots };
});
