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
# Bare call, not $(tl_data_root): caches into $_tl_data_root in THIS shell (not
# a discarded subshell), so the tl_data_dir() and tl_active()/tl_data_exists()
# calls below - each still individually subshelled or not - inherit the
# already-resolved value instead of re-running the git-worktree resolution
# from scratch. See tl_resolve_data_root()'s comment in _lib.sh.
tl_resolve_data_root
droot="$_tl_data_root"
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
    echo "⚠️ throughline could not create its data directory (\`${data#"$droot"/}\`) - check permissions/disk space on the project root. Capture will not run until this is resolved."
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

# Make worktree-sharing (issue #31) non-silent: when this session is a linked
# worktree and its data anchored to the main tree instead, say so plainly
# rather than leaving it to be inferred from where HANDOFF.md happens to live.
#
# $droot is canonicalized (see _tl_compute_data_root in _lib.sh); $root is
# deliberately NOT (tl_root()'s own doc comment - it anchors file-path
# relativization elsewhere in this script and must match tool input paths
# exactly). Comparing them directly is therefore a symlink false-positive
# waiting to happen: on any project whose raw path passes through a symlink
# (macOS's /tmp -> /private/tmp being the everyday case), $root and $droot
# differ even for the literal main working tree, wrongly claiming sharing on
# every single session there. Canonicalize $root ONLY for this comparison -
# not the variable itself - so the "is this actually a different location"
# check compares like with like without disturbing $root's other uses below
# (issue #42 investigation; the CI-only worktree-fixture bug it was filed
# for was unrelated to this and is fixed separately in tests/run.sh).
if [ "$droot" != "$(_tl_canonicalize_path "$root")" ]; then
  echo "🔗 throughline data is shared with the main working tree at \`$droot\` (this is a linked worktree)."
  echo
fi

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
  echo "⚠️ $errn capture failure(s) recorded in \`${data#"$droot"/}/.capture-errors\` - some actions may be missing from the buffer. Check disk space / permissions on \`${data#"$droot"/}/\`, then clear the file once resolved."
  echo
fi

if [ -f "$hf" ]; then
  echo "Durable handoff exists at \`${hf#"$droot"/}\` - read it before starting."
  grep -m1 -i "last updated" "$hf" 2>/dev/null
else
  echo "No HANDOFF.md yet for this project. One will be written at the next handoff."
fi

