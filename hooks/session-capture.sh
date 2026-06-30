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
# splitting both out of one combined jq call), via the shared tl_resolve_sid
# (also used by flush/precompact) so it is derived identically everywhere a
# buffer filename is keyed off it.
sid=$(tl_resolve_sid "$input")
# Drop records with no usable session id rather than poisoning a shared
# "nosession" bucket that flush never stamps and onboard re-warns about forever.
# Breadcrumbed like the other silent-loss paths below: currently unreachable
# (Claude Code always supplies a UUID session_id) but if that assumption ever
# breaks, the loss should be visible rather than untraceable.
[ -n "$sid" ] || { _tl_err "dropped action: no usable session_id"; exit 0; }

line=$(printf '%s' "$input" | jq -r --arg root "$root" '
  # Mask common secret shapes so raw credentials never sit in the buffer. The
  # buffer is gitignored, but a later handoff distills it into committed logs;
  # this is defense-in-depth, not the only barrier (the skill scrubs too).
  # Best-effort: this is pattern/keyword matching, not entropy analysis, so a
  # bare opaque token with no recognizable shape or keyword will not be caught.
  # Known gap, not fixable here without a high false-positive cost: a
  # credential attached to a bare single-letter CLI flag with no keyword at all
  # (mysql -p<password>, curl -u user:pass) has no keyword for this rule to
  # anchor on, and flags like -u/-p are too overloaded across tools (docker run
  # -u uid:gid, ssh -p <port>) to redact generically. The handoff skill re-scan
  # is the second barrier for exactly this shape.
  #
  # Internal sentinel for one specific hand-off: the URL-userinfo rule below is
  # the only shape rule whose replacement abuts a non-whitespace character (the
  # @ that starts the host). Every other shape rule replacement is naturally
  # whitespace-bounded, so the generic catch-all further down can never run
  # past it by accident. The userinfo rule alone needs to mark its output as
  # "already redacted" so the generic value-capture stops there instead
  # of continuing past the @ into the host/path - this used to be inferred from
  # boundary characters (first @, then briefly /) instead of stated directly,
  # and each version of that inference either deleted real trailing context or
  # under-redacted a genuine secret that happened to contain the same boundary
  # character. The sentinel removes the inference: the generic rule recognizes
  # it explicitly, and the final gsub converts it (and any sentinel a URL with
  # no nearby keyword never reached the generic rule to convert) to the
  # user-facing *** mark.
  def M: "TLREDACTSENTINEL";
  # Shape-specific patterns run BEFORE the generic keyword=value catch-all below,
  # so e.g. "Authorization:Basic <base64>" is fully consumed by the Basic-auth
  # rule rather than the generic auth keyword rule eating just the Basic token
  # and leaving the base64 payload exposed. Same reasoning for the dedicated
  # Token rule just below (DRF/GitLab-style "Authorization: Token <value>"
  # headers): without it, the generic rule treats the scheme word "Token"
  # itself as the value to mask and leaves the real key in plaintext right
  # after it. The generic keyword group has trailing \w* too (not just
  # leading) so compound names like SECRET_KEY= or API_KEY_VALUE= still match
  # - a keyword immediately followed by more word characters used to fall
  # through unredacted entirely. Its separator group also accepts a copula
  # (is/was/are) in addition to :/=/bare-whitespace, so natural-language
  # phrasing like "password is X" masks X rather than the word "is". Its value
  # group has no @ or / exclusion at all - it matches the sentinel above when
  # present, else the fully unbounded run up to whitespace/quote - so a genuine
  # secret containing either character (an AWS key with /, a password with @)
  # is always fully masked.
  def redact:
    gsub("-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----"; "***private-key-redacted***")
    | gsub("-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*"; "***private-key-redacted***")
    | gsub("(?i)bearer\\s+(?<t>[A-Za-z0-9._\\-]+)"; "Bearer ***")
    | gsub("(?i)\\btoken\\s+(?<t>[A-Za-z0-9._\\-]+)"; "Token ***")
    | gsub("(?<pfx>://[^:@/\\s]+):(?<pw>[^@/\\s]+)@"; "\(.pfx):\(M)@")
    | gsub("ghp_[A-Za-z0-9]{10,}"; "ghp_***")
    | gsub("github_pat_[A-Za-z0-9_]{10,}"; "github_pat_***")
    | gsub("gh[oprsu]_[A-Za-z0-9]{10,}"; "gh_***")
    | gsub("xox[baprs]-[A-Za-z0-9-]{6,}"; "xox-***")
    | gsub("sk-[A-Za-z0-9_-]{10,}"; "sk-***")
    | gsub("AKIA[0-9A-Z]{12,}"; "AKIA***")
    | gsub("AIza[0-9A-Za-z_\\-]{35}"; "AIza***")
    | gsub("(?i)\\bbasic\\s+[A-Za-z0-9+/=]{8,}"; "Basic ***")
    | gsub("(?i)(?<k>\\w*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|credential|auth(?:orization)?|client[_-]?id)\\w*)(?<s>\\s*[:=]\\s*|\\s+(?:is|was|are)\\s+|\\s+)(?<v>\"?(?:\(M)|[^\\s\"]+))"; "\(.k)\(.s)***")
    | gsub("\(M)"; "***");
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
