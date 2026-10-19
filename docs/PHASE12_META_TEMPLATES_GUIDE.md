# Creating the reminder template in Meta, step by step (for the owner)

*Changed 19 Oct 2026: only ONE template is needed now: the evening-before reminder.*

You do this once, in your web browser, on your computer. It takes about 5 minutes. Nothing here can send a message to a customer. The menu names at Meta change now and then: if a button is not where this says, look for the closest name, or send me a screenshot and I will tell you what to press.

**Why:** WhatsApp lets Elite OS send a normal message only within 24 hours of the customer's last message. The evening-before reminder is usually later, so WhatsApp requires a pre-approved "template". You are asking Meta to approve our one sentence once.

## Part A. Open the template page
1. Go to **business.facebook.com** and sign in with the Facebook account that owns the Elite Kitchens WhatsApp number (the same one you used when you set up WhatsApp for Elite OS).
2. Open **WhatsApp Manager**. If you do not see it in the left menu: click **Business settings** (the cog) → **Accounts** → **WhatsApp accounts** → click **Elite Kitchens** → **WhatsApp Manager**.
3. In the left menu of WhatsApp Manager click **Message templates** (it may be under "Account tools").
4. Look at the list: you should already see `elite_kitchens_reopen` and the quotation one. Those are the same kind of thing. Click **Create template**.

## Part B. Fill in the form
| Question on the form | What you choose or type |
|---|---|
| **Category** | **Utility** (not Marketing) |
| **Name** | `elite_kitchens_consultation_reminder` (exactly, with the underscores, all small letters) |
| **Language** | **English** (plain "English", not "English (UK)" or "English (US)"). If you can only find UK or US, stop and tell me: it changes one setting on my side. |
| **Header** | none |
| **Body** | paste the sentence below |
| **Footer** | leave empty |
| **Buttons** | none |

**Body (copy it exactly):**
```
Hi {{1}}, a reminder that your {{2}} with Elite Kitchens is tomorrow, {{3}} at {{4}}. If you need to change it, just reply to this message. See you then!
```
When you paste it, the blanks look like `{{1}}`, `{{2}}`, `{{3}}`, `{{4}}`. Meta then shows boxes asking for a **sample** for each one. Type these (they are only examples for Meta's reviewer; no real customer is involved):

| Blank | Sample to type |
|---|---|
| `{{1}}` | `Anna` |
| `{{2}}` | `consultation` |
| `{{3}}` | `Wednesday 21 October` |
| `{{4}}` | `10:00` |

Then press **Submit** (it may say "Submit for review").

## Part C. Wait for Meta
The template shows **In review**, then **Approved** (often within minutes, sometimes a day or two). Meta also emails you.
- **Approved:** good. Tell me.
- **Rejected:** open it, copy the reason Meta gives and send it to me. Do not keep re-submitting: I will fix the wording.
- **Approved but the category changed to "Marketing":** tell me. Marketing messages cost more and have extra rules; I would change the wording and ask Meta to re-review it.

## Part D. Connect and test in Elite OS (I do the technical parts only when you say yes)
The name above is the one Elite OS already expects, so nothing has to be typed anywhere if you used it exactly. If Meta forced a different name, tell me the exact name.

1. You approve the merge of the Phase 12 branch (I do it).
2. You run two short commands in Cloud Shell, like last time (`bookings`, then `live`). The reminder stays **off**.
3. I show you what it would do from your real data (a read-only check, nothing is sent).
4. **Test with your own number:** make a customer record with your own number in Elite OS, and book yourself a consultation for **tomorrow morning**. With your **approval** I switch the reminder on (`reminders on`). Between 17:00 and 19:30 that evening it arrives on your phone by itself. If it does not, tell me and I will look at the records.
   - To test the **template**: do this on a day when you have **not** written to the Elite OS WhatsApp number for the last 24 hours.
   - To test the **normal message**: write to the Elite OS number from your phone earlier that day.
5. It stays on after that. Switch it off at any moment: `./scripts/deploy-quote-sending.sh reminders off`.

## How the reminder works (so nothing surprises you)
- It goes **by itself**, no button, between 17:00 and 19:30 the evening before, never at night.
- It goes to **every** customer with a consultation or site visit tomorrow, once.
- It is **not** sent for a visit booked or changed in the last 4 hours (the customer has just heard the time), for cancelled visits, for installations, or to a customer marked "do not contact".
- If you move a visit, the new time gets its own reminder the evening before it.
- If WhatsApp refuses a reminder, the visit and the Today screen say so, and Elite OS tries again 30 minutes later (up to 3 tries). If WhatsApp gives no answer, it is **never** sent again by itself: you look at the chat and press **It arrived** or **It did not arrive**.
- Outside the 24-hour window each reminder is a template message, which WhatsApp charges a small amount for (check Meta's current price list for Ireland). Inside the window it is free.
