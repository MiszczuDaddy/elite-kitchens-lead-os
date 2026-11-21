'use strict';
// Quiet hours: from midnight until 07:00 Irish time nothing is sent to a customer by itself. ONE rule for the whole system: the automatic receptionist (lib/aiReceptionist.js) and the welcome message of a new
// lead (lib/leads.js, lib/welcomeHold.js) both use it. Pure: it only reads a time.
const { dublinParts, dublinToMs } = require('./appointments');
const TZ = 'Europe/Dublin', QUIET_UNTIL_HOUR = 7;
const hourOf = (t) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date(t)));
const isQuiet = (t) => hourOf(t) < QUIET_UNTIL_HOUR;
// When sending may start: now, or 07:00 Irish time on the same day when it is still quiet (summer time and winter time are both handled by Dublin's own clock).
function openAtMs(t) {
  if (!isQuiet(t)) return t;
  const p = dublinParts(t);
  return dublinToMs(p.y, p.m, p.d, QUIET_UNTIL_HOUR, 0);
}
module.exports = { TZ, QUIET_UNTIL_HOUR, hourOf, isQuiet, openAtMs };
