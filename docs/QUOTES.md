# Phase 6 — Quotes (agreed design)

Status: **M0, design only.** Nothing described here is built yet. This document is the specification that the milestones
below implement. A rule in it changes only with the owner's approval.

Quotes become a native part of Elite OS: a Quotes section in the side rail, a Quotes block on every customer profile, a
quote builder, a professional customer PDF, and explicit rules for how quotes move customers through the pipeline.
It replaces the *quoting* part of the separate Elite Kitchens quoting app. Invoices stay in that app for now.

## Decisions (owner, 2026-10-03)

| # | Decision |
|---|---|
| 1 | Phase 6 is quotes only. Invoices stay in the old quoting app until a later Elite OS invoicing phase. |
| 2 | Pipeline rules as in "Pipeline rules" below. Closed customers are never moved automatically. |
| 3 | Pipeline value: prefilled with the dearest option when a quote is sent, with the chosen option when it is accepted. Staff confirm it every time. |
| 4 | Statuses Draft, Sent, Accepted, Declined. "Expired" is shown automatically after the validity date, but **an expired quote is not dead: it can still be reopened, revised and resent** (kitchens often take longer than 30 days to decide). "Follow-Up" is no longer a status; it can return later as a reminder. |
| 5 | Quote numbers continue the old app's series (EK-0034 onwards). The owner confirms the highest number used. |
| 6 | Add "create customer without messaging", so phone, email and walk-in enquiries can be quoted. |
| 7 | Add an optional full Address field to the customer. |
| 8 | Phase 6 sending: Download PDF, an email draft, and Mark as sent. Sending the PDF on WhatsApp comes later. |
| 9 | Keep an exact copy of every PDF sent, private, erased with the customer. |
| 10 | Old quotes stay in the old app. No import in Phase 6. |
| 11 | Where the old app's own numbers disagree, what the customer sees on the PDF is correct. |

## What we start from

**Elite OS** (Phase 5, tag `phase-5-appointments-complete`). Customers are identified by phone number (`contacts/{phone}`,
`conversations/{phone}`). The browser only reads; every change goes through a staff-only Cloud Function. Phase 5
appointments are the model: their own collection, their own functions, their own screen and a block on the customer
profile; booking a New lead moves them to Booked through `planStatusChange` (the same code as a manual move).
`contacts/{phone}.quoteValue` is the number behind every pipeline total.

**The old quoting app** (repository `Elite-Kitchens-Quoting-app-`, GitHub Pages, its own Firebase project). One HTML
file holding customers, quotes, invoices and settings in a single database record written from the browser. Its own
`CLAUDE.md` is a detailed record of the business rules and is the reference for the port.

| | From the old app |
|---|---|
| **Kept** (ported faithfully) | The pricing method: Essential / Premium / Premium Plus, priced per door, per top box and per drawer box, plus shared items (worktop, glazed doors, extras catalogue) and Premium Plus's own extras. Prices frozen on each quote. Versions (v1, v2…). The PDF's design and its content rules (below). The email wording. Up to 5 render images on the PDF. |
| **Adapted** | One record per quote, saved only by the server. Quotes belong to existing Elite OS customers. Prices and business details move to a Quote Settings screen (stored as data, never in code: the repository is public). The builder keeps its fields but takes the Elite OS look. |
| **Replaced** | The price was worked out in four places (builder, list, PDF, invoice) that disagree on rounding and on €0 prices: Elite OS has one calculator. The cloud-sync machinery is not needed. Customers are never matched by name. Nothing is accepted automatically. |
| **Later** | Invoices, deposits, payments and the accountant export; sending quotes on WhatsApp; "quotes going cold" reminders; duplicate quote; templates, options and upgrades; importing old quotes; AI. |

The old app keeps running, unchanged, for invoices and old quotes. Elite OS does not connect to its Firebase project.

## Architecture: five separate parts

```
 Quote builder ──answers──▶ Price calculator ──price sheet──▶ Quote record
                                                                  │
                      Customer PDF ◀── reads a frozen version ────┤
                      Pipeline rules ◀── only on send / accept ───┘
```

Each part can be replaced without touching the others. They meet only at two fixed shapes: the builder's **answers**
(which only its own calculator understands) and the calculator's **price sheet** (which everything else reads).

1. **Quote record** (`functions/lib/quotes.js`). Statuses, versions, numbering, history. Owns the data; knows nothing
   about doors or drawers.
