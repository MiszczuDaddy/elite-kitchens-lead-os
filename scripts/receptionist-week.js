#!/usr/bin/env node
'use strict';
// READ-ONLY. Prints the receptionist's conversations of the last N days (default 7) as plain text so they can be checked for mistakes, plus the business facts it is allowed to state.
// Writes nothing, deletes nothing, sends nothing. Phone numbers, e-mail addresses and Eircodes are replaced by [phone] / [email] / [eircode]; a customer shows as first name + last 3 digits.
// Run in Cloud Shell:  node scripts/receptionist-week.js [days] | tee ~/receptionist-week.txt        (needs: npm --prefix functions install --omit=dev, once)
const path = require('path');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore, Timestamp } = fnRequire('firebase-admin/firestore');

const DAYS = Math.min(31, Math.max(1, Number(process.argv[2]) || 7)), PER_CHAT = 40, MAX_TEXT = 500, MAX_FACT = 300, NOW = Date.now();
const since = Timestamp.fromMillis(NOW - DAYS * 86400e3);

const digitsIn = (s) => (s.match(/\d/g) || []).length;
const redact = (t) => String(t == null ? '' : t)
  .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
  .replace(/\+?\d[\d\s().-]{7,}\d/g, (m) => (digitsIn(m) >= 9 ? '[phone]' : m))
  .replace(/\b(?:[ACDEFHKNPRTVWXY]\d{2}|D6W)\s?[0-9ACDEFHKNPRTVWXY]{4}\b/gi, '[eircode]')
  .replace(/\s+/g, ' ').trim();
const plain = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();       // the business's own facts (its phone, e-mail, prices) are not customer data: shown as they are
const clip = (t, n) => (t.length > n ? t.slice(0, n) + ' …' : t);
const when = (ts) => (ts && ts.toDate ? ts.toDate().toLocaleString('en-IE', { timeZone: 'Europe/Dublin', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '?');
const ms = (ts) => (ts && ts.toMillis ? ts.toMillis() : 0);
const firstName = (n) => String(n || 'Customer').trim().split(/\s+/)[0].slice(0, 30);
const who = (m) => (m.direction === 'in' ? 'CUSTOMER' : m.auto === true ? 'RECEPTIONIST (automatic)' : m.type === 'template' ? 'WELCOME TEMPLATE' : 'THOMAS (a person)');

async function facts(db) {
  const live = await db.doc('aiKnowledge/live').get();
  console.log('############ PART A: what the receptionist is allowed to say (the published business facts)');
  if (!live.exists) { console.log('(no published knowledge: the receptionist uses only its built-in lines)\n'); return; }
  const rec = live.data(), k = rec.data || {};                                         // the published record is { version, data: { sections, lines, instructions … } }
  console.log('Published version:', rec.version == null ? '?' : rec.version);
  if (k.instructions) console.log('\nINSTRUCTIONS: ' + clip(plain(k.instructions), 1500));
  for (const s of k.sections || []) {
    console.log('\n## ' + s.title);
    for (const e of s.entries || []) console.log(`- [${e.kind}] ${e.title ? e.title + ': ' : ''}${clip(plain(e.text), MAX_FACT)}`);
  }
  console.log('\nFIXED LINES: ' + JSON.stringify(k.lines || {}).slice(0, 1500));
  console.log('');
}

async function main() {
  initializeApp({ projectId: process.env.EK_PROJECT || 'elite-kitchens-lead-os' });
  const db = getFirestore();
  await facts(db);
  const convs = (await db.collection('conversations').where('updatedAt', '>=', since).get()).docs;
  const found = [];
  for (let i = 0; i < convs.length; i += 10) {
    await Promise.all(convs.slice(i, i + 10).map(async (d) => {
      const msgs = (await d.ref.collection('messages').orderBy('createdAt', 'desc').limit(PER_CHAT).get()).docs.map((x) => x.data()).reverse();
      const autos = msgs.filter((m) => m.auto === true && ms(m.createdAt) >= since.toMillis());
      if (autos.length) found.push({ c: d.data(), id: d.id, msgs, autos });
    }));
  }
  found.sort((a, b) => ms(a.autos[0].createdAt) - ms(b.autos[0].createdAt));
  console.log(`############ PART B: ${found.length} conversation(s) where the receptionist wrote in the last ${DAYS} days (${found.reduce((t, f) => t + f.autos.length, 0)} automatic messages). Last ${PER_CHAT} messages of each.`);
  console.log('(Times are Irish time. RECEPTIONIST (automatic) = sent by the receptionist itself; THOMAS = typed by a person.)\n');
  found.forEach((f, i) => {
    const r = f.c.receptionist || {};
    console.log(`=== ${i + 1}. ${firstName(f.c.name)} (…${f.id.slice(-3)}) | stage: ${f.c.inboxStatus || 'inbox'} | project: ${redact(f.c.projectType || '') || '?'} | area: ${redact(f.c.location || '') || '?'} | receptionist: ${r.on ? (r.paused ? 'paused (' + redact(r.paused) + ')' : 'on') : 'off'}`);
    for (const m of f.msgs) console.log(`[${when(m.createdAt)}] ${who(m)}${m.status === 'failed' ? ' [FAILED TO SEND]' : ''}: ${clip(redact(m.body) || '[' + (m.type || 'no text') + ']', MAX_TEXT)}`);
    console.log('');
  });
  if (!found.length) console.log('No automatic receptionist messages were found in that period.');
}
main().then(() => process.exit(0), (e) => { console.error('Could not read the data:', e.message); process.exit(1); });
