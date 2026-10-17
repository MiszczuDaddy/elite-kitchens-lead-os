# Backups and recovery (Phase 10)

How Elite OS's data is protected, how to prove that the protection works, and what to do when something has been lost.

- Everything below runs from **Cloud Shell**, in the `~/elite-kitchens-lead-os` folder, as the project owner.
- Every step asks before it changes anything.
- Nothing here ever deletes live data.

> This document covers **data**. Going back to older **code** is covered in `docs/RESTORE.md`.

## 1. What is protected

| What | Protection | How far back |
|---|---|---|
| The customer database: customers, chats, messages, quotes, visits, projects, settings, the Knowledge Centre | **Daily backup** | 14 days (one copy per day) |
| The same database | **Point-in-time recovery**: read it exactly as it was at any minute | 7 days |
| Photos, voice notes, PDFs and renders (Cloud Storage) | **Soft delete**: a deleted file can be brought back | 7 days |
| Code, security rules, documents | Git (GitHub) | All history |

**Not covered here:**
- **The secrets** (Secret Manager): they are kept by Google, outside the database.
- **The settings file** `functions/.env.elite-kitchens-lead-os`, which lives only in Cloud Shell. Keep a copy of it in a safe place.
- **Make, Meta and the Google calendar:** the calendar is rebuilt from Elite OS.
- **Emails in the Gmail "Sent" folder.**

## 2. Switch it on, and check it

```bash
./scripts/setup-backups.sh status
```

Read-only. It shows:
- whether point-in-time recovery and the daily backups are on;
- the newest backup;
- whether deleted files can be brought back.

```bash
./scripts/setup-backups.sh on
```

This switches on all three protections. It asks you to type `yes`. It is safe to run again: whatever is already on is left alone.

**Cost:** well under €2 a month at today's size. Google charges for the space the backups use. (See `docs/PHASE10_SAFETY_NET.md`, "Costs".)

## 3. Prove that a backup can be restored (the restore test)

```bash
./scripts/setup-backups.sh drill
```

1. It takes the **newest finished backup**.
2. It restores it into a **new, separate database** called `restore-test-<date>`. **The live database is never touched.**
3. It waits for Google to finish (usually a few minutes).
4. It runs `scripts/backup-check.js`, which:
   - counts the records in the copy and in the live database, collection by collection;
   - opens a few restored customers and checks they are complete;
   - records the result.

   Elite OS then shows **"Backups: last restore test <date>: OK"** under **Needs attention → System checks**.
5. It asks whether to delete the temporary copy.
   - Say `yes` unless you need to bring something back from it (section 4).
   - The copy holds customer data and costs storage while it is kept.

**When to run it:**
- once, the day after switching backups on;
- after that, every three months. The Needs attention list says so when the last test is over four months old.

**What the counts mean:**
- The live database has whatever was added since the backup was taken, and lacks whatever was deleted since. So the numbers are close, not identical.
- The test fails if the copy is empty, has fewer than half the customers, or the restored customers are incomplete. If it fails, **do not rely on the backups; report it.**

## 4. Bringing data back

All recoveries use `scripts/restore-docs.js`. It works the same way every time:

- **It shows first.** Without `--apply` it only lists what it would bring back. Nothing is changed.
- **It adds only what is missing.** With `--apply` it writes only the records that are **missing** from the live database. A deleted customer comes back, and nothing that exists now is changed.
- **It can put old versions back.** `--overwrite` also replaces records that exist now with their old version. It asks again first.
- **It never deletes anything.**
- **It knows a customer's whole record.** `--customer <number>` brings back:
  - their chat and every message;
  - their customer record;
  - their visits;
  - their quotes, with every version and send record;
  - their projects.

  Visits that come back are put back into the shared Google calendar by the 5-minute calendar check.

### A. Something was deleted or changed in the last 7 days (point-in-time recovery)

Pick a minute **before** the mistake. Times are in UTC: in summer, Irish time minus one hour.

```bash
node scripts/restore-docs.js --read-time 2026-10-18T09:30:00Z --customer 353871234567
node scripts/restore-docs.js --read-time 2026-10-18T09:30:00Z --customer 353871234567 --apply
```

The same works for one document, for example Quote Settings changed by mistake:

```bash
node scripts/restore-docs.js --read-time 2026-10-18T09:30:00Z --doc quoteSettings/current --apply --overwrite
```