2. **Price calculator** (`functions/lib/quoteEngine.js`, with an identical browser copy `public/quote-engine.js`).
   Pure functions, no screen, no database, in the same style as `public/crm.js`. Given the answers and a price list it
   returns the price sheet. The browser uses it for live totals while typing; the server runs it again on every save
   and stores only its own result, so a number from the screen is never trusted. A test fails if the two copies differ.
3. **Quote builder** (`public/quote-builder.js`). Collects the answers. Nothing else depends on its layout.
4. **Customer PDF** (`public/quote-document.js`). A template that turns one frozen version into the customer document.
   It reads the version's customer details, business details and price sheet, never the builder's answers.
5. **Pipeline rules** (`functions/lib/quotePipeline.js`). The only place quotes affect the customer's stage or pipeline
   value. Runs inside the same transaction as the quote change and uses `planStatusChange` unchanged.

Screens: `public/quotes.js` (Quotes section, customer-profile block, dialogs). File names may be refined during
implementation; the separation may not.

**Replacing the builder later.** A future builder (kitchen templates, options, upgrades, deposits) is a new builder plus
a new calculator that produces the same kind of price sheet. Each quote records which calculator and version priced it
(`engine: { id: 'ek-packages', version: 1 }`), so old quotes keep their prices and still open.

### The price sheet

What the calculator returns, and the only pricing information the rest of Elite OS reads:

* the calculator's name and version, currency (EUR) and the VAT rate used;
* one entry per offered option: key, name (Essential, Premium, Premium Plus), price excluding VAT, VAT, and price
  including VAT in whole euros, exactly as printed on today's PDF (rounded to the nearest euro; a €0 price stays €0,
  decision 11);
* the dearest option;
* the customer-facing wording for the document: the specification lines of each option, "In your kitchen", "Work
  included" and "Not included". The calculator writes these because only it understands its answers.

It never contains door, top box or drawer counts, or any per-unit price, so they cannot leak onto a document.

## Data

| Where | What |
|---|---|
| `quotes/{id}` | `phone` (the customer), `number`, `status` (`draft` / `sent` / `accepted` / `declined`), `customerName`, `currentVersion`, `sentVersion`, a summary of the options and prices for lists, `validUntil` of the sent version, `acceptedOption`, `sentAt/By`, `acceptedAt/By`, `declinedAt/By`, `declineReason`, `stageChanges` (what this quote did to the pipeline), `history` (who did what, when), `version` (for "changed by someone else" checks), `requestId`, `createdAt/By`, `updatedAt/By` |
| `quotes/{id}/versions/{n}` | One per version: the answers, the frozen price list, the calculator id and version, the price sheet, the customer's name, phone, email and address, the business details, and once sent the issue date, `validUntil`, who sent it and the stored PDF (path, size, checksum). **A sent version never changes again.** |
| `quoteSettings/current` | Price list, extras catalogue, business details printed on quotes, validity period (30 days), VAT rate, quote-number setup |
| `counters/quoteNumber` | The next quote number. Can only go up. |
| Storage `quotes/{phone}/{id}/v{n}.pdf` | The exact PDF of each sent version. Closed to browsers; staff open it through a 10-minute signed link, like media. |

* The quote id comes from the phone number and the request id, so a double click or a retry creates one quote.
* Stored quote PDFs are kept until the customer is deleted. The automatic 24-month clean-up of customer media
  (`storage-lifecycle.json`, `media/` only) does not apply to them: a sent quote is a business record.
* Lists use single-field queries only (`phone`, `updatedAt`), so no new indexes are needed. No rule changes: staff
  already read everything and browsers already cannot write.
* Stored errors and logs hold codes and ids only, never customer details.

## Statuses and what you can do

| Status | Shown as | You can |
|---|---|---|
| Draft, never sent | Draft | Edit, preview, **send**, delete |
| Sent | Sent, or **Expired** after its validity date | Download the PDF that was sent, **accept** (choose the option), **decline**, **revise** (start a new version as a draft), **renew** (send the same content again with a new date and validity) |
| Sent, with a revision in progress | Sent · draft v*n* | Edit the draft, send it (it becomes the current version), discard it (back to the last sent version) |
| Accepted | Accepted · *option* | View and download, **reopen** (back to Sent) |
| Declined | Declined | View and download, **reopen** (back to Sent), **revise** |

### Expiry (decision 4)

