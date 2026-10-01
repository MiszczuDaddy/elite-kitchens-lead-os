# Phase 4 — Lightweight CRM / sales pipeline

A simple pipeline on top of the existing customers and conversations. No new collections, no new indexes, no rule changes, no migration.

## The pipeline

New lead → Booked → Quoted → Won → Closed.

| Shown as | Stored as `conversations/{phone}.inboxStatus` |
|---|---|
| New lead | `inbox` (or missing) |
| Booked / Quoted / Won | `booked` / `quoted` / `won` |
| Closed | `closed` |

* **Closed means a lead that is no longer active and did NOT become a customer** (declined, stopped responding, chose someone else, not suitable, we decided not to proceed). It is never used for a finished job.
* **Won stays Won**, also after the kitchen is built. Completed-job tracking belongs to a future projects phase, outside the sales pipeline.
* The stored value `inbox` is unchanged so nothing needed migrating; only the label changed (Inbox status chips and the status selector say "New lead"). The Inbox screen itself keeps its name.
* New Meta leads (Phase 3) still arrive with no status, i.e. New lead. `leadIntake` was not touched.

## Data

| Where | Field | Meaning |
|---|---|---|
| `conversations/{phone}` | `stageDates.booked / quoted / won / closed` | Timestamp of the **latest** time the customer entered that stage. Set by the server. |
| `contacts/{phone}` | `quoteValue` | Whole euros (1 – 1,000,000), entered manually. Cleared with an empty value. |

* "Lead created" is the existing `createdAt` (form submission time for Meta leads, first message time for WhatsApp customers). There is no date for New lead because of that.
* `setConversationStatus` writes the stage date in the same transaction as the status. Choosing the stage a customer is already in writes nothing, so a double click cannot move a date. Moving a customer backwards keeps their earlier dates (history) and only the current stage drives the counts.
* `updateContact` accepts an optional `quoteValue` (a whole number or empty). All existing fields behave exactly as before. Staff cannot write dates or status through it; the browser still cannot write to Firestore at all.
* `quoteValue` is deliberately separate from `budget`: budget is what the customer said (free text from the Meta form), quote value is what we quoted. Nothing is ever calculated from budget.

## Existing customers

Customers created before Phase 4 have no `stageDates` and no `quoteValue`. They show a dash / no age and keep working everywhere. Nothing is backfilled or guessed. Their **current stage** is always counted; **date-based** numbers (e.g. "won this month") only include customers who have a date, so the all-time view includes undated customers by their current stage and a specific month does not.

## The Pipeline screen

* Left rail **Pipeline** (on a phone: the pipeline icon in the Inbox header). URL `#pipeline`.
* Five columns on desktop, one stage at a time (chips) on a phone. Rows show name, location · project type, quote value ("No value yet" nudge when Quoted without one), lead source, and days in the current stage.
* Click a row → the existing conversation and Details panel (Back returns to the pipeline on a phone). The `⋯` menu on a row moves it to another stage in one click (uses the existing status callable).
* Filters: search (name, location, project, source, Irish or international phone), lead source, date added (this month / last 30 days / custom range). The source filter also narrows the overview.
* The pipeline reads up to 1,000 customers while the screen is open (the Inbox list keeps its own 300). If that limit is ever reached the screen says so.
* Quote value is edited in the customer's Details panel under Project. Typing `€14,500`, `14500` or `14.5k` all work.

## Drag and drop, and stage colours

* **Desktop:** drag a card from one column to another. The card fades, and only the destination column gets a very faint tint of its stage colour with a hairline outline. Dropping on the card's own column does nothing. The ⋯ menu is still there and is the only method on phones (cards are not draggable below 900px wide).
* **One code path:** drag-and-drop and the menu both call the same `move()` in `pipeline.js`, which calls the existing `setConversationStatus` callable. That callable stamps the stage date, so dates and every overview number behave identically for both.
* **Safe by construction:** a card is shown in its new column straight away (dimmed) and cannot be moved again until the save finishes (one request per customer at a time). If the save fails it returns to its original column with a message such as "Could not move X to Booked. They are back in Closed". The live data replaces the temporary position as soon as it arrives. The board does not redraw while a card is being dragged or a menu is open.
* **Colours:** a small dot beside each stage name (New lead grey, Booked soft blue, Quoted soft amber, Won soft green, Closed muted red), plus a very pale permanent tint behind each column (about 5%) so the five stages are obvious at a glance, even when a column is empty. Columns are tall (they fill the screen) so the boundary is clear. While a card is dragged over a column, that column's own tint becomes about twice as strong. Cards and the page background stay uncoloured, there are no borders or shadows on the columns, and the stage name is always shown next to the dot. On a phone the one visible stage has the same pale tint as a soft band. Strengths live in `app.css` (`--tint` / `--tint-drag` per stage). They are defined once as `--st-*` variables in `app.css`.

## Overview numbers

Chosen period: this month (default), last 30 days, all time (Irish calendar days, Europe/Dublin).

* **New leads** — customers created in the period.
* **Booked / Quoted / Won** — customers who entered that stage in the period (a Won customer later moved back out of Won is not counted as a win). Quoted and Won also show the total quote value.
* **Open quotes** — what is in Quoted *right now* (total value, count, and how many have no value yet). Not period-based.
* **Average job** — total Won value ÷ Won jobs that have a value.
* **Lead → Booked** and **Quote → Won** — measured on the leads created in the period, so they can never exceed 100%. With fewer than 5 customers the screen shows "3 of 4" instead of a percentage.

## Tests

* Backend (`npm test`): stage dates, quote value validation, existing fields unchanged, Phase 3 leads still start as New lead, security rules (`functions/test/crm.test.js`); the pipeline maths incl. old-shape customers, Closed = lost, Dublin months across the clock change (`functions/test/crm-metrics.test.js`).
* Browser (`bash test-ui/run.sh dnd.e2e.js`): real mouse drags, destination highlighting and clean-up, one request identical to the menu's, stage date and overview update, same-column drop, failed save rolls back with a message, second drag while saving is blocked, phone has no drag and shows the colour dots.
* Browser (`bash test-ui/run.sh crm.e2e.js`): the pipeline screen, moves, quote value, filters, overview, phone layout, and a Meta lead arriving through `leadIntake` landing in New lead. `bash test-ui/run.sh` (Phase 2) and `lead.e2e.js` (Phase 3) must still pass.
* One existing backend test was updated on purpose: it asserted that a status change writes *only* `inboxStatus`; it now allows the new stage date and still asserts that nothing else (activity, unread, preview, contact, messages) changes.

## Deploy and rollback

Order matters: the two backward-compatible functions first, then the screen.

1. `./scripts/deploy-crm.sh backend` — only `setConversationStatus` and `updateContact`; saves their current revisions. The existing live screen keeps working.
2. `./scripts/deploy-crm.sh preview` — new screen on Hosting preview channel `phase4` (it uses live data; edits made there are real).
3. After approval: `./scripts/deploy-crm.sh live` (production Hosting).

Rollback: `./scripts/rollback-crm.sh` (functions, seconds); Hosting via the console's release history, or redeploy tag `phase-3-meta-leads-complete`. `firebase.json` now lists `crm.js` and `pipeline.js` in the no-cache headers so a deploy cannot serve a mix of old and new files.

Not touched: `leadIntake`, the webhook, sending/receiving, media, deletion, retention, authentication, security rules, Make, Meta.

## Not in this phase

Quoting/invoices, projects/job status after Won, reminders ("quotes going cold"), a timeframe field (the Meta answer is already kept in Notes), exports.
