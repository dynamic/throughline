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
5. **Dangling wikilinks**: a `[[target]]` in any memory file whose `target` matches the frontmatter `name:` of no file in the memory directory → Repoint to the file that now holds that content, or list it for the operator. Removing files is this skill's own work - a merge deletes the duplicate, and a topic file may be split or renamed - so a pass that fixes the index can silently kill every inbound link to the file it just removed, and none of the four other scans notices.

## Phase 1: Determine Scope

1. Find the current project's memory directory: `$CLAUDE_MEMORY_DIR` if set, else `~/.claude/projects/<project-slug>/memory/`
2. Inventory `MEMORY.md` + all `*.md` topic files in the memory directory
3. Parse MEMORY.md index to build a map of indexed files vs actual files
4. Load topic files and extract frontmatter for analysis of `originSessionId`, type, and metadata
5. Collect each file's frontmatter `name:` into a set of known names - this is the set `[[wikilinks]]` resolve against in Phase 2. Memory files link to each other by `name:`, not by filename, so the name set (not `ls`) is the authority on what a link can point at. Unquote the scalar when collecting it: `name: "split-half-b"` is the name `split-half-b`, and comparing the quoted form would report every link to it as dead

## Phase 2: Extract Candidates

Scan for the five problem types listed above:
- Calculate text similarity between descriptions (frontmatter `description` field or first heading paragraph) using any sequence comparison method - similarity > 90% flags as duplicate candidate, 80-90% as manual review
- Extract `originSessionId` from frontmatter and compare against staleness threshold (90 days default) - older files with no recent `updatedAt` are stale
- Cross-reference actual files against indexed entries in MEMORY.md
- Identify any dead links in the index
- Extract every `[[...]]` wikilink across all `*.md` in the memory directory, `MEMORY.md` included, and flag any target absent from the Phase 1 name set. These parsing details decide whether the scan is right or merely confident:
  - Take the target as the text **before** the first `|` or `#`, then drop one trailing backslash and trim whitespace. `[[split-half-b|the other half]]` links to `split-half-b` and `[[split-half-b#heading]]` links to `split-half-b`; matching the whole string would report a link that resolves fine as dangling. A link inside a markdown table has to escape its pipe as `[[split-half-b\|the other half]]`, which is the same link with a backslash glued on - hence the trailing-backslash rule. When repointing a link, replace only the target part and keep whatever `#anchor` or `|display text` it carried
  - Skip matches inside fenced or inline code blocks: a memory file documenting the wikilink syntax contains `[[target]]` as an example, not as a link. Do the fence toggle **first** and strip inline code spans only from the lines left outside a fence - the other order corrupts the fence markers themselves (a ` ``` ` line contains backticks too), so fence detection is unreliable once inline-code stripping has run and example links inside a fence start being reported as real dead links
  - **Check this case first:** if a target matches a filename - the target plus `.md`, since links never carry the extension - and that file has no `name:` in its frontmatter at all, report the link as "missing `name:`" rather than as a link to repoint. The fix is to give the file a name; repointing every inbound link to some other file would silently rewrite the vault's intent. This outranks the next bullet, which otherwise covers the same link and prescribes the opposite action
  - Otherwise, a target that matches a *filename* whose file has a **different** `name:` is still dangling: repoint it to that file's `name:`. The frontmatter `name:` is authoritative; filename-matching is the approximation that lets a broken link look healthy. Matching is exact and case-sensitive

## Phase 3: Propose Promotions (Human Gate)

Present candidates in a markdown table format:

| File | Problem | Evidence | Proposed Action | Confidence |
|------|---------|----------|-----------------|------------|
| project_x.md | Duplicate | 92% similar to project_y.md | Merge into project_y.md | High |
| project_old.md | Stale | Created 180 days ago | Review and update or delete | Medium |
| orphan.md | Unindexed | Not in MEMORY.md | Add to index | High |
| sibling.md | Dangling wikilink | `[[original-name]]` has no matching `name:` | Repoint to `[[split-half-b]]` (the `name:` of split-half-b.md) | High |
| notes.md | Missing `name:` | `[[notes]]` matches notes.md, which has no `name:` field | Add `name: notes` to notes.md, leave the link alone | High |

For duplicates, show content comparison and suggest a canonical file to merge into.

For stale entries, present the age and context for manual review decision.

## Phase 4: Apply Approved Changes

After human approval:

1. For merges: Combine content into canonical file, delete duplicates, update MEMORY.md
2. For stale entries: Present for manual update (or flag in MEMORY.md)
3. For unindexed orphans: Add to MEMORY.md index with appropriate description
4. For index orphans: Remove dead links from MEMORY.md
5. For dangling wikilinks: rewrite each dead link to the file that now carries the content, and put that file's **`name:` value** between the brackets - `[[split-half-b]]`, never `[[split-half-b.md]]`, because a filename inside a link is the exact failure this scan reports. On a merge, rewrite `[[deleted-name]]` to the canonical file's `name:` as part of the same approved merge. On a split, repoint to whichever half now carries the content; if that is genuinely ambiguous, do not guess - list the links for the operator to resolve and leave them in place with the rest of the report. For a link that was already dangling before any operation ran, apply the target the operator approved in Phase 3 - and if that approved row names no specific target `name:`, do not choose one yourself, list the link instead
6. Re-run the dangling-wikilink scan after every repoint made above, and after any split, rename, merge, or delete - as a post-operation check against the directory's final state, not just as a standalone scan. Splits and renames are normally done by another skill or an earlier session (this skill's own phases only merge), which is exactly why the check is phrased around the operation rather than around who performed it. Rebuild the name set first: a set collected before the delete still contains the name that no longer exists, which is precisely the link this check exists to catch. Report the result (zero findings, or the surviving list) before recording the pass below. The index can look perfectly clean while every inbound link to the file you just deleted is dead; this re-scan is the only thing that catches it. It is read-only: if it still reports findings, report them for another decision rather than editing again unseen - this is a second approval gate, not a self-healing loop
7. Record pass in `DATA/HANDOFF.md` under "Consolidation passes"

## Safety Guidelines

- Never delete files without explicit approval
- Never auto-merge without human gate
- Always preserve original files until merge is approved
- Maintain backward compatibility of file format and frontmatter structure
- Resolve symlinks before editing: if an edit target is a symlink, resolve it (`readlink -f` / `realpath`) and edit the real path. Memory files, and sometimes the memory directory itself, are symlinked into a shared config repo, and the agent harness's Edit tool refuses to write through a symbolic link - it fails with "Refusing to write ... it is a symbolic link" rather than following it. Editing the resolved path is the same file, seen by its real name; it does change the shared original, so the human approval gate above still governs
- This applies to edits only. A delete removes the symlink in the memory directory, not the resolved target: removing the shared original would break every other memory directory that links to it. Deleting the shared original itself needs its own explicit approval
- Link targets are data, never code: when scripting the wikilink scan, quote every variable and never interpolate a link target into a shell command. Memory file content is arbitrary text a previous session wrote

## Configuration

- Similarity threshold: 80% by default (configurable)
- Staleness threshold: 90 days by default (configurable)

## Relationship to Other Skills

- `consolidate` skill mines handoff session logs for recurring lessons and proposes promotions into durable homes, with human gates
- `consolidate-memory` skill handles memory file hygiene (this skill)
- Clear division of responsibilities for maintainability
