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
   - Lines marked `` `[interrupted]` `` (or `` `[failed]` `` where a tool exposes
     an error flag) are actions that did not complete cleanly; do not record them
     as done. The Claude Code Bash result carries no exit code, so a plain failed
     command is unmarked: cross-reference the conversation to judge its success.
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
**Follows:** [<predecessor title>](handoff-YYYY-MM-DD-HHMM.md) <!-- same work stream only; omit if none -->

## Objective
The big-picture goal of the session.

## What happened
Distilled from the capture buffer + conversation: commands run, files changed,
decisions made — with the *why*.

## What we tried (including what failed)
Approaches attempted and abandoned, with the REAL evidence: the actual command,
error text, or number that killed the approach, not a summary of it. A failed
approach is the most expensive thing for a future session to rediscover from
scratch; a summary like "tried caching, didn't work" gives a future session
nothing to avoid re-trying. Omit this section only if nothing was actually tried
and abandoned this session.

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

**Chain link:** if this session continues work a prior log already started (same
work stream, not just the same project), name that predecessor in the **Follows**
line above so a reader can walk the decision history log-to-log without HANDOFF.md
having to carry it. Omit the line entirely for a session that starts something new.

---

## Phase 4: Update durable HANDOFF.md + memory binding

1. Apply the Phase 2 updates to `DATA/HANDOFF.md`. Keep each entry to 1–2 lines —
   it's a reference doc, not a journal. Update its **Last Updated** date.
2. Add a link to the new session log under "Recent Session Logs" — keep only the
   **last 5**.
3. **Memory binding (native system):** ask "did this session surface a durable fact
   worth pinning?" Types: a confirmed preference (`feedback`), a fact about the
   user/context (`user`), a project constraint/decision (`project`), a resource
   pointer (`reference`). Native memory is two layers: `MEMORY.md` is an
   always-loaded index (truncated past 200 lines, so every entry there must stay a
   single short line), and each entry's full content lives in its own topic file
   under `~/.claude/projects/<slug>/memory/`, read on demand. If yes, write the
   topic file with frontmatter shaped like this, then add its one-line pointer to
   `MEMORY.md`:
   ```markdown
   ---
   name: short-kebab-case-slug
   description: one-line summary used to judge relevance in a future session
   metadata:
     node_type: memory
     type: feedback   # or: user, project, reference
     originSessionId: <current session id>
   ---
   ```
   This promotion is **curated**: never auto-dump the buffer into memory. One entry
   per genuine insight; skip if nothing new.
4. **Consume the buffers:** move distilled `DATA/buffer/session-*.md` into
   `DATA/buffer/archive/` so they aren't re-processed next session. Archive only,
   never delete: an archived buffer is the recovery path if a distillation later
   turns out to have missed something. See "Housekeeping" in the README for when an
   archived buffer is old enough to actually delete.
5. **Clear resolved breadcrumbs:** if `DATA/.capture-errors` exists and its contents
   were surfaced above (as a Phase 2 "Resolved Issues" entry or in the session log),
   clear the file now that it has been distilled - it exists to make a swallowed
   capture failure visible exactly once, not to keep nagging on every future onboard
   after it's already been read and acted on.
6. **Emit a next-session briefing.** Render a second, compact view of the session
   log's `## Next steps` (plus `## Objective`, what landed, and the sharpest
   `## Key learnings & gotchas` item) as a copy-pasteable fenced block in your
   report - this is not new synthesis, just a different rendering of what the
   log already holds, aimed at priming a brand-new agent/session rather than
   documenting for a human reader. Do not write it to a file; emit-only.

   ```
   ## Next session briefing - <project>
   Continuing: <one-line objective>
   Last done: <what just landed - PRs merged, deploys done>
   Next: <ordered, specific next steps - exact commands/paths where known>
   Watch out for: <sharpest gotcha from this session, if any>
   ```

7. **Offer to commit + push the handoff artifacts** (offer only, never auto-run -
   the write already happened; this is the review-gated action). throughline's
   data is local-only *by default* (see README "Local by default") - this offer
   only ever produces a commit when the project has deliberately opted in by
   un-ignoring `HANDOFF.md`/`logs/`, so on an unmodified default layout it will
   correctly find nothing to stage and skip silently. Do not treat "nothing
   offered" as a bug; it's the expected outcome unless the project opted in.
   - If `DATA` lives outside the current project's git tree (an absolute
     `THROUGHLINE_DATA_DIR` pointed at a shared, cross-harness location - a
     documented, supported config), skip the offer entirely: those files aren't
     part of this repo's commit at all, and `git check-ignore` on a path outside
     the repo fails with a fatal error rather than a clean answer (same reasoning
     `session-onboard.sh`'s gitignore nudge already applies - see its comment there).
   - Otherwise, check `DATA/HANDOFF.md` and the new session log **independently**
     with `git check-ignore`. Offer to stage whichever of the two is NOT ignored;
     if both are ignored, say so and skip the offer - nothing committable exists
     (the default, local-only layout - including this repo's own dogfooded
     `.claude/throughline/` - is itself gitignored, so this is the common case).
   - Stage **exactly** the not-ignored file(s) by their literal paths - `DATA/HANDOFF.md`
     and/or the specific `DATA/logs/handoff-YYYY-MM-DD-HHMM.md` just written this
     session. Never a glob like `logs/handoff-*.md` (it would sweep in older,
     previously-declined session logs too), never `git add -A`, never `buffer/`
     or `.capture-errors` (see README "Local by default" - those two paths stay
     gitignored even when a project opts in to tracking `HANDOFF.md`/`logs/`).
   - Propose a conventional message, e.g. `docs: session handoff - <brief summary>`,
     matching whatever commit-message convention the repo already follows.
   - Treat push as a separate, remote-affecting confirmation after the commit -
     defer to the calling agent's existing git safety norms (branch-first on a
     default branch, respect any repo-configured push gate, don't bypass one
     without explicit authorization each time).

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
  but it is best-effort pattern matching, not a guarantee — it has no entropy
  analysis, so a bare opaque token with no recognizable keyword or prefix passes
  through unmasked. Before writing anything into `HANDOFF.md` or `logs/` - and
  especially before any opt-in commit of them - scan your draft for token-shaped
  strings (case-insensitive
  `token|key|secret|password|credential|auth`, `Bearer`, `ghp_`/`github_pat_`/
  `gh[oprsu]_`/`sk-`/`AKIA`, URL userinfo) **and** for any other long, opaque,
  random-looking string regardless of keyword — reduce all of them to key names
  only. Two shapes capture's own redaction structurally cannot catch, so they
  need a human/model eye specifically: (1) a credential attached to a bare CLI
  flag with no keyword (`mysql -p<password>`, `curl -u user:pass`) — flags like
  `-u`/`-p` are too overloaded across tools (e.g. `docker run -u uid:gid`) to
  redact mechanically without false positives; (2) a value that's only
  *partially* masked — seeing a `***` in a captured line doesn't mean the whole
  secret was caught, so check what's still readable around it, not just whether
  a mask is present. This is defense in depth, not the sole barrier.
- **Report, then let the user review.** After writing, show the HANDOFF.md diff +
  session-log path, then the copy-pasteable next-session briefing block, then the
  commit/push offer. The review gate is post-write, not pre-write - commit/push is
  the only action in this sequence that waits on an explicit go.
- **Buffers are the source of truth for *what happened*** — they don't lie about
  which commands ran or files changed, even after a long, compacted session.
