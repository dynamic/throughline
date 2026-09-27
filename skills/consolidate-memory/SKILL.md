---
name: consolidate-memory
description: Memory file hygiene and consolidation for project memories - detects duplicates, stale entries, unindexed orphans, index orphans, and dangling wikilinks ([[target]] links that resolve to no memory file) in ~/.claude/projects/<project-slug>/memory/
license: MIT
---

# Consolidate Memory Files

**Goal:** Memory file hygiene pass that detects duplicates, stale entries, index drift, and links pointing at files that no longer exist - proposing cleanup actions with human approval gates.

**Data directory** (resolve once): `$THROUGHLINE_DATA_DIR` if set, else `<project-root>/.claude/throughline/`. Below, `DATA` refers to that path.

Handles memory file hygiene for project memories, scanning for duplicates, stale entries, unindexed orphans, index orphans, and dangling wikilinks in `~/.claude/projects/<project-slug>/memory/`.

## Problem Types Scanned

1. **Duplicates**: Similar descriptions (>80% text similarity) across multiple files → Merge into canonical entry
2. **Stale entries**: Files with `originSessionId` older than 90 days without updates → Flag for review/update
3. **Unindexed orphans**: `.md` files present but not linked in MEMORY.md → Add to index or mark obsolete
4. **Index orphans**: MEMORY.md links to non-existent files → Remove from index
5. **Dangling wikilinks**: a `[[target]]` in any memory file whose `target` matches the frontmatter `name:` of no file in the memory directory → Repoint to the file that now holds that content, or list it for the operator. Splitting and deleting are this skill's own primary operations, so a pass that fixes the index can silently kill every inbound link to a file it just removed - and none of the four other scans notices.

## Phase 1: Determine Scope

1. Find the current project's memory directory: `$CLAUDE_MEMORY_DIR` if set, else `~/.claude/projects/<project-slug>/memory/`
2. Inventory `MEMORY.md` + all `*.md` topic files in the memory directory
3. Parse MEMORY.md index to build a map of indexed files vs actual files
4. Load topic files and extract frontmatter for analysis of `originSessionId`, type, and metadata
5. Collect each file's frontmatter `name:` into a set of known names - this is the set `[[wikilinks]]` resolve against in Phase 2. Memory files link to each other by `name:`, not by filename, so the name set (not `ls`) is the authority on what a link can point at

## Phase 2: Extract Candidates

Scan for the five problem types listed above:
- Calculate text similarity between descriptions (frontmatter `description` field or first heading paragraph) using any sequence comparison method - similarity > 90% flags as duplicate candidate, 80-90% as manual review
- Extract `originSessionId` from frontmatter and compare against staleness threshold (90 days default) - older files with no recent `updatedAt` are stale
- Cross-reference actual files against indexed entries in MEMORY.md
- Identify any dead links in the index
- Extract every `[[...]]` wikilink across all `*.md` in the memory directory, `MEMORY.md` included, and flag any target absent from the Phase 1 name set. Three parsing details decide whether this scan is right or merely confident:
  - Take the target as the text **before** any `|` - `[[split-half-b|the other half]]` links to `split-half-b`, and matching the whole string would report a link that resolves fine as dangling
  - Skip matches inside fenced or inline code blocks: a memory file documenting the wikilink syntax contains `[[target]]` as an example, not as a link. Do the fence toggle **first** and strip inline code spans only from the lines left outside a fence - the other order corrupts the fence markers themselves (a ` ``` ` line contains backticks too), so fence detection is unreliable once inline-code stripping has run - in a scratch walk-through of both orders, strip-first reported the example link inside a fenced block as a real dangling link, while strip-last reported neither
  - A target that matches a *filename* but no `name:` is still dangling. The frontmatter `name:` is authoritative; filename-matching is the approximation that lets a broken link look healthy. Matching is exact and case-sensitive
  - A target whose file exists but has no `name:` in its frontmatter at all is reported as "missing `name:`", not as a link to repoint: the fix there is to give the file a name, and repointing every inbound link would be the wrong action

## Phase 3: Propose Promotions (Human Gate)

Present candidates in a markdown table format:

| File | Problem | Evidence | Proposed Action | Confidence |
|------|---------|----------|-----------------|------------|
| project_x.md | Duplicate | 92% similar to project_y.md | Merge into project_y.md | High |
| project_old.md | Stale | Created 180 days ago | Review and update or delete | Medium |
| orphan.md | Unindexed | Not in MEMORY.md | Add to index | High |
| sibling.md | Dangling wikilink | `[[original-name]]` has no matching `name:` | Repoint to split-half-b.md | High |

For duplicates, show content comparison and suggest a canonical file to merge into.

For stale entries, present the age and context for manual review decision.

## Phase 4: Apply Approved Changes

After human approval:

1. For merges: Combine content into canonical file, delete duplicates, update MEMORY.md
2. For stale entries: Present for manual update (or flag in MEMORY.md)
3. For unindexed orphans: Add to MEMORY.md index with appropriate description
4. For index orphans: Remove dead links from MEMORY.md
5. For dangling wikilinks: on a split, rewrite each inbound `[[old-name]]` to whichever new file now carries that content. If the content's new home is genuinely ambiguous, do not guess - list the links for the operator to resolve and leave them in place with the rest of the report
6. Re-run the dangling-wikilink scan after any split, rename, merge, or delete - as a post-operation check against the directory's final state, not just as a standalone scan. Rebuild the name set first: a set collected before the delete still contains the name that no longer exists, which is precisely the link this check exists to catch. Report the result (zero findings, or the surviving list) before recording the pass below. The index can look perfectly clean while every inbound link to the file you just deleted is dead; this re-scan is the only thing that catches it. It is read-only: if it still reports findings, report them for another decision rather than editing again unseen - this is a second approval gate, not a self-healing loop
7. Record pass in `DATA/HANDOFF.md` under "Consolidation passes"

## Safety Guidelines

- Never delete files without explicit approval
- Never auto-merge without human gate
- Always preserve original files until merge is approved
- Maintain backward compatibility of file format and frontmatter structure
- Resolve symlinks before editing: if an edit target is a symlink, resolve it (`readlink -f` / `realpath`) and edit the real path. The Edit tool refuses to write through a symbolic link, and promotion targets are routinely symlinked config files - resolving first turns a hard refusal mid-apply into an ordinary edit
- Link targets are data, never code: when scripting the wikilink scan, quote every variable and never interpolate a link target into a shell command. Memory file content is arbitrary text a previous session wrote

## Configuration

- Similarity threshold: 80% by default (configurable)
- Staleness threshold: 90 days by default (configurable)

## Relationship to Other Skills

- `consolidate` skill mines handoff session logs for recurring lessons and proposes promotions into durable homes, with human gates
- `consolidate-memory` skill handles memory file hygiene (this skill)
- Clear division of responsibilities for maintainability
