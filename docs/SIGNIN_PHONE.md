# Staying signed in on the phone (27 October 2026)

**The problem (owner's report):** "Elite OS keeps making me log in again every time I open it on my phone."

## Root cause

You were **not** being signed out. Firebase keeps you signed in on the phone, and that was working. The problem was what the screen showed while Elite OS opened:
1. The **sign-in page** ("Sign in with Google") was the page's starting screen.
2. When Elite OS opens, Firebase says who is signed in on the phone. The server then renews your staff access (`claimAccess`), which lasts 12 hours.
3. Only after the server answered was the sign-in page hidden and the app shown.
4. After the phone had been idle, the server takes **several seconds** to wake up. For those seconds you saw "Sign in with Google", which looks exactly like being signed out, so you signed in again.
5. Worse: if that server call failed even once (a weak signal), the app showed the sign-in page with "**not authorised**", although you were still signed in and still allowed.

The new test reproduced this: closing and reopening a phone-sized browser profile with a slow server showed the sign-in page every time.

## The fix

These changes are screen only. No server code changed, and no setting or security rule changed.
- Elite OS now opens on a short **"Opening Elite OS…"** screen.
- The **sign-in page** shows only when nobody is signed in on the phone, or when access was refused.
- **Nothing is shown before the server has confirmed your access**, exactly as before. Only the waiting screen is different.
- **A weak signal** shows "Can't reach Elite OS right now. Trying again…".
  - You stay signed in, and the app keeps trying by itself (after 2, 4, 8, 15, then every 30 seconds).
  - It also tries again at once when the phone gets its connection back, or when you return to the app.
  - There are **Try again** and **Sign out** buttons.
- **Security is unchanged:**
  - Someone not on the staff list still gets "not authorised" and no data.
  - A session that was ended (account disabled, or a revoked sign-in) goes to the sign-in page.
  - Signing out is remembered.
  - Staff access still expires after 12 hours unless renewed, and is checked with the server before anything is shown.
  - The security rules are not touched.

## Tests (27 Oct 2026, on this PC; a local test copy, nothing live touched)

| What | Result |
|---|---|
| New: `test-ui/signin.e2e.js`. It closes and reopens a phone-sized, touch browser profile, which keeps its storage like the installed app does. It covers a slow server (4 s), a weak signal (2 failures, then OK), a restart, sign-out remembered, someone not allowed, and an ended session | ✅ 8 of 8. On the old code it fails at "the sign-in page was never shown" (the problem reproduced) |
| Planted mistakes: the sign-in page shown at the start again; every refusal treated as a connection problem; no retry on a connection problem | ✅ all 3 caught |
| The install-as-app test | ✅ 12 of 12 |
| All the other screen tests (every one signs in first) | ✅ **20 of 23 pass**, and the other 3 fail on unchanged `main` too:<br>• **quote-recovery:** failed once in the full run, then passed 19 of 19 alone. On unchanged `main` the same check also failed once and passed once: it is the known unreliable test.<br>• **appointments, lead-address and conversion:** these fail in the **same way, at the same line, on unchanged `main`** (`appointments.e2e.js:231`; conversion "Lead → Booked"). These calendar and monthly-rate tests depend on today's date near the end of the month, so they are not affected by this change. Fixing them is a separate, test-only job. |

**Not tested:** a real phone. Playwright cannot install the app as a PWA. The installed app keeps its sign-in in the same browser storage as the test profile, so it behaves the same way. Please try it on your phone after the release.

## Release (each needs your OK)

1. Merge the `signin-persist` branch into `main`, and push to GitHub.
2. **Cloud Shell:**
   ```bash
   cd ~/elite-kitchens-lead-os && git pull --ff-only && ./scripts/deploy-quote-sending.sh live
   ```
   This only updates the screen.
3. **On your phone:** close Elite OS fully and open it again. You should see "Opening Elite OS…" for a moment, then the app, with no sign-in. Leave it for a few hours, then open it again: the same.

**Undo:** Firebase console → Hosting → Release history → Rollback.
