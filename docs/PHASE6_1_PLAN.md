# Phase 6.1 — Direct quote sending and "Reopen conversation" (agreed design)

Status (2026-10-05): **M0 to M5 are built and tested** (design, Reopen conversation, delivery foundation, WhatsApp, email, the Send screen), in
a state ready for the owner's review. **Nothing is deployed, nothing real has been sent, nothing outside this repository has been changed.**
Next: the owner's review, then M6 (backend deploy, preview with a controlled test customer, live, merge and tag: each only with explicit
approval; see "Testing the preview" and "Rollout"). Branch `phase-6-1-quote-sending`, started from tag `phase-6-quotes-complete`
(`ab84a7d`). The first half of this document is the agreed specification; "Built so far" records what was built and how it was tested. A rule in
the specification changes only with the owner's approval.

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
  per 24 hours** (a send in progress, sent, or unsure counts; **owner-confirmed 2026-10-05:** a template Meta reports as never
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
  band says when to try again. *Confirmed by the owner on 2026-10-05: confirmed failed or not delivered does not use the cap; unsure does (the customer may have received it); Meta's "wait 24 hours" and "opted out" answers keep blocking.*
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

### M2: the delivery foundation

Built and tested on 2026-10-05. Nothing deployed, and **no new Cloud Function is exported**: the delivery actions can be reached only
from tests until M3 adds the first real channel, so nothing in this milestone is reachable from a browser. No Firestore or Storage rule,
index or setting changed.

| File | What |
|---|---|
| `functions/lib/quotes.js` | Phase 6's `send` is now built from shared pieces (`parseSend`, `storeSendPdf`, `checkSendable`, `applySent`) with **unchanged behaviour, wording and records**. `applySent` is the only place a version is frozen, a quote marked Sent and the pipeline rules applied. New: `prepare`, `readState`, `commitPrepared`, `releasePrepared`. The draft is locked while a send is prepared (`saveDraft`, `discardDraft`, `deleteDraft` and the old `send` refuse; `pdfLink` can also open the prepared PDF; deleting a never-sent quote now also deletes its delivery records) |
| `functions/lib/quoteDelivery.js` | The delivery module: `deliver`, `retry`, `resolve`, `cancelSend`, `markSent`, the `ChannelError` a channel adapter throws, the state machine. Knows nothing about WhatsApp or Gmail |
| `functions/lib/handlers.js` | Staff-only wrappers (`deliverQuote`, `retryQuoteDelivery`, `resolveQuoteDelivery`, `cancelQuoteSend`, `markQuoteSent`) |
| `functions/test/delivery.test.js` | 30 tests |

**The channel interface** (what M3's WhatsApp and M4's email adapters implement): `{ maxMessage, check(ctx), send(ctx) }`. `ctx` holds
the quote number, version, customer phone, the address to use (email only), the message, the exact PDF (`pdf.bytes`, size, SHA-256) and a
file name. `check` may return `{ ok: false, code, text }` to refuse before anything is sent (the 24-hour window has closed, there is no email
address). `send` returns `{ providerId }` or throws `ChannelError(text, { code, definite })`: **definite** means nothing was sent (recorded as
failed, safe to retry); anything else, including any other error, means we cannot tell (recorded as **unknown**).

**What `deliver` does.** For a draft it takes Phase 6's `sendQuote` fields plus `channels` and `messages`: *prepare* (the same checks and
stored PDF as `send`, the draft locked, the delivery records created in the same transaction, **nothing marked sent**), then each channel in
the order WhatsApp, email: *claim* (a compare-and-set in a transaction: one winner), check the stored PDF against its SHA-256, hand it to the
channel, *record* the answer. The first channel to confirm also **commits** in that same transaction (`commitPrepared`, which runs
`applySent`: the version frozen from what was frozen at prepare, the quote Sent, `planSend` and the value rules). With `version` and no PDF
fields it delivers an already-sent version's stored PDF through more channels: no prepare, no commit, no change to the quote record.

**Rules, all tested.**
* **A failed channel is never recorded as sent**, and one channel failing never undoes another's success. If every channel fails, the quote,
  the customer's stage and the pipeline value are exactly as they were, and the draft stays locked.
