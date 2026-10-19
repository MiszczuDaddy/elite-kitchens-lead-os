'use strict';
// One-off clean-up after the "No Meta leads have arrived for a while" warning was removed (19 Oct 2026). The 10-minute health check erases the same two records by itself;
// this does it NOW. It looks first, prints what it finds, and deletes ONLY these two records, nothing else:
//   healthIssues/lead_silence   the old open problem
//   healthSettings/current      the old "warn me after N hours" setting
// Run from the elite-kitchens-lead-os folder in Cloud Shell:  node scripts/erase-lead-warning.js
const path = require('path');
(async () => {
  const need = require('module').createRequire(path.join(process.cwd(), 'functions', 'package.json'));
  const { initializeApp } = need('firebase-admin/app'), { getFirestore } = need('firebase-admin/firestore');
  initializeApp({ projectId: 'elite-kitchens-lead-os' });
  const db = getFirestore();
  for (const p of ['healthIssues/lead_silence', 'healthSettings/current']) {
    const s = await db.doc(p).get();
    if (!s.exists) { console.log(p + ': not there (already clean)'); continue; }
    await s.ref.delete();
    console.log(p + ': erased');
  }
  const hb = await db.doc('health/heartbeats').get(), at = hb.exists && hb.data().healthSweepAt && hb.data().healthSweepAt.toMillis();
  console.log('The 10-minute check last ran ' + (at ? Math.round((Date.now() - at) / 60000) + ' minutes ago.' : 'never (no record).'));
  console.log('Done. Reload Elite OS.');
  process.exit(0);
})().catch((e) => { console.error('Could not do it: ' + String((e && e.message) || e).slice(0, 300)); process.exit(1); });
