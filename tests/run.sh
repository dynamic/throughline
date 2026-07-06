#!/bin/sh
# throughline — hook test harness.
#
# Pipes crafted hook payloads through each script in an isolated temp data dir
# and asserts on the resulting buffer / stdout. No network, no model, no deps
# beyond jq + coreutils + git. Run: sh tests/run.sh   (exit 0 = all passed).
#
# This file is the single source of truth for the current assertion count -
# it prints its own total ("passed: N") on every run. Historical assertion
# counts have drifted in prose before (CHANGELOG/HANDOFF entries citing 71,
# 83, 88, 95... at different points, issue #11): if you cite a count in
# prose, anchor it to a specific version ("143 assertions as of v0.5.2") or
# just point here instead of hardcoding a number that will go stale.
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
# A developer running the suite with the machine-wide kill switch exported
# would otherwise see every hook no-op and the whole suite fail confusingly.
unset THROUGHLINE_DISABLE
DATA="$WORK/proj/.claude/throughline"
BUF="$DATA/buffer"

ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
has()    { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1 (missing: $3)"; printf '       got: %s\n' "$2" ;; esac; }
hasnt()  { case "$2" in *"$3"*) bad "$1 (unexpected: $3)"; printf '       got: %s\n' "$2" ;; *) ok "$1" ;; esac; }
present(){ if [ -f "$2" ]; then ok "$1"; else bad "$1 (no file: $2)"; fi; }
dir_present(){ if [ -d "$2" ]; then ok "$1"; else bad "$1 (no dir: $2)"; fi; }
absent() { if [ -e "$2" ]; then bad "$1 (exists: $2)"; else ok "$1"; fi; }
eq()     { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }
cap()    { printf '%s' "$1" | sh "$H/session-capture.sh"; }
prompt() { printf '%s' "$1" | sh "$H/session-prompt.sh"; }
precompact() { printf '%s' "$1" | sh "$H/session-precompact.sh"; }
reset_buf() { rm -f "$BUF"/session-*.md "$DATA"/.capture-errors; mkdir -p "$BUF"; chmod 755 "$BUF" 2>/dev/null; }

echo "throughline hook tests"
echo "----------------------"

# 1. capture: outcome marking against the REAL Bash tool_response schema
#    (keys: interrupted, isImage, noOutputExpected, stderr, stdout — no exit code).
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"ok cmd","command":"true"},"tool_response":{"interrupted":false,"isImage":false,"stderr":"\nShell cwd was reset to /x","stdout":"ok"}}'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"stopped","command":"sleep 99"},"tool_response":{"interrupted":true,"isImage":false,"stderr":"","stdout":""}}'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"errd","command":"deploy"},"tool_response":{"exit_code":1}}'
B=$(cat "$BUF/session-T.md")
has   "capture records the command" "$B" 'true'
OK_LINE=$(grep 'ok cmd' "$BUF/session-T.md")
hasnt "real success gets no [failed] marker" "$OK_LINE" '`[failed]`'
hasnt "real success gets no [interrupted] marker" "$OK_LINE" '`[interrupted]`'
has   "interrupted action gets [interrupted] marker" "$(grep stopped "$BUF/session-T.md")" '`[interrupted]`'
has   "explicit non-zero exit_code gets [failed] marker (Bash only)" "$(grep errd "$BUF/session-T.md")" '`[failed]`'

# 1a2. a Bash tool_response with an EMPTY-STRING error (jq's `//` only treats
#      null/false as "absent", so "" previously slipped through as "present"
#      and false-positived a [failed] on a genuinely successful command).
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"deploy ok","command":"true"},"tool_response":{"exit_code":0,"stdout":"done","error":""}}'
hasnt "Bash with exit_code:0 and error:\"\" is NOT marked failed" "$(grep 'deploy ok' "$BUF/session-T.md")" '`[failed]`'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"deploy bad","command":"true"},"tool_response":{"exit_code":0,"error":"boom"}}'
has "Bash with a genuinely non-empty error string IS marked failed" "$(grep 'deploy bad' "$BUF/session-T.md")" '`[failed]`'

# 1a3. exit_code surfaced as a STRING "0" (e.g. from a wrapper that
#      JSON-stringifies fields) must not false-positive [failed]: jq's `!=`
#      never considers a string equal to a number regardless of value, so
#      "0" != 0 was true before normalizing both sides via tostring.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"strcode ok","command":"true"},"tool_response":{"exit_code":"0"}}'
hasnt "Bash with exit_code as the STRING \"0\" is NOT marked failed" "$(grep 'strcode ok' "$BUF/session-T.md")" '`[failed]`'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"strcode bad","command":"true"},"tool_response":{"exit_code":"1"}}'
has "Bash with exit_code as the STRING \"1\" IS marked failed" "$(grep 'strcode bad' "$BUF/session-T.md")" '`[failed]`'

# 1b. the exit_code/error heuristic is scoped to Bash; other tool types only
#     trust is_error/interrupted, so an unverified "error" field on Edit/Write
#     does not false-positive a [failed] on completed work.
reset_buf
cap '{"session_id":"T","tool_name":"Edit","tool_input":{"file_path":"'"$WORK"'/proj/src/ok.js"},"tool_response":{"error":""}}'
hasnt "Edit with a benign non-null 'error' field is NOT marked failed" "$(grep ok.js "$BUF/session-T.md")" '`[failed]`'
cap '{"session_id":"T","tool_name":"Edit","tool_input":{"file_path":"'"$WORK"'/proj/src/bad.js"},"tool_response":{"is_error":true}}'
has "Edit with is_error:true IS marked failed" "$(grep bad.js "$BUF/session-T.md")" '`[failed]`'

# 2. secret redaction
reset_buf
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"secret","command":"export API_KEY=ghp_abcdefghij1234567890 token"}}'
S=$(grep 'secret' "$BUF/session-T.md")
hasnt "token value is not stored" "$S" 'ghp_abcdefghij1234567890'
has   "token value is masked" "$S" '***'

# 2b. additional secret shapes: Google API key, PEM private key, Basic auth
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"gkey","command":"deploy --key AIzaSyD1234567890abcdefghijklmnopqrstuv"}}'
hasnt "google api key not stored" "$(grep gkey "$BUF/session-T.md")" 'AIzaSyD1234567890abcdefghijklmnopqrstuv'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"pem","command":"echo -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK\nABCDEF\n-----END RSA PRIVATE KEY-----"}}'
hasnt "pem key body (with END marker) not stored" "$(grep pem "$BUF/session-T.md")" 'MIIEowIBAAK'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"basicauth","command":"curl -H Authorization:Basic dXNlcjpwYXNzd29yZA=="}}'
hasnt "basic-auth payload not stored" "$(grep basicauth "$BUF/session-T.md")" 'dXNlcjpwYXNzd29yZA'

# 2c. PEM body with NO end marker (truncated/streamed key) is still redacted
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"pemnoeND","command":"echo -----BEGIN RSA PRIVATE KEY-----\nMIITRUNCATEDKEYBODY\nNOENDMARKERHERE"}}'
hasnt "pem key body with NO end marker not stored" "$(grep pemnoeND "$BUF/session-T.md")" 'MIITRUNCATEDKEYBODY'

# 2d. ghr_ refresh tokens are redacted (gh[oprsu]_ class, not gh[opsu]_)
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"ghrtok","command":"echo ghr_1234567890abcdefghij"}}'
hasnt "ghr_ refresh token not stored" "$(grep ghrtok "$BUF/session-T.md")" 'ghr_1234567890abcdefghij'

