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

tl_active || exit 0

root=$(tl_root)
data=$(tl_data_dir)
hf="$data/HANDOFF.md"
bufdir="$data/buffer"

# Parse the SessionStart payload (best-effort; jq may be absent). `source` is one
# of startup|resume|clear|compact; `session_id` keys this session's buffer.
input=$(cat 2>/dev/null)
src=""
sid=""
if tl_have_jq; then
  src=$(printf '%s' "$input" | jq -r '.source // ""' 2>/dev/null)
  sid=$(printf '%s' "$input" | jq -r '.session_id // ""' 2>/dev/null)
fi
sid=$(tl_safe_sid "$sid")

echo "## throughline - project session context"
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
    if grep -q '^<!-- session-ended' "$f" 2>/dev/null; then
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

if git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo
  echo "### Live git state"
  echo '```'
  echo "branch: $(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  git -C "$root" status -s 2>/dev/null | head -20
  echo '```'
fi
exit 0
