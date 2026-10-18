# Phase 11: the "Today" tab (plan, for approval)

**Status:** plan only. Nothing is built, merged or deployed. This was written after reading the real code on `main` (`5244e73`).

---

## 1. What you will get, in plain words

A **Today** tab, first in the menu and the screen Elite OS opens on. It answers one question: **"What do I need to do right now?"**

- A strip of counts at the top (what is waiting, what is late).
- One list of things to do, most urgent first. Tap any line to go straight to the customer, chat, booking or quote.
- A separate **New Leads Today** section: every lead that arrived today and how it is going. A lead that is being handled well does not turn into a task.

---

## 2. The layout

### Computer
```
┌ Today ───────────────────────────────  Sat 18 Oct ─┐
│  Everything fine?  ✔ All systems clear   (or: 🔴 2 problems → Needs attention) │
│                                                      │
│  [ 4 Replies ] [ 2 Handovers ] [ 1 Book visit ] [ 3 Quotes ] [ 2 Reminders ] [ 1 Lead to fix ] │
│   ↑ tap one to show only that kind;  red number = overdue                       │
│                                                      │
│  TO DO (most urgent first)                    + Add reminder │
│  🔴 Brendan Burke      Receptionist passed this on: asked about a price │
│                         waiting 3 h 10 m            [Open chat] [Done] │
│  🔴 Ciara Walsh        Waiting for you to book a visit: Tue/Wed afternoon │
│                                                     [Book] [Open chat] │
│  🟠 Aisling Allen      Customer's last message has no reply · 1 h 20 m  │
│  🟠 Quote EK-0112      Sent 6 days ago, no answer · €14,500  [Open quote] [Followed up] │
│  ⚪ Ring Mr Doyle       Reminder · today 16:00                 [Done] [Tomorrow] │
│  🔴 Ciaran Coyle       Meta lead could not be added (bad number) [Add as customer] [Dismiss] │
│                                                      │
│  NEW LEADS TODAY  (7)                                │
│  Contact failed (1) · Needs you (2) · AI handling (2) · Contacted (2)             │
│  ● Sean Doyle     Kitchen · Swords   09:14   Needs you: price question      │
│  ● Niamh Test     Kitchen · Lucan    10:02   AI handling                    │
│  ● …                                                 │
│                                                      │
│  ▸ Done today (3)   (tap to see them; "Undo" brings one back)                 │
└──────────────────────────────────────────────────────┘
```

### Phone (one column, big tap targets, no sideways scrolling)
```
┌ Today ─────────── Sat 18 Oct ┐
│ ✔ All clear                  │
│ ┌────────┬────────┬────────┐ │
│ │ 4      │ 2      │ 1      │ │   counts scroll sideways
│ │Replies │Handover│Book    │ │   or wrap on two rows
│ └────────┴────────┴────────┘ │
│ ┌──────────────────────────┐ │
│ │🔴 Brendan Burke          │ │   the whole card is
│ │ Passed on: price question│ │   one big tap: opens
│ │ waiting 3 h 10 m         │ │   the chat
│ │          [Done]          │ │
│ └──────────────────────────┘ │
│ …                            │
│ NEW LEADS TODAY (7)    ▾     │   sections fold up/down
│ ┌──────────────────────────┐ │
│ │ Sean Doyle · Needs you ›│ │
│ └──────────────────────────┘ │
└──────────────────────────────┘
```

**Navigation**
- **Computer:** "Today" is the first item in the left menu, with a red count when something is overdue. It is the screen Elite OS opens on.
- **Phone:** a prominent "Today" button sits at the top of the Inbox screen, and the app opens on Today. A "Back to Inbox" button is at the top of Today. (The phone header is already full: a sixth icon made "Inbox" wrap, as found in Phase 6.2.)

---

## 3. What counts as a to-do, and when it goes away

**The key idea: nearly everything on Today is *worked out from what Elite OS already knows*, not stored as a separate task.** So:
- it **cannot be duplicated** (the same customer is always one line);
- it **disappears by itself the moment the cause is gone**: you replied, the visit was booked, the quote was accepted or declined, the lead was added;
- it **cannot vanish by accident**: nothing hides unless the cause is gone or you press "Done".

The only things that are really stored are **reminders** you add yourself, and your **"Done"** and **"Tomorrow"** presses.

