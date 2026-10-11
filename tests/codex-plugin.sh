#!/bin/sh
# throughline - Codex plugin manifest check (issue #112).
#
# The Codex plugin ships two files that have to agree with each other and with
# the repo layout:
#
#   .codex-plugin/plugin.json          the plugin manifest Codex loads
#   .agents/plugins/marketplace.json   the marketplace entry that offers it
#
# Before this script neither CI nor .local-ci.json checked that a path the
# manifest advertises actually exists, or that the marketplace entry still
# points at the plugin the manifest describes. Both fail silently at runtime:
# a moved skills/ directory means Codex loads the plugin with no skills, and a
# renamed plugin means the marketplace entry resolves to nothing.
#
# POSIX sh + jq only, so this runs on the Windows leg too (tests/run.sh calls
# it, and that suite runs on all three CI legs). It takes an optional root
# directory as $1 (default: the repo root resolved from this script's own
# location) so a test can point it at a deliberately broken copy without
# touching the real tree.
#
# Usage: sh tests/codex-plugin.sh [root-dir]     (exit 0 = all good)

set -u

ROOT=${1:-}
if [ -z "$ROOT" ]; then
  ROOT=$(unset CDPATH; cd -- "$(dirname -- "$0")/.." && pwd)
fi

fail() {
  printf 'codex-plugin: %s\n' "$1" >&2
  exit 1
}

[ -d "$ROOT" ] || fail "no such root directory: $ROOT"
command -v jq >/dev/null 2>&1 || fail "jq is required but not on PATH"

MANIFEST="$ROOT/.codex-plugin/plugin.json"
MARKETPLACE="$ROOT/.agents/plugins/marketplace.json"

check_file() {
  [ -f "$1" ] || fail "missing file: $1"
  # `jq empty` is NOT a sufficient gate here: it exits 0 on a ZERO-byte file,
  # because an input stream with no values in it is a valid stream. A truncated
  # or hand-empty manifest then sails through and the walk below finds no paths
  # to check at all, so the one file type this check exists to catch - a
  # manifest that no longer describes anything - reads as a clean pass. Requiring
  # a JSON object at the top level rejects empty, array-shaped and `null`
  # content in one gate (`-e` exits 4 when jq produced no output at all), which
  # is also what every field read below assumes anyway. This gate alone still only
  # proves the file is an object; the required-field reads below are what pin that
  # the file still names the paths the plugin is built from.
  if ! jq -e 'type == "object"' "$1" >/dev/null 2>&1; then
    fail "invalid JSON: $1 (must be a non-empty JSON object)"
  fi
}
check_file "$MANIFEST"
check_file "$MARKETPLACE"

