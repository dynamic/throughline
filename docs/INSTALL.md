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
Codex, OpenCode, and OMP have no throughline binding into their own memory system
today (OMP has its own native memory tools, but throughline doesn't integrate with
them yet).

**Updating.** Installed plugins are snapshots - they do not track this repo. An old
copy keeps running (without newer redaction and activation fixes) until you update it.
Refresh the marketplace first, so the update sees the new release, then update the
plugin:

```sh
claude plugin marketplace update throughline
claude plugin update throughline@throughline
```

Restart Claude Code to load the new copy (`claude plugin update` says a restart is
required). Inside a session, the `/plugin` manager does the same. The SessionStart block
prints the running version (`## throughline vX.Y.Z`), and `session-onboard.sh --doctor`
(see REFERENCE.md "Troubleshooting") lists the version every harness on the machine has
installed - if either lags this repo's releases, that install is stale.

## Codex CLI

```sh
codex plugin marketplace add dynamic/throughline
codex plugin add throughline@throughline
```

**Requirements:** `git` and `jq` on your `PATH`, same as Claude Code - Codex runs
the identical hook scripts. Without `jq`, capture cannot run. Works in Codex CLI and
Codex Desktop.

**What you get:** the 4 skills plus all 5 hooks, reading and writing the same
`.claude/throughline/` data format Claude Code, OpenCode, and OMP use - so a
project's history is readable and continuable from any of them.

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
live checkout. Refresh the marketplace snapshot, then add the plugin again, which
replaces the cached copy with the latest release:

```sh
codex plugin marketplace upgrade throughline
codex plugin add throughline@throughline
```

Trust is granted by content hash, so if the update changes the hooks, Codex CLI shows
the "Hooks need review" dialog once more: choose "Trust all and continue" again.
`codex plugin remove throughline@throughline` uninstalls.

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

**Requirements:** `git` and `jq` on your `PATH`, and a POSIX `sh`. The plugin maps
OpenCode's events onto the same `hooks/*.sh` scripts every other harness runs (they
ship inside the npm package), so capture and redaction are identical everywhere.
Without `jq`, capture does not run and the session-start block says so.

**What you get:** all 5 hooks against OpenCode's own plugin API - continuous
prompt/action capture with redaction, session-start context
injection (HANDOFF.md pointer + live git state), and compaction survival (a boundary
marker plus buffer-tail re-injection right after). One behavioral difference worth
knowing: OpenCode's `session.idle` event fires after every turn, not once at process
exit the way Claude Code's `SessionEnd` does, so the buffer gets an end-stamp after each turn that recorded
something, rather than one end-of-session stamp - `onboard` reads it the same way
either way (has this buffer seen activity since the last stamp). This plugin ships **hooks only,
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

**Updating.** OpenCode installs each plugin spec once and caches it under
`~/.cache/opencode/packages/`, one directory per spec. An unpinned entry
(`@dynamicagency/throughline-opencode`, or `...@latest`) stays on the version it first
resolved; a newer release does not replace it on restart. Two ways to move to a
release:

- Pin it. This installs that version right away and rewrites the entry in your global
  config (drop `-g` for the project config):
  ```sh
  opencode plugin @dynamicagency/throughline-opencode@<version> -g -f
  ```
- Keep the unpinned entry and clear its cache, then restart OpenCode:
  ```sh
  rm -rf ~/.cache/opencode/packages/@dynamicagency/throughline-opencode*
  ```

The running version is printed in the injected session-start block
(`## throughline vX.Y.Z`) the same way it is on Claude Code and Codex - if it lags
this repo's releases, your install is stale.

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

## OMP

```sh
git clone https://github.com/dynamic/throughline && cd throughline
omp plugin link .
```

`omp plugin link` symlinks a local directory into OMP's plugin roots, so this stays
a live checkout - `git pull` to update, no separate install/reinstall step. Restart
your OMP session afterward.

