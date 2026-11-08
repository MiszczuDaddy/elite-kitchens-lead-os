# Best time to contact (Pipeline, New lead)

The November lead form asks **"When is the best time to contact you?"**. The answer now shows on the lead's card in the **Pipeline > New lead** column, as a bold line under the town and project: **Best time: Morning (9am-12pm)**. It only shows on New lead cards: once a customer is booked, quoted, won or closed the time no longer matters.

## Where it comes from
Only the **lead form's own answer in the customer's Notes** (the line "• Best time to contact: …" inside a "Meta lead" block), never the chat and never something a person typed in the Notes (`functions/lib/contactTime.js`, the same rule as the ⭐). Meta sends a multiple-choice answer as its option key ("morning_(9am-12pm)"); underscores become spaces and the first letter a capital. If a customer fills the form again, the newest answer wins. It is kept on the conversation as `contactTime` (60 characters at most): set when a lead arrives (`leadIntake`), kept in step when the Notes are edited (`updateContact`), so removing the answer from the Notes removes it from the card.

## Putting it live
1. `./scripts/deploy-quote-sending.sh asap` (redeploys `leadIntake` and `updateContact`; both exist already). Nothing is sent to anyone.
2. For the leads you already have: `node scripts/mark-contact-times.js` (shows what it would change, changes nothing), then `node scripts/mark-contact-times.js --apply`. It changes one field (`contactTime`) on existing conversations.
3. `./scripts/deploy-quote-sending.sh live` (the screen).

New leads from the **old** form ("Kitchens 03/26") have no such question, so they show nothing.

## Tests
`functions/test/contact-time.test.js` (5, emulator): what counts, lead intake, a repeat form, editing the Notes, a chat message never sets it. `test-ui/contact-time.e2e.js` (4): the card on a laptop and a phone, nothing for other leads or booked customers, live updates.
