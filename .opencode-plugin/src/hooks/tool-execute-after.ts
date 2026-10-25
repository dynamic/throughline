/**
 * throughline — tool-execute-after hook (maps to PostToolUse).
 *
 * Maps an OpenCode tool call onto the Claude Code PostToolUse payload that
 * hooks/session-capture.sh reads, so capture and redaction are the shared
 * shell implementation (issue #179).
 */

import type { Hooks } from "@opencode-ai/plugin";
import { type ThroughlineContext, tlDisabled, runHook } from "../lib.js";

type ToolExecuteAfterHook = NonNullable<Hooks["tool.execute.after"]>;
type ToolExecuteAfterInput = Parameters<ToolExecuteAfterHook>[0];
type ToolExecuteAfterOutput = Parameters<ToolExecuteAfterHook>[1];

// Read-side tools too frequent to be worth a buffer line (no spawn at all).
const NOISY_TOOLS = new Set(["read", "glob", "list", "todowrite"]);

type Args = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * OpenCode tool name and args -> Claude Code tool_name and tool_input.
 * Tools not listed pass through by name; session-capture.sh records those
 * name-only (MCP ids included), reading none of their input.
 */
function toClaude(tool: string, args: Args): { tool_name: string; tool_input: Args } {
  switch (tool) {
    case "bash":
      return { tool_name: "Bash", tool_input: { command: str(args.command), description: str(args.description) } };
    case "edit":
      return { tool_name: "Edit", tool_input: { file_path: str(args.filePath) } };
    case "write":
      return { tool_name: "Write", tool_input: { file_path: str(args.filePath) } };
    case "grep":
      return { tool_name: "Grep", tool_input: { pattern: str(args.pattern) } };
    case "webfetch":
      return { tool_name: "WebFetch", tool_input: { url: str(args.url) } };
    case "websearch":
      return { tool_name: "WebSearch", tool_input: { query: str(args.query) } };
    case "task":
      return {
        tool_name: "Task",
        tool_input: {
          subagent_type: str(args.subagent_type),
          description: str(args.description),
          prompt: str(args.prompt),
        },
      };
    default:
      return { tool_name: tool, tool_input: {} };
  }
}

/** Build the PostToolUse payload, or null when the call is not worth a record. */
export function capturePayload(
  input: ToolExecuteAfterInput,
  output: ToolExecuteAfterOutput,
): Record<string, unknown> | null {
  const { tool } = input;
  if (!input.sessionID || !tool || NOISY_TOOLS.has(tool)) return null;
  const args = (input.args ?? {}) as Args;
  const mapped = toClaude(tool, args);
  // An action with no identifying argument says nothing a later handoff can use.
  if (tool === "bash" && !mapped.tool_input.command) return null;
  if ((tool === "edit" || tool === "write") && !mapped.tool_input.file_path) return null;
  if (tool === "grep" && !mapped.tool_input.pattern) return null;
  if (tool === "webfetch" && !mapped.tool_input.url) return null;
  if (tool === "websearch" && !mapped.tool_input.query) return null;
  if (tool === "task" && !args.subagent_type && !args.description && !args.prompt) return null;
  const meta = (output?.metadata ?? {}) as Record<string, unknown>;
  const response: Record<string, unknown> = { ...meta };
  // OpenCode's shell tool reports `exit` (null when aborted or timed out);
  // session-capture.sh's outcome() reads exit_code and interrupted.
  if (tool === "bash" && "exit" in meta) {
    if (meta.exit === null) response.interrupted = true;
    else if (typeof meta.exit === "number") response.exit_code = meta.exit;
  }
  return { session_id: input.sessionID, ...mapped, tool_response: response };
}

export async function toolExecuteAfter(
  ctx: ThroughlineContext,
  input: ToolExecuteAfterInput,
  output: ToolExecuteAfterOutput,
): Promise<void> {
  if (tlDisabled()) return;
  const payload = capturePayload(input, output);
  if (payload) await runHook(ctx, "session-capture.sh", payload);
}
