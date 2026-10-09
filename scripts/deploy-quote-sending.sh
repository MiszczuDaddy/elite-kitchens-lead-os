#!/usr/bin/env bash
# Phase 6.1 (direct quote sending: WhatsApp and email, and "Reopen conversation") deploy helper. Run from Cloud Shell, one stage
# at a time, in the order of docs/PHASE6_1_PLAN.md "Rollout". Nothing here runs until the owner says so.
#   ./scripts/deploy-quote-sending.sh check      read-only: the settings file against what the live functions run with, the functions'
#                                                own access, the one-time email setup, and what "backend" would deploy. Changes nothing.
#   ./scripts/deploy-quote-sending.sh backend    the 7 new functions, and the 14 quote functions (they share the quote code that now
#                                                locks a draft while a send is prepared). Email stays as it is (the settings file decides). The live screen is unaffected.
#   ./scripts/deploy-quote-sending.sh channels   M7 only: redeploy the 3 functions that send (deliverQuote, retryQuoteDelivery, quoteChannels) so a
#                                                closed-window quote goes in the approved quotation template. Email stays as it is.
#   ./scripts/deploy-quote-sending.sh older      the audit fixes in the four OLDER functions (sendReply, sendMedia, claimAccess, leadIntake): one request =
#                                                one message, a Meta 5xx is never retried by itself, and staff access that expires and is renewed.
#                                                Run it BEFORE "rules". It saves the revisions it replaces.
#   ./scripts/deploy-quote-sending.sh rules      the Firestore and Storage SECURITY RULES that refuse an expired staff claim (audit finding 5). LAST, and
#                                                only after "older" and the new screen are live (docs/PHASE6_1_PLAN.md, "Audit"): a session that has not
#                                                renewed its access loses it until the page is reloaded. Cannot be rolled back by revision: redeploy the old rules.
#   ./scripts/deploy-quote-sending.sh preview    the new screen on Hosting PREVIEW channel phase61 (live data; production untouched)
#   ./scripts/deploy-quote-sending.sh mail on    switch email sending ON (writes MAIL_SEND=on, the sender and the mailer service account
#                                                to the settings file) and redeploy the 3 functions that read it. Needs setup-mailer.sh
#                                                and the Workspace approval first.
#   ./scripts/deploy-quote-sending.sh mail off   the kill switch: email sending off again.
#   ./scripts/deploy-quote-sending.sh live       the new screen on production Hosting. ONLY after the owner approved the preview.
# Every functions deploy first saves the revisions it replaces. ./scripts/rollback-quote-sending.sh can put them back only for about a day (Google then
# deletes old versions' files): the dependable undo is redeploying the previous code, see docs/PHASE6_1_PLAN.md "Rollback". The very
# first "backend" run also keeps the ORIGINAL revisions (before Phase 6.1) in ~/.previous-revisions-phase61.original and never overwrites
# them. A deploy that Google throttles is retried by itself (up to 3 times).
# Never deploys the webhook, calendarSweep or any function not named above; changes security rules ONLY in the explicit "rules" stage; never
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
OLDER_FUNCS="sendReply sendMedia claimAccess leadIntake"           # older functions that the audit fixes touch (finding 5 and 6); all four are public already
BACKEND_FUNCS="$NEW_FUNCS $QUOTE_FUNCS"
# Settings shared with the functions that are already live: they must match what those run with, or a deploy would change them.
SHARED_SETTINGS="ALLOWED_EMAILS WHATSAPP_PHONE_NUMBER_ID WHATSAPP_API_VERSION GCAL_SYNC GCAL_CALENDAR_ID GCAL_SERVICE_ACCOUNT"
default_of() { case "$1" in WHATSAPP_API_VERSION) echo v21.0 ;; GCAL_SYNC) echo off ;; *) echo "" ;; esac; }
cd "$(dirname "$0")/.."

usage() { sed -n '2,27p' "$0" | sed 's/^# *//'; exit 1; }
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
    check_settings; check_access
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
    check_settings; check_access
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
    check_settings; check_access
    echo "Functions: $OLDER_FUNCS"
    echo "These are LIVE functions from earlier phases: staff replies and files, the staff sign-in check, and the Meta lead form intake."
    confirm "Redeploy these 4 older functions to the LIVE project?"
    install
    echo "==> saving the revisions this replaces"
    save_revisions $OLDER_FUNCS
    deploy_functions $OLDER_FUNCS
    check_reachable "$OLDER_FUNCS"
    echo "Done. Staff access now carries an expiry and is renewed by the new screen. Do NOT run \"rules\" until the new screen (Phase 6.1) is live and you have reloaded Elite OS once."
    echo "To go back: redeploy the previous code (docs/PHASE6_1_PLAN.md, \"Rollback\"); ./scripts/rollback-quote-sending.sh works only for about a day."
    ;;
  rules)
    [ -n "$(serving_revision claimaccess)" ] || { echo "Deploy the functions first: $0 older"; exit 1; }
    echo "This publishes security rules that REFUSE a staff sign-in whose claim has expired or has no expiry (audit finding 5)."
    echo "Before you do: (1) './scripts/deploy-quote-sending.sh older' must be done; (2) the Phase 6.1 screen must be live (it renews access every 30 minutes;"
    echo "the old screen does not, so it would lose access after about 12 hours); (3) reload Elite OS once so your session carries the new kind of claim."
    echo "If you are locked out afterwards: reload the page (it asks for a new claim). To go back: git checkout 6baa6ca -- firestore.rules storage.rules, then firebase deploy --only firestore:rules,storage (docs/PHASE6_1_PLAN.md, \"Rollback\")."
    confirm "Publish the new security rules to the LIVE project?"
    firebase deploy --project "$PROJECT" --only firestore:rules,storage
    echo "Done. Reload Elite OS to confirm you can still read your conversations."
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
        echo "Email will be sent as $MAIL_SENDER_DEFAULT through $MAIL_SA (send-only)."
        confirm "Switch email sending ON for the live functions?"
        setting "$ENVF" MAIL_SEND on; setting "$ENVF" MAIL_SENDER "$MAIL_SENDER_DEFAULT"; setting "$ENVF" MAIL_SERVICE_ACCOUNT "$MAIL_SA"
        install; save_revisions $MAIL_FUNCS; deploy_functions $MAIL_FUNCS
        echo "Email sending is ON. Kill switch: $0 mail off"
        ;;
      off)
        [ -f "$ENVF" ] || { echo "Missing $ENVF. Stop here."; exit 1; }
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
    no_test_folders
    echo "This publishes the Phase 6.1 screen (Send quote, Reopen conversation) to everyone who uses Elite OS."
    confirm "Publish the Phase 6.1 screen to PRODUCTION Hosting? Only with the owner's approval."
    firebase deploy --project "$PROJECT" --only hosting
    echo "Done. Reload Elite OS. Undo: Firebase console > Hosting > Release history > Rollback."
    ;;
  *) usage ;;
esac
