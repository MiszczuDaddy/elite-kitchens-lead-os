#!/usr/bin/env node
'use strict';
// Puts (or removes) the ⭐ "wants it as soon as possible" on EXISTING customers, from their Notes only (functions/lib/asap.js): the lead form's answer "1-2 months asap".
// New leads get it by themselves, and editing the Notes updates it; this is the one-time catch-up. It changes ONE field (`asap`) on existing conversations. Nothing is sent, nothing else is touched.
//     node scripts/mark-asap-leads.js            shows what it WOULD change (changes nothing)
//     node scripts/mark-asap-leads.js --apply    makes the change
// Run in Cloud Shell (it has the Google credentials). Customers show as the last 3 digits of their number.
const path = require('path');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore } = fnRequire('firebase-admin/firestore');
const Asap = require('../functions/lib/asap');

const APPLY = process.argv.includes('--apply');
(async () => {
  initializeApp({ projectId: process.env.EK_PROJECT || 'elite-kitchens-lead-os' });
  const db = getFirestore();
  const contacts = (await db.collection('contacts').select('notes').get()).docs;
  const plan = [];
  for (let i = 0; i < contacts.length; i += 20) {
    await Promise.all(contacts.slice(i, i + 20).map(async (d) => {
      const want = Asap.fromNotes(d.data().notes), conv = await db.collection('conversations').doc(d.id).get();
      if (conv.exists && !!conv.data().asap !== want) plan.push({ id: d.id, want });
    }));
  }
  const on = plan.filter((p) => p.want), off = plan.filter((p) => !p.want);
  console.log(`${contacts.length} customers read. ${APPLY ? 'Changing' : 'Would change'}: ${on.length} to get the star, ${off.length} to lose it.`);
  for (const p of plan) console.log(`  ${p.want ? 'star on ' : 'star off'}  …${p.id.slice(-3)}`);
  if (!APPLY) { console.log(plan.length ? 'Nothing was changed. Run again with --apply to make these changes.' : 'Nothing to do.'); return; }
  for (let i = 0; i < plan.length; i += 400) {
    const b = db.batch(); for (const p of plan.slice(i, i + 400)) b.update(db.collection('conversations').doc(p.id), { asap: p.want }); await b.commit();
  }
  console.log('Done.');
})().then(() => process.exit(0), (e) => { console.error('Could not finish:', e.message); process.exit(1); });
