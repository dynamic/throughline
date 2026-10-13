#!/bin/sh
# throughline - Codex plugin manifest check (issue #112).
#
# The Codex plugin is installed from two files that have to agree with each other
# and with the repo layout:
#
#   .codex-plugin/plugin.json          the manifest Codex loads
#   .agents/plugins/marketplace.json   the marketplace entry that offers it
#
# Before this script, nothing checked that a path either file names actually
# exists, or that the marketplace entry still points at the plugin the manifest
# describes. Both fail silently at install time: a moved skills/ directory means
# Codex installs the plugin with no skills, and a renamed plugin means the
# marketplace entry resolves to nothing.
#
# The fields are read BY NAME, not collected by a generic "./" walk over every
# string in the file: a walk can only prove that the "./" strings still PRESENT in
# a file resolve, so a manifest that had stopped naming its skills directory - or a
# marketplace entry that had stopped saying where the plugin lives - would leave it
# nothing to check and read as a clean pass. Only these two files, only these
# fields.
#
# POSIX sh + jq only, so this runs on the Windows CI leg (tests/run.sh calls it,
# and that suite runs on all three legs).
#
# Usage: sh tests/codex-plugin.sh [root-dir]     (exit 0 = all good)

set -u

# Optional root override so a test can point the check at a deliberately broken
# copy of the manifests without touching the real tree.
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

check_object() {
  [ -f "$1" ] || fail "missing file: $1"
  # `jq empty` is not a sufficient gate: it exits 0 on a ZERO-byte file, because a
  # value stream containing no values is a valid stream. A truncated or hand-
  # emptied manifest then sails through and every read below comes back empty, so
  # the one file type this check exists to catch - a manifest that no longer
  # describes anything - would read as clean. Requiring a JSON object rejects
  # empty, array-shaped and null content in one gate (-e exits 4 when jq produced no
  # output at all), which is also what every field read below assumes anyway.
  jq -e 'type == "object"' "$1" >/dev/null 2>&1 \
    || fail "invalid JSON: $1 (must be a JSON object)"
}
check_object "$MANIFEST"
check_object "$MARKETPLACE"

