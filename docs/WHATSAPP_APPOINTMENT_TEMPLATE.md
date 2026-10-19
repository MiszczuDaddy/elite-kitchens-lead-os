# WhatsApp templates for visit messages (Phase 12): the three to submit to Meta

**Why:** Elite OS can send a normal message only within 24 hours of the customer's last message. After that, only a **Meta-approved template** can go. Phase 12 sends three messages about a visit; each goes as a normal message when the window is open, and as the matching template when it is closed.
Until a template is approved, a message that needs it is **not sent** and the visit says so; nothing else breaks. Approval usually takes from a few minutes to a couple of days.

**Settings** (`functions/.env.elite-kitchens-lead-os`; these names are the defaults, so nothing needs changing if you use them exactly):

| Message | Template name (default) | Setting |
|---|---|---|
| Confirmation | `elite_kitchens_consultation_confirmed` | `BOOKING_CONFIRM_TEMPLATE` |
| Time changed, or visit cancelled | `elite_kitchens_consultation_changed` | `BOOKING_CHANGE_TEMPLATE` |
| Evening-before reminder | `elite_kitchens_consultation_reminder` | `BOOKING_REMINDER_TEMPLATE` |
| Language (all three) | `en` | `BOOKING_TEMPLATE_LANG` |

A blank name switches that template off (only the 24-hour window can be used for that message).

**For every template:** Category **Utility** (a message about something the customer asked for; no promotion), language English (`en`), no header, no buttons, no links, no emoji. Footer: leave empty. Meta needs a **sample** for each variable (below).

## 1. `elite_kitchens_consultation_confirmed`
```
Hi {{1}}, your {{2}} with Elite Kitchens is confirmed for {{3}} at {{4}}. We will call out to you in {{5}}. If you need to change the time, just reply to this message and we will sort it out. Thank you!
```
| Variable | Filled in with | Sample for Meta |
|---|---|---|
| `{{1}}` | the customer's first name (or "there") | `Anna` |
| `{{2}}` | `consultation` or `site visit` | `consultation` |
| `{{3}}` | the date | `Tuesday 20 October` |
| `{{4}}` | the start time, 24-hour, Irish time | `10:00` |
| `{{5}}` | the **town** from the customer's record (never the full address), or "your area" | `Swords` |

## 2. `elite_kitchens_consultation_changed` (also used for a cancellation)
```
Hi {{1}}, an update on your {{2}} with Elite Kitchens: {{3}}. If you have any questions, just reply to this message and we will help. Thank you!
```
| Variable | Filled in with | Sample for Meta |
|---|---|---|
| `{{1}}` | first name | `Anna` |
| `{{2}}` | `consultation` or `site visit` | `consultation` |
| `{{3}}` | the news: `it is now on Wednesday 21 October at 14:00` or `it has been cancelled` | `it is now on Wednesday 21 October at 14:00` |

## 3. `elite_kitchens_consultation_reminder`
```
Hi {{1}}, a reminder that your {{2}} with Elite Kitchens is tomorrow, {{3}} at {{4}}. If you need to change it, just reply to this message. See you then!
```
| Variable | Filled in with | Sample for Meta |
|---|---|---|
| `{{1}}` | first name | `Anna` |
| `{{2}}` | `consultation` or `site visit` | `consultation` |
| `{{3}}` | the date | `Wednesday 21 October` |
| `{{4}}` | the start time | `10:00` |

## How to submit (you, in Meta Business Manager)
1. Business Manager → WhatsApp Manager → **Message templates** → **Create template**.
2. Category **Utility**, name and language exactly as above, paste the body, fill the samples, submit. Do this three times.
3. When each shows **Approved**, tell me (or just check it in the test below). If Meta makes you rename one, tell me the exact name: it is a setting, nothing is hard-coded.

## Notes
* The words above are what staff see in the chat after a template goes. Keep the Elite OS wording and the approved template identical; if you ever edit one at Meta, tell me so I can match it.
* Installations send **no** message to the customer in Phase 12.
* One message per visit and kind: a confirmation once; a change once per change; a cancellation once; a reminder once per start time. A message WhatsApp did not confirm is never sent again by itself (a person looks at the chat and presses "It arrived" or "It did not arrive").
