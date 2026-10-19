'use strict';
// Elite Kitchens Lead OS: the arithmetic behind "Needs attention" (Phase 10, docs/PHASE10_SAFETY_NET.md). Pure functions only (no DOM, no Firebase), so they can be unit-tested.
// The words of each PROBLEM come from the server (healthIssues: title, help), so they are written in one place only.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.AttentionModel = factory();
})(this, function () {
  const TZ = 'Europe/Dublin';
  const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const CHECK_STALE_MS = 30 * MIN;                        // the health check runs every 10 minutes: three missed runs is a problem in itself
  const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : typeof t === 'number' && isFinite(t) ? t : null);

  function ago(t, now) {
    const v = ms(t); if (v == null) return '';
    const d = Math.max(0, now - v);
    if (d < 2 * MIN) return 'just now';
    if (d < HOUR) return Math.round(d / MIN) + ' minutes ago';
    if (d < 2 * HOUR) return 'an hour ago';
    if (d < DAY) return Math.round(d / HOUR) + ' hours ago';
    return new Intl.DateTimeFormat('en-IE', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(v));
  }
  const day = (t) => { const v = ms(t); return v == null ? '' : new Intl.DateTimeFormat('en-IE', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(v)); };

  // The health check itself has stopped (or never started): shown as a problem of its own, worked out here because nothing else can report it.
  function checkProblem(heartbeats, now) {
    const at = ms(heartbeats && heartbeats.healthSweepAt);
    if (at == null || now - at <= CHECK_STALE_MS) return null;
    return { kind: 'health_check_stopped', local: true, title: 'The health check has stopped', help: 'Elite OS checks itself every 10 minutes, but the last check was ' + ago(at, now) + '. Problems may not be noticed until it runs again. Report it.', since: at, count: 1 };
  }

  // Everything that needs a person, in the order it is shown. Each list is newest first.
  function build({ issues = [], leads = [], convs = [], heartbeats = null } = {}, now = Date.now()) {
    const problems = issues.filter((i) => i && i.status === 'open').map((i) => ({ kind: i.kind || i.id, title: i.title || 'A problem was detected', help: i.help || '', since: ms(i.openedAt), last: ms(i.lastAt),
      count: i.count || 1, detail: i.detail || null, alert: (i.alert && i.alert.state) || null })).sort((a, b) => (b.since || 0) - (a.since || 0));
    const stopped = checkProblem(heartbeats, now); if (stopped) problems.unshift(stopped);
    const alerts = convs.filter((c) => c && c.receptionist && c.receptionist.notifyFailed).map((c) => ({ phone: c.id, name: c.name || null, at: ms(c.receptionist.notifyFailed.at),
      why: c.receptionist.notifyFailed.why || null, emailed: !!(c.receptionist.notifyFailed.alert && c.receptionist.notifyFailed.alert.emailOk) })).sort((a, b) => (b.at || 0) - (a.at || 0));
    const leadItems = leads.filter((l) => l && l.status === 'open').map((l) => ({ leadId: l.leadId || l.id, name: l.name || null, email: l.email || null, phoneTyped: l.phoneTyped || null,
      location: l.location || null, formName: l.formName || null, reason: l.reasonText || 'The lead could not be added.', at: ms(l.receivedAt), attempts: l.attempts || 1 })).sort((a, b) => (b.at || 0) - (a.at || 0));
    return { problems, alerts, leads: leadItems, count: problems.length + alerts.length + leadItems.length };
  }

  const barText = (n) => (n === 1 ? '1 thing needs attention' : n + ' things need attention');

  function checksText(heartbeats, now) {
    const at = ms(heartbeats && heartbeats.healthSweepAt);
    if (at == null) return 'The health check has not run yet (it starts once the Phase 10 server is deployed).';
    return 'Elite OS checked itself ' + ago(at, now) + (now - at > CHECK_STALE_MS ? ' (overdue).' : '. It checks every 10 minutes.');
  }
  function backupText(b, now) {
    if (!b || ms(b.lastDrillAt) == null) return 'Backups: no restore test recorded yet. Run ./scripts/setup-backups.sh drill from Cloud Shell (see docs/BACKUPS.md).';
    const when = day(b.lastDrillAt), from = b.backupTime ? ' of the backup taken ' + day(Date.parse(b.backupTime)) : '';
    const old = now - ms(b.lastDrillAt) > 120 * DAY ? ' It is over 4 months old: run it again.' : '';
    return b.ok ? `Backups: last restore test ${when}${from}: OK.${old}` : `Backups: the restore test on ${when}${from} FAILED. Do not rely on the backups; report it.`;
  }


  // "Do not contact" in words, for the chat and the customer's details.
  function dncText(d, now) {
    if (!d || d.on !== true) return null;
    const who = d.source === 'customer' ? 'The customer asked us to stop messaging them' : `Marked "do not contact" by ${d.by || 'staff'}`;
    return `${who} (${ago(d.at, now)})${d.note && d.source !== 'customer' ? ': ' + d.note : ''}. Messages, files, templates and quotes to them are blocked.`;
  }

  return { build, barText, checksText, backupText, dncText, ago, checkProblem, CHECK_STALE_MS };
});
