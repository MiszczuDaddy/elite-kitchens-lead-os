# Phase 5 — Appointments and Google Calendar

Staff book, reschedule and cancel customer appointments in Elite OS. Elite OS is the source of truth. Every appointment is copied one way to a shared Google calendar, **Elite Kitchens Appointments**, owned by `info@elitekitchens.ie`, so everyone sees the diary on their phone. Nothing is ever read back from Google.

## What staff can do

### Book
Customer profile (Details panel) > Appointments > **Book appointment**:

| Field | Rules |
|---|---|
| Date and time | Irish time (Europe/Dublin), 15-minute steps. From 1 day in the past (a same-day appointment entered late) to 2 years ahead. A time that does not exist because the clocks go forward is refused. In the hour that happens twice when they go back, the later one is used. |
| Duration | 60 minutes by default, 15 minutes to 8 hours in 15-minute steps. |
| Type | Consultation (default), Site visit or Other. |
| Location | Prefilled from the customer's Location, editable, up to 200 characters. |
| Notes | Internal, up to 2,000 characters. **Never sent to Google.** |

Each dialog carries a request id, so a double click or a network retry still books exactly one appointment.

### The Appointments screen
Opened from **Appointments** in the side rail, or the calendar icon in the phone header.

* **Calendar | List** toggle. Calendar is the default on a desktop-width window and List on a phone (below 900px). The choice is remembered for that browser tab.
* **Calendar:** a Monday-first month with today highlighted and Previous / Today / Next. Each day shows up to three appointments (time, name, a subtle stage colour), then "+N more", which lists the whole day. On a phone the month shows dots, and tapping a day lists its appointments underneath.
* **Clicking an appointment** opens a card with Open customer, Reschedule and Cancel. A cancelled appointment only offers Open customer.
* **List:** upcoming appointments from today, grouped by day, with stage and Google Calendar status.
* Cancelled appointments are hidden unless **Show cancelled** is on.
* When any appointment could not be put in Google Calendar, a banner says how many and why, with **Retry now**.

### Reschedule, edit, cancel
* Reschedule or edit the type, location or notes from the card, the list's row menu or the customer profile. If someone else changed the appointment meanwhile, the save is refused with "This appointment was changed by someone else".
* Cancel asks for an optional reason (up to 300 characters). The appointment and its history are kept with status "cancelled". A cancelled appointment cannot be rescheduled: book a new one.
* Each appointment keeps its last 20 history entries (created, rescheduled, edited, cancelled: who and when).

### In the customer profile
The Appointments block lists the customer's upcoming appointments with their Google Calendar status, Reschedule and Cancel, plus "Show past and cancelled (N)".

## Pipeline stages
* Booking an appointment for a **New lead** moves them to **Booked** in the same transaction, with exactly the same rules as a manual move (`docs/CRM_PIPELINE.md`): the Booked date is recorded, and moving them straight back to New lead within 5 minutes counts as a correction.
* **Booked, Quoted, Won and Closed customers are not touched.** Closed stays Closed.
* Rescheduling and cancelling **never** change the stage.

## Google Calendar (one-way)

