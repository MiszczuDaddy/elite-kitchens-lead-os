# Deployment notes (Firebase project `elite-kitchens-lead-os`)

Deployed from Google Cloud Shell: upload repo ZIP, `npm --prefix functions install --omit=dev`,
`firebase login --no-localhost`, `firebase deploy`. Live at https://elite-kitchens-lead-os.web.app

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
