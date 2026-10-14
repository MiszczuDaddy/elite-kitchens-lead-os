# WhatsApp appointment-confirmation template (prepared for Meta approval; not submitted, not used by any code yet)

**Why:** Elite OS can only send free-text WhatsApp messages within 24 hours of the customer's last message. A consultation confirmation sent later (or after the booking is approved the next day) must use a **Meta-approved template**. This is needed for stage R2 (consultation booking). Approval by Meta takes anywhere from minutes to a few days, so submit it early.

## Template 1: consultation confirmed (the one R2 needs)
| Field | Value |
|---|---|
| Name | `elite_kitchens_consultation_confirmed` (lower case, underscores) |
| Category | **Utility** (a confirmation of something the customer asked for; it must contain no promotion or marketing) |
| Language | English (`en`) |
| Header | none |
| Footer | `Elite Kitchens` |
| Buttons | none (the customer simply replies in the chat) |

**Body** (3 to 4 variables; Meta needs a sample for each; variables may not be next to each other or at the very start or end):
```
Hi {{1}}, your initial consultation with Elite Kitchens is confirmed for {{2}} at {{3}}. We will call out to you at {{4}}. If you need to change the time, just reply to this message and we will sort it out. Thank you!
```
| Variable | What the system fills in | Sample for Meta |
|---|---|---|
| `{{1}}` | the customer's first name | `Anna` |
| `{{2}}` | the date, e.g. `Tuesday 20 October` | `Tuesday 20 October` |
| `{{3}}` | the start time, 24-hour or am/pm as you prefer | `10:00` |
| `{{4}}` | the area or the customer's address (we suggest the **town only**, for privacy) | `Swords` |

Plain text, no emoji, no links: all of that keeps it clearly "utility" and easier to approve.

## Template 2 (optional, later): consultation moved or cancelled
```
Hi {{1}}, your consultation with Elite Kitchens has been changed to {{2}} at {{3}}. If that does not suit you, just reply to this message. Thank you!
```
Name `elite_kitchens_consultation_changed`, Utility, English. Samples `Anna`, `Wednesday 21 October`, `14:00`.

## How to submit (you, in Meta Business Manager)
1. Business Manager → WhatsApp Manager → **Message templates** → **Create template**.
2. Category **Utility**, name and language as above, paste the body, fill the samples, submit.
3. When it shows **Approved**, tell me the exact name and language. R2 will read them from the settings file (like the Reopen and quotation templates), so nothing is hard-coded.

## Rules R2 will follow
* If the customer's 24-hour window is open, the confirmation goes as a normal text message (no template needed).
* If it is closed, the approved template is used; if the template is not approved yet, the booking is still saved but **no confirmation is sent** and the approval card says so.
* One confirmation per booking (the same request can never send twice). Nothing is sent without your approval of the booking.
