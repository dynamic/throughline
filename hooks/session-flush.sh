#!/bin/sh
# throughline — SessionEnd safety-net flush.
#
# SessionEnd hooks run a shell command only — the model is gone, so this cannot
# write a curated handoff (that happens live, with judgment, at wrap-up). What it
# CAN do is guarantee nothing is lost: stamp the session buffer as ended so the
# next session's onboard surfaces it for retroactive distillation. Always exits 0.

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "${CLAUDE_PLUGIN_ROOT:-$DIR/..}/hooks/_lib.sh" 2>/dev/null || . "$DIR/_lib.sh"

tl_active || exit 0

input=$(cat 2>/dev/null)
data=$(tl_data_dir)
bufdir="$data/buffer"
[ -d "$bufdir" ] || exit 0

sid=$(printf '%s' "$input" | jq -r '.session_id // ""' 2>/dev/null)
reason=$(printf '%s' "$input" | jq -r '.reason // "end"' 2>/dev/null)
buf="$bufdir/session-$sid.md"

if [ -n "$sid" ] && [ -f "$buf" ]; then
  # Only stamp once.
  grep -q '<!-- session-ended' "$buf" 2>/dev/null || \
    printf -- '\n<!-- session-ended %s (%s) -->\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$reason" >> "$buf" 2>/dev/null
fi
exit 0