* Every sent version has a validity date: the issue date plus 30 days (Europe/Dublin calendar days; the period is a
  setting). It is printed on the PDF.
* A Sent quote past that date is **shown** as "Expired, valid until 4 November". That is a label only: nothing is
  stored, the status stays Sent, and the customer's stage and pipeline value do not change.
* Every action stays available on an expired quote: send the same PDF again (download or email draft), renew it with
  fresh dates, revise it, decline it, or accept it (the accept dialog notes when the validity ended).
* **Renew** creates the next version with the same content and prices, a new issue date and a new validity date. The
  prices stay frozen unless you choose "Update to current prices" (which makes it a revision). **Revise** creates the
  next version as an editable draft.
* A declined quote can be reopened or revised in the same way if the customer comes back.

### Versions

* Editing a draft changes that draft. Once a version is sent it is frozen: changing anything afterwards (prices,
  options, customer details on the document) creates the next version (EK-0034-v2). Earlier versions stay viewable,
  with the PDF that was sent.
* Accepting applies to the version the customer was sent. If a revision is still a draft, send or discard it first.
* Only a quote that has never been sent can be deleted. A sent quote is the record of what the customer received; it is
  erased only when the customer is deleted.

## Pipeline rules (decision 2)

| You do | Customer stage | Pipeline value (decision 3) |
|---|---|---|
| Create, edit, preview, delete a draft | No change | No change |
| **Send** any version (first, revised or renewed) | New lead or Booked → **Quoted**. Quoted and Won: unchanged. Closed: unchanged, unless you tick "Reopen: move to Quoted" (unticked by default) | Dialog shows the current value and proposes the dearest option's price including VAT. You can change it or leave the value as it is. |
| **Accept** (choose the option) | New lead, Booked or Quoted → **Won**. Won: unchanged. Closed: unchanged, unless you tick "Move to Won" (unticked by default) | Proposes the chosen option's price including VAT |
| **Decline** | **Never changes.** The dialog reminds you that you can move the customer to Closed yourself if the whole project is lost | No change |
| **Reopen** an accepted quote | Offers "Move back from Won to Quoted", ticked only when this quote moved the customer to Won and they are still in Won. Within 5 minutes of the accept this is a correction and leaves no trace, exactly like a manual move. | Offers to restore the value from before the accept |
| Reopen a declined quote | No change | No change |
| Expiry | No change | No change |

* Every dialog says in plain words what will happen before you confirm, e.g. "Anna Murphy will move from Booked to
  Quoted. Pipeline value €14,500 → €18,200."
* Stage moves use `planStatusChange` inside the quote's own transaction: stage dates, the `lastMove` note and the
  5-minute correction window behave exactly as for a manual move or a Phase 5 booking. Each move made by a quote is
  recorded on the quote (`stageChanges`).
* A customer can have several quotes (e.g. kitchen and wardrobes). The rules above apply per customer, whichever quote
  is sent or accepted. Because the pipeline value is always confirmed, you decide what it should be.
* `quoteValue` stays the single number behind the pipeline totals: the Phase 4 maths do not change. It is still editable
  by hand in Details, and it is only ever written by a quote when staff confirm it.

## Customers

* A quote always belongs to an existing Elite OS customer, found by phone number. The builder fills in their name,
  email, phone and address; nothing is typed twice and customers are never matched by name.
* **Add customer without messaging** (decision 6). A dialog with phone and name (required) and email, address and
  source (optional). It creates the customer as a New lead and sends nothing. If the number is already a customer, it
  opens them instead. If they message on WhatsApp later, it lands in the same conversation. WhatsApp's own rules are
  unchanged: to message them first, Elite OS still needs the approved template.
* **Address** (decision 7): an optional field (up to 300 characters) under Contact in Details. It fills the quote and is
  frozen into each sent version, so changing it later never alters a quote the customer already has.
* Every customer still needs a phone number: it is how Elite OS identifies customers.

## Quote numbers (decision 5)

* EK-0034 onwards, continuing the old app's series so no two quotes ever share a number. Versions show on the document
  as EK-0034-v2.
* The starting number is set once in Quote Settings at cut-over, from the highest number the old app has used. From then
  on the number can only go up, and each new quote takes the next one in a transaction.
* Until it is set (during preview testing) quotes get test numbers (TEST-0001) and the screen says numbering is not set
  up yet. Test quotes belong to test customers and are erased with them.
