# throughline v0.4.0 - Comprehensive Audit

**Date:** 2026-07-05. **Scope:** full hook layer, all three skills, docs, tests, CI,
plugin metadata, plus a competitive scan of the Claude Code session-memory ecosystem.
P0 findings were fixed in v0.4.1; remaining findings are tracked as GitHub issues.

## Purpose (confirmed coherent)

Continuous, state-aware session memory: mechanical capture of *actions and state*
(not transcript replay) via 4 hooks, judged distillation via the handoff skill,
periodic cross-session consolidation, and a safety-net flush. The positioning
against manual HANDOFF.md, CLAUDE.md, and native memory is explicit and honest.

## What it does well

- **Never blocks a tool.** Every capture failure path exits 0, with a
  `.capture-errors` breadcrumb trail deliberately placed at the data-dir root so it
  survives the failures it reports.
- **Layered secret redaction.** 12+ credential shapes, a sentinel-based structural
  design that ended a recurring boundary-guessing bug class, and the handoff
  skill's human re-scan as a second barrier, with honestly documented limits (no
  entropy analysis, bare-flag credentials).
- **Differentiated safety gates per skill** (the standout design): onboard is
  read-only; handoff reviews post-write; consolidate gates pre-write and per-item
  because it touches always-loaded files. The rationale is documented in both
  skills and the CHANGELOG.
- **Cheap hot path.** About one jq invocation per mutating tool call; pure POSIX
  sh; only jq and git as dependencies. 95 test assertions; CI runs shellcheck,
  manifest validation, and the suite on every push/PR.
- **Compaction survival.** Stable session id across compaction keeps one logical
  session in one buffer file; precompact stamps the seam; onboard's compact path
  points recovery at the intact on-disk buffer.
- **Self-aware docs.** The CHANGELOG records the full adversarial hardening
  history; the repo dogfoods itself; no stale pre-auto-activation claims survive.

## Findings

### P0 (fixed in v0.4.1)

1. **Stale installs were invisible.** This machine ran a v0.1.0 plugin snapshot
   while the repo sat at v0.4.0: none of the redaction hardening, auto-activation,
   or the consolidate skill was actually live, and nothing surfaced it. Fixed:
   the SessionStart header now prints the running version; README documents the
   update flow.
2. **Consolidate mined `.agent/handoffs/` (plural)** while the documented
   convention is `.agent/handoff` (singular) - a silent-miss path bug. Fixed:
   the skill checks both.
3. **No machine-wide disable.** Auto-activation fires in every project;
   opting out required a `.throughlineignore` per project. Fixed:
   `THROUGHLINE_DISABLE` kill switch, checked by all four hooks.

### P1 - capture fidelity (issues filed)

4. **The "why" is never captured mechanically.** No UserPromptSubmit hook, so user
   intent exists only in the (compactable, mortal) conversation. Cheapest
   high-value fix: a small hook appending redacted, truncated prompts to the buffer.
5. **Only 4 tools are captured** (Bash, Edit, Write, NotebookEdit). Research-heavy
   sessions (Read/Grep/WebFetch/Task/MCP) leave almost no trace. Widen the matcher
   with compact lines for high-signal read-side tools.
6. **Precompact stamp is not idempotent** (flush's is; asymmetric).

Also noted, structural: Bash exit codes are invisible in the hook payload (schema
limit, documented in-source); tool results and diffs are never stored (by design,
but worth revisiting for failures specifically); a mid-session jq loss is silent
until the next SessionStart.

### P2 - distillation and UX (issues filed)

7. **No "what we tried / failed approaches" section** in the session-log template.
   Competitors treat failed approaches as the single highest-value handoff content:
   they are the most expensive thing to rediscover. Add the section plus a chain
   link to the previous session log.
8. **Post-compaction recovery is a pointer, not content.** onboard(compact) tells
   Claude where the buffer is; competitors inline the recovered context directly
   into the SessionStart block so recovery costs zero extra tool calls.
9. **No management affordances.** No status surface beyond the SessionStart block,
   no cleanup flow for `logs/` / `buffer/archive/` / `.capture-errors`, all of
   which grow without bound.
10. **Polish items.** handoff Phase 4.4 offers "or delete" for consumed buffers
    (unguarded data loss; archive-only is safer); the native-memory binding in
    handoff Phase 4.3 should cite the now-documented auto-memory layout
    (MEMORY.md index, 200-line/25KB load limit, topic files); test-count drift
    across CHANGELOG/HANDOFF; plugin.json keywords under-sell the git-state and
    cross-harness differentiators.

### P3 - noted, not planned

Searchable log index (FTS), background/AI compression, `<private>` tag support,
Stop-hook wrap-up enforcement, structured YAML frontmatter on session logs. Each
adds runtime weight against throughline's "pure POSIX sh + jq" identity. Revisit
only if log volume makes grep insufficient.

## Competitive scan

- **claude-mem** (~86k stars): captures UserPromptSubmit + Stop + SessionEnd;
  AI-compressed observations in SQLite/FTS5 plus vector search;
  progressive-disclosure retrieval (search index, then timeline, then detail,
  roughly 10x token savings); `<private>` tags; web viewer. Heavy infrastructure
  (Bun worker on port 37777). Its retrieval ideas transfer; its runtime should not.
- **thepushkarp/handoff**: SessionStart(compact) auto-injects the latest handoff
  entry back into context; a Stop hook blocks session exit until the model
  completes required summary fields.
- **REMvisual/claude-handoff**: "What We Tried" as the highest-value section;
  sequence-numbered chain links between handoffs; evidence mining (real numbers
  over summaries); self-validation gates.
- **who96/claude-code-context-handoff**: restores context as `additionalContext`
  automatically on SessionStart(compact|clear), with an age-guarded
  latest-handoff fallback.
- **Continuous-Claude-v3**: structured YAML handoffs for machine parseability;
  post-session daemon extraction; PostgreSQL/pgvector. Far heavier than
  throughline wants to be.
- **Native auto-memory**: the memory dir layout is now officially documented
  (MEMORY.md index loaded at 200 lines/25KB, topic files on demand), so
  throughline's memory binding can cite it instead of relying on an assumed
  layout.

**Where throughline already leads:** zero-infrastructure POSIX design, capture
that never blocks tooling, the graded safety-gate model, secret redaction at
capture time (none of the surveyed tools redact mechanically), and honest scope
documentation.
