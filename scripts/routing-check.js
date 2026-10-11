#!/usr/bin/env node
'use strict';
// Reads the output of `gcloud run services describe SERVICE --format=json` on stdin and prints one line per routing finding. No cloud calls, no writes.
//   exit 0 = a new deploy will be served (NOTE lines may still be printed), 1 = the traffic is PINNED to one named revision, 2 = the input could not be read.
//   With --revision-ready the input is `gcloud run revisions describe REVISION --format=json` instead: exit 0 = the revision is Ready, 1 = it is not, 2 = unreadable.
// Found the hard way on 2026-10-11: a restore that failed ("Revision ... is not ready and cannot serve traffic") left each service's traffic PINNED to a revision that
// could not start. The service kept serving its last good revision, so nothing looked wrong, but every later deploy failed with the same error (and a pin on a healthy
// old revision would let a deploy succeed without ever being served). The fix is only to send the traffic back to the newest revision.
//   PINNED  <revision> <percent>%   the traffic is sent to one named revision instead of following the newest one: blocks a deploy
//   NOTE    <why>                   the service reports that it is not ready; not a pin, and the next deploy replaces what is broken, so it does not block
function findings(service) {
  const spec = (service && service.spec) || {}, status = (service && service.status) || {}, out = [];
  for (const t of Array.isArray(spec.traffic) ? spec.traffic : []) {
    const percent = t.percent === undefined ? 0 : Number(t.percent);
    if (percent > 0 && t.latestRevision !== true) out.push(`PINNED ${t.revisionName || '(a revision)'} ${percent}%`);
  }
  const ready = (Array.isArray(status.conditions) ? status.conditions : []).find((c) => c.type === 'Ready');
  if (ready && ready.status !== 'True') out.push('NOTE the service says it is not ready: ' + String(ready.message || ready.reason || 'no reason given').replace(/\s+/g, ' ').trim());
  return out;
}
const blocks = (lines) => lines.some((l) => l.startsWith('PINNED '));
// `gcloud run revisions describe REVISION --format=json`: only a revision whose Ready condition is True can be given traffic. Anything else, or anything unreadable, is "no".
const revisionReady = (revision) => { const c = (revision && revision.status && Array.isArray(revision.status.conditions)) ? revision.status.conditions : []; const r = c.find((x) => x.type === 'Ready'); return !!r && r.status === 'True'; };
module.exports = { findings, blocks, revisionReady };
if (require.main === module) {
  let input = '';
  process.stdin.on('data', (d) => { input += d; }).on('end', () => {
    let service;
    try { service = JSON.parse(input); } catch (e) { console.error('Could not read the service description.'); process.exitCode = 2; return; }
    if (!service || typeof service !== 'object' || Array.isArray(service)) { console.error('Could not read the service description.'); process.exitCode = 2; return; }
    if (process.argv[2] === '--revision-ready') { process.exitCode = revisionReady(service) ? 0 : 1; return; }       // exit 0 = Ready, 1 = not
    const lines = findings(service);
    for (const line of lines) console.log(line);
    process.exitCode = blocks(lines) ? 1 : 0;
  });
}
