'use strict';
// Elite Kitchens Lead OS: the arithmetic behind the "Notification speed" panel (Phase 8, docs/PUSH.md). Pure functions only (no DOM, no Firebase), so they can be unit-tested.
// Every number is a gap between two timestamps written by different steps, never an estimate. Be careful what each one means:
//   metaToBackend      Meta's own time of the message (seconds resolution, Meta's clock) -> our function received the request. This is Meta's delay plus the clock difference.
//   backendToSend      our function received it -> the push was handed to Firebase.
//   sendToAccepted     handed to Firebase -> Firebase answered "accepted". THIS IS NOT DELIVERY.
//   acceptedToDevice   Firebase accepted -> the service worker on the device woke up and reported it (our server's clock at the moment the report arrived: it includes the report's own trip).
//   total              our function received the request -> the device's report arrived. The honest "how long until the device had it".
//   deviceClockGap     what the device's own clock says minus what our server says for the same report: a big number means the device clock is wrong (do not trust the device-clock figure).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.PushModel = factory();
})(this, function () {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const diff = (a, b) => (num(a) !== null && num(b) !== null ? a - b : null);
  const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : num(t));
  const CLOCK_SUSPECT_MS = 30000;
  const METRICS = ['metaToBackend', 'backendToSend', 'sendToAccepted', 'acceptedToDevice', 'total'];

  // One row per device that was sent this notification.
  function rowsOf(event) {
    const e = event || {}, devices = e.devices || {}, receipts = e.receipts || {}, out = [];
    for (const [id, d] of Object.entries(devices)) {
      const r = receipts[id] || {}, got = r.received || null, clicked = r.clicked || null;
      const gap = got ? diff(got.serverAt, got.deviceAt) : null;
      out.push({
        eventId: e.id || null, deviceId: id, kind: e.kind || null, createdMs: ms(e.createdAt), platform: d.platform || 'other', ok: d.ok === true, error: d.error || null, status: e.status || null,
        metaToBackend: diff(e.backendReceivedAt, e.eventAt), backendToSend: diff(e.sendStartedAt, e.backendReceivedAt), sendToAccepted: d.ok ? diff(d.acceptedAt, e.sendStartedAt) : null,
        acceptedToDevice: got && d.ok ? diff(got.serverAt, d.acceptedAt) : null, total: got ? diff(got.serverAt, e.backendReceivedAt) : null,
        received: !!got, clicked: !!clicked, deviceClockGap: gap, clockSuspect: gap !== null && (gap < -1000 || gap > CLOCK_SUSPECT_MS),
      });
    }
    return out;
  }
  const rowsOfAll = (events) => (events || []).flatMap(rowsOf);

  // Nearest-rank percentile of the numbers that exist (a missing receipt is not a zero and not an infinity: it is left out and counted separately).
  function percentile(values, p) {
    const v = values.filter((x) => num(x) !== null).sort((a, b) => a - b);
    if (!v.length) return null;
    return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
  }
  // For each device type: how many were sent, how many reported back, and the median and 95th percentile of every gap.
  function summarize(rows) {
    const out = {};
    for (const r of rows || []) {
      const s = out[r.platform] || (out[r.platform] = { sent: 0, failed: 0, received: 0, values: Object.fromEntries(METRICS.map((m) => [m, []])) });
      if (r.ok) s.sent++; else s.failed++;
      if (r.received) s.received++;
      for (const m of METRICS) if (num(r[m]) !== null) s.values[m].push(r[m]);
    }
    for (const s of Object.values(out)) {
      s.stats = Object.fromEntries(METRICS.map((m) => [m, { n: s.values[m].length, median: percentile(s.values[m], 50), p95: percentile(s.values[m], 95) }]));
      delete s.values;
    }
    return out;
  }
  const fmt = (v) => (num(v) === null ? '–' : Math.abs(v) < 1000 ? Math.round(v) + ' ms' : (v / 1000).toFixed(1) + ' s');
  return { METRICS, rowsOf, rowsOfAll, percentile, summarize, fmt, CLOCK_SUSPECT_MS };
});
