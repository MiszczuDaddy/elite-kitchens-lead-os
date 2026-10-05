# Phase 6.1 — Direct quote sending and "Reopen conversation" (agreed design)

Status: **M0 (design, branch and baseline) done.** Branch `phase-6-1-quote-sending`, started from tag
`phase-6-quotes-complete` (`ab84a7d`). Nothing is built, nothing is deployed, nothing real has been sent. This document is the
specification the milestones below implement. A rule in it changes only with the owner's approval.

Phase 6 (docs/QUOTES.md) is live, merged and tagged. Phase 6.1 must not destabilise it: every Phase 6 test and the full
regression suite must keep passing unchanged.

## The goal

Sending a finished quote takes seconds, from the quote itself. Roughly (the exact screen is designed in M5):

```
SEND QUOTE — EK-0104
Customer: John Smith
Send via:  [ WhatsApp ]  [ Email ]        (one, or both)
Message (editable): "Hi John, please find attached your quotation EK-0104 from Elite Kitchens. Any questions, just reply here."
[ Send quote ]
```

Staff no longer download the PDF, leave Elite OS, find the customer elsewhere, attach the PDF, mark the quote sent or update
the CRM by hand. Elite OS does all of that, safely.

Reopening a closed WhatsApp conversation is **a general WhatsApp capability, not a quote feature** (decision 9).

## Decisions (owner, 2026-10-05)

| # | Decision |
|---|---|
| 1 | A quote counts as **Sent once at least one selected channel confirms successful delivery**. If every selected channel fails, it stays unsent. |
| 2 | Keep **Download PDF**, **Email draft** and manual **Mark as sent** as secondary / fallback options. |
| 3 | Email goes through the **Gmail API with keyless Google Workspace delegation**, sent as `info@elitekitchens.ie`. The owner does the one-time Workspace admin approval. Emails remaining in `info@`'s Sent folder is accepted. DNS records are inspected first and changed only if actually required (see "Email"). |
| 4 | Build **Reopen conversation** as a general capability, with the proposed template wording. A quick-reply button is preferred. The owner creates the Meta template from the exact instructions below. |
| 5 | **Quote-by-approved-template outside the 24-hour window** is an optional later milestone (M7). The owner may submit its template now so Meta's approval runs in parallel. |
| 6 | At most **one Reopen template per customer per 24 hours**. |
| 7 | Default WhatsApp wording and the existing email wording are approved; both are editable before sending. |
| 8 | Architecture and milestone order approved. Branch `phase-6-1-quote-sending`. **Nothing is deployed to production without the owner's explicit approval.** |
| 9 | Reopen conversation is a general WhatsApp capability for any customer chat, **not quote-specific**. |

## What we start from (inspected 2026-10-05)

* **WhatsApp** (`functions/lib/whatsapp.js`, `functions/lib/handlers.js`): the Cloud API client already sends text, files
  (`uploadMedia` + `sendMedia`, documents with a caption and filename) and templates. `sendReply` and `sendMedia` refuse
  outside the window on the server (`WINDOW_MS`, the customer's `lastInboundAt`); the screen mirrors it (`windowOpen` in
  `public/app.js`). One Meta call carries no idempotency key: a repeated call sends twice.
* **The closed-window button today** ("Send template", `tpl-btn`) opens New conversation and calls `startConversation`, which
  sends the *new-enquiry welcome* template (`WHATSAPP_TEMPLATE_NAME`, "thanks for your enquiry…"). It is the wrong message for
  a customer already in conversation; Reopen gets its own template. `startConversation` stays for brand-new numbers.
* **Quotes** (`functions/lib/quotes.js`, `quotePipeline.js`): `send` freezes the version, stores the exact PDF
  (`quotes/{phone}/{id}/v{n}-{hash of request}.pdf`), marks the quote Sent and applies the pipeline rules **in one step, before
  anything reaches the customer**. The PDF is made in the browser (`public/quote-document.js`, html2pdf) and uploaded to
  `uploads/{uid}/`. Phase 6 has no delivery step: Download PDF and Email draft are manual.
