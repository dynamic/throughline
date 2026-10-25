/**
 * throughline — OpenCode plugin entry point.
 *
 * Wires the 5 hooks to OpenCode's plugin API:
 * - session-created, session-idle, session-compacted → via event handler
 * - chat-message → via chat.message hook
 * - tool-execute-after → via tool.execute.after hook
 * - HANDOFF.md context injection → via experimental.chat.system.transform,
 *   since OpenCode's session.created event has no text-injection channel of
 *   its own (unlike Claude Code's SessionStart). This rides an
 *   `experimental.*` hook and may need to move if OpenCode's API changes —
 *   it is currently the ONLY way a plugin hook can inject an AI-visible
 *   message at all; upstream anomalyco/opencode#17412 tracks the missing
 *   stable primitive (a community PR implementing it, #19519, was closed
 *   unmerged). Each hook runs one of the shared hooks/*.sh scripts (issue
 *   #179); if anomalyco/opencode#12472 (native Claude Code hook compat)
 *   ships, this event mapping could go too (dynamic/throughline#58).
 *
 * Ordering: prompt and tool capture are queued per session and not awaited,
 * so a script spawn never sits on OpenCode's hot path. Compaction and idle
 * drain that session's queue first, so the boundary and the end-stamp land
 * after every record that preceded them.
 *
 * Types are imported from @opencode-ai/plugin rather than hand-rolled, so a
 * payload-shape mismatch is a compile error instead of a silent no-op.
 *
 * pendingContext delivery (issue #56, P0a): `experimental.chat.system.transform`
 * fires MORE THAN ONCE per turn — confirmed live, OpenCode calls it once for its
 * own small-model "title generation" pass (`agent=title, small=true`) and again
 * for the real primary-agent call, both carrying the identical sessionID and no
 * other field to tell them apart. An earlier delete-on-first-read design let the
 * title call (which fires first) consume and destroy the entry before the real,
 * user-facing call ever saw it — the injected block never reached a real
 * conversation. Fixed by pushing on every transform call while an entry is
 * pending (harmless on the throwaway title call, correct on the real one) and
 * clearing it only at `session.idle` — which fires once, after both transform
 * calls for a turn have already happened, at the true end of that turn — so
 * later turns in the same session don't get it re-injected.
 */

import type { Plugin, Hooks } from "@opencode-ai/plugin";

import { sessionCreated } from "./hooks/session-created.js";
import { chatMessage } from "./hooks/chat-message.js";
import { toolExecuteAfter } from "./hooks/tool-execute-after.js";
import { sessionCompacted, sessionCompactionRecovery } from "./hooks/session-compacted.js";
import { sessionIdle } from "./hooks/session-idle.js";
import { enqueue, drain } from "./lib.js";

// --- Plugin implementation ---

/**
 * throughline plugin for OpenCode.
 *
 * Continuous, state-aware session memory. Captures what you did and what is,
 * hands it off with judgment when the session wraps.
 */
export const ThroughlinePlugin: Plugin = async ({ directory, worktree }) => {
  const tlCtx = {
    directory,
    worktree: worktree ?? directory,
  };

  // Context block built at session.created (or session.compacted), injected
  // into every experimental.chat.system.transform call for that session
  // until session.idle clears it — see that hook's own comment below for
  // why "consume on first read" was wrong. `null` means "computed, but
  // nothing to inject" (still tracked, so we don't recompute every call).
  const pendingContext = new Map<string, string | null>();

  const hooks: Hooks = {
    // Direct hooks
    "chat.message": async (input, output) => {
      void enqueue(input.sessionID, () => chatMessage(tlCtx, input, output));
    },

    "tool.execute.after": async (input, output) => {
      void enqueue(input.sessionID, () => toolExecuteAfter(tlCtx, input, output));
    },

    "experimental.chat.system.transform": async (input, output) => {
      // Push, don't consume: this call fires more than once per turn (see
      // header comment), and every call for a session while an entry is
      // pending should see it — the entry is cleared once, at session.idle,
      // not here.
      if (!input.sessionID || !pendingContext.has(input.sessionID)) return;
      const block = pendingContext.get(input.sessionID);
      if (block) output.system.push(block);
    },

    // Event-based hooks
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created": {
          const sessionID = event.properties.info.id;
          // A task-tool subagent's session has a parentID: give it the block, but
          // read-only, so it does not use up the main session's warning (issue #191).
          const block = await sessionCreated(tlCtx, { sessionID, readonly: Boolean(event.properties.info.parentID) });
          pendingContext.set(sessionID, block);
          break;
        }

        case "session.compacted": {
          const sessionID = event.properties.sessionID;
          await drain(sessionID);
          await sessionCompacted(tlCtx, { sessionID });
          // session.created does not re-fire after a compaction, so this is
          // the only channel for post-compaction recovery: overwrite (not
          // merge) any still-pending entry with a fresh recovery block, which
          // rides the same push-per-transform-call / clear-on-idle delivery
          // above. By the time compaction happens, the original session-start
          // entry (if any) has already been cleared by an earlier idle, so
          // there is nothing to lose by overwriting here.
          const recovery = await sessionCompactionRecovery(tlCtx, { sessionID });
          if (recovery) pendingContext.set(sessionID, recovery);
          break;
        }

        case "session.idle": {
          const sessionID = event.properties.sessionID;
          await drain(sessionID);
          await sessionIdle(tlCtx, { sessionID });
          // Clear here, not in the transform hook: idle fires once, after
          // every transform call for the turn has already happened, so this
          // is the correct "turn is over" signal — later turns in the same
          // session should not get the block re-injected.
          pendingContext.delete(sessionID);
          break;
        }
      }
    },
  };

  return hooks;
};

// Default export for OpenCode plugin loader
export default ThroughlinePlugin;
