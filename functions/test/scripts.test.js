// Audit findings 7 and 8: the deployment scripts. The emergency shutdown (--close) must never report success when it failed, rolling back
// must not strand a send that is half done, and the old preview script must not make every Cloud Run service public. These tests run the
// REAL scripts against a FAKE `gcloud` that keeps a little pretend state (which services exist, which are open to browsers) and can
// simulate expired credentials, a denied permission, a missing service, and a command that "succeeds" without changing anything.
// Nothing here touches Google Cloud. No emulator is needed. Everything is made up.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const NEW_FUNCS = ['reopenConversation', 'deliverQuote', 'retryQuoteDelivery', 'resolveQuoteDelivery', 'cancelQuoteSend', 'markQuoteSent', 'quoteChannels'];
const QUOTE_FUNCS = ['createCustomer', 'saveQuoteSettings', 'setQuoteNumbering', 'createQuote', 'saveQuoteDraft', 'sendQuote', 'acceptQuote', 'declineQuote', 'reopenQuote', 'reviseQuote', 'discardQuoteDraft', 'deleteQuoteDraft', 'setQuoteNotes', 'quotePdfUrl'];
const low = (s) => s.toLowerCase();

const FAKE_GCLOUD = `#!/usr/bin/env bash
# A pretend gcloud. State: $FAKE_STATE/deployed/<svc> (the service exists), $FAKE_STATE/public/<svc> (allUsers may invoke it),
# $FAKE_STATE/fail/<svc> (how commands for that service fail: perm | cred | notfound | lie | getfail), $FAKE_STATE/calls.log
echo "gcloud $*" >> "$FAKE_STATE/calls.log"
sub="$1 $2 $3"; svc="$4"
mode() { [ -f "$FAKE_STATE/fail/$svc" ] && cat "$FAKE_STATE/fail/$svc" || true; }
case "$sub" in
  "run services add-iam-policy-binding"|"run services remove-iam-policy-binding")
    m=$(mode)
    [ "$m" = cred ] && { echo "ERROR: There was a problem refreshing your current auth tokens: Reauthentication required." >&2; exit 1; }
    [ "$m" = perm ] && { echo "ERROR: (gcloud.run.services.$3) PERMISSION_DENIED: Permission 'run.services.setIamPolicy' denied on resource" >&2; exit 1; }
    { [ "$m" = notfound ] || [ ! -f "$FAKE_STATE/deployed/$svc" ]; } && { echo "ERROR: (gcloud.run.services.$3) Cannot find service [$svc]" >&2; exit 1; }
    [ "$m" = lie ] && { echo "Updated IAM policy for service [$svc]."; exit 0; }
    if [ "$3" = add-iam-policy-binding ]; then touch "$FAKE_STATE/public/$svc"
    else
      [ -f "$FAKE_STATE/public/$svc" ] || { echo "ERROR: (gcloud.run.services.$3) Policy binding with the specified principal and role not found!" >&2; exit 1; }
      rm -f "$FAKE_STATE/public/$svc"
    fi
    echo "Updated IAM policy for service [$svc]."; exit 0 ;;
  "run services get-iam-policy")
    m=$(mode)
    [ "$m" = cred ] && { echo "ERROR: Reauthentication required." >&2; exit 1; }
    [ "$m" = getfail ] && { echo "ERROR: (gcloud.run.services.get-iam-policy) UNAVAILABLE: try again" >&2; exit 1; }
    [ -f "$FAKE_STATE/deployed/$svc" ] || { echo "ERROR: (gcloud.run.services.get-iam-policy) Cannot find service [$svc]" >&2; exit 1; }
    if [ -f "$FAKE_STATE/public/$svc" ]; then echo '{"bindings":[{"members":["allUsers"],"role":"roles/run.invoker"}],"etag":"x"}'; else echo '{"etag":"x"}'; fi
    exit 0 ;;
  "auth print-access-token "*) echo fake-token; exit 0 ;;
  "functions describe claimAccess") if [ -f "$FAKE_STATE/claim-updated" ]; then cat "$FAKE_STATE/claim-updated"; exit 0; fi; echo "ERROR: (gcloud.functions.describe) not found" >&2; exit 1 ;;
  "run services update-traffic")
    [ "$(mode)" = notready ] && { echo "ERROR: (gcloud.run.services.update-traffic) Revision '$svc-00001-old' is not ready and cannot serve traffic. Container import failed." >&2; exit 1; }
    echo "updated traffic $svc"; exit 0 ;;
esac
echo "fake gcloud: unexpected command: $*" >&2; exit 2
`;

