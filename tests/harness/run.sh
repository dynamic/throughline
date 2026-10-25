#!/bin/sh
# Live harness test (issue #196).
#
# Installs throughline into a real harness the way a user would, inside a throwaway
# HOME, runs one scripted headless session in a fixture git repo, and checks what
# landed in the capture buffer. Unlike tests/run.sh this spends model tokens, so it
# runs nightly and on demand (.github/workflows/harness.yml), never per pull request.
#
# Usage:
#   sh tests/harness/run.sh claude     # needs ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
#   sh tests/harness/run.sh opencode   # needs OPENROUTER_API_KEY (or set THROUGHLINE_HARNESS_MODEL)
#
# THROUGHLINE_HARNESS_MODEL overrides the model (default: a cheap one per harness).
# THROUGHLINE_HARNESS_KEEP=1 keeps the temp tree for inspection.
#
# Exit status: 0 when every assertion passes, 1 on any FAIL, 2 on a setup problem
# (missing harness binary or credentials), so a scheduled job can tell "broken" from
# "not configured".
set -u

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HARNESS=${1:-}
PROBE=throughline-probe

case "$HARNESS" in
  claude | opencode) ;;
  *) echo "usage: sh tests/harness/run.sh claude|opencode" >&2; exit 2 ;;
esac

PASSED=0
FAILED=0
ok()   { PASSED=$((PASSED + 1)); printf '  PASS %s\n' "$1"; }
bad()  { FAILED=$((FAILED + 1)); printf '  FAIL %s\n' "$1"; }
skip() { echo "harness[$HARNESS]: $1" >&2; exit 2; }

command -v jq >/dev/null 2>&1 || skip "jq is required"
command -v git >/dev/null 2>&1 || skip "git is required"

REAL_HOME=$HOME
T=$(mktemp -d 2>/dev/null || mktemp -d -t tlharness)
T=$(cd "$T" && pwd -P)
if [ "${THROUGHLINE_HARNESS_KEEP:-}" = "1" ]; then
  echo "harness[$HARNESS]: keeping $T"
else
  trap 'rm -rf "$T"' EXIT INT TERM
fi

# The fixture project: a git repo with one commit, nothing else.
PROJ="$T/proj"
mkdir -p "$PROJ" "$T/home"
( cd "$PROJ" && git init -q && git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init ) \
  || skip "fixture git repo setup failed"

# Everything the harness writes must land under $T. The checkout under test and
# the real HOME's throughline data are compared before and after.
marker="$T/.started"
: > "$marker"
leak_check() {
  leaks=$(find "$ROOT" "$REAL_HOME/.claude/throughline" -newer "$marker" -type f \
      -not -path '*/.git/*' -not -path '*/node_modules/*' \
      -not -path "$ROOT/.opencode-plugin/dist/*" -not -path "$ROOT/.opencode-plugin/hooks/*" \
      2>/dev/null | head -n 5)
  if [ -z "$leaks" ]; then ok "nothing written outside the temp tree"; else bad "wrote outside the temp tree: $leaks"; fi
}

PROMPT="Run this shell command exactly once: echo $PROBE . Then reply with the single word done."
OUT="$T/session.out"

run_claude() {
  command -v claude >/dev/null 2>&1 || skip "claude is not on PATH"
  [ -n "${ANTHROPIC_API_KEY:-}${CLAUDE_CODE_OAUTH_TOKEN:-}" ] \
    || skip "set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN"
  export HOME="$T/home"
  export CLAUDE_CONFIG_DIR="$HOME/.claude"
  # The real install path: this checkout as a marketplace, then plugin install.
  if ! { claude plugin marketplace add "$ROOT" && claude plugin install throughline@throughline; } >"$T/install.log" 2>&1; then
    cat "$T/install.log" >&2
    skip "plugin install failed"
  fi
  ( cd "$PROJ" && claude -p "$PROMPT" \
      --model "${THROUGHLINE_HARNESS_MODEL:-haiku}" \
      --allowedTools Bash \
      --output-format stream-json --verbose ) >"$OUT" 2>&1
  # The SessionStart block reaches the model as hook context: look for it in the
  # streamed output and in the session transcript.
  if grep -q 'project session context' "$OUT" 2>/dev/null \
    || grep -rqs 'project session context' "$CLAUDE_CONFIG_DIR/projects"; then
    ok "SessionStart context was injected"
  else
    bad "SessionStart context was not injected"
  fi
}

run_opencode() {
  command -v opencode >/dev/null 2>&1 || skip "opencode is not on PATH"
  model=${THROUGHLINE_HARNESS_MODEL:-openrouter/~deepseek/deepseek-v4-flash-latest}
  case "$model" in
    openrouter/*) [ -n "${OPENROUTER_API_KEY:-}" ] || skip "set OPENROUTER_API_KEY" ;;
  esac
  ( cd "$ROOT/.opencode-plugin" && npm ci --silent && npm run build --silent ) >"$T/install.log" 2>&1 \
    || { cat "$T/install.log" >&2; skip "plugin build failed"; }
  : > "$marker"   # the build itself writes dist/ and hooks/ in the checkout
  export HOME="$T/home"
  export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share" \
    XDG_CACHE_HOME="$HOME/.cache" XDG_STATE_HOME="$HOME/.local/state"
  mkdir -p "$XDG_CONFIG_HOME/opencode"
  # A local-path plugin entry, as INSTALL.md documents for a checkout. The npm
  # channel is the install-channel smoke test's job (#203).
  jq -n --arg p "$ROOT/.opencode-plugin" '{"$schema": "https://opencode.ai/config.json", plugin: [$p]}' \
    > "$XDG_CONFIG_HOME/opencode/opencode.json"
  ( cd "$PROJ" && opencode run --auto -m "$model" "$PROMPT" ) >"$OUT" 2>&1
  # OpenCode has no visible channel for the injected system block; the version
  # header in the plugin's own log line is not stable either, so this leg checks
  # the buffer only.
}

echo "harness[$HARNESS]: running in $T"
"run_$HARNESS"

buf=$(find "$PROJ/.claude/throughline/buffer" -maxdepth 1 -name 'session-*.md' -type f 2>/dev/null | head -n 1)
if [ -n "$buf" ]; then
  ok "a session buffer was created"
  if grep -q '\*\*prompt\*\*' "$buf"; then ok "the prompt was captured"; else bad "no prompt line"; fi
  if grep -q "\*\*bash\*\*.*$PROBE" "$buf"; then ok "the shell tool call was captured"; else bad "no bash line with $PROBE"; fi
  if grep -q '^<!-- session-ended' "$buf"; then ok "the session was end-stamped"; else bad "no end stamp"; fi
else
  bad "no session buffer in $PROJ/.claude/throughline/buffer/"
  echo "--- session output (tail) ---"
  tail -n 20 "$OUT" 2>/dev/null
fi
leak_check

echo "harness[$HARNESS]: passed $PASSED, failed $FAILED"
[ "$FAILED" -eq 0 ]
