# Impeccable review — before the light redesign

Method: two independent assessments (design_review and evidence_review), completed 2026-10-01 against e491827. Target: public/index.html, app.css and app.js. User reference: supplied light business-interface screenshot, used for visual language rather than literal copying.

## Verdict

The four-pane information architecture is appropriate. The incumbent green rail, tinted bubbles, repeated borders and similarly weighted labels give the chrome too much emphasis. The reference calls for neutral navigation, intentional density and stronger typographic hierarchy.

## Heuristic assessment

| Heuristic | Score / 4 | Finding |
| --- | --- | --- |
| System status | 3 | Existing unread/status feedback is useful; profile Save is below the fold. |
| Real-world language | 3 | Customer/project data is appropriate; file emoji and raw deletion counts are visually inconsistent. |
| User control | 2 | Back and close exist; unsaved customer edits can be lost on switching. |
| Consistency | 3 | Clear panes, but phone profile Back appears on the opposite side. |
| Error prevention | 3 | Confirmation protects deletion; drafts need customer isolation. |
| Recognition | 3 | Strong context, but profile fields need grouping. |
| Efficiency | 2 | Search and keyboard opening work; inactive destinations and deep Save placement add friction. |
| Minimalism | 2 | Dark rail and repeated containers compete with conversation content. |
| Recovery | 3 | Existing retry and validation paths remain essential. |
| Guidance | 2 | WhatsApp-window explanation helps; planned tools look active. |
| Total | 26 / 40 | Functional foundation with moderate design debt. |

## Priorities carried into implementation

1. Replace the dark rail with warm neutral surfaces and charcoal type. Keep the conversation visually primary.
2. Reduce routine row/bubble borders, group related controls, and distinguish names, snippets and metadata.
3. Put future destinations in a clearly labeled Coming later disclosure.
4. Group profile fields and keep Save/status visible. Put mobile Back at the leading edge and contain focus in the full-screen profile.
5. Simplify gallery metadata, group by month, separate expired entries from photo tiles, and use a drawn document icon.
6. Preserve per-customer message drafts and unsaved profile edits in memory when switching. Clear them at sign-out; do not add storage or backend writes.

## Evidence and limits

Both reviewers independently inspected current desktop/mobile screenshots and source. Each opened and closed a fresh preview tab, performing no customer actions. Browser authentication resolved automatically; the live empty-thread state was observed, while customer/profile detail review relied on synthetic test screenshots and source.

The detector was attempted once and exited 1 because its engine 0.1.5 was unavailable and its cache directory could not be created. No deterministic finding counts or clean scan are claimed. Browser automation exposed read-only evaluation, so no overlay injection was performed. No live server or review temp files were created; both tabs were closed. No ignore file existed.

Questions skipped: the user already specified users, constraints, reference and implementation scope, and approved the independent assessments.

## Implementation direction

Mode: Operate. Preserve the plain HTML/CSS/JavaScript application and all existing Phase 2 contracts. Use a calm light workspace: pale navigation, compact list, soft selected rows, readable charcoal type, subtle outgoing-message tint, stable profile tabs and a fixed save footer. Images remain customer content; no decorative imagery or invented business features are added. Test with emulators, inspect desktop and mobile together, then deploy only the existing Firebase Hosting preview channel.

## Finish review

A fresh independent reviewer assessed the final source and seven current captures (1360px desktop Details/Media, 1024px profile overlay, 390px phone Inbox/Conversation/Details/Media). Disposition: **ship**, with no material findings in that evidence. The generic agent role carried the Impeccable finish-review brief because a named shipped reviewer role was not exposed by this harness.

All 53 emulator-backed browser checks passed after correcting a frontend timing issue where a late contact snapshot could erase the Saved confirmation. The reviewer did not independently interact with a browser or inspect the backend. Documents, dialogs, empty/error states and the media viewer were assessed through source rather than dedicated final captures. The unavailable detector supplies no clean-scan evidence. Staff desktop/phone acceptance on the preview remains required before merge or production release.
