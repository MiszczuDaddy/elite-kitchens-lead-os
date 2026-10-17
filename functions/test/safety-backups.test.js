// Phase 10 (docs/BACKUPS.md): backups and recovery. The restore tools run against the Firestore emulator (a second, named database plays the restored copy); the Cloud Shell
// script runs for real against a PRETEND gcloud that records every command (nothing touches Google Cloud). What matters: a restored copy can be checked and the result is recorded with no
// customer data; chosen records can be brought back without touching anything else (dry run by default, missing records only unless told otherwise, never a deletion); the set-up
// script's "status" changes nothing, "on" changes only what it says and only after "yes", and the restore test restores into a NEW database and never the live one.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const ROOT = path.join(__dirname, '..', '..'), SCRIPTS = path.join(ROOT, 'scripts');
const restoreDocs = require(path.join(SCRIPTS, 'restore-docs.js'));
const backupCheck = require(path.join(SCRIPTS, 'backup-check.js'));
const PROJECT = 'demo-leados', COPY = 'restore-test-20261018-0900';
const app = initializeApp({ projectId: PROJECT });
const live = getFirestore(app), copy = getFirestore(app, COPY);
const P = '353871110061', OTHER = '353871110062', NOW = Date.UTC(2026, 9, 18, 9, 0), ts = (ms) => Timestamp.fromMillis(ms);
const quiet = () => {};

