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

check "$(code -X POST -H "$J" -d '{"username":"anna","password":"wrong"}' "$B/api/login")" 401 "wrong password rejected"
check "$(code -c "$DATA_DIR/ca2" -X POST -H "$J" -d '{"username":"ANNA","password":"secret1"}' "$B/api/login")" 200 "login (case-insensitive username)"
node cli.js passwd anna newpass1 >/dev/null
check "$(code -b "$DATA_DIR/ca" "$B/api/state")" 401 "password reset logs out sessions"
check "$(code -b "$DATA_DIR/cb" -X POST -H "$J" -d '{}' "$B/api/logout")" 200 "logout"
check "$(code -b "$DATA_DIR/cb" "$B/api/me")" 401 "session gone after logout"
node cli.js users | grep -q '^anna' || fail "cli users"; echo "ok  cli lists users"
check "$(code --path-as-is "$B/../store.js")" 404 "no path traversal"
echo "All good."
