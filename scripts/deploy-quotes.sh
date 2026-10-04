#!/usr/bin/env bash
# Phase 6 (quotes) deploy helper. Run from Cloud Shell, one stage at a time, in the order of docs/QUOTES.md "Rollout".
#   ./scripts/deploy-quotes.sh check     read-only: compares the settings file with what the live functions run with, checks the
#                                        functions' own access, and lists what "backend" would deploy. Changes nothing.
#   ./scripts/deploy-quotes.sh backend   the 14 new quote functions, and the two existing functions Phase 6 extended (deleteCustomer
#                                        also erases a customer's quotes and quote PDFs; updateContact also takes an address).
#                                        The live screen is unaffected: it does not use them.
#   ./scripts/deploy-quotes.sh preview   the new screen on Hosting PREVIEW channel phase6 (live data; production Hosting untouched)
#   ./scripts/deploy-quotes.sh live      the new screen on production Hosting. ONLY after the owner approved the preview.
# Every functions deploy first saves the revisions it replaces, so ./scripts/rollback-quotes.sh can undo it in seconds.
# Never deploys the webhook, leadIntake, calendarSweep or any other function, and never changes rules, indexes, secrets, the
# Google Calendar settings, Make or Meta. Do NOT use scripts/deploy-preview.sh for Phase 6: it deploys every function and makes
# them all public, including the private calendarSweep.
set -euo pipefail
PROJECT=elite-kitchens-lead-os
REGION=europe-west1
BUCKET="$PROJECT.firebasestorage.app"
RUNTIME_SA="812360112616-compute@developer.gserviceaccount.com"
ENVF="functions/.env.$PROJECT"
SAVED="$HOME/.previous-revisions-phase6"                # the last Phase 6 functions deploy (rollback-quotes.sh)
BEFORE="$HOME/.previous-revisions-before-phase6"        # written once, by the first backend deploy (rollback-quotes.sh --before-phase6)
# The same list is in rollback-quotes.sh.
QUOTE_FUNCS="createCustomer saveQuoteSettings setQuoteNumbering createQuote saveQuoteDraft sendQuote acceptQuote declineQuote reopenQuote reviseQuote discardQuoteDraft deleteQuoteDraft setQuoteNotes quotePdfUrl"
CHANGED_FUNCS="deleteCustomer updateContact"
BACKEND_FUNCS="$QUOTE_FUNCS $CHANGED_FUNCS"
# Every setting the functions read from the settings file (functions/index.js). A setting missing from the file is NOT kept
# from the live function: it falls back to its default (for example Google Calendar sync "off"). So a deploy is refused
# unless the file gives every function exactly what the live deleteCustomer runs with now.
SETTINGS="ALLOWED_EMAILS WHATSAPP_PHONE_NUMBER_ID WHATSAPP_TEMPLATE_NAME WHATSAPP_TEMPLATE_LANG WHATSAPP_API_VERSION GCAL_SYNC GCAL_CALENDAR_ID GCAL_SERVICE_ACCOUNT"
default_of() {                                                     # the defaults in functions/index.js
  case "$1" in
    WHATSAPP_TEMPLATE_NAME) echo elite_kitchens_new_lead ;; WHATSAPP_TEMPLATE_LANG) echo en ;; WHATSAPP_API_VERSION) echo v21.0 ;;
    GCAL_SYNC) echo off ;; *) echo "" ;;
  esac
}
cd "$(dirname "$0")/.."

usage() { sed -n '2,9p' "$0" | sed 's/^# *//'; exit 1; }
svc() { echo "$1" | tr '[:upper:]' '[:lower:]'; }                  # a function's Cloud Run service name
has() { grep -qE "^$2=" "$1"; }
value() { { grep -E "^$2=" "$1" || true; } | tail -n 1 | cut -d= -f2- | tr -d '\r'; }
confirm() { read -r -p "$1 Type yes: " a; [ "$a" = "yes" ] || { echo "Cancelled. Nothing was deployed."; exit 1; }; }
install() { npm --prefix functions install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm --prefix functions install --omit=dev; }
deploy_functions() { local only=""; for f in "$@"; do only="${only:+$only,}functions:$f"; done; firebase deploy --project "$PROJECT" --only "$only"; }

# The revision live traffic goes to now (after a rollback that is not the newest one), or nothing when the function is not deployed.
serving_revision() {
  { gcloud run services describe "$1" --region "$REGION" --project "$PROJECT" --format=json 2>/dev/null || true; } | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      if (!s.trim()) return;
      const t = ((JSON.parse(s).status || {}).traffic || []).filter((x) => x.revisionName).sort((a, b) => (b.percent || 0) - (a.percent || 0));
      if (t[0]) console.log(t[0].revisionName);
    });'
}
save_revisions() {
  : > "$SAVED"
  for f in "$@"; do
    local rev; rev=$(serving_revision "$(svc "$f")")
    if [ -n "$rev" ]; then echo "$(svc "$f")=$rev" >> "$SAVED"; echo "   saved $f -> $rev"; else echo "   $f: not deployed yet (nothing to save)"; fi
  done
}
backend_deployed() { [ -n "$(serving_revision createquote)" ]; }
no_test_folders() { [ ! -d public/theme-lab ] || { echo "Refusing: the temporary test folder public/theme-lab is there. Remove it first."; exit 1; }; }

