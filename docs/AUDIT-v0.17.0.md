# throughline v0.17.0 - Audit

**Date:** 2026-10-24. **Scope:** open issues, the four skills, the hook layer, packaging
for all five harnesses, harness logs reconciled against the implementation, measured
skill usage from local session transcripts, and a scan of similar projects. Findings
are tracked as epics #166-#172; sequencing is in [ROADMAP.md](ROADMAP.md).

Measurements come from one maintainer machine (macOS) running Claude Code, Codex CLI,
OpenCode and OMP; Hermes runs on a separate host and was not inspected. Project names
are omitted.

## What works

- **Capture never blocks and never errors loudly.** No throughline hook error,
  timeout or non-zero exit appeared in any harness log (Claude Code transcripts,
  Codex's `logs_2.sqlite`, OpenCode's log, OMP's logs).
- **Three of four adapters share one engine.** Claude Code and Codex run
  `hooks/*.sh` directly; OMP (`hooks/post/throughline.ts`) and Hermes
  (`hooks/post/hermes.py`) shell out to the same scripts. Redaction parity holds by
  construction for those four.
- **handoff is used and mostly does its job.** 391 runs, median 3.5 minutes, 10 tool
  calls and 10.4k output tokens per run; the session log was written in 94% of runs
  and the buffer archived in 87%.
- **HANDOFF.md size discipline holds.** Across 53 HANDOFF.md files in main
  checkouts, none exceeds 150 lines; 10 exceed the 8 KB target and one exceeds 11 KB.
- **Version agreement is enforced.** All six manifests read 0.17.0 and CI fails on
  drift.
- **Missed wrap-ups are rare.** 4 of 497 substantive sessions ended on a farewell
  with no handoff (0.8%).

## Findings

### Redaction

1. **Rules consume text later rules need, on plain ASCII.** `redact` runs its rules
   in sequence over already-rewritten text. The bare `token <word>` rule masks the
   word after `token`, so the generic keyword rule never sees `password`:

   ```
   echo token password: hunter2   ->   echo Token *** hunter2
   echo TOKEN password hunter2 ok ->   echo Token *** hunter2 ok
   ```

   #116 (non-ASCII prefix), #121 (SendGrid and MySQL anchors) and #123's blocking
   case are instances of the same defect. Fix: #173.
2. **Parity work dominates.** Seven PRs (#113, #116, #121, #122, #131, #140, #143)
   went to keeping the OpenCode TS port in step with the jq engine. The port is the
   only reimplementation left. Fix: epic #167.
3. **#121's direction needs re-measuring.** A local probe saw the jq engine leak on
   inputs related to #121's rows, the opposite direction to the issue's claim. The
   sweep in #174 settles it.

### Install and version drift

| Harness | Installed on the audited machine | Repo |
|---|---|---|
| Claude Code | 0.16.0 (plugin cache and marketplace clone) | 0.17.0 |
| Codex | 0.15.0 (plugin cache; trust hashes pinned to it) | 0.17.0 |
| OpenCode | 0.14.0 (npm cache; config unpinned) | 0.17.0 |
| OMP | link runs 0.17.0; install records say 0.16.0 | 0.17.0 |

- 455 of 794 Claude Code SessionStart injections in a 30-day window carried a v0.11
  or v0.12 banner, with no such version in the plugin cache. Source unknown: #183.
- OMP injects the banner in 132 of 142 sessions with no entry in its
  `installed_plugins.json`; a second load path through the Claude plugin cache is
  possible: #184.
- `docs/INSTALL.md` still names the pre-0.17 OMP package in its uninstall command:
  #182.

Nothing reports any of this to the operator today. Fix: #181.

### Capture fidelity and data hygiene

- **Duplicates:** 690 adjacent identical records across 131 buffers (TaskUpdate 239,
  Edit 115, bash 78, TaskCreate 26); none in OpenCode buffers. #187.
- **Compaction with no buffer:** 35 of 40 compacted Claude Code sessions had no
  buffer at their cwd, so `session-precompact.sh` exited at its
  `[ -f "$buf" ] || exit 0` guard. All 49 boundary stamps on disk say `auto`. #188.
- **Test pollution:** 300 unstamped buffers in one internal project share one mtime
  and carry transcript paths under a `scratchpad-hooktest` directory. A hook test
  wrote into a real project. #189.
- **Repeat handoffs:** 65 sessions ran handoff two or more times, the trigger for
  #79's archive overwrite. Archives on disk carry hand-added `-2`/`-cont` suffixes
  from manual workarounds. #185, #186.
- **Worktree copies:** three HANDOFF.md files live inside `.claude/worktrees/*`
  (42 KB, 49 KB, 82 KB), against the shared-data-dir design. #190.
- **Growth:** 14 archived buffers exceed 200 KB, the largest 833 KB. No retention
  cap exists (epic #169, Later).
- **OpenCode end-stamps:** `idle` fires every turn; three OpenCode buffers have
  records after their first stamp. #180.

Buffer census: 59 projects, 432 live and 1,907 archived buffers. A pattern scan for
common credential shapes found no unmasked secret in any buffer.

### Skills

Measured from Claude Code transcripts (all-time; the last 60 days in brackets):

| Skill | Runs | Triggered by | Active minutes, median / p90 | Tool calls, median | Output tokens, median |
|---|---|---|---|---|---|
| handoff | 391 [361] | slash command 189, model 202 | 3.5 / 34 | 10 | 10.4k |
| onboard | 50 [40] | slash command 40, model 10 | 12.9 / 124 | 37 | 18.5k |
| consolidate | 0 | - | - | - | - |
| consolidate-memory | 4 | - | 6.8 (n=1) | 10 | 13.1k |

Codex and OMP show a handful of runs each; OpenCode none (plugins there cannot ship
skills).

- **consolidate never runs.** Its only trigger is a request or "roughly monthly".
  This repo's own HANDOFF.md has called a pass overdue since August. #192, after
  #136 separates its pass marker from consolidate-memory's.
- **The unconsumed-buffer warning is noise.** It appears in 571 of 667 sessions with
  a data dir (86%) and is followed up in 56%. #191.
- **handoff's commit step assumes a repo.** 15 `fatal: not a git repository` errors.
  #193.
- **Memory routing is Claude-only.** handoff, consolidate and consolidate-memory
  write to `~/.claude/projects/<slug>/memory/` with no branch for the other four
  harnesses. #194.
- **Nothing tests the skills.** No test reads a SKILL.md. consolidate-memory's is
  29 KB (about 7k tokens), handoff's 19 KB. #195; slimming is epic #170, Later.
- **onboard often keeps going.** Median 37 tool calls per window; several runs move
  into planning and execution before the next human turn (epic #170, Later).
- Compliance sample (9 handoff runs): buffer read and session log written in all 9;
  the HANDOFF.md budget check in about half; an explicit secret re-scan in 2.

### Harness integration

| Harness | Delivery | Events | Skills | Tests | Live test |
|---|---|---|---|---|---|
| Claude Code | `.claude-plugin/`, `hooks/hooks.json` | 5 | 4 | `tests/run.sh` (fixtures through real scripts) | none |
| Codex | `.codex-plugin/`, same `hooks/hooks.json` | 5 | 4 | `tests/codex-plugin.sh` (manifest only) | none |
| OpenCode | `.opencode-plugin/` TS port, npm | 5 mapped | 0 | redaction and integration tests, no runtime | none |
| OMP | root `package.json` `omp` field, `hooks/post/throughline.ts` | 6 | 4 | `.omp-plugin/throughline.test.ts` (real scripts, no runtime) | none |
| Hermes | `plugin.yaml`, `hooks/post/hermes.py` | 6 | 4 | `tests/hermes/test_bridge.py` | none |

- No harness is exercised end to end by its real runtime. Past live checks were
  manual, and one hid #87 (OMP's manifest gate) by testing through `--plugin-dir`
  instead of the user install path. Epic #171.
- Whether Codex's tool names match the `Bash|Edit|Write|...` PostToolUse matcher is
  unverified. #199.

### Repo hygiene

- `ci.yml` and `.local-ci.json` each carry their own manifest, version and
  typography logic; `.local-ci.json` lacks the shellcheck step. #205-#207.
- `THROUGHLINE_HERMES_SURFACES` is missing from REFERENCE.md's configuration table.
  #208.
- CHANGELOG.md is 103 KB (epic #172, Later).

## Open issues at audit time

| Issue | Status after the audit |
|---|---|
| #12 | Rewritten as the parked list; two items graduated |
| #58 | Retitled; the collapse no longer waits on upstream (epic #167) |
| #68 | Under epic #172 (demo GIF still needs a recording) |
| #79 | Unblocked, split into #185 and #186 |
| #84, #136, #163 | Under epic #170 |
| #91 | Split into #176 and #177 under epic #166 |
| #116, #121 | Under epic #166; fixed by #173 and #174 |
| #149 | Open until a run on the build host confirms the OMP check |
| #93, #95, #117, #123, #132, #137, #142, #144, #146, #148 | Advisory reviews of merged or closed PRs; folded into children and closed |

## Similar projects

| Project | Idea | Applies to |
|---|---|---|
| [catchup](https://github.com/wilbeibi/catchup) | Read the harness's own transcript when capture missed something; flag gaps explicitly | #188 (compactions with no buffer) |
| [claude-mem](https://github.com/thedotmack/claude-mem) | `<private>` tags excluded from storage; progressive-disclosure search | Epic #166 Later; #12 (parked) |
| [agentmemory](https://github.com/rohitg00/agentmemory) | Token budget on session-start injection; export only when the target file is absent | #191; never overwriting hand-edited files |
| [ai-memory](https://github.com/akitaonrails/ai-memory) | Detect sessions that ended without a handoff; claim-once handoffs; markdown as source of truth with a rebuildable index | #191; #12 (parked search) |
| [agentprotocol conformance](https://pkg.go.dev/github.com/belt-sh/harness-test) (formerly harness-test) | One conformance suite across many agent CLIs, nightly, with committed expected output | Epic #171 |
| [cc-plugin-eval](https://github.com/sjnims/cc-plugin-eval), `claude plugin eval` | Assert that skills and hooks activate when expected | #198 |
| [adrrr/persistent-handoff](https://github.com/adrrr/persistent-handoff) | Demo recorded from a checked-in VHS tape that waits on a "skill fired" marker | #68 |