// A pretend curl for the Firebase Rules API: $FAKE_STATE/rules-firestore.txt and rules-storage.txt hold the live rules; $FAKE_STATE/curl-fail makes every call fail.
const FAKE_CURL = `#!/usr/bin/env bash
echo "curl $*" >> "$FAKE_STATE/calls.log"
[ -f "$FAKE_STATE/curl-fail" ] && exit 22
for a in "$@"; do url="$a"; done
body() { node -e 'console.log(JSON.stringify({ source: { files: [{ name: "x.rules", content: require("fs").readFileSync(process.argv[1], "utf8") }] } }))' "$1"; }
case "$url" in
  */releases/cloud.firestore) echo '{"rulesetName":"projects/p/rulesets/fs"}' ;;
  */releases/firebase.storage/*) echo '{"rulesetName":"projects/p/rulesets/st"}' ;;
  */rulesets/fs) body "$FAKE_STATE/rules-firestore.txt" ;;
  */rulesets/st) body "$FAKE_STATE/rules-storage.txt" ;;
  *) echo "fake curl: unexpected url $url" >&2; exit 2 ;;
esac
`;

let tmp, state, bin, home;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ek-scripts-'));
  state = path.join(tmp, 'state'); bin = path.join(tmp, 'bin'); home = path.join(tmp, 'home');
  for (const d of ['deployed', 'public', 'fail']) fs.mkdirSync(path.join(state, d), { recursive: true });
  fs.mkdirSync(bin); fs.mkdirSync(home);
  fs.writeFileSync(path.join(bin, 'gcloud'), FAKE_GCLOUD, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), FAKE_CURL, { mode: 0o755 });
  fs.writeFileSync(path.join(state, 'calls.log'), '');
});
const deploy = (funcs, open = true) => { for (const f of funcs) { fs.writeFileSync(path.join(state, 'deployed', low(f)), ''); if (open) fs.writeFileSync(path.join(state, 'public', low(f)), ''); } };
const failWith = (f, how) => fs.writeFileSync(path.join(state, 'fail', low(f)), how);
const isPublic = (f) => fs.existsSync(path.join(state, 'public', low(f)));
const run = (script, args = [], env = {}) => {
  const r = spawnSync('bash', [path.join(SCRIPTS, script), ...args], { encoding: 'utf8', timeout: 60000,
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, FAKE_STATE: state, HOME: home, USERPROFILE: home, ...env } });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