# 2e. broadened keyword alternation catches "credential" (not just token/secret/password)
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"credtest","command":"export DB_CREDENTIAL=s3cr3tHunter2value"}}'
hasnt "DB_CREDENTIAL value not stored" "$(grep credtest "$BUF/session-T.md")" 's3cr3tHunter2value'

# 2e2. compound variable names (keyword immediately followed by more word
#      chars, not just preceded) are still redacted - these used to fall
#      through entirely since the keyword group had no trailing \w*.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"compoundkey","command":"export SECRET_KEY=foo123456789bar"}}'
hasnt "SECRET_KEY value not stored" "$(grep compoundkey "$BUF/session-T.md")" 'foo123456789bar'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"compoundapi","command":"export API_KEY_VALUE=baz987654321qux"}}'
hasnt "API_KEY_VALUE value not stored" "$(grep compoundapi "$BUF/session-T.md")" 'baz987654321qux'

# 2e3. the generic keyword=value rule must not re-swallow text the URL-userinfo
#      rule already redacted: a "token"/"secret" substring inside a URL
#      username (e.g. "x-access-token") used to make the generic rule's
#      unbounded value-capture eat through '@' and delete the trailing
#      host/path, not just mask the credential.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"clone","command":"git clone https://x-access-token:ghp_aaaaaaaaaaaaaaaaaaaaaaaa@github.com/foo/bar.git"}}'
CLONE_LINE=$(grep clone "$BUF/session-T.md")
hasnt "credential in URL userinfo is not stored" "$CLONE_LINE" 'ghp_aaaaaaaaaaaaaaaaaaaaaaaa'
has   "URL host/path after the credential is preserved, not deleted" "$CLONE_LINE" 'github.com/foo/bar.git'

# 2e4. a secret VALUE containing slashes (e.g. a realistic AWS-shaped key) is
#      fully redacted, not truncated at the first '/' - regression check for
#      the over-correction the @-exclusion-only fix above must not reintroduce.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"awskey","command":"export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}}'
AWS_LINE=$(grep awskey "$BUF/session-T.md")
hasnt "AWS secret value (with slashes) is not stored" "$AWS_LINE" 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
hasnt "AWS secret value is not even partially stored" "$AWS_LINE" 'K7MDENG'

# 2e5. dashed multi-segment sk- key formats (Anthropic sk-ant-, OpenAI
#      sk-proj-) are fully redacted, not left untouched by a body class that
#      only allowed alnum and rejected the internal dashes.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"anthropickey","command":"export ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGh1234567890XYZ"}}'
hasnt "sk-ant- key is not stored" "$(grep anthropickey "$BUF/session-T.md")" 'sk-ant-api03-AbCdEfGh1234567890XYZ'

# 2e6. natural-language "keyword is X" phrasing masks the real value X, not
#      the linking word "is" - the separator group used to only recognize
#      :/=/bare-whitespace, so the generic value-capture grabbed whatever
#      single word came right after the keyword regardless of what it was.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"prose","command":"my password is hunter3verylongsecretvalue"}}'
hasnt "secret value after a copula (is/was/are) is not stored" "$(grep prose "$BUF/session-T.md")" 'hunter3verylongsecretvalue'

# 2e7. "Authorization: Token <value>" (DRF/GitLab-style auth header) masks the
#      real key, not the scheme word "Token" itself - needs its own dedicated
#      rule alongside Bearer/Basic, since the generic rule would otherwise
#      treat "Token" as the value to redact and leave the real key exposed.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"drfauth","command":"curl -H Authorization: Token abc123def456ghi789"}}'
hasnt "DRF-style Token value is not stored" "$(grep drfauth "$BUF/session-T.md")" 'abc123def456ghi789'

# 2e8. a secret value that legitimately contains a literal @ (common in
#      human-chosen passwords) is fully masked, not truncated at the first @ -
#      the generic rule's value-capture has no @ exclusion at all now (the
#      sentinel-based redesign below removed the need for one), so this value
#      falls straight to the fully-unbounded branch and is masked whole.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"atpass","command":"export PASSWORD=my@pass123"}}'
hasnt "password value containing @ is not stored" "$(grep atpass "$BUF/session-T.md")" 'my@pass123'
hasnt "password value containing @ is not even partially stored" "$(grep atpass "$BUF/session-T.md")" 'pass123'

# 2e9. a URL credential with NO keyword anywhere nearby (so the generic rule
#      never visits that part of the line at all) still gets its internal
#      sentinel converted to *** by redact's own final catch-all pass, not
#      left as a raw, never-cleaned-up internal marker in the buffer.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"plainclone","command":"curl https://user:hunter2@example.com/data"}}'
PLAIN_LINE=$(grep plainclone "$BUF/session-T.md")
hasnt "URL credential with no nearby keyword is not stored" "$PLAIN_LINE" 'hunter2'
hasnt "internal sentinel never leaks into the buffer" "$PLAIN_LINE" 'TLREDACTSENTINEL'
has   "URL host/path is preserved" "$PLAIN_LINE" 'example.com/data'

# 2e10. issue #15: a quoted secret value ("...") is fully masked with NO
#       orphaned trailing quote left in the output - the value-capture group
#       used to optionally consume a LEADING quote but never a matching
#       trailing one, so `password="X"` redacted to `password=***"` (the
#       secret itself was masked; only the stray quote was cosmetic, but it
#       is malformed output).
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"quotedpw","command":"config: password=\"hunter2superlongvalue\""}}'
QUOTED_LINE=$(grep quotedpw "$BUF/session-T.md")
hasnt "quoted secret value is not stored" "$QUOTED_LINE" 'hunter2superlongvalue'
hasnt "no orphaned trailing quote after the mask" "$QUOTED_LINE" '***"'
has   "quoted secret value is masked" "$QUOTED_LINE" 'password=***'

# 2e11. an UNTERMINATED quoted value (opening quote, no closing quote anywhere
#       after it - malformed/truncated input) is still masked rather than
#       silently falling through to cleartext, matching this rule's
#       pre-#15-fix behavior for exactly that shape.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"unclosedpw","command":"config: password=\"hunter2superlongvalue"}}'
hasnt "unterminated quoted secret is not stored" "$(grep unclosedpw "$BUF/session-T.md")" 'hunter2superlongvalue'

# 2e12. a MULTI-WORD unterminated quoted value is masked IN FULL, not just its
#       first token - an earlier version of the unterminated-quote fallback
#       stopped at the first whitespace (like the bare-unquoted case), which
#       masked only "open" in `password="open sesame` and left "sesame" in
#       cleartext right after the *** marker.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"unclosedmultiword","command":"config: password=\"open sesame"}}'
MULTIWORD_LINE=$(grep unclosedmultiword "$BUF/session-T.md")
hasnt "second word of an unterminated multi-word secret is not stored" "$MULTIWORD_LINE" 'sesame'
hasnt "first word of an unterminated multi-word secret is not stored" "$MULTIWORD_LINE" 'open'
has   "unterminated multi-word secret is masked in full" "$MULTIWORD_LINE" 'password=***'

# 2f. redaction applies to the Bash *description* field, not just command
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"deploy with ghp_abcdefghij1234567890","command":"true"}}'
DESC_LINE=$(grep '\*\*bash\*\* deploy' "$BUF/session-T.md")
hasnt "token in description is not stored" "$DESC_LINE" 'ghp_abcdefghij1234567890'
has   "token in description is masked" "$DESC_LINE" '***'

