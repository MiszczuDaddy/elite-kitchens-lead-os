# No welcome message at night

**13 Nov 2026:** a Meta lead that arrived at 01:46 got the welcome message at 01:46. Now nothing is sent to a customer by itself between **midnight and 07:00 Irish time**: the lead is saved and the team is alerted as always, but its welcome message **waits and goes out at 07:00** (06:00 UTC in summer, 07:00 UTC in winter: Dublin's own clock decides).

## What happens
1. A lead arrives (via Make) at night. `leadIntake` creates the customer and alerts the team as before, then, instead of sending, records the welcome as **held** on the lead (`leads/{id}.welcome = { state: 'held', sendAfter, phone, firstName }`). Make is answered normally; a Make retry of the same lead changes nothing.
2. `welcomeSweep` runs every 5 minutes (it does nothing in quiet hours) and sends each held welcome that is due, the same way an immediate one is sent (the same wording choice, the same fallback), once. Before sending it checks, from what happened **after the lead arrived**:
   | If | The welcome is | Because |
   |---|---|---|
   | the customer wrote to us (WhatsApp or email) | skipped_replied | the receptionist and the team already have the chat |
   | a person or the receptionist has been in touch | skipped_contacted | no second first-message |
   | the customer was deleted | skipped_gone | erasure is respected |
   | they asked not to be contacted | blocked (the chat says why) | do-not-contact is absolute |
   | a welcome went to that number within the hour | skipped_recent | one per number per hour |
3. WhatsApp "too many requests" leaves it held for the next sweep (6 tries, then it is flagged failed for a person, like an immediate failure). A refused or unconfirmed send is flagged on the chat and in Today and **never repeated by itself**. A send that was claimed but never finished (the function died mid-send) is flagged "unknown" after ten minutes.

## What you see
In Today's "New leads today" a held lead says **"The welcome message goes out at 07:00"**. The Pipeline and Inbox show the lead as usual (it has no message yet).

## The same rule everywhere
One quiet-hours rule (`functions/lib/quietHours.js`) is used by the welcome and by the automatic receptionist (it already held its replies until 07:00). A returning customer who fills the form again at night is held too.

## Switching
`./scripts/deploy-quote-sending.sh nighthold` deploys it (`leadIntake`, which exists, and the new `welcomeSweep`); `nighthold off` sends welcomes at once again at any hour; `nighthold on` restores the wait. Nothing is sent by the stage itself.

## Tests
`functions/test/welcome-quiet-hours.test.js` (8, emulator): the rule in winter and summer, a lead at 01:46, the old behaviour by day or with the hold off, the morning sweep (once, twice at once), every check before sending, WhatsApp refusing, a send that never finished, Today's wording and the wiring.
