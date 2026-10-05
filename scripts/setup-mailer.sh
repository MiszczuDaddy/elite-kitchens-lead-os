#!/usr/bin/env bash
# Phase 6.1 one-time Google Cloud setup for sending quotes by email as info@elitekitchens.ie. Run from Cloud Shell; safe to repeat.
# Keyless, like the Phase 5 calendar (scripts/setup-calendar.sh):
#   - enables the Gmail API and IAM Credentials (the functions' runtime identity asks IAM to sign a one-hour request for the mailer)
#   - creates the service account ek-mailer@<project>.iam.gserviceaccount.com with NO project roles and NO keys
#   - lets the functions' runtime account get short-lived tokens/signatures for ek-mailer and nothing else (Token Creator on that one account)
#   - prints the mailer's numeric client ID: the ONE thing the Workspace super admin must authorise, for the "send email" scope only
# It deploys nothing, sends nothing and changes no DNS. Authorising the client ID is done by hand in the Workspace Admin console
# (docs/PHASE6_1_PLAN.md, "One-time Google Workspace setup").
#   ./scripts/setup-mailer.sh           apply, then show what is in place
#   ./scripts/setup-mailer.sh --check   only show what is in place (deploy-quote-sending.sh runs this before deploying)
set -euo pipefail
PROJECT=elite-kitchens-lead-os
NUMBER=812360112616
RUNTIME_SA="$NUMBER-compute@developer.gserviceaccount.com"
MAIL_SA="ek-mailer@$PROJECT.iam.gserviceaccount.com"
APIS="gmail.googleapis.com iamcredentials.googleapis.com"

check() {
  local missing=0 enabled
  enabled=$(gcloud services list --enabled --project "$PROJECT" --format='value(config.name)')
  for api in $APIS; do
    if grep -qx "$api" <<<"$enabled"; then echo "  ok       API enabled: $api"; else echo "  MISSING  API not enabled: $api"; missing=1; fi
  done
  if ! gcloud iam service-accounts describe "$MAIL_SA" --project "$PROJECT" >/dev/null 2>&1; then
    echo "  MISSING  service account $MAIL_SA"; return 1
  fi
  echo "  ok       service account $MAIL_SA"
  if [ -n "$(gcloud iam service-accounts get-iam-policy "$MAIL_SA" --project "$PROJECT" --flatten='bindings[].members' \
      --filter="bindings.role=roles/iam.serviceAccountTokenCreator AND bindings.members:$RUNTIME_SA" --format='value(bindings.role)')" ]; then
    echo "  ok       the functions may get short-lived tokens and signatures for it"
  else echo "  MISSING  Token Creator for $RUNTIME_SA on $MAIL_SA"; missing=1; fi
  if [ -n "$(gcloud iam service-accounts keys list --iam-account "$MAIL_SA" --project "$PROJECT" --managed-by=user --format='value(name)')" ]; then
    echo "  WARNING  $MAIL_SA has a key. It is not needed (sign-in is keyless): delete it in IAM > Service accounts > Keys."
  else echo "  ok       no keys"; fi
  local roles
  roles=$(gcloud projects get-iam-policy "$PROJECT" --flatten='bindings[].members' --filter="bindings.members:$MAIL_SA" --format='value(bindings.role)')
  if [ -n "$roles" ]; then echo "  WARNING  $MAIL_SA has project roles it does not need: $(echo $roles)"; else echo "  ok       no project roles"; fi
  echo "  info     the client ID to authorise in the Workspace Admin console: $(gcloud iam service-accounts describe "$MAIL_SA" --project "$PROJECT" --format='value(oauth2ClientId)')"
  return "$missing"
}

if [ "${1:-}" = "--check" ]; then
  echo "Email sending (Gmail API, keyless), one-time setup:"
  check
  exit $?
fi

echo "==> enabling the APIs"
gcloud services enable $APIS --project "$PROJECT" --quiet

echo "==> the mailer service account (no roles, no keys)"
if gcloud iam service-accounts describe "$MAIL_SA" --project "$PROJECT" >/dev/null 2>&1; then
  echo "   already exists"
else
  gcloud iam service-accounts create ek-mailer --project "$PROJECT" --display-name="Elite OS quote email" \
    --description="Sends quote emails as the business mailbox through Gmail (send-only, domain-wide delegation). No project roles, no keys." --quiet
fi

echo "==> letting the functions get short-lived tokens and signatures for it (Token Creator on this one account only)"
for i in 1 2 3 4 5 6; do          # a brand-new account can take a few seconds before IAM can see it
  if gcloud iam service-accounts add-iam-policy-binding "$MAIL_SA" --project "$PROJECT" --member="serviceAccount:$RUNTIME_SA" \
      --role=roles/iam.serviceAccountTokenCreator --quiet >/dev/null 2>&1; then echo "   ok"; break; fi
  [ "$i" = 6 ] && { echo "Could not grant it yet. Run this script again in a minute."; exit 1; }
  sleep 10
done

echo
echo "In place now:"
check || true
echo
echo "Next, by hand, as a Google Workspace super admin (admin.google.com):"
echo "   Security > Access and data control > API controls > Manage Domain Wide Delegation > Add new"
echo "     Client ID:    (the number printed above)"
echo "     OAuth scopes: https://www.googleapis.com/auth/gmail.send        <- this one scope only"
echo "   That lets Elite OS send email as a mailbox of your domain, and nothing else (it cannot read mail)."
