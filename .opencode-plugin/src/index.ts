/**
 * throughline — OpenCode plugin entry point.
 *
 * Wires the 5 hooks to OpenCode's plugin API:
 * - session-created, session-idle, session-compacted → via event handler
 * - chat-message → via chat.message hook
 * - tool-execute-after → via tool.execute.after hook
 *
 * OpenCode plugins are local TypeScript/JavaScript files with structural typing.
 * The plugin function receives a context object and returns an object with hook
 * handlers. OpenCode calls these hooks at the appropriate lifecycle points.
 *
 * Plugin context shape (from OpenCode docs):
 *   { project, client, $, directory, worktree }
 *
 * Available hooks (from OpenCode docs):
 *   Session: session.created, session.compacted, session.idle, session.deleted, ...
 *   Tool: tool.execute.before, tool.execute.after
 *   Chat: chat.message, chat.params, chat.headers
 *   Events: event handler for session/file/tool/todo/lifecycle events
 */

import { sessionCreated } from "./hooks/session-created.js";
import { chatMessage } from "./hooks/chat-message.js";
import { toolExecuteAfter } from "./hooks/tool-execute-after.js";
import { sessionCompacted } from "./hooks/session-compacted.js";
import { sessionIdle } from "./hooks/session-idle.js";

// --- OpenCode plugin types (structural, no npm package) ---

interface PluginContext {
  directory: string;
  worktree?: string;
  project?: string;
  client?: unknown;
  $?: unknown;
}

interface Event {
  type: string;
  sessionID?: string;
  [key: string]: unknown;
}

interface ChatMessageInput {
  sessionID: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
  messageID?: string;
  variant?: string;
}

interface ChatMessageOutput {
  message: {
    role: string;
    parts: Array<{ type: string; text?: string }>;
  };
  parts: Array<{ type: string; text?: string }>;
}

interface ToolExecuteAfterInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: Record<string, unknown>;
}

interface ToolExecuteAfterOutput {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
}

interface PluginHooks {
  "chat.message"?: (input: ChatMessageInput, output: ChatMessageOutput) => Promise<void>;
  "tool.execute.after"?: (input: ToolExecuteAfterInput, output: ToolExecuteAfterOutput) => Promise<void>;
  event?: (ctx: { event: Event }) => Promise<void>;
  config?: (cfg: Record<string, unknown>) => void;
}

type PluginFunction = (ctx: PluginContext) => Promise<PluginHooks>;

// --- Plugin implementation ---

/**
 * throughline plugin for OpenCode.
 *
 * Continuous, state-aware session memory. Captures what you did and what is,
 * hands it off with judgment when the session wraps.
 */
export const ThroughlinePlugin: PluginFunction = async (ctx) => {
  const { directory, worktree } = ctx;

  // Build the throughline context object that hooks expect
  const tlCtx = {
    directory,
    worktree: worktree ?? directory,
  };

  return {
    // Direct hooks
    "chat.message": async (input, output) => {
      await chatMessage(tlCtx, input, output);
    },

    "tool.execute.after": async (input, output) => {
      await toolExecuteAfter(tlCtx, input, output);
    },

    // Event-based hooks
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created":
          if (event.sessionID) {
            await sessionCreated(tlCtx, { sessionID: event.sessionID });
          }
          break;

        case "session.compacted":
          if (event.sessionID) {
            await sessionCompacted(tlCtx, { sessionID: event.sessionID });
          }
          break;

        case "session.idle":
          if (event.sessionID) {
            await sessionIdle(tlCtx, { sessionID: event.sessionID });
          }
          break;
      }
    },
  };
};

// Default export for OpenCode plugin loader
export default ThroughlinePlugin;