# 2g. redaction applies to Edit/Write/NotebookEdit file_path, not just Bash command
cap '{"session_id":"T","tool_name":"Write","tool_input":{"file_path":"'"$WORK"'/proj/tmp/sk-abcdefghij1234567890.txt"}}'
PATH_LINE=$(grep '\*\*Write\*\*' "$BUF/session-T.md")
hasnt "token in file_path is not stored" "$PATH_LINE" 'sk-abcdefghij1234567890'
has   "token in file_path is masked" "$PATH_LINE" '***'

# 3. path relativization (Edit, Write, NotebookEdit, and the "?" fallback)
reset_buf
cap '{"session_id":"T","tool_name":"Edit","tool_input":{"file_path":"'"$WORK"'/proj/src/app.js"}}'
E=$(grep Edit "$BUF/session-T.md")
has   "Edit path is relativized to project root" "$E" 'src/app.js'
hasnt "Edit path drops the absolute prefix" "$E" "$WORK"
cap '{"session_id":"T","tool_name":"Write","tool_input":{"file_path":"'"$WORK"'/proj/src/new.js"}}'
has "Write path is relativized to project root" "$(grep '\*\*Write\*\*' "$BUF/session-T.md")" 'src/new.js'
cap '{"session_id":"T","tool_name":"NotebookEdit","tool_input":{"notebook_path":"'"$WORK"'/proj/nb/a.ipynb"}}'
has "NotebookEdit uses notebook_path fallback" "$(grep NotebookEdit "$BUF/session-T.md")" 'nb/a.ipynb'
cap '{"session_id":"T","tool_name":"Write","tool_input":{}}'
has "Write with neither path key falls back to ?" "$(grep '\*\*Write\*\* ?' "$BUF/session-T.md")" '**Write** ?'

# 3b. command truncation at 200 chars
LONGCMD=$(printf 'echo %0.s1' $(seq 1 250))
cap "$(printf '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"long","command":"%s"}}' "$LONGCMD")"
LONG_LINE=$(grep '\*\*bash\*\* long' "$BUF/session-T.md")
has   "long command is marked truncated" "$LONG_LINE" '…[truncated]'
hasnt "long command does not store the full untruncated text" "$LONG_LINE" "$LONGCMD"

# 4. missing session_id is dropped (no nosession bucket), but breadcrumbed
#    like the other silent-loss paths so the drop isn't entirely untraceable.
reset_buf
cap '{"tool_name":"Bash","tool_input":{"description":"x","command":"whoami"}}'
absent "no nosession bucket created" "$BUF/session-nosession.md"
present "dropped no-session-id action breadcrumbs to .capture-errors" "$DATA/.capture-errors"

# 5. unsafe session_id is sanitized (no traversal/subdirs)
cap '{"session_id":"../evil","tool_name":"Bash","tool_input":{"description":"x","command":"id"}}'
present "unsafe session_id sanitized to a flat filename" "$BUF/session-.._evil.md"
absent  "no path traversal outside buffer/" "$WORK/proj/.claude/evil.md"

# 5b. tl_safe_sid unit tests: '.', '..', and empty all reject to ""
. "$H/_lib.sh"
eq "tl_safe_sid rejects '.'" "$(tl_safe_sid '.')" ""
eq "tl_safe_sid rejects '..'" "$(tl_safe_sid '..')" ""
eq "tl_safe_sid rejects empty" "$(tl_safe_sid '')" ""

# 5a2. tl_clean_ctrl unit tests: control chars AND backticks both become a
#      space (issue #9 review finding: a stamped trigger/reason containing a
#      run of backticks could otherwise break the markdown fence the new
#      inline-tail feature wraps buffer content in).
eq "tl_clean_ctrl replaces control chars with space" "$(tl_clean_ctrl "$(printf 'a\tb')")" "a b"
eq "tl_clean_ctrl replaces backticks with space" "$(tl_clean_ctrl 'trig```ger')" "trig   ger"

# 5c. tl_data_dir honors an absolute THROUGHLINE_DATA_DIR override
ABS_DIR="$WORK/abs-data"
eq "tl_data_dir honors absolute THROUGHLINE_DATA_DIR" \
  "$(THROUGHLINE_DATA_DIR="$ABS_DIR" CLAUDE_PROJECT_DIR="$WORK/proj" sh -c '. "'"$H"'/_lib.sh"; tl_data_dir')" \
  "$ABS_DIR"

# 5d. capture and flush derive the SAME sanitized filename for a session_id
#     containing a tab character (regression: capture used to tab-split a
#     combined jq output, desyncing it from how other hooks resolve the id).
#     The JSON payload below carries a JSON-escaped \t (valid JSON); a literal
#     tab byte is not legal inside a JSON string and jq would reject it.
reset_buf
TABSID_PAYLOAD='{"session_id":"A\tB","tool_name":"Bash","tool_input":{"description":"x","command":"id"}}'
cap "$TABSID_PAYLOAD"
printf '%s' '{"session_id":"A\tB","reason":"end"}' | sh "$H/session-flush.sh"
RAW_SID=$(printf '%s' "$TABSID_PAYLOAD" | jq -r '.session_id')
EXPECT_SID=$(tl_safe_sid "$RAW_SID")
present "capture wrote the consistently-sanitized filename" "$BUF/session-$EXPECT_SID.md"
has "flush stamped the SAME file capture wrote to" "$(cat "$BUF/session-$EXPECT_SID.md" 2>/dev/null)" '<!-- session-ended'

# 6. PreCompact stamps a boundary marker
reset_buf
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"x","command":"id"}}'
printf '%s' '{"session_id":"T","trigger":"manual"}' | sh "$H/session-precompact.sh"
has "PreCompact writes a compaction-boundary marker" "$(cat "$BUF/session-T.md")" '<!-- compaction-boundary'

# 7. onboard on source=compact inlines the buffer TAIL directly (issue #9),
#    not just a pointer - saves the model a tool call exactly where
#    post-compaction recall is weakest.
O=$(printf '%s' '{"source":"compact","session_id":"T"}' | sh "$H/session-onboard.sh")
has "onboard(compact) names this session buffer" "$O" 'session-T.md'
has "onboard(compact) explains recovery" "$O" 'compacted'
has "onboard(compact) inlines the captured action" "$O" '**bash**'
has "onboard(compact) inlines the compaction-boundary marker" "$O" '<!-- compaction-boundary'

# 7a. the inline tail is specific to the compact path - startup/resume never
#     inline buffer content, only the pointer/warning lines.
O_START=$(printf '%s' '{"source":"startup","session_id":"T"}' | sh "$H/session-onboard.sh")
hasnt "onboard(startup) does not inline the buffer tail" "$O_START" '**bash**'
O_RESUME=$(printf '%s' '{"source":"resume","session_id":"T"}' | sh "$H/session-onboard.sh")
hasnt "onboard(resume) does not inline the buffer tail" "$O_RESUME" '**bash**'

# 7b. the inline tail is BOUNDED to the last N lines - an old line well before
#     the compaction seam is not inlined, only recent history near it.
reset_buf
i=1
while [ "$i" -le 40 ]; do
  printf -- '- `t` **bash** line%s - `cmd%s`\n' "$i" "$i" >> "$BUF/session-T.md"
  i=$((i + 1))
