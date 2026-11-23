# Your phone calendar in Elite OS (23 Nov 2026)

Things you put in Google Calendar on your phone (a dentist visit, a job somewhere else, a family day) did not appear in Elite OS, so a customer could be booked on top of them. Now the **Appointments** screen also shows your business Google Calendar, in **purple**, beside the Elite OS appointments, so the two can never be mixed up.

## What you see
* **Month:** a day with phone events has a purple chip, **Phone · 3**, under the appointments (on a phone, a purple dot). The appointments look exactly as before.
* **The day list** (choose a day): the appointments first, then **From your phone calendar**, one purple row per event (time, title, place; all-day events first).
* **Week and Day:** purple dashed blocks in the time grid. An event that overlaps an appointment sits **side by side** with it, so a clash is visible at a glance. An all-day event is a **Phone: ...** line under the day's heading. The hours shown still follow the appointments only: an event at 06:00 does not stretch the day.
* Choosing a phone event opens a small **read-only** box: the time, the place and **Open in Google Calendar** (only when it is a real Google Calendar link). There is nothing to edit here: change it in Google Calendar.
* The bar above the calendar: a **Phone calendar** tickbox (hides them everywhere; remembered on that device), **when it was last updated and how many events**, and **Refresh now**. After a failed check it says why in plain words ("the calendar is not shared with Elite OS yet") and keeps showing what it already has.

## When it is read
**Once a day, at midnight Irish time** (as asked), and **Refresh now** on the Appointments screen whenever you want it sooner (not more than once every five minutes). An event you add at 9am shows up after the next midnight check, or at once with Refresh now.

## What is kept, and what is not
* Read-only: Elite OS **never creates, changes or deletes** anything in your calendar (its Google client has no way to: the code that reads it is the only part that talks to it, and a test fails if a change call appears).
* Kept: **title, place and time** (and a link back to the event). **Never the description, never the guests.** An event shared with "busy only" shows as **Busy**.
* A window: **14 days back to 6 months ahead**, repeating events as separate days. Older ones are tidied away.
* **Skipped:** cancelled events, events you declined, Google's "Home / Office" markers and contact birthdays, and the events **Elite OS itself** put in Google Calendar (so an appointment never shows twice).
* A check that fails (Google down, the calendar not shared) changes **nothing** already stored: a bad night never empties the screen.
* Stored in `externalEvents` and `externalSync/state` (staff can read; nobody can write from a browser: the same rule as every record).

## Putting it live
1. `./scripts/deploy-quote-sending.sh phonecal`: deploys the two new functions, **switched off** (`calendarImport`, the midnight check; `refreshPhoneCalendar`, the Refresh now button). Then `./scripts/deploy-quote-sending.sh live` (the screen).
2. In Google Calendar, signed in as your business account (on a computer, calendar.google.com): your calendar in the left list > the three dots > **Settings and sharing** > **Share with specific people or groups** > **Add people and groups** > paste the address the next command shows (the same Elite OS account that already writes your appointments) > permission **See all event details** (not "make changes") > Send.
3. `./scripts/deploy-quote-sending.sh phonecal on`: asks for the calendar's address (your business email), shows the sharing step again, asks you to type `yes`, switches it on and starts the first check. Open Appointments a minute later.

Kill switch: `./scripts/deploy-quote-sending.sh phonecal off`. Go back fully: `firebase functions:delete calendarImport refreshPhoneCalendar --region europe-west1 --project elite-kitchens-lead-os`.

Only works for what is in Google Calendar: an event stored only on the phone (not synced to Google) cannot be read.

## Tests
`functions/test/calendar-import.test.js` (10, emulator): what is kept and skipped (including summer time and all-day events), the midnight check, the next night (only changes written, deletions follow), old events tidied away, a bad night changes nothing, many pages, Refresh now's five-minute rule, staff only, the timer and the switch. `test-ui/phone-calendar.e2e.js` (9): in a real browser, the Month chip, the day list, the read-only box and its links, Week and Day blocks side by side with an appointment, the tickbox, the status line (ok, failed, not connected), Refresh now against a fake Google Calendar that is only ever READ, and a 375px phone. `functions/test/scripts.test.js`: the deploy stage.
