# Elite Kitchens Lead OS: Phase 1 (WhatsApp proof of concept)

Proves one thing: our own web app can **send and receive WhatsApp messages via the
Meta WhatsApp Cloud API**, with no Chatwoot in the loop.

    Customer WhatsApp <-> Meta Cloud API <-> this app (Express + Postgres)

Not in scope yet: Lead Ads, Make.com, quotes, appointments, CRM, AI agents, media downloads.

## What's here
- `src/server.js`: Express server. `GET/POST /webhook` (public, signature-verified), `/healthz`, and a password-protected UI + JSON API.
- `src/whatsapp.js`: Cloud API calls (text + template), webhook signature check, payload parsing.
- `src/db.js`, `src/schema.sql`: `contacts`, `conversations`, `messages` (auto-migrates on boot). `messages` already has `message_type` and a `media` JSONB column for Phase 2.
- `public/index.html`: minimal test UI.
- `test/e2e.test.js`: integration tests (real Postgres, mocked Meta API).

## Behaviour worth knowing
- **24-hour rule:** free-text replies only work within 24h of the customer's last message. Otherwise use **Start conversation**, which sends the approved template `elite_kitchens_new_lead` with the first name as `{{1}}`.
- **Dedup:** `messages.whatsapp_message_id` has a unique index; Meta retries are ignored.
- **Signature check:** every webhook POST must carry a valid `X-Hub-Signature-256` (needs `WHATSAPP_APP_SECRET`), otherwise 401.
- **Only our number:** webhook events for any other `phone_number_id` are ignored.
- **Secrets are server-side only** (environment variables). Nothing is sent to the browser.

## Config
See `.env.example`. Required: `DATABASE_URL`, `ADMIN_PASSWORD`, `WHATSAPP_PHONE_NUMBER_ID`,
`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`.

## Run locally
    npm install
    cp .env.example .env   # fill in, then export the variables
    npm start
    DATABASE_URL=postgres://... npm test   # tests DROP and recreate the three tables. Use a scratch DB!

## Meta webhook (do NOT change until approved)
The live Meta webhook currently points at Chatwoot. It is not modified by this repo.
Cutover steps and rollback notes will be added here before any change is made.
