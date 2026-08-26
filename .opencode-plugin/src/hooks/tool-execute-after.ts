/**
 * throughline — tool-execute-after hook (maps to PostToolUse).
 *
 * Appends a structured one-line record of each captured action to the
 * per-session buffer. This is the continuous raw layer that a later
 * handoff distills from. Mechanical and cheap — no model call.
 * Always exits cleanly; never blocks a tool.
 *
 * Which tools land here is decided by the switch below: the mutating
 * tools (bash/edit/write) plus the high-signal read-side tools
 * (grep/webfetch/websearch/task) and MCP tools (mcp__*). read and glob are
 * deliberately skipped — they are the noisiest tools by far, and a buffer
 * that logs every file read stops being skimmable.
 *
 * OpenCode's built-in tool ids are lowercase (`bash`, `edit`, `write`,
 * `grep`, `webfetch`, `websearch`, `task`, ...) — confirmed against
 * packages/opencode/src/tool/*.ts in anomalyco/opencode (the sst/opencode
 * successor) and against `permission=...` lines in this machine's
 * opencode.log. This does NOT match Claude Code's PascalCase tool names
 * (Bash/Edit/Write/Grep/WebFetch/WebSearch/Task), so the arg field names
 * below are OpenCode's own (`filePath`, not `file_path`; no NotebookEdit
 * or Agent alias; the bash tool has no `description` field, only
 * `command`/`timeout`/`workdir`).
 *
 * Port of hooks/session-capture.sh lines 71-147, adapted to the OpenCode
 * tool surface rather than Claude Code's.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";

// Deliberately excluded from the generic default-case capture below: the
// noisiest built-in tools, matching Claude Code's PostToolUse matcher (which
// never sends Read/Glob to the hook at all). Unlike Claude Code's
// hooks.json-level matcher, OpenCode's tool.execute.after fires for EVERY
// tool with no equivalent filter, so this hook has to do that filtering
// itself — this set is that filter.
const NOISY_TOOLS = new Set(["read", "glob"]);
import type { Hooks } from "@opencode-ai/plugin";
import {
  type ThroughlineContext,
  tlActive,
  tlSafeSid,
  tlAppendLine,
  tlErr,
} from "../lib.js";
import { redact, redactPrompt, clean, clamp } from "../utils/redaction.js";

type ToolExecuteAfterHook = NonNullable<Hooks["tool.execute.after"]>;
type ToolExecuteAfterInput = Parameters<ToolExecuteAfterHook>[0];
type ToolExecuteAfterOutput = Parameters<ToolExecuteAfterHook>[1];

/**
 * Determine outcome suffix from tool result metadata.
 * OpenCode's tool output may expose `interrupted`, `is_error`, or
 * `exit_code`/`error`/`code` for bash. Match shell version's outcome() def.
 */
function outcome(tool: string, output: ToolExecuteAfterOutput): string {
  const meta = output?.metadata ?? {};
  const resp = meta as Record<string, unknown>;

  if (resp.interrupted === true) return " `[interrupted]`";
  if (resp.is_error === true) return " `[failed]`";

  // bash-specific: check exit code
  if (tool === "bash") {
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
    case "bash": {
      // OpenCode's bash tool takes command/timeout/workdir — no
      // description field (unlike Claude Code's Bash tool).
      const cmd = (args?.command as string) ?? "";
      if (!cmd) return;
      line = `**bash**${suffix} \`${clamp(clean(redact(cmd)), 200, "…[truncated]")}\``;
      break;
    }

    case "edit":
    case "write": {
      const filePath = (args?.filePath as string) ?? "";
      if (!filePath) return;
      // Show path relative to project root
      const relPath = filePath.startsWith(root + "/")
        ? filePath.slice(root.length + 1)
        : filePath;
      line = `**${tool}** ${clean(redact(relPath))}${suffix}`;
      break;
    }

    case "grep": {
      const pattern = (args?.pattern as string) ?? "";
      if (!pattern) return;
      // Grep pattern is not prose — use command-path redaction
      line = `**grep** \`${clamp(clean(redact(pattern)), 120, "…")}\`${suffix}`;
      break;
    }

    case "webfetch": {
      const url = (args?.url as string) ?? "";
      if (!url) return;
      line = `**webfetch** ${clamp(clean(redact(url)), 200, "…")}${suffix}`;
      break;
    }

    case "websearch": {
      const query = (args?.query as string) ?? "";
      if (!query) return;
      // Natural-language query — prose-safe redaction
      line = `**websearch** ${clamp(clean(redactPrompt(query)), 200, "…")}${suffix}`;
      break;
    }

    case "task": {
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
      // MCP tools and any other unmatched tool: name only, zero assumptions
      // about the input schema, so no field can leak a secret and no
      // unverified shape can be misread. NOISY_TOOLS (read/glob) stays
      // excluded even here — see its own comment.
      //
      // issue #56 (P0b): this used to require "mcp__"/"__" in the name,
      // copying Claude Code's `mcp__server__tool` convention. Confirmed live
      // that OpenCode's own MCP tool ids use a SINGLE underscore between
      // server and tool name (e.g. `perplexity-ask_perplexity_ask`), which
      // matched neither check — every MCP call was silently dropped. There is
      // no prefix to gate on here: every other OpenCode built-in tool this
      // plugin knows about is matched by name above
      // (bash/edit/write/grep/webfetch/websearch/task), so anything reaching
      // this default case is already known to be an MCP tool or something
      // equally unanticipated, and capturing its bare name is safe either way.
      if (NOISY_TOOLS.has(tool)) break;
      const safeName = clean(tool).replace(/\*/g, "");
      line = `**${safeName}**${suffix}`;
      break;
    }
  }

  if (!line) return;

  const bufDir = join(state.dataDir, "buffer");
  try {
    mkdirSync(bufDir, { recursive: true });
  } catch (err) {
    tlErr(state.dataDir, `mkdir failed for buffer dir: ${err}`);
    return;
  }

  tlAppendLine(bufDir, sid, line);
}
