#!/usr/bin/env bash
# Phase 6.1 (direct quote sending: WhatsApp and email, and "Reopen conversation") deploy helper. Run from Cloud Shell, one stage
# at a time, in the order of docs/PHASE6_1_PLAN.md "Rollout". Nothing here runs until the owner says so.
#   ./scripts/deploy-quote-sending.sh check      read-only: the settings file against what the live functions run with, the functions'
#                                                own access, the one-time email setup, and what "backend" would deploy. Changes nothing.
#   ./scripts/deploy-quote-sending.sh backend    the 7 new functions, and the 14 quote functions (they share the quote code that now
#                                                locks a draft while a send is prepared). Email stays as it is (the settings file decides). The live screen is unaffected.
#   ./scripts/deploy-quote-sending.sh channels   M7 only: redeploy the 3 functions that send (deliverQuote, retryQuoteDelivery, quoteChannels) so a
#                                                closed-window quote goes in the approved quotation template. Email stays as it is.
#   ./scripts/deploy-quote-sending.sh older      the audit fixes in the five OLDER functions (sendReply, sendMedia, startConversation, claimAccess, leadIntake): one request =
#                                                one message, a Meta 5xx is never retried by itself, and staff access that expires and is renewed.
#                                                Run it BEFORE "rules". It saves the revisions it replaces.
#   ./scripts/deploy-quote-sending.sh rules      the Firestore and Storage SECURITY RULES that refuse an expired staff claim (audit finding 5). LAST, and
#                                                only after "older" and the new screen are live (docs/PHASE6_1_PLAN.md, "Audit"): a session that has not
#                                                renewed its access loses it until the page is reloaded. Refused unless ./scripts/access-compat.sh proves it is safe.
#   ./scripts/deploy-quote-sending.sh rules-back  put the PREVIOUS security rules (before the audit fixes) back. Do this FIRST when going back to older functions.
#   ./scripts/deploy-quote-sending.sh back backend|older   redeploy those functions from the code BEFORE the audit fixes (commit 6baa6ca): the dependable way back.
#                                                Refused when it would lock staff out (new rules + an older claimAccess): run "rules-back" first.
#   ./scripts/deploy-quote-sending.sh preview    the new screen on Hosting PREVIEW channel phase61 (live data; production untouched)
#   ./scripts/deploy-quote-sending.sh mail on    switch email sending ON (writes MAIL_SEND=on, the sender and the mailer service account
#                                                to the settings file) and redeploy the 3 functions that read it. Needs setup-mailer.sh
#                                                and the Workspace approval first.
#   ./scripts/deploy-quote-sending.sh mail off   the kill switch: email sending off again.
#   ./scripts/deploy-quote-sending.sh live       the new screen on production Hosting. ONLY after the owner approved the preview.
#   ./scripts/deploy-quote-sending.sh routing    read-only: is any function's traffic PINNED to one old version (a failed restore does that)? Every stage that deploys
#                                                functions runs this check first and refuses while one is pinned (2026-10-11: it made 21 deploys fail).
#   ./scripts/deploy-quote-sending.sh routing fix   send the traffic of the pinned functions back to their newest version (routing only; no code changes).
#   ./scripts/deploy-quote-sending.sh push       Phase 8 (push notifications) backend: the 4 new functions, and the WEBHOOK and leadIntake (they now notify staff). Run it BEFORE "live".
#                                                Needs the one-time Firebase web app first (docs/PUSH.md). This one DOES redeploy the live WhatsApp webhook: ask the owner first.
#   ./scripts/deploy-quote-sending.sh projects   Phase 7 (Projects) backend: acceptQuote and reopenQuote (they now keep the quote's project), deleteCustomer (it now also erases
#                                                projects and renders) and the 7 new project functions. Run it BEFORE "live" (the screen); screens that do not know projects keep working.
#   ./scripts/deploy-quote-sending.sh ai         Phase 9 (AI assistant) backend: the assistant functions (aiChat, aiStatus, setAiSettings, aiCheckModels, aiDecide, aiSuggestReply, aiDraftOutcome, aiDismissConsult). Needs the ANTHROPIC_API_KEY secret first; asks for the owner account (the only one that may switch real customer data on). Switched OFF until the owner
#                                                switches it on in the screen. Run it BEFORE "live". No existing function is touched.
#   ./scripts/deploy-quote-sending.sh receptionist  Phase 9 R3: the automatic receptionist's every-minute check (receptionistSweep) and pushReceipt. Run it after "ai" and BEFORE "live". It does nothing until the owner switches
#                                                it on in Assistant > Settings AND for a chat. Switch it off there at any time.
# Every functions deploy first saves the revisions it replaces. ./scripts/rollback-quote-sending.sh can put them back only for about a day (Google then
# deletes old versions' files): the dependable undo is redeploying the previous code, see docs/PHASE6_1_PLAN.md "Rollback". The very
# first "backend" run also keeps the ORIGINAL revisions (before Phase 6.1) in ~/.previous-revisions-phase61.original and never overwrites
# them. A deploy that Google throttles is retried by itself (up to 3 times).
# Never deploys the webhook (except in the explicit "push" stage), calendarSweep or any function not named above; changes security rules ONLY in the explicit "rules" stage; never
# changes indexes, secrets, DNS, the Google Calendar settings, Make or Meta. Do NOT use scripts/deploy-preview.sh: it deploys every function and makes them public.
set -euo pipefail
PROJECT=elite-kitchens-lead-os
REGION=europe-west1
BUCKET="$PROJECT.firebasestorage.app"
RUNTIME_SA="812360112616-compute@developer.gserviceaccount.com"
MAIL_SA="ek-mailer@$PROJECT.iam.gserviceaccount.com"
MAIL_SENDER_DEFAULT="info@elitekitchens.ie"
ENVF="functions/.env.$PROJECT"
SAVED="$HOME/.previous-revisions-phase61"               # the last Phase 6.1 functions deploy (rollback-quote-sending.sh)
ORIGINALS="$HOME/.previous-revisions-phase61.original"   # the revisions from BEFORE Phase 6.1: written once, never overwritten (rollback-quote-sending.sh --originals)
# The same lists are in rollback-quote-sending.sh.
NEW_FUNCS="reopenConversation deliverQuote retryQuoteDelivery resolveQuoteDelivery cancelQuoteSend markQuoteSent quoteChannels"
QUOTE_FUNCS="createCustomer saveQuoteSettings setQuoteNumbering createQuote saveQuoteDraft sendQuote acceptQuote declineQuote reopenQuote reviseQuote discardQuoteDraft deleteQuoteDraft setQuoteNotes quotePdfUrl"
MAIL_FUNCS="deliverQuote retryQuoteDelivery quoteChannels"          # the functions that read the MAIL_* settings
CHANNEL_FUNCS="deliverQuote retryQuoteDelivery quoteChannels"       # the functions that send (M7: they read the quotation template settings too)
OLDER_FUNCS="sendReply sendMedia startConversation claimAccess leadIntake"           # older functions that the audit fixes touch (findings 5 and 6, second audit 6); all are public already
PRE_AUDIT="${PRE_AUDIT:-6baa6ca}"                                                  # the last commit before the audit fixes: the code "back" redeploys (docs/PHASE6_1_PLAN.md, "Rollback")
BACKEND_FUNCS="$NEW_FUNCS $QUOTE_FUNCS"
PROJECT_NEW="createProject saveProject setProjectStep completeProject removeProject attachProjectRender projectRenderUrl"   # Phase 7: new, made public like the quote ones
PROJECT_CHANGED="acceptQuote reopenQuote deleteCustomer"                                                                   # Phase 7: existing functions whose code changed
PROJECT_FUNCS="$PROJECT_NEW $PROJECT_CHANGED"
PUSH_NEW="registerPushDevice unregisterPushDevice sendTestPush pushReceipt"                                                  # Phase 8: new; pushReceipt is reached through a Hosting rewrite
PUSH_CHANGED="webhook leadIntake"                                                                                           # Phase 8: they now send a push (never allowed to break or hold up the message / lead)
PUSH_FUNCS="$PUSH_NEW $PUSH_CHANGED"
AI_NEW="aiChat aiStatus setAiSettings aiCheckModels aiDecide aiSuggestReply aiDraftOutcome aiDismissConsult setReceptionist"                                                                                      # Phase 9: new, staff-only (each checks the signed-in account); no existing function changes
AI_FUNCS="$AI_NEW"
REC_FUNCS="receptionistSweep pushReceipt"                                                      # Phase 9 R3: the every-minute receptionist check (not callable from outside) and pushReceipt (it now knows the "handover" notification)
# Settings shared with the functions that are already live: they must match what those run with, or a deploy would change them.
SHARED_SETTINGS="ALLOWED_EMAILS WHATSAPP_PHONE_NUMBER_ID WHATSAPP_API_VERSION GCAL_SYNC GCAL_CALENDAR_ID GCAL_SERVICE_ACCOUNT"
default_of() { case "$1" in WHATSAPP_API_VERSION) echo v21.0 ;; GCAL_SYNC) echo off ;; *) echo "" ;; esac; }
cd "$(dirname "$0")/.."
. ./scripts/lib-routing.sh

