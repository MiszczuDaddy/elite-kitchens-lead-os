// Quiet hours for the welcome message (functions/lib/quietHours.js, leads.js, welcomeHold.js, docs/WELCOME_QUIET_HOURS.md). A lead that arrives between midnight and 07:00 Irish time is saved and alerted as always, but its
// welcome message waits and is sent at 07:00, after checking nothing changed. Nobody should be messaged at 01:46. Real Firestore emulator; WhatsApp is a fake that records what would be sent. Every name and number is made up.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { createClient } = require('../lib/whatsapp');
const { handleLeadRequest } = require('../lib/leads');
const QH = require('../lib/quietHours');
const Hold = require('../lib/welcomeHold');
const TM = require('../../public/today-model.js');

const PROJECT = 'demo-leados';
initializeApp({ projectId: PROJECT, storageBucket: 'demo-leados.firebasestorage.app' });
const db = getFirestore();
const KEY = 'test-key-1234567890-abcdefghij', cfg = { phoneId: '111', token: 'tok', template: 'elite_kitchens_new_lead', lang: 'en', version: 'v21.0', apiKeys: KEY };
const T = (s) => Date.parse(s), ts = (t) => Timestamp.fromMillis(t);
const NIGHT = T('2026-11-13T01:46:00Z'), MORNING = T('2026-11-13T07:00:00Z'), NOON = T('2026-11-13T12:00:00Z');

