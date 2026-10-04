# Phase 6.1: direct quote sending and "Reopen conversation" on WhatsApp (planned, NOT started)

Recorded on 2026-10-05 at the owner's request, during Phase 6 M5. **Do not implement any of this until the owner says
Phase 6.1 starts.** It is not part of Phase 6 and must not delay or change the Phase 6 Quotes launch.

**Before Phase 6.1 can start:** Phase 6 must be live, verified, merged into `main` and tagged
`phase-6-quotes-complete`. Then the owner decides whether Phase 6.1 or another phase comes next.

## Phase 6 stays as it is

Phase 6 (docs/QUOTES.md) launches with:
- quotes native to Elite OS and belonging to customers, with the pricing and calculations;
- the extras catalogue in Quote Settings, with quick-select buttons in the builder and custom extras;
- the quote PDF, with an exact copy of every sent PDF kept;
- Draft / Sent / Accepted / Declined, and expiry;
- the CRM and pipeline rules;
- Download PDF and the email draft (Gmail, PDF attached by hand).

Do not redesign or destabilise it to add direct sending. Its tests and the full regression suite must keep passing.

## The goal

Sending a finished quote should take seconds, from the quote itself. Roughly (the UI is designed later):

```
SEND QUOTE
Customer: John Smith        Quote: EK-0042
Send via:  [ WhatsApp ]  [ Email ]        (one, or both)
Message (editable): "Hi John, please find attached your quotation from Elite Kitchens..."
[ Send quote ]
```

Staff should no longer have to:
- download the PDF;
- open another application;
- find the customer;
- attach the PDF;
- change the quote's status by hand;
- record that it was sent.

Elite OS does all of that.

## WhatsApp

Elite OS already owns the customer's WhatsApp conversation (WhatsApp Cloud API). **Reuse that infrastructure; do not
build a second WhatsApp messaging system.**

When the customer's 24-hour customer-service window is **open**, "Send quote → WhatsApp" should:
1. use the right customer and conversation;
2. send the exact PDF version being sent;
3. send it as a document into the customer's existing WhatsApp conversation;
4. include a short message, editable before sending;
5. keep the exact PDF that was sent;
6. record that it was sent by WhatsApp;
7. record when it was sent;
8. mark the quote Sent under the existing quote rules;
9. apply the existing CRM → Quoted rules where they apply;
10. show the outgoing document and message in the WhatsApp conversation like any other message.

## The 24-hour rule: "Reopen conversation"

Today, more than 24 hours after the customer's last message, normal replies are disabled and staff can send an approved
template. Phase 6.1 should replace the dead composer with a clear **Reopen conversation** flow:

```
Window closed → [ Reopen conversation ] → template sent → waiting for the customer's reply
→ customer replies → normal 24-hour window open → the quote can be sent normally
```

* "Reopen conversation" sends an approved WhatsApp template, for example: "Hi {{1}}, we have a quick question regarding
  your project. When you have a moment, please reply here and we'll continue the conversation." The exact template and
  its approval with Meta are set up separately.
* **Sending the template does not reopen free-form messaging.** The conversation stays restricted until the **customer**
  replies, and the screen must say so clearly at each step.
* Never try to get around Meta / WhatsApp rules. During Phase 6.1 planning, find out whether an approved template can
  legitimately carry a document (the quote PDF) outside the service window. Do not assume it can.

## Email

"Send quote → Email" sends directly from the business address **info@elitekitchens.ie**:
* **Recipient:** the customer's saved email address, used automatically.
* **Content:** the customer's name, the quote number and a short professional message (editable before sending), with the
  exact quote PDF attached.
* **After sending:** keep the exact PDF and record Email as the channel and the time. Mark the quote Sent under the existing
  rules, apply the CRM rules, and show the sending in the quote's and the customer's activity.

**No email provider is chosen yet.** During Phase 6.1 planning, inspect the current setup and recommend the simplest
reliable way to send as info@elitekitchens.ie. That account signs in to Firebase, so it is a Google account, possibly
Google Workspace. Credentials go to Secret Manager. The owner must never be asked to paste a credential or secret into
chat or source code.

## Several channels

