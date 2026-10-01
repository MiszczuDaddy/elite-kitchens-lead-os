#!/usr/bin/env bash
# Deploy ONLY the new leadIntake function (Phase 3). Never touches the webhook, other functions, hosting or rules.
# Run from Cloud Shell. Needs the LEADS_API_KEY secret to exist first:
#   openssl rand -hex 32 | firebase functions:secrets:set LEADS_API_KEY --data-file - --project elite-kitchens-lead-os
set -euo pipefail
PROJECT=elite-kitchens-lead-os
REGION=europe-west1
cd "$(dirname "$0")/.."
[ -f "functions/.env.$PROJECT" ] || { echo "Missing functions/.env.$PROJECT"; exit 1; }
firebase functions:secrets:get LEADS_API_KEY --project "$PROJECT" >/dev/null 2>&1 || { echo "Secret LEADS_API_KEY does not exist yet - create it first (see top of this file)."; exit 1; }
npm --prefix functions install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm --prefix functions install --omit=dev
firebase deploy --only functions:leadIntake --project "$PROJECT"
gcloud run services add-iam-policy-binding leadintake --region="$REGION" --project "$PROJECT" \
  --member=allUsers --role=roles/run.invoker --quiet >/dev/null && echo "leadIntake is reachable (it authenticates every caller with its own key)."
echo "URL: https://$REGION-$PROJECT.cloudfunctions.net/leadIntake"
