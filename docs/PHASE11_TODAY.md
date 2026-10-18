# Phase 11: the Today tab

**Branch:** `phase-11-today` (from `main` at `5244e73`).
**Status:** built and tested on the branch. **Not merged, not pushed, not deployed.** The plan this follows is `docs/PHASE11_TODAY_PLAN.md`, with the owner's four refinements (below).

## What it is
A **Today** tab, first in the menu and the screen Elite OS opens on. It answers: "What do I need to do right now?"
- **A row of six counters** (Replies, Handovers, Book a visit, Quotes, Reminders, Leads to fix). A counter turns red when something in it is overdue. **Every counter is a button** that shows only that kind; press it again to see everything.
- **One list of things to do, most urgent first.** Each card opens the right customer, chat, booking form or quote.
- **New leads today:** a separate section listing every lead that arrived today, with one status each:
  - Contact failed
  - Needs you
  - AI handling
  - Contacted
- A small line of **visits today and tomorrow**, and the Phase 10 "system problems" line at the top.
- **"Coming up"** (later reminders) and **"Done today"** (with **Undo**) fold away at the bottom.

## The owner's four refinements
1. **Today is the default screen** when Elite OS opens (computer and phone). An address with a chat in it (for example a tapped notification) still opens that chat.
2. **Every counter is a clickable filter.**
3. **Done and Snooze for reminders and quote follow-ups only.** WhatsApp and booking tasks have no Done button: they leave **only when genuinely handled** (rules below). The existing "Not needed" on a visit request stays.
4. **Phone:** full-width cards edge to edge, larger text, buttons at least 44 px tall, counters in three columns, no sideways scrolling. A big "Today" button sits at the top of the Inbox.

## How the list is decided (nothing is a stored task)
Every card is **worked out from live data**, so it cannot be duplicated and it leaves by itself the moment the cause is gone.

