#!/usr/bin/env bash
# Phase 10 (docs/BACKUPS.md): automatic backups of the customer database, and a restore test that proves they work. Run from Cloud Shell, as the project owner.
#   ./scripts/setup-backups.sh status   read-only: point-in-time recovery, the daily backup schedule, the newest backup, and the files' soft delete. Changes nothing.
#   ./scripts/setup-backups.sh on       switch on: a DAILY backup kept 14 days, 7-day point-in-time recovery, and 7-day soft delete for photos, PDFs and renders.
#                                       Asks for "yes". Costs: well under EUR 2 a month at today's size (docs/PHASE10_SAFETY_NET.md, "Costs").
#   ./scripts/setup-backups.sh drill    THE RESTORE TEST: restores the newest backup into a NEW, SEPARATE database (the live one is never touched), checks it with
#                                       scripts/backup-check.js (counts and a few customers opened), records the result in Elite OS, then offers to delete the copy.
#                                       Asks for "yes" before restoring and before deleting. A restore costs a few cents.
# Never deletes or changes live data. Never changes the live database other than switching point-in-time recovery on.
set -euo pipefail
PROJECT=elite-kitchens-lead-os
DB='(default)'
BUCKET="$PROJECT.firebasestorage.app"
RETENTION=14d
SOFT_DELETE=7d
WAIT_SECONDS="${WAIT_SECONDS:-1800}"          # how long the drill waits for Google to finish the restore
POLL_SECONDS="${POLL_SECONDS:-20}"
# (tests only: BACKUP_CHECK_CMD replaces the checker, so the script can be run against a pretend gcloud with no database)
cd "$(dirname "$0")/.."

