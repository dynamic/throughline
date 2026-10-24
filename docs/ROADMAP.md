# throughline roadmap

Planned work after v0.17.0. Each epic is a GitHub issue with its children attached as
sub-issues; the issues are the source of truth for scope and order. The audit behind
this plan is [AUDIT-v0.17.0.md](AUDIT-v0.17.0.md).

## Where it is going

- **One capture engine.** `hooks/*.sh` (POSIX sh + jq) is the only implementation
  of capture and redaction. Each harness gets a thin adapter that maps its events
  onto the shared scripts.
- **Every harness tested live.** A scheduled job runs the real harness, installed
  the way users install it, and REFERENCE.md shows the last green run per harness.
- **Measured redaction.** A generated sweep fails CI if any seeded secret survives
  in any engine.
- **Observable installs.** One command shows which version each harness on the
  machine is running.
- **Skills that fire at the right moments.** Warnings appear only when acting on
  them pays off.

## Epics

| Epic | Theme |
|---|---|
| [#166](https://github.com/dynamic/throughline/issues/166) | Redaction correctness |
| [#167](https://github.com/dynamic/throughline/issues/167) | One capture engine: collapse the OpenCode port |
| [#168](https://github.com/dynamic/throughline/issues/168) | Install and version observability |
| [#169](https://github.com/dynamic/throughline/issues/169) | Capture fidelity and data hygiene |
| [#170](https://github.com/dynamic/throughline/issues/170) | Skill effectiveness |
| [#171](https://github.com/dynamic/throughline/issues/171) | Live harness testing for every plugin |
| [#172](https://github.com/dynamic/throughline/issues/172) | Docs, release and repo hygiene |

## Now

Security fixes, operator visibility, and the guards later work depends on.

- **Redaction.**
  - Goal: rule order stops mattering. #173 computes masks on the original text,
    which also fixes #116.
  - #174 adds the generated sweep, and #121 is re-measured with it.
  - #175 covers GitLab prefixes.
- **Archive safety.** Goal: a repeat handoff never overwrites an archived buffer.
  #185, then #186 (#79).
- **Test isolation.** #189: hook tests may not write outside their temp root. The
  live harness runner (#196) is blocked on it.
- **Install visibility.** #181 adds per-harness versions to `--doctor`; #182 covers
  update commands in INSTALL.md.
- **Shared checks.** #205 and #206, then #207. Goal: CI and local-ci call the same
  scripts. #208 fixes two doc gaps.
- **Investigations.** #183, #184, #187, #188, #190, and #216 (what Hermes should
  capture on a gateway host). Each ends in a finding, and a fix issue where one is
  needed.

## Next

- **Harness testing.**
  - #196 (runner and nightly workflow) and #197 (recorded payloads replayed per PR).
  - Legs: Claude Code #198, Codex #199, OpenCode #200, OMP #201, Hermes #202.
  - #203 is the install-channel smoke test.
  - #204 is the compatibility matrix, started once the Claude Code, Codex and
    OpenCode legs exist.
- **One engine.** Spike #178, then #179; #180 handles OpenCode idle stamps. #58
  tracks upstream.
- **Skills.**
  - #191: unconsumed-buffer warning.
  - #136, then #192: consolidate's own pass marker and a log-count trigger.
  - #193: handoff skips the commit step outside a repo.
  - #194: memory routing per harness.
  - #195: SKILL.md lint.
- **Re-scan reporting.** #176, then #177 (#91).

## Later

Each epic's body lists its Later items, filed when that phase starts. The bigger
ones:
- `<private>` tags (#166);
- retention and pruning (#169);
- a slimmer consolidate-memory, opt-in reflection (#163) and a cross-repo
  dependency check (#84), all under #170;
- the demo GIF (#68).

## Parked

These are tracked in #12. Each adds runtime weight that the zero-infrastructure
design avoids:
- a full-text search index;
- AI compression of buffers;
- a Stop hook that blocks exit until a handoff exists.

## Working the epics

- **Autobuild scope.** Children meant for the maintainer's automated issue-to-PR
  loop name two files or fewer and a checkable "done when".
- **Human-run work.** Live harness runs, investigations and wider items carry
  `no-autobuild`. Wide items are split before that label comes off.
- **Order.** A child with a "Blocked by" line starts after that issue closes.