| Card | Appears when | Leaves when | Urgency |
|---|---|---|---|
| **Reply waiting** | The customer wrote last, within 60 days; the customer is not Closed or Won; not "do not contact"; the message is not just a thank-you; and the receptionist, if on, has had 30 working minutes | A reply goes out through Elite OS (or the customer's chat changes stage to Closed/Won) | Amber at 30, red at 120 **working** minutes (08:00 to 20:00 Irish time) |
| **Receptionist handover** | The receptionist passed the chat to you in the last 14 days (the reason is shown in plain words) | A person writes after the hand-over; or, for "gave days for a visit", a visit is booked | Red at once for a complaint; otherwise as for a reply |
| **Book a visit** | The customer gave days and no visit is booked | The visit is booked, or you press "Not needed" | Amber after 2 working hours, red after a day |
| **Quote follow-up** | A sent, unanswered quote older than 5 days (within 60 days) | Accepted or declined; or you press **Followed up** (back in 5 days) or **Snooze** (1, 3 or 7 days). The snooze is tied to the date the quote was sent, so sending it again brings it back. | Amber at 5 days, red at 10 |
| **Reminder** | You added it, and it is due today or earlier | **Done**, **Snooze** (tomorrow, 3 days, next week, or pick a day), or Delete | Red when its day or time has passed |
| **Lead to fix** | A rejected Meta lead (Phase 10) or a welcome message that did not go | Added as a customer or Dismissed (same buttons as Needs attention); a failed welcome clears once a person or the customer has been in touch | Red |

**One card per customer.** If a customer needs a visit, was handed over and wrote last, that is **one** card headed by the most important reason, with the others as tags.

**Not hidden by the 300-chat limit.** Today asks the database directly (chats created today, contacts whose Meta lead came in today, chats waiting for a booking, chats with a customer message in the last 60 days, sent quotes, open reminders, and so on) instead of using the Inbox's 300 newest chats.

## New Leads Today: the statuses
A lead is anyone who first arrived **today** (Irish time): a Meta form, a new WhatsApp chat, or a customer added by hand.

- **Contact failed:** the welcome message was refused, or Elite OS could not confirm it went, and nobody has been in touch since.
- **Needs you:**
  - the receptionist handed it over;
  - the customer wrote and no one has answered;
  - a visit needs booking;
  - the welcome was held back because they asked not to be contacted;
  - nothing has been sent to them yet;
  - a rejected lead.
- **AI handling:** the receptionist is on for this chat and has not passed it to you.
- **Contacted:** everything else (the welcome went, or a person replied).

If several are true the most serious wins, in the order above. A lead that is **AI handling** or **Contacted** is listed only here and creates no task. One that **Needs you** or **failed** is also a card in the list.

## What is stored (the only new records)
- `reminders/{r_…}`: your own reminders (title, optional customer, day and optional time, open/done). A reminder's id comes from the request id, so pressing Add twice makes one.
- `todayMarks/quote_{id}`: "do not show this quote's follow-up until…", with the quote's sent time (read by the server, never the screen).

Both are written only by two staff-only functions (`saveReminder`, `snoozeQuote`) and read by the screen. **"Delete customer" erases the customer's reminders and quote notes.** No security rule changed.

## Cost, settings and security
- **No new Google Cloud setting and no new database index.** Every question the screen asks is a single-field one.
- **No new monthly cost.** The screen reads a few hundred records when opened and keeps about 11 live connections; this is well inside Google's free allowance.
- The WhatsApp webhook, the receptionist and quote sending are **not changed**.
- Nothing on Today sends a message to anyone.

## Settings chosen (the owner approved the design; these were my recommended defaults)
- Quote follow-up after **5 days** (red at 10); a reply is late after **30 minutes** and red after **2 hours**, counted only **08:00 to 20:00**.
- Closed and Won customers are not listed under "reply waiting"; hand-overs older than **14 days** are not listed.
- Visits today and tomorrow are shown as a small line.

All of these are plain numbers at the top of `public/today-model.js`.

## Release steps (each needs the owner's approval; nothing has been run)
1. **Merge** `phase-11-today` into `main` and push.
2. **Cloud Shell:** `./scripts/deploy-quote-sending.sh today` (the 2 new functions, and `deleteCustomer`). It does **not** deploy the webhook.
3. **Cloud Shell:** `./scripts/deploy-quote-sending.sh live` (it refuses until step 2 is done). Reload Elite OS.
4. **Check:** Elite OS opens on Today; add a reminder; mark it Done and press Undo.

**Undo:** Hosting rollback for the screen; for the functions, see the line the `today` stage prints.

## Tests
| File | What it proves | Result |
|---|---|---|
| `functions/test/today-model.test.js` (no emulator) | Every rule above, including the "must NOT show" cases and the working-hours clock. **Ten planted errors**: nine were caught; the tenth changed nothing (equivalent code). | 20/20 |
| `functions/test/today.test.js` (emulator) | Staff only; strict input; one reminder per request id; done, undo, snooze, delete; quote snooze tied to the server's sent time and undoable; erasing a customer; the browser cannot write these records | 8/8 |
| `test-ui/today.e2e.js` (real page, 450+ chats) | Opens on Today; every task type with its text; closed customers and thank-yous absent; a lead that is **not** among the Inbox's 300 newest chats is listed; counters filter; open a chat and come Back to Today; cards leave by themselves only when handled and return on a new message; reminders add, snooze, done, undo; quote Followed up and Undo; rejected-lead buttons; the phone view | 11/11 |
| `functions/test/scripts.test.js` | The new `today` stage: routing check before the question, never the webhook, `live` waits for it | passed |
| `functions/test/pwa.test.js` | The two new screen files are on the "always fresh" list | passed |
| Older browser suites (`ui`, `safety`, `appointments`, `quotes`, `assistant`, `pwa`, `projects`, `crm`) | Unchanged behaviour. They now press "Inbox" after signing in, because Elite OS opens on Today | see the build record |

## Known limits
- "Reply waiting" looks back **60 days**; an older unanswered chat is still in the Inbox.
- A message answered on your own phone, outside Elite OS, still counts as unanswered until Elite OS sees a reply.
- On the first day, older hand-overs and unanswered chats from the last 60 days will appear. That is correct, but it can look like a lot.
- A failed welcome is only checked for **today's** leads.
- The Inbox's own "Needs booking" count still only sees the 300 newest chats. Today does not have this limit. I suggest moving the Inbox badge to the same question later.
