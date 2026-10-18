'use strict';
// READ-ONLY. Checks the Today tab against the real data: it reads the same records the Today screen reads, runs the same rules (public/today-model.js), and ALSO counts the raw facts
// without the rules (so a rule that hides too much shows up). It changes nothing in Firestore, sends nothing, and prints only the last 4 digits of a phone number, never a name or a message.
// Run from the elite-kitchens-lead-os folder in Cloud Shell:  node scripts/today-check.js
const path = require('path');
const M = require('../public/today-model.js');
const DAY = 86400000;
const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : null);
const last4 = (p) => '…' + String(p || '').slice(-4);
const ago = (t, now) => (t == null ? 'unknown' : (now - t) / DAY >= 1 ? Math.floor((now - t) / DAY) + ' days ago' : Math.floor((now - t) / 3600e3) + ' hours ago');

(async () => {
  const need = require('module').createRequire(path.join(process.cwd(), 'functions', 'package.json'));
  const { initializeApp } = need('firebase-admin/app'), { getFirestore, Timestamp } = need('firebase-admin/firestore');
  initializeApp({ projectId: 'elite-kitchens-lead-os' });
  const db = getFirestore(), now = Date.now(), t0 = M.dayStart(now), TS = Timestamp;
  const docs = async (q) => (await q.get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  // the same questions the screen asks
  const [recent, booking, quotes, reminders, marks, appts, leadIssues, issues, created, contactsToday] = await Promise.all([
    docs(db.collection('conversations').where('lastInboundAt', '>=', TS.fromMillis(now - 60 * DAY)).orderBy('lastInboundAt', 'desc').limit(500)),
    docs(db.collection('conversations').where('consult.needsBooking', '==', true).limit(200)),
    docs(db.collection('quotes').where('status', '==', 'sent').limit(300)),
    docs(db.collection('reminders').where('status', '==', 'open').limit(300)),
    docs(db.collection('todayMarks').orderBy('at', 'desc').limit(300)),
    docs(db.collection('appointments').where('start', '>=', TS.fromMillis(now - 8 * 3600e3)).orderBy('start').limit(400)),
    docs(db.collection('leadIssues').where('status', '==', 'open').limit(100)),
    docs(db.collection('healthIssues').where('status', '==', 'open')),
    docs(db.collection('conversations').where('createdAt', '>=', TS.fromMillis(t0)).limit(300)),
    docs(db.collection('contacts').where('metaLead.receivedAt', '>=', TS.fromMillis(t0)).limit(300)),
  ]);
  const convs = new Map(); for (const c of [...recent, ...booking, ...created]) convs.set(c.id, c);
  const mk = {}; for (const x of marks) if (x.kind === 'quote' && x.quoteId) mk['quote|' + x.quoteId] = x;
  const r = M.build({ convs: [...convs.values()], appts, quotes, reminders, marks: mk, leadIssues, contactsToday, ledger: {}, now });

  console.log('TODAY, worked out from the real data (' + new Date(now).toISOString() + ')');
  console.log('  what the screen shows:', JSON.stringify(r.counts), ' cards:', r.cards.length);
  console.log('  New Leads Today:', r.newLeads.total, JSON.stringify(r.newLeads.counts));
  console.log('  open system warnings:', issues.map((i) => i.id + ' (' + (i.detail || '') + ')').join('; ') || 'none');

  // the raw facts, with no rules applied
  const inbound = recent.filter((c) => c.lastMessageDirection === 'in');
  const open = inbound.filter((c) => !['closed', 'won'].includes(c.inboxStatus || 'inbox'));
  const dnc = open.filter((c) => c.doNotContact && c.doNotContact.on === true);
  const handling = open.filter((c) => c.receptionist && c.receptionist.on === true && !c.receptionist.paused);
  console.log('\nRAW FACTS (before the rules)');
  console.log('  chats with a customer message in the last 60 days:', recent.length, '(limit 500)');
  console.log('  ...whose newest message is from the customer:', inbound.length, '; not Closed/Won:', open.length, '; of those the receptionist is handling:', handling.length, '; do not contact:', dnc.length);
  const lastIns = open.map((c) => ms(c.lastInboundAt)).filter(Boolean).sort((a, b) => b - a);
  console.log('  newest customer message still unanswered:', lastIns.length ? ago(lastIns[0], now) : 'none');
  const paused = recent.concat(booking).filter((c) => c.receptionist && c.receptionist.paused);
  const reasons = {}; for (const c of paused) { const k = String(c.receptionist.paused).replace(/^handover:.*/i, 'handover: …').slice(0, 40); reasons[k] = (reasons[k] || 0) + 1; }
  console.log('  receptionist pauses on those chats:', paused.length, JSON.stringify(reasons));
  const recentPaused = paused.filter((c) => now - (ms(c.receptionist.pausedAt) || 0) <= 14 * DAY);
  console.log('  ...within 14 days:', recentPaused.length, '; of which a person has since replied:', recentPaused.filter((c) => ms(c.receptionist.humanAt) > ms(c.receptionist.pausedAt)).length);
  console.log('  chats the receptionist marked "needs a visit booked":', booking.length, '; of those with an appointment already:', booking.filter((c) => appts.some((a) => String(a.phone) === c.id && a.status === 'scheduled')).length);
  const sent = quotes.filter((q) => ms(q.sentAt));
  console.log('  quotes "sent" and not answered:', sent.length, '; ages in days:', sent.map((q) => Math.floor((now - ms(q.sentAt)) / DAY)).sort((a, b) => b - a).join(', ') || '-', '(Today lists those 5 to 60 days old)');
  console.log('  scheduled appointments from now on:', appts.filter((a) => a.status === 'scheduled').length);
  console.log('  open reminders:', reminders.length, '; rejected leads waiting:', leadIssues.length);

  if (r.cards.length) { console.log('\nCARDS'); for (const c of r.cards.slice(0, 25)) console.log('  ' + c.kind + ' ' + (c.phone ? last4(c.phone) : '') + ' | ' + c.reasons.map((x) => x.type + ': ' + x.text).join(' + ') + ' | ' + ago(c.since, now)); }
  if (open.length && !r.counts.reply) {
    console.log('\nWHY no "reply waiting" card, per chat (newest first)');
    for (const c of open.sort((a, b) => ms(b.lastInboundAt) - ms(a.lastInboundAt)).slice(0, 12)) {
      const why = c.doNotContact && c.doNotContact.on ? 'do not contact' : M.isPleasantry(c.lastMessage) ? 'a thank-you' : (c.receptionist && c.receptionist.on === true && !c.receptionist.paused && M.workMinutes(ms(c.lastInboundAt), now) < 30) ? 'receptionist given 30 working minutes' : 'RULES SAY IT SHOULD SHOW';
      console.log('  ' + last4(c.id) + ' | ' + ago(ms(c.lastInboundAt), now) + ' | ' + why);
    }
  }
  console.log('\nNothing was changed or sent.');
  process.exit(0);
})().catch((e) => { console.error('Could not read: ' + String((e && e.message) || e).slice(0, 300)); process.exit(1); });