done
O_TAIL=$(printf '%s' '{"source":"compact","session_id":"T"}' | sh "$H/session-onboard.sh")
hasnt "onboard(compact) tail excludes a line beyond the bound" "$O_TAIL" 'cmd10`'
has   "onboard(compact) tail includes the first line within the bound" "$O_TAIL" 'cmd11`'
has   "onboard(compact) tail includes the most recent line" "$O_TAIL" 'cmd40`'

# 7c. a single OVERSIZED line within the tail window is truncated per-line
#     (review finding: session-capture.sh never length-clamps a Bash
#     description or an Edit/Write/NotebookEdit file_path, so this hook's own
#     per-line cap - not an assumption about capture-side clamping - is what
#     actually keeps the inlined block bounded).
reset_buf
LONGDESC=$(awk 'BEGIN{for(i=0;i<3000;i++) printf "x"}')
printf -- '- `t` **bash** %s - `ls`\n' "$LONGDESC" > "$BUF/session-T.md"
O_LONG=$(printf '%s' '{"source":"compact","session_id":"T"}' | sh "$H/session-onboard.sh")
hasnt "onboard(compact) does not inline an oversized field verbatim" "$O_LONG" "$LONGDESC"
has   "onboard(compact) marks a truncated oversized line" "$O_LONG" '…[line truncated]'

# 8. flush stamps ended once, anchored
printf '%s' '{"session_id":"T","reason":"clear"}' | sh "$H/session-flush.sh"
printf '%s' '{"session_id":"T","reason":"clear"}' | sh "$H/session-flush.sh"
eq "flush stamps 'ended' exactly once" "$(grep -c '^<!-- session-ended' "$BUF/session-T.md")" "1"

# 9. onboard excludes the CURRENT session from the unconsumed warning
reset_buf
printf -- '- x\n' > "$BUF/session-T.md"
O2=$(printf '%s' '{"source":"startup","session_id":"T"}' | sh "$H/session-onboard.sh")
hasnt "current session not flagged as unconsumed" "$O2" 'unconsumed session buffer'

# 10. onboard surfaces a prior session that ENDED (has the end-stamp) as
#     "unconsumed" — wording asserts a fact it can actually verify.
printf -- '- `t` **bash** old - `x`\n<!-- session-ended 2024-01-01 00:00:00 (end) -->\n' > "$BUF/session-OLD.md"
O3=$(printf '%s' '{"source":"startup","session_id":"T"}' | sh "$H/session-onboard.sh")
has "ended prior session flagged as unconsumed" "$O3" 'unconsumed session buffer'

# 10a. a prompt-only buffer (intent captured, but no action — a Q&A or
#      Read/Glob-only session) is NOT counted as unconsumed: there is nothing
#      to distill, and counting it would nag on every trivial session.
reset_buf
printf -- '- x\n' > "$BUF/session-T.md"
printf -- '- `t` **prompt** just a question answered from context\n<!-- session-ended 2024-01-01 00:00:00 (end) -->\n' > "$BUF/session-PONLY.md"
O3a=$(printf '%s' '{"source":"startup","session_id":"T"}' | sh "$H/session-onboard.sh")
hasnt "prompt-only ended buffer NOT flagged as unconsumed" "$O3a" 'unconsumed session buffer'
# but the same buffer WITH a real action line IS surfaced.
printf -- '- `t` **prompt** do the thing\n- `t` **bash** did it - `x`\n<!-- session-ended 2024-01-01 00:00:00 (end) -->\n' > "$BUF/session-PACT.md"
O3a2=$(printf '%s' '{"source":"startup","session_id":"T"}' | sh "$H/session-onboard.sh")
has "prompt+action ended buffer IS flagged as unconsumed" "$O3a2" 'unconsumed session buffer'

# 10a2. regression: the prompt-only filter is ANCHORED to the type-marker
# position, not a substring search for "**prompt**" anywhere in the line — an
# action line whose own captured content happens to mention that literal
# string (a grep for the pattern, a bash command referencing it) must still
# count as a real action, not be misclassified as a second prompt line.
reset_buf
printf -- '- x\n' > "$BUF/session-T.md"
printf -- '- `t` **prompt** find where **prompt** lines are filtered\n- `t` **grep** `**prompt**`\n<!-- session-ended 2024-01-01 00:00:00 (end) -->\n' > "$BUF/session-SUBSTR.md"
O3a3=$(printf '%s' '{"source":"startup","session_id":"T"}' | sh "$H/session-onboard.sh")
has "action line mentioning the literal **prompt** string is still counted" "$O3a3" 'unconsumed session buffer'

# 10a3. regression: a buffer with ZERO conforming record lines (truncated,
# corrupted, or a capture hook that failed on every call) must still be
# counted, not silently dropped — the total/prompt-count comparison falls
# through to "count it" only when total is 0, matching the pre-existing
# fail-safe behavior of counting any existing, end-stamped buffer regardless
# of its body content.
reset_buf
printf -- '- x\n' > "$BUF/session-T.md"
printf -- '<!-- session-ended 2024-01-01 00:00:00 (end) -->\n' > "$BUF/session-EMPTY.md"
O3a4=$(printf '%s' '{"source":"startup","session_id":"T"}' | sh "$H/session-onboard.sh")
has "a buffer with zero conforming lines is still counted, not dropped" "$O3a4" 'unconsumed session buffer'

# 10a5. regression: an UNREADABLE buffer file makes grep -c print an empty
# string rather than "0" — the total/promptonly counts must default to 0
# rather than feeding an empty operand to the integer test, which would
# otherwise leak a shell diagnostic to stderr, breaking this hook's
# always-silent-on-error contract (every other error path here is
# 2>/dev/null'd). Skipped when running as root, which bypasses permissions.
if [ "$(id -u)" != "0" ]; then
  reset_buf
  printf -- '- x\n' > "$BUF/session-T.md"
  printf 'test' > "$BUF/session-UNREAD.md"
  chmod 000 "$BUF/session-UNREAD.md"
  ERR=$(printf '%s' '{"source":"startup","session_id":"T"}' | sh "$H/session-onboard.sh" 2>&1 1>/dev/null)
  eq "unreadable buffer file produces no stderr diagnostic" "$ERR" ""
  chmod 644 "$BUF/session-UNREAD.md" 2>/dev/null
else
  ok "unreadable-buffer stderr test skipped (running as root)"
fi

# 10a6. regression: a tool_name containing an asterisk (the mcp__.* fallback
# branch is the only place a field is embedded DIRECTLY inside the **...**
# delimiter pair, not just after it) must not break the bold span or desync
# the anchored **[^*]+** classifier above — an action line that becomes
# unparseable must not silently be miscounted as prompt-only.
reset_buf
printf -- '- x\n' > "$BUF/session-T.md"
cap '{"session_id":"MCPSTAR","tool_name":"mcp__weird*tool","tool_input":{"title":"x"}}'
printf -- '<!-- session-ended 2024-01-01 00:00:00 (end) -->\n' >> "$BUF/session-MCPSTAR.md"
O3a6=$(printf '%s' '{"source":"startup","session_id":"T"}' | sh "$H/session-onboard.sh")
has "an mcp tool_name with an asterisk is still counted as a real action" "$O3a6" 'unconsumed session buffer'

# 10b. a prior session buffer with NO end-stamp gets hedged wording, not
#      asserted as "ended" — it could be live in another terminal.
reset_buf
printf -- '- x\n' > "$BUF/session-T.md"
printf -- '- `t` **bash** new - `x`\n' > "$BUF/session-LIVE.md"
O3b=$(printf '%s' '{"source":"startup","session_id":"T"}' | sh "$H/session-onboard.sh")
has   "no-end-stamp buffer surfaced with hedged wording" "$O3b" 'no end-stamp'
hasnt "no-end-stamp buffer NOT mislabeled as ended" "$O3b" 'ended without'

