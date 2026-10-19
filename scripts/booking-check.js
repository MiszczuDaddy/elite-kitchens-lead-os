'use strict';
// READ-ONLY. Shows what the evening-before visit reminder would do right now, from the real data: how many visits are coming up, which ones are tomorrow, who would get a reminder, any reminder that did not go,
// how many reminders have been sent so far, and the installation entries. It changes nothing in Firestore and sends nothing. Phone numbers are shown as the last 4 digits only.
// Run from the elite-kitchens-lead-os folder in Cloud Shell:  node scripts/booking-check.js
const path = require('path');
const R = require('../functions/lib/bookingRules');
const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : null);
const last4 = (p) => '…' + String(p || '').slice(-4);
const when = (t) => new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));

(async () => {
  const req = require('module').createRequire(path.join(process.cwd(), 'functions', 'package.json'));
  const { initializeApp } = req('firebase-admin/app'), { getFirestore, Timestamp } = req('firebase-admin/firestore');
  initializeApp({ projectId: 'elite-kitchens-lead-os' });
  const db = getFirestore(), now = Date.now();
  const BN = require('../functions/lib/bookingNotices');
  const [appts, notices, installs] = await Promise.all([
    db.collection('appointments').where('start', '>=', Timestamp.fromMillis(now - 8 * 3600e3)).orderBy('start').limit(400).get().then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))),
    db.collection('bookingNotices').limit(500).get().then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))),
    db.collection('appointments').where('type', '==', 'installation').limit(100).get().then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))),
  ]);
  const win = BN.reminderWindow(now);
  const visits = appts.filter((a) => R.NOTIFIED_TYPES.includes(a.type) && a.status === 'scheduled');
  const tomorrow = visits.filter((a) => ms(a.start) >= win.from && ms(a.start) < win.to);
  const due = tomorrow.filter((a) => R.reminderDue(a, now));
  console.log('VISIT REMINDERS, from the real data (' + new Date(now).toISOString() + ')');
  console.log('  scheduled visits from now on (consultations and site visits):', visits.length, '(of up to 400 read)');
  console.log('  visits tomorrow:', tomorrow.length, '; reminders that would go (if switched on, between 17:00 and 19:30 Irish time):', due.length);
  console.log('  visits tomorrow that get NO reminder yet because they were booked or changed in the last 4 hours:', tomorrow.filter((a) => !R.reminderDue(a, now) && !(a.visitReminder && ms(a.visitReminder.for) === ms(a.start))).length);
  console.log('  now inside the reminder window:', win.open ? 'yes' : 'no (17:00 to 19:30 Irish time)');
  const issues = appts.filter((a) => a.noticeIssue);
  console.log('  reminders that did not go:', issues.length, issues.map((a) => last4(a.phone) + ' ' + a.noticeIssue.state).join('; ') || '-');
  const by = {}; for (const n of notices) by[n.state] = (by[n.state] || 0) + 1;
  console.log('  reminders Elite OS has handled so far:', notices.length, JSON.stringify(by));
  console.log('  installation entries:', installs.length, '; scheduled:', installs.filter((a) => a.status === 'scheduled').length);
  for (const a of installs.filter((x) => x.status === 'scheduled' && ms(x.start) >= now).slice(0, 10)) console.log('    ' + when(ms(a.start)) + ' ' + last4(a.phone) + ' (project ' + String(a.projectId || '').slice(0, 6) + '…)');
  if (due.length) { console.log('\nREMINDERS DUE TOMORROW'); for (const a of due.slice(0, 15)) console.log('  ' + last4(a.phone) + ' | ' + a.type + ' | ' + when(ms(a.start))); }
  console.log('\nNothing was changed or sent.');
  process.exit(0);
})().catch((e) => { console.error('Could not read: ' + String((e && e.message) || e).slice(0, 300)); process.exit(1); });
