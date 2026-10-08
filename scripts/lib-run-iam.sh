#!/usr/bin/env bash
# Shared by the scripts that open Cloud Run services to browsers or close them again (rollback-quote-sending.sh, rollback-quotes.sh,
# deploy-preview.sh). Source it; the caller sets PROJECT and REGION.
#
# Audit finding 7: an emergency shutdown must never say it worked when it did not. So every gcloud failure is reported as a failure
# (expired login, missing permission, network), a missing service is reported as "not deployed", and the result of every change is
# CHECKED by reading the service's access policy back. The functions return non-zero unless every service was verified in the state
# that was asked for.
iam_lower() { echo "$1" | tr '[:upper:]' '[:lower:]'; }

# iam_state SERVICE -> prints open (allUsers may call it) | closed | missing (no such service) | unknown (could not be read)
iam_state() {
  local out
  if out=$(gcloud run services get-iam-policy "$1" --region "$REGION" --project "$PROJECT" --format=json 2>&1); then
    if grep -q '"allUsers"' <<<"$out"; then echo open; else echo closed; fi
  elif grep -qiE 'cannot find service|NOT_FOUND|could not be found' <<<"$out"; then echo missing
  else echo unknown; fi
}

# iam_public add|remove FUNCTION... : open (add) or close (remove) the functions to browsers, then verify each one.
# Prints one line per function. Sets IAM_FAILED to the names that are NOT in the wanted state. Returns 0 only if there are none.
iam_public() {
  local action="$1" want f svc out rc state how bad=0; shift
  [ "$action" = add ] && want=open || want=closed
  IAM_FAILED=""
  for f in "$@"; do
    svc=$(iam_lower "$f"); how="" ; rc=0
    out=$(gcloud run services "$action-iam-policy-binding" "$svc" --region "$REGION" --project "$PROJECT" --member=allUsers --role=roles/run.invoker --quiet 2>&1) || rc=$?
    if [ "$rc" -ne 0 ]; then
      if [ "$action" = remove ] && grep -qi 'policy binding' <<<"$out" && grep -qi 'not found' <<<"$out"; then how=already      # it was not open
      elif grep -qiE 'cannot find service|NOT_FOUND' <<<"$out" && ! grep -qi 'policy binding' <<<"$out"; then
        if [ "$action" = remove ]; then echo "$f: not deployed (nothing to close)"; continue; fi
        echo "$f: NOT DEPLOYED: it cannot be opened"; bad=1; IAM_FAILED="$IAM_FAILED $f"; continue
      else
        echo "$f: FAILED: $(head -n 1 <<<"$out")"; bad=1; IAM_FAILED="$IAM_FAILED $f"; continue
      fi
    fi
    state=$(iam_state "$svc")                                    # never trust the command's own answer: read the policy back
    if [ "$state" = "$want" ]; then
      if [ "$action" = add ]; then echo "$f: opened"; elif [ "$how" = already ]; then echo "$f: already closed"; else echo "$f: closed"; fi
    else
      echo "$f: NOT $want (the check says: $state)"; bad=1; IAM_FAILED="$IAM_FAILED $f"
    fi
  done
  [ "$bad" -eq 0 ]
}

# iam_assert_private FUNCTION... : succeeds only if none of them is open to everyone (for functions that must stay private, such as
# the calendar sweeper that Cloud Scheduler calls). A function that is not deployed counts as private.
iam_assert_private() {
  local f state bad=0
  for f in "$@"; do
    state=$(iam_state "$(iam_lower "$f")")
    case "$state" in
      closed|missing) echo "$f: private (ok)" ;;
      open) echo "$f: OPEN TO EVERYONE: it must stay private"; bad=1 ;;
      *) echo "$f: could not check whether it is private"; bad=1 ;;
    esac
  done
  [ "$bad" -eq 0 ]
}
