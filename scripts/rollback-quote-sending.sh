#!/usr/bin/env bash
# Undo Phase 6.1 functions deploys in seconds (no rebuild).
#   ./scripts/rollback-quote-sending.sh              undo the LAST "backend" deploy: every function it replaced goes back to the
#                                                    revision it had (~/.previous-revisions-phase61)
#   ./scripts/rollback-quote-sending.sh --close      the 7 new functions stop answering browsers (public access removed). Sent quotes,
#                                                    delivery records and stored PDFs stay as they are; the old screen never calls them
#   ./scripts/rollback-quote-sending.sh --open       undo --close
#   ./scripts/rollback-quote-sending.sh --mail-off   email sending off (the same as "deploy-quote-sending.sh mail off")
# Not done here (docs/PHASE6_1_PLAN.md, Rollback):
#   - the screen: Firebase console > Hosting > Release history > Rollback (or redeploy tag phase-6-quotes-complete)
#   - the 7 new functions did not exist before Phase 6.1, so their first revision has nothing older to go back to; --close shuts them.
#   - a quote whose send is "in progress" when the backend is rolled back keeps its locked draft: the old quote functions do not know
#     about the lock. Finish or cancel such sends first (the quote page shows them), or edit the draft only after the lock is cleared.
set -euo pipefail
PROJECT=elite-kitchens-lead-os
REGION=europe-west1
# The same list is in deploy-quote-sending.sh.
NEW_FUNCS="reopenConversation deliverQuote retryQuoteDelivery resolveQuoteDelivery cancelQuoteSend markQuoteSent quoteChannels"
svc() { echo "$1" | tr '[:upper:]' '[:lower:]'; }

case "${1:-}" in
  --close|--open)
    action=remove; [ "$1" = "--open" ] && action=add
    for f in $NEW_FUNCS; do
      gcloud run services "$action-iam-policy-binding" "$(svc "$f")" --region "$REGION" --project "$PROJECT" \
        --member=allUsers --role=roles/run.invoker --quiet >/dev/null 2>&1 && echo "$([ "$action" = add ] && echo opened || echo closed): $f" \
        || echo "$f: no change (not deployed, or already $([ "$action" = add ] && echo open || echo closed))"
    done
    [ "$1" = "--close" ] && echo "Sending a quote and Reopen conversation now get errors; everything else is unaffected. Undo: $0 --open"
    exit 0
    ;;
  --mail-off) exec "$(dirname "$0")/deploy-quote-sending.sh" mail off ;;
  "") ;;
  *) sed -n '2,8p' "$0" | sed 's/^# *//'; exit 1 ;;
esac

F="$HOME/.previous-revisions-phase61"
[ -s "$F" ] || { echo "No saved revisions ($F). Nothing to roll back to."; exit 1; }
while IFS='=' read -r s rev; do
  [ -n "$s" ] && [ -n "$rev" ] || continue
  gcloud run services update-traffic "$s" --region "$REGION" --project "$PROJECT" --to-revisions="$rev=100" --quiet >/dev/null && echo "restored $s -> $rev"
done < "$F"
