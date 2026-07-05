# throughline

**Continuous, state-aware session memory for Claude Code.** Captures what you *did*
and what *is* - commands, file changes, decisions, live git/PR state - then hands it
off with judgment when the session wraps. Your artifacts stay readable, editable, and
yours.

---

## Why throughline

Most "memory" tools for AI agents replay the *conversation*. throughline captures the
**work and the state**, separates cheap automatic capture from deliberate curated
handoff, and binds into Claude Code's native memory system.

| | conversation-replay tools | **throughline** |
|---|---|---|
| What it captures | chat transcript, lossy summaries | **actions + state** - commands, files, decisions, git/PR |
| Capture vs. distill | one lossy step | **separated**: continuous capture, judged handoff |
| Project state | none | **live git/branch/PR/issue** at load |
| Artifacts | opaque blobs | **human-readable, editable, committable** |
| Storage | per-machine, pollutes git | **configurable**, clean gitignore, team-shareable handoff |
| Native memory | ignored | **binds** to Claude Code's memory (curated promotion) |

### Why not just...

- **a manual `HANDOFF.md`?** You have to remember to write it, and you write it
  from memory, which after a long session is itself reconstructed from a compacted
  transcript. throughline captures continuously and distills from a buffer that
  does not forget.
- **`CLAUDE.md`?** That is for durable preferences and project conventions, the
  things that are true every session. throughline is for per-session work state:
  what you did today, where you stopped, what is still open.
- **native `/memory`?** Native memory holds global facts. throughline holds
  project work state and live git/PR/issue context, and it *promotes* the genuinely
  durable facts up into native memory rather than competing with it.

## How it works

Three layers, each doing what it's actually capable of:

1. **Continuous capture** (`PostToolUse` hook) - appends a structured one-liner per
   mutating action to a per-session buffer: the command or file, flagged if it was
   interrupted, with obvious secrets masked before anything is written. Mechanical
   and cheap. You never see it; it just protects you.
2. **Judged handoff** (`throughline-handoff` skill) - at wrap-up, the agent distills
   the buffer + context into a durable `HANDOFF.md` and a timestamped session log,
   and promotes any durable facts into native memory. This is the judgment layer, so
   it's a skill, not a hook. It runs proactively at detected wrap-up and reports the
   diff for your review.
3. **Safety-net flush** (`SessionEnd` hook) - stamps the buffer on exit so a session
   that ended without a handoff is surfaced next time for retroactive distillation.
   Nothing is ever silently lost.

Orientation is automated too: a `SessionStart` hook injects a HANDOFF.md pointer +
live git state, complementing Claude Code's native `MEMORY.md` load. The
`throughline-onboard` skill does the full pass (open PRs/issues, deep read) on demand.

And over months, the same lesson can appear in session log after session log without
ever graduating. The `throughline-consolidate` skill is the periodic pass (monthly,
or on demand) that mines the handoff logs for lessons recurring 2+ times and proposes
promoting each one - to a global CLAUDE.md rule, an issue on the owning skill's
source repo, a durable project section, or native memory - with every promotion
gated on explicit per-item approval. Session logs stay untouched as historical
records; only the durable copy moves.

## Surviving compaction

When Claude Code compacts a long conversation, the transcript is summarized and
detail is lost. throughline is built around that fact:

- **The raw action buffer survives**, because it lives on disk, appended after
  every action, independent of the context window.
- **A `PreCompact` hook stamps a boundary marker** into the buffer at the moment of
  compaction, so a later handoff can see the seam and knows to distill the actions
  above it from the buffer text rather than from summarized recall.
- **`SessionStart` re-fires on `compact`** (an empty matcher matches every source),
  so right after a compaction throughline points Claude back at the surviving
  buffer for the current session.

Honest scope: the **what** (commands run, files changed) is compaction-proof; the
**why** (decisions, dead ends) lives in the conversation and is what compaction
discards. Run a handoff before a long session compacts to preserve the reasoning,
and the boundary marker flags where recall stops being trustworthy.

## Install

```
/plugin marketplace add dynamic/throughline   # register this repo as a marketplace
/plugin install throughline@throughline        # install plugin@marketplace (same name)
```

Then reload (`/reload-plugins`) or restart the session.

**Requirements:** `git` and `jq` on your `PATH`. `jq` parses the hook payloads; if it
is missing, capture cannot run and the SessionStart block says so rather than failing
silently.

**Updating.** Installed plugins are snapshots - they do not track this repo. An old
copy keeps running (without newer redaction and activation fixes) until you update it
from the `/plugin` manager (or uninstall and reinstall), then `/reload-plugins`. The
SessionStart block prints the running version (`## throughline vX.Y.Z`) - if it lags
this repo's releases, your install is stale.

## Configuration

