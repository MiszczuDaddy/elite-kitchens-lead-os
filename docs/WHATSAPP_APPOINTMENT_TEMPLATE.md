# WhatsApp template for the visit reminder (Phase 12): the ONE template to submit to Meta

*Changed 19 Oct 2026: the confirmation and "changed or cancelled" templates are no longer needed. Only the reminder is sent.*

**Why:** Elite OS can send a normal message only within 24 hours of the customer's last message. The evening-before reminder is usually later, so WhatsApp requires a pre-approved **template**. Inside the 24-hour window the same words go as a normal message. Until the template is approved, a reminder that needs it is **not sent** and the visit says so; nothing else breaks.

**Setting** (`functions/.env.elite-kitchens-lead-os`; the name below is the default, so nothing needs changing if you use it exactly):

| Message | Template name (default) | Setting |
|---|---|---|
| Evening-before reminder | `elite_kitchens_consultation_reminder` | `BOOKING_REMINDER_TEMPLATE` |
| Language | `en` | `BOOKING_TEMPLATE_LANG` |
| Automatic reminders on or off | off | `BOOKING_REMINDERS` (`./scripts/deploy-quote-sending.sh reminders on|off`) |

A blank template name switches the template route off (only the 24-hour window can then be used).

**The template:** category **Utility** (a message about something the customer arranged; no promotion), language English (`en`), no header, no buttons, no links, no emoji, footer empty.

**Name:** `elite_kitchens_consultation_reminder`

**Body:**
```
Hi {{1}}, a reminder that your {{2}} with Elite Kitchens is tomorrow, {{3}} at {{4}}. If you need to change it, just reply to this message. See you then!
```
| Variable | Filled in with | Sample for Meta |
|---|---|---|
| `{{1}}` | the customer's first name (or "there") | `Anna` |
| `{{2}}` | `consultation` or `site visit` | `consultation` |
| `{{3}}` | the date | `Wednesday 21 October` |
| `{{4}}` | the start time, 24-hour, Irish time | `10:00` |

## How to submit
Step by step for a non-technical owner: `docs/PHASE12_META_TEMPLATES_GUIDE.md`.

## Notes
* The words above are what staff see in the chat after the template goes. Keep the Elite OS wording and the approved template identical; if you ever edit it at Meta, tell me so I can match it.
* One reminder per visit time. A message WhatsApp did not confirm is never sent again by itself (a person looks at the chat and presses "It arrived" or "It did not arrive").
* Installations send **no** message to the customer.