// ================================================== finding 7: --close must tell the truth ====================================
for (const [script, funcs, label] of [['rollback-quote-sending.sh', NEW_FUNCS, 'Phase 6.1'], ['rollback-quotes.sh', QUOTE_FUNCS, 'Phase 6']]) {
  test(`${label} --close: every function open to browsers is closed, VERIFIED, and the script says so`, () => {
    deploy(funcs);
    const r = run(script, ['--close']);
    assert.equal(r.code, 0, r.out);
    for (const f of funcs) assert.equal(isPublic(f), false, f + ' is still open');
    assert.match(r.out, /closed/i);
  });

  test(`${label} --close: a denied permission is a FAILURE: non-zero exit, the function named, and no claim that sending is shut`, () => {
    deploy(funcs); failWith(funcs[1], 'perm');
    const r = run(script, ['--close']);
    assert.notEqual(r.code, 0, 'it reported success although a function is still open:\n' + r.out);
    assert.ok(r.out.includes(funcs[1]), 'the function that is still open must be named:\n' + r.out);
    assert.match(r.out, /NOT closed|still open|FAILED/i);
    assert.ok(!/now get errors/i.test(r.out), 'it must not claim the shutdown worked:\n' + r.out);
    assert.equal(isPublic(funcs[1]), true);
  });

  test(`${label} --close: expired credentials fail loudly, they are not "already closed"`, () => {
    deploy(funcs); for (const f of funcs) failWith(f, 'cred');
    const r = run(script, ['--close']);
    assert.notEqual(r.code, 0, r.out);
    assert.ok(!/already closed/i.test(r.out), 'a failed command was described as "already closed":\n' + r.out);
    for (const f of funcs) assert.equal(isPublic(f), true);
  });

  test(`${label} --close: a command that succeeds but leaves the function open is caught by the final check`, () => {
    deploy(funcs); failWith(funcs[0], 'lie');
    const r = run(script, ['--close']);
    assert.notEqual(r.code, 0, r.out); assert.ok(r.out.includes(funcs[0]), r.out);
  });

  test(`${label} --close: a function that is not deployed, and one that is already closed, are fine (and said so)`, () => {
    deploy(funcs.slice(1)); fs.rmSync(path.join(state, 'public', low(funcs[2])));        // funcs[0] is not deployed; funcs[2] is already closed
    const r = run(script, ['--close']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(funcs[0] + '.*not deployed', 'i')); assert.match(r.out, new RegExp(funcs[2] + '.*already closed', 'i'));
  });

  test(`${label} --close: when the final check itself cannot be done the result is a failure, never success`, () => {
    deploy(funcs); failWith(funcs[3], 'getfail');
    const r = run(script, ['--close']);
    assert.notEqual(r.code, 0, r.out); assert.ok(r.out.includes(funcs[3]), r.out);
  });

  test(`${label} --open: opens and verifies; a failure is a failure`, () => {
    deploy(funcs, false);
    let r = run(script, ['--open']); assert.equal(r.code, 0, r.out);
    for (const f of funcs) assert.equal(isPublic(f), true);
    deploy(funcs, false); for (const f of funcs) fs.rmSync(path.join(state, 'public', low(f)), { force: true });
    failWith(funcs[4], 'perm');
    r = run(script, ['--open']); assert.notEqual(r.code, 0, r.out); assert.ok(r.out.includes(funcs[4]), r.out);
  });
}

// ============================ rolling back functions must not strand a send that is half done (Phase 6.1) ======================
test('rollback to older revisions is REFUSED while a quote send is in progress (the old functions do not know the lock), unless told to go on', () => {
  fs.writeFileSync(path.join(home, '.previous-revisions-phase61'), 'sendquote=sendquote-00001-abc\n');
  const blocked = run('rollback-quote-sending.sh', [], { PREPARED_SENDS_CMD: 'echo "q_123 (EK-0104 v1)"; exit 3' });
  assert.notEqual(blocked.code, 0, blocked.out);
  assert.match(blocked.out, /in progress|prepared/i); assert.ok(blocked.out.includes('q_123'), blocked.out);
  assert.match(blocked.out, /REFUSED: a quote send is in progress/); assert.ok(!/could not check/i.test(blocked.out), 'it must say a send is in progress, not that it could not check: ' + blocked.out);
  assert.ok(!/update-traffic/.test(fs.readFileSync(path.join(state, 'calls.log'), 'utf8')), 'nothing may be restored while a send is in progress');
  const forced = run('rollback-quote-sending.sh', ['--ignore-prepared'], { PREPARED_SENDS_CMD: 'echo "q_123"; exit 3' });
  assert.equal(forced.code, 0, forced.out); assert.match(fs.readFileSync(path.join(state, 'calls.log'), 'utf8'), /update-traffic sendquote/);
});

