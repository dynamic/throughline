/**
 * throughline — session-idle hook.
 *
 * OpenCode's `session.idle` fires whenever the agent finishes a turn and
 * goes idle — the docs' own example uses it to fire a "response is ready"
 * desktop notification — NOT once at process exit the way Claude Code's
 * SessionEnd does. A session with several user turns fires this many times.
 *
 * That makes a Claude-style one-shot idempotency guard (stamp once, skip
 * forever after) wrong here: the FIRST idle would permanently stamp the
 * buffer "ended" while the session keeps going, and onboard would then read
 * an active session as abandoned. Instead this keeps exactly ONE marker,
 * always at the true end: every idle strips any previous marker (wherever
 * it landed — trailing, or buried under activity that resumed since) and
 * re-appends a fresh one. onboard's use of it is "no capture activity since
 * this point," which is accurate for every idle, not just a final one —
 * there is no OpenCode event today that reliably fires only at true session
 * end (session.deleted is explicit-delete, not exit).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

// Matches a session-ended marker line, together with its surrounding blank
// line, ANYWHERE in the buffer (global, not end-anchored) — a marker from an
// earlier idle may no longer be trailing if activity resumed since, and it
// still needs to be removed so re-stamping never leaves more than one
// marker in the file.
const MARKER_BLOCK = /\n?<!-- session-ended [^\n]* -->\n?/g;

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
  const marker = `\n<!-- session-ended ${tlNow()} (${cleanReason}) -->\n`;

  try {
    const content = readFileSync(bufPath, "utf-8");
    // Remove any existing marker (wherever it is) before re-appending fresh
    // at the true end — keeps exactly one marker in the file at all times.
    const stripped = content.replace(MARKER_BLOCK, "");
    writeFileSync(bufPath, stripped + marker, "utf-8");
  } catch {
    // Silently fail - this is a safety net, not critical
  }
}
