# The Emails list (14 Nov 2026)

One window on the Inbox that lists **every email Elite OS has sent to, or received from, a customer**, newest first. It answers "what went out, to whom, and did it arrive" without opening each chat.

## What you see
The **Emails** button opens it: in the left rail on a computer, and among the section buttons (Pipeline, Appointments, Quotes...) at the top of the Inbox on a phone. Each row shows the customer, when, what kind of email it is, the subject and a short preview:

| Kind | Meaning |
|---|---|
| **Received** | A customer emailed you (their reply to a quote or follow-up). |
| **Sent · your reply** | You answered from their chat with **Reply by email**. |
| **Sent · follow-up** | The follow-up to a lead who never replied (the Email button, or the Assistant). |
| **Sent · quote follow-up** | The follow-up about a quote nobody answered (after two weeks), with the quote number. |
| **Sent · quote** | The quote itself, sent by email, with the quote number. |

A red **Not confirmed** means Google did not confirm the email was sent: check the Sent folder of the mailbox (Elite OS never resends it by itself). **All / Received / Sent** filter the list. **Tap a row** to open that customer's chat, where the whole email is. The list is live: a new email appears at the top while it is open. **Show older** loads more (100 at a time, up to 500).

## What is kept, and where
`emailLog/{id}` (read by signed-in staff only; written only by the server): who (name, number, address), the direction and kind, the subject, **a preview of at most 200 characters**, when, whether it was confirmed, who sent it and the quote number. It is a copy made for looking at: never the whole email, never an attachment, never the quote PDF. The full text of a received email, a reply and an automatic follow-up stays in the customer's own chat (`conversations/{phone}/emails`).
* **Received** emails and **your replies**: added when they are recorded in the chat (they already were).
* **Follow-ups** (to a lead, about a quote): now also kept in the customer's chat, so the thread shows exactly what was sent. The chat row shows the email as its newest, but the chat does **not** move up the Inbox (30 follow-ups at once must not reshuffle your list).
* **The quote email**: listed with a short preview of the words (not kept in the chat). If it could not be confirmed and you then mark it **arrived** or **did not arrive**, the list follows (not-arrived removes the entry).
* A failure to write the list is logged and ignored: it never stops an email, and never changes whether an email was recorded.
* **Deleting a customer deletes their entries** (with the rest of their data).

## Putting it live
1. `./scripts/deploy-quote-sending.sh emaillist` (the ten functions that send, receive or erase an email; all exist already, nothing is made public, nothing is sent), then `./scripts/deploy-quote-sending.sh live` (the screen).
2. Optional, once: `node scripts/backfill-email-log.js` shows how many older emails (in chats before the list existed) it would add; `--apply` adds them. Follow-ups and quote emails sent before this were never kept as text, so they cannot be added: the list starts from the deploy for those.

Go back: redeploy the earlier code for those functions; the list simply stops filling. Nothing else depends on it.

## Tests
`functions/test/email-list.test.js` (7: received, reply, lead follow-up, quote follow-up, "never stops an email", erasure, the catch-up), `functions/test/quote-email.test.js` (the quote email is listed, marked not confirmed, then follows staff's decision), `test-ui/email-list.e2e.js` (7: the window in a real browser, filters, not confirmed, names shown as text, live, tapping a row, a 375px phone).
