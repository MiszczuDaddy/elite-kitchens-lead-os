#!/usr/bin/env bash
# Phase 5 (appointments + one-way Google Calendar sync) deploy helper. Run from Cloud Shell, one stage at a time, in the order of
# docs/APPOINTMENTS.md "Rollout". Needs the one-time setup first (./scripts/setup-calendar.sh, both calendars created and shared).
#   ./scripts/deploy-appointments.sh backend               the 4 appointment functions, the private calendarSweep, and the two existing
#                                                          functions Phase 5 extended (deleteCustomer, setConversationStatus). Google
#                                                          Calendar sync stays OFF. The live screen is unaffected: it does not use them.
#   ./scripts/deploy-appointments.sh preview               the new screen on Hosting PREVIEW channel phase5 (live data; production untouched)
#   ./scripts/deploy-appointments.sh sync on <calendarId>  Google Calendar sync ON for that calendar (the TEST calendar first, then the real one)
#   ./scripts/deploy-appointments.sh sync off              the kill switch: Elite OS stops writing to Google; appointments keep working
#   ./scripts/deploy-appointments.sh live                  the new screen on production Hosting. ONLY after the owner approved the preview.
# Every functions stage first saves the revisions it replaces, so ./scripts/rollback-appointments.sh can undo it in seconds.
# Never deploys the webhook, leadIntake or any other function, and never touches rules, indexes, secrets, Make or Meta.
set -euo pipefail
PROJECT=elite-kitchens-lead-os
REGION=europe-west1
RUNTIME_SA="812360112616-compute@developer.gserviceaccount.com"
CAL_SA="ek-calendar@$PROJECT.iam.gserviceaccount.com"
ENVF="functions/.env.$PROJECT"
SAVED="$HOME/.previous-revisions-phase5"                # the last Phase 5 functions deploy (rollback-appointments.sh)
BEFORE="$HOME/.previous-revisions-before-phase5"        # written once, by the first backend deploy (rollback-appointments.sh --before-phase5)
CALLABLES="createAppointment updateAppointment cancelAppointment retryCalendarSync"
CALENDAR_FUNCS="$CALLABLES calendarSweep deleteCustomer"           # every function that reads the GCAL_* settings
BACKEND_FUNCS="$CALENDAR_FUNCS setConversationStatus"
cd "$(dirname "$0")/.."

usage() { sed -n '4,10p' "$0" | sed 's/^# *//'; exit 1; }
svc() { echo "$1" | tr '[:upper:]' '[:lower:]'; }                  # a function's Cloud Run service name
has() { grep -qE "^$2=" "$1"; }
value() { { grep -E "^$2=" "$1" || true; } | tail -n 1 | cut -d= -f2- | tr -d '\r'; }
put() {                                                            # set KEY=VALUE in a settings file (replace the line, or append it)
  if has "$1" "$2"; then sed -i "s|^$2=.*|$2=$3|" "$1"; else { [ -z "$(tail -c 1 "$1")" ] || echo; echo "$2=$3"; } >> "$1"; fi
}
show_settings() { for k in GCAL_SYNC GCAL_CALENDAR_ID GCAL_SERVICE_ACCOUNT; do echo "   $k=$(value "$1" "$k")"; done; }
confirm() { read -r -p "$1 Type yes: " a; [ "$a" = "yes" ] || { echo "Cancelled. Nothing was deployed."; exit 1; }; }
need_settings() { [ -f "$ENVF" ] || { echo "Missing $ENVF (the settings file with ALLOWED_EMAILS and WHATSAPP_PHONE_NUMBER_ID)."; exit 1; }; }
need_setup() { bash scripts/setup-calendar.sh --check || { echo "Finish the one-time setup first: ./scripts/setup-calendar.sh"; exit 1; }; }
install() { npm --prefix functions install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm --prefix functions install --omit=dev; }
deploy_functions() { local only=""; for f in "$@"; do only="${only:+$only,}functions:$f"; done; firebase deploy --project "$PROJECT" --only "$only"; }