* **The same request again** returns the current state and sends nothing (it only finishes a channel still "queued", for example after a
  crash before the claim); a failed channel is retried only by an explicit **retry**. Five identical requests at once, and four retries at
  once, send once per channel.
* **Not confirmed** (`unknown`: a provider answer we cannot read, a crash, a send still "sending" after 3 minutes): never retried by itself,
  never cancelled over, and refused for a retry. Staff **settle** it: "it arrived" counts it as delivered (and commits); "it did not arrive" makes it
  a failure that can be retried. A late answer from a send that was settled meanwhile is not written over the staff member's decision.
* **Retry** works on a failed channel only, can carry an edited message, re-checks the stored PDF, and, for a send not yet marked sent,
  refuses once the date on the quote is neither today nor yesterday (the same rule as Phase 6's send): cancel and send again.
* **Cancel** unlocks the draft and deletes the prepared PDF; refused while any channel has delivered, is sending, or is not confirmed.
* **Mark as sent by hand** on a prepared send commits it through the same rules with a "manual" delivery record, using the stored PDF.
* **Never overwritten:** every send request stores its own PDF; revising and resending keeps every earlier version's PDF and deliveries.
* Existing Phase 6 sent quotes have no delivery records: they are simply "marked sent by hand" (no migration).
* **Privacy:** logs hold a channel and a code only (an unexpected error's own message is never logged); stored errors are plain sentences
  or codes; erasing a customer removes the deliveries with the quotes (tested, prepared or delivered).

**Tests.** 30 backend tests, including one that runs Phase 6's own `send` and the delivery commit side by side for every stage (New lead,
Booked, Quoted, Won, Closed, with and without "reopen") and every value choice, and checks the quote, the version, the customer's stage and
the pipeline value come out identical. **Twenty planted errors** were each caught: a failed channel recorded as sent; a delivered channel
resent by a retry; committing when the channel failed; the quote marked Sent at prepare; no one-winner claim; an unconfirmed send treated as
failed; an unconfirmed send retryable; the draft editable while prepared; cancelling over an unconfirmed send; the staff check skipped; every
request sharing one PDF path; a late answer overwriting staff's decision; marking sent by hand while a channel is sending; an out-of-date send
retried; the PDF not verified before sending; channels in the wrong order; the "reopen" choice ignored; cancelling not unlocking the draft;
deleting a cancelled quote leaving its deliveries; the old send ignoring the lock. (Two of my first attempts at planting an error did not
test anything: one crashed on a typo of mine, and one removed only one of two guards that do the same job; both were redone properly.)

**Regression (2026-10-05, after M2):** backend 251 of 251 (the 221 from M1 unchanged, plus the 30 new ones); browser suites `ui` 57/57, `lead`
11/11, `crm` 14/14, `dnd` 13/13, `conversion` 10/10, `appointments` 17/17, `quotes` 20/20, `quote-send` 9/9, `reopen` 14/14, `theme` 10/10
(Chrome). `quotes` and `quote-send` drive the real Send dialog through the refactored Phase 6 `send`. No existing test file was changed.
Before the delivery module was built, the 65 existing quote, customer and calculator tests were run against the refactored `send` alone and
all passed.

**Left for later milestones.** The adapters (M3, M4); the Cloud Function exports and their deploy script (M3); the screens (M5);
the history on screen reads the delivery records (M5).

### M3: WhatsApp quote sending

Built and tested on 2026-10-05. Nothing deployed. Reuses the **existing** WhatsApp client and conversation records: no second WhatsApp
system.

| File | What |
|---|---|
| `functions/lib/quoteChannels.js` | `whatsappChannel`: the channel for the delivery module (`check` and `send`) |
| `functions/lib/whatsapp.js` | additive only: an optional time limit on `uploadMedia` and `sendMedia`, and the Meta error code on a failed upload. Every existing call behaves exactly as before |
| `functions/lib/store.js` | additive only: `storeOutbound` takes an optional `extra` (the quote label). `storeOutbound`'s existing behaviour, including the known millisecond race, is unchanged and still documented technical debt |
| `functions/index.js` | the callables `deliverQuote` and `retryQuoteDelivery` (they hold only the WhatsApp access token; 180 s), `resolveQuoteDelivery`, `cancelQuoteSend`, `markQuoteSent` and `quoteChannels` (no secrets) |
| `functions/test/quote-whatsapp.test.js` | 24 tests |

How it works: the server **re-checks the 24-hour window at send time** (`WindowState`, the same rule as the screen and the chat), so what the
browser showed is never relied on. It refuses (a failure, nothing uploaded or sent) when the window is closed, or when a Reopen
template is waiting for the customer's reply; the words say so and say to reopen the conversation. If the window closes after our check,
Meta's own answer (131047) is turned into the same plain failure. It then uploads **the exact stored PDF** to WhatsApp and sends **one
document message with the editable text as its caption** (limit 1,024 characters), and records it in the existing conversation: an
outgoing document labelled with the quote (`quote: { id, ref, version }`), with its own copy of the PDF under `media/` so the existing
media viewer, retention and erasure code is used unchanged (the quote keeps the original). If that chat record cannot be made after Meta
accepted the message, the delivery is still a success.

Failure shapes, all tested: Meta refuses (4xx): a failure in plain words, nothing in the chat, safe to retry. The PDF upload failing (any
way): a failure, because nothing reached the customer. Meta 5xx, an answer without a message id, no connection, or no answer in 20 s:
**not confirmed**, never resent by itself. A Reopen template does not open the window; only the customer's reply does (tested end to end
through the M1 code and the existing `storeInbound`).

