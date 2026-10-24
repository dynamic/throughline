#!/bin/sh
# Typography gate for outward-facing files: no em/en dashes or curly quotes in
# README, docs and the marketplace description. Internal docs (CHANGELOG,
# HANDOFF, code comments) are exempt. CI (.github/workflows/ci.yml) and
# local-ci (.local-ci.json) both call this script.
#
# Usage: sh scripts/check-typography.sh [--root DIR] [file...]
#   With no file arguments, checks the tracked outward-facing set below in the
#   checkout holding this script (or in DIR). Every path in that set must be
#   tracked: a renamed README or a moved docs/ is an error, not a clean pass.
#   With file arguments, checks those files instead, resolved against the
#   caller's directory (tests/run.sh uses both modes on fixtures).
#
# The pattern is written as escape sequences on purpose: a literal em dash in
# this file would make the check match itself.
#
# LC_ALL is pinned to a UTF-8 locale because git grep -P only enables PCRE2's
# UTF mode under a UTF-8 codeset; elsewhere \x{2013} exceeds the 8-bit maximum
# and the pattern fails to COMPILE (rc 128). A bare `if git grep ...` reads
# that as "no match" and passes clean, so the exit code is checked explicitly:
# only rc 1 counts as a clean pass.
set -u

ROOT=$(unset CDPATH; cd -- "$(dirname -- "$0")/.." && pwd)
if [ "${1:-}" = "--root" ]; then
  [ -n "${2:-}" ] || { echo "check-typography: --root needs a directory" >&2; exit 1; }
  ROOT=$2
  shift 2
fi

PATTERN='[\x{2013}\x{2014}\x{2018}\x{2019}\x{201C}\x{201D}]'

if [ "$#" -gt 0 ]; then
  # git grep, not grep: macOS grep has no -P. `--no-index` refuses a path
  # outside the current directory's tree, so each file is searched from its
  # own directory. Any match wins over no-match; any error wins over both.
  hits='' rc=1
  for f in "$@"; do
    # git grep exits 1 on a path that does not exist, which would read as clean.
    [ -r "$f" ] || { echo "check-typography: cannot read $f" >&2; exit 1; }
    out=$(cd -- "$(dirname -- "$f")" && LC_ALL=C.UTF-8 git grep --no-index -I -n -P "$PATTERN" -- "$(basename -- "$f")")
    r=$?
    if [ "$r" -eq 0 ]; then
      hits="$hits$(printf '%s\n' "$out" | awk -v d="$(dirname -- "$f")" '{ print d "/" $0 }')
"
      [ "$rc" -eq 1 ] && rc=0
    elif [ "$r" -ne 1 ]; then
      rc=$r
    fi
  done
else
  cd "$ROOT" || exit 1
  # git grep also exits 1 on a pathspec that matches nothing, so each path is
  # checked first. An unmatched docs/*.md glob stays literal and fails here too.
  set -- README.md docs/*.md docs/index.html .claude-plugin/marketplace.json
  git ls-files --error-unmatch -- "$@" >/dev/null 2>&1 \
    || { echo "check-typography: an outward-facing path is missing or untracked under $ROOT: $*" >&2; exit 1; }
  hits=$(LC_ALL=C.UTF-8 git grep -I -n -P "$PATTERN" -- "$@")
  rc=$?
fi

if [ "$rc" -eq 0 ]; then
  printf '%s\n' "$hits"
  echo "check-typography: em/en dash or curly quote in outward-facing files (see above); use ASCII punctuation ( - , straight quotes)" >&2
  exit 1
elif [ "$rc" -ne 1 ]; then
  echo "check-typography: the check failed to run (git grep rc=$rc); this must not read as a clean pass" >&2
  exit 1
fi
echo "check-typography: ok"