| To-do | It appears when | It goes away when | Urgency | Opens |
|---|---|---|---|---|
| **Reply waiting** | The customer's last message has had no reply, the chat is not Closed, and the receptionist is not handling it (it is given 15 minutes) | A reply is sent through Elite OS, or you press Done | 🟠 after 30 minutes, 🔴 after 2 hours. The clock only runs 08:00 to 20:00, so a message at 23:00 is not "late" at 07:00. | The chat |
| **Receptionist handover** | The receptionist passed the chat to you in the last 14 days. It shows the **reason** in plain words ("price question", "customer asked for a person", "complaint"). | A person replies after the hand-over, or you press Done. It comes back if the customer writes again. | 🔴 straight away for a complaint or a "stop messaging me"; otherwise as for a reply | The chat |
| **Needs a visit booked** | The customer gave their preferred days and has no visit booked yet | The visit is booked, or you press "Not needed" (the existing button) | 🟠 after 2 hours, 🔴 after 1 day | The booking form, filled in for them |
| **Quote follow-up** | A quote was sent, is not accepted or declined, and is older than **5 days** (your number) | It is accepted or declined, or you press "Followed up" (it returns after another 5 days) or "Tomorrow" | 🟠 at 5 days, 🔴 at 10 days | The quote |
| **Reminder or callback** | You add one ("Ring Mr Doyle", a date, optional customer) | You press Done (or Tomorrow / pick a date) | 🔴 when its time has passed | The customer, or nothing if it has no customer |
| **Lead that could not be added** | Phase 10's rejected-lead list (bad or missing phone number) | You add them as a customer or Dismiss (the same buttons as in Needs attention) | 🔴 always | "Add customer" form, filled in |

**One line per customer.** A customer who is waiting for a reply *and* was handed over *and* needs a visit shows as **one** card, headed by the most important reason with the others as small tags. The order of importance is: needs a visit booked, then handover, then reply. This stops the same customer filling the list three times.

**"Done" never loses anything.** A card you press Done on moves to "Done today" at the bottom, where "Undo" brings it back. A newer customer message or a changed quote brings a card back by itself.

---

## 4. New Leads Today

Every lead that **arrived today** (Irish time), from any source: a Meta lead form, a new WhatsApp chat, or a customer you added by hand. Each one has **one** clear status:

| Status | Meant when |
|---|---|
| 🔴 **Contact failed** | The welcome message did not go, or Elite OS could not confirm it went |
| 🟠 **Needs you** | The receptionist handed it over, or the customer wrote and a person must answer, or a visit needs booking, or the welcome was held back because they asked not to be contacted |
| 🔵 **AI handling** | The receptionist is on for this chat and has not passed it to you |
| 🟢 **Contacted** | The welcome went and the customer is simply being waited on (or a person has replied) |

If several are true, the most serious wins: Contact failed, then Needs you, then AI handling, then Contacted.

- Leads with a bad phone number (no customer could be made) appear here too, as "Needs you: could not be added".
- Tapping a lead opens the customer's chat (or their record, if there is no chat yet).
- This section is **separate from the to-do list.** A lead that is "AI handling" or "Contacted" is only listed here, so a well-handled lead creates no task. A lead that "Needs you" or failed is *also* a to-do, so you never have to look in two places to be sure nothing is missed.
- **It does not depend on the 300 newest chats.** Today asks the database directly for "everything created or received today" (see section 6), so a lead can never be hidden because the Inbox list is long.

---

## 5. Reminders and callbacks (the only new kind of record)

Deliberately tiny, not task management:
- **+ Add reminder** takes: what ("Ring Mr Doyle"), a date (and an optional time), and an optional customer.
- A reminder can also be added from a customer's chat ("Remind me…").
- Buttons: **Done**, **Tomorrow**, **Pick a date**, **Delete**.
- No assigning people, no priorities, no sub-tasks, no categories.
- Pressing Add twice, or a bad connection, creates one reminder (the same duplicate protection the rest of Elite OS uses).

---

## 6. How it is built (what is reused, what is new)

**Reused as it is**
- The chat, booking form, quote screen and customer record (Today only links to them).
- Phase 10's rejected-lead data and its Add/Dismiss buttons, and the "Needs attention" problems bar.
- The "Needs booking" request data from the receptionist, and the existing "Not needed" button.
- Quote data: status, sent date, price.
- The receptionist's hand-over record, with the reason.

**New**
- `public/today-model.js`: the rules above as plain, testable functions (no screen, no database).
- `public/today.js` and some markup and styling: the screen.
- `reminders` records, plus a **`saveReminder`** function (add, done, snooze, delete). Staff only.
- `todayMarks` records, plus a **`markToday`** function for "Done", "Tomorrow" and "Undo". It stores a key like `quote|q_123` plus what it was about (for example the quote's sent date, or the customer's last message time). That is why a changed situation brings the card back.
- A new test of **400+ chats** to prove a lead on the 400th chat still shows.

