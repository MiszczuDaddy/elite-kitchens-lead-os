# Follow-up emails to leads who never replied

In the Inbox's **No reply** tab, each lead who has an email address and is at least a day old gets an **Email** button, and **Email all (N)** sends to every one of them. Each email is one short message with a single question: would they like a free home consultation? **You read it first and press Send; nothing is ever sent by itself.**

## What the email says
Subject "Your kitchen enquiry with Elite Kitchens". "Hi {first name}, thanks for your enquiry… I just wanted to check in, in case my earlier message got lost. Would you like us to arrange a free home consultation to go through your ideas? If so, just reply to this email with a day and time that suit you, and we'll take it from there." Signed Elite Kitchens with the phone, email and website. For one lead you can change the subject and the words before sending; "Email all" shows the wording once (with {first} for the name), you can change it, and each lead gets their own first name (or "there" if the name is not usable). The wording is `functions/lib/followUpText.js` (with an identical copy `public/followup-text.js`).

## Who may be emailed (decided again on the server)
A lead who is still a **New lead**, has **never written** (in the record and in the chat itself), has **not asked not to be contacted**, has a **valid email address**, arrived **at least a day ago**, and has had **fewer than two** follow-ups, the last one **14 days or more** ago. Two presses at once send one email. If Google refuses, nothing is sent or counted; if Google's answer cannot be confirmed, it counts as sent and is never retried by itself (check the Sent folder of the sending mailbox). The result is kept on the conversation (`followUp`) and is erased with the customer.

## Where it is sent from, and the Sent folder
It uses the same Gmail sending as the quote emails (`MAIL_SEND=on`, the mailer service account). **Gmail always keeps a copy of what it sends in the sender's Sent folder.** So, to keep `info@elitekitchens.ie` clean, set `FOLLOWUP_SENDER` in `functions/.env.elite-kitchens-lead-os` to a **separate Google Workspace mailbox** (for example `followups@elitekitchens.ie`, a second user) and redeploy this function: the emails go out from that mailbox (the copies land in its Sent), and **replies still go to info@** (Reply-To). Until `FOLLOWUP_SENDER` is set, follow-ups are sent as `MAIL_SENDER` and appear in its Sent folder. The existing mailer authorisation (the Workspace "domain-wide delegation" for sending) covers any mailbox in the domain; the new mailbox only has to exist.

## Putting it live
1. `./scripts/deploy-quote-sending.sh followup` (one new function, `sendFollowUpEmail`).
2. `./scripts/deploy-quote-sending.sh live` (the screen; it refuses to go out before the function).

## Tests
`functions/test/follow-up.test.js` (8, emulator): sending, own words, who may be emailed, address and switch, not twice and double press, Google refusing or unconfirmed, staff only, screen/server parity. `test-ui/followup.e2e.js` (5): the button only where allowed, the dialog, one email, Email all, the server refusing.
