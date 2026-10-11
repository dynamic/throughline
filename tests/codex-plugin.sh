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
#    ever claimed. A real path reference is one line, so dropping the multi-line
#    case removes that false-positive risk without losing coverage.
#
#    Carriage returns are stripped from whatever `read` hands back, and this is not
#    defensive padding. A CR can reach `$path` from two places on the Windows leg: jq
#    writing CRLF-terminated stdout, or the here-doc below (MSYS opens files in text
#    mode). The strip sits AFTER `read` because that is the one position covering a CR
#    introduced by either source, plus a deliberately CRLF-authored manifest. `$path`
#    is then used only in quoted positions.
#
#    A ".." SEGMENT IS REJECTED, NEVER RESOLVED. The "./" prefix is a promise that the
#    reference stays inside the root, and an existence test cannot keep that promise:
#    `./../x` resolves outside ROOT and PASSES whenever something happens to live at
#    that spot, so a file outside the plugin would be reported as a satisfied manifest
#    field. Neither file may claim that, so escaping is refused on shape - which also
#    means it can never be mistaken for a clean pass. The patterns match `..` only as a
#    whole segment, so a name that merely contains two dots (`./a..b/`) is untouched.
check_paths() {
  file="$1"
  paths=$(jq -r '.. | strings | select(startswith("./") and (contains("\n") | not))' "$file") \
    || fail "could not read strings from $file"
  while IFS= read -r path; do
    path=$(printf '%s' "$path" | tr -d '\r')
    [ -n "$path" ] || continue
    case "$path" in
      *../*|*/..|..)
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
check_paths "$MANIFEST"
check_paths "$MARKETPLACE"

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
# exist, under the same shape rule as the manifest's skills path. If `source` is not an
# object at all the read comes back empty and lands in the "no source.path" branch:
# the message is then imprecise about a genuinely broken entry, which is tolerable - a
# pass would not be.
SOURCE_PATH=$(jq -r --arg n "$NAME" '(.plugins[]? | select(.name == $n) | .source.path) // empty' "$MARKETPLACE" | tr -d '\r')
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
ENTRY_VERSION=$(jq -r --arg n "$NAME" '(.plugins[]? | select(.name == $n) | .version) // empty' "$MARKETPLACE" | tr -d '\r')
if [ -n "$ENTRY_VERSION" ] && [ "$ENTRY_VERSION" != "$MANIFEST_VERSION" ]; then
  fail "version drift for plugin '$NAME': manifest '$MANIFEST_VERSION' vs marketplace '$ENTRY_VERSION'"
fi

exit 0