The Knowledge Centre also has its own history: "Roll back" in the Knowledge Centre is easier.

### B. It happened 8 to 14 days ago (a daily backup)

1. Run `./scripts/setup-backups.sh status` to see which backups exist.
2. Run the restore test, `./scripts/setup-backups.sh drill`, and answer **`no`** when it asks to delete the copy. (To restore an **older** backup than the newest, use the commands in section 5.)
3. Bring back what is needed from that copy:

```bash
node scripts/restore-docs.js --from-database restore-test-20261018-0930 --customer 353871234567
node scripts/restore-docs.js --from-database restore-test-20261018-0930 --customer 353871234567 --apply
```

4. Delete the copy:

```bash
gcloud firestore databases delete --database=restore-test-20261018-0930 --project elite-kitchens-lead-os
```

### C. Photos, PDFs or renders deleted in the last 7 days

Files are kept under:
- `media/<number>/` for chat photos and files;
- `quotes/<number>/` for quote PDFs;
- `projects/<number>/` for renders.

**See what was deleted:**

```bash
gcloud storage ls "gs://elite-kitchens-lead-os.firebasestorage.app/media/353871234567/**" --soft-deleted
```

**Bring them back:**

```bash
gcloud storage restore "gs://elite-kitchens-lead-os.firebasestorage.app/media/353871234567/**" --async
```

Do the same for `quotes/…` and `projects/…`. Restore the files first, then the records (A or B), so that the chat's links work again.

### D. The whole database is lost or damaged (very unlikely)

Google restores a backup only into a **new** database, never over the live one.

The way back is:
1. restore the newest backup into a new database (as in B, step 2);
2. copy it over the live database with Google's own export and import. **This overwrites records with the same name and keeps everything else.**

```bash
gcloud firestore export gs://elite-kitchens-lead-os.firebasestorage.app/restore-export --database=restore-test-20261018-0930 --project elite-kitchens-lead-os
gcloud firestore import gs://elite-kitchens-lead-os.firebasestorage.app/restore-export/<the folder the export printed> --database='(default)' --project elite-kitchens-lead-os
```

Before you do this, switch the automatic receptionist off (Assistant → Settings) so nothing is answered from half-restored chats.

This is a big step. Ask for help before running it.

## 5. Reference: the underlying Google commands

```bash
gcloud firestore databases describe --database='(default)' --project elite-kitchens-lead-os
gcloud firestore backups schedules list --database='(default)' --project elite-kitchens-lead-os
gcloud firestore backups list --project elite-kitchens-lead-os
gcloud firestore databases restore --source-backup=projects/elite-kitchens-lead-os/locations/europe-west1/backups/<id> --destination-database=restore-test-<date> --project elite-kitchens-lead-os
gcloud firestore operations list --database=restore-test-<date> --project elite-kitchens-lead-os
```

**To switch the protection off again:**

```bash
gcloud firestore backups schedules delete <schedule> --database='(default)' --project elite-kitchens-lead-os
gcloud firestore databases update --database='(default)' --no-enable-pitr --project elite-kitchens-lead-os
```

Switching it off deletes no live data.

## 6. Privacy

**Backups contain customer data.** They are kept inside the same Google project, under the same access, and are deleted by Google after 14 days.

**"Delete customer" cannot reach into a backup that already exists.** A deleted customer disappears completely from:
- point-in-time recovery after 7 days;
- the backups after 14 days.

Deleted files are also kept for 7 days by soft delete.

Mention these periods in your privacy notice, for example: "backups are kept for up to 14 days".

## 7. Tests

`functions/test/safety-backups.test.js` checks the following.

**The restore tools,** against the database emulator (a second, named database plays the restored copy):
- bringing back one customer completely, with a dry run first;
- only missing records by default;
- `--overwrite`;
- nothing ever deleted;
- strict options;
- a point in time read inside a read-only transaction, rounded to the minute.

**The restore check:**
- the counts, the customers it opens, and failure cases;
- a result recorded with no customer data.

**`setup-backups.sh`,** against a pretend `gcloud` that records every command:
- `status` changes nothing;
- `on` changes nothing without `yes`, and exactly three settings with `yes`;
- `drill` restores the newest **finished** backup of the live database into a **new** database, checks it, and deletes only that copy, only after `yes`.

**Not tested by a machine:** a real restore in Google Cloud. That is exactly what `drill` is for. Run it once after switching backups on.