# Every scalar read below goes through `tr -d '\r'`, and that is not defensive
# padding. On the Windows leg a CR can end up glued to the value either from jq's
# own output or from a CRLF-authored manifest file, and a CR at the END of a path
# defeats both the "./" prefix match and the existence test, while a CR at the end
# of a name makes a matching marketplace entry look unlisted.
#
# require_path <value> <file> <what> - a path reference must be a non-empty,
# ./-prefixed string naming something that exists once resolved against $ROOT. The
# pattern is `./*`, and because a `case` wildcard matches zero characters too, bare
# `./` - the value this repo's marketplace entry uses for the plugin root itself -
# is accepted by it as well.
#
# What it does NOT do: refuse a `..` SEGMENT. `./../../` is ./-prefixed, resolves
# outside the root, and passes the existence test whenever something happens to live
# there, so the "./" prefix is a statement about how the path is written, not a
# containment guarantee. Deliberate for issue #112: both files are repo-authored and
# reviewed with the tree, so the failure mode worth automating is a moved directory
# or a renamed plugin, not a hand-written escape.
require_path() {
  [ -n "$1" ] || fail "$3 is missing from $2"
  case "$1" in
    ./*) ;;
    *) fail "$3 must be a ./-relative path: got '$1' in $2" ;;
  esac
  [ -e "$ROOT/$1" ] || fail "$3 does not resolve: '$1' in $2 (looked for $ROOT/$1)"
}

# 1. The manifest must name its skills directory. Nothing else in the repo pins
#    this field, and a manifest without it installs a plugin with no skills.
MANIFEST_SKILLS=$(jq -r '.skills // empty' "$MANIFEST" | tr -d '\r')
require_path "$MANIFEST_SKILLS" "$MANIFEST" "manifest .skills"

# 2. Marketplace parity. The manifest's `name` is the identity Codex installs
#    under, so exactly one entry has to carry it: zero means the plugin is
#    unlisted, more than one means two entries compete for one install, and
#    neither fails anywhere except here.
NAME=$(jq -r '.name // empty' "$MANIFEST" | tr -d '\r')
[ -n "$NAME" ] || fail "manifest has no .name in $MANIFEST"

# The entry list has to BE AN ARRAY before the count below can mean anything. Without
# the gate a non-array is reported as something it is not: when `.plugins` is a string
# `.plugins[]?` swallows the index error, the count comes back a well-formed 0, and the
# run says "no marketplace entry named 'x'" about a file that has no entry list at all.
# An object is worse - `[]?` iterates its values, so an object whose one value happens
# to carry the name would be counted as a listing of exactly that one entry.
if ! jq -e '.plugins | type == "array"' "$MARKETPLACE" >/dev/null 2>&1; then
  fail "marketplace .plugins is not an array in $MARKETPLACE"
fi

# The count is guarded on its VALUE rather than on jq's exit status, because `| tr`
# replaces jq's status with tr's. With the array gate above, the shape that reaches the
# count as EMPTY output is an array whose members are not objects: `select(.name == $n)`
# dies indexing a member of a string, jq writes nothing, and tr still reports success.
# A query that could not run must not fall into the "want exactly 1" branch below and be
# reported as a listing problem it is not.
COUNT=$(jq -r --arg n "$NAME" '[.plugins[]? | select(.name == $n)] | length' "$MARKETPLACE" | tr -d '\r')
case "$COUNT" in
  '' | *[!0-9]*) fail "could not count marketplace entries in $MARKETPLACE" ;;
esac
if [ "$COUNT" = "0" ]; then
  fail "no marketplace entry named '$NAME' in $MARKETPLACE"
elif [ "$COUNT" != "1" ]; then
  fail "$COUNT marketplace entries named '$NAME' in $MARKETPLACE (want exactly 1)"
fi

# 3. The matched entry's source.path is how the harness finds the plugin at all,
#    so it is required here, where exactly one matching entry is known to exist.
SOURCE_PATH=$(jq -r --arg n "$NAME" \
  '(.plugins[]? | select(.name == $n) | .source.path) // empty' "$MARKETPLACE" | tr -d '\r')
require_path "$SOURCE_PATH" "$MARKETPLACE" "marketplace entry '$NAME' source.path"

# Pointing at the plugin is more than pointing at something that exists: `./hooks/` is a
# real directory that holds no manifest, and an entry aimed at it installs nothing. This
# repo's layout puts the plugin at the repo root and its entry says `./`, so the file
# below IS the one already read at the top - asserted rather than assumed, because the
# pairing between an entry and a manifest is exactly what this check exists to pin.
# (The manifest itself is still read from $ROOT: the entry can only be identified by the
# manifest's own name, so the two reads cannot be ordered the other way round.)
[ -f "$ROOT/$SOURCE_PATH/.codex-plugin/plugin.json" ] \
  || fail "marketplace entry '$NAME' source.path does not contain a plugin manifest: '$SOURCE_PATH' in $MARKETPLACE (looked for $ROOT/$SOURCE_PATH/.codex-plugin/plugin.json)"

# 4. `version` is optional in the marketplace schema and this repo's entry does
#    not carry one today - the manifest is the single source of truth, and
#    .local-ci.json's "plugin version agreement" check pins the manifest against
#    the other three plugins. A missing version is therefore a pass (inventing a
#    second copy here would only invent a second thing to drift), but a present
#    one is a promise: it must be the version that is actually in the tree.
MANIFEST_VERSION=$(jq -r '.version // empty' "$MANIFEST" | tr -d '\r')
ENTRY_VERSION=$(jq -r --arg n "$NAME" \
  '(.plugins[]? | select(.name == $n) | .version) // empty' "$MARKETPLACE" | tr -d '\r')
if [ -n "$ENTRY_VERSION" ] && [ "$ENTRY_VERSION" != "$MANIFEST_VERSION" ]; then
  fail "version drift for plugin '$NAME': manifest '$MANIFEST_VERSION' vs marketplace '$ENTRY_VERSION'"
fi

exit 0
