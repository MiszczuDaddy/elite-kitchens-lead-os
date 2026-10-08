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
  "run services update-traffic") echo "updated traffic $svc"; exit 0 ;;
esac
echo "fake gcloud: unexpected command: $*" >&2; exit 2
`;

let tmp, state, bin, home;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ek-scripts-'));
  state = path.join(tmp, 'state'); bin = path.join(tmp, 'bin'); home = path.join(tmp, 'home');
  for (const d of ['deployed', 'public', 'fail']) fs.mkdirSync(path.join(state, d), { recursive: true });
  fs.mkdirSync(bin); fs.mkdirSync(home);
  fs.writeFileSync(path.join(bin, 'gcloud'), FAKE_GCLOUD, { mode: 0o755 });
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
