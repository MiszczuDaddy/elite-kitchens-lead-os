# Elite Kitchens Lead OS: Phase 1 (Firebase, WhatsApp proof of concept)

Proves one thing: our own web app can **send and receive WhatsApp messages via the Meta
WhatsApp Cloud API**, with no Chatwoot in the loop.

    Customer WhatsApp <-> Meta Cloud API <-> Cloud Function (webhook) <-> Firestore <-> web UI

Not in Phase 1 scope: quotes, appointments, AI agents. Added since: media downloads (Phase 2), Lead Ads via Make.com (Phase 3), pipeline / CRM (Phase 4), appointments with a one-way Google Calendar copy (Phase 5).

## Stack (all Firebase, one project)
| Piece | Firebase product |
|---|---|
| Web UI (`public/`) | Hosting |
| Staff login | Authentication (Google sign-in) |
| Messages / contacts | Firestore |
| Public Meta webhook + send actions | Cloud Functions (2nd gen, `europe-west1`) |
| Meta credentials | Secret Manager (via `firebase functions:secrets:set`) |
| Appointments on staff phones (Phase 5) | Google Calendar: a shared calendar Elite OS writes to with a keyless service account |

`https://<project>.web.app/webhook` is the public webhook URL (a Hosting rewrite to the function).

## How it works
- **Webhook** (`functions/index.js` -> `lib/handlers.js`): GET answers Meta's verify handshake; POST checks the
  `X-Hub-Signature-256` signature (needs the app secret), ignores events for other phone numbers, and stores messages.
- **Dedup:** a message's Firestore document id *is* the WhatsApp message id and it is written in a transaction,
  so Meta retries (even simultaneous ones) can never create a second copy.
- **Delivery status** (sent/delivered/read/failed) is applied monotonically and survives arriving before our own write.
- **24-hour rule:** free-text replies only within 24h of the customer's last message; otherwise start with the approved
  template `elite_kitchens_new_lead` (first name = `{{1}}`).
- **Security:** the browser can only *read*, and only with the `staff` claim. It cannot write anything. All writes and
  all WhatsApp calls happen in Cloud Functions. `claimAccess` grants the claim only to verified Google accounts in `ALLOWED_EMAILS`.
- `maxInstances: 3` caps runaway function cost.

## Data model (Firestore)
    contacts/{phone}
    conversations/{phone}                  name, lastMessage, lastInboundAt, updatedAt
    conversations/{phone}/messages/{wamid} direction, type, body, media, status, error, createdAt
    appointments/{id}                      phone, type, start, end, location, notes, status, history, sync.google (Phase 5)
    calendarCleanup/{eventId}              calendar events still to remove after a customer was deleted (Phase 5)

`type` and `media` are already in place for images / PDFs / video / voice notes in Phase 2.

## Phase 2 (branch `phase-2-inbox`)
Design and milestones: `docs/PHASE2_DESIGN.md`. Inbox UI = `public/index.html`, `app.css`, `app.js` (no build step).
Delivered on the branch: multi-customer inbox (search, unread counts, thread, reply, new conversation), editable customer details,
automatic download + display of incoming photos/documents/voice notes/video, sending attachments, delivery ticks, phone layout.
See `docs/PHASE2_PROGRESS.md`, `docs/SECURITY.md`, `docs/DATA_CONTROLS.md`, `docs/SECRET_ROTATION.md`, `docs/RESTORE.md`, `DEPLOY.md`.
Phase 3 (Meta lead intake): `docs/LEAD_INTAKE.md`. Phase 4 (pipeline / CRM): `docs/CRM_PIPELINE.md`.
Phase 5 (appointments + Google Calendar, setup, rollout, rollback): `docs/APPOINTMENTS.md`.

## Tests
    npm test          # 136 backend tests against the Firestore + Storage emulators (media, dedup, unread, auth, rules, lead intake,
                      # pipeline, appointments, Google Calendar sync against a local fake Calendar)
    npm run test:ui   # 57-check full-stack test: real page in Chromium + real functions + Auth/Firestore emulators
                      # + mocked Meta API (needs Java and Playwright; set NODE_PATH if Playwright is installed globally)
    bash test-ui/run.sh <suite>   # the other browser suites: lead.e2e.js (11 checks), crm.e2e.js (14), dnd.e2e.js (13),
                                  # conversion.e2e.js (10), theme.e2e.js (10), appointments.e2e.js (17)

Older notes:
    npm install && npm --prefix functions install
    npm test     # starts the Firestore emulator (needs Java) and runs 15 integration tests, incl. security rules

## Meta webhook
Meta delivers WhatsApp messages and delivery statuses straight to `https://elite-kitchens-lead-os.web.app/webhook` (the `webhook` Cloud Function). Chatwoot is no longer in the loop: the cutover was done on 2026-09-30.
That setting lives in Meta, not in this repo, and deploying the repo does not change it. The cutover record and the check command are in `DEPLOY.md`; `scripts/rollback-webhook.sh` restores the previous revision of the webhook function.
