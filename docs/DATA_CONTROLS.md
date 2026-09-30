# Customer data controls

Customer photos, documents, voice notes and videos are personal data (they can show a customer's home, voice and
address). This documents what the system does about it. It is engineering documentation, not legal advice: confirm the
retention period and your privacy notice with your accountant/solicitor.

## Delete a customer (right to erasure)
Details panel > **Delete customer...** (staff only; type the last 4 digits of the number to confirm). One action removes:
the conversation, every message, every stored file (`media/<phone>/...`), and the customer record (name, email, location,
project, budget, notes). Other customers are never touched (tested).
- Audit trail (`auditLog`): who, when, counts, last 3 digits of the number and a one-way SHA-256 hash of it. No name, email,
  message text or full number is kept. Readable by staff only.
- A customer who messages again afterwards starts as a brand-new conversation with nothing carried over.
- Late delivery-status notifications from Meta for a deleted customer are ignored (they can no longer recreate data).
- Not deleted by this action: copies Meta/WhatsApp themselves hold, the customer's own phone, Cloud Functions logs
  (which contain message ids and types only, never message text or names), and any quote/invoice records in other systems.

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
