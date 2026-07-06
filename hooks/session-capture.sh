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

# The redact/clean defs are shared with session-prompt.sh (via
# tl_jq_redact_defs in _lib.sh) so the rule set can't drift between the two
# capture-side hooks; the outcome($t) def and the tool-name dispatch below are
# specific to PostToolUse and stay here.
#
# Session id and the formatted line are produced by ONE jq invocation
# (sid-tab-line), not two: this is the hottest hook in the plugin (fires on
# every matched tool call), and a second full jq process just to re-derive
# .session_id was pure overhead. The trivial `.session_id // ""` expression
# below is byte-identical to tl_resolve_sid's own (_lib.sh) — only that
# expression is re-inlined here; the actual SANITIZER (tl_safe_sid) still runs
# exactly once, in shell, on the extracted id, same as tl_resolve_sid does. That
# distinction matters: the historical desync bug this consolidation must not
# reintroduce came from two DIFFERENT DERIVATION MECHANISMS (shell vs. jq)
# disagreeing on a session id, not from two identical jq expressions — see
# tl_resolve_sid's comment. Cold-path hooks (flush/precompact/onboard, which
# fire once per session/compaction rather than per tool) are unchanged and
# still call tl_resolve_sid directly.
#
# The id is piped through `clean` (control-char + backtick stripping, defined
# in tl_jq_redact_defs) before being joined with the tab delimiter, so a raw
# session_id that happened to contain a literal tab can never be misread as
# the sid/line boundary — tl_safe_sid (run by the shared tl_split_sid_line
# helper below, _lib.sh) maps every disallowed byte (control chars, tab,
# backtick, space, ...) to the same `_` regardless of whether `clean` already
# turned it into a space first, so this is a no-op for any session_id shaped
# like an actual UUID (the only shape Claude Code emits today) and produces
# the identical final sanitized id even in the currently-unreachable case of a
# stranger one. A regression test locks in that capture and flush agree on the
# filename for a tab-containing id.
out=$(printf '%s' "$input" | jq -r --arg root "$root" "$(tl_jq_redact_defs)"'
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
  ((.session_id // "") | clean) as $sid
  | ($sid + "\t" + (.tool_name as $t |
    if $t == "Bash" then
      "**bash** " + ((.tool_input.description // "") | redact | clean) + outcome($t) + " - `" +
      ((.tool_input.command // "") | redact | clean | clamp(200; "…[truncated]")) + "`"
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
      # skimmable trace. Unlike every other branch, $t here is embedded
      # DIRECTLY INSIDE the `**...**` delimiter pair itself (every other
      # branch uses a fixed literal type marker and puts field content only
      # AFTER it), so an asterisk or control char in an unusual tool name
      # would break the markdown bold span and desync the anchored
      # `**[^*]+**` classifier regex used to skip prompt-only buffers in
      # session-onboard.sh, silently miscounting the record as unparseable.
      # `clean` handles control chars and backticks; asterisks are stripped
      # here specifically, not folded into the shared `clean` def which
      # other branches rely on to preserve a literal `*` in content like a
      # glob pattern or command.
      "**" + ($t | clean | gsub("\\*"; "")) + "**" + outcome($t)
    end))
' 2>/dev/null) || { tl_err "jq filter failed"; exit 0; }

# tl_split_sid_line (_lib.sh) does the tab-split + sanitize; shared with
# session-prompt.sh so the two hot-path hooks can't drift on how they derive a
# session id from this identically-shaped jq output — see its comment.
tl_split_sid_line "$out"
sid=$_tl_split_sid
line=$_tl_split_line
# Drop records with no usable session id rather than poisoning a shared
# "nosession" bucket that flush never stamps and onboard re-warns about forever.
# Breadcrumbed like the other silent-loss paths below: currently unreachable
# (Claude Code always supplies a UUID session_id) but if that assumption ever
# breaks, the loss should be visible rather than untraceable.
[ -n "$sid" ] || { tl_err "dropped action: no usable session_id"; exit 0; }

[ -n "$line" ] || exit 0

tl_append_line "$bufdir" "$sid" "$line"
exit 0