**Requirements:** `git`, `jq`, and [Bun](https://bun.sh) on your `PATH` - OMP's own
runtime is Bun-based, and the shim still shells out to the same `jq`-using hook
scripts Claude Code and Codex CLI run.

**What you get:** the 4 skills (auto-discovered from the repo's `skills/`
directory - zero extra step) plus all 5 capture
points, wired through OMP's own event bus rather than a subprocess hook transport.
OMP's hooks are in-process TypeScript event handlers (`pi.on(event, handler)`), so
`hooks/post/throughline.ts` registers against six of OMP's own events -
`session_start`, `before_agent_start`, `tool_result`, `session_before_compact`,
`session_compact`, and `session_shutdown` - and each handler shells out to the
identical `hooks/*.sh` scripts Claude Code and Codex CLI run, translating OMP's own
tool-call shape into the same JSON those scripts already parse. No capture or
redaction logic is duplicated in TypeScript.

One difference worth knowing: OMP splits what Claude Code does with one re-fired
`SessionStart(source=compact)` into two separate events (`session_before_compact` to
stamp the boundary, `session_compact` to re-inject the buffer tail), so the shim
registers both rather than one.

By default the OMP shim uses the same `.claude/throughline/` data directory as
Claude Code, Codex CLI, and OpenCode, so a project's history stays continuous
across every harness you use.

**Updating.** Since this is a live checkout (`omp plugin link`, not a package
install), `git pull` is the update step - no separate reinstall needed. The running
version is printed in the injected session-start block (`## throughline vX.Y.Z`),
same as every other harness.

**Uninstalling a link.** `omp plugin uninstall` takes the npm package name that
`omp plugin list` shows for a link install, not the manifest's `throughline`:
`omp plugin uninstall @dynamicagency/throughline`.

**Upgrading from an earlier link.** Before v0.17.0, checkouts were linked from
`.omp-plugin`, whose package was `@dynamicagency/throughline-omp`. That directory no
longer carries `skills/` or `hooks/`, so remove the old link by that package name and
relink from the repo root:
`omp plugin uninstall @dynamicagency/throughline-omp && omp plugin link .`

**Marketplace install (alternative).** If you don't want a local checkout to
manage:

```sh
omp plugin marketplace add dynamic/throughline
omp plugin install throughline@throughline
```

OMP falls back to reading Claude Code's `.claude-plugin/marketplace.json` format
when there's no OMP-native marketplace file, so this works against the same
repo without any extra OMP-specific manifest. Unlike `omp plugin link`, this
installs a versioned snapshot into `~/.omp/plugins/cache/` (discovered through a
different code path - OMP's `claude-plugins` provider, not the `omp-plugins` one
`omp plugin link` uses). Update it from the marketplace, not with `git pull`:

```sh
omp plugin marketplace update throughline
omp plugin upgrade throughline@throughline
```

A marketplace install is addressed by its marketplace id, so it uninstalls with
`omp plugin uninstall throughline@throughline`.

**Do not use both install methods on the same machine.** The link and the
marketplace snapshot are different files on disk, so OMP would register the hook
shim twice and every capture point would fire twice per event. Pick one.

## Hermes Agent

```sh
hermes plugins install dynamic/throughline
hermes plugins enable throughline
```

Hermes disables general plugins until enabled. Restart the gateway or open a new
session afterward.

**Requirements:** Hermes v0.22.3 or newer, plus `git` and `jq` on the `PATH` of the
machine running Hermes. Without `jq` the plugin logs one warning and registers
nothing.

**What you get:** the 4 skills, registered as `throughline:handoff`,
`throughline:onboard`, `throughline:consolidate` and `throughline:consolidate-memory`
(load them with `skill_view`), plus capture through six Hermes plugin hooks. The
plugin is a thin Python bridge (`hooks/post/hermes.py`) that translates each Hermes
hook into the JSON the `hooks/*.sh` scripts already parse and runs the same scripts
Claude Code runs, so capture and redaction logic exists in one place.

| Hermes hook | Does |
|---|---|
| `on_session_start` | Precomputes the HANDOFF orientation block |
| `pre_llm_call` | Records the prompt; injects the orientation block on the first turn |
| `post_tool_call` | Captures `terminal`, `execute_code`, `write_file`, `patch`, `delegate_task`, `web_search`, `web_extract` and MCP tools |
| `post_compaction` | Stamps the compaction boundary; re-injects the buffer tail on the next turn |
| `on_session_finalize`, `on_session_reset` | Stamps the end of the session buffer |

**Scope.** The plugin acts on sessions whose workspace (`ctx.session_cwd()`) is inside
a git repo and writes to that repo's `.claude/throughline/`, the same data directory
every other harness uses. Sessions outside a git repo are skipped. Only interactive
local sessions (`cli`, `tui`, `desktop`, `acp`, `local`) capture by default; messaging-platform
and cron sessions are skipped so a gateway host's shared checkouts are not written to.
Set `THROUGHLINE_HERMES_SURFACES` (comma-separated surface names, or `all`) to change
that.

**Gateway hosts.** On a Hermes gateway host that serves webhook and cron work, throughline
captures nothing from those sessions. It helps only interactive sessions run inside a git
repo. Setting `THROUGHLINE_HERMES_SURFACES=all` captures gateway sessions too, but it writes
into whatever checkout each session's workspace points at, so use it only where those
checkouts are meant to hold throughline data.

Plugin-internal state (pending injections) is kept in
`<hermes home>/plugin-data/throughline/`, never in the install directory.

**Updating.** `hermes plugins update throughline` pulls the latest release;
`hermes plugins check-updates` reports first without changing anything. An update
re-runs Hermes's security scan, and a caution verdict asks before applying (`--force`
applies it without asking). Restart the gateway or open a new session afterward.
`hermes plugins remove throughline` uninstalls.

## npx skills

```sh
npx skills add dynamic/throughline
```

Installs the 4 skills directly - no plugin system, no marketplace registration. This
is the fallback for any harness that reads `SKILL.md` files from disk but has no
plugin system of its own. **What you get:** the 4 skills, nothing else - no
automatic capture (there's no hook mechanism in this delivery form at all); run
`handoff` manually at the end of a session.
