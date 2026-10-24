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

# Fixtures below run `git commit` (and `git worktree add`, which needs a
# real commit to branch from) against throwaway repos under $WORK. Git
# refuses to commit without an author identity, and a bare CI runner has no
# global user.email/user.name configured (actions/checkout doesn't set one
# for the runner's global config, only for its own internal auth) — so on
# such a runner every fixture below silently failed the commit, which
# silently skipped worktree add (all of it chained with `&&` and swallowed
# by `2>/dev/null`), which left every downstream worktree-detection
# assertion resolving against a directory that was never created. That
# looked exactly like a bug in hooks/_lib.sh's worktree logic and wasn't —
# see dynamic/throughline#42. Setting these env vars (not global git config)
# makes every git commit in this script self-contained regardless of the
# ambient environment's identity config, matching how the rest of this
# script already avoids depending on ambient state.
GIT_AUTHOR_NAME="throughline-tests"
GIT_AUTHOR_EMAIL="throughline-tests@localhost"
GIT_COMMITTER_NAME="throughline-tests"
GIT_COMMITTER_EMAIL="throughline-tests@localhost"
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL

ROOT=$(unset CDPATH; cd -- "$(dirname -- "$0")/.." && pwd)
H="$ROOT/hooks"
PASSED=0
FAIL=0
SKIPPED_WINDOWS=0

# A few permission-based assertions below stage a POSIX mode bit (000/444/555)
# that NTFS's chmod emulation cannot reliably enforce the same way ext4/APFS
# do - those are skipped on Windows, same as the existing
# root-bypasses-permissions guard, and counted so the final summary says how
# many were skipped rather than the count silently reading lower with no
# explanation (the same transparency adrrr/persistent-handoff's own Windows
# leg documents for its skips).
#
# review finding (issue #67): checking only MSYSTEM fails OPEN, not closed -
# it's set by the Git-for-Windows wrapper bash.exe hands off to, not by the
# MSYS runtime itself, so anything invoking usr/bin/sh.exe or usr/bin/bash.exe
# directly (a plausible shape for how a harness spawns a command hook, and
# exactly the scenario this issue exists to cover) leaves it unset and the
# guards below would silently stop firing. `uname -s` (MINGW*/MSYS*/CYGWIN*)
# and $OS=Windows_NT come from the kernel/process environment directly, not a
# wrapper script, so either backstops the case MSYSTEM alone misses.
is_windows() {
  case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) return 0 ;; esac
  [ -n "${MSYSTEM:-}" ] || [ "${OS:-}" = "Windows_NT" ]
}
skip_win() { SKIPPED_WINDOWS=$((SKIPPED_WINDOWS + 1)); ok "$1 (skipped: NTFS chmod can't stage this)"; }

WORK=$(mktemp -d 2>/dev/null || echo "/tmp/tl-tests.$$")
mkdir -p "$WORK/proj/.claude/throughline/buffer"
CLAUDE_PROJECT_DIR="$WORK/proj"
THROUGHLINE_DATA_DIR=".claude/throughline"
export CLAUDE_PROJECT_DIR THROUGHLINE_DATA_DIR
# A developer running the suite with the machine-wide kill switch exported
# would otherwise see every hook no-op and the whole suite fail confusingly.
unset THROUGHLINE_DISABLE
DATA="$WORK/proj/.claude/throughline"
BUF="$DATA/buffer"

ok()  { PASSED=$((PASSED + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
has()    { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1 (missing: $3)"; printf '       got: %s\n' "$2" ;; esac; }
hasnt()  { case "$2" in *"$3"*) bad "$1 (unexpected: $3)"; printf '       got: %s\n' "$2" ;; *) ok "$1" ;; esac; }
# before <label> <haystack> <needle-A> <needle-B> - both substrings are
# present AND A appears before B (case-pattern `*A*B*` is a left-to-right
# greedy match, so this only succeeds when B occurs somewhere after A).
before() { case "$2" in *"$3"*"$4"*) ok "$1" ;; *) bad "$1 (want '$3' before '$4')"; printf '       got: %s\n' "$2" ;; esac; }
present(){ if [ -f "$2" ]; then ok "$1"; else bad "$1 (no file: $2)"; fi; }
dir_present(){ if [ -d "$2" ]; then ok "$1"; else bad "$1 (no dir: $2)"; fi; }
absent() { if [ -e "$2" ]; then bad "$1 (exists: $2)"; else ok "$1"; fi; }
eq()     { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }
cap()    { printf '%s' "$1" | sh "$H/session-capture.sh"; }
# cap_line <description> - the buffer line a `cap` fixture with this exact
# description wrote, matched on the whole description FIELD (`**bash** <desc> - `)
# rather than as a loose substring. Two reasons the bare `grep <desc>` used all
# over this file is not enough for the issue #81 assertions: descriptions are
# prefixes of each other (`mysqlescaq`/`mysqlescaq2`, `mysqlquoted`/
# `mysqlquotedsemi`/`mysqlquotedvar`, `mysqlampgt`/`mysqlampgtgt`/`mysqlampgtq`,
# `shortglpat`/`shortglpat2`), so a loose grep hands has()/hasnt() a haystack
# taken from a DIFFERENT fixture; and a fixture whose payload jq rejects makes
# the hook write NO line at all, so `hasnt "$(...)" 'SECRET'` is satisfied by the
# empty string and pins nothing - which is exactly how one #81 fixture passed for
# two rounds while carrying an invalid-JSON payload (review round 8). So every
# `hasnt` on a positive fixture is paired with a `has` on the mask sentinel: a
# missing line then fails instead of passing. The "exactly one line matched"
# check cannot live in this helper, because command substitution runs it in a
# subshell where a FAIL increment would be lost with the output.
cap_line() { grep -F "**bash** $1 - " "$BUF/session-T.md" 2>/dev/null; }
prompt() { printf '%s' "$1" | sh "$H/session-prompt.sh"; }
precompact() { printf '%s' "$1" | sh "$H/session-precompact.sh"; }
reset_buf() { rm -f "$BUF"/session-*.md "$DATA"/.capture-errors; mkdir -p "$BUF"; chmod 755 "$BUF" 2>/dev/null; }
# fixture_repo <dir> - git init + initial commit in <dir> (self-contained per
# the GIT_AUTHOR_* exports above). On failure, reports via bad() naming the
# dir instead of leaving the caller silently skipped - the same debugging
# trap #42/#43 closed for the worktree-specific chains, closed here for the
# remaining plain git-repo fixtures (#44). The dir/empty-arg guard exists
# because this helper's entire purpose is turning silent fixture failure
# loud - `cd ""` is a POSIX sh no-op that would otherwise silently git-init
# the caller's own cwd instead of failing.
fixture_repo() {
  if [ -z "${1:-}" ] || [ ! -d "$1" ]; then
    bad "fixture setup failed: ${1:-<empty>} (no such dir)"
    return
  fi
  ( cd "$1" && git init -q && git commit -q --allow-empty -m init ) 2>/dev/null \
    || bad "fixture setup failed: $1 (git init/commit)"
}
# fixture_repo_gitignore <dir> - same as fixture_repo, but for fixtures that
# stage and commit a pre-written .gitignore instead of an empty commit.
fixture_repo_gitignore() {
  if [ -z "${1:-}" ] || [ ! -d "$1" ]; then
    bad "fixture setup failed: ${1:-<empty>} (no such dir)"
    return
  fi
  ( cd "$1" && git init -q && git add .gitignore && git commit -q -m init ) 2>/dev/null \
    || bad "fixture setup failed: $1 (git init/add .gitignore/commit)"
}

fixture_repo "$WORK/proj"

