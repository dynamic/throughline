#!/bin/sh
# SKILL.md lint (issue #195). The skills are agent instructions, so no test exercises
# their behaviour; this checks what can be checked mechanically:
#   - frontmatter opens and closes with `---`, `name:` equals the directory name, and
#     `description:` is present and at most 300 characters (pickers truncate past that);
#   - each SKILL.md stays within its byte budget below - a ratchet: lower a budget when
#     a skill is slimmed, never raise one to make a check pass without a reason;
#   - every repo path a skill names (`hooks/...`, `docs/...`, `scripts/...`,
#     `tests/...`, `skills/...` with a file extension) exists.
#
# Usage: sh tests/skill-lint.sh [ROOT]   (ROOT defaults to the repo this file is in)
# Prints one line per problem to stderr and exits 1 if there is any.
set -u

ROOT=${1:-$(cd "$(dirname "$0")/.." && pwd)}
fail=0
bad() { echo "skill-lint: $*" >&2; fail=1; }

# Byte budgets, starting at each skill's size when this check landed (rounded up).
budget() {
  case "$1" in
    consolidate-memory) echo 29500 ;;
    handoff) echo 21200 ;;       # +200 for the per-harness memory routing pointers (#194)
    consolidate) echo 12150 ;;   # +150, same reason
    onboard) echo 3000 ;;
    *) echo 12000 ;;
  esac
}

found=0
for f in "$ROOT"/skills/*/SKILL.md; do
  [ -f "$f" ] || continue
  found=1
  dir=$(basename "$(dirname "$f")")
  # .gitattributes keeps SKILL.md LF, but a contributor's checkout may not honour it;
  # parse a CR-stripped copy so a CRLF file is judged on its content.
  text=$(tr -d '\r' < "$f")

  [ "$(printf '%s\n' "$text" | sed -n 1p)" = "---" ] || bad "$dir: SKILL.md does not open with a --- frontmatter line"
  # Frontmatter is the block between the first two --- lines; it must close.
  fm=$(printf '%s\n' "$text" | awk 'NR == 1 && $0 == "---" { inside = 1; next } inside && $0 == "---" { closed = 1; exit } inside { print } END { if (!closed) print "TL_UNCLOSED" }')
  case "$fm" in *TL_UNCLOSED*) bad "$dir: frontmatter never closes"; continue ;; esac
  [ -n "$fm" ] || { bad "$dir: frontmatter is empty"; continue; }

  name=$(printf '%s\n' "$fm" | sed -n 's/^name:[[:space:]]*//p' | head -n 1)
  [ "$name" = "$dir" ] || bad "$dir: frontmatter name is '$name', expected '$dir'"

  desc=$(printf '%s\n' "$fm" | sed -n 's/^description:[[:space:]]*//p' | head -n 1)
  if [ -z "$desc" ]; then
    bad "$dir: frontmatter has no description"
  elif case "$desc" in '>'|'|'|'>-'|'|-'|'>+'|'|+') true ;; *) false ;; esac; then
    # A block-scalar description continues on later lines, which this line-based
    # check cannot measure; require the single-line form every skill uses.
    bad "$dir: description is a multi-line YAML block; use a single line"
  else
    dlen=$(printf '%s' "$desc" | wc -m | tr -d ' ')
    [ "$dlen" -le 300 ] || bad "$dir: description is $dlen characters, over 300"
  fi

  size=$(wc -c < "$f" | tr -d ' ')
  max=$(budget "$dir")
  [ "$size" -le "$max" ] || bad "$dir: SKILL.md is $size bytes, over its $max budget"

  # Repo paths with a file extension; directories and globs are prose, not checked.
  refs=$(grep -oE '(hooks|docs|scripts|tests|skills)/[A-Za-z0-9_./-]+\.(sh|md|py|ts|json|yaml)' "$f" | sort -u)
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    [ -e "$ROOT/$p" ] || bad "$dir: references $p, which does not exist"
  done <<EOF_REFS
$refs
EOF_REFS
done

[ "$found" -eq 1 ] || bad "no skills/*/SKILL.md found under $ROOT"
exit "$fail"