* **Precedent for safe sending:** the Meta lead-ads welcome (`functions/lib/leads.js`) already claims the send first, and a
  send that died mid-way is flagged "status unknown" and never resent. Phase 6.1 follows the same rule.
* **Security:** Firestore rules let staff read everything and stop every browser write; Storage is closed except create-only
  `uploads/{uid}/`. Every action is a staff-only callable (`assertStaff`). Quote functions hold **no** WhatsApp secrets (least
  privilege).
* **Deletion:** `deleteCustomerData` erases quotes with `recursiveDelete`, so any sub-collection under a quote goes with it,
  and the `media/` and `quotes/` Storage folders. Retention (`storage-lifecycle.json`) deletes `media/` after 24 months and
  not `quotes/`.
* **Webhook:** `webhookReceive` stores inbound messages (which set `lastInboundAt`) and applies delivery statuses. Phase 6.1
  does **not** change it.
* **Customers added without messaging** have a conversation but no inbound message, so their window is closed until they
  write. Their opt-in to WhatsApp is the business's responsibility, as for any template.

## WhatsApp and Meta's rules (checked 2026-10-05; Elite OS never works around them)

* Free-form messages (text, documents) are allowed only within 24 hours of the customer's last message. Anything else must be an
  approved template (error 131047 "more than 24 hours have passed").
* **Sending a template does not open free-form messaging.** A customer's reply does, and so does a tap on a quick-reply button.
* **A quote PDF in a template is legitimate**: a template can have a *document* header (a PDF) and is sent at any time, with
  the document supplied per message. Limits: Meta must approve it; Meta decides its category (**Utility**, cheaper, or
  **Marketing**); a "here is the quote you asked for" message fits Utility but Meta's guidance does not name quotes, and it
  recategorises anything promotional. Marketing templates are subject to per-customer limits (131049) and customers can opt
  out of them (131050).
* A generic "we have a question, please reply" re-engagement template will probably be classified **Marketing**. A reopen tied
  to a live enquiry has a better chance of Utility. Either works; the cost is a few cents per delivered template (third-party
  rate card for Ireland, April 2026: roughly US$0.017 Utility, US$0.059 Marketing).
* Reported by several third-party sources but **not confirmed on Meta's own pages**: from 1 October 2026 free-form replies in an
  open window become billable per message (possibly with a small monthly allowance). Check the billing page in WhatsApp
  Manager. Elite OS sends **one** WhatsApp message per quote (the PDF with the text as its caption), not two.
* Quote sending in the open window reuses the existing client; Reopen adds one small client method that sends a template by
  name (the existing `sendTemplate` stays as it is, for the lead welcome and `startConversation`).

## Email (inspected 2026-10-05)

* `elitekitchens.ie` mail is **Google Workspace** (MX `smtp.google.com`). The Google Cloud organisation blocks service-account keys
  (Phase 5), so the route is the **Gmail API with keyless domain-wide delegation**: the functions' own runtime identity asks the
  IAM Credentials API to sign a short-lived request on behalf of a dedicated service account, which Google lets send as
  `info@elitekitchens.ie`, scope `gmail.send` only (it cannot read mail). No key, password or secret exists anywhere. The same
  keyless idea as Phase 5's calendar, plus one super-admin approval in Workspace Admin (done by the owner at M4, with exact steps).
* The email appears in `info@`'s Sent folder, and replies arrive in `info@`.
* **DNS inspection** (against both authoritative servers `ns9/ns10.dnsireland.com` and public resolvers 8.8.8.8 / 1.1.1.1, all
  agreeing): MX is Google; the only TXT record is a Google site verification; **no SPF record, no DMARC record, and no DKIM key
  at Google's default `google` selector** (nor at seven other common selectors).
* What that means: Google asks *all* senders to authenticate with SPF **or** DKIM (since 1 February 2024); unauthenticated mail
  "might be marked as spam or rejected". This already applies to the email staff send by hand today. It is a deliverability
  matter, not a blocker for building.