**Not touched**
- The WhatsApp webhook, the receptionist's behaviour, quote sending, and the security rules (staff can already read everything; only functions write).

**Database questions Today asks.** All are simple, one-field questions, so **no new database index is needed** (an index would be a Google Cloud change needing your approval):
- chats created today, or with a customer message in the last 60 days;
- contacts whose Meta lead came in today;
- chats waiting for a booking;
- chats handed over in the last 14 days;
- quotes with status "sent";
- open reminders;
- open rejected leads (Phase 10);
- appointments still to come (already used).

**Keeping up to date.** Each of these is a live connection, so a card appears or disappears within a second of the change, with no refresh button. That is about 8 connections. It reads a few hundred records when opened, which is **well inside Google's free allowance, so no new monthly cost.**

---

## 7. Phone and ease of use

- One column, large tap targets (at least 44 px), no horizontal scrolling; checked at 390 px wide.
- The whole card is the tap target; **Done** is a separate button with space around it so it is not pressed by accident.
- Sections fold up and down; the counts strip is also the filter.
- Plain words only. No jargon, no codes: "Receptionist passed this on: asked about a price".
- Empty state: a calm "Nothing waiting. Well done." (and, if there are new leads, they are still shown).

---

## 8. How it will be tested

| What | How |
|---|---|
| Every rule (reply waiting, handover, visit, quote, reminder, lead status, ordering, one card per customer, working hours, "comes back when something changes") | Automatic unit tests of `today-model.js`, including the "must NOT show" cases (receptionist handling it, Closed customers, a reply just sent) and **planted errors** that must be caught |
| Reminders and Done/Undo | Server tests: staff only, strict input, same request twice = one record, undo, erased with the customer |
| Not hidden by the 300 limit | A test with 400+ chats where the new lead is the oldest chat; it must still show |
| Resolves automatically | Real-page test: reply, book a visit, accept a quote, add a rejected lead, and the cards leave by themselves; a new customer message brings one back |
| Phone | Real-page test at 390 px: fits, nothing cut off, Done and open both work |
| Nothing else broken | The existing suites for the screens it touches (Inbox, Assistant, install-as-app) plus the full run before release |

This touches no customer messages and no data deletion, so it is **normal-risk testing**, with one independent review at the end (the same as Phase 10).

---

## 9. Steps (each ends with tests and a commit on its own branch `phase-11-today`)

1. **The rules**: `today-model.js` and its tests. *(small)*
2. **Reminders and "Done"**: the two functions, the records, their tests. *(small)*
3. **The screen**: Today with the counts, the to-do list, Done/Undo, the reminder form. *(medium)*
4. **New Leads Today**, with its statuses. *(small to medium)*
5. **Navigation and phone**: Today first, the default screen, the phone button, polish, the full browser test. *(small)*
6. **Independent review**, the fix pass, and the deploy notes. *(small)*

**Overall size: medium.** Nothing merges or deploys without your approval. Release will be one deploy stage plus the screen, as in Phase 10.

---

## 10. Decisions for you (my recommendation first)

1. **Quote follow-up after 5 days?** (Recommended; red at 10.) Or tell me your number.
2. **A reply is "late" after 30 minutes (amber) / 2 hours (red), counted only 08:00 to 20:00?** (Recommended.)
3. **Today is the screen Elite OS opens on?** (Recommended; Inbox is one tap away.)
4. **Include a small "Visits today and tomorrow" line at the top?** (Recommended: it is cheap, and it makes Today the whole daily picture. Installs join it in Phase 12.) Or leave it out.
5. **Hide Closed and Won customers from "reply waiting"?** (Recommended: a "thanks" from a finished customer should not be a task.)
6. **Show hand-overs from the last 14 days only?** (Recommended. On the first day, a few older ones may show; Done clears each.)

## 11. Risks and honest limits

- **First day:** older hand-overs and unanswered chats from the last 60 days will appear. That is correct, but it can look like a lot. "Done" clears them one by one.
- **"Reply waiting" only looks 60 days back.** An older unanswered chat is still in the Inbox, just not on Today.
- **The Inbox's own "Needs booking" count still only sees the 300 newest chats.** Today fixes this for itself. I suggest switching the Inbox badge to the same query later.
- **Quotes "sent" and never answered** accumulate. Today shows only those from the last 60 days. If you have many, we may later want a database index (your approval needed).
- **A WhatsApp message answered on your own phone**, outside Elite OS, still counts as unanswered until Elite OS sees a reply. Press Done.
