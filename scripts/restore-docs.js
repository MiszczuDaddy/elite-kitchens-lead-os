#!/usr/bin/env node
'use strict';
// Phase 10 (docs/BACKUPS.md): bring back CHOSEN records, without touching anything else. The source is either
//   --from-database <id>   a database restored from a backup (./scripts/setup-backups.sh drill keeps one when you answer "no" to deleting it), or
//   --read-time <time>     the live database AS IT WAS at that minute (point-in-time recovery: up to 7 days back), e.g. 2026-10-18T09:30:00Z
// and what to bring back is
//   --customer <phone>     one customer: their chat and every message, their customer record, appointments, quotes (every version and send) and projects
//   --doc <path>           one document, e.g. quoteSettings/current or aiKnowledge/live (may be repeated)
// SAFE BY DEFAULT: without --apply it only shows what it would do. With --apply it writes only records that are MISSING from the live database (a deleted customer comes back;
// nothing that exists now is changed); add --overwrite to also put back the old version of records that exist now (it asks again). It NEVER deletes anything.
// Photos, PDFs and renders are files, not records: see docs/BACKUPS.md ("Files") to bring those back.
const path = require('path');
const readline = require('readline');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));

const SUB = { conversations: ['messages', 'sendRequests'], quotes: ['versions', 'deliveries'] };     // the subcollections each kind of record has (functions/lib)
const BY_PHONE = ['appointments', 'quotes', 'projects'];
const DOC_PATH = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.()-]+(\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.()-]+)*$/;

function args(argv) {
  const o = { docs: [], apply: false, overwrite: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from-database') o.fromDatabase = argv[++i];
    else if (a === '--read-time') o.readTime = argv[++i];
    else if (a === '--customer') o.customer = String(argv[++i] || '').replace(/\D/g, '');
    else if (a === '--doc') o.docs.push(argv[++i]);
    else if (a === '--apply') o.apply = true;
    else if (a === '--overwrite') o.overwrite = true;
    else if (a === '--yes') o.yes = true;                                     // tests only: skip the typed confirmation
    else throw new Error('Unknown option: ' + a);
  }
  if (!!o.fromDatabase === !!o.readTime) throw new Error('Say where to read from: --from-database <id> OR --read-time <time>.');
  if (o.fromDatabase && (!/^[a-z][a-z0-9-]{3,62}$/.test(o.fromDatabase))) throw new Error('That is not a restored database id (it must not be the live one).');
  if (o.readTime) {
    const t = Date.parse(o.readTime);
    if (!Number.isFinite(t)) throw new Error('The time must look like 2026-10-18T09:30:00Z.');
    o.readMs = Math.floor(t / 60000) * 60000;                                  // point-in-time reads are by whole minute
  }
  if (o.customer !== undefined && o.customer.length < 9) throw new Error('Give the customer\'s full number, e.g. 353871234567.');
  for (const d of o.docs) if (!d || !DOC_PATH.test(d)) throw new Error('Not a document path: ' + d);
  if (!o.customer && !o.docs.length) throw new Error('Say what to bring back: --customer <phone> and/or --doc <path>.');
  if (o.overwrite && !o.apply) throw new Error('--overwrite only makes sense with --apply.');
  return o;
}

// A reader over the SOURCE: get(docPath) -> data|null, query(collection, field, value) -> [ids], list(collectionPath) -> [ids]
function reader(o, live, restored) {
  if (o.fromDatabase) {
    return {
      get: async (p) => { const s = await restored.doc(p).get(); return s.exists ? s.data() : null; },
      query: async (c, f, v) => (await restored.collection(c).where(f, '==', v).get()).docs.map((d) => d.id),
      list: async (c) => (await restored.collection(c).get()).docs.map((d) => d.id),
    };
  }
  const { Timestamp } = fnRequire('firebase-admin/firestore');
  const readTime = Timestamp.fromMillis(o.readMs);
  const at = (fn) => live.runTransaction(fn, { readOnly: true, readTime });   // the live database as it was at that minute (point-in-time recovery)
  return {
    get: (p) => at(async (tx) => { const s = await tx.get(live.doc(p)); return s.exists ? s.data() : null; }),
    query: (c, f, v) => at(async (tx) => (await tx.get(live.collection(c).where(f, '==', v))).docs.map((d) => d.id)),
    list: (c) => at(async (tx) => (await tx.get(live.collection(c))).docs.map((d) => d.id)),
  };
}

// Every document path to bring back, with its data from the source.
async function plan(o, src) {
  const out = new Map();
  const add = async (p) => {
    if (out.has(p)) return;
    const data = await src.get(p);
    if (data) out.set(p, data);
    const top = p.split('/')[0];
    if (p.split('/').length === 2) for (const sub of SUB[top] || []) for (const id of await src.list(`${p}/${sub}`)) await add(`${p}/${sub}/${id}`);
  };
  if (o.customer) {
    await add(`conversations/${o.customer}`); await add(`contacts/${o.customer}`);
    for (const c of BY_PHONE) for (const id of await src.query(c, 'phone', o.customer)) await add(`${c}/${id}`);
  }
  for (const d of o.docs) await add(d);
  return out;
}

// What Google's calendar shows for a restored appointment is not known any more (erasing a customer removes their events): the calendar check is asked to bring it in line again
// (lib/calendarSync.js works out the event from the appointment, so this is always harmless). Everything else is written exactly as it was.
function forLive(p, data) {
  const g = p.startsWith('appointments/') && data.sync && data.sync.google;
  if (!g || g.state === 'off') return data;
  const { Timestamp } = fnRequire('firebase-admin/firestore');
  return { ...data, sync: { ...data.sync, google: { ...g, state: 'pending', attempts: 0, failingSince: null, nextAttemptAt: Timestamp.now(), leaseUntil: null } } };
}