usage() { sed -n '2,41p' "$0" | sed 's/^# *//'; exit 1; }
svc() { echo "$1" | tr '[:upper:]' '[:lower:]'; }
has() { grep -qE "^$2=" "$1"; }
value() { { grep -E "^$2=" "$1" || true; } | tail -n 1 | cut -d= -f2- | tr -d '\r'; }
setting() { local f="$1" k="$2" v="$3"; if has "$f" "$k"; then sed -i "s|^$k=.*|$k=$v|" "$f"; else printf '%s=%s\n' "$k" "$v" >> "$f"; fi; }
confirm() { read -r -p "$1 Type yes: " a; [ "$a" = "yes" ] || { echo "Cancelled. Nothing was deployed."; exit 1; }; }
install() { npm --prefix functions install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm --prefix functions install --omit=dev; }
# Google sometimes throttles a burst of function updates ("Failed to update function"): the deploy is repeated, and Firebase skips what is
# already up to date, so a repeat only does what is left.
deploy_functions() {
  local only="" f try
  for f in "$@"; do only="${only:+$only,}functions:$f"; done
  for try in 1 2 3; do
    if firebase deploy --project "$PROJECT" --only "$only"; then return 0; fi
    [ "$try" = 3 ] && break
    echo "   The deploy did not finish (try $try of 3). Waiting 60 s, then repeating what is left..."; sleep 60
  done
  echo "The deploy did not finish after 3 tries. Nothing is lost: what already deployed stays deployed. Wait a few minutes and run the same command again."; return 1
}
serving_revision() {
  { gcloud run services describe "$1" --region "$REGION" --project "$PROJECT" --format=json 2>/dev/null || true; } | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      if (!s.trim()) return;
      const t = ((JSON.parse(s).status || {}).traffic || []).filter((x) => x.revisionName).sort((a, b) => (b.percent || 0) - (a.percent || 0));
      if (t[0]) console.log(t[0].revisionName);
    });'
}
save_revisions() {
  # Never lose an earlier undo list: a stage that is repeated (or another stage) would otherwise overwrite the only way back with whatever is live at that moment.
  if [ -s "$SAVED" ]; then cp -p "$SAVED" "$SAVED.$(date +%Y%m%d-%H%M%S)"; echo "   (the previous undo list is kept as $SAVED.<date and time>)"; fi
  : > "$SAVED"
  for f in "$@"; do
    local rev; rev=$(serving_revision "$(svc "$f")")
    if [ -n "$rev" ]; then echo "$(svc "$f")=$rev" >> "$SAVED"; echo "   saved $f -> $rev"; else echo "   $f: not deployed yet (nothing to save)"; fi
  done
}
no_test_folders() { [ ! -d public/theme-lab ] || { echo "Refusing: the temporary test folder public/theme-lab is there. Remove it first."; exit 1; }; }
env_of() {
  KEY="$2" node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const c = ((r.spec || {}).containers || [])[0] || {};
    const e = (c.env || []).find((x) => x.name === process.env.KEY);
    console.log(e ? (e.value == null ? "" : e.value) : "<unset>");' "$1"
}
check_settings() {
  [ -f "$ENVF" ] || { echo "Missing $ENVF (the settings file from earlier phases). Stop here."; exit 1; }
  local rev live bad="" k f l
  rev=$(serving_revision deletecustomer)
  [ -n "$rev" ] || { echo "deleteCustomer is not deployed. Phase 6.1 goes on top of Phase 6: stop here."; exit 1; }
  live=$(mktemp)
  gcloud run revisions describe "$rev" --region "$REGION" --project "$PROJECT" --format=json > "$live"
  echo "==> the settings file compared with what the live functions run with (deleteCustomer, $rev)"
  for k in $SHARED_SETTINGS; do
    if has "$ENVF" "$k"; then f=$(value "$ENVF" "$k"); else f=$(default_of "$k"); fi
    l=$(env_of "$live" "$k"); [ "$l" = "<unset>" ] && l=$(default_of "$k")
    if [ "$f" = "$l" ]; then echo "   $k: same"; else echo "   $k: DIFFERENT"; bad="$bad $k"; fi
  done
  rm -f "$live"
  if [ -n "$bad" ]; then
    echo "Refusing to deploy: $ENVF does not match the live functions for:$bad. Nothing was changed. Stop here and report which setting differs."
    exit 1
  fi
  local ms rt rl qt ql; ms=$(value "$ENVF" MAIL_SEND); rt=$(value "$ENVF" WHATSAPP_REOPEN_TEMPLATE_NAME); rl=$(value "$ENVF" WHATSAPP_REOPEN_TEMPLATE_LANG)
  qt=$(value "$ENVF" WHATSAPP_QUOTE_TEMPLATE_NAME); ql=$(value "$ENVF" WHATSAPP_QUOTE_TEMPLATE_LANG)
  echo "   email: MAIL_SEND=${ms:-(not set: off)}  (the deploy keeps it as it is; \"mail on\" switches it)"
  echo "   Reopen template: ${rt:-elite_kitchens_reopen (default)} / ${rl:-en (default)}"
  echo "   Quotation template (closed-window quotes): ${qt:-elite_kitchens_quote_document (default)} / ${ql:-en (default)}"
}
has_binding() {
  node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const p = s.trim() ? JSON.parse(s) : {};
      process.exit((p.bindings || []).some((b) => b.role === process.argv[1] && (b.members || []).includes(process.argv[2])) ? 0 : 1);
    });' "$1" "$2"
}
check_access() {
  echo "==> checking the functions' own access (the same as Phase 6)"
  local ok=1
  if gcloud storage buckets get-iam-policy "gs://$BUCKET" --project "$PROJECT" --format=json | has_binding roles/storage.objectAdmin "serviceAccount:$RUNTIME_SA"; then echo "   storage: ok"; else echo "   WARNING: roles/storage.objectAdmin on gs://$BUCKET is missing"; ok=0; fi
  if gcloud iam service-accounts get-iam-policy "$RUNTIME_SA" --project "$PROJECT" --format=json | has_binding roles/iam.serviceAccountTokenCreator "serviceAccount:$RUNTIME_SA"; then echo "   PDF links: ok"; else echo "   WARNING: roles/iam.serviceAccountTokenCreator is missing"; ok=0; fi
  [ "$ok" = 1 ] || { echo "Stop here and report the warning."; exit 1; }
}
check_reachable() {
  echo "==> checking that each function answers, and refuses a request without sign-in"
  local f code pending="$1" next
  for _ in 1 2 3 4 5 6 7 8 9; do
    next=""
    for f in $pending; do
      code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"data":{}}' "https://$REGION-$PROJECT.cloudfunctions.net/$f" || echo 000)
      if [ "$code" = 401 ]; then echo "   $f: ok"; else next="$next $f"; fi
    done
    pending="$next"; [ -z "$pending" ] && return
    sleep 10
  done
  echo "   WARNING: not answering as expected after 90 s:$pending"
  echo "   Stop here and report it. The live screen is unaffected. To go back see docs/PHASE6_1_PLAN.md, \"Rollback\"."
  exit 1
}
# check_routing FUNCTION...: refuse to deploy while a function's traffic is pinned to one old version (a deploy then fails, or succeeds without ever being served).
# Read-only. A function that is not deployed yet is fine; one that cannot be read stops the stage (the check is not guessed).
check_routing() {
  echo "==> checking that each function's traffic follows its newest version (a failed restore can leave it pinned)"
  local f out rc pinned="" unread=""
  for f in "$@"; do
    rc=0; out=$(routing_check "$(svc "$f")") || rc=$?
    case "$rc" in
      0) [ -z "$out" ] || echo "   $f: ok ($(echo "$out" | head -n 1))" ;;
      2) echo "   $f: not deployed yet" ;;
      1) echo "   $f: PINNED - $(echo "$out" | grep '^PINNED' | head -n 1)"; pinned="$pinned $f" ;;
      *) echo "   $f: could not be checked - $out"; unread="$unread $f" ;;
    esac
  done
  [ -z "$pinned$unread" ] || {
    [ -z "$pinned" ] || { echo "Refusing to deploy: the traffic of these functions is pinned to one old version, so a new version would not be served (or the deploy would fail with \"is not ready\"):$pinned"
      echo "Nothing was changed. Fix it first: $0 routing fix   (it only sends the traffic back to the newest version), then run this stage again."; }
    [ -z "$unread" ] || echo "Refusing to deploy: could not check the routing of:$unread. Nothing was changed. Run this stage again; if it repeats, report the message above."
    exit 1
  }
  echo "   routing: ok"
}
show_deployed() {
  echo "==> what is deployed now"
  local f rev
  for f in $BACKEND_FUNCS; do rev=$(serving_revision "$(svc "$f")"); echo "   $f: ${rev:-not deployed}"; done
}

