# Memory routing per harness

`handoff`, `consolidate` and `consolidate-memory` all write durable facts somewhere.
Where depends on the harness the session runs in. Use this table instead of assuming
Claude Code's layout. You know which harness you are; if you genuinely cannot tell, ask
the operator once rather than writing or skipping.

| Harness | Durable-fact destination |
|---|---|
| Claude Code | Native auto-memory: `$CLAUDE_MEMORY_DIR` if set, else `~/.claude/projects/<slug>/memory/`, with the `MEMORY.md` index. |
| Codex CLI, OpenCode, OMP, Hermes Agent | No native store is integrated. Use the project's `AGENTS.md`, below. |

## Without native memory

- Write durable facts as one short line each under a `## Durable facts` heading in
  `AGENTS.md` at the repo root. Codex CLI and OpenCode load that file. For OMP and Hermes,
  ask the operator whether the harness loads it; if that cannot be confirmed, treat it
  as not loaded and say so in the report.
- `AGENTS.md` is a tracked file that harnesses load into context, so show each line and write it only
  after the operator approves it. Ask before creating the file. Never write secrets,
  only names.
- If the operator declines, or the harness does not load the file, keep the fact in the
  handoff report and write nothing. The session log's `Key learnings & gotchas` section is
  then the fact's durable copy: keep it out of `HANDOFF.md`, and say in the chat report that
  it was not promoted. Never write `~/.claude/projects/` from a harness
  that does not read it.
- `consolidate-memory` has nothing to tidy on these harnesses. Say so in one line and
  stop. `consolidate` still works: it reads the session logs, not the memory store.