### M4: email quote sending

Built and tested on 2026-10-05. Nothing deployed, no DNS changed, no email provider account added, no real email sent.

| File | What |
|---|---|
| `functions/lib/gmail.js` | a minimal Gmail client (REST, no extra packages), the **keyless** sign-in, and the hand-built email |
| `functions/lib/quoteChannels.js` | `emailChannel`: the channel for the delivery module |
| `functions/lib/quoteDelivery.js` | additive: an optional `subject` for the email, the customer's **current** address when an already-sent version is sent again |
| `scripts/setup-mailer.sh` | the one-time Google Cloud setup (below), safe to repeat, `--check` is read-only |
| `functions/test/gmail.test.js`, `functions/test/quote-email.test.js` | 11 and 19 tests |

Sign-in, with no key, password or token stored anywhere: the function's own runtime identity gets a short-lived token; it asks the **IAM
Credentials** API to sign a one-hour request for the dedicated service account `ek-mailer` naming the mailbox (`info@elitekitchens.ie`)
and the **single scope `gmail.send`** (it can send, and cannot read mail); Google's token endpoint exchanges that for a one-hour Gmail
token (cached, renewed 5 minutes before it expires). `ek-mailer` has no project roles and no keys. Every failure of this sign-in is
**definite** (nothing was sent) and says which step.