# 11. missing jq surfaces a visible warning in onboard (curated PATH without jq)
STUB="$WORK/bin"; mkdir -p "$STUB"
for c in sh dirname cat grep git tr head; do
  real=$(command -v "$c" 2>/dev/null) && ln -sf "$real" "$STUB/$c"
done
O4=$(printf '%s' '{"source":"startup","session_id":"T"}' | PATH="$STUB" sh "$H/session-onboard.sh")
has "onboard warns when jq is missing" "$O4" 'jq'
has "onboard says capture is disabled without jq" "$O4" 'DISABLED'

# 11b. missing jq makes capture/flush/precompact no-op silently, not crash
reset_buf
printf '%s' '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"x","command":"id"}}' | PATH="$STUB" sh "$H/session-capture.sh"
absent "capture writes nothing when jq is missing" "$BUF/session-T.md"
printf '%s' '{"session_id":"T","reason":"end"}' | PATH="$STUB" sh "$H/session-flush.sh"
printf '%s' '{"session_id":"T","trigger":"manual"}' | PATH="$STUB" sh "$H/session-precompact.sh"
ok "flush/precompact did not crash without jq"

# 12. tl_active auto-activation: a fresh project with no prior state and no
#     .throughlineignore activates the moment any hook fires, rather than
#     staying silent forever (the old opt-in-by-directory-existence gate was a
#     chicken-and-egg trap: capture never started until a handoff ran, but a
#     handoff had nothing to distill until capture had run).

# 12a. onboard on a totally fresh project, THROUGHLINE_DATA_DIR set (inherits
#      the harness's export) -> auto-activates, dir gets created, onboard is
#      no longer silent.
FRESH_A="$WORK/fresh-a"
mkdir -p "$FRESH_A"
( cd "$FRESH_A" && git init -q && git commit -q --allow-empty -m init ) 2>/dev/null
O5=$(printf '%s' '{"source":"startup","session_id":"T"}' | CLAUDE_PROJECT_DIR="$FRESH_A" sh "$H/session-onboard.sh")
has     "onboard is no longer silent on a fresh project" "$O5" 'throughline'
dir_present "auto-activation created the configured data dir" "$FRESH_A/.claude/throughline"

# 12b. same, but THROUGHLINE_DATA_DIR UNSET -> auto-activates at the plugin's
#      own default path. Must explicitly unset in a subshell: the harness's
#      global export (set once at the top of this file for every other test's
#      convenience) would otherwise mask this exact case.
FRESH_B="$WORK/fresh-b"
mkdir -p "$FRESH_B"
( cd "$FRESH_B" && git init -q && git commit -q --allow-empty -m init ) 2>/dev/null
O6=$(printf '%s' '{"source":"startup","session_id":"T"}' | (unset THROUGHLINE_DATA_DIR; CLAUDE_PROJECT_DIR="$FRESH_B" sh "$H/session-onboard.sh"))
has     "onboard auto-activates at the default path when unset" "$O6" 'throughline'
dir_present "default .claude/throughline/ dir created when unset" "$FRESH_B/.claude/throughline"

# 12c. a .throughlineignore marker at the project root disables throughline
#      unconditionally, even though auto-activation would otherwise apply -
#      the opt-out escape hatch.
FRESH_C="$WORK/fresh-c"
mkdir -p "$FRESH_C"
( cd "$FRESH_C" && git init -q && git commit -q --allow-empty -m init ) 2>/dev/null
: > "$FRESH_C/.throughlineignore"
O7=$(printf '%s' '{"source":"startup","session_id":"T"}' | CLAUDE_PROJECT_DIR="$FRESH_C" sh "$H/session-onboard.sh")
eq "onboard stays silent when .throughlineignore is present" "$O7" ""
absent "no data dir created under an ignored project" "$FRESH_C/.claude"
printf '%s' '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"x","command":"id"}}' | CLAUDE_PROJECT_DIR="$FRESH_C" sh "$H/session-capture.sh"
absent "capture writes nothing under an ignored project" "$FRESH_C/.claude/throughline/buffer/session-T.md"

# 12d. capture.sh called FIRST (no prior onboard call) on a fresh project also
#      auto-activates - proving the bootstrap lives in the shared tl_active
#      helper, not wired to one specific hook.
FRESH_D="$WORK/fresh-d"
mkdir -p "$FRESH_D"
( cd "$FRESH_D" && git init -q && git commit -q --allow-empty -m init ) 2>/dev/null
printf '%s' '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"x","command":"id"}}' | CLAUDE_PROJECT_DIR="$FRESH_D" sh "$H/session-capture.sh"
present "capture-first auto-activates and writes a buffer entry" "$FRESH_D/.claude/throughline/buffer/session-T.md"

# 12e. a FAILED bootstrap must not look identical to a deliberate
#      .throughlineignore opt-out: onboard surfaces a distinct warning rather
#      than staying silent, so the failure is diagnosable instead of
#      masquerading as "user opted out."
FRESH_E="$WORK/fresh-e"
mkdir -p "$FRESH_E"
( cd "$FRESH_E" && git init -q && git commit -q --allow-empty -m init ) 2>/dev/null
if [ "$(id -u)" != "0" ]; then
  chmod 555 "$FRESH_E" 2>/dev/null
  O8=$(printf '%s' '{"source":"startup","session_id":"T"}' | CLAUDE_PROJECT_DIR="$FRESH_E" sh "$H/session-onboard.sh")
  chmod 755 "$FRESH_E" 2>/dev/null
  has    "failed bootstrap surfaces a distinct warning" "$O8" 'could not create its data directory'
  absent "failed bootstrap does not create the data dir" "$FRESH_E/.claude"
  hasnt  "failed bootstrap warning does not leak the absolute project path" "$O8" "$FRESH_E"
else
  ok "failed-bootstrap warning test skipped (running as root)"
  ok "failed-bootstrap no-dir-created test skipped (running as root)"
  ok "failed-bootstrap path-relativization test skipped (running as root)"
fi

# 12f. first activation nudges toward gitignoring the buffer - but only when
#      it is not already covered, using git's own ignore resolution rather
#      than a hand-rolled pattern match.
FRESH_F="$WORK/fresh-f"
mkdir -p "$FRESH_F"
( cd "$FRESH_F" && git init -q && git commit -q --allow-empty -m init ) 2>/dev/null
O9=$(printf '%s' '{"source":"startup","session_id":"T"}' | CLAUDE_PROJECT_DIR="$FRESH_F" sh "$H/session-onboard.sh")
has "first activation nudges to gitignore the buffer when not covered" "$O9" 'not gitignored yet'

FRESH_G="$WORK/fresh-g"
mkdir -p "$FRESH_G"
printf '.claude/throughline/buffer/\n' > "$FRESH_G/.gitignore"
( cd "$FRESH_G" && git init -q && git add .gitignore && git commit -q -m init ) 2>/dev/null
O10=$(printf '%s' '{"source":"startup","session_id":"T"}' | CLAUDE_PROJECT_DIR="$FRESH_G" sh "$H/session-onboard.sh")
hasnt "no gitignore nudge when the buffer is already covered" "$O10" 'not gitignored yet'

