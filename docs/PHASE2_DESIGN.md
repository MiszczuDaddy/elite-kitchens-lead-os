# Phase 2 design: real WhatsApp inbox + customer foundation

Branch `phase-2-inbox`. Known-good baseline: tag `phase-1-whatsapp-poc` (commit f91b3bf). The proven Phase 1 webhook is
extended only additively and only with explicit approval before it is deployed to production.

## Review of the Phase 1 model
Phase 1 already keys everything by the customer's phone number (digits only, e.g. `353894641917`):

    contacts/{phone}                       phone, name, createdAt
    conversations/{phone}                  phone, name, lastMessage, lastInboundAt, updatedAt, createdAt
    conversations/{phone}/messages/{wamid} direction, type, body, media, status, error, createdAt

That is already multi-customer: an inbound message from any new number creates its own conversation, a known number
maps to the existing one, and message docs are keyed by the WhatsApp message id (atomic dedup). No rewrite needed.

## Target model (additive; every existing document stays valid)
    contacts/{phone}          + email, location, projectType, budget, notes, source, updatedAt
    conversations/{phone}     + lastReadAt (M1), unreadCount + lastInboundServerAt (M2, webhook-maintained)
    messages/{id}             + media {waMediaId, mimeType, filename, size, storagePath} (M2)

- Doc id = phone stays the primary identifier for WhatsApp. Later phases add fields/collections (lead info, pipeline,
  appointments, quotes, activities, AI actions) without migrating anything; Meta leads will populate `contacts`.
- `contacts` is the customer record (edited by staff); `conversations` is inbox state; `messages` is the log.

## Milestones
1. **M1 (this milestone):** inbox UI (list, search, unread, thread, reply, new conversation), `markRead` callable.
   Backend change = ONE new additive function. The webhook is not modified.
   Unread = `lastInboundAt > lastReadAt` (or never read). Staff clock/Meta clock skew cannot hide a message from the
   staff member because the open conversation re-marks itself read on every change.
2. **M2:** customer details panel + editing (`updateContact`), media (webhook downloads via the official Cloud API,
   stores privately in Cloud Storage, UI gets short-lived signed URLs), send attachments, `unreadCount`.
   Needs approval to deploy the extended webhook and to enable Cloud Storage.
3. **M3:** polish, mobile pass, reliability hardening.

## Safe preview strategy
- UI: Firebase Hosting **preview channel** (own URL, expires) - production hosting is not touched.
- Functions are shared (one Firebase project has one live webhook, tied to the one real number). M1 only ADDS a function.
  Anything that changes the webhook is tested first, then approved by the owner before deployment.
- Rollback: redeploy from tag `phase-1-whatsapp-poc`.