async function wipe(db, id) { await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/${encodeURIComponent(id)}/documents`, { method: 'DELETE' }); }
async function customer(db, p, name) {
  await db.doc('contacts/' + p).set({ phone: p, name, createdAt: ts(NOW - 9e8) });
  await db.doc('conversations/' + p).set({ phone: p, name, createdAt: ts(NOW - 9e8), updatedAt: ts(NOW - 1e6) });
  await db.doc(`conversations/${p}/messages/wamid.A`).set({ direction: 'in', type: 'text', body: 'Hello', createdAt: ts(NOW - 2e6) });
  await db.doc(`conversations/${p}/messages/wamid.B`).set({ direction: 'out', type: 'text', body: 'Hi there', createdAt: ts(NOW - 1e6), status: 'read' });
  await db.doc(`conversations/${p}/sendRequests/req12345678`).set({ state: 'sent' });
  await db.doc('appointments/a_' + p.slice(-6).padStart(24, '0')).set({ phone: p, status: 'scheduled', start: ts(NOW + 9e8), sync: { google: { state: 'synced', eventId: 'ev1', syncedVersion: 1 } } });
  await db.doc('quotes/q_' + p.slice(-6).padStart(24, '0')).set({ phone: p, ref: 'EK-0101', status: 'sent' });
  await db.doc(`quotes/q_${p.slice(-6).padStart(24, '0')}/versions/1`).set({ state: 'sent' });
  await db.doc(`quotes/q_${p.slice(-6).padStart(24, '0')}/deliveries/1-aaaaaaaaaaaa-whatsapp`).set({ state: 'sent', channel: 'whatsapp' });
  await db.doc('projects/p_' + p.slice(-6).padStart(24, '0')).set({ phone: p, status: 'active' });
}
beforeEach(async () => { await wipe(live, '(default)'); await wipe(copy, COPY); });

// ================================================================ restore-docs.js ======================================
test('bring back ONE deleted customer from a restored copy: a dry run first (nothing written), then only the missing records; their calendar entries are re-sent; nothing else is touched', async () => {
  await customer(copy, P, 'Ciara Restore'); await customer(copy, OTHER, 'Other Person');
  await live.doc('contacts/' + OTHER).set({ phone: OTHER, name: 'Other Person (newer)' });              // the live database has moved on for someone else
  const args = ['--from-database', COPY, '--customer', P];
  const dry = await restoreDocs.main(args, { live, restored: copy, log: quiet });
  assert.deepEqual([dry.found, dry.written, dry.missing, dry.present], [10, 0, 10, 0]);
  assert.equal((await live.doc('conversations/' + P).get()).exists, false, 'a dry run writes nothing');
  const r = await restoreDocs.main([...args, '--apply', '--yes'], { live, restored: copy, log: quiet });
  assert.deepEqual([r.found, r.written], [10, 10]);
  assert.equal((await live.collection(`conversations/${P}/messages`).get()).size, 2, 'every message came back');
  assert.equal((await live.doc(`quotes/q_${P.slice(-6).padStart(24, '0')}/versions/1`).get()).exists, true, 'the quote and its versions came back');
  const appt = (await live.doc('appointments/a_' + P.slice(-6).padStart(24, '0')).get()).data();
  assert.equal(appt.sync.google.state, 'pending', 'the calendar check is asked to put it back in the calendar'); assert.equal(appt.sync.google.eventId, 'ev1');
  assert.equal((await live.doc('contacts/' + OTHER).get()).data().name, 'Other Person (newer)', 'someone else is never touched');
  assert.equal((await live.doc('conversations/' + OTHER).get()).exists, false);
});

test('records that exist now are left alone unless --overwrite is given; nothing in the live database is ever deleted; one document can be brought back on its own', async () => {
  await customer(copy, P, 'Ciara Old');
  await copy.doc('quoteSettings/current').set({ vatRate: 13.5, rev: 3 });
  await live.doc('contacts/' + P).set({ phone: P, name: 'Ciara New' });
  await live.doc('conversations/' + P).set({ phone: P, name: 'Ciara New' });
  await live.doc(`conversations/${P}/messages/wamid.NEW`).set({ direction: 'in', body: 'a message after the backup' });
  await live.doc('quoteSettings/current').set({ vatRate: 23, rev: 4 });
  const keep = await restoreDocs.main(['--from-database', COPY, '--customer', P, '--apply', '--yes'], { live, restored: copy, log: quiet });
  assert.equal(keep.written, 8); assert.equal((await live.doc('contacts/' + P).get()).data().name, 'Ciara New', 'not overwritten without --overwrite');
  await restoreDocs.main(['--from-database', COPY, '--customer', P, '--apply', '--overwrite', '--yes'], { live, restored: copy, log: quiet });
  assert.equal((await live.doc('contacts/' + P).get()).data().name, 'Ciara Old');
  assert.equal((await live.doc(`conversations/${P}/messages/wamid.NEW`).get()).exists, true, 'a message added since the backup is never deleted');
  await restoreDocs.main(['--from-database', COPY, '--doc', 'quoteSettings/current', '--apply', '--overwrite', '--yes'], { live, restored: copy, log: quiet });
  assert.equal((await live.doc('quoteSettings/current').get()).data().vatRate, 13.5);
  const none = await restoreDocs.main(['--from-database', COPY, '--customer', '353870000000'], { live, restored: copy, log: quiet });
  assert.equal(none.found, 0);
  const cancelled = await restoreDocs.main(['--from-database', COPY, '--doc', 'quoteSettings/current', '--apply', '--overwrite'], { live, restored: copy, log: quiet, ask: async () => false });
  assert.equal(cancelled.cancelled, true, 'without "yes" nothing is written');
});

test('the options are strict: never the live database as the source, a target is required, a point in time is rounded to the minute and read inside a read-only transaction', async () => {
  for (const bad of [[], ['--customer', P], ['--from-database', '(default)', '--customer', P], ['--from-database', COPY, '--read-time', '2026-10-18T09:30:00Z', '--customer', P],
    ['--from-database', COPY], ['--from-database', COPY, '--customer', '12'], ['--from-database', COPY, '--doc', '../x'], ['--from-database', COPY, '--customer', P, '--overwrite'], ['--read-time', 'yesterday', '--customer', P]]) {
    assert.throws(() => restoreDocs.args(bad), Error, JSON.stringify(bad));
  }
  const o = restoreDocs.args(['--read-time', '2026-10-18T09:30:42Z', '--customer', P]);
  assert.equal(new Date(o.readMs).toISOString(), '2026-10-18T09:30:00.000Z');
  const seen = [];
  const fakeLive = { doc: (p) => ({ p }), collection: (c) => ({ c, where: () => ({ c }) }),
    runTransaction: async (fn, opts) => { seen.push(opts); return fn({ get: async () => ({ exists: false, docs: [] }) }); } };
  const rd = restoreDocs.reader(o, fakeLive, null);
  assert.equal(await rd.get('contacts/' + P), null);
  assert.equal(seen[0].readOnly, true); assert.equal(seen[0].readTime.toMillis(), o.readMs);
});

// ================================================================ backup-check.js ======================================
test('the restore check compares the copy with the live database, opens a few restored customers, and records the result in Elite OS with counts only', async () => {
  for (const [p, n] of [[P, 'A'], [OTHER, 'B']]) { await customer(copy, p, n); await customer(live, p, n); }
  await live.doc('contacts/353871110063').set({ phone: '353871110063', name: 'Added after the backup' });
  const out = [];
  const r = await backupCheck.main(['--database', COPY, '--backup-time', '2026-10-18T02:11:00Z', '--record'], { live, restored: copy, log: (s) => out.push(s), now: () => NOW });
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.equal(r.live.contacts, 3); assert.equal(r.restored.contacts, 2); assert.equal(r.restored['all messages'], 4);
  assert.match(out.join('\n'), /RESULT: OK/);
  const rec = (await live.doc('health/backup').get()).data();
  assert.deepEqual([rec.ok, rec.database, rec.backupTime, rec.totals], [true, COPY, '2026-10-18T02:11:00Z', { live: 7, restored: 6 }]);
  assert.ok(!JSON.stringify(rec).includes(P) && !JSON.stringify(rec).includes('Added after'), 'no customer data in the record');
  await wipe(copy, COPY);
  const bad = await backupCheck.main(['--database', COPY], { live, restored: copy, log: quiet });
  assert.equal(bad.ok, false); assert.match(bad.problems.join(' '), /no customers/);
  await customer(copy, P, 'A'); await copy.doc('conversations/' + P).update({ phone: '000' });
  assert.match((await backupCheck.main(['--database', COPY], { live, restored: copy, log: quiet })).problems.join(' '), /fewer than half|no matching phone/);
  assert.throws(() => backupCheck.args(['--database', '(default)']), /never the live one/);
});

// ================================================================ setup-backups.sh (a pretend gcloud) =====================
const FAKE_GCLOUD = `#!/usr/bin/env bash
echo "gcloud $*" >> "$FAKE_STATE/calls.log"
case "$1 $2 $3" in
  "firestore databases describe") if [ -f "$FAKE_STATE/pitr" ]; then p=POINT_IN_TIME_RECOVERY_ENABLED; else p=POINT_IN_TIME_RECOVERY_DISABLED; fi
    echo "{\\"locationId\\":\\"europe-west1\\",\\"pointInTimeRecoveryEnablement\\":\\"$p\\",\\"earliestVersionTime\\":\\"2026-10-11T09:00:00Z\\"}" ;;
  "firestore backups schedules") if [ "$4" = create ]; then touch "$FAKE_STATE/schedule"; echo ok; elif [ -f "$FAKE_STATE/schedule" ]; then echo '[{"name":"s1","dailyRecurrence":{},"retention":"1209600s"}]'; else echo '[]'; fi ;;
  "firestore backups list") if [ -f "$FAKE_STATE/backups.json" ]; then cat "$FAKE_STATE/backups.json"; else echo '[]'; fi ;;
  "storage buckets describe") if [ -f "$FAKE_STATE/soft" ]; then echo '{"soft_delete_policy":{"retentionDurationSeconds":"604800"}}'; else echo '{}'; fi ;;
  "storage buckets update") touch "$FAKE_STATE/soft" ;;
  "firestore databases update") touch "$FAKE_STATE/pitr" ;;
  "firestore databases restore") touch "$FAKE_STATE/restored"; echo '{"operationState":"PROCESSING"}' ;;
  "firestore operations list") if [ -f "$FAKE_STATE/restored" ]; then echo '[{"name":"op1","done":true}]'; else echo '[]'; fi ;;
  "firestore databases delete") touch "$FAKE_STATE/deleted" ;;
  *) echo "unexpected gcloud $*" >&2; exit 9 ;;
