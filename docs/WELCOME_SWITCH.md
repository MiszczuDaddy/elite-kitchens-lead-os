# The welcome switch (24–25 October 2026)

**What it does:** you choose which WhatsApp welcome a new Meta lead gets, with one click in **Assistant → Settings**. The choices are:
- **Standard:** the current welcome (`elite_kitchens_new_lead`). It is always the backup.
- **New:** your new welcome (`welcoming_message_v_2_`).

**What stays the same:**
- One welcome per lead, sent the moment the lead arrives.
- Nothing changes until you choose **New**, and choosing **Standard** again is instant.

**Safety:**
- **If WhatsApp refuses the new welcome**, the Standard one is sent instead, straight away. Reasons it might be refused: not approved yet, paused, deleted, or the wrong language. No lead is left without a welcome. "Needs attention" also tells you WhatsApp refused a template.
- **If WhatsApp gives no clear answer** (an outage or a timeout), nothing more is sent, exactly as today. The new message may have gone, and a second one would be a double. The chat says "status unknown", as it does today.
- **The receptionist treats both welcomes as ours.** It reads the words of the one the customer actually got, so it knows what we asked.
- **"Is this Tomasz?"** (or "are you Tomasz", "am I talking to Tomasz") gets the same honest line as "are you a bot". The chat is then handed to you with the reason "asked if this is Tomasz". A friendly "Thanks Tomasz" is just a normal message.
- **A first answer of "No" / "not yet"** to the new welcome's question is treated as an answer, not as "not interested". So the customer never gets the "if you change your mind" line. Clear words still count as a no: "not interested", "found someone else", "by mistake", "stop".

## ⚠️ Before release: the exact words

Elite OS keeps its own copy of the welcome words in each chat. Staff see that copy, and the receptionist reads it. It must match the approved template **word for word**.
- In `functions/lib/welcome.js`, the copy for **New** is still a placeholder ("Hi {{1}}, it's Tomasz from Elite Kitchens…").
- The template you created shows "Hi {{1}}, thanks for your enquiry…" in WhatsApp Manager.
- **Paste the full approved text to Claude** before this is merged; one line in `welcome.js` is then changed.

Also check two things:
- The name is exactly `welcoming_message_v_2_` (with the underscore at the end).
- It has exactly **one** {{1}} (the first name) and **no** header, buttons or footer. Elite OS sends only the first name.

## Release steps (each needs your OK; nothing has been run)

1. Meta shows `welcoming_message_v_2_` as **Active** in WhatsApp Manager.
2. Claude puts in the exact words. Then you approve the merge of the `welcome-switch` branch into `main`, and the push to GitHub.
3. **Cloud Shell:**
   ```bash
   cd ~/elite-kitchens-lead-os && git checkout main && git pull --ff-only
   ./scripts/deploy-quote-sending.sh welcome
   ./scripts/deploy-quote-sending.sh live
   ```
   The `welcome` step redeploys 6 functions that already exist: `leadIntake`, `receptionistOnMessage`, `receptionistSweep`, `setAiSettings`, `aiStatus`, `aiSuggestReply`. It does not touch the WhatsApp webhook, and it sends nothing.
4. Reload Elite OS. Go to **Assistant → Settings → Welcome message for new Meta leads**, choose **New**, and press **Save**.
5. **Test with your own phone:** fill in the Meta form yourself (from the ad or the form preview) with your own number. The new welcome should arrive, and the chat in Elite OS should show the same words.

**Undo:**
- Choose **Standard** and Save. It is instant.
- Full undo of the code: in the Cloud Shell folder, `git checkout 50bcd13 -- functions`, then redeploy the same 6 functions.

## Good to know

- **Category "Marketing":** the new template is a Marketing message.
  - If the current welcome is **Utility**, each new welcome costs a little more.
  - Meta can also hold back some marketing messages to people who get many of them. Elite OS would not see that until WhatsApp reports the message as not delivered.
  - Check the current welcome's category in WhatsApp Manager.
- **"Start a new chat"** (a person starting a chat from the Inbox) still uses the Standard welcome, on purpose.
- The Knowledge Centre's **"Try it"** still shows the Standard welcome in its example chat.
- If you ever **edit** the template at Meta, tell Claude, so the copy in Elite OS stays identical.

## What changed (for the record)

| File | Change |
|---|---|
| `functions/lib/welcome.js` (new) | The two welcomes: their template names, Elite OS's copy of the words, the choice (Standard if anything is unclear) |
| `functions/lib/leads.js` | Sends the chosen welcome. If the New one is refused outright, it sends the Standard one once. The chat copy matches what was sent. The lead record notes which one went |
| `functions/lib/whatsapp.js` | `sendTemplate` can name the other welcome template (same language, same one first-name gap) |
| `functions/lib/aiReceptionist.js` | Either welcome counts as "our welcome", not a person writing |
| `functions/lib/aiSchedule.js` | "Is this Tomasz?" gets the honest line and a person. A first "no" to the New welcome's question is not "not interested" |
| `functions/lib/ai.js` | The owner-only `welcome` setting (Standard or New), and both texts shown in Settings |
| `public/index.html`, `assistant.js`, `app.css` | The choice in Assistant → Settings (only the owner can change it; turned off while the server is older) |
| `scripts/deploy-quote-sending.sh` | New step `welcome` (6 existing functions; never the webhook) |
| `functions/test/welcome-switch.test.js` (new), `scripts.test.js`, `test-ui/assistant.e2e.js` | Tests (below) |

## Tests

Run on 25 Oct 2026, on this PC, on the `welcome-switch` branch. A local test copy was used: no real message was sent and no paid AI was used.

| What | Result |
|---|---|
| New: `welcome-switch.test.js` (Standard unchanged word for word; New sent once; refused New → Standard once; unclear answer → nothing more; rate limit → retried later, still once; both refused → failed, lead kept; the switch is owner-only with two choices; the receptionist; "is this Tomasz?"; a "no" to the question) | ✅ 12 of 12 |
| Planted mistakes (each safety rule broken on purpose: no fallback, a fallback after an unclear answer, the receptionist not knowing the New welcome, no "no" guard, no Tomasz rule, anyone can switch, the wrong words in the chat, the fail-safe read) | ✅ all 8 caught |
| The existing tests for leads, push, do-not-contact, health, the AI, the receptionist (all 15 files) and the install-as-app test | ✅ 440 of 441. The one was receptionist-load check E, the known check that fails about 1 run in 3. It then passed 10 of 10, twice, run alone |
| Deploy script: the `welcome` step checks first, never deploys the webhook, and shows in the help | ✅ |
| Screen: Assistant (21 checks, including the switch: both texts shown, Standard by default, owner chooses New, it stays chosen, and back) | ✅ 21 of 21 |
| Screen: Meta leads arriving | ✅ 11 of 11 |

**Not run yet:** the full regression (about 45 minutes) before release.
