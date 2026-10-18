# Phase 10: Safety net

**Branch:** `phase-10-safety-net` (from `main` at `ead6662`).
**Status:** built and tested on the branch. Not merged, not pushed, not deployed. Every Google Cloud setting below waits for the owner's approval.

Approved scope (owner, 17 Oct 2026):
1. Automatic database backups and a written recovery procedure.
2. Fault alerts when Meta leads, WhatsApp messaging or the AI receptionist stop working.
3. Failed notifications that are visible on screen, with a reliable retry.
4. A do-not-contact switch that really blocks messages to the customer.
5. Rejected Meta leads shown in Elite OS, with the reason.

Rules for the build:
- Keep WhatsApp and the receptionist working exactly as now, unless a change is needed for safety.
- Make failures visible and fixable, not just written to a log.
- Add an automatic test for every feature.
- Put no customer details in alerts or logs.

---

## 1. What you will see

### The "Needs attention" bar and list
A bar at the top of the Inbox appears **only when something needs you**, for example "2 things need attention". It works on both phone and computer. Pressing it opens the **Needs attention** list, which has up to three parts:

| Part | What it shows | What you can do |
|---|---|---|
| **Problems** | A system fault, in plain words, with what to do about it. Examples: <br>• "WhatsApp is refusing Elite OS's access key" <br>• "No Meta leads have arrived for 7 days" <br>• "The receptionist is switched on but cannot answer" | **Mark as fixed**. If the fault is still there, the next check (within 10 minutes) puts it back. |
| **Alerts that did not reach your phone** | Chats the receptionist handed to you whose phone alert failed 3 times. | **Open chat**, or **Seen** (removes it from the list). |
| **Meta leads that could not be added** | A lead whose phone number was missing or wrong. It shows the name, email, the number exactly as typed, the form name, the date and the reason. | **Add as customer** (opens the usual form, already filled in; fix the number and save), or **Dismiss** (the lead's details are deleted). |

The same list also shows:
- when the backups were last tested (see section 4);
- when the system check last ran;
- the **lead warning setting**: "Warn me if no Meta lead arrives for [168] hours (7 days)". Set it to 0 to switch the warning off, for example while ads are paused.

You can open the list at any time from **Notifications → System health and backups**, even when nothing is wrong.

### Phone and email alerts for problems
- **Phone alert:** every new problem and every rejected lead sends one phone alert. It says only "Elite OS needs attention", with no names, numbers or message text. Tapping it opens the Needs attention list.
- **Email alert (optional):** a copy goes by email from info@elitekitchens.ie to the address(es) you choose (setting `ALERT_EMAILS`). It says only what kind of problem it is and "Open Elite OS". No customer details. With no address set, no emails are sent.
- **Fallback:** if a phone alert for a hand-over or a rejected lead cannot be delivered, the email is sent instead.

### Do not contact
- **In the customer's details:** a **"Do not contact…"** button, with an optional note (for example "asked on the phone").
- **When it is on:** a red note in the chat says who set it, when and why. The message box, attachments, Reopen and Suggest reply are switched off. The customer shows a "Do not contact" tag in the Inbox list.
- **To undo it:** press **Allow contact again** and confirm.
- **Set automatically:** when a customer writes something like "stop messaging me", "unsubscribe" or "don't contact me". This uses the same words the receptionist already recognises, and it works in every chat, even with the AI switched off. If the receptionist was handling the chat, it hands the chat to you and alerts you.

**What it blocks, checked on the server** (so a screen trick or an old screen cannot get round it):

| Way a message can leave Elite OS | Blocked |
|---|---|
| Typed reply, file or photo | ✅ |
| "New conversation" (the welcome template) | ✅ |
| "Reopen conversation" template | ✅ |
| Sending a quote by WhatsApp or email, including "Retry" | ✅ (nothing is sent; the send shows as failed with the reason) |
| Quote "Download PDF and mark as sent" (you send it yourself) | ✅ |
| The automatic welcome for a new Meta lead | ✅ (not sent; a note in the chat says why) |
| The automatic receptionist | ✅ (it does not answer; checked again at the moment of sending) |

**Not blocked, on purpose:**
- Booking a visit or the Google calendar. These are internal; nothing goes to the customer.
- "I sent it myself" for a quote already being sent. That only records what already happened.
- The customer can still write to you, and their messages arrive as normal.

---

## 2. What is checked, and when you are alerted

A new system check runs every **10 minutes** (`healthSweep`). Some faults are spotted at the moment they happen.

| Problem | How it is spotted | Clears by itself when |
|---|---|---|
| **No Meta lead** for the number of hours you set (168 = 7 days by default; "Mark as fixed" keeps it quiet for another full window, then it reminds once) | The time of the newest lead received. This catches Make stopping, the form breaking, or ads stopping. | A lead arrives |
| **Make is sending the wrong key** | Leads arrive with a key that does not match. Visits with no key at all, such as internet scanners, are ignored. | You mark it fixed (and the next lead gets in) |
| **More than 60 leads in an hour** (the safety brake was triggered) | The lead intake | You mark it fixed |
| **A lead crashed** while being processed | The lead intake | You mark it fixed |
| **WhatsApp refuses Elite OS's access key** | Any send gets "unauthorised" from Meta | A send works again |
| **WhatsApp has limited the business account** (blocked, payment problem, spam limit) | Meta's own error codes for these | A send works again |
| **WhatsApp refuses one of our approved templates** (deleted, paused or disabled) | Meta's template error codes | A send works again |
| **WhatsApp sends keep failing** | 3 sends in a row in 30 minutes that could not be confirmed | A send works again |
| **WhatsApp stopped reporting back** | Messages were sent more than 45 minutes ago, but no delivery tick has come back since. This usually means incoming messages are not arriving either (the webhook). | A delivery tick arrives |
| **The receptionist's 5-minute check has stopped** | Its last run is more than 20 minutes old while the receptionist is switched on | It runs again |
| **The receptionist is on but cannot answer** | It is switched on, but the AI, real customer data or reply suggestions is off, or the AI key is missing | The settings are fixed |
| **The AI budget is used up**, or **the AI keeps failing** | The receptionist had to hand a chat over for one of these reasons | The next automatic reply works |
| **No device is set up for alerts** | No phone or computer has alerts switched on | A device is switched on |
| **Alerts are failing** | The last 3 or more alerts in 24 hours all failed | An alert gets through |

Each problem alerts you **once** when it opens. If the phone alert does not get through, it is tried again at every check, up to 6 times (about an hour). After that it stays on screen marked "not delivered". A problem never alerts twice at the same time, even if two checks run together.

**Failed hand-over alerts:** today the receptionist tries a hand-over alert 3 times, records the failure, and nothing more happens. From now on the system check:
- tries the phone again up to 6 more times;
- sends the email fallback once;
- removes the item when the alert finally gets through, or when you press "Seen".

There is also a small bug fix: **tapping a hand-over alert now opens that chat.** Before, it only opened Elite OS.

---

## 3. Rejected Meta leads

A Meta lead with no usable phone number used to be recorded only in a hidden list, with no details.

Now it is also saved as a **lead that needs attention**, with only what is needed to follow it up:
- name;
- email;
- the number exactly as typed;
- area;
- form name;
- the date;
- the reason.

You also get one phone alert, and an email if alerts by email are set up.

- **If Make sends the same lead again with a corrected number,** it is added as a customer and the item clears by itself.
- **When you press Dismiss or Add as customer,** the name, email and number on the item are deleted straight away.
- **Handled items are removed completely after 30 days.**
- **Open items stay** until you deal with them.

---

## 4. Backups and recovery

### What protects the data
| What | Protection | Google Cloud setting (needs your approval) |
|---|---|---|
| Customer database (chats, customers, quotes, visits, projects, settings) | **Daily backup, kept 14 days** | A Firestore backup schedule |
| The same database | **"Go back in time" to any minute in the last 7 days** | Firestore point-in-time recovery (PITR) |
| Photos, PDFs and renders | **Deleted files can be brought back for 7 days** | Cloud Storage soft delete (usually on already for new buckets; the script checks) |

### The tools (all in `scripts/`, run from Cloud Shell)

**`./scripts/setup-backups.sh status`**
- Read-only: shows what is switched on, the newest backup, and the storage protection.
- Changes nothing.

**`./scripts/setup-backups.sh on`**
- Switches on the daily backups, point-in-time recovery, and 7-day storage soft delete.
- Asks you to type "yes".

**`./scripts/setup-backups.sh drill`**
- **Proves a backup can be restored.** It restores the newest backup into a **separate, temporary database**. The live database is never touched.
- It then counts the records in both. The counts should match, apart from anything added after the backup was taken.
- It records the result. Elite OS shows "Last restore test: 17 Oct: OK" in the Needs attention list.
- Finally it offers to delete the temporary database.
- Do this once after switching backups on, then every few months.

**`node scripts/restore-docs.js`**
- Brings back **chosen records** without touching anything else. For example, one customer deleted by mistake, or Quote Settings changed by mistake.
- It can read from either source:
  - a restored database (`--from-database`);
  - the database as it was at a past minute (`--read-time`, from point-in-time recovery).
- It shows what it would do first. It writes only with `--apply` and a typed "yes", and it never deletes anything live.

Step-by-step recovery for each case is in `docs/BACKUPS.md`.

**Why this is not a full "replace everything" restore:** Google restores a backup into a **new** database, never over the live one. Copying back only what was lost is safer: everything else that happened since is kept.

---

## 5. Costs (estimates; Google's price list decides)

| Item | Expected monthly cost | Why |
|---|---|---|
| Daily backups, kept 14 days | **under €1** while the database is under about 1 GB (it is far smaller now) | Charged per GB stored |
| Point-in-time recovery, 7 days | **under €1** | Charged per GB of past versions |
| A restore test | **a few cents each time** | Charged per GB restored, and the temporary database is deleted afterwards |
| Storage soft delete, 7 days | **pennies** | Deleted files are kept 7 more days |
| The 10-minute system check (`healthSweep`) | **€0** | It fits in the free allowance. It is the third scheduled job, and Google's free allowance is 3 per billing account. If your billing account has other scheduled jobs elsewhere, about €0.10. |
| Delivery-tick watcher (`healthOnMessageWrite`) | **€0** | One very short run per message change, well inside the free allowance |
| Extra database reads and writes | **€0** | A few hundred a day, inside the free allowance |
| Alert emails | **€0** | Sent through your Google Workspace mailbox |

**Total: expected under €2 a month.** The script shows the database size when you run `status`.

---

## 6. Security and privacy

- **No new access.** Staff can read the new records, like everything else. Nothing can be written from a browser; every change goes through a checked server function.
- **What alerts contain:** phone alerts carry only a meaningless id. Emails carry only the kind of problem and "Open Elite OS". Neither contains a name, number, message or email address. A test checks this.
- **What logs contain:** only error codes, never customer details (the same rule as before).
- **Rejected leads hold personal data** (name, email, the number as typed). That is the minimum needed to call them back. It is deleted as soon as the lead is handled, and handled items are removed completely after 30 days.
- **Do-not-contact** is kept on the customer's chat record. "Delete customer" removes it along with everything else. If that person later sends a new Meta form, that is a new request and the welcome is sent. (If you would rather keep a permanent "never contact" list, that is a separate decision.)
- **Backups contain customer data,** so they are protected by the same Google project access as the live database, and are deleted after 14 days. "Delete customer" cannot reach into an existing backup: a deleted customer disappears from backups within 14 days. This should be mentioned in your privacy notice.
- **Restore tools** run only from Cloud Shell, as the project owner. They are not part of the app.

---

## 7. What changes for WhatsApp and the receptionist (and what does not)

**Unchanged:**
- the webhook (**not redeployed**);
- the receptionist's wording, timing, checks and hand-overs;
- quote sending, Reopen and media;
- the welcome for new leads.

**Changed, for safety only:**
1. Any message to a do-not-contact customer is refused (section 1).
2. "Stop messaging me" now switches on do-not-contact in **every** chat. It used to only hand the chat over, and only when the AI had classed the message as a decline.
3. The receptionist no longer asks the AI anything for a do-not-contact chat, so no AI cost is spent on it.
4. Each WhatsApp send now also records its outcome for the health check: the time, plus success or an error code. This is capped at about one second and can never block or fail a send (tested).

---

## 8. Release steps (each needs the owner's approval; nothing has been run)

1. **Backups** (Cloud Shell), in this order:
   - `./scripts/setup-backups.sh status`
   - `./scripts/setup-backups.sh on`
   - after the first daily backup exists (the next day): `./scripts/setup-backups.sh drill`
2. **Server:** `./scripts/deploy-quote-sending.sh safety`. This:
   - deploys the changed send functions, the lead intake, the receptionist and the new functions;
   - asks for the optional alert email address(es);
   - checks the database region for the new trigger.

   It does **not** deploy the webhook.
3. **Screen:** `./scripts/deploy-quote-sending.sh live`. It refuses until step 2 is done.
4. **Check after the release:**
   - open Needs attention; it should say "All clear";
   - mark a test customer as do-not-contact and try to send; it should be refused;
   - set the lead warning to 1 hour on a quiet evening to see one alert arrive, then set it back.

**Undo:**
- **Screen:** Hosting rollback.
- **Functions:**
  - redeploy `main` (`ead6662`) for the changed functions;
  - `firebase functions:delete healthSweep healthOnMessageWrite attentionAction setDoNotContact`.
- **Backups:** `gcloud firestore backups schedules delete` and `gcloud firestore databases update --no-enable-pitr`. Data is never affected.

---

## 9. Build record (17 Oct 2026)

**Commit:** `0c0be90` on `phase-10-safety-net`. Not pushed, merged or deployed. Nothing was changed in Google Cloud.

### New automatic tests
| File | What it proves | Result |
|---|---|---|
| `functions/test/safety-dnc.test.js` | Every way a message leaves Elite OS refuses a do-not-contact customer, including:<br>• inside each send's own claim;<br>• the quote retry;<br>• the Meta lead welcome;<br>• the receptionist, with no AI call and with the race;<br>• "stop messaging me" in any chat, and ordinary uses of "stop" ignored.<br>Allowing contact again works. | 12/12 |
| `functions/test/safety-health.test.js` | • Problems open, count, close and re-open.<br>• The WhatsApp outcomes are classified.<br>• The client hook can never delay a send for long or change it.<br>• The "reporting back" signal; leads stopped; the receptionist stopped or blocked; the AI budget.<br>• Alerts are sent once, also with two checks running together.<br>• Retries are limited, then marked "not delivered".<br>• The hand-over alert retry falls back to email.<br>• Rejected leads are recorded, closed and erased.<br>• Wrong key, safety brake, buttons, tidying.<br>• No customer data in emails or pushes. | 18/18 |
| `functions/test/safety-backups.test.js` | • Restore tools against a second emulator database: dry run, missing records only, overwrite, never deletes, strict options, read-only point-in-time read.<br>• The restore check and its record.<br>• `setup-backups.sh` with a pretend `gcloud`: status changes nothing; "on" only after "yes"; the drill restores into a NEW database. | 9/9 |
| `functions/test/attention-model.test.js` | The "Needs attention" list, its words, the setting checks. | 3/3 |
| `functions/test/pwa.test.js` (now part of `npm test`) | **New:** every page script is on the "always fresh" list. | 12/12 |
| `test-ui/safety.e2e.js` (real page, real functions) | • The bar, the list and its buttons.<br>• "Add as customer" from a rejected lead.<br>• The setting.<br>• Do not contact on and off, refused by the server even when the screen is bypassed.<br>• Phone layout. | 11/11 |

### Regression
- **Whole server suite (839 tests):** 834 passed at first.
  - 4 file-reading tests failed only because they were started from the wrong folder. Re-run from `functions/` (as `npm test` does): passed.
  - 1 failure is the known flaky load check (`ai-receptionist-load` E, "several at once"). It also fails on unchanged `main` (1 of 2 runs), so it is not caused by this change.
- **Deploy-script tests** for the new stage: passed.
- **Existing browser suites** on the screens this touches:
  - `ui` 57/57
  - `quote-send` 10/10
  - `assistant` 21/21
  - `pwa` 8/8
- **Not re-run here:** `push.e2e.js` and `reopen.e2e.js` (known not to pass on this PC, the same on `main`), and the rest of the browser suites. Run the full regression once more after the review fixes, before release.

### Independent review (same day)
The review found these.
1. **FIXED:** a network blip or a 5xx without an error code was classed as "WhatsApp is refusing the access key". Meta's missing code became 0, which is on the "key" list. A missing code is now "no code".
2. **FIXED:** the tests used a slightly different shape of outcome than the real client sends, so they missed (1). They now use the real shape, and one test runs the real client end to end.
3. **FIXED:** `restore-docs --overwrite` on a customer also put back the old do-not-contact state and the old chat counters. A chat that exists now keeps its live control fields and its send claims; only the content comes back.

**Still open from the review (smaller, not blocking):**
- Rare race: "Seen" pressed while the health check is retrying that alert can leave a stuck "Alert did not reach your phone" tag.
- **Smaller items:**
   - the check delivers alerts one after another (could run past its 2-minute limit in a long outage);
   - every send waits briefly for one shared health record;
   - wrong-key requests to the public lead address each cause a database write;
   - six-digit Meta codes are hidden in problem details;
   - do-not-contact is enforced at each send path rather than once at the bottom layer;
   - one duplicated phone helper.

### Remaining risks
- **"WhatsApp stopped reporting back" can false-alarm.** If the only messages sent in an hour went to phones that are switched off (no delivery tick), it raises a problem. Any customer message or tick closes it again.
- **A real restore in Google Cloud has not been run.** That is what `setup-backups.sh drill` is for: run it once after switching backups on.
- **Do-not-contact is switched on automatically from the customer's words.** A rare false match blocks messages until a person presses "Allow contact again". The do-not-contact note shows the reason.
- **"Needs attention" on iPhone:** only through the bar, which appears only when something needs attention. Notifications (and so "System health") are not available on iPhone.
