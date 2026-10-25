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
 * Ordering and durability: OpenCode awaits `chat.message` and
 * `tool.execute.after`, but not `event` handlers (it fires them with `void`),
 * and a headless `opencode run` exits as soon as the session goes idle. So
 * capture is awaited (tens of ms per call, through a per-session queue that
 * keeps records in order), the idle end-stamp runs synchronously when nothing
 * is queued, and the context blocks are stored as promises the moment their
 * event fires and awaited inside the transform hook, which OpenCode does await.
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
import { sessionIdle, sessionIdleSync } from "./hooks/session-idle.js";
import { enqueue, drain, hasQueued } from "./lib.js";

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

  // Context block for a session: built at session.created (or
  // session.compacted), injected into every experimental.chat.system.transform
  // call for that session, and cleared at the first session.idle after it has
  // been delivered. `block` is the pending script run, stored before it is
  // awaited: OpenCode does not wait for event handlers, so the first transform
  // call of a turn can arrive before onboard finishes (about 150 ms). Clearing
  // only once delivered keeps a block whose turn has not started yet (a manual
  // /compact is followed by idle straight away) for the next turn.
  const pendingContext = new Map<string, { block: Promise<string | null>; delivered: boolean }>();

  const hooks: Hooks = {
    // Direct hooks
    "chat.message": async (input, output) => {
      await enqueue(input.sessionID, () => chatMessage(tlCtx, input, output));
    },

    "tool.execute.after": async (input, output) => {
      await enqueue(input.sessionID, () => toolExecuteAfter(tlCtx, input, output));
    },

    "experimental.chat.system.transform": async (input, output) => {
      // Push, don't consume: this call fires more than once per turn (see
      // header comment), and every call for a session while an entry is
      // pending should see it.
      const entry = input.sessionID ? pendingContext.get(input.sessionID) : undefined;
      if (!entry) return;
      const block = await entry.block;
      entry.delivered = true;
      if (block) output.system.push(block);
    },

    // Event-based hooks
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created": {
          const sessionID = event.properties.info.id;
          // A task-tool subagent's session has a parentID: give it the block, but
          // read-only, so it does not use up the main session's warning (issue #191).
          const block = sessionCreated(tlCtx, { sessionID, readonly: Boolean(event.properties.info.parentID) });
          pendingContext.set(sessionID, { block, delivered: false });
          await block;
          break;
        }

        case "session.compacted": {
          const sessionID = event.properties.sessionID;
          // session.created does not re-fire after a compaction, so this is the
          // only channel for post-compaction recovery. It replaces any pending
          // entry. The boundary waits for queued records, so it lands after them.
          const block = (async () => {
            await drain(sessionID);
            await sessionCompacted(tlCtx, { sessionID });
            return sessionCompactionRecovery(tlCtx, { sessionID });
          })();
          pendingContext.set(sessionID, { block, delivered: false });
          await block;
          break;
        }

        case "session.idle": {
          const sessionID = event.properties.sessionID;
          const entry = pendingContext.get(sessionID);
          if (entry?.delivered) pendingContext.delete(sessionID);
          // Synchronous when nothing is queued, so the stamp is on disk before a
          // headless run's process.exit(); otherwise after the queue drains.
          if (!hasQueued(sessionID)) {
            sessionIdleSync(tlCtx, { sessionID });
          } else {
            await drain(sessionID);
            await sessionIdle(tlCtx, { sessionID });
          }
          break;
        }
      }
    },
  };

  return hooks;
};

// Default export for OpenCode plugin loader
export default ThroughlinePlugin;
