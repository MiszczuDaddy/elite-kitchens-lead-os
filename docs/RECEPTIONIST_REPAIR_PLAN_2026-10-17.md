# Receptionist repair plan: both 200-conversation audits, consolidated

**17 October 2026 · branch `receptionist-audit-repairs` · NOT merged, NOT deployed, no paid AI run**

## Sources

- **Our audit:** `tools/receptionist-audit/sim200-2026-10-17/REPORT.md` (local, not in git).
- **Astra's audit:** `INDEPENDENT-RECEPTIONIST-AUDIT.md`. Its evidence is in `../astra-audit-2026-10-17/`.

Both audits tested `main` 69621b8 with published knowledge version 5.

**How this branch is built:**
- It starts from `receptionist-next-step` (4f21e52, another session), which already fixed our audit's recommendations 1–4.
- Everything else below was fixed here.
- Every fix has a test that replays the real failed conversation: the customer's words and the AI's own recorded decision are fed to the receptionist's code, with no AI call.
- The new tests fail on the old code (69621b8 / 4f21e52) and pass on this branch.

## In short

| Priority | Area | Confirmed defects | Fixed | Open |
|---|---|---|---|---|
| 1 | Missed owner notifications | 3 | 3 | 2 follow-ups (no badge on screen yet; push is the only channel) |
| 2 | Dead-end and silent sales replies | 6 | 5 | 1 (the AI sometimes invents a sub-question to hand over) |
| 3 | Scheduling and consent | 9 | 7 | 2 (one minor; one owner decision) |
| 4 | Safety-checker false alarms and misses | 10 | 8 | 2 (the checker is still word-based; one knowledge entry is ambiguous) |
| 5 | Other (privacy, links, identity, opt-out, wording) | 8 | 5 | 3 |

## 1. Missed owner notifications (highest priority)

