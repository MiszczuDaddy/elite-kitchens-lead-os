# Security model and review (Phase 2)

## Who can do what
| Thing | Who | How it is enforced |
|---|---|---|
| Open the app | Google accounts in `ALLOWED_EMAILS` only | `claimAccess` (verified email + allowlist) sets the `staff` claim; removed people lose it at next sign-in |
| Read customers/conversations/messages | Staff with the claim | Firestore rules (`request.auth.token.staff == true`); nobody can write from a browser |
| Every action (send, edit, mark read, media) | Staff | Each callable runs `assertStaff` (signed in + claim + still on the allowlist) |
| Receive WhatsApp events | Meta only | `X-Hub-Signature-256` HMAC with the app secret; verify token for the handshake; other phone numbers' events ignored |
| Customer photos/files | Staff, via 10-minute signed links | Storage rules deny ALL browser reads/writes under `media/`; `mediaUrl` checks staff + that the path belongs to that conversation |
| Uploads to send | Staff, own folder, create-only, <=100 MB | Storage rules; `sendMedia` re-validates type/size/path, checks the 24h window, then moves the file into private `media/` |

## Review results (2026-09-30)
- Every function has an auth guard (checked programmatically: webhook = HMAC, claimAccess = allowlist, all 7 others = assertStaff).
- No `innerHTML`/`eval`/`document.write` anywhere in the browser code; all customer-supplied text is inserted with `textContent`.
- No secrets in the repo or its git history (Meta token, app secret, private keys, API keys scanned). The "EAA..." pattern
  matches only the 1x1 test PNG embedded in the tests.
- Customer media is never public: verified by tests that the storage emulator refuses unauthenticated AND staff direct reads.
- `npm audit --omit=dev`: 0 high/critical, 9 moderate (transitive in firebase-admin 13 / firebase-functions 6).
  UPGRADED (chore/firebase-sdk-upgrade): firebase-admin 14.5.0 + firebase-functions 7.4.0 -> 2 moderate remain, both the same
  issue: uuid 9.0.1 pinned inside Google's @google-cloud/storage 8.2.0 (flaw needs a caller-supplied buffer to uuid v3/v5/v6;
  gaxios/we only use v4). Accepted residual; clears when Google updates that dependency. Not forced with an override because
  that would put untested code paths (signed URLs, resumable writes) into production.
- Hosting: no-cache + nosniff + frame-deny + referrer policy on our own pages (auth helper paths deliberately untouched).

## Known gaps / recommended next hardening
1. Rotate the Meta app secret and the webhook verify token (both were displayed during setup).
2. Firebase App Check for Storage/Functions (optional abuse protection; Firebase console suggests it).
3. Data retention / GDPR: there is no "delete a customer and their files" action yet, and no storage lifecycle rule.
   Customer photos are personal data: add an erase action and a retention policy before wide use.
4. Content-Security-Policy header (needs care with Google sign-in; test on the preview first).
5. Single allowlisted account today; add staff by editing `ALLOWED_EMAILS` and redeploying.
