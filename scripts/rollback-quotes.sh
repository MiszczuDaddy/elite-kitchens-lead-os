#!/usr/bin/env bash
# Undo Phase 6 functions deploys in seconds (no rebuild): live traffic goes back to the revisions saved by deploy-quotes.sh.
#   ./scripts/rollback-quotes.sh                  undo the LAST "backend" deploy: every function it replaced goes back to the
#                                                 revision it had (~/.previous-revisions-phase6)
#   ./scripts/rollback-quotes.sh --before-phase6  deleteCustomer and updateContact back to the revisions they had before
#                                                 Phase 6's first deploy (~/.previous-revisions-before-phase6)
#   ./scripts/rollback-quotes.sh --close          the 14 quote functions stop answering browsers (public access removed);
#                                                 quotes, settings and stored PDFs stay as they are
#   ./scripts/rollback-quotes.sh --open           undo --close
# Not done here (docs/QUOTES.md, Rollback):
#   - the screen: Firebase console > Hosting > Release history > Rollback (or redeploy tag phase-5-appointments-complete)
#   - the 14 quote functions did not exist before Phase 6, so their first revision has nothing older to go back to. The old
#     screen never calls them; --close shuts them.
set -euo pipefail
PROJECT=elite-kitchens-lead-os
REGION=europe-west1
# The same list is in deploy-quotes.sh.
QUOTE_FUNCS="createCustomer saveQuoteSettings setQuoteNumbering createQuote saveQuoteDraft sendQuote acceptQuote declineQuote reopenQuote reviseQuote discardQuoteDraft deleteQuoteDraft setQuoteNotes quotePdfUrl"
svc() { echo "$1" | tr '[:upper:]' '[:lower:]'; }

case "${1:-}" in
  --close|--open)
    action=remove; [ "$1" = "--open" ] && action=add
    for f in $QUOTE_FUNCS; do
      gcloud run services "$action-iam-policy-binding" "$(svc "$f")" --region "$REGION" --project "$PROJECT" \
        --member=allUsers --role=roles/run.invoker --quiet >/dev/null 2>&1 && echo "$([ "$action" = add ] && echo opened || echo closed): $f" \
        || echo "$f: no change (not deployed, or already $([ "$action" = add ] && echo open || echo closed))"
    done
    [ "$1" = "--close" ] && echo "The Quotes screen and \"Add customer\" now get errors; everything else is unaffected. Undo: $0 --open"
    exit 0
    ;;
  ""|--before-phase6) ;;
  *) sed -n '2,10p' "$0" | sed 's/^# *//'; exit 1 ;;
esac

F="$HOME/.previous-revisions-phase6"
[ "${1:-}" = "--before-phase6" ] && F="$HOME/.previous-revisions-before-phase6"
[ -s "$F" ] || { echo "No saved revisions ($F). Nothing to roll back to."; exit 1; }
while IFS='=' read -r s rev; do
  [ -n "$s" ] && [ -n "$rev" ] || continue
  gcloud run services update-traffic "$s" --region "$REGION" --project "$PROJECT" --to-revisions="$rev=100" --quiet >/dev/null && echo "restored $s -> $rev"
done < "$F"
if [ "${1:-}" = "--before-phase6" ]; then
  echo "Note: deleteCustomer and updateContact are now their Phase 5 versions. Deleting a customer no longer removes their quotes"
  echo "or quote PDFs, and the Address field can no longer be saved."
fi
