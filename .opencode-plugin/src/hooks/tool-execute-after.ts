/**
 * throughline — tool-execute-after hook (maps to PostToolUse).
 *
 * Appends a structured one-line record of each captured action to the
 * per-session buffer. This is the continuous raw layer that a later
 * handoff distills from. Mechanical and cheap — no model call.
 * Always exits cleanly; never blocks a tool.
 *
 * Which tools land here is decided by the filter below: the mutating
 * tools (Bash/Edit/Write/NotebookEdit) plus the high-signal read-side
 * tools (Grep/WebFetch/WebSearch/Task/Agent) and MCP tools (mcp__*).
 * Read and Glob are deliberately skipped — they are the noisiest tools
 * by far, and a buffer that logs every file read stops being skimmable.
 *
 * Port of hooks/session-capture.sh lines 71-147.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import {
  type ThroughlineContext,
  tlActive,
  tlSafeSid,
  tlAppendLine,
  tlErr,
} from "../lib.js";
import { redact, redactPrompt, clean, clamp } from "../utils/redaction.js";

interface ToolExecuteAfterInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: Record<string, unknown>;
}

interface ToolExecuteAfterOutput {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
}

/**
 * Determine outcome suffix from tool result metadata.
 * OpenCode's tool_response may expose `interrupted`, `is_error`, or
 * `exit_code`/`error`/`code` for Bash. Match shell version's outcome() def.
 */
function outcome(tool: string, output: ToolExecuteAfterOutput): string {
  const meta = output?.metadata ?? {};
  const resp = meta as Record<string, unknown>;

  if (resp.interrupted === true) return " `[interrupted]`";
  if (resp.is_error === true) return " `[failed]`";

  // Bash-specific: check exit code
  if (tool === "Bash") {
    const exitCode = resp.exit_code ?? resp.code ?? resp.returncode ?? 0;
    if (resp.error || String(exitCode) !== "0") return " `[failed]`";
  }

  return "";
}

/**
 * Tool execute after hook implementation.
 */
export async function toolExecuteAfter(
  ctx: ThroughlineContext,
  input: ToolExecuteAfterInput,
  output: ToolExecuteAfterOutput,
): Promise<void> {
  const state = tlActive(ctx);
  if (!state.active) return;

  const sid = tlSafeSid(input.sessionID);
  if (!sid) return;

  const { tool, args } = input;
  const root = ctx.directory;
  const suffix = outcome(tool, output);

  let line = "";

  switch (tool) {
    case "Bash": {
      const desc = (args?.description as string) ?? "";
      const cmd = (args?.command as string) ?? "";
      if (!cmd) return;
      line = `**bash** ${clean(redact(desc))}${suffix} - \`${clamp(clean(redact(cmd)), 200, "…[truncated]")}\``;
      break;
    }

    case "Edit":
    case "Write":
    case "NotebookEdit": {
      const filePath =
        (args?.file_path as string) ?? (args?.notebook_path as string) ?? "";
      if (!filePath) return;
      // Show path relative to project root
      const relPath = filePath.startsWith(root + "/")
        ? filePath.slice(root.length + 1)
        : filePath;
      line = `**${tool}** ${clean(redact(relPath))}${suffix}`;
      break;
    }

    case "Grep": {
      const pattern = (args?.pattern as string) ?? "";
      if (!pattern) return;
      // Grep pattern is not prose — use command-path redaction
      line = `**grep** \`${clamp(clean(redact(pattern)), 120, "…")}\`${suffix}`;
      break;
    }

    case "WebFetch": {
      const url = (args?.url as string) ?? "";
      if (!url) return;
      line = `**webfetch** ${clamp(clean(redact(url)), 200, "…")}${suffix}`;
      break;
    }

    case "WebSearch": {
      const query = (args?.query as string) ?? "";
      if (!query) return;
      // Natural-language query — prose-safe redaction
      line = `**websearch** ${clamp(clean(redactPrompt(query)), 200, "…")}${suffix}`;
      break;
    }

    case "Task":
    case "Agent": {
      const subagentType = (args?.subagent_type as string) ?? "";
      // description // prompt: prefer description, fall back to prompt
      const desc =
        (args?.description as string) || (args?.prompt as string) || "";
      if (!desc && !subagentType) return;
      // Natural-language description — prose-safe redaction
      const redactedDesc = desc ? redactPrompt(desc) : "";
      const prefix = subagentType ? `${subagentType}: ` : "";
      line = `**agent** ${prefix}${clamp(clean(redactedDesc), 200, "…")}${suffix}`;
      break;
    }

    default: {
      // MCP tools (mcp__server__tool) and any other matched tool: name only.
      // Strip asterisks from tool name to avoid breaking markdown bold.
      if (tool.startsWith("mcp__") || tool.includes("__")) {
        const safeName = clean(tool).replace(/\*/g, "");
        line = `**${safeName}**${suffix}`;
      }
      break;
    }
  }

  if (!line) return;

  const bufDir = join(state.dataDir, "buffer");
  try {
    mkdirSync(bufDir, { recursive: true });
  } catch (err) {
    tlErr(`mkdir failed for buffer dir: ${err}`);
    return;
  }

  tlAppendLine(bufDir, sid, line);
}
