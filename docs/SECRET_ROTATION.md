# Rotating the WhatsApp secrets (runbook)

Secrets: `WHATSAPP_VERIFY_TOKEN` (webhook handshake), `WHATSAPP_APP_SECRET` (verifies Meta's signatures),
`WHATSAPP_ACCESS_TOKEN` (sending; rotate only if it was ever exposed).

Key facts
- Functions are pinned to a secret VERSION at deploy time. Setting a new version changes nothing until the function is redeployed.
- Never destroy a version a live function is pinned to (it would fail to start). `scripts/secret-cleanup.js` checks this.
- Resetting the Meta app secret invalidates the old one immediately: from then until the webhook is redeployed with the new
  value (~5 min) signed notifications are rejected (401). Meta retries them automatically, so messages arrive late, not lost.
- After a rotation, webhook revisions from before it are obsolete for rollback (they hold the old secret).

Steps
1. New verify token (no live impact): `openssl rand -hex 24 | tr -d '\n' | firebase functions:secrets:set WHATSAPP_VERIFY_TOKEN --data-file -`  (answer **n** to "re-deploy").
2. Meta: App settings > Basic > App secret > Reset. Copy the new secret.
3. `firebase functions:secrets:set WHATSAPP_APP_SECRET`, paste, answer **n** to "re-deploy".
4. Immediately: `firebase deploy --only functions:webhook --project elite-kitchens-lead-os` (webhook now verifies with the new secret).
5. Re-register the new verify token with Meta: dashboard webhook "Verify and save", and the phone-number override (see DEPLOY.md).
6. Test a real message round trip.
7. `./scripts/deploy-preview.sh --with-webhook` (moves every function to the newest versions), then
   `node scripts/secret-cleanup.js` (plan) and `node scripts/secret-cleanup.js --apply`.
