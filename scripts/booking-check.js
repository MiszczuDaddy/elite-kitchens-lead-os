'use strict';
// READ-ONLY. Shows what the Phase 12 booking messages would do right now, from the real data: how many visits are coming up, which ones the customer has not been told about, which reminders would go
// tomorrow evening, any message WhatsApp did not confirm, and how many messages Elite OS has sent so far. It changes nothing in Firestore and sends nothing. Phone numbers are shown as the last 4 digits only.
// Run from the elite-kitchens-lead-os folder in Cloud Shell:  node scripts/booking-check.js
const path = require('path');
const R = require('../functions/lib/bookingRules');
const DAY = 86400000;
const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : null);
const last4 = (p) => '…' + String(p || '').slice(-4);
const when = (t) => new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));

(async () => {
  const need = require('module').createRequire(path.join(process.cwd(), 'functions', 'package.json'));
  const { initializeApp } = need('firebase-admin/app'), { getFirestore, Timestamp } = need('firebase-admin/firestore');
  initializeApp({ projectId: 'elite-kitchens-lead-os' });
  const db = getFirestore(), now = Date.now();
  const BN = require('../functions/lib/bookingNotices');
  const [appts, notices, installs] = await Promise.all([
    db.collection('appointments').where('start', '>=', Timestamp.fromMillis(now - 8 * 3600e3)).orderBy('start').limit(400).get().then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))),
    db.collection('bookingNotices').limit(500).get().then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))),
    db.collection('appointments').where('type', '==', 'installation').limit(100).get().then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))),
  ]);
  const win = BN.reminderWindow(now);
  const notified = appts.filter((a) => R.NOTIFIED_TYPES.includes(a.type) && a.status === 'scheduled');
  const todo = { confirmation: [], change: [], cancellation: [] };
  for (const a of appts) { const k = R.nextAction(a, now); if (k) todo[k].push(a); }
  const tomorrow = notified.filter((a) => ms(a.start) >= win.from && ms(a.start) < win.to);
  const due = tomorrow.filter((a) => R.reminderDue(a, now));
  console.log('BOOKING MESSAGES, from the real data (' + new Date(now).toISOString() + ')');
  console.log('  scheduled visits from now on (consultations and site visits):', notified.length, '(of up to 400 read)');
  console.log('  the customer has NOT been told: confirmation', todo.confirmation.length, '| new time', todo.change.length, '| cancellation', todo.cancellation.length);
  console.log('  visits tomorrow:', tomorrow.length, '; reminders that would go (if switched on, between 17:00 and 19:30):', due.length);
  console.log('  now inside the reminder window:', win.open ? 'yes' : 'no (17:00 to 19:30 Irish time)');
  const issues = appts.filter((a) => a.noticeIssue);
  console.log('  messages with a problem:', issues.length, issues.map((a) => last4(a.phone) + ' ' + a.noticeIssue.kind + ' ' + a.noticeIssue.state).join('; ') || '-');
  const by = {}; for (const n of notices) { const k = n.kind + ':' + n.state; by[k] = (by[k] || 0) + 1; }
  console.log('  messages Elite OS has handled so far:', notices.length, JSON.stringify(by));
  console.log('  installation entries:', installs.length, '; scheduled:', installs.filter((a) => a.status === 'scheduled').length);
  for (const a of installs.filter((x) => x.status === 'scheduled' && ms(x.start) >= now).slice(0, 10)) console.log('    ' + when(ms(a.start)) + ' ' + last4(a.phone) + ' (project ' + String(a.projectId || '').slice(0, 6) + '…)');
  const show = (title, list) => { if (list.length) { console.log('\n' + title); for (const a of list.slice(0, 15)) console.log('  ' + last4(a.phone) + ' | ' + a.type + ' | ' + when(ms(a.start))); } };
  show('NOT TOLD YET (confirmation)', todo.confirmation); show('TOLD A DIFFERENT TIME', todo.change); show('REMINDERS DUE TOMORROW', due);
  console.log('\nNothing was changed or sent.');
  process.exit(0);
})().catch((e) => { console.error('Could not read: ' + String((e && e.message) || e).slice(0, 300)); process.exit(1); });