// REVIEW FIX (17 Oct 2026): putting back the OLD version of a record that exists now must never undo what is true NOW.
//  * A chat's control fields are kept exactly as they are live: do not contact (a customer may have asked to stop after the backup), the numbering of customer messages and the "answered up to"
//    record of the receptionist (an old, lower number would let new customer messages reuse numbers already marked answered, so they would never be answered), the receptionist's state and
//    any Reopen in progress, the unread count, the times of the last message. Only the rest of the record (name, status, dates, notes...) comes back from the backup.
//  * A send claim (conversations/{phone}/sendRequests/*) is never overwritten: it is what stops a message being sent twice.
// A record that is MISSING live comes back exactly as it was (a customer erased by mistake had no live state to protect).
const LIVE_CHAT_FIELDS = ['doNotContact', 'doNotContactHistory', 'inboundSeq', 'lastInboundAt', 'lastMessage', 'lastMessageType', 'lastMessageDirection', 'unreadCount', 'lastReadAt', 'receptionist', 'reopen', 'consult', 'updatedAt'];
const isChat = (p) => /^conversations\/[^/]+$/.test(p), isClaim = (p) => /^conversations\/[^/]+\/sendRequests\/[^/]+$/.test(p);
function overwriteData(p, old, liveData) {
  if (isClaim(p)) return null;
  if (!isChat(p)) return old;
  const out = { ...old };
  for (const k of LIVE_CHAT_FIELDS) { if (liveData && k in liveData) out[k] = liveData[k]; else delete out[k]; }
  return out;
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((r) => rl.question(question + ' Type yes: ', r)); rl.close();
  return a === 'yes';
}

async function main(argv, { live = null, restored = null, log = console.log, ask = confirm } = {}) {
  const o = args(argv);
  if (!live) {
    const { initializeApp, getApps } = fnRequire('firebase-admin/app'), { getFirestore } = fnRequire('firebase-admin/firestore');
    const a = getApps()[0] || initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'elite-kitchens-lead-os' });
    live = getFirestore(a); if (o.fromDatabase && !restored) restored = getFirestore(a, o.fromDatabase);
  }
  log(`Reading from ${o.fromDatabase ? `the restored database "${o.fromDatabase}"` : `the live database as it was at ${new Date(o.readMs).toISOString()}`}.`);
  const docs = await plan(o, reader(o, live, restored));
  if (!docs.size) { log('Nothing found to bring back (check the number, the path or the time). Nothing was changed.'); return { found: 0, written: 0 }; }
  const exists = new Map();
  const liveData = new Map();
  for (const p of docs.keys()) { const s = await live.doc(p).get(); exists.set(p, s.exists); if (s.exists) liveData.set(p, s.data()); }
  const missing = [...docs.keys()].filter((p) => !exists.get(p)), present = [...docs.keys()].filter((p) => exists.get(p));
  const kinds = (list) => Object.entries(list.reduce((m, p) => { const k = p.split('/').length > 2 ? p.split('/')[2] : p.split('/')[0]; m[k] = (m[k] || 0) + 1; return m; }, {})).map(([k, n]) => `${n} ${k}`).join(', ') || 'none';
  log(`Found ${docs.size} records. Missing from the live database (would come back): ${kinds(missing)}. Present in the live database now: ${kinds(present)}.`);
  const write = o.overwrite ? [...docs.keys()].filter((p) => !exists.get(p) || overwriteData(p, docs.get(p), liveData.get(p)) !== null) : missing;
  const kept = o.overwrite ? present.filter((p) => isClaim(p)).length : 0;
  if (!o.apply) { log(`DRY RUN: nothing was changed. To bring back the ${missing.length} missing records, run the same command with --apply${present.length ? ' (add --overwrite to also replace the ' + present.length + ' that exist now with their old version)' : ''}.`); return { found: docs.size, written: 0, missing: missing.length, present: present.length }; }
  if (!write.length) { log('Every record already exists in the live database. Nothing was changed (use --overwrite to put the old versions back).'); return { found: docs.size, written: 0 }; }
  const q = `Write ${write.length} records into the LIVE database${o.overwrite && present.length ? `, REPLACING ${present.length} that exist now with their old version` : ''}? Nothing will be deleted.`;
  if (!o.yes && !(await ask(q))) { log('Cancelled. Nothing was changed.'); return { found: docs.size, written: 0, cancelled: true }; }
  for (let i = 0; i < write.length; i += 400) {
    const b = live.batch();
    for (const p of write.slice(i, i + 400)) b.set(live.doc(p), forLive(p, exists.get(p) ? overwriteData(p, docs.get(p), liveData.get(p)) : docs.get(p)));
    await b.commit();
  }
  if (o.overwrite && present.length) log(`Kept as they are NOW (never taken from the backup): do not contact, message numbers, the receptionist's state and the last-message fields of any chat that exists, and ${kept} send claim(s).`);
  log(`Done: ${write.length} records written. Appointments that came back are put in the shared Google calendar again by the 5-minute calendar check (docs/BACKUPS.md).`);
  return { found: docs.size, written: write.length };
}

module.exports = { main, args, plan, reader, overwriteData, LIVE_CHAT_FIELDS, SUB, BY_PHONE };
if (require.main === module) {
  main(process.argv.slice(2)).then(() => process.exit(0), (e) => { console.error('Stopped: ' + (e && e.message ? e.message : e)); process.exit(1); });
}
