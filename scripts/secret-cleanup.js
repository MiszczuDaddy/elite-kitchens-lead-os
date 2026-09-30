#!/usr/bin/env node
// Destroy OLD / placeholder versions of the WhatsApp secrets, but only ones nothing is using.
// A destroyed secret version that a live function is still pinned to would make that function fail to start,
// so this script reads every Cloud Run service's ACTUAL secret versions first and never touches those (or the latest).
//   node scripts/secret-cleanup.js           -> shows the plan only (changes nothing)
//   node scripts/secret-cleanup.js --apply   -> destroys the versions listed in the plan
const { execFileSync } = require('child_process');
const PROJECT = 'elite-kitchens-lead-os', REGION = 'europe-west1';
const SECRETS = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN'];
const apply = process.argv.includes('--apply');
const g = (...a) => execFileSync('gcloud', [...a, '--project', PROJECT], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const services = g('run', 'services', 'list', '--region', REGION, '--format=value(name)').split(/\s+/).filter(Boolean);
const used = Object.fromEntries(SECRETS.map((s) => [s, {}]));           // secret -> { version -> [services] }
for (const svc of services) {
  const j = JSON.parse(g('run', 'services', 'describe', svc, '--region', REGION, '--format=json'));
  const containers = (((j.spec || {}).template || {}).spec || {}).containers || [];
  for (const e of containers.flatMap((c) => c.env || [])) {
    const r = e.valueFrom && e.valueFrom.secretKeyRef;
    if (r && used[r.name]) (used[r.name][String(r.key)] = used[r.name][String(r.key)] || []).push(svc);
  }
}

let stale = false; const toDestroy = [];
for (const s of SECRETS) {
  const vers = JSON.parse(g('secrets', 'versions', 'list', s, '--format=json')).map((v) => ({ n: Number(v.name.split('/').pop()), state: v.state }));
  const enabled = vers.filter((v) => v.state === 'ENABLED').map((v) => v.n).sort((a, b) => a - b);
  const latest = enabled[enabled.length - 1];
  if (latest == null) { console.log(`${s}: no enabled versions?! skipping`); continue; }
  const pinned = Object.keys(used[s]).filter((k) => k !== 'latest').map(Number);
  const keep = new Set([latest, ...pinned]);
  const doomed = enabled.filter((n) => !keep.has(n));
  console.log(`\n${s}\n  enabled versions: ${enabled.join(', ')}   latest: ${latest}`);
  for (const [ver, svcs] of Object.entries(used[s])) console.log(`  used by ${svcs.length} service(s) at version ${ver}${Number(ver) < latest ? '   <-- OLDER than latest: redeploy these first' : ''}`);
  for (const p of pinned) if (p < latest) stale = true;
  console.log(doomed.length ? `  will destroy: ${doomed.join(', ')}` : '  nothing to destroy');
  doomed.forEach((n) => toDestroy.push([s, n]));
}
if (stale) console.log('\nNOTE: some functions still use an older (kept) version. Run ./scripts/deploy-preview.sh --with-webhook, then run this again.');
if (!apply) { console.log('\n(plan only: nothing changed. Add --apply to destroy the versions above.)'); process.exit(0); }
for (const [s, n] of toDestroy) { g('secrets', 'versions', 'destroy', String(n), '--secret', s, '--quiet'); console.log(`destroyed ${s} version ${n}`); }
console.log(toDestroy.length ? '\nDone.' : '\nNothing to do.');
