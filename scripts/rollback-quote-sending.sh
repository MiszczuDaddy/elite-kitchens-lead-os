#!/usr/bin/env bash
# Put the revisions saved by the last Phase 6.1 functions deploy back. WORKS ONLY WHILE Google still keeps those versions' files (Firebase deletes them
# after about a day: on 2026-10-09 every one of 21 restores failed with "Container import failed"). The dependable way back for functions is to redeploy the
# previous code from git: docs/PHASE6_1_PLAN.md, "Rollback". --close / --open / --mail-off do not depend on that (they change access, not code).
#   ./scripts/rollback-quote-sending.sh              undo the LAST functions deploy (backend, channels or mail): every function it replaced goes back
#                                                    to the revision it had (~/.previous-revisions-phase61)
#   ./scripts/rollback-quote-sending.sh --originals  put the 14 quote functions back to how they were BEFORE Phase 6.1 (the list the first
#                                                    "backend" deploy kept: ~/.previous-revisions-phase61.original). Run --close separately for the 7 new ones
#   ./scripts/rollback-quote-sending.sh --close      the 7 new functions stop answering browsers (public access removed). Sent quotes,
#                                                    delivery records and stored PDFs stay as they are; the old screen never calls them.
#                                                    Every function is CHECKED afterwards: the script exits with an error unless all are closed
#   ./scripts/rollback-quote-sending.sh --open       undo --close
#   ./scripts/rollback-quote-sending.sh --mail-off   email sending off (the same as "deploy-quote-sending.sh mail off")
#   --ignore-prepared                                 with the two restoring forms: go on although a quote send is in progress (see below)
# Restoring older versions is REFUSED while a quote send is in progress (a quote whose PDF was prepared and whose draft is locked, with
# nothing delivered yet): the older quote functions do not know about that lock, so the draft would stay locked. Finish or cancel such
# sends first (the quote page shows a "send in progress" box), or use --ignore-prepared if you accept that.
# Not done here (docs/PHASE6_1_PLAN.md, Rollback):
#   - the screen: Firebase console > Hosting > Release history > Rollback (or redeploy tag phase-6-quotes-complete)
#   - the 7 new functions did not exist before Phase 6.1, so their first revision has nothing older to go back to; --close shuts them.
set -euo pipefail
PROJECT=elite-kitchens-lead-os
REGION=europe-west1
HERE="$(cd "$(dirname "$0")" && pwd)"
# The same list is in deploy-quote-sending.sh.
NEW_FUNCS="reopenConversation deliverQuote retryQuoteDelivery resolveQuoteDelivery cancelQuoteSend markQuoteSent quoteChannels"
. "$HERE/lib-run-iam.sh"

ACT=""; ORIG=0; IGNORE=0
for a in "$@"; do
  case "$a" in
    --close|--open|--mail-off) ACT="$a" ;;
    --originals) ORIG=1 ;;
    --ignore-prepared) IGNORE=1 ;;
    *) sed -n '2,16p' "$0" | sed 's/^# *//'; exit 1 ;;
  esac
done

case "$ACT" in
  --close|--open)
    action=remove; [ "$ACT" = "--open" ] && action=add
    if iam_public "$action" $NEW_FUNCS; then
      [ "$ACT" = "--close" ] && echo "Closed and checked: sending a quote and Reopen conversation now get errors; everything else is unaffected. Undo: $0 --open"
      exit 0
    fi
    echo
    if [ "$ACT" = "--close" ]; then
      echo "NOT CLOSED: these functions may still answer browsers:$IAM_FAILED"
      echo "Do not assume sending is stopped. Fix the error shown above (for example sign in again with: gcloud auth login) and run this again."
    else
      echo "NOT OPENED:$IAM_FAILED. Fix the error shown above and run this again."
    fi
    exit 1
    ;;
  --mail-off) exec "$HERE/deploy-quote-sending.sh" mail off ;;
esac

# Restoring older revisions. First: no send may be half done (the old functions do not understand the lock).
if [ "$IGNORE" != 1 ]; then
  check="${PREPARED_SENDS_CMD:-node \"$HERE/prepared-sends.js\"}"          # PREPARED_SENDS_CMD is only for the tests of this script
  rc=0; found=$(eval "$check" 2>&1) || rc=$?
  if [ "$rc" = 3 ]; then
    echo "REFUSED: a quote send is in progress (its draft is locked and nothing has been delivered yet):"; echo "$found" | sed 's/^/   /'
    echo "The older quote functions do not know about that lock. Finish or cancel each send first (open the quote: the page shows a \"send in progress\" box),"
    echo "or run this again with --ignore-prepared if you accept that those drafts stay locked."
    exit 1
  elif [ "$rc" != 0 ]; then
    echo "REFUSED: could not check whether a quote send is in progress: $found"
    echo "Fix that (it needs access to Firestore), or run this again with --ignore-prepared to go on without the check."
    exit 1
  fi
fi

F="$HOME/.previous-revisions-phase61"; [ "$ORIG" = 1 ] && F="$HOME/.previous-revisions-phase61.original"
[ -s "$F" ] || { echo "No saved revisions ($F). Nothing to roll back to."; exit 1; }
# Putting an OLDER claimAccess back gives staff access without an expiry: with the new security rules live that locks everyone out of the screen (second audit, finding 7).
if grep -q '^claimaccess=' "$F"; then bash "$HERE/access-compat.sh" allow-legacy-code || exit 1; fi
bad=""
while IFS='=' read -r s rev; do
  [ -n "$s" ] && [ -n "$rev" ] || continue
  if gcloud run services update-traffic "$s" --region "$REGION" --project "$PROJECT" --to-revisions="$rev=100" --quiet </dev/null >/dev/null; then echo "restored $s -> $rev"; else bad="$bad $s"; fi
done < "$F"
if [ -n "$bad" ]; then
  echo
  echo "NOT RESTORED:$bad"
  echo "Those functions still run what they ran before: nothing was changed for them. Google keeps an old version's files only for a short time (about a day), so going back by revision often fails with \"Container import failed\"."
  echo "The dependable way back is to redeploy the previous code from git: docs/PHASE6_1_PLAN.md, \"Rollback\"."
  exit 1
fi