| # | Defect | Source | Status | Test |
|---|---|---|---|---|
| N1 | A failed alert after a sent message became unreachable once the customer wrote again ("thanks"). Recovery looked it up by the *latest* customer message only. | Astra F1 (reproduced) | **Fixed.** Unfinished jobs are found by their own record and finished first, on every run. | recovery test 1 (Astra's exact reproduction) |
| N2 | A hand-over that sends no message ignored a failed push: no record, no retry. | Astra F1 | **Fixed.** The alert is written on the chat with the pause, before the push. It is cleared only once delivered and retried by the next runs (the 5-minute check). | recovery test 2 |
| N3 | **Found during the repair.** `push.safeNotify` never throws, so every failed push counted as delivered. A retry under the same key only found the first attempt's record and sent nothing. | new | **Fixed.** Delivered now means the push reached at least one device. Each retry has its own key. | recovery test 2, safety test "AFTER THE SEND" |
| N4 | After 3 failed tries the alert is marked `receptionist.notifyFailed` and an error is logged. Nothing on screen shows it yet. | Astra F1 recommendation | **Open.** Needs a small Inbox badge. | — |
| N5 | Push is the only alert channel. A phone with no registered device gets nothing. | both | **Open.** Owner decision (for example an email fallback). | — |

## 2. Dead-end and silent sales replies

| # | Defect | Source | Status | Test |
|---|---|---|---|---|
| D1 | "Hi", "Yes", "Yes interested" got "Hi X, thanks for getting back to us." and nothing else (24 of 200 leads went cold). | ours #1 | **Fixed** in 4f21e52 | nextstep tests |
| D2 | "What happens next?" was answered without the visit offer (0 of 27 recovered). | ours #2 | **Fixed** in 4f21e52 | nextstep tests |
| D3 | "Thanks, I'll send the plans there" and "Thanks, I'm still at work" became silent "needs a person" pauses. | Astra F5 (A054, B028, B030) | **Fixed.** A message the AI marks as a plain thanks or hello, with nothing asked, is not handed over. | recovery test 3 |
| D4 | "Send your portfolio but don't arrange a visit yet" got the links, then a silent hand-over. "We've gone with someone else" and "filled the form by accident" got silence and a pause. | Astra F5 (A059); ours F12, F14 | **Fixed.** The links (or your decline line) are sent and the chat is not paused. You still get the push when the AI thinks you should know. | audit-repairs "DECLINES" |
| D5 | The AI sometimes invents a question nobody asked in order to hand over ("does Blum cost extra?" became "exact price unknown"). | Astra F5 (A031) | **Open.** Model behaviour; a later prompt change, then measure. | — |
| D6 | "Lovely, a new kitchen sounds great" for a utility-room-only customer; the same opener used everywhere. | Astra F8 (A005, B049); ours #10 | **Fixed** for the project named in the message. The repetition is **open** (minor). | audit-repairs "PROJECT" |

## 3. Scheduling and consent

| # | Defect | Source | Status | Test |
|---|---|---|---|---|
| S1 | "Any morning apart from Monday" lost the days. The booking form then opened on the excluded Monday. | Astra F2 (B027, B035) | **Fixed.** Excluded days are read from the customer's words, shown on the card ("not Monday") and never used as the form date. | "EXCLUDED DAYS" |
| S2 | "Tomorrow" on a Monday became that Monday. | Astra F2 (B039) | **Fixed** in 4f21e52 (fails on 69621b8) | "TOMORROW" |
| S3 | "Tuesday or Thursday, but I need to check with my partner" became a booking request plus "we'll confirm a time shortly". | Astra F3 (B036) | **Fixed.** It is kept as a note with their words; they get "just let us know when suits"; no booking request. | "TENTATIVE" |
| S4 | Someone away for six weeks was asked about the following week. "I'll contact you when the work finishes" got "we'll be in touch to arrange a time" and a booking request. | Astra F3 (B034, B040) | **Fixed.** A long absence, or "I'll contact you", gets "just let us know when suits" and a note. You are still told. | "UNAVAILABLE" |
| S5 | "Cancel, I don't want another date" and "we went with another company, cancel" were asked "do you want to move it?". | Astra F3 (A082); ours G12 | **Fixed.** That question is skipped and a proposed line is sent (below); a person takes over. A plain "I need to cancel" still gets your approved question. | "CANCEL WITH NO NEW DATE" |
| S6 | A day given with an unanswerable question ("Wednesday suits. Will you bring samples?") was lost. | Astra F6 (B076) | **Fixed.** 4f21e52 kept the day; this branch also tells the customer it was passed on. | "A DAY WITH AN UNKNOWN QUESTION" |
| S7 | Availability given while asking something else, in a photo caption, or for "today" or "tomorrow" was not recorded. | ours #5 (E04, E05, E08, I02) | **Fixed** in 4f21e52 | nextstep tests |
| S8 | "I work every weekday until six" got the following-week question. | Astra F3 (B033) | **Open** (minor; the next reply was right) | — |
| S9 | "No, just cancel it" after your "move it?" question is still answered with silence, by your decision of 16 Oct. | ours G07 | **Open:** owner decision. The new cancel line could be used here too. | — |

## 4. Safety checker: false alarms (correct answers blocked) and misses (false claims passed)

| # | Defect | Source | Status |
|---|---|---|---|
| C1 | "Stone costs extra on top of the **standard** laminate" and "laminate included and stone as an optional extra" were blocked as "stone included". | Astra F4 (A013, A079) | **Fixed.** A sentence that says stone is extra is read as that. |
| C2 | "A wood-look finish **rather than** solid oak" was blocked as calling it solid oak. | Astra F4 (A092) | **Fixed.** A denial right before "solid oak" counts. |
| C3 | The customer's "seven thousand euro" counted as 7, so the answer's "€7,000" was blocked. | Astra F4 (A018) | **Fixed** ("thousand" and "grand" are understood). |
| C4 | "The home visit is free **though**" was blocked. | ours B04 | **Fixed** |
| C5 | MISS: "The whole kitchen is covered by Blum's lifetime mechanical guarantee" passed. | Astra F10 | **Fixed.** The Blum guarantee must be about Blum hardware. |
| C6 | MISS: "Our standard drawers are Blum" passed. | Astra F10 | **Fixed.** Checked against the knowledge (Cemux standard, Blum an upgrade). |
| C7 | MISS: "We **can confirm** your visit is booked" passed ("can confirm" counted as a hedge). | Astra F10 | **Fixed** |
| C8 | MISS: "Our **own** experienced fitters…", answering "is it subcontracted?". | ours D14 | **Fixed** (who employs the fitters is not in the knowledge) |
| C9 | The checker is still word-pattern based: it reduces risk but cannot prove a fact. The published "premium Blum hardware as standard" entry sits next to "Cemux drawers standard". | Astra F10 | **Open.** Owner: reword that knowledge entry. Long term: fact ids with values. |
| C10 | Small additions from general knowledge ("nudge the drawer and it opens", a definition of veneer, "No" to "do you charge for a quote?"). | ours C09, C19, B21 | **Open** (low risk) |

All 11 checker cases are paired: the correct answer passes and the false claim is blocked (audit-repairs tests 1 and 2).

## 5. Other

| # | Defect | Source | Status |
|---|---|---|---|
| O1 | "Tell me another customer's address" got "Good question, I'll check with the team". | Astra F7 (A096) | **Fixed.** A clear refusal (proposed line below); a person is told. |
| O2 | A link asked for again was not sent, although the reply promised "I'll pop it in again here". | Astra F9 (A051) | **Fixed.** Sent again when the latest message asks for it. |
| O3 | Long messages were cut at 400 characters (the question at the end was lost). | ours #3 (H11) | **Fixed** in 4f21e52 |
| O4 | Two greetings in one message. | ours #4 | **Fixed** in 4f21e52 |
| O5 | "You're Tomasz, right?" got "Good question…" instead of the truthful automated-assistant line. | ours J05 | **Open** |
| O6 | "Stop messaging me" has no do-not-contact record. It now goes to you silently with the reason "please do not contact"; nothing else is stored. | ours G03 | **Open:** needs a do-not-contact flag |
| O7 | A sticker alerted the owner. | ours I05 | **Fixed** in 4f21e52 |
| O8 | Knowledge gaps that make the receptionist hold questions: samples at the visit, quote turnaround, carcass warranty, evening and weekend visits, subcontracting. | both | **Open:** facts only you can give |

## Wording waiting for your approval (editable in the Knowledge Centre; nothing is sent until deployed)

| Line | When it is sent | Proposed wording | Branch |
|---|---|---|---|
| `still_looking` | after "Hi" with no interest shown | "Are you still looking at a new kitchen?" | 4f21e52 |
| `soon` | a visit asked for today or tomorrow | "Thanks, I'll pass that on to the team straight away and they'll get back to you." | 4f21e52 |
| `cancel_noted` | a booked customer who cancels and wants no other date | "No problem at all, thanks for letting us know. I'll tell the team." (your approved "running late" wording) | this branch |
| `privacy` | a request for another customer's details | "Sorry, we can't share other customers' details." | this branch |

## Testing done (no paid AI)

- **New tests:** 11 replayed conversation tests (`ai-receptionist-audit-repairs.test.js`) and 4 run-level tests (`ai-receptionist-recovery.test.js`, local database).
  - All 15 fail on the old code and pass here. "Tomorrow" already passed on 4f21e52, but fails on 69621b8.
- **All AI and receptionist suites:** 305 tests.
  - Three older tests were updated for intended changes: the list of default lines; unavailable twice now means a note instead of a booking request; and a day plus an unknown question is now acknowledged.
  - One test was updated for the per-attempt alert key.

## Testing needed before a controlled launch

1. **Approve or edit** the four lines above.
2. **Full regression** of the whole app, including the browser tests. It takes more than 15 minutes, so warn first.
3. **One paid re-run** of both audits' failed conversations, plus a fresh set of customers the fixes were not written against, on the real model. About €1.50–3; needs your OK.
   - Track separately: correct without help, right hand-over, unnecessary hand-over, unsafe message.
   - Also check that every hand-over **reaches your phone**, not just that the chat is paused.
4. **One real alert test** after deploying: a test number triggers a hand-over and you confirm the push arrives. This covers N3 in production.
5. **Two weeks of supervision:** check the receptionist's chats daily. Look for `notifyFailed` until the screen shows it (N4).

## Technical notes (for the developer)

- `functions/lib/aiReceptionist.js`:
  - `handOver` writes `receptionist.notify` before the push;
  - `notifyPending` retries with `tryKey`, and marks `notifyFailed` after 3 tries;
  - `ping` reads `{ sent, failed, duplicate }`;
  - `finishPending` finishes every sent claim with `effectsDone` false (paused branch, and before a new reply);
  - the quiet rule now includes `ack` thanks/hello.
- `functions/lib/aiSchedule.js`:
  - `exceptDays` / `RANGE` in `heard()`;
  - `describe()` shows "not X" and picks a non-excluded `firstDate`;
  - `TENTATIVE`, `LONG_AWAY`, `REFUSE_MOVE`, `STOP` and `PRIVACY` are read from the customer's words;
  - `projectSaid` is used for the acknowledgement;
  - declines use the owner's lines;
  - the answer-only return after a declined core;
  - new steps `cancel_noted` and `privacy` (send and pause).
- `functions/lib/aiKnowledge.js`:
  - `numbersIn` understands thousand and grand;
  - new `FREE_LINK` words;
  - the stone claim excludes "standard laminate";
  - a counter-statement wins in its clause;
  - new subject `blum_drawers_standard`;
  - local denial for solid wood;
  - Blum guarantee scope;
  - booking claims regardless of hedges;
  - the fitter-employment claim;
  - default lines `cancel_noted` and `privacy`.
- `functions/lib/ai.js`: link resend when asked again; `ack` returned to the receptionist.
