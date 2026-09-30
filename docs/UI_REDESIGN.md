# Phase 2 UI redesign

Base: `phase-2-foundation` / `96840d173b37dbccae9e65309cf5d06f585d9be1`.
Branch: `phase-2-ui-redesign`.

## Scope

Plain HTML, CSS and JavaScript, with no frontend build step. Backend functions, callable payloads, Firestore shapes, authentication, storage, security rules and deployment configuration are unchanged.

Desktop: workspace navigation, inbox, conversation, customer profile. Below 1280px the profile opens over the conversation. Below 900px inbox and conversation are separate screens, with a full-screen customer profile. Future workspace labels are informational and have no fabricated functionality.

Customer profile: Details, Media and Documents. All supported fields remain editable; closing and reopening the profile retains unsaved edits. Media includes exchanged photos/videos, dates and a private full-size viewer with arrow-key navigation, downloads, Escape and focus restoration. Documents reuse existing file cards and downloads. Native audio/video controls and existing media retry/retention states remain available.

The existing live message listener still loads the latest 500 messages. The asset tabs expose Load earlier messages for older history, reading previous 500-message batches from the same collection. Thumbnails load as they approach the visible profile area. No new collection, media index or callable was introduced.

## Verification

Verified on 2026-10-01: all 51 browser checks passed (45 foundation + 6 redesign); desktop and phone screenshots inspected. Backend/configuration diff against the recovery tag is empty.

`npm run test:ui` retains the original 45 checks and adds six redesign regressions. Emulator data and Meta calls are mocked; no real customer messages are sent by tests. Screenshots are written to ignored `test-ui/shots/`.

On Windows, tests can use Git Bash, Node 22, Java 21, Playwright via NODE_PATH, and Chrome via CHROMIUM. Tooling is outside this repository in the local workspace.

## Preview deployment only

Do **not** run `scripts/deploy-preview.sh` for this UI branch: that script also changes functions and storage rules.

After tests pass, sign into Firebase and run from this repository:

    firebase hosting:channel:deploy phase2-ui-redesign --project elite-kitchens-lead-os --expires 30d

This deploys a Hosting preview channel only. Do not run `firebase deploy`, merge to main, deploy functions, or alter either recovery tag. Preview reads and actions use the existing live backend, so sends/edits/deletions performed by staff in the preview affect real customers.

Owner desktop/phone acceptance testing is required before any merge or production release.
