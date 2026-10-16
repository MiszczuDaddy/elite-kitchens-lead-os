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
  "run services describe")
    # routing tests: $FAKE_STATE/svc-<svc>.json is that service's description; any other DEPLOYED service (but claimAccess) follows its newest revision and is ready
    [ "$(mode)" = describefail ] && { echo "ERROR: (gcloud.run.services.describe) UNAVAILABLE: try again" >&2; exit 1; }
    if [ -f "$FAKE_STATE/svc-$svc.json" ]; then cat "$FAKE_STATE/svc-$svc.json"; exit 0; fi
    if [ "$svc" != claimaccess ]; then
      [ -f "$FAKE_STATE/deployed/$svc" ] || { echo "ERROR: (gcloud.run.services.describe) Cannot find service [$svc]" >&2; exit 1; }
      echo '{"spec":{"traffic":[{"latestRevision":true,"percent":100}]},"status":{"conditions":[{"type":"Ready","status":"True"}]}}'; exit 0
    fi
    cat "$FAKE_STATE/claim-traffic.json" || exit 1; if [ -f "$FAKE_STATE/claim-traffic-after.json" ]; then cp "$FAKE_STATE/claim-traffic-after.json" "$FAKE_STATE/claim-traffic.json"; fi; exit 0 ;;
  "run revisions describe")
    # the service behind a revision name is the name without "-NNNNN-xxx"; fail/<svc> = notready: that version cannot start; gone: its files are deleted
    rev="$4"; owner="\${rev%-[0-9][0-9][0-9][0-9][0-9]-*}"; om=""; [ -f "$FAKE_STATE/fail/$owner" ] && om=$(cat "$FAKE_STATE/fail/$owner")
    [ "$om" = gone ] && { echo "ERROR: (gcloud.run.revisions.describe) Cannot find revision [$rev]" >&2; exit 1; }
    if [ "$om" = notready ]; then echo '{"status":{"conditions":[{"type":"Ready","status":"False","message":"Container import failed."}]}}'; else echo '{"status":{"conditions":[{"type":"Ready","status":"True"}]}}'; fi
    exit 0 ;;
  "run services update-traffic")
    # modes: notready = the saved version cannot start (the switch fails and leaves the routing pinned to it, like the real thing on 2026-10-11); pinfail = the same
    # although the version looked ready; stuck = pinfail and the reset to the newest version fails too; failclean = the switch fails and changes nothing
    m=$(mode); to=""; for a in "$@"; do case "$a" in --to-revisions=*) to="\${a#--to-revisions=}"; to="\${to%=100}" ;; esac; done
    case " $* " in
      *" --to-latest "*)
        [ "$m" = stuck ] && { echo "ERROR: (gcloud.run.services.update-traffic) could not update the service" >&2; exit 1; }
        echo '{"spec":{"traffic":[{"latestRevision":true,"percent":100}]},"status":{"conditions":[{"type":"Ready","status":"True"}]}}' > "$FAKE_STATE/svc-$svc.json"
        echo "updated traffic $svc"; exit 0 ;;
    esac
    case "$m" in
      notready|pinfail|stuck)
        echo '{"spec":{"traffic":[{"revisionName":"REV","percent":100}]},"status":{"conditions":[{"type":"Ready","status":"False","message":"Revision REV is not ready and cannot serve traffic."}]}}' | sed "s/REV/\${to:-$svc-00001-old}/g" > "$FAKE_STATE/svc-$svc.json"
        echo "ERROR: (gcloud.run.services.update-traffic) Revision '\${to:-$svc-00001-old}' is not ready and cannot serve traffic. Container import failed." >&2; exit 1 ;;
      failclean) echo "ERROR: (gcloud.run.services.update-traffic) UNAVAILABLE: try again" >&2; exit 1 ;;
    esac
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
  https://r*---claimaccess-test.a.run.app)
    [ -f "$FAKE_STATE/claim-code" ] || exit 7
    rev=$(echo "$url" | sed -E 's@https://r([0-9]+)---.*@claimaccess-\\1@')
    mode=$(cat "$FAKE_STATE/$rev.code")
    case "$mode" in
      new) echo '{"result":{"ok":true,"expiring":true,"claimMs":43200000,"revision":"'"$rev"'"}}' ;;
      old) echo '{"error":{"status":"UNAUTHENTICATED"}}' ;;
      noexpiry) echo '{"result":{"ok":true,"expiring":false}}' ;;
      noms) echo '{"result":{"ok":true,"expiring":true}}' ;;
      wrongrev) echo '{"result":{"ok":true,"expiring":true,"claimMs":43200000,"revision":"claimaccess-other"}}' ;;
      garbage) echo 'not json at all' ;;
      down) exit 7 ;;
    esac ;;

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
const run = (script, args = [], env = {}, input = undefined) => {
  const r = spawnSync('bash', ['-c', 'gcloud() { bash "$TEST_BIN/gcloud" "$@"; }; curl() { bash "$TEST_BIN/curl" "$@"; }; export -f gcloud curl; exec bash "$@"', 'test', path.isAbsolute(script) ? script : path.join(SCRIPTS, script), ...args], { encoding: 'utf8', timeout: 180000, input,
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, FAKE_STATE: state, TEST_BIN: bin, HOME: home, USERPROFILE: home, ...env } });
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
const claimUpdated = (iso) => fs.writeFileSync(path.join(state, 'claim-updated'), iso + '\n');          // when the function was last (re)deployed: NOT proof of what runs
const claimCode = (answers) => {
  fs.writeFileSync(path.join(state, 'claim-code'), answers);
  const modes = answers.split(',');
  const traffic = modes.map((mode, i) => {
    const revisionName = 'claimaccess-' + (i + 1); fs.writeFileSync(path.join(state, revisionName + '.code'), mode);
    return { revisionName, percent: Math.floor(100 / modes.length) + (i === 0 ? 100 % modes.length : 0), tag: 'r' + (i + 1), url: 'https://r' + (i + 1) + '---claimaccess-test.a.run.app' };
  });
  fs.writeFileSync(path.join(state, 'claim-traffic.json'), JSON.stringify({ metadata: { generation: 1 }, status: { observedGeneration: 1, conditions: [{ type: 'Ready', status: 'True' }], traffic } }));
};
const cannotRead = () => fs.writeFileSync(path.join(state, 'curl-fail'), '');
const NEW_CODE = 'const staffUntil = now() + 1;\n', OLD_CODE = 'await adminAuth.setCustomUserClaims(auth.uid, { staff: true });\n';
const OLD_CLAIM = '2026-09-30T22:34:44Z', NEW_CLAIM = '2026-10-09T21:50:00Z';
const compat = (cmd, { code = NEW_CODE, env = {} } = {}) => {
  const f = path.join(tmp, 'handlers.js'); fs.writeFileSync(f, code);
  fs.rmSync(path.join(state, 'claim-n'), { force: true });
  return run('access-compat.sh', [cmd], { ACCESS_HANDLERS_FILE: f, ...env });
};
const callsLog = () => fs.readFileSync(path.join(state, 'calls.log'), 'utf8');

