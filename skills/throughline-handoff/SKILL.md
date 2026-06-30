---
name: throughline-handoff
description: Distill the current session into the durable HANDOFF.md plus a timestamped session log, using the throughline capture buffer as source. Run when the user asks to "handoff", "wrap up", "save the session", "checkpoint", or when the session is clearly winding down (work complete, user signals done/thanks/that's all). Proactively offer or run this at detected wrap-up — do not wait to be asked.
---

# throughline — Handoff (distillation)

**Goal:** Turn a session's raw, continuously-captured actions into curated, durable
project memory. Capture is automatic (hooks); **distillation is this skill** — the
judgment layer that decides signal vs. noise.

**Data directory** (resolve once): `$THROUGHLINE_DATA_DIR` if set, else
`<project-root>/.claude/throughline/`. Below, `DATA` refers to that path.

- Durable handoff: `DATA/HANDOFF.md`
- Session logs: `DATA/logs/handoff-YYYY-MM-DD-HHMM.md`
- Raw capture buffers: `DATA/buffer/session-<id>.md`

---

## When to run (including proactively)

Run when the user explicitly asks, **or** when you detect wrap-up: the planned work
is complete, the user says "thanks / done / that's all / ship it", or a natural
stopping point is reached. At wrap-up, **just run it and report the diff** — don't
ask permission first. HANDOFF.md updates are idempotent, so an early run is simply
refined by the next. Never run it more than once per unchanged state.

---

## Phase 1: Gather source

1. Read **all** `DATA/buffer/session-*.md` — these are the continuously-captured
   actions (commands, file edits) for this and any unconsumed prior sessions.
   They survive context compaction, so trust them over fuzzy recollection. One
   session is one file (keyed by a session id stable across compaction).
   - Lines marked `` `[failed]` `` are actions that errored or were interrupted;
     do not record them as completed work.
   - A `<!-- compaction-boundary ... -->` line marks where a compaction happened.
     For actions **above** the most recent boundary, distill from the buffer text
     itself: the conversation's account of *why* they were done has been
     summarized away and your recall of it is no longer trustworthy.
2. Read the current `DATA/HANDOFF.md` (create from the Phase 5 template if absent).
3. Cross-reference the buffer against the live conversation: the buffer says *what
   happened*; the conversation says *why*. Distillation needs both (subject to the
   boundary caveat above).

---

## Phase 2: Synthesize (signal vs. noise)

Decide what is a **permanent, reusable change** vs. session-specific noise. For each
applicable area, prepare concise updates (skip what doesn't apply):

- **Architecture & services** — components/repos/topology added, removed, restructured
- **Environment & infra** — deploys, config changes, version bumps
- **Tools & integrations** — added/renamed/removed; auth or token-handling changes
- **Configuration & secrets** — config touched; new env vars / key **names** (never values)
- **Resolved issues** — move from Pending → Resolved with root cause + fix
- **Pending items** — new problems, refactors, next steps surfaced this session
- **Key files & resources** — important new files, scripts, directories

---

## Phase 3: Write the session log

Create `DATA/logs/handoff-YYYY-MM-DD-HHMM.md` (local time; create `logs/` if needed):

```markdown
# Handoff: <Brief Title>
**Date:** <YYYY-MM-DD HH:MM TZ>   **Session:** <session-id if known>

## Objective
The big-picture goal of the session.

## What happened
Distilled from the capture buffer + conversation: commands run, files changed,
decisions made — with the *why*.

## Progress
### Completed   ### In progress   ### Not started

## Key learnings & gotchas
Root causes, non-obvious config, workarounds, things that look like they should
work but don't.

## Current state
Repo (branch, uncommitted, sync), deploy status, open PRs/issues.

## Next steps
Ordered, specific — exact commands, paths, expected outcomes.

## Files & resources
Key paths, URLs, credential locations (names only).
```

---

## Phase 4: Update durable HANDOFF.md + memory binding

1. Apply the Phase 2 updates to `DATA/HANDOFF.md`. Keep each entry to 1–2 lines —
   it's a reference doc, not a journal. Update its **Last Updated** date.
2. Add a link to the new session log under "Recent Session Logs" — keep only the
   **last 5**.
3. **Memory binding (native system):** ask "did this session surface a durable fact
   worth pinning?" Types: a confirmed preference (`feedback`), a fact about the
   user/context (`user`), a project constraint/decision (`project`), a resource
   pointer (`reference`). If yes, write it to the native memory dir
   (`~/.claude/projects/<slug>/memory/`) using the established frontmatter and
   update `MEMORY.md`. This promotion is **curated** — never auto-dump the buffer
   into memory. One entry per genuine insight; skip if nothing new.
4. **Consume the buffers:** move distilled `DATA/buffer/session-*.md` into
   `DATA/buffer/archive/` (or delete) so they aren't re-processed next session.

---

## Phase 5: HANDOFF.md template (if absent)

```markdown
# <Project> — Handoff
**Last Updated:** <YYYY-MM-DD>

## Architecture & Services
## Environment & Infrastructure
## Tools & Integrations
## Authentication & Secrets
## Resolved Issues
| Issue | Resolution | Date |
## Pending Items
| Item | Priority | Tracking |
## Key Files & Resources
| Resource | Path |
## Recent Session Logs
1. [Title](logs/handoff-YYYY-MM-DD-HHMM.md) — YYYY-MM-DD
```

---

## Reminders
- **Distillation needs judgment** — that's why this is a skill, not a hook. Be terse,
  preserve structure, don't duplicate existing entries.
- **Re-scan for secrets before writing.** Capture masks obvious credential shapes,
  but it is best-effort, not a guarantee. Before writing anything into the committed
  `HANDOFF.md` or `logs/`, scan your draft for token-shaped strings (case-insensitive
  `token|key|secret|password`, `Bearer`, `ghp_`/`sk-`/`AKIA`, URL userinfo) and
  reduce them to key names only. This is defense in depth, not the sole barrier.
- **Report, then let the user review.** After writing, show the HANDOFF.md diff +
  session-log path. The review gate is post-write, not pre-write.
- **Buffers are the source of truth for *what happened*** — they don't lie about
  which commands ran or files changed, even after a long, compacted session.
