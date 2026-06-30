#!/bin/sh
# throughline — PostToolUse capture.
#
# Appends a structured one-line record of each mutating action (command run,
# file changed) to a per-session buffer. This is the continuous raw layer that a
# later handoff distills from. Mechanical and cheap — no model call. Always
# exits 0; never blocks a tool.
#
# Load-bearing assumption: one logical session == one buffer file, keyed by a
# session_id that stays stable across a context compaction (true on current
# Claude Code, where compaction re-fires SessionStart, not SessionEnd). The
# handoff and onboard skills rely on this.
#
# The raw action buffer survives compaction because it lives on disk; the
# *reasoning* behind those actions lives in the conversation and does not. Run a
# handoff before a long session compacts to preserve the why.

DIR=$(unset CDPATH; cd -- "$(dirname -- "$0")" && pwd)
. "${CLAUDE_PLUGIN_ROOT:-$DIR/..}/hooks/_lib.sh" 2>/dev/null || . "$DIR/_lib.sh"

tl_active || exit 0
tl_have_jq || exit 0   # capture needs jq; onboard surfaces the missing-jq warning visibly

input=$(cat)
data=$(tl_data_dir)
root=$(tl_root)
bufdir="$data/buffer"
mkdir -p "$bufdir" 2>/dev/null || exit 0

out=$(printf '%s' "$input" | jq -r --arg root "$root" '
  # Mask common secret shapes so raw credentials never sit in the buffer. The
  # buffer is gitignored, but a later handoff distills it into committed logs;
  # this is defense-in-depth, not the only barrier (the skill scrubs too).
  def redact:
    gsub("-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----"; "***private-key-redacted***")
    | gsub("(?i)(?<k>\\w*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key))(?<s>\\s*[:=]\\s*|\\s+)(?<v>\"?[^\\s\"]+)"; "\(.k)\(.s)***")
    | gsub("(?i)bearer\\s+(?<t>[A-Za-z0-9._\\-]+)"; "Bearer ***")
    | gsub("(?<pfx>://[^:@/\\s]+):(?<pw>[^@/\\s]+)@"; "\(.pfx):***@")
    | gsub("ghp_[A-Za-z0-9]{10,}"; "ghp_***")
    | gsub("github_pat_[A-Za-z0-9_]{10,}"; "github_pat_***")
    | gsub("gh[opsu]_[A-Za-z0-9]{10,}"; "gh_***")
    | gsub("xox[baprs]-[A-Za-z0-9-]{6,}"; "xox-***")
    | gsub("sk-[A-Za-z0-9]{10,}"; "sk-***")
    | gsub("AKIA[0-9A-Z]{12,}"; "AKIA***")
    | gsub("AIza[0-9A-Za-z_\\-]{35}"; "AIza***")
    | gsub("(?i)\\bbasic\\s+[A-Za-z0-9+/=]{8,}"; "Basic ***");
  # Neutralize control chars (incl. newlines) and backticks so a captured
  # command cannot break the markdown list / code span it is embedded in.
  def clean: gsub("[[:cntrl:]]"; " ") | gsub("`"; " ");
  # Observable outcome from the tool result. The Claude Code Bash tool_response
  # exposes "interrupted" but NOT an exit code, so a plain non-zero exit is not
  # visible to a PostToolUse hook and is deliberately left unmarked rather than
  # guessed from stderr (which is noisy and often non-empty on success). The
  # is_error / error / exit_code checks are forward-compatible with tool types
  # or future versions that do surface an explicit failure. Never false-positive.
  def outcome:
    (.tool_response) as $r
    | if ($r | type) != "object" then ""
      elif ($r.interrupted? // false) == true then " `[interrupted]`"
      elif (($r.is_error? // false) == true)
        or (($r.error? // null) != null)
        or ((($r.exit_code? // $r.code? // $r.returncode? // 0)) != 0)
      then " `[failed]`"
      else "" end;
  (.session_id // "") + "\t" +
  (.tool_name as $t |
    if $t == "Bash" then
      "**bash** " + ((.tool_input.description // "") | clean) + outcome + " - `" +
      (((.tool_input.command // "") | redact | clean) as $c
        | ($c[0:200]) + (if ($c | length) > 200 then "…[truncated]" else "" end)) + "`"
    elif ($t == "Edit" or $t == "Write" or $t == "NotebookEdit") then
      "**" + $t + "** " +
      (((.tool_input.file_path // .tool_input.notebook_path // "?") | ltrimstr($root + "/")) | clean) +
      outcome
    else
      "**" + $t + "**"
    end)
' 2>/dev/null) || exit 0

[ -n "$out" ] || exit 0
sid=${out%%	*}
line=${out#*	}

# Drop records with no usable session id rather than poisoning a shared
# "nosession" bucket that flush never stamps and onboard re-warns about forever.
sid=$(tl_safe_sid "$sid")
[ -n "$sid" ] || exit 0

ts=$(date '+%Y-%m-%d %H:%M:%S')
# Backticks here are literal markdown and %s are printf specifiers; single quotes
# are intentional (no shell expansion wanted).
# shellcheck disable=SC2016
printf -- '- `%s` %s\n' "$ts" "$line" >> "$bufdir/session-$sid.md" 2>/dev/null
exit 0
