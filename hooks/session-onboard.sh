#!/bin/sh
# throughline — SessionStart orientation.
#
# When a project is throughline-active, inject a short context block at session
# start: a pointer to the durable HANDOFF.md plus live git state. This automates
# the cheap half of orientation; it complements Claude Code's native MEMORY.md
# auto-load (global durable facts) with project-level state. Cheap, offline.
# Always exits 0.

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "${CLAUDE_PLUGIN_ROOT:-$DIR/..}/hooks/_lib.sh" 2>/dev/null || . "$DIR/_lib.sh"

tl_active || exit 0

root=$(tl_root)
data=$(tl_data_dir)
hf="$data/HANDOFF.md"

echo "## throughline — project session context"
echo
if [ -f "$hf" ]; then
  echo "Durable handoff exists at \`$(printf '%s' "$hf" | sed "s|$root/||")\` — read it before starting."
  grep -m1 -i "last updated" "$hf" 2>/dev/null
else
  echo "No HANDOFF.md yet for this project. One will be written at the next handoff."
fi

# Surface any unconsumed buffers from prior sessions (e.g. a crash before handoff).
pending=$(ls -1 "$data/buffer"/session-*.md 2>/dev/null | wc -l | tr -d ' ')
if [ "$pending" != "0" ]; then
  echo
  echo "⚠️ $pending unconsumed session buffer(s) in \`buffer/\` — a prior session ended without a handoff. Consider distilling them."
fi

if git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo
  echo "### Live git state"
  echo '```'
  echo "branch: $(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  git -C "$root" status -s 2>/dev/null | head -20
  echo '```'
fi
exit 0
