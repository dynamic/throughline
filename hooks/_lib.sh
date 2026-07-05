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

# Machine-wide kill switch: THROUGHLINE_DISABLE set to anything but "0" turns
# every hook into a no-op, everywhere, regardless of per-project state or
# .throughlineignore. This is the "off on this whole machine" knob the
# per-project marker file can't provide (auto-activation would otherwise
# require dropping .throughlineignore into every project). Checked by all four
# hooks directly (not only via tl_active): a kill switch that still printed
# orientation or stamped buffers would not read as "off."
tl_disabled() {
  [ -n "${THROUGHLINE_DISABLE:-}" ] && [ "$THROUGHLINE_DISABLE" != "0" ]
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

# True when a data dir already exists for this project, or a HANDOFF.md is
# present in it - independent of .throughlineignore. Kept separate from
# tl_active (which also decides whether to bootstrap and honors the opt-out)
# because two different needs already required a query without the mutation:
# session-flush.sh/session-precompact.sh need to finalize bookkeeping for a
# buffer that already exists regardless of a mid-session opt-out, and
# session-onboard.sh needs to keep orienting toward EXISTING content (a
# HANDOFF.md pointer, unconsumed buffers) even when .throughlineignore is
# present - the opt-out means "stop adding new content," not "stop telling me
# what already exists." A prior version bundled both into tl_active alone,
# which forced those callers to re-derive this check inline with a comment
# explaining why they could not just call tl_active - a future caller reaching
# for tl_active by name (it reads as a plain predicate) could easily miss the
# bootstrap side effect and reintroduce that exact bug.
tl_data_exists() {
  _tl_d=$(tl_data_dir)
  [ -d "$_tl_d" ] || [ -f "$_tl_d/HANDOFF.md" ]
}

# Activation decision for this project, in strict precedence:
#   0. THROUGHLINE_DISABLE (tl_disabled) -> OFF machine-wide, unconditionally.
#   1. .throughlineignore at the project root -> OFF for NEW tracking
#      unconditionally (existing data, per tl_data_exists, is unaffected).
#   2. data dir already exists, or a HANDOFF.md is present -> already active.
#   3. otherwise auto-activate: bootstrap the data dir. Every project touched by
#      Claude Code with throughline installed activates on the first hook fire.
# Returns non-zero (stay silent) if the opt-out marker is present, or if the
# bootstrap mkdir fails - so any hook that proceeds past this call is guaranteed
# a data dir on disk (session-capture.sh's breadcrumb path depends on that).
#
# Also sets $_tl_active_reason to "disabled", "ignored", or "bootstrap-failed" on the
# non-zero paths (unset/stale on the zero path - callers that care check it
# immediately after calling tl_active, before any other _tl_-prefixed call
# might overwrite it). A failed bootstrap must never look identical to a
# deliberate opt-out: onboard is the one hook with a visible voice and uses
# this to warn when auto-activation itself failed (permissions, disk full),
# so that failure doesn't silently masquerade as "user opted out."
tl_active() {
  unset _tl_active_reason
  if tl_disabled; then
    _tl_active_reason="disabled"
    return 1
  fi
  if [ -f "$(tl_root)/.throughlineignore" ]; then
    _tl_active_reason="ignored"
    return 1
  fi
  tl_data_exists && return 0
  _tl_d=$(tl_data_dir)
  if mkdir -p "$_tl_d" 2>/dev/null; then
    return 0
  fi
  _tl_active_reason="bootstrap-failed"
  return 1
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