Sending by WhatsApp only, Email only, or both at once (for example ☑ WhatsApp ☑ Email, one editable message, Send). The UI
is not final. The architecture must support several channels without tying the quote system to one provider:

```
Quote → a send service → WhatsApp / Email
```

No WhatsApp-specific logic in the quote builder or the quote record.

## History

The history should show, for example:

```
EK-0042  Sent 5 Oct 2026, 14:32 via WhatsApp, PDF version 2
         Sent 5 Oct 2026, 14:33 via Email, PDF version 2
```

A revised quote keeps every earlier sent PDF, so it is always known exactly what the customer received. Sent documents are
never overwritten.

## Failures, retries and duplicates

* **A failed channel is never recorded as sent:** if WhatsApp fails, nothing says it went by WhatsApp; if email fails,
  nothing says it went by email.
* **One channel can fail on its own:** if WhatsApp succeeds and email fails, record the WhatsApp success and the email
  failure, and allow retrying the email alone without sending WhatsApp again.
* **No duplicates:** a double-click on Send, or a retry after a timeout, must not send twice. Design the idempotency and
  retry behaviour before implementation; Phase 6's `requestId` on every quote action is the starting point.

## CRM rules

* **No new rules:** reuse Phase 6's quote and pipeline rules. Sending by WhatsApp or email ends in the same central "quote
  sent" behaviour as Phase 6's Send. Do not duplicate stage-change logic.
* **Closed customers** keep following the existing explicit rules ("Reopen" is an unticked box).
* **A declined quote** never closes the customer or project automatically.

## Security and privacy

Keep the existing Elite OS security model:
- quote PDFs stay private, and no Storage file is made public;
- no customer data in logs; no tokens or credentials exposed or committed;
- deleting a customer still erases their quote documents and related data, as the existing deletion does;
- sending and audit records keep only what is needed.

## Architecture: modular, and ready for controlled AI tools later

* **Keep the parts separate:** the quote domain, PDF generation, WhatsApp, email and the CRM stay loosely coupled.
* **Controlled actions, not raw access:** expose them as functions that a future AI could be allowed to call, without
  unrestricted database or messaging access:
  - `send_quote`
  - `send_quote_whatsapp`
  - `send_quote_email`
  - `reopen_whatsapp_conversation`
* **No AI in Phase 6.1.** Just avoid an architecture that would make such tools hard to add later.

## How Phase 6.1 will be run (as previous phases)

1. Start from the completed, tagged Phase 6 `main`.
2. Inspect the existing WhatsApp, quote/PDF and customer infrastructure.
3. Write the architecture before any implementation, for the owner's approval.
4. A separate Phase 6.1 branch.
5. Milestones.
6. Automated tests.
7. The full existing regression suite.
8. Preview before production.
9. A test with a real, controlled customer / contact.
10. No production deployment without the owner's explicit approval.
11. No merge or tag until live verification and the owner's explicit approval.
12. Rollback kept possible.

## Where things are today (starting points for the inspection, not decisions)

* **WhatsApp sending:**
  - `functions/index.js` has `sendReply` (text), `sendMedia` (a staff upload to `uploads/{uid}/`, sent as a WhatsApp
    message and moved to `media/`) and `startConversation` (the approved template `WHATSAPP_TEMPLATE_NAME`).
  - The 24-hour check is `WINDOW_MS` in `functions/lib/handlers.js` (server) and `windowOpen` in `public/app.js` (screen).
* **Quotes** (docs/QUOTES.md):
  - `functions/lib/quotes.js` `send()` is the central "quote sent" behaviour: it freezes the version, stores the exact PDF
    at `quotes/{phone}/{quoteId}/v{n}-{hash}.pdf` and applies `planSend` from `functions/lib/quotePipeline.js`.
  - The PDF is made in the browser today (`public/quote-document.js`, image-based html2pdf). Whether a channel sends that
    stored file or the server makes it is a Phase 6.1 architecture question.
  - Short-lived private links come from `quotePdfUrl`.
* **Deletion:** `deleteCustomer` already erases a customer's quotes and stored quote PDFs (`store.deleteCustomerData`).