# A setting as a function revision runs with it (from "gcloud run revisions describe" JSON), or "<unset>".
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
  [ -n "$rev" ] || { echo "deleteCustomer is not deployed. Phase 6 goes on top of Phase 5: stop here."; exit 1; }
  live=$(mktemp)
  gcloud run revisions describe "$rev" --region "$REGION" --project "$PROJECT" --format=json > "$live"
  echo "==> the settings file compared with what the live functions run with (deleteCustomer, $rev)"
  for k in $SETTINGS; do
    if has "$ENVF" "$k"; then f=$(value "$ENVF" "$k"); else f=$(default_of "$k"); fi
    l=$(env_of "$live" "$k"); [ "$l" = "<unset>" ] && l=$(default_of "$k")
    if [ "$f" = "$l" ]; then echo "   $k: same"; else echo "   $k: DIFFERENT"; bad="$bad $k"; fi
  done
  echo "   (Google Calendar sync: $(value "$ENVF" GCAL_SYNC); these deploys keep it as it is)"
  rm -f "$live"
  if [ -n "$bad" ]; then
    echo "Refusing to deploy: $ENVF does not match the live functions for:$bad"
    echo "A deploy would change these settings for deleteCustomer and updateContact (a missing Google Calendar setting would"
    echo "switch calendar sync off for deleteCustomer). Nothing was changed. Stop here and report which setting differs."
    exit 1
  fi
}
# The functions' own access, granted in Phase 2 for WhatsApp media: quotes use the same (moving the uploaded PDF into quotes/,
# and short-lived links to stored PDFs). Read-only: a missing grant is reported, never changed here.
has_binding() {
  node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const p = s.trim() ? JSON.parse(s) : {};
      process.exit((p.bindings || []).some((b) => b.role === process.argv[1] && (b.members || []).includes(process.argv[2])) ? 0 : 1);
    });' "$1" "$2"
}
check_access() {
  echo "==> checking the functions' own access to stored files"
  local ok=1
  if gcloud storage buckets get-iam-policy "gs://$BUCKET" --project "$PROJECT" --format=json | has_binding roles/storage.objectAdmin "serviceAccount:$RUNTIME_SA"; then
    echo "   storage: ok"; else echo "   WARNING: the functions cannot write stored files (roles/storage.objectAdmin on gs://$BUCKET is missing)"; ok=0; fi
  if gcloud iam service-accounts get-iam-policy "$RUNTIME_SA" --project "$PROJECT" --format=json | has_binding roles/iam.serviceAccountTokenCreator "serviceAccount:$RUNTIME_SA"; then
    echo "   PDF links: ok"; else echo "   WARNING: the functions cannot make short-lived PDF links (roles/iam.serviceAccountTokenCreator is missing)"; ok=0; fi
  [ "$ok" = 1 ] || { echo "Stop here and report the warning: WhatsApp media uses the same access, so it should be there."; exit 1; }
}
# Each quote function must answer a request without sign-in with "Sign in first" (HTTP 401): reachable, and refusing. Nothing
# happens: every one checks the staff account before anything else. New permissions can take a minute to apply.
check_reachable() {
  echo "==> checking that each quote function answers, and refuses a request without sign-in"
  local f code pending="$QUOTE_FUNCS" next
  for _ in 1 2 3 4 5 6 7 8 9; do
    next=""
    for f in $pending; do
      code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"data":{}}' \
        "https://$REGION-$PROJECT.cloudfunctions.net/$f" || echo 000)
      if [ "$code" = 401 ]; then echo "   $f: ok"; else next="$next $f"; fi
    done
    pending="$next"; [ -z "$pending" ] && return
    sleep 10
  done
  echo "   WARNING: not answering as expected after 90 s:$pending"
  echo "   Stop here and report it. The live screen is unaffected; ./scripts/rollback-quotes.sh undoes the deploy."
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
    echo "\"backend\" would deploy: $BACKEND_FUNCS"
    echo "Nothing was changed."
    ;;
  backend)
    check_settings; check_access
    echo "Functions: $BACKEND_FUNCS"
    confirm "Deploy the Phase 6 backend to the LIVE project?"
    install
    echo "==> saving the revisions this replaces"
    save_revisions $BACKEND_FUNCS
    [ -s "$BEFORE" ] || { grep -E '^(deletecustomer|updatecontact)=' "$SAVED" > "$BEFORE" || true; }
    deploy_functions $BACKEND_FUNCS
    echo "==> making the 14 quote functions reachable (each checks the signed-in staff account itself)"
    for f in $QUOTE_FUNCS; do
      gcloud run services add-iam-policy-binding "$(svc "$f")" --region "$REGION" --project "$PROJECT" \
        --member=allUsers --role=roles/run.invoker --quiet >/dev/null && echo "   public: $f"
    done
    check_reachable
    echo "Done. The live screen is unchanged. Undo in seconds with: ./scripts/rollback-quotes.sh"
    ;;
  preview)
    backend_deployed || { echo "Deploy the backend first: $0 backend"; exit 1; }
    no_test_folders
    firebase hosting:channel:deploy phase6 --expires 30d --project "$PROJECT"
    echo "The preview uses LIVE data: customers, quotes and pipeline moves made there are real (quotes are numbered TEST-0001,"
    echo "TEST-0002... until the cut-over). Production Hosting, the live screen, is unchanged."
    ;;
  live)
    backend_deployed || { echo "Deploy the backend first: $0 backend"; exit 1; }
    no_test_folders
    echo "This publishes the Phase 6 screen (Quotes) to everyone who uses Elite OS."
    confirm "Publish the Phase 6 screen to PRODUCTION Hosting? Only with the owner's approval."
    firebase deploy --project "$PROJECT" --only hosting
    echo "Done. Reload Elite OS. Undo: Firebase console > Hosting > Release history > Rollback."
    ;;
  *) usage ;;
esac
