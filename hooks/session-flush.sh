#!/bin/sh
# throughline — SessionEnd safety-net flush.
#
# SessionEnd hooks run a shell command only — the model is gone, so this cannot
# write a curated handoff (that happens live, with judgment, at wrap-up). What it
# CAN do is guarantee nothing is lost: stamp the session buffer as ended so the
# next session's onboard surfaces it for retroactive distillation. Always exits 0.

DIR=$(unset CDPATH; cd -- "$(dirname -- "$0")" && pwd)
. "${CLAUDE_PLUGIN_ROOT:-$DIR/..}/hooks/_lib.sh" 2>/dev/null || . "$DIR/_lib.sh"

# Deliberately NOT tl_active() or tl_data_exists(): this hook's job is to
# finalize bookkeeping for a session that already legitimately captured (its
# buffer file already exists), not to decide whether tracking should start or
# continue - if .throughlineignore appears mid-session, capture stops adding
# new entries immediately (it does use tl_active), but the already-recorded
# session still deserves its end-stamp rather than being silently corrupted by
# a decision made after the fact. The bufdir check below is deliberately
# narrower than tl_data_exists (which checks the data dir, not buffer/): if
# the data dir exists but capture never actually ran, there is still nothing
# to finalize here. No bootstrap: if the data dir was never created, this
# session was never tracked either.
#
# The machine-wide kill switch DOES apply, unlike the per-project marker:
# THROUGHLINE_DISABLE means "off entirely" - and unlike a mid-session opt-out
# (a file that appears while a tracked session runs), the env var was already
# set when this session started, so capture never wrote a buffer and there is
# nothing here to corrupt.
tl_disabled && exit 0
tl_have_jq || exit 0

input=$(cat 2>/dev/null)
data=$(tl_data_dir)
bufdir="$data/buffer"
[ -d "$bufdir" ] || exit 0

# Resolve the session id via the shared helper (also used by capture and
# precompact) so the stamp lands on the right buffer (and never on a
# "nosession" file capture refuses to create).
sid=$(tl_resolve_sid "$input")
reason=$(printf '%s' "$input" | jq -r '.reason // "end"' 2>/dev/null)
reason=$(tl_clean_ctrl "$reason")
buf="$bufdir/session-$sid.md"

if [ -n "$sid" ] && [ -f "$buf" ]; then
  # Stamp unless the buffer already ENDS with a stamp - no record after the last
  # one. A repeated SessionEnd for the same stretch adds nothing, but a resumed
  # session (same id, new records after an earlier stamp) gets a new final stamp,
  # which is what onboard reads as "ended" (issue #180). Both patterns are anchored
  # to the start of a line, so captured text containing the marker cannot match
  # (capture lines all begin with "- `").
  # shellcheck disable=SC2016
  if ! awk '
      /^- `[^`]*` \*\*[^*]+\*\*/ { rec = 1 }
      /^<!-- session-ended/ { rec = 0; stamped = 1 }
      END { exit (stamped && !rec) ? 0 : 1 }
    ' "$buf" 2>/dev/null; then
    printf -- '\n<!-- session-ended %s (%s) -->\n' "$(tl_now)" "$reason" >> "$buf" 2>/dev/null
  fi
fi
exit 0
