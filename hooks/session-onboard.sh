#!/bin/sh
# throughline — SessionStart orientation.
#
# When a project is throughline-active, inject a short context block at session
# start: a pointer to the durable HANDOFF.md plus live git state. This automates
# the cheap half of orientation; it complements Claude Code's native MEMORY.md
# auto-load (global durable facts) with project-level state. Cheap, offline.
#
# An empty SessionStart matcher fires on every source, including `compact`, so
# this also runs right after a context compaction. On that path it points Claude
# back at the on-disk action buffer for the CURRENT session, which survives the
# compaction even though the conversation was summarized. Always exits 0.

DIR=$(unset CDPATH; cd -- "$(dirname -- "$0")" && pwd)
. "${CLAUDE_PLUGIN_ROOT:-$DIR/..}/hooks/_lib.sh" 2>/dev/null || . "$DIR/_lib.sh"

# Machine-wide kill switch: fully silent, even about existing data. The
# per-project .throughlineignore keeps orienting toward existing content;
# the global disable does not - "off" must mean off.
tl_disabled && exit 0

root=$(tl_root)
data=$(tl_data_dir)

# tl_data_exists (not tl_active) gates whether there is anything to report:
# existing state deserves orientation even when .throughlineignore is present
# - the opt-out means "stop adding new content," not "stop telling me what
# already exists" (a mid-life opt-out on an already-tracked project used to
# silence the HANDOFF.md pointer, capture-errors, and unconsumed-buffer
# warnings too, which was never the intent). Only fall through to tl_active
# (which does honor the opt-out, and bootstraps) when there is nothing yet.
if ! tl_data_exists && ! tl_active; then
  # Distinguish a deliberate .throughlineignore opt-out (stay silent, as
  # designed) from a failed auto-activation bootstrap (permissions, disk
  # full) - the latter must not look identical to the former, or the very
  # "no more silent chicken-and-egg trap" this auto-activation exists to fix
  # becomes a new, harder-to-diagnose silent failure of its own.
  if [ "${_tl_active_reason:-}" = "bootstrap-failed" ]; then
    echo "⚠️ throughline could not create its data directory (\`${data#"$root"/}\`) - check permissions/disk space on the project root. Capture will not run until this is resolved."
  fi
  exit 0
fi
hf="$data/HANDOFF.md"
bufdir="$data/buffer"
# Computed once and reused below (the gitignore nudge and the live-git-state
# block both need it) rather than spawning git twice per SessionStart.
if git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  in_worktree=1
else
  in_worktree=0
fi

# Parse the SessionStart payload (best-effort; jq may be absent). `source` is one
# of startup|resume|clear|compact; `session_id` keys this session's buffer.
input=$(cat 2>/dev/null)
src=""
if tl_have_jq; then
  src=$(printf '%s' "$input" | jq -r '.source // ""' 2>/dev/null)
fi
# tl_resolve_sid (also used by capture/flush/precompact) handles the
# missing-jq case itself, returning "".
sid=$(tl_resolve_sid "$input")

# Surface the running plugin version so a stale installed copy is visible at a
# glance (plugins are installed as snapshots; they do not self-update - an old
# cache can silently run without newer redaction/activation fixes). Best-effort:
# jq may be absent or the manifest unreadable, in which case the header stays
# version-less rather than failing.
ver=""
if tl_have_jq; then
  ver=$(jq -r '.version // ""' "${CLAUDE_PLUGIN_ROOT:-$DIR/..}/.claude-plugin/plugin.json" 2>/dev/null)
fi
if [ -n "$ver" ]; then
  echo "## throughline v$ver - project session context"
else
  echo "## throughline - project session context"
fi
echo

# jq is required for action capture. If it is missing, capture silently no-ops,
# so say so loudly here (the one place throughline has a visible voice).
if ! tl_have_jq; then
  echo "⚠️ \`jq\` not found on PATH - throughline action capture is DISABLED this session (nothing will be written to the buffer). Install jq to restore capture."
  echo
fi

