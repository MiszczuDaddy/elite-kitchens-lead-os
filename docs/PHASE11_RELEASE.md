# Phase 11 (Today tab): release checklist

Nothing here has been run. Every step needs the owner's explicit "yes".

## 1. What is on the branch (checked 18 Oct 2026)
`phase-11-today` = `main` (`5244e73`) + 4 commits (`63e3e38`, `e31422f`, `42e1884`, `32b3c4f`). It is on GitHub; `main` there is still `5244e73`.

- **Only Phase 11 work.** 42 files: the Today screen and its rules (`public/today*.js`, `index.html`, `app.js`, `app.css`, `attention.js`), two staff-only functions (`functions/lib/today.js`) wired in `index.js` and `handlers.js`, the erase-customer change (`store.js`), the `today` deploy stage, tests, docs, and a one-line landing fix in 22 older browser tests.
- **Nothing outside the app:** no rules, indexes, secrets, settings, WhatsApp webhook, receptionist or quote-sending code changed.
- `main` is an ancestor of the branch, so the merge has no conflicts.
- No password, key or token in the diff (scanned).

## 2. Tests on the final commit (`32b3c4f`)
Run on 18 Oct 2026, 14:56 to 15:38, on commit `32b3c4f`:
- **Whole server suite: 922 of 922 passed, 0 failed** (this includes the Today rules, the Today server tests, the erase-customer test, the security rules, and Phases 10's suites).
- **Browser suites, all passed:** today 12, ui 57, quotes 20, projects 13, appointments 39, safety 11, lead 11, crm 14.
- Earlier on the same code, 11 other browser suites also passed (see `PHASE11_TODAY.md`). Not run again: `reopen`, `push`, `theme` fail on this PC, the same on `main`.

## 3. Safest procedure
Order matters: **merge, then new functions, then the screen**. The functions are only added (plus one small change to "Delete customer"), so the current screen keeps working throughout.

**Step A: merge (my side, after your "yes").** A merge commit (not fast-forward), so it can be undone with one command:
```
git checkout main && git pull --ff-only
git merge --no-ff phase-11-today
git push origin main
```
**Step B: Cloud Shell, the functions.**
```
cd ~/elite-kitchens-lead-os && git checkout main && git pull --ff-only
./scripts/deploy-quote-sending.sh today
```
It checks everything first, saves the old version of "Delete customer", and asks you to confirm. It does **not** touch the WhatsApp webhook. Nothing visible changes yet.

**Step C: Cloud Shell, the screen.**
```
./scripts/deploy-quote-sending.sh live
```
It refuses if step B was not done. Then reload Elite OS (phone: close and reopen the app once).

*(Optional extra safety, one more command: `./scripts/deploy-quote-sending.sh preview` after step B puts the new screen on a private test address first. Not needed for a screen that sends nothing and can be undone in one click.)*

**Step D: tag (after your tests pass).** `phase-11-today-complete` on the merge commit.

## 4. Your test on real data (desktop, then phone)
Do these in order. Nothing here messages a customer.

**Desktop**
1. Open Elite OS: it should land on **Today**, with Today first in the left menu.
2. The counters add up to the cards shown. Press each counter: the list filters; press again: it clears.
3. **New Leads Today** lists every lead from today (compare with today's leads in Meta/Make), with a status each.
4. Open one card of each kind (a chat, a handover, a visit to book, a quote): it opens the right customer or chat. Press Back: you return to Today.
5. Add a reminder ("Remind me…" in a customer, or the + on Today). Snooze it. Mark it Done, then Undo.
6. On a quote card press "Followed up", then Undo.
7. Reply to a waiting chat in Elite OS: its card disappears by itself. (Use a real chat you were going to answer anyway.)
8. Start editing a quote or Quote Settings and press Today: it must ask "Leave without saving?".

**Phone**
9. Open the app: it lands on Today; cards are full width and easy to tap.
10. Repeat 2, 4 and 5. Check no text is cut off.

If anything looks wrong, write down what you pressed and what you saw (a screenshot is best). If it is bad, do the screen rollback below at once.

## 5. Rollback (data is never lost: reminders are only extra records)
| Problem | Fix | Time |
|---|---|---|
| The screen is wrong or confusing | Firebase console > Hosting > Release history > the release before today > **Rollback**. The old screen ignores reminders. | 1 minute |
| Today's two new functions misbehave | Cloud Shell: `firebase functions:delete saveReminder snoozeQuote --region europe-west1 --project elite-kitchens-lead-os` (the screen then cannot add reminders; roll the screen back too) | 2 minutes |
| "Delete customer" misbehaves | Cloud Shell: `git checkout 5244e73 -- functions` then `firebase deploy --only functions:deleteCustomer --project elite-kitchens-lead-os` | 3 minutes |
| The merge itself must be undone | `git revert -m 1 <merge commit>` then `git push origin main`, then redeploy the screen from that | 10 minutes |

Rolling back the screen is safe at any moment and needs no other step.

## 6. Small issues kept for later (not blockers)
1. **Visits to book:** Today checks the next **400** appointments only. A booking far ahead (beyond the 400th) could leave a customer showing as "needs booking" when they are booked. Fix: ask for the customer's own appointments instead of a fixed number.
2. **Keyboard focus:** the Today list is redrawn fully on every change, so someone using the keyboard (Tab) can lose their place. Touch and mouse are unaffected. Fix: update only the changed cards.
3. **First-day clutter:** the first time Today opens, old unanswered chats from the last 60 days appear. Correct, but it can look like a lot. Fix options: close old chats once, or shorten the window to 14 days.

Also kept from earlier: the Inbox's own "Needs booking" badge still looks at the newest 300 chats only (Today does not); "failed welcome" is only checked for today's leads.

Next: **Phase 12** (bookings customers can rely on) once Phase 11 is verified.
