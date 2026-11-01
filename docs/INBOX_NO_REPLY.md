# Inbox "No reply" tab

The Inbox's last status tab used to be **Closed**. It is now **No reply**: every lead who never wrote back, oldest first, so they can be rung.

## Who is listed
A lead is listed when **all** of these are true:
- they are still a **New lead** (once a lead is Booked, Quoted, Won or Closed they have been in touch, or you have decided about them);
- no message of theirs has ever been recorded (the chat has no "they wrote" time, their message is not the last one, nothing is unread);
- they are not marked **Do not contact**.

A lead nobody has messaged yet (the welcome did not go) is listed too, with "No message has been sent to them yet".

Each row says how long it has been ("40 days, no reply"), shows the project and area, and has a **Call** button (a normal phone link). Pressing Call rings them; pressing the row opens the chat. A lead who writes leaves the tab by itself.

## Older leads
The Inbox's live list holds the 300 newest chats. When the tab is pressed Elite OS also reads every chat whose last message is ours, so older leads are not missed. Each candidate is then confirmed against the chat's own messages (one small read each, remembered for the session), because an older record might not have noted that the customer once wrote. While it checks, a line under the search says so.

## What changed besides the tab
- **Closed** has no tab any more. A Closed customer is still found under **All**, by the search (it looks through every stage) and in the **Pipeline**'s Closed column, and the stage can still be set in the chat. A Closed customer who writes again shows under All with the unread badge (it does not appear in Today).
- Searching still looks through every stage, whichever tab is open.

## Technical
- `public/noreply-model.js` (pure rules, tested in `functions/test/noreply-model.test.js`), glue in `public/app.js` (`loadNoReply`, `noReplyRows`), browser test `test-ui/noreply.e2e.js`.
- Client only: no function, rule or index changes, so it goes out with `./scripts/deploy-quote-sending.sh live`. A new equality query on `conversations.lastMessageDirection` needs no index.
