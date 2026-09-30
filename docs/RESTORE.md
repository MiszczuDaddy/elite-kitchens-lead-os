# Returning to a known-good version

## Checkpoints (git tags, created on GitHub)
- `phase-1-whatsapp-poc`: the original proof of concept (Express-free Firebase version, test page).
- `phase-2-foundation`: Phase 2 complete (inbox, media, customer details, data controls, rotated secrets, upgraded libraries).

## What is live and where it came from
- Page (Hosting): `public/` at the tagged commit.
- Functions: `functions/` at the tagged commit, deployed with `./scripts/deploy-preview.sh --with-webhook`.
- Settings not in git (by design): secrets (Firebase Secret Manager), `functions/.env.elite-kitchens-lead-os` (ALLOWED_EMAILS,
  WHATSAPP_PHONE_NUMBER_ID), Meta webhook configuration (see DEPLOY.md), storage lifecycle rule (`./scripts/apply-retention.sh`).

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

## Verify a restore works
    npm install && npm --prefix functions install && npm test && npm run test:ui
then send a text, photo, voice note and PDF from a phone to the WhatsApp number and reply from the inbox.
