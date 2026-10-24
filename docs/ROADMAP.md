# throughline roadmap

**As of v0.17.0 (2026-10-24).** Evidence behind each item:
[AUDIT-v0.17.0.md](AUDIT-v0.17.0.md). Each epic below is a GitHub issue with its
children attached as sub-issues.

## Where it is going

- **One capture engine.** `hooks/*.sh` (POSIX sh + jq) is the only implementation
  of capture and redaction. Each harness gets a thin adapter that maps its events
  onto the shared scripts.
- **Every harness tested live.** A scheduled job runs the real harness, installed
  the way users install it. REFERENCE.md shows the last green run per harness.
- **Measured redaction.** A generated sweep fails CI if any seeded secret survives
  in any engine.
- **Observable installs.** One command shows which version each harness on the
  machine is running.
- **Skills fire at the right moments.** Warnings appear only when acting on them
  pays off.

## Epics

| Epic | Theme | Phase |
|---|---|---|
| [#166](https://github.com/dynamic/throughline/issues/166) | Redaction correctness | Now |
| [#167](https://github.com/dynamic/throughline/issues/167) | One capture engine: collapse the OpenCode port | Next |
| [#168](https://github.com/dynamic/throughline/issues/168) | Install and version observability | Now |
| [#169](https://github.com/dynamic/throughline/issues/169) | Capture fidelity and data hygiene | Now / Next |
| [#170](https://github.com/dynamic/throughline/issues/170) | Skill effectiveness | Next |
| [#171](https://github.com/dynamic/throughline/issues/171) | Live harness testing for every plugin | Next |
| [#172](https://github.com/dynamic/throughline/issues/172) | Docs, release and repo hygiene | Now / Later |

## Now (v0.18)

Security fixes, operator visibility, and the guards later work depends on.

- **Redaction:** #173 computes masks on the original text, so rule order no longer
  matters. #174 adds the generated sweep. Then #175 (GitLab prefixes) and #121
  (re-measured with the sweep).
- **Archive safety:** #185, then #186 (#79). A repeat handoff no longer overwrites
  the archived buffer.
- **Test isolation:** #189. Hook tests may not write outside their temp root. This
  lands before any live harness test.
- **Install visibility:** #181 (`--doctor` per-harness versions) and #182
  (INSTALL.md update commands).
- **Shared checks:** #205, #206, then #207. CI and local-ci call the same scripts.
- **Investigations:** #183, #184, #187, #188 and #190. Each ends in a finding, and
  a fix issue where one is needed.

## Next (v0.19)

- **Harness testing:** #196 (runner and nightly workflow) and #197 (recorded
  payloads replayed per PR), then the legs: Claude Code #198, Codex #199,
  OpenCode #200, OMP #201, Hermes #202. After those come the install-channel smoke
  test #203 and the compatibility matrix #204.
- **One engine:** spike #178, then #179. #180 handles OpenCode idle stamps. #58
  tracks upstream.
- **Skills:**
  - #191: unconsumed-buffer warning.
  - #136, then #192: consolidate gets its own pass marker and a data-driven
    trigger.
  - #193: handoff skips the commit step outside a repo.
  - #194: memory routing per harness.
  - #195: SKILL.md lint.
- **Re-scan reporting:** #176, then #177 (#91).

## Later

- `<private>` tag exclusion (epic #166).
- Retention cap and `--prune` dry-run, and a Hermes path exclusion (epic #169).
- Slim consolidate-memory via progressive disclosure. Then #163 (opt-in
  reflection), #84 (cross-repo dependency check), an onboard orientation budget,
  and structured frontmatter on session logs (epic #170).
- Release check script and a CHANGELOG entry-length guideline (epic #172).
- Demo GIF (#68).

## Parked

These are tracked in #12. Each adds runtime weight that the zero-infrastructure
design avoids:
- full-text search index
- AI compression of buffers
- a Stop hook that blocks exit until a handoff exists

## Working the epics

- **Scope:** each child names two files or fewer and states a machine-checkable
  "done when", so the autobuild loop can take it.
- **Human-run work:** live harness runs, investigations and anything wider carry
  `no-autobuild`. Wide items are split before that label comes off.
- **Order:** a child that names a "Blocked by" issue starts after that issue
  closes.