echo "Deploying from $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)"
git diff --quiet HEAD -- functions public firebase.json ':!functions/package-lock.json' || echo "WARNING: this checkout has local changes in functions/, public/ or firebase.json."

case "${1:-}" in
  check)
    check_settings; check_access; show_deployed
    echo "==> the one-time email setup"; ./scripts/setup-mailer.sh --check || echo "   (not finished: needed before \"mail on\", not before \"backend\")"
    echo "\"backend\" would deploy: $BACKEND_FUNCS"
    echo "Nothing was changed."
    ;;
  backend)
    check_settings; check_access; check_routing $BACKEND_FUNCS
    echo "Functions: $BACKEND_FUNCS"
    confirm "Deploy the Phase 6.1 backend to the LIVE project? Email stays as it is (see the MAIL_SEND line above)."
    install
    echo "==> saving the revisions this replaces"
    save_revisions $BACKEND_FUNCS
    if [ -s "$ORIGINALS" ]; then echo "   (keeping $ORIGINALS: the revisions from before Phase 6.1 are never overwritten)"; else cp "$SAVED" "$ORIGINALS"; echo "   (kept a copy of these as the originals: $ORIGINALS)"; fi
    deploy_functions $BACKEND_FUNCS
    echo "==> making the 7 new functions reachable (each checks the signed-in staff account itself)"
    for f in $NEW_FUNCS; do
      gcloud run services add-iam-policy-binding "$(svc "$f")" --region "$REGION" --project "$PROJECT" --member=allUsers --role=roles/run.invoker --quiet >/dev/null && echo "   public: $f"
    done
    check_reachable "$NEW_FUNCS $QUOTE_FUNCS"
    echo "Done. The live screen is unchanged (it does not call the new functions). To go back: redeploy the previous code (docs/PHASE6_1_PLAN.md, \"Rollback\"); ./scripts/rollback-quote-sending.sh works only for about a day."
    ;;
  channels)
    check_settings; check_access; check_routing $CHANNEL_FUNCS
    echo "Functions: $CHANNEL_FUNCS"
    confirm "Redeploy the 3 sending functions to the LIVE project (M7: closed-window quotes go in the approved quotation template)? Email stays as it is."
    install
    echo "==> saving the revisions this replaces"
    save_revisions $CHANNEL_FUNCS
    deploy_functions $CHANNEL_FUNCS
    check_reachable "$CHANNEL_FUNCS"
    echo "Done. The live screen is unchanged. To go back: redeploy the previous code (docs/PHASE6_1_PLAN.md, \"Rollback\"); ./scripts/rollback-quote-sending.sh works only for about a day."
    ;;
  older)
    check_settings; check_access; check_routing $OLDER_FUNCS
    echo "Functions: $OLDER_FUNCS"
    echo "These are LIVE functions from earlier phases: staff replies and files, starting a conversation, the staff sign-in check, and the Meta lead form intake."
    bash ./scripts/access-compat.sh allow-code || exit 1                                  # never deploy a claimAccess that the live security rules would refuse (second audit, finding 7)
    confirm "Redeploy these 5 older functions to the LIVE project?"
    install
    echo "==> saving the revisions this replaces"
    save_revisions $OLDER_FUNCS
    deploy_functions $OLDER_FUNCS
    check_reachable "$OLDER_FUNCS"
    echo "==> checking that the claimAccess now SERVING gives staff access an expiry (it is asked, not assumed: a deployment date proves nothing)"
    ok=0; for _ in 1 2 3 4 5 6; do if bash ./scripts/access-compat.sh claim-after-deploy >/dev/null 2>&1; then ok=1; break; fi; sleep 10; done
    [ "$ok" = 1 ] || { bash ./scripts/access-compat.sh claim-after-deploy; exit 1; }
    echo "   claimAccess: the new code is serving (ok)"
    echo "Done. Staff access now carries an expiry and is renewed by the new screen. Do NOT run \"rules\" until the new screen (Phase 6.1) is live and you have reloaded Elite OS once."
    echo "To go back: redeploy the previous code (docs/PHASE6_1_PLAN.md, \"Rollback\"); ./scripts/rollback-quote-sending.sh works only for about a day."
    ;;
  rules)
    [ -n "$(serving_revision claimaccess)" ] || { echo "Deploy the functions first: $0 older"; exit 1; }
    bash ./scripts/access-compat.sh allow-rules || exit 1                                 # this checkout and the LIVE claimAccess must both give the expiry (second audit, finding 7)
    echo "This publishes security rules that REFUSE a staff sign-in whose claim has expired or has no expiry (audit finding 5)."
    echo "Before you do: (1) './scripts/deploy-quote-sending.sh older' must be done; (2) the Phase 6.1 screen must be live (it renews access every 30 minutes;"
    echo "the old screen does not, so it would lose access after about 12 hours); (3) reload Elite OS once so your session carries the new kind of claim."
    echo "If you are locked out afterwards: reload the page (it asks for a new claim). To go back: $0 rules-back (docs/PHASE6_1_PLAN.md, \"Rollback\")."
    confirm "Publish the new security rules to the LIVE project?"
    firebase deploy --project "$PROJECT" --only firestore:rules,storage
    echo "Done. Reload Elite OS to confirm you can still read your conversations."
    ;;
  rules-back)
    git cat-file -e "$PRE_AUDIT^{commit}" 2>/dev/null || { echo "Cannot find the commit $PRE_AUDIT (the code before the audit fixes). Run: git fetch"; exit 1; }
    [ -z "$(git status --porcelain -- firestore.rules storage.rules)" ] || { echo "Refusing: firestore.rules or storage.rules have local changes. Discard them first: git checkout -- firestore.rules storage.rules"; exit 1; }
    echo "This publishes the PREVIOUS security rules (from $PRE_AUDIT, before the audit fixes): staff access no longer has to expire. It cannot lock staff out."
    confirm "Publish the previous security rules to the LIVE project?"
    trap 'git checkout HEAD -- firestore.rules storage.rules >/dev/null 2>&1 || true' EXIT          # your checkout goes back to the audit-fix rules, whatever happens
    git checkout "$PRE_AUDIT" -- firestore.rules storage.rules
    firebase deploy --project "$PROJECT" --only firestore:rules,storage
    echo "Done. The previous rules are live. Reload Elite OS. You can now put older functions back if you need to: $0 back older"
    ;;
  back)
    what="${2:-}"
    case "$what" in backend|older) ;; *) echo "Usage: $0 back backend|older   (redeploy those functions from the code before the audit fixes)"; exit 1 ;; esac
    git cat-file -e "$PRE_AUDIT^{commit}" 2>/dev/null || { echo "Cannot find the commit $PRE_AUDIT (the code before the audit fixes). Run: git fetch"; exit 1; }
    [ -z "$(git status --porcelain -- functions)" ] || { echo "Refusing: there are local changes in functions/. Discard them first: git checkout -- functions"; exit 1; }
    echo "Going back: the stage \"$what\" is redeployed from the code of $PRE_AUDIT (before the audit fixes). It asks you to confirm, like any stage."
    trap 'git checkout HEAD -- functions >/dev/null 2>&1 || true' EXIT                            # your checkout goes back to the audit-fix code, whatever happens
    git checkout "$PRE_AUDIT" -- functions
    "$0" "$what"                                                                                  # the same stage, with the same checks (and the staff-access check sees the OLD code)
    ;;
  projects)
    [ -f functions/lib/projects.js ] || { echo "This checkout has no Phase 7 (Projects) code. Update it first: git checkout main && git pull --ff-only"; exit 1; }
    check_settings; check_access; check_routing $PROJECT_FUNCS
    echo "Functions: $PROJECT_FUNCS"
    echo "Changed: acceptQuote and reopenQuote (they also keep the quote's project, in the same transaction), deleteCustomer (it also erases projects and renders)."
    echo "New: $PROJECT_NEW (only used by the Projects screen)."
    confirm "Deploy the Phase 7 (Projects) backend to the LIVE project?"
    install
    deploy_functions $PROJECT_FUNCS
    echo "==> making the 7 new functions reachable (each checks the signed-in staff account itself)"
    for f in $PROJECT_NEW; do
      gcloud run services add-iam-policy-binding "$(svc "$f")" --region "$REGION" --project "$PROJECT" --member=allUsers --role=roles/run.invoker --quiet >/dev/null && echo "   public: $f"
    done
    check_reachable "$PROJECT_FUNCS"
    echo "Done. The live screen is unchanged and keeps working. Next: $0 live (the Projects screen). To go back: redeploy the previous code (git checkout phase-6-2-pwa-complete -- functions, then firebase deploy --only functions:acceptQuote,functions:reopenQuote,functions:deleteCustomer); the 7 new functions are harmless without the screen."
    ;;
  push)
    [ -f functions/lib/push.js ] || { echo "This checkout has no Phase 8 (push notifications) code. Update it first: git checkout main && git pull --ff-only"; exit 1; }
    check_settings; check_access; check_routing $PUSH_FUNCS
    echo "Functions: $PUSH_FUNCS"
    echo "New: $PUSH_NEW (the staff-only ones register a device and send a test; pushReceipt is public and only records when a notification arrived)."
    echo "Changed: webhook (the live WhatsApp webhook) and leadIntake: after a NEW message or lead is stored they ask for a push. A push problem can never change their answer or lose a message (tested)."
    confirm "Deploy the Phase 8 backend, INCLUDING the live WhatsApp webhook, to the LIVE project?"
    install
    deploy_functions $PUSH_FUNCS
    echo "==> making the assistant functions reachable (the staff-only ones check the signed-in account themselves)"
    for f in $PUSH_NEW; do
      gcloud run services add-iam-policy-binding "$(svc "$f")" --region "$REGION" --project "$PROJECT" --member=allUsers --role=roles/run.invoker --quiet >/dev/null && echo "   public: $f"
    done
    check_reachable "registerPushDevice unregisterPushDevice sendTestPush webhook leadIntake"           # every one of these refuses a request without sign-in / signature / key (401)
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "https://$REGION-$PROJECT.cloudfunctions.net/pushReceipt" || echo 000)
    [ "$code" = 400 ] && echo "   pushReceipt: ok (it answers and refuses a report without the right ids)" || { echo "   WARNING: pushReceipt answered $code instead of 400. Stop here and report it."; exit 1; }
    echo "Done. Next: $0 live (the Notifications button and the service worker). To go back: git checkout phase-7-projects-complete -- functions, then firebase deploy --only functions:webhook,functions:leadIntake; the 4 new functions are harmless without the screen."
    ;;
  ai)
    [ -f functions/lib/ai.js ] || { echo "This checkout has no Phase 9 (AI assistant) code. Update it first: git checkout main && git pull --ff-only"; exit 1; }
    echo "==> the Anthropic key (a Secret Manager secret; this script never sees or prints it)"
    if gcloud secrets versions list ANTHROPIC_API_KEY --project "$PROJECT" --filter="state=ENABLED" --format='value(name)' 2>/dev/null | grep -q .; then echo "   ANTHROPIC_API_KEY: set"
    else echo "   ANTHROPIC_API_KEY is not set yet. Set it first, typing the key into Cloud Shell only (never into a chat or a file):"; echo "     firebase functions:secrets:set ANTHROPIC_API_KEY --project $PROJECT"; exit 1; fi
    check_settings; check_access; check_routing $AI_FUNCS
    echo "Functions: $AI_FUNCS (all new; no existing function is redeployed)."
    owner=$(value "$ENVF" AI_OWNER_EMAILS)
    if [ -z "$owner" ]; then read -r -p "Owner account: the ONE Google account allowed to switch real customer data on (e.g. you@gmail.com): " owner; fi
    case "$owner" in *@*.*) ;; *) echo "That does not look like an email address. Nothing was changed."; exit 1 ;; esac
    allowed=",$(value "$ENVF" ALLOWED_EMAILS | tr -d ' ' | tr 'A-Z' 'a-z'),"; me=",$(printf '%s' "$owner" | tr -d ' ' | tr 'A-Z' 'a-z'),"
    case "$allowed" in *"$me"*) ;; *) echo "$owner is not on the list of people who may use Elite OS (ALLOWED_EMAILS in $ENVF). Stop here and report it."; exit 1 ;; esac
    echo "Only $owner will be able to switch real customer data on. Everyone else on the list can use the assistant and its on/off switch."
    echo "The assistant starts OFF and with real customer data OFF: it answers nothing until the owner switches it on in the screen (Assistant > Settings)."
    confirm "Deploy the Phase 9 (AI assistant) backend to the LIVE project?"
    setting "$ENVF" AI_OWNER_EMAILS "$owner"
    install
    deploy_functions $AI_FUNCS
    echo "==> making the 4 new functions reachable (each checks the signed-in staff account itself)"
    for f in $AI_NEW; do
      gcloud run services add-iam-policy-binding "$(svc "$f")" --region "$REGION" --project "$PROJECT" --member=allUsers --role=roles/run.invoker --quiet >/dev/null && echo "   public: $f"
    done
    check_reachable "$AI_FUNCS"
    echo "Done. Next: $0 live (the Assistant screen). To go back: firebase functions:delete aiChat aiStatus setAiSettings aiCheckModels aiDecide aiSuggestReply aiDraftOutcome aiDismissConsult setReceptionist --region $REGION --project $PROJECT (nothing else depends on them)."
    ;;
  receptionist)
    [ -f functions/lib/aiReceptionist.js ] || { echo "This checkout has no Phase 9 R3 (receptionist) code. Update it first: git checkout main && git pull --ff-only"; exit 1; }
    [ -n "$(serving_revision setreceptionist)" ] || { echo "Deploy the AI backend first: $0 ai"; exit 1; }
    check_settings; check_access
    echo "Functions: $REC_FUNCS. receptionistSweep is NEW and runs every minute; it cannot be called from outside. pushReceipt only learns the new 'handover' notification."
    echo "It does NOTHING until the owner switches 'Automatic receptionist' on in Assistant > Settings (then it handles only NEW Meta leads that arrive after that moment, never existing chats). It never runs between midnight and 7:00."
    confirm "Deploy the receptionist check to the LIVE project?"
    install
    deploy_functions $REC_FUNCS
    echo "Done. Next: $0 live (the screen). To stop it: switch 'Automatic receptionist' off in Assistant > Settings, or firebase functions:delete receptionistSweep --region $REGION --project $PROJECT"
    ;;
  preview)
    [ -n "$(serving_revision deliverquote)" ] || { echo "Deploy the backend first: $0 backend"; exit 1; }
    no_test_folders
    firebase hosting:channel:deploy phase61 --expires 30d --project "$PROJECT"
    echo "The preview uses LIVE data and the LIVE backend. Use a test customer who is your own number and email (docs/PHASE6_1_PLAN.md,"
    echo "\"Testing the preview\"). Production Hosting, the live screen, is unchanged."
    ;;
  mail)
    case "${2:-}" in
      on)
        [ -f "$ENVF" ] || { echo "Missing $ENVF. Stop here."; exit 1; }
        ./scripts/setup-mailer.sh --check >/dev/null || { echo "The one-time email setup is not finished: run ./scripts/setup-mailer.sh and do the Workspace approval first."; exit 1; }
        check_routing $MAIL_FUNCS
        echo "Email will be sent as $MAIL_SENDER_DEFAULT through $MAIL_SA (send-only)."
        confirm "Switch email sending ON for the live functions?"
        setting "$ENVF" MAIL_SEND on; setting "$ENVF" MAIL_SENDER "$MAIL_SENDER_DEFAULT"; setting "$ENVF" MAIL_SERVICE_ACCOUNT "$MAIL_SA"
        install; save_revisions $MAIL_FUNCS; deploy_functions $MAIL_FUNCS
        echo "Email sending is ON. Kill switch: $0 mail off"
        ;;
      off)
        [ -f "$ENVF" ] || { echo "Missing $ENVF. Stop here."; exit 1; }
        check_routing $MAIL_FUNCS
        confirm "Switch email sending OFF for the live functions?"
        setting "$ENVF" MAIL_SEND off
        install; save_revisions $MAIL_FUNCS; deploy_functions $MAIL_FUNCS
        echo "Email sending is OFF. Quotes can still be sent by WhatsApp and by hand."
        ;;
      *) usage ;;
    esac
    ;;
  live)
    [ -n "$(serving_revision deliverquote)" ] || { echo "Deploy the backend first: $0 backend"; exit 1; }
    # Phase 7: a screen that has Projects calls functions that must exist first (the screen would show errors otherwise).
    if [ -f functions/lib/projects.js ] && [ -z "$(serving_revision createproject)" ]; then echo "Deploy the Projects backend first: $0 projects"; exit 1; fi
    if [ -f functions/lib/push.js ] && [ -z "$(serving_revision pushreceipt)" ]; then echo "Deploy the push notifications backend first: $0 push"; exit 1; fi        # Phase 8: the screen and the /pushReceipt rewrite need these functions
    if [ -f functions/lib/ai.js ] && [ -z "$(serving_revision aichat)" ]; then echo "Deploy the AI assistant backend first: $0 ai"; exit 1; fi
    if [ -f functions/lib/aiReceptionist.js ] && [ -z "$(serving_revision receptionistsweep)" ]; then echo "Deploy the receptionist backend first: $0 receptionist"; exit 1; fi        # Phase 9 R3: the chat button calls setReceptionist; the check itself runs in receptionistSweep        # Phase 9: the Assistant screen calls these functions
    no_test_folders
    echo "This publishes the screen files of this checkout (the commit shown at the top) to everyone who uses Elite OS. Hosting only: no function, rule or setting changes."
    confirm "Publish the screen to PRODUCTION Hosting? Only with the owner's approval."
    firebase deploy --project "$PROJECT" --only hosting
    echo "Done. Reload Elite OS. Undo: Firebase console > Hosting > Release history > Rollback."
    ;;
  routing)
    case "${2:-}" in
      "")
        check_routing $BACKEND_FUNCS $OLDER_FUNCS
        echo "Nothing was changed."
        ;;
      fix)
        pinned=""; unread=""
        echo "==> looking for functions whose traffic is pinned to one old version"
        for f in $BACKEND_FUNCS $OLDER_FUNCS; do
          rc=0; out=$(routing_check "$(svc "$f")") || rc=$?
          case "$rc" in
            1) echo "   $f: PINNED - $(echo "$out" | grep '^PINNED' | head -n 1)"; pinned="$pinned $f" ;;
            0|2) ;;
            *) echo "   $f: could not be checked - $out"; unread="$unread $f" ;;
          esac
        done
        [ -z "$unread" ] || { echo "Could not check:$unread. Nothing was changed. Run this again."; exit 1; }
        [ -n "$pinned" ] || { echo "Nothing is pinned. Nothing was changed."; exit 0; }
        echo "This sends the traffic of these functions back to their NEWEST version. It changes only where requests go (no code, no settings, no data):$pinned"
        echo "If you put one of them back to an old version ON PURPOSE (a restore by revision), this ends that: it runs the newest version again."
        confirm "Send the traffic of these functions back to their newest version?"
        failed=""
        for f in $pinned; do
          if routing_reset "$(svc "$f")"; then echo "   $f: following the newest version"; else echo "   $f: NOT fixed"; failed="$failed $f"; fi
        done
        [ -z "$failed" ] || { echo "NOT FIXED:$failed. Report the messages above; nothing else was changed."; exit 1; }
        echo "Done. The traffic of these functions follows their newest version again."
        ;;
      *) usage ;;
    esac
    ;;
  *) usage ;;
esac
