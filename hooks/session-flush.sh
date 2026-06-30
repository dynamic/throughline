#!/bin/sh
# throughline — SessionEnd safety-net flush.
#
# SessionEnd hooks run a shell command only — the model is gone, so this cannot
# write a curated handoff (that happens live, with judgment, at wrap-up). What it
# CAN do is guarantee nothing is lost: stamp the session buffer as ended so the
# next session's onboard surfaces it for retroactive distillation. Always exits 0.

DIR=$(unset CDPATH; cd -- "$(dirname -- "$0")" && pwd)
. "${CLAUDE_PLUGIN_ROOT:-$DIR/..}/hooks/_lib.sh" 2>/dev/null || . "$DIR/_lib.sh"

tl_active || exit 0
tl_have_jq || exit 0

input=$(cat 2>/dev/null)
data=$(tl_data_dir)
bufdir="$data/buffer"
[ -d "$bufdir" ] || exit 0

# Resolve the session id the same way capture does, so the stamp lands on the
# right buffer (and never on a "nosession" file capture refuses to create).
sid=$(printf '%s' "$input" | jq -r '.session_id // ""' 2>/dev/null)
sid=$(tl_safe_sid "$sid")
# Control-char neutralization here is duplicated in session-capture.sh's
# `clean` def and session-precompact.sh's trigger gsub (no shared jq module
# exists to factor it into) — keep all three in sync if it ever changes.
reason=$(printf '%s' "$input" | jq -r '(.reason // "end") | gsub("[[:cntrl:]]"; " ")' 2>/dev/null)
buf="$bufdir/session-$sid.md"

if [ -n "$sid" ] && [ -f "$buf" ]; then
  # Stamp once. Anchor the guard to the start of a line so a captured command or
  # description containing the marker text cannot suppress a real stamp (capture
  # lines all begin with "- `", so they never match this anchor).
  grep -q '^<!-- session-ended' "$buf" 2>/dev/null || \
    printf -- '\n<!-- session-ended %s (%s) -->\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$reason" >> "$buf" 2>/dev/null
fi
exit 0