* **Nothing is changed in DNS now.** The order is: (1) the owner reads, without changing anything, Admin console > Apps > Google
  Workspace > Gmail > Authenticate email (is DKIM already on?); (2) at the M4 preview a test email is sent from `info@` to the
  owner's own Gmail and Outlook addresses and the message headers are read (SPF / DKIM / DMARC results); (3) only if they show
  *none* or *fail*, we recommend: SPF `v=spf1 include:_spf.google.com ~all` as a single TXT at the root (after confirming nothing
  else sends as `@elitekitchens.ie`: website forms, accounting software, automations); DKIM switched on in Admin console (Google
  gives the TXT record to add; selector `google`); DMARC optional, monitor-only. DNS is managed at dnsireland.com.

## Architecture

Quote → a send service → WhatsApp / Email. No WhatsApp or email logic in the quote builder or the quote record; the parts meet
at small fixed shapes and each can be replaced alone:

```
 Send dialog ──▶ deliverQuote ──▶ prepare ─▶ channel adapters ─▶ commit (existing "sent" rules)
 (browser)       (quoteDelivery)               whatsapp | email     marks Sent + CRM, central
 Customer chat ─▶ reopenConversation (reopen) ─▶ template via the WhatsApp client
```

### Send in three steps

1. **Prepare** (the checks and storing of today's `send`, minus the marking): the same validation (draft unchanged since the PDF
   was made, Quote Settings and customer details unchanged, issue date today, a real PDF of at most 25 MB from the sender's own
   upload folder), the exact PDF stored privately, the version **locked** (`prepared` on the draft version: editing, discarding
   or revising is refused until the send finishes or is cancelled). The quote's status, the customer's stage and the pipeline
   value are **not touched**.
2. **Deliver**, one channel at a time (WhatsApp, then email), each with its own record (below).
3. **Commit** (the existing central "quote sent" behaviour: freeze, mark Sent, `planSend` pipeline rules, history), in the same
   transaction that records the **first** channel confirmed as delivered. Later successes only add their record. If every channel
   fails, nothing is committed and the draft stays locked until staff **retry**, **cancel the send** (deletes the stored PDF,
   unlocks the draft) or **mark it sent by hand**.

The Phase 6 `sendQuote` keeps its exact behaviour, wording and tests: internally it becomes prepare + commit back to back, so
"marked sent by hand" is unchanged, and **no stage or status logic is duplicated** (`quotePipeline.js` stays the only place).

Sending an already-sent version through another channel (for example email later) needs no prepare and no commit: a new
delivery of the same stored PDF. A sent version's PDF never changes.

### Data

| Where | What |
|---|---|
| `quotes/{id}/versions/{n}.prepared` (draft versions only) | `requestId`, `at`, `by`, `pdf` (`path`, `size`, `sha256`), `issueDate`, `validUntil`, the frozen `customer` and `business` details, the staff's `pipeline` choices (`reopen`, `value`), the selected `channels` |
| `quotes/{id}/deliveries/{did}` | One per channel per send request. `did` = `{version}-{hash of requestId}-{channel}`. `channel` (`whatsapp` / `email`), `version`, `requestId`, `state` (`queued` / `sending` / `sent` / `failed` / `unknown`), `attempts`, `claimedAt`, `sentAt`, `message` (the exact text sent), `to` (email address used), `pdf` (path, size, sha256), `provider` (WhatsApp message id or Gmail id), `error` (a code and a plain sentence, never customer details), `resolvedBy` (when staff settled an "unsure"), `history` (last 20 events) |
| `quotes/{id}` | adds `preparedSend` (`version`, `requestId`) while a send is locked; `rev` still guards every change |
| `conversations/{phone}.reopen` | `state` (`sending` / `sent` / `failed` / `unknown`), `requestId`, `claimedAt`, `sentAt`, `wamid`, `templateName`, `by`, `error` |
| `conversations/{phone}/messages/{wamid}` | the quote document appears like any other outgoing document, with `quote: { id, ref, version }` so the chat can label it; the template appears as an outgoing template message (`[template: name] …`) |
| Storage `quotes/{phone}/{id}/v{n}-{hash}.pdf` | unchanged: one path per send request, never overwritten, private, erased with the customer |
| Storage `media/{phone}/{wamid}/…` | a copy of the PDF for the chat bubble, so the existing media, retention and signed-link code is not touched. After 24 months it is removed with the other chat media; the quote's own PDF stays |

