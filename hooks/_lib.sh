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

tl_data_dir() {
  root=$(tl_root)
  if [ -n "$THROUGHLINE_DATA_DIR" ]; then
    case "$THROUGHLINE_DATA_DIR" in
      /*) printf '%s' "$THROUGHLINE_DATA_DIR" ;;
      *)  printf '%s/%s' "$root" "$THROUGHLINE_DATA_DIR" ;;
    esac
  else
    printf '%s/.claude/throughline' "$root"
  fi
}

# True when this project should be tracked: the data dir already exists, or a
# HANDOFF.md is present in it. Keeps throughline silent in unrelated repos until
# the user opts a project in by running the handoff once.
tl_active() {
  d=$(tl_data_dir)
  [ -d "$d" ] || [ -f "$d/HANDOFF.md" ]
}
