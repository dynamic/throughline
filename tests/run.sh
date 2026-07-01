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

# 10. onboard surfaces a prior session that ENDED (has the end-stamp) as
#     "unconsumed" — wording asserts a fact it can actually verify.
printf -- '- old\n<!-- session-ended 2024-01-01 00:00:00 (end) -->\n' > "$BUF/session-OLD.md"
O3=$(printf '%s' '{"source":"startup","session_id":"T"}' | sh "$H/session-onboard.sh")
has "ended prior session flagged as unconsumed" "$O3" 'unconsumed session buffer'

# 10b. a prior session buffer with NO end-stamp gets hedged wording, not
#      asserted as "ended" — it could be live in another terminal.
reset_buf
printf -- '- x\n' > "$BUF/session-T.md"
printf -- '- new\n' > "$BUF/session-LIVE.md"
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

echo "----------------------"
printf 'passed: %s   failed: %s\n' "$PASS" "$FAIL"
rm -rf "$WORK"
[ "$FAIL" -eq 0 ]
