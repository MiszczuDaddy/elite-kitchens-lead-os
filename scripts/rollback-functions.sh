#!/usr/bin/env bash
# Instantly send live traffic for EVERY function back to the revisions saved before the last deploy-preview.sh run
# (~/.previous-revisions). No rebuild: takes seconds. Use if a deploy misbehaves in any function.
#   ./scripts/rollback-functions.sh                 restore all functions
#   ./scripts/rollback-functions.sh webhook         restore only the named function(s)
set -euo pipefail
PROJECT=elite-kitchens-lead-os
REGION=europe-west1
F="$HOME/.previous-revisions"
[ -s "$F" ] || { echo "No saved revisions found ($F). Nothing to roll back to."; exit 1; }
while IFS='=' read -r svc rev; do
  [ -n "$svc" ] && [ -n "$rev" ] || continue
  if [ "$#" -gt 0 ]; then case " $* " in *" $svc "*) ;; *) continue;; esac; fi
  gcloud run services update-traffic "$svc" --region "$REGION" --project "$PROJECT" --to-revisions="$rev=100" --quiet >/dev/null && echo "restored $svc -> $rev"
done < "$F"
