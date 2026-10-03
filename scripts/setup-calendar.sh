#!/usr/bin/env bash
# Phase 5 one-time Google Cloud setup for the Google Calendar sync. Run from Cloud Shell; safe to repeat (every step is idempotent).
#   - enables the Google Calendar API, Cloud Scheduler (runs the 5-minute sweeper) and IAM Credentials (keyless tokens)
#   - creates the service account ek-calendar@<project>.iam.gserviceaccount.com with NO project roles and NO keys
#   - lets the functions' runtime account get short-lived tokens for ek-calendar and nothing else (Token Creator on that one account)
#   - makes sure Cloud Scheduler's own Google-managed account has its standard role, so it can call the private sweeper
# Deploys nothing and never touches a calendar: creating and sharing the calendars is done by hand (docs/APPOINTMENTS.md).
#   ./scripts/setup-calendar.sh           apply, then show what is in place
#   ./scripts/setup-calendar.sh --check   only show what is in place (deploy-appointments.sh runs this before deploying)
set -euo pipefail
PROJECT=elite-kitchens-lead-os
NUMBER=812360112616
RUNTIME_SA="$NUMBER-compute@developer.gserviceaccount.com"
CAL_SA="ek-calendar@$PROJECT.iam.gserviceaccount.com"
SCHEDULER_AGENT="service-$NUMBER@gcp-sa-cloudscheduler.iam.gserviceaccount.com"
APIS="calendar-json.googleapis.com cloudscheduler.googleapis.com iamcredentials.googleapis.com"

check() {
  local missing=0 enabled
  enabled=$(gcloud services list --enabled --project "$PROJECT" --format='value(config.name)')
  for api in $APIS; do
    if grep -qx "$api" <<<"$enabled"; then echo "  ok       API enabled: $api"; else echo "  MISSING  API not enabled: $api"; missing=1; fi
  done
  if ! gcloud iam service-accounts describe "$CAL_SA" --project "$PROJECT" >/dev/null 2>&1; then
    echo "  MISSING  service account $CAL_SA"; return 1
  fi
  echo "  ok       service account $CAL_SA"
  if [ -n "$(gcloud iam service-accounts get-iam-policy "$CAL_SA" --project "$PROJECT" --flatten='bindings[].members' \
      --filter="bindings.role=roles/iam.serviceAccountTokenCreator AND bindings.members:$RUNTIME_SA" --format='value(bindings.role)')" ]; then
    echo "  ok       the functions may get short-lived tokens for it"
  else echo "  MISSING  Token Creator for $RUNTIME_SA on $CAL_SA"; missing=1; fi
  if [ -n "$(gcloud iam service-accounts keys list --iam-account "$CAL_SA" --project "$PROJECT" --managed-by=user --format='value(name)')" ]; then
    echo "  WARNING  $CAL_SA has a key. It is not needed (sign-in is keyless): delete it in IAM > Service accounts > Keys."
  else echo "  ok       no keys"; fi
  local roles
  roles=$(gcloud projects get-iam-policy "$PROJECT" --flatten='bindings[].members' --filter="bindings.members:$CAL_SA" --format='value(bindings.role)')
  if [ -n "$roles" ]; then echo "  WARNING  $CAL_SA has project roles it does not need: $(echo $roles)"; else echo "  ok       no project roles"; fi
  if [ -n "$(gcloud projects get-iam-policy "$PROJECT" --flatten='bindings[].members' \
      --filter="bindings.role=roles/cloudscheduler.serviceAgent AND bindings.members:$SCHEDULER_AGENT" --format='value(bindings.role)')" ]; then
    echo "  ok       Cloud Scheduler's account has its role"
  else echo "  WARNING  Cloud Scheduler's account ($SCHEDULER_AGENT) has no Cloud Scheduler Service Agent role (run this script without --check)"; fi
  return "$missing"
}

if [ "${1:-}" = "--check" ]; then
  echo "Google Calendar sync, one-time setup:"
  check
  exit $?
fi

echo "==> enabling the APIs"
gcloud services enable $APIS --project "$PROJECT" --quiet

echo "==> the calendar service account (no roles, no keys)"
if gcloud iam service-accounts describe "$CAL_SA" --project "$PROJECT" >/dev/null 2>&1; then
  echo "   already exists"
else
  gcloud iam service-accounts create ek-calendar --project "$PROJECT" --display-name="Elite OS Google Calendar sync" \
    --description="Writes appointment events to the shared Elite Kitchens Appointments calendar. No project roles, no keys." --quiet
fi

echo "==> letting the functions get short-lived tokens for it (Token Creator on this one account only)"
for i in 1 2 3 4 5 6; do          # a brand-new account can take a few seconds before IAM can see it
  if gcloud iam service-accounts add-iam-policy-binding "$CAL_SA" --project "$PROJECT" --member="serviceAccount:$RUNTIME_SA" \
      --role=roles/iam.serviceAccountTokenCreator --quiet >/dev/null 2>&1; then echo "   ok"; break; fi
  [ "$i" = 6 ] && { echo "Could not grant it yet. Run this script again in a minute."; exit 1; }
  sleep 10
done

echo "==> Cloud Scheduler's own account (Google normally grants this when the API is enabled; this only makes sure)"
gcloud beta services identity create --service=cloudscheduler.googleapis.com --project "$PROJECT" >/dev/null 2>&1 || true
if gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SCHEDULER_AGENT" --role=roles/cloudscheduler.serviceAgent \
    --condition=None --quiet >/dev/null 2>&1; then echo "   ok"; else echo "   could not confirm it; the sweeper check in 'deploy-appointments.sh backend' will show whether it matters"; fi

echo
echo "In place now:"
check || true
echo
echo "Next, by hand (docs/APPOINTMENTS.md, One-time Google setup): share BOTH calendars with"
echo "   $CAL_SA   ->   Make changes to events"
