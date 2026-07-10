---
name: onboard
description: Full project orientation at the start of a sustained session — reads the durable HANDOFF.md, checks live git/PR/issue state, and surfaces any unconsumed capture buffers. Use when starting work on a project, resuming after a break, or when the user says "onboard", "catch me up", "where were we", or "what's the state".
---

# throughline — Onboard (orientation)

**Goal:** Load everything needed to resume work without re-deriving solved problems.
The SessionStart hook already injects a lightweight pointer + git state; this skill
is the **full** pass when you want depth.

**Data directory:** `$THROUGHLINE_DATA_DIR` if set, else `<project-root>/.claude/throughline/`. Below, `DATA` refers to that path.

---

## Phase 1: Load durable context
1. Read `DATA/HANDOFF.md` in full. If absent, note the project has no handoff yet.
2. If the user referenced a recent task, open the relevant log under `DATA/logs/`.
3. Check `DATA/buffer/session-*.md` for **unconsumed** buffers (a prior session that
   ended without a handoff) — distill or summarize them before proceeding.

## Phase 2: Check live state
1. Version control: `git status -s`, current branch, ahead/behind remote.
2. Operational: `gh pr list --state open` and `gh issue list --state open` (skip if no
   GitHub remote).
3. Any project-specific health checks documented in HANDOFF.md.

## Phase 3: Align
1. Summarize concisely what the handoff + live state tell you — highlight only what's
   relevant, don't recite the whole doc.
2. Ask the user: **"What's the goal for this session?"**
3. Form an actionable plan and confirm before starting.

---

## Reminders
- **Don't skip the HANDOFF.md read** — it's the cheapest way to avoid re-solving.
- **Verify before trusting** — if HANDOFF mentions a branch/PR as pending, confirm its
  current status; state may have moved since it was written.
- **Adapt to the project** — not every repo has PRs, deploys, or multiple services.