test('rollback proceeds when no send is in progress; and when it cannot tell, it refuses rather than guess', () => {
  fs.writeFileSync(path.join(home, '.previous-revisions-phase61'), 'sendquote=sendquote-00001-abc\n');
  const ok = run('rollback-quote-sending.sh', [], { PREPARED_SENDS_CMD: 'echo none; exit 0' });
  assert.equal(ok.code, 0, ok.out); assert.match(fs.readFileSync(path.join(state, 'calls.log'), 'utf8'), /update-traffic sendquote/);
  const unsure = run('rollback-quote-sending.sh', [], { PREPARED_SENDS_CMD: 'echo "cannot reach Firestore" >&2; exit 2' });
  assert.notEqual(unsure.code, 0, unsure.out); assert.match(unsure.out, /could not check|cannot|ignore-prepared/i);
});

test('a restore that fails (Google no longer has that version\'s files) is reported as a failure: non-zero exit, the functions named, and the way back that does work', () => {
  fs.writeFileSync(path.join(home, '.previous-revisions-phase61'), 'sendquote=sendquote-00001-abc\ncreatequote=createquote-00001-def\n');
  failWith('sendQuote', 'notready');
  const some = run('rollback-quote-sending.sh', [], { PREPARED_SENDS_CMD: 'echo none; exit 0' });
  assert.notEqual(some.code, 0, some.out);
  assert.match(some.out, /NOT RESTORED: sendquote/); assert.ok(!/NOT RESTORED:.*createquote/.test(some.out), some.out);
  assert.match(some.out, /restored createquote/); assert.ok(!/restored sendquote/.test(some.out), some.out);
  assert.match(some.out, /redeploy the previous code from git/);
  failWith('createQuote', 'notready');
  const all = run('rollback-quote-sending.sh', [], { PREPARED_SENDS_CMD: 'echo none; exit 0' });
  assert.notEqual(all.code, 0, all.out); assert.ok(!/restored /.test(all.out), all.out); assert.match(all.out, /NOT RESTORED: sendquote createquote/);
});

