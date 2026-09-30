# Phase 2 progress

## Checkpoint M1: multi-customer inbox (PASSED real-world test)
- Code: commit `75ec2e4` on branch `phase-2-inbox` (the exact version deployed to the preview channel).
- Verified by the owner with two different real WhatsApp numbers: separate conversations, switching between them,
  independent replies, replies reached the correct phones.
- Automated: 17 backend tests + 23-check full-stack UI test (emulators) passing.
- Production (`main`, tag `phase-1-whatsapp-poc`) untouched. Preview: Hosting channel `phase2`
  (https://elite-kitchens-lead-os--phase2-0qxooc1u.web.app, expires 2026-10-30).
- Only live change so far: one new function, `markRead`. The webhook is still the Phase 1 code.

## Remaining (in order, each a checkpoint)
1. Customer details panel + editing (`updateContact`), location/project in list and search.
2. Incoming media: images, PDFs/documents, audio/voice notes, video (webhook change: needs owner approval + Cloud Storage).
3. Sending attachments from the inbox.
4. Unread counts (webhook-maintained), status polish, security hardening, mobile polish.

## Checkpoint 1 (PASSED): editable customer details
Panel with name/email/location/project/budget/source/notes, email optional, location/project shown in list and searchable.

## Checkpoint 2 (PASSED real-world test, 2026-09-30): media + attachments + unread
- Incoming photos, PDFs/documents, voice notes, audio and video are downloaded automatically on arrival (official Cloud API ->
  private Cloud Storage) and appear in the conversation with no clicks. Verified live with real WhatsApp: text, photo with caption,
  voice note, PDF, video.
- Safety net: anything that failed/never downloaded is fetched by the page in the background when it comes into view.
- Staff can send photos/PDFs/video/audio (paperclip, paste, drag & drop), validated to WhatsApp limits.
- Per-conversation unread counts, "You:" + type icons in the list, delivery ticks (sent/delivered/read/failed).
- Webhook change deployed to production with approval; one-command rollback: `scripts/rollback-webhook.sh`.
- Tests: 32 backend + 42-check full-stack browser test, all passing.
- Security review: see docs/SECURITY.md.


## Checkpoint 3 (PASSED real-world test): foundation/security hardening - PHASE 2 COMPLETE
All verified on the real system with real WhatsApp traffic before moving on:
1. **Secrets rotated** (Meta app secret, webhook verify token); Meta re-verified the webhook with the new token; all functions moved to the
   newest versions; placeholder/old versions destroyed with a script that refuses to delete anything still in use. See docs/SECRET_ROTATION.md.
2. **Customer data controls**: "Delete customer" (conversation, messages, files, record; audit entry without personal data; late Meta
   statuses can't resurrect data) and **24-month media retention** (storage lifecycle rule in force). See docs/DATA_CONTROLS.md.
3. **Dependency upgrade**: firebase-admin 13->14.5.0, firebase-functions 6->7.4.0; audit 9 -> 2 moderate (accepted residual, see docs/SECURITY.md).
   Staged: all functions except the webhook first (photo links, sending, editing verified), then the webhook last (text, photo, voice note, PDF arrive automatically).
4. Live: webhook = Phase 2 code on upgraded libraries; live page = inbox with delete; retention rule active.

Tests at this checkpoint: 37 backend + 45-check full-stack browser test, all passing.
Deliberately NOT built (later phases): Meta Lead Ads, pipeline stages, appointments, quotes, AI agents. UI is functional only: a redesign is planned.

Known/accepted: 2 moderate npm findings inside Google's storage library (unreachable); Firebase App Check not enabled; no data-export (subject access) action yet;
single allowlisted staff account; Content-Security-Policy not set.
