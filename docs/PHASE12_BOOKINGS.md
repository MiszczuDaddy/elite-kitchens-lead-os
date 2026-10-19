# Phase 12: bookings customers can rely on (build record)

Approved plan: `docs/PHASE12_BOOKINGS_PLAN.md` (18 Oct 2026, all five recommended choices). Branch `phase-12-bookings`, on top of `main` `f074b8c`. **Nothing here is deployed.**

## What it does (plain words)
1. **Send confirmation.** After you book a visit, a button appears next to the "Booked for ..." message: *Send confirmation…*. It opens a short question ("Send Anna a WhatsApp confirmation of their consultation on tomorrow at 10:30? It will go as a normal WhatsApp message."). Press **Send**: one message goes. The same button is on the visit (in the customer's profile, the Appointments list, the day/week view) and in the visit's menu. Booking never sends anything by itself.
2. **New time / cancellation.** If you move or cancel a visit the customer was told about, the button becomes *Send the new time…* or *Send cancellation message…*. A visit the customer never heard about needs neither.
3. **Evening reminder** (automatic, **off until you switch it on**). The evening before a visit (17:00 to 19:30 Irish time, never at night), customers who were sent a confirmation and were not told in the last 4 hours get one reminder with the time they were told.
4. **Today** has a new seventh counter, **Tell customer**: visits nobody told (confirmation, a moved time, a cancellation) and messages WhatsApp gave no answer to. Each card has the send button; it leaves by itself once the customer was told.
5. **Installation.** A project's installation date is one entry in the calendar (08:00 to 16:00 on the day; you can edit the time). Set it, move it, clear it or delete the project and the entry follows. If it overlaps another visit you get a warning ("Heads up: it overlaps Brian Kelly at 11:00"), never a block. Moving or cancelling the entry in the calendar changes the project's date too. **No message is ever sent about an installation.**

## Exactly once, and never a surprise
- Every message has a **claim** made in a transaction **before** WhatsApp is contacted: confirmation = one per visit; change = one per version of the visit; cancellation = one per visit; reminder = one per start time. A double click, a retry, two people or two overlapping sweeps send **one** message.
- **Do not contact** is checked inside the claim (same as every other send in Elite OS). Customers who said stop get no button and no message.
- WhatsApp **refuses** (for example the template is not approved yet): nothing is recorded as told, the chat is untouched, the reason is shown in plain words, and the button works again. The automatic reminder retries a refusal at most 3 times, 30 minutes apart.
- WhatsApp gives **no answer**: the message is **never sent again by itself** (it may have arrived). The visit and Today say "WhatsApp did not say whether the last message arrived. Check the chat." with **It arrived** (the customer is recorded as told) and **It did not arrive** (the button works again). Nothing is sent by pressing them.
- Inside the 24-hour window the words go as a normal message; outside it, as the approved template. If a template is not set up and the window is closed, nothing is sent and the screen says so.
- Messages use the **town only** (never the full address) and no internal notes.

## What changed in the code
| Where | What |
|---|---|
| `functions/lib/bookingRules.js` (+ identical `public/booking-rules.js`) | Which message a visit needs next (pure; the server and the screen use the same file) |
| `functions/lib/bookingNotices.js` | The claims, the sending, `resolveNotice`, the evening reminder sweep and its Irish-time window |
| `functions/lib/installVisits.js` | The installation entry of a project |
| `functions/lib/appointments.js` | Type `installation`; moving or cancelling an installation entry changes its project's date in the same transaction |
| `functions/lib/projects.js` | Saving an installation date or deleting a project updates the entry in the same transaction |
| `functions/lib/store.js` | Erasing a customer also erases their message records |
| `functions/lib/handlers.js`, `functions/index.js` | New callables `sendBookingNotice`, `resolveBookingNotice` and the schedule `bookingReminderSweep` (every 15 minutes) |
| `functions/lib/whatsapp.js`, `reopen.js` | `sendText` accepts the time limit used by every other send; `refusalText` is exported |
| `public/appointments.js`, `today-model.js`, `today.js`, `index.html`, `app.css`, `projects.js` | The buttons, the dialog, the Today counter and cards, the installation type and the project's calendar note |
| `scripts/deploy-quote-sending.sh` | New stages `bookings` and `reminders on|off`; `live` waits for `bookings` |

No new Firestore index; no security-rule change (the existing rule already lets staff read and nobody write from a browser); no new secret. The three new settings are plain values with defaults (see `docs/WHATSAPP_APPOINTMENT_TEMPLATE.md`).

## Where it differs from the approved plan (all small, all to be safer)
- **No reminder within 4 hours of telling the customer.** The plan said a visit booked at 18:00 for tomorrow gets its reminder straight away; that would send a confirmation and a reminder 15 minutes apart. Now the reminder waits until the customer was told at least 4 hours earlier.
- **Change and cancellation share ONE template** (the news is a variable), so you submit **three** templates, as planned, not four.
- **"It arrived / It did not arrive"** (above) was added so a message WhatsApp gave no answer to can never be stuck.
- **Today has seven counters** (four per row on a phone) instead of six.
- A visit just booked is not listed on Today for 2 hours (you are still on it) unless it is within 48 hours.

## Settings (all in `functions/.env.elite-kitchens-lead-os`; defaults shown)
`BOOKING_CONFIRM_TEMPLATE=elite_kitchens_consultation_confirmed`, `BOOKING_CHANGE_TEMPLATE=elite_kitchens_consultation_changed`, `BOOKING_REMINDER_TEMPLATE=elite_kitchens_consultation_reminder`, `BOOKING_TEMPLATE_LANG=en`, **`BOOKING_REMINDERS=off`** (the kill switch; `./scripts/deploy-quote-sending.sh reminders on|off`).

## Release steps (each needs the owner's approval; nothing has been run)
1. Submit the three templates to Meta (`docs/WHATSAPP_APPOINTMENT_TEMPLATE.md`). The buttons work inside the 24-hour window without them.
2. **Merge** `phase-12-bookings` into `main` and push.
3. **Cloud Shell:** `./scripts/deploy-quote-sending.sh bookings` (new functions; the appointment, project, erase and calendar functions). Does **not** deploy the webhook. Sends nothing.
4. **Cloud Shell:** `./scripts/deploy-quote-sending.sh live`. Reload Elite OS.
5. **Test with your own number** (below), then, when the templates are approved, `./scripts/deploy-quote-sending.sh reminders on`.

**Your test (one message to your own phone):** book a visit for yourself (a customer record with your own number, last message from you less than 24 hours ago), press *Send confirmation…*, check your phone; move the visit, press *Send the new time…*; cancel it, press *Send cancellation message…*. Then set a project's installation date and look for the "Installation" entry in the shared Google Calendar (it can take up to 5 minutes).

## Undo
| Problem | Fix |
|---|---|
| The screen is wrong | Firebase console > Hosting > Release history > Rollback |
| Reminders misbehave | `./scripts/deploy-quote-sending.sh reminders off` (1 minute); nothing else is affected |
| The new functions misbehave | the line the `bookings` stage prints: `git checkout f074b8c -- functions`, redeploy the six changed functions, and `firebase functions:delete sendBookingNotice resolveBookingNotice bookingReminderSweep ...` |
| Data | Nothing needs repairing: message records and the installation entries are only extra records. A message that already went cannot be recalled. |

## Known limits (small, documented)
- An installation is **one calendar entry on one day** (up to 8 hours). A multi-day installation is one entry on its first day; add more by hand.
- The calendar entry for an installation reaches Google within about 5 minutes (the existing sweep), not instantly.
- The reminder covers visits **tomorrow** only, and only customers who were sent a confirmation here. A customer you confirmed by typing in the chat gets no reminder (press the button once, or tell them yourself).
- Customers who wrote more than 24 hours ago get the reminder as a **template** (WhatsApp charges a few cents for each template message outside the window; please check Meta's current price list for Ireland).
- Today lists visits starting from 8 hours ago, up to 400 (the same limit as before).
- The words of the messages exist in two places: the code and the approved template at Meta. If you edit a template at Meta, tell me so the copy stays identical.

## Tests
(See the table at the end; filled in when the last run finished.)
