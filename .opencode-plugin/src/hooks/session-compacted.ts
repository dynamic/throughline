/**
 * throughline — session-compacted hook (maps to PreCompact plus
 * SessionStart(source=compact)).
 *
 * OpenCode reports a compaction after the fact, so both steps run here:
 * hooks/session-precompact.sh marks the compaction boundary in the buffer,
 * then hooks/session-onboard.sh builds the recovery block (the buffer tail)
 * that the next turn's system prompt carries.
 */

import { type ThroughlineContext, tlDisabled, runHook } from "../lib.js";

interface SessionCompactedInput {
  sessionID: string;
}

export async function sessionCompacted(ctx: ThroughlineContext, input: SessionCompactedInput): Promise<void> {
  if (tlDisabled() || !input.sessionID) return;
  // OpenCode does not say whether a compaction was automatic or manual.
  await runHook(ctx, "session-precompact.sh", { session_id: input.sessionID, trigger: "auto" });
}

export async function sessionCompactionRecovery(
  ctx: ThroughlineContext,
  input: SessionCompactedInput,
): Promise<string | null> {
  if (tlDisabled() || !input.sessionID) return null;
  const out = (await runHook(ctx, "session-onboard.sh", { session_id: input.sessionID, source: "compact" })).trim();
  return out || null;
}
