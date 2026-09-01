#!/usr/bin/env bash
#
# Puts the hooks and skills into demo/homelab so the demo project is a real
# install, not a mockup. They live once in the repo; these copies are
# gitignored (see demo/homelab/.gitignore) and rebuilt fresh by this script.

set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
project="$here/homelab"

rm -rf "$project/.claude/hooks" "$project/.claude/skills"
mkdir -p "$project/.claude/hooks" "$project/.claude/skills" "$project/logs"

install -m 755 "$root"/hooks/*.sh "$project/.claude/hooks/"
for skill in onboard handoff consolidate consolidate-memory; do
  mkdir -p "$project/.claude/skills/$skill"
  cp -R "$root/skills/$skill/." "$project/.claude/skills/$skill/"
done

cat <<'EOF'
demo/homelab is ready. Open a session scoped to just this project:

  cd demo/homelab
  claude --setting-sources project,local --strict-mcp-config \
         --tools Read,Glob,Grep,Bash,Skill,Write

Ask: "where were we?" - the answer comes from HANDOFF.md, injected by the
SessionStart hook before your first message, not from a file you have to open.

Then try the loop: "check logs/link-check.log for last night's run and update
the handoff if the third clean night landed." Watch the capture buffer grow at
.claude/throughline/buffer/session-<id>.md as you go, then ask for a handoff
and see it distilled into HANDOFF.md and a new session log.

Claude Code will ask you to trust this folder, because it carries a project
hook in .claude/settings.json. The hooks at .claude/hooks/*.sh are copies of
the real throughline/hooks/*.sh, placed here by this script: read them before
you accept, the same as any repo you clone.
EOF
