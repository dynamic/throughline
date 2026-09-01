# Install

Per-harness requirements, what each install gives you, the Codex trust step, and how
to update or point at a local checkout. The [README](../README.md) has the one-liner
commands and the capability comparison table; this is the detail behind them.

## Claude Code

```
/plugin marketplace add dynamic/throughline   # register this repo as a marketplace
/plugin install throughline@throughline        # install plugin@marketplace (same name)
```

Then reload (`/reload-plugins`) or restart the session.

**Requirements:** `git` and `jq` on your `PATH`. `jq` parses the hook payloads; if it
is missing, capture cannot run and the SessionStart block says so rather than failing
silently.

**What you get:** the 4 skills (`handoff`, `onboard`, `consolidate`,
`consolidate-memory`) plus all 5 hooks. The only harness with a native durable
memory system of its own (`/memory`, backed by `MEMORY.md`) - the session-start
injection above complements that auto-load with project-level state, and the
`handoff`/`consolidate-memory` skills promote genuinely durable facts into it.
Codex and OpenCode have no equivalent system to bind into today.

**Updating.** Installed plugins are snapshots - they do not track this repo. An old
copy keeps running (without newer redaction and activation fixes) until you update it
from the `/plugin` manager (or uninstall and reinstall), then `/reload-plugins`. The
SessionStart block prints the running version (`## throughline vX.Y.Z`) - if it lags
this repo's releases, your install is stale.

## Codex CLI

```sh
codex plugin marketplace add dynamic/throughline
codex plugin add throughline@throughline
```

**Requirements:** `git` and `jq` on your `PATH`, same as Claude Code - Codex runs
the identical hook scripts. Without `jq`, capture cannot run. Works in Codex CLI and
Codex Desktop.

**What you get:** the 4 skills plus all 5 hooks, reading and writing the same
`.claude/throughline/` data format Claude Code and OpenCode use - so a project's
history is readable and continuable from any of the three.

**The one-time trust step.** Codex gates hook execution behind a one-time trust
decision per machine (Claude Code has no equivalent gate - a plugin's hooks just run
once installed). What that looks like the first time you use a project with
throughline installed:

- **Codex CLI** shows a native **"Hooks need review"** dialog before your first
  message: "5 hooks are new or changed. Hooks can run outside the sandbox after you
  trust them." Choose **"Trust all and continue."** That's the whole step - trust is
  granted by content hash, not by project path, so it covers every project at once.
  A throughline update that changes the hook scripts triggers the dialog again.
- **Codex Desktop** grants trust silently, with no dialog - capture just starts
  working on your first message.

Verify anytime with the in-TUI **`/hooks`** command: it lists every Codex hook event
with an Installed/Active count, and pressing Enter on a row shows that hook's
`Source`, `Command`, `Mode`, `Timeout`, and `Trust` status. A trusted throughline
hook reads `Source: Plugin - throughline@throughline`, `Trust: Trusted`.

**Updating.** Same story as Claude Code: an installed plugin is a snapshot, not a
live checkout. Update from `codex plugin add throughline@throughline` again (or the
Codex plugin manager) to pick up the latest release - a throughline update also
changes the hook scripts' content hash, so the trust dialog reappears once on Codex
CLI.

## OpenCode

throughline is also available as an OpenCode plugin, providing the same session
capture functionality within the OpenCode ecosystem.

```json
{
  "plugin": ["@dynamicagency/throughline-opencode"]
}
```

OpenCode's plugin config key is `plugin` (singular) in `opencode.json`, and each
entry is either an npm package name or a local path - there is no separate
`plugins/` directory to copy into. Add the line above and restart OpenCode; it
installs the package automatically via Bun at startup. Check
`~/.local/share/opencode/log/opencode.log` for a load error if session capture
doesn't appear to be running.

**Requirements:** Node.js 18+ (no `jq` required - TypeScript uses native JSON
parsing).

**What you get:** all 5 hooks, ported to TypeScript against OpenCode's own plugin
API - continuous prompt/action capture with redaction, session-start context
injection (HANDOFF.md pointer + live git state), and compaction survival (a boundary
marker plus buffer-tail re-injection right after). One behavioral difference worth
knowing: OpenCode's `session.idle` event fires after every turn, not once at process
exit the way Claude Code's `SessionEnd` does, so the buffer's end-marker is a "last
known idle point" that gets re-stamped each time the session goes idle, rather than
a one-shot end-of-session stamp - `onboard` reads it the same way either way (has
this buffer seen activity since the marker). This plugin ships **hooks only,
no skills** - OpenCode's own plugin API has no supported way to ship a skill
directory alongside a plugin today. Run `npx skills add dynamic/throughline`
separately for `handoff`/`onboard`/`consolidate`/`consolidate-memory`. In practice
this is often a non-issue: OpenCode discovers `SKILL.md` files from several
locations it shares with Claude Code and Codex (project-local and global
`.claude/skills/`, `.agents/skills/`, and its own `.opencode/skills/` /
`~/.config/opencode/skills/`), so skills installed for another harness on the same
machine are frequently already visible to OpenCode with no extra step.

By default the OpenCode plugin uses the same `.claude/throughline/` data directory
as Claude Code and Codex, so a project's history stays continuous across harnesses.

**Updating.** An installed plugin is a versioned snapshot, same as Claude Code and
Codex - bumping the version in `opencode.json` (or letting Bun resolve a new
range) is what picks up a release, not a `git pull`. The running version is
printed in the injected session-start block (`## throughline vX.Y.Z`) the same way
it is on Claude Code and Codex - if it lags this repo's releases, your install is
stale.

Publishing to npm is tag-triggered: pushing a `vX.Y.Z` tag runs a GitHub Actions
workflow that publishes `@dynamicagency/throughline-opencode` via npm Trusted
Publishing (OIDC), with no long-lived npm token and an automatic provenance
attestation on the published package.

**Local-path install (testing unreleased changes).** Point `opencode.json` at a
checkout of this repo instead of the package name:

```json
{
  "plugin": ["/absolute/path/to/throughline/.opencode-plugin"]
}
```

The package's `main` field points at compiled `dist/`, which is gitignored, so a
local-path install needs a build first: `cd .opencode-plugin && npm ci && npm run
build`. Unlike the npm install, this stays a live checkout - `git pull` and
rebuild to update it.

## npx skills

```sh
npx skills add dynamic/throughline
```

Installs the 4 skills directly - no plugin system, no marketplace registration. This
is the fallback for any harness that reads `SKILL.md` files from disk but has no
plugin system of its own. **What you get:** the 4 skills, nothing else - no
automatic capture (there's no hook mechanism in this delivery form at all); run
`handoff` manually at the end of a session.
