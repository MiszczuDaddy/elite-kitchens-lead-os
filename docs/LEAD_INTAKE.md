# Phase 3 — Meta Lead Ads → Make → Elite OS → WhatsApp

Make only **delivers** the lead. Elite OS validates, de-duplicates, stores it, creates the customer and sends the
approved WhatsApp template `elite_kitchens_new_lead` itself. The customer's reply arrives through the existing webhook and the
conversation continues in the normal Inbox (new leads start in **Inbox** status).

## Endpoint
`POST https://europe-west1-elite-kitchens-lead-os.cloudfunctions.net/leadIntake` (function `leadIntake`, separate from the webhook).
Header `Authorization: Bearer <LEADS_API_KEY>` (also accepted: `X-Api-Key`). JSON body ≤ 32 KB. The key lives only in Secret Manager
(`LEADS_API_KEY`) and in the Make connection/headers. Several comma-separated keys are accepted, which allows rotation with no downtime.

## Payload
Minimum: `leadId` (the Meta lead id, 5–64 chars `A-Za-z0-9_-`) plus the answers, in any of these shapes:
`{"leadId":"…","formId":"…","formName":"…","fields":{"full_name":"…","phone_number":"…"}}`,
`fields` as Meta's `[{name, values:[…]}]` list, `field_data`, or the answers flat at the top level.
Field names are matched loosely (name/first_name/full_name, phone/mobile/whatsapp, email, city/town/location/county, budget,
requirements/message/comments, project/service/interested…). Unknown questions are kept in the customer's **Notes**, never lost.
Project type is taken from the answers or guessed from the form name; staff can edit it.

## Responses (what Make sees)
| HTTP | body `status` | meaning | Make should |
|---|---|---|---|
| 200 | `processed` | customer saved; `welcome`: sent / failed / unknown / skipped_recent | done |
| 200 | `duplicate` | this lead id was already handled | done |
| 200 | `rejected` (`reason: invalid_phone`) | no usable phone number | **email the owner** |
| 401 | — | wrong/missing key | fix the key |
| 400 / 413 | — | bad body | check mapping |
| 503 | `in_progress` / `rate_limited` / retryable WhatsApp error | try again later | let Make retry |
Rejected leads are not final: re-sending the same lead id after correcting the phone is processed normally.

## Safety rules (all covered by tests)
- Meta Lead ID is the dedup key (`leads/{id}`, created in a transaction): retries and concurrent posts create one customer and send one template.
- The welcome is **at most once**: if a run dies mid-send the lead is flagged "status unknown" in the conversation and never auto-resent.
- Same phone number within 1 hour → no second template (the lead is still recorded in Notes). After 1 hour a new enquiry sends it again.
- Circuit breaker: > 60 new leads/hour → 503 and nothing is sent. Max 3 attempts per lead.
- Phone numbers: Irish national (089…, 0035389…, +353…) and valid international numbers → digits-only international; anything else rejected.
- Name missing/unusable → "Hi there". Existing customers: only blank fields are filled, staff edits and status are kept.
- The `leads` ledger holds no names, numbers or emails; logs redact digit runs. Firestore rules unchanged (staff read-only, no browser writes).

## Make scenario (keep it OFF until tested)
1. **Facebook Lead Ads → Watch Leads** (Page + the form). One scenario per form: clone it for new forms; Elite OS needs no change.
2. **HTTP → Make a request**: POST the URL above, header `Authorization: Bearer <key>`, body type JSON:
   `leadId` = Lead ID, `formId`, `formName`, `fields` = every answer from the form (name → value).
3. **Filter + email** on `status = rejected` ("Lead needs a phone number" with the lead details).
4. Error handler: leave Make's default retry; 503 and network errors are safe to repeat.
Confirm the real output field names on the first real lead and adjust.

## Rollout / test plan
1. Create the secret, `./scripts/deploy-lead-intake.sh` (only `leadIntake`).
2. `./scripts/test-lead.sh <your phone>` → template arrives, lead shows in Inbox; run again with the same lead id → nothing sent; wrong key → 401.
3. Build the Make scenario (OFF), run once with Meta's Lead Ads Testing Tool (placeholder phone → expect `rejected` email), then a real test with your number.
4. Turn the scenario ON.

## Rollback / kill switch
- Pause: switch the Make scenario OFF (instant). Nothing else is affected.
- Remove: `firebase functions:delete leadIntake --region europe-west1 --project elite-kitchens-lead-os`.
- Rotate key: add a new key after a comma (`old,new`), update Make, then drop the old one.