# Stale-handoff detection (issue #66): HANDOFF.md's own "Last Updated" date
# compared against the latest commit on this branch. A handoff-file design
# has one built-in blind spot: the file only reflects what was written, so
# it can look current - still present, still readable - while work has
# quietly moved past it. This project's own handoff went 5+ weeks stale this
# way before anyone noticed (nested-workspace gap: a parent-directory
# session's work on this repo never reached this repo's own HANDOFF.md).
# Live commit history is the one signal available here to catch that
# silently, so use it - skipped on `compact` (same reasoning as the
# gitignore nudge above: informational, not worth repeating mid-session) and
# whenever either date is unavailable or unparseable, in which case this
# says nothing rather than guessing.
TL_STALE_HANDOFF_DAYS=14
if [ "$src" != "compact" ] && [ "$in_worktree" = "1" ] && [ -f "$hf" ]; then
  hf_date=$(grep -m1 -i "last updated" "$hf" 2>/dev/null | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -1)
  commit_date=$(git -C "$root" log -1 --format=%cd --date=short 2>/dev/null)
  if [ -n "$hf_date" ] && [ -n "$commit_date" ]; then
    # Plain-integer civil-calendar day count (Howard Hinnant's days_from_civil),
    # not `date -d`/`date -j`: those flags differ between GNU and BSD date, and
    # this needs to run unmodified on macOS, Linux, and (per issue #67) Windows
    # Git Bash alike. Verified against a same-month gap, a year boundary, and a
    # leap-year February before landing here.
    stale_days=$(awk -v hf="$hf_date" -v co="$commit_date" '
      function days(ds,   y,m,d,era,yoe,doy,doe) {
        y = substr(ds,1,4)+0; m = substr(ds,6,2)+0; d = substr(ds,9,2)+0
        if (m <= 2) y -= 1
        era = int((y >= 0 ? y : y-399) / 400)
        yoe = y - era*400
        doy = int((153*(m + (m>2?-3:9)) + 2)/5) + d - 1
        doe = yoe*365 + int(yoe/4) - int(yoe/100) + doy
        return era*146097 + doe - 719468
      }
      BEGIN { print days(co) - days(hf) }
    ' 2>/dev/null)
    # Strip a leading '-' before the digit-only check so a HANDOFF.md newer
    # than the latest commit (a negative gap - describing in-flight,
    # uncommitted state, which is normal) isn't blanked out as "unparseable"
    # the way genuinely non-numeric awk output would be.
    _tl_check=${stale_days#-}
    case "$_tl_check" in
      ''|*[!0-9]*) stale_days="" ;;
    esac
    if [ -n "$stale_days" ] && [ "$stale_days" -ge "$TL_STALE_HANDOFF_DAYS" ]; then
      echo "⚠️ HANDOFF.md was last updated $hf_date, $stale_days day(s) before the most recent commit ($commit_date) - it may be stale."
    fi
  fi
fi

# Nudge toward gitignoring bufdir/ - the one subdir that must ALWAYS stay
# untracked regardless of policy, since it can hold raw, only best-effort-
# redacted command/path text. Checks bufdir/ specifically rather than $data/
# (the whole data dir) deliberately: an earlier version of this check used
# $data/, reasoning that throughline is local-only by default (see README
# "Local by default") so the whole dir should normally be covered - but
# `git check-ignore -q "$data/"` can return "ignored" (a directory-glob
# pattern like `.claude/throughline/*` matches the bare directory path with
# a trailing slash too) even when a specific file inside it - like the
# buffer - is genuinely untracked and stageable via `git status`. Checking
# the coarser ancestor as a proxy for the leaf resource that actually
# matters is unsound; check-ignore only reliably answers for the exact path
# you care about. bufdir/ is that path: it is the one thing that must never
# be exposed even on a project that has deliberately opted in to tracking
# HANDOFF.md/logs/ (see README "Opting in to tracking" - buffer/ and
# .capture-errors stay ignored even then).
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
# $data lives outside the data root's own git tree (an absolute
# THROUGHLINE_DATA_DIR pointed at a shared, cross-harness location - a
# documented, supported configuration): `git check-ignore` on a path outside
# the repo fails with a fatal error rather than "not ignored", which the
# negated check here would otherwise treat identically to "not gitignored" -
# printing an unsatisfiable warning on every single SessionStart forever,
# since a path outside the repo can never be matched by that repo's
# .gitignore in the way check-ignore verifies. Checked (and check-ignore run)
# against $droot, not $root: in a linked worktree $data lives under the MAIN
# tree (tl_data_root), so that main tree's .gitignore is the one that actually
# governs it - $root's own working directory has no bearing on that lookup.
case "$data" in
  "$droot"/*)
    if [ "$src" != "compact" ] && [ "$in_worktree" = "1" ] \
      && ! git -C "$droot" check-ignore -q "$bufdir/" 2>/dev/null; then
      echo
      echo "⚠️ \`${bufdir#"$droot"/}/\` is not gitignored yet - it can contain raw command/path text (best-effort redacted only) and must stay untracked. throughline is local-only by default - typically the whole data dir should be gitignored (see README \"Local by default\"), not just this subdir."
    fi
    ;;
esac

# Live git state, deliberately placed early (issue #64): it's small and
# tightly bounded (one branch line + `head -20` status lines), unlike the
# post-compaction buffer-tail inline below, whose size depends on how much
# was captured and is the thing most likely to push this block past whatever
# undocumented size limit Claude Code applies to SessionStart output. If
# truncation happens, it should cut into the buffer tail - which already
# carries its own "full history is at <path>" fallback pointer - not into
# this, which has none.
if [ "$in_worktree" = "1" ]; then
  echo
  echo "### Live git state"
  echo '```'
  echo "branch: $(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  git -C "$root" status -s 2>/dev/null | head -20
  echo '```'
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
    echo "⚠️ $ended unconsumed session buffer(s) in \`${bufdir#"$droot"/}/\` from sessions that ended without being distilled into a handoff. Consider running the handoff to fold them in."
  fi
  if [ "$unsure" -ne 0 ]; then
    echo
    echo "ℹ️ $unsure other session buffer(s) in \`${bufdir#"$droot"/}/\` with no end-stamp - could be live in another terminal, or could have exited without a clean shutdown. If none are still running, consider running the handoff."
  fi
fi

# Post-compaction recovery (issue #9): the conversation was just summarized,
# but this session's buffer is intact on disk. Inline its TAIL directly into
# this SessionStart block instead of only pointing at the file - a bare
# pointer costs the model a tool call it may not make, right where
# post-compaction recall is weakest. Bounded to the last N lines, EACH also
# capped at TL_COMPACT_TAIL_LINE_CHARS characters (via the awk pass below) -
# not just line count. A record's Bash `description` and Edit/Write/
# NotebookEdit `file_path` fields are never length-clamped in
# session-capture.sh (only `command` and the other free-text fields are), so
# without this hook's OWN cap an unusually long one of those would still
# inline verbatim; capping here, at the point this block's own bounded-size
# claim is made, holds regardless of what any capture-side branch does or
# later stops doing. The full-file pointer is kept for anything older than
# the tail.
#
# Placed LAST in this script (issue #64), not where it used to sit: a
# realistic worst case (a 30-line, near-max-width tail plus a normal header
# and a handful of untracked files) measured at 11KB, over an undocumented
# ~10,000-character cap a competing plugin claims Claude Code enforces on
# SessionStart output (unverified against Claude Code's own docs, which
# specify no limit at all - but an unbounded worst case is worth budgeting
# against regardless of the exact cutoff). 30/300 shrunk to 20/200 to bring
# the worst case for this block alone down to roughly 4-5KB, and it now
# renders after every other block in this script, all of which are small and
# bounded - so if truncation does happen, it eats into the one block that
# already tells you where to find the rest (`session-$sid.md`), not into
# live git state or the HANDOFF pointer, which have no such fallback.
TL_COMPACT_TAIL_LINES=20
TL_COMPACT_TAIL_LINE_CHARS=200
if [ "$src" = "compact" ] && [ -n "$sid" ] && [ -f "$bufdir/session-$sid.md" ]; then
  buf="$bufdir/session-$sid.md"
  echo
  echo "🧷 Context was just compacted. The last $TL_COMPACT_TAIL_LINES line(s) of this session's action buffer are inlined below to recover what you did before the compaction, without an extra read - the raw actions persist even though the conversation summary dropped detail. Full history (if the session ran longer than this tail) is at \`${bufdir#"$droot"/}/session-$sid.md\`."
  echo '```'
  tail -n "$TL_COMPACT_TAIL_LINES" "$buf" 2>/dev/null | awk -v max="$TL_COMPACT_TAIL_LINE_CHARS" '
    { if (length($0) > max) print substr($0, 1, max) " …[line truncated]"
      else print
    }'
  echo '```'
fi

exit 0