* After cut-over, no new quotes are made in the old app.

## The customer PDF

* The current design, ported: editorial layout, option cards, "Your kitchen", "In your kitchen" / "Work included", "Not
  included", the terms panel, the validity date, the sign-off, and up to 5 render images on their own pages.
* Content rules carried over unchanged:
  * never print door, top box or drawer counts, or any per-unit price;
  * never add workmanship-warranty wording (the 6-month snagging line in the terms is a separate thing and stays);
  * the laminate-worktop water-damage note appears under Worktops only when a worktop is quoted;
  * paid items and free work are listed in separate groups.
* The PDF is made in the browser, the same way as today. The PDF library and the fonts are served from Elite OS itself,
  not from other websites.
* **Sending** (decisions 8 and 9). "Send" freezes the version (issue date and validity), lets you add render images,
  makes the PDF, stores that exact file privately, marks the quote Sent and applies the pipeline rules. Then it offers
  **Download PDF** and **Email draft** (opens Gmail with the usual wording; you attach the file). The file you send is
  therefore byte-for-byte the stored copy. Before sending, previews are marked "Draft, not sent".
* Sending the PDF on WhatsApp is a later step: WhatsApp only allows it within 24 hours of the customer's last message,
  or with a separately approved template.

## Quote Settings

A settings screen for: the price list (per-door and per-top-box defaults for each option, drawer boxes, glazed doors,
worktop, the extras catalogue), the business details printed on quotes, the validity period (30 days), the VAT rate
(13.5%, to be confirmed with the accountant) and the one-time starting number.

* Changing a price affects new quotes, and drafts only when you press "Update to current prices". It never changes a
  sent version.
* The starting values are entered from the old app's Settings by the owner. They are stored in the database, not in the
  repository.
* No bank details: they belong to invoices, which stay in the old app.

## Invoices (decision 1)

Invoices stay in the old app until a later phase. To invoice an accepted Elite OS quote, re-enter the job in the old app
and issue the invoice there. The Elite OS quote shows the builder's figures in the same terms as the old app to make that
quick. The quote the old app creates for this gets its own internal number; only its invoice goes to the customer, never
that quote's PDF.

## Security and data

* No change to Firestore or Storage rules. Browsers still cannot write anything.
* Every quote action is a staff-only function (`assertStaff`) with strict input checks. New quotes and sends carry a
  request id (no duplicates), and edits carry the version they started from ("changed by someone else" is refused).
* Planned functions:
  * New: `createQuote`, `saveQuoteDraft`, `sendQuote`, `acceptQuote`, `declineQuote`, `reopenQuote`,
    `discardQuoteDraft`, `deleteQuoteDraft`, `quotePdfUrl`, `saveQuoteSettings` and `createCustomer`.
  * Changed:
    * `updateContact`: accepts `address`; every other field behaves exactly as before.
    * `deleteCustomer`: also erases the customer's quotes, their versions and stored PDFs; the audit entry adds the
      number of quotes; its answer to the screen is unchanged.
* The PDF upload uses the existing private upload folder (`uploads/{uid}/`, create-only). The function checks the file
  is a PDF of sensible size before moving it to `quotes/`.
* `functions/.env` and secrets are unchanged: quotes need no new secret.

## Ready for AI later (nothing built now)

Each action is a named, strictly checked server function that records who did it (`createdBy`, `updatedBy` and history
entries hold an actor, today always staff). The calculator is pure. A future assistant would use exactly these functions
as its tools (`get_quotes`, `get_quote`, `create_quote`, `update_quote`, `calculate_quote`, `generate_quote_document`),
with the same checks and the same confirmations.

## Milestones

Each milestone ends with a commit and a report. The next one starts only when the owner says so. One person (one agent)
works on the branch at a time.

