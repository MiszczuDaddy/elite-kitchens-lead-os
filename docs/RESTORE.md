# Returning to a known-good version

## Checkpoints (git tags, created on GitHub)
- `phase-1-whatsapp-poc`: the original proof of concept (Express-free Firebase version, test page).
- `phase-2-foundation`: Phase 2 complete (inbox, media, customer details, data controls, rotated secrets, upgraded libraries).
- `phase-2-ui-complete`: the redesigned inbox with conversation status filters.
- `phase-3-meta-leads-complete`: Meta Lead Ads intake via Make (`docs/LEAD_INTAKE.md`).
- `phase-4-crm-complete`: the pipeline / CRM (`docs/CRM_PIPELINE.md`). The last version without appointments.

## What is live and where it came from
- Page (Hosting): `public/` at the tagged commit.
- Functions: `functions/` at the tagged commit, deployed with `./scripts/deploy-preview.sh --with-webhook`.
- Settings not in git (by design): secrets (Firebase Secret Manager), `functions/.env.elite-kitchens-lead-os` (ALLOWED_EMAILS,
  WHATSAPP_PHONE_NUMBER_ID, and from Phase 5 the GCAL_* calendar settings), Meta webhook configuration (see DEPLOY.md), storage lifecycle
  rule (`./scripts/apply-retention.sh`). Phase 5 also relies on the `ek-calendar` service account (`./scripts/setup-calendar.sh`), the
  calendar's sharing in Google Calendar and one Google Workspace sharing setting (`docs/APPOINTMENTS.md`).

## Go back to a tag (from Cloud Shell)
    cd ~/elite-kitchens-lead-os && git fetch --tags -q && git checkout phase-2-foundation
    ./scripts/deploy-preview.sh --with-webhook          # functions + preview page
    firebase deploy --only hosting --project elite-kitchens-lead-os   # live page

## Undo the last deploy quickly (no rebuild, seconds)
    ./scripts/rollback-functions.sh            # every function back to the revision saved before the last deploy
    ./scripts/rollback-functions.sh webhook    # only the webhook
Live page: Firebase console > Hosting > Release history > roll back.
Note: a revision from before a secret rotation holds the OLD secret version (destroyed), so it cannot start; roll back only to
revisions made after the last rotation.
Phase 5 has its own quick undo: `./scripts/rollback-appointments.sh` (`docs/APPOINTMENTS.md`, Rollback).

## Going back to a tag from before Phase 5
- First stop all writes to Google from the Phase 5 checkout: `./scripts/deploy-appointments.sh sync off`.
- Redeploying an older tag does not delete the Phase 5 functions. They stay deployed and unused: the older screen never calls them.
- `deploy-preview.sh` makes every deployed function public, and that now includes the private `calendarSweep`. Afterwards, make it private again:
      gcloud run services remove-iam-policy-binding calendarsweep --region europe-west1 --project elite-kitchens-lead-os --member=allUsers --role=roles/run.invoker

## Verify a restore works
    npm install && npm --prefix functions install && npm test && npm run test:ui
then send a text, photo, voice note and PDF from a phone to the WhatsApp number and reply from the inbox.
