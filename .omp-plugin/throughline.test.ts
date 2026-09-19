// Integration test for the OMP hook shim (hooks/post/throughline.ts).
//
// Deliberately does NOT mock node:child_process: it imports the real shim
// and fires synthetic OMP events at it, letting each handler drive the real
// hooks/*.sh scripts against a scratch project directory, then asserts on
// the resulting buffer file. A mocked-execFile unit test would only prove
// "the shim called execFile with some string" — it can't catch a JSON
// field-name mismatch against what the shell scripts' own `jq` filters
// expect, which is exactly the class of bug this design is meant to avoid
// (see dynamic/throughline#85 and the .opencode-plugin tool-naming bug it
// cites). Running the real scripts, as tests/run.sh already does for the
// Claude Code hooks, is the layer that actually catches that.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SHIM = path.join(import.meta.dir, "..", "hooks", "post", "throughline.ts");
const SESSION_ID = "test-session-id";

let scratchDir: string;
let originalCwd: string;
let registered: Record<string, ((event: unknown, ctx: unknown) => Promise<void> | void)[]>;
let sentMessages: { customType?: string; content?: string }[];
let ctx: { cwd: string; sessionManager: { getSessionId: () => string } };

async function fire(event: string, payload: unknown): Promise<void> {
	const handlers = registered[event] ?? [];
	expect(handlers.length).toBeGreaterThan(0);
	for (const h of handlers) await h(payload, ctx);
}

function bufferPath(): string {
	return path.join(scratchDir, ".claude", "throughline", "buffer", `session-${SESSION_ID}.md`);
}

beforeEach(async () => {
	scratchDir = mkdtempSync(path.join(os.tmpdir(), "tl-omp-test-"));
	originalCwd = process.cwd();
	process.chdir(scratchDir);

	registered = {};
	sentMessages = [];
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
			(registered[event] ??= []).push(handler);
		},
		sendMessage(msg: { customType?: string; content?: string }) {
			sentMessages.push(msg);
		},
	};
	ctx = { cwd: scratchDir, sessionManager: { getSessionId: () => SESSION_ID } };

	// Cache-busting query so bun re-evaluates the module (and its registered
	// handlers) fresh for every test rather than reusing a prior import.
	const mod = await import(`${SHIM}?t=${Date.now()}-${Math.random()}`);
	mod.default(pi);
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(scratchDir, { recursive: true, force: true });
});

describe("throughline OMP shim", () => {
	test("registers all six lifecycle events", () => {
		for (const event of [
			"session_start",
			"before_agent_start",
			"tool_result",
			"session_before_compact",
			"session_compact",
			"session_shutdown",
		]) {
			expect(registered[event]?.length).toBe(1);
		}
	});

	test("session_start sends an onboarding message", async () => {
		await fire("session_start", { type: "session_start" });
		expect(sentMessages.length).toBe(1);
		expect(sentMessages[0].customType).toBe("throughline-onboard");
		expect(sentMessages[0].content).toContain("throughline");
	});

	test("large payload does not crash when the target hook script exits before reading stdin", async () => {
		// Regression: every hooks/*.sh script guard-clause exits 0 (before ever
		// reading stdin) when THROUGHLINE_DISABLE is set. A payload large enough
		// to exceed the pipe buffer then hits EPIPE on the write - unhandled,
		// that tears down the whole host process, not just this one hook call.
		const prev = process.env.THROUGHLINE_DISABLE;
		process.env.THROUGHLINE_DISABLE = "1";
		try {
			const bigPrompt = "x".repeat(5 * 1024 * 1024);
			await fire("before_agent_start", { type: "before_agent_start", prompt: bigPrompt });
		} finally {
			if (prev === undefined) delete process.env.THROUGHLINE_DISABLE;
			else process.env.THROUGHLINE_DISABLE = prev;
		}
	});

	test("before_agent_start captures the prompt", async () => {
		await fire("before_agent_start", { type: "before_agent_start", prompt: "hello from omp" });
		const buf = readFileSync(bufferPath(), "utf8");
		expect(buf).toContain("**prompt** hello from omp");
	});

	test("tool_result captures bash, write, grep, and mcp__* tools", async () => {
		await fire("tool_result", {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "1",
			input: { command: "echo hi" },
			content: [],
			isError: false,
		});
		await fire("tool_result", {
			type: "tool_result",
			toolName: "write",
			toolCallId: "2",
			input: { path: "foo.txt", content: "x" },
			content: [],
			isError: false,
		});
		await fire("tool_result", {
			type: "tool_result",
			toolName: "grep",
			toolCallId: "3",
			input: { pattern: "TODO" },
			content: [],
			isError: false,
		});
		await fire("tool_result", {
			type: "tool_result",
			toolName: "mcp__github_search_issues",
			toolCallId: "4",
			input: {},
			content: [],
			isError: false,
		});

		const buf = readFileSync(bufferPath(), "utf8");
		expect(buf).toContain("**bash**");
		expect(buf).toContain("echo hi");
		expect(buf).toContain("**Write** foo.txt");
		expect(buf).toContain("**grep** `TODO`");
		expect(buf).toContain("**mcp__github_search_issues**");
	});

	test("tool_result falls back to task's prompt when description is an empty string", async () => {
		// Regression: an empty-string description must still fall through to
		// prompt (matches session-capture.sh's own empty-aware jq select) - a
		// naive `??` fallback stops at the empty string and drops the intent.
		await fire("tool_result", {
			type: "tool_result",
			toolName: "task",
			toolCallId: "1",
			input: { subagent_type: "Explore", description: "", prompt: "find the auth code paths" },
			content: [],
			isError: false,
		});
		const buf = readFileSync(bufferPath(), "utf8");
		expect(buf).toContain("find the auth code paths");
	});

	test("tool_result skips read and glob (matches Claude Code's own exclusion)", async () => {
		await fire("tool_result", {
			type: "tool_result",
			toolName: "read",
			toolCallId: "1",
			input: { path: "foo.txt" },
			content: [],
			isError: false,
		});
		await fire("tool_result", {
			type: "tool_result",
			toolName: "glob",
			toolCallId: "2",
			input: { pattern: "*.ts" },
			content: [],
			isError: false,
		});
		expect(existsSync(bufferPath())).toBe(false);
	});

	test("tool_result drops unrecognized non-mcp tools rather than guessing a shape", async () => {
		await fire("tool_result", {
			type: "tool_result",
			toolName: "todo",
			toolCallId: "1",
			input: {},
			content: [],
			isError: false,
		});
		expect(existsSync(bufferPath())).toBe(false);
	});

	test("session_before_compact stamps a compaction boundary", async () => {
		// Needs an existing buffer to stamp — capture something first.
		await fire("before_agent_start", { type: "before_agent_start", prompt: "hi" });
		await fire("session_before_compact", { type: "session_before_compact" });
		const buf = readFileSync(bufferPath(), "utf8");
		expect(buf).toContain("<!-- compaction-boundary");
	});

	test("session_compact re-sends onboarding context (post-compaction recovery)", async () => {
		await fire("before_agent_start", { type: "before_agent_start", prompt: "hi" });
		await fire("session_compact", { type: "session_compact" });
		expect(sentMessages.length).toBe(1);
		expect(sentMessages[0].content).toContain("Context was just compacted");
	});

	test("session_shutdown stamps the buffer as ended", async () => {
		await fire("before_agent_start", { type: "before_agent_start", prompt: "hi" });
		await fire("session_shutdown", { type: "session_shutdown" });
		const buf = readFileSync(bufferPath(), "utf8");
		expect(buf).toContain("<!-- session-ended");
	});
});
