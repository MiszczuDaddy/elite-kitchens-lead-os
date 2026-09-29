# Elite Kitchens Lead OS: Phase 1 (Firebase, WhatsApp proof of concept)

Proves one thing: our own web app can **send and receive WhatsApp messages via the Meta
WhatsApp Cloud API**, with no Chatwoot in the loop.

    Customer WhatsApp <-> Meta Cloud API <-> Cloud Function (webhook) <-> Firestore <-> web UI

Not in scope yet: Lead Ads, Make.com, quotes, appointments, CRM, AI agents, media downloads.

## Stack (all Firebase, one project)
| Piece | Firebase product |
|---|---|
| Web UI (`public/`) | Hosting |
| Staff login | Authentication (Google sign-in) |
| Messages / contacts | Firestore |
| Public Meta webhook + send actions | Cloud Functions (2nd gen, `europe-west1`) |
| Meta credentials | Secret Manager (via `firebase functions:secrets:set`) |

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

`type` and `media` are already in place for images / PDFs / video / voice notes in Phase 2.

## Tests
    npm install && npm --prefix functions install
    npm test     # starts the Firestore emulator (needs Java) and runs 15 integration tests, incl. security rules

## Meta webhook: NOT changed by this repo
The live Meta webhook still points at Chatwoot. Cutover and rollback notes will be added here before anything is changed.
