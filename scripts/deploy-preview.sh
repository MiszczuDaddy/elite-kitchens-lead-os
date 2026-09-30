#!/usr/bin/env bash
# Deploy the Phase 2 PREVIEW from Cloud Shell:
#   - Storage security rules (customer media is private; staff may only drop files into their own uploads folder)
#   - all Cloud Functions EXCEPT the live webhook, unless you pass --with-webhook
#   - the IAM permissions those functions need (idempotent)
#   - makes every function publicly reachable (they authenticate callers themselves)
#   - the Hosting preview channel "phase2" (production hosting is never touched)
# Usage:  ./scripts/deploy-preview.sh                 (Stage A: webhook untouched)
#         ./scripts/deploy-preview.sh --with-webhook  (Stage B: ONLY after the owner approved; saves the old revision for rollback)
set -euo pipefail
PROJECT=elite-kitchens-lead-os
REGION=europe-west1
BUCKET="$PROJECT.firebasestorage.app"
SA="812360112616-compute@developer.gserviceaccount.com"
cd "$(dirname "$0")/.."

[ -f "functions/.env.$PROJECT" ] || { echo "Missing functions/.env.$PROJECT (your two settings file). Copy it from your old folder."; exit 1; }

echo "==> installing function dependencies"
npm --prefix functions install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm --prefix functions install --omit=dev

echo "==> making sure the functions' service account has the access it needs"
gcloud services enable iamcredentials.googleapis.com --project "$PROJECT" --quiet >/dev/null
# read/write customer media in our bucket only
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$SA" --role=roles/storage.objectAdmin --project "$PROJECT" --quiet >/dev/null
# sign short-lived download links for itself (no keys are ever created or stored)
gcloud iam service-accounts add-iam-policy-binding "$SA" --member="serviceAccount:$SA" --role=roles/iam.serviceAccountTokenCreator --project "$PROJECT" --quiet >/dev/null
echo "   ok"

if [ "${1:-}" = "--with-webhook" ]; then
  echo "==> saving the CURRENT webhook revision so it can be restored in one command"
  PREV=$(gcloud run services describe webhook --region "$REGION" --project "$PROJECT" --format='value(status.latestReadyRevisionName)')
  echo "$PREV" > "$HOME/.webhook-previous-revision"
  echo "   previous revision: $PREV  (rollback: ./scripts/rollback-webhook.sh)"
fi

echo "==> deploying storage rules"
firebase deploy --project "$PROJECT" --only storage

FUNCS=$(node -e "
const src=require('fs').readFileSync('functions/index.js','utf8');
const names=[...src.matchAll(/^exports\.(\w+)\s*=/gm)].map(m=>m[1]);
const withHook=process.argv[1]==='--with-webhook';
console.log(names.filter(n=>withHook||n!=='webhook').map(n=>'functions:'+n).join(','));
" -- "${1:-}")
echo "==> deploying: $FUNCS"
firebase deploy --project "$PROJECT" --only "$FUNCS"

echo "==> making functions reachable (idempotent)"
for svc in $(gcloud run services list --region "$REGION" --project "$PROJECT" --format='value(name)'); do
  gcloud run services add-iam-policy-binding "$svc" --region "$REGION" --project "$PROJECT" \
    --member=allUsers --role=roles/run.invoker --quiet >/dev/null && echo "   public: $svc"
done

echo "==> publishing the preview page"
firebase hosting:channel:deploy phase2 --expires 30d --project "$PROJECT"
echo "Done. Preview: https://elite-kitchens-lead-os--phase2-0qxooc1u.web.app"
