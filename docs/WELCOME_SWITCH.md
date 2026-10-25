# The welcome switch (24–25 October 2026)

**What it does:** you choose which WhatsApp welcome a new Meta lead gets, with one click in **Assistant → Settings**. The choices are:
- **Standard:** the current welcome (`elite_kitchens_new_lead`). It is always the backup.
- **New:** your new welcome (`welcoming_message_v_2_`).

**What stays the same:**
- One welcome per lead, sent the moment the lead arrives.
- Nothing changes until you choose **New**, and choosing **Standard** again is instant.

**The new welcome, word for word.** Meta approved it on 25 Oct 2026 as `welcoming_message_v_2_` (English, Marketing):
> Hi {{1}}, thanks for your enquiry with Elite Kitchens. We've received your details and would be happy to help with your new kitchen.
>
> Would you like us to arrange a free home consultation to go through your ideas?

**Safety:**
- **If WhatsApp refuses the new welcome** (paused, deleted, wrong language), the Standard one is sent instead, straight away. No lead is left without a welcome. "Needs attention" also tells you WhatsApp refused a template.
- **If WhatsApp gives no clear answer** (an outage or a timeout), nothing more is sent, exactly as today. The new message may have gone, and a second one would be a double. The chat says "status unknown".
- **The receptionist treats both welcomes as ours.** It reads the words of the one the customer actually got.
- **The new welcome already offers the free home consultation.** So the receptionist reads the customer's **first** reply as an answer to that offer:
  - "Yes please", "Sure", "Interested": the next message asks which days suit ("Would any day next week suit you for a home consultation?"). It never offers the visit a second time.
  - "No thanks", "Not right now", "Maybe later": your "no problem" line. Nothing more is pushed.
  - Anything else goes on exactly as before. For example, "Hi, I am looking for a shaker kitchen" gets one offer from the receptionist, and a price question gets your price line.
  - From the second reply on, nothing is different from today.
- **The AI is told what the welcome said.** Its notes now say "our welcome message asked whether they would like a free home consultation". Before, it was told "we have NOT offered a home visit yet", which would now be wrong.
- **"Is this Tomasz?"** gets the same honest line as "are you a bot", and the chat is handed to you. The new welcome doesn't use your name, but people may still ask.

## Release steps

1. ✅ Meta shows `welcoming_message_v_2_` as **Active** (25 Oct).
2. When the full check passes: the `welcome-switch` branch is merged into `main` and pushed to GitHub. You approved this on 25 Oct.
3. **Cloud Shell:**
   ```bash
   cd ~/elite-kitchens-lead-os && git checkout main && git pull --ff-only
   ./scripts/deploy-quote-sending.sh welcome
   ./scripts/deploy-quote-sending.sh live
   ```
   `welcome` redeploys 6 functions that already exist: `leadIntake`, `receptionistOnMessage`, `receptionistSweep`, `setAiSettings`, `aiStatus` and `aiSuggestReply`. It does not touch the WhatsApp webhook, and it sends nothing.
4. Reload Elite OS. Go to **Assistant → Settings → Welcome message for new Meta leads**, choose **New**, and press **Save**.
5. **Test with your own phone:** fill in the Meta form yourself (from the ad, or the form's preview link) with your own number.
   - The new welcome should arrive.
   - The chat in Elite OS should show the same words.
   - Reply "Yes please": the receptionist should ask which day next week suits. Outside quiet hours (midnight to 7:00) it answers within about a minute.

**Undo:**
- Choose **Standard** and press Save. It is instant.
- Full undo of the code: in the Cloud Shell folder, `git checkout 50bcd13 -- functions`, then redeploy the same 6 functions.

## Good to know

- **Category "Marketing":**
  - If your current welcome is **Utility**, each new welcome costs a little more.
  - Meta can hold back some marketing messages to people who get many of them. Elite OS would only see that when WhatsApp reports the message as not delivered.
- **"Start a new chat"** (a person starting a chat from the Inbox) still uses the Standard welcome, on purpose.
- The Knowledge Centre's **"Try it"** still shows the Standard welcome in its example chat.
- If you ever **edit** the template at Meta, tell Claude, so the copy in Elite OS stays word for word the same.

## What changed (for the record)

| File | Change |
|---|---|
| `functions/lib/welcome.js` (new) | The two welcomes: template names, Elite OS's word-for-word copy, which one offers the consultation, and the choice (Standard if anything is unclear) |
| `functions/lib/leads.js` | Sends the chosen welcome. If the New one is refused outright, the Standard one goes once. The chat copy matches what was sent, and the lead record notes which one went |
| `functions/lib/whatsapp.js` | `sendTemplate` can name the other welcome template (same language, same one first-name gap) |
| `functions/lib/aiReceptionist.js` | Either welcome counts as "our welcome", not as a person writing |
| `functions/lib/aiSchedule.js` | The first reply to the New welcome: yes → the days question, no → your line. "Is this Tomasz?" → the honest line and a person |
| `functions/lib/aiReply.js` | The AI is told the New welcome offered a free home consultation |
| `functions/lib/ai.js` | The owner-only `welcome` setting (Standard or New), and both texts shown in Settings |
| `public/index.html`, `assistant.js`, `app.css` | The choice in Assistant → Settings. Only the owner can change it, and it is greyed out while the server is still the older version |
| `scripts/deploy-quote-sending.sh` | New step `welcome` (6 existing functions; never the webhook) |
| `functions/test/welcome-switch.test.js` (new), `scripts.test.js`, `test-ui/assistant.e2e.js` | Tests (below) |

## Tests

These ran on 25 Oct 2026, on this PC, on the `welcome-switch` branch. They used a local test copy: no real message was sent and no paid AI was used.

| What | Result |
|---|---|
| New: `welcome-switch.test.js`. It covers sending (the Standard welcome unchanged word for word, a refusal, an unclear answer, a rate limit, both refused, a setting that can't be read), the switch (owner only, two choices), and the receptionist with the New welcome (yes → days whatever the model labels it, no → your line, anything else as before, nothing different from the second reply, the AI is told, "is this Tomasz?") | ✅ 16 of 16 |
| Planted mistakes: each safety rule was broken on purpose (12 in all) | ✅ all 12 caught |
| The existing tests for leads, push, do-not-contact, health, the AI and the receptionist, plus the install-as-app test (15 files, before the final wording) | ✅ 440 of 441. The one failure was receptionist-load check E, which is known to fail about 1 run in 3; it then passed 10 of 10, twice, run alone |
| Deploy script: the `welcome` step checks first, never deploys the webhook, and shows in the help | ✅ |
| Screen: Assistant (21 checks, including the switch) | ✅ 21 of 21 |
| Screen: Meta leads arriving | ✅ 11 of 11 |
| **Full regression on the final code** (`e0b5500`, 25 Oct, evening) | ✅ **Server: 999 of 999** (949 tests plus the 50 deploy-script tests) |
| | ✅ **Screen: 21 of 23 suites pass.**<br>• 16 passed first time.<br>• 5 (conversion, crm, dnd, assistant, quotes) failed only on "wait for the save" timers while the slow deploy-script test ran beside them. Run alone, each passed in full.<br>• 2 (appointments, lead-address) stop at the same calendar drag check (`calendar-drag-checks.js:13`). It looks for another day in the month of "a week from today". On 25 Oct that is 1 Nov, so there is none. **Unchanged `main` fails it in exactly the same way today**, so it is the test's date, not this change. It will pass again from tomorrow. |
| Not run | push, theme and reopen: these screen tests fail on this PC in the same way on `main` (known). |
