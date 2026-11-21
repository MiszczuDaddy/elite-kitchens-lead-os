#!/usr/bin/env node
'use strict';
// Adds the emails that are ALREADY in customers' chats (what customers sent you, and the replies you sent from a chat) to the new Emails list on the Inbox (docs/EMAIL_LIST.md). From now on every email is added by itself;
// this is the one-time catch-up for the older ones. Automatic follow-ups and quote emails sent before the list existed were never kept as text, so they cannot be added. Safe to run twice.
//     node scripts/backfill-email-log.js            shows how many it WOULD add (changes nothing)
//     node scripts/backfill-email-log.js --apply    adds them
// Run in Cloud Shell (it has the Google credentials). It only writes the list (emailLog); nothing is sent and no customer record is changed.
const path = require('path');
const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = fnRequire('firebase-admin/app');
const { getFirestore } = fnRequire('firebase-admin/firestore');
const EmailLog = require('../functions/lib/emailLog');

const APPLY = process.argv.includes('--apply');
(async () => {
  initializeApp({ projectId: process.env.EK_PROJECT || 'elite-kitchens-lead-os' });
  const r = await EmailLog.backfill(getFirestore(), { apply: APPLY });
  console.log(`${r.read} emails read from customers' chats. ${r.missing} were not in the list yet.`);
  if (!APPLY) { console.log(r.missing ? 'Nothing was changed. Run again with --apply to add them.' : 'Nothing to do.'); return; }
  console.log(`Added ${r.written}.${r.written < r.missing ? ' ' + (r.missing - r.written) + ' could not be added (see the messages above).' : ''}`);
})().then(() => process.exit(0), (e) => { console.error('Could not finish:', e.message); process.exit(1); });
