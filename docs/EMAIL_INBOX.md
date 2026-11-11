# Email in Elite OS: customers' replies, and "Email" to answer them

When a customer replies to a quote email or a follow-up email, the reply lands in the business mailbox (info@). From 10 Nov 2026 Elite OS brings that reply into **their chat**, next to the WhatsApp messages, and the **Email** button answers it by email, in the same email conversation.

## What you see
- **In the chat:** the email as a bubble marked "✉ Email · subject", with only what they wrote this time (the quoted history is cut off), and, if there are attachments, their names with a link that opens the email in Gmail. Your replies show as "✉ You emailed". Emails sit in time order with the WhatsApp messages.
- **In the Inbox:** the chat moves to the top, with the same unread badge as WhatsApp, and the row says "✉ subject" while an email is the newest thing in it.
- **"They wrote to us":** a lead who replied by email is **not** "never replied": they leave the No reply tab, are not chased by a follow-up email, and a quote is not followed up by email after they wrote. The Assistant's counting follows the same rule.
- **The Email button** (next to Suggest reply, in any chat that has an email address or an email from them): opens a reply to the address they wrote from, "Re: their subject", with their last email shown above for reference. **Send email** sends it from the business address, in the same Gmail conversation (threadId, In-Reply-To, References), and keeps it in the chat. The very same words sent twice within two minutes are refused (a double press), a customer who asked not to be contacted is refused, and an answer from Google that cannot be confirmed is kept as "not confirmed: check Gmail" and never retried by itself.
- **Check for new email** (in that dialog) runs the five-minute check now.

## What it reads, and what it never does
- It signs in to the business mailbox with a **read-only** permission (`gmail.readonly`), separate from the sending permission (`gmail.send`); sending never gets the read permission.
- Every five minutes (`emailSweep`) it lists the newest inbox messages and looks **only at the sender** of each new one. The **text is read and kept only when the sender's address is a customer or lead Elite OS already has** (matched in lower case; an address on two customers goes to the chat that was active most recently). A stranger's email (the accountant, a supplier, anything personal) is never read and nothing about it is stored. It looks back 3 days the first time, then from just before the last check; each message is handled once.
- It never sends, deletes, labels or marks anything in Gmail. Attachments are not downloaded (the Gmail link opens them).
- The emails are kept in `conversations/{phone}/emails`, **not** in `messages`, so the automatic receptionist, the WhatsApp 24-hour window ("last message", "last inbound") and the Reopen rules never see them; the chat's `emailInboundAt`, `lastEmailAt`, `lastEmailSubject` and `lastEmailDir` carry what the Inbox and the "never wrote" rule need. **Deleting a customer deletes their emails** with the rest of the chat.
- The Assistant does not read emails yet.

## Switching it on (one Google Workspace step)
1. `./scripts/deploy-quote-sending.sh emailin` deploys the backend (reading stays **off**), then `./scripts/deploy-quote-sending.sh live` for the screen.
2. In **admin.google.com > Security > Access and data control > API controls > Manage domain-wide delegation**, edit the entry for the mailer service account (`ek-mailer@elite-kitchens-lead-os.iam.gserviceaccount.com`, the one already used for sending) and add the scope `https://www.googleapis.com/auth/gmail.readonly`, keeping `gmail.send`.
3. `./scripts/deploy-quote-sending.sh emailin on` switches reading on (it asks first). Kill switch: `./scripts/deploy-quote-sending.sh emailin off`.
4. Open a chat > **Email** > **Check for new email**. If it says Google has not allowed Elite OS to read the mailbox, step 2 is not finished (it can take a few minutes to apply).

## Not built yet (ideas)
Showing email replies on the Today screen as a reply alert; a push notification for an email reply; the Assistant reading emails; attachments saved into the customer's Documents; emails from customers who are not yet in Elite OS (they are ignored on purpose).

## Tests
`functions/test/email-inbox.test.js` (12, emulator): reading a message, the Gmail reader and its scope, the sweep (a customer's email kept, a stranger's never read, read once, unread count, "wrote to us"), who is a customer, Google refusing and big mailboxes, the replies (thread, headers, once, rules, refusals), staff only, erasure. `test-ui/email-inbox.e2e.js` (8): the button, check for new email, the thread, the Inbox row and the No reply tab, the reply, a double press, the phone.
