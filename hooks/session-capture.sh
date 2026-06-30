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

# Best-effort breadcrumb for the swallowed-failure paths below: capture must
# never block a tool, so every failure here still exits 0, but a write failure
# (full disk, lost permissions) would otherwise drop an action with zero trace.
# onboard surfaces this file's presence so the loss isn't silent forever. Lives
# at the data-dir root, NOT under buffer/: tl_active (checked above) guarantees
# $data exists before this point, but $bufdir may not (mkdir below can fail) —
# if the breadcrumb's own target depended on bufdir, the one failure mode this
# exists to report (bufdir uncreatable) would silently defeat the breadcrumb
# along with it.
_tl_err() {
  printf -- '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$data/.capture-errors" 2>/dev/null
}

mkdir -p "$bufdir" 2>/dev/null || { _tl_err "mkdir failed for buffer dir"; exit 0; }

# Session id is resolved independently of the formatted line below (rather than
# splitting both out of one combined jq call) so it is derived identically to
# how flush/onboard/precompact resolve it — a session_id containing a tab would
# otherwise desync the two derivations and point them at different filenames.
sid=$(printf '%s' "$input" | jq -r '.session_id // ""' 2>/dev/null)
sid=$(tl_safe_sid "$sid")
# Drop records with no usable session id rather than poisoning a shared
# "nosession" bucket that flush never stamps and onboard re-warns about forever.
[ -n "$sid" ] || exit 0

line=$(printf '%s' "$input" | jq -r --arg root "$root" '
  # Mask common secret shapes so raw credentials never sit in the buffer. The
  # buffer is gitignored, but a later handoff distills it into committed logs;
  # this is defense-in-depth, not the only barrier (the skill scrubs too).
  # Best-effort: this is pattern/keyword matching, not entropy analysis, so a
  # bare opaque token with no recognizable shape or keyword will not be caught.
  # Shape-specific patterns run BEFORE the generic keyword=value catch-all below,
  # so e.g. "Authorization:Basic <base64>" is fully consumed by the Basic-auth
  # rule rather than the generic auth keyword rule eating just the Basic token
  # and leaving the base64 payload exposed. The generic keyword group has
  # trailing \w* too (not just leading) so compound names like SECRET_KEY= or
  # API_KEY_VALUE= still match - a keyword immediately followed by more word
  # characters used to fall through unredacted entirely. Its value group stops
  # at @ and / as well as whitespace/quote: the URL-userinfo rule above already
  # bounds and masks a credential inside a URL, and without this the generic
  # rule re-matching token inside e.g. a user-token:***@host/path URL would
  # greedily re-consume everything through the path, deleting rather than
  # masking it.
  def redact:
    gsub("-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----"; "***private-key-redacted***")
    | gsub("-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*"; "***private-key-redacted***")
    | gsub("(?i)bearer\\s+(?<t>[A-Za-z0-9._\\-]+)"; "Bearer ***")
    | gsub("(?<pfx>://[^:@/\\s]+):(?<pw>[^@/\\s]+)@"; "\(.pfx):***@")
    | gsub("ghp_[A-Za-z0-9]{10,}"; "ghp_***")
    | gsub("github_pat_[A-Za-z0-9_]{10,}"; "github_pat_***")
    | gsub("gh[oprsu]_[A-Za-z0-9]{10,}"; "gh_***")
    | gsub("xox[baprs]-[A-Za-z0-9-]{6,}"; "xox-***")
    | gsub("sk-[A-Za-z0-9]{10,}"; "sk-***")
    | gsub("AKIA[0-9A-Z]{12,}"; "AKIA***")
    | gsub("AIza[0-9A-Za-z_\\-]{35}"; "AIza***")
    | gsub("(?i)\\bbasic\\s+[A-Za-z0-9+/=]{8,}"; "Basic ***")
    | gsub("(?i)(?<k>\\w*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|credential|auth(?:orization)?|client[_-]?id)\\w*)(?<s>\\s*[:=]\\s*|\\s+)(?<v>\"?[^\\s\"@/]+)"; "\(.k)\(.s)***");
  # Neutralize control chars (incl. newlines) and backticks so a captured
  # command cannot break the markdown list / code span it is embedded in. The
  # control-char half mirrors the shared `tl_clean_ctrl` shell helper in
  # _lib.sh (used by session-flush.sh / session-precompact.sh for their
  # reason/trigger fields) but stays inline here: this runs inside a jq
  # pipeline applied per-field alongside redaction and backtick-stripping in
  # one pass, so factoring it out would mean an extra subprocess per field.
  def clean: gsub("[[:cntrl:]]"; " ") | gsub("`"; " ");
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
          or ((($r.exit_code? // $r.code? // $r.returncode? // 0)) != 0))
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
    else
      "**" + $t + "**"
    end)
' 2>/dev/null) || { _tl_err "jq filter failed"; exit 0; }

[ -n "$line" ] || exit 0

ts=$(date '+%Y-%m-%d %H:%M:%S')
# Backticks here are literal markdown and %s are printf specifiers; single quotes
# are intentional (no shell expansion wanted).
# shellcheck disable=SC2016
printf -- '- `%s` %s\n' "$ts" "$line" >> "$bufdir/session-$sid.md" 2>/dev/null || _tl_err "write failed for session-$sid"
exit 0
