# Lightweight conversation status

> Phase 4 update: the first status is now *displayed* as **New lead** (stored value still `inbox`), entering Booked/Quoted/Won/Closed records a stage date, and a Pipeline screen was added. See `docs/CRM_PIPELINE.md`. The description below is the original Phase 2 design.

Approved scope: Inbox, Booked, Quoted, Won and Closed, displayed as small filters beneath the inbox caption and changed through the conversation header selector. This is inbox organisation, not a CRM or Kanban system.

## Data and behaviour

Only `conversations/{phone}.inboxStatus` is added. Accepted values are `inbox`, `booked`, `quoted`, `won`, `closed`. Missing values display as Inbox, so existing and newly created conversations need no migration or webhook modification. Unknown values also display as Inbox defensively; the callable rejects unsupported values.

`setConversationStatus({phone, status})` uses the existing staff-claim, verified-email and allowlist checks. Its transaction updates only an existing conversation. It does not write to contacts, messages, timestamps, unread fields or storage, and cannot recreate a missing/deleted conversation. The existing customer deletion removes the field with its containing document.

Incoming messages keep the assigned status. Closed is a label, not a messaging restriction or deletion. The overall unread indicator remains global; each filter gets a small unread dot with an accessible count. Search applies within the selected filter. Status changes do not clear the selected conversation or its draft. Failed saves show an error and restore the last known server value; the user can retry the selector.

The existing latest-300-conversations listener is unchanged. Filters cover that loaded set, not older history. No collections, indexes, security rules, authentication changes, retention changes or migrations are introduced.

## Verification

On 2026-10-01, `npm test` passed all 41 backend tests (37 existing plus four status regressions), and `npm run test:ui` passed all 57 browser checks (53 existing plus four status scenarios). The tests use local Firebase emulators and mocked Meta calls. Coverage includes field-only writes, permissions and validation, survival through messaging/media/contact updates, deletion and recreation, defaults, all five filters, scoped search, two-client realtime updates, failure recovery, unread indicators, draft preservation and mobile/keyboard navigation. Desktop and phone screenshots were inspected.

## Deployment boundary

Firebase Hosting preview channels share the project's Cloud Functions. A Hosting-only preview can show the new controls, but saving status requires the new callable to be deployed. After reviewing the passing tests, the owner separately authorised deployment of **only the new status function** to that shared backend. Production Hosting, main, existing functions and rules remain outside this authorisation. Do not deploy all functions or run `scripts/deploy-preview.sh`.

The authorised selective command is:

    firebase deploy --only functions:setConversationStatus --project elite-kitchens-lead-os

This is a shared backend deployment, not an isolated Hosting preview. Existing callable exports and their behaviour must remain untouched. The production frontend and main branch must not change.