esac
`;
function sh(args, input = '', env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ek-backup-')), state = path.join(dir, 'state'), bin = path.join(dir, 'bin');
  fs.mkdirSync(state); fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, 'gcloud'), FAKE_GCLOUD);
  for (const [k, v] of Object.entries(env.files || {})) fs.writeFileSync(path.join(state, k), v);
  const r = spawnSync('bash', ['-c', 'gcloud() { bash "$TEST_BIN/gcloud" "$@"; }; export -f gcloud; exec bash "$@"', 'test', path.join(SCRIPTS, 'setup-backups.sh'), ...args],
    { encoding: 'utf8', input, env: { ...process.env, FAKE_STATE: state, TEST_BIN: bin, POLL_SECONDS: '0', WAIT_SECONDS: '5', ...(env.vars || {}) } });
  const calls = fs.existsSync(path.join(state, 'calls.log')) ? fs.readFileSync(path.join(state, 'calls.log'), 'utf8').trim().split('\n') : [];
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), calls, has: (f) => fs.existsSync(path.join(state, f)) };
}
const MUTATING = /schedules create|databases update|buckets update|databases restore|databases delete/;
const BACKUPS = JSON.stringify([
  { name: 'projects/p/locations/europe-west1/backups/old', database: 'projects/p/databases/(default)', snapshotTime: '2026-10-16T02:00:00Z', state: 'READY' },
  { name: 'projects/p/locations/europe-west1/backups/new', database: 'projects/p/databases/(default)', snapshotTime: '2026-10-17T02:00:00Z', state: 'READY' },
  { name: 'projects/p/locations/europe-west1/backups/making', database: 'projects/p/databases/(default)', snapshotTime: '2026-10-18T02:00:00Z', state: 'CREATING' },
  { name: 'projects/p/locations/europe-west1/backups/other', database: 'projects/p/databases/restore-test-x', snapshotTime: '2026-10-19T02:00:00Z', state: 'READY' }]);

test('setup-backups.sh status: read-only (no command that changes anything), says plainly what is on and off', () => {
  const r = sh(['status']);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.calls.length >= 4 && !r.calls.some((c) => MUTATING.test(c)), r.calls.join('\n'));
  assert.match(r.out, /point-in-time recovery: OFF/); assert.match(r.out, /daily backups: OFF/); assert.match(r.out, /newest backup: none yet/); assert.match(r.out, /soft delete: OFF/);
  const on = sh(['status'], '', { files: { pitr: '', schedule: '', soft: '', 'backups.json': BACKUPS } });
  assert.match(on.out, /point-in-time recovery: ON/); assert.match(on.out, /daily backups: ON, each kept 14 days/); assert.match(on.out, /newest backup: 2026-10-17T02:00:00Z \(2 kept\)/); assert.match(on.out, /for 7 days/);
});

test('setup-backups.sh on: changes nothing without "yes"; with "yes" it switches on exactly the daily backup (14 days), point-in-time recovery and 7-day soft delete; a second run changes nothing', () => {
  const no = sh(['on'], 'no\n');
  assert.notEqual(no.code, 0); assert.ok(!no.calls.some((c) => MUTATING.test(c)), no.calls.join('\n')); assert.match(no.out, /Cancelled/);
  const yes = sh(['on'], 'yes\n');
  assert.equal(yes.code, 0, yes.out);
  const m = yes.calls.filter((c) => MUTATING.test(c));
  assert.deepEqual(m.map((c) => c.replace(/ --project \S+/, '')), [
    "gcloud firestore backups schedules create --database=(default) --recurrence=daily --retention=14d",
    "gcloud firestore databases update --database=(default) --enable-pitr",
    'gcloud storage buckets update gs://elite-kitchens-lead-os.firebasestorage.app --soft-delete-duration=7d']);
  assert.ok(m.every((c) => !/databases (delete|restore)/.test(c)), 'nothing is deleted or restored');
  const again = sh(['on'], 'yes\n', { files: { pitr: '', schedule: '', soft: '' } });
  assert.ok(!again.calls.some((c) => MUTATING.test(c)), 'already on: nothing to change'); assert.match(again.out, /already on/);
});

test('setup-backups.sh drill: restores the NEWEST FINISHED backup of the live database into a NEW database, checks it, and deletes the copy only after "yes"; never the live database', () => {
  const none = sh(['drill'], 'yes\n');
  assert.notEqual(none.code, 0); assert.match(none.out, /no finished backup yet/); assert.ok(!none.calls.some((c) => MUTATING.test(c)));
  const stub = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ek-check-')), 'check.sh');
  fs.writeFileSync(stub, 'echo "CHECK $*"; exit 0\n');
  const r = sh(['drill'], 'yes\nyes\n', { files: { 'backups.json': BACKUPS }, vars: { BACKUP_CHECK_CMD: 'bash ' + stub.replace(/\\/g, '/') } });
  assert.equal(r.code, 0, r.out);
  const restore = r.calls.find((c) => /databases restore/.test(c));
  assert.match(restore, /--source-backup=projects\/p\/locations\/europe-west1\/backups\/new /, 'the newest READY backup of (default)');
  const id = /--destination-database=(\S+)/.exec(restore)[1];
  assert.match(id, /^restore-test-\d{8}-\d{4}$/); assert.notEqual(id, '(default)');
  assert.match(r.out, new RegExp('CHECK --database ' + id + ' --backup-time 2026-10-17T02:00:00Z --record'));
  assert.ok(r.calls.some((c) => c.includes('databases delete --database=' + id)), 'the temporary copy is deleted after "yes"');
  assert.ok(!r.calls.some((c) => /databases delete --database=\(default\)/.test(c)), 'the live database is never deleted');
  assert.match(r.out, /RESTORE TEST PASSED/);
  const keep = sh(['drill'], 'yes\nno\n', { files: { 'backups.json': BACKUPS }, vars: { BACKUP_CHECK_CMD: 'bash ' + stub.replace(/\\/g, '/') } });
  assert.ok(!keep.calls.some((c) => /databases delete/.test(c))); assert.match(keep.out, /kept\. To bring records back from it/);
  const cancel = sh(['drill'], 'no\n', { files: { 'backups.json': BACKUPS } });
  assert.notEqual(cancel.code, 0); assert.ok(!cancel.calls.some((c) => MUTATING.test(c)), 'no restore without "yes"');
});
