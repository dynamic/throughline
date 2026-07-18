# Changelog

All notable changes to throughline are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project uses semantic versioning.

## [0.11.0]

Shares the data dir across git worktrees (issue #31). Claude Code's
auto-worktree-per-branch workflow (`<project>/.claude/worktrees/<name>`) points
`CLAUDE_PROJECT_DIR` at the linked worktree, which previously made every
worktree accumulate its own `HANDOFF.md`/`logs/`/`buffer/` - a fresh session in
one worktree had no visibility into a handoff written minutes earlier in
another. Now, in a linked worktree, the data dir resolves to the **main**
working tree's `.claude/throughline/` by default, so every worktree of a repo
plus its main checkout share one durable handoff.

### Added
- `tl_data_root()` in `hooks/_lib.sh`: resolves to the main working tree when
  the session is a linked git worktree (via `git rev-parse --git-dir` vs.
  `--git-common-dir` to detect it, then `git worktree list` to find the main
  tree's path), else falls through to `tl_root()` unchanged. Used only for the
  data-dir anchor - file-path relativization and live git state in
  `session-onboard.sh`/`session-capture.sh` stay anchored to `tl_root()` (the
  session's own working tree), since those should describe where the session
  is actually working, not the main tree.
- Migration safety: a worktree that already accumulated its own data dir
  before this default existed keeps resolving to its own root, permanently -
  sharing only applies to worktrees that had no prior throughline data, so
  upgrading never silently strands a pre-existing `HANDOFF.md`.
- The `.throughlineignore` opt-out check honors a marker at *either* the
  shared main root or the session's own worktree root, so a marker placed in
  a worktree before this default existed keeps being honored there too.
- `THROUGHLINE_WORKTREE_SHARED=0` (or `false`/`no`/`off`) opts back into the
  previous per-worktree isolation, for users who want parallel worktrees to
  keep independent handoffs.
- `session-onboard.sh` prints a one-line note (`🔗 throughline data is shared
  with the main working tree at ...`) whenever the redirect is active, so the
  sharing is visible rather than only inferable from where `HANDOFF.md`
  happens to live.
- Falls back to per-worktree behavior (unchanged) for non-git directories and
  git < 2.31 (no `--path-format` flag). **Known, narrow gap** (verified
  against git 2.55.0, not expected to be fixable at the shell-script level):
  a main checkout created via a *fresh* `git init --separate-git-dir=<elsewhere>`
  (git-dir relocated before any `git worktree add` ever ran) leaves
  `core.worktree` unset, and in that state `git worktree list` itself - not
  just this heuristic - misreports the git-dir's own container as the "main"
  worktree. This is git's own worktree-tracking model, not a gap this script
  can close with a better query; it does not affect the ordinary case (`git
  worktree add` off a normal repo) issue #31 and Claude Code's own
  auto-worktree workflow actually produce. `THROUGHLINE_WORKTREE_SHARED=0` or
  an absolute `THROUGHLINE_DATA_DIR` sidesteps it if ever hit.

### Changed
- `tl_data_dir()` and the `.throughlineignore` opt-out check now anchor to
  `tl_data_root()` (plus `tl_root()` for the opt-out, see above) instead of
  `tl_root()` alone.
- `session-onboard.sh`'s data-path display strips (`HANDOFF.md` pointer,
  capture-errors, unconsumed-buffer warnings, the gitignore nudge) now
  relativize against the resolved data root, not the session's working tree.
- `tl_data_root()`'s resolution is memoized per hook-script run via
  `tl_resolve_data_root()`, an out-parameter helper (same convention as
  `$_tl_active_reason`) called as a bare statement rather than through command
  substitution - a naive cache inside `tl_data_root()` itself does not survive
  `$(...)`'s subshell, so without this the two hottest hooks
  (`session-capture.sh`, `session-prompt.sh`) forked git 6 times per tool
  call/prompt instead of 2.
- `skills/handoff/SKILL.md`'s Phase 4 commit-offer step now runs `git
  check-ignore` against the directory that actually contains `DATA` (which
  may be the main tree, not the session's own worktree) to avoid a fatal
  "outside repository" error, and `README.md`'s opt-out instructions now
  restate the worktree caveat at the point of use.

## [0.10.0]

Renames the three skills to drop the redundant `throughline-` prefix (issue
#29): `throughline-handoff` → `handoff`, `throughline-onboard` → `onboard`,
`throughline-consolidate` → `consolidate`. The plugin is already namespaced
`throughline`, so invoking a skill produced an awkward double-prefix
(`throughline:throughline-handoff`); the skill's own name shouldn't duplicate
what the plugin namespace already carries. No backward-compatibility path -
the sole consumer of this plugin approved a clean break while there's still
time to settle the invocation surface before anyone else depends on it.
Skill-content and documentation only - no hook, test, or plugin-config change
(skill discovery is purely directory-based).

### Changed
- Directory renames: `skills/throughline-{handoff,onboard,consolidate}/` →
  `skills/{handoff,onboard,consolidate}/` (via `git mv`, history preserved).
- `name:` frontmatter in each `SKILL.md` updated to match. `description:`
  bodies untouched - their "handoff"/"onboard"/"consolidate" mentions are
  natural-language trigger phrases, not the identifier.
- The two places the skills reference each other by name (`consolidate`'s
  Phase 1.4, `handoff`'s Phase 4) updated to the short form.
- `README.md` (10 references, including the file-tree diagram) and
  `docs/index.html` (2 references) updated to match.
- Historical mentions in `CHANGELOG.md` and `docs/REVIEW-v0.1.0.md` left
  untouched - they accurately describe repo state at the time, same principle
  already applied to every past entry here.

## [0.9.0]

Token-efficiency batch (issue #26), driven by a usage audit in a consuming project:
`HANDOFF.md` is read in full by every session's onboard pass, so it is resident
context paid for on every turn, not a one-time write - it had grown to ~5.3K
resident tokens (measured at ~12% of that project's total session token usage),
~105 of its ~199 content lines duplicating history already captured verbatim in
`CHANGELOG.md` and `logs/`. Nothing previously capped its growth: `handoff` only
appends (Pending → Resolved), and `consolidate` promotes lessons *out* but left
HANDOFF.md's own accumulated history untouched. Skill-content only - no hook
behavior change, verified by the unchanged assertion suite plus shellcheck.

### Changed
- **`skills/throughline-handoff/SKILL.md` Phase 4** - adds explicit size
  discipline: "Architecture & Services" is current-state only, never a
  per-version changelog (that narrative belongs in `CHANGELOG.md`); "Resolved
  Issues" is capped to the most recent ~8-10 rows, with older rows relocated
  (not deleted) to `CHANGELOG.md`/`logs/` as the cap is enforced.
- **`skills/throughline-consolidate/SKILL.md`** - Phase 1 gains a step that
  checks `HANDOFF.md`'s own size discipline (separate from mining the session
  logs), and Phase 3's promotion-home table gains a new home, "(e) HANDOFF-diet
  (trim, don't add)", for when per-edit discipline alone has drifted over many
  small handoffs. Closes the gap where consolidate's periodic pass never
  looked at HANDOFF.md's own bloat.

### Fixed (found during review, before merge)
- **Consolidate Phase 4 instructed writing relocated content into a session
  log**, directly contradicting the same file's own "leave session logs
  untouched" rule three lines later and its Reminders section ("session logs
  are evidence, not scratch - prune nothing from them"). Both skills also
  assumed every consuming project has a maintained `CHANGELOG.md` mirroring
  HANDOFF.md's history - true only in throughline's own dogfooded repo. Fixed
  by gating HANDOFF-diet (home e) on an explicit durable-copy check for each
  line proposed for removal - an existing `CHANGELOG.md` entry, an existing
  session-log citation (never an edit), or a new `CHANGELOG.md` entry written
  as part of the same promotion (creating the file if the project has none) -
  and refusing to trim anything whose only copy would otherwise be HANDOFF.md
  itself.

## [0.8.0]

Flips the default handoff policy: throughline's data is now **local-only by
default** (per-operator working memory, not a shared team artifact), with
tracking as a deliberate opt-in - reversal of prior guidance ("meant to be
committed so teammates get oriented"). Driver: on a multi-developer project
where other devs don't use throughline, or run their own memory tooling,
committing HANDOFF.md/logs/ into the shared tree causes churn, merge
conflicts on the single mutable HANDOFF.md, and review noise. throughline
already made this call for its own repo; this makes it the recommended
default for consuming projects too. Review (xhigh, run twice) caught three
real bugs before merge - see "Fixed" - including a wrong first-draft change
to the onboard nudge's `check-ignore` target that would have silently missed
a genuine buffer exposure; that target is unchanged from v0.7.0 in the
shipped version. Verified by the test suite (see `tests/run.sh` - it prints
its own total; 156 assertions as of this release) plus shellcheck.

### Changed
- **README "Commit policy" → "Local by default"** - rewritten to state the
  local-only default, added a "Team projects" section explaining the
  multi-developer rationale, and an explicit "Opting in to tracking" section
  for solo repos or teams that have all adopted throughline.
- **`hooks/session-onboard.sh` gitignore nudge** - message reworded for the
  new local-only-by-default framing. The `check-ignore` target stays
  `buffer/` specifically (see "Fixed" below for why a whole-data-dir target
  was tried and reverted).
- **`skills/throughline-handoff/SKILL.md` Phase 4 step 7** (commit/push
  offer) - reframed as relevant only once a project has opted in to tracking;
  on the (now default) local-only layout it correctly finds nothing
  committable and skips silently - documented as expected, not a bug.
- **`docs/index.html`** and the README comparison table - "team-shareable"
  positioning replaced with "local by default, commit when you choose."
- **`plugin.json` description** - "committable artifacts" → "local-first
  artifacts (commit them if you choose)".

### Fixed
- A first-draft change re-targeted the onboard nudge's `check-ignore` from
  `buffer/` to the whole data dir, reasoning the whole dir should normally be
  covered under the new default. Reverted: `check-ignore` on a directory path
  can report "ignored" via a directory-glob pattern (`.claude/throughline/*`
  matches the bare directory too) even when a specific file inside it -
  including the buffer, which must *always* stay untracked regardless of
  opt-in status - is genuinely exposed per `git status`. Checking a coarser
  ancestor as a proxy for the leaf path that actually matters was unsound;
  reverted to checking `buffer/` directly, which correctly catches this case
  (added as a regression test).
- The README's allowlist-style-`.gitignore` opt-in guidance re-included only
  the two leaf paths (`!/.claude/throughline/HANDOFF.md`, `!/.claude/throughline/logs/`),
  which does not work - git prunes an excluded directory before evaluating
  negation patterns for paths inside it, so re-including a leaf file whose
  ancestor directory is still excluded is a no-op. Rewritten with the correct
  ancestor-negation chain (verified against a real repo) and
  `THROUGHLINE_DATA_DIR=.agent/handoff` given as the simpler alternative.
- `hooks/_lib.sh`'s redaction comment still claimed committed logs as a
  defense-in-depth barrier, contradicting the new local-by-default policy
  (that file was outside the first commit's changed-file list).

## [0.7.0]

Closes the loop at the end of `throughline-handoff` Phase 4 (issue #21, found
while dogfooding the skill in a consuming project). No hook behavior change -
skill-content only, verified by the unchanged 154-assertion suite plus
shellcheck.

### Added
- **Issue #21** - Phase 4 now offers (never auto-runs) to stage exactly
  `HANDOFF.md` and the new session log by their literal paths (never a glob,
  which could sweep in older, previously-declined logs) and commit/push them.
  Guarded by `git check-ignore`, checked **independently per file** so a
  partially-ignored layout still offers to commit whichever file is actually
  committable, and skipped entirely when `THROUGHLINE_DATA_DIR` points outside
  the project's git tree (check-ignore is fatal on an out-of-tree path, the
  same case `session-onboard.sh`'s gitignore nudge already special-cases).
  Never stages `buffer/` or `.capture-errors`; push is a separate,
  remote-affecting confirmation that defers to whatever push-gate/branch
  conventions the calling agent already follows.
- **Issue #21** - Phase 4 also emits a compact, copy-pasteable "next session
  briefing" - a pre-written kickoff prompt rendered from the session log's
  existing `## Next steps`/`## Objective`/`## Key learnings & gotchas`, aimed
  at priming a brand-new agent or session rather than documenting for a human
  reader. Emit-only: not persisted to a file, no new `throughline-onboard`
  wiring.

## [0.6.1]

Docs/skill polish batch from the v0.4.0 audit (docs/AUDIT-v0.4.0.md, P2, items
#8/#10/#11). No hook behavior change - verified by the unchanged
154-assertion suite plus shellcheck under both Homebrew and an
`apt-get install shellcheck` Ubuntu container.

### Added
- **Issue #8** - the session-log template (`throughline-handoff` Phase 3) gains
  a "What we tried (including what failed)" section, with guidance to record
  real evidence (the actual command/error/number), not a summary - a failed
  approach is the most expensive thing for a future session to rediscover from
  scratch. A **Follows** line lets a log name its predecessor in the same work
  stream, so a reader can walk the decision history log-to-log without
  HANDOFF.md having to carry it.
- **Issue #10** - a new README "Housekeeping" section documents what's safe to
  delete (old archived buffers, a resolved `.capture-errors`) versus what
  isn't (`logs/`, `HANDOFF.md`, unarchived buffers) - deliberately a
  documented convention, not automated tooling, matching the plugin's
  zero-infrastructure identity. The handoff skill (Phase 4) now also clears
  `.capture-errors` once its contents have been surfaced in a session log,
  instead of leaving it to nag on every future onboard indefinitely.

### Changed
- **Issue #11 polish batch**: the handoff skill's Phase 4.4 no longer offers
  "(or delete)" for consumed buffers - archive-only removes an unguarded
  data-loss affordance. Phase 4.3's memory-binding step now cites the actual
  native auto-memory layout (`MEMORY.md` as a 200-line-truncated index, one
  topic file per entry under `~/.claude/projects/<slug>/memory/`) and inlines
  a one-line frontmatter example, so an executing model can't produce a
  malformed entry. `plugin.json` keywords gained `git-state`,
  `cross-harness`, `resume`, `onboarding` - the prior list under-sold the
  differentiators. `tests/run.sh`'s header now states it is the single
  source of truth for the current assertion count (it prints its own total),
  after prose counts drifted across releases before (71/83/88/95 at
  different points).

### Fixed (found during review, before merge)
- **The memory-binding frontmatter example didn't match reality**: every
  actual memory topic file (`~/.claude/projects/<slug>/memory/*.md`) carries
  `node_type: memory` and `originSessionId` under `metadata`, both omitted
  from the template this release added - so an agent following it verbatim
  would have written a schema-inconsistent entry, the exact failure the
  change claimed to prevent. Verified against every real memory file in the
  harness (100% carried both fields); the template now matches.
- **Em-dashes in new content**: the new Housekeeping section (README) and
  session-log/Phase-4 additions (`throughline-handoff` SKILL.md) used
  em-dashes, violating this user's global no-em-dash writing-style rule -
  in `handoffs`, a category the rule names explicitly. Replaced with commas,
  colons, periods, or spaced hyphens per the rule.

## [0.6.0]

Issue #9 from the v0.4.0 audit (docs/AUDIT-v0.4.0.md, P2): inline post-compaction
recovery content instead of a pointer. Feature bump - onboard's compact-path
output now carries actual buffer content, not just a filename. An independent
code-review pass on this release caught two gaps in the initial
implementation's bounded-output claim, both closed before merge. Verified by
the full 154-assertion suite (11 new) plus shellcheck under both Homebrew and
an `apt-get install shellcheck` Ubuntu container.

### Added
- **Inlined post-compaction recovery** (`session-onboard.sh`): on
  `source=compact`, the last 30 lines of the current session's action
  buffer - including any trailing `compaction-boundary` marker, which lands
  there naturally since no captured action can land between PreCompact
  stamping it and this SessionStart firing - are now printed directly into
  the SessionStart block, fenced in a code block. Previously this path only
  printed a pointer ("your buffer survived at `<path>`, read it"), which cost
  the model a tool call it might not make, at exactly the point where
  post-compaction recall is weakest. The pointer to the full file is kept
  alongside the inlined tail for sessions that ran longer than the window.
  `startup`/`resume`/`clear` sources are unaffected - only `compact` inlines
  buffer content.

### Fixed (found during review, before merge)
- **The bounded-output claim was false for two unclamped fields**: a Bash
  record's `description` and an Edit/Write/NotebookEdit record's `file_path`
  are never length-clamped in `session-capture.sh` (only `command` and the
  other free-text fields are), so an unusually long one of either would still
  inline verbatim despite the 30-line cap. Rather than clamp every
  capture-side field (a change to `session-capture.sh`'s existing, separate
  design, out of scope here), the inline-tail block now caps each line to 300
  characters itself, via an `awk` pass - the bound this feature's own claim
  depends on is now enforced at the point the claim is made, not assumed from
  upstream.
- **A stamped `trigger`/`reason` value could break the new markdown fence**:
  `tl_clean_ctrl` (shared by `session-flush.sh`/`session-precompact.sh` to
  sanitize those fields before stamping) only stripped control characters, not
  backticks - a run of 3+ backticks in one of those fields could prematurely
  close the ``` fence this release introduces. Not reachable today (both
  fields are fixed enum strings from the harness), but cheap to close at the
  source: `tl_clean_ctrl` now strips backticks too, matching what the jq-side
  `clean` def already does for capture-side fields.

## [0.5.2]

Hot-path perf batch plus issue #15, which turned out to have a second,
un-cosmetic bug underneath it - caught by an independent code-review pass on
this release before merge. Verified by the full 143-assertion suite plus
shellcheck under both Homebrew and an `apt-get install shellcheck` Ubuntu
container.

### Changed
- **One jq invocation per capture/prompt fire, not two**: `session-capture.sh`
  and `session-prompt.sh` (the hottest hooks - every matched tool call and
  every prompt submit) each separately resolved `session_id` via
  `tl_resolve_sid` and then re-ran a full jq program to build the record line.
  Both are now produced by a single jq call (`session_id` and the line joined
  by a tab), removing the per-fire process. This matters most for
  `session-prompt.sh`, which runs synchronously ahead of prompt processing.
  The id is piped through the shared `clean` def (control-char/backtick
  stripping) before joining, so the split is unambiguous even for a
  session_id containing a literal tab; `tl_safe_sid` still runs exactly once,
  as the single sanitizer. The split-and-sanitize step itself is a new shared
  `tl_split_sid_line` helper in `_lib.sh`, not hand-duplicated between the two
  hooks (an initial version did duplicate it verbatim - flagged by review and
  factored out before merge, since that duplication is exactly the drift
  class `tl_resolve_sid` itself exists to prevent). Cold-path hooks
  (flush/precompact/onboard) are unchanged.

### Fixed
- **Issue #15**: `redact()`'s generic keyword+separator rule left an orphaned
  trailing quote on a quoted secret value (`password="X"` redacted to
  `password=***"` instead of `password=***`). No security impact on its own -
  the secret itself was always masked - purely malformed output. The
  value-capture group now distinguishes a balanced quoted value (`"..."`, both
  quotes consumed) from an unterminated one (opening quote with no matching
  close) from a bare unquoted run.
- **Multi-word unterminated-quote leak** (pre-existing, found by review while
  fixing #15 above): the unterminated-quote case's first fix stopped at the
  first whitespace, like the bare-unquoted case - so a multi-word unterminated
  secret (`password="open sesame`, no closing quote) only masked its first
  word and left the rest in cleartext (`password=*** sesame`). This gap
  predates #15 and was never specific to this release, but was caught here
  because the new comment/CHANGELOG language claimed the unterminated case was
  fully handled, and the case is now genuinely fully masked to match.

## [0.5.1]

Calmer follow-up pass on the three cleanups v0.5.0's review deferred rather
than fixing under time pressure (issue #16). No behavior change; verified by
the full 136-assertion suite plus shellcheck under both Homebrew and an
`apt-get install shellcheck` Ubuntu container (the exact CI/local mismatch
that broke v0.5.0's first push).

### Changed
- **Shared `tl_now()` helper**: the `date '+%Y-%m-%d %H:%M:%S'` format string
  was spelled out identically in 4 places (`tl_err`, `tl_append_line`,
  `session-flush.sh`, `session-precompact.sh`). Collapsed to one definition in
  `hooks/_lib.sh` so a future format change (e.g. a timezone offset) can't be
  applied to 3 of 4 sites.
- **Single-pass onboard buffer scan**: `session-onboard.sh`'s per-buffer loop
  ran 3 separate `grep` passes (total, prompt-only, session-ended) over the
  same file. Replaced with one `awk` pass computing all three counters,
  preserving the exact same silent-on-error defaulting contract (an
  unreadable file still yields "0 0 0" rather than leaking a diagnostic).
- **Parameterized `_auth_scheme`**: the command-path and prose-path Bearer/
  Basic regexes duplicated the same character classes, differing only in
  their length floor. Factored into shared `_bearer_scheme($min)` /
  `_basic_scheme($min)` defs; `_auth_scheme` and `_auth_scheme_prose` now call
  them with their existing, unchanged floors (1/8 vs 16/16). The prose path's
  Token rule and the command path's separately-positioned Token rule are
  untouched - they were never actually duplicated with each other, only the
  Bearer/Basic literals were.

## [0.5.0]

The P1 capture-fidelity batch out of the v0.4.0 audit (docs/AUDIT-v0.4.0.md,
issues #5/#6/#7). The buffer now records *why* (user intent), captures a much
wider slice of what a session actually does, and stamps compaction seams
idempotently. A fifth hook joins the set.

### Added
- **Prompt capture** (`UserPromptSubmit` -> `hooks/session-prompt.sh`, issue #5):
  each user prompt is appended to the session buffer as a redacted, 200-char
  truncated `**prompt**` line. Intent previously lived only in the compactable
  conversation - exactly what a context compaction destroys - so the buffer
  recorded what happened but never why. Shares the same redaction/cleaning
  pipeline as capture, so a pasted credential in a prompt is masked by the same
  rules. Fail-open: every failure path exits 0 (a non-zero UserPromptSubmit hook
  would abort the prompt) and breadcrumbs to `.capture-errors`.
- **Widened action capture** (issue #6): the `PostToolUse` matcher now also
  covers `Grep`, `WebFetch`, `WebSearch`, `Task`/`Agent` (subagents), and MCP
  tools (`mcp__.*`). Each high-signal read-side tool emits one redacted
  one-liner (grep pattern, fetched URL, search query, or subagent type +
  description); MCP tools are captured name-only, making zero assumptions about
  their input schema so no field can leak. `Read` and `Glob` are deliberately
  NOT matched - the noisiest tools, whose capture would swamp the buffer.
  Research-heavy sessions previously left almost no trace. SubagentStop boundary
  markers were considered and deferred (see issue #6).

### Changed
- The jq redaction/cleaning defs (`redact`/`clean`, ~15 gsub rules and their
  full comment history) moved from `session-capture.sh` into a shared
  `tl_jq_redact_defs` helper in `hooks/_lib.sh`, prepended to each capture-side
  hook's jq program so the rule set can't drift between the prompt and action
  hooks. Same consolidation reasoning as `tl_resolve_sid`; each hook stays a
  single jq invocation. The `_tl_err` breadcrumb helper was likewise promoted to
  a shared `tl_err`. This refactor is behavior-neutral - the pre-existing
  redaction suite passes unchanged, proving it.

### Fixed
- **Precompact stamp idempotency** (issue #7): `session-precompact.sh` now skips
  the boundary write when the buffer already ends with a compaction-boundary
  marker (a `tail -n 1` guard, mirroring `session-flush.sh`'s end-stamp guard),
  so a double `PreCompact` fire for one seam writes one marker - while a long
  session with several genuine compactions still stamps each one, because a
  captured action landing between them moves the marker off the last line.

### Review fixes (pre-merge, high-effort code review)
- **Prose-safe prompt redaction**: prompts run through a new `redact_prompt`
  (structural token formats + explicit `key:value`/`key=value` secrets only),
  not the command-tuned `redact` whose copula/bare-space and bearer/token WORD
  rules corrupt and can invert ordinary English ("password is not the problem"
  -> "password is ***"). The command path is unchanged. A bare-word secret with
  no prefix and no colon is deliberately left for the handoff human re-scan.
- **No nag for prompt-only sessions**: `session-prompt.sh` records a line for
  every session, so onboard's unconsumed-buffer counter now skips buffers with
  no captured ACTION line (Q&A / Read-Glob-only sessions have nothing to
  distill), preserving the warning's signal.
- **Prompt latency bound**: the prompt is clamped to 2000 chars before the
  redaction passes (then to 200 for storage), so a multi-MB paste isn't fully
  regex-scanned in the synchronous UserPromptSubmit path.
- **Task empty-description fallback**: an empty-string `description` now falls
  through to `prompt` (jq `//` only skips null), so delegated intent isn't lost.
- **Duplication removed**: shared `tl_append_line` (buffer write + breadcrumb)
  and a jq `clamp($n; $ell)` truncation def, so the write sequence and the
  redact|clean|truncate idiom are single-sourced across capture surfaces.

### Review fixes, round 2 (a second high-effort review of the round-1 fixes)
- **Onboard's prompt-only-buffer skip was a substring search**, not anchored:
  `grep -qv '\*\*prompt\*\*'` matched the literal string anywhere in a line, so
  a real action line whose OWN captured content happened to mention
  `**prompt**` (a grep for that literal pattern, a bash command referencing it
  - routine in this repo) made every line in the buffer match, and the whole
  buffer was silently misclassified as prompt-only and dropped from the
  unconsumed-buffer warning. Fixed by anchoring to the type-marker position
  (`- \`<ts>\` **TYPE** ...`) instead of searching for the substring anywhere.
- **`redact_prompt`'s keyword rule matched substrings**, not whole words: `auth`
  matched inside "author"/"authority", `token` matched inside "tokens", so
  "author: rewrite the intro" -> "author: \*\*\* the intro" - prose corruption
  in the very path introduced to prevent it. Fixed with `\b`-word-boundaries
  (replacing the `\w*...\w*` affixes carried over from the command path, which
  exist there to catch compound ENV-VAR names like `SECRET_KEY=` - a surface
  that never collides with prose).
- **`redact_prompt` dropped the Bearer/Basic scheme rules entirely**, so a
  pasted `Authorization: Bearer <jwt>` leaked the credential body into the
  buffer verbatim. Restored via a new shared `_auth_scheme` def (used by both
  `redact` and `redact_prompt`): these are shape-constrained (fixed scheme word
  + base64-alphabet body), not generic prose words, so they carry far less
  false-positive risk than the bare-`token`-word rule that's deliberately
  excluded.
- **`WebSearch` query and `Task`/`Agent` description were run through
  `redact`**, not `redact_prompt`, despite both being prose - the same
  bare-`token`-word corruption issue #5 exists to fix ("fix token refresh bug"
  -> "fix Token \*\*\* bug"). `Grep` (a regex pattern) and `WebFetch` (a URL)
  correctly stay on `redact` - neither is natural language.

### Review fixes, round 3 (each of round 2's fixes had its own bug)
- **`redact_prompt`'s new `\b` word-boundary silently stopped matching
  SCREAMING_SNAKE_CASE compounds** - the standard real-world credential-naming
  convention (`CLIENT_SECRET`, `ACCESS_TOKEN`, `DB_PASSWORD`), exactly what a
  pasted `.env` file or curl command uses. Underscore is a `\w` character, so
  `\bsecret\b` never matches "secret" inside "client_secret" - those secrets
  passed into the buffer completely unredacted. Fixed by switching to a
  LETTER-only lookaround boundary (`(?<![A-Za-z])`/`(?![A-Za-z])`): an
  underscore still counts as a valid boundary (so the compound matches) while
  an adjacent letter still doesn't (so "author"/"tokens" still don't).
- **Onboard's prompt-only-buffer filter used a grep-into-grep pipe** whose
  "found nothing" and "found nothing because there's nothing to find" are
  indistinguishable - so a buffer with ZERO conforming record lines (a
  truncated/corrupted buffer, or a capture hook whose jq failed on every call)
  silently fell through the same `|| continue` as a genuine prompt-only
  buffer, regressing the pre-existing guarantee that any existing, end-stamped
  buffer gets surfaced regardless of its body. Fixed with an explicit
  total-vs-prompt-count comparison that only skips when there's at least one
  recognized line AND every one of them is a prompt line.
- **The new shared `_auth_scheme` def (added in round 2 to close the
  Bearer/Basic leak) was unconstrained enough to corrupt ordinary prose** -
  "explain the bearer token approach" -> "explain the Bearer \*\*\* approach",
  "basic authentication support" -> "Basic \*\*\* support" (English words are a
  subset of the base64 alphabet the Basic rule allowed, and the Bearer rule had
  no length floor at all) - the exact failure mode `redact_prompt` exists to
  prevent, now reachable through the very rule meant to plug a different gap.
  Split into two variants: `_auth_scheme` (command path, unchanged - commands
  aren't prose) and a new `_auth_scheme_prose` (16+ char length floor on both
  Bearer's value and Basic's body - real tokens/JWTs run far longer than a
  single English word), used only by `redact_prompt`.

### Review fixes, round 4 - structural redesign of `redact_prompt`
A fourth review found four more bugs, two of them ([1]) in the SAME code
round 3 had just patched: the letter-lookaround boundary excluded not just the
intended false-positive cases but EVERY keyword followed by any letter, so
"secrets:"/"passwords:"/"credentials:" (common, real phrasing) silently
stopped being redacted at all - worse than what it fixed. That's three
consecutive rounds where a fix to the same keyword-boundary regex was correct
for its target case but broke a different one, the same shape as the
`redact()` boundary-character rework documented earlier in this changelog
(v0.2.0). Rather than a fourth regex patch, `redact_prompt`'s generic
keyword+separator rule was removed entirely:

- **No boundary rule can admit "secrets:"/"passwords:" (real usage) while
  excluding "author:"/"tokens:" (false positives) - the shapes overlap.**
  `redact_prompt` now masks ONLY unambiguous structural signals: known token
  prefixes (`ghp_`, `sk-`, `AKIA`, ...), PEM blocks, URL-userinfo, and
  length-gated Bearer/Token/Basic scheme values. A colon-form secret with no
  recognizable prefix/scheme ("password: hunter2", `CLIENT_SECRET: xyz`) is
  now a deliberate, documented, and CONSISTENT gap - not fixed differently
  case-by-case - backstopped solely by the handoff skill's human re-scan,
  same class as `redact`'s existing bare-CLI-flag gap.
- **`redact_prompt` had no Token-scheme rule at all** (the DRF/GitLab-style
  `Authorization: Token <value>` header), an oversight from splitting it out
  of `redact` in round 2. Added alongside Bearer/Basic in `_auth_scheme_prose`,
  same 16+ char length floor.
- **The 16-char length floor (round 3's prose-safety fix) also un-redacts
  real 8-15 char Bearer/Basic values**, leaving the credential in plaintext
  next to a `***` that falsely suggests full redaction. Accepted as the same
  deliberate gap as above, rather than tuning the threshold further.
- A pre-existing (not a regression from this PR) cosmetic quote-handling bug
  in the shared value-capture group - an orphaned trailing quote in malformed
  output, no secret leak - was identified in both `redact` and the
  since-removed `redact_prompt` generic rule. It no longer applies to
  `redact_prompt` (that rule is gone); it remains in `redact` (command path,
  unchanged, out of scope for this PR) as a low-priority follow-up.

### Review fixes, round 5 - the redesign held; two smaller bugs elsewhere
A fifth review found the round-4 redesign clean (zero findings against
`redact_prompt` itself - the three-round regex cycle is over) and surfaced two
smaller, unrelated bugs plus deferred cleanup:

- **`session-onboard.sh`'s prompt-only counters leaked a shell diagnostic to
  stderr on an unreadable buffer file.** `grep -c` prints an empty string
  (not "0") when it cannot read the file at all, and the following integer
  test was not guarded against that - the one place in this hook where an
  error path was not `2>/dev/null`'d, breaking its own always-silent contract.
  Fixed by defaulting both counts to 0 when empty.
- **The `mcp__*` fallback branch embedded the raw tool name directly inside
  the `**...**` bold-marker pair** without stripping asterisks (every other
  branch only puts field content AFTER a fixed literal marker, so this is the
  one place where arbitrary text sits inside the delimiters themselves). An
  unusual tool name containing `*` would break the markdown span and desync
  onboard's anchored classifier regex, silently miscounting a real action as
  prompt-only. Fixed by stripping asterisks from the tool name specifically
  (not folded into the shared `clean` def, which other branches rely on to
  preserve a literal `*` in content like a glob pattern).
- The Bash capture branch's hand-rolled truncation was migrated to the shared
  `clamp` def (it was the one call site the round-1 refactor had missed).
- Filed as follow-ups rather than fixed inline (issue #16): a timestamp format
  string duplicated across 4 call sites, `session-onboard.sh` running 3
  separate `grep` passes per buffer file where one would do, and
  `_auth_scheme`/`_auth_scheme_prose` duplicating the same regex literals at
  different length thresholds instead of one parameterized def. None are
  correctness bugs; deferred to a calmer pass rather than more mechanical
  edits under the same time pressure that caused rounds 2-4.

### Tests
- 44 new assertions (95 -> 136): prompt capture (line shape, prose-safety,
  structural-signal redaction, documented-gap behavior for colon-form/compound
  secrets, Bearer/Token/Basic scheme masking + prose preservation, truncation,
  empty-prompt skip, opt-out/kill-switch, no-session breadcrumb); widened
  capture (grep/webfetch/websearch/task/mcp one-liners, URL-userinfo masking,
  empty-desc task fallback, WebSearch/Task prose preservation, mcp input not
  read, asterisk-stripped tool_name); prompt-only buffers not counted as
  unconsumed, including the zero-conforming-line and unreadable-file edge
  cases; precompact idempotency (double-fire, multi-seam, post-boundary).

## [0.4.1]

P0 fixes out of the v0.4.0 audit (docs/AUDIT-v0.4.0.md). The audit's live finding
drove the headline change: this plugin's own dev machine was silently running a
stale v0.1.0 installed snapshot - none of the 0.2.0 redaction hardening or 0.3.0
auto-activation was actually live - and nothing surfaced that.

### Added
- **Version visibility**: the SessionStart block header now reads
  `## throughline vX.Y.Z - project session context`, with the version read from
  the running plugin's own `.claude-plugin/plugin.json` (best-effort; header
  stays version-less if jq or the manifest is unavailable). A stale installed
  snapshot is now visible at every session start. README gains an "Updating"
  note explaining that installed plugins do not track this repo.
- **Machine-wide kill switch**: `THROUGHLINE_DISABLE` set to anything but `0`
  turns all four hooks into complete no-ops - no capture, no SessionStart
  block (not even about existing data), no end-stamps. Checked first in
  `tl_active` (reason `disabled`) and directly by onboard/flush/precompact,
  since those don't gate on `tl_active`. Stricter than `.throughlineignore`
  by design: the per-project marker keeps orienting toward existing content;
  the global switch means off. Auto-activation in every project made this the
  missing affordance - opting out per-project doesn't scale to "not on this
  machine."

### Fixed
- **Consolidate mined the wrong portable path**: the skill said to mine
  `.agent/handoffs/` (plural) while the README's documented convention is
  `THROUGHLINE_DATA_DIR=.agent/handoff` (singular) - a one-letter mismatch
  that could make a consolidation pass silently miss a repo's actual logs.
  The skill now checks both forms, skipping whichever is already `DATA`.

### Tests
- New sections 12m (kill switch: silent onboard on fresh and on already-active
  projects, no bootstrap, no capture, no flush stamp, and `0`/unset do NOT
  disable) and 12n (version line present, read dynamically from plugin.json).
  95 assertions total.

## [0.4.0]

Capture and handoff answer "what happened this session?"; nothing answered "what
keeps happening?" A lesson could recur in session log after session log without
ever graduating to the durable layer where it stops needing to be re-learned.
This release adds the missing periodic pass (#3).

### Added
- **`throughline-consolidate` skill**: a periodic (monthly or on-demand)
  consolidation pass over the timestamped handoff session logs. Four phases:
  determine scope (logs since the last recorded pass; the pass history lives in
  a "Consolidation passes" section of `HANDOFF.md`), extract candidate lessons
  (anything recurring in 2+ sessions - workflow corrections, tool quirks,
  environment gotchas, conventions - each carrying its evidence logs and a
  recurred-N-times confidence), propose promotions (global `CLAUDE.md` rule, an
  issue filed on the owning skill's source repo - never a direct cross-repo
  edit - a durable project `CLAUDE.md`/`HANDOFF.md` section, or an auto-memory
  entry), and apply + record. The gate is **pre-write and per-item**: the full
  promotion list is presented and nothing is applied without explicit approval,
  unlike handoff's post-write review - promotions touch always-loaded files,
  where one wrong line costs every future session. Session logs are never
  pruned; they are historical records and the evidence trail for each
  promotion. Mines `DATA/logs/` plus `.agent/handoffs/` when that portable
  convention is present. Complements (does not duplicate) the anthropic
  `consolidate-memory` skill: that one owns the auto-memory files, this one
  owns the handoff logs.

## [0.3.0]

A deliberate reversal of the "silent until opted in" activation model. Through
v0.2.0, throughline only tracked a project once a data dir already existed - which
in practice meant only once a handoff had already run once. That was a
chicken-and-egg trap (capture never started until a handoff ran, but a handoff had
nothing to distill until capture had run), and it is the exact "activation gate is
a silent chicken-and-egg trap" finding raised in the original v0.1.0 review
(`docs/REVIEW-v0.1.0.md`) - never actually fixed until now.

### Changed
- **throughline now auto-activates in every project.** The first time any hook
  fires, `tl_active` creates the data dir on demand, so continuous capture works
  from the first session with no manual opt-in - whether `THROUGHLINE_DATA_DIR` is
  set or the default `.claude/throughline/` is used. This is a **behavior
  reversal, not a bug fix**: the previous "stays silent in unrelated repos until
  opted in" guarantee (previously advertised in the README) is intentionally
  removed, and this affects every consumer of the published plugin, not just one
  repo. The `SessionStart` onboard block now appears in every non-ignored project.

### Added
- **`.throughlineignore` opt-out marker.** An empty file named
  `.throughlineignore` at the project root disables new activation for that
  project unconditionally - no data dir is created, and `onboard`/`capture` stop
  adding new content - regardless of `THROUGHLINE_DATA_DIR` or any pre-existing
  data dir/`HANDOFF.md`. The opt-out is checked first in `tl_active`, so it wins
  even for a project that was previously active; existing `HANDOFF.md`/`logs/`
  are left untouched, throughline simply stops adding to the project. Documented
  under "Opting a project out" in the README.
- **A failed auto-activation is distinguishable from a deliberate opt-out.** A
  review pass found that a bootstrap `mkdir` failure (permissions, disk full)
  made `tl_active` return non-zero identically to the `.throughlineignore` path,
  so the very "no more silent chicken-and-egg trap" this release exists to fix
  had a silent failure mode of its own. `tl_active` now sets an internal reason
  the caller can inspect; `onboard` (the one hook with a visible voice) surfaces
  a distinct warning naming the data dir it could not create.
- **Nudges toward gitignoring the buffer.** Auto-activation can now be the very
  first thing that happens in a project, with no manual opt-in step to naturally
  prompt the user to set up `.gitignore` first. `onboard` checks with
  `git check-ignore` (not a hand-rolled pattern match) and warns only when the
  buffer isn't already covered. A follow-up review pass found this was nested
  only inside the "no `HANDOFF.md` yet" branch, so it permanently stopped firing
  the moment the first handoff ran, whether or not the buffer was ever actually
  gitignored - moved out to fire independently of `HANDOFF.md`'s existence.
  Skipped on `compact` re-fires so it doesn't repeat within one already-running
  session as it compacts; it still fires on every new session start until the
  buffer is actually covered.
- **`flush`/`precompact` no longer let a mid-session `.throughlineignore` corrupt
  an already-tracked session's bookkeeping.** Both used to gate on the same
  `tl_active` as `onboard`/`capture`, so if the opt-out marker appeared between a
  session's start and its end, the end-stamp (or compaction-boundary marker)
  would be silently skipped for a session that had already legitimately
  captured - permanently mislabeling a completed session as "could be live
  elsewhere" instead of "confirmed ended." Both hooks now check only for an
  existing *buffer* directory - narrower than the data dir itself, and
  deliberately not `tl_data_exists`: a data dir that was bootstrapped but never
  actually captured anything (no buffer/ ever created) has nothing to finalize
  either - with no ignore-file veto and no bootstrap, before finalizing
  bookkeeping for a session file that already exists; `capture` is unaffected
  and still stops recording new actions the moment the opt-out appears.
- **A mid-life `.throughlineignore` no longer silences orientation toward
  content that already exists.** A review pass found that adding the opt-out
  marker to a project that was *already* tracked (had a committed `HANDOFF.md`)
  made `onboard` exit silently before ever reaching the `HANDOFF.md` pointer,
  capture-errors surfacing, or unconsumed-buffer warnings - `.throughlineignore`
  is meant to mean "stop adding new content," not "stop telling me what already
  exists." Split the query from the mutation: a new `tl_data_exists` (existing
  data dir or `HANDOFF.md`, independent of the opt-out) now gates whether
  `onboard` has anything to report; `tl_active` (which does honor the opt-out,
  and bootstraps) is only consulted when there is nothing yet.
- **The gitignore nudge no longer nags forever when the data dir lives outside
  the git tree.** An absolute `THROUGHLINE_DATA_DIR` pointed at a shared,
  cross-harness location (a documented, supported configuration) made
  `git check-ignore` fail with a fatal error instead of "not ignored"; the
  negated check treated that identically to "not gitignored," so the nudge
  printed on every single `SessionStart` forever, with no way to satisfy it (a
  path outside the repo can never be matched by that repo's `.gitignore`). The
  nudge is now skipped entirely when the data dir isn't under the project root.
- **The bootstrap-failure warning no longer leaks the absolute project path.**
  Every other message in `onboard` strips to a repo-relative path before
  printing; this one interpolated the raw (absolute) path, the one place
  throughline's output surfaced local machine/username details into the
  transcript. Fixed to match the rest of the file.
- **17 new test cases** (88 total) covering auto-activation with
  `THROUGHLINE_DATA_DIR` set and unset (via onboard), auto-activation via
  `session-capture.sh` called first (proving the bootstrap lives in the shared
  `tl_active` helper, not one specific hook), the `.throughlineignore` opt-out,
  a failed bootstrap surfacing its distinct warning with a relativized path,
  the gitignore nudge firing only when needed (including after a handoff has
  already run, not repeating on a `compact` re-fire, and not firing when the
  data dir is outside the git tree), `flush`/`precompact` still finalizing an
  already-tracked session despite a mid-session `.throughlineignore`, and
  `onboard` still orienting toward existing content despite a mid-life
  `.throughlineignore`. The v0.2.0 "inactive project stays silent" test is
  rewritten to the new model.

## [0.2.0]

A robustness, privacy, and compaction-survival pass driven by a four-lens review
(see `docs/REVIEW-v0.1.0.md`), hardened by a follow-up adversarial pass against
the PR itself (general code review plus silent-failure, test-coverage, and
comment-accuracy specialists) before merge.

### Added (hardening pass)
- **Redaction now covers every captured field**, not just the Bash command:
  the Bash `description` and the Edit/Write/NotebookEdit `file_path` previously
  bypassed `redact` entirely (only control-char cleanup ran), so a credential in
  either field was stored verbatim. Both are now redacted.
- **`buffer/.capture-errors` breadcrumb**: the `mkdir`, `jq` filter, and final
  buffer-write failure paths in capture were silently swallowed with zero trace
  (a known gap called out, but not fixed, in the original v0.1.0 review). Each
  now best-effort appends a one-line breadcrumb; onboard surfaces its presence
  and count so a run of silent capture loss is no longer invisible.
- **Broader redaction coverage**: the GitHub token class now includes `ghr_`
  refresh tokens (was missing the `r` prefix); the generic keyword alternation
  now also matches `credential`, `auth`/`authorization`, and `client_id`; PEM
  private-key redaction now also catches a key body with no `-----END...-----`
  marker (a truncated or streamed key). Documented limitation, unchanged: this
  is pattern/keyword matching, not entropy analysis: a bare opaque token with
  no recognizable shape still passes through.
- **`[failed]` outcome marking scoped to verified schema**: the `exit_code` /
  `error` / `code` heuristics were only ever validated against the real Bash
  `tool_response` shape; they are now applied only when `tool_name == "Bash"`,
  so an unverified field on Edit/Write/NotebookEdit's response can't
  false-positive a `[failed]` marker onto completed work. `is_error` /
  `interrupted` are still checked for every tool type.
- **onboard's "unconsumed buffer" check distinguishes ended from unsure**: a
  buffer carrying the `session-ended` stamp is reported as a confirmed,
  undistilled, ended session; a buffer with no stamp (could be a session still
  live in another terminal, or one that exited without a clean shutdown) now
  gets hedged wording instead of being asserted as "ended" when that wasn't
  actually known.
- **Session id is derived consistently across all four hooks**: capture
  previously tab-split a combined jq output to recover the session id, which
  could desync from how flush/onboard/precompact derive it (e.g. for a
  session_id containing a tab). Capture now resolves the session id via its own
  dedicated jq call, identical to the other hooks.
- **`.capture-errors` lives at the data-dir root, not under `buffer/`**: a
  second review pass found that the breadcrumb's own write target depended on
  `buffer/` already existing, so the one failure mode it most needs to report
  (the `mkdir -p` that creates `buffer/` failing) silently defeated the
  breadcrumb along with it. `tl_active` already guarantees the data dir itself
  exists before any hook proceeds, so the breadcrumb now targets that instead.
  README's gitignore guidance updated to match.
- **`[failed]` no longer false-positives on a benign empty-string `error`**: a
  third review pass found that jq's `//` operator only treats `null`/`false` as
  "absent": a Bash `tool_response` with `exit_code:0` and `error:""` (a
  genuinely successful run) was matched by `(.error? // null) != null` and
  permanently mismarked `[failed]`, exactly the false-positive the prior fix's
  Bash-only scoping was meant to rule out. Now checked as `(.error? // "") !=
  ""`, so only a non-empty error string counts.
- **Control-char stripping shared via a real helper, not just a comment**:
  `session-flush.sh` and `session-precompact.sh` now call a new `tl_clean_ctrl`
  in `_lib.sh` instead of duplicating the same inline jq `gsub`, removing two of
  the three places that rule had to be kept in sync by hand. `session-capture.sh`
  keeps its own inline version (it applies control-char and backtick stripping
  together, per-field, inside the same jq pass that also redacts).
- **Compound credential variable names are now redacted**: a fourth review
  pass found that the generic keyword=value rule only matched when the keyword
  was immediately followed by `:`/`=`/whitespace, so `SECRET_KEY=`,
  `API_KEY_VALUE=`, and similar compound names fell through completely
  unredacted (the keyword group had `\w*` before it but not after). Fixed by
  adding a trailing `\w*` to the keyword group.
- **The same rule no longer deletes trailing URL content past a credential**:
  its value-capture group was unbounded except for whitespace/quotes, so when
  a "token"/"secret" substring appeared inside a URL username (e.g.
  `x-access-token` in a clone URL), the rule re-matched text the
  URL-userinfo rule upstream had already safely redacted and then greedily
  consumed everything through `@` and the rest of the path, replacing the
  whole tail with `***` instead of just the credential. The value group now
  also stops at `@`/`/`.
- **`tl_safe_sid`'s lossy-collapse tradeoff is now documented**: two session
  ids differing only in disallowed punctuation sanitize to the same filename.
  Noted as currently unreachable (Claude Code session_ids are UUIDs, already
  all-allowed characters) rather than restructured, since a collision-resistant
  encoding would cost the human-readable filenames for no live attack path.
- **Fixed an over-correction from the previous fix**: bounding the
  keyword=value value-capture at `/` (to stop it re-consuming a URL path past
  an already-redacted credential) also truncated genuine slash-containing
  secrets (e.g. a realistic AWS-shaped key) after their first `/`, leaving most
  of the value exposed. The URL case only ever needed the boundary at `@` -
  the URL-userinfo rule upstream always leaves `***@` right before the
  host/path, so excluding only `@` (not `/`) fixes both cases at once.
- **`sk-` key redaction now covers dashed multi-segment formats** (Anthropic's
  `sk-ant-api03-...`, OpenAI's `sk-proj-...`): the body character class was
  alnum-only, so the first internal dash in these current real-world key
  formats stopped the match entirely and the whole key passed through
  unredacted.
- **Dropped no-session-id actions now breadcrumb too**, for the same
  visibility reason as the mkdir/jq/write failures - currently unreachable
  (Claude Code always supplies a UUID session_id) but no longer untraceable if
  that assumption ever breaks.
- **Handoff skill's re-scan checklist now names two shapes capture's own
  redaction cannot catch mechanically**: a credential attached to a bare CLI
  flag with no keyword (`mysql -p<password>`, `curl -u user:pass` - flags like
  `-u`/`-p` are too overloaded across tools, e.g. `docker run -u uid:gid`, to
  redact generically without false positives), and the fact that seeing a
  `***` in a captured line doesn't guarantee the *whole* secret was masked.
- **The generic rule now masks the real secret, not an intervening word**: a
  seventh review pass found two more ways the actual credential could survive
  in plaintext. First, natural-language phrasing like `password is X` masked
  the linking word `is` instead of `X` (the separator group only recognized
  `:`/`=`/bare whitespace) - now also accepts `is`/`was`/`are`. Second,
  `Authorization: Token <key>` (a common DRF/GitLab auth-header style) masked
  the scheme word `Token` itself, leaving the real key exposed right after it
  - now has its own dedicated rule alongside the existing Bearer/Basic ones.
- **Fixed another `@`-boundary over-correction**: the value-capture group
  excluded `@` outright to stop the URL-userinfo edge case, which also
  under-redacted a literal secret that happens to contain `@` (a common shape
  for human-chosen passwords). It now only treats `@` as a boundary when it
  immediately follows an already-redacted `***` (the exact mark the
  URL-userinfo rule leaves), so a genuine `@`-containing secret with no
  preceding `***` still falls through to the fully-masked general case.
- **`[failed]` no longer mis-fires on a string-valued `exit_code`**: jq's `!=`
  never considers a string equal to a number, so `exit_code: "0"` (e.g. from a
  wrapper that JSON-stringifies fields) compared unequal to `0` and falsely
  marked a successful command failed. Both sides are now normalized through
  `tostring` before comparing.
- **24 additional test cases** (68 total) covering the above, plus
  previously-uncovered branches: the `tl_active` silent-exit/opt-in-silence
  path, Write/NotebookEdit capture (only Edit was tested), `tl_safe_sid`'s
  `.`/`..` rejection, `THROUGHLINE_DATA_DIR`'s absolute-path branch, command
  truncation, and the breadcrumb surviving a `buffer/`-creation failure.
- **Structural rework of the URL/generic-rule hand-off, replacing the
  boundary-character guessing game**: across rounds five through seven, the
  generic keyword=value rule's relationship to the URL-userinfo rule was
  patched three times by inferring "already redacted" from a boundary
  character right after the `***` mark - first `@`+`/`, reverted to just `@`,
  each version either deleting real trailing URL content or under-redacting a
  genuine secret that happened to contain that same character. The
  URL-userinfo rule now marks its own output with an internal sentinel
  (`TLREDACTSENTINEL`, never written to the buffer) instead of the literal
  `***`; the generic rule recognizes that sentinel explicitly instead of
  inferring it from context, and a final pass converts any sentinel - whether
  the generic rule touched it or not - to the user-facing `***`. The value
  group is now fully unbounded except whitespace/quote in every other case, so
  this removes the `@`-vs-`/` tradeoff entirely rather than picking a side.
- **3 additional test cases** (71 total): a URL credential with no nearby
  keyword at all (proving the final sentinel-to-`***` pass works
  independently of the generic rule), plus a check that the internal sentinel
  itself never leaks into the buffer.
- **Session-id resolution deduplicated into `tl_resolve_sid`**: an eighth
  review pass flagged that `capture`/`flush`/`onboard`/`precompact` each
  hand-duplicated the same "extract `session_id`, then `tl_safe_sid` it" two
  lines - exactly the kind of duplication that already caused a real desync
  bug once (capture deriving it differently than the other three, fixed
  earlier in this same series). All four now call one shared `_lib.sh`
  helper. The similarly-flagged duplication between `flush`/`precompact`'s
  marker-stamping boilerplate was left alone: the two differ in a real way
  (flush stamps once via a guard, precompact intentionally stamps on every
  compaction), so a shared helper would need a mode parameter rather than
  removing genuine duplication.

### Added
- **PreCompact hook** (`session-precompact.sh`): stamps a `compaction-boundary`
  marker into the live buffer just before a context compaction, so a later
  handoff knows the seam and distills above-the-line actions from the buffer
  text rather than from lost conversation recall.
- **Compaction recovery in onboard**: on `source=compact`, onboard now reads the
  session id and points Claude back at the surviving on-disk buffer for the
  current session.
- **Missing-jq warning**: when `jq` is absent, capture is impossible; onboard now
  says so loudly instead of letting capture no-op in silence.
- **Tool outcome capture**: interrupted actions are marked `[interrupted]` in
  the buffer (from `tool_response.interrupted`); explicit error flags / non-zero
  exit codes are marked `[failed]` where a tool surfaces them. Note: the Claude
  Code Bash result exposes no exit code, so a plain non-zero command exit is not
  markable from a hook and is left for the handoff to cross-reference against the
  conversation. (Found during review: the original synthetic test asserted an
  `is_error` field that the real payload does not have.)
- **Capture-time secret redaction**: common credential shapes (KEY=VALUE tokens,
  `Bearer` tokens, URL userinfo passwords, `ghp_`/`github_pat_`/`xox`/`sk-`/`AKIA`,
  Google `AIza` keys, `Basic` auth payloads, and inline PEM private-key blocks) are
  masked before anything is written to the buffer. Defense in depth alongside the
  handoff skill's "key names only" rule.
- **Test harness** (`tests/run.sh`) and **CI** (`.github/workflows/ci.yml`):
  shellcheck plus fixture-driven hook tests on every push and PR.

### Changed
- **session_id is sanitized** to a safe, flat filename in capture and flush
  (no path traversal, no stray subdirectories).
- **Edit/Write paths are relativized** to the project root before capture, so
  committed logs no longer leak absolute paths or the OS username.
- **Captured commands are sanitized**: control characters and backticks are
  neutralized so a command can never break the buffer's markdown.
- **Long commands** are marked `…[truncated]` instead of being silently cut.
- **onboard "unconsumed buffer" warning** no longer counts the current session
  (which previously made a mid-session compaction look like "a prior session
  ended without a handoff"); wording clarified.
- **flush end-stamp guard** is anchored to the start of a line, so captured text
  containing the marker cannot suppress a real stamp.
- README "compaction-proof" wording qualified: the raw action buffer survives
  compaction; the reasoning behind it survives only if a handoff ran first.

### Fixed
- **Missing session_id no longer poisons** a shared `session-nosession.md` that
  flush never stamped and onboard re-warned about forever. Such records are now
  dropped.
- onboard root-prefix stripping uses POSIX parameter expansion instead of `sed`,
  fixing breakage when the project path contains regex-special characters.

## [0.1.0]

- Initial release: continuous PostToolUse capture, judged handoff skill,
  SessionStart orientation, SessionEnd safety-net flush, onboard skill.
