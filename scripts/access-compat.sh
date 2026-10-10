#!/usr/bin/env bash
# Staff access has an EXPIRY (audit finding 5): the function claimAccess gives a sign-in a claim that expires, and the security rules (Firestore and
# Storage) refuse a claim without an expiry. The two must stay in step, or everyone is locked out of the screen (second audit, finding 7):
#   * rules that REQUIRE the expiry, and a claimAccess that does NOT give one (an older version put back by a rollback)   = locked out
#   * rules published while the live claimAccess is still the old one                                                    = locked out
# This reads the live state and says whether a step is safe. It changes nothing.
#   ./scripts/access-compat.sh status             what the three parts are right now
#   ./scripts/access-compat.sh allow-code         may the functions code of THIS checkout be deployed? (yes if it gives the expiry; otherwise only while the live rules do not require it)
#   ./scripts/access-compat.sh allow-legacy-code  may an OLDER claimAccess be put back? (only while the live rules do not require the expiry)
#   ./scripts/access-compat.sh allow-rules        may the rules that require the expiry be published? (only if this checkout's code and the LIVE claimAccess give it)
# A step that cannot be proven safe (the live state cannot be read) is refused. ACCESS_COMPAT_FORCE=yes overrides it, for someone who has checked by hand.
# Exit 0 = allowed, 1 = refused.
set -uo pipefail
PROJECT="${PROJECT:-elite-kitchens-lead-os}"
REGION="${REGION:-europe-west1}"
BUCKET="$PROJECT.firebasestorage.app"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
HANDLERS="${ACCESS_HANDLERS_FILE:-$ROOT/functions/lib/handlers.js}"          # the file that decides which claim a sign-in gets
API="${FIREBASERULES_API:-https://firebaserules.googleapis.com/v1}"

# What the code of this checkout gives a sign-in: expiry | legacy (no expiry) | unknown (the file is missing)
code_state() {
  [ -f "$HANDLERS" ] || { echo unknown; return; }
  if grep -q 'staffUntil' "$HANDLERS"; then echo expiry; else echo legacy; fi
}

api_get() {
  local tok; tok=$(gcloud auth print-access-token 2>/dev/null) || return 1
  [ -n "$tok" ] || return 1
  curl -fsS -H "Authorization: Bearer $tok" -H "x-goog-user-project: $PROJECT" "$1" 2>/dev/null          # a user's token must name the project to bill, or some Google APIs refuse it
}
json_field() { node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{const o=JSON.parse(s);console.log(String(o[process.argv[1]]||""))}catch(e){console.log("")}})' "$1"; }
# Does the live ruleset of one release require the expiry? yes | no | unknown
ruleset_requires_expiry() {
  local rel rs src
  rel=$(api_get "$API/projects/$PROJECT/releases/$1") || { echo unknown; return; }
  rs=$(printf '%s' "$rel" | json_field rulesetName); [ -n "$rs" ] || { echo unknown; return; }
  src=$(api_get "$API/$rs") || { echo unknown; return; }
  printf '%s' "$src" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{const f=(JSON.parse(s).source||{}).files||[];console.log(f.length&&f.every((x)=>typeof x.content==="string")?(f.some((x)=>x.content.includes("staffUntil"))?"yes":"no"):"unknown")}catch(e){console.log("unknown")}})'
}
# The live rules: expiry (at least one of Firestore and Storage requires it) | legacy (neither does) | unknown
rules_state() {
  local f s; f=$(ruleset_requires_expiry cloud.firestore); s=$(ruleset_requires_expiry "firebase.storage/$BUCKET")
  if [ "$f" = yes ] || [ "$s" = yes ]; then echo expiry; elif [ "$f" = no ] && [ "$s" = no ]; then echo legacy; else echo unknown; fi
}
# When the code that gives the expiry first existed (the commit that introduced it), and when the LIVE claimAccess was last updated
claim_since() { if [ -n "${ACCESS_CLAIM_SINCE:-}" ]; then echo "$ACCESS_CLAIM_SINCE"; else git -C "$ROOT" log --reverse -S staffUntil --format=%cI -- functions/lib/handlers.js 2>/dev/null | head -n 1; fi; }
live_claim_updated() { gcloud functions describe claimAccess --gen2 --region "$REGION" --project "$PROJECT" --format='value(updateTime)' 2>/dev/null | head -n 1; }
# Live claimAccess: new (updated after the expiry code existed) | old | unknown. Code cannot have been deployed before it was written.
claim_live_state() {
  local since upd; since=$(claim_since); upd=$(live_claim_updated)
  [ -n "$since" ] && [ -n "$upd" ] || { echo unknown; return; }
  node -e 'const a=Date.parse(process.argv[1]),b=Date.parse(process.argv[2]);console.log(isNaN(a)||isNaN(b)?"unknown":(a>=b?"new":"old"))' "$upd" "$since"
}

