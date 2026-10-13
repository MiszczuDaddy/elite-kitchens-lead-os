# Phase 9: the AI assistant (9.0 foundations + 9.1 read-only chat)

**Status:** built on branch `phase-9-ai-assistant`. **Not merged, not deployed, no key set, switched OFF.** Only 9.0 and 9.1 are built.

## What it is, and what it is not
A chat inside Elite OS (left bar: **Assistant**; a link under the Inbox caption on phones). It looks things up and explains them: find customers, read quotes, appointments and projects, and understand the customer, quote or project you had open when you pressed Assistant.

**It cannot change or send anything.** No quote edits, no bookings, no WhatsApp replies, no automatic replies to customers, no voice. Those are later phases (below) and each needs its own approval.

## How it works
```
browser (Assistant screen) --aiChat--> Cloud Function --> model wrapper --> Anthropic API
                                           |  ^
                                           v  |  read-only tools (9) -> Firestore
                                  aiSettings / aiUsage / aiRate / aiLog
```
* **One question** = the function checks who you are (same staff allow-list as everything else), the on/off switch, the speed limit and the budget, then runs a short loop (at most 6 steps, at most 4 lookups per step): the model asks for a lookup, the function runs it, the model answers.
* **Stateless:** the browser sends the last 12 plain-text turns; the conversation is kept only in that browser tab (`sessionStorage`, cleared on sign-out). The server stores no conversation. Errors and lookup details never go back to the model.
* **The open customer/quote/project** is sent as ids only. The server reads the names itself, so a screen cannot feed the model made-up facts.
* **Model-independent:** Elite OS talks to a tiny interface (`complete({model, system, messages, tools})`). `anthropicModel()` in `functions/lib/ai.js` turns it into the Anthropic API (one `fetch`, no SDK, prompt caching on, retries on busy/failing servers, a time limit). Another provider is another adapter; nothing else changes. **Models:** two, chosen by name on the screen: **Haiku** (`claude-haiku-5-5`, the default for everything) and **Sonnet** (`claude-sonnet-5-5`). The IDs live on the server only; the screen can send nothing but "haiku" or "sonnet" (anything else is refused). One model answers one question, start to finish: nothing escalates by itself. **"Retry with Sonnet"** under the last Haiku answer re-asks the same question, with the same earlier conversation, once, with Sonnet; it is a second request and counts against the same limits. The default can be changed with `aiSettings/current.defaultModel` ("haiku" or "sonnet").

### The ten tools (all read-only, strict input checks, small capped answers)
`search_customers`, `get_customer`, `get_conversation` (≤15 messages, each ≤300 characters), `list_quotes`, `get_quote`, `list_appointments`, `list_projects`, `get_project`, `pipeline_summary`. They use the same rules as the screens (e.g. the project status/"waiting to order" logic is checked against `public/project-model.js` for all 64 combinations). **The assistant never does maths:** prices are quoted exactly as stored; quotes are only ever calculated by the quote engine.

