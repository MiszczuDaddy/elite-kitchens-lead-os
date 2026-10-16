'use strict';
// READ-ONLY. Saves a safe copy of two documents for an independent audit: the PUBLISHED Knowledge Centre content (aiKnowledge/live) and the receptionist's model settings (aiSettings/current).
// It only READS: it changes nothing in Firestore and deploys nothing. It leaves out who published or changed anything (email addresses), the data-approval record, prices and every other setting.
// Run from the elite-kitchens-lead-os folder in Cloud Shell:  node scripts/export-ai-for-astra.js
const fs = require('fs'), path = require('path');
const iso = (t) => (t && typeof t.toDate === 'function' ? t.toDate().toISOString() : null);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));
// The published knowledge: its version, when it was published, the note, and the content.
function knowledgeOf(d) {
  if (!d) return null;
  return { version: d.version, publishedAt: iso(d.publishedAt), note: d.note || '', data: pick(d.data || {}, ['sections', 'links', 'contact', 'lines', 'instructions', 'examples']) };
}
// The receptionist's settings that matter for judging it: which switches are on, which models, the reply delay, the spending caps.
function settingsOf(d) {
  if (!d) return null;
  return pick(d, ['enabled', 'replyAssistant', 'autoReply', 'customerDataApproved', 'replyModel', 'defaultModel', 'replyDelaySeconds', 'maxOutputTokens', 'monthlyCapEur', 'dailyCapEur']);
}
module.exports = { knowledgeOf, settingsOf };

if (require.main === module) {
  (async () => {
    const need = require('module').createRequire(path.join(process.cwd(), 'functions', 'package.json'));
    const { initializeApp } = need('firebase-admin/app'), { getFirestore } = need('firebase-admin/firestore');
    initializeApp({ projectId: 'elite-kitchens-lead-os' });
    const db = getFirestore(), [k, s] = await Promise.all([db.doc('aiKnowledge/live').get(), db.doc('aiSettings/current').get()]);
    if (!k.exists) { console.log('Nothing is published in the Knowledge Centre yet.'); process.exit(1); }
    const dir = path.join(process.env.HOME || '.', 'astra-export'); fs.mkdirSync(dir, { recursive: true });
    const kf = path.join(dir, 'aiKnowledge-live.json'), sf = path.join(dir, 'aiSettings-current.json'), kd = knowledgeOf(k.data());
    fs.writeFileSync(kf, JSON.stringify(kd, null, 2)); fs.writeFileSync(sf, JSON.stringify(settingsOf(s.exists ? s.data() : null), null, 2));
    console.log('Saved (read-only copy):\n  ' + kf + '\n  ' + sf + '\nPublished knowledge: version ' + kd.version + ', ' + (kd.data.sections || []).reduce((n, x) => n + x.entries.length, 0) + ' entries.');
    process.exit(0);
  })().catch((e) => { console.error('Could not read: ' + String((e && e.message) || e).slice(0, 200)); process.exit(1); });
}
