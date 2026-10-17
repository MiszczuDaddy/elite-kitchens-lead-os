# Phase 8: push notifications

An alert on Windows and Android for every **new WhatsApp message** and every **new Meta lead**, even when Elite OS is closed; clicking it opens the right chat. **Live since 2026-10-12** (see "What the real rollout taught" at the end).

## How it works
1. **Enable:** the Notifications dialog (left bar; a small link on phones) asks the browser for permission, gets this device's push address from Firebase Cloud Messaging (FCM) through the app's own service worker (`sw.js`), and a staff-only function stores it (`pushDevices/{id}`).
2. **Sending:** the webhook calls the push right after a **new** WhatsApp message is stored (a Meta retry is a duplicate and sends nothing), **before** the slow media download; `leadIntake` does the same right after the customer is saved, **before** the welcome message. The call can never throw, gives up after 2.5 s, and its result is ignored by the webhook: **a push can never break or hold up WhatsApp or lead processing** (tested with Firebase down, hanging, and the hook itself throwing).
3. **What is sent:** data only, with opaque ids: the notification id, this device's id, the kind, and a hash that groups one customer's alerts. **No name, number or message text.** The service worker writes the words itself: "New WhatsApp message / Open Elite OS to read it.", "New lead / Open Elite OS to see the details.".
4. **Click:** opens (or focuses) Elite OS; the app looks the opaque id up (staff only) and goes to that customer's chat.
5. **No duplicates:** one create-only record per WhatsApp message id / lead id (`pushEvents`), one push per device, one alert per customer at a time (a tag; a new message replaces the earlier alert), and no alert while Elite OS is open and in front.
6. **Who:** only staff on `ALLOWED_EMAILS` who switched notifications on, on that device. A person removed from the list gets nothing even before their devices are deleted (`scripts/revoke-staff.js` deletes them too). A device that unsubscribed is forgotten at the next send.

## Measuring real delivery (what was asked for)
Each notification has a record `pushEvents/{id}` with timestamps from different steps (all milliseconds):

