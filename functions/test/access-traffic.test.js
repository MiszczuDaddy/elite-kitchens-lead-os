'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { probeTargets } = require('../../scripts/access-traffic');
const service = (traffic) => ({ metadata: { generation: 2 }, status: { observedGeneration: 2, conditions: [{ type: 'Ready', status: 'True' }], url: 'https://claimaccess-test.a.run.app', traffic } });
const target = (n, percent, tagged = true) => ({ revisionName: 'claimaccess-' + n, percent, ...(tagged ? { tag: 'r' + n, url: `https://r${n}---claimaccess-test.a.run.app` } : {}) });
test('traffic inventory includes every active revision, including 1 percent, and ignores inactive revisions', () => {
  assert.deepEqual(probeTargets(service([target(1, 99), target(2, 1), target(3, 0)])).map((t) => t.revision), ['claimaccess-1', 'claimaccess-2']);
});
test('single untagged revision uses the service URL; split traffic needs a direct URL for each revision', () => {
  assert.equal(probeTargets(service([target(1, 100, false)]))[0].url, 'https://claimaccess-test.a.run.app');
  assert.throws(() => probeTargets(service([target(1, 99), target(2, 1, false)])), /Cannot address/);
  const split = service([target(1, 99), target(2, 1, false), target(2, 0)]);
  assert.equal(probeTargets(split)[1].url, 'https://r2---claimaccess-test.a.run.app');
});
test('missing, partial, malformed and unsettled traffic fails closed', () => {
  for (const obj of [{}, service([]), service([target(1, 99)]), service([target(1, '100')]), service([{ percent: 100, latestRevision: true }])]) assert.throws(() => probeTargets(obj));
  const obj = service([target(1, 100)]); obj.status.observedGeneration = 1;
  assert.throws(() => probeTargets(obj), /not settled/);
  obj.status.observedGeneration = 2; obj.status.conditions[0].status = 'Unknown';
  assert.throws(() => probeTargets(obj), /not settled/);
});
