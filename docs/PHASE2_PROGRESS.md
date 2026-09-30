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
