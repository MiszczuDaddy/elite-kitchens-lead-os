#!/usr/bin/env bash
# Apply (or show) the automatic-deletion rules for stored customer files. Reads storage-lifecycle.json:
#   media/    older than 730 days (24 months since received) -> deleted automatically by Google Cloud Storage
#   uploads/  older than 1 day (abandoned half-finished sends) -> deleted
# Message TEXT and customer details are not touched by this; they stay until the customer is deleted in the app.
# Usage:  ./scripts/apply-retention.sh          (apply)      ./scripts/apply-retention.sh --show   (only print what is set now)
set -euo pipefail
PROJECT=elite-kitchens-lead-os
BUCKET="gs://$PROJECT.firebasestorage.app"
cd "$(dirname "$0")/.."
if [ "${1:-}" = "--show" ]; then
  gcloud storage buckets describe "$BUCKET" --project "$PROJECT" --format="json(lifecycle_config)"
  exit 0
fi
echo "Applying this to $BUCKET:"; cat storage-lifecycle.json
gcloud storage buckets update "$BUCKET" --lifecycle-file=storage-lifecycle.json --project "$PROJECT"
echo "Now in force:"; gcloud storage buckets describe "$BUCKET" --project "$PROJECT" --format="json(lifecycle_config)"