### What the event shows
* **Title:** "Consultation – Anna Murphy" (the type, then the customer's name, or the phone number if there is no name).
* **Time and location:** the appointment's.
* **Description:** the phone number, a link to the customer in Elite OS, and "Managed by Elite OS. Changes made here are not saved back."
* **Left out:** internal notes, attendees and invitations. Nobody is emailed, and everyone's own notification settings for the shared calendar apply.

Booking creates the event, a reschedule or edit updates the same event, and cancelling deletes it. Elite OS keeps the cancelled appointment. Changes made in Google are not read back: the next change in Elite OS overwrites them, and recreates an event someone deleted by hand.

### Status shown in Elite OS
| Shown | Meaning |
|---|---|
| In Google Calendar / Removed from Google Calendar | Google matches Elite OS. "Open in Google Calendar" opens the event. |
| Waiting to sync | Google has not caught up yet. Elite OS keeps trying on its own. |
| Not in Google Calendar / Not removed from Google Calendar | Elite OS gave up after 24 hours, or Google refused the event. Hover for the reason. Use **Retry now** once the cause is fixed. |
| Calendar sync off | Sync is switched off (`GCAL_SYNC=off`). Appointments work normally and are sent to Google when sync is switched back on. |

### Reliability
* The appointment is always saved first. Google is then updated straight away, waiting at most 8 seconds. A Google problem never fails or undoes a booking: the screen says "Google Calendar will update shortly".
* `calendarSweep` runs every 5 minutes (Europe/Dublin). It retries after 1, 5, 15, 30 and 60 minutes, then hourly. After 24 hours of failures the appointment is marked failed.
* **No duplicates:** each appointment has one event id, chosen by Elite OS and never changed. A retry checks Google first, then updates. A 60-second lease stops two attempts running at once, and a version check means Google always ends on the latest change.
* Each appointment stays on the calendar its event was first sent to. Changing `GCAL_CALENDAR_ID` affects new appointments only.

### Switches (`functions/.env.elite-kitchens-lead-os`, written by `scripts/deploy-appointments.sh`)
| Setting | Meaning |
|---|---|
| `GCAL_SYNC` | `on` or `off`. Off by default. |
| `GCAL_CALENDAR_ID` | The shared calendar's id (`…@group.calendar.google.com`). |
| `GCAL_SERVICE_ACCOUNT` | `ek-calendar@elite-kitchens-lead-os.iam.gserviceaccount.com` |

Sync runs only when all three are set and `GCAL_SYNC=on`. Changing them needs a redeploy of the calendar functions: `./scripts/deploy-appointments.sh sync on <id>` or `sync off`.

## Data

| Where | What |
|---|---|
| `appointments/{id}` | `phone` (links to `contacts/{phone}` and `conversations/{phone}`), `customerName`, `type`, `start`, `end`, `durationMin`, `timeZone`, `location`, `notes`, `status` (`scheduled` / `cancelled`), `version`, `requestId`, `movedToBooked`, `createdAt/By`, `updatedAt/By`, `cancelledAt/By`, `cancelReason`, `rescheduleCount`, `history` (last 20), `sync.google` (below) |
| `appointments/{id}.sync.google` | `state` (`pending` / `synced` / `retrying` / `failed` / `off`), `eventId`, `calendarId`, `created`, `syncedVersion`, `attempts`, `failingSince`, `nextAttemptAt`, `lastAttemptAt`, `syncedAt`, `lastError` (a short code only, never customer data), `htmlLink`, `leaseUntil` |
| `calendarCleanup/{eventId}` | Only a calendar id and an event id: a calendar event still to be removed after a customer was deleted while Google was unavailable. |

* The document id is derived from the phone number and the request id, so the same request always lands on the same document.
* **No rule or index changes.** The existing rules already let staff read every collection and stop any browser write. Every query uses a single field, so Firestore needs no new indexes.
* The browser only reads. Every change goes through the functions `createAppointment`, `updateAppointment`, `cancelAppointment` and `retryCalendarSync`.

## Deleting a customer
**Delete customer…** now also deletes the customer's appointments and their Google Calendar events.
* Each event is blanked first (title "Removed", no description or location) and then deleted. Google keeps deleted events in the calendar's trash for a while, and those copies hold no customer details.
* If Google is unavailable, a `calendarCleanup` record holding only the two ids lets the sweeper finish the job later. It keeps trying (at most hourly) until it succeeds and logs an error after 24 hours.
* This works while sync is off too, as long as the calendar account is set up. Anything that could not be removed waits until sync is on again.
* The audit entry adds the number of appointments deleted. The function's answer to the screen is unchanged.

## Security
* The four appointment functions are staff-only (signed in, `staff` claim, still in `ALLOWED_EMAILS`) and hold no WhatsApp secrets.
* `calendarSweep` is private: only Cloud Scheduler can call it. `deploy-appointments.sh backend` checks this and removes any public access it finds.
* **Keyless sign-in to Google.** The functions' own runtime account asks the IAM Credentials API for a one-hour token for `ek-calendar`, limited to the `calendar.events` scope. `ek-calendar` has no project roles and no keys. The organisation blocks key creation anyway.
* The calendar is shared for editing with `ek-calendar` only. People get "See all event details", which is read-only.
* Logs and stored errors contain codes and appointment ids only: no names, phone numbers or emails (tested).
* Everyone the calendar is shared with sees each appointment's name, phone number and location. Notes stay in Elite OS.

## One-time Google setup (the owner does this once)
The order matters: the service account must exist (C) before the calendars can be shared with it (D).

**A. Google Workspace Admin** (admin.google.com, as a super admin)
1. Apps > Google Workspace > **Calendar**: the service is **On**.
2. Calendar > Sharing settings > **External sharing options for secondary calendars**: **"Share all information, and outsiders can change calendars"**. Google treats the Elite OS service account as outside your domain, and so are people on Gmail. This affects secondary calendars only, never anyone's main calendar. It usually applies within minutes but can take up to 24 hours.

**B. Google Calendar, signed in as `info@elitekitchens.ie`**
1. Create **"Elite Kitchens Appointments"** with time zone (GMT+00:00) Dublin.
2. Create **"Elite Kitchens Appointments (TEST)"** for the rollout. It can be deleted afterwards.
3. For each calendar: its Settings > Integrate calendar > copy the **Calendar ID** (`…@group.calendar.google.com`).

**C. Google Cloud** (Cloud Shell, project `elite-kitchens-lead-os`)

    cd ~/elite-kitchens-lead-os && git fetch && git checkout phase-5-appointments && git pull
    ./scripts/setup-calendar.sh

This enables the Calendar, Cloud Scheduler and IAM Credentials APIs. It creates `ek-calendar@elite-kitchens-lead-os.iam.gserviceaccount.com` (no roles, no keys) and lets the functions' runtime account (`812360112616-compute@developer.gserviceaccount.com`) get tokens for it, and nothing else. It is safe to repeat. `./scripts/setup-calendar.sh --check` only shows what is in place.

**D. Share both calendars** (each calendar's Settings > Share with specific people or groups)
1. `ek-calendar@elite-kitchens-lead-os.iam.gserviceaccount.com`: **Make changes to events**. If that option is greyed out, setting A2 has not applied yet. Afterwards check that it is actually listed under "Share with specific people": a missing share shows up later as "the calendar was not found".
2. You, your dad and staff: **See all event details** (read-only), on the real calendar.

**E. Each person's phone**
1. Accept the share email. The calendar then appears in the Google Calendar app.
2. Set the calendar's notifications on your own phone (Elite OS adds none).
3. iPhone (Apple Calendar): also tick the calendar at calendar.google.com/calendar/syncselect.

## Rollout
Every step is run by the owner in Cloud Shell, after approval. Each functions step asks for "yes" and saves the revisions it replaces first.

0. **Clone on the Phase 5 branch:** `cd ~/elite-kitchens-lead-os && git fetch && git checkout phase-5-appointments && git pull`. The settings file `functions/.env.elite-kitchens-lead-os` from earlier phases must be there.
1. **One-time Google setup** (above).
2. **Backend, sync off:** `./scripts/deploy-appointments.sh backend`. This deploys the 4 appointment functions, `calendarSweep`, `deleteCustomer` and `setConversationStatus`. The output should include "private: ok" and "test run: the sweeper ran (ok)". The live screen is unchanged.
3. **Preview:** `./scripts/deploy-appointments.sh preview`. Open the printed preview address and sign in. It uses live data.
   * For testing, use a customer who exists only for testing. For example, message the business WhatsApp from your own phone: that creates a New lead conversation and sends nothing to anyone else.
   * Book an appointment for them. It should move to Booked and show "Calendar sync off".
4. **Sync on, TEST calendar:** `./scripts/deploy-appointments.sh sync on <TEST calendar id>`.
   * Within 5 minutes, step 3's appointment shows "In Google Calendar" and appears in the TEST calendar on the phones.
   * Book, reschedule and cancel another one, and watch the phones follow.
   * Then **remove all test appointments**: cancel them, or Delete customer on the test customer, which also tests that erasure removes their events. Each appointment stays on the calendar it was first sent to, so none should be left pointing at TEST.
5. **Sync on, real calendar:** `./scripts/deploy-appointments.sh sync on <real calendar id>`. Book one test appointment, check it appears in the real calendar on everyone's phone, then cancel it.
6. **Owner review** of Calendar and List on the preview.
7. **Live, only after approval:** `./scripts/deploy-appointments.sh live`. Then reload Elite OS. `firebase.json` serves `appointments.js` with no-cache, so the old and new screens never mix.
8. **After live is confirmed, and only with approval:** merge `phase-5-appointments` into `main` and tag `phase-5-appointments-complete`. Then put the Cloud Shell clone back on main: `git checkout main && git pull`.

Optional afterwards: delete the TEST calendar once no appointment points at it.

**Do not use `scripts/deploy-preview.sh` for Phase 5.** It deploys every function and makes all of them public, which would include the private `calendarSweep`. Before the one-time setup it would also try to deploy the sweeper without Cloud Scheduler.

## Day-to-day
* **Health:** the Appointments screen shows a banner when anything is not in Google Calendar. Logs, newest first:

      gcloud logging read 'jsonPayload.msg="calendar sync attempt failed"' --project elite-kitchens-lead-os --freshness=1d --limit=20 --format='value(timestamp,jsonPayload.code,jsonPayload.status)'
      gcloud logging read 'jsonPayload.msg="calendar sweep"' --project elite-kitchens-lead-os --freshness=1h --limit=5 --format='value(timestamp,jsonPayload)'

* **Someone joins or leaves:** Elite OS access is still `ALLOWED_EMAILS` plus a redeploy, as before. Calendar access is separate: share or unshare "Elite Kitchens Appointments" in Google Calendar.
* **Stop all writes to Google:** `./scripts/deploy-appointments.sh sync off` (a few minutes). Appointments keep working in Elite OS and are sent to Google when sync is switched back on.

### Troubleshooting
| What you see | Likely cause | Fix |
|---|---|---|
| Failed: "the calendar is not shared with Elite OS" | The calendar is not shared with `ek-calendar` with "Make changes to events", or Workspace setting A2 has not applied | Share it (D1), then **Retry now** |
| Failed: "the calendar was not found" (log code `not_found`, 404) | Most often the calendar is **not shared with `ek-calendar` at all**: Google then answers "not found" rather than "forbidden" (this happened during the rollout). Less often, a wrong calendar id | Check the calendar's sharing (D1) and add `ek-calendar` if it is missing. If the id was wrong: `sync on <correct id>`. Appointments already tried keep the wrong calendar, so cancel and rebook those |
| Failed: "Google sign-in failed" | The functions may not get tokens for `ek-calendar`, the IAM Credentials API is off, or `GCAL_SERVICE_ACCOUNT` is wrong | `./scripts/setup-calendar.sh`, then **Retry now** |
| Failed: "Google rejected the event" | Not expected | Check the logs above and report it |
| "Waiting to sync" for more than about 15 minutes | Google keeps refusing or is unreachable | Check the logs above. The code there matches one of the rows in this table. After fixing the cause, a Reschedule or any small edit tries again straight away (Retry now only appears once an appointment is marked failed) |
| "Calendar sync off" | `GCAL_SYNC=off` | `./scripts/deploy-appointments.sh sync on <id>` |
| "In Google Calendar" in Elite OS, but missing on a phone | The share was not accepted, the calendar is hidden, or (iPhone) it is not ticked in syncselect | Step E |
| The backend deploy warns "no sweeper run was logged", and the scheduler status shows code 7 or 16 | Cloud Scheduler may not call `calendarSweep` | Re-run `./scripts/setup-calendar.sh`, then `./scripts/deploy-appointments.sh backend` (it re-checks the sweeper's permissions) |

## Rollback
* **Functions, seconds, no rebuild:** `./scripts/rollback-appointments.sh` undoes the last `backend` or `sync on|off` deploy. `./scripts/rollback-appointments.sh --before-phase5` returns `deleteCustomer` and `setConversationStatus` to their revisions from before Phase 5's first deploy. Deleting a customer then no longer removes their appointments or calendar events.
* **The 4 appointment functions and `calendarSweep`** did not exist before Phase 5, so they have nothing older to go back to. The old screen never calls them. `sync off` stops every write to Google.
* **The screen:** Firebase console > Hosting > Release history > Rollback, or redeploy tag `phase-4-crm-complete`. The appointment data stays in Firestore and is simply not shown.
* **The calendar:** events already in Google stay there. Unshare the calendar from people to hide it, or delete it in Google Calendar as `info@`.

## Tests
* **Backend** (`npm test`, 36 of its tests are Phase 5):
  * `functions/test/appointments.test.js` (18): staff only; validation and the booking window; Dublin times either side of the clock change; New lead → Booked exactly like a manual move; other stages byte-for-byte unchanged; correction rules; a simultaneous stage change is never downgraded; double requests; reschedule, edit and cancel guards and history; Closed stays Closed; erasure; security rules; the extracted stage function makes the same decisions as before.
  * `functions/test/calendar.test.js` (18), against a local fake Google Calendar:
    * the agreed event content (no notes, no attendees); sync off, then catching up
    * Google down when booking; a lost answer; an event that already exists; rapid reschedules during an outage; a change made mid-push
    * cancel; the immediate push, the sweeper and Retry now all at once; 403 → retries → failed → Retry now; token problems
    * an event deleted by hand; erasure, including mid-push
    * no customer data in logs; staff-only retry; keyless token flow; valid event ids
* **Browser** (`bash test-ui/run.sh appointments.e2e.js`, 17 checks):
  * booking from Details (15-minute times, 60-minute default, New lead → Booked, one Google event with no notes); Quoted and Closed unchanged
  * Calendar default on desktop with today highlighted and stage colours; the card's actions; a busy day with "+1 more"; Previous / Today / Next; the Calendar | List toggle remembered after a reload
  * the List; reschedule; cancel; "Show cancelled"; Google down → Retry now
  * the Pipeline shows the booking; the phone layout (List default, compact calendar, no sideways scroll); no JavaScript errors
* All Phase 1–4 suites pass unchanged. The only edits to them were test-harness fixes, made in separate commits, with no assertion changed.

## Not in this phase
Two-way sync (edits in Google are never read back), invitations and attendees, customer reminders by WhatsApp or email, staff assignment and availability or double-booking checks.

## Future improvements
* **Day view (requested 2026-10-02, deferred):** clicking a day in the calendar should open a detailed day view, similar to Samsung Calendar or Google Calendar, with all of that date's appointments and fuller details for each. Today, a desktop day cell shows up to three appointments and its "+N more" opens a short list; on a phone, tapping a day lists it under the month. Not built in Phase 5.