// a WhatsApp that records every message it is asked to send; `mode` decides what it answers
function whatsapp(mode = 'ok') {
  const w = { sent: [], async fetch(url, o) { const body = JSON.parse(o.body); w.sent.push(body); const m = typeof mode === 'function' ? mode(w.sent.length) : mode;
    if (m === 'rate') return new Response(JSON.stringify({ error: { message: 'Too many', code: 4 } }), { status: 429, headers: { 'content-type': 'application/json' } });
    if (m === 'refused') return new Response(JSON.stringify({ error: { message: 'Bad number', code: 131026 } }), { status: 400, headers: { 'content-type': 'application/json' } });
    if (m === 'down') return new Response('{}', { status: 500 });
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.W' + w.sent.length }] }), { status: 200, headers: { 'content-type': 'application/json' } }); } };
  w.wa = createClient(cfg, (u, o) => w.fetch(u, o)); return w;
}
const lead = (phone, id, name = 'Aoife Byrne') => ({ leadId: id, formName: 'November 2026 form', field_data: [{ name: 'full_name', values: [name] }, { name: 'phone_number', values: [phone] }] });
const send = (body, { now, wa, hold = true, push } = {}) => handleLeadRequest({ method: 'POST', headers: { authorization: `Bearer ${KEY}` }, rawBody: Buffer.from(JSON.stringify(body)), body }, { db, wa: wa.wa, cfg, now: () => now, holdAtNight: hold, push });
const ledger = async (id) => (await db.doc('leads/' + id).get()).data();
const conv = async (p) => (await db.doc('conversations/' + p).get()).data();
const msgs = async (p) => (await db.collection(`conversations/${p}/messages`).get()).docs.map((d) => d.data());
const sweep = (wa, now) => Hold.sweep({ db, wa: wa.wa, cfg, nowMs: now });
const P = '353871119701', ID = 'LEADNIGHT01';
beforeEach(async () => { await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' }); });
async function heldLead(over = {}) { const wa = whatsapp(); const r = await send(lead('p:+' + P, ID), { now: NIGHT, wa }); assert.equal((await r).body.welcome, 'held'); assert.equal(wa.sent.length, 0); return over.wa || whatsapp(over.mode); }

test('QUIET HOURS: midnight to 07:00 Irish time, in winter and in summer; sending may start at 07:00 Irish time', () => {
  for (const [t, quiet] of [['2026-11-13T00:00:00Z', true], ['2026-11-13T06:59:00Z', true], ['2026-11-13T07:00:00Z', false], ['2026-11-13T23:59:00Z', false], ['2026-07-13T05:59:00Z', true], ['2026-07-13T06:00:00Z', false], ['2026-07-12T22:59:00Z', false], ['2026-07-12T23:00:00Z', true]]) assert.equal(QH.isQuiet(T(t)), quiet, t);
  assert.equal(QH.openAtMs(NIGHT), MORNING); assert.equal(QH.openAtMs(T('2026-07-13T05:30:00Z')), T('2026-07-13T06:00:00Z'), 'summer time: 07:00 Irish time is 06:00 UTC'); assert.equal(QH.openAtMs(NOON), NOON, 'by day: now');
  assert.deepEqual([QH.QUIET_UNTIL_HOUR, require('../lib/aiReceptionist').quiet(NIGHT), require('../lib/aiReceptionist').quiet(MORNING)], [7, true, false], 'the receptionist uses the same rule');
});

test('A LEAD AT 01:46: saved and alerted as always, no WhatsApp message goes, the welcome is held until 07:00 (and a Make retry changes nothing)', async () => {
  const wa = whatsapp(), pushes = []; const r = await send(lead('p:+' + P, ID), { now: NIGHT, wa, push: { notify: async (e) => { pushes.push(e); } } });
  assert.deepEqual([r.status, r.body.status, r.body.welcome, r.body.newCustomer], [200, 'processed', 'held', true]); assert.equal(wa.sent.length, 0, 'nothing is sent at night');
  assert.deepEqual(pushes.map((e) => e.kind), ['lead'], 'the team is alerted at once');
  const l = await ledger(ID); assert.deepEqual([l.state, l.welcome.state, l.welcome.sendAfter, l.welcome.phone, l.welcome.firstName], ['done', 'held', MORNING, P, 'Aoife']);
  assert.ok((await db.doc('contacts/' + P).get()).exists); assert.ok((await conv(P)).createdAt); assert.deepEqual(await msgs(P), []);
  const again = await send(lead('p:+' + P, ID), { now: NIGHT + 1500e3, wa }); assert.equal(again.body.status, 'duplicate'); assert.equal(wa.sent.length, 0);
});

test('THE OLD BEHAVIOUR WHERE IT SHOULD BE: by day the welcome goes at once; with the hold off a night lead is welcomed at once; a returning customer who fills the form at night is held too', async () => {
  const day = whatsapp(); const a = await send(lead('p:+353871119702', 'LEADDAY0001'), { now: NOON, wa: day }); assert.equal(a.body.welcome, 'sent'); assert.equal(day.sent.length, 1);
  const off = whatsapp(); const b = await send(lead('p:+353871119703', 'LEADOFF0001'), { now: NIGHT, wa: off, hold: false }); assert.equal(b.body.welcome, 'sent'); assert.equal(off.sent.length, 1);
  await db.doc('contacts/353871119704').set({ phone: '353871119704', name: 'Old Customer' }); await db.doc('conversations/353871119704').set({ phone: '353871119704', name: 'Old Customer', lastMessageDirection: 'out', lastMessage: 'Your quote', updatedAt: ts(NIGHT - 5 * 86400e3), createdAt: ts(NIGHT - 30 * 86400e3) });
  const c = whatsapp(); const r = await send(lead('p:+353871119704', 'LEADRET0001', 'Old Customer'), { now: NIGHT, wa: c }); assert.equal(r.body.welcome, 'held'); assert.equal(c.sent.length, 0);
});

test('THE MORNING SWEEP: nothing before 07:00; at 07:00 the welcome goes once, with the first name, and is kept in the chat; the lead is marked sent; sweeping again or twice at once sends nothing more', async () => {
  await heldLead(); const wa = whatsapp();
  assert.deepEqual((await sweep(wa, MORNING - 60e3)).quiet, true); assert.equal(wa.sent.length, 0, 'still quiet at 06:59');
  assert.equal((await sweep(wa, T('2026-11-13T06:59:30Z'))).due, 0);
  const r = await sweep(wa, MORNING); assert.deepEqual([r.due, r.results], [1, { sent: 1 }]);
  assert.equal(wa.sent.length, 1); assert.deepEqual([wa.sent[0].to, wa.sent[0].template.name, wa.sent[0].template.components[0].parameters[0].text], [P, 'elite_kitchens_new_lead', 'Aoife']);
  const l = await ledger(ID); assert.deepEqual([l.welcome.state, l.welcome.wamid, l.welcome.template, l.state], ['sent', 'wamid.W1', 'standard', 'done']);
  const m = await msgs(P); assert.equal(m.length, 1); assert.deepEqual([m[0].direction, m[0].type], ['out', 'template']); assert.equal((await db.doc('contacts/' + P).get()).data().metaLead.welcomeClaimedAt, undefined, 'the claim is released');
  await sweep(wa, MORNING + 300e3); assert.equal(wa.sent.length, 1);
  const fresh = await (async () => { await db.recursiveDelete(db.doc('leads/' + ID)); await db.doc('contacts/' + P).delete(); await db.recursiveDelete(db.doc('conversations/' + P)); await heldLead(); return whatsapp(); })();
  await Promise.all([sweep(fresh, MORNING + 600e3), sweep(fresh, MORNING + 600e3)]); assert.equal(fresh.sent.length, 1, 'two sweeps at once send ONE welcome');
});

test('BEFORE SENDING IT CHECKS: a customer who wrote, was contacted, was deleted or asked not to be contacted does not get the welcome; a welcome that went lately is not repeated', async () => {
  const setup = async (convUpdate) => { await heldLead(); if (convUpdate) await db.doc('conversations/' + P).update(convUpdate); };
  const stateAfter = async (wa) => { const r = await sweep(wa, MORNING + 60e3); return { r, state: (await ledger(ID)).welcome.state, sent: wa.sent.length }; };
  const reset = async () => { await db.recursiveDelete(db.doc('leads/' + ID)); await db.doc('contacts/' + P).delete(); await db.recursiveDelete(db.doc('conversations/' + P)); };
  await setup({ lastInboundAt: ts(NIGHT + 600e3), lastMessageDirection: 'in', lastMessage: 'Hi' }); let x = await stateAfter(whatsapp()); assert.deepEqual([x.state, x.sent], ['skipped_replied', 0]); await reset();
  await setup({ emailInboundAt: ts(NIGHT + 600e3) }); x = await stateAfter(whatsapp()); assert.deepEqual([x.state, x.sent], ['skipped_replied', 0], 'an email reply counts'); await reset();
  await setup({ lastMessageDirection: 'out', updatedAt: ts(NIGHT + 1200e3), lastMessage: 'Hi from the team' }); x = await stateAfter(whatsapp()); assert.deepEqual([x.state, x.sent], ['skipped_contacted', 0]); await reset();
  await setup({ receptionist: { humanAt: ts(NIGHT + 600e3) } }); x = await stateAfter(whatsapp()); assert.deepEqual([x.state, x.sent], ['skipped_contacted', 0]); await reset();
  await setup({ lastMessageType: 'template', lastMessageDirection: 'out', updatedAt: ts(MORNING - 30 * 60e3) }); x = await stateAfter(whatsapp()); assert.deepEqual([x.state, x.sent], ['skipped_contacted', 0], 'a message from us since the lead arrived'); await reset();
  await setup(null); await db.doc('contacts/' + P).delete(); await db.recursiveDelete(db.doc('conversations/' + P)); x = await stateAfter(whatsapp()); assert.deepEqual([x.state, x.sent], ['skipped_gone', 0], 'the customer was deleted overnight'); await reset();
  await setup({ doNotContact: { on: true } }); x = await stateAfter(whatsapp()); assert.deepEqual([x.state, x.sent], ['blocked', 0]); assert.match(JSON.stringify(await msgs(P)), /asked not to be contacted/, 'the chat says why'); await reset();
  await setup(null); await db.doc('contacts/' + P).set({ metaLead: { welcomeSentAt: ts(MORNING - 10 * 60e3) } }, { merge: true }); x = await stateAfter(whatsapp()); assert.deepEqual([x.state, x.sent], ['skipped_recent', 0], 'one welcome per number per hour');
});

test('WHEN WHATSAPP SAYS NO: "too many requests" keeps it held for the next sweep (then it goes), six refusals flag it for a person, a refused or unconfirmed send is flagged and never repeated', async () => {
  await heldLead(); const rate = whatsapp('rate'); let r = await sweep(rate, MORNING); assert.deepEqual(r.results, { retry: 1 }); let l = await ledger(ID); assert.deepEqual([l.welcome.state, l.welcome.tries, l.welcome.phone, l.welcome.firstName], ['held', 1, P, 'Aoife']);
  const ok = whatsapp(); r = await sweep(ok, MORNING + 300e3); assert.deepEqual(r.results, { sent: 1 }); assert.equal((await ledger(ID)).welcome.state, 'sent');
  const wipe = async () => { await db.recursiveDelete(db.doc('leads/' + ID)); await db.doc('contacts/' + P).delete(); await db.recursiveDelete(db.doc('conversations/' + P)); };
  await wipe(); await heldLead(); const always = whatsapp('rate'); for (let i = 0; i < Hold.MAX_TRIES; i++) await sweep(always, MORNING + i * 300e3);
  l = await ledger(ID); assert.deepEqual([l.welcome.state, l.welcome.error], ['failed', 'too many retries']); assert.match(JSON.stringify(await msgs(P)), /kept refusing/); const n = always.sent.length; await sweep(always, MORNING + 3600e3); assert.equal(always.sent.length, n, 'a failed one is not tried again');
  await wipe(); await heldLead(); const refused = whatsapp('refused'); await sweep(refused, MORNING); l = await ledger(ID); assert.equal(l.welcome.state, 'failed'); assert.equal(refused.sent.length, 1); await sweep(refused, MORNING + 300e3); assert.equal(refused.sent.length, 1, 'never repeated');
  await wipe(); await heldLead(); const down = whatsapp('down'); await sweep(down, MORNING); assert.equal((await ledger(ID)).welcome.state, 'unknown'); assert.match(JSON.stringify(await msgs(P)), /status unknown/); await sweep(down, MORNING + 300e3); assert.equal(down.sent.length, 1, 'an unconfirmed send is never repeated by itself');
});

test('A SEND THAT NEVER FINISHED: claimed more than ten minutes ago, it is flagged "unknown" for a person and never sent again; a recent one is left alone', async () => {
  await heldLead(); await db.doc('contacts/' + P).set({ metaLead: { leadId: ID } }, { merge: true });
  await db.doc('leads/' + ID).update({ welcome: { state: 'sending', at: MORNING - 5 * 60e3 } }); const wa = whatsapp(); let r = await sweep(wa, MORNING); assert.equal(r.stuck, 0); assert.equal((await ledger(ID)).welcome.state, 'sending');
  r = await sweep(wa, MORNING + 6 * 60e3); assert.equal(r.stuck, 1); assert.equal((await ledger(ID)).welcome.state, 'unknown'); assert.match(JSON.stringify(await msgs(P)), /interrupted while sending/); assert.equal(wa.sent.length, 0);
  r = await sweep(wa, MORNING + 12 * 60e3); assert.equal(r.stuck, 0);
});

test('TODAY SHOWS IT: a held welcome is "goes out at 07:00", not a lead nobody has contacted; and the functions are wired (the switch, the sweep every five minutes)', () => {
  const now = T('2026-11-13T02:30:00Z'), conv = { id: P, name: 'Aoife Byrne', createdAt: { toMillis: () => NIGHT }, updatedAt: { toMillis: () => NIGHT } };
  const r = TM.build({ convs: [conv], contactsToday: [{ id: P, name: 'Aoife Byrne', metaLead: { leadId: ID, receivedAt: { toMillis: () => NIGHT } } }], ledger: { [ID]: { welcome: { state: 'held' } } }, now });
  const item = r.newLeads.items.find((x) => x.phone === P);
  assert.deepEqual([item.status, item.text], ['ai', 'The welcome message goes out at 07:00']);
  const idx = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  assert.match(idx, /const WELCOME_NIGHT_HOLD = defineString\('WELCOME_NIGHT_HOLD', \{ default: 'on' \}\)/); assert.match(idx, /holdAtNight: WELCOME_NIGHT_HOLD\.value\(\)\.trim\(\)\.toLowerCase\(\) !== 'off'/, 'the live intake holds night leads unless switched off');
  assert.match(idx, /exports\.welcomeSweep = onSchedule\(\{ schedule: 'every 5 minutes', timeZone: 'Europe\/Dublin', secrets: \[ACCESS_TOKEN\]/);
  assert.match(fs.readFileSync(path.join(__dirname, '../../test-ui/run.sh'), 'utf8'), /WELCOME_NIGHT_HOLD=off/, 'the browser tests do not depend on the time of day');
});
