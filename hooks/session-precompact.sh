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

tl_active || exit 0
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

printf -- '\n<!-- compaction-boundary %s (%s) - actions above predate a context compaction; distill them from this buffer, not from conversation recall -->\n' \
  "$(date '+%Y-%m-%d %H:%M:%S')" "$trigger" >> "$buf" 2>/dev/null
exit 0