The message: plain text, the customer's saved address (frozen on the quote at the time it was prepared), `From: "Elite Kitchens"
<info@elitekitchens.ie>`, `Reply-To` the same (so replies come back to `info@`, and the message sits in its Sent folder), the editable text
as the body, the **exact stored PDF** attached. Built by hand, so it is tested hard: quoted-printable text (round-trips `=`, accents, euro,
em dash, emoji, long lines, spaces at the end of a line), RFC 2047 encoded subject and name in words of at most 75 characters, base64 PDF
that survives byte for byte at every length, and **nothing can break out of a header** (a line break or odd address in the subject, name,
recipient or file name is refused; the body may contain anything). The default subject is the existing wording
(`Elite Kitchens — Kitchen Quote EK-0104 v1`), editable.

Failure shapes: Google refusing (400, 401, 403, 429) is a failure in plain words ending "Nothing was sent."; Google 5xx, an answer
without a message id, no connection or no answer in 20 s is **not confirmed** ("check the Sent folder of info@"), never resent by itself.
The email switch: `MAIL_SEND` is **off** unless it is `on` and `MAIL_SENDER` and `MAIL_SERVICE_ACCOUNT` are set (plain settings, not
secrets); with it off the channel refuses with "Email sending is not switched on yet" and Google is never contacted. In the emulator,
`MAIL_API_BASE` points at a local fake Gmail.

**What the mailbox owner must do once** (the owner said yes to this): see "One-time Google Workspace setup" below. **No DNS change is
needed to build or test anything**; see "Email authentication" below for what the preview test decides.

### M5: the send experience

Built and tested on 2026-10-05. Nothing deployed.

| File | What |
|---|---|
| `public/quote-send-model.js` | the logic behind the dialog, pure and unit-tested in Node (`functions/test/quote-send-model.test.js`, 11 tests): which channels can be used and why not, the default wording, how each delivery is described |
| `public/quotes.js`, `public/index.html`, `public/app.css` | the Send dialog, the results, the "send in progress" box, the delivery lines under each sent version, the activity wording |
| `public/app.js` | "Reopen conversation" can be opened from anywhere (the Send dialog uses it), the Send dialog follows the customer's conversation live, and a quote document in the chat shows a **Quote EK-0104 v1** label that opens the quote |
| `test-ui/quote-delivery.e2e.js` | the browser test (desktop and phone) |

What staff see. **Send quote** opens a dialog that shows **Send via** with each channel and why it can or cannot be used:

* **WhatsApp:** *Available* (window open, and until when), *24-hour window closed* (disabled, with **Reopen conversation**: the same
  confirmation as in the chat), *Template sent at 14:27. Waiting for Anna to reply: WhatsApp does not allow this message until they do*
  (never "reopened"), or no conversation. When the customer replies the row unlocks by itself, without closing the dialog.
* **Email:** *Available: anna@example.com*, *No email address: add one in the customer's Details*, a bad address, or *not switched on yet*.
* **One channel is ticked by default** (WhatsApp if it can be used, else email); staff tick both if they want both. Each ticked channel
  has its own **editable message**: WhatsApp (1,024 characters) and email (subject and body), prefilled with the approved wording.
* Staff cannot press **Send quote** with no channel. When none can be used the dialog says how to fix that (reopen WhatsApp, add an email
  address) and offers the fallback below.

After **Send quote** the dialog shows **each channel's result on its own**: `✓ WhatsApp: sent 5 Oct 14:32`, `✕ Email: failed` with
the plain reason and **Retry Email**, or `? WhatsApp: delivery not confirmed` with **It arrived** / **It did not arrive** and no Retry.
The headline says **"sent"** as soon as one channel confirmed, and otherwise **"not sent yet"** with what to do next. If every channel
fails, the quote stays a locked draft and the quote page shows a **"A send is in progress: v1 is not marked sent"** box with the
channels, **Download PDF**, **I sent it myself: mark as sent** and **Cancel this send**; the draft cannot be edited until it is finished.
A connection that drops during a send is shown as "we do not know whether it went", and pressing Send again is safe (same request).

Also: **Send this version…** (on a sent quote and on each sent version) delivers the stored PDF of a version already sent, by WhatsApp or
email, with no new version and no change to the quote; **Send again…** (new version, new dates) and **Revise** are unchanged. **The
manual ways stay as the fallback**, under the same ids as before: "Prefer to send it yourself? Make the PDF and mark it sent", then
Download PDF and Email draft; and "I sent it myself" on a prepared send. Existing quotes marked sent by hand show "Marked sent: no channel
recorded". The quote's **Sent versions** list shows every version's deliveries channel by channel (a failed attempt is hidden once the same
channel has since delivered), the **activity** says "sent v1 via WhatsApp", the quote row and the customer's profile say "Sent 3 Oct via
WhatsApp", and the chat shows the document labelled with the quote number. PDF v1 stays exactly as it was when v2 is sent.

### Results at the end of M5 (2026-10-05)

All on emulators with fake providers: nothing real was sent, nothing was deployed, nothing outside the repository was changed.

| Suite | Result |
|---|---|
| Backend (`npm test`) | **317 of 317** (baseline 201, +116: Reopen 20, delivery 30, Gmail 11, WhatsApp 24, email 20, send model 11) |
| `ui.e2e.js` / `lead` / `crm` / `dnd` / `conversion` / `appointments` | 57 of 57 / 11 of 11 / 14 of 14 / 13 of 13 / 10 of 10 / 17 of 17 |
| `quotes.e2e.js`, `quote-send.e2e.js` (Phase 6, **unchanged**, now against the new Send dialog) | 20 of 20, 9 of 9 |
| `reopen.e2e.js` (M1) | 14 of 14 |
| `quote-delivery.e2e.js` (M5, new; desktop and phone) | 16 of 16 |
| `theme.e2e.js` (Google Chrome) | 10 of 10 |

No existing test file was modified. The one harness change is in `test-ui/run.sh` (it also writes the fake-Gmail settings), in its own commit.

**Planted errors** (a deliberate bug is put into the code and the tests must fail; every source file was restored byte-for-byte after each):
backend **47 of 47 caught** (M1 8, M2 20, M3/M4 19), among them: a failed channel recorded as sent; the quote committed while every channel
failed; a retry that resends a delivered channel; no claim before sending (double send); the 24-hour window bypassed; a Reopen template
treated as opening the window; the PDF or recipient swapped; header injection allowed; the Gmail scope widened; an unsure answer treated as
refused (so retryable) or as sent; the staff check removed. Two M2 attempts were first wrong (one did not load, one removed only one of two
guards); they were redone as valid mutants and both were caught. A representative sample of eleven backend ones was run again on the final tree
(the backend code is unchanged since, except one comment). Screen, **10 of 10 caught** (by the model's unit test, the browser test, or both): a failed
channel shown as "sent"; the headline saying "sent" when nothing was sent; Retry offered on an unsure result; a closed window treated as usable; **Send quote** enabled with no
channel ticked; both channels ticked by default; a new request id on every press (the double-send guard); Reopen hidden inside the dialog; the dialog
ignoring the customer's reply; the wrong first name in the default message. One of my first attempts at the request-id one did not match the code
(nothing was changed); it was redone and caught.

**Flaky tests:** none in the final runs. One Phase 5 test (`calendar.test.js`, "immediate push, sweeper and Retry now") failed once during
M1 under the load of a full run (2 GETs instead of 1); it passed 5 of 5 alone and in every later full run, including this one. Treated as a timing
flake of a Phase 5 test, unrelated to Phase 6.1.

### Security review at the end of M5

| Check | Result |
|---|---|
| Staff-only | Every exported handler was called with no sign-in and with a signed-in non-staff user, with no database available: all 34 staff handlers (including the 7 new ones) reject with unauthenticated / permission-denied before doing anything; the 4 intentionally open ones (webhook verify and receive, claimAccess, isAllowedUser) are unchanged. Tested again per action in `delivery.test.js` and `quote-email.test.js` |
| Recipient cannot be chosen by a browser | WhatsApp goes to the quote's own customer number (read from the quote), email to the customer's saved address; a changed address stops the send. A staff user cannot send quote X to customer Y |
| Private PDF | Stored under `quotes/` (Storage rules deny all browser access); no public URL, no ACL, no `makePublic`; staff view it via 10-minute signed links; the PDF actually sent is read back and its SHA-256 compared first; the upload path must be the sender's own folder |
| Replay, double click, refresh, two staff, timeouts | One request id = one send; each delivery is claimed (compare-and-set) before the provider is contacted; a stalled "sending" becomes "unsure" after 3 minutes and is **never** retried by itself; a late answer cannot overwrite a staff decision. All tested, with planted errors |
| Stale state | The 24-hour window is re-checked on the server at send time; a changed customer, settings or draft, or an old issue date, refuses the send |
| Customer deletion | Erases the delivery records, quote PDFs, the chat copy of the document and the messages (tested in WhatsApp and email suites). Not erasable by Elite OS: the email copy in info@'s Sent folder, and Meta's and Google's own copies (`docs/DATA_CONTROLS.md`) |
| PII in logs and stored errors | Codes only, never a name, number, address, message text or PDF content (tested with logging captured, for every failure shape) |
| Secrets | No secret in the repository or its new files (scanned the 25 changed or new files for keys, tokens, private keys, passwords). No key file anywhere: Gmail sign-in is keyless (IAM signs a one-hour request for `ek-mailer`); the email functions hold no secret at all; only the two functions that send hold the WhatsApp token |
| Google permission | `gmail.send` only (checked in the code and by a planted error that widens it), sender fixed by a setting, `ek-mailer` has no project roles and no keys (the setup script warns if it finds either) |
| Unchanged | Webhook (`webhookVerify`/`webhookReceive`), Meta Lead Ads, Appointments/Calendar, Firestore and Storage rules, the CRM stage rules: `git diff` shows no change to any of them. `whatsapp.js` and `store.js` changes are additive (an optional time limit, the Meta error code on the error, an optional `extra` on an outgoing message); the old tests pass unchanged |
| Browser code | No `innerHTML` with customer text: the new code uses `textContent` only (the four existing `innerHTML` uses insert fixed SVG icons and are older than Phase 6.1) |

### Deviations from the approved design, and limits to know

1. **"Confirmed delivery" means "the provider accepted it".** Decision 1 says a quote is Sent once a channel "confirms successful delivery".
   Neither Meta nor Gmail can confirm arrival at the time of sending, only acceptance (see "What sent means"). That is what is implemented and
   what the screen now says ("accepted it for delivery"). If you want a quote to go back to a draft when Meta later reports a failure, that is a new feature.
2. **A retry of an email goes to the address stored with that attempt.** If the first attempt failed because the address was wrong, correcting it in the
   customer's Details does not change a retry that is already queued: **Cancel this send** and send again (a new send uses the corrected address, as
   does **Send this version…**). Not changed here: it is safe, only less convenient. Candidate for a later small change.
3. The two deploy and rollback scripts and the one-time mailer setup script were written in M4/M5 (the plan placed deploy scripts in M6). **None has been run.**
4. The optional M7 (quote document inside an approved template outside the 24-hour window) is **not built**, as instructed.

### Technical debt (documented, not fixed: out of scope)

* An outgoing WhatsApp message whose Meta status arrives within the same millisecond as our own record can have its stored `error` reset to null
  (`storeOutbound`). Pre-existing, rare, documented since M1; the quote delivery record itself is unaffected.
* `public/quotes.js` is large (about 1,200 lines) and now holds the whole Send flow. Splitting it is a refactor with no user value today.
* The Phase 5 calendar timing test mentioned above.

### Still needed from the owner before the preview

* **Meta: done (2026-10-07).** WhatsApp Manager shows `elite_kitchens_reopen` (Utility, English `en`) as **Active**, with the quality rating still "pending" (normal until it has been sent). The name and language are the plan defaults, so no setting changes. The second
  template (`elite_kitchens_quote_document`, Utility, Active) is not used by anything built so far (it is for the optional M7).
* **Google Workspace:** run `./scripts/setup-mailer.sh` in Cloud Shell, then authorise the printed client ID for the single scope `gmail.send` in the
  Admin console (steps above). Not done.
* **DNS:** nothing needs changing now. SPF, DKIM and DMARC are decided by the header test in "Testing the preview"; any change needs approval first.
* **Approvals:** backend deploy, preview deploy, email switched on, then (after your review) live, merge and tag. None has been given or done.

## What "sent" means (read this before the preview)

A channel counts as **sent** when the provider **accepts** the message: Meta returns a message id, Gmail returns a message id. That
is the strongest answer either gives synchronously, and it is what Elite OS records and what marks the quote Sent. It does **not** prove the
message reached the customer's phone or inbox: a phone that is off still shows one tick, a number that turns out not to be on
WhatsApp is reported by Meta a moment later, and a mailbox can bounce. For WhatsApp the later report is recorded on the chat message as
before (ticks, "failed", the existing status webhook, unchanged); the quote's delivery record and the quote's Sent status are **not** rewritten
by it. For email a bounce arrives as a message in the info@ mailbox (Elite OS cannot read it). Choosing to act on a later failure (for
example moving a quote back to a draft) would be a new feature and a business decision: not part of Phase 6.1.

## Testing the preview (controlled, real; the owner runs it after approving the preview deploy)

Nothing here has been run. **No real customer is used.** The test customer is the owner's own WhatsApp number and own email address
(ideally a second phone or a family member's who has agreed), created as a normal customer called, for example, **Test Customer**. The
preview (Hosting channel `phase61`) uses the live data and the live backend, so everything below really sends.

**Before starting (all from the owner; none is done yet)**

| Needed | Why | Status at the end of M5 |
|---|---|---|
| Meta template `elite_kitchens_reopen` approved (name and language code sent to me) | "Reopen conversation" | **done**: Active, Utility, English (owner's WhatsApp Manager screenshot, 2026-10-07) |
| Cloud Shell: `./scripts/setup-mailer.sh`, then the Workspace approval (see "One-time Google Workspace setup") | email | not done |
| An email address the owner can read, different from info@ (their own Gmail, ideally also an Outlook one) | the email test and the header check | to be given |
| A phone for the test customer that has WhatsApp and can message the business number | WhatsApp tests | to be given |
| Approval to deploy the backend, then the preview | the whole test | not given |

**The test** (each line is a tick box; tell me what you see, with a screenshot of anything odd)

1. **Reopen.** From the test phone, message the business number once, then do nothing for 24 hours (or use a number that has not messaged
   for more than 24 hours). In Elite OS open that chat: the grey band says the window is closed and offers **Reopen conversation**. Press it, confirm.
   The phone receives the template; the chat says "Template sent … waiting for Test Customer to reply" (it never says "reopened"). Press
   **Go ahead** on the phone: the chat unlocks by itself. Press Reopen again straight away: it is refused (one a day).
2. **WhatsApp quote.** Make a quote for Test Customer. **Send quote**: *WhatsApp* is ticked and says "Available". Send. The phone gets the PDF
   with the message; the dialog shows "WhatsApp: sent"; the quote is **Sent**; the customer moved from New lead to Quoted; the chat shows the
   document labelled **Quote EK-… v1**; the activity says "via WhatsApp". Open the PDF on the phone: it is the quote, v1.
3. **Email quote.** (Switch email on first: `./scripts/deploy-quote-sending.sh mail on`.) Give Test Customer your own email address. Send
   with only *Email* ticked. It arrives from info@elitekitchens.ie with the PDF attached and the subject shown in the dialog. It also appears
   in the info@ mailbox's **Sent** folder.
4. **Email authentication.** In your Gmail, open the email, **three dots > Show original**: write down SPF, DKIM and DMARC (PASS / NONE / FAIL).
   Do the same in an Outlook address. Tell me the six words. (Nothing in DNS is changed without your approval: "Email authentication" below.)
5. **Both at once.** Revise to v2 and send by WhatsApp and email together. Both arrive; the quote page lists both under v2; v1's PDF is unchanged.
6. **Send this version.** On the sent quote press **Send this version…** for v1, email only: v1 arrives again, no new version appears.
7. **Window closed while sending.** With the test customer's window closed (after 24 hours of silence), open **Send quote**: WhatsApp is
   greyed with "24-hour window closed" and **Reopen conversation** inside the dialog; email still works.
8. **No email address.** For a customer without one the Email row says so and cannot be ticked.
9. **Email switched off.** `./scripts/deploy-quote-sending.sh mail off`: the Email row says "not switched on yet"; WhatsApp still works.
   Switch it back on if you want to continue.
10. **Failure paths** cannot be forced safely with real Meta and Google, so they are proved by the automated tests with fake providers (below).
    One you can try for real, with a number you own that is **not** on WhatsApp (never someone else's): Meta may refuse at once (the quote
    stays a locked draft with "A send is in progress" and **Retry WhatsApp**) or may accept the message and report "undeliverable" a moment
    later (the quote is then marked Sent, because Meta accepted it, and the chat shows the message as failed). Tell me which you see.
11. **Clean up.** Press **Delete customer…** on Test Customer: the chat, the quotes, the PDFs and the delivery records go. The emails
    stay in the info@ Sent folder: delete them there by hand.

**Stop at once** if anything is sent to a number or address that is not your own, if a quote is marked Sent when nothing arrived, or if
a message arrives twice: run `./scripts/rollback-quote-sending.sh --close` and tell me.

## Rollout (M6, not started)

Every step is run by the owner in Cloud Shell, after approval, one stage at a time; each functions step asks for "yes" and saves the
revisions it replaces first (`scripts/deploy-quote-sending.sh`, `scripts/rollback-quote-sending.sh`). Nothing below has been run.

1. **Clone on the Phase 6.1 branch:** `cd ~/elite-kitchens-lead-os && git fetch && git checkout phase-6-1-quote-sending && git pull`.
2. **Check (changes nothing):** `./scripts/deploy-quote-sending.sh check`.
3. **Email setup (once, only needed before email is switched on):** `./scripts/setup-mailer.sh`, then the Workspace approval below.
4. **Backend:** `./scripts/deploy-quote-sending.sh backend`: the 7 new functions and the 14 quote functions (they share the quote code
   that now locks a draft while a send is prepared). Email stays **off**. The live screen is unchanged: it does not call the new functions.
5. **Preview:** `./scripts/deploy-quote-sending.sh preview` (Hosting channel `phase61`, live data and live backend). Test as in "Testing
   the preview".
6. **Email on, when the test plan reaches it:** `./scripts/deploy-quote-sending.sh mail on` (kill switch: `mail off`).
7. **Live (approval):** `./scripts/deploy-quote-sending.sh live`. Then reload Elite OS.
8. **Merge and tag (approval), after live is confirmed:** merge `phase-6-1-quote-sending` into `main` and tag it.

Rollback: `./scripts/rollback-quote-sending.sh` (the last backend deploy back to the saved revisions, in seconds), `--close` (the 7 new
functions stop answering browsers; data stays), `--mail-off`; the screen: Firebase console > Hosting > Release history > Rollback.

## One-time Google Workspace setup (email)

1. **Cloud Shell**, in the project `elite-kitchens-lead-os`: `./scripts/setup-mailer.sh`. It enables the Gmail API and IAM Credentials,
   creates the service account `ek-mailer` (no roles, no keys) and lets the functions' own account ask for tokens for it. It prints the
   **client ID** (a long number). Safe to repeat; `./scripts/setup-mailer.sh --check` only reads.
2. **Google Workspace Admin console** (admin.google.com, as a **super admin**): **Security > Access and data control > API controls >
   Manage Domain Wide Delegation > Add new**. Client ID: the number from step 1. OAuth scopes: `https://www.googleapis.com/auth/gmail.send`
   (this one only). **Authorise.** This lets Elite OS send email as a mailbox of the domain and nothing else (it cannot read mail).
