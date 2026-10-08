#!/usr/bin/env node
'use strict';
// End a person's access to Elite OS at once (audit finding 5). Run it in Cloud Shell when someone leaves:
//     node scripts/revoke-staff.js person@example.com
// It clears their staff claim and revokes their sign-in sessions, so they cannot get a new sign-in token. A token they already hold stays valid
// for the rest of its life (up to about an hour, a Firebase rule), after which Firestore and Storage refuse them. ALSO remove the address from
// ALLOWED_EMAILS in functions/.env.elite-kitchens-lead-os and redeploy: until you do, they can sign in again and be allowed back in.
// (Even if you do nothing else, access ends by itself: the staff claim expires after 12 hours and is only renewed while the address is allowed.)
// Needs the functions' dependencies installed (any deploy does that) and Google credentials (Cloud Shell has them).
const fs = require('fs'), path = require('path');

const EMAIL = /^[^\s@<>",;()[\]\\]+@[^\s@<>",;()[\]\\]+\.[^\s@<>",;()[\]\\]+$/;

// adminAuth: the Admin SDK's auth service. Throws a plain Error (never returns success) if anything fails.
async function revokeStaff(adminAuth, email) {
  const address = String(email == null ? '' : email).trim().toLowerCase();
  if (!EMAIL.test(address)) throw new Error('Give the person\'s email address, for example: node scripts/revoke-staff.js person@example.com');
  let user;
  try { user = await adminAuth.getUserByEmail(address); }
  catch (e) {
    if (e && e.code === 'auth/user-not-found') throw new Error(`No account with the email address ${address} has ever signed in here, so there is nothing to revoke.`);
    throw e;
  }
  await adminAuth.setCustomUserClaims(user.uid, { staff: false });
  await adminAuth.revokeRefreshTokens(user.uid);
  return { uid: user.uid, email: user.email || address };
}
module.exports = { revokeStaff, EMAIL };

if (require.main === module) {
  (async () => {
    const arg = process.argv[2];
    if (!arg || arg.startsWith('-')) { console.log('Usage: node scripts/revoke-staff.js person@example.com\n  Ends that person\'s access to Elite OS (see the comments at the top of this file).'); process.exit(2); }
    try {
      const fnRequire = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
      const { initializeApp } = fnRequire('firebase-admin/app'), { getAuth } = fnRequire('firebase-admin/auth');
      initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'elite-kitchens-lead-os' });
      const r = await revokeStaff(getAuth(), arg);
      console.log(`Done: ${r.email} can no longer get a new sign-in; any sign-in they already hold stops working within about an hour.`);
      try {                                                                      // remind, if they are still on the list
        const env = fs.readFileSync(path.join(__dirname, '..', 'functions', '.env.elite-kitchens-lead-os'), 'utf8');
        const line = env.split(/\r?\n/).find((l) => l.startsWith('ALLOWED_EMAILS='));
        if (line && line.slice(15).toLowerCase().split(/[,\s]+/).includes(r.email.toLowerCase())) {
          console.log(`WARNING: ${r.email} is STILL in ALLOWED_EMAILS. Remove it from functions/.env.elite-kitchens-lead-os and redeploy, or they can sign in again.`);
        }
      } catch (e) { /* no settings file here: nothing to compare */ }
    } catch (e) { console.error('NOT DONE: ' + String((e && e.message) || e).split('\n')[0]); process.exit(1); }
  })();
}
