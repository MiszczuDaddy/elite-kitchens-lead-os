#!/usr/bin/env bash
# Instantly send ALL live WhatsApp webhook traffic back to the revision that was live before the last
# `deploy-preview.sh --with-webhook` (saved in ~/.webhook-previous-revision). No rebuild, takes seconds.
set -euo pipefail
PROJECT=elite-kitchens-lead-os
REGION=europe-west1
F="$HOME/.webhook-previous-revision"
[ -s "$F" ] || { echo "No saved previous revision found ($F). Nothing to roll back to."; exit 1; }
REV=$(cat "$F")
gcloud run services update-traffic webhook --region "$REGION" --project "$PROJECT" --to-revisions="$REV=100"
echo "Webhook is now serving 100% from the old revision: $REV"