| Field | Meaning |
|---|---|
| `eventAt` | Meta's own time of the message / lead (seconds resolution, Meta's clock) |
| `backendReceivedAt` | our function received the request |
| `sendStartedAt` | just before the push was handed to Firebase |
| `devices.<id>.acceptedAt` | Firebase answered "accepted" for that device. **This is not delivery** and is never shown as such |
| `receipts.<id>.received` | `{ deviceAt, serverAt }`: the service worker on the device reports the moment it woke up (the device's clock) and our server's clock when the report arrived |
| `receipts.<id>.clicked` | the same for the click |

Reports go to `/pushReceipt` (a Hosting rewrite to a public function: strict, one report per kind, returns nothing). **"Notification speed"** in the Notifications dialog lists the last 20 with the gaps *Meta → us*, *us → send*, *Firebase accepted*, *accepted → device*, *total to device*, per device (Windows vs Android), with the median and slowest 5% per device type. **"Send a test notification"** gives a repeatable test whose clock starts when the request reaches the server.

**Honest limits:** "device received" is when our code on the device woke up; the report adds its own trip (a fraction of a second). A device with no connection sends no report ("no report"). A device with a wrong clock is flagged (use the "total", which uses our server's clock at both ends). Meta's own timestamp has one-second resolution.

## To measure on your devices (after the deploy)
1. Windows: open Elite OS, Notifications, Enable, Send a test notification ten times; read the table. Then **close** Elite OS (the installed window; the browser may stay in the background) and send a test from a second device or wait for a real message.
2. Android: the same, then lock the phone and test again. Battery saving can delay pushes (Android "Doze"): note it.
3. A real WhatsApp message from your own phone to the business number: the row says *Meta → us* (Meta's delay), *us → send*, and the total.

## Platform notes
* **Windows (Edge or Chrome):** alerts arrive while the browser is allowed to run in the background (the default). If it is fully quit, or the PC is asleep or offline, the alert arrives when it wakes.
* **Android (Chrome / the installed app):** delivered through FCM even when closed; battery optimisation may delay it. iPhone is not included.

## Data and privacy
* **Phase 10:** a fifth kind, `alert` ("Elite OS needs attention"), for a problem or a Meta lead that could not be added; tapping it opens "Needs attention". Tapping a hand-over alert now opens that chat (it used to open only Elite OS: the screen did not recognise `h_` ids). A hand-over alert that failed three times is retried by the health check and falls back to email (`docs/PHASE10_SAFETY_NET.md`).
* `pushDevices/{id}`: the FCM token, the e-mail, the device type, on/off. Readable by staff (the existing rule); no write from a browser.
* `pushEvents/{id}`: the customer's phone (to open the chat), the kind, the timings. **Erased with the customer** (`deleteCustomer`), like projects.
* Google (FCM) sees opaque ids only.
* Retention: the measurement records are kept until the customer is erased. A clean-up of old ones is a possible later change.

## One-time setup (the owner's approval needed; nothing is changed until then)
1. **Register a Firebase web app** (the live config has no `appId`, which FCM needs): in Cloud Shell `firebase apps:create WEB "Elite OS web" --project elite-kitchens-lead-os`. Hosting then serves the new `appId` in `/__/firebase/init.json` (check it). Free; changes nothing else.
2. **Needed (it was not optional):** let the functions' account send push: `gcloud projects add-iam-policy-binding elite-kitchens-lead-os --member=serviceAccount:812360112616-compute@developer.gserviceaccount.com --role=roles/firebasecloudmessaging.admin`.

## Release (each step needs the owner's approval)
1. Merge, then the web app (setup 1).
2. `./scripts/deploy-quote-sending.sh push`: the 4 new functions (`registerPushDevice`, `unregisterPushDevice`, `sendTestPush`, `pushReceipt`) **and the live `webhook` and `leadIntake`**; asks "yes" naming the webhook; checks each answers and refuses a bad request.
3. `./scripts/deploy-quote-sending.sh live` (refuses until step 2): the Notifications button, the service worker with push, the `/pushReceipt` rewrite. Reload Elite OS (the installed apps update their service worker by themselves).
Undo: Hosting rollback for the screen; for the functions `git checkout phase-7-projects-complete -- functions` and redeploy `webhook` and `leadIntake` (the new four are harmless without the screen).

## Tests
`functions/test/push.test.js` (10, emulator), `push-sw.test.js` (7, no emulator: the real `sw.js` push and click handling, and the speed model), `test-ui/push.e2e.js` (9: dialog, enable and registration, test, the table, the real service worker receiving a push with Elite OS closed and reporting to the real receipt function, click-through, turning off, blocked permission, phone layout; needs full Chrome: `CHROMIUM="C:/Program Files/Google/Chrome/Application/chrome.exe"`), a static deploy-script test, and the updated PWA test (the service worker may now push, but still stores nothing). **12 planted errors, all caught.** Real delivery over the internet can only be tested on real devices.

## What the real rollout taught (2026-10-12) and the first measurements
**Deployed and working** on Windows (installed app) and Android (Samsung, added to the home screen), with Elite OS closed. Order done: merge, web app, backend (incl. `webhook` and `leadIntake`), Hosting; then four fixes found only on the real project:
1. **The Firebase web app's `appId`** is not in Hosting's automatic config until the next Hosting release; `public/push.js` carries it as a fallback (public).
2. **A Web Push key of our own.** The shared default key was not usable; the PUBLIC key made in the Firebase console (Project settings > Cloud Messaging > Web Push certificates) is in `public/push.js`.
3. **The functions' account needed `roles/firebasecloudmessaging.admin`** (it was not optional). The Firebase library reports a *permission denied* as `messaging/mismatched-credential`, which looks like a token problem and is not; the role takes a few minutes to apply. To read the real error of a failed push: Firestore `pushEvents/<id>.devices.<id>.error`, and send the same message with your own account through `https://fcm.googleapis.com/v1/projects/elite-kitchens-lead-os/messages:send`.
4. **Sign-in lockout (fixed, tested).** Once notifications are allowed in a browser, Firebase's function-calling code asks the messaging library for a token on **every** function call; when that failed (first a missing `/firebase-messaging-sw.js`, in general any failure to reach Firebase messaging) the first call at sign-in failed and the app said "not authorised". Elite OS never needs that token, so `silenceCallToken` in `public/push.js` switches it off for function calls (best effort: it uses a private part of the SDK; `test-ui/push.e2e.js` signs in with notifications allowed and production-like config, and fails without the fix). `public/firebase-messaging-sw.js` is a safety-net file that only loads `/sw.js`. **Emergency workaround if it ever happens again:** sign in from a private window, or reset the site's Notifications permission to "Ask".
5. **Android battery saving** (Samsung "sleeping apps"): after a while the phone stopped reporting. Settings > Apps > Chrome (and Elite OS) > Battery > Unrestricted, and take them out of "Sleeping / Deep sleeping apps"; then it worked.
6. A device registered with an older token stays in the list until a send finds it unregistered, then it is removed.

**First measurements** (the owner's real WhatsApp messages, app closed, one device each): Meta to our backend 1.6 to 7.3 s (Meta's side; the 7.3 s message was also the first after idle, a cold start); backend to push handed to Firebase 114 to 188 ms warm (546 ms cold); Firebase accepted 52 to 86 ms; Firebase accepted to the device waking up 68 ms (Windows) and 314 ms (Android, awake); total backend to device 237 to 329 ms (Windows), 946 ms (Android). Windows button tests: 158 to 233 ms. The table only measures when our code on the device woke up, not when the alert appeared on screen. Ideas not done: send the push in parallel with saving the message (about 400 ms less when cold), a minimum instance for the webhook (no cold start, costs money), a "send a test in 15 seconds" button, a clean-up of old `pushEvents`.
