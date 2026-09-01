# homelab-linkcheck

A small nightly link checker for a personal site. `scripts/check-links.sh` reads
`urls.txt`, hits each one, and appends a result line to `logs/link-check.log`. Run
from cron at 2:30am.

This is throughline's demo project: a fictional repo with a real, populated
`.claude/throughline/` already in it, so you can see the artifacts before
generating your own. See [`../README.md`](../README.md) for how to run it.

**One deliberate quirk.** throughline is local-only by default and normally
gitignores the whole data dir - this demo tracks its `HANDOFF.md`, a session
log, and one live capture buffer instead, because those artifacts *are* the
example. That's why a session here prints a "not gitignored yet" warning on
`buffer/` - correct behavior, aimed at a real project, not a bug in the demo.
