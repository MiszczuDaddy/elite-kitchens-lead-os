#!/usr/bin/env bash
# Phase 4 (pipeline / CRM) deploy helper. Run from Cloud Shell, one stage at a time:
#   ./scripts/deploy-crm.sh backend   deploys ONLY setConversationStatus and updateContact (both backward compatible: the live
#                                     app keeps working). Saves their current revisions first so they can be rolled back in seconds.
#   ./scripts/deploy-crm.sh preview   publishes the new screen to a Hosting PREVIEW channel (production site untouched)
#   ./scripts/deploy-crm.sh live      publishes the new screen to production Hosting. ONLY after the owner approved the preview.
# Never deploys leadIntake, the webhook or any other function, never touches rules, Make or Meta.
set -euo pipefail
PROJECT=elite-kitchens-lead-os
REGION=europe-west1
SAVED="$HOME/.previous-revisions-phase4"
cd "$(dirname "$0")/.."

case "${1:-}" in
  backend)
    [ -f "functions/.env.$PROJECT" ] || { echo "Missing functions/.env.$PROJECT"; exit 1; }
    npm --prefix functions install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm --prefix functions install --omit=dev
    : > "$SAVED"
    for svc in setconversationstatus updatecontact; do
      rev=$(gcloud run services describe "$svc" --region "$REGION" --project "$PROJECT" --format='value(status.latestReadyRevisionName)')
      echo "$svc=$rev" >> "$SAVED"; echo "saved current revision: $svc -> $rev"
    done
    firebase deploy --project "$PROJECT" --only functions:setConversationStatus,functions:updateContact
    echo "Done. Roll back with: ./scripts/rollback-crm.sh"
    ;;
  preview)
    firebase hosting:channel:deploy phase4 --expires 30d --project "$PROJECT"
    ;;
  live)
    read -r -p "Publish the Phase 4 screen to PRODUCTION Hosting? Type yes: " a; [ "$a" = "yes" ] || { echo "Cancelled."; exit 1; }
    firebase deploy --project "$PROJECT" --only hosting
    ;;
  *) echo "usage: $0 backend|preview|live"; exit 1 ;;
esac
