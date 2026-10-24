#!/bin/sh
# Manifest validity, version agreement across every harness manifest, and the
# CHANGELOG top heading. CI (.github/workflows/ci.yml) and local-ci
# (.local-ci.json) both call this script, so the two cannot drift.
# Run from anywhere: sh scripts/check-manifests.sh [root]   (exit 0 = clean).
# [root] defaults to the checkout holding this script; tests/run.sh passes a
# fixture copy to prove the check fails on drift.
set -u

ROOT=${1:-$(unset CDPATH; cd -- "$(dirname -- "$0")/.." && pwd)}
cd "$ROOT" || exit 1

command -v jq >/dev/null 2>&1 || { echo "check-manifests: jq is required" >&2; exit 1; }

fail=0
bad() { echo "check-manifests: $1" >&2; fail=1; }

# 1. Each manifest parses and carries the fields its harness reads.
jq -e '.hooks | keys' hooks/hooks.json >/dev/null 2>&1 || bad "hooks/hooks.json: missing .hooks"
jq -e '.name and .version' .claude-plugin/plugin.json >/dev/null 2>&1 || bad ".claude-plugin/plugin.json: missing .name or .version"
jq -e '.plugins' .claude-plugin/marketplace.json >/dev/null 2>&1 || bad ".claude-plugin/marketplace.json: missing .plugins"
jq -e '.name and .version' .codex-plugin/plugin.json >/dev/null 2>&1 || bad ".codex-plugin/plugin.json: missing .name or .version"
jq -e '.plugins' .agents/plugins/marketplace.json >/dev/null 2>&1 || bad ".agents/plugins/marketplace.json: missing .plugins"
jq -e '.name and .version and .omp' package.json >/dev/null 2>&1 || bad "package.json: missing .name, .version or .omp"
grep -q '^version: ' plugin.yaml || bad "plugin.yaml: missing a 'version:' line"

# 2. Every manifest declares the same version.
c=$(jq -r .version .claude-plugin/plugin.json 2>/dev/null)
x=$(jq -r .version .codex-plugin/plugin.json 2>/dev/null)
o=$(jq -r .version .opencode-plugin/package.json 2>/dev/null)
m=$(jq -r .version package.json 2>/dev/null)
h=$(jq -r .version .omp-plugin/package.json 2>/dev/null)
y=$(sed -n 's/^version: //p' plugin.yaml | tr -d '\r')
if [ -z "$c" ] || [ "$c" != "$x" ] || [ "$c" != "$o" ] || [ "$c" != "$m" ] || [ "$c" != "$h" ] || [ "$c" != "$y" ]; then
  bad "version drift: .claude-plugin/plugin.json=$c .codex-plugin/plugin.json=$x .opencode-plugin/package.json=$o package.json=$m .omp-plugin/package.json=$h plugin.yaml=$y"
fi

# 3. CHANGELOG: the first heading is [Unreleased] or the manifest version, and
# the first released heading is the manifest version.
first=$(sed -n 's/^## \[\([^]]*\)\].*/\1/p' CHANGELOG.md | head -n 1)
released=$(sed -n 's/^## \[\([^]]*\)\].*/\1/p' CHANGELOG.md | grep -v '^Unreleased$' | head -n 1)
if [ "$first" != "Unreleased" ] && [ "$first" != "$c" ]; then
  bad "CHANGELOG.md: first heading is [$first], expected [Unreleased] or [$c]"
fi
[ "$released" = "$c" ] || bad "CHANGELOG.md: first released heading is [$released], manifests say $c"

[ "$fail" -eq 0 ] && echo "check-manifests: ok ($c)"
exit "$fail"
