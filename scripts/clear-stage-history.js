#!/usr/bin/env node
// Remove recorded stage history (Booked / Quoted / Won / Closed dates and the correction note) from TEST customers, e.g. after
// accidental moves made before the correction window existed. It only DELETES; it never invents or edits a date.
//
//   node scripts/clear-stage-history.js --list                     read-only: customers that have stage dates
//   node scripts/clear-stage-history.js <phone>                    show what would be removed, then ask before changing anything
//   node scripts/clear-stage-history.js <phone> --status inbox     ...and also put the customer back in a stage (inbox = New lead)
//   node scripts/clear-stage-history.js <phone> --stages booked    only remove the listed stage dates (default: all)
//   add --yes to skip the question (only for scripted tests)
// Run in Cloud Shell from the repo folder. Uses the project's own credentials; touches only conversations/{phone}.
const path = require('path'), readline = require('readline');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore, FieldValue } = fnRequire('firebase-admin/firestore');

const STAGES = ['booked', 'quoted', 'won', 'closed'], STATUSES = ['inbox', 'booked', 'quoted', 'won', 'closed'];
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? null : (argv[i + 1] || ''); };
const has = (n) => argv.includes(n);
const fmt = (t) => (t && t.toDate ? t.toDate().toISOString().slice(0, 16).replace('T', ' ') : '-');
const last = (p) => '…' + String(p).slice(-4);
const die = (m) => { console.error(m); process.exit(1); };
const ask = (q) => new Promise((res) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.on('close', () => res('')); rl.question(q, (a) => { res(a.trim()); rl.close(); }); });          // no answer (closed input) = cancel

(async () => {
  initializeApp({ projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'elite-kitchens-lead-os' });
  const db = getFirestore();
  if (has('--list')) {
    const snap = await db.collection('conversations').get();
    const rows = snap.docs.filter((d) => d.data().stageDates || d.data().lastMove);
    if (!rows.length) return console.log('No customers have stage dates.');
    for (const d of rows) { const c = d.data(), sd = c.stageDates || {}; console.log(`${last(d.id)}  ${(c.name || '(no name)').padEnd(24)} now: ${String(c.inboxStatus || 'inbox').padEnd(7)} booked ${fmt(sd.booked)} | quoted ${fmt(sd.quoted)} | won ${fmt(sd.won)} | closed ${fmt(sd.closed)}`); }
    return console.log(`\n${rows.length} customer(s). Use the full phone number (digits only, e.g. 353851234567) to clear one.`);
  }
  const phone = (argv.find((a) => /^\+?[\d ]{9,}$/.test(a)) || '').replace(/\D/g, '');
  if (!phone) die('Give the customer phone number (digits, e.g. 353851234567), or use --list. See the top of this file.');
  const stages = flag('--stages') ? flag('--stages').split(',').map((x) => x.trim()) : STAGES;
  if (stages.some((x) => !STAGES.includes(x))) die('--stages must be a comma list of: ' + STAGES.join(', '));
  const status = flag('--status');
  if (status !== null && !STATUSES.includes(status)) die('--status must be one of: ' + STATUSES.join(', '));
  const ref = db.collection('conversations').doc(phone), snap = await ref.get();
  if (!snap.exists) die('No customer with that number.');
  const c = snap.data(), sd = c.stageDates || {};
  console.log(`Customer ${(c.name || '(no name)')} (${last(phone)}), currently ${c.inboxStatus || 'inbox'}.`);
  const remove = stages.filter((x) => sd[x]);
  console.log('Stage dates that will be REMOVED: ' + (remove.length ? remove.map((x) => `${x} (${fmt(sd[x])})`).join(', ') : 'none'));
  if (stages.length === STAGES.length && c.lastMove) console.log('The correction note will be removed.');
  if (status !== null && status !== (c.inboxStatus || 'inbox')) console.log(`The customer will be moved to ${status}.`);
  if (!remove.length && !(stages.length === STAGES.length && c.lastMove) && (status === null || status === (c.inboxStatus || 'inbox'))) return console.log('Nothing to change.');
  console.log('Nothing else is touched (messages, details, quote value).');
  if (!has('--yes') && (await ask(`Type the last 4 digits of the number (${phone.slice(-4)}) to confirm, anything else cancels: `)) !== phone.slice(-4)) return console.log('Cancelled. Nothing was changed.');
  const patch = {};
  for (const x of remove) patch[`stageDates.${x}`] = FieldValue.delete();
  if (stages.length === STAGES.length) patch.lastMove = FieldValue.delete();
  if (status !== null) patch.inboxStatus = status;
  await ref.update(patch);
  console.log('Done.');
})().catch((e) => die('Failed: ' + (e.message || e)));
