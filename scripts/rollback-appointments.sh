#!/usr/bin/env bash
# Undo a Phase 5 functions deploy in seconds (no rebuild): live traffic goes back to the revisions saved by deploy-appointments.sh.
#   ./scripts/rollback-appointments.sh                  undo the LAST "backend" or "sync on|off" deploy (~/.previous-revisions-phase5)
#   ./scripts/rollback-appointments.sh --before-phase5  deleteCustomer and setConversationStatus back to the revisions they had before
#                                                        Phase 5's first deploy (~/.previous-revisions-before-phase5)
# Not done here (docs/APPOINTMENTS.md, Rollback):
#   - the screen: Firebase console > Hosting > Release history > Rollback (or redeploy tag phase-4-crm-complete)
#   - the 4 appointment functions and calendarSweep did not exist before Phase 5, so their first revision has nothing older to go back
#     to. The old screen never calls them. To stop every write to Google Calendar: ./scripts/deploy-appointments.sh sync off
set -euo pipefail
PROJECT=elite-kitchens-lead-os
REGION=europe-west1
F="$HOME/.previous-revisions-phase5"
[ "${1:-}" = "--before-phase5" ] && F="$HOME/.previous-revisions-before-phase5"
[ -s "$F" ] || { echo "No saved revisions ($F). Nothing to roll back to."; exit 1; }
while IFS='=' read -r svc rev; do
  [ -n "$svc" ] && [ -n "$rev" ] || continue
  gcloud run services update-traffic "$svc" --region "$REGION" --project "$PROJECT" --to-revisions="$rev=100" --quiet >/dev/null && echo "restored $svc -> $rev"
done < "$F"
if [ "${1:-}" = "--before-phase5" ]; then
  echo "Note: deleteCustomer is now the pre-Phase 5 version. Deleting a customer no longer removes their appointments or calendar events."
fi
