# Calendar day agenda

The month remains the overview. Selecting a date displays its agenda beside the month on desktop (1200px and above), or below it on smaller screens. Today selects today's date; the agenda's day controls and the date buttons' arrow keys navigate across month boundaries. Returning from a customer preserves the selected date.

Calendar appointment chips and “+N more” reveal appointments in the agenda. Desktop details expand inline; phone details open in a full-width sheet. Details include appointment type, location, internal notes, Google sync state and the existing customer, edit, reschedule and cancel actions. List view remains available.

On desktop with a mouse, drag an appointment chip or agenda entry onto another calendar day to open the reschedule form with that date selected. Irish start time and duration are preserved. The user must confirm the move; closing the form changes nothing. Past dates, unchanged dates, cancelled appointments and external drag data cannot initiate a move. Updates received during the drag are checked before opening the form; subsequent conflicts use the existing expected-version guard. Mobile and keyboard users retain the Reschedule action. For dates outside the visible calendar, use the form's date picker.

“Book appointment” opens a customer chooser using the existing loaded inbox across all stages, then the existing booking dialog with the selected date. Results are capped at 20 until narrowed by name, phone or location. This does not introduce a new customer search backend. Booking from a customer profile still works as before.

All saves use the existing callables, request IDs and expected-version checks. A pending save blocks repeated submission and dismissal. Details-only edits say “Appointment updated”; time changes say “Rescheduled for”. Google remains a one-way copy of Elite OS. Internal notes remain private to Elite OS.

No availability guarantees, free-slot suggestions, business hours, staff assignment, travel calculations or automatic conflict prevention are introduced. Calendar loading failures and the existing 500-result limit are explained in the agenda rather than presented as an empty day.

## Focused checks and local preview

Run `bash test-ui/run.sh appointments.e2e.js` with Node, Java and Playwright/Chrome available. This runs only appointment UI checks using the demo Firebase emulators and a fake Google Calendar.

Set `CALENDAR_PREVIEW=1` to keep the local test server and emulators running after the checks pass. Open `http://127.0.0.1:5055/#appointments`; the preview signs into a synthetic demo staff account automatically. It is local to this computer and uses no production customer data. To stop it gracefully in PowerShell, run `Invoke-WebRequest -Method Post -Headers @{'X-Elite-Preview'='stop'} http://127.0.0.1:5055/__stop-preview`. The harness then stops its emulators and removes their temporary configuration files. If the process is force-terminated instead, remove the harness-generated `functions/.env.local` and `functions/.secret.local` before further work.

Screenshots are generated under `test-ui/shots` (or `SHOTS_DIR`). No preview code or automatic login is added to the production frontend.
