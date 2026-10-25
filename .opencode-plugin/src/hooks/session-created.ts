/**
 * throughline — session-created hook (maps to SessionStart).
 *
 * Runs hooks/session-onboard.sh and returns its output, the session-start
 * block (HANDOFF.md pointer, live git state, warnings and nudges), for
 * index.ts to inject through the system-prompt transform: OpenCode's
 * session.created event has no text channel of its own.
 */

import { type ThroughlineContext, tlDisabled, runHook } from "../lib.js";

interface SessionCreatedInput {
  sessionID: string;
  /**
   * True for a child session (a task-tool subagent, `info.parentID` set): build
   * the block but do not record the unconsumed-buffer warning as reported
   * (issue #191), so a subagent cannot use up a report the main session needs.
   */
  readonly?: boolean;
}

export async function sessionCreated(ctx: ThroughlineContext, input: SessionCreatedInput): Promise<string | null> {
  if (tlDisabled() || !input.sessionID) return null;
  const env: Record<string, string> = input.readonly ? { THROUGHLINE_ONBOARD_READONLY: "1" } : {};
  const out = (await runHook(ctx, "session-onboard.sh", { session_id: input.sessionID, source: "startup" }, env)).trim();
  return out || null;
}
