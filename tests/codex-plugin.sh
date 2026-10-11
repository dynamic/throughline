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
  # is also what every field read below assumes anyway.
  if ! jq -e 'type == "object"' "$1" >/dev/null 2>&1; then
    fail "invalid JSON: $1 (must be a non-empty JSON object)"
  fi
}
check_file "$MANIFEST"
check_file "$MARKETPLACE"

# 1. Path resolution. Every "./"-relative string in either file is a path the
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
#    Carriage returns are stripped from whatever `read` hands back, and this is
#    NOT defensive padding: the Windows CI leg failed this check on a path that
#    plainly exists (`missing path './' ... codex/dupe/.agents/plugins/
#    marketplace.json`, dynamic/throughline#145 run 1) while the same fixture
#    passed on Linux and macOS. The surviving evidence - a one-line jq stream
#    resolving fine and a two-line stream not, with the runner's log showing a
#    bare line break where `$path` is interpolated - points to a trailing CR on
#    every line but the last. Neither source can be named from that evidence
#    alone (the Windows jq, or the here-doc below, since MSYS opens files in text
#    mode), so the strip sits AFTER `read` rather than on the jq stream: that one
#    position covers a CR introduced by either of them, and by a CRLF-authored
#    manifest on purpose. `$path` is then used only in quoted positions.
check_paths() {
  file="$1"
  paths=$(jq -r '.. | strings | select(startswith("./") and (contains("\n") | not))' "$file") \
    || fail "could not read strings from $file"
  while IFS= read -r path; do
    path=$(printf '%s' "$path" | tr -d '\r')
    [ -n "$path" ] || continue
    if [ ! -e "$ROOT/$path" ]; then
      fail "missing path '$path' referenced by $file (resolved to $ROOT/$path)"
    fi
  done <<EOF
$paths
EOF
}
check_paths "$MANIFEST"
check_paths "$MARKETPLACE"

# 2. Marketplace parity. The manifest's `name` is the identity Codex installs
#    under; the marketplace entry with that name is the one that offers it. Zero
#    matches means the plugin is unlisted, more than one means two entries
#    compete for one install, and either way nothing here fails at runtime - so
#    both are named explicitly rather than lumped into one "mismatch" message.
# The three scalar reads below pipe through `tr`, which replaces jq's exit status
# with tr's. Each one is guarded by a value check instead of a status check for
# that reason: an empty NAME fails, a non-numeric COUNT fails, and an empty
# version is the documented "absent" case. The `tr` is the same CRLF normalisation
# as check_paths - a CR glued to NAME would otherwise be reported as a name that
# does not exist in the marketplace, and a CR glued to COUNT would trip the
# numeric guard.
NAME=$(jq -r '.name // empty' "$MANIFEST" | tr -d '\r')
[ -n "$NAME" ] || fail "manifest has no name: $MANIFEST"

COUNT=$(jq -r --arg n "$NAME" '[.plugins[]? | select(.name == $n)] | length' "$MARKETPLACE" | tr -d '\r')
# A non-numeric COUNT means the count itself failed to evaluate (jq produced no
# output, exit 4) rather than that it found 0 or 2 entries - a distinct failure
# mode, and one that must not fall into the "want exactly 1" branch and read as
# a parity problem when the real problem is that the file could not be queried.
case "$COUNT" in
  ''|*[!0-9]*) fail "could not count plugins in $MARKETPLACE" ;;
esac
if [ "$COUNT" = "0" ]; then
  fail "no marketplace entry named '$NAME' in $MARKETPLACE"
elif [ "$COUNT" != "1" ]; then
  fail "$COUNT marketplace entries named '$NAME' in $MARKETPLACE (want exactly 1)"
fi

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
