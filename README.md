# throughline

**Continuous, state-aware session memory for Claude Code.** Captures what you *did*
and what *is* — commands, file changes, decisions, live git/PR state — then hands it
off with judgment when the session wraps. Your artifacts stay readable, editable, and
yours.

---

## Why throughline

Most "memory" tools for AI agents replay the *conversation*. throughline captures the
**work and the state**, separates cheap automatic capture from deliberate curated
handoff, and binds into Claude Code's native memory system.

| | conversation-replay tools | **throughline** |
|---|---|---|
| What it captures | chat transcript, lossy summaries | **actions + state** — commands, files, decisions, git/PR |
| Capture vs. distill | one lossy step | **separated**: continuous capture, judged handoff |
| Project state | none | **live git/branch/PR/issue** at load |
| Artifacts | opaque blobs | **human-readable, editable, committable** |
| Storage | per-machine, pollutes git | **configurable**, clean gitignore, team-shareable handoff |
| Native memory | ignored | **binds** to Claude Code's memory (curated promotion) |

## How it works

Three layers, each doing what it's actually capable of:

1. **Continuous capture** (`PostToolUse` hook) — appends a structured one-liner per
   mutating action to a per-session buffer. Mechanical, cheap, compaction-proof. You
   never see it; it just protects you.
2. **Judged handoff** (`throughline-handoff` skill) — at wrap-up, the agent distills
   the buffer + context into a durable `HANDOFF.md` and a timestamped session log,
   and promotes any durable facts into native memory. This is the judgment layer, so
   it's a skill, not a hook. It runs proactively at detected wrap-up and reports the
   diff for your review.
3. **Safety-net flush** (`SessionEnd` hook) — stamps the buffer on exit so a session
   that ended without a handoff is surfaced next time for retroactive distillation.
   Nothing is ever silently lost.

Orientation is automated too: a `SessionStart` hook injects a HANDOFF.md pointer +
live git state, complementing Claude Code's native `MEMORY.md` load. The
`throughline-onboard` skill does the full pass (open PRs/issues, deep read) on demand.

## Install

```
/plugin marketplace add dynamic/throughline
/plugin install throughline@throughline
```

Then reload (`/reload-plugins`) or restart the session.

## Configuration

By default, state lives in **`.claude/throughline/`** in each project (the universal
Claude Code workspace dir). Override the location with an environment variable:

```sh
# Unify with a portable .agent/ handoff convention (e.g. for cross-harness use):
export THROUGHLINE_DATA_DIR=.agent/handoff
```

- Relative values resolve against the project root; absolute values are used as-is.
- throughline stays silent in a project until that project is opted in (the data dir
  exists, or a HANDOFF.md is present) — no noise in unrelated repos.

**Commit policy:** the durable `HANDOFF.md` and `logs/` are meant to be committed so
teammates and fresh clones get oriented. The raw `buffer/` is scratch — gitignore it:

```gitignore
# in your project's .gitignore
.claude/throughline/buffer/
```

## Auto-handoff at wrap-up (optional reinforcement)

The handoff skill is written to run proactively when the agent detects the session
winding down. To reinforce it, add one line to your project or global `CLAUDE.md`:

> When a session reaches a natural stopping point or the user signals they're done,
> run the `throughline-handoff` skill and report the diff — don't wait to be asked.

## Layout

```
throughline/
├─ .claude-plugin/
│  ├─ plugin.json
│  └─ marketplace.json
├─ hooks/
│  ├─ hooks.json
│  ├─ _lib.sh              # data-dir resolution + activation gate
│  ├─ session-onboard.sh   # SessionStart: pointer + live git state
│  ├─ session-capture.sh   # PostToolUse: structured action buffer
│  └─ session-flush.sh     # SessionEnd: safety-net stamp
└─ skills/
   ├─ throughline-onboard/SKILL.md   # full orientation
   └─ throughline-handoff/SKILL.md   # judged distillation + memory binding
```

## License

MIT © Dynamic Agency
