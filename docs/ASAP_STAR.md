# The ⭐ "wants it as soon as possible"

A ⭐ appears beside the name of every customer who wants the kitchen as soon as possible: in the **Inbox** (and the No reply tab), in **Today** (the card and the "New leads today" row) and in the **Pipeline**.

## Where it comes from (and where it never does)
**Only from the lead's Notes.** The Meta lead form has a fixed answer, "1-2 months asap". When a lead arrives, the answer is saved in the customer's Notes inside the lead's own block:

```
Meta lead · November 2026 form · 1 Nov 2026
Lead ID: 123456
Other answers:
• When do you want to start?: 1-2_months_asap
```

`functions/lib/asap.js` looks for a **bulleted answer line inside a "Meta lead" block** whose answer says "asap" or "as soon as possible" (Meta may send the option as `1-2_months_asap`; underscores are read as spaces). It never reads the chat, never reads what a person typed in the Notes, and never reads the free-text "Requirements" line.

The result is stored as `asap: true/false` on the customer's conversation, so the lists can show it without reading every customer's Notes. It is recomputed from the Notes whenever they are written:
- **a new lead arrives** (`leadIntake`; a customer who fills the form again gets it too),
- **someone edits the Notes** (`updateContact`: delete the lead's answer from the Notes and the star goes; paste a lead block with the answer and it comes),
- **`scripts/mark-asap-leads.js`**, the one-time catch-up for existing customers.

## Putting it live
1. `./scripts/deploy-quote-sending.sh asap` (the two functions, `leadIntake` and `updateContact`; nothing is sent to anyone).
2. `node scripts/mark-asap-leads.js` (shows what it would change), then `node scripts/mark-asap-leads.js --apply` (stars the existing leads). It changes one field on existing conversations and nothing else.
3. `./scripts/deploy-quote-sending.sh live` (the screen).

## If the star is missing on a lead who picked the answer
Open the customer's Notes: the answer must be there as a "• question: answer" line under a "Meta lead ·" heading. If the form's wording ever changes so that the answer no longer contains "asap" (or "as soon as possible"), tell Claude the new wording.

## Tests
`functions/test/asap-star.test.js` (what counts, what never counts, lead intake, form filled again, editing the Notes, a chat message never sets it) and `test-ui/asap.e2e.js` (Inbox, Today, Pipeline, phone, live).
