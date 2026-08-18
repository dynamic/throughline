/**
 * throughline — session-idle hook (maps to SessionEnd).
 *
 * Stamps the session buffer as ended so the next session's onboard
 * surfaces it for retroactive distillation. Always exits cleanly.
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

interface SessionIdleInput {
  sessionID: string;
}

/**
 * Resolve session ID from OpenCode's sessionID.
 */
function resolveSid(sessionID: string): string {
  return tlSafeSid(sessionID);
}

/**
 * Session idle hook implementation.
 */
export async function sessionIdle(
  ctx: ThroughlineContext,
  input: SessionIdleInput,
): Promise<void> {
  if (tlDisabled()) return;

  const dataDir = tlDataDir(ctx);
  const bufDir = join(dataDir, "buffer");

  if (!existsSync(bufDir)) return;

  const sid = resolveSid(input.sessionID);
  if (!sid) return;

  const bufPath = join(bufDir, `session-${sid}.md`);
  if (!existsSync(bufPath)) return;

  // Determine reason (OpenCode doesn't provide this, so default to "idle")
  const reason = "idle";
  const cleanReason = tlCleanCtrl(reason);

  // Check if already stamped (idempotency guard)
  try {
    const content = readFileSync(bufPath, "utf-8");
    if (/^<!-- session-ended/m.test(content)) return;
  } catch {
    // If we can't read, try to write anyway
  }

  // Stamp session-ended marker
  const marker = `\n<!-- session-ended ${tlNow()} (${cleanReason}) -->\n`;
  try {
    appendFileSync(bufPath, marker, "utf-8");
  } catch {
    // Silently fail - this is a safety net, not critical
  }
}
