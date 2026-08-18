/**
 * throughline — session-compacted hook (maps to PreCompact).
 *
 * Stamps a compaction boundary marker into the session buffer so a later
 * handoff knows a compaction happened and treats actions above the line
 * as "distill from buffer text alone, not conversation recall."
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ThroughlineContext,
  tlDisabled,
  tlDataDir,
  tlSafeSid,
  tlNow,
  tlCleanCtrl,
} from "../lib.js";

interface SessionCompactedInput {
  sessionID: string;
}

/**
 * Resolve session ID from OpenCode's sessionID.
 */
function resolveSid(sessionID: string): string {
  return tlSafeSid(sessionID);
}

/**
 * Session compacted hook implementation.
 */
export async function sessionCompacted(
  ctx: ThroughlineContext,
  input: SessionCompactedInput,
): Promise<void> {
  if (tlDisabled()) return;

  const dataDir = tlDataDir(ctx);
  const bufDir = join(dataDir, "buffer");

  if (!existsSync(bufDir)) return;

  const sid = resolveSid(input.sessionID);
  if (!sid) return;

  const bufPath = join(bufDir, `session-${sid}.md`);
  if (!existsSync(bufPath)) return;

  // Idempotency guard: skip if buffer already ends with a boundary marker
  try {
    const content = readFileSync(bufPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim() !== "");
    const lastLine = lines[lines.length - 1] || "";
    if (lastLine.startsWith("<!-- compaction-boundary")) {
      return; // Already marked
    }
  } catch {
    // If we can't read, try to write anyway
  }

  // Stamp compaction boundary marker
  const trigger = "auto"; // OpenCode doesn't provide trigger info
  const cleanTrigger = tlCleanCtrl(trigger);
  const marker = `\n<!-- compaction-boundary ${tlNow()} (${cleanTrigger}) - actions above predate a context compaction; distill them from this buffer, not from conversation recall -->\n`;

  try {
    appendFileSync(bufPath, marker, "utf-8");
  } catch {
    // Silently fail - this is a marker, not critical
  }
}