* No Firestore or Storage rule change and no new index (single-field queries, staff-only reads, no browser writes).
* Deliveries live under the quote, so the existing customer erasure removes them, with the quote's versions and PDFs.
* Existing Phase 6 sent versions have no delivery records: the history shows them as **"marked sent by hand"** (no migration).
* Logs and stored errors hold codes and ids only: no names, phone numbers, email addresses or message text.

### One request, one send: idempotency

| Situation | What happens |
|---|---|
| Double click, or the browser retries after a timeout | One request number per Send dialog. The same number again returns the current state and sends nothing. |
| Two staff press Retry on the same failed channel | Moving a delivery from `failed` to `sending` is a compare-and-set in a transaction: one winner, the other is told it is already in progress. |
| The window closes between opening the dialog and sending | The server re-checks. The WhatsApp delivery fails with "the 24-hour window has closed" before anything is sent. |
| WhatsApp refuses (Meta 4xx, e.g. 131047) | `failed`, with a plain-English reason. Safe to retry. |
| Media upload fails (the step before the message) | `failed`: nothing was sent. |
| Timeout, network loss or a Meta/Gmail 5xx **during the final send call**, or the function dies after claiming | `unknown`: we cannot tell whether it arrived. **Never retried automatically.** The screen says "We couldn't confirm it was delivered. Check WhatsApp (or the Sent folder of info@), then choose: **It arrived** / **It didn't arrive, try again**." A `sending` older than 3 minutes is treated as `unknown`. |
| WhatsApp succeeds, email fails | Two independent records. The quote is Sent (WhatsApp confirmed). **Retry email** sends only the email. |
| Both fail | Nothing committed; the draft stays locked with a clear next step. |
| Meta accepted the message but our write to Firestore failed | `unknown` (as above); the delivery-status webhook still records the message. |

### Reopen conversation (general, decision 9)

* **Window state** is derived, never stored, from the customer's last message and the last Reopen: **open** (last customer message
  under 24 hours ago), **awaiting** (a Reopen template was sent after their last message, within 24 hours, and has not failed),
  **closed**. A pure function shared by the server and the screen (identical browser copy with a parity test, as for the quote
  calculator). **The webhook does not change**: a customer's reply updates `lastInboundAt` as it does now, so the chat unlocks
  by itself.
* **The screen never implies the conversation is open before the customer replies:**
  * *Closed:* "More than 24 hours since {name} last messaged: WhatsApp only allows an approved template until they reply."
    **[Reopen conversation]**
  * *Awaiting:* "Template sent at 14:02 (delivered). Waiting for {name} to reply. You can't send normal messages until they do."
    No button.
  * *Failed:* "WhatsApp couldn't deliver the template: {reason}." Closed again, subject to the cap.
  * *Open:* the normal composer.
* **`reopenConversation({ phone, requestId })`** (staff only): refuses if the window is open; enforces **one Reopen template per customer
  per 24 hours** (a send in progress, sent, or unsure counts; **proposed, owner to confirm:** a template Meta reports as never
  delivered, for example because it expired, does not count, since the customer never saw it); claims first (the same claim-then-send
  rule); sends the Reopen template with the customer's first name (or "there"); records it in the chat as an outgoing
  template. Works for any customer, with or without a quote.
* **Template** (`WHATSAPP_REOPEN_TEMPLATE_NAME` / `_LANG`, plain settings, not secrets): see "Meta templates".

### Channel adapters

Each channel is a small adapter behind one interface (`send` returns a provider id or a classified failure: definite = `failed`,
ambiguous = `unknown`). The send service knows nothing about WhatsApp or Gmail.

