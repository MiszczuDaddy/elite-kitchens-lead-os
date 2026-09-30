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

## Remaining
- Owner check of the phone layout on a real phone; final polish from owner feedback.
- Clean-ups: rotate Meta app secret + verify token; destroy placeholder secret versions; tested Firebase SDK upgrade.
- When approved: merge `phase-2-inbox` to `main` and point production Hosting at the new inbox (NOT done; owner decision).
