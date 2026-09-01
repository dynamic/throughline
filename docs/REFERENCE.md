# Reference

Configuration, git worktrees, opt-out, and housekeeping detail for throughline. The
[README](../README.md) covers the pitch, how it works, and install; this is where the
knobs and edge cases live.

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
of each worktree silently accumulating its own. The session-start capture point
prints a note when this redirect is active. Live git state (current branch,
`git status`) and captured file paths still describe the worktree you're actually in.

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

> **A tracked `HANDOFF.md` is input the agent acts on, not passive documentation.**
> The `SessionStart` hook injects it straight into a fresh session's context, and
> the `onboard`/`handoff` skills tell the agent to act on what it says. Tracking it
> means anyone who can push to that repo writes into every future session's
> context - the same caution that applies to a tracked `CLAUDE.md`, but less
> obvious here because the injection is automatic rather than something a human
> opens on purpose. Keep tracking to repos whose writers you'd trust to shape
> agent behavior.

### Troubleshooting

throughline resolves its data location through three env vars, a
`.throughlineignore` marker checked at two roots, sticky git-worktree
migration logic, and a soft `jq` dependency that degrades capture silently
when missing - reasoning through all of that by hand to answer "why isn't
capture firing" gets old fast. `session-onboard.sh --doctor` prints the
resolved state directly instead:

```sh
sh hooks/session-onboard.sh --doctor
# or, once installed as a plugin:
sh "$CLAUDE_PLUGIN_ROOT/hooks/session-onboard.sh" --doctor
```

It reports the resolved root and data root (and whether they differ, i.e.
worktree-sharing applies), the activation state and why (`disabled` /
`ignored` / `active` / `would-bootstrap`), whether `jq` is on `PATH`, live vs.
archived buffer counts, and the three env vars' current values. It is
read-only: unlike a real hook run, it never bootstraps a data directory as a
side effect, so it's safe to run out of curiosity on a project that has never
activated throughline.

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

## Layout

```
throughline/
├─ .claude-plugin/
│  ├─ plugin.json
│  └─ marketplace.json
├─ .codex-plugin/
│  └─ plugin.json           # declares skills; hooks found via convention in hooks/
├─ .agents/plugins/
│  └─ marketplace.json      # Codex marketplace entry, mirrors .claude-plugin's
├─ .opencode-plugin/
│  ├─ package.json          # Node dependencies + plugin entry point (main)
│  ├─ tsconfig.json         # TypeScript config
│  ├─ .gitignore            # Excludes node_modules/ and dist/
│  └─ src/
│     ├─ index.ts           # Plugin entry point
│     ├─ lib.ts             # Core library (data dir, session ID, buffer)
│     ├─ hooks/             # All 5 hook implementations
│     │  ├─ session-created.ts
│     │  ├─ chat-message.ts
│     │  ├─ tool-execute-after.ts
│     │  ├─ session-compacted.ts
│     │  └─ session-idle.ts
│     ├─ utils/
│     │  ├─ redaction.ts       # Redaction logic ported from jq to TypeScript
│     │  └─ redaction.test.ts
│     └─ integration.test.ts
├─ hooks/
│  ├─ hooks.json
│  ├─ _lib.sh                # data-dir resolution + activation gate + jq/sid/redaction helpers
│  ├─ session-onboard.sh     # SessionStart: pointer, git state, compaction recovery
│  ├─ session-prompt.sh      # UserPromptSubmit: redacted, truncated user-intent line
│  ├─ session-capture.sh     # PostToolUse: structured action buffer (outcome + redaction)
│  ├─ session-precompact.sh  # PreCompact: stamp the compaction-boundary marker
│  └─ session-flush.sh       # SessionEnd: safety-net stamp
├─ skills/
│  ├─ onboard/SKILL.md            # full orientation
│  ├─ handoff/SKILL.md            # judged distillation + memory binding
│  ├─ consolidate/SKILL.md        # periodic promotion of recurring lessons
│  └─ consolidate-memory/SKILL.md # native-memory file hygiene
├─ tests/run.sh              # fixture-driven hook tests (shellcheck + CI)
├─ docs/                     # promo site + reference docs
└─ CHANGELOG.md
```