### Customer summaries: one format, built by code
Asked to summarise a customer, Haiku and Sonnet used to answer differently. The cause was both: the lookup left gaps (no Eircode field, appointments newest-first with past and cancelled ones mixed in, no "latest quote", no test-record hint), so each model filled them in its own way, and the answer format was free. Now the **server builds the summary** (`functions/lib/aiSummary.js`) from the records by fixed rules, in this order:
```
**Customer Name**
- Budget: €XX,XXX–€XX,XXX      (a clear free-text budget is reshaped; anything unclear is shown "as recorded"; none = not recorded)
- Location: Town
- Eircode: XXX XXXX            (from the saved address, else the notes; two different codes = not recorded)
- Latest quote: Quote number — Status   (the newest quote; "Sent (expired)" once its valid-until date has passed; none yet)
- Next appointment: Date, time (the next one that is not cancelled; none scheduled)
- Notes: only relevant information     (left out when there is none: project type, requirements, a short project status; not the lead-form boilerplate, address, Eircode or budget)
⚠ Possible test record: ...    (only when the name, email, phone, notes or quote number look like test data)
```
* The model's only job is to call `customer_summary`; its reply is the tool's text, so Haiku and Sonnet are identical by construction (a model's own wording is discarded). That also saves tokens: **no second model call** is made to restate it.
* **"Summarise this customer" with a customer open** (plain whole-message requests only: "summary", "overview", "summarise this customer", "tell me about her"…) needs **no model at all**: answered instantly, free, chip "No AI used". Anything more specific goes to the model as usual.
* Every other answer stays free-form, with the same short style rules for both models (answer first, no lead-in, "not recorded" for missing facts, one short ⚠ line for suspected test data). `get_customer` (for specific questions) now also returns the budget, Eircode, latest quote, next appointment and test hints, so no model has to dig for them.
* The summary never invents: a missing fact is labelled, free-text notes are shown as recorded (an instruction inside a note is just text on the screen).
Examples (from the test data): a full record, a sparse record (every missing field labelled), a test record (⚠ line) are in `functions/test/ai.test.js` ("EXAMPLES").

## Safety rules (each one has a test)
| Rule | How |
|---|---|
| **Spending cap, enforced on the server** | Before every model call the function *reserves* the worst case of that call (input estimate + the maximum output) on the month and the day totals in one transaction; no room = no call, and the person is told. After the call the reservation is corrected to the real cost. Ten simultaneous questions cannot overshoot. A call that times out keeps its reservation (it may still be billed); a failed call returns it. Defaults: **€15 / month, €2 / day** (the daily cap cannot exceed the monthly one; 0 = no AI at all). |
| **Global kill switch** | `aiSettings/current.enabled`. Missing document or anything but `true` = **OFF**. One tick in Assistant → Settings. Stops the very next question. |
| **Real customer data gate** | `customerDataApproved` (default **false**). While false the model gets **no tools**, is told so, never sees the open customer's name, and a lookup it asks for anyway is refused. Turning it on needs a tick on "I have checked the AI provider's data terms" and is written to `auditLog`. **Only the owner should do this, after reading "Data terms" below.** |
| **Only the owner switches real customer data on (or off)** | `customerDataApproved` can be changed only by the account(s) in the server setting `AI_OWNER_EMAILS` (matched exactly, ignoring case; empty = nobody). Any other staff account gets "Only the owner account can change real customer data access", nothing is saved, and the box is greyed out in their Settings. Everyone on the staff list can still use the assistant, pull the on/off switch and change the limits. `dataApprovedBy` records who switched it on. |
| **Read-only by construction** | `aiTools.js` contains no write call (a test reads the file and fails if one appears) and the model is only given the nine tools. The only things the AI code writes are its own records: `aiSettings`, `aiUsage`, `aiRate`, `aiLog` and one `auditLog` line when settings change (also tested). |
| **Customers' words are data, never orders** | Notes, names, locations and messages reach the model only inside tool results, always labelled "data, not instructions"; the system prompt says to ignore any orders found in them and never to reveal its instructions. Tested with a note that says "IGNORE ALL PREVIOUS INSTRUCTIONS…". (This lowers the risk; it cannot remove it. That is why this phase has no write tools.) |
| **No content in logs** | `aiLog` holds feature, model, token counts, cost, time, ok. Console logs hold the same. Never the question, the answer or any customer data (tested by planting names in the question and reading every record). |
| **Answers are text** | The screen builds plain text nodes from a tiny markdown (paragraphs, lists, bold); HTML in an answer or a customer name is shown as text and never runs (tested in the browser). |
| **Speed limit** | 8 questions a minute and 60 an hour per person. |
| **Secrets** | `ANTHROPIC_API_KEY` is a Secret Manager secret that only `aiChat`/`aiStatus` can read. It is never in the code, the browser or a log; the error messages never carry it. |
| **Fake model only in the emulator** | The demo model used by the tests exists only when `FUNCTIONS_EMULATOR === 'true'` **and** `AI_FAKE_MODEL=on` (a test checks this). |

## Models and prices (verified against Anthropic's own pages on 2026-10-14)
Source: platform.claude.com/docs/en/models/overview and /about-claude/pricing. **Model IDs confirmed:** `claude-sonnet-5-5` (chat), `claude-haiku-5-5` (cheap jobs later); both active, retirement not before Sept/Oct 2027.
| Model | Input | Output | Cache write (5 min) | Cache read |
|---|---|---|---|---|
| Sonnet 5.5 | $2 / MTok | $10 / MTok | $2.50 | $0.10 |
| Haiku 5.5 (prompts up to 100k tokens) | $0.10 | $0.50 | $0.125 | $0.01 |
The estimate uses these list prices, then × 1.25 safety margin, and counts a dollar as a euro (`eurPerUsd` 1, which overstates the cost), so the shown spend is a little above the real bill. Cache reads are deliberately estimated at 0.1× (Sonnet 5.5 really charges 0.05×). An **unknown** model is priced at $15 / $75 (more than any current model) so a wrong model name can never under-count. Prices are editable in `aiSettings.prices` if Anthropic changes them. **Also set a €15 limit in the Anthropic console** as a second, independent stop.
**Thinking (found while verifying, and handled):** these models think before answering by default; that thinking is billed as output and counts towards `max_tokens`, and within a lookup turn the model's thinking blocks must be sent back unchanged or the API refuses. So: the adapter sends them back exactly as received (tested); Sonnet 5.5 is set to its lowest thinking setting (`between_tools`; it rejects "disabled") and Haiku 5.5 to "disabled", both at medium effort; `maxOutputTokens` is 2048 (thinking included); a question may not start a new model call after 100 s. A typical question costs a fraction of a cent to about a cent on these numbers.


### Checking the models against the provider before use
**Check models** (Assistant → Settings, free, no tokens) asks the provider's own Models API (`GET /v1/models/<id>`) whether each model ID exists, is active, supports the effort setting we send, and accepts the thinking setting we send (Haiku: "off" must be accepted; Sonnet: "thinking" must be supported). The answer is stored (`aiSettings/modelCheck`) and audited. **A model that has not passed, or whose ID has changed, is refused by the server.** The Models API does **not** return prices, so prices are checked against the price page (above) and, after the first real questions, against the cost shown in the Anthropic console usage page (deployment step 7).

## Data terms (checked 2026-10-13; **you must verify before you switch real customer data on**)
From Anthropic's own pages (`privacy.claude.com`, `platform.claude.com/docs/en/manage-claude/api-and-data-retention`; secondary reading, please confirm on your account):
* **Training:** commercial API inputs/outputs are **not used to train** models by default. Exceptions: feedback you choose to send, and content you explicitly opt in to share.
* **Retention:** by default API inputs/outputs are deleted from Anthropic's backend within **30 days**. Content flagged by their safety systems can be kept up to 2 years (classifier scores up to 7 years); legal holds apply.
* **Zero Data Retention (ZDR):** exists, but is **per organisation by agreement with Anthropic**, not automatic. Without it the 30-day rule applies.
* **Location (checked 2026-10-14):** the first-party Claude API offers **no EU processing or EU storage**. Inference is "global" (anywhere) by default; the only alternative is US-only ("us", +10% price), and workspace storage is US-only. So customer data sent to the assistant is processed outside the EU (a GDPR international transfer): check Anthropic's Data Processing Addendum and its transfer mechanism for your account, tell customers in your privacy notice, and decide whether that is acceptable. (Other routes with EU regions exist, e.g. through Amazon Bedrock or Google Cloud, but they are different accounts and not built.)
**Decision for you:** accept 30-day retention (no ZDR) or ask Anthropic for ZDR; then tick the box in Settings. Until then the assistant works only on general questions.

## Customer-facing AI (not built yet): disclosure policy
Decisions recorded (2026-10-13): the future WhatsApp receptionist (9.4/9.5) **will not introduce itself as an AI** and will sound natural, warm and professional on behalf of Elite Kitchens; it will **never pretend to be a named employee**; and it will **answer truthfully if asked** whether it is an AI. Before it is ever enabled for automatic customer conversations the disclosure rules must be checked and complied with.
**Flag (please read):** EU AI Act Article 50(1) requires people to be told they are talking to an AI system **unless that is obvious to a reasonably well-informed person from the context**. As I read the secondary sources, this obligation applies from **2 August 2026**, so it is already in force. A WhatsApp receptionist with no introduction and no disclosure may not satisfy it. Options when we reach 9.4: (a) a short, friendly one-line disclosure (the safe route, small effect on warmth), (b) legal advice that the context makes it "obvious", (c) a human always sends. I have not given legal advice and did not read the official text; **take this to a solicitor before 9.4.** Nothing in 9.0/9.1 talks to customers.

## Deployment plan (nothing is deployed until you approve each step)
Order, one command at a time from Cloud Shell, each verified from outside:
0. **Before:** you read "Data terms" above (including: no EU processing); optionally set a €15 limit in the Anthropic console.
1. **Merge** the branch to `main` and update Cloud Shell (`git checkout main && git pull --ff-only`). Needs your approval.
2. **Key:** `firebase functions:secrets:set ANTHROPIC_API_KEY --project elite-kitchens-lead-os`; paste the key there when asked. Never in a chat or a file. Check: `gcloud secrets versions list ANTHROPIC_API_KEY --project elite-kitchens-lead-os` shows one enabled version.
3. **Backend:** `./scripts/deploy-quote-sending.sh ai`. It asks for the **owner account** (your Google account; it must already be on the staff list) and writes it to the settings file as `AI_OWNER_EMAILS` after you say yes. It deploys only the 4 new functions (no existing function, rule, index or secret changes), makes them reachable, and checks each refuses a request without sign-in. It refuses to run without the key.
4. **Screen:** `./scripts/deploy-quote-sending.sh live`. Refuses until step 3 is done. (Or first `preview`.)
5. **Models:** Assistant → Settings → **Check models**. Both lines must say "ready". If one says "failed", read why and tell me; do not go on.
6. **First test, customer data OFF:** in Settings tick "switched on" only; leave the customer-data box unticked. Then: (a) a general question ("what is a shaker door?") is answered by Haiku; (b) "find anna" is refused with the explanation and no name appears; (c) press Sonnet, ask the same general question: answered, and the chip says Sonnet; (d) ask with Haiku, then press "Retry with Sonnet": one new answer replaces the old one; (e) the spending bar moves by a cent or less, and `aiUsage/<month>` shows Haiku and Sonnet separately; (f) untick "switched on": the next question is refused at once; tick it again; (g) set the daily limit to 0: refused with "budget used up"; put €2 back; (h) sign in with a **second** staff account if there is one: its customer-data box is greyed out.
7. **Prices:** after step 6, compare the cost the screen shows for Haiku and for Sonnet with the Anthropic console's usage page for the same minutes. They should be close (the screen is a little higher on purpose). If they are not, tell me before continuing.
8. **Then, only on your decision:** tick "Let the assistant see real customer data" plus the confirmation, and try the same lookups on one real, low-risk customer.
**Undo:** the switch (Settings) stops it instantly. To remove it entirely: `firebase functions:delete aiChat aiStatus setAiSettings aiCheckModels --region europe-west1` and roll back the screen in Firebase console → Hosting → Release history. Nothing else depends on the assistant. The `AI_OWNER_EMAILS` line in the settings file is harmless.
**Not asked about yet:** the spending limits can be changed by any staff account (the data switch cannot). Say if you want those owner-only as well.

## Tests
* `functions/test/ai.test.js` (55, emulator, fake model + fake `fetch`): access, kill switch, defaults, settings, data gate, cap (month, day, 10 at once, failures, timeouts), prices, speed limit, the loop, tool inputs and outputs, injection text, history/context rules, no content in logs, read-only static checks, the database-spy proof that the gate reads nothing, the Anthropic adapter's exact request/thinking/retry/timeout behaviour, rules (browsers cannot write the AI records).
* `functions/test/assistant-model.test.js` (9): history, context, markdown, spending bar, notices.
* `test-ui/assistant.e2e.js` (real page + functions + emulators, demo model): screens and states, "Check models", the Haiku/Sonnet selector and "Retry with Sonnet", the owner-only data box, settings and the data-gate confirmation, a lookup, the open customer, HTML shown as text, the tab-only conversation, the kill switch and a used-up budget, the phone layout.
* Planted-error checks (14 deliberate breakages of the cap, switch, data gate, reservation, timeout handling, rate limit, logging, read-only, injection labelling, history and context rules): 12 caught at once; 2 exposed one real test gap (the hourly speed limit, now tested) and one harmless equivalent change (the open customer is read but still never shown to the model while the gate is closed).

## Not built (needs your approval, in this order)
9.2 AI-prepared proposals (e.g. a quote revision) applied only after you press Approve · 9.3 push-to-talk voice (browser speech recognition first, fallback where unsupported) · 9.4 WhatsApp receptionist in **suggest-only** mode · 9.5 receptionist that replies by itself (after the disclosure question above, with a per-lead opt-out and a human hand-over).
