#!/bin/sh
# End-to-end check: invites, registration, login, per-user isolation, CLI.
set -eu
cd "$(dirname "$0")/.."
export DATA_DIR="$(mktemp -d)" PORT="${PORT:-3997}"
B="http://127.0.0.1:$PORT"; J='Content-Type: application/json'
node server.js >/dev/null & PID=$!
trap 'kill $PID 2>/dev/null; rm -rf "$DATA_DIR"' EXIT
sleep 1
fail() { echo "FAIL: $*"; exit 1; }
check() { [ "$1" = "$2" ] || fail "$3 (got $1, want $2)"; echo "ok  $3"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

check "$(code "$B/")" 302 "unauthenticated / redirects to login"
check "$(code "$B/api/state")" 401 "unauthenticated state is rejected"
check "$(code -X POST -H "$J" -d '{"invite":"NOPE1234","username":"x1","password":"secret1"}' "$B/api/register")" 400 "register without valid invite fails"

I1=$(node cli.js invite "anna" | awk '/^Invite code/{print $3}')
I2=$(node cli.js invite "bela" | awk '/^Invite code/{print $3}')
check "$(code -c "$DATA_DIR/ca" -X POST -H "$J" -d "{\"invite\":\"$I1\",\"username\":\"Anna\",\"password\":\"secret1\"}" "$B/api/register")" 200 "register anna with invite"
check "$(code -X POST -H "$J" -d "{\"invite\":\"$I1\",\"username\":\"eve\",\"password\":\"secret1\"}" "$B/api/register")" 400 "invite cannot be reused"
check "$(code -X POST -H "$J" -d "{\"invite\":\"$I2\",\"username\":\"anna\",\"password\":\"secret1\"}" "$B/api/register")" 409 "duplicate username rejected"
check "$(code -c "$DATA_DIR/cb" -X POST -H "$J" -d "{\"invite\":\"$I2\",\"username\":\"bela\",\"password\":\"secret2\"}" "$B/api/register")" 200 "register bela"

check "$(code -b "$DATA_DIR/ca" -X PUT -H "$J" -d '{"json":"{\"lists\":[],\"who\":\"anna\"}","updatedAt":10}' "$B/api/state")" 200 "anna saves"
check "$(code -b "$DATA_DIR/cb" "$B/api/state")" 204 "bela does not see anna's data"
check "$(code -b "$DATA_DIR/ca" -X PUT -H "$J" -d '{"json":"{}","updatedAt":5}' "$B/api/state")" 409 "older save cannot overwrite newer"
check "$(code -b "$DATA_DIR/ca" -X PUT -d '{"json":"{}","updatedAt":50}' "$B/api/state")" 415 "non-JSON content type rejected (CSRF guard)"
curl -s -b "$DATA_DIR/ca" "$B/api/state" | grep -q '"who\\":\\"anna' || fail "anna reads her data"; echo "ok  anna reads her own data"
curl -s -b "$DATA_DIR/ca" "$B/" | grep -q 'name="mf-user" content="anna"' || fail "page knows user"; echo "ok  page is served with username"

check "$(code "$B/api/dictionary")" 401 "base dictionary requires login"
curl -s -b "$DATA_DIR/cb" "$B/api/dictionary" | head -1 | grep -q '^francia;magyar;tipus;megjegyzes;lecke' || fail "base dictionary served"; echo "ok  base dictionary is served to users"

check "$(code -X POST -H "$J" -d '{}' "$B/api/invites")" 401 "user invites require login"
for n in 1 2 3; do check "$(code -b "$DATA_DIR/cb" -X POST -H "$J" -d "{\"note\":\"friend $n\"}" "$B/api/invites")" 200 "bela creates invite $n"; done
check "$(code -b "$DATA_DIR/cb" -X POST -H "$J" -d '{"note":"friend 4"}' "$B/api/invites")" 403 "4th user invite is refused"
UI=$(curl -s -b "$DATA_DIR/cb" "$B/api/invites" | node -pe 'JSON.parse(require("fs").readFileSync(0)).invites[0].code')
check "$(code -b "$DATA_DIR/ca" -X POST -H "$J" -d "{\"code\":\"$UI\"}" "$B/api/invites/revoke")" 400 "anna cannot revoke bela's invite"
check "$(code -c "$DATA_DIR/cc" -X POST -H "$J" -d "{\"invite\":\"$UI\",\"username\":\"cili\",\"password\":\"secret3\"}" "$B/api/register")" 200 "register cili with bela's invite"
check "$(code -b "$DATA_DIR/cb" -X POST -H "$J" -d "{\"code\":\"$UI\"}" "$B/api/invites/revoke")" 400 "used invite cannot be revoked"
UI2=$(curl -s -b "$DATA_DIR/cb" "$B/api/invites" | node -pe 'JSON.parse(require("fs").readFileSync(0)).invites[1].code')
check "$(code -b "$DATA_DIR/cb" -X POST -H "$J" -d "{\"code\":\"$UI2\"}" "$B/api/invites/revoke")" 200 "bela revokes an open invite"
check "$(code -b "$DATA_DIR/cb" -X POST -H "$J" -d '{"note":"friend 5"}' "$B/api/invites")" 200 "revoking frees a slot"
check "$(code -b "$DATA_DIR/cb" -X POST -H "$J" -d '{"note":"friend 6"}' "$B/api/invites")" 403 "limit holds (1 used + 2 open)"
check "$(code -b "$DATA_DIR/cc" -X POST -H "$J" -d '{}' "$B/api/invites")" 200 "invited users can invite too"

check "$(code -X POST -H "$J" -d '{"username":"anna","password":"wrong"}' "$B/api/login")" 401 "wrong password rejected"
check "$(code -c "$DATA_DIR/ca2" -X POST -H "$J" -d '{"username":"ANNA","password":"secret1"}' "$B/api/login")" 200 "login (case-insensitive username)"
node cli.js passwd anna newpass1 >/dev/null
check "$(code -b "$DATA_DIR/ca" "$B/api/state")" 401 "password reset logs out sessions"
check "$(code -b "$DATA_DIR/cb" -X POST -H "$J" -d '{}' "$B/api/logout")" 200 "logout"
check "$(code -b "$DATA_DIR/cb" "$B/api/me")" 401 "session gone after logout"
node cli.js users | grep -q '^anna' || fail "cli users"; echo "ok  cli lists users"
check "$(code --path-as-is "$B/../store.js")" 404 "no path traversal"
echo "All good."
