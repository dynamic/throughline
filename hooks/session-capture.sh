#!/bin/sh
# throughline — PostToolUse capture.
#
# Appends a structured one-line record of each captured action (command run,
# file changed, search, fetch, delegated task) to a per-session buffer. This is
# the continuous raw layer that a later handoff distills from. Mechanical and
# cheap — no model call. Always exits 0; never blocks a tool.
#
# Which tools land here is decided by the PostToolUse matcher in hooks.json:
# the mutating tools (Bash/Edit/Write/NotebookEdit) plus the high-signal
# read-side tools (Grep/WebFetch/WebSearch/Task/Agent) and MCP tools
# (mcp__.*, name-only via the fallback branch below). Read and Glob are
# deliberately NOT matched — they are the noisiest tools by far, and a buffer
# that logs every file read stops being skimmable (issue #6).
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

# Failure paths below breadcrumb via the shared tl_err (_lib.sh) — see its
# comment for why the breadcrumb lives at the data-dir root, not under buffer/.

mkdir -p "$bufdir" 2>/dev/null || { tl_err "mkdir failed for buffer dir"; exit 0; }

# Session id is resolved independently of the formatted line below (rather than
# splitting both out of one combined jq call), via the shared tl_resolve_sid
# (also used by flush/precompact) so it is derived identically everywhere a
# buffer filename is keyed off it.
sid=$(tl_resolve_sid "$input")
# Drop records with no usable session id rather than poisoning a shared
# "nosession" bucket that flush never stamps and onboard re-warns about forever.
# Breadcrumbed like the other silent-loss paths below: currently unreachable
# (Claude Code always supplies a UUID session_id) but if that assumption ever
# breaks, the loss should be visible rather than untraceable.
[ -n "$sid" ] || { tl_err "dropped action: no usable session_id"; exit 0; }

# The redact/clean defs are shared with session-prompt.sh (via
# tl_jq_redact_defs in _lib.sh) so the rule set can't drift between the two
# capture-side hooks; the outcome($t) def and the tool-name dispatch below are
# specific to PostToolUse and stay here. Concatenated into one jq program so
# this remains a single jq invocation on the hot path.
line=$(printf '%s' "$input" | jq -r --arg root "$root" "$(tl_jq_redact_defs)"'
  # Observable outcome from the tool result. The Claude Code Bash tool_response
  # exposes "interrupted" but NOT an exit code, so a plain non-zero exit is not
  # visible to a PostToolUse hook and is deliberately left unmarked rather than
  # guessed from stderr (which is noisy and often non-empty on success).
  # is_error / interrupted are checked for every tool type. exit_code / error /
  # code are Bash-specific assumptions, verified only against the real Bash
  # tool_response schema — scoped to $t == "Bash" so an unverified field shape
  # on another tool type cannot false-positive a [failed] on completed work.
  def outcome($t):
    (.tool_response) as $r
    | if ($r | type) != "object" then ""
      elif ($r.interrupted? // false) == true then " `[interrupted]`"
      elif (($r.is_error? // false) == true) then " `[failed]`"
      elif ($t == "Bash") and
        ((($r.error? // "") != "")
          or ((($r.exit_code? // $r.code? // $r.returncode? // 0) | tostring) != "0"))
      then " `[failed]`"
      else "" end;
  (.tool_name as $t |
    if $t == "Bash" then
      "**bash** " + ((.tool_input.description // "") | redact | clean) + outcome($t) + " - `" +
      (((.tool_input.command // "") | redact | clean) as $c
        | ($c[0:200]) + (if ($c | length) > 200 then "…[truncated]" else "" end)) + "`"
    elif ($t == "Edit" or $t == "Write" or $t == "NotebookEdit") then
      "**" + $t + "** " +
      ((.tool_input.file_path // .tool_input.notebook_path // "?") | ltrimstr($root + "/") | redact | clean) +
      outcome($t)
    # High-signal read-side tools (issue #6): one redacted+cleaned argument
    # each, same outcome suffix. Each argument is clamped to a short prefix so
    # a wide-net buffer stays skimmable — grep patterns / URLs / queries can be
    # long, and only the first stretch identifies the action for a later
    # handoff. A subagent Task keeps a longer slice of its description because
    # that IS the delegated intent, the highest-value line in a research
    # session; falls back to the prompt head when no description is supplied.
    elif ($t == "Grep") then
      # A regex pattern, not prose — the command-tuned redact is appropriate.
      "**grep** `" + ((.tool_input.pattern // "") | redact | clean | clamp(120; "…")) + "`" + outcome($t)
    elif ($t == "WebFetch") then
      # A URL, not prose — same reasoning as Grep.
      "**webfetch** " + ((.tool_input.url // "") | redact | clean | clamp(200; "…")) + outcome($t)
    elif ($t == "WebSearch") then
      # A natural-language query — redact_prompt (prose-safe), NOT redact: the
      # command-tuned bare-"token"-word rule mangles a query like "fix token
      # refresh bug" into "fix Token *** bug", the exact corruption class the
      # issue #5 fix (session-prompt.sh) exists to avoid.
      "**websearch** " + ((.tool_input.query // "") | redact_prompt | clean | clamp(200; "…")) + outcome($t)
    elif ($t == "Task" or $t == "Agent") then
      # description // prompt via an empty-aware select: jq // only falls
      # through on null/false, so an empty-STRING description would otherwise
      # suppress the prompt fallback and drop the delegated intent entirely.
      # redact_prompt (prose-safe), NOT redact: the delegated description IS
      # natural language and is the highest-value line in a research session —
      # the same reasoning as WebSearch above.
      "**agent** "
      + ((.tool_input.subagent_type // "") | clean
         | if . == "" then "" else . + ": " end)
      + (((.tool_input.description | select(. != "" and . != null))
          // .tool_input.prompt // "") | redact_prompt | clean | clamp(200; "…"))
      + outcome($t)
    else
      # MCP tools (mcp__server__tool) and any other matched tool: name only.
      # Zero assumptions about the input schema, so no field can leak a secret
      # and no unverified shape can be misread — the tool name alone is the
      # skimmable trace.
      "**" + $t + "**" + outcome($t)
    end)
' 2>/dev/null) || { tl_err "jq filter failed"; exit 0; }

[ -n "$line" ] || exit 0

tl_append_line "$bufdir" "$sid" "$line"
exit 0