# 12g. flush still stamps an ALREADY-EXISTING buffer even if .throughlineignore
#      appears mid-session: its job is to finalize a session that legitimately
#      captured, not to decide whether tracking should continue. Without this,
#      a later opt-out decision would silently corrupt an already-recorded
#      session's bookkeeping.
FRESH_H="$WORK/fresh-h"
mkdir -p "$FRESH_H"
( cd "$FRESH_H" && git init -q && git commit -q --allow-empty -m init ) 2>/dev/null
printf '%s' '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"x","command":"id"}}' | CLAUDE_PROJECT_DIR="$FRESH_H" sh "$H/session-capture.sh"
: > "$FRESH_H/.throughlineignore"
printf '%s' '{"session_id":"T","reason":"end"}' | CLAUDE_PROJECT_DIR="$FRESH_H" sh "$H/session-flush.sh"
has "flush still stamps a session that was already tracked, despite a new .throughlineignore" \
  "$(cat "$FRESH_H/.claude/throughline/buffer/session-T.md" 2>/dev/null)" '<!-- session-ended'

# 12h. same reasoning, for precompact's boundary marker.
FRESH_I="$WORK/fresh-i"
mkdir -p "$FRESH_I"
( cd "$FRESH_I" && git init -q && git commit -q --allow-empty -m init ) 2>/dev/null
printf '%s' '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"x","command":"id"}}' | CLAUDE_PROJECT_DIR="$FRESH_I" sh "$H/session-capture.sh"
: > "$FRESH_I/.throughlineignore"
printf '%s' '{"session_id":"T","trigger":"manual"}' | CLAUDE_PROJECT_DIR="$FRESH_I" sh "$H/session-precompact.sh"
has "precompact still stamps a session that was already tracked, despite a new .throughlineignore" \
  "$(cat "$FRESH_I/.claude/throughline/buffer/session-T.md" 2>/dev/null)" '<!-- compaction-boundary'

# 12i. a project that was ALREADY active (has a HANDOFF.md) still gets full
#      onboard orientation - the HANDOFF.md pointer, capture-errors surfacing,
#      unconsumed-buffer warnings - even after .throughlineignore appears.
#      .throughlineignore means "stop adding new content", not "stop telling
#      me what already exists"; tl_data_exists (not tl_active) gates whether
#      there is anything to report.
FRESH_J="$WORK/fresh-j"
mkdir -p "$FRESH_J/.claude/throughline"
printf -- '# Test\n**Last Updated:** 2024-01-01\n' > "$FRESH_J/.claude/throughline/HANDOFF.md"
( cd "$FRESH_J" && git init -q && git commit -q --allow-empty -m init ) 2>/dev/null
: > "$FRESH_J/.throughlineignore"
O11=$(printf '%s' '{"source":"startup","session_id":"T"}' | CLAUDE_PROJECT_DIR="$FRESH_J" sh "$H/session-onboard.sh")
has "onboard still points to an existing HANDOFF.md despite .throughlineignore" "$O11" 'Durable handoff exists'

# 12j. the gitignore nudge fires even AFTER a HANDOFF.md exists, as long as
#      the buffer genuinely still is not covered - it used to be nested only
#      inside the "no HANDOFF.md yet" branch, so it permanently stopped firing
#      the moment the first handoff ran regardless of gitignore state.
FRESH_K="$WORK/fresh-k"
mkdir -p "$FRESH_K/.claude/throughline"
printf -- '# Test\n**Last Updated:** 2024-01-01\n' > "$FRESH_K/.claude/throughline/HANDOFF.md"
( cd "$FRESH_K" && git init -q && git commit -q --allow-empty -m init ) 2>/dev/null
O12=$(printf '%s' '{"source":"startup","session_id":"T"}' | CLAUDE_PROJECT_DIR="$FRESH_K" sh "$H/session-onboard.sh")
has "gitignore nudge still fires after a handoff has already run" "$O12" 'not gitignored yet'

# 12k. the gitignore nudge does not repeat on a `compact` re-fire within the
#      same already-running session - it still fires on genuinely new session
#      starts until the buffer is actually covered.
FRESH_L="$WORK/fresh-l"
mkdir -p "$FRESH_L"
( cd "$FRESH_L" && git init -q && git commit -q --allow-empty -m init ) 2>/dev/null
mkdir -p "$FRESH_L/.claude/throughline"
O13=$(printf '%s' '{"source":"compact","session_id":"T"}' | CLAUDE_PROJECT_DIR="$FRESH_L" sh "$H/session-onboard.sh")
hasnt "gitignore nudge is suppressed on a compact re-fire" "$O13" 'not gitignored yet'

# 12l. the gitignore nudge is skipped entirely when THROUGHLINE_DATA_DIR is an
#      absolute path OUTSIDE the project's own git tree (a documented,
#      supported cross-harness configuration) - `git check-ignore` on a path
#      outside the repo fails with a fatal error rather than "not ignored",
#      which the negated check would otherwise treat identically to "not
#      gitignored", printing an unsatisfiable warning on every SessionStart
#      forever (a path outside the repo can never be matched by that repo's
#      .gitignore).
FRESH_M="$WORK/fresh-m"
OUTSIDE_DATA="$WORK/outside-data"
mkdir -p "$FRESH_M"
( cd "$FRESH_M" && git init -q && git commit -q --allow-empty -m init ) 2>/dev/null
O14=$(printf '%s' '{"source":"startup","session_id":"T"}' | CLAUDE_PROJECT_DIR="$FRESH_M" THROUGHLINE_DATA_DIR="$OUTSIDE_DATA" sh "$H/session-onboard.sh")
hasnt "no gitignore nudge when the data dir is outside the git tree" "$O14" 'not gitignored yet'

# 12m. THROUGHLINE_DISABLE machine-wide kill switch: every hook is a complete
#      no-op - onboard is silent even about EXISTING data (stricter than
#      .throughlineignore, which keeps orienting), capture neither bootstraps
#      nor writes, and flush leaves an existing buffer unstamped. "0" and
#      empty do NOT disable.
FRESH_N="$WORK/fresh-n"
mkdir -p "$FRESH_N"
( cd "$FRESH_N" && git init -q && git commit -q --allow-empty -m init ) 2>/dev/null
O15=$(printf '%s' '{"source":"startup","session_id":"T"}' | CLAUDE_PROJECT_DIR="$FRESH_N" THROUGHLINE_DISABLE=1 sh "$H/session-onboard.sh")
eq "disabled: onboard is fully silent on a fresh project" "$O15" ""
absent "disabled: onboard does not bootstrap a data dir" "$FRESH_N/.claude"
printf '%s' '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"x","command":"id"}}' | CLAUDE_PROJECT_DIR="$FRESH_N" THROUGHLINE_DISABLE=1 sh "$H/session-capture.sh"
absent "disabled: capture writes nothing and creates nothing" "$FRESH_N/.claude"
# Silent even with pre-existing data (the .throughlineignore contrast).
O16=$(printf '%s' '{"source":"startup","session_id":"T"}' | THROUGHLINE_DISABLE=1 sh "$H/session-onboard.sh")
eq "disabled: onboard is silent even when project data exists" "$O16" ""
# Flush must not stamp an existing buffer while disabled; must still stamp
# normally once re-enabled (same payload, switch off).
reset_buf
printf -- '- `2026-01-01 00:00:00` **bash** x - `id`\n' > "$BUF/session-T.md"
printf '%s' '{"session_id":"T","reason":"exit"}' | THROUGHLINE_DISABLE=1 sh "$H/session-flush.sh"
hasnt "disabled: flush does not end-stamp the buffer" "$(cat "$BUF/session-T.md")" 'session-ended'
printf '%s' '{"session_id":"T","reason":"exit"}' | THROUGHLINE_DISABLE=0 sh "$H/session-flush.sh"
has "THROUGHLINE_DISABLE=0 does NOT disable (flush stamps normally)" "$(cat "$BUF/session-T.md")" 'session-ended'

