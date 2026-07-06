#!/bin/sh
# throughline — PreCompact boundary marker.
#
# Fires just before a context compaction. The conversation (and the *reasoning*
# it holds) is about to be summarized and largely lost; the on-disk action
# buffer is not. PreCompact stdout is NOT injected into context, so this cannot
# recover anything itself — what it CAN do is stamp the seam into the buffer so a
# later handoff knows a compaction happened here and treats the actions above the
# line as "distill from the buffer text alone, do not trust conversation recall
# for the why." Mechanical, cheap, always exits 0; never blocks the compaction.

DIR=$(unset CDPATH; cd -- "$(dirname -- "$0")" && pwd)
. "${CLAUDE_PLUGIN_ROOT:-$DIR/..}/hooks/_lib.sh" 2>/dev/null || . "$DIR/_lib.sh"

# Deliberately NOT tl_active() - see session-flush.sh for the full reasoning:
# this hook finalizes bookkeeping for an already-existing buffer, so a
# mid-session .throughlineignore should not veto stamping it, and there is no
# reason to bootstrap a data dir that was never created for this session.
# The machine-wide kill switch DOES apply (see session-flush.sh).
tl_disabled && exit 0
tl_have_jq || exit 0

input=$(cat 2>/dev/null)
data=$(tl_data_dir)
bufdir="$data/buffer"
[ -d "$bufdir" ] || exit 0

sid=$(tl_resolve_sid "$input")
trigger=$(printf '%s' "$input" | jq -r '.trigger // .reason // "auto"' 2>/dev/null)
trigger=$(tl_clean_ctrl "$trigger")
[ -n "$sid" ] || exit 0
buf="$bufdir/session-$sid.md"
[ -f "$buf" ] || exit 0

# Idempotency guard, mirroring session-flush.sh's end-stamp guard but keyed to
# "already the LAST marker" rather than "exists anywhere in the file": a double
# PreCompact fire for one seam must write one boundary, but a long session with
# several genuine compactions must still stamp each one. Skip only when the
# buffer already ends with a boundary marker (no captured action has landed
# since) — two stamps with nothing between them mark the same seam. The marker
# is written as a leading blank line + the comment + a trailing newline, so the
# comment is always the final line; tail -n 1 (not -n 2, which would also catch
# a boundary sitting just above a later captured action and wrongly suppress
# that action's own seam). ^-anchored so a captured command containing the
# marker text (capture lines all begin with "- `") can never suppress a stamp.
if tail -n 1 "$buf" 2>/dev/null | grep -q '^<!-- compaction-boundary'; then
  exit 0
fi

printf -- '\n<!-- compaction-boundary %s (%s) - actions above predate a context compaction; distill them from this buffer, not from conversation recall -->\n' \
  "$(date '+%Y-%m-%d %H:%M:%S')" "$trigger" >> "$buf" 2>/dev/null
exit 0
