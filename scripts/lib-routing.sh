#!/usr/bin/env bash
# Routing checks for the Cloud Run services behind the functions. Source it; the caller sets PROJECT and REGION.
# Found the hard way on 2026-10-11: a restore that FAILED left each service's traffic pinned to a revision that could not start; the service kept serving its
# last good revision (so nothing looked wrong), but no new deploy could take traffic: "Revision ... is not ready and cannot serve traffic. Container import failed".
# docs/PHASE6_1_PLAN.md, "What the real rollout taught".
ROUTING_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# routing_check SERVICE: prints what it finds (PINNED <revision> <percent>% / NOTE ...).
# Returns 0 = a new deploy will be served, 1 = the traffic is pinned, 2 = there is no such service (not deployed yet), 3 = it could not be read.
routing_check() {
  local out rc=0 lines
  out=$(gcloud run services describe "$1" --region "$REGION" --project "$PROJECT" --format=json 2>&1 </dev/null) || rc=$?
  if [ "$rc" != 0 ]; then
    if grep -qiE 'cannot find service|NOT_FOUND|could not be found' <<<"$out"; then return 2; fi
    echo "could not read the routing: $(head -n 1 <<<"$out")"; return 3
  fi
  rc=0; lines=$(printf '%s' "$out" | node "$ROUTING_HERE/routing-check.js") || rc=$?
  [ -z "$lines" ] || echo "$lines"
  if [ "$rc" = 0 ]; then return 0; elif [ "$rc" = 1 ]; then return 1; else return 3; fi
}

# routing_reset SERVICE: send the service's traffic back to its NEWEST revision (it changes only the routing, never code), then check that it worked.
routing_reset() {
  gcloud run services update-traffic "$1" --to-latest --region "$REGION" --project "$PROJECT" --quiet </dev/null >/dev/null 2>&1 || return 1
  routing_check "$1" >/dev/null
}

# revision_ready REVISION: succeeds only if Cloud Run says the revision is Ready (its files still exist and it can serve). Anything else, including not being able to read it, is "no".
revision_ready() {
  local out
  out=$(gcloud run revisions describe "$1" --region "$REGION" --project "$PROJECT" --format=json 2>/dev/null </dev/null) || return 1
  printf '%s' "$out" | node "$ROUTING_HERE/routing-check.js" --revision-ready >/dev/null
}
