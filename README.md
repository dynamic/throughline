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
| Artifacts | opaque blobs | **human-readable, editable, plain text** |
| Storage | per-machine, pollutes git | **local by default**, clean gitignore, commit when you choose |
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

1. **Continuous capture** (`UserPromptSubmit` + `PostToolUse` hooks) - appends a
   structured one-liner per user prompt and per captured action to a per-session
   buffer: the intent behind the work, then the command, file, search, fetch, or
   delegated task, flagged if it was interrupted, with obvious secrets masked
   before anything is written. Mutating tools (Bash/Edit/Write/NotebookEdit) plus
   high-signal read-side tools (Grep/WebFetch/WebSearch/Task/agents) and MCP tools
   are captured; the noisiest (Read/Glob) are deliberately skipped so the buffer
   stays skimmable. Mechanical and cheap. You never see it; it just protects you.
2. **Judged handoff** (`handoff` skill) - at wrap-up, the agent distills
   the buffer + context into a durable `HANDOFF.md` and a timestamped session log,
   and promotes any durable facts into native memory. This is the judgment layer, so
   it's a skill, not a hook. It runs proactively at detected wrap-up and reports the
   diff for your review.
3. **Safety-net flush** (`SessionEnd` hook) - stamps the buffer on exit so a session
   that ended without a handoff is surfaced next time for retroactive distillation.
   Nothing is ever silently lost.

Orientation is automated too: a `SessionStart` hook injects a HANDOFF.md pointer +
live git state, complementing Claude Code's native `MEMORY.md` load. The
`onboard` skill does the full pass (open PRs/issues, deep read) on demand.