# 12n. the SessionStart block surfaces the running plugin version (from
#      .claude-plugin/plugin.json) so a stale installed snapshot is visible -
#      the repo itself dogfooded a v0.1.0 cache while main sat at v0.4.0.
PLUGIN_VER=$(jq -r '.version' "$ROOT/.claude-plugin/plugin.json")
O17=$(printf '%s' '{"source":"startup","session_id":"T"}' | sh "$H/session-onboard.sh")
has "onboard header carries the plugin version" "$O17" "throughline v$PLUGIN_VER"

# 13. capture breadcrumbs a swallowed write failure and onboard surfaces it.
#     Chmod the SESSION FILE itself read-only (not the directory): appending to
#     an existing file is gated by the file's own write bit, independent of the
#     directory's permissions, so this isolates the final-write failure path
#     without also blocking the .capture-errors breadcrumb write that follows it.
#     Note: a "Permission denied" line on stderr here is expected — the shell
#     reports the failed >> redirection itself before the script's own
#     2>/dev/null on that line takes effect; it does not affect the assertions.
reset_buf
cap '{"session_id":"T2","tool_name":"Bash","tool_input":{"description":"seed","command":"id"}}'
if [ "$(id -u)" != "0" ]; then
  chmod 444 "$BUF/session-T2.md" 2>/dev/null
  printf '%s' '{"session_id":"T2","tool_name":"Bash","tool_input":{"description":"blocked","command":"id"}}' | sh "$H/session-capture.sh"
  chmod 644 "$BUF/session-T2.md" 2>/dev/null
  present "a write failure breadcrumbs to .capture-errors" "$DATA/.capture-errors"
  O6=$(printf '%s' '{"source":"startup","session_id":"X"}' | sh "$H/session-onboard.sh")
  has "onboard surfaces the capture-errors breadcrumb" "$O6" 'capture failure'
else
  ok "write-failure breadcrumb test skipped (running as root)"
  ok "onboard capture-errors surfacing test skipped (running as root)"
fi

# 13b. the breadcrumb survives the failure mode it exists to report: bufdir
#      itself cannot be created. Block "buffer" with a regular file (not a
#      directory, not a permission change) so `mkdir -p "$bufdir"` fails while
#      $data itself stays fully writable — proves the breadcrumb doesn't depend
#      on the very directory whose creation just failed.
reset_buf
rm -rf "$BUF"
printf 'not a directory' > "$BUF"
printf '%s' '{"session_id":"T4","tool_name":"Bash","tool_input":{"description":"x","command":"id"}}' | sh "$H/session-capture.sh"
present "mkdir failure still breadcrumbs (target is data-dir root, not buffer/)" "$DATA/.capture-errors"
rm -f "$BUF"
mkdir -p "$BUF"

# 14. UserPromptSubmit capture (issue #5): the buffer records intent, not just
#     actions. Shares the redaction pipeline with capture via tl_jq_redact_defs.
reset_buf
prompt '{"session_id":"P","prompt":"fix the login bug in the auth module"}'
has   "prompt hook records the prompt line" "$(cat "$BUF/session-P.md")" '**prompt** fix the login bug'
# Redaction on prompts uses the PROSE-SAFE path (redact_prompt): ONLY
# unambiguous structural signals are masked (known token prefixes, PEM,
# URL-userinfo, and length-gated Bearer/Token/Basic scheme values) — there is
# NO generic keyword+colon rule (see the def's comment for why: three rounds
# of boundary regex fixes each traded one false-positive/negative for a
# different one, and there is no boundary rule that admits "secrets:"/
# "passwords:" while excluding "author:"/"tokens:" — the shapes overlap).
# A known token-prefix shape is still caught even inside prose:
prompt '{"session_id":"P","prompt":"deploy with my key ghp_abcdefghij1234567890"}'
PS=$(grep 'deploy with' "$BUF/session-P.md")
hasnt "prompt: gh token not stored" "$PS" 'ghp_abcdefghij1234567890'
has   "prompt: gh token masked"     "$PS" '***'
# Prose safety: ordinary English containing credential KEYWORDS but no
# recognizable structural shape survives verbatim — the whole point of
# redact_prompt. The command path's copula/bare-space rule would mangle all
# of these; redact_prompt has no keyword rule at all to even attempt it.
prompt '{"session_id":"P","prompt":"my password is not the problem, the auth is stale"}'
has "prompt: prose after keyword+copula is preserved (not inverted)" "$(grep 'not the problem' "$BUF/session-P.md")" 'my password is not the problem, the auth is stale'
prompt '{"session_id":"P","prompt":"explain how the token refresh flow works"}'
has "prompt: 'token refresh' prose is preserved" "$(grep 'refresh flow' "$BUF/session-P.md")" 'the token refresh flow works'
prompt '{"session_id":"P","prompt":"author: rewrite the intro section"}'
has "prompt: 'author:' prose is preserved" "$(grep 'rewrite the intro' "$BUF/session-P.md")" 'author: rewrite the intro section'
# Deliberate, accepted gap (not a bug): a colon-form secret with no
# recognizable prefix/scheme is NOT masked in prompts — same class as
# `redact`'s documented bare-CLI-flag gap, backstopped by the handoff skill's
# human re-scan instead of a second automated layer. This also means the
# real-world plural phrasing the removed keyword rule mishandled ("secrets:",
# "passwords:", "credentials:") is now consistently left untouched rather than
# inconsistently redacted depending on suffix — documented here so a future
# reader doesn't mistake this for an oversight and re-add the keyword rule.
prompt '{"session_id":"P","prompt":"our secrets: hunter2superlongsecretvalue"}'
has "prompt: bare colon-form secret is a documented gap, not auto-masked" "$(grep 'our secrets' "$BUF/session-P.md")" 'our secrets: hunter2superlongsecretvalue'
prompt '{"session_id":"P","prompt":"client_secret: aB3xY9zQwErTyUiOp1234567890"}'
has "prompt: SCREAMING_SNAKE_CASE compound is the same documented gap" "$(grep client_secret "$BUF/session-P.md")" 'client_secret: aB3xY9zQwErTyUiOp1234567890'
# Structural scheme rules still catch a pasted Authorization header, INCLUDING
# the Token scheme (DRF/GitLab-style) — redact_prompt lacked this rule
# entirely until it was added alongside Bearer/Basic.
prompt '{"session_id":"P","prompt":"Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.fake.jwt.body"}'
hasnt "prompt: bearer JWT body not stored" "$(grep Authorization "$BUF/session-P.md")" 'eyJhbGciOiJIUzI1NiJ9'
reset_buf
prompt '{"session_id":"P","prompt":"Authorization: Token abcdefghijklmnopqrstuvwxyzTHISISAVERYLONGSECRETVALUE"}'
hasnt "prompt: Authorization Token value not stored" "$(cat "$BUF/session-P.md")" 'abcdefghijklmnopqrstuvwxyzTHISISAVERYLONGSECRETVALUE'
has   "prompt: Authorization Token scheme word preserved" "$(cat "$BUF/session-P.md")" 'Authorization: Token ***'
# The scheme rules must NOT fire on short English words after
# "bearer"/"basic"/"token" — this is the exact corruption class redact_prompt
# exists to prevent.
prompt '{"session_id":"P","prompt":"explain the bearer token approach for auth"}'
has "prompt: 'bearer token approach' prose is preserved" "$(grep 'bearer token approach' "$BUF/session-P.md")" 'the bearer token approach for auth'
prompt '{"session_id":"P","prompt":"we need basic authentication support"}'
has "prompt: 'basic authentication' prose is preserved" "$(grep 'basic authentication' "$BUF/session-P.md")" 'we need basic authentication support'
# Same documented length-gate gap applies to short real scheme values (a
# 8-15 char Bearer/Basic/Token value is not masked) — deliberate, not a bug.
prompt '{"session_id":"P","prompt":"Authorization: Basic dXNlcjpwdw=="}'
has "prompt: short Basic value is the same documented gap" "$(grep 'Authorization: Basic' "$BUF/session-P.md")" 'Authorization: Basic dXNlcjpwdw=='
# Truncation at 200 chars with the same marker as the Bash command path.
LONGP=$(printf 'x%.0s' $(seq 1 300))
prompt '{"session_id":"P","prompt":"'"$LONGP"'"}'
has "prompt: long prompt is truncated" "$(grep truncated "$BUF/session-P.md")" '…[truncated]'
# Empty / whitespace-only prompt writes no line.
reset_buf
prompt '{"session_id":"P2","prompt":"   "}'
absent "prompt: whitespace-only prompt writes no buffer file" "$BUF/session-P2.md"
prompt '{"session_id":"P2","prompt":""}'
absent "prompt: empty prompt writes no buffer file" "$BUF/session-P2.md"
# Opt-out and kill switch are honored (prompt uses tl_active like capture).
reset_buf
printf '' > "$WORK/proj/.throughlineignore"
prompt '{"session_id":"P3","prompt":"should be ignored"}'
absent "prompt: .throughlineignore suppresses capture" "$BUF/session-P3.md"
rm -f "$WORK/proj/.throughlineignore"
printf '%s' '{"session_id":"P4","prompt":"should be disabled"}' | THROUGHLINE_DISABLE=1 sh "$H/session-prompt.sh"
absent "prompt: THROUGHLINE_DISABLE suppresses capture" "$BUF/session-P4.md"
# Missing session_id drops the prompt and breadcrumbs (mirrors capture).
reset_buf
prompt '{"prompt":"no session id here"}'
present "prompt: missing session_id breadcrumbs to .capture-errors" "$DATA/.capture-errors"

