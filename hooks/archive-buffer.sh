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
# Exit 0 when every buffer was archived; non-zero if any was not. Each failure
# is reported on stderr, and a window that could not be archived is always left
# where the next handoff reads buffers (DIR/session-*.md): back at its own name,
# or beside a newer live buffer as DIR/session-<id>.unmerged-<stamp>.md.
#
# The live buffer is renamed into archive/ first and only then appended. A
# rename is atomic and capture opens the buffer per event with `>>`, so a record
# captured after the rename lands in a fresh live buffer. That narrows the loss
# window to a single write already in flight at the rename, rather than every
# record captured between a copy and a delete.

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
  bufdir=$(dirname -- "$buf")
  arch="$bufdir/archive"
  dest="$arch/$name"
  if ! mkdir -p "$arch" 2>/dev/null; then
    echo "archive-buffer: cannot create $arch; $buf left in place" >&2
    rc=1
    continue
  fi
  if [ ! -e "$dest" ]; then
    # Plain move only when nothing is there. POSIX mv has no portable
    # no-clobber flag, so the check and the move are two steps; two handoffs
    # archiving the same buffer at the same instant could still race here.
    mv -- "$buf" "$dest" 2>/dev/null || { echo "archive-buffer: move failed; $buf left in place" >&2; rc=1; }
    continue
  fi
  # A fresh name per run: a fixed name (say, one keyed on $$) could be reused
  # by a later run and overwrite a window kept from an earlier failure.
  tmp=$(mktemp "$arch/.archiving.XXXXXX" 2>/dev/null) || tmp="$arch/.archiving.$$.$(date +%s)"
  if ! mv -f -- "$buf" "$tmp" 2>/dev/null; then
    rm -f -- "$tmp"
    echo "archive-buffer: move failed; $buf left in place" >&2
    rc=1
    continue
  fi
  if { printf -- '\n<!-- archive-append %s - a later handoff in the same session appended the window below -->\n' "$(tl_now)"; cat -- "$tmp"; } >> "$dest" 2>/dev/null; then
    rm -f -- "$tmp"
    continue
  fi
  # Append failed: put the window back where the next handoff reads buffers.
  # If capture already started a new live buffer, keep the window beside it.
  back=$buf
  [ -e "$back" ] && back="$bufdir/${name%.md}.unmerged-$(date +%Y%m%d%H%M%S)-$$.md"
  if mv -- "$tmp" "$back" 2>/dev/null; then
    echo "archive-buffer: append to $dest failed; window kept at $back" >&2
  else
    echo "archive-buffer: append to $dest failed; window kept at $tmp" >&2
  fi
  rc=1
done
exit "$rc"
