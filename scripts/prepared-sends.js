#!/usr/bin/env node
'use strict';
// Lists the quotes that have a send IN PROGRESS (a quote whose PDF was prepared, whose draft is locked, and which no channel has
// delivered yet). The older quote functions do not know about that lock, so rolling the functions back while one exists would strand it
// (audit finding 7). rollback-quote-sending.sh runs this before it restores older versions.
//   exit 0  none in progress     exit 3  some are (they are printed)     exit 2  could not check (the reason is printed)
// Needs credentials that can read Firestore (Cloud Shell has them) and the functions' dependencies installed.
async function findPrepared(db) {
  const snap = await db.collection('quotes').where('preparedSend', '!=', null).get();
  return snap.docs.map((d) => ({ id: d.id, ref: d.data().ref || null, version: d.data().preparedSend && d.data().preparedSend.version }));
}
module.exports = { findPrepared };

if (require.main === module) {
  (async () => {
    try {
      const path = require('path');
      const { initializeApp } = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin', 'lib', 'app'));
      const { getFirestore } = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin', 'lib', 'firestore'));
      initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'elite-kitchens-lead-os' });
      const found = await findPrepared(getFirestore());
      if (!found.length) { console.log('none'); process.exit(0); }
      for (const q of found) console.log(`${q.id} (${q.ref || 'no number'} v${q.version})`);
      process.exit(3);
    } catch (e) { console.error(String((e && e.message) || e).split('\n')[0]); process.exit(2); }
  })();
}
