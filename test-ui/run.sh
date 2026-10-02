#!/usr/bin/env bash
# Full-stack UI test: real page + real functions + Auth/Firestore emulators + mocked Meta API.
# Needs: npm install (root + functions), Java, and Playwright (set NODE_PATH if it is installed globally).
set -e
cd "$(dirname "$0")/.."
# Emulator-only config, removed on exit (both files are gitignored). Fake secrets: nothing real is used.
printf 'ALLOWED_EMAILS=staff@test.dev\nWHATSAPP_PHONE_NUMBER_ID=111\nWHATSAPP_API_BASE=http://127.0.0.1:9911\nGCAL_SYNC=on\nGCAL_CALENDAR_ID=elite-e2e@group.calendar.google.com\nGCAL_API_BASE=http://127.0.0.1:9912\n' > functions/.env.local
printf 'WHATSAPP_ACCESS_TOKEN=tok\nWHATSAPP_APP_SECRET=secret\nWHATSAPP_VERIFY_TOKEN=vt\nLEADS_API_KEY=emulator-leads-key-0123456789abcdef\n' > functions/.secret.local
trap 'rm -f functions/.env.local functions/.secret.local' EXIT
npx firebase emulators:exec --only auth,functions,firestore,storage --project demo-leados "node test-ui/${1:-ui.e2e.js}"