* **WhatsApp:** checks the window on the server; uploads the stored PDF to WhatsApp; sends **one** document message with the
  editable text as its caption (WhatsApp's limit is 1,024 characters) and the file name `EliteKitchens-EK-0104-v1.pdf`; records
  the chat message (with the quote label and a copy for the bubble); delivery ticks arrive through the existing webhook.
* **Email:** Gmail API `messages.send` as `info@elitekitchens.ie`, to the customer's saved address (frozen on the version),
  plain-text body (the editable text, signed as Quote Settings says), the exact PDF attached, a subject in the existing style.
  Switch: `MAIL_SEND` on/off (default off, like `GCAL_SYNC`), `MAIL_SENDER`, `MAIL_SERVICE_ACCOUNT` (plain settings).
* A future channel (or the optional template route, M7) is another adapter.

### Callables

New, all staff-only (`assertStaff`), each a named, strictly checked function that records an actor (staff today), so a future
assistant could use exactly these as tools: `deliverQuote` (prepare, deliver, commit; ≈ `send_quote`, with per-channel
functions `sendQuoteWhatsApp` / `sendQuoteEmail` inside), `retryQuoteDelivery`, `resolveQuoteDelivery` ("it arrived" / "it didn't"),
`cancelQuoteSend`, `reopenConversation` (≈ `reopen_whatsapp_conversation`). They bind only the WhatsApp access token (not the app
secret or verify token) and the email route needs no secret. The 14 Phase 6 quote functions stay free of secrets.
One limit for later AI: the first PDF is still made in the browser, so an assistant could send existing prepared PDFs but not
create a first one until server-side PDF generation exists (not in 6.1).

### History on screen

Each sent version lists its deliveries, newest first, for example:
```
EK-0104 v1   Sent 5 Oct 2026, 14:32 via WhatsApp (PDF v1)
             Sent 5 Oct 2026, 14:33 via Email (PDF v1)
EK-0104 v2   Email failed: … [Retry email]
```
A revised and resent quote keeps every earlier PDF; the history also appears in the quote's activity and the customer profile.

## Security and privacy

* Quote PDFs stay private: no public URL, staff open them through 10-minute signed links. No customer data in logs.
* Deleting a customer still erases their quotes, deliveries and quote PDFs, and the chat copy. **Not erased by Elite OS:** the email
  copy in `info@`'s Sent folder at Google and the copies WhatsApp/Meta hold (added to `docs/DATA_CONTROLS.md` in M6).
* The email route uses domain-wide delegation limited to `gmail.send` and a hard-coded sender setting: it can send as that address
  and nothing else, and only the functions' runtime identity can use it.
* Webhook verification, Meta Lead Ads, Appointments / Google Calendar, Quotes and the CRM stage rules are not changed.

## Milestones

Each milestone ends with a commit and a report. The next starts only when the owner says so. Test-harness fixes go in their own
commits and never weaken an assertion.

| | Scope | Effect on the live system |
|---|---|---|
| **M0** | This design, branch from the tag, baseline run of every existing suite | None |
| **M1** | **Reopen conversation** (general): window state, `reopenConversation`, the 24-hour cap, the chat states (closed / awaiting / failed), tests with a fake Meta | None until deployed; preview only |
| **M2** | **Delivery foundation**, no real channel: `send` split into prepare + commit (Phase 6 tests unchanged), delivery records, state machine, idempotency, retry, resolve, cancel, history, erasure. Tests with a fake channel and planted-error checks | None |
| **M3** | **WhatsApp quote sending**: adapter, document message with caption, chat bubble with the quote label, window re-check, tests with a fake Meta | Preview only |
| **M4** | **Email**: Gmail adapter (keyless), message builder, setup script, `MAIL_SEND` switch, tests with a fake Google. Owner's one-time Workspace approval and the DNS read-only check | Preview only |
| **M5** | **Screens**: the Send dialog (channels, editable text, per-channel results, retry / unsure / cancel), the history on the quote, the sent versions and the customer profile; desktop and phone browser tests | Preview only |
| **M6** | `scripts/deploy-quote-sending.sh` and rollback, docs, preview channel `phase61` with a controlled test customer, owner review, **live (approval)**, **merge and tag (approval)** | Controlled |
| **M7 (optional, later)** | Quote PDF inside an approved template outside the window (adapter + template settings) | Later |

Rollback: close the new functions (like Phase 6's `--close`) and roll Hosting back; data stays; the old screen simply does not
show it. The 14 Phase 6 functions and the manual path keep working throughout.

## Meta templates (the owner creates these in WhatsApp Manager)

Business Suite / business.facebook.com > **WhatsApp Manager** > **Message templates** > **Create template**, for the existing
business account. Names are lowercase with underscores. Tell me the **exact name and language code** afterwards (they are plain
settings, not secrets). Meta may take minutes to a day and may change the category: accept the category it assigns.

**1. Reopen conversation (needed for M1)**

| Field | Value |
|---|---|
| Name | `elite_kitchens_reopen` |
| Category | Utility (Meta may reclassify it as Marketing: accept) |
| Language | English (`en`) |
| Header | none |
| Body | `Hi {{1}}, it's Elite Kitchens. We have a quick question regarding your project. When you have a moment, please reply here and we'll continue the conversation.` |
| Sample for {{1}} | `John` |
| Footer | none |
| Variable type | **Number** (`{{1}}` is the customer's first name; the sending code sends numbered variables) |
| Buttons | **Add button > Custom** (WhatsApp Manager's name for a quick-reply button): `Go ahead`; a second **Custom**: `Not now`. No website, call, Flow or contact buttons |
| Message validity period | **On, 12 hours** (the maximum; see below) |

A tap on either button counts as the customer's reply and opens the 24-hour window; staff will see the button text as the
message. A single button is also fine.

**Message validity period.** For Utility templates Meta drops a message that cannot be delivered within the validity period
(default **10 minutes**, custom 30 seconds to 12 hours): the customer never sees it and it is not charged. Ten minutes would lose
every template sent to a phone that is off or out of signal, so both templates are set to 12 hours. If Meta reclassifies a
template as Marketing the setting may not apply (Marketing messages are retried for far longer).

**2. Quote document (optional, M7; may be submitted now)**

| Field | Value |
|---|---|
| Name | `elite_kitchens_quote_document` |
| Category | Utility |
| Language | English (`en`) |
| Header | **Document**; upload a harmless one-page sample PDF (for example one saying "Sample quotation": never a real customer's quote) |
| Body | `Hi {{1}}, as discussed, please find attached your Elite Kitchens quotation {{2}}. If you have any questions or would like to make any changes, just reply here.` |
| Variable type | **Number** |
| Samples | {{1}} `John`, {{2}} `EK-0104-v1` |
| Footer | none |
| Buttons | **Add button > Custom**: `I have a question` |
| Message validity period | **On, 12 hours** |

Keep both free of offers, discounts or calls to action: that is what makes Meta reclassify a template as Marketing.

## Testing

* Every row of the idempotency table, the Reopen cap, the window states, "Sent only after a confirmed delivery", the commit's
  reuse of the pipeline rules, erasure, staff-only access, secrets and logs. Fake Meta and fake Google servers for the adapters.
  Planted-error checks (a failed channel recorded as sent; a retry that resends the successful channel; the 24-hour cap skipped;
  the quote marked Sent while every channel failed) must each be caught.
* All existing suites must pass unchanged; browser suites on desktop and phone.
* A real controlled test only at the preview (M6), with a contact the owner chooses.

### Baseline (M0)

Run on 2026-10-05 on branch `phase-6-1-quote-sending` at `ab84a7d` (identical to `main` and tag `phase-6-quotes-complete`), before
any code change. All emulator-only: nothing touched the live project, nothing real was sent.

| Suite | Result |
|---|---|
| Backend (`npm test`) | 201 of 201 passed |
| `ui.e2e.js` | 57 of 57 |
| `lead.e2e.js` | 11 of 11 |
| `crm.e2e.js` | 14 of 14 |
| `dnd.e2e.js` | 13 of 13 |
| `conversion.e2e.js` | 10 of 10 |
| `appointments.e2e.js` | 17 of 17 |
| `quotes.e2e.js` | 20 of 20 |
| `quote-send.e2e.js` | 9 of 9 |
| `theme.e2e.js` | 10 of 10 (in Google Chrome) |

Every suite passed on the first run. Run as in the owner's PC notes: `NODE_PATH` set to the global npm folder, `CHROMIUM` set to
Playwright's headless shell (Google Chrome for `theme`), one suite at a time. No test file was changed.

## Built so far

### M1: Reopen conversation

Built and tested on 2026-10-05. Nothing deployed; nothing real was sent. The existing screen and every existing function behave as
before, apart from the closed-window band (below).

| File | What |
|---|---|
| `functions/lib/windowState.js` | The 24-hour rule and the Reopen state (open / awaiting / closed), the first-name rule and the Reopen wording. Pure functions. `public/window-state.js` is an identical copy for the browser (a test fails if they differ: after changing the original, copy it over) |
| `functions/lib/reopen.js` | The action: claim, send, record. Knows nothing about quotes |
| `functions/lib/whatsapp.js` | A failed send now says whether it was **definite** (not configured, or Meta answered 4xx: nothing was sent) or **ambiguous** (5xx, no message id, network failure, timeout); an optional time limit; `sendTemplateByName`. Existing methods behave exactly as before |
| `functions/lib/handlers.js`, `functions/index.js` | The staff-only wrapper and the callable `reopenConversation`. It binds **only the WhatsApp access token** (not the app secret or verify token). Two plain settings, not secrets: `WHATSAPP_REOPEN_TEMPLATE_NAME` (default `elite_kitchens_reopen`) and `WHATSAPP_REOPEN_TEMPLATE_LANG` (default `en`). `handlers.js` now takes its 24-hour constant from the shared module (same value) |
| `public/index.html`, `app.js`, `app.css`, `firebase.json` | The band under the chat, the composer states, the confirmation dialog; the new script is served with no-cache |
| `functions/test/reopen.test.js`, `test-ui/reopen.e2e.js` | 20 backend tests and 14 browser checks |

What staff see: **open** (nothing changes); **closed**: "More than 24 hours since {name} last messaged (or "{name} hasn't messaged yet").
WhatsApp only allows an approved template until they reply." with **Reopen conversation**; the button opens a confirmation showing the
exact wording ("Hi Anna, it's Elite Kitchens…") and saying messaging stays off until the customer replies; after sending, **awaiting**:
"Template sent 14:02 (delivered). Waiting for {name} to reply. You can't send normal messages until they do." (no button, composer off,
the placeholder says "Waiting for {name} to reply…"); when the customer replies, even by tapping a button, the band disappears and the
composer unlocks by itself. A template Meta refused shows the reason in plain words and Reopen is offered again.

How it behaves, beyond the plan:

* **One request number per dialog**, so a double click sends once (tested through the screen and through the function). After an
  error the dialog offers only Close; the chat then shows what happened and offers Reopen again only when it is allowed.
* **The 24-hour allowance** counts a template that is in progress, sent (delivered or not yet), or not confirmed. It does **not** count a
  template Meta refused (nothing was sent: for example the template was not approved yet) or one Meta reports as never delivered (for
  example it expired). **Exception:** Meta's own "wait 24 hours" (131049) and "customer opted out" (131050) answers still count, and the
  band says when to try again. *This follows the owner-confirmation proposal in "Open items": say if the cap should be stricter.*
* **Not confirmed** (Meta 5xx, no message id, network failure, a send with no answer after 20 seconds): recorded as "not confirmed",
  counted, never retried by itself, with a message in the chat telling staff to check before trying again. A send still in progress
  after 3 minutes is treated the same way.
* **The customer is erased while a template is in flight:** nothing is recreated.
* **Failures in plain English** for the Meta errors most likely to be met (template unknown or not approved, paused, disabled, number not on
  WhatsApp, held back, opted out, too many messages), always with Meta's code.
* The screen re-checks every minute and whenever a delivery status arrives, so a window that closes, or a "waiting" that runs out its
  day, is shown without reloading.
* Customers added without messaging, or who never wrote, get the same band ("hasn't messaged yet") and Reopen. The old welcome template
  stays in **New conversation** for brand-new numbers.
* The one existing browser check about the 24-hour band (`ui.e2e.js`) is unchanged and passes: the band keeps its id and the composer
  stays disabled; only the button's label changed.

**Tests.** 20 backend tests (the state table including the 24-hour edge, the cap table, idempotency including five calls at once, two
members of staff at once, refusals, every "not confirmed" kind including a hung call, delivery statuses through the existing webhook
code, a delivery status that arrives before our own record, erasure mid-send, logs and stored errors free of names, numbers and message
text, staff-only access, the browser copy). 14 browser checks, desktop and phone, with screenshots. **Nine planted errors** were each
caught: a sent template treated as opening the window; the cap skipped; no claim before sending; a refused template recorded as sent;
a "not confirmed" send treated as refused; the full name sent instead of the first name; a log leaking numbers; the staff check
skipped; a delivery notice's reason overwritten by our own record.

**Found and fixed while building M1.** The full regression run caught a race that the new browser check missed when run alone: the
screen shows "waiting for the customer" the moment the Reopen is recorded, and Meta's delivery status can arrive within milliseconds. M1
first recorded the Reopen and then, separately, wrote the chat message; the existing message-saving code (`storeOutbound`) writes
`error: null` over a status that beat it, so a "not delivered" notice arriving in that gap lost its reason (131049) and the screen
wrongly offered Reopen again. Now the Reopen and the chat message are recorded in **one transaction** (`recordSent` in `reopen.js`), a
status that arrived first keeps its status and its reason, and a test proves it (and fails if the old behaviour returns). The existing
`storeOutbound` is unchanged: the same gap can in principle affect any outbound message whose "not delivered" notice beats its own
record, which needs a status to arrive within milliseconds of the send; left alone, noted here.

**Regression (2026-10-05, after M1):** backend 221 of 221 (the 201 from the baseline unchanged, plus the 20 new ones); browser suites `ui`
57/57, `lead` 11/11, `crm` 14/14, `dnd` 13/13, `conversion` 10/10, `appointments` 17/17, `quotes` 20/20, `quote-send` 9/9, `reopen` 14/14
(new), `theme` 10/10 (Chrome). No existing test file was changed. Two things happened on the way, both reported plainly: (1) the first
full run showed the race described above (the new browser check failed there; fixed, then everything passed); (2) in that same first
full run the Phase 5 test "the immediate push, the sweeper and Retry now all at once still produce exactly one event"
(`calendar.test.js`) failed once (it counted two lookups of the fake Google where it expects one). Nothing M1 changed touches the
calendar code; that test deliberately slows the fake Google by 250 ms so that attempts overlap, so its count can vary on a heavily
loaded run. It then passed 5 of 5 on its own and in the next full run. Treated as a timing flake of the harness, not an M1 fault.

**To check at the preview, with the real Meta (cannot be checked with a fake):** that the template, sent with only the first-name
parameter, is accepted with its quick-reply buttons; that the wording in `windowState.js` still matches the approved template; and
how the chat bubble reads. It shows the existing `[template: name]` prefix, as for the welcome template; it can be tidied later.

## Open items

* The Reopen template's name and language (owner creates it; needed before the M1 preview).
* The owner to confirm that a template Meta reports as never delivered does not use up the one-per-24-hours Reopen cap.
* Email authentication (SPF / DKIM / DMARC): decided by the M4 header check, not before.
* Whether free-form replies are billed from 1 October 2026 (check WhatsApp Manager billing).
* For customers who have never messaged (phone or walk-in enquiries): whether the closed band should also offer the old
  "welcome" template next to Reopen. To be decided in M1.
