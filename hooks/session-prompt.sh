#!/bin/sh
# throughline — UserPromptSubmit capture.
#
# Appends a redacted, truncated record of each user prompt to the per-session
# buffer. The rest of the buffer records what happened (tool calls); this
# records why — the user's intent, which otherwise lives only in the
# compactable, mortal conversation and is exactly what a context compaction
# destroys. Mechanical and cheap — no model call. Always exits 0; never blocks
# the prompt (a UserPromptSubmit hook that exits non-zero would abort it).
#
# Shares the redaction/cleaning pipeline with session-capture.sh via
# tl_jq_redact_defs, so a prompt containing a pasted credential is masked by
# the same rules that mask a captured command.

DIR=$(unset CDPATH; cd -- "$(dirname -- "$0")" && pwd)
. "${CLAUDE_PLUGIN_ROOT:-$DIR/..}/hooks/_lib.sh" 2>/dev/null || . "$DIR/_lib.sh"

tl_active || exit 0
tl_have_jq || exit 0   # capture needs jq; onboard surfaces the missing-jq warning visibly

input=$(cat)
data=$(tl_data_dir)
bufdir="$data/buffer"

# Failure paths breadcrumb via the shared tl_err (_lib.sh); see its comment for
# why the breadcrumb lives at the data-dir root, not under buffer/.
mkdir -p "$bufdir" 2>/dev/null || { tl_err "mkdir failed for buffer dir"; exit 0; }

# Same shared session-id derivation as capture/flush/precompact so the prompt
# line lands on the same buffer file as the actions it precedes.
sid=$(tl_resolve_sid "$input")
[ -n "$sid" ] || { tl_err "dropped prompt: no usable session_id"; exit 0; }

# Build the prompt line. Three deliberate choices, all different from the
# command capture path:
#   1. redact_prompt, NOT redact: prompts are prose, and the command-tuned
#      generic/word rules corrupt ordinary English (see _lib.sh).
#   2. Clamp the RAW text to a generous bound (2000) BEFORE redacting: a
#      UserPromptSubmit hook runs synchronously ahead of prompt processing, so
#      running ~15 gsub passes over a multi-MB paste would add real latency.
#      The bound still fully covers the 200-char window we store, so no secret
#      inside that window slips past redaction. The final clamp(200) is what
#      actually lands in the buffer; its ellipsis reflects the real length.
#   3. Concatenated with the shared defs into one jq program (single invocation).
line=$(printf '%s' "$input" | jq -r "$(tl_jq_redact_defs)"'
  ((.prompt // "") | clamp(2000; "") | redact_prompt | clean) as $p
  | if ($p | gsub("^\\s+|\\s+$"; "")) == "" then ""
    else "**prompt** " + ($p | clamp(200; "…[truncated]"))
    end
' 2>/dev/null) || { tl_err "jq filter failed"; exit 0; }

# Empty / whitespace-only prompts produce no line.
[ -n "$line" ] || exit 0

tl_append_line "$bufdir" "$sid" "$line"
exit 0
