# Memory routing per harness

`handoff`, `consolidate` and `consolidate-memory` all write durable facts somewhere.
Where depends on the harness the session runs in. Use this table instead of assuming
Claude Code's layout. When unsure which harness you are in, treat it as not Claude Code.

| Harness | Durable-fact destination |
|---|---|
| Claude Code | Native auto-memory: `$CLAUDE_MEMORY_DIR` if set, else `~/.claude/projects/<slug>/memory/`, with the `MEMORY.md` index. |
| Codex CLI, OpenCode, OMP, Hermes Agent | No native store is integrated. Use the project's `AGENTS.md`, below. |

## Without native memory

- Write durable facts as one short line each under a `## Durable facts` heading in
  `AGENTS.md` at the repo root. Codex CLI and OpenCode load that file; check that OMP and
  Hermes do before relying on it, and say so in the report if not.
- `AGENTS.md` is a tracked file every session reads, so show each line and write it only
  after the operator approves it. Ask before creating the file. Never write secrets,
  only names.
- If the operator declines, or the harness does not load the file, keep the fact in the
  handoff report and write nothing. Never write `~/.claude/projects/` from a harness
  that does not read it.
- `consolidate-memory` has nothing to tidy on these harnesses. Say so in one line and
  stop. `consolidate` still works: it reads the session logs, not the memory store.
