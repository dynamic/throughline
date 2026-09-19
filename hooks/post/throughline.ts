/**
 * throughline — OMP (Oh My Pi) hook shim.
 *
 * OMP discovers this file two ways, both feeding the same physical file so
 * there is nothing to keep in sync:
 *   - via `.omp-plugin/hooks/post/` (a symlink to this directory) when
 *     throughline is installed as an OMP-native extension package, and
 *   - via this literal `hooks/post/` directory when OMP reads a real
 *     Claude Code plugin install from `~/.claude/plugins/cache/` (OMP's
 *     `claude-plugins` discovery provider) — meaning anyone who already has
 *     throughline installed as a Claude Code plugin gets this for free.
 *
 * OMP's extension/hook events are in-process TypeScript callbacks, not
 * subprocess invocations like Claude Code/Codex CLI's hooks.json. Rather
 * than reimplementing session-capture.sh's capture/redaction logic in
 * TypeScript (the approach `.opencode-plugin` took, which shipped two
 * silent production bugs undetected by its own unit tests), each handler
 * here builds the same JSON shape the existing hooks/*.sh scripts already
 * `jq`-parse and shells out to the real script. See dynamic/throughline#85.
 */
import { execFile } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Resolves through symlinks to the real file location, so this is always
// `<repo-root>/hooks` regardless of which discovery path loaded this module.
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = path.join(THIS_DIR, "..");
const PLUGIN_ROOT = path.join(HOOKS_DIR, "..");

interface MinimalContext {
	cwd: string;
	sessionManager: { getSessionId(): string };
}

function runHook(script: string, payload: Record<string, unknown>, cwd: string): Promise<string> {
	return new Promise(resolve => {
		const child = execFile(
			"sh",
			[path.join(HOOKS_DIR, script)],
			{
				cwd,
				env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PROJECT_DIR: cwd },
				timeout: 5000,
				maxBuffer: 1024 * 1024,
			},
			// hooks/*.sh always exit 0 by contract (never block); any spawn/timeout
			// error here is likewise non-fatal to the OMP session — resolve with
			// whatever stdout is available (empty on failure) rather than throwing.
			(_error, stdout) => resolve(stdout ?? ""),
		);
		child.stdin?.end(JSON.stringify(payload));
	});
}

async function onboard(pi: { sendMessage: (msg: unknown, opts?: unknown) => void }, ctx: MinimalContext, source: string) {
	const stdout = await runHook(
		"session-onboard.sh",
		{ session_id: ctx.sessionManager.getSessionId(), source },
		ctx.cwd,
	);
	const text = stdout.trim();
	if (text) {
		pi.sendMessage({ customType: "throughline-onboard", content: text, display: true }, { triggerTurn: false });
	}
}

/**
 * Tools this shim captures, translated into the Claude-Code-shaped
 * `tool_name`/`tool_input` session-capture.sh already parses. Mirrors the
 * intent of hooks.json's PostToolUse matcher
 * (`Bash|Edit|Write|NotebookEdit|Grep|WebFetch|WebSearch|Task|Agent|mcp__.*`)
 * adapted to OMP's tool vocabulary — OMP has no NotebookEdit/WebFetch
 * built-ins, so those simply never appear here. `read`/`glob` are excluded
 * on purpose, matching Claude Code's own exclusion (too noisy — see
 * hooks.json's comment history / issue #6).
 *
 * Field names for `bash`/`edit`/`write`/`grep` are confirmed against OMP's
 * own tool schemas (`src/tools/{bash,write,grep}.ts`: `command`, `path`,
 * `pattern`). `web_search`/`task`'s field names below are a best-effort
 * guess pending live verification (dynamic/throughline#85) — if wrong, the
 * fields simply come through empty rather than crashing or misfiring.
 */
// event is loosely typed pending OMP's own published @types package
// (verified field names against OMP source directly — see comment above).
function buildCapturePayload(event: any, ctx: MinimalContext): Record<string, unknown> | null {
	const sessionId = ctx.sessionManager.getSessionId();
	const isError = event.isError === true;
	const input = event.input ?? {};
	const base = { session_id: sessionId, tool_response: { is_error: isError } };

	switch (event.toolName) {
		case "bash":
			return { ...base, tool_name: "Bash", tool_input: { command: input.command ?? "", description: "" } };
		case "edit":
			return { ...base, tool_name: "Edit", tool_input: { file_path: input.path ?? input.paths?.[0] ?? "" } };
		case "write":
			return { ...base, tool_name: "Write", tool_input: { file_path: input.path ?? "" } };
		case "grep":
			return { ...base, tool_name: "Grep", tool_input: { pattern: input.pattern ?? "" } };
		case "web_search":
			return { ...base, tool_name: "WebSearch", tool_input: { query: input.query ?? input.q ?? "" } };
		case "task":
			return {
				...base,
				tool_name: "Task",
				tool_input: {
					subagent_type: input.subagent_type ?? input.agent ?? "",
					description: input.description ?? input.prompt ?? "",
				},
			};
		case "read":
		case "glob":
			return null;
		default:
			// mcp__<server>_<tool> (OMP's own MCP naming) and any other custom
			// tool: name-only capture, zero field-shape assumptions — same
			// principle session-capture.sh's own `mcp__.*` fallback branch
			// already applies. Never silently drop an unrecognized-but-allowed
			// tool (the exact bug .opencode-plugin shipped and fixed).
			if (event.toolName.startsWith("mcp__")) {
				return { ...base, tool_name: event.toolName, tool_input: {} };
			}
			return null;
	}
}

export default function throughline(pi: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => void;
	sendMessage: (msg: unknown, opts?: unknown) => void;
}): void {
	pi.on("session_start", async (_event, ctx) => {
		await onboard(pi, ctx as MinimalContext, "startup");
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const e = event as { prompt: string };
		const c = ctx as MinimalContext;
		await runHook("session-prompt.sh", { session_id: c.sessionManager.getSessionId(), prompt: e.prompt }, c.cwd);
	});

	pi.on("tool_result", async (event, ctx) => {
		const c = ctx as MinimalContext;
		const payload = buildCapturePayload(event, c);
		if (payload) await runHook("session-capture.sh", payload, c.cwd);
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		const c = ctx as MinimalContext;
		await runHook(
			"session-precompact.sh",
			{ session_id: c.sessionManager.getSessionId(), reason: "auto" },
			c.cwd,
		);
	});

	pi.on("session_compact", async (_event, ctx) => {
		// OMP has no single re-fired "session start" for post-compaction the way
		// Claude Code's SessionStart(source=compact) works; session-onboard.sh's
		// buffer-tail recovery block is keyed on that source value, so replicate
		// it explicitly here.
		await onboard(pi, ctx as MinimalContext, "compact");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const c = ctx as MinimalContext;
		await runHook("session-flush.sh", { session_id: c.sessionManager.getSessionId(), reason: "end" }, c.cwd);
	});
}
