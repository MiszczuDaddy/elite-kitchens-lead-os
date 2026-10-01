#!/usr/bin/env bash
# Send ONE test lead to the live leadIntake (use your OWN phone number: a real WhatsApp template will be sent).
# Usage: ./scripts/test-lead.sh 0891234567 [FirstName] [LeadId]   (key is read from Secret Manager, never printed)
set -euo pipefail
PROJECT=elite-kitchens-lead-os
PHONE="${1:?usage: test-lead.sh <your phone> [name] [leadId]}"; NAME="${2:-Test}"; ID="${3:-TEST$(date +%s)}"
KEY="$(firebase functions:secrets:access LEADS_API_KEY --project "$PROJECT" | tr -d '\r\n')"
curl -sS -X POST "https://europe-west1-$PROJECT.cloudfunctions.net/leadIntake" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"leadId\":\"$ID\",\"formName\":\"Manual test\",\"fields\":{\"full_name\":\"$NAME\",\"phone_number\":\"$PHONE\",\"city\":\"Balbriggan\",\"project_requirements\":\"Test lead\"}}"
echo; echo "Lead ID used: $ID (run again with the same ID to prove a retry sends nothing)"
