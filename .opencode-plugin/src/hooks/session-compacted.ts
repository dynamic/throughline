/**
 * throughline — session-compacted hook (maps to PreCompact).
 *
 * Stamps a compaction boundary marker into the session buffer so a later
 * handoff knows a compaction happened and treats actions above the line
 * as "distill from buffer text alone, not conversation recall."
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  type ThroughlineContext,
  tlDisabled,
  tlDataDir,
  tlDataRoot,
  tlSafeSid,
  tlNow,
  tlCleanCtrl,
  tlErr,
} from "../lib.js";

interface SessionCompactedInput {
  sessionID: string;
}

// Mirrors hooks/session-onboard.sh's TL_COMPACT_TAIL_LINES /
// TL_COMPACT_TAIL_LINE_CHARS: bounded so the recovery block itself has a
// predictable size regardless of how long any single captured line got.
const RECOVERY_TAIL_LINES = 30;
const RECOVERY_TAIL_LINE_CHARS = 300;

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

/**
 * Post-compaction recovery block (issue #56, P3 — port of
 * session-onboard.sh's `source == "compact"` branch).
 *
 * OpenCode's session.created does not re-fire after a compaction the way
 * Claude Code's SessionStart does with source=compact, so there is no other
 * channel to re-inject anything once a compaction has happened. This inlines
 * the buffer's tail directly into a context block that index.ts hands to
 * `pendingContext`, which rides the same push-per-transform-call /
 * clear-on-idle delivery as the session-start block.
 *
 * Returns null when there is genuinely nothing to recover (no buffer yet,
 * or an empty one) rather than throwing — this must never break the
 * session. A READ failure is different from "nothing to recover" (there
 * likely IS unrecovered history, it just couldn't be read) and is
 * breadcrumbed via tlErr plus an explicit degraded block, rather than
 * silently returning null the same as the no-buffer case — this fires
 * exactly when conversation memory was just wiped by the compaction, the
 * one moment a silent "nothing to see here" is least affordable.
 */
export async function sessionCompactionRecovery(
  ctx: ThroughlineContext,
  input: SessionCompactedInput,
): Promise<string | null> {
  if (tlDisabled()) return null;

  const dataDir = tlDataDir(ctx);
  const dataRoot = tlDataRoot(ctx);
  const bufDir = join(dataDir, "buffer");
  const sid = resolveSid(input.sessionID);
  if (!sid) return null;

  const bufPath = join(bufDir, `session-${sid}.md`);
  if (!existsSync(bufPath)) return null;

  const relBuf = relative(dataRoot, bufPath);

  let content: string;
  try {
    content = readFileSync(bufPath, "utf-8");
  } catch (err) {
    tlErr(dataDir, `sessionCompactionRecovery: read failed for ${relBuf}: ${err}`);
    return `⚠️ Context was just compacted, but this session's action buffer (\`${relBuf}\`) could not be read - recent action history before this point may be lost. Check disk space / permissions.`;
  }

  const allLines = content.split("\n").filter((l) => l.trim() !== "");
  if (allLines.length === 0) return null;

  const tail = allLines.slice(-RECOVERY_TAIL_LINES).map((l) =>
    l.length > RECOVERY_TAIL_LINE_CHARS
      ? `${l.slice(0, RECOVERY_TAIL_LINE_CHARS)} …[line truncated]`
      : l,
  );

  const lines: string[] = [
    `🧷 Context was just compacted. The last ${RECOVERY_TAIL_LINES} line(s) of this session's action buffer are inlined below to recover what you did before the compaction, without an extra read - the raw actions persist even though the conversation summary dropped detail. Full history (if the session ran longer than this tail) is at \`${relBuf}\`.`,
    "```",
    ...tail,
    "```",
  ];

  return lines.join("\n");
}
