# Inbox: the "All" tab and one search across every customer (build record)

**This replaces the larger Phase 13 plan** (`docs/PHASE13_CUSTOMERS_PLAN.md`, a separate Customers section) at the owner's request, 20 Oct 2026: *a simple improvement to the existing WhatsApp Inbox, reusing the customer data we already have, no separate Customers section, no CRM.* Branch `inbox-all-and-search`, on top of `main` `af74153`. **Nothing here is deployed or merged.**

## What you get (plain words)
1. **An "All" tab**, first in the row of tabs, showing **every conversation of every status** (New lead, Booked, Quoted, Won, Closed), newest first, 100 at a time with a **"Show more"** button. Each row says its stage.
2. **One search bar**, on every tab, that searches **everyone**: **name, phone number, email and town** (also the project type). It works for old and closed customers, and:
   - every word typed must match ("pat naas" finds Pat in Naas, not Pat in Cork);
   - capitals and accents do not matter ("sean" finds "Seán Ó Briain");
   - a phone number works however it is typed: `085 123 4567`, `+353 85 123 4567`, `353851234567`, `(085) 123-4567`, or just the last digits;
   - part of an email is enough ("old-example" finds `zoe.oldham@old-example.ie`).
3. **The existing tabs are unchanged.** New lead is still the tab Elite OS opens on, and each stage tab still shows exactly the live conversations it showed before. The live list is still your 300 newest chats, so nothing got slower.
4. **An older customer opens as a complete chat**: name, phone, town, stage, old messages, details, quotes, visits. Before this, opening a customer who was not among the 300 newest showed a half-empty header and some parts of the screen did not work for them. (Today's cards for old leads open properly now too.)

## How it works
- **The directory.** The first time you open the All tab or type a word, the browser asks the server for one compact list of every customer: `[phone, name, town, project type, email, stage, last activity]`, about 100 bytes each (20,000 customers is about 2 MB). The search then runs **in the browser**, so every keystroke is instant (20,000 customers search in a few milliseconds; a test checks it).
- **Efficient and private.** The server reads each customer's conversation and contact **once** (two reads per customer, only the five fields needed), keeps the answer for **2 minutes**, and returns **only** those fields: never message text, notes, addresses, budgets or receptionist data (a test checks this). Staff only; it sends nothing and changes nothing.
- **Live and directory together.** For a customer in both, the **live chat wins** (it is newer, with unread counts and the latest message). The directory adds everyone else. The directory is refreshed when it is more than 10 minutes old and you open the All tab again.
- **Opening an older customer.** They are watched on their own **while open** and joined to the screen's list, so every part of the screen works for them; when you leave them, the list goes back to the 300 newest.
- **If the directory cannot load** (for example no connection), the screen says so and keeps searching the latest 300 chats; pressing the All tab again retries.
- **Scale.** Up to **20,000 customers** are listed (the 20,000 most recent, and the screen says so if there are more). You are far below that.

## What changed in the code
| Where | What |
|---|---|
| `functions/lib/directory.js` (+ `handlers.js`, `index.js`) | New staff-only, read-only callable `customerDirectory` |
| `public/inbox-search-model.js` | The search rules, pure and tested (matching, phone variants, merge, newest-first) |
| `public/app.js`, `index.html`, `app.css` | The All tab, the search, "Show more", the note line, the older-customer watcher |
| `scripts/deploy-quote-sending.sh` | New stage `search`; `live` waits for it |

No new index, no security-rule change (staff can read; nothing can be written from a browser), no new secret, no change to any customer record, no message sent to anyone.

## Cost
No new service. Each time a search session starts, the directory reads each customer twice: **2,000 customers is about 4,000 reads (well under a cent)**, at most once per 2 minutes per server instance, so a few cents a month at the very most.

## Release steps (each needs the owner's approval; nothing has been run)
1. **Merge** `inbox-all-and-search` into `main` and push.
2. **Cloud Shell:** `./scripts/deploy-quote-sending.sh search` (one new read-only function; nothing existing changes; the WhatsApp webhook is not touched).
3. **Cloud Shell:** `./scripts/deploy-quote-sending.sh live`. Reload Elite OS (phone: close and reopen once).
4. **Check:** open Inbox, press **All** (it counts every customer), type the name of an old closed customer, open them.

## Undo
Firebase console > Hosting > Release history > Rollback (the old screen ignores the new function). To remove the function: `firebase functions:delete customerDirectory --region europe-west1 --project elite-kitchens-lead-os`. Nothing in the data changed, so nothing needs repairing.

## Known limits (small)
- The directory is a snapshot: a customer added in the last 2 minutes appears in the **live** list (and searches) at once, but the All tab's older part does not list them until the next refresh; they are always found by search because the live chats are searched too.
- Search matches **words inside** names and emails (not spelling mistakes).
- The All tab shows the stage but not the latest message for old customers (only the live 300 have it); open the chat to read it.

## Tests
(See the table at the end; filled in when the last run finished.)