confirm() { read -r -p "$1 Type yes: " a; [ "$a" = "yes" ] || { echo "Cancelled. Nothing was changed."; exit 1; }; }
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
# json FILE EXPRESSION: print what the JavaScript expression (over the parsed file, as `j`) gives
json() { node -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8") || "null"); const v = (new Function("j", "return (" + process.argv[2] + ")"))(j); if (v !== undefined && v !== null) console.log(v);' "$1" "$2"; }

read_state() {
  gcloud firestore databases describe --database="$DB" --project "$PROJECT" --format=json > "$tmp"
  LOCATION=$(json "$tmp" 'j.locationId'); PITR=$(json "$tmp" 'j.pointInTimeRecoveryEnablement || "POINT_IN_TIME_RECOVERY_DISABLED"')
  EARLIEST=$(json "$tmp" 'j.earliestVersionTime || ""')
  gcloud firestore backups schedules list --database="$DB" --project "$PROJECT" --format=json > "$tmp"
  DAILY=$(json "$tmp" '(j || []).filter((s) => s.dailyRecurrence !== undefined).map((s) => Math.round(parseInt(s.retention, 10) / 86400) + " days").join(" ")')
  WEEKLY=$(json "$tmp" '(j || []).filter((s) => s.weeklyRecurrence !== undefined).map((s) => Math.round(parseInt(s.retention, 10) / 86400) + " days").join(" ")')
  gcloud firestore backups list --project "$PROJECT" --format=json > "$tmp"
  NEWEST=$(json "$tmp" '(j || []).filter((b) => /\/databases\/\(default\)$/.test(b.database || "") && b.state === "READY").sort((a, b) => String(b.snapshotTime).localeCompare(String(a.snapshotTime))).map((b) => b.name + " " + b.snapshotTime)[0] || ""')
  BACKUPS=$(json "$tmp" '(j || []).filter((b) => /\/databases\/\(default\)$/.test(b.database || "") && b.state === "READY").length')
  gcloud storage buckets describe "gs://$BUCKET" --format=json > "$tmp"
  SOFT=$(json "$tmp" 'Number(((j.soft_delete_policy || j.softDeletePolicy || {}).retentionDurationSeconds) || 0)')
}
show_state() {
  echo "==> the customer database ($LOCATION)"
  if [ "$PITR" = POINT_IN_TIME_RECOVERY_ENABLED ]; then echo "   point-in-time recovery: ON (any minute back to ${EARLIEST:-7 days ago})"; else echo "   point-in-time recovery: OFF"; fi
  echo "   daily backups: ${DAILY:+ON, each kept $DAILY}${DAILY:-OFF}${WEEKLY:+ (also weekly, kept $WEEKLY)}"
  if [ -n "$NEWEST" ]; then echo "   newest backup: ${NEWEST#* } ($BACKUPS kept)"; else echo "   newest backup: none yet"; fi
  echo "==> photos, PDFs and renders (Cloud Storage gs://$BUCKET)"
  if [ "${SOFT:-0}" -gt 0 ]; then echo "   deleted files can be brought back for $((SOFT / 86400)) days (soft delete)"; else echo "   soft delete: OFF (a deleted file is gone at once)"; fi
}

case "${1:-}" in
  status)
    read_state; show_state
    echo "Nothing was changed. The database's size is in the Firebase console > Firestore > Usage."
    ;;
  on)
    read_state; show_state
    echo
    echo "This switches on, for the LIVE project: a daily backup of the customer database kept $RETENTION, point-in-time recovery (7 days), and $SOFT_DELETE soft delete for files."
    echo "No data is changed, deleted or moved. Expected cost: well under EUR 2 a month at today's size."
    confirm "Switch the backups on?"
    if [ -z "$DAILY" ]; then gcloud firestore backups schedules create --database="$DB" --recurrence=daily --retention="$RETENTION" --project "$PROJECT"; else echo "   daily backups: already on"; fi
    if [ "$PITR" != POINT_IN_TIME_RECOVERY_ENABLED ]; then gcloud firestore databases update --database="$DB" --enable-pitr --project "$PROJECT"; else echo "   point-in-time recovery: already on"; fi
    if [ "${SOFT:-0}" -lt 604800 ]; then gcloud storage buckets update "gs://$BUCKET" --soft-delete-duration="$SOFT_DELETE"; else echo "   soft delete: already on"; fi
    echo; read_state; show_state
    echo "Done. The first daily backup appears within a day: then run   $0 drill   to prove it can be restored."
    ;;
  drill)
    read_state
    [ -n "$NEWEST" ] || { echo "There is no finished backup yet. Run   $0 on   and wait for the first daily backup (up to a day). Nothing was changed."; exit 1; }
    name="${NEWEST%% *}"; snap="${NEWEST#* }"
    id="restore-test-$(date -u +%Y%m%d-%H%M)"
    echo "The newest backup was taken at $snap."
    echo "This restores it into a NEW, SEPARATE database called $id. The live database is not touched. It takes a few minutes and costs a few cents."
    confirm "Restore the backup into $id?"
    gcloud firestore databases restore --source-backup="$name" --destination-database="$id" --project "$PROJECT" --format=json > /dev/null
    echo "==> waiting for Google to finish the restore (up to $((WAIT_SECONDS / 60)) minutes)"
    waited=0
    while :; do
      gcloud firestore operations list --database="$id" --project "$PROJECT" --format=json > "$tmp" 2>/dev/null || echo '[]' > "$tmp"
      state=$(json "$tmp" '(j || []).some((o) => o.done === true && !o.error) ? "done" : (j || []).some((o) => o.done === true && o.error) ? "failed" : "running"')
      [ "$state" = done ] && break
      [ "$state" = failed ] && { echo "Google reported that the restore FAILED. The live database is untouched. Report this. The empty copy can be deleted with: gcloud firestore databases delete --database=$id --project $PROJECT"; exit 1; }
      [ "$waited" -ge "$WAIT_SECONDS" ] && { echo "The restore is still running after $((WAIT_SECONDS / 60)) minutes. Run later: node scripts/backup-check.js --database $id --backup-time $snap --record"; exit 1; }
      sleep "$POLL_SECONDS"; waited=$((waited + POLL_SECONDS))
    done
    echo "==> checking the restored copy"
    rc=0; ${BACKUP_CHECK_CMD:-node scripts/backup-check.js} --database "$id" --backup-time "$snap" --record || rc=$?
    echo
    read -r -p "Delete the temporary copy $id now? (it holds customer data and costs storage while it is kept) Type yes: " a
    if [ "$a" = yes ]; then gcloud firestore databases delete --database="$id" --project "$PROJECT" --quiet; echo "   deleted $id"
    else echo "   kept. To bring records back from it: node scripts/restore-docs.js --from-database $id ...   Delete it afterwards: gcloud firestore databases delete --database=$id --project $PROJECT"; fi
    [ "$rc" = 0 ] && echo "RESTORE TEST PASSED." || { echo "RESTORE TEST FAILED: see the result above and report it."; exit 1; }
    ;;
  *)
    sed -n '2,10p' "$0" | sed 's/^# *//'; exit 1 ;;
esac
