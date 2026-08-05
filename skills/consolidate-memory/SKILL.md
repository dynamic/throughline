---
name: consolidate-memory
description: Memory file hygiene and consolidation for project memories - detects duplicates, stale entries, unindexed orphans, and index orphans in ~/.claude/projects/<project-slug>/memory/
---

# Consolidate Memory Files

**Goal:** Memory file hygiene pass that detects duplicates, stale entries, and index drift - proposing cleanup actions with human approval gates.

Handles memory file hygiene for project memories, scanning for duplicates, stale entries, unindexed orphans, and index orphans in `~/.claude/projects/<project-slug>/memory/`.

## Problem Types Scanned

1. **Duplicates**: Similar descriptions (>80% text similarity) across multiple files → Merge into canonical entry
2. **Stale entries**: Files with `originSessionId` older than 90 days without updates → Flag for review/update
3. **Unindexed orphans**: `.md` files present but not linked in MEMORY.md → Add to index or mark obsolete
4. **Index orphans**: MEMORY.md links to non-existent files → Remove from index

## Phase 1: Determine Scope

1. Find the current project's memory directory: `$CLAUDE_MEMORY_DIR` if set, else `~/.claude/projects/<project-slug>/memory/`
2. Inventory `MEMORY.md` + all `*.md` topic files in the memory directory
3. Parse MEMORY.md index to build a map of indexed files vs actual files
4. Load topic files and extract frontmatter for analysis of `originSessionId`, type, and metadata

## Phase 2: Extract Candidates

Scan for the four problem types listed above:
- Calculate text similarity: use `difflib.SequenceMatcher` on file descriptions (frontmatter `description` field or first heading paragraph) - similarity > 90% flags as duplicate candidate, 80-90% as manual review
- Extract `originSessionId` from frontmatter and compare against staleness threshold (90 days default) - older files with no recent `updatedAt` are stale
- Cross-reference actual files against indexed entries in MEMORY.md
- Identify any dead links in the index

## Phase 3: Propose Promotions (Human Gate)

Present each candidate with:
- Problem type + evidence (file paths, similarity scores, dates)
- Proposed action (merge, update, add-to-index, remove-from-index, delete-file)
- Confidence level (based on similarity score / staleness / etc.)

For duplicates, show content comparison and suggest a canonical file to merge into.

For stale entries, present the age and context for manual review decision.

## Phase 4: Apply Approved Changes

After human approval:

1. For merges: Combine content into canonical file, delete duplicates, update MEMORY.md
2. For stale entries: Present for manual update (or flag in MEMORY.md)
3. For unindexed orphans: Add to MEMORY.md index with appropriate description
4. For index orphans: Remove dead links from MEMORY.md
5. Record pass in `DATA/HANDOFF.md` under "Consolidation passes"

## Safety Guidelines

- Never delete files without explicit approval
- Never auto-merge without human gate
- Always preserve original files until merge is approved
- Maintain backward compatibility of file format and frontmatter structure

## Configuration

- Similarity threshold: 80% by default (configurable)
- Staleness threshold: 90 days by default (configurable)

## Relationship to Other Skills

- `consolidate` skill mines handoff session logs for recurring lessons and proposes promotions into durable homes, with human gates
- `consolidate-memory` skill handles memory file hygiene (this skill)
- Clear division of responsibilities for maintainability