| | Scope | Effect on the live system |
|---|---|---|
| **M0** | Decisions, this document, branch `phase-6-quotes` from `main`, baseline run of every existing test suite | None |
| **M1** | Price calculator and its tests, including parity with the old app's PDF figures on many sample quotes (full, missing newer fields, bare) | None: not deployed |
| **M2** | Server side: quote records, versions, numbering, statuses and expiry, pipeline rules, Quote Settings, create customer without messaging, Address field, delete-customer erasing quotes. Every rule in this document gets a test; every existing suite must pass unchanged | None until deployed; the backend deploy is invisible to the live screen |
| **M3** | Screens: Quotes in the side rail (list, filters, search, expired label), Quotes block on the customer profile, Add customer, builder, Send / Accept / Decline / Reopen / Revise / Renew dialogs, Quote Settings. Desktop and phone browser tests | Preview only |
| **M4** | Customer PDF: port, stored copy on send, earlier versions, email draft. Rendered-text checks that no counts or unit prices appear; screenshots for approval | Preview only |
| **M5** | `scripts/deploy-quotes.sh` and `scripts/rollback-quotes.sh`, docs. Backend → preview (channel `phase6`, a test customer) → owner review → live (approval) → cut-over: set the starting number, stop making new quotes in the old app → merge and tag `phase-6-quotes-complete` (approval) | Controlled |

## Testing

* Baseline before any change: every existing suite (results below).
* Calculator: the old app's PDF arithmetic is used as the reference in the tests; any difference fails. Includes €0
  prices, decimal quantities, rounding at .5, every option combination, Premium Plus extras, and the three quote shapes
  the old app's notes require.
* Server: each row of the pipeline table, the correction window, Closed untouched, several quotes per customer,
  expired quotes (every action still allowed), versions frozen after sending, idempotency, "changed by someone else",
  numbering (only up, test numbers before setup), erasure, staff-only access, no customer data in logs.
* Browser: every screen and dialog on desktop and phone, the expired label, the PDF's visible text, and no JavaScript
  errors. All Phase 1–5 suites must pass unchanged; any test-harness fix goes in its own commit and never weakens an
  assertion.

### Baseline (M0)

Run on 2026-10-03 on branch `phase-6-quotes` at `beb7c72` (identical to `main` and tag `phase-5-appointments-complete`),
before any change. All emulator-only: nothing touched the live project.

| Suite | Result |
|---|---|
| Backend (`npm test`) | 136 of 136 passed |
| `ui.e2e.js` | 57 of 57 |
| `lead.e2e.js` | 11 of 11 (see note) |
| `crm.e2e.js` | 14 of 14 |
| `dnd.e2e.js` | 13 of 13 |
| `conversion.e2e.js` | 10 of 10 |
| `theme.e2e.js` | 10 of 10 (in Google Chrome, see note) |
| `appointments.e2e.js` | 17 of 17 |

Notes for running the browser suites on the owner's Windows PC (no test file was changed):

* Set `NODE_PATH` to the global npm folder (`npm root -g`) and `CHROMIUM` to a browser, since the default path in the
  tests is a Linux one. Playwright's full Chromium does not start on this PC (Windows reports a side-by-side
  configuration error), so the suites ran with Playwright's headless shell
  (`%LOCALAPPDATA%\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe`).
* `theme.e2e.js` needs a full browser: its control check switches on Chromium's force-dark mode, which the headless
  shell does not have. It passed with `CHROMIUM` set to the installed Google Chrome (a temporary profile, the owner's
  own profile is not used).
* `lead.e2e.js` check 9 failed once and passed on the next run: the `sendReply` function started more than 5 seconds
  after the click on a cold emulator (the test waits 5 seconds), then ran in 11 ms. A timing sensitivity of the
  harness on this PC, not an Elite OS fault. Left unchanged.

## Deploy and rollback (prepared in M5)

* A Phase 6 deploy script modelled on Phase 5's: it saves the revisions it replaces, grants public invocation only to the
  new callables (they check staff themselves) and deploys in stages. **Do not use `scripts/deploy-preview.sh`**: it
  deploys every function and makes them all public, including the private `calendarSweep`.
* Rollback: functions in seconds with the saved revisions (`deleteCustomer` and `updateContact` return to their Phase 5
  versions); the screen through Hosting's release history or by redeploying tag `phase-5-appointments-complete`. Quote
  data stays in Firestore and is simply not shown.

## Open items

* The highest EK number used by the old app, confirmed at cut-over.
* The VAT rate (13.5%), to be confirmed with the accountant.
* The old app's own database security rules were never confirmed (its notes ask the owner to check them).
* Both GitHub repositories are public. Prices and business details are kept out of this repository for that reason.
  Making it private is the owner's choice; Cloud Shell would then need a GitHub sign-in to pull.

## Not in this phase

Invoices, deposits and payments; sending quotes on WhatsApp; reminders for quotes going cold; duplicate quote; kitchen
templates, options and upgrades; importing the old app's quotes; online acceptance or e-signature by the customer; AI.
