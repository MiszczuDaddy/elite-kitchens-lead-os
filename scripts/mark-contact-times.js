#!/usr/bin/env node
'use strict';
// Puts (or removes) the "best time to contact" on EXISTING customers, from their Notes only (functions/lib/contactTime.js): the lead form's answer to "When is the best time to contact you?".
// New leads get it by themselves, and editing the Notes updates it; this is the one-time catch-up. It changes ONE field (`contactTime`) on existing conversations. Nothing is sent, nothing else is touched.
//     node scripts/mark-contact-times.js            shows what it WOULD change (changes nothing)
//     node scripts/mark-contact-times.js --apply    makes the change
// Run in Cloud Shell (it has the Google credentials). Customers show as the last 3 digits of their number.
const path = require('path');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore } = fnRequire('firebase-admin/firestore');
const ContactTime = require('../functions/lib/contactTime');

const APPLY = process.argv.includes('--apply');
(async () => {
  initializeApp({ projectId: process.env.EK_PROJECT || 'elite-kitchens-lead-os' });
  const db = getFirestore();
  const contacts = (await db.collection('contacts').select('notes').get()).docs;
  const plan = [];
  for (let i = 0; i < contacts.length; i += 20) {
    await Promise.all(contacts.slice(i, i + 20).map(async (d) => {
      const want = ContactTime.fromNotes(d.data().notes), conv = await db.collection('conversations').doc(d.id).get();
      if (conv.exists && (conv.data().contactTime || null) !== want) plan.push({ id: d.id, want });
    }));
  }
  const on = plan.filter((p) => p.want), off = plan.filter((p) => !p.want);
  console.log(`${contacts.length} customers read. ${APPLY ? 'Changing' : 'Would change'}: ${on.length} to get a best time, ${off.length} to lose it.`);
  for (const p of plan) console.log(`  ${p.want ? 'set   ' : 'remove'}  …${p.id.slice(-3)}${p.want ? '  ' + p.want : ''}`);
  if (!APPLY) { console.log(plan.length ? 'Nothing was changed. Run again with --apply to make these changes.' : 'Nothing to do.'); return; }
  for (let i = 0; i < plan.length; i += 400) {
    const b = db.batch(); for (const p of plan.slice(i, i + 400)) b.update(db.collection('conversations').doc(p.id), { contactTime: p.want }); await b.commit();
  }
  console.log('Done.');
})().then(() => process.exit(0), (e) => { console.error('Could not finish:', e.message); process.exit(1); });