3. `./scripts/setup-mailer.sh --check` should now show everything "ok".
4. Nothing else: no key, password or token is created or pasted anywhere. Email stays off until `mail on`.

## Email authentication (SPF, DKIM, DMARC): decided by evidence, not now

Inspected 2026-10-05 (see "Email" above): the domain has no SPF, DKIM or DMARC record in public DNS. **Nothing is changed.** At the preview
the owner sends one test email to their own Gmail and Outlook addresses and opens the message's headers ("Show original" in Gmail):
if SPF, DKIM and DMARC read **pass**, nothing is needed; if they read **none** or **fail**, the recommendation is SPF
`v=spf1 include:_spf.google.com ~all` (one TXT record at the root, after confirming nothing else sends as `@elitekitchens.ie`) and
DKIM switched on in Admin console (Apps > Google Workspace > Gmail > Authenticate email), with DMARC optional and monitor-only. Any DNS
change needs the owner's explicit approval first.

## Open items

* The Reopen template's name and language (owner creates it; needed before the M1 preview).
* Email authentication (SPF / DKIM / DMARC): decided by the M4 header check, not before.
* Whether free-form replies are billed from 1 October 2026 (check WhatsApp Manager billing).
* For customers who have never messaged (phone or walk-in enquiries): whether the closed band should also offer the old
  "welcome" template next to Reopen. To be decided in M1.
