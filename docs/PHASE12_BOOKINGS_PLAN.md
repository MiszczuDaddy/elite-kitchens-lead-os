# Phase 12: Bookings customers can rely on (PLAN, for the owner's approval; nothing is built)

Written 18 Oct 2026 after reading the real code (`appointments.js`, `reopen.js`, `windowState.js`, `outbound.js`, `calendarSync.js`, `projects.js`, `docs/WHATSAPP_APPOINTMENT_TEMPLATE.md`).

## 1. What you get
1. A **"Send confirmation"** button when you book or move a visit. The customer gets one clear WhatsApp message with the date, time and area.
2. A **change / cancel notice** the same way, when you move or cancel a visit the customer was already told about.
3. A **reminder the evening before**, sent automatically, never at night.
4. A new visit type, **Installation**. A project's installation date creates, moves or removes its calendar entry by itself, and warns you about a clash.
5. A message that cannot be sent (no approved template, customer said stop, WhatsApp refused) is **shown to you** (on the visit and on Today), never lost quietly.

## 2. What already exists and is reused
- Visits (book, move, cancel, history, Google Calendar copy every 5 minutes) are done in Phase 5. Nothing there is rewritten.
- The sending safety from Phase 6.1 and 10: every message is **claimed before it is sent**, so a double click, a retry or two people can never send twice; a send WhatsApp does not confirm is flagged and **never retried by itself**; "do not contact" refuses every send.
- The 24-hour window rule (`windowState.js`): inside the window a normal text goes; outside only an approved template can go.
- The prepared template wording (`docs/WHATSAPP_APPOINTMENT_TEMPLATE.md`): confirmed and changed. I will add the reminder (and a cancelled one).

## 3. How each message behaves
| Message | Sent when | Inside 24 h | Outside 24 h |
|---|---|---|---|
| Confirmation | you press the button | normal text | approved template `elite_kitchens_consultation_confirmed` |
| Changed / cancelled | you press the button after a move or cancel | normal text | `elite_kitchens_consultation_changed` (cancel wording inside it) |
| Reminder | automatically, evening before | normal text | `elite_kitchens_consultation_reminder` |

- **Exactly once:** confirmation = one per visit; change = one per version of the visit; reminder = one per visit start time. A moved visit gets a new reminder for the new time and the old one is never sent.
- **No approved template yet:** the visit is still saved, **nothing is sent**, and the screen says why. Nothing breaks.
- **Wording:** plain, no emoji, no links, town only (not the full address), so Meta treats it as a utility message.
- **Test customers / your own number:** the reminder sweep skips visits marked "Other".

## 4. The reminder
- A check every 15 minutes. It looks at visits starting **tomorrow** (Irish time) that are still scheduled.
- It sends between **17:00 and 19:30** the evening before. Never earlier than 17:00, never after 19:30, never at night.
- A visit booked **after 19:30 for the next morning** gets no reminder (the customer was just told; the confirmation covers it). A visit booked at 18:00 for tomorrow gets its reminder straight away, once.
- Clock-change days (the last Sundays of March and October) are tested explicitly.
- A kill switch in the settings file turns the reminders off at once without changing code.

## 5. Installations
- New type **Installation** (default 08:00 to 16:00 on the install date; you can edit it).
- Setting, moving or clearing a project's **installation date** creates, moves or cancels that calendar entry. One entry per project; it links to the project.
- **Clash warning** (a warning only, it never blocks you): another visit or install overlapping that day.
- It appears in the shared Google Calendar like any visit.
- **No customer WhatsApp for installs in this phase** (the template wording is about consultations). I suggest adding it later if you want it.

## 6. Decisions I need from you (my recommendation first)
1. **Confirmation:** a button you press (recommended), or sent automatically when you save a booking? Automatic is faster but a mistyped time reaches the customer at once.
2. **Reminders go to:** only customers who were sent a confirmation (recommended), or every booked customer?
3. **Reminder time:** evening before, 17:00 to 19:30 (recommended), or the morning of the visit at 08:00?
4. **Installs:** one calendar entry per project, no customer message (recommended). OK?
5. **Meta templates:** you submit three in WhatsApp Manager (Utility, English): confirmed, changed/cancelled, reminder. I will give you the final wording and the exact names to type. Approval usually takes from a few minutes to a couple of days. **Until they are approved, only the in-window text messages work.**

## 7. Build steps (each tested before the next)
| Step | What | Size |
|---|---|---|
| M1 | The rules and the exactly-once engine, no screen: who gets what, when; claim-then-send; windows; templates missing; do-not-contact; clock changes. Server tests with a pretend WhatsApp. | medium |
| M2 | The buttons and status on the visit screen and on Today ("confirmation not sent", "not confirmed"). | small |
| M3 | The evening reminder check and its kill switch. | small |
| M4 | The Installation type and the project link, clash warning. | medium |
| M5 | Docs, the deploy stage `bookings` (with rollback), a read-only check script, independent review. | small |

Tests: server tests with a pretend WhatsApp (never two confirmations, retry after a crash, an unconfirmed send is never repeated, the clock-change dates, a moved visit gets a new reminder only), screen tests, and **full regression plus an independent review**, because this sends customer messages.
**One real test message to your own phone, with your OK**, after the templates are approved.

## 8. Cost and risk
- **Cost:** no new Google Cloud service; one small scheduled check every 15 minutes (well inside the free allowance). WhatsApp charges per template message sent **outside** the 24-hour window (a few cents each; please check Meta's current price list for Ireland); normal texts inside the window are free.
- **Risks, and the answer to each:** a double message (claimed first, tested); a wrong time (the time comes from the saved visit, in Irish time, tested over both clock changes); a message to someone who said stop (refused by the same check as every other send); Meta rejects a template (the app keeps working and says so).
- **Rollback:** switch the reminders off in the settings file (instant); the deploy stage prints the undo line; Hosting rollback for the screen. No data is changed in a way that cannot be left alone.

## 9. Not in this phase
Customers booking themselves, customers confirming by replying "yes" (the chat is read by you as today), SMS, and WhatsApp messages for installs.
