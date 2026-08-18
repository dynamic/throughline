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
 *   `experimental.*` hook and may need to move if OpenCode's API changes.
 *
 * Types are imported from @opencode-ai/plugin rather than hand-rolled, so a
 * payload-shape mismatch is a compile error instead of a silent no-op.
 */

import type { Plugin, Hooks } from "@opencode-ai/plugin";

import { sessionCreated } from "./hooks/session-created.js";
import { chatMessage } from "./hooks/chat-message.js";
import { toolExecuteAfter } from "./hooks/tool-execute-after.js";
import { sessionCompacted } from "./hooks/session-compacted.js";
import { sessionIdle } from "./hooks/session-idle.js";

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

  // Context block built at session.created, consumed once by the next
  // system-prompt transform for that session. `null` means "computed, but
  // nothing to inject" (still consumed, so we don't recompute every turn).
  const pendingContext = new Map<string, string | null>();

  const hooks: Hooks = {
    // Direct hooks
    "chat.message": async (input, output) => {
      await chatMessage(tlCtx, input, output);
    },

    "tool.execute.after": async (input, output) => {
      await toolExecuteAfter(tlCtx, input, output);
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID || !pendingContext.has(input.sessionID)) return;
      const block = pendingContext.get(input.sessionID);
      pendingContext.delete(input.sessionID);
      if (block) output.system.push(block);
    },

    // Event-based hooks
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created": {
          const sessionID = event.properties.info.id;
          const block = await sessionCreated(tlCtx, { sessionID });
          pendingContext.set(sessionID, block);
          break;
        }

        case "session.compacted":
          await sessionCompacted(tlCtx, { sessionID: event.properties.sessionID });
          break;

        case "session.idle":
          await sessionIdle(tlCtx, { sessionID: event.properties.sessionID });
          break;
      }
    },
  };

  return hooks;
};

// Default export for OpenCode plugin loader
export default ThroughlinePlugin;
