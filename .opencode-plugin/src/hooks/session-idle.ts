/**
 * throughline — session-idle hook (maps to SessionEnd).
 *
 * OpenCode has no session-end event; session.idle fires at the end of every
 * turn. hooks/session-flush.sh appends an end-stamp only when a record
 * follows the last one, so a long session gets one stamp per active turn,
 * and onboard treats a buffer as ended only when nothing follows its last
 * stamp (issue #180).
 */

import { type ThroughlineContext, tlDisabled, runHook } from "../lib.js";

interface SessionIdleInput {
  sessionID: string;
}

export async function sessionIdle(ctx: ThroughlineContext, input: SessionIdleInput): Promise<void> {
  if (tlDisabled() || !input.sessionID) return;
  await runHook(ctx, "session-flush.sh", { session_id: input.sessionID, reason: "idle" });
}