And over months, the same lesson can appear in session log after session log without
ever graduating. The `consolidate` skill is the periodic pass (monthly,
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
# Opt in to a portable .agent/ handoff convention - e.g. for cross-harness use,
# or a team that has agreed to commit its handoffs (see "Local by default" below):
export THROUGHLINE_DATA_DIR=.agent/handoff
```

- Relative values resolve against the project root; absolute values are used as-is.
- throughline auto-activates in every project: the first time any hook fires it
  creates its data dir on demand, so capture starts working immediately with no
  manual opt-in. To keep it out of a specific project, drop an empty
  `.throughlineignore` file at the project root (see "Opting a project out" below).

### Git worktrees

In a **linked git worktree** (e.g. Claude Code's `claude/<branch>` auto-worktree
workflow, under `<project>/.claude/worktrees/<name>/`), "the project root" above
resolves to the **main working tree**, not the worktree itself - so every worktree
of a repo, plus its main checkout, share one `HANDOFF.md`/`logs/`/`buffer/` instead
of each worktree silently accumulating its own. `session-onboard.sh` prints a note
when this redirect is active. Live git state (current branch, `git status`) and
captured file paths still describe the worktree you're actually in.

Set `THROUGHLINE_WORKTREE_SHARED=0` to opt back into isolated per-worktree data
dirs. Requires git 2.31+; falls back to per-worktree behavior for bare repos,
submodules, and older git.

### Opting a project out

throughline activates automatically in every project. To disable it for one
project, add an empty marker file at the project root:

```sh
touch .throughlineignore
```

**In a linked git worktree** (see "Git worktrees" above), place this at the
**main** working tree's root, not the worktree you're sitting in - that's where
the opt-out check now looks by default. (A marker already sitting in a worktree
from before worktree-sharing existed is still honored there too, so upgrading
never silently re-enables a pre-existing opt-out.)

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

Any value other than `0` disables **all five hooks completely** - no capture, no
SessionStart block (not even about existing data), no end-stamps. This is stricter
than `.throughlineignore`, which keeps orienting toward already-existing content.
Unset it (or set `0`) to re-enable; existing data is untouched either way.

**Cross-harness handoffs.** The data dir is the one knob that makes throughline
portable. Point it at `.agent/handoff` (or any other path) and the durable
`HANDOFF.md` it produces lives in a harness-neutral location any agent can read,
not buried under a Claude-Code-specific path - useful if other tooling also drives
this project. Portability of the *location* is independent of whether you commit
it - see "Local by default" below.

### Local by default

throughline's data - `HANDOFF.md`, `logs/`, `buffer/`, everything under the data
dir - is **per-operator working memory, not a shared team artifact**, and stays
local (gitignored) by default. Gitignore the whole data dir for whichever location
you use:

```gitignore
# default layout
.claude/throughline/
# or, if you set THROUGHLINE_DATA_DIR=.agent/handoff
.agent/handoff/
```

**Team projects.** On a project with multiple developers - especially ones not
using throughline, or already running their own memory/notes tooling - committing
one operator's session artifacts into the shared tree causes real friction: churn
and merge conflicts on the single mutable `HANDOFF.md`, review noise on every PR,
and possible collision with whatever a teammate already relies on. Local-only
avoids all of it: nothing throughline writes reaches a teammate's checkout unless
you deliberately choose to share it.

**Opting in to tracking.** For a solo repo, or a team that has all adopted
throughline, committing `HANDOFF.md` + `logs/` gives fresh clones and teammates a
shared, readable project record - genuinely useful when everyone is actually
reading it. To opt in, un-ignore just those two paths (keep `buffer/` and
`.capture-errors` ignored always - `buffer/` is scratch and can contain unredacted
command text, and `.capture-errors` is a scratch breadcrumb file):

```gitignore
.claude/throughline/*
!.claude/throughline/HANDOFF.md
!.claude/throughline/logs/
```

The `handoff` skill's Phase 4 offers (never auto-runs, and relevant
only once you've opted in as above) to stage exactly `HANDOFF.md` + the new
session log and commit/push them - it checks `git check-ignore` first and skips
the offer entirely when the files aren't actually committable in your layout.

> **Heads-up for allowlist-style `.gitignore`.** If your repo ignores everything
> by default (a root `/*` then `!/keep` pattern) and you *do* want to opt in to
> tracking, re-including just the two leaf paths does **not** work - git prunes
> an excluded directory before it ever evaluates negation patterns for paths
> inside it, so `.claude` (matched by the root `/*`) is never even descended
> into. The simplest fix is `THROUGHLINE_DATA_DIR=.agent/handoff` so the
> opted-in artifacts sit outside the ignored tree entirely. To keep the default
> location instead, negate **every ancestor directory** on the way down, then
> re-exclude the scratch paths (which the ancestor negations would otherwise
> expose too):
> ```gitignore
> !/.claude/
> !/.claude/throughline/
> !/.claude/throughline/HANDOFF.md
> !/.claude/throughline/logs/
> .claude/throughline/buffer/
> .claude/throughline/.capture-errors
> ```

## Housekeeping

Everything throughline writes grows without automatic bound: there is no
background cleanup process, deliberately, to keep the plugin's footprint at
"pure POSIX sh + jq, zero infrastructure." What's safe to clean up by hand,
and what isn't:

**Safe to delete:**
- `buffer/archive/*.md` older than your last `consolidate` pass -
  once a consolidation has mined a log for recurring lessons, an archived raw
  buffer behind it has nothing left to give. As a simple rule of thumb, an
  archived buffer older than ~90 days with no open question against it is safe
  to remove.
- `.capture-errors`, once its contents have been surfaced in a session log and
  cleared by the handoff skill (Phase 4): it's a breadcrumb meant to be read
  once, not a running log.

**Not safe to delete:**
- `logs/`: these are the evidence trail. `consolidate` explicitly
  never prunes them, and HANDOFF.md's own "Recent Session Logs" list only ever
  points at the last 5, so older logs are already off the beaten path without
  needing to be deleted.
- `HANDOFF.md` itself, obviously - it's the durable record.
- Any buffer still in `buffer/` (not yet archived) - it may be an in-progress or
  unconsumed session; run a handoff first, which moves it to `archive/` once
  distilled.

There's no automated retention policy beyond this: clean up by hand on the
cadence above, or leave it, a growing `archive/` costs disk, not correctness.

## Auto-handoff at wrap-up (optional reinforcement)

The handoff skill is written to run proactively when the agent detects the session
winding down. To reinforce it, add one line to your project or global `CLAUDE.md`:

> When a session reaches a natural stopping point or the user signals they're done,
> run the `handoff` skill and report the diff - don't wait to be asked.

## Layout

```
throughline/
├─ .claude-plugin/
│  ├─ plugin.json
│  └─ marketplace.json
├─ hooks/
│  ├─ hooks.json
│  ├─ _lib.sh                # data-dir resolution + activation gate + jq/sid/redaction helpers
│  ├─ session-onboard.sh     # SessionStart: pointer, git state, compaction recovery
│  ├─ session-prompt.sh      # UserPromptSubmit: redacted, truncated user-intent line
│  ├─ session-capture.sh     # PostToolUse: structured action buffer (outcome + redaction)
│  ├─ session-precompact.sh  # PreCompact: stamp the compaction-boundary marker
│  └─ session-flush.sh       # SessionEnd: safety-net stamp
├─ skills/
│  ├─ onboard/SKILL.md     # full orientation
│  ├─ handoff/SKILL.md     # judged distillation + memory binding
│  └─ consolidate/SKILL.md # periodic promotion of recurring lessons
├─ tests/run.sh              # fixture-driven hook tests (shellcheck + CI)
├─ docs/                     # promo site + review report
└─ CHANGELOG.md
```

## License

MIT © Dynamic Agency
