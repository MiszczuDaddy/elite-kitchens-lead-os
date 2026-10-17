#!/usr/bin/env node
'use strict';
// Phase 10 (docs/BACKUPS.md): proves that a restored backup really holds the business's data. Run by ./scripts/setup-backups.sh drill after it restored the newest backup into a
// SEPARATE database; it can also be run by hand. READ-ONLY on both databases, except that with --record it writes the result (counts only, no customer data) to the live
// database's health/backup document, so Elite OS shows "Last restore test" in "Needs attention".
//   node scripts/backup-check.js --database restore-test-20261018-0900 [--backup-time 2026-10-18T02:11:00Z] [--record]
// It compares, collection by collection, how many records the restored copy and the live database hold. They should be close: the live database has whatever was added since the
// backup was taken (and lacks whatever was deleted since). It also opens a few restored customers and checks that their records are complete. Exit code 0 = the copy is usable.
const path = require('path');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));

const COLLECTIONS = ['conversations', 'contacts', 'appointments', 'quotes', 'projects', 'leads', 'quoteSettings', 'counters', 'aiSettings', 'aiKnowledge', 'aiKnowledgeVersions'];
const GROUPS = ['messages', 'versions', 'deliveries'];
const SAMPLE = 5;

function args(argv) {
  const o = { record: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--database') o.database = argv[++i];
    else if (a === '--backup-time') o.backupTime = argv[++i];
    else if (a === '--record') o.record = true;
    else throw new Error('Unknown option: ' + a);
  }
  if (!o.database || !/^[a-z][a-z0-9-]{3,62}$/.test(o.database) || o.database === '(default)') throw new Error('Say which RESTORED database to check: --database <id> (never the live one).');
  return o;
}

async function counts(db) {
  const out = {};
  for (const c of COLLECTIONS) out[c] = (await db.collection(c).count().get()).data().count;
  for (const g of GROUPS) out['all ' + g] = (await db.collectionGroup(g).count().get()).data().count;
  return out;
}

// A few customers from the restored copy: each must have its chat record with a phone, and its customer record. Returns problems found (no names or numbers, only positions).
async function sample(db) {
  const convs = await db.collection('conversations').orderBy('updatedAt', 'desc').limit(SAMPLE).get();
  const problems = [];
  let i = 0;
  for (const d of convs.docs) {
    i++;
    const c = d.data();
    if (!c.phone || c.phone !== d.id) problems.push(`restored customer ${i}: the chat record has no matching phone`);
    const contact = await db.collection('contacts').doc(d.id).get();
    if (!contact.exists) problems.push(`restored customer ${i}: no customer record`);
  }
  return { checked: convs.size, problems };
}

async function main(argv, { app = null, live = null, restored = null, log = console.log, now = Date.now } = {}) {
  const o = args(argv);
  if (!live || !restored) {
    const { initializeApp, getApps } = fnRequire('firebase-admin/app'), { getFirestore } = fnRequire('firebase-admin/firestore');
    const a = app || getApps()[0] || initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'elite-kitchens-lead-os' });
    live = live || getFirestore(a); restored = restored || getFirestore(a, o.database);
  }
  log(`Comparing the restored copy "${o.database}"${o.backupTime ? ` (backup taken ${o.backupTime})` : ''} with the live database. Read-only.`);
  const [l, r] = [await counts(live), await counts(restored)];
  log('  what                      live   restored');
  for (const k of Object.keys(l)) log(`  ${k.padEnd(24)} ${String(l[k]).padStart(6)} ${String(r[k]).padStart(10)}`);
  const s = await sample(restored);
  const liveTotal = l.conversations + l.contacts + l.quotes, restoredTotal = r.conversations + r.contacts + r.quotes;
  const problems = [...s.problems];
  if (liveTotal > 0 && restoredTotal === 0) problems.push('the restored copy has no customers, chats or quotes at all');
  if (l.conversations > 0 && r.conversations < Math.ceil(l.conversations / 2)) problems.push('the restored copy has fewer than half of the live customers');
  const ok = problems.length === 0;
  log(`  ${s.checked} restored customers opened and checked.`);
  if (ok) log('RESULT: OK. The backup can be restored and holds the business data.');
  else { log('RESULT: PROBLEM. ' + problems.join('; ') + '. Do not rely on this backup; report it.'); }
  if (o.record) {
    const { Timestamp } = fnRequire('firebase-admin/firestore');
    await live.doc('health/backup').set({ lastDrillAt: Timestamp.fromMillis(now()), ok, database: o.database, backupTime: o.backupTime || null,
      totals: { live: liveTotal, restored: restoredTotal }, problems: problems.slice(0, 5) });
    log('Recorded in Elite OS (Needs attention > Backups).');
  }
  return { ok, live: l, restored: r, problems };
}

module.exports = { main, args, counts, sample, COLLECTIONS, GROUPS };
if (require.main === module) {
  main(process.argv.slice(2)).then((r) => process.exit(r.ok ? 0 : 2), (e) => { console.error('Stopped: ' + (e && e.message ? e.message : e)); process.exit(1); });
}