# The revision live traffic goes to now (after a rollback that is not the newest one), or nothing when the function is not deployed.
serving_revision() {
  { gcloud run services describe "$1" --region "$REGION" --project "$PROJECT" --format=json 2>/dev/null || true; } | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      if (!s.trim()) return;
      const t = ((JSON.parse(s).status || {}).traffic || []).filter((x) => x.revisionName).sort((a, b) => (b.percent || 0) - (a.percent || 0));
      if (t[0]) console.log(t[0].revisionName);
    });'
}
save_revisions() {
  : > "$SAVED"
  for f in "$@"; do
    local rev; rev=$(serving_revision "$(svc "$f")")
    if [ -n "$rev" ]; then echo "$(svc "$f")=$rev" >> "$SAVED"; echo "   saved $f -> $rev"; else echo "   $f: not deployed yet (nothing to save)"; fi
  done
}
backend_deployed() { [ -n "$(serving_revision createappointment)" ]; }

check_sweeper() {
  echo "==> checking that the sweeper is private and that Cloud Scheduler can run it"
  local policy job since
  policy=$(gcloud run services get-iam-policy calendarsweep --region "$REGION" --project "$PROJECT" --format=json)
  if grep -qE '"allUsers"|"allAuthenticatedUsers"' <<<"$policy"; then
    for m in allUsers allAuthenticatedUsers; do
      gcloud run services remove-iam-policy-binding calendarsweep --region "$REGION" --project "$PROJECT" --member="$m" --role=roles/run.invoker --quiet >/dev/null 2>&1 || true
    done
    echo "   it was reachable from the internet: that access was removed"
  else echo "   private: ok"; fi
  if ! grep -q "serviceAccount:$RUNTIME_SA" <<<"$policy"; then
    gcloud run services add-iam-policy-binding calendarsweep --region "$REGION" --project "$PROJECT" --member="serviceAccount:$RUNTIME_SA" \
      --role=roles/run.invoker --quiet >/dev/null && echo "   allowed the scheduler's identity to call it"
  fi
  job=$(gcloud scheduler jobs list --location "$REGION" --project "$PROJECT" --format='value(name)' 2>/dev/null | grep -i calendarsweep | head -n 1 || true)
  job=${job##*/}
  if [ -z "$job" ]; then echo "   WARNING: no Cloud Scheduler job found for calendarSweep in $REGION. Look in the console under Cloud Scheduler."; return; fi
  echo "   scheduler job $job: $(gcloud scheduler jobs describe "$job" --location "$REGION" --project "$PROJECT" --format='value(state,schedule,timeZone)' | tr '\t' ' ')"
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gcloud scheduler jobs run "$job" --location "$REGION" --project "$PROJECT" >/dev/null
  for _ in $(seq 1 12); do
    sleep 10
    if [ -n "$(gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"calendarsweep\" AND timestamp>=\"$since\" AND (jsonPayload.msg=\"calendar sweep\" OR textPayload:\"calendar sweep\")" \
        --project "$PROJECT" --limit=1 --format='value(timestamp)' 2>/dev/null)" ]; then
      echo "   test run: the sweeper ran (ok)"; return
    fi
  done
  echo "   WARNING: no sweeper run was logged within 2 minutes. See what the scheduler got back with:"
  echo "     gcloud scheduler jobs describe $job --location $REGION --project $PROJECT --format='value(status,lastAttemptTime)'"
  echo "   (code 7 or 16 means Cloud Scheduler may not call it: docs/APPOINTMENTS.md, Troubleshooting)"
}

echo "Deploying from $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)"
git diff --quiet HEAD -- functions public firebase.json ':!functions/package-lock.json' || echo "WARNING: this checkout has local changes in functions/, public/ or firebase.json."

case "${1:-}" in
  backend)
    need_settings; need_setup
    tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT; cp "$ENVF" "$tmp"
    # The calendar settings must be in the file, or firebase stops to ask for them. A first deploy keeps sync off.
    has "$tmp" GCAL_SYNC || put "$tmp" GCAL_SYNC off
    has "$tmp" GCAL_CALENDAR_ID || put "$tmp" GCAL_CALENDAR_ID ""
    [ -n "$(value "$tmp" GCAL_SERVICE_ACCOUNT)" ] || put "$tmp" GCAL_SERVICE_ACCOUNT "$CAL_SA"
    echo "Calendar settings for this deploy:"; show_settings "$tmp"
    [ "$(value "$tmp" GCAL_SYNC)" = "on" ] && echo "   (sync is ON: it stays on with this calendar)"
    echo "Functions: $BACKEND_FUNCS"
    confirm "Deploy the Phase 5 backend to the LIVE project?"
    cp "$tmp" "$ENVF"
    install
    echo "==> saving the revisions this replaces"
    save_revisions $BACKEND_FUNCS
    [ -s "$BEFORE" ] || cp "$SAVED" "$BEFORE"
    deploy_functions $BACKEND_FUNCS
    echo "==> making the 4 appointment functions reachable (each checks the signed-in staff account itself)"
    for f in $CALLABLES; do
      gcloud run services add-iam-policy-binding "$(svc "$f")" --region "$REGION" --project "$PROJECT" \
        --member=allUsers --role=roles/run.invoker --quiet >/dev/null && echo "   public: $f"
    done
    check_sweeper
    echo "Done. Undo in seconds with: ./scripts/rollback-appointments.sh"
    ;;
  preview)
    backend_deployed || { echo "Deploy the backend first: $0 backend"; exit 1; }
    firebase hosting:channel:deploy phase5 --expires 30d --project "$PROJECT"
    echo "The preview uses LIVE data: appointments booked there are real, move New leads to Booked, and go to Google when sync is on."
    ;;
  sync)
    need_settings
    tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT; cp "$ENVF" "$tmp"
    case "${2:-}" in
      on)
        id="${3:-}"
        [[ "$id" =~ ^[A-Za-z0-9._-]+@group\.calendar\.google\.com$ ]] || {
          echo "usage: $0 sync on <calendar id>   (Google Calendar > the calendar's Settings > Integrate calendar; it ends in @group.calendar.google.com)"; exit 1; }
        need_setup
        put "$tmp" GCAL_SERVICE_ACCOUNT "$CAL_SA"; put "$tmp" GCAL_CALENDAR_ID "$id"; put "$tmp" GCAL_SYNC on
        echo "The calendar must already be shared with $CAL_SA (Make changes to events)."
        echo "Appointments already sent to another calendar stay there; new ones go to this one."
        ;;
      off) put "$tmp" GCAL_SYNC off ;;
      *) usage ;;
    esac
    echo "Calendar settings after this deploy:"; show_settings "$tmp"
    echo "Functions: $CALENDAR_FUNCS"
    confirm "Deploy these calendar settings to the LIVE project?"
    cp "$tmp" "$ENVF"
    install
    echo "==> saving the revisions this replaces"
    save_revisions $CALENDAR_FUNCS
    deploy_functions $CALENDAR_FUNCS
    if [ "$2" = "on" ]; then echo "Done. A new booking should show \"In Google Calendar\" within seconds. Undo: ./scripts/rollback-appointments.sh"
    else echo "Done. Elite OS no longer writes to Google Calendar; new and changed appointments show \"Calendar sync off\"."; fi
    ;;
  live)
    [ -d public/theme-lab ] && { echo "Refusing to publish to production: the temporary test folder public/theme-lab is still there. Remove it first."; exit 1; }
    backend_deployed || { echo "Deploy the backend first: $0 backend"; exit 1; }
    need_settings
    echo "Calendar settings in $ENVF (the functions use what was last deployed):"; show_settings "$ENVF"
    confirm "Publish the Phase 5 screen to PRODUCTION Hosting?"
    firebase deploy --project "$PROJECT" --only hosting
    ;;
  *) usage ;;
esac