# Surface any breadcrumbed capture failures (mkdir/jq/write) from the swallowed
# failure paths in session-capture.sh — that hook must never block a tool, so it
# fails silently except for this trace file. Lives at the data-dir root (not
# under buffer/) so it survives even the failure mode where bufdir itself
# couldn't be created.
if [ -f "$data/.capture-errors" ]; then
  errn=$(grep -c '.' "$data/.capture-errors" 2>/dev/null | tr -d ' ')
  echo "⚠️ $errn capture failure(s) recorded in \`${data#"$root"/}/.capture-errors\` - some actions may be missing from the buffer. Check disk space / permissions on \`${data#"$root"/}/\`, then clear the file once resolved."
  echo
fi

if [ -f "$hf" ]; then
  echo "Durable handoff exists at \`${hf#"$root"/}\` - read it before starting."
  grep -m1 -i "last updated" "$hf" 2>/dev/null
else
  echo "No HANDOFF.md yet for this project. One will be written at the next handoff."
fi

# Nudge toward gitignoring the buffer before anything gets committed.
# Deliberately NOT gated on "no HANDOFF.md yet": that used to be its only
# guard, which meant the nudge permanently stopped firing the moment the
# first handoff ran, even if the buffer was still never actually gitignored.
# Auto-activation means this can now be the very first thing to happen in a
# project, with no manual opt-in step that would have naturally prompted the
# user to set this up first. Skipped on `compact` re-fires so it does not
# repeat within one already-running session as it compacts - it still fires
# on every new session start until the buffer is actually covered. Uses git's
# own ignore resolution (a trailing slash lets it match a directory pattern
# even before the buffer dir itself exists) rather than a hand-rolled pattern
# match, so this only fires when it is actually needed. Skipped entirely when
# $data lives outside the project's own git tree (an absolute
# THROUGHLINE_DATA_DIR pointed at a shared, cross-harness location - a
# documented, supported configuration): `git check-ignore` on a path outside
# the repo fails with a fatal error rather than "not ignored", which the
# negated check here would otherwise treat identically to "not gitignored" -
# printing an unsatisfiable warning on every single SessionStart forever,
# since a path outside the repo can never be matched by that repo's
# .gitignore in the way check-ignore verifies.
case "$data" in
  "$root"/*)
    if [ "$src" != "compact" ] && [ "$in_worktree" = "1" ] \
      && ! git -C "$root" check-ignore -q "$bufdir/" 2>/dev/null; then
      echo
      echo "⚠️ \`${bufdir#"$root"/}/\` is not gitignored yet - it can contain raw command/path text (best-effort redacted only). Add it to \`.gitignore\` before committing."
    fi
    ;;
esac

# Post-compaction recovery: the conversation was just summarized, but this
# session's buffer is intact on disk. Point Claude at it explicitly.
if [ "$src" = "compact" ] && [ -n "$sid" ] && [ -f "$bufdir/session-$sid.md" ]; then
  echo
  echo "🧷 Context was just compacted. This session's action buffer survived at \`${bufdir#"$root"/}/session-$sid.md\` - read it to recover what you did before the compaction. The raw actions persist even though the conversation summary dropped detail."
fi

# Surface unconsumed buffers from OTHER sessions. Exclude the current session's
# own live buffer so a mid-session compaction is never mislabeled as "a prior
# session." Among the rest: a buffer carrying the session-ended stamp (written
# by session-flush.sh on SessionEnd) is a confirmed-ended session that was never
# distilled — report those plainly. A buffer with NO stamp could be the same
# (the process was killed and SessionEnd never fired), but it could just as
# easily be a session still running live in another terminal, so it gets hedged
# wording instead of being asserted as "ended" when that isn't actually known.
if [ -d "$bufdir" ]; then
  ended=0
  unsure=0
  for f in "$bufdir"/session-*.md; do
    [ -f "$f" ] || continue
    [ -n "$sid" ] && [ "$f" = "$bufdir/session-$sid.md" ] && continue
    # Skip prompt-only buffers. A UserPromptSubmit line is recorded for every
    # session (session-prompt.sh fires before any tool), so a session that
    # captured intent but no ACTION - a question answered from context, or
    # Read/Glob-only work, neither of which is a captured tool - leaves a buffer
    # containing only `**prompt**` lines. There is nothing to distill there, so
    # counting it would nag the user to hand off sessions that did no real work,
    # eroding the signal of the warning below. A buffer counts only if it holds
    # at least one capture line that is not a prompt line.
    #
    # The type marker always immediately follows the timestamp backtick + space
    # (every record is `- \`<ts>\` **TYPE** ...`), so the check is anchored
    # there rather than searching for the substring "**prompt**" anywhere in
    # the line - a plain substring search false-matches an action line whose
    # OWN captured content happens to mention "**prompt**" (a grep for that
    # literal pattern, a bash command referencing it, and so on — routine in
    # this very repo), which would silently misclassify a genuinely unconsumed
    # session as prompt-only and drop it from the warning entirely.
    #
    # Counted explicitly (total vs. prompt-marked) rather than via a
    # grep-into-grep pipe: the pipe form's "found nothing" and "found nothing
    # because there's nothing to find" are indistinguishable, so a buffer with
    # ZERO conforming record lines (a truncated/corrupted buffer, or a capture
    # hook's jq failing on every call) silently fell through the SAME `||
    # continue` as a genuine prompt-only buffer - even though pre-existing
    # behavior always counted any existing, end-stamped buffer regardless of
    # its body. Skip ONLY when there is at least one recognized line AND every
    # one of them is a prompt line; zero recognized lines falls through to be
    # counted, matching that prior fail-safe behavior instead of silently
    # dropping a real ended session.
    # An unreadable/unparseable file (permissions, I/O error) makes awk print
    # nothing at all rather than "0 0 0", so all three counts default to 0 here
    # - otherwise the comparisons below get an empty operand and this hook's
    # "always silent on error" contract breaks (every other error path here is
    # 2>/dev/null'd; an unguarded integer test on an empty string is the one
    # way that contract leaks a diagnostic to stderr instead of failing quiet).
    # An empty $_tl_counts also leaves is_ended at its default 0 ("not ended"),
    # which falls through to the unsure branch below - the same fail-safe
    # behavior the prior three-grep version had on an unreadable file.
    #
    # Single awk pass replaces three separate grep forks/reads over the same
    # file (issue #16) - total, prompt-only, and session-ended were each their
    # own full read of $f; awk computes all three in one pass.
    # shellcheck disable=SC2016
    _tl_counts=$(awk '
      /^- `[^`]*` \*\*[^*]+\*\*/ { total++ }
      /^- `[^`]*` \*\*prompt\*\*/ { promptonly++ }
      /^<!-- session-ended/ { is_ended=1 }
      END { printf "%d %d %d", total+0, promptonly+0, is_ended+0 }
    ' "$f" 2>/dev/null)
    # Word splitting here is deliberate: $_tl_counts is awk's own
    # space-separated "%d %d %d" output (or empty on read failure), never
    # arbitrary content, so there is nothing to glob or mis-split.
    # shellcheck disable=SC2086
    set -- $_tl_counts
    total=${1:-0}; promptonly=${2:-0}; is_ended=${3:-0}
    [ "$total" -gt 0 ] && [ "$total" -eq "$promptonly" ] && continue
    if [ "$is_ended" -eq 1 ]; then
      ended=$((ended + 1))
    else
      unsure=$((unsure + 1))
    fi
  done
  if [ "$ended" -ne 0 ]; then
    echo
    echo "⚠️ $ended unconsumed session buffer(s) in \`${bufdir#"$root"/}/\` from sessions that ended without being distilled into a handoff. Consider running the handoff to fold them in."
  fi
  if [ "$unsure" -ne 0 ]; then
    echo
    echo "ℹ️ $unsure other session buffer(s) in \`${bufdir#"$root"/}/\` with no end-stamp - could be live in another terminal, or could have exited without a clean shutdown. If none are still running, consider running the handoff."
  fi
fi

if [ "$in_worktree" = "1" ]; then
  echo
  echo "### Live git state"
  echo '```'
  echo "branch: $(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  git -C "$root" status -s 2>/dev/null | head -20
  echo '```'
fi
exit 0
