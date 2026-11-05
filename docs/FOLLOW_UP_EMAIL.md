# Follow-up emails to leads who never replied

In the Inbox's **No reply** tab, each lead who has an email address and is at least a day old gets an **Email** button, and **Email all (N)** sends to every one of them. Each email is one short message with a single question: would they like a free home consultation? **You read it first and press Send; nothing is ever sent by itself.**

## What the email says
Subject "Your kitchen enquiry with Elite Kitchens". "Hi {first name}, thanks for your enquiry… I just wanted to check in, in case my earlier message got lost. Would you like us to arrange a free home consultation to go through your ideas? If so, just reply to this email with a day and time that suit you, and we'll take it from there." Signed Elite Kitchens with the phone, email and website. For one lead you can change the subject and the words before sending; "Email all" shows the wording once (with {first} for the name), you can change it, and each lead gets their own first name (or "there" if the name is not usable). The wording is `functions/lib/followUpText.js` (with an identical copy `public/followup-text.js`).

## Who may be emailed (decided again on the server)
A lead who is still a **New lead**, has **never written** (in the record and in the chat itself), has **not asked not to be contacted**, has a **valid email address**, arrived **at least a day ago**, and has had **fewer than two** follow-ups, the last one **14 days or more** ago. Two presses at once send one email. If Google refuses, nothing is sent or counted; if Google's answer cannot be confirmed, it counts as sent and is never retried by itself (check the Sent folder of the sending mailbox). The result is kept on the conversation (`followUp`) and is erased with the customer.

## Where it is sent from, and the Sent folder
It uses the same Gmail sending as the quote emails (`MAIL_SEND=on`, the mailer service account). **Gmail always keeps a copy of what it sends in the sender's Sent folder.** So, to keep `info@elitekitchens.ie` clean, set `FOLLOWUP_SENDER` in `functions/.env.elite-kitchens-lead-os` to a **separate Google Workspace mailbox** (for example `followups@elitekitchens.ie`, a second user) and redeploy this function: the emails go out from that mailbox (the copies land in its Sent), and **replies still go to info@** (Reply-To). Until `FOLLOWUP_SENDER` is set, follow-ups are sent as `MAIL_SENDER` and appear in its Sent folder. The existing mailer authorisation (the Workspace "domain-wide delegation" for sending) covers any mailbox in the domain; the new mailbox only has to exist.

## Ask the Assistant: "email all the leads who did not reply" (5 Nov 2026)
Instead of pressing Email all, you can write to the Assistant: *"write a follow up email to all leads that didn't reply"*. It prepares **one approval card** (the same card the Assistant already uses for notes and project updates):
- **Who gets it (N)**: every lead who may be emailed right now (the rules above, checked when the card is made, including a look inside the chat for a message from them), oldest first, each as "Name · email". At most **30** per card; if there are more it says so and you ask again.
- **The email**: the exact fixed text, with {first name} where each lead's own first name goes. **The model writes no words and picks no one**: the list and the text are built by code (`buildFollowUps` in `functions/lib/aiActions.js`), and the tool takes no input at all.
- Press **Approve** and the emails go out one lead at a time through the same server code as the Email button (`functions/lib/followUp.js`), which checks every rule again for each lead: someone who wrote in the meantime, or was emailed meanwhile, is **skipped with a reason** and the rest still go. The card ends with "2 emails were sent." or "1 of 2 emails were sent. The others were skipped" and a Sent / Not sent line per lead. **Reject**, or doing nothing (it expires after 30 minutes), sends nothing.
- Pressing Approve twice never emails anyone twice (the proposal is claimed once, and each send is recorded on the lead).
- **It is OFF until the owner ticks "Follow-up emails to leads who never replied" in Assistant > Settings** (with AI actions switched on). Email sending (`MAIL_SEND`) must be on; if it is not, Approve is refused and the card stays waiting.
- The audit log records that a proposal was created and applied, by whom, and nothing about names or addresses.

## Putting it live
1. `./scripts/deploy-quote-sending.sh followup` (one new function, `sendFollowUpEmail`).
2. `./scripts/deploy-quote-sending.sh assistantmail` (the Assistant: `aiChat`, `aiStatus`, `setAiSettings`, `aiDecide`; all exist already).
3. `./scripts/deploy-quote-sending.sh live` (the screen; it refuses to go out before the first function).
4. In Assistant > Settings, tick the new box.

## Tests
`functions/test/ai-followup-emails.test.js` (10, emulator): the switch, who is listed, the model cannot add words or people, the 30 cap, Approve sends one each with their own name, twice sends once, a lead who wrote meanwhile is skipped, Google refusing, switches off at decision time, who may decide. `test-ui/assistant-followup.e2e.js` (6): switch off by default, the card, Approve, asking again, the phone. `functions/test/follow-up.test.js` (8, emulator): sending, own words, who may be emailed, address and switch, not twice and double press, Google refusing or unconfirmed, staff only, screen/server parity. `test-ui/followup.e2e.js` (5): the button only where allowed, the dialog, one email, Email all, the server refusing.