# 1. Required references. The generic walk in the next section can only prove that
#    the "./" strings STILL PRESENT in a file resolve; it says nothing about one that
#    was deleted, so a manifest reduced to `{"name": "throughline"}` - nothing left to
#    walk, nothing left to fail - reads as clean. That is exactly the degenerate case
#    the JSON gate above was tightened for, so the two references this plugin is made
#    of are required by name, in the file that owns each: the manifest owns the skills
#    directory, and the marketplace entry owns the source path (that read sits in
#    section 3, since the matching entry has to be identified first). Each must be a
#    string starting with "./" - the same shape the walk resolves - because anything
#    else is unresolvable by construction, whether or not a directory of that name
#    happens to exist.
#
#    Read through `tr` like every other scalar read: `// empty` maps a missing or null
#    field to the empty string, which is what the "no ... path" branch keys on, and a
#    CR glued to the value would defeat the "./" prefix match below.
# A required path must also fit on ONE line, and the check for that runs INSIDE jq, on
# the JSON value as the file states it - not on a shell copy. Two checks leave a gap a
# single-line value cannot fall through: the walk skips multi-line strings on purpose
# (the prose false-positive exclusion), so a value split over lines is a reference
# nothing resolves; and a `case` pattern's `*` matches a newline, so a prefix test alone
# happily accepts `./no-such-dir/` followed by a second line. A shell-side newline test
# does not close the gap either: command substitution STRIPS trailing newlines, so for
# `.skills = "./skills/\n"` the read below hands back a pristine `./skills/` - prefix
# test passes - while the walk skips the multi-line value, and the run exits 0 on a
# manifest whose only path reference resolves to nothing: the directory exists under
# the unstripped spelling, so even an existence test on the raw value would not catch
# it. A CR reaches the same hole by a different door - the reads and the walk strip CRs
# (a transport normalization), so `.skills = "./skills/\r"` was checked as `./skills/`,
# a path the manifest never named. And a third door is NUL: command substitution
# silently DROPS NUL bytes from jq's output (bash deletes them, dash truncates at
# them - both measured), so `.skills = "./skills/\u0000"` reads back as `./skills/`
# too. jq sees every control character at every position - leading, interior, trailing
# - so the detection happens there, on the parsed value, where a transport CR (added
# to jq's stdout line endings AFTER parsing) cannot be confused with a `\r` the JSON
# itself escaped. Written positively ("is a string containing a C0 control") rather
# than as a pass gate, so non-strings and missing fields fall through to the two
# branches below, which name those cases precisely; `and` short-circuits, so `explode`
# is never evaluated on a non-string, and a jq error (exit 2/5) simply does not fire
# this branch, exactly like every other guarded read here. The class is every C0
# control, not just [\r\n]: NUL demonstrated that "a control char reaches the
# existence test verbatim" is false for the pipeline's own edits, and once the class
# is earned, a bare tab in a required path is refused on shape too rather than
# surviving as a mystery 404. The read is regex-free (explode + codepoint compare) so
# it cannot silently no-op on a jq build without Oniguruma.
if jq -e '.skills | type == "string" and ((explode | map(select(. < 32)) | length) > 0)' "$MANIFEST" >/dev/null 2>&1; then
  fail "manifest .skills must be a single-line path: got an embedded control character in $MANIFEST"
fi