# --- isolation guard (issue #189) ----------------------------------------------
# Every hook below must resolve its data dir under $WORK. Two layers:
#   1. Run from inside $WORK, so a hook that falls back to `pwd` (tl_root with no
#      CLAUDE_PROJECT_DIR) lands in the temp root, not the checkout the suite was
#      started from. The case checks below are a tripwire for edits to the
#      exports above, which every hook call inherits.
#   2. Snapshot the real data dirs this checkout would use (its own, and the main
#      checkout's when this is a linked worktree) before any hook runs, and fail
#      at the end if something a fixture produces appeared there: a buffer named
#      for a fixture session id, or the data dir itself created from nothing.
#      Anything else is left alone, because other sessions on the machine share
#      the main checkout's data dir and keep writing to it while the suite runs
#      (their own buffers, a handoff's logs/, .capture-errors, an archive temp
#      file). Real harness session ids are long (a UUID, OpenCode's ses_<base62>);
#      fixture ids are short. Keep every fixture session id at 16 characters or
#      fewer so the guard can tell them apart.
case "$CLAUDE_PROJECT_DIR" in
  "$WORK"/*) ;;
  *) echo "refusing to run: CLAUDE_PROJECT_DIR ($CLAUDE_PROJECT_DIR) is outside $WORK" >&2; exit 1 ;;
esac
case "$THROUGHLINE_DATA_DIR" in
  /*) echo "refusing to run: THROUGHLINE_DATA_DIR is absolute ($THROUGHLINE_DATA_DIR)" >&2; exit 1 ;;
esac
# iso_snapshot <dir>: sorted relative paths under <dir>, or the line ABSENT.
iso_snapshot() {
  if [ -d "$1" ]; then (cd "$1" && find . -print) | LC_ALL=C sort; else echo ABSENT; fi
}
# iso_leaks <snapshot-file> <dir>: fixture-shaped paths now under <dir> that were
# not in the snapshot: a short-id buffer (live or archived), or `.` when the
# whole data dir is new.
iso_leaks() {
  iso_snapshot "$2" | LC_ALL=C comm -13 "$1" - \
    | grep -E '^\./buffer/(archive/)?session-[^/]{1,16}\.md$|^\.$'
}
ISO_SENTINELS="$ROOT/.claude/throughline"
ISO_COMMON=$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) \
  && ISO_SENTINELS="$ISO_SENTINELS
$(dirname -- "$ISO_COMMON")/.claude/throughline"
ISO_N=0
printf '%s\n' "$ISO_SENTINELS" | while IFS= read -r d; do
  ISO_N=$((ISO_N + 1)); iso_snapshot "$d" > "$WORK/iso-before.$ISO_N"
done
cd "$WORK" || exit 1

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
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"secret","command":"export API_KEY=ghp_xxxxxxxxxxxx token"}}'
S=$(grep 'secret' "$BUF/session-T.md")
hasnt "token value is not stored" "$S" 'ghp_xxxxxxxxxxxx'
has   "token value is masked" "$S" '***'

# 2b. additional secret shapes: Google API key, PEM private key, Basic auth
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"gkey","command":"deploy --key AIzaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}}'
hasnt "google api key not stored" "$(grep gkey "$BUF/session-T.md")" 'AIzaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"pem","command":"echo -----BEGIN RSA PRIVATE'' KEY-----\nEXAMPLEKEYBODY\nEXAMPLEKEYBODY2\n-----END RSA PRIVATE'' KEY-----"}}'
hasnt "pem key body (with END marker) not stored" "$(grep pem "$BUF/session-T.md")" 'EXAMPLEKEYBODY'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"basicauth","command":"curl -H Authorization:Basic xxxxxxxxxxxxxxxxxx=="}}'
hasnt "basic-auth payload not stored" "$(grep basicauth "$BUF/session-T.md")" 'xxxxxxxxxxxxxxxxxx'

# 2c. PEM body with NO end marker (truncated/streamed key) is still redacted
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"pemnoeND","command":"echo -----BEGIN RSA PRIVATE'' KEY-----\nEXAMPLEKEYBODY\nEXAMPLETRAILER"}}'
hasnt "pem key body with NO end marker not stored" "$(grep pemnoeND "$BUF/session-T.md")" 'EXAMPLEKEYBODY'

# 2d. ghr_ refresh tokens are redacted (gh[oprsu]_ class, not gh[opsu]_)
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"ghrtok","command":"echo ghr_xxxxxxxxxxxx"}}'
hasnt "ghr_ refresh token not stored" "$(grep ghrtok "$BUF/session-T.md")" 'ghr_xxxxxxxxxxxx'

# 2e. broadened keyword alternation catches "credential" (not just token/secret/password)
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"credtest","command":"export DB_CREDENTIAL=xxxxxxxxxxxxxxxxxx"}}'
hasnt "DB_CREDENTIAL value not stored" "$(grep credtest "$BUF/session-T.md")" 'xxxxxxxxxxxxxxxxxx'

# 2e2. compound variable names (keyword immediately followed by more word
#      chars, not just preceded) are still redacted - these used to fall
#      through entirely since the keyword group had no trailing \w*.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"compoundkey","command":"export SECRET_KEY=xxxxxxxxxxxxxxx"}}'
hasnt "SECRET_KEY value not stored" "$(grep compoundkey "$BUF/session-T.md")" 'xxxxxxxxxxxxxxx'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"compoundapi","command":"export API_KEY_VALUE=xxxxxxxxxxxxxxx"}}'
hasnt "API_KEY_VALUE value not stored" "$(grep compoundapi "$BUF/session-T.md")" 'xxxxxxxxxxxxxxx'

# 2e3. the generic keyword=value rule must not re-swallow text the URL-userinfo
#      rule already redacted: a "token"/"secret" substring inside a URL
#      username (e.g. "x-access-token") used to make the generic rule's
#      unbounded value-capture eat through '@' and delete the trailing
#      host/path, not just mask the credential.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"clone","command":"git clone https://x-access-token:ghp_xxxxxxxxxxxx@github.com/foo/bar.git"}}'
CLONE_LINE=$(grep clone "$BUF/session-T.md")
hasnt "credential in URL userinfo is not stored" "$CLONE_LINE" 'ghp_xxxxxxxxxxxx'
has   "URL host/path after the credential is preserved, not deleted" "$CLONE_LINE" 'github.com/foo/bar.git'

# 2e4. a secret VALUE containing slashes (e.g. a realistic AWS-shaped key) is
#      fully redacted, not truncated at the first '/' - regression check for
#      the over-correction the @-exclusion-only fix above must not reintroduce.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"awskey","command":"export AWS_SECRET_ACCESS_KEY=xxxxxxxxxxxxxxx/xxxxxxxxxxxxx/xxxxxxxxxx"}}'
AWS_LINE=$(grep awskey "$BUF/session-T.md")
hasnt "AWS secret value (with slashes) is not stored" "$AWS_LINE" 'xxxxxxxxxxxxxxx/xxxxxxxxxxxxx/xxxxxxxxxx'
hasnt "AWS secret value is not even partially stored" "$AWS_LINE" 'K7MDENG'

# 2e5. dashed multi-segment sk- key formats (Anthropic sk-ant-, OpenAI
#      sk-proj-) are fully redacted, not left untouched by a body class that
#      only allowed alnum and rejected the internal dashes.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"anthropickey","command":"export ANTHROPIC_API_KEY=sk-ant-''api03-xxxxxxxxxxxxxxxxxxxxx"}}'
hasnt "sk-ant- key is not stored" "$(grep anthropickey "$BUF/session-T.md")" 'sk-ant-''api03-xxxxxxxxxxxxxxxxxxxxx'

# 2e6. natural-language "keyword is X" phrasing masks the real value X, not
#      the linking word "is" - the separator group used to only recognize
#      :/=/bare-whitespace, so the generic value-capture grabbed whatever
#      single word came right after the keyword regardless of what it was.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"prose","command":"my password is xxxxxxxxxxxxxxxxxxxxxxxxxx"}}'
hasnt "secret value after a copula (is/was/are) is not stored" "$(grep prose "$BUF/session-T.md")" 'xxxxxxxxxxxxxxxxxxxxxxxxxx'

# 2e7. "Authorization: Token <value>" (DRF/GitLab-style auth header) masks the
#      real key, not the scheme word "Token" itself - needs its own dedicated
#      rule alongside Bearer/Basic, since the generic rule would otherwise
#      treat "Token" as the value to redact and leave the real key exposed.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"drfauth","command":"curl -H Authorization: Token xxxxxxxxxxxxxxxxxx"}}'
hasnt "DRF-style Token value is not stored" "$(grep drfauth "$BUF/session-T.md")" 'xxxxxxxxxxxxxxxxxx'

# 2e8. a secret value that legitimately contains a literal @ (common in
#      human-chosen passwords) is fully masked, not truncated at the first @ -
#      the generic rule's value-capture has no @ exclusion at all now (the
#      sentinel-based redesign below removed the need for one), so this value
#      falls straight to the fully-unbounded branch and is masked whole.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"atpass","command":"export PASSWORD=my@stage123"}}'
hasnt "password value containing @ is not stored" "$(grep atpass "$BUF/session-T.md")" 'my@stage123'
hasnt "password value containing @ is not even partially stored" "$(grep atpass "$BUF/session-T.md")" 'stage123'

# 2e9. a URL credential with NO keyword anywhere nearby (so the generic rule
#      never visits that part of the line at all) still gets its internal
#      sentinel converted to *** by redact's own final catch-all sweep, not
#      left as a raw, never-cleaned-up internal marker in the buffer.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"plainclone","command":"curl https://user:hunter2@example.com/data"}}'
PLAIN_LINE=$(grep plainclone "$BUF/session-T.md")
hasnt "URL credential with no nearby keyword is not stored" "$PLAIN_LINE" 'hunter2'
hasnt "internal sentinel never leaks into the buffer" "$PLAIN_LINE" 'TLREDACTSENTINEL'
has   "URL host/path is preserved" "$PLAIN_LINE" 'example.com/data'

# 2e9b. issue #115: a scheme-relative reference (`git clone
#       //bob:hunter2@example.com/r`, a copy-pasted `//user:token@host/x`) has
#       its userinfo masked by `_url` exactly like a scheme-ful URL does - the
#       anchor is `//`, so a credential in userinfo position is a credential
#       whether or not a scheme precedes it. The host/path survive, and the
#       internal sentinel the rule hands the generic sweep is converted, not
#       left in the buffer.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"relclone","command":"git clone //bob:hunter2@example.com/r"}}'
REL_LINE=$(grep relclone "$BUF/session-T.md")
hasnt "scheme-relative URL credential is not stored" "$REL_LINE" 'hunter2'
has   "scheme-relative userinfo is masked in place" "$REL_LINE" '//bob:***@example.com/r'
has   "scheme-relative URL path is preserved" "$REL_LINE" 'example.com/r'
hasnt "internal sentinel never leaks for scheme-relative userinfo" "$REL_LINE" 'TLREDACTSENTINEL'

# 2e10. issue #15: a quoted secret value ("...") is fully masked with NO
#       orphaned trailing quote left in the output - the value-capture group
#       used to optionally consume a LEADING quote but never a matching
#       trailing one, so `password="X"` redacted to `password=***"` (the
#       secret itself was masked; only the stray quote was cosmetic, but it
#       is malformed output).
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"quotedpw","command":"config: password=\"xxxxxxxxxxxxxxxxxxxxx\""}}'
QUOTED_LINE=$(grep quotedpw "$BUF/session-T.md")
hasnt "quoted secret value is not stored" "$QUOTED_LINE" 'xxxxxxxxxxxxxxxxxxxxx'
hasnt "no orphaned trailing quote after the mask" "$QUOTED_LINE" '***"'
has   "quoted secret value is masked" "$QUOTED_LINE" 'password=***'

# 2e11. an UNTERMINATED quoted value (opening quote, no closing quote anywhere
#       after it - malformed/truncated input) is still masked rather than
#       silently falling through to cleartext, matching this rule's
#       pre-#15-fix behavior for exactly that shape.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"unclosedpw","command":"config: password=\"xxxxxxxxxxxxxxxxxxxxx"}}'
hasnt "unterminated quoted secret is not stored" "$(grep unclosedpw "$BUF/session-T.md")" 'xxxxxxxxxxxxxxxxxxxxx'

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

# 2h. issue #81: MySQL/MariaDB client-ANCHORED `-p<password>`. A generic -p
#       rule is impossible (-p is a port, a parallel flag, a print flag), so
#       the anchor is the CLIENT NAME, and the negative controls below are what
#       prove it is an anchor rather than an excuse: `ssh -p 2222`,
#       `docker run -u 1000:1000`, and a real `mysql -p <db>` (interactive
#       password prompt, so the next word is a database name) must ALL survive
#       untouched, and an -p on the far side of a pipe must not be swallowed
#       even with a client name earlier on the line.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlpw","command":"mysql -h db -u app -pS3cretPw dbname"}}'
MYSQL_LINE=$(cap_line mysqlpw)
hasnt "mysql -p<password> value is not stored" "$MYSQL_LINE" 'S3cretPw'
has   "mysql -p is masked in place, db name kept" "$MYSQL_LINE" '-p*** dbname'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"sshdump","command":"ssh host \"mysqldump -u x -pS3cretPw dbname\""}}'
hasnt "mysqldump over ssh: -p<password> value is not stored" "$(cap_line sshdump)" 'S3cretPw'
has   "mysqldump over ssh: mask sentinel is present" "$(cap_line sshdump)" '-p*** dbname'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqladminpw","command":"mysqladmin -h1 -pS3cretPw status"}}'
hasnt "mysqladmin -p<password> value is not stored" "$(cap_line mysqladminpw)" 'S3cretPw'
has   "mysqladmin -p<password>: mask sentinel is present" "$(cap_line mysqladminpw)" '-p*** status'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mariadbdumppw","command":"mariadb-dump --single-transaction -pS3cretPw dbname"}}'
hasnt "mariadb-dump -p<password> value is not stored" "$(cap_line mariadbdumppw)" 'S3cretPw'
has   "mariadb-dump -p<password>: mask sentinel is present" "$(cap_line mariadbdumppw)" '-p*** dbname'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlquoted","command":"mysql -u app -p\"pa ss\" dbname"}}'
MQ_LINE=$(cap_line mysqlquoted)
hasnt "quoted -p<password> is not stored, not even its second word" "$MQ_LINE" 'pa ss'
has   "quoted -p<password> is masked whole with no orphaned quote" "$MQ_LINE" '-p*** dbname'
# negative controls - the anchor, proven
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"sshport","command":"ssh -p 2222 host true"}}'
has   "ssh -p <port> is NOT masked by the client-anchored rule" "$(cap_line sshport)" 'ssh -p 2222'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"dockeruid","command":"docker run -u 1000:1000 img"}}'
has   "docker run -u <uid:gid> is NOT masked" "$(cap_line dockeruid)" '-u 1000:1000'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlinteractive","command":"mysql -p dbname"}}'
has   "bare mysql -p (interactive prompt) keeps the following db name" "$(cap_line mysqlinteractive)" 'mysql -p dbname'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlpipe","command":"mysql -u app db | ssh -p2222 host"}}'
PIPE_LINE=$(cap_line mysqlpipe)
has   "ssh -p2222 on the far side of a pipe is not swallowed" "$PIPE_LINE" 'ssh -p2222'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlsemi","command":"mysql db; tar -pczf x.tgz d"}}'
has   "tar -pczf after a semicolon is not swallowed" "$(cap_line mysqlsemi)" 'tar -pczf'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlandand","command":"mysqldump db && cp -pr a b"}}'
has   "cp -pr after && is not swallowed" "$(cap_line mysqlandand)" 'cp -pr'
# 2h2. the separator class must be QUOTE-AWARE. A trailing `;` inside `-e "..."`
#      is idiomatic MySQL, not a command boundary; a separator-blind span stops
#      at it, never reaches -p, and the password is written in plaintext. These
#      four lines are the exact shapes issue #81 reported.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlquotedsemi","command":"mysql -h db -u root -e \"show databases;\" -pS3cretPw"}}'
hasnt "semicolon inside a quoted -e does not stop the span" "$(cap_line mysqlquotedsemi)" 'S3cretPw'
has   "semicolon inside a quoted -e: mask sentinel is present" "$(cap_line mysqlquotedsemi)" '-p***'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqldumpwhere","command":"mysqldump --where=\"id=1 || id=2\" -pS3cretPw dbname"}}'
hasnt "|| inside a quoted --where does not stop the span" "$(cap_line mysqldumpwhere)" 'S3cretPw'
has   "|| inside a quoted --where: mask sentinel is present" "$(cap_line mysqldumpwhere)" '-p*** dbname'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlpipequote","command":"mysql -e \u0027a|b\u0027 -pS3cretPw dbname"}}'
hasnt "pipe inside a quoted -e does not stop the span" "$(cap_line mysqlpipequote)" 'S3cretPw'
has   "pipe inside a quoted -e: mask sentinel is present" "$(cap_line mysqlpipequote)" '-p*** dbname'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqltarget","command":"mysql -e \"select -pfoo from t\" -pS3cretPw dbname"}}'
TARGET_LINE=$(cap_line mysqltarget)
hasnt "the real -p after a quoted -pfoo is the one masked" "$TARGET_LINE" 'S3cretPw'
has   "the -pfoo inside the SQL string is left as the text it is" "$TARGET_LINE" '-pfoo from t'
# 2h3. client coverage: every MySQL/MariaDB client that takes -p<password>, not
#      just the two names the first report happened to contain.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"cl_mysqlpump","command":"mysqlpump -u x -pxxxx dbname"}}'
hasnt "mysqlpump -p<password> value is not stored" "$(cap_line cl_mysqlpump)" 'xxxx'
has   "mysqlpump -p<password>: mask sentinel is present" "$(cap_line cl_mysqlpump)" '-p*** dbname'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"cl_mysqlcheck","command":"mysqlcheck -u x -pxxxx dbname"}}'
hasnt "mysqlcheck -p<password> value is not stored" "$(cap_line cl_mysqlcheck)" 'xxxx'
has   "mysqlcheck -p<password>: mask sentinel is present" "$(cap_line cl_mysqlcheck)" '-p*** dbname'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"cl_mysql_upgrade","command":"mysql_upgrade -u x -pxxxx dbname"}}'
hasnt "mysql_upgrade -p<password> value is not stored" "$(cap_line cl_mysql_upgrade)" 'xxxx'
has   "mysql_upgrade -p<password>: mask sentinel is present" "$(cap_line cl_mysql_upgrade)" '-p*** dbname'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"cl_mariadb-check","command":"mariadb-check -u x -pxxxx dbname"}}'
hasnt "mariadb-check -p<password> value is not stored" "$(cap_line cl_mariadb-check)" 'xxxx'
has   "mariadb-check -p<password>: mask sentinel is present" "$(cap_line cl_mariadb-check)" '-p*** dbname'
# 2h4. value shapes. A password can legitimately be a command substitution, an
#      escaped-space run, or have a quote glued onto its end; each must be
#      consumed whole, with no fragment and no orphaned tail left behind.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlsubst","command":"mysql -u root -p$''(echo xxxx) dbname"}}'
SUB_LINE=$(cap_line mysqlsubst)
hasnt "command-substitution -p value is consumed whole" "$SUB_LINE" 'xxxx)'
has   "command-substitution -p value: mask sentinel is present" "$SUB_LINE" '-p*** dbname'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlescapedspace","command":"mysql -u root -pS3cret\\ with\\ space dbname"}}'
ESC_LINE=$(cap_line mysqlescapedspace)
hasnt "escaped-space -p value is not stored (first chunk)" "$ESC_LINE" 'S3cret'
hasnt "escaped-space -p value is not stored (tail chunk)" "$ESC_LINE" 'space dbname'
has   "escaped-space -p value: mask sentinel is present" "$ESC_LINE" '-p*** dbname'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlgluedquote","command":"mysql -u root -paS3cret\u0027x y\u0027 dbname"}}'
hasnt "quote glued onto a bare -p value is consumed whole" "$(cap_line mysqlgluedquote)" 'x y'
has   "quote glued onto a bare -p value: mask sentinel is present" "$(cap_line mysqlgluedquote)" '-p*** dbname'
# 2h5. KNOWN FALSE POSITIVE, pinned so it is a documented trade and not a
#      surprise. The anchor is a word, not a parse position, so a line that only
#      MENTIONS a mysql path and then carries an unrelated -p masks that -p too.
#      Over-redacting captured command text is the safe side of this trade; the
#      alternatives need a shell parse, or would leak a password that happens to
#      look like a port mapping.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlfpfind","command":"find /var/lib/mysql -name x.ibd -print"}}'
has "known false positive: find -print after a mysql path is masked too" "$(cap_line mysqlfpfind)" '-p***'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlfpdocker","command":"docker run --name mysql -p3306:3306 mysql:8"}}'
has "known false positive: docker -p3306:3306 after a mysql name is masked too" "$(cap_line mysqlfpdocker)" '-p***'

# 2i. issue #81: extended vendor token PREFIX allowlist (glpat-, sk_live_/
#     rk_test_, xapp-, npm_, SG.x.y). Each floor is set above anything an
#     ordinary word or identifier could be, and the cases at the end pin that:
#     a 19-char glpat body and vendor-shaped identifiers stay unmasked.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"gitlabpat","command":"glab api -H \"X: glpat-''xxxxxxxxxxxxxxxxxxxx\""}}'
hasnt "gitlab glpat- token not stored" "$(cap_line gitlabpat)" 'glpat-''xxxxxxxxxxxxxxxxxxxx'
has   "gitlab glpat- token: mask sentinel is present" "$(cap_line gitlabpat)" 'glpat-***'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"stripelive","command":"deploy --key sk_live_''xxxxxxxxxxxxxxxxxx"}}'
hasnt "stripe sk_live_ key not stored" "$(cap_line stripelive)" 'sk_live_''xxxxxxxxxxxxxxxxxx'
has   "stripe sk_live_ key: mask sentinel is present" "$(cap_line stripelive)" 'sk_live_***'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"striperestricted","command":"deploy --key rk_test_''xxxxxxxxxxxxxxxxxx"}}'
hasnt "stripe rk_test_ key not stored" "$(cap_line striperestricted)" 'rk_test_''xxxxxxxxxxxxxxxxxx'
has   "stripe rk_test_ key: mask sentinel is present" "$(cap_line striperestricted)" 'rk_test_***'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"slackapp","command":"echo xapp-''1-xxxxxxxxxxxx-xxxxxxxxxxxxxxxx-xxxxxxxxxx"}}'
hasnt "slack xapp- token not stored" "$(cap_line slackapp)" 'xapp-''1-xxxxxxxxxxxx-xxxxxxxxxxxxxxxx-xxxxxxxxxx'
has   "slack xapp- token: mask sentinel is present" "$(cap_line slackapp)" 'xapp-***'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"npmtoken","command":"echo npm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}}'
hasnt "npm_ automation token not stored" "$(cap_line npmtoken)" 'npm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
has   "npm_ automation token: mask sentinel is present" "$(cap_line npmtoken)" 'npm_***'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"sendgrid","command":"mail --key SG.''xxxxxxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxxxxxx"}}'
hasnt "sendgrid SG. key not stored" "$(cap_line sendgrid)" 'SG.''xxxxxxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxxxxxx'
has   "sendgrid SG. key: mask sentinel is present" "$(cap_line sendgrid)" 'SG.***'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"shortglpat","command":"echo glpat-''xxxxxxxxxxxxxxxxxxx"}}'
has   "a 19-character glpat body is NOT masked (the 20 floor is real)" "$(cap_line shortglpat)" 'glpat-''xxxxxxxxxxxxxxxxxxx'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"shortglpat2","command":"echo glpat-abc"}}'
has   "a too-short glpat- sample is NOT masked" "$(cap_line shortglpat2)" 'glpat-abc'

# 2i-b. issue #175: every prefix in GitLab's token table
#       (https://docs.gitlab.com/security/tokens/), each with a positive row and
#       two negatives: a 19-character body (under the 20 floor) and the prefix
#       glued onto a longer identifier. Values are assembled at run time so this
#       file carries no token-shaped literal.
GL_BODY=xxxxxxxxxxxxxxxxxxxx
GL_SHORT=xxxxxxxxxxxxxxxxxxx
for gp in glpat gloas gldt glrt glrtr glcbt glptt glft glimt glagent glwt glsoat glffct; do
  cap "{\"session_id\":\"T\",\"tool_name\":\"Bash\",\"tool_input\":{\"description\":\"glprefix-$gp\",\"command\":\"curl -H X:$gp-$GL_BODY\"}}"
  hasnt "gitlab $gp- token not stored" "$(cap_line "glprefix-$gp")" "$gp-$GL_BODY"
  has   "gitlab $gp- token: mask keeps the prefix" "$(cap_line "glprefix-$gp")" "X:$gp-***"
  cap "{\"session_id\":\"T\",\"tool_name\":\"Bash\",\"tool_input\":{\"description\":\"glshort-$gp\",\"command\":\"echo $gp-$GL_SHORT big$gp-$GL_BODY\"}}"
  has   "gitlab $gp-: a 19-character body and a glued identifier are NOT masked" "$(cap_line "glshort-$gp")" "$gp-$GL_SHORT big$gp-$GL_BODY"
done
# Routable tokens carry a `.<version>.<length+crc32>` tail; the whole token is
# masked, and a sentence-ending period after it survives.
cap "{\"session_id\":\"T\",\"tool_name\":\"Bash\",\"tool_input\":{\"description\":\"glroutable\",\"command\":\"echo glpat-$GL_BODY.00.0x0000000. done\"}}"
hasnt "routable glpat- tail not stored" "$(cap_line glroutable)" '.00.0x0000000'
has   "routable glpat- token masked whole; the trailing period survives" "$(cap_line glroutable)" 'echo glpat-***. done'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"glsession","command":"curl -b _gitlab_session=0000xxxx0000xxxx0000xxxx0000xxxx https://gitlab.example"}}'
hasnt "_gitlab_session cookie value not stored" "$(cap_line glsession)" '0000xxxx0000xxxx'
has   "_gitlab_session cookie: mask keeps the cookie name" "$(cap_line glsession)" '_gitlab_session=*** https://gitlab.example'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"glsessionneg","command":"echo my_gitlab_session=0000xxxx0000xxxx0000 _gitlab_session=short"}}'
has   "a longer name ending in _gitlab_session and a short value are NOT masked" "$(cap_line glsessionneg)" 'my_gitlab_session=0000xxxx0000xxxx0000 _gitlab_session=short'
# Prefix rules are LEFT-ANCHORED as well as length-floored: an identifier that
# merely CONTAINS one of these prefixes is not a credential. The anchor is a
# lookbehind and not \b on purpose - underscore is a word character, so \b gives
# no boundary between `disk` and `_test_`, which is exactly how `disk_test_…` was
# getting masked as a Stripe key.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"msgprop","command":"cat MSG.errorMessageTemplate.userNotFoundError"}}'
has   "MSG.* identifier is not mistaken for a SendGrid key" "$(cap_line msgprop)" 'MSG.errorMessageTemplate.userNotFoundError'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"xappid","command":"ls xapp-config-generator"}}'
has   "xapp-config-generator identifier is not mistaken for a Slack token" "$(cap_line xappid)" 'xapp-config-generator'
# The lookbehind on its own, isolated from the length floor and from the digit
# segment: each of these CONTAINS a real prefix mid-word.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"disktest","command":"echo disk_test_''xxxxxxxxxxxxxxxxxx"}}'
has   "disk_test_ is not mistaken for a Stripe key" "$(cap_line disktest)" 'disk_test_''xxxxxxxxxxxxxxxxxx'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"fooxapp","command":"echo fooxapp-''1-xxxxxxxxxxxx-xxxxxxxxxxxxxxxx"}}'
has   "fooxapp- is not mistaken for a Slack token" "$(cap_line fooxapp)" 'fooxapp-''1-xxxxxxxxxxxx-xxxxxxxxxxxxxxxx'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mynpm","command":"echo mynpm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}}'
has   "mynpm_ is not mistaken for an npm token" "$(cap_line mynpm)" 'mynpm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'

# 2i2. the span must cross the things that LOOK like separators but are not: a
#      backslash-newline continuation (that chain is ONE command, and capture
#      sees its newlines before clean turns them into spaces, so a same-line-only
#      rule misses the whole shape), a file-descriptor redirect, and bash's `&>`
#      combined redirect. In the first cap below the JSON escape sequence is two
#      backslashes followed by n-backslash-n: the doubled backslash decodes to ONE
#      literal backslash and the following escape decodes to a newline, so jq
#      hands the hook a real shell line continuation. The earlier cut of this
#      fixture had a doubled-backslash-n only, which is a backslash followed by
#      the LETTER n - one ordinary line, which the span reaches without its
#      continuation alternative, so that case passed with the alternative deleted
#      and proved nothing (issue #81 review round 6). A
#      newline with NO continuation stays a hard stop - that is the control which
#      keeps the positive cases from being an accident of a match-anything span.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlcont","command":"mysqldump \\\n  -u root \\\n  -pS3cretPw dbname"}}'
hasnt "line-continued mysqldump still reaches -p<password>" "$(cap_line mysqlcont)" 'S3cretPw'
has   "line-continued mysqldump: mask sentinel is present" "$(cap_line mysqlcont)" '-p*** dbname'
# issue #81 review round 8: the continuation line ABOVE is indented, which hid a
# second shape. The span consumes the backslash AND the newline as one step, so a
# continuation that starts at column 0 leaves no whitespace between them and the
# flag, and a tail requiring `\s` never matches - `mysqldump db \` + newline +
# `-p<pw> db` is a valid command (the space before the backslash is the argument
# separator) and its password went through in cleartext. The tail now also accepts
# a just-crossed backslash-newline via two fixed-length lookbehinds.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlcont0","command":"mysqldump db \\\n-pS3cretPw dbname"}}'
hasnt "a continuation line at column 0 still reaches -p<password>" "$(cap_line mysqlcont0)" 'S3cretPw'
has   "column-0 continuation: mask sentinel is present" "$(cap_line mysqlcont0)" '-p*** dbname'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlredir","command":"mysql -h h 2>&1 -pS3cretPw db"}}'
hasnt "a 2>&1 redirect between client and flag does not stop the span" "$(cap_line mysqlredir)" 'S3cretPw'
has   "a 2>&1 redirect: mask sentinel is present" "$(cap_line mysqlredir)" '-p*** db'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlampgt","command":"mysqladmin ping &>/dev/null -pS3cretPw"}}'
hasnt "a &> combined redirect does not stop the span" "$(cap_line mysqlampgt)" 'S3cretPw'
has   "a &> combined redirect: mask sentinel is present" "$(cap_line mysqlampgt)" '-p***'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlampgtgt","command":"mysqldump db &>>/tmp/out.log -pS3cretPw"}}'
hasnt "a &>> append redirect does not stop the span" "$(cap_line mysqlampgtgt)" 'S3cretPw'
has   "a &>> append redirect: mask sentinel is present" "$(cap_line mysqlampgtgt)" '-p***'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlampgtq","command":"mysql &>/dev/null \"-pS3cret\" db"}}'
hasnt "the quoted rule crosses &> the same way the span does" "$(cap_line mysqlampgtq)" 'S3cret'
has   "the quoted rule crossing &> leaves the quoted mask sentinel" "$(cap_line mysqlampgtq)" '"-p***"'
# negative controls for the new redirect alternative: a bare `&` (background) and
# `&&` ARE separators, so the &> alternative must not swallow what follows them.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlbareamp","command":"mysqldump db & ssh -p2222 host"}}'
has   "a backgrounded & still stops the span" "$(cap_line mysqlbareamp)" 'ssh -p2222'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlampampq","command":"mysql -uroot && rsync \"-pavz\" src dst"}}'
has   "a quoted -pavz after && is NOT masked" "$(cap_line mysqlampampq)" 'rsync "-pavz" src dst'
# 2i2b. escaped quotes inside the span (issue #81 review round 7). `-e "select
#      \"it's\"" -p<pw>` is a normal way to put an apostrophe in SQL: the quoted
#      run used to end at the escaped quote, the stray apostrophe then read as
#      opening a run that never closed, and the password went through in
#      cleartext. The negative control keeps this from being fixed by a span that
#      simply walks through any quote: the same escaped-quote payload on a line
#      with no client name stays exactly as typed. THE FIXTURE PAYLOAD ITSELF
#      MATTERS: this one used to end `-e \"select \\\"it's\\\"" -p<pw>`, whose
#      final `"` closes the JSON string early, so jq rejected the payload, the
#      hook wrote NO line, and the `hasnt` below was satisfied by the sibling
#      fixture's already-masked line (loose grep, see cap_line) - two rounds of
#      "passing" while testing nothing. The payload is now escaped so the decoded
#      command really is `-e "select \"it's\""`, verified by running `jq .` on the
#      payload and by the sentinel assertion under it (a payload jq rejects writes
#      no buffer line, which is invisible to a `hasnt` and loud to a `has`).
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlescaq","command":"mysql -uroot -e \"select \\\"it\u0027s\\\"\" -pS3cretPw db"}}'
hasnt "an escaped quote inside -e does not stop the span" "$(cap_line mysqlescaq)" 'S3cretPw'
has   "an escaped quote inside -e: mask sentinel is present" "$(cap_line mysqlescaq)" '-p*** db'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlescaq2","command":"mysql -e \"a\\\"b\" -pS3cretPw db"}}'
hasnt "an escaped double quote inside -e does not stop the span" "$(cap_line mysqlescaq2)" 'S3cretPw'
has   "an escaped double quote inside -e: mask sentinel is present" "$(cap_line mysqlescaq2)" '-p*** db'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlrecesq","command":"mysql --init-command=don\\\u0027t -pS3cretPw db"}}'
hasnt "an escaped single quote outside a quoted run does not stop the span" "$(cap_line mysqlrecesq)" 'S3cretPw'
has   "an escaped single quote outside a run: mask sentinel is present" "$(cap_line mysqlrecesq)" '-p*** db'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"grepescaq","command":"grep -e \"a\\\"b\" file.txt"}}'
has   "the same escaped-quote payload with no client name is NOT masked" "$(cap_line grepescaq)" 'grep -e "a\"b" file.txt'
# the escaped-separator side of the same branch: `\;` is a literal argument in a
# shell, not a boundary, so the span crosses it - an over-match on the safe side,
# pinned rather than left to be rediscovered.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlescsep","command":"mysql -e \"x\" \\; ssh -p2222 host"}}'
has   "an escaped \; is a literal argument, so the span crosses it" "$(cap_line mysqlescsep)" '-p***'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlmulti","command":"mysqldump dbname\nssh -p2222 host"}}'
has   "a plain newline is still a hard stop for the span" "$(cap_line mysqlmulti)" 'ssh -p2222'
# 2i1b. backtracking regression: 12+ file-descriptor redirects with NO -p must
#      NOT cause regex failure (Oniguruma retry-limit-in-match). The span group
#      is atomic (?> … ) so it is O(n) regardless of redirect count.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysql12redirects","command":"mysql 2>&1 2>&1 2>&1 2>&1 2>&1 2>&1 2>&1 2>&1 2>&1 2>&1 2>&1 2>&1"}}'
has   "12+ redirects without -p does not cause regex failure" "$(cap_line mysql12redirects)" 'mysql 2>&1'
# 2i1b2. issue #130: the SAME failure class in the GENERIC keyword=value rule (the
#      `(?<k>...)` gsub in `def redact`), not just in the mysql span. Its keyword
#      group was an unanchored `\w*(?:token|password|...)\w*`, so a long word run
#      with no separator in it - `password=x ` followed by thousands of `tokena` -
#      made Oniguruma exhaust its retry budget: `Regex failure:
#      retry-limit-in-match over`. That aborts the hook's ENTIRE jq pipeline, so
#      session-capture writes NO buffer line: the event is silently dropped,
#      secrets included. Both size assertions below are therefore `has` on the
#      captured line, never `hasnt` on a secret - an empty haystack satisfies
#      `hasnt` and would have made this fixture green while the event was being
#      dropped (the same trap cap_line's note above closed for #81). The group is
#      now `(?:(?<!\w)|(?<=\(M)))(?<k>(?>\w*...\w*))`: the lookbehind drops
#      redundant start positions inside a word run, the atomic group drops
#      redundant re-entries once the separator fails at the run's end, and the
#      `(?<=\(M))` alternative keeps the one legitimate mid-run start (the
#      post-sentinel resume position - pinned by the kwsentinel fixture below).
#      The lookbehind and the atomic group are both needed: on a 96 KB run the
#      lookbehind alone still hit the retry limit and the atomic group alone crawled
#      (no per-machine numbers here - they go stale; the measurements taken while
#      landing this are in dynamic/throughline#160, the PR that anchored this rule).
#
#      The fixture length is asserted first: a `tl_repeat` that silently produced a
#      short string would make these pass on the PRE-fix regex, which is the one
#      way this block could lie. Built by concatenation rather than
#      `printf %.0s $(seq N)` so it needs no coreutils beyond what the suite
#      already assumes.
tl_repeat() {
  tl_w=$1; tl_n=$2; tl_o=''
  while [ "$tl_n" -gt 0 ]; do tl_o="$tl_o$tl_w"; tl_n=$((tl_n - 1)); done
  printf '%s' "$tl_o"
}
tl_run6k=$(tl_repeat tokena 1000)
if [ "${#tl_run6k}" -ne 6000 ]; then
  bad "issue #130 6 KB fixture built ${#tl_run6k} chars, expected 6000 (fixture broken, not the hook)"
fi
cap "{\"session_id\":\"T\",\"tool_name\":\"Bash\",\"tool_input\":{\"description\":\"kwrun6k\",\"command\":\"password=x $tl_run6k\"}}"
has   "6 KB word run after 'password=x ' is redacted, not dropped (issue #130)" "$(cap_line kwrun6k)" 'password=***'
tl_run24k=$(tl_repeat tokena 4000)
if [ "${#tl_run24k}" -ne 24000 ]; then
  bad "issue #130 24 KB fixture built ${#tl_run24k} chars, expected 24000 (fixture broken, not the hook)"
fi
cap "{\"session_id\":\"T\",\"tool_name\":\"Bash\",\"tool_input\":{\"description\":\"kwrun24k\",\"command\":\"password=x $tl_run24k\"}}"
has   "24 KB word run after 'password=x ' is redacted, not dropped (issue #130)" "$(cap_line kwrun24k)" 'password=***'
#      And the lookbehind's own character class - which is asymmetric, so it needs
#      two fixtures pointing opposite ways. The class is `(?<!\w)` rather than the
#      `(?<![A-Za-z0-9_])` some other rules in this file use, and the two failure
#      directions are NOT equal. WIDENING it (a class that also counts `-`, say
#      `(?<![A-Za-z0-9_-])`) LEAKS: in `mydb --token=zz` the only position the match
#      can start at is the `t`, because `-` is not a `\w` so the leading `\w*` cannot
#      absorb it - reject that position and the value stays in cleartext. NARROWING
#      it cannot leak at all: dropping characters from the class only ADMITS extra
#      start positions, which costs doomed backtracking and never rejects a start
#      that would otherwise work.
#      `kwaccent` is the narrow-direction case, not a pin on the class. On jq 1.8.2
#      `\w` does not count `é`, so `(?<!\w)` and `(?<![A-Za-z0-9_])` agree on this
#      input and both keep the keyword masked - the fixture stays GREEN under the
#      ASCII-only lookbehind, which is the correct outcome (a narrower class is a
#      latency bug, not a disclosure), and it is what proves that. What it pins is
#      that a non-ASCII-prefixed keyword still masks through the anchor.
#      `kwclasswide` is the direction that actually leaks, and it is the fixture that
#      goes red under the widening above: `sh tests/run.sh` against a one-character
#      widening of the lookbehind class returns `mydb --token=zz` in cleartext, and
#      the same suite on an ASCII-only (narrower) lookbehind stays green).
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwaccent","command":"éPASSWORD=zz"}}'
has   "a keyword glued to a non-ASCII letter is still masked (issue #130)" "$(cap_line kwaccent)" 'éPASSWORD=***'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwclasswide","command":"mydb --token=zz"}}'
has   "a keyword glued to a hyphen flag is masked; a lookbehind class wider than the keyword class would leak it (issue #130)" "$(cap_line kwclasswide)" 'mydb --token=***'
hasnt "a keyword glued to a hyphen flag: value not stored (issue #130)" "$(cap_line kwclasswide)" '--token=zz'
#      And the one start position inside a word run the lookbehind must KEEP. gsub
#      resumes after the previous match, and the sentinel value alternative ends
#      mid-run (the sentinel is all word characters), so the second keyword here only
#      gets masked if that resume position stays admissible. Anchoring without it
#      masks LESS than the pre-fix rule - the leak direction - and the first cut of
#      this fix did exactly that until the plugin's jq-parity suite caught it, so it
#      is pinned on the hooks side too and not only over there.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwsentinel","command":"password=TLREDACTSENTINELtoken=x"}}'
has   "a keyword glued to a masked sentinel value is still masked (issue #130)" "$(cap_line kwsentinel)" 'token=***'
hasnt "a keyword glued to a masked sentinel: value not stored" "$(cap_line kwsentinel)" 'token=x'
# 2i1b3. issue #173: the rules run in sequence over rewritten text, so a rule whose
#      value is a whitespace-separated word could swallow a keyword a later rule
#      needed (`token password: X` stored as `Token *** X`). `_backstop` reads the
#      ORIGINAL text, takes the value after every keyword head on its own, and masks
#      any of those values the pipeline left visible. It only adds masks, so each row
#      here checks that the secret marker never reaches the buffer; a few also pin
#      the shape.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwhtokcolon","command":"echo token password: S3cretPw"}}'
has   "kwhtokcolon: masked shape (issue #173)" "$(cap_line kwhtokcolon)" 'Token *** ***'
hasnt "kwhtokcolon: secret not stored (issue #173)" "$(cap_line kwhtokcolon)" 'S3cretPw'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwhtokcop","command":"echo token password is S3cretPw"}}'
hasnt "kwhtokcop: secret not stored (issue #173)" "$(cap_line kwhtokcop)" 'S3cretPw'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwhtokbare","command":"echo TOKEN password S3cretPw ok"}}'
hasnt "kwhtokbare: secret not stored (issue #173)" "$(cap_line kwhtokbare)" 'S3cretPw'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwhbearer","command":"echo Bearer password: S3cretPw"}}'
has   "kwhbearer: masked shape (issue #173)" "$(cap_line kwhbearer)" 'Bearer ***: ***'
hasnt "kwhbearer: secret not stored (issue #173)" "$(cap_line kwhbearer)" 'S3cretPw'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwhbeareq","command":"echo bearer secret=S3cretPw"}}'
hasnt "kwhbeareq: secret not stored (issue #173)" "$(cap_line kwhbeareq)" 'S3cretPw'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwhbasic","command":"echo basic password: S3cretPw"}}'
hasnt "kwhbasic: secret not stored (issue #173)" "$(cap_line kwhbasic)" 'S3cretPw'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwhgeneric","command":"echo auth password: S3cretPw"}}'
has   "kwhgeneric: masked shape (issue #173)" "$(cap_line kwhgeneric)" 'auth *** ***'
hasnt "kwhgeneric: secret not stored (issue #173)" "$(cap_line kwhgeneric)" 'S3cretPw'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwhgenbare","command":"echo password token S3cretPw ok"}}'
hasnt "kwhgenbare: secret not stored (issue #173)" "$(cap_line kwhgenbare)" 'S3cretPw'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwhchain3","command":"echo token token token: S3cretPw"}}'
hasnt "kwhchain3: secret not stored (issue #173)" "$(cap_line kwhchain3)" 'S3cretPw'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwhchainsep","command":"echo auth secret password: S3cretPw"}}'
hasnt "kwhchainsep: secret not stored (issue #173)" "$(cap_line kwhchainsep)" 'S3cretPw'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwhspacedeq","command":"echo token password = S3cretPw"}}'
hasnt "kwhspacedeq: secret not stored (issue #173)" "$(cap_line kwhspacedeq)" 'S3cretPw'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwhquoted","command":"echo token password \"S3cretPw two\""}}'
hasnt "kwhquoted: secret not stored (issue #173)" "$(cap_line kwhquoted)" 'S3cretPw'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwhsegment","command":"echo Bearer svc_token_zzS3cretPw is expired"}}'
hasnt "kwhsegment: secret not stored (issue #173)" "$(cap_line kwhsegment)" 'S3cretPw'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwhhyphen","command":"echo Bearer my-api-key-S3cretPw is invalid"}}'
hasnt "kwhhyphen: secret not stored (issue #173)" "$(cap_line kwhhyphen)" 'S3cretPw'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwhexplicit","command":"echo password=secret: S3cretPw"}}'
hasnt "kwhexplicit: secret not stored (issue #173)" "$(cap_line kwhexplicit)" 'S3cretPw'
#      A keyword-shaped secret before a bare space, a bare chain of even length, and a
#      value behind a scheme word with an explicit separator (passes B and C).
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwhkwvalue","command":"echo password TOKEN: mytokenS3cretPw ok"}}'
hasnt "kwhkwvalue: secret not stored (issue #173)" "$(cap_line kwhkwvalue)" 'mytokenS3cretPw'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwhbare4","command":"echo password token secret auth S3cretPw"}}'
hasnt "kwhbare4: secret not stored (issue #173)" "$(cap_line kwhbare4)" 'S3cretPw'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwhscheme","command":"echo --token=Bearer: S3cretPw"}}'
hasnt "kwhscheme: secret not stored (issue #173)" "$(cap_line kwhscheme)" 'S3cretPw'
#      Scheme words are heads only with an explicit separator: `Basic test` (bare space,
#      under `_auth_scheme`'s 8-character floor) is left alone.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwhbasicshort","command":"echo Basic test"}}'
has   "kwhbasicshort: a short word after a bare scheme word is not masked (issue #173)" "$(cap_line kwhbasicshort)" 'Basic test'
#      Whole-token replacement: a value that also occurs inside a longer word is not
#      masked there (`PASSWORD` must not eat the tail of `DB_PASSWORD`), and a closing
#      quote is never read as a value.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwhwholetok","command":"export DB_PASSWORD SECRET PASSWORD S3cretPw"}}'
has   "kwhwholetok: a value is masked only as a whole token (issue #173)" "$(cap_line kwhwholetok)" 'DB_PASSWORD'
hasnt "kwhwholetok: secret not stored (issue #173)" "$(cap_line kwhwholetok)" 'S3cretPw'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwhclosequote","command":"curl -H \"Authorization: Basic zzauthzzzz=\" host"}}'
has   "kwhclosequote: a closing quote is not read as a value (issue #173)" "$(cap_line kwhclosequote)" '*** ***" host'
hasnt "kwhclosequote: Basic value not stored (issue #173)" "$(cap_line kwhclosequote)" 'zzauthzzzz'
#      Ordinary commands are unchanged from the pipeline's own output.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"kwhordinary","command":"git commit -m \"fix token refresh flow\""}}'
has   "kwhordinary: ordinary command keeps the pipeline's shape (issue #173)" "$(cap_line kwhordinary)" 'fix Token *** flow'
#      Bounded: a long keyword chain stays a single linear pass and is not dropped.
tl_kwchain=$(i=0; while [ $i -lt 2000 ]; do printf 'token '; i=$((i+1)); done)
cap "{\"session_id\":\"T\",\"tool_name\":\"Bash\",\"tool_input\":{\"description\":\"kwhlongchain\",\"command\":\"$tl_kwchain: S3cretPw\"}}"
has   "kwhlongchain: a 2000-keyword chain is captured, not dropped (issue #173)" "$(cap_line kwhlongchain)" 'Token ***'
# 2i1c. quoted -p<value> inside double quotes (the container-entrypoint shape
#      mysql -uroot "-p$PW" db): the span group consumes the full quoted run
#      including the -p. The pre-rule _mysql_pw_pre catches this shape.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlquotedvar","command":"mysql -uroot \"-pS3cret\" db"}}'
hasnt "quoted -p<value> inside double-quotes is masked" "$(cap_line mysqlquotedvar)" 'S3cret'
has   "masked quoted -p value has sentinel" "$(cap_line mysqlquotedvar)" '"-p***"'

# 2i1c2. the OTHER whole-argument quoted shapes (issue #81 review round 5). A
#      quoted run that OPENS before the -p is a different case from `-p'val'`
#      (2i3), and the span rule cannot enter it for the same reason it cannot
#      enter the double-quoted one above. `'-p<value>'` was the repro round 3
#      gave and round 4 still missed; a double-quoted value containing a space
#      was missed by the first cut of the pre rule, whose value group could not
#      cross the space. Each positive case below is paired with a control that
#      keeps the SAME quoted argument unmasked, so the fix cannot be restored by
#      a rule that simply masks every "-p..." it sees.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlqspace","command":"mysql -uroot \"-pS3cret word\" db"}}'
QSPACE=$(cap_line mysqlqspace)
hasnt "double-quoted -p value with a space: whole value not stored" "$QSPACE" 'S3cret word'
has   "double-quoted -p value with a space is masked whole" "$QSPACE" '"-p***"'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlqsingle","command":"mysql -h db \u0027-pS3cret\u0027 db"}}'
QSQ=$(cap_line mysqlqsingle)
hasnt "single-quoted whole-argument -p<value> is not stored" "$QSQ" 'S3cret'
has   "single-quoted whole-argument -p<value> is masked whole" "$QSQ" "'-p***'"
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlqaftersemi","command":"mysql -e \u0027show databases;\u0027 \u0027-pS3cret\u0027"}}'
hasnt "single-quoted -p after a quoted -e is still reached" "$(cap_line mysqlqaftersemi)" 'S3cret'
has   "single-quoted -p after a quoted -e: mask sentinel is present" "$(cap_line mysqlqaftersemi)" "'-p***'"
# issue #81 review round 8: a double-quoted shell string can carry an ESCAPED
# quote, and the whole-argument value body was `[^"]*`, which stops at the first
# `"` escaped or not - `"-pSE\"CRET"` masked to `"-p***"CRET`, the rest of the
# password in cleartext. The double-quoted body now steps over `\.`; the
# single-quoted one stays `[^']*` because a single-quoted shell string has no
# escapes to step over.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlqescval","command":"mysql -uroot \"-pSE\\\"CRET\" db"}}'
hasnt "escaped quote inside a quoted -p value does not cut the mask short" "$(cap_line mysqlqescval)" 'CRET'
has   "quoted -p value with an escaped quote: mask sentinel is present" "$(cap_line mysqlqescval)" '"-p***"'
# issue #81 review round 9: the whole-argument quoted shape ALSO appears inside an
# OUTER double-quoted command, where both quotes are written `\"` - `ssh prod
# "mysqldump -uroot \"-p<pw>\" app"` and `docker exec db sh -c "mysql -uroot
# \"-p<pw>\" app"`. The pre-rule only accepted a bare `"` before `-p` and the span
# rule, after stepping over `\"`, landed on a `-p` with no whitespace in front of
# it, so the two shapes this PR calls important combined into nothing. Related case
# in the same review: `mysqldump -p\"S3cret Pw\"` (an escaped-quoted value on the
# SPAN side) masked only up to the space inside it, leaving the second word of the
# password stored; the compound value run now takes an escaped-quoted run as one
# alternative, listed before the generic escaped-character step.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlouterdq","command":"docker exec db sh -c \"mysql -uroot \\\"-pS3cretPw\\\" app\""}}'
hasnt "escaped-quoted -p inside an outer double-quoted command is not stored" "$(cap_line mysqlouterdq)" 'S3cretPw'
has   "escaped-quoted -p inside an outer command: mask sentinel is present" "$(cap_line mysqlouterdq)" '-p***'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlouterssh","command":"ssh prod \"mysqldump -uroot \\\"-pS3cretPw\\\" app\""}}'
hasnt "ssh-wrapped escaped-quoted -p is not stored" "$(cap_line mysqlouterssh)" 'S3cretPw'
has   "ssh-wrapped escaped-quoted -p: mask sentinel is present" "$(cap_line mysqlouterssh)" '-p***'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlouterspan","command":"ssh prod \"mysqldump -p\\\"S3cret Pw\\\" app\""}}'
hasnt "escaped-quoted -p value with a space is consumed whole on the span side" "$(cap_line mysqlouterspan)" 'S3cret Pw'
has   "escaped-quoted -p value with a space: mask sentinel is present" "$(cap_line mysqlouterspan)" '-p*** app'
# The same review round's second finding: the pre-rule dropped the part of the
# password GLUED on after the closing quote, which is the worst kind of leak - the
# `***` makes the line look redacted while the whole password sits after it. Each of
# these is ONE shell argument, so the compound run after the closing quote belongs
# to the value; the controls above (a space after the closing quote stops the run)
# keep ordinary `"-p" db` text intact.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlqgluebare","command":"mysql -uroot \"-p\"S3cretPw db"}}'
hasnt "value glued after a closing double quote is not stored" "$(cap_line mysqlqgluebare)" 'S3cretPw'
has   "value glued after a closing double quote: mask sentinel is present" "$(cap_line mysqlqgluebare)" '"-p***" db'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlqgluemid","command":"mysql -uroot \"-pS3c\"retPw db"}}'
hasnt "value glued mid-argument after a double quote is not stored" "$(cap_line mysqlqgluemid)" 'retPw'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlqgluesingle","command":"mysql -uroot \u0027-pS3c\u0027retPw db"}}'
hasnt "value glued mid-argument after a single quote is not stored" "$(cap_line mysqlqgluesingle)" 'retPw'
# Round 9's third finding is the mirror image: the lead was `\\s`, which matches a
# PLAIN newline too, so the span stopped before the newline, the lead swallowed it,
# and a `-p` starting the NEXT line got masked - against the claim this file and the
# CHANGELOG both make and against the `mysqlmulti` control below it. The lead is
# `[ \\t]` plus the two continuation lookbehinds now. The value here is a fake
# literal; what the test pins is the boundary.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqlnlhard0","command":"mysqldump db\n-pS3cretPw dbname"}}'
has   "a plain newline stops the span even when the next line starts with -p" "$(cap_line mysqlnlhard0)" '-pS3cretPw dbname'
# negative controls: the pre rule is ANCHORED like the span rule, so a quoted
# -p on a line with no client name, or one across a command separator from the
# client name, is ordinary text and stays exactly as typed.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"grepqflag","command":"grep \"-pattern\" file.txt"}}'
has   "grep \"-pattern\" is NOT masked (no client name to anchor on)" "$(cap_line grepqflag)" 'grep "-pattern" file.txt'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"rsyncqflag","command":"rsync \u0027-pavz\u0027 src dst"}}'
has   "rsync single-quoted -pavz is NOT masked" "$(cap_line rsyncqflag)" "rsync '-pavz' src dst"
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"echoqflag","command":"echo \"-pfoo\""}}'
has   "echo \"-pfoo\" is NOT masked" "$(cap_line echoqflag)" 'echo "-pfoo"'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"pipeqflag","command":"mysql --version | grep \"-pattern\" f"}}'
has   "quoted -pattern across a pipe from a client name is NOT masked" "$(cap_line pipeqflag)" 'grep "-pattern" f'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"notclientq","command":"notmysql \"-pZ9\" db"}}'
has   "a non-client binary name does not anchor the quoted rule either" "$(cap_line notclientq)" 'notmysql "-pZ9" db'

# 2i3. glued value tails. In a real shell `-p'abc'def` is ONE argument that
#      concatenates a quoted part with a bare part, and a value alternation that
#      matched the quoted part first left `-def` - part of the password - sitting
#      in cleartext immediately after the mask. The value group is one compound
#      run for exactly this reason.
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqltailsingle","command":"mysql -u root -p\u0027abc\u0027def dbname"}}'
hasnt "bare tail glued after a quoted -p value is not stored" "$(cap_line mysqltailsingle)" 'def dbname'
has   "bare tail after a quoted -p value: mask sentinel is present" "$(cap_line mysqltailsingle)" '-p*** dbname'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqltaildouble","command":"mysql -u root -p\"pa ss\"word dbname"}}'
hasnt "bare tail glued after a double-quoted -p value is not stored" "$(cap_line mysqltaildouble)" 'word dbname'
has   "bare tail after a double-quoted -p value: mask sentinel is present" "$(cap_line mysqltaildouble)" '-p*** dbname'
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"mysqltailsubst","command":"mysql -u root -p$''(echo f)tail dbname"}}'
hasnt "bare tail glued after a command substitution is not stored" "$(cap_line mysqltailsubst)" 'tail dbname'
has   "bare tail after a command substitution: mask sentinel is present" "$(cap_line mysqltailsubst)" '-p*** dbname'

# 2f. redaction applies to the Bash *description* field, not just command
cap '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"deploy with ghp_xxxxxxxxxxxx","command":"true"}}'
DESC_LINE=$(grep '\*\*bash\*\* deploy' "$BUF/session-T.md")
hasnt "token in description is not stored" "$DESC_LINE" 'ghp_xxxxxxxxxxxx'
has   "token in description is masked" "$DESC_LINE" '***'

# 2g. redaction applies to Edit/Write/NotebookEdit file_path, not just Bash command
cap '{"session_id":"T","tool_name":"Write","tool_input":{"file_path":"'"$WORK"'/proj/tmp/sk-''xxxxxxxxxxxxxxxxxxxx.xxx"}}'
PATH_LINE=$(grep '\*\*Write\*\*' "$BUF/session-T.md")
hasnt "token in file_path is not stored" "$PATH_LINE" 'sk-xxxxxxxxxxxxxxxxxxxx'
has   "token in file_path is masked" "$PATH_LINE" '***'

# 3. path relativization (Edit, Write, NotebookEdit, and the "?" fallback)
reset_buf
cap '{"session_id":"T","tool_name":"Edit","tool_input":{"file_path":"'"$WORK"'/proj/src/app.js"}}'
E=$(grep Edit "$BUF/session-T.md")
has   "Edit path is relativized to project root" "$E" 'src/app.js'
hasnt "Edit path drops the absolute prefix" "$E" "$WORK"
cap '{"session_id":"T","tool_name":"Write","tool_input":{"file_path":"'"$WORK"'/proj/src/new.js"}}'
W=$(grep '\*\*Write\*\*' "$BUF/session-T.md")
has   "Write path is relativized to project root" "$W" 'src/new.js'
# review finding: only the Edit assertion above checked for the ABSENCE of
# the absolute prefix - Write and NotebookEdit share the identical
# relativization code path and would fail identically (as they briefly did
# on Windows, per env.root vs. --arg root above) without anyone catching it,
# since "the tail is present" alone stays true even when the prefix was
# never stripped.
hasnt "Write path drops the absolute prefix" "$W" "$WORK"
cap '{"session_id":"T","tool_name":"NotebookEdit","tool_input":{"notebook_path":"'"$WORK"'/proj/nb/a.ipynb"}}'
NB=$(grep NotebookEdit "$BUF/session-T.md")
has   "NotebookEdit uses notebook_path fallback" "$NB" 'nb/a.ipynb'
hasnt "NotebookEdit path drops the absolute prefix" "$NB" "$WORK"
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

# 5e. issue #31: a LINKED git worktree shares its data dir with the MAIN
#     working tree instead of accumulating its own - the fix for handoff data
#     silently stranding per-worktree. THROUGHLINE_DATA_DIR stays at the
#     harness-wide relative default (".claude/throughline") for these cases,
#     so the only variable is which root it resolves against.
WT_MAIN="$WORK/wt-main"
mkdir -p "$WT_MAIN"
( cd "$WT_MAIN" && git init -q && git commit -q --allow-empty -m init \
    && git worktree add -q "$WORK/wt-linked" -b feat ) 2>/dev/null \
  || bad "fixture setup failed: wt-linked (git init/commit/worktree add)"
WT_LINK="$WORK/wt-linked"
D_LINK=$(CLAUDE_PROJECT_DIR="$WT_LINK" sh -c '. "'"$H"'/_lib.sh"; tl_data_dir')
has   "linked worktree data dir points at the MAIN tree" "$D_LINK" "wt-main/.claude/throughline"
hasnt "linked worktree data dir is NOT under the worktree itself" "$D_LINK" "wt-linked/.claude"

# 5e2. the main working tree still resolves to its own data dir (no-op case -
#      tl_data_root falls through to tl_root when git-dir == git-common-dir).
D_MAIN=$(CLAUDE_PROJECT_DIR="$WT_MAIN" sh -c '. "'"$H"'/_lib.sh"; tl_data_dir')
has "main working tree resolves to its own data dir" "$D_MAIN" "wt-main/.claude/throughline"

# 5e3. THROUGHLINE_WORKTREE_SHARED=0 opts back into the old per-worktree
#      behavior - the documented escape hatch for parallel-feature-work users
#      who want isolated handoffs per worktree.
D_OPT=$(THROUGHLINE_WORKTREE_SHARED=0 CLAUDE_PROJECT_DIR="$WT_LINK" sh -c '. "'"$H"'/_lib.sh"; tl_data_dir')
has "THROUGHLINE_WORKTREE_SHARED=0 keeps per-worktree data dirs" "$D_OPT" "wt-linked/.claude/throughline"

# 5e4. onboard surfaces the sharing note (issue #31 review point: the
#      redirection must not be silent, or the original confusion - "why did my
#      handoff not show up?" - just relocates instead of resolving).
O_WT=$(printf '%s' '{"source":"startup","session_id":"T"}' | CLAUDE_PROJECT_DIR="$WT_LINK" sh "$H/session-onboard.sh")
has "onboard notes worktree data sharing" "$O_WT" 'shared with the main working tree'

# 5e5. and does NOT print that note from the main working tree, where droot
#      and root are the same - only a linked worktree needs the redirect
#      surfaced.
O_MAIN=$(printf '%s' '{"source":"startup","session_id":"T"}' | CLAUDE_PROJECT_DIR="$WT_MAIN" sh "$H/session-onboard.sh")
hasnt "onboard does not note sharing from the main working tree" "$O_MAIN" 'shared with the main working tree'

# 5e6. migration safety (issue #31 review finding): a linked worktree that
#      ALREADY accumulated its own data dir before worktree-sharing existed
#      keeps resolving to its own root - the shared main tree has no data of
#      its own yet, so redirecting would make the pre-existing HANDOFF.md
#      silently invisible rather than just relocating where new data lands.
WT_OLD_MAIN="$WORK/wt-old-main"
mkdir -p "$WT_OLD_MAIN"
( cd "$WT_OLD_MAIN" && git init -q && git commit -q --allow-empty -m init \
    && git worktree add -q "$WORK/wt-old-linked" -b old ) 2>/dev/null \
  || bad "fixture setup failed: wt-old-linked (git init/commit/worktree add)"
WT_OLD_LINK="$WORK/wt-old-linked"
mkdir -p "$WT_OLD_LINK/.claude/throughline"
printf -- '# Test\n**Last Updated:** 2024-01-01\n' > "$WT_OLD_LINK/.claude/throughline/HANDOFF.md"
D_OLD=$(CLAUDE_PROJECT_DIR="$WT_OLD_LINK" sh -c '. "'"$H"'/_lib.sh"; tl_data_dir')
has "a worktree with PRE-EXISTING data keeps resolving to its own root" "$D_OLD" "wt-old-linked/.claude/throughline"

# 5e6b. issue #42 review finding: onboard's sharing note must NOT fire for
#       this worktree - it is deliberately NOT sharing (the migration guard
#       above keeps it on its own root). _tl_compute_data_root() used to
#       return this branch's path raw (uncanonicalized) while every other
#       branch returned canonical, so on a symlinked $WORK (true of macOS's
#       mktemp -d, /tmp -> /private/tmp) onboard's raw-vs-canonical
#       comparison saw two different-looking strings for the SAME directory
#       and wrongly printed a sharing note - the exact opposite of what this
#       branch exists to guarantee. Both sides of that comparison are
#       canonical now; this pins the observable (the printed message), not
#       just the internal path value 5e6 above already checks.
O_OLD=$(printf '%s' '{"source":"startup","session_id":"T"}' | CLAUDE_PROJECT_DIR="$WT_OLD_LINK" sh "$H/session-onboard.sh")
hasnt "onboard does not claim sharing for a worktree keeping its own data" "$O_OLD" 'shared with the main working tree'

# 5e7. once the shared main root ALSO has data (or is later adopted), sharing
#      applies going forward - the migration guard only protects data that
#      would otherwise be stranded, not a permanent per-worktree carve-out.
mkdir -p "$WT_OLD_MAIN/.claude/throughline"
printf -- '# Main\n**Last Updated:** 2024-06-01\n' > "$WT_OLD_MAIN/.claude/throughline/HANDOFF.md"
D_OLD2=$(CLAUDE_PROJECT_DIR="$WT_OLD_LINK" sh -c '. "'"$H"'/_lib.sh"; tl_data_dir')
has "once main tree also has data, the worktree still keeps its own (guard is sticky, not one-shot)" "$D_OLD2" "wt-old-linked/.claude/throughline"

# 5e8. the .throughlineignore opt-out check honors a marker at EITHER the
#      shared main root OR the session's own worktree root (issue #31 review
#      finding): a marker a user placed in their own worktree before
#      worktree-sharing existed must keep working, not be silently ignored
#      the moment the shared main root becomes the sole place checked.
WT_IGN_MAIN="$WORK/wt-ign-main"
mkdir -p "$WT_IGN_MAIN"
( cd "$WT_IGN_MAIN" && git init -q && git commit -q --allow-empty -m init \
    && git worktree add -q "$WORK/wt-ign-linked" -b ign ) 2>/dev/null \
  || bad "fixture setup failed: wt-ign-linked (git init/commit/worktree add)"
WT_IGN_LINK="$WORK/wt-ign-linked"
: > "$WT_IGN_LINK/.throughlineignore"
O_IGN=$(printf '%s' '{"source":"startup","session_id":"T"}' | CLAUDE_PROJECT_DIR="$WT_IGN_LINK" sh "$H/session-onboard.sh")
eq "a legacy per-worktree .throughlineignore is still honored after upgrading" "$O_IGN" ""
absent "no data dir bootstrapped under the shared main root" "$WT_IGN_MAIN/.claude"

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
#     Bound is TL_COMPACT_TAIL_LINES=20 (issue #64 shrunk it from 30 to keep
#     this block's worst-case size well under Claude Code's undocumented
#     SessionStart output cap), so of 40 written lines only the last 20
#     (line21-line40) are inlined.
reset_buf
i=1
while [ "$i" -le 40 ]; do
  printf -- '- `t` **bash** line%s - `cmd%s`\n' "$i" "$i" >> "$BUF/session-T.md"
  i=$((i + 1))
done
O_TAIL=$(printf '%s' '{"source":"compact","session_id":"T"}' | sh "$H/session-onboard.sh")
hasnt "onboard(compact) tail excludes a line beyond the bound" "$O_TAIL" 'cmd20`'
has   "onboard(compact) tail includes the first line within the bound" "$O_TAIL" 'cmd21`'
has   "onboard(compact) tail includes the most recent line" "$O_TAIL" 'cmd40`'

# 7b2. issue #64: live git state renders BEFORE the compaction-tail inline,
#      not after - the tail's size depends on how much was captured and is
#      the block most likely to push total output past whatever undocumented
#      limit Claude Code applies to SessionStart output; git state is small
#      and bounded and has no fallback pointer of its own if it gets cut, so
#      it must not be the thing sitting after a large, truncatable block.
before "onboard(compact) live git state precedes the buffer-tail inline" \
  "$O_TAIL" 'Live git state' 'Context was just compacted'

# 7b3. review finding: `head -20` bounds the live-git-state block's LINE
#      COUNT but not each line's WIDTH - `git status -s` prints one line per
#      modified tracked file regardless of path depth, so a single very long
#      path is truncated per-line the same way an oversized buffer-tail line
#      already is (7c below), keeping this block bounded on both axes the
#      way its "renders first, has no fallback" placement (7b2) assumes.
# Path length is tuned deliberately, not just "as long as possible": the
# repo-relative path needs to push a git-status line past
# TL_GIT_STATUS_LINE_CHARS=200, but the FULL filesystem path (this fixture's
# $WORK prefix included) must stay under Windows' classic 260-character
# MAX_PATH - review finding: the original version of this fixture exceeded
# it and failed to even stage on Windows CI (git init/add/commit itself
# failed), never reaching the assertion this test exists to make.
FRESH_LONGPATH="$WORK/fresh-longpath"
LONGPATH="a/very/deeply/nested/directory/structure/for/testing"
LONGNAME="a_generated_file_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.txt"
mkdir -p "$FRESH_LONGPATH/$LONGPATH"
: > "$FRESH_LONGPATH/$LONGPATH/$LONGNAME"
( cd "$FRESH_LONGPATH" && git init -q && git config core.longpaths true && git add -A && git commit -q -m init ) 2>/dev/null \
  || bad "fixture setup failed: $FRESH_LONGPATH (git init/add/commit)"
printf -- 'changed\n' >> "$FRESH_LONGPATH/$LONGPATH/$LONGNAME"
O_LONGPATH=$(printf '%s' '{"source":"startup","session_id":"T"}' | CLAUDE_PROJECT_DIR="$FRESH_LONGPATH" sh "$H/session-onboard.sh")
# git status prints the path RELATIVE to the repo root, not the fixture's
# absolute $FRESH_LONGPATH prefix - assert against the repo-relative form,
# the same string the untruncated line would actually contain.
hasnt "onboard(startup) does not inline an oversized git-status line verbatim" "$O_LONGPATH" "$LONGPATH/$LONGNAME"
has   "onboard(startup) marks a truncated oversized git-status line" "$O_LONGPATH" '…[line truncated]'

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
# 2>/dev/null'd). Skipped when running as root, which bypasses permissions,
# or on Windows/NTFS, which can't stage an unreadable-to-owner file (see
# is_windows() above).
if is_windows; then
  skip_win "unreadable-buffer stderr test"
elif [ "$(id -u)" != "0" ]; then
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
# A tiny exec wrapper script per tool, not `ln -sf` or `cp`: a symlink needs
# an elevated privilege Windows doesn't grant by default (issue #67), and a
# COPY of the real binary is worse - on macOS a Homebrew-built binary can
# resolve its shared libraries via an @executable_path-relative reference,
# which breaks (hangs or crashes) once the binary is relocated to $STUB. A
# plain `#!/bin/sh -c 'exec <real> "$@"'` wrapper needs no privilege beyond
# writing a text file and never touches the real binary's own location.
STUB="$WORK/bin"; mkdir -p "$STUB"
for c in sh dirname cat grep git tr head awk sed; do
  real=$(command -v "$c" 2>/dev/null) || continue
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$real" > "$STUB/$c"
  chmod +x "$STUB/$c"
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
fixture_repo "$FRESH_A"
O5=$(printf '%s' '{"source":"startup","session_id":"T"}' | CLAUDE_PROJECT_DIR="$FRESH_A" sh "$H/session-onboard.sh")
has     "onboard is no longer silent on a fresh project" "$O5" 'throughline'
dir_present "auto-activation created the configured data dir" "$FRESH_A/.claude/throughline"

# 12b. same, but THROUGHLINE_DATA_DIR UNSET -> auto-activates at the plugin's
#      own default path. Must explicitly unset in a subshell: the harness's
#      global export (set once at the top of this file for every other test's
#      convenience) would otherwise mask this exact case.
FRESH_B="$WORK/fresh-b"
mkdir -p "$FRESH_B"
fixture_repo "$FRESH_B"
O6=$(printf '%s' '{"source":"startup","session_id":"T"}' | (unset THROUGHLINE_DATA_DIR; CLAUDE_PROJECT_DIR="$FRESH_B" sh "$H/session-onboard.sh"))
has     "onboard auto-activates at the default path when unset" "$O6" 'throughline'
dir_present "default .claude/throughline/ dir created when unset" "$FRESH_B/.claude/throughline"

# 12c. a .throughlineignore marker at the project root disables throughline
#      unconditionally, even though auto-activation would otherwise apply -
#      the opt-out escape hatch.
FRESH_C="$WORK/fresh-c"
mkdir -p "$FRESH_C"
fixture_repo "$FRESH_C"
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
fixture_repo "$FRESH_D"
printf '%s' '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"x","command":"id"}}' | CLAUDE_PROJECT_DIR="$FRESH_D" sh "$H/session-capture.sh"
present "capture-first auto-activates and writes a buffer entry" "$FRESH_D/.claude/throughline/buffer/session-T.md"

# 12e. a FAILED bootstrap must not look identical to a deliberate
#      .throughlineignore opt-out: onboard surfaces a distinct warning rather
#      than staying silent, so the failure is diagnosable instead of
#      masquerading as "user opted out."
FRESH_E="$WORK/fresh-e"
mkdir -p "$FRESH_E"
fixture_repo "$FRESH_E"
if is_windows; then
  skip_win "failed-bootstrap warning test"
  skip_win "failed-bootstrap no-dir-created test"
  skip_win "failed-bootstrap path-relativization test"
elif [ "$(id -u)" != "0" ]; then
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

# 12f. first activation nudges toward gitignoring bufdir/ specifically - the
#      one path that must ALWAYS stay untracked - but only when it is not
#      already covered, using git's own ignore resolution rather than a
#      hand-rolled pattern match. Checks bufdir/ itself, not a coarser
#      ancestor like the whole data dir: an earlier draft checked the whole
#      dir on the theory that it should normally all be covered under the
#      new local-only-by-default policy, but `check-ignore` on a directory
#      path can report "ignored" via a directory-glob pattern (e.g.
#      `.claude/throughline/*`) even when a specific file inside it is
#      genuinely untracked per `git status` - checking a coarser ancestor as
#      a proxy for the leaf resource that actually matters is unsound. See
#      12g3 below for the exact regression this would otherwise miss.
FRESH_F="$WORK/fresh-f"
mkdir -p "$FRESH_F"
fixture_repo "$FRESH_F"
O9=$(printf '%s' '{"source":"startup","session_id":"T"}' | CLAUDE_PROJECT_DIR="$FRESH_F" sh "$H/session-onboard.sh")
has "first activation nudges to gitignore the buffer when not covered" "$O9" 'not gitignored yet'

FRESH_G="$WORK/fresh-g"
mkdir -p "$FRESH_G"
printf '.claude/throughline/buffer/\n' > "$FRESH_G/.gitignore"
fixture_repo_gitignore "$FRESH_G"
O10=$(printf '%s' '{"source":"startup","session_id":"T"}' | CLAUDE_PROJECT_DIR="$FRESH_G" sh "$H/session-onboard.sh")
hasnt "no gitignore nudge when the buffer is already covered" "$O10" 'not gitignored yet'

# 12g2. gitignoring the WHOLE data dir (the README's default recommendation,
#       no wildcard) also satisfies the check, since an un-wildcarded
#       directory pattern recursively covers everything nested inside it,
#       including the buffer - a different authoring style reaching the
#       same, correctly-detected outcome as 12g.
FRESH_G2="$WORK/fresh-g2"
mkdir -p "$FRESH_G2"
printf '.claude/throughline/\n' > "$FRESH_G2/.gitignore"
fixture_repo_gitignore "$FRESH_G2"
O10B=$(printf '%s' '{"source":"startup","session_id":"T"}' | CLAUDE_PROJECT_DIR="$FRESH_G2" sh "$H/session-onboard.sh")
hasnt "no gitignore nudge when the whole data dir (unwildcarded) covers the buffer too" "$O10B" 'not gitignored yet'

# 12g3. regression guard for the exact xhigh-review finding this fix
#       addresses: `.claude/throughline/*` + `!.claude/throughline/buffer/`
#       is a plausible typo'd variant of the opt-in recipe (negating buffer/
#       instead of HANDOFF.md/logs/) that makes `git check-ignore` report
#       the DIRECTORY path itself as ignored (the trailing-`*` glob matches
#       the bare dir too) even though `git status` shows the buffer file
#       genuinely untracked and stageable. Checking bufdir/ directly (not
#       the parent dir) must still catch this - confirming 12f's
#       leaf-not-ancestor reasoning actually holds for the adversarial case,
#       not just the simple ones above.
FRESH_G3="$WORK/fresh-g3"
mkdir -p "$FRESH_G3"
printf '.claude/throughline/*\n!.claude/throughline/buffer/\n' > "$FRESH_G3/.gitignore"
fixture_repo_gitignore "$FRESH_G3"
O10C=$(printf '%s' '{"source":"startup","session_id":"T"}' | CLAUDE_PROJECT_DIR="$FRESH_G3" sh "$H/session-onboard.sh")
has "gitignore nudge still fires when a wildcard+negation pattern falsely un-ignores the buffer" "$O10C" 'not gitignored yet'

# 12g. flush still stamps an ALREADY-EXISTING buffer even if .throughlineignore
#      appears mid-session: its job is to finalize a session that legitimately
#      captured, not to decide whether tracking should continue. Without this,
#      a later opt-out decision would silently corrupt an already-recorded
#      session's bookkeeping.
FRESH_H="$WORK/fresh-h"
mkdir -p "$FRESH_H"
fixture_repo "$FRESH_H"
printf '%s' '{"session_id":"T","tool_name":"Bash","tool_input":{"description":"x","command":"id"}}' | CLAUDE_PROJECT_DIR="$FRESH_H" sh "$H/session-capture.sh"
: > "$FRESH_H/.throughlineignore"
printf '%s' '{"session_id":"T","reason":"end"}' | CLAUDE_PROJECT_DIR="$FRESH_H" sh "$H/session-flush.sh"
has "flush still stamps a session that was already tracked, despite a new .throughlineignore" \
  "$(cat "$FRESH_H/.claude/throughline/buffer/session-T.md" 2>/dev/null)" '<!-- session-ended'

# 12h. same reasoning, for precompact's boundary marker.
FRESH_I="$WORK/fresh-i"
mkdir -p "$FRESH_I"
fixture_repo "$FRESH_I"
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
fixture_repo "$FRESH_J"
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
fixture_repo "$FRESH_K"
O12=$(printf '%s' '{"source":"startup","session_id":"T"}' | CLAUDE_PROJECT_DIR="$FRESH_K" sh "$H/session-onboard.sh")
has "gitignore nudge still fires after a handoff has already run" "$O12" 'not gitignored yet'

# 12j2. issue #66: a HANDOFF.md whose "Last Updated" date sits well behind
#       the branch's latest commit is flagged as possibly stale - the one
#       failure mode every handoff-file design shares (the file only
#       reflects what was written), and the one signal available here
#       (commit history) to catch it going wrong silently.
FRESH_STALE="$WORK/fresh-stale"
mkdir -p "$FRESH_STALE/.claude/throughline"
printf -- '# Test\n**Last Updated:** 2020-01-01\n' > "$FRESH_STALE/.claude/throughline/HANDOFF.md"
fixture_repo "$FRESH_STALE"
O_STALE=$(printf '%s' '{"source":"startup","session_id":"T"}' | CLAUDE_PROJECT_DIR="$FRESH_STALE" sh "$H/session-onboard.sh")
has "onboard flags a HANDOFF.md far behind the latest commit as possibly stale" "$O_STALE" 'may be stale'

# 12j3. ...but a HANDOFF.md updated the same day as the latest commit is not
#       flagged - a 0-day (or negative, in-flight-uncommitted-state) gap is
#       the normal case and must stay silent.
TODAY=$(date '+%Y-%m-%d')
FRESH_CURRENT="$WORK/fresh-current"
mkdir -p "$FRESH_CURRENT/.claude/throughline"
printf -- '# Test\n**Last Updated:** %s\n' "$TODAY" > "$FRESH_CURRENT/.claude/throughline/HANDOFF.md"
fixture_repo "$FRESH_CURRENT"
O_CURRENT=$(printf '%s' '{"source":"startup","session_id":"T"}' | CLAUDE_PROJECT_DIR="$FRESH_CURRENT" sh "$H/session-onboard.sh")
hasnt "onboard does not flag a HANDOFF.md updated the same day as the latest commit" "$O_CURRENT" 'may be stale'

# 12j4. the stale check does not repeat on a compact re-fire, matching the
#       gitignore nudge's own reasoning - informational, not worth repeating
#       mid-session.
O_STALE_COMPACT=$(printf '%s' '{"source":"compact","session_id":"T"}' | CLAUDE_PROJECT_DIR="$FRESH_STALE" sh "$H/session-onboard.sh")
hasnt "onboard does not repeat the stale-handoff warning on a compact re-fire" "$O_STALE_COMPACT" 'may be stale'

# 12j5. review finding: a HANDOFF.md whose "Last Updated" date is shaped like
#       a date (\d{4}-\d{2}-\d{2}) but isn't a real calendar date (month/day
#       out of range) must NOT compute a confident-looking wrong answer - the
#       stale check's own stated contract is "say nothing when unparseable",
#       and a malformed month/day is exactly as unparseable as a missing one.
FRESH_BADDATE="$WORK/fresh-baddate"
mkdir -p "$FRESH_BADDATE/.claude/throughline"
printf -- '# Test\n**Last Updated:** 2026-00-00\n' > "$FRESH_BADDATE/.claude/throughline/HANDOFF.md"
fixture_repo "$FRESH_BADDATE"
O_BADDATE=$(printf '%s' '{"source":"startup","session_id":"T"}' | CLAUDE_PROJECT_DIR="$FRESH_BADDATE" sh "$H/session-onboard.sh")
hasnt "onboard does not flag a malformed (out-of-range) Last-Updated date as stale" "$O_BADDATE" 'may be stale'

# 12k. the gitignore nudge does not repeat on a `compact` re-fire within the
#      same already-running session - it still fires on genuinely new session
#      starts until the buffer is actually covered.
FRESH_L="$WORK/fresh-l"
mkdir -p "$FRESH_L"
fixture_repo "$FRESH_L"
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
fixture_repo "$FRESH_M"
O14=$(printf '%s' '{"source":"startup","session_id":"T"}' | CLAUDE_PROJECT_DIR="$FRESH_M" THROUGHLINE_DATA_DIR="$OUTSIDE_DATA" sh "$H/session-onboard.sh")
hasnt "no gitignore nudge when the data dir is outside the git tree" "$O14" 'not gitignored yet'

# 12m. THROUGHLINE_DISABLE machine-wide kill switch: every hook is a complete
#      no-op - onboard is silent even about EXISTING data (stricter than
#      .throughlineignore, which keeps orienting), capture neither bootstraps
#      nor writes, and flush leaves an existing buffer unstamped. "0" and
#      empty do NOT disable.
FRESH_N="$WORK/fresh-n"
mkdir -p "$FRESH_N"
fixture_repo "$FRESH_N"
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

# 12o. --doctor (issue #71): a read-only diagnostic report. Checked BEFORE the
#      THROUGHLINE_DISABLE kill switch (the disabled state is exactly what
#      someone runs --doctor to discover), reads no stdin, and must never
#      bootstrap a data dir as a side effect - tl_active() does that, and
#      --doctor must not call it.
DOC1=$(THROUGHLINE_DISABLE=1 sh "$H/session-onboard.sh" --doctor)
has "doctor reports under THROUGHLINE_DISABLE (not swallowed by the kill switch)" "$DOC1" "disabled"

DOC2=$(CLAUDE_PROJECT_DIR="$WT_IGN_LINK" sh "$H/session-onboard.sh" --doctor)
has "doctor reports ignored when .throughlineignore is present" "$DOC2" "ignored"

DOC3=$(CLAUDE_PROJECT_DIR="$WT_LINK" sh "$H/session-onboard.sh" --doctor)
# Match the WT_MAIN path as a SUFFIX, not the full absolute path: on Windows
# CI, $WT_MAIN (derived from $WORK, in MSYS form, e.g. /tmp/...) and the
# doctor's own "data root:" line (resolved via `git worktree list`, which
# reports the native C:/... form) describe the identical directory but never
# match as a full-string substring - every OTHER worktree assertion in this
# file already sidesteps this by matching a path suffix (see lines 374/381/
# 386); this one broke that convention and was red on windows-latest until
# fixed to match it.
has   "doctor reports the shared data root from inside a linked worktree" "$DOC3" "wt-main/.claude/throughline"
has   "doctor labels a linked worktree as worktree-shared" "$DOC3" "linked worktree"
# WT_MAIN already has a HANDOFF.md/data dir from earlier onboard calls (5e4/
# 5e above) by this point in the suite, so DOC3 - which reports on the SHARED
# main root's state, not the linked worktree's own - exercises the "active"
# branch of the state machine. Pinned explicitly: it is the most common
# real-world case and had zero dedicated assertions.
has   "doctor reports active state when data already exists" "$DOC3" "activation:        active"

DOC4=$(PATH="$STUB" sh "$H/session-onboard.sh" --doctor)
has "doctor reports missing jq" "$DOC4" "MISSING"

FRESH_DOC="$WORK/fresh-doctor"
mkdir -p "$FRESH_DOC"
fixture_repo "$FRESH_DOC"
DOC5=$(CLAUDE_PROJECT_DIR="$FRESH_DOC" sh "$H/session-onboard.sh" --doctor)
has "doctor reports would-bootstrap on a never-activated project" "$DOC5" "would-bootstrap"
absent "doctor does not create a data dir as a side effect" "$FRESH_DOC/.claude"

# 12o-2. buffer counts: seed a KNOWN number of live and archived buffer files
#        and assert the exact reported count, not just that the words "live"/
#        "archived" appear - the counting loop itself (a glob, not find | wc;
#        see the comment in session-onboard.sh) had zero regression coverage
#        beyond incidentally landing on 0/0 in every other doctor fixture.
FRESH_DOC_BUF="$WORK/fresh-doctor-bufs"
mkdir -p "$FRESH_DOC_BUF/.claude/throughline/buffer/archive"
fixture_repo "$FRESH_DOC_BUF"
: > "$FRESH_DOC_BUF/.claude/throughline/buffer/session-a.md"
: > "$FRESH_DOC_BUF/.claude/throughline/buffer/session-b.md"
: > "$FRESH_DOC_BUF/.claude/throughline/buffer/archive/session-c.md"
DOC6=$(CLAUDE_PROJECT_DIR="$FRESH_DOC_BUF" sh "$H/session-onboard.sh" --doctor)
has "doctor reports the exact seeded buffer counts" "$DOC6" "2 live, 1 archived"

# 12o-3. would-bootstrap distinguishes the LIKELY TO FAIL case (project root
#        not writable - what a real hook run treats as bootstrap-failed) from
#        an ordinary not-yet-activated project. Same NTFS-chmod-emulation
#        caveat as the other permission-based tests in this file (12e).
if is_windows; then
  skip_win "doctor reports would-bootstrap LIKELY TO FAIL on an unwritable root"
elif [ "$(id -u)" != "0" ]; then
  FRESH_DOC_RO="$WORK/fresh-doctor-ro"
  mkdir -p "$FRESH_DOC_RO"
  fixture_repo "$FRESH_DOC_RO"
  chmod 555 "$FRESH_DOC_RO" 2>/dev/null
  DOC7=$(CLAUDE_PROJECT_DIR="$FRESH_DOC_RO" sh "$H/session-onboard.sh" --doctor)
  chmod 755 "$FRESH_DOC_RO" 2>/dev/null
  has "doctor reports would-bootstrap LIKELY TO FAIL on an unwritable root" "$DOC7" "LIKELY TO FAIL"
else
  ok "doctor LIKELY TO FAIL test skipped (running as root)"
fi

# 12b. --doctor lists the installed version per harness and flags only the ones
#      older than the scripts running it (issue #181). A fake HOME holds a stale
#      Claude Code and Codex install and a current OpenCode, OMP (link) and Hermes
#      install, each in the shape that harness writes on disk.
DV_SELF=$(sed -n 's/^version: //p' "$ROOT/plugin.yaml")
DVH="$WORK/doctor-home"
# Codex's two cache dirs differ only in numeric order (string order would pick 0.9.0).
mkdir -p "$DVH/.claude/plugins" "$DVH/.codex/plugins/cache/throughline/throughline/0.9.0" \
  "$DVH/.codex/plugins/cache/throughline/throughline/0.10.0" \
  "$DVH/.cache/opencode/packages/@dynamicagency/throughline-opencode@latest/node_modules/@dynamicagency/throughline-opencode" \
  "$DVH/.omp/plugins/node_modules/@dynamicagency" "$DVH/checkout" "$DVH/.hermes/plugins/throughline"
printf '{"version":2,"plugins":{"throughline@throughline":[{"scope":"user","version":"0.0.9"}],"other@x":[{"version":"0.0.1"}]}}\n' > "$DVH/.claude/plugins/installed_plugins.json"
printf '{"version":"%s"}\n' "$DV_SELF" > "$DVH/.cache/opencode/packages/@dynamicagency/throughline-opencode@latest/node_modules/@dynamicagency/throughline-opencode/package.json"
printf '{"name":"@dynamicagency/throughline","version":"%s"}\n' "$DV_SELF" > "$DVH/checkout/package.json"
# The lock records a stale version on purpose: the link's checkout must win. Git
# Bash's ln -s can copy instead of linking, so Windows gets no lock and no link.
if ! is_windows; then
  printf '{"plugins":{"@dynamicagency/throughline":{"version":"0.0.3"}}}\n' > "$DVH/.omp/plugins/omp-plugins.lock.json"
  ln -s "$DVH/checkout" "$DVH/.omp/plugins/node_modules/@dynamicagency/throughline" 2>/dev/null
fi
printf 'name: throughline\nversion: %s\n' "$DV_SELF" > "$DVH/.hermes/plugins/throughline/plugin.yaml"
DV=$( (unset CODEX_HOME HERMES_HOME XDG_CACHE_HOME CLAUDE_CONFIG_DIR; HOME="$DVH" sh "$H/session-onboard.sh" --doctor) )
has "doctor names its own version" "$DV" "installed versions (this doctor: $DV_SELF)"
has "doctor flags the stale Claude Code install" "$(printf '%s\n' "$DV" | grep 'claude code:')" "0.0.9 (user)  OLDER than $DV_SELF"
has "doctor reports the numerically newest Codex cache version, flagged stale" "$(printf '%s\n' "$DV" | grep 'codex:')" "0.10.0  OLDER than $DV_SELF"
has "doctor reports the current OpenCode install by spec" "$(printf '%s\n' "$DV" | grep 'opencode:')" "$DV_SELF (@dynamicagency/throughline-opencode@latest)"
has "doctor reports the current Hermes install" "$(printf '%s\n' "$DV" | grep 'hermes:')" "$DV_SELF"
eq "doctor flags exactly the two stale installs" "$(printf '%s\n' "$DV" | grep -c 'OLDER than')" "2"
eq "doctor ignores other plugins in installed_plugins.json" "$(printf '%s\n' "$DV" | grep -c 'claude code:')" "1"
if is_windows; then
  ok "doctor reads an OMP link install's version from the checkout (skipped: Git Bash ln -s may copy)"
else
  has "doctor reads an OMP link install's version from the checkout, not the lock" "$(printf '%s\n' "$DV" | grep 'omp:')" "$DV_SELF (link -> "
fi
# A second fake HOME: an OMP marketplace install (OMP's own installed_plugins.json)
# beside a link whose checkout is gone, then the same HOME with jq off PATH.
DVH2="$WORK/doctor-home-2"
mkdir -p "$DVH2/.omp/plugins/node_modules/@dynamicagency" "$DVH2/.cache/opencode/packages/@dynamicagency/throughline-opencode/node_modules/@dynamicagency/throughline-opencode"
printf '{"version":2,"plugins":{"throughline@throughline":[{"scope":"user","version":"0.0.4"}]}}\n' > "$DVH2/.omp/plugins/installed_plugins.json"
printf '{"name":"@dynamicagency/throughline-opencode","version":"0.0.5"}\n' > "$DVH2/.cache/opencode/packages/@dynamicagency/throughline-opencode/node_modules/@dynamicagency/throughline-opencode/package.json"
DV=$( (unset CODEX_HOME HERMES_HOME XDG_CACHE_HOME CLAUDE_CONFIG_DIR; HOME="$DVH2" sh "$H/session-onboard.sh" --doctor) )
has "doctor reports an OMP marketplace install from OMP's installed_plugins.json" "$(printf '%s\n' "$DV" | grep 'omp:')" "0.0.4 (marketplace)  OLDER than $DV_SELF"
if is_windows; then
  ok "doctor reports a broken OMP link (skipped: Git Bash ln -s may copy)"
else
  ln -s "$DVH2/gone" "$DVH2/.omp/plugins/node_modules/@dynamicagency/throughline" 2>/dev/null
  DV=$( (unset CODEX_HOME HERMES_HOME XDG_CACHE_HOME CLAUDE_CONFIG_DIR; HOME="$DVH2" sh "$H/session-onboard.sh" --doctor) )
  has "doctor reports a broken OMP link as broken, not with a borrowed version" "$DV" "link broken: "
fi
DV=$( (unset CODEX_HOME HERMES_HOME XDG_CACHE_HOME CLAUDE_CONFIG_DIR; HOME="$DVH2" PATH="$STUB" sh "$H/session-onboard.sh" --doctor) )
has "doctor without jq still reads a package.json version" "$(printf '%s\n' "$DV" | grep 'opencode:')" "0.0.5 (@dynamicagency/throughline-opencode)"
has "doctor without jq says a registry install was not read" "$(printf '%s\n' "$DV" | grep 'omp:')" "version not read (jq missing)"
mkdir -p "$WORK/doctor-empty-home"
DV=$( (unset CODEX_HOME HERMES_HOME XDG_CACHE_HOME CLAUDE_CONFIG_DIR; HOME="$WORK/doctor-empty-home" sh "$H/session-onboard.sh" --doctor) )
has "doctor with no harness installs says none found" "$DV" "  none found"

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
prompt '{"session_id":"P","prompt":"deploy with my key ghp_xxxxxxxxxxxx"}'
PS=$(grep 'deploy with' "$BUF/session-P.md")
hasnt "prompt: gh token not stored" "$PS" 'ghp_xxxxxxxxxxxx'
has   "prompt: gh token masked"     "$PS" '***'
# issue #81: the newly added vendor prefixes live in the SHARED _prefix_tokens
# def, so they protect prompts too - and, being shape-distinctive, they do it
# without the prose-corruption problem that made the keyword rules command-only.
prompt '{"session_id":"P","prompt":"rotate the gitlab glpat-''xxxxxxxxxxxxxxxxxxxx before it expires"}'
hasnt "prompt: glpat- not stored" "$(grep 'rotate the gitlab' "$BUF/session-P.md")" 'glpat-''xxxxxxxxxxxxxxxxxxxx'
has   "prompt: glpat- mask sentinel is present" "$(grep 'rotate the gitlab' "$BUF/session-P.md")" 'glpat-***'
# issue #175 on the prose path: a new prefix masks, and prose that names a prefix
# without a token body stays word for word.
prompt '{"session_id":"P","prompt":"rotate the runner glrt-''xxxxxxxxxxxxxxxxxxxx and read the glft- prefix docs for gldt-short9"}'
GL_P=$(grep 'rotate the runner' "$BUF/session-P.md")
hasnt "prompt: glrt- not stored" "$GL_P" 'glrt-''xxxxxxxxxxxxxxxxxxxx'
has   "prompt: glrt- masked, prose naming a prefix left intact" "$GL_P" 'glrt-*** and read the glft- prefix docs for gldt-short9'
prompt '{"session_id":"P","prompt":"the stripe key sk_live_''xxxxxxxxxxxxxxxxxx leaked, rotate it"}'
hasnt "prompt: sk_live_ key not stored" "$(grep 'the stripe key' "$BUF/session-P.md")" 'sk_live_''xxxxxxxxxxxxxxxxxx'
has   "prompt: sk_live_ mask sentinel is present" "$(grep 'the stripe key' "$BUF/session-P.md")" 'sk_live_***'
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
prompt '{"session_id":"P","prompt":"our secrets: xxxxxxxxxxxxxxxxxxxxxxxxxxx"}'
has "prompt: bare colon-form secret is a documented gap, not auto-masked" "$(grep 'our secrets' "$BUF/session-P.md")" 'our secrets: xxxxxxxxxxxxxxxxxxxxxxxxxxx'
prompt '{"session_id":"P","prompt":"client_secret: xxxxxxxxxxxxxxxxxxx"}'
has "prompt: SCREAMING_SNAKE_CASE compound is the same documented gap" "$(grep client_secret "$BUF/session-P.md")" 'client_secret: xxxxxxxxxxxxxxxxxxx'
# Structural scheme rules still catch a pasted Authorization header, INCLUDING
# the Token scheme (DRF/GitLab-style) — redact_prompt lacked this rule
# entirely until it was added alongside Bearer/Basic.
prompt '{"session_id":"P","prompt":"Authorization: Bearer eyJxxxxxxxxxxxxxxxxxx.fake.jwt.body"}'
hasnt "prompt: bearer JWT body not stored" "$(grep Authorization "$BUF/session-P.md")" 'eyJxxxxxxxxxxxxxxxxxx'
# Issue #173's value backstop is command-path only (`redact`); the prompt path is
# unchanged. A long Bearer value containing a keyword, before a copula, stays masked.
prompt '{"session_id":"P","prompt":"Bearer zzAuthzzzzzzzzzzzzzQ is expired"}'
hasnt "prompt: Bearer value with a keyword inside, before a copula, not stored (issue #173)" "$(cat "$BUF/session-P.md")" 'zzAuthzzzzzzzzzzzzzQ'
reset_buf
prompt '{"session_id":"P","prompt":"Authorization: Token xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}'
hasnt "prompt: Authorization Token value not stored" "$(cat "$BUF/session-P.md")" 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
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
prompt '{"session_id":"P","prompt":"Authorization: Basic xxxxxxxxxx=="}'
has "prompt: short Basic value is the same documented gap" "$(grep 'Authorization: Basic' "$BUF/session-P.md")" 'Authorization: Basic xxxxxxxxxx=='
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
cap '{"session_id":"W","tool_name":"WebFetch","tool_input":{"url":"https://alice:xxxxxxxx@example.com/doc"}}'
WF=$(grep webfetch "$BUF/session-W.md")
has   "webfetch captured with url"      "$WF" '**webfetch** https://alice:'
hasnt "webfetch url userinfo is masked" "$WF" 'xxxxxxxx'
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

# --- archive-buffer.sh: never overwrite an archived buffer (issues #79, #185) ----
# Two handoffs in one session archive two windows under one session id. The
# second must append to the first run's archived file, not replace it.
AB="$WORK/archive-test/buffer"
mkdir -p "$AB"
printf -- '- `2026-01-01 09:00:00` **bash** window-one-first\n- `2026-01-01 09:05:00` **bash** window-one-last\n' > "$AB/session-AB.md"
sh "$H/archive-buffer.sh" "$AB/session-AB.md"; AB_RC=$?
eq "archive-buffer: first archive exits 0" "$AB_RC" "0"
absent "archive-buffer: first archive removes the live buffer" "$AB/session-AB.md"
present "archive-buffer: first archive lands in archive/" "$AB/archive/session-AB.md"
printf -- '- `2026-01-01 10:00:00` **bash** window-two-only\n' > "$AB/session-AB.md"
sh "$H/archive-buffer.sh" "$AB/session-AB.md"; AB_RC=$?
eq "archive-buffer: same-session second archive exits 0" "$AB_RC" "0"
absent "archive-buffer: second archive removes the live buffer" "$AB/session-AB.md"
AB_TXT=$(cat "$AB/archive/session-AB.md")
has "archive-buffer: the first window survives the second archive" "$AB_TXT" "window-one-first"
before "archive-buffer: both windows are kept in order" "$AB_TXT" "window-one-last" "window-two-only"
has "archive-buffer: an append boundary marks the second window" "$AB_TXT" "<!-- archive-append "
eq "archive-buffer: one archived file per session, no temp left behind" "$(find "$AB/archive" -type f | wc -l | tr -d ' ')" "1"
printf -- '- x\n' > "$AB/session-OTHER.md"
sh "$H/archive-buffer.sh" "$AB/session-OTHER.md" "$AB/session-MISSING.md" 2>/dev/null; AB_RC=$?
eq "archive-buffer: a missing buffer exits non-zero" "$AB_RC" "1"
present "archive-buffer: other buffers in the same call are still archived" "$AB/archive/session-OTHER.md"
# A failed append puts the window back where the next handoff reads buffers.
if is_windows; then
  skip_win "archive-buffer: a failed append leaves the window at its live name"
else
  printf -- '- window-three\n' > "$AB/session-AB.md"
  chmod 444 "$AB/archive/session-AB.md"
  AB_ERR=$(sh "$H/archive-buffer.sh" "$AB/session-AB.md" 2>&1); AB_RC=$?
  chmod 644 "$AB/archive/session-AB.md"
  if [ "$(id -u)" = "0" ]; then
    ok "archive-buffer: a failed append leaves the window at its live name (skipped: root bypasses 444)"
  else
    eq "archive-buffer: a failed append exits non-zero" "$AB_RC" "1"
    has "archive-buffer: a failed append leaves the window at its live name" "$(cat "$AB/session-AB.md" 2>/dev/null)" "window-three"
    has "archive-buffer: a failed append says where the window is" "$AB_ERR" "window kept at $AB/session-AB.md"
    eq "archive-buffer: a failed append leaves no temp file in archive/" "$(find "$AB/archive" -name '.archiving.*' | wc -l | tr -d ' ')" "0"
  fi
fi
# #186: the skill archives through the script, never a bare move onto the archive.
has "handoff skill: the consume step calls hooks/archive-buffer.sh" "$(cat "$ROOT/skills/handoff/SKILL.md")" "hooks/archive-buffer.sh"

# --- jq program size (Windows command-line cap) ---------------------------------
# session-capture.sh hands jq ONE argument: the redaction defs plus the capture
# filter. Windows caps a whole command line at 32,767 characters, and a jq call
# that exceeds it fails outright, dropping every captured event (the 33,071-char
# argument at the #81 review round 9 head did exactly that on the Windows CI leg).
# Full-line comments are stripped from the emitted defs so doc-comments cost
# nothing; this pins that, and pins a byte budget with wide headroom.
(
  . "$ROOT/hooks/_lib.sh"
  defs=$(tl_jq_redact_defs)
  if printf '%s\n' "$defs" | grep -qE '^[[:space:]]*#'; then
    echo "comment-line"
  else
    echo "no-comment-line"
  fi > "$WORK/defs-comments.txt"
  printf '%s' "${#defs}" > "$WORK/defs-len.txt"
)
eq "jq defs: no full-line comment reaches jq" "$(cat "$WORK/defs-comments.txt")" "no-comment-line"
if [ "$(cat "$WORK/defs-len.txt")" -lt 20000 ]; then
  ok "jq defs: emitted text is under 20000 chars (Windows argv cap is 32767 for defs + filter)"
else
  bad "jq defs: emitted text is $(cat "$WORK/defs-len.txt") chars, over the 20000 budget"
fi

# --- SKILL.md lint (issue #195) ---------------------------------------------------
# tests/skill-lint.sh checks every skill's frontmatter, its byte budget and that each
# repo path it names exists. Run against this repo (must be clean) and against a
# fixture that breaks each rule, so a lint that stopped checking would go red here.
sl_err=$(sh "$ROOT/tests/skill-lint.sh" "$ROOT" 2>&1) && sl_rc=0 || sl_rc=$?
eq "skill-lint: this repo's skills pass (issue #195)" "$sl_rc:$sl_err" "0:"
sl_root="$WORK/skill-lint"
mkdir -p "$sl_root/skills/broken"
printf -- '---\nname: other\n---\nRun hooks/no-such-script.sh first.\n' > "$sl_root/skills/broken/SKILL.md"
sl_err=$(sh "$ROOT/tests/skill-lint.sh" "$sl_root" 2>&1) && sl_rc=0 || sl_rc=$?
eq "skill-lint: a broken skill fails (issue #195)" "$sl_rc" "1"
has "skill-lint: names a frontmatter name mismatch (issue #195)" "$sl_err" "frontmatter name is 'other', expected 'broken'"
has "skill-lint: names a missing description (issue #195)" "$sl_err" 'has no description'
has "skill-lint: names a referenced path that does not exist (issue #195)" "$sl_err" 'references hooks/no-such-script.sh'
mkdir -p "$sl_root/skills/onboard"
{ printf -- '---\nname: onboard\ndescription: x\n---\n'; i=0; while [ $i -lt 400 ]; do printf 'padding line\n'; i=$((i+1)); done; } > "$sl_root/skills/onboard/SKILL.md"
sl_err=$(sh "$ROOT/tests/skill-lint.sh" "$sl_root" 2>&1) || true
has "skill-lint: names a skill over its byte budget (issue #195)" "$sl_err" 'onboard: SKILL.md is'
rm -rf "$sl_root/skills/onboard"
mkdir -p "$sl_root/skills/longdesc" "$sl_root/skills/unclosed" "$sl_root/skills/folded"
{ printf -- '---\nname: longdesc\ndescription: '; i=0; while [ $i -lt 301 ]; do printf 'x'; i=$((i+1)); done; printf '\n---\nbody\n'; } > "$sl_root/skills/longdesc/SKILL.md"
printf -- '---\nname: unclosed\ndescription: x\nbody without a closing line\n' > "$sl_root/skills/unclosed/SKILL.md"
printf -- '---\nname: folded\ndescription: >\n  a long folded description\n---\nbody\n' > "$sl_root/skills/folded/SKILL.md"
sl_err=$(sh "$ROOT/tests/skill-lint.sh" "$sl_root" 2>&1) || true
has "skill-lint: names a description over 300 characters (issue #195)" "$sl_err" 'longdesc: description is 301 characters, over 300'
has "skill-lint: names frontmatter that never closes (issue #195)" "$sl_err" 'unclosed: frontmatter never closes'
has "skill-lint: rejects a multi-line YAML description (issue #195)" "$sl_err" 'folded: description is a multi-line YAML block'
# A CRLF copy of a clean skill still passes: the lint parses a CR-stripped copy.
sl_crlf="$WORK/skill-lint-crlf"
mkdir -p "$sl_crlf/skills/onboard" "$sl_crlf/docs"
: > "$sl_crlf/docs/REFERENCE.md"
sed 's/$/\r/' "$ROOT/skills/onboard/SKILL.md" > "$sl_crlf/skills/onboard/SKILL.md"
sl_err=$(sh "$ROOT/tests/skill-lint.sh" "$sl_crlf" 2>&1) && sl_rc=0 || sl_rc=$?
eq "skill-lint: a CRLF checkout of a clean skill passes (issue #195)" "$sl_rc:$sl_err" "0:"

# --- Codex plugin manifest (issue #112) ----------------------------------------
# tests/codex-plugin.sh checks .codex-plugin/plugin.json against
# .agents/plugins/marketplace.json - the two files Codex installs the plugin
# from. Routing it through this file is what enforces it: .local-ci.json's "hook
# tests" and every CI leg already run run.sh, so the check needs no declaration of
# its own to be enforced locally and in CI.
#
# A negative case has to fail for the reason it STAGES, so codex_expect requires
# both the exit status and a substring of stderr. Exit status alone would let a
# fixture that died for an unrelated reason (a mis-copied file, a missing jq call)
# read as a sweep - the same trap cap_line() documents above.
codex_fixture() {
  cf_root="$WORK/codex/$1"
  mkdir -p "$cf_root/.codex-plugin" "$cf_root/.agents/plugins"
  # The copy holds only what the check reads, plus the directories those files
  # reference (skills/, and the plugin root itself - the fixture root). Named
  # fragility: if a manifest ever advertises a ./-path somewhere else in the tree,
  # this copy has to grow with it; until it does, every fixture fails with "does
  # not resolve" while the real-tree case below still passes. A half-copied fixture
  # is reported through bad() so it stays a visible failure, and the chain is
  # written as if/then rather than `A && B || C`, which would also report a setup
  # failure when every cp succeeded but something after the || failed.
  if cp "$ROOT/.codex-plugin/plugin.json" "$cf_root/.codex-plugin/" \
    && cp "$ROOT/.agents/plugins/marketplace.json" "$cf_root/.agents/plugins/" \
    && cp -R "$ROOT/skills" "$cf_root/"; then
    :
  else
    bad "codex fixture setup failed: $cf_root"
  fi
}
# codex_expect <label> <want-exit> <stderr needle or ''> <root>
codex_expect() {
  ce_want=$2; ce_needle=$3; ce_root=$4
  # `$?` here is the check script's status: a plain assignment's exit status IS the
  # command substitution's, and ce_* are plain assignments, not `local` (which
  # would reset it to its own 0).
  ce_err=$(sh "$ROOT/tests/codex-plugin.sh" "$ce_root" 2>&1 >/dev/null)
  ce_rc=$?
  if [ "$ce_rc" != "$ce_want" ]; then
    bad "$1 (exit $ce_rc, want $ce_want)"
    printf '       got: %s\n' "$ce_err"
  elif [ -z "$ce_needle" ]; then
    ok "$1"
  else
    has "$1" "$ce_err" "$ce_needle"
  fi
}
# codex_patch <root> <jq filter> - rewrite one manifest inside a fixture. The mv is
# chained to && and jq runs with -e so a filter that fails, or that succeeds while
# emitting nothing, cannot leave an empty file behind: the check would then reject
# it as invalid JSON and the assertion would succeed for a reason that has nothing to
# do with the drift being staged.
codex_patch() {
  if jq -e "$2" "$1/.agents/plugins/marketplace.json" > "$1/.agents/plugins/marketplace.json.new" 2>/dev/null; then
    mv "$1/.agents/plugins/marketplace.json.new" "$1/.agents/plugins/marketplace.json"
  else
    bad "codex fixture patch failed: $1 ($2)"
  fi
}
codex_patch_manifest() {
  if jq -e "$2" "$1/.codex-plugin/plugin.json" > "$1/.codex-plugin/plugin.json.new" 2>/dev/null; then
    mv "$1/.codex-plugin/plugin.json.new" "$1/.codex-plugin/plugin.json"
  else
    bad "codex fixture patch failed: $1 ($2)"
  fi
}

codex_fixture good
codex_expect "codex check: intact copy exits 0" 0 "" "$WORK/codex/good"
codex_expect "codex check: the real tree exits 0 (root passed explicitly)" 0 "" "$ROOT"
# A no-arg run has to be its own call: every case above hands the script a root, so
# the default - resolve the root from the script's own location - would otherwise be
# exercised only when a person runs the script directly. Run from $WORK so the
# current directory cannot be what makes it succeed.
ce_noarg_rc=0
ce_noarg_err=$(cd "$WORK" && sh "$ROOT/tests/codex-plugin.sh" 2>&1 >/dev/null) || ce_noarg_rc=$?
if [ "$ce_noarg_rc" = "0" ]; then
  ok "codex check: no-arg run resolves the root from its own location"
else
  bad "codex check: no-arg run resolves the root from its own location (exit $ce_noarg_rc, want 0)"
  printf '       got: %s\n' "$ce_noarg_err"
fi
codex_expect "codex check: a root dir that does not exist exits non-zero" 1 "no such root directory" "$WORK/codex/never-created"

# A manifest that no longer names its skills directory must fail, not succeed for lack
# of anything to check - so both the deleted key and a value in a form that could
# never resolve are pinned by name, each guarding on its own message.
codex_fixture noskillkey
codex_patch_manifest "$WORK/codex/noskillkey" 'del(.skills)'
codex_expect "codex check: manifest with no .skills key exits non-zero" 1 "manifest .skills is missing from" "$WORK/codex/noskillkey"

codex_fixture skillunprefixed
codex_patch_manifest "$WORK/codex/skillunprefixed" '.skills = "skills/"'
codex_expect "codex check: manifest .skills without the ./ prefix exits non-zero" 1 "manifest .skills must be a ./-relative path" "$WORK/codex/skillunprefixed"

# A referenced path that does not exist, from both directions: the skills dir the
# manifest advertises is gone from the tree, and the marketplace entry points at a
# directory that was never there. Each names the literal path in the needle, so the
# case cannot succeed on some other "does not resolve".
codex_fixture noskillsdir
rm -rf "$WORK/codex/noskillsdir/skills"
codex_expect "codex check: a missing skills dir exits non-zero" 1 "'./skills/' in $WORK/codex/noskillsdir/.codex-plugin/plugin.json" "$WORK/codex/noskillsdir"

codex_fixture badsourcepath
codex_patch "$WORK/codex/badsourcepath" '.plugins[0].source.path = "./no-such-dir/"'
codex_expect "codex check: a marketplace source.path that does not resolve exits non-zero" 1 "'./no-such-dir/' in $WORK/codex/badsourcepath/.agents/plugins/marketplace.json" "$WORK/codex/badsourcepath"

codex_fixture nosourcepath
codex_patch "$WORK/codex/nosourcepath" 'del(.plugins[0].source.path)'
codex_expect "codex check: marketplace entry with no source.path exits non-zero" 1 "source.path is missing from" "$WORK/codex/nosourcepath"

# Pointing at the plugin is more than pointing at something that exists: ./skills/ is a
# real directory holding no manifest, so an entry aimed at it installs nothing while a
# pure existence test reports clean.
codex_fixture sourceisdir
codex_patch "$WORK/codex/sourceisdir" '.plugins[0].source.path = "./skills/"'
codex_expect "codex check: a marketplace source.path with no manifest inside exits non-zero" 1 "does not contain a plugin manifest" "$WORK/codex/sourceisdir"

# A manifest at the other end of source.path is not yet THE plugin: an entry named
# throughline can point at a directory holding some other plugin's manifest, and every
# name match above is against the root manifest. The nested manifest here is written by
# the fixture itself (the copy in codex_fixture holds only the two files the check reads,
# plus skills/), so the case stages a real second plugin rather than a path string.
codex_fixture sourceothersub
codex_patch "$WORK/codex/sourceothersub" '.plugins[0].source.path = "./sub/"' \
  && { mkdir -p "$WORK/codex/sourceothersub/sub/.codex-plugin"
       printf '{"name":"other-plugin"}\n' > "$WORK/codex/sourceothersub/sub/.codex-plugin/plugin.json"; }
codex_expect "codex check: a marketplace source.path at another plugin's manifest exits non-zero" 1 "points at a different plugin" "$WORK/codex/sourceothersub"

# A malformed entry LIST is a different verdict from an unlisted plugin, and they are
# easy to conflate: `.plugins[]?` swallows the index error when `.plugins` is a string,
# so the count comes back a well-formed 0 and the run calls a file with no entry list
# "unlisted". This pins the distinct message.
codex_fixture pluginsnotarray
codex_patch "$WORK/codex/pluginsnotarray" '.plugins = "nope"'
codex_expect "codex check: a marketplace plugins list that is not an array exits non-zero" 1 ".plugins is not an array" "$WORK/codex/pluginsnotarray"

# The one shape that reaches the count as EMPTY output rather than a number - an array
# whose members are not objects, where select() dies indexing a string - so the numeric
# guard has a case of its own instead of being reachable only in principle.
codex_fixture pluginsnotobjects
codex_patch "$WORK/codex/pluginsnotobjects" '.plugins = ["notanobject"]'
codex_expect "codex check: a marketplace plugins array of non-objects exits non-zero" 1 "could not count marketplace entries" "$WORK/codex/pluginsnotobjects"

# The manifest's `name` is the identity Codex installs under, and every case above
# leaves it at its real value - so a check that hardcoded 'throughline' would succeed
# the whole suite. These two vary the MANIFEST side: a renamed plugin (no entry
# matches) and a deleted name (a different verdict, and a different message, from an
# unmatched one).
codex_fixture renamedmanifest
codex_patch_manifest "$WORK/codex/renamedmanifest" '.name = "renamed-in-manifest"'
codex_expect "codex check: manifest name with no matching marketplace entry exits non-zero" 1 "no marketplace entry named 'renamed-in-manifest'" "$WORK/codex/renamedmanifest"

codex_fixture noname
codex_patch_manifest "$WORK/codex/noname" 'del(.name)'
codex_expect "codex check: manifest with no name at all exits non-zero" 1 "manifest has no .name" "$WORK/codex/noname"

# The marketplace side of the same pairing: the entry is renamed away from the
# manifest, and a second entry is added so two compete for one install.
codex_fixture renamedentry
codex_patch "$WORK/codex/renamedentry" '.plugins[0].name = "other-plugin"'
codex_expect "codex check: marketplace name drift from the manifest exits non-zero" 1 "no marketplace entry named 'throughline'" "$WORK/codex/renamedentry"

codex_fixture dupe
codex_patch "$WORK/codex/dupe" '.plugins += [.plugins[0]]'
codex_expect "codex check: two marketplace entries for one plugin exit non-zero" 1 "want exactly 1" "$WORK/codex/dupe"

# Version parity: this repo's entry carries no version today (the manifest is the
# source of truth), so a missing one is a sweep - pinned by the intact-copy case
# above - and a present one has to be the version in the tree.
codex_fixture wrongversion
codex_patch "$WORK/codex/wrongversion" '.plugins[0].version = "0.0.1"'
codex_expect "codex check: marketplace version disagreeing with the manifest exits non-zero" 1 "version drift" "$WORK/codex/wrongversion"

# A zero-byte file specifically, not merely malformed bytes: `jq empty` accepts an
# empty file (a value stream with no values is a valid stream), so this is the case
# that pins the JSON gate being strong enough to reject a manifest that describes
# nothing at all.
codex_fixture emptymarketplace
: > "$WORK/codex/emptymarketplace/.agents/plugins/marketplace.json"
codex_expect "codex check: zero-byte marketplace file exits non-zero" 1 "invalid JSON" "$WORK/codex/emptymarketplace"

# --- OMP manifest lives at the repo root, next to skills/ and hooks/ --------------
# OMP resolves skills/ and hooks/ as siblings of the package.json carrying the
# `omp` field, with no path override.
eq "root package.json carries the omp manifest name" "$(jq -r '.omp.name // empty' "$ROOT/package.json")" "throughline"
eq "skills/ beside the OMP manifest holds 4 skills" "$(find "$ROOT/skills" -name SKILL.md | wc -l | tr -d ' ')" "4"
present "OMP hook shim beside the OMP manifest" "$ROOT/hooks/post/throughline.ts"

# --- shared check scripts (issues #205, #206) -----------------------------------
# CI and local-ci both call scripts/check-*.sh, so these prove each gate can fail.
# The manifest fixture copies only what check-manifests.sh reads.
mf_fixture() {
  mf_root="$WORK/manifests/$1"
  mkdir -p "$mf_root/hooks" "$mf_root/.claude-plugin" "$mf_root/.codex-plugin" \
    "$mf_root/.agents/plugins" "$mf_root/.opencode-plugin" "$mf_root/.omp-plugin"
  for f in hooks/hooks.json .claude-plugin/plugin.json .claude-plugin/marketplace.json \
    .codex-plugin/plugin.json .agents/plugins/marketplace.json .opencode-plugin/package.json \
    package.json .omp-plugin/package.json plugin.yaml CHANGELOG.md; do
    cp "$ROOT/$f" "$mf_root/$f" || bad "manifest fixture copy failed: $f"
  done
}
mf_run() { sh "$ROOT/scripts/check-manifests.sh" "$1" 2>&1; }

mf_fixture intact
MF_OUT=$(mf_run "$WORK/manifests/intact"); MF_RC=$?
eq "check-manifests: an intact copy passes" "$MF_RC" "0"

mf_fixture drift
jq '.version = "0.0.1"' "$ROOT/.codex-plugin/plugin.json" > "$WORK/manifests/drift/.codex-plugin/plugin.json"
MF_OUT=$(mf_run "$WORK/manifests/drift"); MF_RC=$?
eq "check-manifests: a version mismatch exits non-zero" "$MF_RC" "1"
has "check-manifests: the mismatch names the drifting manifest" "$MF_OUT" ".codex-plugin/plugin.json=0.0.1"

mf_fixture changelog
sed 's/^## \[Unreleased\]/## [0.0.1]/' "$ROOT/CHANGELOG.md" > "$WORK/manifests/changelog/CHANGELOG.md"
MF_OUT=$(mf_run "$WORK/manifests/changelog"); MF_RC=$?
eq "check-manifests: a CHANGELOG top heading ahead of the manifests exits non-zero" "$MF_RC" "1"
has "check-manifests: the CHANGELOG failure says which heading" "$MF_OUT" "first heading is [0.0.1]"

mf_fixture released
# A synthetic CHANGELOG, so the case does not depend on the live file's top.
printf '# Changelog\n\n## [Unreleased]\n\n- x\n\n## [0.0.2] - 2026-01-01\n\n- y\n' > "$WORK/manifests/released/CHANGELOG.md"
MF_OUT=$(mf_run "$WORK/manifests/released"); MF_RC=$?
eq "check-manifests: [Unreleased] on top but no heading for the manifest version exits non-zero" "$MF_RC" "1"
has "check-manifests: the released-heading failure says which heading" "$MF_OUT" "first released heading is [0.0.2]"

mf_fixture badjson
printf '{' > "$WORK/manifests/badjson/.claude-plugin/plugin.json"
MF_OUT=$(mf_run "$WORK/manifests/badjson"); MF_RC=$?
eq "check-manifests: an unparseable manifest exits non-zero" "$MF_RC" "1"

mkdir -p "$WORK/typo"
printf 'a \342\200\224 b\n' > "$WORK/typo/dash.md"
printf 'plain ASCII - fine\n' > "$WORK/typo/clean.md"
TY_OUT=$(sh "$ROOT/scripts/check-typography.sh" "$WORK/typo/dash.md" 2>&1); TY_RC=$?
eq "check-typography: an em dash fixture exits non-zero" "$TY_RC" "1"
has "check-typography: the hit names the file" "$TY_OUT" "dash.md:1:"
TY_OUT=$(sh "$ROOT/scripts/check-typography.sh" "$WORK/typo/clean.md" 2>&1); TY_RC=$?
eq "check-typography: an ASCII fixture passes" "$TY_RC" "0"
TY_OUT=$(sh "$ROOT/scripts/check-typography.sh" "$WORK/typo/missing.md" 2>&1); TY_RC=$?
eq "check-typography: a missing file is an error, not a clean pass" "$TY_RC" "1"
# The default mode CI runs, pointed at a fixture checkout with --root.
TYR="$WORK/typo/repo"
mkdir -p "$TYR/docs" "$TYR/.claude-plugin"
printf 'plain\n' > "$TYR/README.md"; printf 'plain\n' > "$TYR/docs/INSTALL.md"
printf '<p>plain</p>\n' > "$TYR/docs/index.html"; printf '{}\n' > "$TYR/.claude-plugin/marketplace.json"
( cd "$TYR" && git init -q && git add -A && git commit -q -m init ) 2>/dev/null || bad "typography fixture repo setup failed"
TY_OUT=$(sh "$ROOT/scripts/check-typography.sh" --root "$TYR" 2>&1); TY_RC=$?
eq "check-typography: default mode passes a clean checkout" "$TY_RC" "0"
printf 'a \342\200\234quoted\342\200\235 b\n' > "$TYR/docs/INSTALL.md"
( cd "$TYR" && git commit -qam dash ) 2>/dev/null
TY_OUT=$(sh "$ROOT/scripts/check-typography.sh" --root "$TYR" 2>&1); TY_RC=$?
eq "check-typography: default mode fails on a curly quote in docs/" "$TY_RC" "1"
( cd "$TYR" && git rm -q README.md && git commit -qm gone ) 2>/dev/null
TY_OUT=$(sh "$ROOT/scripts/check-typography.sh" --root "$TYR" 2>&1); TY_RC=$?
eq "check-typography: default mode with README.md gone is an error, not a clean pass" "$TY_RC" "1"
has "check-typography: the missing-path error says so" "$TY_OUT" "missing or untracked"

# --- no credential-shaped literals in tracked files ---------------------------
# The Claude plugin directory ships the whole repo and rejects any file holding
# something that looks like a live vendor key. Fixtures keep the prefix, and the
# length wherever a redaction rule has an exact or minimum one, but use a
# placeholder body of E/X/A/M/P/L, x, 0 and separators only; PEM bodies start EXAMPLE. The
# prefixes are assembled from pieces so this block does not match itself.
_B='(^|[^A-Za-z0-9_]|\\[nrt])'
_P="gh""[oprsu]_|github""_pat_|sk""_live_|sk""_test_|rk""_test_|xo""x[baprs]-|xa""pp-|sk""-|AK""IA|AI""za|g""l(pat|oas|dt|rtr|rt|cbt|ptt|ft|imt|agent|wt|soat|ffct)-|np""m_"
_TOK="${_B}(${_P})[A-Za-z0-9_-]{10,}|${_B}S""G\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}"
_STRIP="^(${_P})([0-9]{1,2}-)?((ant|proj)-)?(api03-)?"
_BAD=$(cd "$ROOT" || exit 1; git ls-files -z | xargs -0 /usr/bin/grep -IhoE "$_TOK" 2>/dev/null \
  | sed -E 's/^(\\[nrt]|[^A-Za-z])//' | /usr/bin/grep -vx 'xa''pp-config-generator' \
  | sed -E "s/${_STRIP}//; s/^S""G\.//" \
  | /usr/bin/grep -vE '^[EXAMPLx0_.-]+$' || true)
_PEM_BAD=$(cd "$ROOT" || exit 1; git ls-files -z | xargs -0 /usr/bin/grep -IzhoE 'BEGIN [A-Z ]*PRIVATE KEY-----(\\n|[[:space:]])+[A-Za-z0-9+/=]{4,}' 2>/dev/null \
  | tr '\0\n' '  ' | sed 's/BEGIN /\
BEGIN /g' | /usr/bin/grep -E 'KEY-----' | /usr/bin/grep -vE 'KEY-----(\\n| )+EXAMPLE' || true)
# Sanity: the token regex must be a valid ERE (grep exits 2 on a bad one, which the
# `|| true` pipelines above would otherwise swallow as "scanned, clean").
printf '' | /usr/bin/grep -IhoE "$_TOK" >/dev/null 2>&1
if [ "$?" -le 1 ]; then ok "credential guard regex compiles"; else bad "credential guard regex compiles"; fi
eq "no credential-shaped vendor literals in tracked files (placeholder bodies only)" "$_BAD" ""
eq "no PEM key bodies in tracked files (EXAMPLE marker only)" "$_PEM_BAD" ""

# --- isolation guard: verdict (issue #189) ---------------------------------------
# First prove the detector can fire, on a stand-in data dir inside $WORK: a fixture
# buffer is a leak; another session's buffer, log or breadcrumb is not.
ISO_FAKE="$WORK/iso-fake/.claude/throughline"
mkdir -p "$ISO_FAKE/buffer"
iso_snapshot "$ISO_FAKE" > "$WORK/iso-fake.before"
: > "$ISO_FAKE/buffer/session-0b0d2f6e-1c2a-4f6b-9a1e-3d5c7b9a1f20.md"
: > "$ISO_FAKE/buffer/session-ses_2f8a91c0d4ffe1QmXbV7tq3KpL.md"
mkdir -p "$ISO_FAKE/logs" "$ISO_FAKE/buffer/archive"
: > "$ISO_FAKE/logs/handoff-2026-01-01-0900.md"
: > "$ISO_FAKE/.capture-errors"
: > "$ISO_FAKE/buffer/archive/.archiving.Ab12Cd"
eq "isolation guard: other sessions' buffers, logs and breadcrumbs are not leaks" "$(iso_leaks "$WORK/iso-fake.before" "$ISO_FAKE")" ""
: > "$ISO_FAKE/buffer/session-T.md"
: > "$ISO_FAKE/buffer/archive/session-MCPSTAR.md"
has "isolation guard: a fixture-id buffer is a leak" "$(iso_leaks "$WORK/iso-fake.before" "$ISO_FAKE")" "./buffer/session-T.md"
has "isolation guard: an archived fixture-id buffer is a leak" "$(iso_leaks "$WORK/iso-fake.before" "$ISO_FAKE")" "./buffer/archive/session-MCPSTAR.md"
eq "isolation guard: a data dir bootstrapped from nothing is a leak" \
  "$(printf 'ABSENT\n' > "$WORK/iso-absent.before"; iso_leaks "$WORK/iso-absent.before" "$ISO_FAKE" | head -n 1)" "."

# Then the real verdict: nothing this suite ran wrote into a real data dir.
ISO_ALL=$(ISO_N=0; printf '%s\n' "$ISO_SENTINELS" | while IFS= read -r d; do
  ISO_N=$((ISO_N + 1))
  iso_leaks "$WORK/iso-before.$ISO_N" "$d" | sed "s|^\.|$d|"
done)
eq "isolation guard: no hook wrote into this checkout's real data dirs" "$ISO_ALL" ""

echo "----------------------"
printf 'passed: %s   failed: %s\n' "$PASSED" "$FAIL"
[ "$SKIPPED_WINDOWS" -eq 0 ] || printf '  (%s permission-based assertion(s) skipped on Windows/NTFS - see is_windows() above)\n' "$SKIPPED_WINDOWS"
rm -rf "$WORK"
[ "$FAIL" -eq 0 ]