// ============================ finding 8: the old preview script must not open every service to browsers =========================
test('which functions are public is worked out from index.js: callables and the two web endpoints, never a scheduled function', () => {
  const r = spawnSync('node', [path.join(SCRIPTS, 'public-functions.js')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const names = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const src = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
  const wanted = [...src.matchAll(/^exports\.(\w+)\s*=\s*on(?:Call|Request)\b/gm)].map((m) => low(m[1]));
  assert.deepEqual([...names].sort(), [...wanted].sort());
  assert.ok(!names.includes('calendarsweep'), 'the calendar sweeper must stay private');
  for (const must of ['webhook', 'leadintake', 'claimaccess', 'delivequote'.replace('delive', 'deliver'), 'sendreply']) assert.ok(names.includes(must), must + ' is missing');
  assert.equal(new Set(names).size, names.length);
});

test('deploy-preview.sh no longer binds allUsers on every service it finds, and it asserts the private ones stay private', () => {
  const s = fs.readFileSync(path.join(SCRIPTS, 'deploy-preview.sh'), 'utf8');
  const lines = s.split('\n');
  const loopsOverAll = lines.map((l, i) => [l, i]).filter(([l]) => /for svc in \$\(gcloud run services list/.test(l));
  for (const [, i] of loopsOverAll) {                     // reading revisions from every service is fine; granting access is not
    const body = lines.slice(i, i + 4).join('\n');
    assert.ok(!/allUsers|add-iam-policy-binding|iam_public/.test(body), 'a loop over EVERY service grants public access:\n' + body);
  }
  assert.match(s, /public-functions\.js/);
  assert.match(s, /calendarsweep/i);
});

test('the shared helper only touches the services it is given, and a private service is reported when it has been opened by mistake', () => {
  deploy(['alpha', 'calendarSweep']);
  const r = spawnSync('bash', ['-c', `. "${path.join(SCRIPTS, 'lib-run-iam.sh').replace(/\\/g, '/')}"; PROJECT=p; REGION=r; iam_public add alpha; echo "rc=$?"; iam_assert_private calendarSweep; echo "private rc=$?"`],
    { encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, FAKE_STATE: state, HOME: home } });
  const out = r.stdout + r.stderr;
  assert.match(out, /rc=0/); assert.equal(isPublic('alpha'), true);
  assert.equal(isPublic('beta'), false);
  assert.match(out, /private rc=[1-9]/, 'an open private service must be reported:\n' + out);
});

test('rollback --originals restores from the ORIGINAL list (before Phase 6.1), not from the last-deploy list', () => {
  fs.writeFileSync(path.join(home, '.previous-revisions-phase61'), 'sendquote=sendquote-00002-new\n');
  fs.writeFileSync(path.join(home, '.previous-revisions-phase61.original'), 'sendquote=sendquote-00001-orig\n');
  const r = run('rollback-quote-sending.sh', ['--originals'], { PREPARED_SENDS_CMD: 'echo none' });
  assert.equal(r.code, 0, r.out); assert.match(r.out, /sendquote-00001-orig/); assert.ok(!/00002-new/.test(r.out));
});

test('an unknown option prints the help and does nothing', () => {
  const r = run('rollback-quote-sending.sh', ['--nonsense']);
  assert.notEqual(r.code, 0); assert.match(r.out, /--close/); assert.equal(fs.readFileSync(path.join(state, 'calls.log'), 'utf8'), '');
});


// ============================ second audit 7: staff access has an expiry; the security rules and claimAccess must stay in step ===========================
// New rules refuse a sign-in without an expiry, so an OLDER claimAccess (it gives none) put back by a rollback, or rules published while claimAccess is still
// the old one, would lock everyone out of the screen. scripts/access-compat.sh reads the live state and says whether a step is safe; nothing here is real.
const NEW_RULES = "allow read: if request.auth.token.staff == true && request.auth.token.get('staffUntil', 0) > request.time.toMillis();";
const OLD_RULES = 'allow read: if request.auth.token.staff == true;';
const rulesAre = (firestoreRules, storageRules = firestoreRules) => { fs.writeFileSync(path.join(state, 'rules-firestore.txt'), firestoreRules); fs.writeFileSync(path.join(state, 'rules-storage.txt'), storageRules); };
const claimUpdated = (iso) => fs.writeFileSync(path.join(state, 'claim-updated'), iso + '\n');
const cannotRead = () => fs.writeFileSync(path.join(state, 'curl-fail'), '');
const NEW_CODE = 'const staffUntil = now() + 1;\n', OLD_CODE = 'await adminAuth.setCustomUserClaims(auth.uid, { staff: true });\n';
const OLD_CLAIM = '2026-09-30T22:34:44Z', NEW_CLAIM = '2026-10-09T21:50:00Z';
const compat = (cmd, { code = NEW_CODE, env = {} } = {}) => {
  const f = path.join(tmp, 'handlers.js'); fs.writeFileSync(f, code);
  return run('access-compat.sh', [cmd], { ACCESS_HANDLERS_FILE: f, ACCESS_CLAIM_SINCE: '2026-10-08T05:00:00Z', ...env });
};
const callsLog = () => fs.readFileSync(path.join(state, 'calls.log'), 'utf8');

test('status tells the truth about the three parts, and calls "the rules need the expiry but claimAccess does not give it" DANGER', () => {
  rulesAre(NEW_RULES); claimUpdated(OLD_CLAIM);
  const danger = compat('status');
  assert.match(danger.out, /REQUIRE an expiring staff claim/); assert.match(danger.out, /older than the expiry code/); assert.match(danger.out, /VERDICT: DANGER/); assert.match(danger.out, /rules-back/);
  claimUpdated(NEW_CLAIM);
  assert.match(compat('status').out, /VERDICT: in step/);
  rulesAre(OLD_RULES);
  assert.match(compat('status').out, /VERDICT: safe .*can be published/);
  assert.match(callsLog(), /x-goog-user-project: elite-kitchens-lead-os/, 'the call to the Rules API must name the project to bill');
  cannotRead();
  const blind = compat('status'); assert.match(blind.out, /could not be read/); assert.match(blind.out, /VERDICT: not proven/);
});

test('allow-code: code that gives the expiry is always fine; code WITHOUT it only while the live rules do not require one, and never when that cannot be read', () => {
  rulesAre(NEW_RULES); claimUpdated(NEW_CLAIM);
  assert.equal(compat('allow-code', { code: NEW_CODE }).code, 0);
  const bad = compat('allow-code', { code: OLD_CODE });
  assert.equal(bad.code, 1, bad.out); assert.match(bad.out, /REFUSED/); assert.match(bad.out, /locked out/); assert.match(bad.out, /rules-back/);
  rulesAre(OLD_RULES);
  assert.equal(compat('allow-code', { code: OLD_CODE }).code, 0);
  rulesAre(OLD_RULES, NEW_RULES);                                                      // Firestore still old but Storage already new: the rules DO require it
  const storageOnly = compat('allow-code', { code: OLD_CODE }); assert.equal(storageOnly.code, 1);
  assert.match(storageOnly.out, /REQUIRE one/, 'Storage requiring the expiry must be recognised, not reported as unreadable');
  rulesAre(OLD_RULES); cannotRead();
  assert.equal(compat('allow-code', { code: OLD_CODE }).code, 1, 'when the live rules cannot be read, old code must be refused');
  assert.equal(compat('allow-code', { code: NEW_CODE }).code, 0, 'code that gives the expiry needs no proof');
  assert.equal(compat('allow-code', { env: { ACCESS_HANDLERS_FILE: path.join(tmp, 'does-not-exist.js') } }).code, 1);
});

test('allow-legacy-code (an older claimAccess put back): only while the live rules do not require the expiry', () => {
  rulesAre(NEW_RULES);
  const r = compat('allow-legacy-code'); assert.equal(r.code, 1, r.out); assert.match(r.out, /locked out|lock everyone out/); assert.match(r.out, /rules-back/);
  rulesAre(OLD_RULES); assert.equal(compat('allow-legacy-code').code, 0);
  cannotRead(); assert.equal(compat('allow-legacy-code').code, 1);
});

test('allow-rules: only if this checkout gives the expiry AND the live claimAccess is newer than the code that gives it; never when that cannot be checked', () => {
  claimUpdated(NEW_CLAIM);
  const r = compat('allow-rules'); assert.equal(r.code, 0, r.out);
  const oldCheckout = compat('allow-rules', { code: OLD_CODE }); assert.equal(oldCheckout.code, 1, oldCheckout.out); assert.match(oldCheckout.out, /WITHOUT an expiry/);
  claimUpdated(OLD_CLAIM);
  const oldLive = compat('allow-rules'); assert.equal(oldLive.code, 1, oldLive.out); assert.match(oldLive.out, /older than the code that gives the expiry/); assert.match(oldLive.out, /older/);
  fs.rmSync(path.join(state, 'claim-updated'));
  const unknown = compat('allow-rules'); assert.equal(unknown.code, 1, unknown.out); assert.match(unknown.out, /could not be checked/);
  claimUpdated(NEW_CLAIM);
});

test('ACCESS_COMPAT_FORCE=yes lets a person who has checked by hand go on (and says so); nothing else does', () => {
  rulesAre(NEW_RULES);
  assert.equal(compat('allow-legacy-code').code, 1);
  const forced = compat('allow-legacy-code', { env: { ACCESS_COMPAT_FORCE: 'yes' } });
  assert.equal(forced.code, 0, forced.out); assert.match(forced.out, /going on anyway/);
  assert.equal(compat('allow-legacy-code', { env: { ACCESS_COMPAT_FORCE: '1' } }).code, 1, 'only the exact word counts');
});

test('the rollback script will not put an older claimAccess back while the new rules are live; other functions restore as usual; the override works', () => {
  const list = (...lines) => fs.writeFileSync(path.join(home, '.previous-revisions-phase61'), lines.join('\n') + '\n');
  const roll = (env = {}) => run('rollback-quote-sending.sh', [], { PREPARED_SENDS_CMD: 'echo none; exit 0', ACCESS_CLAIM_SINCE: '2026-10-08T05:00:00Z', ...env });
  rulesAre(NEW_RULES);
  list('claimaccess=claimaccess-00001-old', 'sendreply=sendreply-00001-old');
  const refused = roll(); assert.notEqual(refused.code, 0, refused.out); assert.match(refused.out, /REFUSED/); assert.match(refused.out, /rules-back/);
  assert.ok(!/update-traffic/.test(callsLog()), 'nothing may be restored when it would lock staff out');
  list('sendreply=sendreply-00001-old');                                               // no claimAccess in the list: nothing to do with access
  const fine = roll(); assert.equal(fine.code, 0, fine.out); assert.match(callsLog(), /update-traffic sendreply/);
  list('claimaccess=claimaccess-00001-old'); rulesAre(OLD_RULES);                      // the old rules do not mind
  const old = roll(); assert.equal(old.code, 0, old.out); assert.match(callsLog(), /update-traffic claimaccess/);
  rulesAre(NEW_RULES);
  const forced = roll({ ACCESS_COMPAT_FORCE: 'yes' }); assert.equal(forced.code, 0, forced.out);
});

test('the deploy stages that change staff access run the check first, "older" includes startConversation, and "back" and "rules-back" put your checkout back whatever happens', () => {
  const s = fs.readFileSync(path.join(SCRIPTS, 'deploy-quote-sending.sh'), 'utf8').replace(/\r\n/g, '\n');
  const stage = (name) => { const i = s.indexOf(`\n  ${name})\n`); assert.ok(i >= 0, name + ' stage not found'); return s.slice(i, s.indexOf('\n    ;;', i)); };
  assert.match(stage('older'), /access-compat\.sh allow-code/); assert.ok(stage('older').indexOf('access-compat') < stage('older').indexOf('confirm '), 'older: the check must come before the question');
  assert.match(stage('rules'), /access-compat\.sh allow-rules/); assert.ok(stage('rules').indexOf('access-compat') < stage('rules').indexOf('confirm '), 'rules: the check must come before the question');
  for (const name of ['rules-back', 'back']) {
    assert.match(stage(name), /trap 'git checkout HEAD -- /, name + ': it must restore your checkout');
    assert.match(stage(name), /git checkout "\$PRE_AUDIT" -- /, name + ': it must take the code from the commit before the audit fixes');
  }
  assert.match(s, /^OLDER_FUNCS=".*startConversation/m);
});

test('rules-back publishes the PREVIOUS rules, and leaves your checkout on the audit-fix rules both when it works and when the deploy fails', () => {
  const repo = path.join(tmp, 'repo'); fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  for (const f of ['deploy-quote-sending.sh', 'access-compat.sh', 'lib-run-iam.sh']) fs.copyFileSync(path.join(SCRIPTS, f), path.join(repo, 'scripts', f));
  const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' });
  const put = (rules, code) => { fs.writeFileSync(path.join(repo, 'firestore.rules'), rules + '\n'); fs.writeFileSync(path.join(repo, 'storage.rules'), rules + ' // storage\n');
    fs.mkdirSync(path.join(repo, 'functions', 'lib'), { recursive: true }); fs.writeFileSync(path.join(repo, 'functions', 'lib', 'handlers.js'), code); };
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); put(OLD_RULES, OLD_CODE); git('add', '-A'); git('commit', '-q', '-m', 'before the audit fixes');
  const pre = git('rev-parse', 'HEAD').stdout.trim();
  put(NEW_RULES, NEW_CODE); git('add', '-A'); git('commit', '-q', '-m', 'audit fixes');
  fs.writeFileSync(path.join(bin, 'firebase'), '#!/usr/bin/env bash\necho "firebase $*" >> "$FAKE_STATE/calls.log"\n[ -f "$FAKE_STATE/firebase-fail" ] && { echo "Error: deploy failed" >&2; exit 1; }\ncp firestore.rules "$FAKE_STATE/deployed-firestore.rules"; cp storage.rules "$FAKE_STATE/deployed-storage.rules"\necho "Deploy complete!"\n', { mode: 0o755 });
  const go = (input, ...args) => { const r = spawnSync('bash', [path.join(repo, 'scripts', 'deploy-quote-sending.sh'), ...(args.length ? args : ['rules-back'])], { encoding: 'utf8', input, timeout: 60000, cwd: repo,
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, FAKE_STATE: state, HOME: home, USERPROFILE: home, PRE_AUDIT: pre } }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
  const norm = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  const stillNew = () => norm(path.join(repo, 'firestore.rules')) === NEW_RULES + '\n' && git('status', '--porcelain').stdout.trim() === '';

  const no = go('no\n'); assert.notEqual(no.code, 0, no.out); assert.ok(!fs.existsSync(path.join(state, 'deployed-firestore.rules')), 'nothing may be deployed when the answer is not yes'); assert.ok(stillNew());
  const yes = go('yes\n'); assert.equal(yes.code, 0, yes.out); assert.match(yes.out, /previous rules are live/);
  assert.equal(norm(path.join(state, 'deployed-firestore.rules')), OLD_RULES + '\n', 'the PREVIOUS rules must be what is deployed');
  assert.equal(norm(path.join(state, 'deployed-storage.rules')), OLD_RULES + ' // storage\n');
  assert.ok(stillNew(), 'your checkout must be back on the audit-fix rules:\n' + git('status', '--porcelain').stdout);
  fs.writeFileSync(path.join(state, 'firebase-fail'), '');                            // the deploy itself fails
  const failed = go('yes\n'); assert.notEqual(failed.code, 0, failed.out);
  assert.ok(stillNew(), 'a failed deploy must still leave your checkout on the audit-fix rules');
  fs.writeFileSync(path.join(repo, 'firestore.rules'), 'local edit\n');               // local changes are never overwritten
  const dirty = go('yes\n'); assert.notEqual(dirty.code, 0); assert.match(dirty.out, /local changes/);
  assert.equal(fs.readFileSync(path.join(repo, 'firestore.rules'), 'utf8'), 'local edit\n');

  // "back": the functions come from the commit before the audit fixes, and your checkout is put back even when the stage it runs stops early
  git('checkout', '--', 'firestore.rules');
  const usage = go('', 'back', 'nonsense'); assert.notEqual(usage.code, 0); assert.match(usage.out, /Usage: .* back backend\|older/);
  const back = go('yes\n', 'back', 'older');                                                 // the stage itself stops early here (there is no settings file in this pretend repo)
  assert.notEqual(back.code, 0, back.out); assert.match(back.out, /Going back: the stage "older" is redeployed from the code of/);
  assert.equal(norm(path.join(repo, 'functions', 'lib', 'handlers.js')), NEW_CODE, 'a stopped "back" must leave your checkout on the audit-fix code');
  assert.equal(git('status', '--porcelain').stdout.trim(), '', git('status', '--porcelain').stdout);
});
