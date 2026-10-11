'use strict';
// Turn resolved Cloud Run traffic into an exhaustive, deterministic probe list. No cloud writes.
function probeTargets(service) {
  const { metadata, status } = service || {};
  if (!metadata || !status || !Number.isInteger(Number(metadata.generation)) || Number(metadata.generation) < 1 ||
      Number(status.observedGeneration) !== Number(metadata.generation) ||
      !status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')) throw Error('Cloud Run traffic is not settled.');
  const traffic = status.traffic;
  if (!Array.isArray(traffic) || !traffic.length) throw Error('Missing resolved traffic.');
  const active = new Map();
  let total = 0;
  for (const t of traffic) {
    const percent = t.percent === undefined ? 0 : t.percent;
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw Error('Invalid traffic percentage.');
    if (!percent) continue;
    if (!/^claimaccess-[a-z0-9-]+$/.test(t.revisionName || '')) throw Error('Unresolved revision.');
    total += percent;
    active.set(t.revisionName, (active.get(t.revisionName) || 0) + percent);
  }
  if (total !== 100) throw Error('Traffic does not account for 100 percent.');
  return [...active].sort(([a], [b]) => a.localeCompare(b)).map(([revision, percent]) => {
    // Existing tag URLs address a revision directly, including tags with zero default traffic.
    // A single serving revision can use the service URL; the response must still identify that revision.
    const tagged = traffic.find((t) => t.revisionName === revision && t.tag && t.url);
    const url = tagged ? tagged.url : active.size === 1 ? status.url : null;
    if (typeof url !== 'string' || !/^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.run\.app\/?$/.test(url)) {
      throw Error('Cannot address every serving revision: split traffic needs existing revision tag URLs.');
    }
    return { revision, url, percent };
  });
}
module.exports = { probeTargets };
if (require.main === module) {
  let input = '';
  process.stdin.on('data', (d) => { input += d; }).on('end', () => {
    try { for (const t of probeTargets(JSON.parse(input))) console.log(`${t.revision}\t${t.url}\t${t.percent}`); }
    catch (e) { console.error(e.message); process.exitCode = 1; }
  });
}
