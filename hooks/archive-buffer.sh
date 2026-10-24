#!/bin/sh
# throughline — archive distilled capture buffers (issue #79).
#
# Called by the handoff skill's "consume the buffers" step, not by a harness
# event. Moves each DIR/session-<id>.md into DIR/archive/ and never overwrites:
# a session id is stable for the whole session, so a second handoff in the same
# session archives a buffer with the same name as the first run's. When the
# archived file already exists, the live buffer is appended to it under a
# boundary marker, so the archive keeps one file per session with every window
# in order.
#
# Usage: sh hooks/archive-buffer.sh DIR/session-<id>.md [...]
# Exit 0 when every buffer was archived; non-zero if any was not (that buffer
# is left in place, so nothing is lost and the next handoff retries it).
#
# The live buffer is renamed into archive/ first and only then appended: a
# rename is atomic, and capture opens the buffer per event with `>>`, so a
# record written mid-archive lands in a fresh live buffer instead of being
# dropped between a copy and a delete.

DIR=$(unset CDPATH; cd -- "$(dirname -- "$0")" && pwd)
. "${CLAUDE_PLUGIN_ROOT:-$DIR/..}/hooks/_lib.sh" 2>/dev/null || . "$DIR/_lib.sh"

[ "$#" -gt 0 ] || { echo "usage: archive-buffer.sh DIR/session-<id>.md [...]" >&2; exit 2; }

rc=0
for buf in "$@"; do
  if [ ! -f "$buf" ]; then
    echo "archive-buffer: no such buffer: $buf" >&2
    rc=1
    continue
  fi
  name=$(basename -- "$buf")
  arch="$(dirname -- "$buf")/archive"
  dest="$arch/$name"
  if ! mkdir -p "$arch" 2>/dev/null; then
    echo "archive-buffer: cannot create $arch" >&2
    rc=1
    continue
  fi
  if [ ! -e "$dest" ]; then
    # Plain move only when nothing is there. POSIX mv has no portable
    # no-clobber flag, so the check and the move are two steps; only a
    # handoff archives buffers, so nothing else races to create $dest.
    mv -- "$buf" "$dest" 2>/dev/null || { echo "archive-buffer: move failed: $buf" >&2; rc=1; }
    continue
  fi
  tmp="$arch/.$name.$$"
  if ! mv -- "$buf" "$tmp" 2>/dev/null; then
    echo "archive-buffer: move failed: $buf" >&2
    rc=1
    continue
  fi
  if { printf -- '\n<!-- archive-append %s - a later handoff in the same session appended the window below -->\n' "$(tl_now)"; cat -- "$tmp"; } >> "$dest" 2>/dev/null; then
    rm -f -- "$tmp"
  else
    # Put the window back where the next handoff will find it. If a new live
    # buffer appeared meanwhile, keep the window beside it instead of on top.
    if [ -e "$buf" ]; then
      echo "archive-buffer: append failed; window kept at $tmp" >&2
    else
      mv -- "$tmp" "$buf" 2>/dev/null || echo "archive-buffer: append failed; window kept at $tmp" >&2
    fi
    rc=1
  fi
done
exit "$rc"
