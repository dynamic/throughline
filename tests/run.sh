#!/bin/sh
# throughline — hook test harness.
#
# Pipes crafted hook payloads through each script in an isolated temp data dir
# and asserts on the resulting buffer / stdout. No network, no model, no deps
# beyond jq + coreutils + git. Run: sh tests/run.sh   (exit 0 = all passed).
#
# Test fixtures legitimately contain literal markdown backticks and $ inside
# single quotes, so SC2016 (no-expansion-in-single-quotes) is expected here.
# shellcheck disable=SC2016

set -u
ROOT=$(unset CDPATH; cd -- "$(dirname -- "$0")/.." && pwd)
H="$ROOT/hooks"
PASS=0
FAIL=0

WORK=$(mktemp -d 2>/dev/null || echo "/tmp/tl-tests.$$")
mkdir -p "$WORK/proj/.claude/throughline/buffer"
( cd "$WORK/proj" && git init -q && git commit -q --allow-empty -m init ) 2>/dev/null
CLAUDE_PROJECT_DIR="$WORK/proj"
THROUGHLINE_DATA_DIR=".claude/throughline"
export CLAUDE_PROJECT_DIR THROUGHLINE_DATA_DIR
BUF="$WORK/proj/.claude/throughline/buffer"

ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
has()    { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1 (missing: $3)"; printf '       got: %s\n' "$2" ;; esac; }
hasnt()  { case "$2" in *"$3"*) bad "$1 (unexpected: $3)"; printf '       got: %s\n' "$2" ;; *) ok "$1" ;; esac; }
present(){ if [ -f "$2" ]; then ok "$1"; else bad "$1 (no file: $2)"; fi; }
absent() { if [ -e "$2" ]; then bad "$1 (exists: $2)"; else ok "$1"; fi; }
eq()     { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }
cap()    { printf '%s' "$1" | sh "$H/session-capture.sh"; }
reset_buf() { rm -f "$BUF"/session-*.md; }

echo "throughline hook tests"
echo "----------------------"

# 1. capture: successful vs failed action
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"ok cmd","command":"true"},"tool_response":{"is_error":false}}'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"bad cmd","command":"false"},"tool_response":{"is_error":true}}'
B=$(cat "$BUF/session-T.md")
has  "capture records the command" "$B" 'true'
has  "failed action gets [failed] marker" "$B" '`[failed]`'
hasnt "successful action has no marker" "$(grep 'ok cmd' "$BUF/session-T.md")" '[failed]'

# 2. secret redaction
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"secret","command":"export API_KEY=ghp_abcdefghij1234567890 token"}}'
S=$(grep 'secret' "$BUF/session-T.md")
hasnt "token value is not stored" "$S" 'ghp_abcdefghij1234567890'
has   "token value is masked" "$S" '***'

# 2b. additional secret shapes: Google API key, PEM private key, Basic auth
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"gkey","command":"deploy --key AIzaSyD1234567890abcdefghijklmnopqrstuv"}}'
hasnt "google api key not stored" "$(grep gkey "$BUF/session-T.md")" 'AIzaSyD1234567890abcdefghijklmnopqrstuv'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"pem","command":"echo -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK\nABCDEF\n-----END RSA PRIVATE KEY-----"}}'
hasnt "pem key body not stored" "$(grep pem "$BUF/session-T.md")" 'MIIEowIBAAK'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"basicauth","command":"curl -H Authorization:Basic dXNlcjpwYXNzd29yZA=="}}'
hasnt "basic-auth payload not stored" "$(grep basicauth "$BUF/session-T.md")" 'dXNlcjpwYXNzd29yZA'

# 3. path relativization
cap '{"session_id":"T","tool_name":"Edit","tool_input":{"file_path":"'"$WORK"'/proj/src/app.js"}}'
E=$(grep Edit "$BUF/session-T.md")
has   "Edit path is relativized to project root" "$E" 'src/app.js'
hasnt "Edit path drops the absolute prefix" "$E" "$WORK"

# 4. missing session_id is dropped (no nosession bucket)
cap '{"tool_name":"Bash","tool_input":{"description":"x","command":"whoami"}}'
absent "no nosession bucket created" "$BUF/session-nosession.md"

# 5. unsafe session_id is sanitized (no traversal/subdirs)
cap '{"session_id":"../evil","tool_name":"Bash","tool_input":{"description":"x","command":"id"}}'
present "unsafe session_id sanitized to a flat filename" "$BUF/session-.._evil.md"
absent  "no path traversal outside buffer/" "$WORK/proj/.claude/evil.md"

# 6. PreCompact stamps a boundary marker
printf '%s' '{"session_id":"T","trigger":"manual"}' | sh "$H/session-precompact.sh"
has "PreCompact writes a compaction-boundary marker" "$(cat "$BUF/session-T.md")" '<!-- compaction-boundary'

# 7. onboard on source=compact points at the live buffer
O=$(printf '%s' '{"source":"compact","session_id":"T"}' | sh "$H/session-onboard.sh")
has "onboard(compact) names this session buffer" "$O" 'session-T.md'
has "onboard(compact) explains recovery" "$O" 'compacted'

# 8. flush stamps ended once, anchored
printf '%s' '{"session_id":"T","reason":"clear"}' | sh "$H/session-flush.sh"
printf '%s' '{"session_id":"T","reason":"clear"}' | sh "$H/session-flush.sh"
eq "flush stamps 'ended' exactly once" "$(grep -c '^<!-- session-ended' "$BUF/session-T.md")" "1"

# 9. onboard excludes the CURRENT session from the unconsumed warning
reset_buf
printf -- '- x\n' > "$BUF/session-T.md"
O2=$(printf '%s' '{"source":"startup","session_id":"T"}' | sh "$H/session-onboard.sh")
hasnt "current session not flagged as unconsumed" "$O2" 'unconsumed session buffer'

# 10. onboard surfaces a DIFFERENT prior session as unconsumed
printf -- '- old\n' > "$BUF/session-OLD.md"
O3=$(printf '%s' '{"source":"startup","session_id":"T"}' | sh "$H/session-onboard.sh")
has "prior session flagged as unconsumed" "$O3" 'unconsumed session buffer'

# 11. missing jq surfaces a visible warning in onboard (curated PATH without jq)
STUB="$WORK/bin"; mkdir -p "$STUB"
for c in sh dirname cat grep git tr head; do
  real=$(command -v "$c" 2>/dev/null) && ln -sf "$real" "$STUB/$c"
done
O4=$(printf '%s' '{"source":"startup","session_id":"T"}' | PATH="$STUB" sh "$H/session-onboard.sh")
has "onboard warns when jq is missing" "$O4" 'jq'
has "onboard says capture is disabled without jq" "$O4" 'DISABLED'

echo "----------------------"
printf 'passed: %s   failed: %s\n' "$PASS" "$FAIL"
rm -rf "$WORK"
[ "$FAIL" -eq 0 ]
