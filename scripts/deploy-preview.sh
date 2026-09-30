#!/usr/bin/env bash
# Deploy the Phase 2 PREVIEW from Cloud Shell:
#   - the Hosting preview channel "phase2" (production hosting is never touched)
#   - all Cloud Functions EXCEPT the live webhook, unless you pass --with-webhook
#   - makes every function publicly reachable (they authenticate callers themselves)
# Usage:  ./scripts/deploy-preview.sh            (safe default: webhook untouched)
#         ./scripts/deploy-preview.sh --with-webhook   (only after the owner approved a webhook change)
set -euo pipefail
PROJECT=elite-kitchens-lead-os
REGION=europe-west1
cd "$(dirname "$0")/.."

[ -f "functions/.env.$PROJECT" ] || { echo "Missing functions/.env.$PROJECT (your two settings file). Copy it from your old folder."; exit 1; }
echo "==> installing function dependencies"
npm --prefix functions install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm --prefix functions install --omit=dev

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
