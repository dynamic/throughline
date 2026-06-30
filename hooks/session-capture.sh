#!/bin/sh
# throughline — PostToolUse capture.
#
# Appends a structured one-line record of each mutating action (command run,
# file changed) to a per-session buffer. This is the continuous, compaction-proof
# raw layer that a later handoff distills from. Mechanical and cheap — no model
# call. Always exits 0; never blocks a tool.

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "${CLAUDE_PLUGIN_ROOT:-$DIR/..}/hooks/_lib.sh" 2>/dev/null || . "$DIR/_lib.sh"

tl_active || exit 0

input=$(cat)
data=$(tl_data_dir)
bufdir="$data/buffer"
mkdir -p "$bufdir" 2>/dev/null || exit 0

out=$(printf '%s' "$input" | jq -r '
  (.session_id // "nosession") + "\t" +
  (.tool_name as $t |
    if $t == "Bash" then
      "**bash** " + (.tool_input.description // "") + " — `" +
      ((.tool_input.command // "") | gsub("\n"; " ") | .[0:200]) + "`"
    elif ($t == "Edit" or $t == "Write" or $t == "NotebookEdit") then
      "**" + $t + "** " + (.tool_input.file_path // .tool_input.notebook_path // "?")
    else
      "**" + $t + "**"
    end)
' 2>/dev/null) || exit 0

[ -n "$out" ] || exit 0
sid=${out%%	*}
line=${out#*	}
ts=$(date '+%Y-%m-%d %H:%M:%S')

printf -- '- `%s` %s\n' "$ts" "$line" >> "$bufdir/session-$sid.md" 2>/dev/null
exit 0
