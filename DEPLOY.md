# Deployment notes (Firebase project `elite-kitchens-lead-os`)

Deployed from Google Cloud Shell, from a clone of the GitHub repo (`cd ~/elite-kitchens-lead-os && git pull`), using the scripts in
`scripts/` (`deploy-preview.sh`, `deploy-lead-intake.sh`, `deploy-crm.sh`; details below and in `docs/LEAD_INTAKE.md`, `docs/CRM_PIPELINE.md`).
The scripts run `npm --prefix functions install --omit=dev` and `firebase deploy` themselves; Firebase sign-in in Cloud Shell is
`firebase login --no-localhost`. Live at https://elite-kitchens-lead-os.web.app

## Things that had to be fixed on this project (the org is `elitekitchens.ie`, secure-by-default)
1. **Build failed** ("missing permission on the build service account"): the org policy
   `iam.automaticIamGrantsForDefaultServiceAccounts` stops Google auto-granting roles to the default
   compute service account `812360112616-compute@developer.gserviceaccount.com`. Granted explicitly:
   - `roles/cloudbuild.builds.builder` (build)
   - `roles/firebaseauth.admin` (claimAccess sets the `staff` claim)
   - `roles/datastore.user` (functions read/write Firestore)
2. **Functions could not be made public**: org policy `iam.allowedPolicyMemberDomains` (domain restricted sharing)
   blocked `allUsers`. Overridden for THIS PROJECT ONLY (`allowAll: true` at project level), then
   `roles/run.invoker` granted to `allUsers` on webhook, claimaccess, startconversation, sendreply.
   Public invocation only opens the door: the webhook checks Meta's HMAC signature, the callables check
   the signed-in staff account against `ALLOWED_EMAILS`.
   NOTE: any NEW function added later needs the same `allUsers` invoker grant (or `invoker: 'public'` in code).
3. The org-level role `roles/orgpolicy.policyAdmin` was temporarily granted to info@elitekitchens.ie to do (2).
   Remove it when done:
   `gcloud organizations remove-iam-policy-binding 1048933872885 --member=user:info@elitekitchens.ie --role=roles/orgpolicy.policyAdmin`

## Config
- Secrets (Secret Manager): WHATSAPP_ACCESS_TOKEN, WHATSAPP_APP_SECRET (placeholders until Meta values are set),
  WHATSAPP_VERIFY_TOKEN (random). Update a secret: `firebase functions:secrets:set NAME`, then redeploy functions.
- `functions/.env.elite-kitchens-lead-os` (gitignored): ALLOWED_EMAILS, WHATSAPP_PHONE_NUMBER_ID (placeholder 0 until set).
- Container image cleanup policy: 1 day (keeps Artifact Registry cost ~0).

## Webhook cutover (2026-09-30): DONE, Chatwoot no longer receives WhatsApp
- App-level webhook (Meta app "Nowy Whats", 1496707152106004): `https://elite-kitchens-lead-os.web.app/webhook`, field `messages` subscribed.
- The phone number (id 1132141579981595) ALSO had its own override pointing at
  `https://app.chatwoot.com/webhooks/whatsapp/+353899661073`, which beats the app-level webhook. Replaced with ours via
  `POST /{phone_number_id}` `webhook_configuration.override_callback_uri` + verify_token.
  Check any time: `GET /{phone_number_id}?fields=webhook_configuration`.
- WABA 1262905402273450 has the app subscribed and no WABA-level override.
- Secrets read from Secret Manager are `.trim()`med (a token saved via `openssl ... | secrets:set --data-file -` keeps a newline).

## Phase 1 result
- Test 1 (phone -> Meta -> Cloud Function -> Firestore -> web UI): PASSED
- Test 2 (web UI -> Cloud Function -> Meta -> phone): PASSED

## Follow-ups
- Remove temporary org role: see item 3 above.

## Phase 2 deploys (branch `phase-2-inbox`)
Deploy from Cloud Shell: `cd ~/elite-kitchens-lead-os && git pull && ./scripts/deploy-preview.sh`
- Stage A (default): storage rules + all functions except the live webhook + preview page. Safe to repeat.
- Stage B: `./scripts/deploy-preview.sh --with-webhook` ONLY after the owner has approved a webhook change.
  Saves the live revision to `~/.webhook-previous-revision`; `./scripts/rollback-webhook.sh` restores it in seconds.
- Cloud Storage bucket: `gs://elite-kitchens-lead-os.firebasestorage.app` (europe-west1). Functions' service account
  needs `roles/storage.objectAdmin` on the bucket and `roles/iam.serviceAccountTokenCreator` on itself (to sign download
  links); the script applies both.

## Safety nets added in Phase 2 hardening
- Every `deploy-preview.sh` run first saves each function's current live revision (`~/.previous-revisions`); `./scripts/rollback-functions.sh [name]` restores them in seconds.
- Secret versions: `node scripts/secret-cleanup.js` (plan) / `--apply`; it reads the Cloud Functions records and refuses to run if it cannot see what is in use.
- Retention: `./scripts/apply-retention.sh` (24 months for media, 1 day for abandoned uploads).
- Firebase Admin 14 is modular-only: use `getFirestore()/getAuth()/getStorage()`, not `admin.firestore()`.
