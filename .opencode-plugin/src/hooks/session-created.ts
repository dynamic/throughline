/**
 * throughline — session-created hook (maps to SessionStart).
 *
 * Injects a context block at session start: a pointer to HANDOFF.md plus
 * live git state. This automates the cheap half of orientation.
 *
 * Note: OpenCode's session.created hook doesn't inject text into context
 * like Claude Code's SessionStart does. Instead, we log a message that
 * the agent can read, or we could use experimental.chat.system.transform
 * to inject into the system prompt. For now, we'll just ensure the data
 * dir exists and log a message.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";
import {
  type ThroughlineContext,
  tlDisabled,
  tlDataRoot,
  tlDataDir,
  tlActive,
  tlDataExists,
} from "../lib.js";

// Note: Unlike the shell version, this TypeScript port does NOT require jq.
// JSON parsing is native in TypeScript, so the shell's jq-availability check
// and warning are not applicable here.

interface SessionCreatedInput {
  sessionID: string;
}

/**
 * Get live git state (branch, status).
 */
function getGitState(root: string): { branch: string; status: string } | null {
  try {
    const branch = execSync(`git -C "${root}" rev-parse --abbrev-ref HEAD`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const status = execSync(`git -C "${root}" status -s`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    return { branch, status };
  } catch {
    return null;
  }
}

/**
 * Session created hook implementation.
 */
export async function sessionCreated(
  ctx: ThroughlineContext,
  input: SessionCreatedInput,
): Promise<string | null> {
  if (tlDisabled()) return null;

  const root = ctx.directory;
  const dataRoot = tlDataRoot(ctx);
  const dataDir = tlDataDir(ctx);

  // Check if throughline is active
  const state = tlActive(ctx);
  const dataExists = tlDataExists(ctx);

  if (!dataExists && !state.active) {
    // Distinguish deliberate opt-out from bootstrap failure
    if (state.activeReason === "bootstrap-failed") {
      return `⚠️ throughline could not create its data directory (${relative(dataRoot, dataDir)}) - check permissions/disk space. Capture will not run.`;
    }
    return null;
  }

  const lines: string[] = [];

  // Header
  lines.push("## throughline - project session context");
  lines.push("");

  // Worktree sharing note
  if (dataRoot !== root) {
    lines.push(
      `🔗 throughline data is shared with the main working tree at \`${dataRoot}\` (this is a linked worktree).`,
    );
    lines.push("");
  }

  // Capture errors breadcrumb
  const errPath = join(dataDir, ".capture-errors");
  if (existsSync(errPath)) {
    try {
      const errContent = readFileSync(errPath, "utf-8");
      const errCount = errContent.split("\n").filter((l) => l.trim()).length;
      if (errCount > 0) {
        lines.push(
          `⚠️ ${errCount} capture failure(s) recorded in \`${relative(dataRoot, errPath)}\` - some actions may be missing. Check disk space / permissions.`,
        );
        lines.push("");
      }
    } catch {
      // Ignore read errors
    }
  }

  // HANDOFF.md pointer
  const handoffPath = join(dataDir, "HANDOFF.md");
  if (existsSync(handoffPath)) {
    lines.push(`Durable handoff exists at \`${relative(dataRoot, handoffPath)}\` - read it before starting.`);

    // Extract "Last Updated" line
    try {
      const content = readFileSync(handoffPath, "utf-8");
      const match = content.match(/Last Updated:\s*(.+)/i);
      if (match) {
        lines.push(`Last Updated: ${match[1].trim()}`);
      }
    } catch {
      // Ignore read errors
    }
  } else {
    lines.push("No HANDOFF.md yet for this project. One will be written at the next handoff.");
  }

  // Git state (if in worktree)
  const gitState = getGitState(root);
  if (gitState) {
    lines.push("");
    lines.push("### Live git state");
    lines.push("```");
    lines.push(`branch: ${gitState.branch}`);
    if (gitState.status) {
      lines.push(gitState.status);
    }
    lines.push("```");
  }

  return lines.join("\n");
}
