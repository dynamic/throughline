# throughline for OpenCode

Continuous, state-aware session memory for [OpenCode](https://opencode.ai) - the
OpenCode delivery of [throughline](https://github.com/dynamic/throughline),
which also ships for Claude Code and Codex CLI.

## Install

Add the package name to `opencode.json`'s `plugin` array:

```json
{
  "plugin": ["@dynamicagency/throughline-opencode"]
}
```

OpenCode installs it automatically via Bun at startup - no clone, no separate
build step. Restart OpenCode after adding it; check
`~/.local/share/opencode/log/opencode.log` for a load error if session capture
doesn't appear to be running.

## What you get

All five throughline hooks, ported to OpenCode's plugin API:

- **Continuous capture** of prompts and tool calls, with redaction, written to
  `.claude/throughline/buffer/`
- **Session-start context injection** - a `HANDOFF.md` pointer plus live git
  state, surfaced at the top of the conversation
- **Compaction survival** - a boundary marker and buffer-tail re-injection
  immediately after OpenCode compacts a session
- The same `.claude/throughline/` data directory Claude Code and Codex use, so
  a project's history stays continuous across harnesses

This package ships hooks only, no skills - OpenCode's plugin API has no
supported way to bundle a skill directory alongside a plugin. Run
`npx skills add dynamic/throughline` separately for the
`handoff`/`onboard`/`consolidate`/`consolidate-memory` skills. OpenCode often
discovers them anyway: it scans `~/.claude/skills/` and `~/.agents/skills/` in
addition to its own skill directories, so a skill installed for another harness
on the same machine is frequently already visible here.

## Full documentation

See the [main throughline README](https://github.com/dynamic/throughline#opencode)
for the complete OpenCode section, including the local-path install (for
testing unreleased changes) and behavioral notes specific to OpenCode's plugin
API.

## License

MIT
