# The Emails list (14 Nov 2026)

One page that lists **every email Elite OS has sent to, or received from, a customer**, **one row per customer**, the customer with the newest email first. It answers "what went out, to whom, and did it arrive" without opening each chat.

## What you see
**Emails** is its own page (14 Nov 2026, as a tab rather than a pop-up): in the left menu on a computer, and among the section buttons (Pipeline, Calendar, Quotes...) at the top of the Inbox on a phone. The address `#emails` opens it directly.

* **The list** (left): **one row per customer** (21 Nov 2026; before that it was one row per email, which was unusable with 200 emails). The customer with the newest email is first. Each row shows the customer, when their newest email was, **how many emails** they have ("3 emails"), the newest email's kind, subject and a short preview. A customer with an email Google did not confirm is flagged on their row, even when it is not their newest.
* **Who is waiting for whom** (22 Nov 2026). Only a customer whose **newest email is from them** is highlighted: a green row with a **Replied · your turn** tag. Every other row (the newest email is one you sent: a follow-up, a quote, a reply) is plain and grey with **Waiting for their reply**, so an email you sent can never look like an answer. This follows the customer's newest email of all, whatever filter is on. It is about email only: if you answered by WhatsApp or by phone, the row stays green until you reply by email (or the customer writes again).
* **The conversation** (right): choose a customer and **all their emails open in one window**, oldest at the top and the newest at the bottom (like the chat), sent and received together. Each email shows whether it was received or sent (and what kind), when, from or to which address, who sent it and the full text; each attachment has a **View** button (22 Nov 2026, docs/EMAIL_ATTACHMENTS.md): PDFs and pictures open in a new tab, anything else downloads, and the file is fetched from Gmail when you click, never stored. **Reply by email** (the button at the bottom, by the newest email; **Write an email** when they have never written) opens the same reply window as in the chat, with their newest email above the box you write in; it goes out from the business address in the same Gmail conversation, and appears at the bottom of the conversation. **Open chat** takes you to that customer's chat. A new email appears at the bottom while the window is open (unless you have scrolled up to read an older one). On a phone the list and the conversation take turns: choose a customer to read, **All customers** (or Back) returns to the list.
* **Search** finds a name, a subject, an email address or a quote number (it looks at the preview, not the whole text).
* **Filters:** **All**, **Needs your reply (2)** (the customers who have replied and are waiting for you; the number is how many), **Received**, **Sent**, **Follow-ups** (to a lead and about a quote), **Not confirmed**. They choose which customers are listed (those with at least one such email; the row then shows their newest matching email and how many match). Search and filters work together. The conversation window always shows the customer's whole conversation.

| Kind | Meaning |
|---|---|
| **Received** | A customer emailed you (their reply to a quote or follow-up). |
| **Sent · your reply** | You answered from their chat with **Reply by email**. |
| **Sent · follow-up** | The follow-up to a lead who never replied (the Email button, or the Assistant). |
| **Sent · quote follow-up** | The follow-up about a quote nobody answered (after two weeks), with the quote number. |
| **Sent · quote** | The quote itself, sent by email, with the quote number (its wording is not kept: the page shows the start of it). |
| **Sent · from Gmail** | An email you wrote to a customer from Gmail yourself, found in the mailbox's Sent folder (see docs/EMAIL_INBOX.md, "Both directions"). |

A red **Not confirmed** means Google did not confirm the email was sent: check the Sent folder of the mailbox (Elite OS never resends it by itself); the email's page says so too. The list is live: a new email appears at the top while the page is open. **Show older** loads more (300 emails at a time, up to 1,500; the page starts with the newest 300). A customer's conversation window loads their own emails separately (up to 300), so it is complete even when the list has not loaded that far back; only the count on the row follows what the list has loaded.

## What is kept, and where
`emailLog/{id}` (read by signed-in staff only; written only by the server): who (name, number, address), the direction and kind, the subject, **a preview of at most 200 characters**, when, whether it was confirmed, who sent it and the quote number. It is a copy made for looking at: never the whole email, never an attachment, never the quote PDF. The full text of a received email, a reply and an automatic follow-up stays in the customer's own chat (`conversations/{phone}/emails`).
* **Received** emails and **your replies**: added when they are recorded in the chat (they already were).
* **Follow-ups** (to a lead, about a quote): now also kept in the customer's chat, so the thread shows exactly what was sent. The chat row shows the email as its newest, but the chat does **not** move up the Inbox (30 follow-ups at once must not reshuffle your list).
* **The quote email**: listed with a short preview of the words (not kept in the chat). If it could not be confirmed and you then mark it **arrived** or **did not arrive**, the list follows (not-arrived removes the entry).
* A failure to write the list is logged and ignored: it never stops an email, and never changes whether an email was recorded.
* **Deleting a customer deletes their entries** (with the rest of their data).

## Putting it live
1. `./scripts/deploy-quote-sending.sh emaillist` (the ten functions that send, receive or erase an email; all exist already, nothing is made public, nothing is sent), then `./scripts/deploy-quote-sending.sh live` (the screen: the page and its menu button).
2. Optional, once: `node scripts/backfill-email-log.js` shows how many older emails (in chats before the list existed) it would add; `--apply` adds them. Follow-ups and quote emails sent before this were never kept as text, so they cannot be added: the list starts from the deploy for those.

Go back: redeploy the earlier code for those functions; the list simply stops filling. Nothing else depends on it.

## Tests
`functions/test/email-list.test.js` (7: received, reply, lead follow-up, quote follow-up, "never stops an email", erasure, the catch-up), `functions/test/quote-email.test.js` (the quote email is listed, marked not confirmed, then follows staff's decision), `test-ui/email-list.e2e.js` (9: the page in a real browser: it opens and closes like the other pages, one row per customer, filters and search, a customer's whole conversation in one window, not confirmed, names and bodies shown as text, live updates, an empty list, a 375px phone one thing at a time).
