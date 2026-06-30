#!/bin/sh
# throughline — shared helpers for hook scripts.
#
# Resolves the data directory where session state lives. Precedence:
#   1. $THROUGHLINE_DATA_DIR (absolute, or relative to the project root)
#   2. .claude/throughline/   (default — universal Claude Code workspace dir)
#
# Set THROUGHLINE_DATA_DIR=.agent/handoff in your environment to unify with a
# portable .agent/ handoff convention used by other harnesses.

tl_root() {
  printf '%s' "${CLAUDE_PROJECT_DIR:-$PWD}"
}

# POSIX sh has no `local`; helpers prefix their temporaries with `_tl_` so they do
# not clobber a same-named variable in the sourcing hook.
tl_data_dir() {
  _tl_root=$(tl_root)
  if [ -n "$THROUGHLINE_DATA_DIR" ]; then
    case "$THROUGHLINE_DATA_DIR" in
      /*) printf '%s' "$THROUGHLINE_DATA_DIR" ;;
      *)  printf '%s/%s' "$_tl_root" "$THROUGHLINE_DATA_DIR" ;;
    esac
  else
    printf '%s/.claude/throughline' "$_tl_root"
  fi
}

# True when this project should be tracked: the data dir already exists, or a
# HANDOFF.md is present in it. Keeps throughline silent in unrelated repos until
# the user opts a project in by running the handoff once.
tl_active() {
  _tl_d=$(tl_data_dir)
  [ -d "$_tl_d" ] || [ -f "$_tl_d/HANDOFF.md" ]
}

# jq is a hard dependency for capture (it parses the hook payload). When it is
# missing, capture cannot record anything; the onboard hook surfaces a visible
# warning so the failure is never silent.
tl_have_jq() {
  command -v jq >/dev/null 2>&1
}

# Sanitize a session id for safe use as a filename: keep only [A-Za-z0-9._-],
# collapsing everything else to '_'. Rejects empty / '.' / '..' by printing
# nothing (callers treat empty output as "no usable id"). Prevents slashes in a
# session_id from creating stray subdirectories or escaping the buffer dir.
# Known tradeoff: this collapse is lossy, so two different ids that disagree
# only in disallowed characters (e.g. "abc/def" vs "abc:def") sanitize to the
# same filename. Currently unreachable: Claude Code session_ids are UUIDs,
# which already consist entirely of allowed characters and pass through
# unchanged. Revisit if session_ids ever stop being UUID-shaped.
tl_safe_sid() {
  _tl_s=$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')
  case "$_tl_s" in ''|.|..) printf '' ;; *) printf '%s' "$_tl_s" ;; esac
}

# Resolve and sanitize the session_id from a hook's raw JSON stdin payload in
# one step. Shared by session-capture.sh, session-flush.sh, and
# session-precompact.sh, which all key their buffer filename off this exact
# derivation - letting it drift between them once already desynced filenames
# for a session_id containing a tab (capture used to extract it differently
# than the other three). Prints "" if jq is unavailable or session_id is
# absent/unsafe; safe to call even where the caller has not separately
# checked tl_have_jq.
tl_resolve_sid() {
  tl_have_jq || { printf ''; return; }
  _tl_raw=$(printf '%s' "$1" | jq -r '.session_id // ""' 2>/dev/null)
  tl_safe_sid "$_tl_raw"
}

# Replace control characters (including newlines) with a space. Shared by
# session-flush.sh and session-precompact.sh so their reason/trigger fields
# can't break the `<!-- ... -->` marker they're embedded in. (capture.sh's `clean`
# def duplicates this rule rather than calling it: capture applies control-char
# AND backtick stripping together, per-field, inside one jq pipeline that also
# does redaction — pulling just the control-char half out to a separate shell
# call there would mean an extra process per field for no real safety gain.)
tl_clean_ctrl() {
  printf '%s' "$1" | tr '[:cntrl:]' ' '
}