By default, state lives in **`.claude/throughline/`** in each project (the universal
Claude Code workspace dir). Override the location with an environment variable:

```sh
# Unify with a portable .agent/ handoff convention (e.g. for cross-harness use):
export THROUGHLINE_DATA_DIR=.agent/handoff
```

- Relative values resolve against the project root; absolute values are used as-is.
- throughline auto-activates in every project: the first time any hook fires it
  creates its data dir on demand, so capture starts working immediately with no
  manual opt-in. To keep it out of a specific project, drop an empty
  `.throughlineignore` file at the project root (see "Opting a project out" below).

### Opting a project out

throughline activates automatically in every project. To disable it for one
project, add an empty marker file at the project root:

```sh
touch .throughlineignore
```

With that file present, no new data dir is created, and `onboard`/`capture` stop
adding anything new - regardless of `THROUGHLINE_DATA_DIR` or any pre-existing
`.claude/throughline/`. The opt-out wins even over a project that was already
active: existing `HANDOFF.md`/`logs/` are left in place, and no *new* activity is
recorded. One nuance: if a session was already being captured when the file
appears, `flush`/`precompact` still finalize that one session's already-existing
buffer (its end-stamp or compaction marker) rather than leaving it in a permanent
"still live?" limbo - they don't create anything new, they just avoid corrupting
bookkeeping for work that had already legitimately started. Remove the file to
re-enable. Commit it like `.gitignore` so the policy is shared with teammates.

### Disabling machine-wide

To turn throughline off everywhere without uninstalling or touching every project,
set the kill switch (e.g. in `~/.claude/settings.json`'s `env` block, or your shell
profile):

```sh
export THROUGHLINE_DISABLE=1
```

Any value other than `0` disables **all four hooks completely** - no capture, no
SessionStart block (not even about existing data), no end-stamps. This is stricter
than `.throughlineignore`, which keeps orienting toward already-existing content.
Unset it (or set `0`) to re-enable; existing data is untouched either way.

**Cross-harness handoffs.** The data dir is the one knob that makes throughline
portable. Point it at `.agent/handoff` and the durable `HANDOFF.md` it produces lives
in a harness-neutral location any agent or teammate can read, not buried under a
Claude-Code-specific path. One env var turns per-session memory into a shared,
tool-agnostic project record.

**Commit policy.** The durable `HANDOFF.md` and `logs/` are meant to be committed so
teammates and fresh clones get oriented. The raw `buffer/` is scratch (and can contain
unredacted command text), and `.capture-errors` is a scratch breadcrumb file (capture
write/permission failures only, no command text) - neither should ever be committed.
Gitignore both for whichever data dir you use:

```gitignore
# default layout
.claude/throughline/buffer/
.claude/throughline/.capture-errors
# or, if you set THROUGHLINE_DATA_DIR=.agent/handoff
.agent/handoff/buffer/
.agent/handoff/.capture-errors
```

> **Heads-up for allowlist-style `.gitignore`.** If your repo ignores all of
> `.claude/` (a `/*` then `!/keep` pattern), the committable `HANDOFF.md` and `logs/`
> get swallowed too. Either re-include them (`!/.claude/throughline/HANDOFF.md`,
> `!/.claude/throughline/logs/`) or set `THROUGHLINE_DATA_DIR=.agent/handoff` so the
> committed artifacts sit outside the ignored tree.

## Auto-handoff at wrap-up (optional reinforcement)

The handoff skill is written to run proactively when the agent detects the session
winding down. To reinforce it, add one line to your project or global `CLAUDE.md`:

> When a session reaches a natural stopping point or the user signals they're done,
> run the `throughline-handoff` skill and report the diff - don't wait to be asked.

## Layout

```
throughline/
├─ .claude-plugin/
│  ├─ plugin.json
│  └─ marketplace.json
├─ hooks/
│  ├─ hooks.json
│  ├─ _lib.sh                # data-dir resolution + activation gate + jq/sid helpers
│  ├─ session-onboard.sh     # SessionStart: pointer, git state, compaction recovery
│  ├─ session-capture.sh     # PostToolUse: structured action buffer (outcome + redaction)
│  ├─ session-precompact.sh  # PreCompact: stamp the compaction-boundary marker
│  └─ session-flush.sh       # SessionEnd: safety-net stamp
├─ skills/
│  ├─ throughline-onboard/SKILL.md     # full orientation
│  ├─ throughline-handoff/SKILL.md     # judged distillation + memory binding
│  └─ throughline-consolidate/SKILL.md # periodic promotion of recurring lessons
├─ tests/run.sh              # fixture-driven hook tests (shellcheck + CI)
├─ docs/                     # promo site + review report
└─ CHANGELOG.md
```

## License

MIT © Dynamic Agency
