---
name: throughline-consolidate
description: Periodic consolidation pass that mines the timestamped handoff session logs for lessons recurring across sessions and proposes promoting them into durable homes, with a human gate on every promotion. Run when the user says "consolidate handoffs", "mine the handoff logs", "consolidation pass", or "promote lessons" - or roughly monthly, or when HANDOFF.md has grown stale or bloated and the same lessons keep being re-learned session after session.
---

# throughline - Consolidate (promotion)

**Goal:** Handoff distills one session; onboard reads it back. Neither notices that
the same lesson has now appeared in four different session logs. This skill is the
periodic pass that does: mine the logs since the last pass, find what recurs, and
propose promoting it - with a human gate - into the durable layer where it stops
needing to be re-learned.

**Data directory** (resolve once): `$THROUGHLINE_DATA_DIR` if set, else
`<project-root>/.claude/throughline/`. Below, `DATA` refers to that path.

- Session logs: `DATA/logs/handoff-YYYY-MM-DD-HHMM.md`
- Some repos also keep session logs at `.agent/handoff/logs/` (the singular
  `THROUGHLINE_DATA_DIR` convention documented in the README - skip it if that
  path already *is* `DATA/logs/`) or `.agent/handoffs/` (a plural variant used
  by other harnesses). When either directory exists and isn't already covered
  by `DATA`, mine it too - the two names differ by one letter and are easy to
  conflate, so check for both.

**Scope boundary:** this skill owns the **handoff session logs**. Auto-memory files
(`~/.claude/projects/<slug>/memory/`) are the `consolidate-memory` skill's job -
merging duplicates, fixing stale facts, pruning the index. Don't duplicate that
work: if a candidate's right home is an auto-memory file, write the one new entry
(Phase 4) and leave the reflective cleanup of the memory dir to consolidate-memory.

---

## Phase 1: Determine scope

1. Find the last consolidation pass: `DATA/HANDOFF.md` records each pass under a
   **"Consolidation passes"** section (date + what was promoted). If the section is
   absent, this is the first pass - everything is in scope.
2. Collect the logs to mine: every `DATA/logs/handoff-*.md` dated after the last
   pass, plus `.agent/handoff/logs/*.md` and `.agent/handoffs/*.md` when those
   directories exist and aren't already `DATA/logs/`. The filenames carry the
   date; no content parsing needed to scope.
3. Confirm scope with the user before reading: which repos/paths, how many logs,
   since when. Default is the **current project only** - mining other repos'
   handoff logs is a deliberate widening, not an assumption.

---

## Phase 2: Extract candidate lessons

Read the in-scope logs. "Key learnings & gotchas" is the richest seam, but lessons
also hide in "What happened" and "Next steps". A **candidate** is anything that
recurred in **2 or more sessions**:

- **Workflow corrections** - the user pushed back the same way more than once
- **Tool quirks** - a tool that needs the same workaround every time
- **Environment gotchas** - non-obvious config, ordering, or platform behavior
- **Conventions** - naming, branching, commit patterns applied repeatedly

Each candidate carries three things:

1. **The lesson** - one line, stated as a rule, not a story.
2. **Evidence** - which session logs it appeared in, with a quote or close
   paraphrase from each.
3. **Confidence** - "recurred N times across M sessions". More recurrences, more
   confidence.

A lesson seen once is not a candidate - it stays in its log until it earns a
second appearance.

---

## Phase 3: Propose promotions (human gate)

For each candidate, propose exactly **one** home:

| Home | When |
|---|---|
| (a) Global `CLAUDE.md` rule | The lesson holds across all projects |
| (b) The owning skill, in its source repo | The lesson corrects or extends a specific skill. **File an issue in that repo - never edit another repo's skill directly** |
| (c) Project `CLAUDE.md` / durable `HANDOFF.md` section | The lesson is project-specific and true every session |
| (d) Auto-memory file | A confirmed preference or fact that fits the native memory types (`feedback`, `user`, `project`, `reference`) |

Present the **full list** - lesson, evidence, confidence, proposed home - and stop.
**Nothing is applied without explicit approval, per item.** The user may approve,
redirect (same lesson, different home), or reject each candidate independently.
Unlike handoff's post-write review, this gate is **pre-write**: promotions touch
always-loaded files, where one wrong line costs every future session.

---

## Phase 4: Apply and record

1. Apply the **approved** promotions only, each to its agreed home. For home (b),
   opening the issue *is* the promotion - the edit happens in that repo on its own
   schedule.
2. Record the pass in `DATA/HANDOFF.md` under "Consolidation passes" (create the
   section if absent): date + what was promoted and where, one line per promotion.
   Update the **Last Updated** date.
3. **Leave the session logs untouched** - they are historical records, and they are
   the evidence trail for every promotion just made. The point of promotion is
   that the durable copy now lives where it is always loaded; the log keeps the
   original context.
4. Report: what was applied, what was redirected, what was rejected, and the next
   suggested pass date (roughly a month out).

---

## Reminders

- **2+ recurrences is the bar.** Resist promoting a vivid one-off; if it matters,
  it will recur.
- **Cross-repo promotions are issues, not edits** - the owning repo reviews the
  lesson on its own terms.
- **Session logs are evidence, not scratch** - prune nothing from them.
- **Stay off consolidate-memory's turf** - one new memory entry per approved
  candidate is fine; restructuring the memory dir is not this skill's job.
