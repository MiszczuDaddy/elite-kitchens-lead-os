# Phase 6.2: Elite OS as an installable app (PWA)

Elite OS can be installed as an app: its own window and icon on **Windows** (Edge or Chrome) and on **Android** (Chrome). Same website, same sign-in, same data.
Screen files and `firebase.json` only: no backend, no rules, no functions. Branch `phase-6-2-pwa`.

## What was added (all in `public/`)
| File | What it does |
|---|---|
| `manifest.webmanifest` | Name "Elite Kitchens Lead OS" (short "Elite OS"), opens its own window at `/`, light colours of the app. |
| `icons/` | `EK` monogram made from the real E and K of the logo, bone letters on the brand green. `icon-192.png`, `icon-512.png` (rounded), `icon-maskable-512.png` (the shape Android crops), two favicons. Made by `scripts/make-icons.js`. |
| `sw.js` | A tiny service worker. See below. |
| `offline.html` | "You're offline" with a **Retry** button (also retries by itself when the connection returns). |
| `pwa.js` | Registers the worker and shows **Install Elite OS** only when the browser offers installation. |
| `index.html`, `app.css` | The manifest and icon links, `pwa.js`, and the install option (rail above Sign out on a computer; a small text line under the caption on a phone). |
| `firebase.json` | No-cache headers for `sw.js`, `pwa.js`, `offline.html` and the manifest (an old worker must not outlive an update), and the manifest's content type. The `/webhook` rewrite is untouched. |

## What the service worker does and does not do
* It stores **only** `offline.html`. **No app code and no data** are kept on the device, so staff always run the code the server sends: a quote can never be sent by an old copy of the screen.
* It touches **page loads only**, and only a **failed connection** gets the offline page (a server error is passed on as it is).
* Firebase, Firestore, Storage, Cloud Functions, Google sign-in (`/__/`), the WhatsApp webhook (`/webhook`), scripts, files and other websites go straight to the network.
* Not included: push notifications, offline data, iPhone, Microsoft Store, Google Play.

## Installing
* **Windows:** in Edge or Chrome, open Elite OS, sign in, then **Install Elite OS** in the left bar (above Sign out), or the install icon in the address bar.
* **Android:** in Chrome, open Elite OS, sign in, then **Install Elite OS** under "WhatsApp conversations" (or Chrome menu > Install app).
* The option disappears once installed, and never shows inside the installed app.

## Tests
* `functions/test/pwa.test.js` (11, about 2 seconds, no emulator): manifest, icon sizes, page wiring, headers, and the REAL `sw.js` and `pwa.js` run in a pretend browser. 8 planted errors, all caught.
* `test-ui/pwa.e2e.js` (8 checks, `bash test-ui/run.sh pwa.e2e.js`): Chrome's own installability check reports no errors; the worker stores only the offline page; `app.js` comes from the network, never from the worker; offline page and Retry; the install option on a computer and on a phone (the header looks exactly the same); never shown in a standalone window.
* **Not tested by a machine:** a real installation on Windows and on Android, and Google sign-in inside the installed window (it uses a popup, which can behave differently there). Test these by hand after the deploy.

## Release and undo
* Deploy: Hosting only (`firebase deploy --project elite-kitchens-lead-os --only hosting`).
* Undo the release: Firebase console > Hosting > Release history > Rollback.
* Worker misbehaving on a device: deploy a `sw.js` that only unregisters itself and deletes the caches (`self.registration.unregister()` after `caches.keys()` and `caches.delete()`), then everything runs as a normal website. Removing an installed app is done on the device (Windows: Settings > Apps, or the app's menu > Uninstall; Android: long-press the icon > Uninstall).
