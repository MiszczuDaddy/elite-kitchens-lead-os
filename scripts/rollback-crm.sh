#!/usr/bin/env bash
# Send live traffic for the two Phase 4 functions back to the revisions saved by "deploy-crm.sh backend". Takes seconds, no rebuild.
# The screen itself is rolled back in Firebase console > Hosting > Release history > Rollback (or redeploy tag phase-3-meta-leads-complete).
set -euo pipefail
PROJECT=elite-kitchens-lead-os
REGION=europe-west1
F="$HOME/.previous-revisions-phase4"
[ -s "$F" ] || { echo "No saved revisions ($F). Nothing to roll back to."; exit 1; }
while IFS='=' read -r svc rev; do
  [ -n "$svc" ] && [ -n "$rev" ] || continue
  gcloud run services update-traffic "$svc" --region "$REGION" --project "$PROJECT" --to-revisions="$rev=100" --quiet >/dev/null && echo "restored $svc -> $rev"
done < "$F"
