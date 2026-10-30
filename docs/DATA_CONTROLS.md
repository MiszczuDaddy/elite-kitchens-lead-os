# Customer data controls

Customer photos, documents, voice notes and videos are personal data (they can show a customer's home, voice and
address). This documents what the system does about it. It is engineering documentation, not legal advice: confirm the
retention period and your privacy notice with your accountant/solicitor.

## Delete a customer (right to erasure)
Details panel > **Delete customer...** (staff only; type the last 4 digits of the number to confirm). One action removes:
the conversation, every message, every stored file (`media/<phone>/...`), the customer record (name, email, location,
project, budget, notes), and (Phase 5) their appointments and Google Calendar events. Other customers are never touched (tested).
- Calendar events are blanked first and then deleted, so the copy Google keeps in the calendar's trash holds no customer details.
  If Google is unavailable, a clean-up record holding only the calendar and event ids lets Elite OS finish the job later
  (`docs/APPOINTMENTS.md`).
- Audit trail (`auditLog`): who, when, counts (including appointments), last 3 digits of the number and a one-way SHA-256 hash of it. No name, email,
  message text or full number is kept. Readable by staff only.
- (Phase 6.1) The same action also erases the quotes' delivery records (they hold the customer's email address and the message that was sent),
  the stored quote PDFs, and the copy of a sent quote shown in the chat. See "Quotes sent by WhatsApp or email" below for what it cannot erase.
- (Phase 7) The same action also erases the customer's **projects** (checklist, installation date, notes) and their stored **3D renders** (`projects/<phone>/...`);
  the audit entry counts them (`projects`, `projectFiles`). Deleting a single project (always possible) erases the record and its render file; it leaves an audit entry with the project id, who, when, how many steps were ticked and whether a render was attached, and no personal content.
- (Phase 8) The same action also erases the customer's **notification records** (`pushEvents`: they hold the number and the timings of each alert). Staff devices (`pushDevices`) are not the customer's data.
- A customer who messages again afterwards starts as a brand-new conversation with nothing carried over.
- Late delivery-status notifications from Meta for a deleted customer are ignored (they can no longer recreate data).
- Not deleted by this action: copies Meta/WhatsApp themselves hold, the customer's own phone, Cloud Functions logs
  (which contain message ids and types only, never message text or names), and any quote/invoice records in other systems.
  Staff phones drop the deleted calendar events the next time their calendar app syncs.

## Quotes sent by WhatsApp or email (Phase 6.1)
- A quote email is sent from the business mailbox (info@elitekitchens.ie) and Gmail keeps a copy in that mailbox's **Sent** folder, with the
  customer's address, the message and the PDF. Elite OS cannot delete it (it is send-only), and "Delete customer" does not remove it: delete it
  by hand from that mailbox if an erasure request needs it. The customer's own mailbox, and Google's and Meta's own copies, are likewise outside this action.
- Logs hold codes only (channel, error code, kind): never a name, number, address, message text or PDF content (tested).
- Nothing is sent by the automated tests: they use fake providers.

## Retention of stored media (automatic)
- `media/` files are deleted automatically **730 days (24 months) after they were received**; abandoned temporary uploads
  (`uploads/`) after 1 day. Configured in `storage-lifecycle.json`, applied with `./scripts/apply-retention.sh`.
- When a file has been removed, the conversation shows "removed after the retention period" (no broken images, no retries).
- Message text and customer details are kept until the customer is deleted. Change the number in `storage-lifecycle.json`
  and re-run the script to change the period (it affects files from their original received date).
- Cloud Storage deletes lifecycle-expired objects in the background, usually within about a day of the threshold.

## Not built yet (candidates)
- Export a customer's data (subject access request) as a file.
- Bulk "delete everyone inactive for N months".

## Phase 10: do not contact, rejected leads, backups
- **Do not contact** (`conversations/{phone}.doNotContact`, with the last 20 changes): set by staff or by the customer's own "stop messaging me"; every send is refused while it is on. "Delete customer" removes it with the chat. A person who sends a NEW Meta form after being deleted is a new enquiry and gets the welcome.
- **Rejected Meta leads** (`leadIssues/{leadId}`): name, email, the number as typed and the area, only so a person can follow the lead up. Erased the moment it is dealt with (added, dismissed, or sent again by Make with a usable number); the dealt-with item is removed completely after 30 days. Open items stay until someone deals with them. Not linked to a customer (there is no usable number), so "Delete customer" does not find them: use Dismiss.
- **Problems** (`healthIssues`), the health records (`health/*`) and the alert records hold no customer data (a phone number appears only in a hand-over alert record, erased with the customer as before). Fixed problems are removed after 90 days.
- **Backups** (`docs/BACKUPS.md`): daily backups kept 14 days, point-in-time recovery 7 days, deleted files 7 days. A deleted customer disappears from them after those periods. Say so in the privacy notice.
- **Phase 11 (Today):** reminders (`reminders/{id}`, with an optional customer number and name), quote follow-up notes (`todayMarks/quote_{id}`) and dismissed reply alerts (`todayMarks/reply_{phone}`) are **erased with the customer** (`Delete customer`). A reminder with no customer is not personal data and is kept until you delete it.
- **Phase 12 (visit reminders and installations):** the records of the reminders sent about a visit (`bookingNotices/{id}`: the customer's number, when, WhatsApp's message id, never the words) are **erased with the customer** (`Delete customer`), as are the visits themselves, including the installation entries made for their projects. The words of each reminder are in the customer's chat, which is erased as before.
