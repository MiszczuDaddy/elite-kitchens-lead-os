#!/usr/bin/env bash
# Full-stack UI test: real page + real functions + Auth/Firestore emulators + mocked Meta API.
# Needs: npm install (root + functions), Java, and Playwright (set NODE_PATH if it is installed globally).
set -e
cd "$(dirname "$0")/.."
# Emulator-only config, removed on exit (both files are gitignored). Fake secrets: nothing real is used.
printf 'ALLOWED_EMAILS=staff@test.dev\nWHATSAPP_PHONE_NUMBER_ID=111\nWHATSAPP_API_BASE=http://127.0.0.1:9911\n' > functions/.env.local
printf 'WHATSAPP_ACCESS_TOKEN=tok\nWHATSAPP_APP_SECRET=secret\nWHATSAPP_VERIFY_TOKEN=vt\n' > functions/.secret.local
trap 'rm -f functions/.env.local functions/.secret.local' EXIT
npx firebase emulators:exec --only auth,functions,firestore --project demo-leados "node test-ui/ui.e2e.js"