test('status tells the truth about the three parts, and calls "the rules need the expiry but claimAccess does not give it" DANGER', () => {
  rulesAre(NEW_RULES); claimUpdated(NEW_CLAIM); claimCode('old');
  const danger = compat('status');
  assert.match(danger.out, /REQUIRE an expiring staff claim/); assert.match(danger.out, /older: it gives NO expiry/); assert.match(danger.out, /VERDICT: DANGER/); assert.match(danger.out, /rules-back/);
  claimCode('new');
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

test('allow-rules: only if this checkout gives the expiry AND the code serving claimAccess answers the probe; never when that cannot be checked', () => {
  claimCode('new');
  const r = compat('allow-rules'); assert.equal(r.code, 0, r.out);
  const oldCheckout = compat('allow-rules', { code: OLD_CODE }); assert.equal(oldCheckout.code, 1, oldCheckout.out); assert.match(oldCheckout.out, /WITHOUT an expiry/);
  claimCode('old');
  const oldLive = compat('allow-rules'); assert.equal(oldLive.code, 1, oldLive.out); assert.match(oldLive.out, /older than the code that gives the expiry/);
  fs.rmSync(path.join(state, 'claim-code'));
  const unknown = compat('allow-rules'); assert.equal(unknown.code, 1, unknown.out); assert.match(unknown.out, /could not be checked/);
});

test('third check, finding 7: a claimAccess REDEPLOYED just now with older code is not proof: what answers is what counts, so the rules stay blocked', () => {
  claimUpdated(NEW_CLAIM);                       // the function was (re)deployed minutes ago: a timestamp the old checker took for "the new code"
  claimCode('old');                              // ...but the code now serving it gives staff access no expiry (an older version was redeployed)
  const r = compat('allow-rules');
  assert.equal(r.code, 1, 'the rules were allowed although older code is serving claimAccess:\n' + r.out); assert.match(r.out, /REFUSED/); assert.match(r.out, /older than the code that gives the expiry/);
  assert.match(compat('status').out, /older: it gives NO expiry/);
});

test('third check, finding 7: traffic restored to an OLDER revision after the new code was live is caught (the function\'s own timestamp does not change)', () => {
  claimUpdated(NEW_CLAIM);
  claimCode('new');
  assert.equal(compat('allow-rules').code, 0, 'the new code is serving: allowed');
  claimCode('old');                              // traffic moved back to an older revision: the timestamp above is unchanged
  const r = compat('allow-rules');
  assert.equal(r.code, 1, 'the rules were allowed although traffic is on an older revision:\n' + r.out);
  claimCode('new,old,new');                      // traffic split between two revisions: one old answer is enough
  assert.equal(compat('allow-rules', {}).code, 1, 'a split between versions must be refused');
  claimCode('new');
  assert.equal(compat('allow-rules', {}).code, 0);
});

test('third check, finding 7: a probe that cannot be answered, is answered wrongly, or is split between versions never allows the rules', () => {
  for (const answers of ['down', 'garbage', 'noexpiry', 'noms', 'old', 'new,new,old', 'old,new,new']) {
    claimCode(answers);
    const r = compat('allow-rules', {});
    assert.equal(r.code, 1, answers + ': the rules must be refused:\n' + r.out);
  }
  claimCode('new,new,new'); assert.equal(compat('allow-rules', {}).code, 0);
  claimCode('new,old,new');                                                     // every revision receiving traffic must answer individually
  const byDefault = compat('allow-rules');
  assert.equal(byDefault.code, 1, 'every serving revision must be checked:\n' + byDefault.out);
  cannotRead(); claimCode('new');
  assert.equal(compat('allow-rules').code, 1, 'when the network call fails nothing is proven');
});

test('third check, finding 7: after "older" the script verifies that the NEW claimAccess is the one serving (only when the code deployed gives the expiry)', () => {
  claimCode('old');
  const bad = compat('claim-after-deploy', { code: NEW_CODE }); assert.equal(bad.code, 1, bad.out); assert.match(bad.out, /NOT serving the new code|do not run .rules./i);
  claimCode('new');
  assert.equal(compat('claim-after-deploy', { code: NEW_CODE }).code, 0);
  claimCode('old');
  const legacy = compat('claim-after-deploy', { code: OLD_CODE }); assert.equal(legacy.code, 0, legacy.out);             // going BACK to older code: nothing to prove
  const s2 = fs.readFileSync(path.join(SCRIPTS, 'deploy-quote-sending.sh'), 'utf8').replace(/\r\n/g, '\n');
  const i = s2.indexOf('\n  older)\n'), older = s2.slice(i, s2.indexOf('\n    ;;', i));
  assert.match(older, /access-compat\.sh claim-after-deploy/); assert.ok(older.indexOf('check_reachable') < older.indexOf('claim-after-deploy'), 'the probe comes after the deploy');
  assert.match(older, /for _ in 1 2 3 4 5 6; do if bash \.\/scripts\/access-compat\.sh claim-after-deploy/, 'the stage must ASK (with a few tries: a new revision takes a moment to take over)');
  assert.match(older, /\[ "\$ok" = 1 \] \|\| \{ bash \.\/scripts\/access-compat\.sh claim-after-deploy; exit 1; \}/, 'and STOP when the new code is not the one serving');
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
  for (const f of ['deploy-quote-sending.sh', 'access-compat.sh', 'access-traffic.js', 'lib-run-iam.sh', 'lib-routing.sh', 'routing-check.js']) fs.copyFileSync(path.join(SCRIPTS, f), path.join(repo, 'scripts', f));
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

// Final verification: the old checker missed an old revision after three lucky new responses.
test('final verification 7: every serving revision is checked, including an old fourth revision and a 1 percent revision', () => {
  claimCode('new,new,new,old');
  const r = compat('allow-rules'); assert.equal(r.code, 1, r.out);
  assert.match(callsLog(), /r4---claimaccess-test/);
  claimCode('new,old');
  const file = path.join(state, 'claim-traffic.json'), obj = JSON.parse(fs.readFileSync(file));
  obj.status.traffic[0].percent = 99; obj.status.traffic[1].percent = 1;
  fs.writeFileSync(file, JSON.stringify(obj)); assert.equal(compat('allow-rules').code, 1);
  claimCode('new,new,new,new'); assert.equal(compat('allow-rules').code, 0);
});
test('final verification 7: inaccessible revisions, wrong identities and unknown traffic fail closed', () => {
  for (const modes of ['new,down', 'new,wrongrev']) { claimCode(modes); assert.equal(compat('allow-rules').code, 1); }
  claimCode('new,new');
  const file = path.join(state, 'claim-traffic.json'), obj = JSON.parse(fs.readFileSync(file));
  delete obj.status.traffic[1].url; fs.writeFileSync(file, JSON.stringify(obj));
  assert.equal(compat('allow-rules').code, 1, 'cannot address one member of a split');
  fs.writeFileSync(file, '{}'); assert.equal(compat('allow-rules').code, 1);
  fs.rmSync(file); assert.equal(compat('allow-rules').code, 1);
});

test('final verification 7: traffic changing during verification is refused', () => {
  claimCode('new,new');
  const obj = JSON.parse(fs.readFileSync(path.join(state, 'claim-traffic.json')));
  obj.status.traffic[0].percent = 99; obj.status.traffic[1].percent = 1;
  fs.writeFileSync(path.join(state, 'claim-traffic-after.json'), JSON.stringify(obj));
  const r = compat('allow-rules'); assert.equal(r.code, 1, r.out); assert.match(r.out, /could not be checked/);
});

// ============================ 2026-10-11: a failed restore must never leave a function pinned to a version that cannot start ======================
// The real rollout: every restore by revision failed ("Container import failed") and each failure left the service's traffic PINNED to that revision, so the next deploy of
// all 21 functions failed with "Revision ... is not ready and cannot serve traffic". The rollback script now checks the version first and undoes a pin that fails;
// the deploy stages refuse while anything is pinned; "routing fix" repairs it. The fake gcloud pins the routing the way the real one did (fail/<svc> = notready | pinfail | stuck).
const routingLib = require(path.join(SCRIPTS, 'routing-check.js'));
const svcJson = (name) => JSON.parse(fs.readFileSync(path.join(state, `svc-${name}.json`), 'utf8'));
const pinnedTo = (name, revisionName, ready = false) => fs.writeFileSync(path.join(state, `svc-${low(name)}.json`), JSON.stringify({ spec: { traffic: [{ revisionName, percent: 100 }] },
  status: { conditions: [{ type: 'Ready', status: ready ? 'True' : 'False', message: ready ? '' : `Revision '${revisionName}' is not ready and cannot serve traffic.` }] } }));
const rollbackList = (...lines) => fs.writeFileSync(path.join(home, '.previous-revisions-phase61'), lines.join('\n') + '\n');
const rollback = (args = []) => run('rollback-quote-sending.sh', args, { PREPARED_SENDS_CMD: 'echo none; exit 0' });
const deployScript = (args, input) => run('deploy-quote-sending.sh', args, {}, input);

test('the routing reader: pinned traffic is a PINNED finding (healthy or not), following the newest version is fine, a not-ready service alone is only a note', () => {
  const f = routingLib.findings;
  assert.deepEqual(f({ spec: { traffic: [{ latestRevision: true, percent: 100 }] }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }), []);
  assert.deepEqual(f({}), [], 'nothing known about the service is not a pin');
  assert.deepEqual(f({ spec: { traffic: [{ revisionName: 'a-00004-gik', percent: 100 }] }, status: { conditions: [{ type: 'Ready', status: 'False' }] } }).filter((l) => l.startsWith('PINNED')), ['PINNED a-00004-gik 100%']);
  assert.deepEqual(f({ spec: { traffic: [{ revisionName: 'a-00002-ok', percent: 100 }] }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }), ['PINNED a-00002-ok 100%'], 'a pin on a HEALTHY old version blocks too: a deploy would never be served');
  assert.deepEqual(f({ spec: { traffic: [{ latestRevision: true, percent: 100 }, { revisionName: 'a-00001-x', percent: 0, tag: 'canary' }] } }), [], 'a tagged revision with no traffic is not a pin');
  assert.deepEqual(f({ spec: { traffic: [{ latestRevision: true, percent: 90 }, { revisionName: 'a-00001-x', percent: 10 }] } }), ['PINNED a-00001-x 10%'], 'a traffic split that sends any share to a named version is a pin');
  const note = f({ spec: { traffic: [{ latestRevision: true, percent: 100 }] }, status: { conditions: [{ type: 'Ready', status: 'False', message: 'the last deploy failed' }] } });
  assert.equal(note.length, 1); assert.match(note[0], /^NOTE .*not ready.*the last deploy failed/); assert.equal(routingLib.blocks(note), false, 'a failed latest deploy is fixed by deploying again: it must not block');
  assert.equal(routingLib.blocks(['PINNED a-00001-x 100%']), true);
  assert.equal(routingLib.revisionReady({ status: { conditions: [{ type: 'Ready', status: 'True' }] } }), true);
  for (const bad of [{}, null, { status: {} }, { status: { conditions: [{ type: 'Ready', status: 'False' }] } }, { status: { conditions: [{ type: 'Ready', status: 'Unknown' }] } }, { status: { conditions: [{ type: 'Active', status: 'True' }] } }]) assert.equal(routingLib.revisionReady(bad), false, JSON.stringify(bad));
  const cli = (input, ...args) => spawnSync('node', [path.join(SCRIPTS, 'routing-check.js'), ...args], { input, encoding: 'utf8' });
  assert.equal(cli('not json').status, 2); assert.equal(cli('[]').status, 2); assert.equal(cli('{"spec":{"traffic":[{"revisionName":"x-00001-a","percent":100}]}}').status, 1);
  assert.equal(cli('{"status":{"conditions":[{"type":"Ready","status":"True"}]}}', '--revision-ready').status, 0); assert.equal(cli('{}', '--revision-ready').status, 1); assert.equal(cli('nope', '--revision-ready').status, 2);
});

test('rollback: a saved version that is not Ready is never switched to, so nothing is pinned (the routing is left alone)', () => {
  deploy(['sendQuote', 'createQuote'], false);
  rollbackList('sendquote=sendquote-00001-abc', 'createquote=createquote-00001-def');
  failWith('sendQuote', 'notready');                                    // its files are gone: the version cannot start
  const r = rollback();
  assert.notEqual(r.code, 0, r.out); assert.match(r.out, /NOT RESTORED: sendquote/); assert.match(r.out, /skipped sendquote.*left alone/);
  assert.ok(!/update-traffic sendquote/.test(callsLog()), 'a version that cannot start must not even be asked for:\n' + callsLog());
  assert.match(callsLog(), /update-traffic createquote/); assert.match(r.out, /restored createquote/);
  assert.equal(fs.existsSync(path.join(state, 'svc-sendquote.json')), false, 'its routing must be untouched');
  failWith('sendQuote', 'gone');                                        // Google no longer knows the version at all
  const gone = rollback(); assert.notEqual(gone.code, 0, gone.out); assert.match(gone.out, /NOT RESTORED: sendquote/); assert.ok(!/update-traffic sendquote/.test(callsLog()));
});

test('rollback: when the switch fails although the version looked ready, the pin it left is undone at once and the user is told', () => {
  deploy(['sendQuote', 'createQuote'], false);
  rollbackList('sendquote=sendquote-00001-abc', 'createquote=createquote-00001-def');
  failWith('sendQuote', 'pinfail');
  const r = rollback();
  assert.notEqual(r.code, 0, 'a failed restore is still a failure:\n' + r.out); assert.match(r.out, /NOT RESTORED: sendquote/); assert.ok(!/NOT RESTORED:.*createquote/.test(r.out), r.out);
  assert.match(callsLog(), /update-traffic sendquote .*--to-revisions=sendquote-00001-abc=100/, 'it did try the switch');
  assert.match(callsLog(), /update-traffic sendquote .*--to-latest/, 'and undid the pin it left behind');
  assert.match(r.out, /sendquote: the failed switch had pinned the routing to sendquote-00001-abc; it is back on the newest version/);
  assert.deepEqual(routingLib.findings(svcJson('sendquote')), [], 'the service must follow its newest version again');
  assert.ok(!/STUCK/.test(r.out), r.out);
  assert.ok(!/update-traffic createquote .*--to-latest/.test(callsLog()), 'a service that was restored is not touched again');
  assert.match(r.out, /restored createquote/); assert.match(r.out, /pinned to it:.*createquote/, 'the restored one is pinned on purpose and the note says so');
});

test('rollback: when even the reset fails the user is warned loudly, told the exact stage that fixes it, and the exit is a failure', () => {
  deploy(['sendQuote'], false);
  rollbackList('sendquote=sendquote-00001-abc');
  failWith('sendQuote', 'stuck');
  const r = rollback();
  assert.notEqual(r.code, 0, r.out); assert.match(r.out, /WARNING - STUCK ROUTING: sendquote/); assert.match(r.out, /next deploy of them FAILS/); assert.match(r.out, /deploy-quote-sending\.sh routing fix/);
  assert.match(r.out, /could NOT be put back/);
});

test('rollback: a switch that fails WITHOUT pinning anything does not trigger a reset (only a pin on the version it tried is undone)', () => {
  deploy(['sendQuote'], false);
  rollbackList('sendquote=sendquote-00001-abc');
  failWith('sendQuote', 'failclean');
  const r = rollback(); assert.notEqual(r.code, 0, r.out); assert.match(r.out, /NOT RESTORED: sendquote/);
  assert.ok(!/--to-latest/.test(callsLog()), 'nothing was pinned, so nothing may be changed:\n' + callsLog());
  deploy(['createQuote'], false); rollbackList('createquote=createquote-00001-def'); pinnedTo('createQuote', 'createquote-00007-keep', true); failWith('createQuote', 'failclean');
  const other = rollback(); assert.notEqual(other.code, 0, other.out);
  assert.ok(!/--to-latest/.test(callsLog()), 'a pin on some OTHER version is somebody\'s choice and must be left alone');
});

test('deploy stages refuse while a function is pinned: they name it, change nothing, and point to "routing fix"; the read-only "routing" stage reports the same', () => {
  const funcs = [...NEW_FUNCS, ...QUOTE_FUNCS, 'sendReply', 'sendMedia', 'startConversation', 'claimAccess', 'leadIntake']; deploy(funcs, false); claimCode('new');
  pinnedTo('createCustomer', 'createcustomer-00004-gik');
  const report = deployScript(['routing']);
  assert.notEqual(report.code, 0, report.out); assert.match(report.out, /createCustomer: PINNED - PINNED createcustomer-00004-gik 100%/); assert.match(report.out, /routing fix/);
  assert.match(report.out, /Nothing was changed/); assert.ok(!/createCustomer: ok/.test(report.out));
  for (const f of funcs.filter((x) => x !== 'createCustomer')) assert.ok(!new RegExp(f + ': PINNED').test(report.out), f + ' wrongly reported');
  assert.ok(!/update-traffic/.test(callsLog()), 'the report must not change anything');
  fs.rmSync(path.join(state, 'svc-createcustomer.json'));
  const fine = deployScript(['routing']); assert.equal(fine.code, 0, fine.out); assert.match(fine.out, /routing: ok/);
  // a function that is not deployed yet is fine; one that cannot be read stops the check (it is not guessed)
  fs.rmSync(path.join(state, 'deployed', 'deliverquote')); const fresh = deployScript(['routing']); assert.equal(fresh.code, 0, fresh.out); assert.match(fresh.out, /deliverQuote: not deployed yet/);
  failWith('sendQuote', 'describefail'); const unread = deployScript(['routing']);
  assert.notEqual(unread.code, 0, unread.out); assert.match(unread.out, /sendQuote: could not be checked/); assert.match(unread.out, /could not check the routing of: sendQuote/);
});

test('"routing fix": asks first, then sends only the pinned functions back to their newest version, and checks it worked', () => {
  const funcs = [...NEW_FUNCS, ...QUOTE_FUNCS, 'sendReply', 'sendMedia', 'startConversation', 'claimAccess', 'leadIntake']; deploy(funcs, false); claimCode('new');
  pinnedTo('createCustomer', 'createcustomer-00004-gik'); pinnedTo('sendQuote', 'sendquote-00003-ok', true);
  const no = deployScript(['routing', 'fix'], 'no\n');
  assert.notEqual(no.code, 0, no.out); assert.match(no.out, /createCustomer: PINNED/); assert.match(no.out, /sendQuote: PINNED/); assert.ok(!/update-traffic/.test(callsLog()), 'nothing may change unless the answer is yes');
  const yes = deployScript(['routing', 'fix'], 'yes\n');
  assert.equal(yes.code, 0, yes.out); assert.match(yes.out, /createCustomer: following the newest version/); assert.match(yes.out, /sendQuote: following the newest version/);
  const calls = callsLog().split('\n').filter((l) => /update-traffic/.test(l));
  assert.deepEqual(calls.map((l) => l.match(/update-traffic (\w+)/)[1]).sort(), ['createcustomer', 'sendquote'], 'only the pinned ones are touched:\n' + calls.join('\n'));
  for (const l of calls) { assert.match(l, /--to-latest/); assert.ok(!/--to-revisions/.test(l), l); }
  assert.deepEqual(routingLib.findings(svcJson('createcustomer')), []); assert.equal(deployScript(['routing']).code, 0);
  const nothing = deployScript(['routing', 'fix'], 'yes\n'); assert.equal(nothing.code, 0, nothing.out); assert.match(nothing.out, /Nothing is pinned/);
  pinnedTo('leadIntake', 'leadintake-00002-abc'); failWith('leadIntake', 'stuck');                                   // the reset itself fails: a failure, named
  const stuck = deployScript(['routing', 'fix'], 'yes\n'); assert.notEqual(stuck.code, 0, stuck.out); assert.match(stuck.out, /leadIntake: NOT fixed/); assert.match(stuck.out, /NOT FIXED: leadIntake/);
  const bad = deployScript(['routing', 'nonsense']); assert.notEqual(bad.code, 0); assert.match(bad.out, /routing /);
});

test('every stage that deploys functions runs the routing check BEFORE it asks for confirmation (backend, channels, older, mail on, mail off); the read-only stages and rules do not need it', () => {
  const s = fs.readFileSync(path.join(SCRIPTS, 'deploy-quote-sending.sh'), 'utf8').replace(/\r\n/g, '\n');
  const stage = (name) => { const i = s.indexOf(`\n  ${name})\n`); assert.ok(i >= 0, name + ' stage not found'); return s.slice(i, s.indexOf('\n    ;;', i)); };
  const before = (text, label) => { const a = text.indexOf('check_routing'), b = text.indexOf('confirm "'); assert.ok(a >= 0, label + ': no routing check'); assert.ok(b >= 0 && a < b, label + ': the routing check must come before the question'); };
  before(stage('backend'), 'backend'); assert.match(stage('backend'), /check_routing \$BACKEND_FUNCS/);
  before(stage('channels'), 'channels'); assert.match(stage('channels'), /check_routing \$CHANNEL_FUNCS/);
  before(stage('older'), 'older'); assert.match(stage('older'), /check_routing \$OLDER_FUNCS/);
  const mail = stage('mail'), [on, off] = mail.split('      off)\n'); assert.ok(off, 'mail off not found');
  before(on, 'mail on'); before(off, 'mail off'); assert.match(on, /check_routing \$MAIL_FUNCS/); assert.match(off, /check_routing \$MAIL_FUNCS/);
  assert.ok(!/check_routing/.test(stage('rules')) && !/check_routing/.test(stage('live')), 'stages that deploy no functions do not need it');
  before(stage('projects'), 'projects'); assert.match(stage('projects'), /check_routing \$PROJECT_FUNCS/);
  before(stage('push'), 'push'); assert.match(stage('push'), /check_routing \$PUSH_FUNCS/);
  before(stage('ai'), 'ai'); assert.match(stage('ai'), /check_routing \$AI_FUNCS/);
  const help = s.split('\n').slice(0, 44).join('\n');                       // the usage text is lines 2 to 44 of the script (it was 2 to 39 before the receptionist and staffsend stages were added)
  assert.match(s, /^usage\(\) \{ sed -n '2,44p'/m); assert.match(help, /routing fix/, 'the help text must show the new stages (the usage range must cover them)');
  assert.match(help, /deploy-quote-sending\.sh projects/, 'the help text must show the projects stage');
  assert.match(help, /deploy-quote-sending\.sh push /, 'the help text must show the push stage');
  assert.match(help, /deploy-quote-sending\.sh ai /, 'the help text must show the ai stage');
  assert.match(help, /deploy-quote-sending\.sh receptionist /, 'the help text must show the receptionist stage'); assert.match(help, /deploy-quote-sending\.sh staffsend /, 'the help text must show the staffsend stage');
  before(stage('staffsend'), 'staffsend'); assert.match(stage('staffsend'), /check_routing \$STAFFSEND_FUNCS/);
});

// ============================ Phase 8: the "push" stage deploys exactly the right functions (the live webhook among them), and the screen waits for them ======================
test('Phase 8: the push stage names exactly the four new functions and the two changed ones, every one is a real function, the webhook change needs an explicit "yes", and the screen waits', () => {
  const s = fs.readFileSync(path.join(SCRIPTS, 'deploy-quote-sending.sh'), 'utf8').replace(/\r\n/g, '\n');
  const list = (name) => { const m = new RegExp('^' + name + '="([^"]*)"', 'm').exec(s); assert.ok(m, name + ' not found'); return m[1].trim().split(/\s+/); };
  const fresh = list('PUSH_NEW'), changed = list('PUSH_CHANGED');
  assert.deepEqual([...fresh].sort(), ['pushReceipt', 'registerPushDevice', 'sendTestPush', 'unregisterPushDevice']); assert.deepEqual([...changed].sort(), ['leadIntake', 'webhook']);
  const idx = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
  for (const f of fresh.filter((x) => x !== 'pushReceipt')) assert.match(idx, new RegExp('^exports\\.' + f + '\\s*=\\s*onCall\\b', 'm'), f + ' is not a callable function in functions/index.js');
  for (const f of ['pushReceipt', 'webhook', 'leadIntake']) assert.match(idx, new RegExp('^exports\\.' + f + '\\s*=\\s*onRequest\\b', 'm'), f + ' is not an HTTP function in functions/index.js');
  assert.match(s, /^PUSH_FUNCS="\$PUSH_NEW \$PUSH_CHANGED"/m);
  const i = s.indexOf('\n  push)\n'); assert.ok(i >= 0); const stage = s.slice(i, s.indexOf('\n    ;;', i));
  assert.match(stage, /deploy_functions \$PUSH_FUNCS/); assert.match(stage, /for f in \$PUSH_NEW; do[\s\S]*add-iam-policy-binding[\s\S]*done/, 'only the NEW functions are made public');
  assert.match(stage, /confirm "[^"]*WhatsApp webhook[^"]*"/, 'the question names the live webhook'); assert.ok(stage.indexOf('check_settings') < stage.indexOf('confirm "') && stage.indexOf('confirm "') < stage.indexOf('deploy_functions'));
  assert.match(stage, /check_reachable "[^"]*webhook[^"]*leadIntake[^"]*"|check_reachable "[^"]*leadIntake[^"]*webhook[^"]*"/); assert.match(stage, /pushReceipt answered \$code instead of 400/);
  const j = s.indexOf('\n  live)\n'), live = s.slice(j, s.indexOf('\n    ;;', j));
  assert.match(live, /serving_revision pushreceipt[\s\S]*Deploy the push notifications backend first/); assert.ok(live.indexOf('pushreceipt') < live.indexOf('confirm "'));
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8')); assert.deepEqual(cfg.hosting.rewrites.find((r) => r.source === '/pushReceipt').function, { functionId: 'pushReceipt', region: 'europe-west1' });
});

// ============================ Phase 7: the "projects" stage deploys exactly the right functions, and the screen cannot go live before them ======================
test('Phase 7: the projects stage names exactly the seven new project functions and the three changed ones, every one is a real function, and the screen waits for them', () => {
  const s = fs.readFileSync(path.join(SCRIPTS, 'deploy-quote-sending.sh'), 'utf8').replace(/\r\n/g, '\n');
  const list = (name) => { const m = new RegExp('^' + name + '="([^"]*)"', 'm').exec(s); assert.ok(m, name + ' not found'); return m[1].trim().split(/\s+/); };
  const fresh = list('PROJECT_NEW'), changed = list('PROJECT_CHANGED');
  assert.deepEqual([...fresh].sort(), ['attachProjectRender', 'completeProject', 'createProject', 'projectRenderUrl', 'removeProject', 'saveProject', 'setProjectStep']);
  assert.deepEqual([...changed].sort(), ['acceptQuote', 'deleteCustomer', 'reopenQuote']);
  const idx = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
  for (const f of [...fresh, ...changed]) assert.match(idx, new RegExp('^exports\\.' + f + '\\s*=\\s*onCall\\b', 'm'), f + ' is not a callable function in functions/index.js (a typo would deploy nothing)');
  assert.match(s, /^PROJECT_FUNCS="\$PROJECT_NEW \$PROJECT_CHANGED"/m);
  const i = s.indexOf('\n  projects)\n'); assert.ok(i >= 0); const stage = s.slice(i, s.indexOf('\n    ;;', i));
  assert.match(stage, /deploy_functions \$PROJECT_FUNCS/); assert.match(stage, /for f in \$PROJECT_NEW; do[\s\S]*add-iam-policy-binding[\s\S]*done/, 'only the NEW functions are made public');
  assert.match(stage, /check_reachable "\$PROJECT_FUNCS"/); assert.ok(stage.indexOf('check_settings') < stage.indexOf('confirm "') && stage.indexOf('confirm "') < stage.indexOf('deploy_functions'), 'checks, then the question, then the deploy');
  const j = s.indexOf('\n  live)\n'), live = s.slice(j, s.indexOf('\n    ;;', j));
  assert.match(live, /serving_revision createproject[\s\S]*Deploy the Projects backend first/); assert.ok(live.indexOf('createproject') < live.indexOf('confirm "'), 'the screen cannot be published before the Projects backend');
});

// ============================ Phase 9: the "ai" stage deploys exactly the three new functions, needs the key first, and the screen waits for them ======================
test('Phase 9: the ai stage names exactly the three new callables (each bound to the Anthropic secret), checks the key before asking, touches no existing function, and the screen waits for them', () => {
  const s = fs.readFileSync(path.join(SCRIPTS, 'deploy-quote-sending.sh'), 'utf8').replace(/\r\n/g, '\n');
  const m = /^AI_NEW="([^"]*)"/m.exec(s); assert.ok(m); const fresh = m[1].trim().split(/\s+/);
  assert.deepEqual([...fresh].sort(), ['aiChat', 'aiCheckModels', 'aiDecide', 'aiDismissConsult', 'aiDraftOutcome', 'aiKnowledge', 'aiKnowledgeTest', 'aiStatus', 'aiSuggestReply', 'setAiSettings', 'setReceptionist']);
  assert.match(s, /^AI_FUNCS="\$AI_NEW"/m);
  const idx = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
  assert.match(idx, /^exports\.aiDecide\s*=\s*onCall\(\{\}/m, 'aiDecide applies approved changes and needs no model key');
  assert.match(idx, /^exports\.aiDraftOutcome\s*=\s*onCall\(\{\}/m, 'aiDraftOutcome only records an outcome and needs no model key');
  assert.match(idx, /^exports\.aiDismissConsult\s*=\s*onCall\(\{\}/m, 'aiDismissConsult only clears a waiting flag and needs no model key');
  for (const f of fresh.filter((x) => !['aiDecide', 'aiDraftOutcome', 'aiDismissConsult', 'setReceptionist', 'aiKnowledge'].includes(x))) assert.match(idx, new RegExp('^exports\\.' + f + '\\s*=\\s*onCall\\(\\{ secrets: \\[ANTHROPIC_API_KEY\\]', 'm'), f + ' is not a callable bound to the Anthropic secret in functions/index.js');
  const i = s.indexOf('\n  ai)\n'); assert.ok(i >= 0); const stage = s.slice(i, s.indexOf('\n    ;;', i));
  assert.match(stage, /deploy_functions \$AI_FUNCS/); assert.match(stage, /for f in \$AI_NEW; do[\s\S]*add-iam-policy-binding[\s\S]*done/); assert.match(stage, /check_reachable "\$AI_FUNCS"/);
  assert.ok(stage.indexOf('ANTHROPIC_API_KEY is not set yet') < stage.indexOf('confirm "') && stage.indexOf('check_routing') < stage.indexOf('confirm "') && stage.indexOf('confirm "') < stage.indexOf('deploy_functions'), 'key and checks first, then the question, then the deploy');
  assert.equal(/functions:secrets:set[^\n]*\$\(|ANTHROPIC_API_KEY=/.test(stage), false, 'the script never handles the key itself');
  assert.match(stage, /read -r -p "Owner account/); assert.match(stage, /ALLOWED_EMAILS/); assert.ok(stage.indexOf('Owner account') < stage.indexOf('confirm "'), 'the owner is asked before the question');
  assert.ok(stage.indexOf('confirm "') < stage.indexOf('setting "$ENVF" AI_OWNER_EMAILS') && stage.indexOf('setting "$ENVF" AI_OWNER_EMAILS') < stage.indexOf('deploy_functions'), 'nothing is written before the yes');
  const j = s.indexOf('\n  live)\n'), live = s.slice(j, s.indexOf('\n    ;;', j));
  assert.match(live, /serving_revision aichat[\s\S]*Deploy the AI assistant backend first/); assert.ok(live.indexOf('aichat') < live.indexOf('confirm "'));
});

test('Phase 9 R3: the receptionist stage deploys only the message-arrival trigger, the 5-minute backup and pushReceipt, needs the AI backend first, asks before deploying, never makes the check public, and the screen waits for it', () => {
  const s = fs.readFileSync(path.join(SCRIPTS, 'deploy-quote-sending.sh'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(s, /^REC_FUNCS="receptionistSweep receptionistOnMessage pushReceipt"/m);
  const idx = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
  assert.match(idx, /^exports\.receptionistSweep\s*=\s*onSchedule\(/m, 'the check is a scheduled job, not a callable'); assert.match(idx, /^exports\.setReceptionist\s*=\s*onCall\(\{\}/m);
  const i = s.indexOf('\n  receptionist)\n'); assert.ok(i >= 0); const stage = s.slice(i, s.indexOf('\n    ;;', i));
  assert.match(stage, /serving_revision setreceptionist[\s\S]*Deploy the AI backend first/); assert.match(stage, /deploy_functions \$REC_FUNCS/);
  assert.match(stage, /gcloud firestore databases describe[\s\S]*"\$DB_LOC" != "\$REGION"[\s\S]*exit 1/); assert.ok(stage.indexOf('databases describe') < stage.indexOf('confirm "'), 'the database region is checked before asking');
  assert.equal(/add-iam-policy-binding/.test(stage), false, 'a scheduled job is never opened to the public'); assert.ok(stage.indexOf('serving_revision') < stage.indexOf('confirm "') && stage.indexOf('confirm "') < stage.indexOf('deploy_functions'), 'checks first, then the question, then the deploy');
  const j = s.indexOf('\n  live)\n'), live = s.slice(j, s.indexOf('\n    ;;', j)); assert.match(live, /serving_revision receptionistsweep[\s\S]*Deploy the receptionist backend first/); assert.ok(live.indexOf('receptionistsweep') < live.indexOf('confirm "'));
  assert.match(idx, /receptionistSweep[\s\S]{0,200}secrets: \[\.\.\.SECRETS, ANTHROPIC_API_KEY\]/, 'it holds the WhatsApp and Anthropic secrets');
});

test('the "mail off" stage stops on a pinned function before it asks anything, and asks as usual when nothing is pinned', () => {
  const funcs = [...NEW_FUNCS, ...QUOTE_FUNCS, 'sendReply', 'sendMedia', 'startConversation', 'claimAccess', 'leadIntake']; deploy(funcs, false); claimCode('new');
  const repo = path.join(tmp, 'repo-mail'); fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(repo, 'functions'));
  for (const f of ['deploy-quote-sending.sh', 'access-compat.sh', 'access-traffic.js', 'lib-run-iam.sh', 'lib-routing.sh', 'routing-check.js']) fs.copyFileSync(path.join(SCRIPTS, f), path.join(repo, 'scripts', f));
  const envFile = path.join(repo, 'functions', '.env.elite-kitchens-lead-os'); fs.writeFileSync(envFile, 'MAIL_SEND=on\n');
  const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' });
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'x');
  const mailOff = (input) => run(path.join(repo, 'scripts', 'deploy-quote-sending.sh'), ['mail', 'off'], {}, input);
  pinnedTo('quoteChannels', 'quotechannels-00002-bad');
  const pinned = mailOff('yes\n');
  assert.notEqual(pinned.code, 0, pinned.out); assert.match(pinned.out, /Refusing to deploy: the traffic of these functions is pinned.*: quoteChannels/);
  assert.ok(!/Type yes/.test(pinned.out) && !/Cancelled/.test(pinned.out), 'it must stop BEFORE asking:\n' + pinned.out);
  assert.equal(fs.readFileSync(envFile, 'utf8'), 'MAIL_SEND=on\n', 'the settings file must not be changed');
  fs.rmSync(path.join(state, 'svc-quotechannels.json'));
  const fine = mailOff('no\n');
  assert.notEqual(fine.code, 0, fine.out); assert.match(fine.out, /routing: ok/); assert.match(fine.out, /Cancelled\. Nothing was deployed/);
  assert.equal(fs.readFileSync(envFile, 'utf8'), 'MAIL_SEND=on\n');
});
