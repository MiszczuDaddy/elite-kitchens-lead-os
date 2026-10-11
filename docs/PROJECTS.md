# Phase 7: Projects

A simple way to see where each customer's kitchen job stands, and whether everything has been ordered. **Built and tested on branch `phase-7-projects`; not merged, not deployed** (each needs the owner's approval).

**Not in scope, on purpose:** manufacturing tracking, stock, whether doors or carcasses have *arrived*, supplier integrations, anything like project management. Only the approved 3D render is attached.

## What it does
1. **A project is made when a quote is marked Accepted.** Linked to the customer and the quote, in the same database transaction as the accept (both happen or neither does). A quote can never have two projects.
2. **A project can be made by hand** from the customer's profile ("New project"), optionally linked to one of their accepted quotes that has no project yet.
3. **Projects dashboard** (left bar > Projects): active projects sorted by installation date, a one-line status, a five-segment progress bar, and amber flags **Carcasses to order** / **Doors to order**. Two tiles at the top count them and are filters (press again to go back); other filters: Active, Ready for installation, Completed; search by name, quote number or phone.
4. **One project:** customer details (live from the customer record), the linked quote, the checklist, expected installation date, notes, the approved 3D render.
5. **Checklist** (five boxes): Final 3D design approved, Carcasses ordered, Doors ordered, Ready for installation, Installation completed. **All five are independent**: any box can be ticked or cleared at any time, in any order. Each tick records who and when.
6. **Mark project completed** (warns if boxes are not ticked; can be undone with "Reopen project"). A completed project leaves the active list and waits for nothing. A completed project cannot be changed until it is reopened.
7. **Delete project**: always possible, whatever is in it (ticked steps, date, notes, a render, even when completed). The confirmation says exactly what will be erased; the quote and the customer are never touched; the render file is erased from storage with the record. It cannot be undone. (Until 2026-10-11 deleting was only allowed for a project with nothing ticked and no render; the owner asked for it to be always possible.)

## Data: `projects/{id}`
| Field | Meaning |
|---|---|
| `id` | `p_` + the 24 hex of the quote's own id (one project per quote, by construction); `m_` + a hash of the request for a project with no quote |
| `phone`, `customerName` | the customer (details shown on screen are read live; the name is a copy for the list) |
| `quoteId`, `quoteRef`, `quoteOption`, `quoteStatus` | the accepted quote, its number, the accepted option (name and amount at the time), and `accepted` / `reopened` |
| `status` | `active` or `completed` (`completedAt`, `completedBy`) |
| `steps.<name>` | `{ done, at, by }` for the five steps |
| `installDate` | `YYYY-MM-DD` or none |
| `notes` | up to 2,000 characters |
| `render` | `{ path, filename, mime, size, sha256, at, by }` |
| `rev` | counts only saves of the date and notes (so ticking boxes never makes two people clash); `history` keeps the last 60 changes |

No rule or index changes: staff read through the existing rule, nothing can be written from a browser. Render files live under `projects/<phone>/<project>/`, closed to browsers.

## Quotes and projects
* **Accept** makes the project (or, if one exists, only refreshes its link: the steps, date, notes, render and "completed" are never reset).
* **Reopening an accepted quote** keeps the project and shows "The quote was reopened after it was accepted. Check that the job is still going ahead." Nothing is deleted behind anyone's back; accepting again clears the note.
* **Quotes accepted before Phase 7** have no project. Make them by hand (customer profile > New project > choose the accepted quote). There is no automatic backfill.
* Erasing a customer erases their projects and renders (`docs/DATA_CONTROLS.md`).

## Backend (`functions/lib/projects.js`)
Seven staff-only callables: `createProject`, `saveProject` (date and notes, against a revision), `setProjectStep`, `completeProject` (also reopens), `removeProject`, `attachProjectRender`, `projectRenderUrl`. `acceptQuote` and `reopenQuote` gained a project write inside their own transactions; `deleteCustomer` gained the erasure. The render is dropped by the browser in its own `uploads/` folder, then checked by its real content (JPG, PNG, WebP or PDF by its first bytes), size (25 MB) and owner, and moved; a refused file is deleted. See `docs/SECURITY.md`.

## Screen (`public/projects.js`, `public/project-model.js`)
The model (steps, "waiting for", status, filters, counts, order, search) is pure and unit-tested; the screen draws it. The project page is built once and updated in place by the live data, so ticking a box, typing, or keyboard focus are never lost; typing is never overwritten by someone else's save, and a save is checked against the revision the form was loaded from (a clash is explained, with "Load the latest"). On phones there is a "Projects" link under the caption (a sixth header button would squeeze the title).

## Tests
* `functions/test/projects.test.js` (17, emulators): who may call, accept makes exactly one project and is atomic, two accepts at once, reopen and accept again, manual creation, independent steps (also five ticks at once), date and notes, completed, remove, render checks, render link, erasure, security rules. **20 planted errors (5 on the delete), all caught.**
* `functions/test/project-model.test.js` (7, no emulator). **9 planted errors, all caught.**
* `test-ui/projects.e2e.js` (13, `bash test-ui/run.sh projects.e2e.js`): accepting in the real screen, the dashboard and its filters, the checklist, date/notes and a clash, the render, completing, deleting (also with work and a render in it), manual creation, the reopened-quote flag, the phone layout. A planted bug (save against the live revision) is caught.
* Existing suites that share the screen still pass: backend `quotes`, `customers`, `audit`; browser `ui`, `appointments`, `quotes`, `readability`, `pwa`. (`appointments.e2e.js` now expects Projects to have left the "Coming later" list.)
* Not run: the full backend and browser regression of the whole branch.

## Release
Deploy order (each step needs the owner's approval), from Cloud Shell on `main` after the merge:
1. `./scripts/deploy-quote-sending.sh projects`: the backend. Checks the settings file against the live functions, the functions' own access and that no function's traffic is pinned; asks for "yes"; deploys `acceptQuote`, `reopenQuote`, `deleteCustomer` and the seven new functions (made public like the quote ones); then checks that each answers and refuses a request without sign-in. The live screen is unchanged and keeps working.
2. `./scripts/deploy-quote-sending.sh live`: Hosting only (refuses unless step 1 is done). Reload Elite OS.

Undo: Hosting rollback for the screen (Firebase console > Hosting > Release history > Rollback). For the functions, redeploy the previous code from git (`git checkout phase-6-2-pwa-complete -- functions`, then `firebase deploy --only functions:acceptQuote,functions:reopenQuote,functions:deleteCustomer`); revision rollback does not work (`docs/PHASE6_1_PLAN.md`). The seven new functions are harmless without the screen. Projects already created stay in the database.