refuse() {
  echo "REFUSED: $1"; shift
  for l in "$@"; do echo "  $l"; done
  if [ "${ACCESS_COMPAT_FORCE:-}" = yes ]; then echo "ACCESS_COMPAT_FORCE=yes: going on anyway, as you asked."; return 0; fi
  echo "  (If you have checked this by hand: ACCESS_COMPAT_FORCE=yes $0 ... overrides this.)"
  return 1
}
RULES_BACK="./scripts/deploy-quote-sending.sh rules-back"

case "${1:-}" in
  status)
    r=$(rules_state); c=$(code_state); l=$(claim_live_state)
    echo "Security rules (live):   $( [ "$r" = expiry ] && echo 'REQUIRE an expiring staff claim' || { [ "$r" = legacy ] && echo 'do not require an expiry' || echo 'could not be read'; } )"
    echo "Code of this checkout:   $( [ "$c" = expiry ] && echo 'gives staff access an expiry' || { [ "$c" = legacy ] && echo 'gives staff access WITHOUT an expiry (the version before the audit fixes)' || echo 'could not be found'; } )"
    echo "claimAccess (live):      $( [ "$l" = new ] && echo 'updated after the expiry code existed (gives the expiry)' || { [ "$l" = old ] && echo 'older than the expiry code (gives NO expiry)' || echo 'could not be read'; } )"
    if [ "$r" = expiry ] && [ "$l" != new ]; then echo "VERDICT: DANGER: the rules require the expiry but claimAccess may not give it: staff are locked out of the screen. Put the rules back first: $RULES_BACK"
    elif [ "$r" = expiry ]; then echo "VERDICT: in step (rules and claimAccess both use the expiry)."
    elif [ "$r" = legacy ] && [ "$l" = new ]; then echo "VERDICT: safe (the old rules accept both kinds of claim); the rules that need the expiry can be published."
    else echo "VERDICT: not proven (something could not be read)."; fi ;;
  allow-code)
    c=$(code_state)
    [ "$c" = expiry ] && { echo "ok: this code gives staff access an expiry, which both kinds of rules accept."; exit 0; }
    [ "$c" = unknown ] && { refuse "cannot find the code that decides staff access ($HANDLERS)."; exit $?; }
    r=$(rules_state)
    [ "$r" = legacy ] && { echo "ok: this code gives access WITHOUT an expiry, and the live rules do not require one."; exit 0; }
    refuse "this code gives staff access WITHOUT an expiry, and the live security rules $( [ "$r" = expiry ] && echo 'REQUIRE one' || echo 'could not be read' ): everyone would be locked out of the screen." \
      "Put the previous security rules back FIRST: $RULES_BACK, then try again."; exit $? ;;
  allow-legacy-code)
    r=$(rules_state)
    [ "$r" = legacy ] && { echo "ok: the live rules do not require an expiry."; exit 0; }
    refuse "putting an older claimAccess back (it gives staff access WITHOUT an expiry) while the live security rules $( [ "$r" = expiry ] && echo 'REQUIRE one' || echo 'could not be read' ) would lock everyone out of the screen." \
      "Put the previous security rules back FIRST: $RULES_BACK, then try again."; exit $? ;;
  allow-rules)
    c=$(code_state)
    [ "$c" = expiry ] || { refuse "this checkout's code gives staff access WITHOUT an expiry, so rules that require one would lock everyone out." "Switch to the branch with the audit fixes first (git checkout phase-6-1-quote-sending && git pull)."; exit $?; }
    l=$(claim_live_state)
    [ "$l" = new ] && { echo "ok: the live claimAccess gives the expiry."; exit 0; }
    refuse "the live claimAccess $( [ "$l" = old ] && echo 'is older than the code that gives the expiry' || echo 'could not be checked' ): rules that require an expiry would lock everyone out." \
      "Deploy the functions first: ./scripts/deploy-quote-sending.sh older, then try again."; exit $? ;;
  *) sed -n '2,13p' "$0" | sed 's/^# *//'; exit 1 ;;
esac
