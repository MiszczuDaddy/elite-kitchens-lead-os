// Audit finding 5: removing someone from ALLOWED_EMAILS must really end their access. Before, Firestore and Storage trusted the stored
// `staff: true` claim for ever (a claim persists until it is changed, and Firebase keeps refreshing the token that carries it), and the claim
// was cleared only if the removed person called claimAccess themselves. Now staff access EXPIRES (the claim carries `staffUntil`), the app
// renews it while the person is still allowed, and an administrator can end it at once. Real Firestore + Storage emulators with the real
// rules files; fake sign-in service. Everything is made up.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const h = require('../lib/handlers');

const PROJECT = 'demo-leados', BUCKET = 'demo-leados.firebasestorage.app';
const HOUR = 3600 * 1000;
const ROOT = path.join(__dirname, '..', '..');
const cfg = { allowedEmails: 'thomas@example.com' };

// ============================================================ claimAccess ===================================================
function fakeAdminAuth() { const calls = []; return { calls, setCustomUserClaims: async (uid, claims) => { calls.push([uid, claims]); }, revokeRefreshTokens: async (uid) => { calls.push([uid, 'revoked']); } }; }
const user = (email, extra = {}) => ({ uid: 'u-' + email, token: { email, email_verified: true, ...extra } });

test('claimAccess gives an allowed, verified person a staff claim that EXPIRES (about 12 hours), and says when', async () => {
  const adminAuth = fakeAdminAuth(), now = 1_800_000_000_000;
  const r = await h.claimAccess(user('thomas@example.com'), { adminAuth, cfg, now: () => now });
  assert.deepEqual(adminAuth.calls, [['u-thomas@example.com', { staff: true, staffUntil: now + 12 * HOUR }]]);
  assert.equal(r.ok, true); assert.equal(r.staffUntil, now + 12 * HOUR);
});

test('claimAccess refuses someone who is no longer allowed AND removes the claim they still carry; it never grants anything', async () => {
  const adminAuth = fakeAdminAuth();
  await assert.rejects(h.claimAccess(user('former@example.com', { staff: true, staffUntil: Date.now() + HOUR }), { adminAuth, cfg }), (e) => e.code === 'permission-denied');
  assert.deepEqual(adminAuth.calls, [['u-former@example.com', { staff: false }]]);                         // no staffUntil: access is over
  const none = fakeAdminAuth();
  await assert.rejects(h.claimAccess(user('stranger@gmail.com'), { adminAuth: none, cfg }), (e) => e.code === 'permission-denied');
  assert.deepEqual(none.calls, []);
  await assert.rejects(h.claimAccess(null, { adminAuth: none, cfg }), (e) => e.code === 'unauthenticated');
  await assert.rejects(h.claimAccess(user('thomas@example.com', { email_verified: false }), { adminAuth: none, cfg }), (e) => e.code === 'permission-denied');
});

// ============================================================ the rules =====================================================
const claims = (extra) => ({ email: 'thomas@example.com', email_verified: true, ...extra });
test('Firestore rules: a staff claim works only while it has not expired; no expiry, an old one or a malformed one is the same as no access', async () => {
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  const env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { host, port: Number(port), rules: fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8') } });
  await env.withSecurityRulesDisabled(async (ctx) => { await ctx.firestore().doc('conversations/1').set({ phone: '1' }); });
  const as = (uid, c) => env.authenticatedContext(uid, c).firestore();
  await assertSucceeds(as('a', claims({ staff: true, staffUntil: Date.now() + HOUR })).doc('conversations/1').get());          // valid
  await assertFails(as('b', claims({ staff: true })).doc('conversations/1').get());                                           // the OLD kind of claim: no expiry
  await assertFails(as('c', claims({ staff: true, staffUntil: Date.now() - 1000 })).doc('conversations/1').get());             // expired
  await assertFails(as('d', claims({ staff: true, staffUntil: 'tomorrow' })).doc('conversations/1').get());                    // not a number
  await assertFails(as('e', claims({ staff: false, staffUntil: Date.now() + HOUR })).doc('conversations/1').get());            // revoked
  await assertFails(as('f', claims({ staffUntil: Date.now() + HOUR })).doc('conversations/1').get());                         // an expiry alone is nothing
  await assertFails(env.unauthenticatedContext().firestore().doc('conversations/1').get());
  await assertFails(as('g', claims({ staff: true, staffUntil: Date.now() + HOUR })).doc('conversations/1').set({ phone: 'x' }));   // and nobody writes from a browser, as before
  await env.cleanup();
});

test('Storage rules: staff may drop a file into their own uploads folder only while the claim has not expired', async () => {
  const [host, port] = process.env.FIREBASE_STORAGE_EMULATOR_HOST.split(':');
  const env = await initializeTestEnvironment({ projectId: PROJECT, storage: { host, port: Number(port), rules: fs.readFileSync(path.join(ROOT, 'storage.rules'), 'utf8') } });
  const put = (uid, c, p) => env.authenticatedContext(uid, c).storage('gs://' + BUCKET).ref(p).put(Buffer.from('x'), { contentType: 'text/plain' });
  await assertSucceeds(put('u1', { staff: true, staffUntil: Date.now() + HOUR }, 'uploads/u1/a.txt'));
  await assertFails(put('u2', { staff: true }, 'uploads/u2/a.txt'));                                                          // the old kind of claim
  await assertFails(put('u3', { staff: true, staffUntil: Date.now() - 1000 }, 'uploads/u3/a.txt'));                          // expired
  await assertFails(put('u4', { staff: true, staffUntil: Date.now() + HOUR }, 'uploads/u5/a.txt'));                          // someone else's folder, as before
  await env.cleanup();
});

// ============================================================ the administrator's way to end access =========================
test('the revoke script ends access: clears the claim and the sign-in sessions; an unknown account or a missing address is an error, not a success', async () => {
  const { revokeStaff } = require('../../scripts/revoke-staff.js');
  const calls = [];
  const adminAuth = { getUserByEmail: async (e) => { if (e === 'nobody@example.com') { const x = new Error('no user'); x.code = 'auth/user-not-found'; throw x; } return { uid: 'u-1', email: e }; },
    setCustomUserClaims: async (uid, c) => { calls.push(['claims', uid, c]); }, revokeRefreshTokens: async (uid) => { calls.push(['revoked', uid]); } };
  const r = await revokeStaff(adminAuth, 'Former@Example.com ');
  assert.deepEqual(calls, [['claims', 'u-1', { staff: false }], ['revoked', 'u-1']]); assert.equal(r.uid, 'u-1');
  await assert.rejects(revokeStaff(adminAuth, 'nobody@example.com'), /no account|not found/i);
  await assert.rejects(revokeStaff(adminAuth, ''), /email/i); await assert.rejects(revokeStaff(adminAuth, 'not-an-email'), /email/i);
  assert.equal(calls.length, 2);
  const cli = spawnSync('node', [path.join(ROOT, 'scripts', 'revoke-staff.js')], { encoding: 'utf8' });                         // run with no address: help, not a crash or a success
  assert.notEqual(cli.status, 0); assert.match(cli.stdout + cli.stderr, /Usage/i);
});
