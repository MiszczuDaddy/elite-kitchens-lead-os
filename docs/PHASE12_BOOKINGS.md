# Phase 12: the evening-before visit reminder, and installations in the calendar (build record)

**Change of plan, 19 Oct 2026 (the owner's decision):** the confirmation, new-time and cancellation messages were **removed**. Phase 12 now has two things: the **automatic evening-before WhatsApp reminder** (one Meta template: `elite_kitchens_consultation_reminder`) and **installation dates in the calendar**. The reminder stays **OFF** until the owner approves switching it on. Branch `phase-12-bookings`, on top of `main` `f074b8c`. **Nothing here is deployed.**

## What it does (plain words)
1. **Evening reminder, by itself.** Between **17:00 and 19:30 Irish time**, the evening before a consultation or site visit, the customer gets one WhatsApp reminder ("Hi Anna, a reminder that your consultation with Elite Kitchens is tomorrow, Wednesday 21 October at 10:00. If you need to change it, just reply to this message. See you then!"). **Nobody presses anything.** Booking, moving or cancelling a visit sends nothing.
2. **Who gets one:** every customer with a **scheduled consultation or site visit tomorrow**, once per visit time. Not for visits booked or changed in the last 4 hours (the customer has just heard the time), not for cancelled visits, not for "Other" or "Installation" visits, and **never for a customer marked do-not-contact**.
3. **A moved visit** has a new time, so it is reminded the evening before the new time (the old time is never reminded twice).
4. **When it goes wrong, you can see it.** On the visit (customer profile, Appointments list, day and week view) and on **Today** (a red **Reminder check** card):
   - *WhatsApp refused it* (for example the template is not approved yet): the visit says why. Elite OS tries again 30 minutes later, up to 3 tries in all. After that it stays visible so you can message the customer yourself.
   - *WhatsApp gave no answer*: it may have arrived, so Elite OS **never sends it again by itself**. You look at the chat and press **It arrived** (the visit is recorded as reminded) or **It did not arrive** (the next check may try again). Pressing either sends nothing.
5. **Installation.** A project's installation date is **one entry in the calendar** (08:00 to 16:00 on the day; you can edit the time). Set it, move it, clear it or delete the project and the entry follows. If it overlaps another visit you get a warning ("Heads up: it overlaps Brian Kelly at 11:00"), never a block. Moving or cancelling the entry in the calendar changes the project's date too. **No message is ever sent about an installation.**

## Safety (what is guaranteed, and tested)
- **No duplicate reminders.** Every reminder has a claim made in a transaction **before** WhatsApp is contacted, keyed on the visit and its start time. Two checks at the same moment send **one** message.
- **Do not contact** is checked inside the claim, like every other send in Elite OS.
- **Never at night.** The check runs every 15 minutes but sends only between 17:00 and 19:30 Irish time (clock-change days are tested: the last Sundays of March and October).
- **The kill switch.** `BOOKING_REMINDERS` is **off** by default. Nothing is sent until you switch it on; switch it off at any moment.
- **Inside the 24-hour window** the words go as a normal message; **outside it** as the approved template. If the template is not set up and the window is closed, nothing is sent.
- The message holds only the first name, the kind of visit, the date and the time: no address, no notes.

## What changed in the code
| Where | What |
|---|---|
| `functions/lib/bookingRules.js` (+ identical `public/booking-rules.js`) | Who is due a reminder, and the words for the screen (pure; the server and the screen use the same file) |
| `functions/lib/bookingNotices.js` | The claim, the sending, the 3-try retry, "it arrived / it did not arrive", and the 15-minute reminder check with its Irish-time window |
| `functions/lib/installVisits.js` | The installation entry of a project |
| `functions/lib/appointments.js` | Type `installation`; moving or cancelling an installation entry changes its project's date in the same transaction |
| `functions/lib/projects.js` | Saving an installation date or deleting a project updates the entry in the same transaction |
| `functions/lib/store.js` | Erasing a customer also erases their reminder records |
| `functions/lib/handlers.js`, `functions/index.js` | New callable `resolveBookingNotice` (sends nothing) and the schedule `bookingReminderSweep` (every 15 minutes) |
| `functions/lib/whatsapp.js`, `reopen.js` | `sendText` accepts the time limit used by every other send; `refusalText` is exported |
| `public/appointments.js`, `today-model.js`, `today.js`, `app.css`, `projects.js` | The one-line reminder status on a visit, the Today "Reminder check" card, the installation type and the project's calendar note |
| `scripts/deploy-quote-sending.sh` | New stages `bookings` and `reminders on|off`; `live` waits for `bookings` |
| `scripts/booking-check.js` | Read-only: what the reminder would do right now, from the real data |

No new Firestore index; no security-rule change (staff can read and nobody can write from a browser, as before); no new secret. Three plain settings with defaults, in `functions/.env.elite-kitchens-lead-os`: `BOOKING_REMINDER_TEMPLATE=elite_kitchens_consultation_reminder`, `BOOKING_TEMPLATE_LANG=en`, **`BOOKING_REMINDERS=off`**.

## Removed on 19 Oct 2026 (so nobody looks for them)
The *Send confirmation*, *Send the new time* and *Send cancellation message* buttons and window, the callable `sendBookingNotice`, the two templates `elite_kitchens_consultation_confirmed` and `elite_kitchens_consultation_changed`, the settings `BOOKING_CONFIRM_TEMPLATE` and `BOOKING_CHANGE_TEMPLATE`, and the rule that a reminder needed a confirmation first. The "Tell customer" Today counter became **Reminder check** (only reminders that did not go). A test checks that none of them exists.

## Release steps (each needs the owner's approval; nothing has been run)
1. Create and submit the one template at Meta (`docs/PHASE12_META_TEMPLATES_GUIDE.md`). Inside the 24-hour window the reminder needs no template.
2. **Merge** `phase-12-bookings` into `main` and push.
3. **Cloud Shell:** `./scripts/deploy-quote-sending.sh bookings` (the new functions; the appointment, project, erase and calendar functions). Does **not** deploy the webhook. Sends nothing. The reminder stays off.
4. **Cloud Shell:** `./scripts/deploy-quote-sending.sh live`. Reload Elite OS.
5. **Check what it would do:** `node scripts/booking-check.js` (read-only).
6. **Switch it on, with the owner's approval:** `./scripts/deploy-quote-sending.sh reminders on`. The first real reminder goes at the next evening check (17:00 to 19:30) for a visit the next day.

**The test with your own number:** make a customer record with your own number, book yourself a consultation for tomorrow morning, and (with the owner's approval) switch reminders on. Between 17:00 and 19:30 the reminder arrives by itself. Do it on a day when you have not written to the Elite OS number for 24 hours to test the template path, and on a day when you have to test the normal-message path.

## Undo
| Problem | Fix |
|---|---|
| Reminders misbehave | `./scripts/deploy-quote-sending.sh reminders off` (1 minute); nothing else is affected |
| The screen is wrong | Firebase console > Hosting > Release history > Rollback |
| The new functions misbehave | the line the `bookings` stage prints: `git checkout f074b8c -- functions`, redeploy the changed functions, and `firebase functions:delete resolveBookingNotice bookingReminderSweep ...` |
| Data | Nothing needs repairing: reminder records and installation entries are only extra records. A message that already went cannot be recalled. |

## Known limits (small, documented)
- A visit booked less than 4 hours before the check, or booked after 19:30 for the next morning, gets **no reminder** (the customer has just been told the time).
- A customer you have **never** reached on WhatsApp still gets the reminder as a template, which WhatsApp charges a small amount for outside the 24-hour window (please check Meta's current price list for Ireland); inside the window it is free.
- An installation is **one calendar entry on one day** (up to 8 hours). A multi-day installation is one entry on its first day; add more by hand. It reaches Google within about 5 minutes (the existing sweep).
- Today lists visits starting from 8 hours ago, up to 400 (the same limit as before).
- The words of the reminder exist in two places: the code and the approved template at Meta. If you edit the template at Meta, tell me so the copy stays identical.
- Today's "Reminder check" does not know about a do-not-contact customer whose chat is older than 60 days; the server still refuses to send, so nothing is sent.

## Tests
(See the table at the end; filled in when the last run finished.)