MANIFEST_SKILLS=$(jq -r '.skills // empty' "$MANIFEST" | tr -d '\r')
[ -n "$MANIFEST_SKILLS" ] || fail "manifest has no .skills path in $MANIFEST"
case "$MANIFEST_SKILLS" in
  ./*) ;;
  *) fail "manifest .skills must be a ./-relative path: got '$MANIFEST_SKILLS' in $MANIFEST" ;;
esac

# 2. Path resolution. Every "./"-relative string in either file is a path the
#    harness resolves against the repo root, so every one is collected with a
#    generic walk rather than a hardcoded key list - a new "./..." field in a
#    manifest is checked the moment it is added, not whenever someone remembers
#    to extend this script. "./" itself (the marketplace entry's source path)
#    resolves to the root and is expected to exist, like everything else.
#
#    Multi-line strings are excluded from the walk: the loop below reads one
#    line at a time, so prose that merely BEGINS with "./" and continues onto a
#    second line would be chopped into fragments and fail as a path no field
#    ever claimed. The exclusion covers PROSE only - a newline with text after
#    it. A "./" string whose newline has nothing after it (a path with a
#    trailing LF) is not prose and is NOT quietly dropped: the control-character
#    gate below refuses it on shape, because "dropped by a select()" is exactly
#    the silent pass this whole series of fixes exists to close.
#
#    Carriage returns are stripped from whatever `read` hands back, and this is not
#    defensive padding. A CR can reach `$path` from two TRANSPORT sources on the Windows
#    leg: jq writing CRLF-terminated stdout, or the here-doc below (MSYS opens files in
#    text mode). The strip sits AFTER `read` because that is the one position covering a
#    CR introduced by either source. It normalizes transport ONLY: CRLF file line
#    endings put CRs between JSON tokens, where jq's parser drops them as whitespace,
#    and a CR inside a string VALUE takes a `\r` escape - which the gate below refuses
#    on shape before this loop ever runs, so the strip can never quietly substitute a
#    different path for the one the file names. `$path` is then used only in quoted
#    positions.
#
#    A ".." SEGMENT IS REJECTED, NEVER RESOLVED. The "./" prefix is a promise that the
#    reference stays inside the root, and an existence test cannot keep that promise:
#    `./../x` resolves outside ROOT and PASSES whenever something happens to live at
#    that spot, so a file outside the plugin would be reported as a satisfied manifest
#    field. Neither file may claim that, so escaping is refused on shape - which also
#    means it can never be mistaken for a clean pass. The patterns are SEGMENT-anchored,
#    not a bare two-dot match, because `foo..` is a legal directory name: `./a..b/`,
#    `./foo../` and `./a/..b` all go through to the existence test, while `./..`,
#    `./../`, `./a/..`, `./a/../` and `./a/../b` are all refused. The interior pattern
#    needs its trailing `*` to reach `./a/../b` - a `case` pattern is fully anchored, so
#    one ending at `/../` would only catch a path that ENDS with a `..` segment and would
#    let `./a/../b` out through the middle.
check_paths() {
  file="$1"
  # A CR inside a "./" string is refused on shape, never normalized away - and this
  # closes the NON-REQUIRED fields that the two required-field gates above cannot
  # reach. The loop below strips CRs to undo a transport artifact; an existence test
  # after that strip would check a path the file does not name - `./x\r` verified as
  # `./x`, which exists for the values a real tree carries: a silent pass built on a
  # value the pipeline edited. Transport CRs never reach this jq call, because they
  # are added to its stdout line endings by the platform AFTER parsing, so `any` only
  # ever reports a CR that the JSON itself escaped as \r - no false positive on the
  # Windows leg. Prose CRs outside "./" strings are none of this check's business;
  # only references are pinned.
  if jq -e 'any(.. | strings; startswith("./") and contains("\r"))' "$file" >/dev/null 2>&1; then
    fail "path reference in $file contains a carriage return: a CR here would be stripped as a transport artifact, checking a path the file does not name"
  fi
  # And a second gate for the rest of the C0 controls, closing what the CR gate and
  # the two required-field gates cannot reach: NON-required "./" strings. NUL is the
  # reason the class is not just newlines - command substitution drops NUL bytes from
  # jq's output silently (bash deletes, dash truncates), so `./x` + NUL would reach
  # the loop as `./x`, which a real tree carries. A trailing newline is the same
  # species: the select() below drops it as prose and nothing resolves it. PROSE is
  # exempt, defined as a newline with text after it (the longDescription fixture's
  # shape) - a string whose newline(s) have nothing after them is a path plus
  # dangling control bytes, not prose. Regex-free like the gates above, so no
  # dependence on jq's regex build. Consequence stated plainly: a TAB inside a
  # non-required "./" path is now refused on shape too, where it previously reached
  # the existence test verbatim - a real filename containing a tab would have to be
  # referenced some other way, which is the right trade for a check whose whole
  # subject is references resolving to the wrong thing.
  if jq -e 'any(.. | strings; startswith("./") and ((explode | map(select(. < 32)) | length) > 0) and ((contains("\n") and ((. / "\n" | last) != "")) | not))' "$file" >/dev/null 2>&1; then
    fail "path reference in $file contains a control character: NUL and trailing-newline spellings of a path are erased or dropped by the line-based read, so they are refused on shape (prose with text after a newline is the exempt case)"
  fi
  paths=$(jq -r '.. | strings | select(startswith("./") and (contains("\n") | not))' "$file") \
    || fail "could not read strings from $file"
  while IFS= read -r path; do
    path=$(printf '%s' "$path" | tr -d '\r')
    [ -n "$path" ] || continue
    case "$path" in
      ./..|./../*|*/..|*/../*)
        fail "path escapes the root: '$path' referenced by $file (.. segments are not allowed)"
        ;;
    esac
    if [ ! -e "$ROOT/$path" ]; then
      fail "missing path '$path' referenced by $file (resolved to $ROOT/$path)"
    fi
  done <<EOF
$paths
EOF
}

# 3. Marketplace parity. The manifest's `name` is the identity Codex installs
#    under; the marketplace entry with that name is the one that offers it. Zero
#    matches means the plugin is unlisted, more than one means two entries
#    compete for one install, and either way nothing here fails at runtime - so
#    both are named explicitly rather than lumped into one "mismatch" message.
# The four scalar reads below pipe through `tr`, which replaces jq's exit status
# with tr's. Each one is guarded by a value check instead of a status check for
# that reason: an empty NAME fails, a non-numeric COUNT fails, and an empty
# version is the documented "absent" case. The `tr` is the same CRLF normalisation
# as check_paths - a CR glued to NAME would otherwise be reported as a name that
# does not exist in the marketplace, and a CR glued to COUNT would trip the
# numeric guard.
NAME=$(jq -r '.name // empty' "$MANIFEST" | tr -d '\r')
[ -n "$NAME" ] || fail "manifest has no name: $MANIFEST"
# Same C0 class as the path gates, on the field that IS the install identity:
# `$(...)` and `tr` erase trailing newlines, CRs and NULs, so a manifest named
# "throughline\n" reads back as `throughline`, matches the marketplace entry, and the
# parity verdict compares a value neither file states - while Codex installs under
# the unstripped name. Detected in jq, on the parsed value, before any comparison.
if jq -e '.name | type == "string" and ((explode | map(select(. < 32)) | length) > 0)' "$MANIFEST" >/dev/null 2>&1; then
  fail "manifest .name must be free of control characters: got an embedded control character in $MANIFEST"
fi

# The entry list has to BE AN ARRAY before the count below can mean anything, and
# that is not hypothetical: measured here with `.plugins` set to a string (or to
# null), `.plugins[]?` swallows the index error, the count comes back a well-formed
# 0, and the check reports "no marketplace entry named 'throughline'" - it calls a
# malformed file "unlisted". It never reads as a clean pass, so this is only about the
# verdict being TRUE, which is the whole point of naming each failure mode separately.
if ! jq -e '.plugins | type == "array"' "$MARKETPLACE" >/dev/null 2>&1; then
  fail "marketplace .plugins is not an array in $MARKETPLACE"
fi

COUNT=$(jq -r --arg n "$NAME" '[.plugins[]? | select(.name == $n)] | length' "$MARKETPLACE" | tr -d '\r')
# A non-numeric COUNT means the count query itself failed, not that it found 0 or 2
# entries. This call has no `-e`, so jq writes NOTHING and exits non-zero on error -
# the code depends on the failure mode: 2 for an unreadable file, 3 for an unknown
# filter, 5 for a bad index or failed write. `tr` in the pipe then reports its own 0,
# which is why the guard is on the VALUE and not the status. A query that could not
# run must not fall into the "want exactly 1" branch below and read as a parity
# problem; an absent or renamed entry is not this branch either - that is a
# well-formed 0.
case "$COUNT" in
  ''|*[!0-9]*) fail "could not count plugins in $MARKETPLACE" ;;
esac
if [ "$COUNT" = "0" ]; then
  fail "no marketplace entry named '$NAME' in $MARKETPLACE"
elif [ "$COUNT" != "1" ]; then
  fail "$COUNT marketplace entries named '$NAME' in $MARKETPLACE (want exactly 1)"
fi

# The entry's `source.path` is how the harness finds the plugin in the first place,
# and the walk in section 2 cannot pin it: delete the field and the walk simply has one
# fewer string to check, so the entry silently stops pointing anywhere and the check
# still reports clean. Required here, where exactly one matching entry is known to
# exist, under the same shape rules as the manifest's skills path - including the
# single-line gate in jq, for the same command-substitution reason given there:
# checked on the shell's copy, `"./\n"` reads as the real, valid `./` (and `"./\r"`
# reads as it after the CR strip) while the value it stands for resolves nowhere. If
# `source` is not an object at all the gate errors (exit 5, does not fire) and the read
# comes back empty and lands in the "no source.path" branch: the message is then
# imprecise about a genuinely broken entry, which is tolerable - a pass would not be.
if jq -e --arg n "$NAME" \
  '(.plugins[]? | select(.name == $n) | .source.path) | type == "string" and ((explode | map(select(. < 32)) | length) > 0)' \
  "$MARKETPLACE" >/dev/null 2>&1; then
  fail "marketplace source.path must be a single-line path: got an embedded control character in $MARKETPLACE"
fi
SOURCE_PATH=$(jq -r --arg n "$NAME" '(.plugins[]? | select(.name == $n) | .source.path) // empty' "$MARKETPLACE" 2>/dev/null | tr -d '\r')
[ -n "$SOURCE_PATH" ] || fail "marketplace entry '$NAME' has no source.path in $MARKETPLACE"
case "$SOURCE_PATH" in
  ./*) ;;
  *) fail "marketplace source.path must be a ./-relative path: got '$SOURCE_PATH' in $MARKETPLACE" ;;
esac

# `version` is optional in the marketplace schema, and this repo's entry does
# not carry one today (the manifest is the single source of truth, and the
# existing "plugin version agreement" check pins the manifest against the other
# three plugins). So a missing version is a pass - adding one here would just
# invent a second copy to drift - but a present one is a promise: it must equal
# the manifest's, or the marketplace advertises an install of a version that is
# not the one in the tree.
MANIFEST_VERSION=$(jq -r '.version // empty' "$MANIFEST" | tr -d '\r')
ENTRY_VERSION=$(jq -r --arg n "$NAME" '(.plugins[]? | select(.name == $n) | .version) // empty' "$MARKETPLACE" 2>/dev/null | tr -d '\r')
# "A present version is a promise" only holds if the compared strings are the ones the
# files state, and the drift comparison below reads through the same erasing pipeline
# as every other read: an entry `.version = "0.16.0\n"` compares equal to a clean
# manifest version and reports no drift. Gated in jq on both sides, tolerating
# absence (null short-circuits past the type test - a missing entry version stays the
# documented pass).
if jq -e '.version | type == "string" and ((explode | map(select(. < 32)) | length) > 0)' "$MANIFEST" >/dev/null 2>&1; then
  fail "manifest .version must be free of control characters: got an embedded control character in $MANIFEST"
fi
if jq -e --arg n "$NAME" \
  '(.plugins[]? | select(.name == $n) | .version) | type == "string" and ((explode | map(select(. < 32)) | length) > 0)' \
  "$MARKETPLACE" >/dev/null 2>&1; then
  fail "marketplace entry .version must be free of control characters: got an embedded control character in $MARKETPLACE"
fi
if [ -n "$ENTRY_VERSION" ] && [ "$ENTRY_VERSION" != "$MANIFEST_VERSION" ]; then
  fail "version drift for plugin '$NAME': manifest '$MANIFEST_VERSION' vs marketplace '$ENTRY_VERSION'"
fi

# The walk is CALLED here, not where it is defined, and the order is a decision rather
# than an accident: the named-field reads above (the manifest's .skills, the matched
# entry's source.path) each own a verdict about their own field, and when one file
# carries more than one defect the most specific check should claim it first. With the
# walk running first, a `source.path = "./\r"` was reported by the walk's generic
# "path reference contains a carriage return" instead of the source.path gate's own
# message - correct verdict, lazier reason. Named checks first, generic catch-all
# last.
check_paths "$MANIFEST"
check_paths "$MARKETPLACE"

exit 0