# 15. widened PostToolUse capture (issue #6): high-signal read-side tools each
#     emit one redacted one-liner; MCP tools are name-only; Read/Glob are not
#     matched at all (excluded in hooks.json, so no branch is needed for them).
reset_buf
cap '{"session_id":"W","tool_name":"Grep","tool_input":{"pattern":"needle.*haystack"}}'
has "grep captured with pattern" "$(cat "$BUF/session-W.md")" '**grep** `needle.*haystack`'
cap '{"session_id":"W","tool_name":"WebFetch","tool_input":{"url":"https://alice:s3cr3tpw@example.com/doc"}}'
WF=$(grep webfetch "$BUF/session-W.md")
has   "webfetch captured with url"      "$WF" '**webfetch** https://alice:'
hasnt "webfetch url userinfo is masked" "$WF" 's3cr3tpw'
cap '{"session_id":"W","tool_name":"WebSearch","tool_input":{"query":"posix sh idempotency"}}'
has "websearch captured with query" "$(grep websearch "$BUF/session-W.md")" '**websearch** posix sh idempotency'
# Regression: WebSearch query is prose, so it must use redact_prompt, not the
# command-tuned redact — the bare-"token"-word rule would otherwise mangle a
# natural-language query like the command path does.
cap '{"session_id":"W","tool_name":"WebSearch","tool_input":{"query":"how to fix token refresh bug"}}'
has "websearch query prose is preserved (not mangled by command redact)" "$(grep 'refresh bug' "$BUF/session-W.md")" 'how to fix token refresh bug'
cap '{"session_id":"W","tool_name":"Task","tool_input":{"subagent_type":"Explore","description":"map the hook data flow"}}'
has "task captured with subagent + description" "$(grep '\*\*agent\*\*' "$BUF/session-W.md")" '**agent** Explore: map the hook data flow'
# Regression: Task description is prose (the delegated intent) — same
# redact_prompt requirement as WebSearch.
cap '{"session_id":"W","tool_name":"Task","tool_input":{"subagent_type":"Explore","description":"refactor the token handling code"}}'
has "task description prose is preserved (not mangled by command redact)" "$(grep 'handling code' "$BUF/session-W.md")" 'refactor the token handling code'
cap '{"session_id":"W","tool_name":"Task","tool_input":{"prompt":"no description, only a prompt body"}}'
has "task falls back to prompt when no description" "$(grep 'prompt body' "$BUF/session-W.md")" '**agent** no description'
# Empty-STRING description must fall through to prompt (jq // only skips null).
cap '{"session_id":"W","tool_name":"Task","tool_input":{"description":"","prompt":"intent lives in the prompt"}}'
has "task falls back to prompt on empty-string description" "$(grep 'intent lives' "$BUF/session-W.md")" '**agent** intent lives in the prompt'
cap '{"session_id":"W","tool_name":"mcp__github__create_pull_request","tool_input":{"title":"secret sauce"}}'
MC=$(grep 'mcp__github' "$BUF/session-W.md")
has   "mcp tool captured name-only"        "$MC" '**mcp__github__create_pull_request**'
hasnt "mcp tool input fields are not read" "$MC" 'secret sauce'
# Regression: a tool_name containing an asterisk is embedded DIRECTLY inside
# the **...** delimiter pair (unlike every other branch, which only puts field
# content after a fixed literal marker) — an unstripped asterisk would break
# the bold span and desync onboard's **[^*]+** classifier regex.
cap '{"session_id":"W","tool_name":"mcp__weird*tool","tool_input":{}}'
has "mcp tool_name asterisk is stripped, not embedded in the bold marker" "$(grep weirdtool "$BUF/session-W.md")" '**mcp__weirdtool**'

# 16. precompact stamp idempotency (issue #7): a double fire for one seam writes
#     one boundary; each genuine compaction (a captured action lands between)
#     still gets its own.
reset_buf
printf -- '- `t` **bash** first - `a`\n' > "$BUF/session-C.md"
precompact '{"session_id":"C","trigger":"auto"}'
precompact '{"session_id":"C","trigger":"auto"}'
eq "precompact: double fire writes one boundary" "$(grep -c '^<!-- compaction-boundary' "$BUF/session-C.md")" "1"
printf -- '- `t` **bash** second - `b`\n' >> "$BUF/session-C.md"
precompact '{"session_id":"C","trigger":"auto"}'
eq "precompact: a second genuine compaction gets its own boundary" "$(grep -c '^<!-- compaction-boundary' "$BUF/session-C.md")" "2"
# A later end-stamp after a boundary must not confuse the last-line guard.
printf -- '- `t` **bash** third - `c`\n' >> "$BUF/session-C.md"
precompact '{"session_id":"C","trigger":"auto"}'
eq "precompact: boundary after a post-boundary action stamps again" "$(grep -c '^<!-- compaction-boundary' "$BUF/session-C.md")" "3"

echo "----------------------"
printf 'passed: %s   failed: %s\n' "$PASS" "$FAIL"
rm -rf "$WORK"
[ "$FAIL" -eq 0 ]
