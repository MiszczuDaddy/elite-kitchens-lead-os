# Receptionist fixes after the 200-chat test (17 Oct 2026)

Branch `receptionist-next-step`. **Not merged, not live.** Nothing changes for customers until you say so.

## What changes for customers

1. **No more dead-end replies.**
   - "Yes", "Yes interested" or "Yes please" now get the greeting **and** the visit offer:
     *"Hi Frank, thanks for getting back to us. Would you like us to call out and have a look at your space?"*
   - A plain "Hi" or "Hello" gets the greeting and **one question**:
     *"Hi Leo, thanks for getting back to us. Are you still looking at a new kitchen?"*
     If they answer yes, the visit offer follows.
   - "What happens next?", "How does it work?" or "What's the process?" get the answer **and** the visit offer, once.
   - Plain fact questions (VAT, email, hinges) still get the answer only, as you decided on 15 Oct.
2. **Long messages are read in full.** Before, anything after 400 letters was cut off, so the question at the end was lost.
3. **One greeting per message.** "Hi Megan, thanks for getting back to us. … Hi, thanks for getting back to us." can no longer happen.
4. **Days and times are always written down**: "today", "tomorrow at 10", "only Saturdays", a photo with "Thursday suits", or "can I talk to someone, Friday suits". They show on the booking card even when the chat comes to you.
   - "Can someone come out today?" or "tomorrow?" no longer gets "Good question, I'll check". It gets the new line below, and you get a push.

## New wording: approved by the owner on 17 Oct 2026

| When | Approved words |
|---|---|
| The customer only says hello | **Are you still looking at a new kitchen?** |
| The customer asks for a visit today or tomorrow | **Thanks, I'll pass your request on to the team and they'll get back to you.** (the owner removed "straight away"; changed on branch `receptionist-audit-repairs`) |

Once this is live, you can change both lines yourself. They are in the Knowledge Centre, under the other fixed lines:
- "Customer only says hello";
- "Customer asks for a visit today or tomorrow".

One thing to check: the "hello" question says "a new kitchen". A wardrobes-only lead would also get "kitchen". Tell me if you want other wording.

## Checks

- New tests use the real conversations from the test (A06, E07, F11, A02, H11, C10, A20, E04, E05, E08, I02). They fail on the old code and pass on the new.
- All the receptionist and AI test suites were run on this computer, with no real messages and no AI cost.
- Not done yet: the paid re-run of the 200-chat test (about €1.50, needs your OK).
